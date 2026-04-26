/// <reference lib="webworker" />

import { runSimulationShard } from './utils';
import type { SeedData } from './types';
import type {
  PathShardRequest,
  PathShardResponse,
} from './path-shard-worker-types';

/**
 * Trial-shard worker. Executes a single contiguous trial range for one path
 * configuration and returns the engine's raw shard output.
 *
 * Session model: the orchestrator primes each worker with the request's
 * `SeedData` once per simulation via `{ type: 'prime', payload: { sessionId,
 * data } }`. Subsequent `run` messages reference the cached `data` by
 * `sessionId`. `unprime` evicts the session at the end of the request. This
 * keeps the dominant SeedData payload off the per-shard postMessage path —
 * with 30+ shard batches per simulation × pool-size workers, eliminating
 * those clones is worth several seconds of wall-clock.
 *
 * Cancellation: the orchestrator can post `{ type: 'cancel', requestId }` to
 * abort an in-flight shard. The engine's loop checks isCancelled between
 * trials and throws SIMULATION_CANCELLED, which we translate into a
 * `{ type: 'cancelled', requestId }` response.
 */

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<string>();
const sessionData = new Map<string, SeedData>();

function post(msg: PathShardResponse) {
  workerScope.postMessage(msg);
}

workerScope.onmessage = (event: MessageEvent<PathShardRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    cancelledRequests.add(message.requestId);
    return;
  }

  if (message.type === 'prime') {
    sessionData.set(message.payload.sessionId, message.payload.data);
    return;
  }

  if (message.type === 'unprime') {
    sessionData.delete(message.sessionId);
    return;
  }

  const { payload } = message;
  const { requestId, sessionId } = payload;
  cancelledRequests.delete(requestId);

  const data = sessionData.get(sessionId);
  if (!data) {
    post({
      type: 'error',
      requestId,
      error: `Path shard worker: session ${sessionId} not primed (run received before prime, or session already evicted).`,
    });
    return;
  }

  try {
    const output = runSimulationShard(
      data,
      payload.assumptions,
      payload.stressors,
      payload.responses,
      payload.trialRange,
      {
        annualSpendTarget: payload.annualSpendTarget,
        annualSpendScheduleByYear: payload.annualSpendScheduleByYear,
        pathMode: payload.pathMode,
        strategyMode: payload.strategyMode,
        stressorKnobs: payload.stressorKnobs,
        isCancelled: () => cancelledRequests.has(requestId),
        // No onProgress: shard runs are short (~150 trials each at K=8) and
        // chatting per-trial across the worker boundary is wasteful. The
        // orchestrator estimates progress from completed-shard counts.
      },
    );

    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      post({ type: 'cancelled', requestId });
      return;
    }

    post({ type: 'result', requestId, output });
  } catch (error) {
    const cancelled =
      cancelledRequests.has(requestId) ||
      (error instanceof Error && error.message === 'SIMULATION_CANCELLED');
    if (cancelled) {
      cancelledRequests.delete(requestId);
      post({ type: 'cancelled', requestId });
      return;
    }
    post({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : 'Path shard failed',
    });
  }
};
