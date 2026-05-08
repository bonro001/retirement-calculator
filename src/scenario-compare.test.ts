import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { PlannerInput } from './decision-engine';
import { buildScenarioCompareDisplayRows, getScenarioCompareRegistry, runScenarioCompare } from './scenario-compare';
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
  simulationRuns: 80,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260418,
  assumptionsVersion: 'scenario-compare-test',
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

describe('scenario compare registry', () => {
  it('contains required named scenarios', () => {
    const names = new Set(getScenarioCompareRegistry().map((scenario) => scenario.name));
    expect(names.has('Base')).toBe(true);
    expect(names.has('Bad First 3 Years')).toBe(true);
    expect(names.has('No Inheritance')).toBe(true);
    expect(names.has('No Home Sale')).toBe(true);
    expect(names.has('Delay Retirement 12 Months')).toBe(true);
    expect(names.has('Keep House')).toBe(true);
    expect(names.has('More Travel')).toBe(true);
  });

  it('scenario transforms are pure and do not mutate baseline', () => {
    const baseline = buildInput();
    const original = JSON.parse(JSON.stringify(baseline)) as PlannerInput;
    const registry = getScenarioCompareRegistry();

    registry.forEach((scenario) => {
      const transformed = scenario.apply(baseline);
      expect(transformed).not.toBe(baseline);
    });

    expect(baseline).toEqual(original);
  });

  it('applies key transforms correctly', () => {
    const input = buildInput({
      selectedStressors: ['market_up'],
    });
    const registry = getScenarioCompareRegistry();
    const byId = (id: string) => {
      const scenario = registry.find((item) => item.id === id);
      if (!scenario) {
        throw new Error(`Missing scenario: ${id}`);
      }
      return scenario;
    };

    const badFirst = byId('bad_first_3_years').apply(input);
    expect(badFirst.selectedStressors.includes('market_down')).toBe(true);
    expect(badFirst.selectedStressors.includes('market_up')).toBe(false);

    const noInheritance = byId('no_inheritance').apply(input);
    const inheritanceWindfall = noInheritance.data.income.windfalls.find((item) => item.name === 'inheritance');
    expect(inheritanceWindfall?.amount).toBe(0);

    const delay = byId('delay_retirement_12_months').apply(input);
    expect(new Date(delay.data.income.salaryEndDate).getUTCFullYear()).toBe(
      new Date(input.data.income.salaryEndDate).getUTCFullYear() + 1,
    );

    const moreTravel = byId('more_travel').apply(input);
    expect(moreTravel.data.spending.travelEarlyRetirementAnnual).toBe(
      input.data.spending.travelEarlyRetirementAnnual + 5000,
    );
  });
});

describe('scenario compare runner + formatting', () => {
  it('builds reproducible compare output with deterministic seeds', async () => {
    // simulationRunsOverride bumped 40 → 500. At 40 trials the standard
    // error on deltaSuccessRate (~16%) was large enough that whether ANY
    // recommendation cleared the inclusion threshold became dependent on
    // engine-update-induced drift rather than the property under test
    // (deterministic + reproducible compare output). 500 trials puts SE
    // around 4.5% so the rankedRecommendations array reliably contains
    // at least one entry.
    const constrainedInput = buildInput();
    constrainedInput.data.spending.essentialMonthly *= 1.2;
    constrainedInput.data.spending.optionalMonthly *= 1.2;
    const first = await runScenarioCompare(constrainedInput, {
      scenarioIds: ['base'],
      simulationRunsOverride: 500,
      seedBase: 7331,
      seedStrategy: 'shared',
    });
    const second = await runScenarioCompare(constrainedInput, {
      scenarioIds: ['base'],
      simulationRunsOverride: 500,
      seedBase: 7331,
      seedStrategy: 'shared',
    });

    expect(second).toEqual(first);
    expect(first.results[0].scenarioName).toBe('Base');
    expect(first.results[0].topRecommendation).not.toBeNull();
  }, 30_000);

  it('formats compare output rows for display', () => {
    const rows = buildScenarioCompareDisplayRows({
      seed: 1,
      runCount: 100,
      strategyMode: 'planner_enhanced',
      optimizationObjective: 'maximize_flat_spending',
      scenarioOrder: ['base'],
      results: [
        {
          scenarioId: 'base',
          scenarioName: 'Base',
          metrics: {
            successRate: 0.88,
            medianEndingWealth: 1_250_000,
            p10EndingWealth: 410_000,
            earliestFailureYear: null,
          },
          topRecommendation: {
            id: 'spend_optional_down_10',
            name: 'Cut Optional Spending 10%',
            summary: 'Improves success and downside outcomes.',
            successDelta: 0.05,
          },
        },
      ],
    });

    expect(rows[0]).toEqual({
      scenarioId: 'base',
      scenarioName: 'Base',
      successRate: '88%',
      medianEndingWealth: '$1,250,000',
      p10EndingWealth: '$410,000',
      earliestFailureYear: 'None',
      topRecommendation: 'Cut Optional Spending 10%',
    });
  });
});
