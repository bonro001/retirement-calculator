import { describe, expect, it, vi } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';
import { solveSpendByReverseTimeline } from './spend-solver';
import { evaluatePlan, type Plan } from './plan-evaluation';

vi.setConfig({ testTimeout: 30_000 });

const SOLVER_TEST_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 24,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'spend-solver-test',
};

function buildSolverInput() {
  return {
    data: initialSeedData,
    assumptions: SOLVER_TEST_ASSUMPTIONS,
    selectedStressors: ['market_down'],
    selectedResponses: ['cut_spending'],
    // Re-tuned 2026-04-29 after the SS engine integration: spousal-floor
    // math added ~$7,272/yr to Debbie's projected SS income, lifting
    // overall household solvency. Previous target ($900k) and floor
    // (80% solvent) became trivially achievable, so the solver hit
    // its upper-spending-cap without actually bisecting — adjacent
    // tests started seeing zero phase deltas / no differentiation.
    // Raised to $1.6M legacy + 90% solvency to put the constraints
    // back on the binding edge where the solver has real work to do.
    targetLegacyTodayDollars: 1_600_000,
    minSuccessRate: 0.9,
    spendingFloorAnnual: 60000,
    spendingCeilingAnnual: 220000,
    toleranceAnnual: 500,
    maxIterations: 14,
  };
}

function getPhaseDelta(result: ReturnType<typeof solveSpendByReverseTimeline>, phase: 'go_go' | 'slow_go' | 'late') {
  return result.spendingDeltaByPhase.find((entry) => entry.phase === phase)?.deltaAnnual ?? 0;
}

describe('spend-solver', () => {
  it('reduces allowed spending when primary residence sale is disabled', () => {
    // Re-tuned 2026-04-29: target $1.2M / 85% became trivially
    // achievable after SS engine integration; both policies hit the
    // upper cap with identical recommended spends. Bumped to $2M /
    // 90% so the home-sale-vs-no-home-sale distinction binds.
    const allowsHomeSale = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 2_000_000,
      minSuccessRate: 0.9,
      housingFundingPolicy: 'allow_primary_residence_sale',
    });
    const blocksHomeSale = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 2_000_000,
      minSuccessRate: 0.9,
      housingFundingPolicy: 'do_not_sell_primary_residence',
    });

    expect(blocksHomeSale.recommendedAnnualSpend).toBeLessThan(
      allowsHomeSale.recommendedAnnualSpend,
    );
  });

  it('reduces allowed spending when legacy target increases', () => {
    const lowLegacy = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 500000,
    });
    const highLegacy = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 1400000,
    });

    expect(highLegacy.recommendedAnnualSpend).toBeLessThanOrEqual(
      lowLegacy.recommendedAnnualSpend,
    );
    expect(highLegacy.supportedAnnualSpendNow).toBeLessThanOrEqual(
      lowLegacy.supportedAnnualSpendNow,
    );
  });

  it('reduces allowed spending when required success rate increases', () => {
    const lowerSuccessFloor = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      minSuccessRate: 0.72,
    });
    const higherSuccessFloor = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      minSuccessRate: 0.9,
    });

    expect(higherSuccessFloor.recommendedAnnualSpend).toBeLessThanOrEqual(
      lowerSuccessFloor.recommendedAnnualSpend,
    );
  });

  it('converges to a stable recommendation', () => {
    const result = solveSpendByReverseTimeline(buildSolverInput());

    expect(result.converged).toBe(true);
    expect(result.safeSpendingBand.lowerAnnual).toBeLessThanOrEqual(
      result.safeSpendingBand.targetAnnual,
    );
    expect(result.safeSpendingBand.targetAnnual).toBeLessThanOrEqual(
      result.safeSpendingBand.upperAnnual,
    );
    expect(result.actionableExplanation.length).toBeGreaterThan(0);
    expect(result.tradeoffExplanation.length).toBeGreaterThan(0);
  });

  it('is deterministic for repeated runs with the same seed', () => {
    const firstRun = solveSpendByReverseTimeline(buildSolverInput());
    const secondRun = solveSpendByReverseTimeline(buildSolverInput());

    expect(secondRun.recommendedAnnualSpend).toBe(firstRun.recommendedAnnualSpend);
    expect(secondRun.modeledSuccessRate).toBe(firstRun.modeledSuccessRate);
    expect(secondRun.projectedLegacyOutcomeTodayDollars).toBe(
      firstRun.projectedLegacyOutcomeTodayDollars,
    );
  });

  it('produces differentiated phase spending adjustments in time-weighted mode', () => {
    // Re-tuned 2026-04-29: target $750k / 75% after SS engine
    // integration → solver hit upper cap, all phases zero. Bumped
    // to $1.8M / 88% so the time-weighted optimization actually has
    // headroom-vs-constraint to differentiate go-go from late.
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      selectedStressors: [],
      selectedResponses: [],
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 1_800_000,
      minSuccessRate: 0.88,
    });

    const goGoDelta = getPhaseDelta(result, 'go_go');
    const lateDelta = getPhaseDelta(result, 'late');

    expect(result.activeOptimizationObjective).toBe('maximize_time_weighted_spending');
    expect(goGoDelta).not.toBe(lateDelta);
    expect(
      result.spendingDeltaByPhase.every((entry) => Number.isFinite(entry.optimizedAnnual)),
    ).toBe(true);
  }, 20000);

  it('respects minimum ending wealth and success constraints in time-weighted mode', () => {
    const minSuccessRate = 0.8;
    const targetLegacy = 700_000;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      minSuccessRate,
      targetLegacyTodayDollars: targetLegacy,
    });

    if (result.feasible) {
      expect(result.legacyAttainmentMet).toBe(true);
      expect(result.projectedLegacyOutcomeTodayDollars).toBeGreaterThanOrEqual(
        result.legacyFloorTodayDollars,
      );
      expect(result.modeledSuccessRate).toBeGreaterThanOrEqual(minSuccessRate);
      return;
    }

    expect(result.bindingConstraint.length).toBeGreaterThan(0);
    expect(result.actionableExplanation.length).toBeGreaterThan(0);
    expect(result.modeledSuccessRate < minSuccessRate || result.projectedLegacyOutcomeTodayDollars < targetLegacy).toBe(true);
  }, 20000);

  it('reduces feasible spending when inheritance is removed in time-weighted mode', () => {
    const withInheritance = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
    });
    const withoutInheritance = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
      constraints: {
        inheritanceEnabled: false,
      },
    });

    expect(withoutInheritance.recommendedAnnualSpend).toBeLessThanOrEqual(
      withInheritance.recommendedAnnualSpend,
    );
  }, 20000);

  it('does not reduce flexible spending below configured minimums', () => {
    const flexibleMinimumAnnual = 36_000;
    const travelMinimumAnnual = 6_000;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      spendingMinimums: {
        flexibleAnnualMinimum: flexibleMinimumAnnual,
        travelAnnualMinimum: travelMinimumAnnual,
      },
      spendingFloorAnnual: 60_000 + 12_000 + flexibleMinimumAnnual + travelMinimumAnnual,
      selectedStressors: [],
      selectedResponses: [],
    });

    expect(result.flexibleSpendingMinimum).toBeGreaterThanOrEqual(flexibleMinimumAnnual);
    expect(result.travelSpendingMinimum).toBeGreaterThanOrEqual(travelMinimumAnnual);
    expect(result.floorAnnual).toBeGreaterThanOrEqual(
      60_000 + 12_000 + flexibleMinimumAnnual + travelMinimumAnnual,
    );
    expect(result.recommendedAnnualSpend).toBeGreaterThanOrEqual(result.floorAnnual);
  }, 20000);

  it('changes supported spending when flexible minimums are tightened', () => {
    const constrainedData = {
      ...initialSeedData,
      accounts: {
        ...initialSeedData.accounts,
        pretax: { ...initialSeedData.accounts.pretax, balance: initialSeedData.accounts.pretax.balance * 0.35 },
        roth: { ...initialSeedData.accounts.roth, balance: initialSeedData.accounts.roth.balance * 0.35 },
        taxable: { ...initialSeedData.accounts.taxable, balance: initialSeedData.accounts.taxable.balance * 0.35 },
        cash: { ...initialSeedData.accounts.cash, balance: initialSeedData.accounts.cash.balance * 0.35 },
      },
    };
    const constrainedAssumptions: MarketAssumptions = {
      ...SOLVER_TEST_ASSUMPTIONS,
      simulationRuns: 50,
      equityMean: 0.03,
      internationalEquityMean: 0.03,
      bondMean: 0.015,
      cashMean: 0.005,
      inflation: 0.04,
    };
    const baseline = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      data: constrainedData,
      assumptions: constrainedAssumptions,
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 900_000,
      minSuccessRate: 0.9,
      spendingCeilingAnnual: 200_000,
      spendingMinimums: {
        flexibleAnnualMinimum: 10_000,
      },
      selectedStressors: ['market_down', 'high_inflation'],
      selectedResponses: ['cut_spending'],
    });
    const tighterMinimum = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      data: constrainedData,
      assumptions: constrainedAssumptions,
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 900_000,
      minSuccessRate: 0.9,
      spendingCeilingAnnual: 200_000,
      spendingMinimums: {
        flexibleAnnualMinimum: 45_000,
      },
      selectedStressors: ['market_down', 'high_inflation'],
      selectedResponses: ['cut_spending'],
    });

    const supportedSpendChanged =
      tighterMinimum.supportedAnnualSpendNow !== baseline.supportedAnnualSpendNow ||
      tighterMinimum.supportedSpend60s !== baseline.supportedSpend60s ||
      tighterMinimum.supportedSpend70s !== baseline.supportedSpend70s ||
      tighterMinimum.supportedSpend80Plus !== baseline.supportedSpend80Plus ||
      tighterMinimum.flexibleSpendingMinimum !== baseline.flexibleSpendingMinimum ||
      tighterMinimum.floorAnnual !== baseline.floorAnnual ||
      tighterMinimum.bindingConstraint !== baseline.bindingConstraint;
    expect(supportedSpendChanged).toBe(true);
  }, 20000);

  it('changes supported spending when IRMAA/tax constraints tighten', () => {
    const pretaxHeavyData = {
      ...initialSeedData,
      accounts: {
        ...initialSeedData.accounts,
        pretax: {
          ...initialSeedData.accounts.pretax,
          balance:
            initialSeedData.accounts.pretax.balance * 0.75 +
            initialSeedData.accounts.roth.balance * 0.75 +
            initialSeedData.accounts.taxable.balance * 0.75,
        },
        roth: { ...initialSeedData.accounts.roth, balance: initialSeedData.accounts.roth.balance * 0.05 },
        taxable: { ...initialSeedData.accounts.taxable, balance: initialSeedData.accounts.taxable.balance * 0.05 },
        cash: { ...initialSeedData.accounts.cash, balance: initialSeedData.accounts.cash.balance * 0.2 },
      },
    };
    const constrainedAssumptions: MarketAssumptions = {
      ...SOLVER_TEST_ASSUMPTIONS,
      simulationRuns: 50,
      equityMean: 0.03,
      internationalEquityMean: 0.03,
      bondMean: 0.015,
      cashMean: 0.005,
      inflation: 0.04,
    };
    const base = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      data: pretaxHeavyData,
      assumptions: constrainedAssumptions,
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 900_000,
      minSuccessRate: 0.9,
      spendingCeilingAnnual: 200_000,
      selectedStressors: ['market_down', 'high_inflation'],
      selectedResponses: ['cut_spending'],
    });
    const tighterTaxData = {
      ...pretaxHeavyData,
      household: {
        ...pretaxHeavyData.household,
        filingStatus: 'single',
      },
    };
    const tighterConstraints = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      data: tighterTaxData,
      assumptions: {
        ...constrainedAssumptions,
        irmaaThreshold: 60_000,
      },
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 900_000,
      minSuccessRate: 0.9,
      spendingCeilingAnnual: 200_000,
      selectedStressors: ['market_down', 'high_inflation'],
      selectedResponses: ['cut_spending'],
    });

    const supportedSpendChanged =
      tighterConstraints.supportedAnnualSpendNow !== base.supportedAnnualSpendNow ||
      tighterConstraints.supportedSpend60s !== base.supportedSpend60s ||
      tighterConstraints.supportedSpend70s !== base.supportedSpend70s ||
      tighterConstraints.supportedSpend80Plus !== base.supportedSpend80Plus;
    expect(
      supportedSpendChanged ||
        tighterConstraints.annualFederalTaxEstimate >= base.annualFederalTaxEstimate ||
        tighterConstraints.annualHealthcareCostEstimate >= base.annualHealthcareCostEstimate,
    ).toBe(true);
  }, 20000);

  it('keeps supported spending output distinct from user target spending intent', () => {
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 1_300_000,
      minSuccessRate: 0.88,
      selectedStressors: ['market_down', 'high_inflation'],
      selectedResponses: ['cut_spending'],
    });

    expect(result.userTargetSpendNowMonthly).toBeGreaterThan(0);
    expect(result.supportedMonthlySpendNow).toBeGreaterThan(0);
    expect(result.userTargetSpendNowMonthly).not.toBe(result.supportedMonthlySpendNow);
    expect(result.spendGapNowMonthly).toBe(
      Number((result.supportedMonthlySpendNow - result.userTargetSpendNowMonthly).toFixed(2)),
    );
  }, 20000);

  it('applies sensible spending-minimum defaults for plans without explicit minimum fields', () => {
    const inferredFloorAnnual = 60_000 + 12_000 + 60_000 * 0.88 + 14_000 * 0.8;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      spendingFloorAnnual: inferredFloorAnnual,
      selectedStressors: [],
      selectedResponses: [],
    });

    expect(result.flexibleSpendingMinimum).toBeGreaterThan(0);
    expect(result.travelSpendingMinimum).toBeGreaterThan(0);
    expect(result.flexibleSpendingMinimum).toBeLessThanOrEqual(result.flexibleSpendingTarget);
    expect(result.travelSpendingMinimum).toBeLessThanOrEqual(result.travelSpendingTarget);
  });

  it('produces a meaningfully different phase profile than preserve_legacy mode', () => {
    const preserveLegacy = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'preserve_legacy',
      selectedStressors: [],
      selectedResponses: [],
    });
    const timeWeighted = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      selectedStressors: [],
      selectedResponses: [],
    });

    const preserveDeltas = preserveLegacy.spendingDeltaByPhase.map((entry) => entry.deltaAnnual);
    const timeWeightedDeltas = timeWeighted.spendingDeltaByPhase.map((entry) => entry.deltaAnnual);
    const preserveSpread = Math.max(...preserveDeltas) - Math.min(...preserveDeltas);
    const timeWeightedSpread = Math.max(...timeWeightedDeltas) - Math.min(...timeWeightedDeltas);

    expect(timeWeighted.activeOptimizationObjective).toBe('maximize_time_weighted_spending');
    expect(preserveLegacy.activeOptimizationObjective).toBe('preserve_legacy');
    expect(timeWeightedSpread).toBeGreaterThan(preserveSpread);
  }, 20000);

  it('expands spending ceiling to consume surplus when legacy is far over target', () => {
    const highAssetData = {
      ...initialSeedData,
      accounts: {
        ...initialSeedData.accounts,
        pretax: { ...initialSeedData.accounts.pretax, balance: initialSeedData.accounts.pretax.balance * 2.5 },
        roth: { ...initialSeedData.accounts.roth, balance: initialSeedData.accounts.roth.balance * 2.5 },
        taxable: { ...initialSeedData.accounts.taxable, balance: initialSeedData.accounts.taxable.balance * 2.5 },
        cash: { ...initialSeedData.accounts.cash, balance: initialSeedData.accounts.cash.balance * 2.5 },
      },
    };
    const initialCeilingAnnual = 170_000;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      data: highAssetData,
      assumptions: {
        ...SOLVER_TEST_ASSUMPTIONS,
        simulationRuns: 24,
      },
      selectedStressors: [],
      selectedResponses: [],
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 1_000_000,
      minSuccessRate: 0.75,
      spendingCeilingAnnual: initialCeilingAnnual,
      maxIterations: 8,
      runtimeBudget: {
        searchSimulationRuns: 16,
        finalSimulationRuns: 24,
        maxIterations: 8,
        diagnosticsMode: 'core',
        enableSuccessRelaxationProbe: false,
      },
    });

    expect(result.ceilingAnnual).toBeGreaterThanOrEqual(initialCeilingAnnual);
    expect(result.ceilingUsed).toBe(result.ceilingAnnual);
    expect(result.ceilingIterations).toBeGreaterThan(0);
    expect(result.finalBindingConstraint).not.toBe('upper_spending_cap');
    const closeToTarget = Math.abs(result.distanceFromTarget) <= Math.max(500_000, 1_000_000 * 0.5);
    expect(
      closeToTarget || result.finalBindingConstraint !== 'upper_spending_cap',
    ).toBe(true);
  }, 20000);

  it('lands near target when constraints permit a close target-seeking solution', () => {
    // Re-tuned 2026-04-29: previous target $1M / 65% solvent was
    // trivially achievable after SS engine integration — solver
    // landed at the spending ceiling ($151k vs the test's expected
    // ≤$100k from-target). Bumped target to $2.5M to put the
    // optimizer genuinely on the target's edge.
    const targetLegacy = 2_500_000;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      selectedStressors: [],
      selectedResponses: [],
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: targetLegacy,
      minSuccessRate: 0.65,
      assumptions: {
        ...SOLVER_TEST_ASSUMPTIONS,
        simulationRuns: 40,
      },
      maxIterations: 8,
    });

    const distance = Math.abs(result.distanceFromTarget);
    const tolerance = Math.max(100_000, targetLegacy * 0.1);
    expect(result.activeOptimizationObjective).toBe('maximize_time_weighted_spending');
    expect(distance).toBeLessThanOrEqual(tolerance);
    expect(result.overTargetPenalty).toBeGreaterThanOrEqual(0);
  }, 20000);

  it('keeps median ending wealth close to legacy target in balanced (92%) time-weighted mode', () => {
    const targetLegacy = 1_000_000;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      selectedStressors: [],
      selectedResponses: [],
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: targetLegacy,
      minSuccessRate: 0.92,
    });

    expect(result.activeOptimizationObjective).toBe('maximize_time_weighted_spending');
    expect(result.feasible).toBe(true);
    expect(Math.abs(result.distanceFromTarget)).toBeLessThanOrEqual(100_000);
  }, 30000);

  it('increases supported spending as success floor is relaxed from 99% -> 95% -> 92%', () => {
    const strict99 = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_flat_spending',
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 1_000_000,
      minSuccessRate: 0.99,
    });
    const conservative95 = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_flat_spending',
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 1_000_000,
      minSuccessRate: 0.95,
    });
    const balanced92 = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_flat_spending',
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 1_000_000,
      minSuccessRate: 0.92,
    });

    expect(conservative95.supportedAnnualSpendNow).toBeGreaterThanOrEqual(
      strict99.supportedAnnualSpendNow,
    );
    expect(balanced92.supportedAnnualSpendNow).toBeGreaterThanOrEqual(
      conservative95.supportedAnnualSpendNow,
    );
  }, 30000);

  it('moves ending wealth closer to legacy target when success floor is relaxed', () => {
    const targetLegacy = 1_000_000;
    const strict99 = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_flat_spending',
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: targetLegacy,
      minSuccessRate: 0.99,
    });
    const conservative95 = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_flat_spending',
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: targetLegacy,
      minSuccessRate: 0.95,
    });
    const balanced92 = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_flat_spending',
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: targetLegacy,
      minSuccessRate: 0.92,
    });

    const strictGap = Math.abs(strict99.projectedLegacyOutcomeTodayDollars - targetLegacy);
    const conservativeGap = Math.abs(conservative95.projectedLegacyOutcomeTodayDollars - targetLegacy);
    const balancedGap = Math.abs(balanced92.projectedLegacyOutcomeTodayDollars - targetLegacy);

    expect(conservativeGap).toBeLessThanOrEqual(strictGap);
    expect(Math.min(conservativeGap, balancedGap)).toBeLessThanOrEqual(strictGap);
  }, 30000);

  it('enforces legacy floor and target band diagnostics', () => {
    const targetLegacy = 1_000_000;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: targetLegacy,
      minSuccessRate: 0.92,
    });

    expect(result.legacyFloorTodayDollars).toBe(950_000);
    expect(result.legacyTargetBandLowerTodayDollars).toBe(950_000);
    expect(result.legacyTargetBandUpperTodayDollars).toBe(1_050_000);
    expect(result.projectedLegacyOutcomeTodayDollars).toBeGreaterThanOrEqual(
      result.legacyFloorTodayDollars,
    );
  }, 30000);

  it('propagates success floor consistently through evaluatePlan and solver diagnostics', async () => {
    const plan: Plan = {
      data: initialSeedData,
      assumptions: {
        ...SOLVER_TEST_ASSUMPTIONS,
        simulationRuns: 30,
        assumptionsVersion: 'success-floor-propagation',
      },
      controls: {
        selectedStressorIds: [],
        selectedResponseIds: [],
      },
      preferences: {
        calibration: {
          targetLegacyTodayDollars: 1_000_000,
          legacyPriority: 'important',
          successFloorMode: 'conservative',
          minSuccessRate: 0.95,
          optimizationObjective: 'maximize_flat_spending',
        },
      },
    };

    const evaluation = await evaluatePlan(plan);

    expect(evaluation.calibration.minimumSuccessRateTarget).toBeCloseTo(0.95, 6);
    expect(evaluation.calibration.achievedSuccessRate).toBeCloseTo(
      evaluation.raw.spendingCalibration.modeledSuccessRate,
      6,
    );
    expect(evaluation.summary.successRate).toBeCloseTo(
      evaluation.raw.spendingCalibration.modeledSuccessRate,
      6,
    );
    expect(evaluation.calibration.minimumSuccessRateTarget).toBeCloseTo(
      evaluation.raw.spendingCalibration.minimumSuccessRateTarget,
      6,
    );
  }, 40000);

  it('supports coarse-to-fine solver runtime budgets in core diagnostics mode', () => {
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      runtimeBudget: {
        searchSimulationRuns: 24,
        finalSimulationRuns: 48,
        maxIterations: 10,
        diagnosticsMode: 'core',
        enableSuccessRelaxationProbe: false,
      },
    });

    expect(result.runtimeDiagnostics.searchSimulationRuns).toBe(24);
    expect(result.runtimeDiagnostics.finalSimulationRuns).toBe(48);
    expect(result.runtimeDiagnostics.diagnosticsMode).toBe('core');
    expect(result.runtimeDiagnostics.searchEvaluations).toBeGreaterThan(0);
    expect(result.runtimeDiagnostics.finalEvaluations).toBeGreaterThan(0);
    expect(result.actionableExplanation.toLowerCase()).toContain('reduced for interactive runtime budget');
  });

  it('propagates runtime budgets through evaluatePlan, solver, and decision diagnostics', async () => {
    const plan: Plan = {
      data: initialSeedData,
      assumptions: {
        ...SOLVER_TEST_ASSUMPTIONS,
        simulationRuns: 60,
        assumptionsVersion: 'runtime-budget-propagation',
      },
      controls: {
        selectedStressorIds: ['market_down'],
        selectedResponseIds: ['cut_spending'],
      },
      preferences: {
        calibration: {
          targetLegacyTodayDollars: 1_000_000,
          legacyPriority: 'important',
          successFloorMode: 'balanced',
          minSuccessRate: 0.92,
          optimizationObjective: 'maximize_time_weighted_spending',
        },
        runtime: {
          finalEvaluationSimulationRuns: 54,
          solverSearchSimulationRuns: 24,
          solverFinalSimulationRuns: 48,
          solverMaxIterations: 10,
          solverDiagnosticsMode: 'core',
          solverEnableSuccessRelaxationProbe: false,
          decisionSimulationRuns: 30,
          decisionScenarioEvaluationLimit: 10,
          decisionEvaluateExcludedScenarios: false,
          stressTestComplexity: 'reduced',
          timeoutMs: 55_000,
        },
      },
    };

    const evaluation = await evaluatePlan(plan);

    expect(evaluation.raw.run.runtimeDiagnostics.settings.finalEvaluationSimulationRuns).toBe(54);
    expect(evaluation.raw.run.runtimeDiagnostics.settings.solverSearchSimulationRuns).toBe(24);
    expect(evaluation.raw.spendingCalibration.runtimeDiagnostics.searchSimulationRuns).toBe(24);
    expect(evaluation.raw.spendingCalibration.runtimeDiagnostics.finalSimulationRuns).toBe(48);
    expect(evaluation.raw.decision.runtimeDiagnostics.simulationRunsUsed).toBe(30);
    expect(evaluation.raw.decision.runtimeDiagnostics.scenarioCountEvaluated).toBeLessThanOrEqual(10);
  }, 40000);
});
