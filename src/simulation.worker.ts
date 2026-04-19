/// <reference lib="webworker" />

import { buildPathResults, buildSimulationParityReport } from './utils';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from './simulation-worker-types';

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<string>();

function postMessageToMainThread(message: SimulationWorkerResponse) {
  workerScope.postMessage(message);
}

workerScope.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    cancelledRequests.add(message.requestId);
    return;
  }

  const { requestId, data, assumptions, selectedStressors, selectedResponses } = message.payload;
  cancelledRequests.delete(requestId);

  try {
    const pathResults = buildPathResults(
      data,
      assumptions,
      selectedStressors,
      selectedResponses,
      {
        isCancelled: () => cancelledRequests.has(requestId),
        onProgress: (progress) => {
          postMessageToMainThread({
            type: 'progress',
            requestId,
            progress,
          });
        },
      },
    );
    const parityReport = buildSimulationParityReport(
      data,
      assumptions,
      selectedStressors,
      selectedResponses,
      {
        isCancelled: () => cancelledRequests.has(requestId),
        plannerPathOverride: pathResults[2] ?? pathResults[0],
      },
    );

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
      pathResults,
      parityReport,
    });
  } catch (error) {
    const cancelled =
      cancelledRequests.has(requestId) ||
      (error instanceof Error && error.message === 'SIMULATION_CANCELLED');

    if (cancelled) {
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
      error: error instanceof Error ? error.message : 'Simulation failed',
    });
  }
};
