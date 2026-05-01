import type {
  EngineCandidateRequest,
  EngineCandidateRequestV1,
} from './engine-compare';
import type { SimulationRandomTape } from './random-tape';
import type {
  MarketAssumptions,
  SeedData,
  SimulationStrategyMode,
} from './types';
import type { Policy, PolicyEvaluation } from './policy-miner-types';
import type { PolicyMiningSummary } from './policy-mining-summary-contract';

export const CANDIDATE_REPLAY_PACKAGE_VERSION =
  'candidate-replay-package-v1';

export interface CandidateReplayPackage {
  packageVersion: typeof CANDIDATE_REPLAY_PACKAGE_VERSION;
  policy: Policy;
  evaluation: PolicyEvaluation;
  summary: PolicyMiningSummary;
  candidateData: SeedData;
  candidateAssumptions: MarketAssumptions;
  simulationMode: SimulationStrategyMode;
  annualSpendTarget: number;
  tape?: SimulationRandomTape;
}

function compactTapeForSummaryRequest(
  tape: SimulationRandomTape,
): SimulationRandomTape {
  return {
    ...tape,
    trials: tape.trials.map((trial) => ({
      trialIndex: trial.trialIndex,
      trialSeed: trial.trialSeed,
      ltcEventOccurs: trial.ltcEventOccurs,
      marketPath: trial.marketPath.map((year) => ({
        year: year.year,
        yearOffset: year.yearOffset,
        inflation: year.inflation,
        assetReturns: year.assetReturns,
        bucketReturns: year.bucketReturns,
        cashflow: year.cashflow
          ? ({} as NonNullable<typeof year.cashflow>)
          : undefined,
        marketState: year.marketState,
      })),
    })),
  };
}

export function buildCandidateReplayPackage(input: {
  policy: Policy;
  evaluation: PolicyEvaluation;
  summary: PolicyMiningSummary;
  candidateData: SeedData;
  candidateAssumptions: MarketAssumptions;
  tape?: SimulationRandomTape;
}): CandidateReplayPackage {
  return {
    packageVersion: CANDIDATE_REPLAY_PACKAGE_VERSION,
    policy: input.policy,
    evaluation: input.evaluation,
    summary: input.summary,
    candidateData: input.candidateData,
    candidateAssumptions: input.candidateAssumptions,
    simulationMode: input.summary.simulationMode,
    annualSpendTarget: input.policy.annualSpendTodayDollars,
    tape: input.tape,
  };
}

export function candidateReplayPackageToRequest(
  replayPackage: CandidateReplayPackage,
  outputLevel: EngineCandidateRequestV1['outputLevel'] = 'full_trace',
): EngineCandidateRequest {
  if (!replayPackage.tape) {
    throw new Error('Candidate replay package is missing random tape');
  }
  return {
    schemaVersion: 'engine-candidate-request-v1',
    data: replayPackage.candidateData,
    assumptions: replayPackage.candidateAssumptions,
    mode: replayPackage.simulationMode,
    tape:
      outputLevel === 'policy_mining_summary'
        ? compactTapeForSummaryRequest(replayPackage.tape)
        : replayPackage.tape,
    annualSpendTarget: replayPackage.annualSpendTarget,
    outputLevel,
  };
}
