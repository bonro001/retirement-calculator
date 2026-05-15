import type { ModelFidelityAssessment, PathResult } from './types';

export const POLICY_MINING_SUMMARY_CONTRACT_VERSION =
  'policy-mining-summary-v1';

export interface PolicyMiningSummaryModelCompleteness {
  indicator: ModelFidelityAssessment['modelCompleteness'] | 'unknown';
  inferredAssumptions: string[];
  assumptionsVersion?: string;
}

export interface PolicyMiningSummary {
  contractVersion: typeof POLICY_MINING_SUMMARY_CONTRACT_VERSION;
  outputLevel: 'policy_mining_summary';
  sourcePathId: string;
  simulationMode: PathResult['simulationMode'];
  plannerLogicActive: boolean;
  successRate: number;
  yearsFunded: number;
  medianEndingWealth: number;
  endingWealthPercentiles: PathResult['endingWealthPercentiles'];
  annualFederalTaxEstimate: number;
  lifetimeFederalTaxEstimate: number;
  irmaaExposureRate: number;
  spendingCutRate: number;
  rothDepletionRate: number;
  failureYearDistribution: PathResult['failureYearDistribution'];
  worstOutcome: PathResult['worstOutcome'];
  bestOutcome: PathResult['bestOutcome'];
  monteCarloMetadata: PathResult['monteCarloMetadata'];
  modelCompleteness: PolicyMiningSummaryModelCompleteness;
}

export interface TodayDollarPercentiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface PolicyMiningSummaryDifference {
  field: string;
  expected: number;
  actual: number;
  delta: number;
  tolerance: number;
}

export function toTodayDollars(
  nominal: number,
  inflation: number,
  horizonYears: number,
): number {
  const factor = Math.pow(
    1 + Math.max(-0.99, inflation),
    Math.max(0, horizonYears),
  );
  if (factor <= 0) return nominal;
  return nominal / factor;
}

export function pathToPolicyMiningSummary(
  path: PathResult,
  modelCompleteness?: Partial<PolicyMiningSummaryModelCompleteness>,
): PolicyMiningSummary {
  const planningHorizonYears = path.monteCarloMetadata.planningHorizonYears;
  const lifetimeFederalTaxEstimate = path.yearlySeries.length
    ? path.yearlySeries.reduce((total, year) => total + year.medianFederalTax, 0)
    : path.annualFederalTaxEstimate * planningHorizonYears;
  return {
    contractVersion: POLICY_MINING_SUMMARY_CONTRACT_VERSION,
    outputLevel: 'policy_mining_summary',
    sourcePathId: path.id,
    simulationMode: path.simulationMode,
    plannerLogicActive: path.plannerLogicActive,
    successRate: path.successRate,
    yearsFunded: path.yearsFunded,
    medianEndingWealth: path.medianEndingWealth,
    endingWealthPercentiles: { ...path.endingWealthPercentiles },
    annualFederalTaxEstimate: path.annualFederalTaxEstimate,
    lifetimeFederalTaxEstimate,
    irmaaExposureRate: path.irmaaExposureRate,
    spendingCutRate: path.spendingCutRate,
    rothDepletionRate: path.rothDepletionRate,
    failureYearDistribution: path.failureYearDistribution.map((entry) => ({
      ...entry,
    })),
    worstOutcome: { ...path.worstOutcome },
    bestOutcome: { ...path.bestOutcome },
    monteCarloMetadata: { ...path.monteCarloMetadata },
    modelCompleteness: {
      indicator: modelCompleteness?.indicator ?? 'unknown',
      inferredAssumptions: modelCompleteness?.inferredAssumptions
        ? [...modelCompleteness.inferredAssumptions]
        : [],
      assumptionsVersion:
        modelCompleteness?.assumptionsVersion ??
        path.monteCarloMetadata.assumptionsVersion,
    },
  };
}

export function deflateSummaryEndingWealth(
  summary: PolicyMiningSummary,
  inflation: number,
  horizonYears = summary.monteCarloMetadata.planningHorizonYears,
): TodayDollarPercentiles {
  return {
    p10: toTodayDollars(
      summary.endingWealthPercentiles.p10,
      inflation,
      horizonYears,
    ),
    p25: toTodayDollars(
      summary.endingWealthPercentiles.p25,
      inflation,
      horizonYears,
    ),
    p50: toTodayDollars(
      summary.endingWealthPercentiles.p50,
      inflation,
      horizonYears,
    ),
    p75: toTodayDollars(
      summary.endingWealthPercentiles.p75,
      inflation,
      horizonYears,
    ),
    p90: toTodayDollars(
      summary.endingWealthPercentiles.p90,
      inflation,
      horizonYears,
    ),
  };
}

export function comparePolicyMiningSummaries(
  expected: PolicyMiningSummary,
  actual: PolicyMiningSummary,
  tolerance = 1e-9,
): { pass: boolean; firstDifference: PolicyMiningSummaryDifference | null } {
  const wealthTolerance = (value: number) => Math.max(2, Math.abs(value) * 1e-7);
  const fields: Array<
    [
      string,
      (summary: PolicyMiningSummary) => number,
      (expectedValue: number) => number,
    ]
  > = [
    ['successRate', (summary) => summary.successRate, () => tolerance],
    [
      'medianEndingWealth',
      (summary) => summary.medianEndingWealth,
      wealthTolerance,
    ],
    [
      'endingWealthPercentiles.p10',
      (summary) => summary.endingWealthPercentiles.p10,
      wealthTolerance,
    ],
    [
      'endingWealthPercentiles.p50',
      (summary) => summary.endingWealthPercentiles.p50,
      wealthTolerance,
    ],
    [
      'endingWealthPercentiles.p90',
      (summary) => summary.endingWealthPercentiles.p90,
      wealthTolerance,
    ],
    [
      'annualFederalTaxEstimate',
      (summary) => summary.annualFederalTaxEstimate,
      wealthTolerance,
    ],
    ['irmaaExposureRate', (summary) => summary.irmaaExposureRate, () => tolerance],
    ['spendingCutRate', (summary) => summary.spendingCutRate, () => tolerance],
    ['rothDepletionRate', (summary) => summary.rothDepletionRate, () => tolerance],
  ];

  for (const [field, read, toleranceFor] of fields) {
    const expectedValue = read(expected);
    const actualValue = read(actual);
    const delta = Math.abs(expectedValue - actualValue);
    const fieldTolerance = toleranceFor(expectedValue);
    if (delta > fieldTolerance) {
      return {
        pass: false,
        firstDifference: {
          field,
          expected: expectedValue,
          actual: actualValue,
          delta,
          tolerance: fieldTolerance,
        },
      };
    }
  }

  return { pass: true, firstDifference: null };
}
