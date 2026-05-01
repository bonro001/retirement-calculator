/// <reference lib="webworker" />

import {
  buildPathResults,
  buildSimulationParityReport,
  getSocialSecurityBenefitFactor,
} from './utils';
import { solveSpendByReverseTimeline } from './spend-solver';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
  SolvedSpendProfile,
} from './simulation-worker-types';

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<string>();

const SANDBOX_SUCCESS_TARGET = 0.85;

function postMessageToMainThread(message: SimulationWorkerResponse) {
  workerScope.postMessage(message);
}

workerScope.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
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
    selectedResponses,
    stressorKnobs,
  } = message.payload;
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
          // Reserve the top of the progress bar for the parity + solver phases
          // that still run after buildPathResults finishes. Without this the UI
          // sits at "Running 100%" for ~30s while the spend solver churns,
          // which reads as "stuck" to users.
          postMessageToMainThread({
            type: 'progress',
            requestId,
            progress: Math.min(progress, 1) * 0.7,
          });
        },
        stressorKnobs,
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
        stressorKnobs,
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

    // Parity report is done; give the UI a visible nudge before the solver
    // starts its multi-iteration run so the progress bar doesn't appear stuck.
    postMessageToMainThread({
      type: 'progress',
      requestId,
      progress: 0.75,
    });

    // Run the committed spend solver so the sandbox can show an honest
    // "constant-real monthly spend at 85% success" headline rather than the
    // generous year-1 flex pace. Use a reduced run budget — the sandbox is
    // comparative, not a final plan commit.
    let solvedSpendProfile: SolvedSpendProfile | null = null;
    if (message.payload.solvedSpendMode !== 'skip') {
      try {
        const solved = solveSpendByReverseTimeline({
          data,
          assumptions,
          selectedStressors,
          selectedResponses,
          stressorKnobs,
          targetLegacyTodayDollars: 0,
          minSuccessRate: SANDBOX_SUCCESS_TARGET,
          toleranceAnnual: 400,
          maxIterations: 8,
          runtimeBudget: {
            searchSimulationRuns: 300,
            finalSimulationRuns: 600,
            maxIterations: 8,
            diagnosticsMode: 'core',
            enableSuccessRelaxationProbe: false,
          },
        });
        // Floor each retirement-smile phase at the household's guaranteed real
        // monthly income for that phase. The solver can legitimately return a
        // "supported spend" below Social Security because it's optimizing
        // portfolio longevity, but you physically cannot spend less than the
        // fixed income arriving each month. Clamping makes the headline match
        // what the household will actually experience.
        const socialSecurity = data.income.socialSecurity ?? [];
        const monthlyIncomeFloorForPhaseMinAge = (phaseMinAge: number) =>
          socialSecurity.reduce((total, entry) => {
            if (entry.claimAge > phaseMinAge) return total;
            return total + entry.fraMonthly * getSocialSecurityBenefitFactor(entry.claimAge);
          }, 0);
        const floor60s = monthlyIncomeFloorForPhaseMinAge(60);
        const floor70s = monthlyIncomeFloorForPhaseMinAge(70);
        const floor80Plus = monthlyIncomeFloorForPhaseMinAge(80);

        const raw60 = solved.supportedSpend60s / 12;
        const raw70 = solved.supportedSpend70s / 12;
        const raw80 = solved.supportedSpend80Plus / 12;
        solvedSpendProfile = {
          monthlySpendNow: solved.supportedMonthlySpendNow,
          monthly60s: Math.max(raw60, floor60s),
          monthly70s: Math.max(raw70, floor70s),
          monthly80Plus: Math.max(raw80, floor80Plus),
          rawMonthly60s: raw60,
          rawMonthly70s: raw70,
          rawMonthly80Plus: raw80,
          floorMonthly60s: floor60s,
          floorMonthly70s: floor70s,
          floorMonthly80Plus: floor80Plus,
          successTarget: SANDBOX_SUCCESS_TARGET,
          achievedSuccess: solved.achievedSuccessRate ?? solved.modeledSuccessRate ?? SANDBOX_SUCCESS_TARGET,
        };
      } catch {
        // Non-fatal: if the solver can't find a spend level we fall back to the
        // year-1 flex pace on the UI side.
        solvedSpendProfile = null;
      }
    }

    postMessageToMainThread({
      type: 'progress',
      requestId,
      progress: 0.98,
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
      pathResults,
      parityReport,
      solvedSpendProfile,
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
