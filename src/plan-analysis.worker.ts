/// <reference lib="webworker" />

import { evaluatePlan } from './plan-evaluation';
import type {
  PlanAnalysisWorkerRequest,
  PlanAnalysisWorkerResponse,
} from './plan-analysis-worker-types';

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<string>();

function postMessageToMainThread(message: PlanAnalysisWorkerResponse) {
  workerScope.postMessage(message);
}

workerScope.onmessage = (event: MessageEvent<PlanAnalysisWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    cancelledRequests.add(message.requestId);
    return;
  }

  const { requestId, plan } = message.payload;
  cancelledRequests.delete(requestId);

  void (async () => {
    try {
      const evaluation = await evaluatePlan(plan, {
        onPhaseProgress: (progress) => {
          if (cancelledRequests.has(requestId)) {
            return;
          }
          postMessageToMainThread({
            type: 'progress',
            requestId,
            phase: progress.phase,
            status: progress.status,
            durationMs: progress.durationMs,
            meta: progress.meta,
          });
        },
      });

      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        postMessageToMainThread({
          type: 'cancelled',
          requestId,
        });
        return;
      }

      postMessageToMainThread({
        type: 'result',
        requestId,
        evaluation,
      });
    } catch (error) {
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        postMessageToMainThread({
          type: 'cancelled',
          requestId,
        });
        return;
      }

      postMessageToMainThread({
        type: 'error',
        requestId,
        error: error instanceof Error ? error.message : 'Plan analysis failed',
      });
    }
  })();
};
