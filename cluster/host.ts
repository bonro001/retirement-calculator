/**
 * Policy Miner Cluster — Node Host.
 *
 * Runs on each non-browser worker machine (M1 mini in the shop, Ryzen
 * 7800X3D upstairs, future hosts). Connects to the dispatcher on the M4
 * mini, registers as a `host`, spins up a `worker_threads` pool, and
 * accepts `batch_assign` messages. Each batch is primed once per session,
 * dispatched to a free worker, the resulting `MiningJobResult` is sent
 * back as a `batch_result`, and the dispatcher acks.
 *
 * D.2 scope (this commit): the host-side wiring is complete — registration,
 * heartbeat, session priming, batch dispatch through the worker pool,
 * result reporting. The dispatcher does not yet GENERATE batches (that's
 * D.4), so a connected host today will register, heartbeat, and idle
 * waiting for work. The smoke test (`cluster:host-smoke`) exercises the
 * pool end-to-end without the dispatcher.
 *
 * Responsibilities the host explicitly does NOT take on:
 *   - Persistence. Nothing on this machine writes to IndexedDB or any
 *     local store. All state goes back to the dispatcher.
 *   - Policy enumeration. The dispatcher decides what to mine; the host
 *     just evaluates whatever batches it receives.
 *   - Reconnection. If the WebSocket drops, the process exits with code 2
 *     and `npm run cluster:host` (or systemd / launchd) restarts it.
 *     Clean restart > flaky reconnect logic on day one.
 */

import { Worker } from 'node:worker_threads';
import { hostname, cpus, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  DEFAULT_DISPATCHER_PORT,
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type BatchAssignMessage,
  type BatchResultMessage,
  type CancelSessionMessage,
  type ClusterMessage,
  type HeartbeatMessage,
  type HostCapabilities,
  type RegisterMessage,
  type StartSessionMessage,
} from '../src/mining-protocol';
import type {
  MiningJobBatch,
  MiningJobResult,
  Policy,
  PolicyEvaluation,
} from '../src/policy-miner-types';
import type {
  PolicyMinerWorkerRequest,
  PolicyMinerWorkerResponse,
} from '../src/policy-miner-worker-types';
import type { MarketAssumptions, SeedData } from '../src/types';

// ---------------------------------------------------------------------------
// Config — env-driven so per-machine overrides don't need code changes
// ---------------------------------------------------------------------------

const DISPATCHER_URL =
  process.env.DISPATCHER_URL ?? `ws://localhost:${DEFAULT_DISPATCHER_PORT}`;

const HOST_DISPLAY_NAME =
  process.env.HOST_DISPLAY_NAME ?? `node-host-${hostname()}`;

/**
 * Effective worker count. Defaults to `min(12, cpus.length - 2)`:
 *   - 12 cap matches the M4 mini browser pool tuning, where we found
 *     oversubscription past 12 hits diminishing returns on 10-core
 *     Apple Silicon.
 *   - `-2` reserves one core for the host main process and one for the
 *     OS / dispatcher chatter so the machine stays responsive.
 *   - Override with HOST_WORKERS for hardware that should run more (Ryzen
 *     16-thread → 14, big EPYC → up to 12 anyway, the bottleneck above
 *     that is dispatcher round-trip not CPU).
 */
const DEFAULT_WORKER_COUNT = Math.max(1, Math.min(12, cpus().length - 2));
const HOST_WORKER_COUNT = (() => {
  const raw = process.env.HOST_WORKERS;
  if (!raw) return DEFAULT_WORKER_COUNT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORKER_COUNT;
})();

const HOST_PERF_CLASS = ((): HostCapabilities['perfClass'] => {
  const raw = process.env.HOST_PERF_CLASS;
  if (
    raw === 'apple-silicon-perf' ||
    raw === 'apple-silicon-efficiency' ||
    raw === 'x86-modern' ||
    raw === 'x86-legacy'
  ) {
    return raw;
  }
  // Best-effort default from `os.arch()` and platform — overridable.
  if (arch() === 'arm64') return 'apple-silicon-perf';
  if (arch() === 'x64') return 'x86-modern';
  return 'unknown';
})();

const PLATFORM_DESCRIPTOR =
  process.env.HOST_PLATFORM_DESCRIPTOR ??
  `${platform()}-${arch()}-${cpus().length}cpu`;

// ---------------------------------------------------------------------------
// Logging — tagged with hostname so multi-host log scraping is easy
// ---------------------------------------------------------------------------

const LOG_TAG = `[host@${hostname()}]`;
function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const tail = meta ? ' ' + JSON.stringify(meta) : '';
  const line = `${LOG_TAG} [${level}] ${msg}${tail}`;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

/**
 * One slot in the pool. `busy` reflects whether a `run` is in flight; the
 * dispatcher's free-slot count comes from this. `primedSessionIds` tracks
 * which sessions this worker has already received a `prime` for so we
 * don't re-send the heavy SeedData payload on every batch.
 */
interface WorkerSlot {
  worker: Worker;
  index: number;
  busy: boolean;
  primedSessionIds: Set<string>;
}

interface PendingRun {
  resolve: (evals: PolicyEvaluation[]) => void;
  reject: (err: Error & { partial?: PolicyEvaluation[] }) => void;
}

const slots: WorkerSlot[] = [];
const pendingRuns = new Map<string, PendingRun>();
let shuttingDown = false;

function spawnPool(): void {
  // tsx loads TypeScript in the parent process, but each worker_thread
  // starts a fresh Node interpreter without that loader. The cleanest
  // way to bring TypeScript resolution into workers — across every Node
  // version we care about — is a tiny `.mjs` bootstrap that calls
  // `register('tsx/esm', ...)` from `node:module` and then dynamically
  // imports the `.ts` worker. (We tried `execArgv: ['--import', 'tsx']`
  // first; it leaves nested `.ts` imports unresolved on Node 23.)
  //
  // Forward the parent's `execArgv` so any tuning flags (`--max-old-
  // space-size`, profiler hooks) survive into the workers — keeps the
  // pool symmetric with the main process.
  const loaderUrl = new URL('./host-worker-loader.mjs', import.meta.url);
  const workerExecArgv = [...process.execArgv];
  for (let i = 0; i < HOST_WORKER_COUNT; i += 1) {
    const worker = new Worker(loaderUrl, { execArgv: workerExecArgv });
    const slot: WorkerSlot = {
      worker,
      index: i,
      busy: false,
      primedSessionIds: new Set(),
    };
    worker.on('message', (msg: PolicyMinerWorkerResponse) =>
      handleWorkerMessage(slot, msg),
    );
    worker.on('error', (err) => {
      // A worker crash leaves any in-flight run un-resolved — surface it
      // so the dispatcher can reassign. Keep the host alive: in
      // production we'd respawn the slot, but for D.2 we just mark it
      // permanently busy and let the operator restart the host.
      log('error', `worker ${i} crashed`, { err: String(err) });
      slot.busy = true;
    });
    worker.on('exit', (code) => {
      // During graceful shutdown the main process calls `terminate()`
      // which produces a non-zero exit code — that's expected, not a
      // failure. Only log the surprise case (exit before shutdown).
      if (!shuttingDown) {
        log('warn', `worker ${i} exited`, { code });
      }
      slot.busy = true;
    });
    slots.push(slot);
  }
  log('info', 'worker pool ready', { workers: HOST_WORKER_COUNT });
}

function handleWorkerMessage(
  slot: WorkerSlot,
  msg: PolicyMinerWorkerResponse,
): void {
  const pending = pendingRuns.get(msg.requestId);
  if (!pending) {
    // Late reply for a request we already gave up on (e.g. host shutdown
    // mid-batch). Safe to drop.
    return;
  }
  pendingRuns.delete(msg.requestId);
  slot.busy = false;
  if (msg.type === 'result') {
    pending.resolve(msg.evaluations);
    return;
  }
  if (msg.type === 'cancelled') {
    const err = Object.assign(new Error('POLICY_MINER_CANCELLED'), {
      partial: msg.partial,
    });
    pending.reject(err);
    return;
  }
  // 'error'
  const err = Object.assign(new Error(msg.error), { partial: msg.partial });
  pending.reject(err);
}

function pickFreeSlot(): WorkerSlot | null {
  for (const slot of slots) {
    if (!slot.busy) return slot;
  }
  return null;
}

/**
 * Send a `prime` message to every slot that hasn't yet been primed for
 * this session. Cheap to call repeatedly — slots already in
 * `primedSessionIds` are skipped.
 */
function primeAllSlotsForSession(
  sessionId: string,
  data: SeedData,
  assumptions: MarketAssumptions,
  baselineFingerprint: string,
  engineVersion: string,
  evaluatedByNodeId: string,
  legacyTargetTodayDollars: number,
): void {
  const prime: PolicyMinerWorkerRequest = {
    type: 'prime',
    payload: {
      sessionId,
      data,
      assumptions,
      baselineFingerprint,
      engineVersion,
      evaluatedByNodeId,
      legacyTargetTodayDollars,
    },
  };
  for (const slot of slots) {
    if (slot.primedSessionIds.has(sessionId)) continue;
    slot.worker.postMessage(prime);
    slot.primedSessionIds.add(sessionId);
  }
}

function unprimeAllSlots(sessionId: string): void {
  const unprime: PolicyMinerWorkerRequest = { type: 'unprime', sessionId };
  for (const slot of slots) {
    if (!slot.primedSessionIds.has(sessionId)) continue;
    slot.worker.postMessage(unprime);
    slot.primedSessionIds.delete(sessionId);
  }
}

/**
 * Run a batch of policies on the next free slot. Resolves with the
 * `PolicyEvaluation[]` from the worker, rejects with a partial-bearing
 * error on cancel or worker failure. The caller is responsible for
 * mapping that into a `batch_result` (or a partial-failure form).
 */
function runBatchOnPool(
  sessionId: string,
  batchId: string,
  policies: Policy[],
): Promise<PolicyEvaluation[]> {
  return new Promise((resolve, reject) => {
    const slot = pickFreeSlot();
    if (!slot) {
      // handleBatchAssign pre-checks freeSlotCount() and nacks before
      // ever calling us — so this branch is reachable only if a slot was
      // free at pre-check and got grabbed in between (no concurrent path
      // exists today, but defensively we tag the rejection so the catch
      // in handleBatchAssign can distinguish "host overpacked → must
      // nack, NOT batch_result with 0 evals" from a real worker error.)
      const err = Object.assign(new Error('host: no free worker slots — dispatcher overpacked'), {
        kind: 'host_no_free_slots' as const,
      });
      reject(err);
      return;
    }
    if (!slot.primedSessionIds.has(sessionId)) {
      reject(
        new Error(
          `host: slot ${slot.index} not primed for session ${sessionId}`,
        ),
      );
      return;
    }
    const requestId = `${sessionId}-${batchId}`;
    pendingRuns.set(requestId, {
      resolve,
      reject: reject as PendingRun['reject'],
    });
    slot.busy = true;
    const run: PolicyMinerWorkerRequest = {
      type: 'run',
      payload: { requestId, sessionId, policies },
    };
    slot.worker.postMessage(run);
  });
}

function cancelAllInFlight(): void {
  for (const [requestId] of pendingRuns) {
    const cancel: PolicyMinerWorkerRequest = { type: 'cancel', requestId };
    // Broadcast — only the worker holding the request will act on it.
    for (const slot of slots) slot.worker.postMessage(cancel);
  }
}

function freeSlotCount(): number {
  let n = 0;
  for (const slot of slots) if (!slot.busy) n += 1;
  return n;
}

async function shutdownPool(): Promise<void> {
  shuttingDown = true;
  await Promise.all(slots.map((slot) => slot.worker.terminate()));
}

// ---------------------------------------------------------------------------
// Session bookkeeping
// ---------------------------------------------------------------------------

/**
 * Per-session payload cache. The dispatcher sends `start_session` with
 * the full SeedData + MarketAssumptions; we cache them so subsequent
 * `batch_assign` messages can omit them (and the worker `prime` can
 * reuse them). Cleared on `cancel_session` or when a new session arrives.
 */
interface ActiveSession {
  sessionId: string;
  baselineFingerprint: string;
  engineVersion: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  legacyTargetTodayDollars: number;
}

let activeSession: ActiveSession | null = null;
const inFlightBatchIds = new Set<string>();

// Per-session counters used solely for the host-terminal `batch done`
// log line. Reset whenever the active session changes so the numbers
// shown line up with the session the operator is currently watching.
let sessionBatchesCompleted = 0;
let sessionPoliciesCompleted = 0;

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let myPeerId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

function connect(): void {
  log('info', 'connecting', { url: DISPATCHER_URL });
  socket = new WebSocket(DISPATCHER_URL);

  socket.on('open', () => {
    const register: RegisterMessage = {
      kind: 'register',
      protocolVersion: MINING_PROTOCOL_VERSION,
      roles: ['host'],
      displayName: HOST_DISPLAY_NAME,
      capabilities: {
        workerCount: HOST_WORKER_COUNT,
        perfClass: HOST_PERF_CLASS,
        platformDescriptor: PLATFORM_DESCRIPTOR,
      },
    };
    socket?.send(encodeMessage(register));
    log('info', 'sent register', {
      workers: HOST_WORKER_COUNT,
      perf: HOST_PERF_CLASS,
      platform: PLATFORM_DESCRIPTOR,
    });
  });

  socket.on('message', (raw: Buffer) => {
    const text = raw.toString('utf-8');
    let message: ClusterMessage;
    try {
      message = decodeMessage(text);
    } catch (err) {
      log('warn', 'parse error', { err: String(err) });
      return;
    }
    void handleDispatcherMessage(message);
  });

  socket.on('close', (code, reason) => {
    log('warn', 'socket closed', {
      code,
      reason: reason.toString('utf-8'),
    });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // Exit non-zero so a process supervisor (systemd / launchd / npm
    // run script in a loop) restarts. Reconnect logic in-process is a
    // D.5 problem; for now, "die and respawn" is the reliable answer.
    void shutdownPool().finally(() => process.exit(2));
  });

  socket.on('error', (err) => {
    log('error', 'socket error', { err: String(err) });
  });
}

async function handleDispatcherMessage(message: ClusterMessage): Promise<void> {
  switch (message.kind) {
    case 'welcome': {
      myPeerId = message.peerId;
      log('info', 'welcomed', {
        peerId: message.peerId,
        clusterPeers: message.clusterSnapshot.peers.length,
      });
      startHeartbeat();
      return;
    }
    case 'register_rejected': {
      log('error', 'register rejected', {
        reason: message.reason,
        detail: message.detail,
      });
      socket?.close();
      return;
    }
    case 'start_session': {
      handleStartSession(message);
      return;
    }
    case 'cancel_session': {
      handleCancelSession(message);
      return;
    }
    case 'batch_assign': {
      await handleBatchAssign(message);
      return;
    }
    case 'batch_ack': {
      inFlightBatchIds.delete(message.batchId);
      return;
    }
    case 'cluster_state':
    case 'evaluations_ingested':
      // Hosts don't act on these; observers do. Ignore.
      return;
    case 'heartbeat':
    case 'register':
    case 'batch_result':
    case 'batch_nack':
      // Outbound-only from this host's perspective.
      return;
    default: {
      // Exhaustiveness guard — TS will error here if a new ClusterMessage
      // kind is added without a case above.
      const _exhaustive: never = message;
      void _exhaustive;
      return;
    }
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!myPeerId || !socket || socket.readyState !== WebSocket.OPEN) return;
    const hb: HeartbeatMessage = {
      kind: 'heartbeat',
      from: myPeerId,
      inFlightBatchIds: Array.from(inFlightBatchIds),
      freeWorkerSlots: freeSlotCount(),
    };
    socket.send(encodeMessage(hb));
  }, HEARTBEAT_INTERVAL_MS);
}

function handleStartSession(message: StartSessionMessage): void {
  // If a session was already active, drop it. The dispatcher promises one
  // session at a time, but be defensive — overlapping sessions would
  // cross-pollute the worker prime cache.
  if (activeSession) {
    log('warn', 'replacing active session', {
      old: activeSession.sessionId,
      new: message.config.baselineFingerprint,
    });
    unprimeAllSlots(activeSession.sessionId);
  }
  // Prefer the dispatcher-supplied sessionId so subsequent batch_assigns
  // match. The fallback to baselineFingerprint preserves the D.2 direct-
  // test path (host-smoke / unit tests) where there's no dispatcher.
  const sessionId = message.sessionId ?? message.config.baselineFingerprint;
  activeSession = {
    sessionId,
    baselineFingerprint: message.config.baselineFingerprint,
    engineVersion: message.config.engineVersion,
    data: message.seedDataPayload as SeedData,
    assumptions: message.marketAssumptionsPayload as MarketAssumptions,
    legacyTargetTodayDollars: message.legacyTargetTodayDollars,
  };
  sessionBatchesCompleted = 0;
  sessionPoliciesCompleted = 0;
  log('info', 'session started', {
    baseline: message.config.baselineFingerprint,
    engine: message.config.engineVersion,
    trials: message.trialCount,
  });
}

function handleCancelSession(message: CancelSessionMessage): void {
  if (!activeSession || activeSession.sessionId !== message.sessionId) {
    log('warn', 'cancel for unknown session', { sessionId: message.sessionId });
    return;
  }
  log('info', 'cancelling session', {
    sessionId: message.sessionId,
    reason: message.reason,
  });
  cancelAllInFlight();
  unprimeAllSlots(activeSession.sessionId);
  activeSession = null;
}

async function handleBatchAssign(message: BatchAssignMessage): Promise<void> {
  const { sessionId, batch } = message;
  // Hot-path assertions — if any of these fire it's a dispatcher bug, but
  // we'd rather log and nack than evaluate against a stale baseline.
  if (!activeSession || activeSession.sessionId !== sessionId) {
    log('warn', 'batch_assign for inactive session — nacking', {
      sessionId,
      batchId: batch.batchId,
    });
    sendNack(sessionId, batch.batchId, 'no_active_session');
    return;
  }
  if (batch.engineVersion !== activeSession.engineVersion) {
    log('warn', 'engine version mismatch — nacking', {
      batch: batch.engineVersion,
      session: activeSession.engineVersion,
    });
    sendNack(sessionId, batch.batchId, 'engine_version_mismatch');
    return;
  }
  // Pre-flight slot check. The dispatcher MAY overpack — its heartbeat
  // bookkeeping can lag behind in-flight work — so a batch can land
  // when every worker is busy. Nack instead of running through
  // runBatchOnPool's `reject` path: an error there would surface as a
  // batch_result with 0 evaluations + partialFailure, which the
  // dispatcher currently treats as a (zero-policy) completion and
  // silently drops the work. A nack hits the dispatcher's existing
  // requeue-with-cooldown + per-policy retry-cap path, so the policies
  // stay alive in the queue and a healthier host (or this one a moment
  // later) picks them up.
  if (freeSlotCount() <= 0) {
    log('warn', 'no free worker slots — nacking for requeue', {
      batchId: batch.batchId,
      policies: batch.policies.length,
    });
    sendNack(sessionId, batch.batchId, 'host_no_free_slots');
    return;
  }

  inFlightBatchIds.add(batch.batchId);
  primeAllSlotsForSession(
    sessionId,
    activeSession.data,
    activeSession.assumptions,
    activeSession.baselineFingerprint,
    activeSession.engineVersion,
    myPeerId ?? 'unknown',
    activeSession.legacyTargetTodayDollars,
  );

  const startedAt = Date.now();
  let evaluations: PolicyEvaluation[] = [];
  let partialFailure: MiningJobResult['partialFailure'] = null;
  try {
    evaluations = await runBatchOnPool(sessionId, batch.batchId, batch.policies);
  } catch (err) {
    // Race fallback: precheck thought a slot was free but it got taken
    // before runBatchOnPool grabbed it. Nack and bail — same reasoning
    // as the precheck in handleBatchAssign above.
    const tagged = err as Error & { kind?: string };
    if (tagged.kind === 'host_no_free_slots') {
      log('warn', 'no free worker slots at run-time — nacking for requeue', {
        batchId: batch.batchId,
      });
      inFlightBatchIds.delete(batch.batchId);
      sendNack(sessionId, batch.batchId, 'host_no_free_slots');
      return;
    }
    const partial = (err as Error & { partial?: PolicyEvaluation[] }).partial;
    if (partial && partial.length > 0) {
      evaluations = partial;
    }
    partialFailure = {
      completedPolicyIds: evaluations.map((e) => e.id),
      reason: err instanceof Error ? err.message : String(err),
    };
    log('warn', 'batch failed (partial captured)', {
      batchId: batch.batchId,
      completed: evaluations.length,
      total: batch.policies.length,
      reason: partialFailure.reason,
    });
  }

  const result: MiningJobResult = {
    batchId: batch.batchId,
    evaluatedByNodeId: myPeerId ?? 'unknown',
    batchDurationMs: Date.now() - startedAt,
    evaluations,
    partialFailure,
  };
  sendBatchResult(sessionId, result);

  // Per-batch heartbeat on the host terminal. The dispatcher and the
  // browser status card already have the cluster-wide view; this is for
  // the operator who's SSH'd into a worker box and wants to see "yes,
  // it's chewing through batches" without cracking open the UI. Skip
  // on partialFailure — that path already emitted a warn above with
  // the relevant diagnostics, and re-logging at info would just clutter.
  if (!partialFailure && evaluations.length > 0) {
    sessionBatchesCompleted += 1;
    sessionPoliciesCompleted += evaluations.length;
    const msPerPolicy = result.batchDurationMs / evaluations.length;
    log('info', 'batch done', {
      batchId: batch.batchId,
      policies: evaluations.length,
      durationMs: result.batchDurationMs,
      msPerPolicy: Math.round(msPerPolicy),
      sessionBatches: sessionBatchesCompleted,
      sessionPolicies: sessionPoliciesCompleted,
    });
  }
}

function sendBatchResult(
  sessionId: string,
  result: MiningJobResult,
): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log('warn', 'cannot send batch_result — socket not open', {
      batchId: result.batchId,
    });
    return;
  }
  const msg: BatchResultMessage = {
    kind: 'batch_result',
    from: myPeerId ?? undefined,
    sessionId,
    result,
  };
  socket.send(encodeMessage(msg));
}

function sendNack(
  sessionId: string,
  batchId: string,
  reason: string,
): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const msg: ClusterMessage = {
    kind: 'batch_nack',
    from: myPeerId ?? undefined,
    sessionId,
    batchId,
    reason,
  };
  socket.send(encodeMessage(msg));
}

// ---------------------------------------------------------------------------
// Bootstrap / shutdown
// ---------------------------------------------------------------------------

function gracefulShutdown(signal: string): void {
  log('info', 'shutting down', { signal });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close(1000, `${signal} received`);
  }
  // Failsafe: terminate workers and exit even if WS close hangs.
  setTimeout(() => process.exit(0), 1500).unref();
  void shutdownPool().then(() => process.exit(0));
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Detect whether this file was invoked directly (vs imported by the smoke
// test). When invoked directly via `tsx cluster/host.ts`, bootstrap.
const invokedPath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === invokedPath;
if (isMain) {
  log('info', 'host starting', {
    name: HOST_DISPLAY_NAME,
    workers: HOST_WORKER_COUNT,
    perf: HOST_PERF_CLASS,
    dispatcher: DISPATCHER_URL,
  });
  spawnPool();
  connect();
}

// Exports for the smoke test — lets us drive the pool without a dispatcher.
export {
  spawnPool,
  shutdownPool,
  primeAllSlotsForSession,
  unprimeAllSlots,
  runBatchOnPool,
  freeSlotCount,
  HOST_WORKER_COUNT,
};
