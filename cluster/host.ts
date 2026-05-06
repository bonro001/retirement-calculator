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
 *
 * Reconnect behavior (E.7): the host survives transient loss of contact
 * with the dispatcher — Wi-Fi flaps, dispatcher restarts, brief network
 * partitions — without the operator needing to SSH into each worker
 * machine and restart anything. On socket close we:
 *   - Cancel any in-flight worker runs (their results would be stale on
 *     the new connection anyway; the dispatcher has already requeued
 *     the policies on its end via handleDisconnect).
 *   - Clear session + peer state so the next welcome can re-establish
 *     cleanly. The dispatcher assigns a new peerId and (if a session
 *     is active) immediately re-sends start_session to us.
 *   - Schedule a reconnect with exponential backoff (1s → 60s cap) so
 *     a flapping link doesn't busy-loop the dispatcher with register
 *     attempts.
 *   - Initial-connect failures are handled the same way, so the host
 *     can boot before the dispatcher does and keep retrying.
 *
 * Process exit is now reserved for SIGINT/SIGTERM (operator-initiated
 * graceful shutdown) and pool-spawn failure. A process supervisor is
 * still useful for surviving full Node crashes, but day-to-day
 * connectivity issues no longer require one.
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
import {
  compareBuildInfo,
  formatBuildInfo,
  getLocalBuildInfo,
} from './build-info';
import type {
  MiningJobBatch,
  MiningJobResult,
  Policy,
  PolicyEvaluation,
  PolicyMinerShadowStats,
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

const HOST_ENGINE_RUNTIME =
  process.env.ENGINE_RUNTIME ?? process.env.ENGINE_RUNTIME_DEFAULT ?? 'ts';
const HOST_BUILD_INFO = getLocalBuildInfo();
const HOST_AUTO_UPDATE =
  process.env.HOST_AUTO_UPDATE === '1' ||
  process.env.HOST_AUTO_UPDATE === 'true';
const AUTO_UPDATE_EXIT_CODE = 75;

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

// Max batches the host will queue locally when all workers are busy.
// Should be ≥ dispatcher's IN_FLIGHT_PER_PEER. Beyond this, host nacks for
// requeue rather than holding payloads in memory.
const MAX_QUEUE_DEPTH = 4;

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
  resolve: (result: WorkerRunResult) => void;
  reject: (err: Error & { partial?: PolicyEvaluation[]; shadowStats?: PolicyMinerShadowStats }) => void;
}

interface WorkerRunResult {
  evaluations: PolicyEvaluation[];
  shadowStats?: PolicyMinerShadowStats;
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
    pending.resolve({
      evaluations: msg.evaluations,
      shadowStats: msg.shadowStats,
    });
    return;
  }
  if (msg.type === 'cancelled') {
    const err = Object.assign(new Error('POLICY_MINER_CANCELLED'), {
      partial: msg.partial,
      shadowStats: msg.shadowStats,
    });
    pending.reject(err);
    return;
  }
  // 'error'
  const err = Object.assign(new Error(msg.error), {
    partial: msg.partial,
    shadowStats: msg.shadowStats,
  });
  pending.reject(err);
}

function pickFreeSlot(): WorkerSlot | null {
  for (const slot of slots) {
    if (!slot.busy) return slot;
  }
  return null;
}

function combineShadowStats(
  stats: Array<PolicyMinerShadowStats | undefined>,
): PolicyMinerShadowStats | undefined {
  const present = stats.filter(
    (item): item is PolicyMinerShadowStats => Boolean(item),
  );
  if (present.length === 0) return undefined;
  const runtime = present[0].runtime;
  const sumTiming = (
    total: PolicyMinerShadowStats,
    item: PolicyMinerShadowStats,
    key: keyof NonNullable<PolicyMinerShadowStats['timings']>,
  ) => Number(total.timings?.[key] ?? 0) + Number(item.timings?.[key] ?? 0);
  const avgTiming = (
    total: PolicyMinerShadowStats,
    item: PolicyMinerShadowStats,
    key: keyof NonNullable<PolicyMinerShadowStats['timings']>,
  ) => {
    const evaluated = total.evaluated + item.evaluated;
    return evaluated > 0 ? sumTiming(total, item, key) / evaluated : 0;
  };
  return present.reduce<PolicyMinerShadowStats>(
    (total, item) => ({
      runtime,
      evaluated: total.evaluated + item.evaluated,
      mismatches: total.mismatches + item.mismatches,
      errors: total.errors + item.errors,
      skipped: total.skipped + item.skipped,
      timings: {
        tsEvaluationDurationMsTotal:
          (total.timings?.tsEvaluationDurationMsTotal ?? 0) +
          (item.timings?.tsEvaluationDurationMsTotal ?? 0),
        rustSummaryDurationMsTotal:
          (total.timings?.rustSummaryDurationMsTotal ?? 0) +
          (item.timings?.rustSummaryDurationMsTotal ?? 0),
        tsEvaluationDurationMsAverage:
          total.evaluated + item.evaluated > 0
            ? ((total.timings?.tsEvaluationDurationMsTotal ?? 0) +
                (item.timings?.tsEvaluationDurationMsTotal ?? 0)) /
              (total.evaluated + item.evaluated)
            : 0,
        rustSummaryDurationMsAverage:
          total.evaluated + item.evaluated > 0
            ? ((total.timings?.rustSummaryDurationMsTotal ?? 0) +
                (item.timings?.rustSummaryDurationMsTotal ?? 0)) /
              (total.evaluated + item.evaluated)
            : 0,
        tapeRecordDurationMsTotal: sumTiming(total, item, 'tapeRecordDurationMsTotal'),
        requestBuildDurationMsTotal: sumTiming(total, item, 'requestBuildDurationMsTotal'),
        rustIpcWriteDurationMsTotal: sumTiming(total, item, 'rustIpcWriteDurationMsTotal'),
        rustResponseWaitDurationMsTotal: sumTiming(total, item, 'rustResponseWaitDurationMsTotal'),
        rustResponseParseDurationMsTotal: sumTiming(total, item, 'rustResponseParseDurationMsTotal'),
        rustTotalDurationMsTotal: sumTiming(total, item, 'rustTotalDurationMsTotal'),
        compareDurationMsTotal: sumTiming(total, item, 'compareDurationMsTotal'),
        candidateRequestBytesTotal: sumTiming(total, item, 'candidateRequestBytesTotal'),
        candidateRequestDataBytesTotal: sumTiming(total, item, 'candidateRequestDataBytesTotal'),
        candidateRequestAssumptionsBytesTotal: sumTiming(total, item, 'candidateRequestAssumptionsBytesTotal'),
        candidateRequestTapeBytesTotal: sumTiming(total, item, 'candidateRequestTapeBytesTotal'),
        candidateRequestTapeBytesSavedTotal: sumTiming(
          total,
          item,
          'candidateRequestTapeBytesSavedTotal',
        ),
        candidateRequestEnvelopeBytesTotal: sumTiming(total, item, 'candidateRequestEnvelopeBytesTotal'),
        rustResponseBytesTotal: sumTiming(total, item, 'rustResponseBytesTotal'),
        tapeCacheHitsTotal: sumTiming(total, item, 'tapeCacheHitsTotal'),
        tapeCacheMissesTotal: sumTiming(total, item, 'tapeCacheMissesTotal'),
        compactTapeCacheHitsTotal: sumTiming(total, item, 'compactTapeCacheHitsTotal'),
        compactTapeCacheMissesTotal: sumTiming(total, item, 'compactTapeCacheMissesTotal'),
        tapeRecordDurationMsAverage: avgTiming(total, item, 'tapeRecordDurationMsTotal'),
        requestBuildDurationMsAverage: avgTiming(total, item, 'requestBuildDurationMsTotal'),
        rustIpcWriteDurationMsAverage: avgTiming(total, item, 'rustIpcWriteDurationMsTotal'),
        rustResponseWaitDurationMsAverage: avgTiming(total, item, 'rustResponseWaitDurationMsTotal'),
        rustResponseParseDurationMsAverage: avgTiming(total, item, 'rustResponseParseDurationMsTotal'),
        rustTotalDurationMsAverage: avgTiming(total, item, 'rustTotalDurationMsTotal'),
        compareDurationMsAverage: avgTiming(total, item, 'compareDurationMsTotal'),
        candidateRequestBytesAverage: avgTiming(total, item, 'candidateRequestBytesTotal'),
        candidateRequestDataBytesAverage: avgTiming(total, item, 'candidateRequestDataBytesTotal'),
        candidateRequestAssumptionsBytesAverage: avgTiming(total, item, 'candidateRequestAssumptionsBytesTotal'),
        candidateRequestTapeBytesAverage: avgTiming(total, item, 'candidateRequestTapeBytesTotal'),
        candidateRequestTapeBytesSavedAverage: avgTiming(
          total,
          item,
          'candidateRequestTapeBytesSavedTotal',
        ),
        candidateRequestEnvelopeBytesAverage: avgTiming(total, item, 'candidateRequestEnvelopeBytesTotal'),
        rustResponseBytesAverage: avgTiming(total, item, 'rustResponseBytesTotal'),
        tapeCacheHitRate:
          sumTiming(total, item, 'tapeCacheHitsTotal') +
            sumTiming(total, item, 'tapeCacheMissesTotal') >
          0
            ? sumTiming(total, item, 'tapeCacheHitsTotal') /
              (sumTiming(total, item, 'tapeCacheHitsTotal') +
                sumTiming(total, item, 'tapeCacheMissesTotal'))
            : 0,
        compactTapeCacheHitRate:
          sumTiming(total, item, 'compactTapeCacheHitsTotal') +
            sumTiming(total, item, 'compactTapeCacheMissesTotal') >
          0
            ? sumTiming(total, item, 'compactTapeCacheHitsTotal') /
              (sumTiming(total, item, 'compactTapeCacheHitsTotal') +
                sumTiming(total, item, 'compactTapeCacheMissesTotal'))
            : 0,
      },
      firstMismatch: total.firstMismatch ?? item.firstMismatch,
    }),
    {
      runtime,
      evaluated: 0,
      mismatches: 0,
      errors: 0,
      skipped: 0,
      timings: {
        tsEvaluationDurationMsTotal: 0,
        rustSummaryDurationMsTotal: 0,
        tsEvaluationDurationMsAverage: 0,
        rustSummaryDurationMsAverage: 0,
        tapeRecordDurationMsTotal: 0,
        requestBuildDurationMsTotal: 0,
        rustIpcWriteDurationMsTotal: 0,
        rustResponseWaitDurationMsTotal: 0,
        rustResponseParseDurationMsTotal: 0,
        rustTotalDurationMsTotal: 0,
        compareDurationMsTotal: 0,
        candidateRequestBytesTotal: 0,
        candidateRequestDataBytesTotal: 0,
        candidateRequestAssumptionsBytesTotal: 0,
        candidateRequestTapeBytesTotal: 0,
        candidateRequestTapeBytesSavedTotal: 0,
        candidateRequestEnvelopeBytesTotal: 0,
        rustResponseBytesTotal: 0,
        tapeCacheHitsTotal: 0,
        tapeCacheMissesTotal: 0,
        compactTapeCacheHitsTotal: 0,
        compactTapeCacheMissesTotal: 0,
        tapeRecordDurationMsAverage: 0,
        requestBuildDurationMsAverage: 0,
        rustIpcWriteDurationMsAverage: 0,
        rustResponseWaitDurationMsAverage: 0,
        rustResponseParseDurationMsAverage: 0,
        rustTotalDurationMsAverage: 0,
        compareDurationMsAverage: 0,
        candidateRequestBytesAverage: 0,
        candidateRequestDataBytesAverage: 0,
        candidateRequestAssumptionsBytesAverage: 0,
        candidateRequestTapeBytesAverage: 0,
        candidateRequestTapeBytesSavedAverage: 0,
        candidateRequestEnvelopeBytesAverage: 0,
        rustResponseBytesAverage: 0,
        tapeCacheHitRate: 0,
        compactTapeCacheHitRate: 0,
      },
      firstMismatch: null,
    },
  );
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
 * Partition a policy list into N contiguous slices as evenly as possible.
 * The first `policies.length % n` partitions get one extra policy so the
 * total adds up exactly. Returns the partitions in input order — concat
 * `partitions.flat()` reproduces the original `policies` array, which
 * makes the result-merge step at the end of fan-out trivially correct.
 *
 * Pure; exported for the host-pool unit test that asserts the partition
 * shape never drops or duplicates a policy.
 */
export function partitionPolicies(
  policies: Policy[],
  slotCount: number,
): Policy[][] {
  const n = Math.min(policies.length, Math.max(1, slotCount));
  if (n <= 1) return [policies.slice()];
  const base = Math.floor(policies.length / n);
  const extra = policies.length % n;
  const partitions: Policy[][] = [];
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    partitions.push(policies.slice(cursor, cursor + size));
    cursor += size;
  }
  return partitions;
}

/**
 * Run a batch of policies across the host's free worker_threads in
 * parallel. When a single slot is free or the batch is too small to
 * benefit, falls through to the legacy single-slot path (one worker
 * chews through the batch serially). When ≥2 slots are free and the
 * batch has ≥2 policies, partitions the work across N slots and
 * resolves with the merged results in original input order.
 *
 * Why fan out: before this, a 25-policy batch at coarse N=200 trials
 * tied up ONE worker for ~25 × 100ms = 2.5 sec while the other
 * workers on the same host idled. With 8 workers and a 25-policy
 * batch, each gets ~3-4 policies → wall drops 8× to ~300ms.
 *
 * Resolves with the merged `PolicyEvaluation[]`. Rejects with a
 * partial-bearing error if any sub-batch fails or is cancelled —
 * the partial includes evaluations from BOTH already-finished
 * sub-batches and any partial each failing sub-batch managed to
 * complete before cancel/error.
 */
function runBatchOnPool(
  sessionId: string,
  batchId: string,
  policies: Policy[],
): Promise<WorkerRunResult> {
  // Collect the free, primed slots we can use. We only consider slots
  // already primed for this session — the prime handler primes every
  // slot at session start, so this should always equal freeSlotCount(),
  // but the defensive check keeps us correct under any future flow
  // where slots get rotated.
  const freeSlots: WorkerSlot[] = [];
  for (const slot of slots) {
    if (slot.busy) continue;
    if (!slot.primedSessionIds.has(sessionId)) continue;
    freeSlots.push(slot);
    if (freeSlots.length >= policies.length) break;
  }
  if (freeSlots.length === 0) {
    return Promise.reject(
      Object.assign(
        new Error('host: no free worker slots — dispatcher overpacked'),
        { kind: 'host_no_free_slots' as const },
      ),
    );
  }
  // Single-slot path: trivial pass-through to legacy behavior. Avoids
  // the fan-out bookkeeping when there's nothing to gain.
  if (freeSlots.length === 1 || policies.length === 1) {
    return runSingleSubBatch(sessionId, batchId, policies, freeSlots[0]);
  }
  // Fan-out path: partition + dispatch in parallel.
  const partitions = partitionPolicies(policies, freeSlots.length);
  return runFanOutBatch(sessionId, batchId, partitions, freeSlots.slice(0, partitions.length));
}

/**
 * Single-worker path used both directly (small batch / single free slot)
 * AND as the building block for fan-out (each sub-batch is a single-
 * worker run). Encapsulating it keeps the worker-message bookkeeping
 * (`pendingRuns.set`, `slot.busy = true`) in exactly one place.
 */
function runSingleSubBatch(
  sessionId: string,
  batchId: string,
  policies: Policy[],
  slot: WorkerSlot,
): Promise<WorkerRunResult> {
  return new Promise((resolve, reject) => {
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

/**
 * Fan-out path: dispatch each partition to its own slot in parallel,
 * resolve the parent Promise once all sub-batches complete (in either
 * direction). Sub-batches use request IDs of the form
 * `${sessionId}-${batchId}-s${i}` so the per-slot resolver in
 * `handleWorkerMessage` routes each result/error to the right callback
 * via `pendingRuns`. Cancel-broadcast already iterates `pendingRuns`,
 * so cancelling sub-batches works without any extra wiring.
 */
function runFanOutBatch(
  sessionId: string,
  batchId: string,
  partitions: Policy[][],
  freeSlots: WorkerSlot[],
): Promise<WorkerRunResult> {
  return new Promise((resolve, reject) => {
    const successful: (WorkerRunResult | null)[] = partitions.map(() => null);
    const partials: (WorkerRunResult | null)[] = partitions.map(() => null);
    let completed = 0;
    let failed = false;
    let failureMessage: string | null = null;

    const finalize = (): void => {
      if (completed < partitions.length) return;
      if (failed) {
        // Aggregate any evaluations that DID land — both from
        // successful sub-batches and from the partial buffer of any
        // sub-batch that failed mid-stream.
        const allPartials: PolicyEvaluation[] = [];
        const partialShadowStats: PolicyMinerShadowStats[] = [];
        for (let i = 0; i < partitions.length; i += 1) {
          const success = successful[i];
          const partial = partials[i];
          if (success) {
            allPartials.push(...success.evaluations);
            if (success.shadowStats) partialShadowStats.push(success.shadowStats);
          } else if (partial) {
            allPartials.push(...partial.evaluations);
            if (partial.shadowStats) partialShadowStats.push(partial.shadowStats);
          }
        }
        const err = Object.assign(
          new Error(failureMessage ?? 'host: fan-out sub-batch failed'),
          {
            partial: allPartials,
            shadowStats: combineShadowStats(partialShadowStats),
          },
        );
        reject(err);
        return;
      }
      // All sub-batches succeeded — concat in input order. partitions
      // were carved contiguously so successful[0] is the first slice,
      // successful[1] the next, etc. Result equals the original input
      // policy order.
      const merged: PolicyEvaluation[] = [];
      const shadowStats: PolicyMinerShadowStats[] = [];
      for (const part of successful) {
        if (part) {
          merged.push(...part.evaluations);
          if (part.shadowStats) shadowStats.push(part.shadowStats);
        }
      }
      resolve({
        evaluations: merged,
        shadowStats: combineShadowStats(shadowStats),
      });
    };

    for (let i = 0; i < partitions.length; i += 1) {
      const slot = freeSlots[i];
      const partition = partitions[i];
      const subRequestId = `${sessionId}-${batchId}-s${i}`;
      pendingRuns.set(subRequestId, {
        resolve: (result) => {
          successful[i] = result;
          completed += 1;
          finalize();
        },
        reject: (err) => {
          partials[i] = {
            evaluations: err.partial ?? [],
            shadowStats: err.shadowStats,
          };
          // Capture the FIRST failure message; later failures are
          // typically follow-on cancellations from the same session
          // tear-down.
          if (!failureMessage) failureMessage = err.message;
          failed = true;
          completed += 1;
          finalize();
        },
      });
      slot.busy = true;
      const run: PolicyMinerWorkerRequest = {
        type: 'run',
        payload: { requestId: subRequestId, sessionId, policies: partition },
      };
      slot.worker.postMessage(run);
    }
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
// Batches the host has accepted but can't run yet because every worker
// slot is busy. Drained after each batch completes (in handleBatchAssign,
// after sendBatchResult). Holding the payload locally lets the dispatcher
// pre-load the next batch while the current one runs — eliminating the
// round-trip idle time that previously caused CPU to pulse on multi-worker
// hosts.
const pendingBatchQueue: Array<{
  message: BatchAssignMessage;
  receivedAtMs: number;
}> = [];

// Per-session counters used solely for the host-terminal `batch done`
// log line. Reset whenever the active session changes so the numbers
// shown line up with the session the operator is currently watching.
let sessionBatchesCompleted = 0;
let sessionPoliciesCompleted = 0;

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

/**
 * Reconnect backoff schedule. Each entry is the delay in ms before the
 * next attempt. Saturates at the last value — once we hit 60s we keep
 * trying every 60s indefinitely until the dispatcher comes back. The
 * early entries are short so a brief Wi-Fi flap reconnects in seconds;
 * the cap protects the dispatcher from a busy-loop if it's wedged.
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

let socket: WebSocket | null = null;
let myPeerId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let stopReconnecting = false;
let autoUpdateRequested = false;
// Throttling for the auto-update path: maybeRequestAutoUpdate is called
// on every cluster_state broadcast (~1/sec from the dispatcher), so the
// "waiting for idle host" warning would fire 60×/min without throttling.
// Track the last-warned expected build hash so we only log on
// transitions, not on every poll.
let lastWaitingWarnExpected: string | null = null;

function maybeRequestAutoUpdate(
  expectedBuildInfo: Parameters<typeof compareBuildInfo>[0],
  source: string,
): void {
  if (!HOST_AUTO_UPDATE || autoUpdateRequested) return;
  const status = compareBuildInfo(expectedBuildInfo, HOST_BUILD_INFO);
  if (status === 'match') {
    lastWaitingWarnExpected = null;
    return;
  }
  // Workers are ephemeral: a dirty tree (typically package-lock.json drift
  // from a prior `npm install`) shouldn't block the auto-update. The
  // launcher's start-host script hard-resets to origin/main on relaunch,
  // so blowing away local edits is the intended behavior.
  const expectedKey = formatBuildInfo(expectedBuildInfo);
  if (activeSession || inFlightBatchIds.size > 0 || pendingRuns.size > 0) {
    if (lastWaitingWarnExpected !== expectedKey) {
      log('info', 'auto-update waiting for idle host', {
        local: formatBuildInfo(HOST_BUILD_INFO),
        expected: expectedKey,
        source,
        activeSession: activeSession?.sessionId ?? null,
        inFlightBatches: inFlightBatchIds.size,
      });
      lastWaitingWarnExpected = expectedKey;
    }
    return;
  }
  autoUpdateRequested = true;
  stopReconnecting = true;
  log('warn', 'auto-update requested: host code is behind dispatcher', {
    local: formatBuildInfo(HOST_BUILD_INFO),
    expected: formatBuildInfo(expectedBuildInfo),
    source,
  });
  socket?.close(1000, 'auto-update requested');
  setTimeout(() => process.exit(AUTO_UPDATE_EXIT_CODE), 250).unref();
}

/**
 * Reset peer-scoped state on disconnect. The dispatcher has already
 * requeued any in-flight batches we held (its handleDisconnect path),
 * so the right thing on our end is to:
 *   - cancel in-flight worker runs and reject their pending promises
 *     so the slots free up immediately for the next session
 *   - drop activeSession and primed-session caches; the dispatcher
 *     will re-issue start_session on re-register if a session is live
 *   - clear inFlightBatchIds so heartbeats after reconnect are accurate
 *   - clear myPeerId so we don't accidentally tag outbound messages
 *     with a stale id between disconnect and the next welcome
 */
function resetPeerScopedState(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  // Cancel anything the workers are still chewing on — its result would
  // never make it back to the dispatcher anyway.
  cancelAllInFlight();
  // Reject pending promises so handleBatchAssign's await resolves and
  // the slots get marked free again. We use a tagged error so a future
  // error-handling path can distinguish "host disconnected" from
  // "engine threw".
  for (const [requestId, pending] of pendingRuns) {
    pending.reject(
      Object.assign(new Error('host: dispatcher disconnected'), {
        kind: 'host_disconnected' as const,
      }),
    );
    pendingRuns.delete(requestId);
  }
  // Belt and suspenders: any slot that didn't get its rejection above
  // (race) gets reset here so the next session starts clean.
  for (const slot of slots) {
    slot.busy = false;
    slot.primedSessionIds.clear();
  }
  if (activeSession) {
    activeSession = null;
  }
  inFlightBatchIds.clear();
  pendingBatchQueue.length = 0;
  sessionBatchesCompleted = 0;
  sessionPoliciesCompleted = 0;
  myPeerId = null;
}

function scheduleReconnect(): void {
  if (stopReconnecting) return;
  if (reconnectTimer) return; // already scheduled
  const delay =
    RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
  reconnectAttempt += 1;
  log('info', 'reconnecting', {
    inMs: delay,
    attempt: reconnectAttempt,
  });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  // Don't keep the event loop alive solely for the reconnect timer —
  // SIGINT/SIGTERM should still be able to exit promptly.
  reconnectTimer.unref?.();
}

function connect(): void {
  if (stopReconnecting) return;
  log('info', 'connecting', { url: DISPATCHER_URL });
  let socketClosed = false;
  let ws: WebSocket;
  try {
    ws = new WebSocket(DISPATCHER_URL);
  } catch (err) {
    // Synchronous construction failure (malformed URL etc.). Treat as a
    // failed connect and back off.
    log('error', 'socket construction failed', { err: String(err) });
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.on('open', () => {
    const register: RegisterMessage = {
      kind: 'register',
      protocolVersion: MINING_PROTOCOL_VERSION,
      roles: ['host'],
      displayName: HOST_DISPLAY_NAME,
      buildInfo: HOST_BUILD_INFO,
      capabilities: {
        workerCount: HOST_WORKER_COUNT,
        perfClass: HOST_PERF_CLASS,
        platformDescriptor: PLATFORM_DESCRIPTOR,
        engineRuntime: HOST_ENGINE_RUNTIME,
      },
    };
    ws.send(encodeMessage(register));
    log('info', 'sent register', {
      workers: HOST_WORKER_COUNT,
      perf: HOST_PERF_CLASS,
      platform: PLATFORM_DESCRIPTOR,
      runtime: HOST_ENGINE_RUNTIME,
      build: formatBuildInfo(HOST_BUILD_INFO),
      autoUpdate: HOST_AUTO_UPDATE,
    });
    // Don't reset reconnectAttempt here — wait for the dispatcher's
    // 'welcome' to confirm we were actually accepted. A socket can open
    // and immediately receive register_rejected (protocol mismatch),
    // and we don't want that to look like a successful connect for
    // backoff purposes.
  });

  ws.on('message', (raw: Buffer) => {
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

  ws.on('close', (code, reason) => {
    if (socketClosed) return; // dedupe close fired after error
    socketClosed = true;
    log('warn', 'socket closed', {
      code,
      reason: reason.toString('utf-8'),
      attempt: reconnectAttempt,
    });
    socket = null;
    resetPeerScopedState();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    // 'error' commonly fires on initial-connect refusal (ECONNREFUSED)
    // immediately followed by 'close'. Log here, let the close handler
    // schedule the retry — it dedupes against this path so we don't
    // double-bump the backoff.
    log('warn', 'socket error', { err: String(err) });
  });
}

async function handleDispatcherMessage(message: ClusterMessage): Promise<void> {
  switch (message.kind) {
    case 'welcome': {
      myPeerId = message.peerId;
      // We were accepted by the dispatcher — the connection is healthy.
      // Reset the reconnect backoff so the NEXT disconnect (whenever
      // it happens) starts from the 1s rung again instead of inheriting
      // a stale long delay from an earlier outage.
      const wasReconnect = reconnectAttempt > 0;
      reconnectAttempt = 0;
      log('info', 'welcomed', {
        peerId: message.peerId,
        clusterPeers: message.clusterSnapshot.peers.length,
        buildStatus: compareBuildInfo(
          message.clusterSnapshot.dispatcherBuildInfo,
          HOST_BUILD_INFO,
        ),
        ...(wasReconnect ? { afterReconnect: true } : {}),
      });
      maybeRequestAutoUpdate(message.clusterSnapshot.dispatcherBuildInfo, 'welcome');
      startHeartbeat();
      return;
    }
    case 'register_rejected': {
      log('error', 'register rejected', {
        reason: message.reason,
        detail: message.detail,
      });
      // Protocol mismatch is a structural failure — reconnecting won't
      // fix it. Stop the loop so the operator sees a single clear error
      // instead of the same rejection log every minute.
      if (message.reason === 'protocol_version_mismatch') {
        stopReconnecting = true;
      }
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
      maybeRequestAutoUpdate(message.snapshot.dispatcherBuildInfo, 'cluster_state');
      return;
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
  // Drop any batches that haven't started yet — they belong to the
  // session being cancelled and would fail validation in the run path.
  pendingBatchQueue.length = 0;
  activeSession = null;
}

async function handleBatchAssign(
  message: BatchAssignMessage,
  receivedAtMs = Date.now(),
): Promise<void> {
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
  // Pre-flight slot check. With multi-batch-in-flight (IN_FLIGHT_PER_PEER>1
  // on the dispatcher), a 2nd batch can arrive while the 1st is fanned
  // out across all workers. Queue it locally instead of nacking — when
  // the 1st batch's result is sent, drainPendingBatchQueue() picks the
  // 2nd up immediately, eliminating the round-trip idle time that caused
  // the CPU "pulse" pattern.
  //
  // MAX_QUEUE_DEPTH guards against runaway memory if dispatcher misbehaves
  // (or IN_FLIGHT_PER_PEER is raised beyond the host's expectations). Set
  // to 2 to match the dispatcher's IN_FLIGHT_PER_PEER plus a small buffer.
  if (freeSlotCount() <= 0) {
    if (pendingBatchQueue.length >= MAX_QUEUE_DEPTH) {
      log('warn', 'pending queue full — nacking for requeue', {
        batchId: batch.batchId,
        policies: batch.policies.length,
        queueDepth: pendingBatchQueue.length,
      });
      sendNack(sessionId, batch.batchId, 'host_no_free_slots');
      return;
    }
    pendingBatchQueue.push({ message, receivedAtMs });
    inFlightBatchIds.add(batch.batchId);
    log('info', 'queued batch — workers busy', {
      batchId: batch.batchId,
      policies: batch.policies.length,
      queueDepth: pendingBatchQueue.length,
    });
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
  const hostQueueDelayMs = Math.max(0, startedAt - receivedAtMs);
  let evaluations: PolicyEvaluation[] = [];
  let shadowStats: PolicyMinerShadowStats | undefined;
  let partialFailure: MiningJobResult['partialFailure'] = null;
  try {
    const run = await runBatchOnPool(sessionId, batch.batchId, batch.policies);
    evaluations = run.evaluations;
    shadowStats = run.shadowStats;
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
    shadowStats = (err as Error & { shadowStats?: PolicyMinerShadowStats }).shadowStats;
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
    hostQueueDelayMs,
    batchDurationMs: Date.now() - startedAt,
    evaluations,
    shadowStats,
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
      shadowStats,
    });
  }

  // Drain any batches that arrived while workers were saturated.
  // Re-entrant: each drained call awaits its own batch and then drains
  // again, so the queue cascades through whatever depth has accumulated.
  drainPendingBatchQueue();
}

function drainPendingBatchQueue(): void {
  while (pendingBatchQueue.length > 0 && freeSlotCount() > 0) {
    const next = pendingBatchQueue.shift();
    if (!next) break;
    // The queued batch is already counted in inFlightBatchIds. Remove it
    // so handleBatchAssign re-adds it on the run path (keeping the set
    // consistent if the batch ends up nacked due to session/version drift
    // detected on the second pass).
    inFlightBatchIds.delete(next.message.batch.batchId);
    handleBatchAssign(next.message, next.receivedAtMs).catch((err) => {
      log('error', 'queued batch failed during drain', {
        batchId: next.message.batch.batchId,
        err: String(err),
      });
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
  // Operator-initiated stop — disarm the reconnect loop so the host
  // doesn't immediately come back up after we close the socket.
  stopReconnecting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
