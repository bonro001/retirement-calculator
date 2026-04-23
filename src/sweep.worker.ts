/// <reference lib="webworker" />

import { buildPathResults } from './utils';
import type { SweepWorkerRequest, SweepWorkerResponse } from './sweep-worker-types';

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledBatches = new Set<string>();

function post(msg: SweepWorkerResponse) {
  workerScope.postMessage(msg);
}

workerScope.onmessage = (event: MessageEvent<SweepWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    cancelledBatches.add(message.batchId);
    return;
  }

  const { batchId, points } = message.payload;
  cancelledBatches.delete(batchId);

  try {
    for (let i = 0; i < points.length; i += 1) {
      if (cancelledBatches.has(batchId)) {
        post({ type: 'cancelled', batchId });
        cancelledBatches.delete(batchId);
        return;
      }

      const point = points[i];
      const [path] = buildPathResults(
        point.data,
        point.assumptions,
        point.selectedStressors,
        point.selectedResponses,
        {
          pathMode: 'selected_only',
          strategyMode: point.strategyMode,
          isCancelled: () => cancelledBatches.has(batchId),
          onProgress: (pointProgress) => {
            post({
              type: 'progress',
              batchId,
              pointId: point.pointId,
              index: i,
              total: points.length,
              pointProgress,
            });
          },
        },
      );

      if (cancelledBatches.has(batchId)) {
        post({ type: 'cancelled', batchId });
        cancelledBatches.delete(batchId);
        return;
      }

      post({
        type: 'point',
        batchId,
        pointId: point.pointId,
        index: i,
        total: points.length,
        path,
      });
    }

    post({ type: 'done', batchId });
  } catch (error) {
    const cancelled =
      cancelledBatches.has(batchId) ||
      (error instanceof Error && error.message === 'SIMULATION_CANCELLED');
    if (cancelled) {
      cancelledBatches.delete(batchId);
      post({ type: 'cancelled', batchId });
      return;
    }
    post({
      type: 'error',
      batchId,
      error: error instanceof Error ? error.message : 'Sweep failed',
    });
  }
};
