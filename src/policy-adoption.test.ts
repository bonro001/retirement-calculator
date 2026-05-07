import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { Policy } from './policy-miner-types';
import type { SeedData } from './types';
import {
  adoptedSeedMatchesPolicy,
  buildAdoptedSeedData,
  diffAdoption,
  explainAdoption,
  totalAnnualSpendFromCategories,
} from './policy-adoption';

/**
 * E.2 — adoption math. The user-facing claim is "adopting this policy
 * makes your plan run at $X/yr spend, claim SS at A/B, convert Roth
 * up to $C/yr". If the spending scaler is wrong by 5%, the user
 * adopts a $130k policy and silently runs the simulation at $123k or
 * $137k — a hard-to-debug discrepancy. These tests pin the math.
 */

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'pol_test',
    annualSpendTodayDollars: 130_000,
    primarySocialSecurityClaimAge: 70,
    spouseSocialSecurityClaimAge: 68,
    rothConversionAnnualCeiling: 40_000,
    ...overrides,
  } as Policy;
}

describe('buildAdoptedSeedData', () => {
  it('scales the four spending categories proportionally to hit the policy target', () => {
    const policy = makePolicy({ annualSpendTodayDollars: 130_000 });
    const adopted = buildAdoptedSeedData(initialSeedData, policy);
    const newTotal = totalAnnualSpendFromCategories(adopted.spending);
    expect(Math.abs(newTotal - 130_000)).toBeLessThanOrEqual(0.01);
  });

  it('reconciles monthly rounding drift back to the exact annual target', () => {
    const seed: SeedData = {
      ...initialSeedData,
      spending: {
        ...initialSeedData.spending,
        essentialMonthly: 4_333,
        optionalMonthly: 2_777,
        annualTaxesInsurance: 8_888,
        travelEarlyRetirementAnnual: 6_666,
      },
    };
    const policy = makePolicy({ annualSpendTodayDollars: 110_000 });
    const adopted = buildAdoptedSeedData(seed, policy);
    const newTotal = totalAnnualSpendFromCategories(adopted.spending);
    expect(Math.abs(newTotal - 110_000)).toBeLessThanOrEqual(0.01);
  });

  it('preserves the relative split between categories', () => {
    const policy = makePolicy({ annualSpendTodayDollars: 100_000 });
    const baselineTotal = totalAnnualSpendFromCategories(
      initialSeedData.spending,
    );
    const adopted = buildAdoptedSeedData(initialSeedData, policy);
    // Each category's share of the new total should match its share of
    // the old total within 0.5 percentage points (rounding tolerance).
    const oldShare =
      (initialSeedData.spending.essentialMonthly * 12) / baselineTotal;
    const newShare =
      (adopted.spending.essentialMonthly * 12) / 100_000;
    expect(Math.abs(oldShare - newShare)).toBeLessThan(0.005);
  });

  it('does not mutate the input seed', () => {
    const before = JSON.stringify(initialSeedData.spending);
    buildAdoptedSeedData(initialSeedData, makePolicy());
    expect(JSON.stringify(initialSeedData.spending)).toBe(before);
  });

  it('writes the primary SS claim age', () => {
    const adopted = buildAdoptedSeedData(
      initialSeedData,
      makePolicy({ primarySocialSecurityClaimAge: 70 }),
    );
    expect(adopted.income.socialSecurity[0]?.claimAge).toBe(70);
  });

  it('writes the spouse SS claim age when the household has a spouse', () => {
    if ((initialSeedData.income.socialSecurity?.length ?? 0) < 2) return;
    const adopted = buildAdoptedSeedData(
      initialSeedData,
      makePolicy({ spouseSocialSecurityClaimAge: 68 }),
    );
    expect(adopted.income.socialSecurity[1]?.claimAge).toBe(68);
  });

  it('sets the Roth max fields exactly the way the miner did', () => {
    const adopted = buildAdoptedSeedData(
      initialSeedData,
      makePolicy({ rothConversionAnnualCeiling: 40_000 }),
    );
    expect(adopted.rules?.rothConversionPolicy?.enabled).toBe(true);
    expect(adopted.rules?.rothConversionPolicy?.minAnnualDollars).toBe(0);
    expect(adopted.rules?.rothConversionPolicy?.maxAnnualDollars).toBe(40_000);
    expect(adopted.rules?.rothConversionPolicy?.magiBufferDollars).toBe(2_000);
  });

  it('disables Roth conversion when the ceiling is 0', () => {
    const adopted = buildAdoptedSeedData(
      initialSeedData,
      makePolicy({ rothConversionAnnualCeiling: 0 }),
    );
    expect(adopted.rules?.rothConversionPolicy?.enabled).toBe(false);
  });

  it('recognizes when the current seed is exactly the adopted mined policy', () => {
    const policy = makePolicy({ annualSpendTodayDollars: 118_000 });
    const adopted = buildAdoptedSeedData(initialSeedData, policy);
    expect(adoptedSeedMatchesPolicy(adopted, initialSeedData, policy)).toBe(true);
  });

  it('does not treat later non-adoption edits as current mined policy state', () => {
    const policy = makePolicy({ annualSpendTodayDollars: 118_000 });
    const adopted = buildAdoptedSeedData(initialSeedData, policy);
    const edited: SeedData = {
      ...adopted,
      goals: {
        ...adopted.goals,
        legacyTargetTodayDollars:
          (adopted.goals?.legacyTargetTodayDollars ?? 1_000_000) + 50_000,
      },
    };
    expect(adoptedSeedMatchesPolicy(edited, initialSeedData, policy)).toBe(false);
  });
});

describe('diffAdoption', () => {
  it('flags the spend row as changed when the target differs from current', () => {
    const diff = diffAdoption(
      initialSeedData,
      makePolicy({ annualSpendTodayDollars: 130_000 }),
    );
    const spendRow = diff.rows.find((r) => r.key === 'spend');
    expect(spendRow?.changed).toBe(true);
  });

  it('marks the spend row unchanged when the target equals current', () => {
    const currentTotal = totalAnnualSpendFromCategories(
      initialSeedData.spending,
    );
    const diff = diffAdoption(
      initialSeedData,
      makePolicy({ annualSpendTodayDollars: currentTotal }),
    );
    const spendRow = diff.rows.find((r) => r.key === 'spend');
    expect(spendRow?.changed).toBe(false);
  });

  it('produces a one-line summary suitable for the undo banner', () => {
    const diff = diffAdoption(initialSeedData, makePolicy());
    expect(diff.summary).toContain('SS 70');
    expect(diff.summary).toContain('Roth');
  });

  it('breakdown sums match the new annual target within rounding tolerance', () => {
    const diff = diffAdoption(
      initialSeedData,
      makePolicy({ annualSpendTodayDollars: 130_000 }),
    );
    const monthly = diff.spendingBreakdown
      .filter((b) => b.unit === '$/mo')
      .reduce((s, b) => s + b.proposed * 12, 0);
    const annual = diff.spendingBreakdown
      .filter((b) => b.unit === '$/yr')
      .reduce((s, b) => s + b.proposed, 0);
    expect(Math.abs(monthly + annual - 130_000)).toBeLessThanOrEqual(0.01);
  });
});

// ---------------------------------------------------------------------------
// explainAdoption — plain-English narrative for the post-adoption banner
// ---------------------------------------------------------------------------

/**
 * Build a seed with explicit current SS ages and Roth ceiling so the
 * lever-comparison logic is testable without depending on whatever
 * `initialSeedData` happens to ship with.
 */
function seedWith(opts: {
  primarySsAge?: number;
  spouseSsAge?: number | null;
  rothCeiling?: number;
}): SeedData {
  const seed = JSON.parse(JSON.stringify(initialSeedData)) as SeedData;
  if (opts.primarySsAge !== undefined && seed.income.socialSecurity[0]) {
    seed.income.socialSecurity[0].claimAge = opts.primarySsAge;
  }
  if (opts.spouseSsAge !== undefined && seed.income.socialSecurity[1]) {
    seed.income.socialSecurity[1].claimAge = opts.spouseSsAge ?? 0;
  }
  if (opts.rothCeiling !== undefined) {
    seed.rules = seed.rules ?? {};
    seed.rules.rothConversionPolicy = {
      ...(seed.rules.rothConversionPolicy ?? {}),
      enabled: opts.rothCeiling > 0,
      minAnnualDollars: 0,
      maxAnnualDollars: opts.rothCeiling,
      magiBufferDollars: 2_000,
    };
  }
  return seed;
}

describe('explainAdoption', () => {
  it('headline reports the spend lift in absolute and delta terms', () => {
    const seed = seedWith({ primarySsAge: 67, spouseSsAge: 67, rothCeiling: 0 });
    const before = totalAnnualSpendFromCategories(seed.spending);
    const result = explainAdoption(
      seed,
      makePolicy({
        annualSpendTodayDollars: before + 12_000,
        primarySocialSecurityClaimAge: 67,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 0,
      }),
    );
    expect(result.headline.toLowerCase()).toMatch(/lift|raise/);
    expect(result.headline).toContain('+');
  });

  it('headline trims spend down when the policy lowers it', () => {
    const seed = seedWith({ primarySsAge: 67, spouseSsAge: 67, rothCeiling: 0 });
    const before = totalAnnualSpendFromCategories(seed.spending);
    const result = explainAdoption(
      seed,
      makePolicy({
        annualSpendTodayDollars: before - 8_000,
        primarySocialSecurityClaimAge: 67,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 0,
      }),
    );
    expect(result.headline.toLowerCase()).toMatch(/trim|restore/);
  });

  it('headline holds spend constant when the delta is within rounding', () => {
    const seed = seedWith({ primarySsAge: 67, spouseSsAge: 67, rothCeiling: 0 });
    const before = totalAnnualSpendFromCategories(seed.spending);
    const result = explainAdoption(
      seed,
      makePolicy({
        annualSpendTodayDollars: before, // identical
        primarySocialSecurityClaimAge: 70, // structural change
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 0,
      }),
    );
    expect(result.headline.toLowerCase()).toMatch(/hold/);
  });

  it('picks SS delay over Roth when both change', () => {
    const seed = seedWith({
      primarySsAge: 67,
      spouseSsAge: 67,
      rothCeiling: 0,
    });
    const result = explainAdoption(
      seed,
      makePolicy({
        primarySocialSecurityClaimAge: 70, // 3-year delay × 8 = 24
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 20_000, // 20000/1250 = 16
      }),
    );
    expect(result.detail).toContain('Social Security');
    expect(result.detail).toContain('70');
  });

  it('frames an SS-pulled-forward change as filing earlier, not delaying', () => {
    const seed = seedWith({ primarySsAge: 70, spouseSsAge: 67, rothCeiling: 0 });
    const result = explainAdoption(
      seed,
      makePolicy({
        primarySocialSecurityClaimAge: 65,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 0,
      }),
    );
    expect(result.detail?.toLowerCase()).toContain('earlier');
  });

  it('points to the Roth lever when SS is unchanged but the ceiling shifts', () => {
    const seed = seedWith({ primarySsAge: 67, spouseSsAge: 67, rothCeiling: 10_000 });
    const result = explainAdoption(
      seed,
      makePolicy({
        primarySocialSecurityClaimAge: 67, // unchanged
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 80_000,
      }),
    );
    expect(result.detail?.toLowerCase()).toContain('roth');
    expect(result.detail).toContain('80');
  });

  it('frames a lowered Roth ceiling as MAGI/IRMAA protection', () => {
    const seed = seedWith({ primarySsAge: 67, spouseSsAge: 67, rothCeiling: 80_000 });
    const result = explainAdoption(
      seed,
      makePolicy({
        primarySocialSecurityClaimAge: 67,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 20_000,
      }),
    );
    expect(result.detail?.toLowerCase()).toContain('irmaa');
  });

  it('returns a null detail when no structural lever changed', () => {
    const seed = seedWith({ primarySsAge: 67, spouseSsAge: 67, rothCeiling: 30_000 });
    const before = totalAnnualSpendFromCategories(seed.spending);
    const result = explainAdoption(
      seed,
      makePolicy({
        annualSpendTodayDollars: before + 5_000,
        primarySocialSecurityClaimAge: 67,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 30_000,
      }),
    );
    expect(result.detail).toBeNull();
  });

  it('ignores trivial Roth ceiling jitter (< $5k) so it does not steal the headline', () => {
    const seed = seedWith({ primarySsAge: 67, spouseSsAge: 67, rothCeiling: 30_000 });
    const result = explainAdoption(
      seed,
      makePolicy({
        primarySocialSecurityClaimAge: 67,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 32_000, // $2k change
      }),
    );
    expect(result.detail).toBeNull();
  });

  it('attaches a comfortable-headroom feasibility note above 95%', () => {
    const seed = seedWith({});
    const result = explainAdoption(seed, makePolicy(), {
      bequestAttainmentRate: 0.97,
    });
    expect(result.feasibilityNote).toContain('97%');
    expect(result.feasibilityNote?.toLowerCase()).toContain('headroom');
  });

  it('attaches an edge-of-feasibility note below 85%', () => {
    const seed = seedWith({});
    const result = explainAdoption(seed, makePolicy(), {
      bequestAttainmentRate: 0.78,
    });
    expect(result.feasibilityNote?.toLowerCase()).toContain('edge');
  });

  it('omits the feasibility note when no evaluation is supplied', () => {
    const seed = seedWith({});
    const result = explainAdoption(seed, makePolicy());
    expect(result.feasibilityNote).toBeNull();
  });
});
