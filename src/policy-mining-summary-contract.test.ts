import { describe, expect, it } from 'vitest';
import {
  POLICY_MINING_SUMMARY_CONTRACT_VERSION,
  comparePolicyMiningSummaries,
  deflateSummaryEndingWealth,
  pathToPolicyMiningSummary,
} from './policy-mining-summary-contract';
import { initialSeedData } from './data';
import { DEFAULT_ENGINE_COMPARE_ASSUMPTIONS } from './engine-compare';
import type { PathResult } from './types';
import { buildPathResults } from './utils';

function makePath(overrides: Partial<PathResult> = {}): PathResult {
  return {
    id: 'baseline',
    label: 'Baseline',
    simulationMode: 'planner_enhanced',
    plannerLogicActive: true,
    successRate: 0.91,
    medianEndingWealth: 500_000,
    tenthPercentileEndingWealth: 100_000,
    yearsFunded: 30,
    medianFailureYear: null,
    spendingCutRate: 0.08,
    irmaaExposureRate: 0.2,
    homeSaleDependenceRate: 0,
    inheritanceDependenceRate: 0,
    flexibilityScore: 80,
    cornerRiskScore: 10,
    rothDepletionRate: 0.12,
    annualFederalTaxEstimate: 24_000,
    irmaaExposure: 'Low',
    cornerRisk: 'Low',
    failureMode: 'none',
    notes: '',
    stressors: [],
    responses: [],
    endingWealthPercentiles: {
      p10: 100_000,
      p25: 250_000,
      p50: 500_000,
      p75: 750_000,
      p90: 900_000,
    },
    failureYearDistribution: [{ year: 2045, count: 2, rate: 0.02 }],
    worstOutcome: {
      endingWealth: -10_000,
      success: false,
      failureYear: 2045,
    },
    bestOutcome: {
      endingWealth: 1_500_000,
      success: true,
      failureYear: null,
    },
    monteCarloMetadata: {
      seed: 123,
      trialCount: 100,
      assumptionsVersion: 'test-assumptions',
      planningHorizonYears: 10,
    },
    simulationConfiguration: {} as PathResult['simulationConfiguration'],
    simulationDiagnostics: {} as PathResult['simulationDiagnostics'],
    riskMetrics: {} as PathResult['riskMetrics'],
    yearlySeries: [],
    ...overrides,
  };
}

describe('policy mining summary contract', () => {
  it('maps the lean policy-mining fields from a PathResult', () => {
    const summary = pathToPolicyMiningSummary(makePath(), {
      indicator: 'reconstructed',
      inferredAssumptions: ['assumptions.simulationSeed(defaulted)'],
    });

    expect(summary.contractVersion).toBe(POLICY_MINING_SUMMARY_CONTRACT_VERSION);
    expect(summary.outputLevel).toBe('policy_mining_summary');
    expect(summary.successRate).toBe(0.91);
    expect(summary.endingWealthPercentiles.p50).toBe(500_000);
    expect(summary.annualFederalTaxEstimate).toBe(24_000);
    expect(summary.irmaaExposureRate).toBe(0.2);
    expect(summary.modelCompleteness.indicator).toBe('reconstructed');
    expect(summary.modelCompleteness.inferredAssumptions).toEqual([
      'assumptions.simulationSeed(defaulted)',
    ]);
  });

  it('deflates ending wealth percentiles with the explicit horizon', () => {
    const summary = pathToPolicyMiningSummary(makePath());
    const todayDollars = deflateSummaryEndingWealth(summary, 0.025);

    expect(todayDollars.p50).toBeCloseTo(390_599.2, 2);
  });

  it('compares summary fields with field-specific tolerances', () => {
    const expected = pathToPolicyMiningSummary(makePath());
    const actual = pathToPolicyMiningSummary(
      makePath({
        endingWealthPercentiles: {
          ...expected.endingWealthPercentiles,
          p50: expected.endingWealthPercentiles.p50 + 3,
        },
      }),
    );

    const comparison = comparePolicyMiningSummaries(expected, actual);

    expect(comparison.pass).toBe(false);
    expect(comparison.firstDifference?.field).toBe(
      'endingWealthPercentiles.p50',
    );
  });

  it('keeps policy-mining summary fields equal between full and summary-only paths', { timeout: 20_000 }, () => {
    const assumptions = {
      ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
      simulationRuns: 8,
      assumptionsVersion: 'summary-only-parity-test',
    };
    const fullPath = buildPathResults(initialSeedData, assumptions, [], [], {
      annualSpendTarget: 120_000,
      pathMode: 'selected_only',
    })[0];
    const summaryOnlyPath = buildPathResults(
      initialSeedData,
      assumptions,
      [],
      [],
      {
        annualSpendTarget: 120_000,
        pathMode: 'selected_only',
        outputLevel: 'policy_mining_summary',
      },
    )[0];

    const comparison = comparePolicyMiningSummaries(
      pathToPolicyMiningSummary(fullPath),
      pathToPolicyMiningSummary(summaryOnlyPath),
    );

    expect(comparison.pass).toBe(true);
    expect(summaryOnlyPath.simulationDiagnostics.withdrawalPath).toHaveLength(0);
  });
});
