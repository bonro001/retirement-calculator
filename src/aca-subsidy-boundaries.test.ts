import { describe, it, expect } from 'vitest';
import {
  calculateHealthcarePremiums,
  type HealthcarePremiumCalculationInput,
} from './healthcare-premium-engine';

// Engine uses post-ARPA/IRA regime: continuous 8.5% cap above 400% FPL instead
// of a hard cliff. Bands per DEFAULT_HEALTHCARE_PREMIUM_CONFIG:
//   ≤1.5 FPL → 0%
//   1.5-2.0 → 0-2% (linear on fplRatio within band)
//   2.0-2.5 → 2-4%
//   2.5-3.0 → 4-6%
//   3.0-4.0 → 6-8.5%
//   >4.0    → 8.5% flat
//
// Expected contribution = rate × MAGI. Subsidy = max(premium - contribution, 0)
// but only applies if retired and has non-Medicare members.

const FPL_HOUSEHOLD_2 = 21_150;
const FPL_HOUSEHOLD_4 = 32_150;
const BASE_PREMIUM_PER_PERSON = 10_000;

function mkInput(overrides: Partial<HealthcarePremiumCalculationInput> = {}): HealthcarePremiumCalculationInput {
  return {
    agesByYear: [60, 60],
    filingStatus: 'married_filing_jointly',
    MAGI: 0,
    retirementStatus: true,
    medicareEligibilityByPerson: [false, false],
    baselineAcaPremiumAnnual: BASE_PREMIUM_PER_PERSON,
    baselineMedicarePremiumAnnual: 0,
    irmaaSurchargeAnnualPerEligible: 0,
    ...overrides,
  };
}

describe('ACA subsidy / FPL-band behavior', () => {
  it('MAGI at 1.5 FPL → expected contribution 0, full subsidy', () => {
    const magi = Math.round(FPL_HOUSEHOLD_2 * 1.5); // 31,725
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const fullPremium = BASE_PREMIUM_PER_PERSON * 2;
    expect(out.acaPremiumEstimate).toBe(fullPremium);
    expect(out.acaSubsidyEstimate).toBe(fullPremium);
    expect(out.netAcaCost).toBe(0);
  });

  it('MAGI at 2.0 FPL → expected contribution = 2% of MAGI', () => {
    const magi = FPL_HOUSEHOLD_2 * 2; // 42,300
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const expectedContribution = magi * 0.02;
    const expectedSubsidy = BASE_PREMIUM_PER_PERSON * 2 - expectedContribution;
    expect(out.acaSubsidyEstimate).toBeCloseTo(expectedSubsidy, 0);
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI at 3.0 FPL → expected contribution = 6% of MAGI', () => {
    const magi = FPL_HOUSEHOLD_2 * 3; // 63,450
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const expectedContribution = magi * 0.06;
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI at 4.0 FPL → expected contribution = 8.5% of MAGI (band top)', () => {
    const magi = FPL_HOUSEHOLD_2 * 4; // 84,600
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const expectedContribution = magi * 0.085;
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI at 5.0 FPL → still 8.5% (no 400%-cliff in post-IRA regime)', () => {
    const magi = FPL_HOUSEHOLD_2 * 5; // 105,750
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const expectedContribution = magi * 0.085;
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI high enough that contribution exceeds premium → subsidy 0', () => {
    const magi = 400_000; // 8.5% × 400k = 34k, way above 20k premium
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    expect(out.acaSubsidyEstimate).toBe(0);
    expect(out.netAcaCost).toBe(BASE_PREMIUM_PER_PERSON * 2);
  });

  it('no subsidy if not retired (working ACA enrollee outside scope)', () => {
    const magi = FPL_HOUSEHOLD_2 * 2;
    const out = calculateHealthcarePremiums(
      mkInput({ MAGI: magi, retirementStatus: false }),
    );
    expect(out.acaSubsidyEstimate).toBe(0);
    expect(out.netAcaCost).toBe(BASE_PREMIUM_PER_PERSON * 2);
  });

  it('no subsidy if all members on Medicare', () => {
    const out = calculateHealthcarePremiums(
      mkInput({
        MAGI: 50_000,
        medicareEligibilityByPerson: [true, true],
        baselineMedicarePremiumAnnual: 2_220,
      }),
    );
    expect(out.acaPremiumEstimate).toBe(0);
    expect(out.acaSubsidyEstimate).toBe(0);
    expect(out.medicarePremiumEstimate).toBe(2_220 * 2);
  });

  it('household size follows filing status — single is always 1', () => {
    const single = calculateHealthcarePremiums(
      mkInput({
        filingStatus: 'single',
        agesByYear: [60],
        medicareEligibilityByPerson: [false],
      }),
    );
    // MAGI 0 on single w/ ACA should still zero out because 0 MAGI <= 1.5 FPL
    expect(single.acaSubsidyEstimate).toBe(BASE_PREMIUM_PER_PERSON);
  });

  it('larger household raises the FPL threshold linearly', () => {
    const magi = FPL_HOUSEHOLD_4 * 2; // 64,300
    const out = calculateHealthcarePremiums(
      mkInput({
        MAGI: magi,
        agesByYear: [60, 60, 15, 15],
        medicareEligibilityByPerson: [false, false, false, false],
      }),
    );
    // FPL 4-person household MAGI 64,300 → 2.0 FPL band, rate 2%.
    const expectedContribution = magi * 0.02;
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('monotone: subsidy never increases as MAGI rises', () => {
    let lastSubsidy = Infinity;
    for (const magi of [15_000, 30_000, 60_000, 90_000, 120_000, 200_000]) {
      const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
      expect(out.acaSubsidyEstimate).toBeLessThanOrEqual(lastSubsidy + 0.01);
      lastSubsidy = out.acaSubsidyEstimate;
    }
  });

  it('IRMAA surcharge flows through for Medicare-eligible members', () => {
    const out = calculateHealthcarePremiums(
      mkInput({
        MAGI: 300_000,
        medicareEligibilityByPerson: [true, true],
        baselineMedicarePremiumAnnual: 2_220,
        irmaaSurchargeAnnualPerEligible: 1_200,
      }),
    );
    expect(out.irmaaSurcharge).toBe(2_400); // 1200 * 2 eligible
    expect(out.totalHealthcarePremiumCost).toBe(
      2_220 * 2 + 2_400, // Medicare × 2 + IRMAA × 2
    );
  });
});
