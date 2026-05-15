import { describe, expect, it } from 'vitest';
import { defaultAssumptions } from './default-assumptions';
import { initialSeedData } from './data';
import { runSpendingModels } from './spending-model-runner';
import type { MarketAssumptions, PathResult, SeedData } from './types';

function buildRunnerSeed(): SeedData {
  const seed: SeedData = structuredClone(initialSeedData);
  seed.household.robBirthDate = '1961-01-01';
  seed.household.debbieBirthDate = '1961-01-01';
  seed.income.salaryAnnual = 0;
  seed.income.salaryEndDate = '2026-07-01';
  seed.income.socialSecurity = [];
  seed.income.windfalls = [];
  seed.spending.essentialMonthly = 5_000;
  seed.spending.optionalMonthly = 2_000;
  seed.spending.annualTaxesInsurance = 12_000;
  seed.spending.travelEarlyRetirementAnnual = 30_000;
  return seed;
}

function buildRunnerAssumptions(): MarketAssumptions {
  return {
    ...defaultAssumptions,
    simulationRuns: 12,
    simulationSeed: 20260512,
    assumptionsVersion: 'spending-model-runner-test',
  };
}

function fakePath(overrides: Partial<PathResult> = {}): PathResult {
  return {
    id: 'selected',
    label: 'Selected Path',
    simulationMode: 'planner_enhanced',
    plannerLogicActive: true,
    successRate: 0.9,
    medianEndingWealth: 1_000_000,
    tenthPercentileEndingWealth: 100_000,
    yearsFunded: 30,
    medianFailureYear: null,
    spendingCutRate: 0,
    irmaaExposureRate: 0,
    homeSaleDependenceRate: 0,
    inheritanceDependenceRate: 0,
    flexibilityScore: 80,
    cornerRiskScore: 20,
    rothDepletionRate: 0,
    annualFederalTaxEstimate: 10_000,
    irmaaExposure: 'Low',
    cornerRisk: 'Low',
    failureMode: 'none',
    notes: '',
    stressors: [],
    responses: [],
    endingWealthPercentiles: {
      p10: 100_000,
      p25: 500_000,
      p50: 1_000_000,
      p75: 1_500_000,
      p90: 2_000_000,
    },
    failureYearDistribution: [],
    worstOutcome: {
      endingWealth: 0,
      success: false,
      failureYear: 2030,
    },
    bestOutcome: {
      endingWealth: 2_000_000,
      success: true,
      failureYear: null,
    },
    monteCarloMetadata: {
      seed: 20260512,
      trialCount: 12,
      assumptionsVersion: 'spending-model-runner-test',
      planningHorizonYears: 30,
    },
    simulationConfiguration: {} as PathResult['simulationConfiguration'],
    simulationDiagnostics: {} as PathResult['simulationDiagnostics'],
    riskMetrics: {
      earlyFailureProbability: 0.12,
      medianFailureShortfallDollars: 0,
      medianDownsideSpendingCutRequired: 0,
      worstDecileEndingWealth: 100_000,
      equitySalesInAdverseEarlyYearsRate: 0,
    },
    yearlySeries: [],
    ...overrides,
  };
}

describe('spending model runner', () => {
  it('returns an empty successful result when no presets are selected', () => {
    const result = runSpendingModels({
      data: buildRunnerSeed(),
      assumptions: buildRunnerAssumptions(),
      presetIds: [],
      runPathResults: (() => {
        throw new Error('should not run');
      }) as typeof import('./utils').buildPathResults,
    });

    expect(result).toEqual([]);
  });

  it('runs forward and historical modes with the same schedule and seed', () => {
    const calls: Array<{
      assumptions: MarketAssumptions;
      schedule: Record<number, number> | undefined;
    }> = [];
    const result = runSpendingModels({
      data: buildRunnerSeed(),
      assumptions: buildRunnerAssumptions(),
      presetIds: ['jpmorgan_curve_travel_included'],
      generatedAtIso: '2026-05-12T00:00:00.000Z',
      runPathResults: ((_, assumptions, __, ___, options) => {
        calls.push({
          assumptions,
          schedule: options?.annualSpendScheduleByYear,
        });
        return [fakePath()];
      }) as typeof import('./utils').buildPathResults,
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('complete');
    expect(calls).toHaveLength(2);
    expect(calls[0].assumptions.simulationSeed).toBe(20260512);
    expect(calls[1].assumptions.simulationSeed).toBe(20260512);
    expect(calls[0].assumptions.useHistoricalBootstrap).toBe(false);
    expect(calls[1].assumptions.useHistoricalBootstrap).toBe(true);
    expect(calls[0].schedule).toEqual(calls[1].schedule);
    expect(calls[0].schedule).toEqual(result[0].annualSpendScheduleByYear);
    expect(result[0].simulation.byMode.forward_parametric.first10YearFailureRisk).toBe(
      0.12,
    );
    expect(result[0].simulation.byMode.historical_precedent.p90EndingWealth).toBe(
      2_000_000,
    );
    expect(result[0].provenance.generatedAtIso).toBe('2026-05-12T00:00:00.000Z');
  });

  it('skips invalid preset rows without running simulations', () => {
    let calls = 0;
    const result = runSpendingModels({
      data: buildRunnerSeed(),
      assumptions: buildRunnerAssumptions(),
      presetIds: ['jpmorgan_curve_extra_travel_overlay'],
      runPathResults: (() => {
        calls += 1;
        return [fakePath()];
      }) as typeof import('./utils').buildPathResults,
    });

    expect(calls).toBe(0);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('skipped');
    expect(result[0].warnings).toContainEqual(
      expect.objectContaining({
        code: 'extra_travel_missing',
        severity: 'blocking',
      }),
    );
  });

  it('isolates one mode failure and continues later preset rows', () => {
    let calls = 0;
    const result = runSpendingModels({
      data: buildRunnerSeed(),
      assumptions: buildRunnerAssumptions(),
      presetIds: ['jpmorgan_curve_travel_included', 'jpmorgan_curve_early_volatility'],
      runPathResults: ((_, __, ___, ____, options) => {
        calls += 1;
        if (calls === 2) {
          throw new Error('historical mode exploded');
        }
        return [
          fakePath({
            medianEndingWealth: options?.annualSpendScheduleByYear?.[2026] ?? 0,
          }),
        ];
      }) as typeof import('./utils').buildPathResults,
    });

    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('partial');
    expect(result[0].simulation.byMode.forward_parametric.status).toBe('complete');
    expect(result[0].simulation.byMode.historical_precedent.status).toBe('failed');
    expect(result[0].warnings).toContainEqual(
      expect.objectContaining({
        code: 'mode_failed',
        severity: 'warning',
      }),
    );
    expect(result[1].status).toBe('complete');
    expect(calls).toBe(4);
  });
});
