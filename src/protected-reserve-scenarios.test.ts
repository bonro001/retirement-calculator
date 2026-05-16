import { describe, expect, it, vi } from 'vitest';
import { initialSeedData } from './data';
import { resolveProtectedReserveGoal } from './protected-reserve';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

vi.setConfig({ testTimeout: 30_000 });

const ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.07,
  internationalEquityVolatility: 0.17,
  bondMean: 0.04,
  bondVolatility: 0.06,
  cashMean: 0.025,
  cashVolatility: 0.005,
  inflation: 0.025,
  inflationVolatility: 0.01,
  simulationRuns: 80,
  irmaaThreshold: 212_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 25,
  guardrailCutPercent: 0.1,
  robPlanningEndAge: 88,
  debbiePlanningEndAge: 91,
  travelPhaseYears: 10,
  simulationSeed: 20260516,
  assumptionsVersion: 'protected-reserve-scenarios-v1',
};

function cloneSeed(): SeedData {
  return JSON.parse(JSON.stringify(initialSeedData)) as SeedData;
}

function setLtc(
  data: SeedData,
  input: {
    enabled: boolean;
    startAge: number;
    annualCostToday: number;
    durationYears: number;
    eventProbability: number;
  },
) {
  data.rules.ltcAssumptions = {
    enabled: input.enabled,
    startAge: input.startAge,
    annualCostToday: input.annualCostToday,
    durationYears: input.durationYears,
    inflationAnnual: 0.03,
    eventProbability: input.eventProbability,
  };
}

function runReserveScenario(
  mutateData: (data: SeedData) => void,
  selectedStressors: string[] = [],
  assumptions: MarketAssumptions = ASSUMPTIONS,
) {
  const data = cloneSeed();
  mutateData(data);
  const path = buildPathResults(data, assumptions, selectedStressors, [], {
    pathMode: 'selected_only',
    strategyMode: 'planner_enhanced',
  })[0];
  const totalMedianLtcCost = path.yearlySeries.reduce(
    (sum, row) => sum + Math.max(0, row.medianLtcCost ?? 0),
    0,
  );
  const totalMedianHsaLtcOffset = path.yearlySeries.reduce(
    (sum, row) => sum + Math.max(0, row.medianHsaLtcOffsetUsed ?? 0),
    0,
  );
  const totalMedianLtcAfterHsa = path.yearlySeries.reduce(
    (sum, row) => sum + Math.max(0, row.medianLtcCostRemainingAfterHsa ?? 0),
    0,
  );
  return {
    data,
    path,
    protectedReserve: resolveProtectedReserveGoal(data.goals),
    totalMedianLtcCost,
    totalMedianHsaLtcOffset,
    totalMedianLtcAfterHsa,
    finalYear: path.yearlySeries[path.yearlySeries.length - 1]?.year ?? null,
  };
}

describe('protected reserve scenario behavior', () => {
  it('keeps the reserve available for legacy in the no-care case', () => {
    const noCare = runReserveScenario((data) => {
      setLtc(data, {
        enabled: false,
        startAge: 82,
        annualCostToday: 0,
        durationYears: 0,
        eventProbability: 0,
      });
    });

    expect(noCare.protectedReserve).toMatchObject({
      targetTodayDollars: 1_000_000,
      purpose: 'care_first_legacy_if_unused',
      availableFor: 'late_life_care_or_health_shocks',
      normalLifestyleSpendable: false,
      modelCompleteness: 'faithful',
    });
    expect(noCare.totalMedianLtcCost).toBe(0);
    expect(noCare.path.medianEndingWealth).toBeGreaterThan(
      noCare.protectedReserve.targetTodayDollars,
    );
    expect(noCare.finalYear).toBe(2055);
  });

  it('uses part of the reserve for care while preserving the median target', () => {
    const noCare = runReserveScenario((data) => {
      setLtc(data, {
        enabled: false,
        startAge: 82,
        annualCostToday: 0,
        durationYears: 0,
        eventProbability: 0,
      });
    });
    const partialCare = runReserveScenario((data) => {
      setLtc(data, {
        enabled: true,
        startAge: 82,
        annualCostToday: 100_000,
        durationYears: 2,
        eventProbability: 1,
      });
    });

    expect(partialCare.totalMedianLtcCost).toBeGreaterThan(0);
    expect(partialCare.totalMedianLtcCost).toBeLessThan(
      partialCare.protectedReserve.targetTodayDollars,
    );
    expect(partialCare.totalMedianHsaLtcOffset).toBeGreaterThan(0);
    expect(partialCare.path.medianEndingWealth).toBeLessThan(
      noCare.path.medianEndingWealth,
    );
    expect(partialCare.path.medianEndingWealth).toBeGreaterThan(
      partialCare.protectedReserve.targetTodayDollars,
    );
  });

  it('keeps full-care depletion interpretable instead of treating it as routine spend', () => {
    const partialCare = runReserveScenario((data) => {
      setLtc(data, {
        enabled: true,
        startAge: 82,
        annualCostToday: 100_000,
        durationYears: 2,
        eventProbability: 1,
      });
    });
    const fullCare = runReserveScenario((data) => {
      setLtc(data, {
        enabled: true,
        startAge: 82,
        annualCostToday: 250_000,
        durationYears: 4,
        eventProbability: 1,
      });
    });

    expect(fullCare.totalMedianLtcCost).toBeGreaterThan(
      fullCare.protectedReserve.targetTodayDollars,
    );
    expect(fullCare.totalMedianLtcAfterHsa).toBeGreaterThan(0);
    expect(fullCare.path.successRate).toBeLessThan(partialCare.path.successRate);
    expect(fullCare.path.medianEndingWealth).toBeLessThan(
      partialCare.path.medianEndingWealth,
    );
    expect(fullCare.path.yearlySeries.some((row) => row.medianLtcCost > 0)).toBe(true);
    expect(fullCare.finalYear).toBe(2055);
  });

  it('shows market stress plus care shock as a distinct reserve-risk case', () => {
    const careOnly = runReserveScenario((data) => {
      setLtc(data, {
        enabled: true,
        startAge: 82,
        annualCostToday: 100_000,
        durationYears: 2,
        eventProbability: 1,
      });
    });
    const careAndMarketStress = runReserveScenario((data) => {
      setLtc(data, {
        enabled: true,
        startAge: 82,
        annualCostToday: 100_000,
        durationYears: 2,
        eventProbability: 1,
      });
    }, ['market_down']);

    expect(careAndMarketStress.totalMedianLtcCost).toBeGreaterThan(0);
    expect(careAndMarketStress.path.successRate).toBeLessThan(
      careOnly.path.successRate,
    );
    expect(careAndMarketStress.path.medianEndingWealth).toBeLessThan(
      careOnly.path.medianEndingWealth,
    );
    expect(careAndMarketStress.finalYear).toBe(2055);
  });

  it('keeps life-horizon sensitivity separate from the active 88/91 baseline', () => {
    const baseline = runReserveScenario((data) => {
      setLtc(data, {
        enabled: false,
        startAge: 82,
        annualCostToday: 0,
        durationYears: 0,
        eventProbability: 0,
      });
    });
    const longerLife = runReserveScenario(
      (data) => {
        setLtc(data, {
          enabled: false,
          startAge: 82,
          annualCostToday: 0,
          durationYears: 0,
          eventProbability: 0,
        });
      },
      [],
      {
        ...ASSUMPTIONS,
        debbiePlanningEndAge: 95,
        assumptionsVersion: 'protected-reserve-longer-life-sensitivity-v1',
      },
    );

    expect(baseline.finalYear).toBe(2055);
    expect(longerLife.finalYear).toBeGreaterThan(baseline.finalYear ?? 0);
    expect(baseline.protectedReserve.targetTodayDollars).toBe(1_000_000);
    expect(longerLife.protectedReserve.targetTodayDollars).toBe(1_000_000);
  });
});
