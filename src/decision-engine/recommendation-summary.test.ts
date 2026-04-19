import { describe, expect, it } from 'vitest';
import { deriveRecommendationSummary } from './recommendation-summary';
import type { LeverScenarioResult, RecommendationConstraints, ScenarioMetrics } from './types';

function buildBaseline(overrides?: Partial<ScenarioMetrics>): ScenarioMetrics {
  return {
    successRate: 0.66,
    failureRate: 0.34,
    medianEndingWealth: 900_000,
    p10EndingWealth: 250_000,
    p90EndingWealth: 1_800_000,
    earliestFailureYear: 2039,
    percentFailBeforeSocialSecurity: 0.3,
    percentFailBeforeInheritance: 0.2,
    percentFailFirst10Years: 0.25,
    ...overrides,
  };
}

function buildScenario(
  overrides?: Partial<LeverScenarioResult>,
): LeverScenarioResult {
  return {
    scenarioId: 'scenario',
    name: 'Cut Optional Spending 10%',
    category: 'spending',
    disruption: 'low',
    complexity: 'simple',
    tags: ['optional_cut'],
    isSensitivity: false,
    metrics: buildBaseline(),
    delta: {
      deltaSuccessRate: 0.08,
      deltaMedianEndingWealth: 20_000,
      deltaP10EndingWealth: 15_000,
      deltaEarliestFailureYear: 1,
      deltaFailFirst10Years: -0.02,
    },
    recommendationScore: 10,
    recommendationSummary: 'Cut optional spending 10% to improve success and reduce early risk.',
    tradeoffs: [],
    excludedByConstraints: false,
    exclusionReasons: [],
    ...overrides,
  };
}

describe('deriveRecommendationSummary', () => {
  it('returns best non-high-disruption recommendation with >2% improvement', () => {
    const summary = deriveRecommendationSummary(
      buildBaseline(),
      [
        buildScenario({
          scenarioId: 'high_disruption',
          name: 'Delay Retirement 12 Months',
          disruption: 'high',
          category: 'timing',
          tags: ['retirement_delay'],
          delta: {
            ...buildScenario().delta,
            deltaSuccessRate: 0.12,
          },
        }),
        buildScenario({
          scenarioId: 'low_disruption',
          name: 'Cut Optional Spending 10%',
          disruption: 'low',
          category: 'spending',
          tags: ['optional_cut'],
          delta: {
            ...buildScenario().delta,
            deltaSuccessRate: 0.08,
          },
        }),
      ],
      null,
    );

    expect(summary.isFallback).toBe(false);
    expect(summary.summary).toContain('Cut Optional Spending 10%');
    expect(summary.impact?.deltaSuccessRate).toBe(0.08);
    expect(summary.reasoning.length).toBeGreaterThan(0);
  });

  it('uses fallback when no lever improves success by more than 2%', () => {
    const summary = deriveRecommendationSummary(
      buildBaseline(),
      [
        buildScenario({
          scenarioId: 'small_gain',
          delta: {
            ...buildScenario().delta,
            deltaSuccessRate: 0.015,
          },
        }),
      ],
      null,
    );
    expect(summary.isFallback).toBe(true);
    expect(summary.summary).toContain('No single low-impact change materially improves the plan');
    expect(summary.impact).toBeNull();
  });

  it('allows high-disruption recommendation only when no alternatives exist', () => {
    const summary = deriveRecommendationSummary(
      buildBaseline(),
      [
        buildScenario({
          scenarioId: 'only_high',
          name: 'Delay Retirement 12 Months',
          disruption: 'high',
          category: 'timing',
          tags: ['retirement_delay'],
          delta: {
            ...buildScenario().delta,
            deltaSuccessRate: 0.07,
          },
        }),
      ],
      null,
    );
    expect(summary.isFallback).toBe(false);
    expect(summary.summary).toContain('Delay Retirement 12 Months');
  });

  it('respects constraint-based reasoning hints', () => {
    const constraints: RecommendationConstraints = {
      rules: {
        allowRetirementDelay: false,
      },
    };
    const summary = deriveRecommendationSummary(
      buildBaseline(),
      [buildScenario()],
      constraints,
    );
    expect(summary.reasoning.some((line) => line.includes('no-retirement-delay'))).toBe(true);
  });
});
