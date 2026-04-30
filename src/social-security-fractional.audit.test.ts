/**
 * Audit test for MINER_REFACTOR_WORKPLAN steps 1 + 3.
 *
 * Verifies the engine handles fractional SS claim ages correctly
 * end-to-end. Originally written under step 1 to pin the buggy
 * pre-fix behavior; updated under step 3 once the partial-year-of-
 * claim support landed in `social-security.ts` and `utils.ts`.
 *
 * Findings (2026-04-30 → 2026-05-01):
 *
 * 1. Benefit-factor math IS fractional-aware. `earlyClaimFactor` and
 *    `delayedRetirementCreditFactor` both compute correctly at any real
 *    `claimAge`. Test cases below confirm 67.5 produces a benefit factor
 *    strictly between 67 and 68.
 *
 * 2. Per-year payment loop now honors partial-year-of-claim. At the
 *    year where Math.floor(claimAge) === age, the engine pays
 *    (1 - fractional) * 12 months × the (fractional-age-adjusted)
 *    monthly benefit. So claiming at 67.5 = full benefit factor of
 *    1.04 × 6 months in the claim year, vs claiming at 68 = factor
 *    1.08 × 0 months in the claim year (none) + 12 in the next.
 *    Lifetime is now genuinely a smooth function of claimAge — the
 *    optimizer can pick fractional ages meaningfully.
 */

import { describe, it, expect } from 'vitest';
import {
  ownClaimAdjustmentFactor,
  projectAnnualSocialSecurityIncome,
  type SocialSecurityEarner,
} from './social-security';

describe('SS fractional-age audit (workplan step 1)', () => {
  describe('benefit-factor math is fractional-aware', () => {
    it('produces strictly increasing factors for delayed retirement credits', () => {
      // FRA = 67. DRC = 8% per year of delay.
      const f670 = ownClaimAdjustmentFactor(67, 67.0);
      const f675 = ownClaimAdjustmentFactor(67, 67.5);
      const f680 = ownClaimAdjustmentFactor(67, 68.0);
      expect(f670).toBe(1.0);
      expect(f680).toBeCloseTo(1.08, 5);
      expect(f675).toBeCloseTo(1.04, 5);
      // Strictly monotonic — 6 months of delay gives 4% bump, exactly
      // half the 1-year DRC.
      expect(f670).toBeLessThan(f675);
      expect(f675).toBeLessThan(f680);
    });

    it('produces strictly decreasing factors for early claims', () => {
      // FRA = 67. Tier 1 (first 36 months early) = 5/9 of 1% per month.
      const f670 = ownClaimAdjustmentFactor(67, 67.0);
      const f665 = ownClaimAdjustmentFactor(67, 66.5);
      const f660 = ownClaimAdjustmentFactor(67, 66.0);
      expect(f670).toBe(1.0);
      // 12 months early at 5/9% = 6.667% reduction → factor 0.9333.
      expect(f660).toBeCloseTo(1 - (12 * 5) / 900, 5);
      // 6 months early at 5/9% = 3.333% reduction → factor 0.9667.
      expect(f665).toBeCloseTo(1 - (6 * 5) / 900, 5);
      expect(f660).toBeLessThan(f665);
      expect(f665).toBeLessThan(f670);
    });
  });

  describe('per-year loop honors partial-year-of-claim (post-step-3 fix)', () => {
    const earner = (claimAge: number): SocialSecurityEarner => ({
      person: 'rob',
      fraMonthly: 4000,
      claimAge,
      birthYear: 1960,
      assumedDeathAge: 90,
    });

    it('claiming at 67.5 pays 6 months at the 67.5-adjusted rate in the claim year', () => {
      // 2027 = age 67 (the claim year for claimAge=67.5).
      // Pre-fix: zero SS in 2027, full year in 2028 at 67.5-adjusted rate.
      // Post-fix: 6 months in 2027 at 67.5-adjusted rate (1.04), 12 months in 2028+.
      const income = projectAnnualSocialSecurityIncome(earner(67.5), null, 2027, 2029);
      // 2027: claim year. 6 months × $4000 × 1.04 = $24,960.
      expect(income[0].householdAnnual).toBeCloseTo(4000 * 1.04 * 6, 0);
      // 2028: full year × 1.04 = $49,920.
      expect(income[1].householdAnnual).toBeCloseTo(4000 * 1.04 * 12, 0);
      // 2029: full year, same rate.
      expect(income[2].householdAnnual).toBeCloseTo(4000 * 1.04 * 12, 0);
    });

    it('claiming at 68.0 pays full year at 68-adjusted rate starting in claim year', () => {
      const income = projectAnnualSocialSecurityIncome(earner(68.0), null, 2027, 2029);
      // 2027: age 67 < 68 → zero.
      expect(income[0].householdAnnual).toBe(0);
      // 2028: age 68 = floor(68.0), partial-year math kicks in.
      // (1 - (68.0 - 68)) * 12 = 12 months. Full year at 1.08.
      expect(income[1].householdAnnual).toBeCloseTo(4000 * 1.08 * 12, 0);
      expect(income[2].householdAnnual).toBeCloseTo(4000 * 1.08 * 12, 0);
    });

    it('lifetime SS curve is smooth across fractional ages (no dominated points)', () => {
      // Ages 67.0, 67.5, 68.0, 68.5 over a 21-year horizon (2027-2047).
      // The "smooth" property is what the optimizer needs: no claim age
      // strictly dominated by another.
      //
      // Empirically at this horizon DRC (8%/yr → 4%/half-year) wins over
      // earlier payment timing — claim later → higher lifetime total.
      // Pre-fix the curve was lumpy (67.5 collapsed to 68's timing with
      // lower factor); post-fix it's a smooth monotonic curve.
      const lifetime = (claimAge: number) =>
        projectAnnualSocialSecurityIncome(earner(claimAge), null, 2027, 2047)
          .reduce((sum, row) => sum + row.householdAnnual, 0);

      const l670 = lifetime(67.0);
      const l675 = lifetime(67.5);
      const l680 = lifetime(68.0);
      const l685 = lifetime(68.5);

      // At a 20-year post-FRA horizon, DRC > earlier-payment value.
      // Curve is monotonically increasing.
      expect(l675).toBeGreaterThan(l670);
      expect(l680).toBeGreaterThan(l675);
      expect(l685).toBeGreaterThan(l680);

      // Increments are SMOOTH — each 6-month delay gives roughly the
      // same fraction of the 8%/yr DRC bump. Without the partial-year
      // fix, l675 would have collapsed to within $0.01 of l680 (same
      // timing, fractional factor).
      const delta01 = l675 - l670;
      const delta02 = l680 - l675;
      expect(Math.abs(delta01 - delta02) / Math.max(delta01, delta02)).toBeLessThan(0.5);
    });

    it('claim age 67.5 is no longer strictly dominated by 68', () => {
      // Pre-fix: claim 67.5 → income identical timing to 68, lower
      // amount → strictly worse. Test asserted lifetime675 < lifetime680.
      // Post-fix: 67.5 has 6 extra months of payments in 2027 → may
      // beat 68 over short horizons.
      const lifetime = (claimAge: number, endYear: number) =>
        projectAnnualSocialSecurityIncome(earner(claimAge), null, 2027, endYear)
          .reduce((sum, row) => sum + row.householdAnnual, 0);

      // Short horizon (3 years post-claim): 67.5 wins because of the
      // extra 6 months in 2027.
      expect(lifetime(67.5, 2030)).toBeGreaterThan(lifetime(68.0, 2030));
    });
  });
});
