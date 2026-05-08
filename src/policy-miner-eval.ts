import type { MarketAssumptions, PathResult, SeedData } from './types';
import type { SimulationRandomTape } from './random-tape';
import { buildPathResults, buildPolicyMiningRandomTape } from './utils';
import { approximateBequestAttainmentRate } from './plan-evaluation';
import { policyId } from './policy-axis-enumerator';
import type { Policy, PolicyEvaluation } from './policy-miner-types';
import {
  buildCandidateReplayPackage,
  type CandidateReplayPackage,
} from './candidate-replay-package';
import {
  deflateSummaryEndingWealth,
  pathToPolicyMiningSummary,
  type PolicyMiningSummary,
} from './policy-mining-summary-contract';

/**
 * Pure evaluation helpers for the policy miner.
 *
 * This module is the import surface that BOTH the browser worker
 * (`src/policy-miner.worker.ts`) and the Node host worker
 * (`cluster/host-worker.ts`) load. It deliberately avoids importing
 * anything that touches:
 *   - `indexedDB` (browser-only persistence in `policy-mining-corpus.ts`)
 *   - `Worker` constructors / module URLs (browser-only in `policy-miner-pool.ts`)
 *
 * The dependency graph from here is engine-only: `utils.ts` →
 * `monte-carlo-engine.ts` + tax tables + path builders. Nothing in that
 * subtree references `window`, `document`, `IndexedDB`, or `Worker`, so
 * `tsx cluster/host-worker.ts` can load this file under Node without
 * polyfills.
 *
 * The full mining session orchestrator (`runMiningSession*`) and the
 * IndexedDB corpus writes still live in `policy-miner.ts` — those run
 * only in the browser, where the corpus is stored.
 */

/** A function the host environment provides to clone SeedData safely. */
export type SeedDataCloner = (seed: SeedData) => SeedData;

export type PolicyEvaluationWithSummary = CandidateReplayPackage;

export interface PolicyEvaluationTiming {
  tapeRecordDurationMs: number;
}

export interface PolicyFullTraceOptions {
  selectedStressors?: string[];
  selectedResponses?: string[];
  useHistoricalBootstrap?: boolean;
}

export interface PolicyMiningDeterminismCheck {
  passed: boolean;
  policyId: string;
  seed: number;
  trialCount: number;
  comparedFields: string[];
  firstDifference: {
    field: string;
    first: number;
    second: number;
  } | null;
}

export function buildPolicyEvaluationFromSummary(input: {
  policy: Policy;
  summary: PolicyMiningSummary;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
  evaluationDurationMs: number;
  evaluatedAtIso?: string;
}): PolicyEvaluation {
  const horizonYears = input.summary.monteCarloMetadata.planningHorizonYears ?? 30;
  const inflation = input.assumptions.inflation ?? 0.025;
  const todayDollars = deflateSummaryEndingWealth(
    input.summary,
    inflation,
    horizonYears,
  );
  const bequestAttainmentRate =
    input.legacyTargetTodayDollars > 0
      ? approximateBequestAttainmentRate(input.legacyTargetTodayDollars, {
          p10: todayDollars.p10,
          p25: todayDollars.p25,
          p50: todayDollars.p50,
          p75: todayDollars.p75,
          p90: todayDollars.p90,
        })
      : 1;

  return {
    id: policyId(
      input.policy,
      input.baselineFingerprint,
      input.engineVersion,
    ),
    baselineFingerprint: input.baselineFingerprint,
    engineVersion: input.engineVersion,
    evaluatedByNodeId: input.evaluatedByNodeId,
    evaluatedAtIso: input.evaluatedAtIso ?? new Date().toISOString(),
    policy: input.policy,
    outcome: {
      solventSuccessRate: input.summary.successRate,
      bequestAttainmentRate,
      p10EndingWealthTodayDollars: todayDollars.p10,
      p25EndingWealthTodayDollars: todayDollars.p25,
      p50EndingWealthTodayDollars: todayDollars.p50,
      p75EndingWealthTodayDollars: todayDollars.p75,
      p90EndingWealthTodayDollars: todayDollars.p90,
      // V1 placeholders — these need engine-side aggregation that isn't
      // on PathResult yet. Phase A ships with success/cemetery only;
      // V1.1 adds the spend / tax aggregations.
      medianLifetimeSpendTodayDollars: 0,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars:
        input.summary.annualFederalTaxEstimate ?? 0,
      irmaaExposureRate: input.summary.irmaaExposureRate ?? 0,
    },
    evaluationDurationMs: input.evaluationDurationMs,
  };
}

export function assumptionsForPolicy(
  assumptions: MarketAssumptions,
  policy: Policy,
): MarketAssumptions {
  return policy.withdrawalRule
    ? { ...assumptions, withdrawalRule: policy.withdrawalRule }
    : assumptions;
}

export function buildPolicyMiningReplayInput(
  policy: Policy,
  baseline: SeedData,
  assumptions: MarketAssumptions,
  baselineFingerprint: string,
  engineVersion: string,
  cloner: SeedDataCloner,
  options: {
    replayTape?: SimulationRandomTape;
  } = {},
) {
  const seed = applyPolicyToSeed(cloner(baseline), policy);
  const policyAssumptions = assumptionsForPolicy(assumptions, policy);
  const tape =
    options.replayTape ??
    buildPolicyMiningRandomTape({
      data: seed,
      assumptions: policyAssumptions,
      annualSpendTarget: policy.annualSpendTodayDollars,
      label: `policy-miner:${policyId(
        policy,
        baselineFingerprint,
        engineVersion,
      )}`,
    });
  return {
    candidateData: seed,
    candidateAssumptions: policyAssumptions,
    tape,
    simulationMode: tape.simulationMode,
    annualSpendTarget: policy.annualSpendTodayDollars,
  };
}

export function runPolicyMiningDeterminismCheck(input: {
  policy: Policy;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  cloner: SeedDataCloner;
  trialCount?: number;
}): PolicyMiningDeterminismCheck {
  const trialCount = Math.max(1, Math.floor(input.trialCount ?? 32));
  const policyAssumptions = assumptionsForPolicy(
    {
      ...input.assumptions,
      simulationRuns: trialCount,
    },
    input.policy,
  );
  const runOne = () => {
    const seed = applyPolicyToSeed(input.cloner(input.baseline), input.policy);
    const [path] = buildPathResults(seed, policyAssumptions, [], [], {
      annualSpendTarget: input.policy.annualSpendTodayDollars,
      pathMode: 'selected_only',
      outputLevel: 'policy_mining_summary',
    });
    if (!path) {
      throw new Error('runPolicyMiningDeterminismCheck: engine returned no path results');
    }
    const summary = pathToPolicyMiningSummary(path);
    return {
      successRate: summary.successRate,
      medianEndingWealth: summary.medianEndingWealth,
      tenthPercentileEndingWealth: summary.endingWealthPercentiles.p10,
      annualFederalTaxEstimate: summary.annualFederalTaxEstimate,
      bequestP50: summary.endingWealthPercentiles.p50,
    };
  };
  const first = runOne();
  const second = runOne();
  const comparedFields = Object.keys(first);
  const firstDifference =
    comparedFields
      .map((field) => {
        const key = field as keyof typeof first;
        return first[key] === second[key]
          ? null
          : {
              field,
              first: first[key],
              second: second[key],
            };
      })
      .find((item): item is NonNullable<typeof item> => item !== null) ?? null;

  return {
    passed: firstDifference === null,
    policyId: policyId(input.policy, input.baselineFingerprint, input.engineVersion),
    seed: policyAssumptions.simulationSeed ?? 20260416,
    trialCount,
    comparedFields,
    firstDifference,
  };
}

/**
 * Apply a Policy to a SeedData baseline. Mutates the *clone*, not the
 * original — caller must clone first.
 *
 * Roth conversion policy:
 *   - `maxAnnualDollars` is the visible annual Roth max/mining knob.
 *   - `magiBufferDollars` is threshold safety room around ACA/IRMAA.
 * Older corpora used the buffer as a proxy; new policy application
 * writes both explicitly.
 */
export function applyPolicyToSeed(seed: SeedData, policy: Policy): SeedData {
  // Adjust SS claim ages. SeedData.income.socialSecurity is an array
  // (primary first by convention).
  if (seed.income?.socialSecurity?.[0]) {
    seed.income.socialSecurity[0].claimAge =
      policy.primarySocialSecurityClaimAge;
  }
  if (
    seed.income?.socialSecurity?.[1] &&
    policy.spouseSocialSecurityClaimAge !== null
  ) {
    seed.income.socialSecurity[1].claimAge =
      policy.spouseSocialSecurityClaimAge;
  }
  // Roth conversion max: see caveat above.
  if (!seed.rules) {
    // SeedData.rules is required by the type, but be defensive.
    return seed;
  }
  seed.rules.rothConversionPolicy = {
    ...(seed.rules.rothConversionPolicy ?? {}),
    enabled: policy.rothConversionAnnualCeiling > 0,
    minAnnualDollars: 0,
    maxAnnualDollars: policy.rothConversionAnnualCeiling,
    magiBufferDollars: seed.rules.rothConversionPolicy?.magiBufferDollars ?? 2_000,
  };
  return seed;
}

/**
 * Run the engine on a single policy. The host passes its own SeedData
 * cloner so this module stays free of lodash / structuredClone version
 * concerns (the worker context may not have structuredClone).
 */
export async function evaluatePolicy(
  policy: Policy,
  baseline: SeedData,
  assumptions: MarketAssumptions,
  baselineFingerprint: string,
  engineVersion: string,
  evaluatedByNodeId: string,
  cloner: SeedDataCloner,
  legacyTargetTodayDollars: number,
): Promise<PolicyEvaluation> {
  const run = await evaluatePolicyWithSummary(
    policy,
    baseline,
    assumptions,
    baselineFingerprint,
    engineVersion,
    evaluatedByNodeId,
    cloner,
    legacyTargetTodayDollars,
  );
  return run.evaluation;
}

export async function evaluatePolicyWithSummary(
  policy: Policy,
  baseline: SeedData,
  assumptions: MarketAssumptions,
  baselineFingerprint: string,
  engineVersion: string,
  evaluatedByNodeId: string,
  cloner: SeedDataCloner,
  legacyTargetTodayDollars: number,
  options: {
    recordTape?: boolean;
    onTiming?: (timing: PolicyEvaluationTiming) => void;
  } = {},
): Promise<CandidateReplayPackage> {
  const startMs = Date.now();
  const seed = applyPolicyToSeed(cloner(baseline), policy);
  // Per-candidate assumptions clone with the policy's withdrawal rule
  // applied. Mining sweeps this axis so each candidate runs against
  // its own rule; the engine reads `assumptions.withdrawalRule` in
  // `getStrategyBehavior` and the rule drives the per-year cascade.
  const policyAssumptions = assumptionsForPolicy(assumptions, policy);
  // Run all four standard paths (baseline + downside + upside + selected
  // stressors). For the miner we want the BASELINE path — `paths[0]` per
  // convention — so we run with no stressors and pull the first path.
  let recordedTape: CandidateReplayPackage['tape'];
  let tapeRecordDurationMs = 0;
  const paths = buildPathResults(seed, policyAssumptions, [], [], {
    annualSpendTarget: policy.annualSpendTodayDollars,
    pathMode: 'selected_only',
    outputLevel: 'policy_mining_summary',
    randomTape: options.recordTape
      ? {
          mode: 'record',
          label: `policy-miner:${policyId(
            policy,
            baselineFingerprint,
            engineVersion,
          )}`,
          onRecord: (tape) => {
            const tapeRecordStartedAt = performance.now();
            recordedTape = tape;
            tapeRecordDurationMs += performance.now() - tapeRecordStartedAt;
          },
        }
      : undefined,
  });
  options.onTiming?.({ tapeRecordDurationMs });
  const baselinePath = paths[0];
  if (!baselinePath) {
    throw new Error('evaluatePolicy: engine returned no path results');
  }

  const summary = pathToPolicyMiningSummary(baselinePath);
  const evaluation = buildPolicyEvaluationFromSummary({
    policy,
    summary,
    assumptions: policyAssumptions,
    baselineFingerprint,
    engineVersion,
    evaluatedByNodeId,
    legacyTargetTodayDollars,
    evaluationDurationMs: Date.now() - startMs,
  });

  return buildCandidateReplayPackage({
    policy,
    evaluation,
    summary,
    candidateData: seed,
    candidateAssumptions: policyAssumptions,
    tape: recordedTape,
  });
}

/**
 * Re-run one mined policy with the full explainability trace.
 *
 * Corpus mining uses `policy_mining_summary` so ranking stays cheap.
 * Drilldowns and cockpit finalist views call this helper for the top
 * candidate slice only, preserving the same policy mutation, withdrawal
 * rule handling, and annual-spend target as the mining evaluator.
 */
export function evaluatePolicyFullTrace(
  policy: Policy,
  baseline: SeedData,
  assumptions: MarketAssumptions,
  cloner: SeedDataCloner,
  options: PolicyFullTraceOptions = {},
): PathResult {
  const seed = applyPolicyToSeed(cloner(baseline), policy);
  const policyAssumptions = assumptionsForPolicy(
    options.useHistoricalBootstrap === undefined
      ? assumptions
      : { ...assumptions, useHistoricalBootstrap: options.useHistoricalBootstrap },
    policy,
  );
  const paths = buildPathResults(
    seed,
    policyAssumptions,
    options.selectedStressors ?? [],
    options.selectedResponses ?? [],
    {
      annualSpendTarget: policy.annualSpendTodayDollars,
      pathMode: 'selected_only',
      outputLevel: 'full_trace',
    },
  );
  const path = paths[0];
  if (!path) {
    throw new Error('evaluatePolicyFullTrace: engine returned no path results');
  }
  return path;
}
