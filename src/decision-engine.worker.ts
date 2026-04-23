/// <reference lib="webworker" />

import { evaluateDecisionLevers } from './decision-engine';
import { buildPathResults } from './utils';
import type {
  DecisionEngineWorkerRequest,
  DecisionEngineWorkerResponse,
} from './decision-engine-worker-types';

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<string>();

function post(message: DecisionEngineWorkerResponse) {
  workerScope.postMessage(message);
}

workerScope.onmessage = (event: MessageEvent<DecisionEngineWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    cancelledRequests.add(message.requestId);
    return;
  }

  const payload = message.payload;
  const {
    requestId,
    data,
    assumptions,
    selectedStressors,
    selectedResponses,
    strategyMode,
    simulationRunsOverride,
    seedBase,
    constraints,
  } = payload;

  cancelledRequests.delete(requestId);

  void (async () => {
    try {
      const [baselinePath] = buildPathResults(
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
        {
          pathMode: 'selected_only',
          strategyMode,
          isCancelled: () => cancelledRequests.has(requestId),
        },
      );

      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        post({ type: 'cancelled', requestId });
        return;
      }

      const report = await evaluateDecisionLevers(
        {
          data,
          assumptions,
          selectedStressors,
          selectedResponses,
          strategyMode,
        },
        {
          strategyMode,
          simulationRunsOverride,
          seedBase,
          seedStrategy: 'shared',
          constraints,
          evaluateExcludedScenarios: true,
        },
      );

      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        post({ type: 'cancelled', requestId });
        return;
      }

      post({ type: 'result', requestId, baselinePath, report });
    } catch (error) {
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        post({ type: 'cancelled', requestId });
        return;
      }
      post({
        type: 'error',
        requestId,
        error: error instanceof Error ? error.message : 'Decision engine failed',
      });
    }
  })();
};
