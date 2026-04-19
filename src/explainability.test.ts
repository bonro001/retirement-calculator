import { describe, expect, it } from 'vitest';
import type { LeverScenarioResult, ScenarioMetrics } from './decision-engine';
import { buildExplainabilityReport } from './explainability';

function buildBaselineMetrics(overrides?: Partial<ScenarioMetrics>): ScenarioMetrics {
  return {
    successRate: 0.82,
    failureRate: 0.18,
    medianEndingWealth: 1_800_000,
    p10EndingWealth: 650_000,
    p90EndingWealth: 3_000_000,
    earliestFailureYear: 2047,
    percentFailBeforeSocialSecurity: 0.25,
    percentFailBeforeInheritance: 0.2,
    percentFailFirst10Years: 0.2,
    ...overrides,
  };
}

function buildScenarioResult(overrides?: Partial<LeverScenarioResult>): LeverScenarioResult {
  return {
    scenarioId: 'default',
    name: 'Default',
    category: 'spending',
    disruption: 'low',
    complexity: 'simple',
    isSensitivity: false,
    metrics: buildBaselineMetrics(),
    delta: {
      deltaSuccessRate: 0,
      deltaMedianEndingWealth: 0,
      deltaP10EndingWealth: 0,
      deltaEarliestFailureYear: 0,
      deltaFailFirst10Years: 0,
    },
    recommendationScore: 0,
    recommendationSummary: '',
    tradeoffs: [],
    ...overrides,
  };
}

describe('buildExplainabilityReport', () => {
  it('classifies early sequence risk when first-decade failures dominate', () => {
    const report = buildExplainabilityReport({
      baseline: buildBaselineMetrics({
        percentFailFirst10Years: 0.58,
        percentFailBeforeSocialSecurity: 0.62,
      }),
      scenarios: [
        buildScenarioResult({
          scenarioId: 'spend_optional_down_10',
          category: 'spending',
          delta: { ...buildScenarioResult().delta, deltaSuccessRate: 0.03 },
        }),
      ],
      medianFailureYear: 2032,
      planningStartYear: 2026,
      inheritanceDependenceRate: 0.12,
      homeSaleDependenceRate: 0.1,
    });

    expect(report.primaryIssue).toBe('early_sequence_risk');
    expect(report.summaryLines.some((line) => line.includes('before Social Security begins'))).toBe(true);
  });

  it('classifies weak assumptions when inheritance/home-sale dependence is high', () => {
    const report = buildExplainabilityReport({
      baseline: buildBaselineMetrics(),
      scenarios: [
        buildScenarioResult({
          scenarioId: 'assumption_remove_inheritance',
          category: 'assumption',
          isSensitivity: true,
          delta: { ...buildScenarioResult().delta, deltaSuccessRate: -0.24 },
        }),
        buildScenarioResult({
          scenarioId: 'assumption_remove_home_sale',
          category: 'assumption',
          isSensitivity: true,
          delta: { ...buildScenarioResult().delta, deltaSuccessRate: -0.14 },
        }),
      ],
      medianFailureYear: 2045,
      planningStartYear: 2026,
      inheritanceDependenceRate: 0.5,
      homeSaleDependenceRate: 0.42,
    });

    expect(report.primaryIssue).toBe('weak_assumptions');
    expect(report.summaryLines.some((line) => line.includes('relies heavily on the inheritance assumption'))).toBe(true);
  });

  it('classifies spending level when spending levers are strongest', () => {
    const report = buildExplainabilityReport({
      baseline: buildBaselineMetrics({
        percentFailFirst10Years: 0.24,
        percentFailBeforeSocialSecurity: 0.21,
      }),
      scenarios: [
        buildScenarioResult({
          scenarioId: 'spend_optional_down_15',
          category: 'spending',
          delta: { ...buildScenarioResult().delta, deltaSuccessRate: 0.14 },
        }),
        buildScenarioResult({
          scenarioId: 'retire_delay_6m',
          category: 'timing',
          delta: { ...buildScenarioResult().delta, deltaSuccessRate: 0.02 },
        }),
      ],
      medianFailureYear: 2048,
      planningStartYear: 2026,
      inheritanceDependenceRate: 0.1,
      homeSaleDependenceRate: 0.08,
    });

    expect(report.primaryIssue).toBe('spending_level');
    expect(report.primaryIssueExplanation).toContain('spending level');
  });

  it('classifies timing when failures cluster before Social Security and timing levers help', () => {
    const report = buildExplainabilityReport({
      baseline: buildBaselineMetrics({
        percentFailFirst10Years: 0.24,
        percentFailBeforeSocialSecurity: 0.72,
      }),
      scenarios: [
        buildScenarioResult({
          scenarioId: 'retire_delay_12m',
          category: 'timing',
          delta: { ...buildScenarioResult().delta, deltaSuccessRate: 0.12 },
        }),
        buildScenarioResult({
          scenarioId: 'spend_optional_down_10',
          category: 'spending',
          delta: { ...buildScenarioResult().delta, deltaSuccessRate: 0.03 },
        }),
      ],
      medianFailureYear: 2038,
      planningStartYear: 2026,
      inheritanceDependenceRate: 0.1,
      homeSaleDependenceRate: 0.1,
    });

    expect(report.primaryIssue).toBe('timing');
    expect(report.summaryLines.some((line) => line.includes('before Social Security starts'))).toBe(true);
  });
});
