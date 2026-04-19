import { describe, expect, it } from 'vitest';
import { deriveBaselineRiskWarning } from './explanations';
import type { LeverScenarioResult, ScenarioMetrics } from './types';

function buildBaseline(overrides?: Partial<ScenarioMetrics>): ScenarioMetrics {
  return {
    successRate: 0.6,
    failureRate: 0.4,
    medianEndingWealth: 800_000,
    p10EndingWealth: 200_000,
    p90EndingWealth: 1_700_000,
    earliestFailureYear: 2037,
    percentFailBeforeSocialSecurity: 0.35,
    percentFailBeforeInheritance: 0.35,
    percentFailFirst10Years: 0.35,
    ...overrides,
  };
}

function buildScenario(overrides?: Partial<LeverScenarioResult>): LeverScenarioResult {
  return {
    scenarioId: 'stub',
    name: 'Stub',
    category: 'spending',
    disruption: 'low',
    complexity: 'simple',
    tags: ['optional_cut'],
    isSensitivity: false,
    metrics: buildBaseline(),
    delta: {
      deltaSuccessRate: 0.03,
      deltaMedianEndingWealth: 10_000,
      deltaP10EndingWealth: 8_000,
      deltaEarliestFailureYear: 1,
      deltaFailFirst10Years: -0.01,
    },
    recommendationScore: 10,
    recommendationSummary: 'Stub scenario summary that is clear and actionable.',
    tradeoffs: [],
    excludedByConstraints: false,
    exclusionReasons: [],
    ...overrides,
  };
}

describe('deriveBaselineRiskWarning', () => {
  it('returns null when baseline success is >= 70%', () => {
    const warning = deriveBaselineRiskWarning(buildBaseline({ successRate: 0.72 }), []);
    expect(warning).toBeNull();
  });

  it('uses early sequence risk when first-decade pressure dominates', () => {
    const warning = deriveBaselineRiskWarning(
      buildBaseline({
        percentFailFirst10Years: 0.7,
        percentFailBeforeSocialSecurity: 0.5,
        percentFailBeforeInheritance: 0.2,
      }),
      [],
    );
    expect(warning).toContain('early sequence risk');
  });

  it('uses spending level when spending relief is strongest', () => {
    const warning = deriveBaselineRiskWarning(
      buildBaseline({
        percentFailFirst10Years: 0.2,
        percentFailBeforeSocialSecurity: 0.2,
        percentFailBeforeInheritance: 0.2,
      }),
      [
        buildScenario({
          scenarioId: 'spend_optional_down_20',
          category: 'spending',
          delta: {
            ...buildScenario().delta,
            deltaSuccessRate: 0.14,
          },
        }),
      ],
    );
    expect(warning).toContain('spending level');
  });

  it('uses reliance on inheritance when inheritance sensitivity is high', () => {
    const warning = deriveBaselineRiskWarning(
      buildBaseline({
        percentFailBeforeInheritance: 0.6,
        percentFailFirst10Years: 0.15,
        percentFailBeforeSocialSecurity: 0.15,
      }),
      [
        buildScenario({
          scenarioId: 'assumption_remove_inheritance',
          category: 'assumption',
          tags: ['inheritance_sensitive'],
          isSensitivity: true,
          delta: {
            ...buildScenario().delta,
            deltaSuccessRate: -0.2,
          },
        }),
      ],
    );
    expect(warning).toContain('reliance on inheritance');
  });

  it('uses timing gap before Social Security when timing pressure dominates', () => {
    const warning = deriveBaselineRiskWarning(
      buildBaseline({
        percentFailFirst10Years: 0.1,
        percentFailBeforeSocialSecurity: 0.75,
        percentFailBeforeInheritance: 0.1,
      }),
      [
        buildScenario({
          scenarioId: 'retire_delay_12m',
          category: 'timing',
          tags: ['retirement_delay'],
          delta: {
            ...buildScenario().delta,
            deltaSuccessRate: 0.12,
          },
        }),
      ],
    );
    expect(warning).toContain('timing gap before Social Security');
  });
});
