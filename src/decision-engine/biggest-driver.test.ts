import { describe, expect, it } from 'vitest';
import { deriveBiggestDriverInsight } from './biggest-driver';
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
      deltaMedianEndingWealth: 10_000,
      deltaP10EndingWealth: 5_000,
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

describe('deriveBiggestDriverInsight', () => {
  it('selects the highest-impact category winner', () => {
    const insight = deriveBiggestDriverInsight([
      buildScenario({
        scenarioId: 'spend_optional',
        name: 'Cut Optional Spending 10%',
        category: 'spending',
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.04 },
      }),
      buildScenario({
        scenarioId: 'retire_delay',
        name: 'Delay Retirement 12 Months',
        category: 'timing',
        tags: ['retirement_delay'],
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.08 },
      }),
      buildScenario({
        scenarioId: 'alloc_shift',
        name: 'Increase Bonds +5%',
        category: 'allocation',
        tags: ['allocation_change'],
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.03 },
      }),
    ]);

    expect(insight).not.toBeNull();
    expect(insight?.category).toBe('timing');
    expect(insight?.scenarioName).toContain('Delay Retirement');
    expect(insight?.deltaSuccessRate).toBe(0.08);
  });

  it('ignores excluded and combo scenarios so they do not dominate', () => {
    const insight = deriveBiggestDriverInsight([
      buildScenario({
        scenarioId: 'combo',
        name: 'Combo Super Lever',
        category: 'combo',
        tags: ['combo'],
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.2 },
      }),
      buildScenario({
        scenarioId: 'excluded',
        name: 'Excluded Timing Lever',
        category: 'timing',
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.12 },
        excludedByConstraints: true,
      }),
      buildScenario({
        scenarioId: 'spending',
        name: 'Cut Optional Spending 10%',
        category: 'spending',
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.05 },
      }),
    ]);

    expect(insight?.category).toBe('spending');
    expect(insight?.scenarioName).toContain('Optional');
  });

  it('returns null when no positive eligible improvements exist', () => {
    const insight = deriveBiggestDriverInsight([
      buildScenario({
        scenarioId: 'negative',
        delta: { ...buildScenario().delta, deltaSuccessRate: -0.02 },
      }),
      buildScenario({
        scenarioId: 'sensitivity',
        isSensitivity: true,
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.04 },
      }),
    ]);

    expect(insight).toBeNull();
  });

  it('prefers simple lever when impact is similar within a category', () => {
    const insight = deriveBiggestDriverInsight([
      buildScenario({
        scenarioId: 'timing_simple',
        name: 'Delay Retirement 3 Months',
        category: 'timing',
        complexity: 'simple',
        disruption: 'medium',
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.06 },
      }),
      buildScenario({
        scenarioId: 'timing_complex',
        name: 'Delay Retirement 12 Months',
        category: 'timing',
        complexity: 'complex',
        disruption: 'high',
        delta: { ...buildScenario().delta, deltaSuccessRate: 0.065 },
      }),
    ]);

    expect(insight?.scenarioName).toContain('3 Months');
  });
});
