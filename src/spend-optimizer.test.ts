import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { getDefaultVerificationAssumptions } from './verification-harness';
import { findMaxSustainableSpend } from './spend-optimizer';

/**
 * Tests for `findMaxSustainableSpend`.
 *
 * Strategy mirrors `ss-optimizer.test.ts`: small synthetic seeds, low
 * trial counts, narrow ranges. Validates the BISECTION CONTRACT, not
 * engine math:
 *
 *   1. Returns a recommended spend within [min, max]
 *   2. The recommended spend's solvency >= target (when feasible)
 *   3. `feasible: false` when seed can't sustain min at the target
 *   4. `feasible: true` and reports max when seed sustains max too
 *   5. Trace records every evaluation
 *   6. Cancellation short-circuits without crashing
 *
 * One directional property test confirms that a richer household has a
 * higher max sustainable spend than a thinner one — sanity check on the
 * monotonicity-of-bisection assumption.
 */

const FAST_TRIALS = 50;

function buildSpendSeed(opts: {
  startingBalance: number;
  /** Annual spending the seed encodes — used as the "current" baseline
   *  in the optimizer's currentSeedEvaluation comparison. */
  annualSpending: number;
}): SeedData {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));

  // Tax-neutral, single-bucket setup (Roth = no tax on growth/withdrawal).
  seed.accounts.pretax.balance = 0;
  seed.accounts.taxable.balance = 0;
  seed.accounts.cash.balance = 0;
  seed.accounts.hsa.balance = 0;
  seed.accounts.roth.balance = opts.startingBalance;
  seed.accounts.roth.targetAllocation = { VTI: 0.6, BND: 0.4 };

  // Spending: split into essential so guardrails don't cut it.
  seed.spending.essentialMonthly = opts.annualSpending / 12;
  seed.spending.optionalMonthly = 0;
  seed.spending.travelEarlyRetirementAnnual = 0;
  seed.spending.annualTaxesInsurance = 0;

  // No income — already retired.
  seed.income.salaryAnnual = 0;
  seed.income.salaryEndDate = '2025-01-01';
  seed.income.socialSecurity = [];
  seed.income.windfalls = [];

  // Disable feature noise.
  seed.rules.ltcAssumptions.eventProbability = 0;
  seed.rules.ltcAssumptions.annualCostToday = 0;
  seed.rules.healthcarePremiums.baselineAcaPremiumAnnual = 0;
  seed.rules.healthcarePremiums.baselineMedicarePremiumAnnual = 0;
  seed.rules.hsaStrategy.enabled = false;

  // Birthdates: household is 65 today.
  const currentYear = new Date().getUTCFullYear();
  const birthYear = currentYear - 65;
  seed.household.robBirthDate = `${birthYear}-01-01`;
  seed.household.debbieBirthDate = `${birthYear}-01-01`;

  return seed;
}

function buildAssumptions(): MarketAssumptions {
  return {
    ...getDefaultVerificationAssumptions(),
    robPlanningEndAge: 90,
    debbiePlanningEndAge: 90,
  };
}

describe('findMaxSustainableSpend — contract', () => {
  it('returns a spend within [min, max] and meets the target solvency (no legacy goal)', () => {
    const seed = buildSpendSeed({
      startingBalance: 1_500_000,
      annualSpending: 50_000,
    });

    const result = findMaxSustainableSpend(seed, buildAssumptions(), {
      minAnnualSpend: 30_000,
      maxAnnualSpend: 80_000,
      targetSolventRate: 0.95,
      trialCount: FAST_TRIALS,
      toleranceDollars: 2_000,
      // No legacy target → constraint is solvency only.
      legacyTargetTodayDollars: 0,
    });

    expect(result.feasible).toBe(true);
    expect(result.targetLegacyAttainmentRate).toBeNull();
    expect(result.recommendedAnnualSpendTodayDollars).toBeGreaterThanOrEqual(30_000);
    expect(result.recommendedAnnualSpendTodayDollars).toBeLessThanOrEqual(80_000);
    // The recommended evaluation's solvency must meet the floor.
    expect(result.recommendedEvaluation.solventSuccessRate).toBeGreaterThanOrEqual(
      0.95 - 0.05, // small tolerance for RNG noise at FAST_TRIALS
    );
  });

  it('enforces both constraints when a legacy target is set', () => {
    const seed = buildSpendSeed({
      startingBalance: 1_500_000,
      annualSpending: 50_000,
    });

    const result = findMaxSustainableSpend(seed, buildAssumptions(), {
      minAnnualSpend: 30_000,
      maxAnnualSpend: 80_000,
      targetSolventRate: 0.85,
      targetLegacyAttainmentRate: 0.85,
      legacyTargetTodayDollars: 250_000, // moderate legacy goal
      trialCount: FAST_TRIALS,
      toleranceDollars: 2_000,
    });

    expect(result.targetLegacyAttainmentRate).toBe(0.85);
    if (result.feasible) {
      // When feasible, the recommended point must satisfy BOTH
      // constraints (within RNG tolerance).
      expect(result.recommendedEvaluation.solventSuccessRate).toBeGreaterThanOrEqual(
        0.85 - 0.05,
      );
      expect(result.recommendedEvaluation.legacyAttainmentRate).not.toBeNull();
      expect(
        result.recommendedEvaluation.legacyAttainmentRate ?? 0,
      ).toBeGreaterThanOrEqual(0.85 - 0.05);
      expect(['solvency', 'legacy', 'both']).toContain(
        result.bindingConstraint,
      );
    } else {
      // Infeasible: the binding constraint should be one of the two.
      expect(['solvency', 'legacy', 'both']).toContain(result.bindingConstraint);
    }
  });

  it('reports infeasible when the seed cannot sustain even minAnnualSpend', () => {
    // $50k starting balance vs $200k floor → impossible.
    const seed = buildSpendSeed({
      startingBalance: 50_000,
      annualSpending: 60_000,
    });

    const result = findMaxSustainableSpend(seed, buildAssumptions(), {
      minAnnualSpend: 200_000,
      maxAnnualSpend: 300_000,
      targetSolventRate: 0.95,
      trialCount: FAST_TRIALS,
      legacyTargetTodayDollars: 0,
    });

    expect(result.feasible).toBe(false);
    expect(result.recommendedAnnualSpendTodayDollars).toBe(200_000);
    expect(result.bindingConstraint).toBe('solvency');
  });

  it('returns max when the seed sustains the upper bound at target', () => {
    // Massive starting balance + low max → trivially sustainable.
    const seed = buildSpendSeed({
      startingBalance: 10_000_000,
      annualSpending: 50_000,
    });

    const result = findMaxSustainableSpend(seed, buildAssumptions(), {
      minAnnualSpend: 30_000,
      maxAnnualSpend: 50_000,
      targetSolventRate: 0.95,
      trialCount: FAST_TRIALS,
      legacyTargetTodayDollars: 0,
    });

    expect(result.feasible).toBe(true);
    expect(result.recommendedAnnualSpendTodayDollars).toBe(50_000);
  });

  it('records every evaluation in trace', () => {
    const seed = buildSpendSeed({
      startingBalance: 1_500_000,
      annualSpending: 50_000,
    });

    const result = findMaxSustainableSpend(seed, buildAssumptions(), {
      minAnnualSpend: 30_000,
      maxAnnualSpend: 80_000,
      targetSolventRate: 0.95,
      trialCount: FAST_TRIALS,
      maxIterations: 4, // limit work so the test is fast and trace is bounded
      legacyTargetTodayDollars: 0,
    });

    // Trace should include: bracket-min, bracket-max, up to 4 bisection
    // mids, plus current-seed evaluation = at least 3, at most ~7.
    expect(result.trace.length).toBeGreaterThanOrEqual(3);
    expect(result.trace.length).toBeLessThanOrEqual(7);
    // Every trace entry must report a finite solvency.
    for (const t of result.trace) {
      expect(Number.isFinite(t.solventSuccessRate)).toBe(true);
    }
  });

  it('honors isCancelled — bails out without crashing', () => {
    const seed = buildSpendSeed({
      startingBalance: 1_000_000,
      annualSpending: 50_000,
    });
    let calls = 0;
    expect(() =>
      findMaxSustainableSpend(seed, buildAssumptions(), {
        minAnnualSpend: 30_000,
        maxAnnualSpend: 80_000,
        targetSolventRate: 0.95,
        trialCount: FAST_TRIALS,
        onProgress: () => {
          calls += 1;
        },
        isCancelled: () => calls >= 2,
      }),
    ).not.toThrow();
  });

  it('throws when minAnnualSpend >= maxAnnualSpend', () => {
    const seed = buildSpendSeed({
      startingBalance: 1_000_000,
      annualSpending: 50_000,
    });
    expect(() =>
      findMaxSustainableSpend(seed, buildAssumptions(), {
        minAnnualSpend: 80_000,
        maxAnnualSpend: 80_000,
        trialCount: FAST_TRIALS,
      }),
    ).toThrow();
  });
});

describe('findMaxSustainableSpend — directional behavior', () => {
  it('a richer seed has a higher max sustainable spend than a thinner one', () => {
    const thinSeed = buildSpendSeed({
      startingBalance: 800_000,
      annualSpending: 50_000,
    });
    const richSeed = buildSpendSeed({
      startingBalance: 2_000_000,
      annualSpending: 50_000,
    });
    const opts = {
      minAnnualSpend: 30_000,
      maxAnnualSpend: 200_000,
      targetSolventRate: 0.9,
      trialCount: 200,
      toleranceDollars: 5_000,
    };
    const thin = findMaxSustainableSpend(thinSeed, buildAssumptions(), opts);
    const rich = findMaxSustainableSpend(richSeed, buildAssumptions(), opts);

    // Rich seed should sustain materially more spending. Use a loose
    // bound (10k) to absorb RNG noise at moderate trial counts.
    expect(rich.recommendedAnnualSpendTodayDollars).toBeGreaterThan(
      thin.recommendedAnnualSpendTodayDollars + 10_000,
    );
  });
});
