import { describe, expect, it } from 'vitest';
import { defaultAssumptions } from './default-assumptions';
import { initialSeedData } from './data';
import {
  BLANCHETT_SPENDING_SMILE_SOURCE_VERSION,
  JPMORGAN_DEFAULT_CURVE_START_AGE,
  JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP,
  JPMORGAN_SPENDING_CURVE_POINTS,
  JPMORGAN_SPENDING_SOURCE_VERSION,
  MAGIC_AVERAGE_BLEND_WEIGHT,
  SPENDING_MODEL_SIMULATION_MODES,
  blanchettAnnualRealSpendingChangeForAge,
  buildDefaultSpendingModelSchedules,
  buildSpendingModelSchedule,
  curveMultiplierForAge,
  resolveHouseholdSpendingModifiers,
} from './jpmorgan-spending-surprises';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

function buildStudySeed(): SeedData {
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

  seed.accounts.pretax.balance = 0;
  seed.accounts.taxable.balance = 0;
  seed.accounts.cash.balance = 0;
  seed.accounts.roth.balance = 10_000_000;
  seed.accounts.roth.targetAllocation = { CASH: 1 };
  if (seed.accounts.hsa) {
    seed.accounts.hsa.balance = 0;
  }

  seed.rules.healthcarePremiums = {
    baselineAcaPremiumAnnual: 0,
    baselineMedicarePremiumAnnual: 0,
    medicalInflationAnnual: 0,
  };
  seed.rules.hsaStrategy = { enabled: false };
  seed.rules.ltcAssumptions = {
    enabled: false,
    startAge: 85,
    annualCostToday: 0,
    durationYears: 0,
    eventProbability: 0,
  };

  return seed;
}

function buildSplitAgeSeed(): SeedData {
  const seed = buildStudySeed();
  seed.household.robBirthDate = '1960-01-01';
  seed.household.debbieBirthDate = '1966-01-01';
  return seed;
}

function buildStudyAssumptions(): MarketAssumptions {
  return {
    ...defaultAssumptions,
    inflation: 0.028,
    inflationVolatility: 0,
    simulationRuns: 12,
    robPlanningEndAge: 95,
    debbiePlanningEndAge: 95,
    travelPhaseYears: 10,
    simulationSeed: 20260512,
    assumptionsVersion: 'jpmorgan-spending-surprises-test',
  };
}

function age65AnchorSpend() {
  return JPMORGAN_SPENDING_CURVE_POINTS.find((point) => point.age === 65)!
    .annualSpend;
}

describe('J.P. Morgan spending-model schedule adapter', () => {
  it('exports phase-1 constants and fixed dual-mode policy', () => {
    expect(JPMORGAN_SPENDING_SOURCE_VERSION).toBe(
      'jpmorgan-2026-guide-plus-blanchett-smile-2025-spending-surprises',
    );
    expect(BLANCHETT_SPENDING_SMILE_SOURCE_VERSION).toBe(
      'blanchett-2014-retirement-spending-smile',
    );
    expect(JPMORGAN_DEFAULT_CURVE_START_AGE).toBe(65);
    expect(JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP).toBe(0.01);
    expect(JPMORGAN_SPENDING_CURVE_POINTS[0]).toEqual({
      age: 60,
      annualSpend: 77_060,
    });
    expect(JPMORGAN_SPENDING_CURVE_POINTS.find((point) => point.age === 65)).toEqual({
      age: 65,
      annualSpend: age65AnchorSpend(),
    });
    expect(SPENDING_MODEL_SIMULATION_MODES).toEqual([
      'forward_parametric',
      'historical_precedent',
    ]);
  });

  it('tracks field-level assumption sources for defaults and user inputs', () => {
    const resolved = resolveHouseholdSpendingModifiers({
      householdAgeBasis: 'older_adult',
      extraTravelOverlayAnnual: 12_000,
      extraTravelOverlayYears: 4,
    });

    expect(resolved.modifiers.householdAgeBasis).toBe('older_adult');
    expect(resolved.assumptionSources.householdAgeBasis.source).toBe('user');
    expect(resolved.assumptionSources.curveStartAge.source).toBe('source_research');
    expect(resolved.assumptionSources.extraTravelOverlayAnnual.source).toBe('user');
    expect(resolved.assumptionSources.protectHousingFixedCosts.source).toBe('default');
  });

  it('keeps current faithful spending identical to the existing engine path', () => {
    const seed = buildStudySeed();
    const assumptions = buildStudyAssumptions();
    const current = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'current_faithful',
      modifiers: { householdAgeBasis: 'rob' },
    });

    expect(current.status).toBe('complete');
    expect(current.modelCompleteness).toBe('faithful');
    expect(current.inferredAssumptions).toEqual([]);
    expect(current.yearlySchedule[0]).toMatchObject({
      currentPlanBaselineAnnualSpend: 126_000,
      modelBaselineAnnualSpend: 126_000,
      jpmorganCurveAnnualSpend: 126_000,
      finalAnnualSpend: 126_000,
      travelOverlay: 30_000,
    });

    const baselinePath = buildPathResults(seed, assumptions, [], [], {
      pathMode: 'selected_only',
    })[0];
    const schedulePath = buildPathResults(seed, assumptions, [], [], {
      pathMode: 'selected_only',
      annualSpendScheduleByYear: current.annualSpendScheduleByYear,
    })[0];

    expect(schedulePath.medianEndingWealth).toBeCloseTo(baselinePath.medianEndingWealth, 0);
    expect(schedulePath.yearlySeries.at(-1)!.medianSpending).toBeCloseTo(
      baselinePath.yearlySeries.at(-1)!.medianSpending,
      0,
    );
  });

  it('reconstructs a travel-included curve with travel inside the age-65 anchor', () => {
    const schedule = buildSpendingModelSchedule(
      buildStudySeed(),
      buildStudyAssumptions(),
      {
        presetId: 'jpmorgan_curve_travel_included',
        modifiers: { householdAgeBasis: 'rob' },
      },
    );

    expect(schedule.status).toBe('complete');
    expect(schedule.modelCompleteness).toBe('reconstructed');
    expect(schedule.warnings).toEqual([]);
    expect(schedule.provenance.smileSourceVersion).toBe(
      BLANCHETT_SPENDING_SMILE_SOURCE_VERSION,
    );
    expect(schedule.assumptionSources.spendingSmileEquation?.source).toBe(
      'source_research',
    );
    expect(schedule.yearlySchedule[0]).toMatchObject({
      currentPlanBaselineAnnualSpend: 126_000,
      modelBaselineAnnualSpend: 126_000,
      jpmorganCurveAnnualSpend: 126_000,
      finalAnnualSpend: 126_000,
      protectedFixedCosts: 12_000,
      curveSubjectAnnual: 114_000,
      travelOverlay: 0,
    });

    const age95 = schedule.yearlySchedule.find((point) => point.householdAge >= 95);
    const age80 = schedule.yearlySchedule.find((point) => point.householdAge >= 80);
    expect(age80).toBeDefined();
    expect(age95).toBeDefined();
    expect(age80!.finalAnnualSpend).toBeCloseTo(
      12_000 + 114_000 * (57_650 / 70_900),
      2,
    );
    expect(age95!.protectedFixedCosts).toBe(12_000);
    expect(age95!.finalAnnualSpend).toBeCloseTo(
      12_000 +
        114_000 *
          curveMultiplierForAge({
            householdAge: 95,
            inflation: buildStudyAssumptions().inflation,
          }),
      2,
    );
    expect(age95!.finalAnnualSpend).toBeLessThan(age80!.finalAnnualSpend);
    expect(schedule.intermediateCalculations.age95AnnualSpend).toBe(
      age95!.finalAnnualSpend,
    );
    expect(
      schedule.intermediateCalculations.blanchettSmileProjectedAnnualSpendByAge[100],
    ).toBeGreaterThan(
      schedule.intermediateCalculations.blanchettSmileProjectedAnnualSpendByAge[95],
    );
  });

  it('builds Magic Average as an explicit midpoint spending schedule', () => {
    const seed = buildStudySeed();
    const assumptions = buildStudyAssumptions();
    const modifiers = { householdAgeBasis: 'rob' } as const;
    const current = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'current_faithful',
      modifiers,
    });
    const curve = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'jpmorgan_curve_travel_included',
      modifiers,
    });
    const magic = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'magic_average',
      modifiers,
    });

    expect(magic.status).toBe('complete');
    expect(magic.modelCompleteness).toBe('reconstructed');
    expect(magic.assumptionSources.magicAverageBlend?.source).toBe('user');
    expect(magic.inferredAssumptions[0]).toContain('50/50 blend');
    expect(
      magic.intermediateCalculations.magicAverageCurrentFaithfulWeight,
    ).toBe(0.5);
    expect(magic.intermediateCalculations.magicAverageJpmorganWeight).toBe(0.5);
    expect(magic.intermediateCalculations.magicAverageSourcePresetIds).toEqual([
      'current_faithful',
      'jpmorgan_curve_travel_included',
    ]);

    const age80 = magic.yearlySchedule.find((point) => point.householdAge >= 80);
    const currentAge80 = current.yearlySchedule.find(
      (point) => point.householdAge >= 80,
    );
    const curveAge80 = curve.yearlySchedule.find((point) => point.householdAge >= 80);
    expect(age80).toBeDefined();
    expect(currentAge80).toBeDefined();
    expect(curveAge80).toBeDefined();
    expect(age80!.finalAnnualSpend).toBeCloseTo(
      currentAge80!.finalAnnualSpend * (1 - MAGIC_AVERAGE_BLEND_WEIGHT) +
        curveAge80!.finalAnnualSpend * MAGIC_AVERAGE_BLEND_WEIGHT,
      2,
    );
    expect(magic.annualSpendScheduleByYear[age80!.year]).toBe(
      age80!.finalAnnualSpend,
    );
  });

  it('starts pre-65 retirement years above the age-65 anchor from the JPM 60-64 bucket', () => {
    const seed = buildStudySeed();
    seed.household.robBirthDate = '1963-01-01';
    seed.household.debbieBirthDate = '1963-01-01';
    const assumptions = buildStudyAssumptions();
    const current = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'current_faithful',
      modifiers: { householdAgeBasis: 'rob' },
    });
    const curve = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'jpmorgan_curve_travel_included',
      modifiers: { householdAgeBasis: 'rob' },
    });

    expect(curve.yearlySchedule[0].householdAge).toBe(63);
    expect(curve.yearlySchedule[0].curveMultiplier).toBeGreaterThan(1);
    expect(curve.annualSpendScheduleByYear[2026]).toBeGreaterThan(
      current.annualSpendScheduleByYear[2026],
    );
    expect(curve.yearlySchedule[0]).toMatchObject({
      protectedFixedCosts: 12_000,
      curveSubjectAnnual: 114_000,
      travelOverlay: 0,
    });
  });

  it('pins the J.P. Morgan age-bucket curve multipliers', () => {
    const assumptions = buildStudyAssumptions();
    const anchorSpend = age65AnchorSpend();
    for (const { age, annualSpend } of JPMORGAN_SPENDING_CURVE_POINTS) {
      if (age > 90) {
        continue;
      }
      const expected = annualSpend / anchorSpend;
      expect(
        curveMultiplierForAge({
          householdAge: age,
          inflation: assumptions.inflation,
        }),
      ).toBeCloseTo(expected, 12);
    }
    expect(
      curveMultiplierForAge({
        householdAge: 72.5,
        inflation: assumptions.inflation,
      }),
    ).toBeCloseTo(((67_640 + 62_460) / 2) / 70_900, 12);
    expect(
      curveMultiplierForAge({
        householdAge: 80,
        inflation: assumptions.inflation,
      }),
    ).toBeLessThan(
      curveMultiplierForAge({
        householdAge: 65,
        inflation: assumptions.inflation,
      }),
    );
    expect(
      curveMultiplierForAge({
        householdAge: 100,
        inflation: assumptions.inflation,
      }),
    ).toBeGreaterThan(
      curveMultiplierForAge({
        householdAge: 95,
        inflation: assumptions.inflation,
      }),
    );
    expect(
      curveMultiplierForAge({
        householdAge: 95,
        inflation: assumptions.inflation,
      }),
    ).toBeGreaterThan(
      curveMultiplierForAge({
        householdAge: 94,
        inflation: assumptions.inflation,
      }),
    );
    expect(blanchettAnnualRealSpendingChangeForAge(100)).toBeGreaterThan(
      blanchettAnnualRealSpendingChangeForAge(90),
    );
  });

  it('requires explicit amount and years before running the extra travel overlay preset', () => {
    const missing = buildSpendingModelSchedule(
      buildStudySeed(),
      buildStudyAssumptions(),
      {
        presetId: 'jpmorgan_curve_extra_travel_overlay',
        modifiers: { householdAgeBasis: 'rob' },
      },
    );

    expect(missing.status).toBe('skipped');
    expect(missing.annualSpendScheduleByYear).toEqual({});
    expect(missing.warnings).toContainEqual(
      expect.objectContaining({
        code: 'extra_travel_missing',
        severity: 'blocking',
      }),
    );

    const explicit = buildSpendingModelSchedule(
      buildStudySeed(),
      buildStudyAssumptions(),
      {
        presetId: 'jpmorgan_curve_extra_travel_overlay',
        modifiers: {
          householdAgeBasis: 'rob',
          extraTravelOverlayAnnual: 15_000,
          extraTravelOverlayYears: 2,
        },
      },
    );

    expect(explicit.status).toBe('complete');
    expect(explicit.yearlySchedule[0].travelOverlay).toBe(15_000);
    expect(explicit.yearlySchedule[1].travelOverlay).toBe(15_000);
    expect(explicit.yearlySchedule[2].travelOverlay).toBe(0);
  });

  it('models early surge as an explicit selected stress with a relevance warning when partial retirement is off', () => {
    const seed = buildStudySeed();
    const assumptions = buildStudyAssumptions();
    const base = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'jpmorgan_curve_travel_included',
      modifiers: { householdAgeBasis: 'rob' },
    });
    const surge = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'jpmorgan_curve_early_surge',
      modifiers: { householdAgeBasis: 'rob' },
    });

    expect(surge.warnings).toContainEqual(
      expect.objectContaining({
        code: 'surge_not_applicable',
        severity: 'info',
      }),
    );
    expect(surge.annualSpendScheduleByYear[2026]).toBeCloseTo(
      base.annualSpendScheduleByYear[2026] * 1.3,
      2,
    );
    expect(surge.annualSpendScheduleByYear[2028]).toBeCloseTo(
      base.annualSpendScheduleByYear[2028] * 1.3,
      2,
    );
    expect(surge.annualSpendScheduleByYear[2029]).toBe(
      base.annualSpendScheduleByYear[2029],
    );
  });

  it('places early and age-75 volatility in separate preset rows', () => {
    const seed = buildSplitAgeSeed();
    const assumptions = buildStudyAssumptions();
    const early = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'jpmorgan_curve_early_volatility',
      modifiers: { householdAgeBasis: 'older_adult' },
    });
    const age75 = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'jpmorgan_curve_age75_volatility',
      modifiers: { householdAgeBasis: 'younger_adult' },
    });

    const firstEarlyShock = early.yearlySchedule.find(
      (point) => point.volatilityAdjustment > 0,
    );
    const firstAge75Shock = age75.yearlySchedule.find(
      (point) => point.volatilityAdjustment > 0,
    );

    expect(firstEarlyShock?.year).toBe(2026);
    expect(firstAge75Shock?.householdAge).toBeGreaterThanOrEqual(75);
    expect(firstAge75Shock?.year).toBe(2041);
  });

  it('returns only default-selected phase-1 schedules', () => {
    const schedules = buildDefaultSpendingModelSchedules(
      buildStudySeed(),
      buildStudyAssumptions(),
      {
        modifiers: { householdAgeBasis: 'rob' },
      },
    );

    expect(schedules.map((schedule) => schedule.id)).toEqual([
      'current_faithful',
      'jpmorgan_curve_travel_included',
      'magic_average',
      'jpmorgan_curve_early_volatility',
      'jpmorgan_curve_age75_volatility',
    ]);
    expect(schedules.every((schedule) => schedule.status === 'complete')).toBe(true);
  });

  it('can feed the existing Monte Carlo annualSpendScheduleByYear hook', () => {
    const seed = buildStudySeed();
    const assumptions = buildStudyAssumptions();
    const current = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'current_faithful',
      modifiers: { householdAgeBasis: 'rob' },
    });
    const curve = buildSpendingModelSchedule(seed, assumptions, {
      presetId: 'jpmorgan_curve_travel_included',
      modifiers: { householdAgeBasis: 'rob' },
    });

    const currentPath = buildPathResults(seed, assumptions, [], [], {
      pathMode: 'selected_only',
      annualSpendScheduleByYear: current.annualSpendScheduleByYear,
    })[0];
    const curvePath = buildPathResults(seed, assumptions, [], [], {
      pathMode: 'selected_only',
      annualSpendScheduleByYear: curve.annualSpendScheduleByYear,
    })[0];

    expect(curve.annualSpendScheduleByYear[2026]).toBe(current.annualSpendScheduleByYear[2026]);
    expect(curve.annualSpendScheduleByYear[2041]).toBeLessThan(
      curve.annualSpendScheduleByYear[2026],
    );
    expect(curvePath.yearlySeries.at(-1)!.medianSpending).not.toBe(
      currentPath.yearlySeries.at(-1)!.medianSpending,
    );
  });
});
