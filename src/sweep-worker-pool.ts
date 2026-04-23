import type {
  SweepPointInput,
  SweepWorkerRequest,
  SweepWorkerResponse,
} from './sweep-worker-types';

/**
 * Shared pool of sweep workers. All sweep-style sensitivity hooks dispatch
 * into this pool so we parallelize across available cores without creating
 * one worker per hook instance or per Calculate click.
 *
 * Design:
 *   - A user-level batch is split across all workers by round-robin on
 *     point index.
 *   - Each worker gets its own sub-batch id: `${userBatchId}::${workerIdx}`.
 *   - Pool routes per-sub-batch events back to the user-level onEvent
 *     callback, translating (index, total) from worker-local to
 *     user-global and re-flagging the batchId.
 *   - cancel() broadcasts a cancel message to every sub-batch.
 */

export interface SweepPoolHandle {
  batchId: string;
  cancel: () => void;
}

export interface UserLevelSweepEvent {
  /** Re-emitted with the user-level batchId, not the sub-batch id. */
  raw: SweepWorkerResponse;
}

interface SubBatchState {
  // Indices of user-level points routed to this sub-batch, in order.
  userIndices: number[];
}

interface UserBatchState {
  onEvent: (msg: SweepWorkerResponse) => void;
  subBatches: Map<string, SubBatchState>; // sub-batch id → state
  subBatchesRemaining: number;
  totalPoints: number;
  cancelled: boolean;
  pointsCompleted: number;
}

let pool: Worker[] | null = null;
let poolInitInFlight: Promise<Worker[]> | null = null;

const activeBatches = new Map<string, UserBatchState>();
const subBatchToUserBatch = new Map<string, string>();

function workerCount(): number {
  const hc =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  // Cap at 4 to avoid memory pressure from many simultaneous sim threads,
  // and leave one core for the main/UI thread.
  return Math.max(2, Math.min(4, hc - 1));
}

function ensurePool(): Worker[] {
  if (pool) return pool;
  if (poolInitInFlight) {
    // Should not happen in practice — ensurePool is sync — but guard anyway.
    throw new Error('Pool init in flight unexpectedly');
  }
  const count = workerCount();
  const created: Worker[] = [];
  for (let i = 0; i < count; i += 1) {
    const worker = new Worker(new URL('./sweep.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', handlePoolMessage);
    worker.addEventListener('error', handlePoolError);
    created.push(worker);
  }
  pool = created;
  return pool;
}

function handlePoolMessage(event: MessageEvent<SweepWorkerResponse>) {
  const msg = event.data;
  const subBatchId = msg.batchId;
  const userBatchId = subBatchToUserBatch.get(subBatchId);
  if (!userBatchId) return; // orphan event, batch already cleaned up
  const state = activeBatches.get(userBatchId);
  if (!state || state.cancelled) return;

  const sub = state.subBatches.get(subBatchId);
  if (!sub) return;

  if (msg.type === 'progress') {
    const globalIndex = sub.userIndices[msg.index];
    if (globalIndex === undefined) return;
    state.onEvent({
      type: 'progress',
      batchId: userBatchId,
      pointId: msg.pointId,
      index: globalIndex,
      total: state.totalPoints,
      pointProgress: msg.pointProgress,
    });
  } else if (msg.type === 'point') {
    const globalIndex = sub.userIndices[msg.index];
    if (globalIndex === undefined) return;
    state.pointsCompleted += 1;
    state.onEvent({
      type: 'point',
      batchId: userBatchId,
      pointId: msg.pointId,
      index: globalIndex,
      total: state.totalPoints,
      path: msg.path,
    });
  } else if (msg.type === 'done') {
    state.subBatchesRemaining -= 1;
    state.subBatches.delete(subBatchId);
    subBatchToUserBatch.delete(subBatchId);
    if (state.subBatchesRemaining === 0) {
      activeBatches.delete(userBatchId);
      state.onEvent({ type: 'done', batchId: userBatchId });
    }
  } else if (msg.type === 'cancelled') {
    state.subBatchesRemaining -= 1;
    state.subBatches.delete(subBatchId);
    subBatchToUserBatch.delete(subBatchId);
    if (state.subBatchesRemaining === 0) {
      activeBatches.delete(userBatchId);
      state.onEvent({ type: 'cancelled', batchId: userBatchId });
    }
  } else if (msg.type === 'error') {
    // Take the first error, cancel siblings, surface one error at the user level.
    if (!state.cancelled) {
      state.cancelled = true;
      for (const siblingSubBatchId of state.subBatches.keys()) {
        if (siblingSubBatchId === subBatchId) continue;
        const workerIdx = parseWorkerIndex(siblingSubBatchId);
        const targetWorker = workerIdx !== null ? pool?.[workerIdx] : undefined;
        if (targetWorker) {
          const cancelMsg: SweepWorkerRequest = {
            type: 'cancel',
            batchId: siblingSubBatchId,
          };
          targetWorker.postMessage(cancelMsg);
        }
      }
      state.onEvent({ type: 'error', batchId: userBatchId, error: msg.error });
      // Clean up tracking; late cancelled events from siblings will be ignored.
      for (const siblingSubBatchId of state.subBatches.keys()) {
        subBatchToUserBatch.delete(siblingSubBatchId);
      }
      activeBatches.delete(userBatchId);
    }
  }
}

function parseWorkerIndex(subBatchId: string): number | null {
  const sep = subBatchId.lastIndexOf('::');
  if (sep < 0) return null;
  const parsed = Number.parseInt(subBatchId.slice(sep + 2), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function handlePoolError(event: ErrorEvent) {
  // Surface as an error against every active batch. Rare — usually module
  // load failures or an uncaught throw in the worker.
  for (const [userBatchId, state] of activeBatches) {
    if (state.cancelled) continue;
    state.cancelled = true;
    state.onEvent({
      type: 'error',
      batchId: userBatchId,
      error: event.message || 'Sweep worker crashed',
    });
    for (const subBatchId of state.subBatches.keys()) {
      subBatchToUserBatch.delete(subBatchId);
    }
    activeBatches.delete(userBatchId);
  }
}

export function runSweepBatch(
  userBatchId: string,
  points: SweepPointInput[],
  onEvent: (msg: SweepWorkerResponse) => void,
): SweepPoolHandle {
  const workers = ensurePool();
  const numWorkers = Math.min(workers.length, points.length);

  // Partition points round-robin across workers so variable per-point cost
  // tends to balance out.
  const partitions: SweepPointInput[][] = Array.from({ length: numWorkers }, () => []);
  const globalIndexPerPartition: number[][] = Array.from({ length: numWorkers }, () => []);
  for (let i = 0; i < points.length; i += 1) {
    const slot = i % numWorkers;
    partitions[slot].push(points[i]);
    globalIndexPerPartition[slot].push(i);
  }

  const state: UserBatchState = {
    onEvent,
    subBatches: new Map(),
    subBatchesRemaining: numWorkers,
    totalPoints: points.length,
    cancelled: false,
    pointsCompleted: 0,
  };
  activeBatches.set(userBatchId, state);

  for (let w = 0; w < numWorkers; w += 1) {
    const subBatchId = `${userBatchId}::${w}`;
    const sub: SubBatchState = { userIndices: globalIndexPerPartition[w] };
    state.subBatches.set(subBatchId, sub);
    subBatchToUserBatch.set(subBatchId, userBatchId);
    const runMsg: SweepWorkerRequest = {
      type: 'run',
      payload: { batchId: subBatchId, points: partitions[w] },
    };
    workers[w].postMessage(runMsg);
  }

  return {
    batchId: userBatchId,
    cancel: () => {
      const active = activeBatches.get(userBatchId);
      if (!active || active.cancelled) return;
      active.cancelled = true;
      for (const subBatchId of active.subBatches.keys()) {
        const workerIdx = parseWorkerIndex(subBatchId);
        const target = workerIdx !== null ? workers[workerIdx] : undefined;
        if (target) {
          const cancelMsg: SweepWorkerRequest = { type: 'cancel', batchId: subBatchId };
          target.postMessage(cancelMsg);
        }
      }
    },
  };
}

// Exposed for tests / manual cleanup only. Not normally needed — the pool
// lives for the lifetime of the tab.
export function __terminateSweepPoolForTests() {
  if (pool) {
    for (const w of pool) w.terminate();
    pool = null;
  }
  activeBatches.clear();
  subBatchToUserBatch.clear();
  poolInitInFlight = null;
}
