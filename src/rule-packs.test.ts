import { describe, expect, it } from 'vitest';
import { CURRENT_LAW_2026_RULE_PACK, CURRENT_RULE_PACK_VERSION } from './rule-packs';
import { DEFAULT_LIMITS } from './contribution-engine';
import { DEFAULT_TAX_ENGINE_CONFIG } from './tax-engine';
import { DEFAULT_IRMAA_CONFIG } from './retirement-rules';

describe('current-law 2026 rule pack', () => {
  it('pins published 2026 federal tax values', () => {
    const tax = CURRENT_LAW_2026_RULE_PACK.federalTax;

    expect(CURRENT_RULE_PACK_VERSION).toBe('current-law-2026-v1');
    expect(tax.taxYear).toBe(2026);
    expect(tax.profiles.married_filing_jointly.standardDeduction).toBe(32_200);
    expect(tax.profiles.single.standardDeduction).toBe(16_100);
    expect(tax.profiles.head_of_household.standardDeduction).toBe(24_150);
    expect(tax.profiles.married_filing_jointly.ordinaryBrackets.map((b) => b.upTo)).toEqual([
      24_800,
      100_800,
      211_400,
      403_550,
      512_450,
      768_700,
      Number.POSITIVE_INFINITY,
    ]);
    expect(tax.profiles.single.ordinaryBrackets.map((b) => b.upTo)).toEqual([
      12_400,
      50_400,
      105_700,
      201_775,
      256_225,
      640_600,
      Number.POSITIVE_INFINITY,
    ]);
    expect(tax.profiles.married_filing_jointly.capitalGainsThresholds).toEqual({
      zeroRateTop: 98_900,
      fifteenRateTop: 613_700,
    });
    expect(tax.profiles.single.capitalGainsThresholds).toEqual({
      zeroRateTop: 49_450,
      fifteenRateTop: 545_500,
    });
    expect(tax.additionalStandardDeductionForAge65.perElderlyByStatus).toMatchObject({
      married_filing_jointly: 1_650,
      single: 2_050,
      head_of_household: 2_050,
    });
  });

  it('pins 2026 payroll contribution limits and exposes deferred super catch-up facts', () => {
    const contributions = CURRENT_LAW_2026_RULE_PACK.contributions;

    expect(contributions.employee401kBaseLimit).toBe(24_500);
    expect(contributions.employee401kCatchUpLimit).toBe(8_000);
    expect(contributions.employee401kSuperCatchUpAges).toEqual([60, 61, 62, 63]);
    expect(contributions.employee401kSuperCatchUpLimit).toBe(11_250);
    expect(contributions.rothCatchUpWageThreshold).toBe(150_000);
    expect(contributions.hsaSelfLimit).toBe(4_400);
    expect(contributions.hsaFamilyLimit).toBe(8_750);
    expect(contributions.hsaCatchUpLimit).toBe(1_000);
  });

  it('pins ACA, IRMAA, RMD, and Social Security provenance-bearing values', () => {
    expect(CURRENT_LAW_2026_RULE_PACK.aca.lawRegime).toBe(
      'current-law-2026-restored-400-fpl-cliff',
    );
    expect(CURRENT_LAW_2026_RULE_PACK.aca.federalPovertyLevelByHouseholdSize).toEqual({
      1: 15_650,
      2: 21_150,
      3: 26_650,
      4: 32_150,
    });
    expect(CURRENT_LAW_2026_RULE_PACK.aca.subsidyEligibilityMaxFplRatio).toBe(4);

    expect(CURRENT_LAW_2026_RULE_PACK.irmaa.brackets.married_filing_jointly[0].maxMagi).toBe(
      218_000,
    );
    expect(CURRENT_LAW_2026_RULE_PACK.irmaa.brackets.married_filing_jointly[1]).toMatchObject({
      maxMagi: 274_000,
      partBSurchargeMonthly: 81.2,
      partDSurchargeMonthly: 14.5,
    });
    expect(CURRENT_LAW_2026_RULE_PACK.rmd.startAgesByBirthYear).toEqual({
      through1950: 72,
      from1951Through1959: 73,
      from1960: 75,
    });
    expect(
      CURRENT_LAW_2026_RULE_PACK.federalTax.profiles.married_filing_jointly
        .socialSecurityThresholds,
    ).toEqual({
      firstBase: 32_000,
      secondBase: 44_000,
      secondTierAdjustmentCap: 6_000,
    });
  });

  it('wires default engine configs to the active rule pack', () => {
    expect(DEFAULT_TAX_ENGINE_CONFIG.profiles.married_filing_jointly.standardDeduction).toBe(
      CURRENT_LAW_2026_RULE_PACK.federalTax.profiles.married_filing_jointly.standardDeduction,
    );
    expect(DEFAULT_LIMITS.employee401kBaseLimit).toBe(
      CURRENT_LAW_2026_RULE_PACK.contributions.employee401kBaseLimit,
    );
    expect(DEFAULT_LIMITS.hsaFamilyLimit).toBe(
      CURRENT_LAW_2026_RULE_PACK.contributions.hsaFamilyLimit,
    );
    expect(DEFAULT_IRMAA_CONFIG.brackets.married_filing_jointly[1].partBSurchargeMonthly).toBe(
      CURRENT_LAW_2026_RULE_PACK.irmaa.brackets.married_filing_jointly[1]
        .partBSurchargeMonthly,
    );
  });
});
