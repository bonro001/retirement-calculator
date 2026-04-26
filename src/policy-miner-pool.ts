import type { MarketAssumptions, SeedData } from './types';
import type { Policy, PolicyEvaluation } from './policy-miner-types';
import type {
  PolicyMinerWorkerRequest,
  PolicyMinerWorkerResponse,
} from './policy-miner-worker-types';

/**
 * Policy-miner worker pool — fans policy batches across N Web Workers.
 *
 * Mirrors the design of `path-shard-pool.ts` (lazy init, prime/run/unprime
 * session model, per-slot busy tracking, queued dispatch). The two pools
 * are separate to keep their concerns isolated:
 *   - `path-shard-pool` parallelizes one simulation's TRIAL space across
 *     workers. One simulation, K shards.
 *   - `policy-miner-pool` parallelizes a policy SEARCH space across
 *     workers. K policies, one full simulation each.
 *
 * Sizing: defaults to `min(8, hardwareConcurrency - 1)` matching the
 * shard pool. The user has multiple Mac minis (8-core M4 each) — Phase D
 * will distribute batches across hosts via the same `MiningJobBatch`
 * shape used internally here, so adding remote hosts later is a matter
 * of swapping the dispatcher rather than redesigning the pool.
 *
 * Why mining and shards both can't share workers: the shard worker keeps
 * the running simulation's SeedData hot in its primed cache. The miner
 * worker mutates SeedData per policy. Same worker code path can't serve
 * both without a session-isolation refactor we don't need yet.
 */

interface PendingRun {
  resolve: (evals: PolicyEvaluation[]) => void;
  reject: (err: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  currentRequestId: string | null;
}

let slots: WorkerSlot[] | null = null;
const pendingByRequestId = new Map<string, PendingRun>();
const queuedRequests: Array<{
  requestId: string;
  sessionId: string;
  policies: Policy[];
}> = [];
let nextRequestSeq = 0;

function defaultPoolSize(): number {
  const hc =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  // Apple Silicon (M-series) reports total cores via hardwareConcurrency
  // but macOS pins Web Workers to the performance cluster by default —
  // M4 mini exposes 8 cores (4 perf + 4 efficiency) and Activity Monitor
  // tops out around 50% CPU during mining because the 4 perf cores are
  // pegged but efficiency cores stay idle. Oversubscribing the perf
  // cluster pushes some workers onto the efficiency cores. Each
  // additional worker past hc costs the prime payload's RAM (a SeedData
  // clone) but no measurable per-worker overhead, so we go 1.5× hc up
  // to a hard cap of 12.
  const target = Math.ceil(hc * 1.5);
  return Math.max(2, Math.min(12, target));
}

/** Read-only diagnostic — what `defaultPoolSize` decided and why. */
export function describeMinerPoolSizing(): {
  hardwareConcurrency: number;
  poolSize: number;
} {
  const hc =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return { hardwareConcurrency: hc, poolSize: defaultPoolSize() };
}

/** Returns the actual worker count after `ensurePool()`. */
export function getMinerPoolSize(): number {
  return ensurePool().length;
}

/**
 * How many worker slots are currently idle. Used by the cluster client's
 * heartbeat as a `freeWorkerSlots` capacity hint to the dispatcher so the
 * dispatcher doesn't overpack this host. Returns 0 (not the pool size!)
 * until the pool has been initialized — we don't want to advertise free
 * capacity we haven't actually created yet.
 */
export function getFreeMinerSlotCount(): number {
  if (!slots) return 0;
  let n = 0;
  for (const slot of slots) if (!slot.busy) n += 1;
  return n;
}

/**
 * Prime every worker with the session's static context (SeedData,
 * assumptions, baseline fingerprint, engine version, node id, legacy
 * target). Subsequent `runPoliciesInParallel` calls reference this
 * context by sessionId.
 */
export function primeMinerSession(args: {
  sessionId: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
}): void {
  const pool = ensurePool();
  for (const slot of pool) {
    slot.worker.postMessage({
      type: 'prime',
      payload: { ...args },
    } satisfies PolicyMinerWorkerRequest);
  }
}

/** Drop the cached session payload from every worker. */
export function unprimeMinerSession(sessionId: string): void {
  if (!slots) return;
  for (const slot of slots) {
    slot.worker.postMessage({
      type: 'unprime',
      sessionId,
    } satisfies PolicyMinerWorkerRequest);
  }
}

function ensurePool(): WorkerSlot[] {
  if (slots) return slots;
  const size = defaultPoolSize();
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const created: WorkerSlot[] = [];
  for (let i = 0; i < size; i += 1) {
    try {
      // URL must be a string literal for Vite's worker static analysis to
      // emit the worker chunk in production builds. Storing the path in a
      // const variable silently breaks the build (the chunk is omitted and
      // the runtime `new Worker()` 404s). All other pools in this codebase
      // inline the URL the same way — keep this one consistent.
      const worker = new Worker(
        new URL('./policy-miner.worker.ts', import.meta.url),
        { type: 'module' },
      );
      const slot: WorkerSlot = {
        worker,
        busy: false,
        currentRequestId: null,
      };
      worker.addEventListener('message', (event) => handleMessage(slot, event));
      worker.addEventListener('error', (event) => handleError(slot, event));
      created.push(slot);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[policy-miner-pool] failed to spawn worker ${i + 1}/${size}:`,
        err,
      );
    }
  }
  const ms =
    typeof performance !== 'undefined'
      ? Math.round(performance.now() - t0)
      : 0;
  // eslint-disable-next-line no-console
  console.info(
    `[policy-miner-pool] initialized ${created.length}/${size} workers in ${ms}ms`,
  );
  slots = created;
  return slots;
}

function dispatchQueued(slot: WorkerSlot) {
  if (slot.busy) return;
  const next = queuedRequests.shift();
  if (!next) return;
  slot.busy = true;
  slot.currentRequestId = next.requestId;
  const req: PolicyMinerWorkerRequest = {
    type: 'run',
    payload: {
      requestId: next.requestId,
      sessionId: next.sessionId,
      policies: next.policies,
    },
  };
  slot.worker.postMessage(req);
}

function tryDispatchAcrossPool() {
  const pool = ensurePool();
  for (const slot of pool) {
    if (!slot.busy && queuedRequests.length > 0) {
      dispatchQueued(slot);
    }
  }
}

function handleMessage(
  slot: WorkerSlot,
  event: MessageEvent<PolicyMinerWorkerResponse>,
) {
  const msg = event.data;
  const pending = pendingByRequestId.get(msg.requestId);
  if (!pending) return;

  switch (msg.type) {
    case 'result': {
      pendingByRequestId.delete(msg.requestId);
      pending.resolve(msg.evaluations);
      break;
    }
    case 'error': {
      pendingByRequestId.delete(msg.requestId);
      // Hand back the partial work as part of the error so the dispatcher
      // can persist what we got and reschedule the rest.
      const err = new Error(msg.error || 'Policy miner worker failed');
      (err as Error & { partial?: PolicyEvaluation[] }).partial = msg.partial;
      pending.reject(err);
      break;
    }
    case 'cancelled': {
      pendingByRequestId.delete(msg.requestId);
      const err = new Error('POLICY_MINER_CANCELLED');
      (err as Error & { partial?: PolicyEvaluation[] }).partial = msg.partial;
      pending.reject(err);
      break;
    }
  }

  if (slot.currentRequestId === msg.requestId) {
    slot.busy = false;
    slot.currentRequestId = null;
    dispatchQueued(slot);
  }
}

function handleError(slot: WorkerSlot, event: ErrorEvent) {
  if (slot.currentRequestId) {
    const pending = pendingByRequestId.get(slot.currentRequestId);
    if (pending) {
      pendingByRequestId.delete(slot.currentRequestId);
      pending.reject(
        new Error(event.message || 'Policy miner worker crashed'),
      );
    }
  }
  slot.busy = false;
  slot.currentRequestId = null;
  dispatchQueued(slot);
}

/**
 * Cancel-all token: the miner uses this to abort a running session.
 * Mutating `cancelled = true` causes any subsequent batch dispatch to
 * short-circuit, AND posts a cancel message to every busy worker.
 */
export interface MinerCancelToken {
  cancelled: boolean;
}

/**
 * Dispatch a policy batch to the next available worker. Returns the
 * promise of evaluations. The caller chains many of these; the pool
 * processes them concurrently up to its size.
 *
 * Why batches: per-policy postMessage overhead is small but non-zero
 * (~1-2ms cloning the request payload). Batches of 4-8 amortize that
 * cost without sacrificing cancellation responsiveness — at production
 * trial counts each policy is ~5s, so an 8-policy batch is ~40s, the
 * worst-case work lost on cancel.
 */
export function runPolicyBatch(
  sessionId: string,
  policies: Policy[],
): Promise<PolicyEvaluation[]> {
  ensurePool();
  const requestId = `mine-${Date.now()}-${(nextRequestSeq += 1)}`;
  const promise = new Promise<PolicyEvaluation[]>((resolve, reject) => {
    pendingByRequestId.set(requestId, { resolve, reject });
  });
  queuedRequests.push({ requestId, sessionId, policies });
  tryDispatchAcrossPool();
  return promise;
}

/**
 * Cancel every in-flight and queued batch for this session. Best-effort
 * — workers drain their current policy first, then post a `cancelled`
 * response with whatever evaluations completed.
 */
export function cancelMinerSession(): void {
  // Reject every queued request immediately.
  while (queuedRequests.length > 0) {
    const queued = queuedRequests.shift();
    if (!queued) break;
    const pending = pendingByRequestId.get(queued.requestId);
    if (pending) {
      pendingByRequestId.delete(queued.requestId);
      pending.reject(new Error('POLICY_MINER_CANCELLED'));
    }
  }
  // Tell every busy worker to cancel its current request.
  if (!slots) return;
  for (const slot of slots) {
    if (slot.busy && slot.currentRequestId) {
      slot.worker.postMessage({
        type: 'cancel',
        requestId: slot.currentRequestId,
      } satisfies PolicyMinerWorkerRequest);
    }
  }
}
