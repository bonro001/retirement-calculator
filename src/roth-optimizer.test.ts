import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { getDefaultVerificationAssumptions } from './verification-harness';
import { findOptimalRothCeiling } from './roth-optimizer';

/**
 * Tests for `findOptimalRothCeiling`.
 *
 * Mirrors the SS / spend optimizer test shape: synthetic seed, low
 * trial counts, narrow ceiling list. Validates the contract:
 *
 *   1. Returns one candidate per ceiling level
 *   2. recommended === ranked[0]
 *   3. Candidates are tagged with meetsNorthStars + bindingConstraint
 *   4. feasibleCount counts the constraint-satisfying ones
 */

const FAST_TRIALS = 50;

function buildRothSeed(opts: {
  pretaxBalance: number;
  rothBalance: number;
}): SeedData {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));

  // Mix of pretax + roth + taxable so Roth-conversion mechanics have
  // something to operate on.
  seed.accounts.pretax.balance = opts.pretaxBalance;
  seed.accounts.roth.balance = opts.rothBalance;
  seed.accounts.taxable.balance = 100_000;
  seed.accounts.cash.balance = 50_000;
  seed.accounts.hsa.balance = 0;
  seed.accounts.pretax.targetAllocation = { VTI: 0.6, BND: 0.4 };
  seed.accounts.roth.targetAllocation = { VTI: 0.7, BND: 0.3 };
  seed.accounts.taxable.targetAllocation = { VTI: 0.6, BND: 0.4 };

  // Modest spending so Roth conversion has bracket headroom.
  seed.spending.essentialMonthly = 4_000;
  seed.spending.optionalMonthly = 0;
  seed.spending.travelEarlyRetirementAnnual = 0;
  seed.spending.annualTaxesInsurance = 0;

  // Already retired — ensure salary is off.
  seed.income.salaryAnnual = 0;
  seed.income.salaryEndDate = '2025-01-01';
  seed.income.windfalls = [];
  seed.income.socialSecurity = [
    { person: 'rob', fraMonthly: 3_000, claimAge: 70 },
    { person: 'debbie', fraMonthly: 2_000, claimAge: 70 },
  ];

  // Disable feature noise.
  seed.rules.ltcAssumptions.eventProbability = 0;
  seed.rules.ltcAssumptions.annualCostToday = 0;
  seed.rules.healthcarePremiums.baselineAcaPremiumAnnual = 0;
  seed.rules.healthcarePremiums.baselineMedicarePremiumAnnual = 0;
  seed.rules.hsaStrategy.enabled = false;

  // Birthdates: 65 today.
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

describe('findOptimalRothCeiling — contract', () => {
  it('returns one candidate per ceiling level', () => {
    const seed = buildRothSeed({
      pretaxBalance: 800_000,
      rothBalance: 200_000,
    });
    const result = findOptimalRothCeiling(seed, buildAssumptions(), 60_000, {
      ceilingLevels: [0, 40_000, 80_000],
      trialCount: FAST_TRIALS,
      legacyTargetTodayDollars: 0,
    });
    expect(result.ranked).toHaveLength(3);
    expect(result.recommended).toBe(result.ranked[0]);
    expect(result.trialCount).toBe(FAST_TRIALS);
  });

  it('tags each candidate with meetsNorthStars + bindingConstraint', () => {
    const seed = buildRothSeed({
      pretaxBalance: 800_000,
      rothBalance: 200_000,
    });
    const result = findOptimalRothCeiling(seed, buildAssumptions(), 60_000, {
      ceilingLevels: [0, 40_000],
      trialCount: FAST_TRIALS,
      legacyTargetTodayDollars: 100_000,
      targetLegacyAttainmentRate: 0.5,
    });
    for (const c of result.ranked) {
      expect(typeof c.meetsNorthStars).toBe('boolean');
      if (c.meetsNorthStars) {
        expect(c.bindingConstraint).toBeNull();
      } else {
        expect(['solvency', 'legacy', 'both']).toContain(c.bindingConstraint);
      }
    }
    expect(result.feasibleCount).toBe(
      result.ranked.filter((c) => c.meetsNorthStars).length,
    );
  });

  it('honors isCancelled — bails out without crashing', () => {
    const seed = buildRothSeed({
      pretaxBalance: 800_000,
      rothBalance: 200_000,
    });
    let calls = 0;
    expect(() =>
      findOptimalRothCeiling(seed, buildAssumptions(), 60_000, {
        ceilingLevels: [0, 40_000, 80_000, 120_000],
        trialCount: FAST_TRIALS,
        onProgress: () => {
          calls += 1;
        },
        isCancelled: () => calls >= 2,
      }),
    ).not.toThrow();
  });
});

describe('findOptimalRothCeiling — directional behavior', () => {
  it('with a meaningful pretax balance, the highest ceiling tends to rank well on legacy', () => {
    // Setup: $1M pretax, modest spending → bracket headroom for big
    // conversions. Higher ceiling should grow tax-free Roth and lift
    // p50 EW (legacy) — the ranked top should NOT be ceiling=0.
    const seed = buildRothSeed({
      pretaxBalance: 1_000_000,
      rothBalance: 100_000,
    });
    const result = findOptimalRothCeiling(seed, buildAssumptions(), 60_000, {
      ceilingLevels: [0, 80_000, 160_000],
      trialCount: 200,
      legacyTargetTodayDollars: 0, // rank purely on EW
    });
    // Sanity: at zero legacy target, every candidate is "feasible"
    // (legacy constraint is dropped). So ranking is purely p50 EW.
    expect(result.feasibleCount).toBeGreaterThanOrEqual(1);
    // Pretax conversion should help legacy materially. Recommended
    // should NOT be ceiling=0 (the no-conversion baseline).
    // (If RNG noise at low trials makes them tied within 1%, this
    // could flap; the 200-trial bump keeps it deterministic enough.)
    expect(result.recommended.ceilingTodayDollars).toBeGreaterThan(0);
  });
});
