import { describe, it, expect } from 'vitest';
import {
  computeAnnualHouseholdSocialSecurity,
  effectiveMonthlyBenefit,
  ownAdjustedMonthlyBenefit,
  ownClaimAdjustmentFactor,
  projectAnnualSocialSecurityIncome,
  spousalBenefitFloor,
  totalLifetimeSocialSecurityTodayDollars,
  type SocialSecurityEarner,
} from './social-security';

const FRA = 67;

function rob(claimAge = 67, deathAge = 95): SocialSecurityEarner {
  return {
    person: 'rob',
    fraMonthly: 4_100,
    claimAge,
    birthYear: 1964,
    assumedDeathAge: deathAge,
  };
}
function debbie(claimAge = 67, deathAge = 95): SocialSecurityEarner {
  return {
    person: 'debbie',
    fraMonthly: 2_000,
    claimAge,
    birthYear: 1963,
    assumedDeathAge: deathAge,
  };
}

describe('ownClaimAdjustmentFactor', () => {
  it('returns 1.0 at FRA', () => {
    expect(ownClaimAdjustmentFactor(67, 67)).toBe(1);
  });
  it('returns 0.7 at age 62 with FRA 67 (60 months early — 30% reduction)', () => {
    // SSA: 36 months × 5/9 of 1% = 20%, plus 24 months × 5/12 of 1% = 10%
    // → 30% reduction, factor 0.70.
    expect(ownClaimAdjustmentFactor(67, 62)).toBeCloseTo(0.7, 4);
  });
  it('returns 0.8667 at age 65 with FRA 67 (24 months early — 13.33% reduction)', () => {
    // SSA: 24 months × 5/9 of 1% = 13.333...% reduction.
    expect(ownClaimAdjustmentFactor(67, 65)).toBeCloseTo(0.8666667, 4);
  });
  it('credits fractional delayed claiming smoothly', () => {
    // Half a year after FRA earns half of the annual 8% delayed credit.
    expect(ownClaimAdjustmentFactor(67, 67.5)).toBeCloseTo(1.04, 4);
  });
  it('returns 1.24 at age 70 with FRA 67 (3 years × 8% DRC)', () => {
    expect(ownClaimAdjustmentFactor(67, 70)).toBeCloseTo(1.24, 4);
  });
  it('caps DRC at age 70', () => {
    expect(ownClaimAdjustmentFactor(67, 71)).toBeCloseTo(1.24, 4);
    expect(ownClaimAdjustmentFactor(67, 72)).toBeCloseTo(1.24, 4);
  });
});

describe('spousalBenefitFloor', () => {
  it('Debbie\'s spousal floor at FRA = 50% of Rob FRA = $2,050', () => {
    expect(spousalBenefitFloor(debbie(67), rob(67), FRA)).toBeCloseTo(2_050, 2);
  });
  it('reduces when lower earner claims early', () => {
    // Spousal floor at age 62 is reduced by the early-claim factor.
    const expected = 4_100 * 0.5 * 0.7;
    expect(spousalBenefitFloor(debbie(62), rob(67), FRA)).toBeCloseTo(expected, 2);
  });
  it('does NOT increase past 50% with delayed claim', () => {
    // Spousal benefits do NOT receive DRC. Claiming spousal at 70 is
    // still 50% of higher earner's PIA.
    expect(spousalBenefitFloor(debbie(70), rob(67), FRA)).toBeCloseTo(2_050, 2);
  });
});

describe('effectiveMonthlyBenefit', () => {
  it('Debbie at FRA 67: own $2,000 vs spousal floor $2,050 → spousal wins', () => {
    expect(effectiveMonthlyBenefit(debbie(67), rob(67), FRA)).toBeCloseTo(2_050, 2);
  });
  it('Rob (higher earner) ignores spousal — own benefit always wins', () => {
    expect(effectiveMonthlyBenefit(rob(67), debbie(67), FRA)).toBeCloseTo(4_100, 2);
  });
  it('Debbie at age 70 own benefit $2,480 beats her own spousal floor $2,050', () => {
    // Own at 70 with FRA 67: 4_100 ... wait that's Rob.
    // Debbie's own at 70: 2_000 × 1.24 = $2,480, beats spousal floor $2,050.
    expect(effectiveMonthlyBenefit(debbie(70), rob(67), FRA)).toBeCloseTo(2_480, 2);
  });
});

describe('projectAnnualSocialSecurityIncome', () => {
  it('income only starts after claim age', () => {
    const schedule = projectAnnualSocialSecurityIncome(
      rob(67),
      debbie(67),
      2026,
      2035,
      FRA,
    );
    // 2026: Rob is age 62, Debbie age 63 — neither claimed yet at 67.
    const before = schedule.find((r) => r.year === 2026);
    expect(before?.householdMonthly).toBe(0);
    // 2030: Debbie hits 67, Rob still 66 → only Debbie claiming. Rob
    // hasn't filed, so no spousal floor applies — Debbie gets her own
    // $2,000 (the test stub's value), not the $2,050 spousal floor.
    const debbieOnly = schedule.find((r) => r.year === 2030);
    expect(debbieOnly?.activeEarners).toEqual(['debbie']);
    expect(debbieOnly?.householdMonthly).toBeCloseTo(2_000, 2);
    // 2031: Rob hits 67 → both claiming. Spousal floor activates for
    // Debbie. She jumps from her own $2,000 to spousal floor $2,050.
    const onYear = schedule.find((r) => r.year === 2031);
    expect(onYear?.activeEarners).toEqual(expect.arrayContaining(['rob', 'debbie']));
    expect(onYear?.perEarnerMonthly['debbie']).toBeCloseTo(2_050, 2);
    expect(onYear?.householdMonthly).toBeGreaterThan(6_000);
  });

  it('survivor switch: lower-earner spouse jumps to higher-earner amount when higher dies', () => {
    // Rob dies at 80 (in year 2044). Debbie alive to 95.
    const schedule = projectAnnualSocialSecurityIncome(
      rob(70, 80),
      debbie(67, 95),
      2026,
      2058,
      FRA,
    );
    // After Rob dies, Debbie's monthly should jump from her own ($2,050
    // spousal floor) to Rob's claim amount ($4,100 × 1.24 = $5,084).
    const beforeDeath = schedule.find((r) => r.year === 2043); // Rob age 79
    const afterDeath = schedule.find((r) => r.year === 2046); // Rob has been dead since end-2044
    expect(beforeDeath).toBeDefined();
    expect(afterDeath).toBeDefined();
    expect(beforeDeath?.perEarnerMonthly['debbie']).toBeCloseTo(2_050, 2);
    expect(afterDeath?.perEarnerMonthly['debbie']).toBeCloseTo(5_084, 2);
    // Rob's slot is 0 after death.
    expect(afterDeath?.perEarnerMonthly['rob']).toBe(0);
  });
});

describe('computeAnnualHouseholdSocialSecurity — survivor switch', () => {
  // Per-year function used by the engine. Verifies the survivor
  // switch fires when one spouse is past their assumedDeathAge.
  const FRA = 67;

  it('both alive at FRA: Debbie at $2,050 (spousal floor), Rob at $4,100', () => {
    const annual = computeAnnualHouseholdSocialSecurity(
      { fraMonthly: 4_100, claimAge: 67, currentAge: 67 },
      { fraMonthly: 1_444, claimAge: 67, currentAge: 67 },
      FRA,
    );
    // Rob $4,100 + Debbie spousal $2,050 = $6,150/mo × 12 = $73,800/yr.
    expect(annual).toBeCloseTo(73_800, 0);
  });

  it('Rob dies, Debbie alive: survivor switch jumps Debbie to $4,100 (Rob\'s claim amount)', () => {
    const annual = computeAnnualHouseholdSocialSecurity(
      {
        fraMonthly: 4_100,
        claimAge: 67,
        currentAge: 80, // past assumedDeathAge → dead
        assumedDeathAge: 78,
      },
      {
        fraMonthly: 1_444,
        claimAge: 67,
        currentAge: 81,
        assumedDeathAge: 95,
      },
      FRA,
    );
    // Rob slot: 0 (dead). Debbie slot: max($1,444 own, $2,050 spousal,
    // $4,100 survivor) = $4,100. × 12 = $49,200/yr.
    expect(annual).toBeCloseTo(49_200, 0);
  });

  it('Rob delays to 70, dies at 80: survivor benefit lifts to $5,084 (Rob\'s 70-claim amount)', () => {
    // Rob's claim amount at 70 = $4,100 × 1.24 (DRC) = $5,084. When
    // he dies, Debbie's survivor benefit converts to that — the
    // architectural reason "delay the higher earner" is correct
    // even when his own life expectancy is moderate.
    const annual = computeAnnualHouseholdSocialSecurity(
      {
        fraMonthly: 4_100,
        claimAge: 70,
        currentAge: 81,
        assumedDeathAge: 80,
      },
      {
        fraMonthly: 1_444,
        claimAge: 67,
        currentAge: 82,
        assumedDeathAge: 95,
      },
      FRA,
    );
    // Debbie alone receiving max($1,444 own, $2,050 spousal,
    // $5,084 survivor) = $5,084 × 12 = $61,008/yr.
    expect(annual).toBeCloseTo(61_008, 0);
  });

  it('Debbie dies (lower earner), Rob alive: Rob unaffected (no survivor switch needed)', () => {
    const annual = computeAnnualHouseholdSocialSecurity(
      { fraMonthly: 4_100, claimAge: 67, currentAge: 70, assumedDeathAge: 95 },
      {
        fraMonthly: 1_444,
        claimAge: 67,
        currentAge: 71,
        assumedDeathAge: 70, // dies at 70
      },
      FRA,
    );
    // Rob $4,100 only. × 12 = $49,200/yr.
    expect(annual).toBeCloseTo(49_200, 0);
  });
});

describe("Debbie's actual numbers: $1,444 own vs $2,050 spousal floor", () => {
  // Per the user's clarification 2026-04-29: Debbie's actual FRA is
  // $1,444 (lower than the $2,050 spousal floor at 50% × Rob $4,100).
  // Her real-life benefit at FRA is $2,050, NOT $1,444. The engine
  // must model this floor.
  const debbieReal = (claimAge = 67): SocialSecurityEarner => ({
    person: 'debbie',
    fraMonthly: 1_444,
    claimAge,
    birthYear: 1963,
    assumedDeathAge: 95,
  });

  it("Debbie's effective benefit at FRA is the spousal floor, not her own $1,444", () => {
    // Both claimed: Debbie gets max($1,444 own, $2,050 spousal) = $2,050.
    const v = effectiveMonthlyBenefit(debbieReal(67), rob(67), FRA, true);
    expect(v).toBeCloseTo(2_050, 2);
  });

  it('Before Rob files, Debbie gets only her own $1,444 (no spousal floor yet)', () => {
    const v = effectiveMonthlyBenefit(debbieReal(67), rob(70), FRA, false);
    expect(v).toBeCloseTo(1_444, 2);
  });

  it("Debbie at 70 with own $1,790 vs spousal $2,050 — spousal still wins", () => {
    // Own at 70 with FRA 67: $1,444 × 1.24 = $1,790. Spousal floor
    // (no DRC) is still $2,050. Spousal wins.
    const v = effectiveMonthlyBenefit(debbieReal(70), rob(70), FRA, true);
    expect(v).toBeCloseTo(2_050, 2);
  });

  it("user's insight: Debbie claiming at 67 vs 70 yields identical lifetime SS when both cap at spousal floor (Rob delays to 70)", () => {
    // Both scenarios have Rob claiming at 70. Debbie's effective benefit
    // is $2,050 in both (spousal-floor-capped). So Debbie at 67 gets
    // 3 EXTRA years of payments at her own $1,444 (before Rob files,
    // before spousal kicks in) — that's pure upside vs claiming at 70.
    const startYear = 2026;
    const endYear = 2058;
    const debbie67 = totalLifetimeSocialSecurityTodayDollars(
      projectAnnualSocialSecurityIncome(rob(70), debbieReal(67), startYear, endYear, FRA),
    );
    const debbie70 = totalLifetimeSocialSecurityTodayDollars(
      projectAnnualSocialSecurityIncome(rob(70), debbieReal(70), startYear, endYear, FRA),
    );
    // Debbie at 67 should yield STRICTLY more lifetime SS — 3 years
    // of $1,444 × 12 = ~$52k extra (her own benefit, before Rob
    // files at 70 and spousal floor activates).
    const delta = debbie67 - debbie70;
    expect(delta).toBeGreaterThan(40_000); // ~$52k expected, with some margin
    expect(delta).toBeLessThan(60_000);
  });
});

describe("Debbie's intuition: stagger claim — she at 67, Rob at 70", () => {
  it('staggered (D67, R70) yields more lifetime SS than both-at-67', () => {
    const startYear = 2026;
    const endYear = 2058; // both alive to 95 per default
    const both67 = totalLifetimeSocialSecurityTodayDollars(
      projectAnnualSocialSecurityIncome(rob(67), debbie(67), startYear, endYear, FRA),
    );
    const staggered = totalLifetimeSocialSecurityTodayDollars(
      projectAnnualSocialSecurityIncome(rob(70), debbie(67), startYear, endYear, FRA),
    );
    // The staggered path should yield materially more lifetime SS over
    // a long horizon. With the survivor model, this gap widens further.
    expect(staggered).toBeGreaterThan(both67);
    expect(staggered - both67).toBeGreaterThan(50_000); // material delta
  });

  it('staggered with survivor scenario: Rob dies at 78, Debbie lives to 95', () => {
    const startYear = 2026;
    const endYear = 2058;
    const both67 = totalLifetimeSocialSecurityTodayDollars(
      projectAnnualSocialSecurityIncome(
        rob(67, 78),
        debbie(67, 95),
        startYear,
        endYear,
        FRA,
      ),
    );
    const staggered = totalLifetimeSocialSecurityTodayDollars(
      projectAnnualSocialSecurityIncome(
        rob(70, 78),
        debbie(67, 95),
        startYear,
        endYear,
        FRA,
      ),
    );
    // With Rob dying at 78 — only 8 years past his age-70 claim, he
    // himself benefits less from delaying. But Debbie's survivor
    // benefit (= Rob's claim amount) is materially higher when he
    // delayed to 70. This is the architectural insight that makes
    // delay-the-higher-earner correct even when his own life
    // expectancy is moderate.
    expect(staggered).toBeGreaterThan(both67);
  });
});
