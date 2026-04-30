/**
 * Audit: does the engine correctly model the "Debbie claims at 67,
 * steps up to spousal when Rob files at 70" strategy?
 *
 * Setup mirrors the household (Rob FRA $4,100, Debbie FRA $1,444):
 *   - Strategy A: Debbie 67, Rob 70
 *     - Debbie 67-69: own benefit only ($1,444) since Rob hasn't filed
 *     - Debbie 70+: Rob filed → spousal step-up to max($1,444, 0.5 ×
 *       $4,100 = $2,050) = $2,050
 *   - Strategy B: Debbie 70, Rob 70
 *     - Debbie 67-69: zero (hasn't filed)
 *     - Debbie 70+: own at 70 with DRC ($1,444 × 1.24 = $1,791),
 *       spousal $2,050 → max = $2,050
 *
 * Strategy A lifetime SS for Debbie should be ~$52k MORE than B
 * over ages 67-92 (3 years × $1,444/mo × 12 = $51,984).
 */

import { describe, it, expect } from 'vitest';
import {
  projectAnnualSocialSecurityIncome,
  type SocialSecurityEarner,
} from './social-security';

const ROB_BIRTH_YEAR = 1962; // makes Rob 67 in 2029
const DEBBIE_BIRTH_YEAR = 1962;
const DEATH_AGE = 92;

function rob(claimAge: number): SocialSecurityEarner {
  return {
    person: 'rob',
    fraMonthly: 4100,
    claimAge,
    birthYear: ROB_BIRTH_YEAR,
    assumedDeathAge: DEATH_AGE,
  };
}
function debbie(claimAge: number): SocialSecurityEarner {
  return {
    person: 'debbie',
    fraMonthly: 1444,
    claimAge,
    birthYear: DEBBIE_BIRTH_YEAR,
    assumedDeathAge: DEATH_AGE,
  };
}

const startYear = 2027; // Rob age 65
const endYear = 2054;   // Rob age 92

describe('SS spousal step-up audit', () => {
  it('Strategy A (Debbie 67, Rob 70): own-only 67-69, spousal step-up at 70+', () => {
    const a = projectAnnualSocialSecurityIncome(
      rob(70),
      debbie(67),
      startYear,
      endYear,
    );
    // Year Rob is 67 = 2029, Debbie also 67 = 2029.
    const debbie67 = a.find((row) => row.year === 2029);
    expect(debbie67).toBeTruthy();
    // Debbie filed (67 ≥ 67), Rob hasn't (67 < 70). Debbie should
    // receive own benefit of $1,444/mo, no spousal floor.
    expect(debbie67!.perEarnerMonthly.debbie).toBeCloseTo(1444, 0);
    // Rob hasn't filed yet; he should get $0.
    expect(debbie67!.perEarnerMonthly.rob).toBe(0);

    // Year Rob is 70 = 2032, Debbie also 70.
    const both70 = a.find((row) => row.year === 2032);
    expect(both70).toBeTruthy();
    // Rob filed at 70 → his own benefit with 24% DRC = $4,100 × 1.24 = $5,084
    expect(both70!.perEarnerMonthly.rob).toBeCloseTo(5084, 0);
    // Debbie's own ($1,444) is now floored by 0.5 × $4,100 = $2,050.
    expect(both70!.perEarnerMonthly.debbie).toBeCloseTo(2050, 0);
  });

  it('Strategy B (Debbie 70, Rob 70): both zero until 70, both step up together', () => {
    const b = projectAnnualSocialSecurityIncome(
      rob(70),
      debbie(70),
      startYear,
      endYear,
    );
    const at67 = b.find((row) => row.year === 2029); // both 67
    expect(at67!.perEarnerMonthly.debbie).toBe(0);
    expect(at67!.perEarnerMonthly.rob).toBe(0);

    const at70 = b.find((row) => row.year === 2032);
    expect(at70).toBeTruthy();
    // Rob: $4,100 × 1.24 = $5,084
    expect(at70!.perEarnerMonthly.rob).toBeCloseTo(5084, 0);
    // Debbie own at 70 = $1,444 × 1.24 = $1,790.56; spousal floor $2,050
    // → step up to $2,050.
    expect(at70!.perEarnerMonthly.debbie).toBeCloseTo(2050, 0);
  });

  it('Strategy A lifetime household SS exceeds Strategy B by ~$52k over 67-92', () => {
    const a = projectAnnualSocialSecurityIncome(
      rob(70),
      debbie(67),
      startYear,
      endYear,
    );
    const b = projectAnnualSocialSecurityIncome(
      rob(70),
      debbie(70),
      startYear,
      endYear,
    );
    const sumA = a.reduce((acc, row) => acc + row.householdAnnual, 0);
    const sumB = b.reduce((acc, row) => acc + row.householdAnnual, 0);
    const delta = sumA - sumB;
    // 3 years × $1,444 × 12 = $51,984. Allow $1k slack for any
    // rounding/timing edge cases.
    expect(delta).toBeGreaterThan(50_000);
    expect(delta).toBeLessThan(53_000);
  });
});
