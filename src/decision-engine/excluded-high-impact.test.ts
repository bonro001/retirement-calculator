import { describe, expect, it } from 'vitest';
import { deriveExcludedHighImpactLevers } from './excluded-high-impact';
import type { LeverScenarioResult } from './types';

function buildScenario(
  overrides?: Partial<LeverScenarioResult>,
): LeverScenarioResult {
  return {
    scenarioId: 'scenario',
    name: 'Scenario',
    category: 'spending',
    disruption: 'low',
    complexity: 'simple',
    tags: ['optional_cut'],
    isSensitivity: false,
    metrics: {
      successRate: 0.8,
      failureRate: 0.2,
      medianEndingWealth: 1_000_000,
      p10EndingWealth: 500_000,
      p90EndingWealth: 2_000_000,
      earliestFailureYear: 2045,
      percentFailBeforeSocialSecurity: 0.1,
      percentFailBeforeInheritance: 0.1,
      percentFailFirst10Years: 0.1,
    },
    delta: {
      deltaSuccessRate: 0.02,
      deltaMedianEndingWealth: 20_000,
      deltaP10EndingWealth: 15_000,
      deltaEarliestFailureYear: 1,
      deltaFailFirst10Years: -0.01,
    },
    recommendationScore: 10,
    recommendationSummary: 'Actionable scenario summary text.',
    tradeoffs: [],
    excludedByConstraints: false,
    exclusionReasons: [],
    ...overrides,
  };
}

describe('deriveExcludedHighImpactLevers', () => {
  it('returns top excluded positive-improvement scenarios sorted by impact', () => {
    const output = deriveExcludedHighImpactLevers(
      [
        buildScenario({
          scenarioId: 'allow_ignored',
          name: 'Allowed Scenario',
          excludedByConstraints: false,
          delta: { ...buildScenario().delta, deltaSuccessRate: 0.2 },
        }),
        buildScenario({
          scenarioId: 'excluded_high',
          name: 'Delay Retirement 12 Months',
          excludedByConstraints: true,
          exclusionReasons: ['Scenario contains forbidden tags: retirement_delay.'],
          category: 'timing',
          delta: { ...buildScenario().delta, deltaSuccessRate: 0.118 },
        }),
        buildScenario({
          scenarioId: 'excluded_mid',
          name: 'Increase Bonds 10%',
          excludedByConstraints: true,
          exclusionReasons: ['Scenario category "allocation" is disallowed.'],
          category: 'allocation',
          delta: { ...buildScenario().delta, deltaSuccessRate: 0.06 },
        }),
        buildScenario({
          scenarioId: 'excluded_negative',
          name: 'Excluded but Worsens',
          excludedByConstraints: true,
          exclusionReasons: ['Scenario is disallowed by id.'],
          delta: { ...buildScenario().delta, deltaSuccessRate: -0.02 },
        }),
      ],
      3,
    );

    expect(output).toHaveLength(2);
    expect(output[0]).toEqual({
      scenario: 'Delay Retirement 12 Months',
      deltaSuccessRate: 0.118,
      reasonExcluded: 'Scenario contains forbidden tags: retirement_delay.',
    });
    expect(output[1]).toEqual({
      scenario: 'Increase Bonds 10%',
      deltaSuccessRate: 0.06,
      reasonExcluded: 'Scenario category "allocation" is disallowed.',
    });
  });

  it('uses a default exclusion reason when none is provided', () => {
    const output = deriveExcludedHighImpactLevers([
      buildScenario({
        scenarioId: 'excluded_no_reason',
        name: 'Excluded Scenario',
        excludedByConstraints: true,
        exclusionReasons: [],
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.03 },
      }),
    ]);

    expect(output[0]?.reasonExcluded).toBe('Excluded by active recommendation constraints.');
  });
});
