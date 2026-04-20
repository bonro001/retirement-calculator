import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { evaluateDecisionLevers, runDecisionEngine } from './decision-engine';
import {
  calculateRecommendationScore,
  compareRecommendationCandidates,
  dedupeRecommendationCandidates,
  DEFAULT_RECOMMENDATION_WEIGHTS,
  HIGH_DISRUPTION_MIN_SUCCESS_IMPROVEMENT,
  MIN_RECOMMENDED_SUCCESS_IMPROVEMENT,
} from './decision-engine/scoring';
import type { PlannerInput } from './decision-engine';
import type { MarketAssumptions, SeedData } from './types';

const TEST_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.074,
  internationalEquityVolatility: 0.18,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 120,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260418,
  assumptionsVersion: 'decision-engine-layer-test',
};

const cloneSeedData = (value: SeedData): SeedData =>
  JSON.parse(JSON.stringify(value)) as SeedData;

function buildInput(overrides?: Partial<PlannerInput>): PlannerInput {
  return {
    data: cloneSeedData(initialSeedData),
    assumptions: { ...TEST_ASSUMPTIONS },
    selectedStressors: ['market_down'],
    selectedResponses: ['cut_spending'],
    strategyMode: 'planner_enhanced',
    ...overrides,
  };
}

function buildStubRecommendation(
  overrides?: Partial<Awaited<ReturnType<typeof evaluateDecisionLevers>>['rankedRecommendations'][number]>,
) {
  return {
    scenarioId: 'stub',
    name: 'Stub Lever',
    category: 'spending' as const,
    disruption: 'low' as const,
    complexity: 'simple' as const,
    tags: ['optional_cut'],
    isSensitivity: false,
    metrics: {
      successRate: 0.8,
      failureRate: 0.2,
      medianEndingWealth: 1_000_000,
      p10EndingWealth: 400_000,
      p90EndingWealth: 2_000_000,
      earliestFailureYear: 2045,
      percentFailBeforeSocialSecurity: 0.1,
      percentFailBeforeInheritance: 0.1,
      percentFailFirst10Years: 0.1,
    },
    delta: {
      deltaSuccessRate: 0.05,
      deltaMedianEndingWealth: 20_000,
      deltaP10EndingWealth: 15_000,
      deltaEarliestFailureYear: 1,
      deltaFailFirst10Years: -0.01,
    },
    recommendationScore: 12,
    recommendationSummary: 'Cut optional spending to improve success and downside resilience.',
    tradeoffs: [],
    excludedByConstraints: false,
    exclusionReasons: [],
    ...overrides,
  };
}

function withoutRuntimeDiagnostics<T extends { runtimeDiagnostics?: unknown }>(value: T) {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  if ('runtimeDiagnostics' in clone) {
    delete (clone as { runtimeDiagnostics?: unknown }).runtimeDiagnostics;
  }
  return clone;
}

describe('decision-engine layer', () => {
  it('produces baseline + scenario metrics and ranked recommendation slices', async () => {
    const report = await evaluateDecisionLevers(buildInput());

    expect(report.baseline.successRate).toBeGreaterThanOrEqual(0);
    expect(report.baseline.successRate).toBeLessThanOrEqual(1);
    expect(report.allScenarioResults.length).toBeGreaterThanOrEqual(20);
    expect(report.rankedRecommendations.every((item, index, list) => {
      if (index === 0) {
        return true;
      }
      return compareRecommendationCandidates(list[index - 1], item) <= 0;
    })).toBe(true);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('scenario evaluation does not mutate baseline input', async () => {
    const input = buildInput();
    const before = cloneSeedData(input.data);
    await evaluateDecisionLevers(input);
    expect(input.data).toEqual(before);
  });

  it('computes deltas consistently from baseline metrics', async () => {
    const report = await evaluateDecisionLevers(buildInput());
    report.allScenarioResults.forEach((scenario) => {
      expect(scenario.delta.deltaSuccessRate).toBeCloseTo(
        scenario.metrics.successRate - report.baseline.successRate,
      );
      expect(scenario.delta.deltaMedianEndingWealth).toBeCloseTo(
        scenario.metrics.medianEndingWealth - report.baseline.medianEndingWealth,
      );
      expect(scenario.delta.deltaP10EndingWealth).toBeCloseTo(
        scenario.metrics.p10EndingWealth - report.baseline.p10EndingWealth,
      );
      expect(scenario.delta.deltaFailFirst10Years).toBeCloseTo(
        scenario.metrics.percentFailFirst10Years - report.baseline.percentFailFirst10Years,
      );
    });
  });

  it('keeps deterministic outputs for same seed and options', async () => {
    const input = buildInput();
    const first = await runDecisionEngine(input, {
      seedBase: 7331,
      seedStrategy: 'scenario_derived',
      simulationRunsOverride: 80,
    });
    const second = await runDecisionEngine(buildInput(), {
      seedBase: 7331,
      seedStrategy: 'scenario_derived',
      simulationRunsOverride: 80,
    });

    expect(withoutRuntimeDiagnostics(second)).toEqual(withoutRuntimeDiagnostics(first));
  });

  it('defaults to shared seed strategy for apples-to-apples scenario deltas', async () => {
    const baseline = buildInput();
    const defaultSeedReport = await evaluateDecisionLevers(baseline, {
      seedBase: 411,
      simulationRunsOverride: 90,
    });
    const explicitSharedSeedReport = await evaluateDecisionLevers(buildInput(), {
      seedBase: 411,
      seedStrategy: 'shared',
      simulationRunsOverride: 90,
    });
    expect(withoutRuntimeDiagnostics(defaultSeedReport)).toEqual(
      withoutRuntimeDiagnostics(explicitSharedSeedReport),
    );
  });

  it('ranking penalizes high disruption and complexity', async () => {
    const baseline = {
      successRate: 0.78,
      failureRate: 0.22,
      medianEndingWealth: 1_600_000,
      p10EndingWealth: 700_000,
      p90EndingWealth: 2_900_000,
      earliestFailureYear: 2043,
      percentFailBeforeSocialSecurity: 0.04,
      percentFailBeforeInheritance: 0.11,
      percentFailFirst10Years: 0.08,
    };
    const delta = {
      deltaSuccessRate: 0.03,
      deltaMedianEndingWealth: 45_000,
      deltaP10EndingWealth: 30_000,
      deltaEarliestFailureYear: 2,
      deltaFailFirst10Years: -0.02,
    };
    const lowPenalty = calculateRecommendationScore({
      baselineMetrics: baseline,
      delta,
      disruption: 'low',
      complexity: 'simple',
      weights: DEFAULT_RECOMMENDATION_WEIGHTS,
    });
    const highPenalty = calculateRecommendationScore({
      baselineMetrics: baseline,
      delta,
      disruption: 'high',
      complexity: 'complex',
      weights: DEFAULT_RECOMMENDATION_WEIGHTS,
    });
    expect(highPenalty.score).toBeLessThan(lowPenalty.score);
  });

  it('separates sensitivity scenarios from recommendations', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
    });
    const sensitivityIds = new Set([
      'assumption_remove_inheritance',
      'assumption_remove_home_sale',
      'assumption_inheritance_later_2y',
      'assumption_home_sale_later_2y',
      'housing_keep_house',
      'housing_sell_later_2y',
      'combo_no_home_sale_optional_15',
      'combo_no_inheritance_delay_12m',
    ]);

    report.rankedRecommendations.forEach((recommendation) => {
      expect(sensitivityIds.has(recommendation.scenarioId)).toBe(false);
    });
    expect(report.worstSensitivityScenarios.length).toBeGreaterThan(0);
  });

  it('explanation strings align with metric directions', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
    });
    report.allScenarioResults.forEach((scenario) => {
      if (scenario.delta.deltaSuccessRate > 0) {
        expect(scenario.recommendationSummary.includes('improves')).toBe(true);
      } else if (scenario.delta.deltaSuccessRate < 0) {
        expect(scenario.recommendationSummary.includes('reduces')).toBe(true);
      } else {
        expect(scenario.recommendationSummary.includes('keeps')).toBe(true);
      }
      expect(scenario.recommendationSummary.includes('failure risk by -')).toBe(false);
      expect(scenario.tradeoffs.length).toBeGreaterThan(0);
    });
  });

  it('excludes retirement delay scenarios when disabled', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      constraints: {
        rules: {
          allowRetirementDelay: false,
        },
      },
    });

    const hasRetirementDelayRecommendation = report.rankedRecommendations.some((scenario) =>
      (scenario.exclusionReasons ?? []).length === 0 &&
      (scenario.scenarioId.startsWith('retire_delay_') ||
        scenario.scenarioId === 'combo_delay_6m_optional_10' ||
        scenario.scenarioId === 'combo_delay_12m_travel_5k' ||
        scenario.scenarioId === 'combo_no_inheritance_delay_12m'),
    );
    expect(hasRetirementDelayRecommendation).toBe(false);
    expect(report.excludedScenarioNames.some((name) => name.includes('Delay Retirement'))).toBe(true);
  });

  it('excludes combo scenarios containing forbidden levers', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      constraints: {
        rules: {
          allowAllocationChanges: false,
        },
      },
    });

    expect(
      report.rankedRecommendations.some(
        (scenario) =>
          scenario.scenarioId === 'combo_optional_10_conservative' ||
          scenario.scenarioId.startsWith('alloc_bonds_up_'),
      ),
    ).toBe(false);
    expect(
      report.excludedScenarioNames.some((name) =>
        name.includes('Conservative Allocation') || name.includes('Increase Bonds'),
      ),
    ).toBe(true);
  });

  it('respects minimum travel budget constraints', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      constraints: {
        minimumTravelBudgetAnnual: 10_000,
      },
      evaluateExcludedScenarios: true,
    });

    const travel5000 = report.allScenarioResults.find((scenario) => scenario.scenarioId === 'travel_down_5000');
    const travel10000 = report.allScenarioResults.find((scenario) => scenario.scenarioId === 'travel_down_10000');
    const travel2500 = report.allScenarioResults.find((scenario) => scenario.scenarioId === 'travel_down_2500');

    expect(travel5000?.excludedByConstraints).toBe(true);
    expect(travel10000?.excludedByConstraints).toBe(true);
    expect(travel2500?.excludedByConstraints).toBe(false);
    expect(report.recommendationUniverseNotes.some((note) => note.includes('Travel cuts below'))).toBe(true);
  });

  it('blocked scenarios do not appear in ranked recommendations', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      constraints: {
        disallowedScenarioIds: ['spend_optional_down_10'],
      },
      evaluateExcludedScenarios: true,
    });
    expect(
      report.rankedRecommendations.some((scenario) => scenario.scenarioId === 'spend_optional_down_10'),
    ).toBe(false);
    expect(
      report.allScenarioResults.some(
        (scenario) =>
          scenario.scenarioId === 'spend_optional_down_10' && scenario.excludedByConstraints,
      ),
    ).toBe(true);
  });

  it('reports exclusion notes for active constraints', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      constraints: {
        rules: {
          allowRetirementDelay: false,
          allowHomeSaleChanges: false,
          allowEssentialSpendingCuts: false,
        },
      },
    });

    expect(report.activeConstraints).not.toBeNull();
    expect(report.excludedScenarioCount).toBeGreaterThan(0);
    expect(report.recommendationUniverseNotes.some((note) => note.includes('Retirement delay'))).toBe(true);
    expect(report.recommendationUniverseNotes.some((note) => note.includes('Home-sale-based'))).toBe(true);
    expect(report.recommendationUniverseNotes.some((note) => note.includes('Essential spending cuts'))).toBe(true);
  });

  it('applies minimum success improvement sanity guard to recommendations', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      evaluateExcludedScenarios: true,
    });
    expect(
      report.rankedRecommendations.every(
        (scenario) => scenario.delta.deltaSuccessRate >= MIN_RECOMMENDED_SUCCESS_IMPROVEMENT,
      ),
    ).toBe(true);
  });

  it('requires >5% success lift for high-disruption recommendations', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      evaluateExcludedScenarios: true,
    });
    expect(
      report.rankedRecommendations
        .filter((scenario) => scenario.disruption === 'high')
        .every(
          (scenario) =>
            scenario.delta.deltaSuccessRate > HIGH_DISRUPTION_MIN_SUCCESS_IMPROVEMENT,
        ),
    ).toBe(true);
  });

  it('prefers simple non-combo lever when impact is similar', () => {
    const simple = buildStubRecommendation({
      scenarioId: 'simple_optional_cut',
      name: 'Cut Optional Spending 10%',
      category: 'spending',
      complexity: 'simple',
      disruption: 'low',
      tags: ['optional_cut'],
      delta: {
        ...buildStubRecommendation().delta,
        deltaSuccessRate: 0.06,
      },
    });
    const combo = buildStubRecommendation({
      scenarioId: 'combo_optional_allocation',
      name: 'Optional Cut + Allocation Shift',
      category: 'combo',
      complexity: 'complex',
      disruption: 'medium',
      tags: ['combo', 'optional_cut', 'allocation_change'],
      delta: {
        ...buildStubRecommendation().delta,
        deltaSuccessRate: 0.058,
      },
    });
    expect(compareRecommendationCandidates(simple, combo)).toBeLessThan(0);
  });

  it('deduplicates effectively equivalent recommendations', () => {
    const first = buildStubRecommendation({
      scenarioId: 'spend_optional_down_10',
      name: 'Cut Optional Spending 10%',
      tags: ['optional_cut'],
      delta: {
        ...buildStubRecommendation().delta,
        deltaSuccessRate: 0.045,
        deltaFailFirst10Years: -0.02,
      },
    });
    const second = buildStubRecommendation({
      scenarioId: 'spend_optional_down_15',
      name: 'Cut Optional Spending 15%',
      tags: ['optional_cut'],
      delta: {
        ...buildStubRecommendation().delta,
        deltaSuccessRate: 0.05,
        deltaFailFirst10Years: -0.022,
      },
    });
    const distinct = buildStubRecommendation({
      scenarioId: 'retire_delay_6m',
      name: 'Delay Retirement 6 Months',
      category: 'timing',
      tags: ['retirement_delay'],
      delta: {
        ...buildStubRecommendation().delta,
        deltaSuccessRate: 0.052,
      },
    });

    const deduped = dedupeRecommendationCandidates([first, second, distinct]);
    expect(deduped.length).toBe(2);
    expect(deduped.some((item) => item.scenarioId === 'spend_optional_down_10')).toBe(true);
    expect(deduped.some((item) => item.scenarioId === 'retire_delay_6m')).toBe(true);
  });

  it('ensures top recommendation is actionable and clear', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      evaluateExcludedScenarios: true,
    });
    const top = report.rankedRecommendations[0];
    if (!top) {
      expect(report.rankedRecommendations.length).toBe(0);
      return;
    }
    expect(top.recommendationSummary.trim().length).toBeGreaterThanOrEqual(20);
    expect(top.delta.deltaSuccessRate).toBeGreaterThanOrEqual(
      MIN_RECOMMENDED_SUCCESS_IMPROVEMENT,
    );
    expect(top.excludedByConstraints).not.toBe(true);
    expect(top.isSensitivity).toBe(false);
  });

  it('populates biggestDriver insight from eligible scenarios', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      evaluateExcludedScenarios: true,
    });
    if (report.biggestDriver) {
      expect(report.biggestDriver.deltaSuccessRate).toBeGreaterThan(0);
      expect(report.biggestDriver.summary.length).toBeGreaterThan(10);
      expect(report.biggestDriver.category).not.toBe('combo');
    } else {
      expect(report.rankedRecommendations.length).toBe(0);
    }
  });

  it('does not consider excluded scenarios for biggestDriver insight', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      constraints: {
        rules: {
          allowRetirementDelay: false,
          allowAllocationChanges: false,
          allowHomeSaleChanges: false,
          allowEssentialSpendingCuts: false,
          allowOptionalSpendingCuts: false,
          allowTravelCuts: false,
          allowSocialSecurityChanges: false,
          allowComboScenarios: false,
        },
      },
      evaluateExcludedScenarios: true,
    });

    expect(report.biggestDriver).toBeNull();
  });

  it('includes excluded high-impact insights when constraints block strong levers', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
      constraints: {
        rules: {
          allowRetirementDelay: false,
        },
      },
    });

    expect(report.excludedHighImpactLevers.length).toBeGreaterThan(0);
    expect(report.excludedHighImpactLevers.length).toBeLessThanOrEqual(3);
    expect(
      report.excludedHighImpactLevers.every((item) =>
        report.excludedScenarioNames.includes(item.scenario),
      ),
    ).toBe(true);
    expect(
      report.excludedHighImpactLevers.every((item) => item.reasonExcluded.length > 0),
    ).toBe(true);
    expect(
      report.excludedHighImpactLevers.every((item) => item.deltaSuccessRate > 0),
    ).toBe(true);
  });

  it('returns no excluded high-impact insights when no constraints are active', async () => {
    const report = await evaluateDecisionLevers(buildInput(), {
      simulationRunsOverride: 80,
    });
    expect(report.excludedHighImpactLevers).toEqual([]);
  });
});
