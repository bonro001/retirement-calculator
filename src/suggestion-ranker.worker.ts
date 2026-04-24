/// <reference lib="webworker" />

import { buildPathResults } from './utils';
import type {
  PathResult,
  PathYearResult,
  MarketAssumptions,
  SeedData,
} from './types';
import type {
  SuggestionOutcome,
  SuggestionRankerWorkerRequest,
  SuggestionRankerWorkerResponse,
} from './suggestion-ranker-worker-types';

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<string>();

function post(message: SuggestionRankerWorkerResponse) {
  workerScope.postMessage(message);
}

function summarize(path: PathResult): Omit<SuggestionOutcome, 'responseId'> {
  let lifetimeFederalTax = 0;
  for (const y of path.yearlySeries as PathYearResult[]) {
    lifetimeFederalTax += y.medianFederalTax ?? 0;
  }
  const firstSpendYear = path.yearlySeries.find(
    (y) => (y.medianSpending ?? 0) > 0,
  );
  const monthlyEstimate = (firstSpendYear?.medianSpending ?? 0) / 12;
  return {
    successRate: path.successRate,
    monthlyEstimate,
    medianEndingWealth: path.medianEndingWealth,
    spendingCutRate: path.spendingCutRate,
    irmaaExposureRate: path.irmaaExposureRate,
    lifetimeFederalTax,
  };
}

function runOne(
  data: SeedData,
  assumptions: MarketAssumptions,
  selectedStressors: string[],
  selectedResponses: string[],
  requestId: string,
) {
  const [primary] = buildPathResults(
    data,
    assumptions,
    selectedStressors,
    selectedResponses,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
      isCancelled: () => cancelledRequests.has(requestId),
    },
  );
  return primary;
}

workerScope.onmessage = (event: MessageEvent<SuggestionRankerWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    cancelledRequests.add(message.requestId);
    return;
  }

  const {
    requestId,
    data,
    assumptions,
    selectedStressors,
    fixedResponses,
    candidates,
    runsPerCandidate = 1500,
  } = message.payload;

  cancelledRequests.delete(requestId);

  // Reduce run count for speed; the results are comparative, not final plan numbers.
  const rankingAssumptions: MarketAssumptions = {
    ...assumptions,
    simulationRuns: runsPerCandidate,
  };

  const throwIfCancelled = () => {
    if (cancelledRequests.has(requestId)) {
      throw new Error('SUGGESTION_RANKING_CANCELLED');
    }
  };

  try {
    // Baseline: the selected stressors + fixed responses, no new candidate.
    const baselinePath = runOne(
      data,
      rankingAssumptions,
      selectedStressors,
      fixedResponses,
      requestId,
    );
    throwIfCancelled();

    post({
      type: 'progress',
      requestId,
      completed: 0,
      total: candidates.length,
    });

    const outcomes: SuggestionOutcome[] = [];
    for (let i = 0; i < candidates.length; i++) {
      throwIfCancelled();
      const candidate = candidates[i];
      const combinedResponses = fixedResponses.includes(candidate.responseId)
        ? fixedResponses
        : [...fixedResponses, candidate.responseId];
      const path = runOne(
        data,
        rankingAssumptions,
        selectedStressors,
        combinedResponses,
        requestId,
      );
      outcomes.push({
        responseId: candidate.responseId,
        ...summarize(path),
      });
      post({
        type: 'progress',
        requestId,
        completed: i + 1,
        total: candidates.length,
      });
    }

    throwIfCancelled();

    post({
      type: 'result',
      requestId,
      baseline: {
        responseId: '__baseline__',
        isBaseline: true,
        ...summarize(baselinePath),
      },
      candidates: outcomes,
    });
  } catch (error) {
    const cancelled =
      cancelledRequests.has(requestId) ||
      (error instanceof Error &&
        (error.message === 'SUGGESTION_RANKING_CANCELLED' ||
          error.message === 'SIMULATION_CANCELLED'));

    if (cancelled) {
      cancelledRequests.delete(requestId);
      post({ type: 'cancelled', requestId });
      return;
    }

    post({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : 'Suggestion ranking failed',
    });
  }
};
