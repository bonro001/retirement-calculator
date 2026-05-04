/**
 * Policy Miner Cluster — Dispatcher.
 *
 * A small Node service that:
 *   1. Accepts WebSocket connections from hosts (browser tabs, Node
 *      processes on other machines), controllers, and observers.
 *   2. Maintains the authoritative peer registry for the cluster.
 *   3. Owns the "what session is running" state machine.
 *   4. Hands `MiningJobBatch`es to hosts and ingests `MiningJobResult`s
 *      back into the canonical corpus on disk.
 *
 * D.4 scope (this commit): all four items above. A controller (today the
 * `cluster:start-session` CLI; later the browser via D.3) sends
 * `start_session`; the dispatcher enumerates policies, opens a session
 * dir on disk, and starts handing batches to every connected host. As
 * results arrive they're appended to `evaluations.jsonl` and broadcast
 * to subscribed observers via `cluster_state`.
 *
 * Why a separate Node service instead of running everything in the
 * browser:
 *   - Browsers can't accept inbound WebSocket connections, only outbound.
 *     The cluster needs a server somewhere; that server may as well
 *     also coordinate.
 *   - The dispatcher needs to outlive any single browser tab. Closing
 *     the unified-plan tab today kills the mining session; with a
 *     dispatcher, the tab is just a client and the session keeps running.
 *   - The canonical corpus on the dispatcher is the bridge between hosts.
 *     Each host writes through to the same JSONL log; dedupe is automatic
 *     via the deterministic policy id.
 *
 * Design notes:
 *   - Single in-process state. Peer registry and session bookkeeping live
 *     in plain Maps and die with the process. Evaluation records ARE
 *     persisted (`evaluations.jsonl`); peer state isn't.
 *   - No auth. LAN-only by default; we bind to all interfaces but rely
 *     on the local network being trusted.
 *   - One session at a time. Multi-session would require per-session
 *     batch routing tables — keep it simple until we need it.
 *   - No resume. If the dispatcher restarts mid-session, the controller
 *     has to re-issue start_session. Resume is D.5.
 */

import { createServer, type IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_DISPATCHER_PORT,
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  STATE_BROADCAST_INTERVAL_MS,
  ProtocolParseError,
  decodeMessage,
  encodeMessage,
  type BatchAssignMessage,
  type ClusterBuildInfo,
  type CancelSessionMessage,
  type ClusterMessage,
  type ClusterPeerMetrics,
  type ClusterRuntimeMetrics,
  type ClusterSnapshot,
  type HostCapabilities,
  type PeerRole,
  type RegisterMessage,
  type StartSessionMessage,
  type WelcomeMessage,
} from '../src/mining-protocol';
import {
  enumeratePolicies,
  policyId,
} from '../src/policy-axis-enumerator';
import type {
  MiningJobBatch,
  MiningStats,
  Policy,
  PolicyEvaluation,
  PolicyMiningSessionConfig,
} from '../src/policy-miner-types';
import {
  WorkQueue,
  recommendedBatchSize,
} from './work-queue';
import {
  appendEvaluations,
  closeSessionWithStats,
  findResumableSessions,
  openSessionForWrite,
  type ResumableSession,
  type SessionManifest,
} from './corpus-writer';
import {
  listSessions,
  readEvaluations,
  readSessionMetadata,
} from './corpus-reader';
import {
  compareBuildInfo,
  formatBuildInfo,
  getLocalBuildInfo,
} from './build-info';

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

/**
 * In-process record for one connected peer. The registry is a `Map<peerId,
 * Peer>` keyed by the dispatcher-assigned id. The WebSocket reference
 * lets us push messages; the metadata fields are mirrored into
 * `ClusterSnapshot.peers` on every state broadcast.
 *
 * Throughput tracking lives here too because (a) the dispatcher uses it
 * to size subsequent batches and (b) the snapshot includes it for the
 * per-host UI panel.
 */
interface Peer {
  peerId: string;
  displayName: string;
  roles: PeerRole[];
  capabilities: HostCapabilities | null;
  buildInfo?: ClusterBuildInfo;
  socket: WebSocket;
  lastHeartbeatTs: number | null;
  /** Rolling mean ms-per-policy from completed batches. Updated on each
   *  batch_result; used by `recommendedBatchSize` once it's non-null. */
  meanMsPerPolicy: number | null;
  /** Free worker slots reported by the host's last heartbeat. Defaults to
   *  capabilities.workerCount on register so the very first batch can ship
   *  before any heartbeat has arrived. */
  freeWorkerSlots: number;
  /** Batch ids the dispatcher has handed this peer and not yet seen acked. */
  inFlightBatchIds: Set<string>;
  /** Estimated worker slots reserved by each in-flight batch. Host fan-out
   *  can consume many slots for one batch, so batch-count alone is not
   *  a safe capacity proxy. */
  inFlightSlotReservations: Map<string, number>;
  assignedBatches: number;
  completedBatches: number;
  nackedBatches: number;
  capacityNacks: number;
  assignedPolicies: number;
  completedPolicies: number;
  totalDispatchToResultMs: number;
  busySlotMs: number;
  idleWhilePendingSlotMs: number;
  lastUtilizationSampleMs: number | null;
  /** Connection time, used for "uptime" diagnostics in logs. */
  connectedAtMs: number;
  /** Count of completed batches; threshold for "trust the measured mean
   *  over the perf-class hint" lives in recommendedBatchSize. */
  completedBatchCount: number;
  /** Earliest wall-clock ms at which this peer may be re-fed. Set by the
   *  nack handler to break tight nack loops; the failsafe pump tick
   *  retries after the cooldown elapses. */
  pumpCooldownUntilMs: number;
}

interface SessionRuntimeCounters {
  batchesAssigned: number;
  batchResults: number;
  batchNacks: number;
  capacityNacks: number;
  policiesAssigned: number;
  policiesCompleted: number;
  policiesRequeued: number;
  policiesDropped: number;
  totalDispatchToResultMs: number;
}

/** How long after a nack to skip a peer in pumpDispatch. Long enough to
 *  let the host re-prime / recover; short enough that a healthy host
 *  bouncing one bad batch doesn't sit idle. */
const NACK_COOLDOWN_MS = 1_000;
/** Capacity NACKs are normal backpressure/race signals, not host failures.
 *  Keep the pause short so a just-freed fast host can be fed promptly. */
const CAPACITY_NACK_COOLDOWN_MS = 100;

/**
 * Authoritative free-slot count for a peer. The peer's heartbeat-reported
 * `freeWorkerSlots` is informational only — it can be sampled BEFORE a
 * just-dispatched batch arrives at the host's worker pool, in which case
 * trusting it would let pumpDispatch issue more batches than the host
 * can run. The host then either nacks (best case) or — in the original
 * D.4 implementation — threw an error that surfaced as a 0-evaluation
 * `batch_result`, which the dispatcher treated as "complete" and
 * silently dropped the policies.
 *
 * The fix: derive free slots from `workerCount - reservedSlots`. Both
 * numbers are owned by the dispatcher: workerCount comes from register;
 * reservations are updated whenever we assign / complete / nack /
 * disconnect. By construction this can't lie as badly as heartbeat lag.
 *
 * Host fan-out means one batch can consume every worker slot on that host.
 * Counting one in-flight batch as one slot overfeeds fast hosts and turns
 * capacity backpressure into a storm of `host_no_free_slots` nacks.
 */
function effectiveFreeSlots(peer: Peer): number {
  const total = peer.capabilities?.workerCount ?? 0;
  let reserved = 0;
  for (const slots of peer.inFlightSlotReservations.values()) {
    reserved += slots;
  }
  return Math.max(0, total - reserved);
}

function reservedWorkerSlots(peer: Peer): number {
  let reserved = 0;
  for (const slots of peer.inFlightSlotReservations.values()) {
    reserved += slots;
  }
  return reserved;
}

function resetPeerRuntimeMetrics(peer: Peer): void {
  peer.assignedBatches = 0;
  peer.completedBatches = 0;
  peer.nackedBatches = 0;
  peer.capacityNacks = 0;
  peer.assignedPolicies = 0;
  peer.completedPolicies = 0;
  peer.totalDispatchToResultMs = 0;
  peer.busySlotMs = 0;
  peer.idleWhilePendingSlotMs = 0;
  peer.lastUtilizationSampleMs = Date.now();
}

function maxBatchSizeForPeer(
  peer: Peer,
  freeSlots: number = peer.capabilities?.workerCount ?? 1,
): number {
  const runtime = peer.capabilities?.engineRuntime;
  const workers = peer.capabilities?.workerCount ?? 1;
  const slots = Math.max(1, Math.min(workers, freeSlots));
  if (runtime === 'rust-native-compact') {
    return Math.max(1, Math.min(200, slots * 16));
  }
  if (runtime === 'rust-native-compact-shadow') {
    return Math.max(1, Math.min(100, slots * 8));
  }
  // JS engine: per-policy compute is large, so keep batches big enough
  // to amortize websocket round-trip. Idle peer (slots == workers) gets
  // ~3 rounds of work (25 / 8 ≈ 3); fully-saturated peer was already
  // skipped above by the freeSlots <= 0 check in pumpDispatch.
  return Math.max(1, Math.min(25, slots * 4));
}

function accountPeerUtilization(nowMs: number): void {
  const pendingWorkExists = !!activeSession && activeSession.queue.pendingCount() > 0;
  for (const peer of peers.values()) {
    if (!peer.roles.includes('host')) continue;
    if (peer.lastUtilizationSampleMs === null) {
      peer.lastUtilizationSampleMs = nowMs;
      continue;
    }
    const dt = Math.max(0, Math.min(10_000, nowMs - peer.lastUtilizationSampleMs));
    peer.lastUtilizationSampleMs = nowMs;
    if (!activeSession || dt === 0) continue;
    const workers = peer.capabilities?.workerCount ?? 0;
    if (workers <= 0) continue;
    const busySlots = Math.min(workers, reservedWorkerSlots(peer));
    peer.busySlotMs += busySlots * dt;
    if (pendingWorkExists) {
      peer.idleWhilePendingSlotMs += Math.max(0, workers - busySlots) * dt;
    }
  }
}

function buildPeerMetrics(peer: Peer): ClusterPeerMetrics {
  const denominator = peer.busySlotMs + peer.idleWhilePendingSlotMs;
  return {
    assignedBatches: peer.assignedBatches,
    completedBatches: peer.completedBatches,
    nackedBatches: peer.nackedBatches,
    capacityNacks: peer.capacityNacks,
    assignedPolicies: peer.assignedPolicies,
    completedPolicies: peer.completedPolicies,
    reservedWorkerSlots: reservedWorkerSlots(peer),
    busySlotMs: Math.round(peer.busySlotMs),
    idleWhilePendingSlotMs: Math.round(peer.idleWhilePendingSlotMs),
    utilizationRate: denominator > 0 ? peer.busySlotMs / denominator : null,
    avgDispatchToResultMs:
      peer.completedBatches > 0 ? peer.totalDispatchToResultMs / peer.completedBatches : null,
  };
}

function buildRuntimeMetrics(queueSnap: ReturnType<WorkQueue['snapshot']>): ClusterRuntimeMetrics | undefined {
  if (!activeSession) return undefined;
  let hostBusySlotMs = 0;
  let hostIdleWhilePendingSlotMs = 0;
  for (const peer of peers.values()) {
    if (!peer.roles.includes('host')) continue;
    hostBusySlotMs += peer.busySlotMs;
    hostIdleWhilePendingSlotMs += peer.idleWhilePendingSlotMs;
  }
  const m = activeSession.runtimeMetrics;
  const utilizationDenominator = hostBusySlotMs + hostIdleWhilePendingSlotMs;
  return {
    pendingPolicies: queueSnap.pendingCount,
    inFlightBatches: queueSnap.inFlightCount,
    batchesAssigned: m.batchesAssigned,
    batchResults: m.batchResults,
    batchNacks: m.batchNacks,
    capacityNacks: m.capacityNacks,
    policiesAssigned: m.policiesAssigned,
    policiesCompleted: m.policiesCompleted,
    policiesRequeued: m.policiesRequeued,
    policiesDropped: m.policiesDropped,
    avgBatchSize: m.batchesAssigned > 0 ? m.policiesAssigned / m.batchesAssigned : null,
    avgDispatchToResultMs:
      m.batchResults > 0 ? m.totalDispatchToResultMs / m.batchResults : null,
    hostBusySlotMs: Math.round(hostBusySlotMs),
    hostIdleWhilePendingSlotMs: Math.round(hostIdleWhilePendingSlotMs),
    hostUtilizationRate:
      utilizationDenominator > 0 ? hostBusySlotMs / utilizationDenominator : null,
  };
}

const peers = new Map<string, Peer>();
const DISPATCHER_BUILD_INFO = getLocalBuildInfo();

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Everything we need to know about the currently-running session. Null when
 * the cluster is idle. There's at most one — `start_session` is rejected
 * if this is non-null; `cancel_session` and natural completion both clear it.
 */
interface ActiveSession {
  sessionId: string;
  startedAtIso: string;
  config: PolicyMiningSessionConfig;
  trialCount: number;
  legacyTargetTodayDollars: number;
  /** The pre-serialized SeedData / MarketAssumptions to ship in every
   *  batch. We keep the parsed JSON here (not re-stringified) so each
   *  batch_assign serialization is a single JSON.stringify pass instead
   *  of stringify-then-parse-then-stringify. */
  seedDataPayload: unknown;
  marketAssumptionsPayload: unknown;
  /** The CURRENT stage's queue. During a single-stage session this is
   *  the only queue; during two-stage it points at the coarse queue
   *  during the coarse phase, then is replaced with the fine queue
   *  built from coarse-pass survivors. */
  queue: WorkQueue;
  /** Best policy id seen so far; mirrored into the cluster snapshot. */
  bestPolicyId: string | null;
  /** Rolling mean ms/policy across the whole cluster. Used for the ETA. */
  clusterMeanMsPerPolicy: number;
  /** Total policy-evaluations the queue has yielded; used to keep the
   *  rolling mean stable as samples accumulate. */
  ingestedSamples: number;
  controllerPeerId: string | null;

  // ---- Phase 2.C two-stage screening state ----
  /** Which stage the session is currently dispatching:
   *  - `'single'`: legacy single-pass behavior (no coarseStage configured).
   *  - `'coarse'`: shipping coarseStage.trialCount per batch; results are
   *    held in memory in `coarseSurvivorsBuffer` and NOT persisted.
   *  - `'fine'`: shipping session.trialCount per batch; results land in
   *    the corpus via appendEvaluations. */
  currentStage: 'single' | 'coarse' | 'fine';
  /** Buffer of coarse-pass evaluations awaiting the survival filter at
   *  stage transition. Empty when currentStage !== 'coarse'. */
  coarseSurvivorsBuffer: PolicyEvaluation[];
  /** Running totals surfaced in the cluster snapshot via MiningStats.
   *  Initialized to 0 even for single-stage sessions (the fields are
   *  required on MiningStats but stay 0 when no coarse pass runs). */
  coarseEvaluatedTotal: number;
  coarseScreenedOutTotal: number;
  /** Total policies the coarse queue was built with — needed because
   *  the coarse WorkQueue's totalPolicies is replaced when we swap to
   *  the fine queue and the snapshot's progress denominator must keep
   *  the original headline (X of original-N evaluated). */
  coarseTotalPolicies: number;
  runtimeMetrics: SessionRuntimeCounters;
}

let activeSession: ActiveSession | null = null;

/**
 * Sessions found on disk at boot that have a manifest but no summary
 * (i.e. the dispatcher crashed mid-session). Keyed by
 * `config.baselineFingerprint` so a controller's `start_session` for
 * the same baseline can be resumed without anyone needing to know the
 * old session id. At most one entry per fingerprint — if two unfinished
 * sessions share a baseline, the most recent one wins (later
 * `startedAtIso` overwrites earlier).
 *
 * Entries are removed once consumed by `handleStartSession`. Entries
 * not consumed by the time the operator restarts the controller stay
 * here; they're available for resume on subsequent `start_session`s.
 */
const resumableSessions = new Map<string, ResumableSession>();

/**
 * Counter to generate unique peer ids when a peer doesn't request one.
 * Format: `${hostname}-${role-tag}-${counter}` so logs are scannable.
 */
let peerIdCounter = 0;
function generatePeerId(displayName: string, roles: PeerRole[]): string {
  peerIdCounter += 1;
  const roleTag = roles.includes('host') ? 'h' : roles.includes('controller') ? 'c' : 'o';
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  return `${slug || 'peer'}-${roleTag}-${peerIdCounter}`;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const SELF_HOST = hostname();

// Where session corpora land. `undefined` lets corpus-writer fall back to
// its DEFAULT_DATA_DIR (cluster/data, relative to the dispatcher source).
// Set CLUSTER_DATA_DIR for systemd / NAS / read-only-/opt deploys where
// the source tree isn't writable.
const CLUSTER_DATA_ROOT: string | undefined =
  process.env.CLUSTER_DATA_DIR && process.env.CLUSTER_DATA_DIR.length > 0
    ? process.env.CLUSTER_DATA_DIR
    : undefined;
function log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  // eslint-disable-next-line no-console
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  stream(`[${ts}] [dispatcher@${SELF_HOST}] [${level}] ${message}${metaStr}`);
}

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

/**
 * Build a wire-friendly snapshot from in-process state. Pure function of
 * `peers` + `activeSession` so tests can stub it.
 */
function buildClusterSnapshot(): ClusterSnapshot {
  accountPeerUtilization(Date.now());
  let session: ClusterSnapshot['session'] = null;
  if (activeSession) {
    const queueSnap = activeSession.queue.snapshot();
    // For two-stage sessions, the snapshot's `totalPolicies` should
    // reflect the FULL workload denominator the user expects to see in
    // the status panel. During the coarse phase that's the coarse
    // queue's total (which equals the original policy count). During
    // the fine phase the queue's total switches to the survivor count
    // — but we want the panel to keep showing "X / 7,776 evaluated"
    // not jump to "X / 1,944 evaluated", so we override with the
    // recorded original count.
    const totalPoliciesForSnapshot =
      activeSession.currentStage === 'fine'
        ? activeSession.coarseTotalPolicies
        : queueSnap.totalPolicies;
    // policiesEvaluated semantics: count of evaluations that landed in
    // the corpus. For single-pass sessions (the common case — two-stage
    // is disabled in production) this is the queue's evaluatedCount
    // directly. For two-stage sessions, the COARSE phase doesn't
    // append to the corpus (those are screening trials), so the
    // counter only ticks during the FINE phase. The earlier behavior
    // — treating only `currentStage === 'fine'` as advancing — left
    // the household staring at 0/N for the entire single-pass mine
    // even as the corpus grew normally on disk.
    const finePoliciesEvaluated =
      activeSession.currentStage === 'coarse'
        ? 0
        : queueSnap.evaluatedCount;
    const stats: MiningStats = {
      sessionStartedAtIso: activeSession.startedAtIso,
      totalPolicies: totalPoliciesForSnapshot,
      policiesEvaluated: finePoliciesEvaluated,
      feasiblePolicies: queueSnap.feasibleCount,
      droppedPolicies: queueSnap.droppedCount,
      meanMsPerPolicy: activeSession.clusterMeanMsPerPolicy,
      // p95 isn't tracked precisely on the dispatcher; expose mean × 1.5
      // as a rough placeholder. The browser UI labels this "approx" anyway.
      p95MsPerPolicy: activeSession.clusterMeanMsPerPolicy * 1.5,
      estimatedRemainingMs: estimateRemainingMs(),
      bestPolicyId: activeSession.bestPolicyId,
      coarseEvaluated: activeSession.coarseEvaluatedTotal,
      coarseScreenedOut: activeSession.coarseScreenedOutTotal,
      state: queueSnap.evaluatedCount === 0 ? 'running' : 'running',
      lastError: null,
    };
    session = {
      sessionId: activeSession.sessionId,
      startedAtIso: activeSession.startedAtIso,
      stats,
      metrics: buildRuntimeMetrics(queueSnap),
    };
  }
  return {
    protocolVersion: MINING_PROTOCOL_VERSION,
    dispatcherBuildInfo: DISPATCHER_BUILD_INFO,
    peers: [...peers.values()].map((p) => ({
      peerId: p.peerId,
      displayName: p.displayName,
      roles: p.roles,
      capabilities: p.capabilities,
      buildInfo: p.buildInfo,
      buildStatus: compareBuildInfo(DISPATCHER_BUILD_INFO, p.buildInfo),
      lastHeartbeatTs: p.lastHeartbeatTs,
      meanMsPerPolicy: p.meanMsPerPolicy,
      inFlightBatchCount: p.inFlightBatchIds.size,
      metrics: p.roles.includes('host') ? buildPeerMetrics(p) : undefined,
    })),
    session,
  };
}

/** Cluster-wide ETA. With distributed work the right way is
 *  remainingPolicies × clusterMean / sumOfWorkerCounts; we approximate
 *  by counting all advertised worker slots. Returns 0 when the session
 *  hasn't measured throughput yet. */
function estimateRemainingMs(): number {
  if (!activeSession) return 0;
  const queueSnap = activeSession.queue.snapshot();
  const remaining = queueSnap.pendingCount + queueSnap.inFlightCount;
  if (remaining === 0) return 0;

  // Prefer OBSERVED throughput once the session has meaningful data
  // (≥ 30s elapsed AND ≥ 50 evaluated). Theoretical (mean-ms / slots)
  // assumes 100% worker utilization with no batch dispatch overhead,
  // no browser-throttling on reduced hosts, and no idle slots between
  // batches — so it under-estimates by 2-4× in practice. Observed
  // self-corrects for all of those factors continuously.
  const startMs = new Date(activeSession.startedAtIso).getTime();
  const elapsedMs = Date.now() - startMs;
  const evaluated = queueSnap.evaluatedCount;
  if (elapsedMs >= 30_000 && evaluated >= 50) {
    const policiesPerMs = evaluated / elapsedMs;
    if (policiesPerMs > 0) {
      return Math.round(remaining / policiesPerMs);
    }
  }

  // Fall back to theoretical capacity for the first ~30s before
  // observed throughput stabilizes. Same formula as the original.
  if (activeSession.clusterMeanMsPerPolicy <= 0) return 0;
  let totalSlots = 0;
  for (const peer of peers.values()) {
    if (peer.roles.includes('host')) {
      totalSlots += peer.capabilities?.workerCount ?? 1;
    }
  }
  if (totalSlots === 0) return 0;
  return Math.round((remaining * activeSession.clusterMeanMsPerPolicy) / totalSlots);
}

/** Send a message to one specific peer. Drops silently if the socket
 *  isn't open — the peer's heartbeat timeout will clean up the dead
 *  registry entry on the next sweep. */
function sendTo(peer: Peer, message: ClusterMessage): void {
  if (peer.socket.readyState !== peer.socket.OPEN) return;
  try {
    peer.socket.send(encodeMessage(message));
  } catch (err) {
    log('warn', 'send failed', { peerId: peer.peerId, err: String(err) });
  }
}

/** Broadcast to every peer matching the role filter. Used for cluster
 *  state pushes (everyone) and session events (controllers + observers). */
function broadcast(message: ClusterMessage, rolesFilter?: PeerRole[]): void {
  for (const peer of peers.values()) {
    if (rolesFilter && !peer.roles.some((r) => rolesFilter.includes(r))) continue;
    sendTo(peer, message);
  }
}

function broadcastClusterState(): void {
  broadcast({ kind: 'cluster_state', snapshot: buildClusterSnapshot(), from: 'dispatcher' });
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function handleRegister(socket: WebSocket, registration: RegisterMessage, remoteAddress: string): Peer | null {
  const incomingMajor = registration.protocolVersion.split('.')[0];
  const expectedMajor = MINING_PROTOCOL_VERSION.split('.')[0];
  if (incomingMajor !== expectedMajor) {
    const reject = encodeMessage({
      kind: 'register_rejected',
      reason: 'protocol_version_mismatch',
      detail: `dispatcher speaks v${MINING_PROTOCOL_VERSION}, peer speaks v${registration.protocolVersion}`,
    });
    socket.send(reject);
    socket.close(1002, 'protocol version mismatch');
    log('warn', 'register rejected: protocol version mismatch', {
      peer: registration.displayName,
      peerVersion: registration.protocolVersion,
    });
    return null;
  }

  let peerId = registration.desiredPeerId ?? generatePeerId(registration.displayName, registration.roles);
  if (registration.desiredPeerId && peers.has(registration.desiredPeerId)) {
    log('warn', 'desired peer id in use, generating fresh id', {
      requested: registration.desiredPeerId,
      assigned: peerId,
    });
    peerId = generatePeerId(registration.displayName, registration.roles);
  }

  const peer: Peer = {
    peerId,
    displayName: registration.displayName,
    roles: registration.roles,
    capabilities: registration.capabilities ?? null,
    buildInfo: registration.buildInfo,
    socket,
    lastHeartbeatTs: Date.now(),
    meanMsPerPolicy: null,
    // Seed free slots from advertised worker count so we can dispatch the
    // first batch before any heartbeat arrives. Heartbeats refine this.
    freeWorkerSlots: registration.capabilities?.workerCount ?? 0,
    inFlightBatchIds: new Set(),
    inFlightSlotReservations: new Map(),
    assignedBatches: 0,
    completedBatches: 0,
    nackedBatches: 0,
    capacityNacks: 0,
    assignedPolicies: 0,
    completedPolicies: 0,
    totalDispatchToResultMs: 0,
    busySlotMs: 0,
    idleWhilePendingSlotMs: 0,
    lastUtilizationSampleMs: null,
    connectedAtMs: Date.now(),
    completedBatchCount: 0,
    pumpCooldownUntilMs: 0,
  };
  peers.set(peerId, peer);

  const welcome: WelcomeMessage = {
    kind: 'welcome',
    peerId,
    protocolVersion: MINING_PROTOCOL_VERSION,
    clusterSnapshot: buildClusterSnapshot(),
    from: 'dispatcher',
    to: peerId,
  };
  sendTo(peer, welcome);

  log('info', 'peer registered', {
    peerId,
    displayName: peer.displayName,
    roles: peer.roles.join(','),
    workers: peer.capabilities?.workerCount ?? '?',
    perfClass: peer.capabilities?.perfClass ?? 'unknown',
    build: formatBuildInfo(peer.buildInfo),
    expectedBuild: formatBuildInfo(DISPATCHER_BUILD_INFO),
    buildStatus: compareBuildInfo(DISPATCHER_BUILD_INFO, peer.buildInfo),
    remoteAddress,
  });

  // A new host arriving means new capacity — bring it up to speed on the
  // active session (if any) and try to feed it immediately.
  if (peer.roles.includes('host') && activeSession) {
    forwardStartSessionToOnePeer(peer);
    pumpDispatch();
  }

  return peer;
}

/** Unregister + clean up. Idempotent. If the peer had in-flight batches
 *  for the active session, requeue them before returning so a fast
 *  reconnect-elsewhere doesn't permanently lose work. */
function handleDisconnect(peer: Peer | null, reason: string): void {
  if (!peer) return;
  if (!peers.has(peer.peerId)) return;
  peers.delete(peer.peerId);
  let requeued = 0;
  let dropped = 0;
  if (activeSession && activeSession.queue.hasInFlightForPeer(peer.peerId)) {
    const r = activeSession.queue.requeueAllForPeer(peer.peerId);
    requeued = r.requeued;
    dropped = r.dropped;
    activeSession.runtimeMetrics.policiesRequeued += requeued;
    activeSession.runtimeMetrics.policiesDropped += dropped;
  }
  log('info', 'peer disconnected', {
    peerId: peer.peerId,
    displayName: peer.displayName,
    reason,
    uptimeMs: Date.now() - peer.connectedAtMs,
    requeuedPolicies: requeued,
    droppedPolicies: dropped,
  });
  if (dropped > 0) {
    log('warn', 'dropped policies after exhausting attempts', {
      peerId: peer.peerId,
      droppedPolicies: dropped,
      totalDropped: activeSession?.queue.droppedCountValue() ?? 0,
    });
  }
  broadcastClusterState();
  // Requeued work needs to land somewhere; pump immediately. Dropped
  // work doesn't need a pump but still affects completion — if
  // dropping these batches just emptied the queue, pumpDispatch will
  // notice (pending=0 + inFlight=0) and end the session.
  if ((requeued > 0 || dropped > 0) && activeSession) {
    pumpDispatch();
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function handleStartSession(peer: Peer, message: StartSessionMessage): void {
  if (activeSession) {
    log('warn', 'start_session rejected: another session active', {
      from: peer.peerId,
      activeSessionId: activeSession.sessionId,
    });
    // We don't have a dedicated reject message kind for this, so we just
    // log loudly. The controller observes via cluster_state that the
    // session it asked for never appeared and can re-issue.
    return;
  }
  if (!peer.roles.includes('controller')) {
    log('warn', 'start_session from non-controller, ignored', { from: peer.peerId });
    return;
  }

  // Validate config minimally — schema correctness is the controller's job;
  // we only check the things that would crash the dispatcher.
  const cfg = message.config;
  if (!cfg || !cfg.axes || !cfg.baselineFingerprint) {
    log('warn', 'start_session: invalid config', { from: peer.peerId });
    return;
  }
  const policies = enumeratePolicies(cfg.axes);
  if (policies.length === 0) {
    log('warn', 'start_session: enumerator produced 0 policies', { from: peer.peerId });
    return;
  }
  const cap = cfg.maxPoliciesPerSession;
  const sliced =
    cap && cap > 0 && cap < policies.length ? policies.slice(0, cap) : policies;

  // D.5 resume: did the dispatcher crash mid-session against this same
  // baseline? If so, reuse the on-disk sessionId, skip already-evaluated
  // policies, and continue from where the crash left off. The controller
  // doesn't need to know — it just re-issues the same start_session it
  // used originally, and the dispatcher does the right thing.
  const resumable = resumableSessions.get(cfg.baselineFingerprint);
  let sessionId: string;
  let startedAtIso: string;
  let queue: WorkQueue;
  let isResume = false;
  let bestPolicyIdSeed: string | null = null;
  if (resumable) {
    isResume = true;
    sessionId = resumable.manifest.sessionId;
    startedAtIso = resumable.manifest.startedAtIso;
    // Filter the freshly-enumerated policy list to drop anything the
    // crashed run already evaluated. Uses the same canonical hash the
    // miner workers stamp into evaluation records, so set membership is
    // exact: if a policy id is in evaluatedIds, that policy is done.
    const remainingPolicies = sliced.filter((policy) => {
      const id = policyId(policy, cfg.baselineFingerprint, cfg.engineVersion);
      return !resumable.evaluatedIds.has(id);
    });
    queue = new WorkQueue(sessionId, remainingPolicies, {
      priorEvaluatedCount: resumable.evaluationCount,
    });
    bestPolicyIdSeed = resumable.bestSoFar?.id ?? null;
    log('info', 'session resume: matched on-disk session', {
      sessionId,
      baselineFingerprint: cfg.baselineFingerprint.slice(0, 12),
      enumeratedPolicies: sliced.length,
      alreadyEvaluated: resumable.evaluationCount,
      remainingPolicies: remainingPolicies.length,
      bestPolicyId: bestPolicyIdSeed,
      from: peer.peerId,
    });
    // Consume the entry so a second start_session in the same boot
    // doesn't double-resume the same on-disk session.
    resumableSessions.delete(cfg.baselineFingerprint);
  } else {
    // Fresh session: stamp id with baseline prefix + time so logs read
    // well and re-running doesn't collide with a stale on-disk session dir.
    const startedAtMs = Date.now();
    sessionId = `s-${cfg.baselineFingerprint.slice(0, 12)}-${startedAtMs}`;
    startedAtIso = new Date(startedAtMs).toISOString();
    queue = new WorkQueue(sessionId, sliced);
  }

  // Phase 2.C: when the controller's config carries a coarseStage, run
  // a cheap coarse pass FIRST. The queue we just built becomes the
  // coarse queue (same policy list, just shipped at coarseTrialCount
  // per batch). When the coarse queue drains, the dispatcher
  // transitions to fine: builds a new WorkQueue with only survivors
  // and continues at the configured full trialCount. Coarse evaluations
  // are NOT persisted — they live in coarseSurvivorsBuffer in memory
  // and are dropped at stage transition. Resume is fine: coarse is
  // cheap; restarting it from scratch loses at most a few minutes of
  // wall on a Full mine.
  //
  // Resume note: if this `start_session` is matching a resumable
  // session, we explicitly DOWNGRADE to single-stage. The on-disk
  // corpus only contains fine-pass evaluations (no coarse leak, by
  // design), so a resume of a partially-completed session has already
  // committed to the fine pass implicitly. Re-running coarse on the
  // remaining policies wouldn't be wrong, just wasteful. Single-stage
  // resume preserves "remaining policies are evaluated at full N" which
  // matches the corpus's existing semantics.
  const usingCoarseStage = !!cfg.coarseStage && !isResume;
  const initialStage: 'single' | 'coarse' = usingCoarseStage ? 'coarse' : 'single';
  const coarseTotalPolicies = queue.totalPolicies;

  const manifest: SessionManifest = {
    sessionId,
    startedAtIso,
    config: cfg,
    trialCount: message.trialCount,
    legacyTargetTodayDollars: message.legacyTargetTodayDollars,
    totalPolicies: sliced.length,
    startedBy: peer.displayName,
  };
  try {
    openSessionForWrite(manifest, CLUSTER_DATA_ROOT, { resume: isResume });
  } catch (err) {
    log('error', 'session: corpus open failed', { err: String(err), sessionId });
    return;
  }

  activeSession = {
    sessionId,
    startedAtIso,
    config: cfg,
    trialCount: message.trialCount,
    legacyTargetTodayDollars: message.legacyTargetTodayDollars,
    seedDataPayload: message.seedDataPayload,
    marketAssumptionsPayload: message.marketAssumptionsPayload,
    queue,
    bestPolicyId: bestPolicyIdSeed,
    clusterMeanMsPerPolicy: 0,
    ingestedSamples: 0,
    controllerPeerId: peer.peerId,
    currentStage: initialStage,
    coarseSurvivorsBuffer: [],
    coarseEvaluatedTotal: 0,
    coarseScreenedOutTotal: 0,
    coarseTotalPolicies,
    runtimeMetrics: {
      batchesAssigned: 0,
      batchResults: 0,
      batchNacks: 0,
      capacityNacks: 0,
      policiesAssigned: 0,
      policiesCompleted: 0,
      policiesRequeued: 0,
      policiesDropped: 0,
      totalDispatchToResultMs: 0,
    },
  };

  // Phase 2.C bug fix: reset per-host throughput EWMAs at session start.
  // Without this, the recommendedBatchSize computation uses
  // peer.meanMsPerPolicy carried over from PREVIOUS sessions — which
  // reflects whatever trial count that session ran. If the new session
  // uses a different trial count (e.g. previous was 2000 trials, new
  // session's coarse phase is 200 trials), batch sizes are 10× too
  // small and dispatch overhead dominates the coarse phase wall time.
  // (Discovered by the first cluster two-stage end-to-end test:
  // coarse pass took 51.9s vs predicted 7.2s on 500 policies × 200
  // trials.)
  for (const p of peers.values()) {
    p.meanMsPerPolicy = null;
    p.completedBatchCount = 0;
    resetPeerRuntimeMetrics(p);
  }

  log('info', isResume ? 'session resumed' : 'session started', {
    sessionId,
    totalPolicies: queue.snapshot().totalPolicies,
    pendingPolicies: queue.pendingCount(),
    trialCount: message.trialCount,
    feasibilityThreshold: cfg.feasibilityThreshold,
    controller: peer.displayName,
    hostsAvailable: [...peers.values()].filter((p) => p.roles.includes('host')).length,
  });

  // Forward start_session to every host so they prime their worker pools
  // BEFORE the first batch_assign arrives. Without this the host nacks
  // every batch with `no_active_session`. The forwarded message includes
  // the canonical sessionId so subsequent batch_assigns match.
  forwardStartSessionToHosts();

  broadcastClusterState();
  pumpDispatch();
}

/** Send the active session's start_session payload to every host. Idempotent
 *  on the host side — a host that's already primed for this baseline will
 *  warn and replace, but the underlying prime is keyed per worker so
 *  re-priming is harmless. */
function forwardStartSessionToHosts(): void {
  if (!activeSession) return;
  const session = activeSession;
  const start: StartSessionMessage = {
    kind: 'start_session',
    config: session.config,
    seedDataPayload: session.seedDataPayload,
    marketAssumptionsPayload: session.marketAssumptionsPayload,
    trialCount: session.trialCount,
    legacyTargetTodayDollars: session.legacyTargetTodayDollars,
    sessionId: session.sessionId,
    from: 'dispatcher',
  };
  for (const peer of peers.values()) {
    if (!peer.roles.includes('host')) continue;
    sendTo(peer, start);
  }
}

/** Send a single host the current session's start_session. Used when a
 *  host registers mid-session so the next batch_assign doesn't bounce. */
function forwardStartSessionToOnePeer(peer: Peer): void {
  if (!activeSession) return;
  const session = activeSession;
  const start: StartSessionMessage = {
    kind: 'start_session',
    config: session.config,
    seedDataPayload: session.seedDataPayload,
    marketAssumptionsPayload: session.marketAssumptionsPayload,
    trialCount: session.trialCount,
    legacyTargetTodayDollars: session.legacyTargetTodayDollars,
    sessionId: session.sessionId,
    from: 'dispatcher',
    to: peer.peerId,
  };
  sendTo(peer, start);
}

function handleCancelSession(peer: Peer, message: CancelSessionMessage): void {
  if (!activeSession || activeSession.sessionId !== message.sessionId) {
    log('info', 'cancel_session: no matching active session, ignored', {
      from: peer.peerId,
      requested: message.sessionId,
    });
    return;
  }
  log('info', 'session cancelled by controller', {
    sessionId: activeSession.sessionId,
    from: peer.peerId,
    reason: message.reason ?? '(none)',
  });
  endSession('cancelled', message.reason ?? 'controller cancel');
}

/** Tear down the active session: write summary, clear in-flight, broadcast.
 *  Safe to call multiple times; only the first call has an effect. */
function endSession(state: 'completed' | 'cancelled' | 'error', reason?: string): void {
  if (!activeSession) return;
  const session = activeSession;
  // Tell hosts to drop their primed sessions BEFORE we null activeSession
  // — endSession can be re-entrant from a pump-after-broadcast and we
  // don't want a doubled cancel. The host's cancel handler is itself
  // idempotent so a duplicate cancel is harmless either way.
  for (const peer of peers.values()) {
    if (!peer.roles.includes('host')) continue;
    sendTo(peer, {
      kind: 'cancel_session',
      sessionId: session.sessionId,
      reason: reason ?? `session ${state}`,
      from: 'dispatcher',
      to: peer.peerId,
    });
  }
  activeSession = null; // clear FIRST so re-entrant pumps see no session

  const queueSnap = session.queue.snapshot();
  const summary = closeSessionWithStats(
    session.sessionId,
    state,
    session.startedAtIso,
    {
      totalPolicies: queueSnap.totalPolicies,
      evaluatedCount: queueSnap.evaluatedCount,
      feasibleCount: queueSnap.feasibleCount,
    },
    reason,
  );

  // Wipe in-flight ids on every host — there's nothing in flight anymore
  // because the session is gone and the queue is dropped. The hosts will
  // also drop them on their next batch_ack timeout, but cleaning here
  // keeps the cluster snapshot honest immediately.
  for (const peer of peers.values()) {
    peer.inFlightBatchIds.clear();
    peer.inFlightSlotReservations.clear();
  }

  log('info', 'session ended', {
    sessionId: session.sessionId,
    state,
    reason: reason ?? '(none)',
    totalPolicies: queueSnap.totalPolicies,
    evaluatedCount: queueSnap.evaluatedCount,
    feasibleCount: queueSnap.feasibleCount,
    bestPolicyId: summary?.bestPolicyId ?? null,
  });

  broadcastClusterState();
}

// ---------------------------------------------------------------------------
// Batch dispatch
// ---------------------------------------------------------------------------

/**
 * The pump. Walks every host with free worker slots and assigns a batch
 * sized for that host. Idempotent — calling it more than necessary is
 * harmless; missing a call is the bug to avoid (it manifests as an idle
 * host while the queue still has work).
 *
 * Triggered from:
 *   - start_session (kick things off)
 *   - new host registers (capacity grew)
 *   - heartbeat (host's freeWorkerSlots changed)
 *   - batch_result / batch_nack (a slot became free)
 *   - 1Hz failsafe tick (catches whatever edge case we forgot)
 */
function pumpDispatch(): void {
  if (!activeSession) return;
  const session = activeSession;
  if (session.queue.pendingCount() === 0) {
    // No more pending — but maybe still in-flight. If neither, the
    // current stage is complete. For a coarse-stage session that means
    // it's time to filter survivors and transition to fine; otherwise
    // the whole session is done.
    if (session.queue.inFlightCount() === 0) {
      if (session.currentStage === 'coarse') {
        transitionToFineStage(session);
        // transitionToFineStage installs a new queue and recursively
        // calls pumpDispatch, so we're done here either way.
        return;
      }
      endSession('completed');
    }
    return;
  }

  // Walk hosts in a stable order so a tied set of hosts is fair across
  // pumps. Sort by displayName as a deterministic-ish proxy.
  const hostsByName = [...peers.values()]
    .filter((p) => p.roles.includes('host'))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const now = Date.now();
  for (const peer of hostsByName) {
    if (session.queue.pendingCount() === 0) break;
    // Authoritative — see `effectiveFreeSlots` above for why heartbeat
    // can't be trusted here.
    const freeSlots = effectiveFreeSlots(peer);
    if (freeSlots <= 0) continue;
    if (peer.socket.readyState !== peer.socket.OPEN) continue;
    if (peer.pumpCooldownUntilMs > now) continue;

    // Phase 2.C: ship coarseStage.trialCount per batch during the
    // coarse phase; otherwise the configured full trialCount. The
    // host doesn't need to know which stage it's in — it just runs
    // the batch at whatever trialCount the dispatcher specified.
    const batchTrialCount =
      session.currentStage === 'coarse' && session.config.coarseStage
        ? session.config.coarseStage.trialCount
        : session.trialCount;
    // One batch per pump-call per host. Multi-batch-per-pump is doable
    // but adds bookkeeping; the 1Hz tick catches any host that needs a
    // second helping after its first batch completes.
    //
    // Phase 2.C tuning: pass batchTrialCount to recommendedBatchSize so
    // the perf-class hint scaling kicks in for coarse phase. Without
    // this, the cold-start hint is calibrated at 2000 trials and ships
    // batches 10× too small for a 200-trial coarse pass.
    const size = recommendedBatchSize(
      peer.capabilities?.perfClass ?? 'unknown',
      peer.completedBatchCount >= 3 ? peer.meanMsPerPolicy : null,
      session.queue.pendingCount(),
      batchTrialCount,
      { maxBatchSize: maxBatchSizeForPeer(peer, freeSlots) },
    );
    const assigned = session.queue.assignBatch(peer.peerId, size);
    if (!assigned) continue;
    const batch: MiningJobBatch = {
      batchId: assigned.batchId,
      baselineFingerprint: session.config.baselineFingerprint,
      engineVersion: session.config.engineVersion,
      seedDataPayload: session.seedDataPayload,
      marketAssumptionsPayload: session.marketAssumptionsPayload,
      policies: assigned.policies,
      trialCount: batchTrialCount,
    };
    const batchAssign: BatchAssignMessage = {
      kind: 'batch_assign',
      sessionId: session.sessionId,
      batch,
      from: 'dispatcher',
      to: peer.peerId,
    };
    sendTo(peer, batchAssign);
    peer.inFlightBatchIds.add(assigned.batchId);
    const reservedSlots = Math.max(
      1,
      Math.min(assigned.policies.length, freeSlots),
    );
    peer.inFlightSlotReservations.set(assigned.batchId, reservedSlots);
    peer.assignedBatches += 1;
    peer.assignedPolicies += assigned.policies.length;
    session.runtimeMetrics.batchesAssigned += 1;
    session.runtimeMetrics.policiesAssigned += assigned.policies.length;
    // No optimistic decrement of peer.freeWorkerSlots: that field is
    // informational only. Slot reservations are the decrement
    // (effectiveFreeSlots reads them directly).
  }
}

/**
 * Phase 2.C — coarse → fine stage transition.
 *
 * Called from pumpDispatch when the coarse queue drains (no pending and
 * no in-flight batches). Filters the in-memory coarseSurvivorsBuffer
 * by `bequestAttainmentRate >= (feasibilityThreshold - feasibilityBuffer)`,
 * builds a fresh WorkQueue from the survivors, swaps it into the
 * session, resets per-host throughput EWMAs (the trial count changes,
 * so old samples are stale), broadcasts the new state, and re-enters
 * pumpDispatch to start fine-pass batches.
 */
/**
 * Pure helper: partition a coarse-pass evaluation buffer into survivors
 * (those whose attainment rate clears `feasibilityThreshold - buffer`)
 * and a screened-out count. Exported for direct unit testing — the
 * transitionToFineStage caller mutates session state, but the math
 * itself is pure and covered by `cluster/dispatcher.two-stage.test.ts`.
 */
export function filterCoarseSurvivors(
  buffer: readonly PolicyEvaluation[],
  feasibilityThreshold: number,
  feasibilityBuffer: number,
): { survivors: Policy[]; screenedOut: number; survivalThreshold: number } {
  const survivalThreshold = Math.max(0, feasibilityThreshold - feasibilityBuffer);
  const survivors: Policy[] = [];
  let screenedOut = 0;
  for (const ev of buffer) {
    if (ev.outcome.bequestAttainmentRate >= survivalThreshold) {
      survivors.push(ev.policy);
    } else {
      screenedOut += 1;
    }
  }
  return { survivors, screenedOut, survivalThreshold };
}

function transitionToFineStage(session: ActiveSession): void {
  const coarseStage = session.config.coarseStage;
  if (!coarseStage) {
    // Shouldn't happen — currentStage === 'coarse' implies coarseStage
    // was set at session start. Defensive: bail out by ending session.
    log('error', 'transitionToFineStage: currentStage=coarse but no config.coarseStage', {
      sessionId: session.sessionId,
    });
    endSession('error', 'invariant: coarse stage active without coarseStage config');
    return;
  }
  const { survivors, screenedOut } = filterCoarseSurvivors(
    session.coarseSurvivorsBuffer,
    session.config.feasibilityThreshold,
    coarseStage.feasibilityBuffer,
  );
  session.coarseScreenedOutTotal += screenedOut;
  // Free the coarse buffer memory now that we've filtered. For a Full
  // mine this is ~7,776 PolicyEvaluation records ≈ a few MB; not huge
  // but no reason to hold it through the fine pass.
  session.coarseSurvivorsBuffer = [];

  log('info', 'cluster two-stage: coarse complete, transitioning to fine', {
    sessionId: session.sessionId,
    coarseEvaluated: session.coarseEvaluatedTotal,
    survivors: survivors.length,
    screenedOut: session.coarseScreenedOutTotal,
    coarseTrialCount: coarseStage.trialCount,
    fineTrialCount: session.trialCount,
  });

  // Build the fine queue. Re-use the same sessionId so the corpus
  // session dir doesn't change — fine results land in the existing
  // evaluations.jsonl. WorkQueue's batch ids are unique within the
  // queue instance via nextBatchSeq, so the new queue won't reuse
  // coarse batch ids even though the sessionId is shared.
  session.queue = new WorkQueue(session.sessionId, survivors);
  session.currentStage = 'fine';

  // The trial count changed — per-host meanMsPerPolicy EWMAs from the
  // coarse pass would over-recommend batch sizes for the (slower) fine
  // pass and tank wall-clock pump efficiency. Reset so recommendedBatchSize
  // falls back to the perf-class hint until 3 fine batches land.
  for (const peer of peers.values()) {
    peer.meanMsPerPolicy = null;
    peer.completedBatchCount = 0;
  }
  // Reset the cluster-wide EWMA too — it would otherwise carry coarse
  // ms/policy into the ETA math.
  session.clusterMeanMsPerPolicy = 0;
  session.ingestedSamples = 0;

  broadcastClusterState();
  // Recursively pump — fine batches start going out immediately.
  pumpDispatch();
}

/**
 * Result handler. Validates session match, records in queue, appends to
 * corpus, updates per-host throughput, broadcasts evaluations_ingested,
 * acks the host, and pumps again.
 *
 * Phase 2.C: when currentStage === 'coarse', evaluations are NOT appended
 * to the corpus. They land in coarseSurvivorsBuffer for the survival
 * filter that runs at stage transition.
 */
function handleBatchResult(peer: Peer, message: Extract<ClusterMessage, { kind: 'batch_result' }>): void {
  if (!activeSession || message.sessionId !== activeSession.sessionId) {
    log('warn', 'batch_result for unknown/old session, ignored', {
      from: peer.peerId,
      reportedSession: message.sessionId,
      activeSession: activeSession?.sessionId ?? null,
    });
    // Still ack so the host clears its in-flight tracking.
    sendTo(peer, {
      kind: 'batch_ack',
      sessionId: message.sessionId,
      batchId: message.result.batchId,
      from: 'dispatcher',
      to: peer.peerId,
    });
    return;
  }
  const session = activeSession;
  if (message.result.shadowStats && message.result.shadowStats.evaluated > 0) {
    log(
      message.result.shadowStats.mismatches > 0 ||
        message.result.shadowStats.errors > 0 ||
        message.result.shadowStats.skipped > 0
        ? 'warn'
        : 'info',
      'engine shadow batch telemetry',
      {
        from: peer.peerId,
        batchId: message.result.batchId,
        ...message.result.shadowStats,
      },
    );
  }

  // Phase 2.C: route by stage.
  //   - coarse: collect into in-memory buffer; never touches the corpus.
  //   - fine / single: append to disk before marking complete (existing path).
  let appendOutcome: { feasibleInBatch: number; runningBest: ReturnType<typeof appendEvaluations>['runningBest'] };
  if (session.currentStage === 'coarse') {
    // Buffer for the survival filter at stage transition. We still
    // count "feasible" against the SAME threshold the corpus would use
    // — the coarse-pass feasibility count is a useful UI signal even
    // though these evaluations won't be persisted.
    let feasibleInBatch = 0;
    for (const ev of message.result.evaluations) {
      session.coarseSurvivorsBuffer.push(ev);
      session.coarseEvaluatedTotal += 1;
      if (ev.outcome.bequestAttainmentRate >= session.config.feasibilityThreshold) {
        feasibleInBatch += 1;
      }
    }
    appendOutcome = { feasibleInBatch, runningBest: null };
  } else {
    // Append to disk. We do this BEFORE marking the batch complete so that
    // a write failure doesn't leave us with a queue that thinks the work
    // is done while the corpus is missing it.
    try {
      appendOutcome = appendEvaluations(session.sessionId, message.result.evaluations);
    } catch (err) {
      log('error', 'corpus append failed — requeueing batch', {
        err: String(err),
        sessionId: session.sessionId,
        batchId: message.result.batchId,
      });
      // Don't complete; let the next nack/disconnect path requeue. To force
      // immediate reassignment, we just don't ack — the heartbeat reconciler
      // (D.5) would handle this, but for now log and move on.
      return;
    }
  }

  const completed = session.queue.completeBatch(message.result.batchId, appendOutcome.feasibleInBatch);
  if (!completed) {
    log('warn', 'batch_result for unknown batch (already completed?)', {
      from: peer.peerId,
      batchId: message.result.batchId,
    });
    // Still send an ack — the host needs to clear its in-flight tracking.
    sendTo(peer, {
      kind: 'batch_ack',
      sessionId: session.sessionId,
      batchId: message.result.batchId,
      from: 'dispatcher',
      to: peer.peerId,
    });
    return;
  }

  // Update per-host throughput. msPerPolicy from the batch dominates the
  // EWMA; we keep the EWMA so a single slow batch doesn't tank the
  // estimate that the next pump uses for sizing.
  if (message.result.evaluations.length > 0) {
    const dispatchToResultMs = Date.now() - completed.assignedAtMs;
    peer.completedBatches += 1;
    peer.completedPolicies += completed.policies.length;
    peer.totalDispatchToResultMs += dispatchToResultMs;
    session.runtimeMetrics.batchResults += 1;
    session.runtimeMetrics.policiesCompleted += completed.policies.length;
    session.runtimeMetrics.totalDispatchToResultMs += dispatchToResultMs;
    const batchMsPerPolicy = message.result.batchDurationMs / message.result.evaluations.length;
    if (peer.meanMsPerPolicy === null) {
      peer.meanMsPerPolicy = batchMsPerPolicy;
    } else {
      // Alpha 0.3 — recent batches matter but we don't ignore history.
      peer.meanMsPerPolicy = peer.meanMsPerPolicy * 0.7 + batchMsPerPolicy * 0.3;
    }
    peer.completedBatchCount += 1;

    // Cluster mean — straight average across all evaluations seen this
    // session, weighted by sample count (so a fast host doing 80% of the
    // work doesn't get out-voted by a slow one).
    const newSamples = session.ingestedSamples + message.result.evaluations.length;
    session.clusterMeanMsPerPolicy =
      (session.clusterMeanMsPerPolicy * session.ingestedSamples +
        batchMsPerPolicy * message.result.evaluations.length) /
      newSamples;
    session.ingestedSamples = newSamples;
  }

  if (appendOutcome.runningBest) {
    session.bestPolicyId = appendOutcome.runningBest.id;
  }
  peer.inFlightBatchIds.delete(message.result.batchId);
  peer.inFlightSlotReservations.delete(message.result.batchId);
  // No need to bump peer.freeWorkerSlots — effectiveFreeSlots reads
  // slot reservations directly, and the delete above IS the bump.

  // Ack so the host clears its in-flight tracking.
  sendTo(peer, {
    kind: 'batch_ack',
    sessionId: session.sessionId,
    batchId: message.result.batchId,
    from: 'dispatcher',
    to: peer.peerId,
  });

  // Tell controllers + observers what landed. evaluationIds, not full
  // records — the canonical store on disk has everything; this is just
  // a "go look".
  //
  // Phase 2.C: SUPPRESS this during the coarse phase. The browser
  // controller would otherwise try to fetch records by id from the
  // corpus that aren't there (coarse evals don't persist). The next
  // cluster_state broadcast will reflect coarse progress via
  // stats.coarseEvaluated.
  if (session.currentStage !== 'coarse') {
    broadcast(
      {
        kind: 'evaluations_ingested',
        sessionId: session.sessionId,
        evaluationIds: message.result.evaluations.map((ev) => ev.id),
        from: 'dispatcher',
      },
      ['controller', 'observer'],
    );
  }

  // Pump first (might queue another batch on this host) THEN broadcast
  // state — the broadcast then includes the freshly-issued batch.
  pumpDispatch();
  broadcastClusterState();
}

function handleBatchNack(peer: Peer, message: Extract<ClusterMessage, { kind: 'batch_nack' }>): void {
  if (!activeSession || message.sessionId !== activeSession.sessionId) {
    log('warn', 'batch_nack for unknown/old session, ignored', {
      from: peer.peerId,
      reportedSession: message.sessionId,
    });
    return;
  }
  const isCapacityNack = message.reason === 'host_no_free_slots';
  const r = activeSession.queue.requeueBatch(message.batchId, {
    countAttemptFailure: !isCapacityNack,
  });
  peer.inFlightBatchIds.delete(message.batchId);
  peer.inFlightSlotReservations.delete(message.batchId);
  peer.nackedBatches += 1;
  if (isCapacityNack) peer.capacityNacks += 1;
  activeSession.runtimeMetrics.batchNacks += 1;
  if (isCapacityNack) activeSession.runtimeMetrics.capacityNacks += 1;
  activeSession.runtimeMetrics.policiesRequeued += r?.requeued ?? 0;
  activeSession.runtimeMetrics.policiesDropped += r?.dropped ?? 0;
  // effectiveFreeSlots reads slot reservations directly — no need
  // to touch peer.freeWorkerSlots.
  // Cool-down: don't reassign to this peer for a moment. Without this, a
  // peer that's permanently broken (priming failure, stale state) and a
  // dispatcher that always pumps on nack go into a tight infinite-loop
  // racing through batch ids. The 1Hz failsafe pump will retry within a
  // second — plenty fast.
  const cooldownMs = isCapacityNack ? CAPACITY_NACK_COOLDOWN_MS : NACK_COOLDOWN_MS;
  peer.pumpCooldownUntilMs = Date.now() + cooldownMs;
  log('info', 'batch nacked', {
    from: peer.peerId,
    batchId: message.batchId,
    reason: message.reason,
    requeuedPolicies: r?.requeued ?? 0,
    droppedPolicies: r?.dropped ?? 0,
    cooldownMs,
  });
  if (r && r.dropped > 0) {
    log('warn', 'dropped policies after exhausting attempts', {
      peerId: peer.peerId,
      batchId: message.batchId,
      droppedPolicies: r.dropped,
      totalDropped: activeSession.queue.droppedCountValue(),
    });
  }
  // Pump OTHER hosts immediately — they may have idle slots and the
  // requeued batch is now at the head of the queue.
  pumpDispatch();
  broadcastClusterState();
}

// ---------------------------------------------------------------------------
// Per-socket message dispatch
// ---------------------------------------------------------------------------

function handleMessage(peer: Peer, message: ClusterMessage): void {
  switch (message.kind) {
    case 'register':
      log('warn', 'register from already-registered peer, ignored', { peerId: peer.peerId });
      return;

    case 'heartbeat': {
      peer.lastHeartbeatTs = Date.now();
      // Kept for diagnostics / snapshot, but NOT used by pumpDispatch —
      // see effectiveFreeSlots for why heartbeat-reported free can lag
      // and lead to overpacking.
      peer.freeWorkerSlots = message.freeWorkerSlots;
      // Heartbeat is a cheap secondary trigger for the pump (the 1Hz
      // failsafe and the post-result/nack pumps are the primary ones).
      // pumpDispatch is itself early-exit-cheap when there's no work.
      if (activeSession && effectiveFreeSlots(peer) > 0) {
        pumpDispatch();
      }
      return;
    }

    case 'start_session':
      handleStartSession(peer, message);
      return;

    case 'cancel_session':
      handleCancelSession(peer, message);
      return;

    case 'batch_result':
      handleBatchResult(peer, message);
      return;

    case 'batch_nack':
      handleBatchNack(peer, message);
      return;

    case 'welcome':
    case 'register_rejected':
    case 'batch_assign':
    case 'batch_ack':
    case 'cluster_state':
    case 'evaluations_ingested':
      // Server-originated kinds — should never arrive from a peer.
      log('warn', `unexpected server-originated kind from peer`, {
        kind: message.kind,
        peerId: peer.peerId,
      });
      return;

    default: {
      const exhaustive: never = message;
      log('warn', 'unknown message kind', { kind: (exhaustive as { kind: string }).kind });
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat sweep
// ---------------------------------------------------------------------------

const STALE_PEER_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 6;

function sweepStalePeers(): void {
  const now = Date.now();
  for (const peer of [...peers.values()]) {
    if (peer.lastHeartbeatTs === null) continue;
    const silentMs = now - peer.lastHeartbeatTs;
    if (silentMs > STALE_PEER_THRESHOLD_MS) {
      log('warn', 'stale peer, disconnecting', {
        peerId: peer.peerId,
        silentMs,
      });
      try {
        peer.socket.close(1001, 'heartbeat timeout');
      } catch {
        /* socket may already be dead */
      }
      handleDisconnect(peer, 'heartbeat timeout');
    }
  }
}

// ---------------------------------------------------------------------------
// Server boot
// ---------------------------------------------------------------------------

/**
 * CORS headers applied to every HTTP response. The browser fetches the
 * corpus endpoints (E.1) from a Vite dev server on a different origin
 * (typically http://localhost:5173 → this dispatcher on :8765), so the
 * browser blocks the response unless we whitelist it. A LAN-only
 * dispatcher with no auth has no privileged data to protect — `*` is
 * the right call here. If we ever add auth, this becomes a per-origin
 * allowlist sourced from env.
 */
function applyCorsHeaders(res: import('node:http').ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendNotFound(
  res: import('node:http').ServerResponse,
  message = 'not found',
): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/**
 * Where the corpus reader endpoints look for session data. Matches the
 * writer's default (CLUSTER_DATA_DIR env override → cluster/data) so
 * `GET /sessions` lists exactly what `evaluations.jsonl` files exist on
 * disk. Resolved at server boot and captured in the closure.
 */
function getCorpusRoot(): string | undefined {
  // undefined → corpus-reader uses its DEFAULT_DATA_DIR (cluster/data
  // resolved relative to the dispatcher source). Reads the same env-resolved
  // root the writer uses, so reads always match writes.
  return CLUSTER_DATA_ROOT;
}

function startDispatcher(port: number, host?: string): void {
  const httpServer = createServer((req, res) => {
    applyCorsHeaders(res);

    // Preflight — browsers send OPTIONS before any cross-origin GET that
    // has non-simple headers. Respond with 204 and the headers above.
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('method not allowed');
      return;
    }

    const url = req.url ?? '/';

    if (url === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        protocolVersion: MINING_PROTOCOL_VERSION,
        buildInfo: DISPATCHER_BUILD_INFO,
        peerCount: peers.size,
        activeSessionId: activeSession?.sessionId ?? null,
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    // GET /sessions — list every session on disk with manifest + summary
    // + evaluation line count. Sorted most-recent-first by file mtime so
    // a UI picker can default to the freshest entry.
    if (url === '/sessions') {
      try {
        const sessions = listSessions(getCorpusRoot());
        sendJson(res, 200, { sessions });
      } catch (err) {
        log('warn', 'GET /sessions failed', { err: String(err) });
        sendJson(res, 500, { error: 'list failed', detail: String(err) });
      }
      return;
    }

    // GET /sessions/:id — manifest + summary + evaluation count, no
    // payload. Cheap; useful for "is this session done?" probes.
    const metaMatch = url.match(/^\/sessions\/([^/]+)$/);
    if (metaMatch) {
      const sessionId = decodeURIComponent(metaMatch[1]);
      try {
        const meta = readSessionMetadata(sessionId, getCorpusRoot());
        if (!meta) {
          sendNotFound(res, `session not found: ${sessionId}`);
          return;
        }
        sendJson(res, 200, meta);
      } catch (err) {
        log('warn', 'GET /sessions/:id failed', { sessionId, err: String(err) });
        sendJson(res, 500, { error: 'read failed', detail: String(err) });
      }
      return;
    }

    // GET /sessions/:id/evaluations — the actual evaluation records.
    // Returned as `{ evaluations: [...] }` rather than a bare array so a
    // future server can attach pagination cursors without breaking shape.
    //
    // Query params (Phase 2.D):
    //   ?topN=<N>       Return only the top-N evaluations after sorting.
    //                   Browser passes this during running sessions to
    //                   keep the response payload bounded — at Full mine
    //                   scale (7776 polices) the unbounded payload was
    //                   ~10MB JSON and crashed Chrome through poll churn.
    //                   Omit (or topN<=0) for the full corpus.
    //   ?minFeasibility=<0..1>
    //                   Filter to records with bequestAttainmentRate ≥
    //                   this floor BEFORE sort+slice. When set, sort
    //                   defaults to spend-desc so the top-N reflects
    //                   "highest spend that still hits the legacy floor"
    //                   — the answer the household actually wants. Without
    //                   this, the legacy feasibility-desc sort buries
    //                   high-spend/just-feasible rows beneath a flood of
    //                   low-spend/100%-feasible ones, so the user sees a
    //                   misleadingly low max spend.
    //   ?sort=feasibility  (default when no minFeasibility) Sort
    //                   feasible-first (by bequestAttainmentRate desc),
    //                   then by spend desc among feasibles.
    //   ?sort=spend     (default when minFeasibility>0) Sort by spend
    //                   desc, with feasibility as the tiebreaker. Matches
    //                   the table's "max spend at floor" question.
    //   ?sort=order     Preserve evaluation-completion order (legacy
    //                   behavior — what /evaluations used to return).
    //
    // The response always carries `evaluationCount` = TOTAL records on
    // disk, so the UI can show "showing top 200 of 4,346 feasible".
    // `evaluations.length <= evaluationCount` after a topN cap.
    const evalMatch = url.match(/^\/sessions\/([^/]+)\/evaluations(\?.*)?$/);
    if (evalMatch) {
      const sessionId = decodeURIComponent(evalMatch[1]);
      try {
        const meta = readSessionMetadata(sessionId, getCorpusRoot());
        if (!meta) {
          sendNotFound(res, `session not found: ${sessionId}`);
          return;
        }
        const allEvaluations = readEvaluations(sessionId, getCorpusRoot());
        // Parse query params from the URL (req.url includes ?topN=...)
        const queryStr = url.includes('?') ? url.slice(url.indexOf('?')) : '';
        const params = new URLSearchParams(queryStr);
        const topNRaw = params.get('topN');
        const topN = topNRaw ? Number.parseInt(topNRaw, 10) : 0;
        const minFeasibilityRaw = params.get('minFeasibility');
        const minFeasibility = minFeasibilityRaw
          ? Number.parseFloat(minFeasibilityRaw)
          : 0;
        const sortMode =
          params.get('sort') ??
          (minFeasibility > 0 ? 'spend' : 'feasibility');

        let evaluations = allEvaluations;
        if (Number.isFinite(minFeasibility) && minFeasibility > 0) {
          evaluations = evaluations.filter(
            (e) => (e.outcome?.bequestAttainmentRate ?? 0) >= minFeasibility,
          );
        }
        if (sortMode === 'spend') {
          // Highest-spend feasibles first; feasibility breaks ties so
          // among same-spend rows the sturdier one wins.
          evaluations = [...evaluations].sort((a, b) => {
            const aspend = a.policy?.annualSpendTodayDollars ?? 0;
            const bspend = b.policy?.annualSpendTodayDollars ?? 0;
            if (aspend !== bspend) return bspend - aspend;
            const ar = a.outcome?.bequestAttainmentRate ?? 0;
            const br = b.outcome?.bequestAttainmentRate ?? 0;
            return br - ar;
          });
        } else if (sortMode === 'feasibility') {
          // Sort feasible-first, then by spend desc — matches the
          // PolicyMiningResultsTable ranking. O(n log n); 7776 records
          // is <5ms even on the dispatcher's main thread.
          evaluations = [...evaluations].sort((a, b) => {
            const ar = a.outcome?.bequestAttainmentRate ?? 0;
            const br = b.outcome?.bequestAttainmentRate ?? 0;
            if (ar !== br) return br - ar;
            const aspend = a.policy?.annualSpendTodayDollars ?? 0;
            const bspend = b.policy?.annualSpendTodayDollars ?? 0;
            return bspend - aspend;
          });
        }
        if (Number.isFinite(topN) && topN > 0) {
          evaluations = evaluations.slice(0, topN);
        }
        sendJson(res, 200, {
          sessionId,
          baselineFingerprint: meta.manifest.config.baselineFingerprint,
          engineVersion: meta.manifest.config.engineVersion,
          evaluationCount: allEvaluations.length,
          evaluations,
        });
      } catch (err) {
        log('warn', 'GET /sessions/:id/evaluations failed', {
          sessionId,
          err: String(err),
        });
        sendJson(res, 500, { error: 'read failed', detail: String(err) });
      }
      return;
    }

    sendNotFound(res, 'not found — try ws:// upgrade, /health, or /sessions');
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress ?? 'unknown';
    log('info', 'incoming connection', { remoteAddress });

    let peer: Peer | null = null;

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString('utf-8');
      let message: ClusterMessage;
      try {
        message = decodeMessage(text);
      } catch (err) {
        if (err instanceof ProtocolParseError) {
          log('warn', 'malformed message, closing socket', {
            err: err.message,
            remoteAddress,
          });
          socket.close(1002, 'protocol error');
        } else {
          log('error', 'unexpected parse error', { err: String(err) });
          socket.close(1011, 'internal error');
        }
        return;
      }

      if (!peer) {
        if (message.kind !== 'register') {
          log('warn', 'first message was not register, closing', {
            kind: message.kind,
            remoteAddress,
          });
          socket.close(1002, 'register required first');
          return;
        }
        peer = handleRegister(socket, message, remoteAddress);
        if (peer) {
          broadcastClusterState();
        }
        return;
      }

      handleMessage(peer, message);
    });

    socket.on('close', (code, reasonBuf) => {
      handleDisconnect(peer, `code=${code} reason=${reasonBuf.toString('utf-8') || '(none)'}`);
    });

    socket.on('error', (err) => {
      log('warn', 'socket error', { err: String(err), peerId: peer?.peerId });
      handleDisconnect(peer, `socket error: ${err.message}`);
    });
  });

  httpServer.listen(port, host, () => {
    log('info', 'dispatcher listening', {
      host: host ?? '0.0.0.0',
      port,
      protocolVersion: MINING_PROTOCOL_VERSION,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      stateBroadcastIntervalMs: STATE_BROADCAST_INTERVAL_MS,
      pid: process.pid,
    });
    // D.5 resume: scan the corpus root for sessions that have a manifest
    // but no summary — these are crashes that left work on the table.
    // Do this AFTER the listen log so the operator sees the order of
    // events clearly. Errors during scan are logged and otherwise
    // swallowed: a corrupt session dir shouldn't prevent the dispatcher
    // from accepting new connections.
    try {
      const candidates = findResumableSessions();
      for (const r of candidates) {
        const fp = r.manifest.config.baselineFingerprint;
        // If two crashed sessions share a baseline (rare — we'd have to
        // crash twice in a row before any controller reissued), prefer
        // the most recent. The manifest's startedAtIso is the tiebreaker.
        const incumbent = resumableSessions.get(fp);
        if (incumbent && incumbent.manifest.startedAtIso > r.manifest.startedAtIso) {
          continue;
        }
        resumableSessions.set(fp, r);
      }
      if (candidates.length > 0) {
        log('info', 'resumable sessions found on disk', {
          count: candidates.length,
          held: resumableSessions.size,
          sessionIds: [...resumableSessions.values()].map((s) => s.manifest.sessionId),
        });
      }
    } catch (err) {
      log('warn', 'resume scan failed; continuing without resume support', {
        err: String(err),
      });
    }
  });

  // Periodic cluster-state broadcast.
  setInterval(() => {
    if (peers.size === 0) return;
    broadcastClusterState();
  }, STATE_BROADCAST_INTERVAL_MS);

  // Stale peer sweep.
  setInterval(sweepStalePeers, HEARTBEAT_INTERVAL_MS);

  // 1Hz failsafe pump — covers any edge case where a slot freed up but
  // we missed the wake-up trigger. The pump itself is cheap (early-exits
  // when there's no session or no work).
  setInterval(() => {
    if (activeSession) pumpDispatch();
  }, 1_000);

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    log('info', 'shutting down', { signal, peerCount: peers.size });
    if (activeSession) {
      // Mark session as cancelled so the on-disk summary is consistent.
      endSession('cancelled', `dispatcher shutdown (${signal})`);
    }
    for (const peer of peers.values()) {
      try {
        peer.socket.close(1001, 'dispatcher shutting down');
      } catch {
        /* already dead */
      }
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const portEnv = process.env.DISPATCHER_PORT;
const port = portEnv ? Number(portEnv) : DEFAULT_DISPATCHER_PORT;
if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
  // eslint-disable-next-line no-console
  console.error(`invalid DISPATCHER_PORT="${portEnv}"`);
  process.exit(1);
}
startDispatcher(port, process.env.DISPATCHER_HOST);
