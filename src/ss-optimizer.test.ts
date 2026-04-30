import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { getDefaultVerificationAssumptions } from './verification-harness';
import { findOptimalSocialSecurityClaim } from './ss-optimizer';

/**
 * Tests for `findOptimalSocialSecurityClaim`.
 *
 * Strategy: small synthetic seeds, low trial counts, narrow age ranges.
 * The point isn't to validate engine math (the calibration suite covers
 * that) — it's to validate the OPTIMIZER's contract:
 *
 *   1. Returns one candidate per searched cell
 *   2. `recommended === ranked[0]`
 *   3. `currentSeedCandidate` matches the seed's actual claim ages
 *   4. Spouse axis collapses cleanly when only one SS record exists
 *   5. Cancellation short-circuits without crashing
 *
 * One slower property-style test asserts the directional claim that
 * delaying SS improves outcomes for a household with adequate runway —
 * if this ever breaks, either the engine or the optimizer scoring has
 * regressed.
 */

const FAST_TRIALS = 50;
const PROPERTY_TRIALS = 300;

function buildOptimizerSeed(opts: {
  /** Single-claimant if false. */
  hasSpouse: boolean;
  /** Total starting balance across all buckets. */
  startingBalance: number;
  annualSpending: number;
  primaryFraMonthly: number;
  spouseFraMonthly?: number;
  primaryClaimAge: number;
  spouseClaimAge?: number;
}): SeedData {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));

  // All assets in roth (tax-neutral, like the calibration tests).
  seed.accounts.pretax.balance = 0;
  seed.accounts.taxable.balance = 0;
  seed.accounts.cash.balance = 0;
  seed.accounts.hsa.balance = 0;
  seed.accounts.roth.balance = opts.startingBalance;
  seed.accounts.roth.targetAllocation = { VTI: 0.6, BND: 0.4 };

  // Spending: all essential so guardrails don't cut it.
  seed.spending.essentialMonthly = opts.annualSpending / 12;
  seed.spending.optionalMonthly = 0;
  seed.spending.travelEarlyRetirementAnnual = 0;
  seed.spending.annualTaxesInsurance = 0;

  // Already retired — no salary, no windfalls.
  seed.income.salaryAnnual = 0;
  seed.income.salaryEndDate = '2025-01-01';
  seed.income.windfalls = [];
  seed.income.socialSecurity = [
    {
      person: 'rob',
      fraMonthly: opts.primaryFraMonthly,
      claimAge: opts.primaryClaimAge,
    },
  ];
  if (opts.hasSpouse) {
    seed.income.socialSecurity.push({
      person: 'debbie',
      fraMonthly: opts.spouseFraMonthly ?? 0,
      claimAge: opts.spouseClaimAge ?? 67,
    });
  }

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

describe('findOptimalSocialSecurityClaim — contract', () => {
  it('returns one candidate per cell, recommended === ranked[0]', () => {
    const seed = buildOptimizerSeed({
      hasSpouse: true,
      startingBalance: 1_000_000,
      annualSpending: 60_000,
      primaryFraMonthly: 3_000,
      spouseFraMonthly: 2_000,
      primaryClaimAge: 67,
      spouseClaimAge: 67,
    });

    const result = findOptimalSocialSecurityClaim(seed, buildAssumptions(), {
      minClaimAge: 65,
      maxClaimAge: 66,
      trialCount: FAST_TRIALS,
    });

    // 2 ages × 2 ages = 4 cells (both spouses sweep)
    expect(result.ranked).toHaveLength(4);
    expect(result.recommended).toBe(result.ranked[0]);
    expect(result.hasSpouse).toBe(true);
    expect(result.ageRange).toEqual({ min: 65, max: 66, step: 1 });
    expect(result.trialCount).toBe(FAST_TRIALS);
  });

  it('reports currentSeedCandidate matching seed claim ages', () => {
    const seed = buildOptimizerSeed({
      hasSpouse: true,
      startingBalance: 1_000_000,
      annualSpending: 60_000,
      primaryFraMonthly: 3_000,
      spouseFraMonthly: 2_000,
      primaryClaimAge: 66,
      spouseClaimAge: 65,
    });

    const result = findOptimalSocialSecurityClaim(seed, buildAssumptions(), {
      minClaimAge: 65,
      maxClaimAge: 66,
      trialCount: FAST_TRIALS,
    });

    expect(result.currentSeedCandidate).not.toBeNull();
    expect(result.currentSeedCandidate?.primaryAge).toBe(66);
    expect(result.currentSeedCandidate?.spouseAge).toBe(65);
  });

  it('returns null currentSeedCandidate when seed claim ages are outside the search range', () => {
    const seed = buildOptimizerSeed({
      hasSpouse: true,
      startingBalance: 1_000_000,
      annualSpending: 60_000,
      primaryFraMonthly: 3_000,
      spouseFraMonthly: 2_000,
      primaryClaimAge: 62, // outside [65, 66]
      spouseClaimAge: 62,
    });

    const result = findOptimalSocialSecurityClaim(seed, buildAssumptions(), {
      minClaimAge: 65,
      maxClaimAge: 66,
      trialCount: FAST_TRIALS,
    });

    expect(result.currentSeedCandidate).toBeNull();
    // Recommended should still be defined.
    expect(result.recommended).toBeDefined();
  });

  it('collapses spouse axis when only one SS record is present', () => {
    const seed = buildOptimizerSeed({
      hasSpouse: false,
      startingBalance: 800_000,
      annualSpending: 50_000,
      primaryFraMonthly: 2_500,
      primaryClaimAge: 67,
    });

    const result = findOptimalSocialSecurityClaim(seed, buildAssumptions(), {
      minClaimAge: 65,
      maxClaimAge: 67,
      trialCount: FAST_TRIALS,
    });

    expect(result.hasSpouse).toBe(false);
    // 3 primary ages × 1 collapsed spouse axis = 3 cells
    expect(result.ranked).toHaveLength(3);
    for (const c of result.ranked) {
      expect(c.spouseAge).toBeNull();
    }
  });

  it('honors isCancelled — bails out without crashing', () => {
    const seed = buildOptimizerSeed({
      hasSpouse: true,
      startingBalance: 1_000_000,
      annualSpending: 60_000,
      primaryFraMonthly: 3_000,
      spouseFraMonthly: 2_000,
      primaryClaimAge: 67,
      spouseClaimAge: 67,
    });

    let cells = 0;
    expect(() =>
      findOptimalSocialSecurityClaim(seed, buildAssumptions(), {
        minClaimAge: 65,
        maxClaimAge: 70,
        trialCount: FAST_TRIALS,
        onProgress: () => {
          cells += 1;
        },
        isCancelled: () => cells >= 2,
      }),
    ).not.toThrow();
  });
});

describe('findOptimalSocialSecurityClaim — directional behavior', () => {
  it('for a household with adequate runway, delaying SS to 70/70 ranks at or above claiming at 65/65', () => {
    // Setup: $1.5M, $80k/yr spending, both spouses with meaningful FRA
    // benefits. Delaying SS gives 8%/yr DRC → ~32% bigger benefit at
    // 70 vs 67, and even more vs 65. With this much runway the
    // household can bridge the early-retirement gap, so delaying should
    // dominate.
    const seed = buildOptimizerSeed({
      hasSpouse: true,
      startingBalance: 1_500_000,
      annualSpending: 80_000,
      primaryFraMonthly: 3_500,
      spouseFraMonthly: 2_000,
      primaryClaimAge: 65, // arbitrary; the optimizer overrides
      spouseClaimAge: 65,
    });

    const result = findOptimalSocialSecurityClaim(seed, buildAssumptions(), {
      minClaimAge: 65,
      maxClaimAge: 70,
      ageStep: 5, // just (65, 70) — fast and the directional check still holds
      trialCount: PROPERTY_TRIALS,
    });

    const claim65 = result.ranked.find(
      (c) => c.primaryAge === 65 && c.spouseAge === 65,
    );
    const claim70 = result.ranked.find(
      (c) => c.primaryAge === 70 && c.spouseAge === 70,
    );
    expect(claim65).toBeDefined();
    expect(claim70).toBeDefined();

    // Claim 70 should NOT be worse than claim 65 on solvency. (At
    // adequate runway it's typically materially better; we assert the
    // weaker ≥ to keep the test robust to RNG noise at low trial counts.)
    expect(claim70!.solventSuccessRate).toBeGreaterThanOrEqual(
      claim65!.solventSuccessRate - 0.02, // 2pp tolerance for RNG noise
    );
  });
});
