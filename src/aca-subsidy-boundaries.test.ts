import { describe, it, expect } from 'vitest';
import {
  calculateHealthcarePremiums,
  type HealthcarePremiumCalculationInput,
} from './healthcare-premium-engine';

// Engine uses current 2026-law ACA percentages with the restored 400% FPL cap.
// Bands per DEFAULT_HEALTHCARE_PREMIUM_CONFIG:
//   ≤1.33 FPL → 2.10%
//   1.33-1.5 → 3.14-4.19%
//   1.5-2.0 → 4.19-6.60%
//   2.0-2.5 → 6.60-8.44%
//   2.5-3.0 → 8.44-9.96%
//   3.0-4.0 → 9.96%
//   >4.0    → no subsidy
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
  it('MAGI at 1.5 FPL → expected contribution is 4.19% of MAGI', () => {
    const magi = Math.round(FPL_HOUSEHOLD_2 * 1.5); // 31,725
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const fullPremium = BASE_PREMIUM_PER_PERSON * 2;
    const expectedContribution = magi * 0.0419;
    expect(out.acaPremiumEstimate).toBe(fullPremium);
    expect(out.acaSubsidyEstimate).toBeCloseTo(fullPremium - expectedContribution, 0);
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI at 2.0 FPL → expected contribution = 6.6% of MAGI', () => {
    const magi = FPL_HOUSEHOLD_2 * 2; // 42,300
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const expectedContribution = magi * 0.066;
    const expectedSubsidy = BASE_PREMIUM_PER_PERSON * 2 - expectedContribution;
    expect(out.acaSubsidyEstimate).toBeCloseTo(expectedSubsidy, 0);
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI at 3.0 FPL → expected contribution = 9.96% of MAGI', () => {
    const magi = FPL_HOUSEHOLD_2 * 3; // 63,450
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const expectedContribution = magi * 0.0996;
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI at 4.0 FPL → expected contribution = 9.96% of MAGI', () => {
    const magi = FPL_HOUSEHOLD_2 * 4; // 84,600
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    const expectedContribution = magi * 0.0996;
    expect(out.netAcaCost).toBeCloseTo(expectedContribution, 0);
  });

  it('MAGI $1 above 4.0 FPL → restored 400%-FPL cap removes subsidy', () => {
    const magi = FPL_HOUSEHOLD_2 * 4 + 1;
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    expect(out.acaSubsidyEstimate).toBe(0);
    expect(out.netAcaCost).toBe(BASE_PREMIUM_PER_PERSON * 2);
  });

  it('MAGI at 5.0 FPL → restored 400%-FPL cap means no subsidy', () => {
    const magi = FPL_HOUSEHOLD_2 * 5; // 105,750
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    expect(out.acaSubsidyEstimate).toBe(0);
    expect(out.netAcaCost).toBe(BASE_PREMIUM_PER_PERSON * 2);
  });

  it('MAGI high enough that contribution exceeds premium → subsidy 0', () => {
    const magi = 400_000; // 8.5% × 400k = 34k, way above 20k premium
    const out = calculateHealthcarePremiums(mkInput({ MAGI: magi }));
    expect(out.acaSubsidyEstimate).toBe(0);
    expect(out.netAcaCost).toBe(BASE_PREMIUM_PER_PERSON * 2);
  });

  it('no ACA cost if not retired (working household assumed on employer insurance)', () => {
    // Updated semantics: working households are assumed to be on
    // employer-provided health insurance, so the engine no longer models
    // a hypothetical marketplace premium. Previously this test pinned the
    // old behavior of charging the full ACA premium with zero subsidy
    // during working years, which surfaced as a misleading "ACA subsidy
    // lost" signal in the Advisor "Tax & coverage" card. See
    // healthcare-premium-engine.ts for the matching gating logic.
    const magi = FPL_HOUSEHOLD_2 * 2;
    const out = calculateHealthcarePremiums(
      mkInput({ MAGI: magi, retirementStatus: false }),
    );
    expect(out.acaPremiumEstimate).toBe(0);
    expect(out.acaSubsidyEstimate).toBe(0);
    expect(out.netAcaCost).toBe(0);
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
    // FPL 4-person household MAGI 64,300 → 2.0 FPL band, rate 6.6%.
    const expectedContribution = magi * 0.066;
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
