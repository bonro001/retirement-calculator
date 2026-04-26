import type {
  MonteCarloShardOutput,
  MonteCarloTrialRange,
} from './monte-carlo-engine';
import type {
  PathShardRequest,
  PathShardResponse,
  PathShardRunPayload,
} from './path-shard-worker-types';
import type { SimulationRunResult } from './utils';
import type { SeedData } from './types';

/**
 * Lazy-initialized pool of trial-shard workers. Lives inside the simulation
 * orchestrator worker (nested workers) — Vite supports this in module worker
 * mode out of the box.
 *
 * Why nested rather than main-thread? The orchestrator (simulation.worker.ts)
 * already holds the spend-solver loop and wants to drive multiple parallel
 * shard runs across each solver iteration. Putting the pool here keeps the
 * fan-out close to where the work is dispatched and avoids ping-ponging
 * shard payloads through the main thread on every solver iteration.
 *
 * Pool sizing: we target `min(8, hardwareConcurrency - 1)` workers. On the
 * M4 mini (10 cores) that's 8 workers; the main thread + the orchestrator
 * worker keep two cores. Memory cost is the simulation closure × N — small
 * relative to the per-trial yearly traces already held.
 */

interface PendingShard {
  resolve: (output: MonteCarloShardOutput<SimulationRunResult>) => void;
  reject: (err: Error) => void;
  /**
   * Set when the orchestrator cancels via the token. The pool then posts
   * `{type:'cancel', requestId}` to the worker that owns it. Already-running
   * shards drain via SIMULATION_CANCELLED.
   */
  cancelled: boolean;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  /** requestId currently running on this worker, if any. */
  currentRequestId: string | null;
}

let slots: WorkerSlot[] | null = null;
const pendingByRequestId = new Map<string, PendingShard>();
const queuedRequests: Array<{
  requestId: string;
  payload: PathShardRunPayload;
}> = [];
let nextRequestSeq = 0;

function defaultPoolSize(): number {
  const hc =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  // Leave one core for the orchestrator and one for the main UI thread.
  // Cap at 8 — beyond that, postMessage overhead on the per-trial run[]
  // payloads starts to dominate the speedup.
  return Math.max(2, Math.min(8, hc - 1));
}

/**
 * Returns the actual worker count after `ensurePool()`. Callers should match
 * shard count to this value — asking for N+1 shards on an N-worker pool means
 * N shards run in parallel and one straggler runs alone, adding ~1/N wall-
 * clock for nothing. The orchestrator uses this to size each shard batch.
 */
export function getPoolSize(): number {
  return ensurePool().length;
}

/**
 * Prime every worker with the simulation request's `SeedData`. Callers must
 * invoke this BEFORE the first `runShardsInParallel` for `sessionId` — the
 * worker rejects `run` messages whose session isn't primed.
 *
 * Why broadcast: every worker may end up running shards for the request, and
 * postMessage is FIFO per worker, so the prime is guaranteed to land before
 * any subsequent run on the same worker. Total wire cost: `data` × pool-size,
 * paid once. Compared with the previous design (data × pool-size × N shard
 * batches per simulation), this saves several seconds of clone time for real
 * PDF-imported plans where SeedData is hundreds of KB.
 */
export function primeSession(sessionId: string, data: SeedData) {
  const pool = ensurePool();
  for (const slot of pool) {
    slot.worker.postMessage({
      type: 'prime',
      payload: { sessionId, data },
    } satisfies PathShardRequest);
  }
}

/**
 * Drop the cached session payload from every worker. Safe to call after all
 * shard batches for the session have settled — guarantees we don't leak the
 * SeedData reference for the lifetime of the orchestrator worker.
 */
export function unprimeSession(sessionId: string) {
  if (!slots) return;
  for (const slot of slots) {
    slot.worker.postMessage({
      type: 'unprime',
      sessionId,
    } satisfies PathShardRequest);
  }
}

function ensurePool(): WorkerSlot[] {
  if (slots) return slots;
  const size = defaultPoolSize();
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const created: WorkerSlot[] = [];
  for (let i = 0; i < size; i += 1) {
    try {
      const worker = new Worker(
        new URL('./path-shard.worker.ts', import.meta.url),
        { type: 'module' },
      );
      const slot: WorkerSlot = { worker, busy: false, currentRequestId: null };
      worker.addEventListener('message', (event) => handleMessage(slot, event));
      worker.addEventListener('error', (event) => handleError(slot, event));
      created.push(slot);
    } catch (err) {
      // Surface the failure loudly — if nested workers can't spawn, the
      // orchestrator silently falls back to sequential runs and the user
      // sees no speedup. We want that to be visible in the console.
      console.error(
        `[path-shard-pool] failed to spawn worker ${i + 1}/${size}:`,
        err,
      );
    }
  }
  const ms = typeof performance !== 'undefined'
    ? Math.round(performance.now() - t0)
    : 0;
  console.info(
    `[path-shard-pool] initialized ${created.length}/${size} workers in ${ms}ms`,
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
  const req: PathShardRequest = { type: 'run', payload: next.payload };
  slot.worker.postMessage(req);
}

function handleMessage(
  slot: WorkerSlot,
  event: MessageEvent<PathShardResponse>,
) {
  const msg = event.data;
  const pending = pendingByRequestId.get(msg.requestId);
  if (!pending) {
    // Orphan response — the request was never registered or already resolved.
    return;
  }

  switch (msg.type) {
    case 'result': {
      pendingByRequestId.delete(msg.requestId);
      pending.resolve(msg.output);
      break;
    }
    case 'error': {
      pendingByRequestId.delete(msg.requestId);
      pending.reject(new Error(msg.error || 'Path shard worker failed'));
      break;
    }
    case 'cancelled': {
      pendingByRequestId.delete(msg.requestId);
      pending.reject(new Error('SIMULATION_CANCELLED'));
      break;
    }
  }

  // Free the slot and dispatch the next queued shard, if any.
  if (slot.currentRequestId === msg.requestId) {
    slot.busy = false;
    slot.currentRequestId = null;
    dispatchQueued(slot);
  }
}

function handleError(slot: WorkerSlot, event: ErrorEvent) {
  // Worker crashed mid-run. Surface the failure to whatever shard was
  // running on this slot, then mark the slot free so another shard can try.
  if (slot.currentRequestId) {
    const pending = pendingByRequestId.get(slot.currentRequestId);
    if (pending) {
      pendingByRequestId.delete(slot.currentRequestId);
      pending.reject(new Error(event.message || 'Path shard worker crashed'));
    }
  }
  slot.busy = false;
  slot.currentRequestId = null;
  // Best-effort: try to dispatch the next queued shard on this slot. If the
  // worker is genuinely broken the next shard will also error and bubble up.
  dispatchQueued(slot);
}

export interface ShardCancelToken {
  /** Mutable flag the caller may flip true to abort all in-flight shards. */
  cancelled: boolean;
}

/**
 * Run K shards in parallel across the pool and resolve when all K have
 * returned (or any one has rejected).
 *
 * Determinism: callers MUST pass shards whose `trialRange` cover the global
 * trial space `[0, simulationRuns)` exactly once each. The engine uses the
 * GLOBAL trialIndex for seed mixing, so a shard that runs trials [400,500)
 * produces output bit-identical to the same trials in a single-threaded run.
 *
 * If the cancel token is flipped during execution, all queued and in-flight
 * shards are aborted; the returned promise rejects with SIMULATION_CANCELLED.
 */
export async function runShardsInParallel(
  shardPayloads: Array<Omit<PathShardRunPayload, 'requestId'>>,
  cancelToken?: ShardCancelToken,
): Promise<Array<MonteCarloShardOutput<SimulationRunResult>>> {
  const pool = ensurePool();
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const trialCount = shardPayloads.reduce(
    (sum, p) => sum + (p.trialRange.end - p.trialRange.start),
    0,
  );
  const promises: Array<Promise<MonteCarloShardOutput<SimulationRunResult>>> = [];
  const requestIds: string[] = [];

  for (const partial of shardPayloads) {
    const requestId = `shard-${Date.now()}-${nextRequestSeq++}`;
    requestIds.push(requestId);
    const payload: PathShardRunPayload = { ...partial, requestId };

    const promise = new Promise<MonteCarloShardOutput<SimulationRunResult>>(
      (resolve, reject) => {
        pendingByRequestId.set(requestId, {
          resolve,
          reject,
          cancelled: false,
        });
      },
    );
    promises.push(promise);

    // Place on a free slot if one exists; otherwise queue.
    const freeSlot = pool.find((slot) => !slot.busy);
    if (freeSlot) {
      freeSlot.busy = true;
      freeSlot.currentRequestId = requestId;
      const req: PathShardRequest = { type: 'run', payload };
      freeSlot.worker.postMessage(req);
    } else {
      queuedRequests.push({ requestId, payload });
    }
  }

  // Cancellation watcher: poll the token while shards run. Cheap because the
  // token check happens via microtask, not a dedicated timer.
  if (cancelToken) {
    const watchInterval = setInterval(() => {
      if (!cancelToken.cancelled) return;
      clearInterval(watchInterval);
      // Cancel any still-pending requests — both queued and in-flight.
      for (const requestId of requestIds) {
        const pending = pendingByRequestId.get(requestId);
        if (!pending) continue;
        pending.cancelled = true;
        // Find the slot running this requestId, if any, and tell it to cancel.
        const owner = pool.find((slot) => slot.currentRequestId === requestId);
        if (owner) {
          owner.worker.postMessage({
            type: 'cancel',
            requestId,
          } satisfies PathShardRequest);
        } else {
          // Queued but not yet running — drop it from the queue and reject now.
          const idx = queuedRequests.findIndex(
            (q) => q.requestId === requestId,
          );
          if (idx >= 0) {
            queuedRequests.splice(idx, 1);
          }
          pendingByRequestId.delete(requestId);
          pending.reject(new Error('SIMULATION_CANCELLED'));
        }
      }
    }, 50);

    // Make sure the interval gets cleared when all shards settle, regardless
    // of outcome.
    Promise.allSettled(promises).finally(() => clearInterval(watchInterval));
  }

  const results = await Promise.all(promises);
  if (typeof performance !== 'undefined') {
    const ms = Math.round(performance.now() - t0);
    // Sample log so the user can confirm shards are actually running in
    // parallel and see the wall-clock per shard batch. Throttle to avoid
    // spamming the console during long solver loops.
    if (Math.random() < 0.1) {
      console.debug(
        `[path-shard-pool] ${shardPayloads.length} shards / ${trialCount} trials in ${ms}ms (pool=${pool.length})`,
      );
    }
  }
  return results;
}

/** For tests: throw away the current pool so the next call rebuilds it. */
export function _resetShardPoolForTests() {
  if (slots) {
    for (const slot of slots) {
      slot.worker.terminate();
    }
  }
  slots = null;
  pendingByRequestId.clear();
  queuedRequests.length = 0;
  nextRequestSeq = 0;
}

/** Helper for callers that want even shard count without importing the engine. */
export { partitionTrials } from './monte-carlo-engine';

/** Re-export so the orchestrator only needs to import from this file. */
export type { MonteCarloTrialRange };
