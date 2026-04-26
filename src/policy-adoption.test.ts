import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { Policy } from './policy-miner-types';
import {
  buildAdoptedSeedData,
  diffAdoption,
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
    // Allow $4 of rounding slop ($1 per category from Math.round).
    expect(Math.abs(newTotal - 130_000)).toBeLessThanOrEqual(4);
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

  it('sets the Roth ceiling fields exactly the way the miner did', () => {
    const adopted = buildAdoptedSeedData(
      initialSeedData,
      makePolicy({ rothConversionAnnualCeiling: 40_000 }),
    );
    expect(adopted.rules?.rothConversionPolicy?.enabled).toBe(true);
    expect(adopted.rules?.rothConversionPolicy?.minAnnualDollars).toBe(0);
    expect(adopted.rules?.rothConversionPolicy?.magiBufferDollars).toBe(40_000);
  });

  it('disables Roth conversion when the ceiling is 0', () => {
    const adopted = buildAdoptedSeedData(
      initialSeedData,
      makePolicy({ rothConversionAnnualCeiling: 0 }),
    );
    expect(adopted.rules?.rothConversionPolicy?.enabled).toBe(false);
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
    expect(Math.abs(monthly + annual - 130_000)).toBeLessThanOrEqual(4);
  });
});
