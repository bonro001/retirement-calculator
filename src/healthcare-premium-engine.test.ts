import { describe, expect, it } from 'vitest';
import { calculateHealthcarePremiums } from './healthcare-premium-engine';

describe('healthcare-premium-engine', () => {
  it('estimates ACA subsidy and net ACA cost for pre-65 retired household', () => {
    const result = calculateHealthcarePremiums({
      agesByYear: [62, 63],
      filingStatus: 'married_filing_jointly',
      MAGI: 50000,
      retirementStatus: true,
      medicareEligibilityByPerson: [false, false],
      baselineAcaPremiumAnnual: 12000,
      baselineMedicarePremiumAnnual: 2220,
      irmaaSurchargeAnnualPerEligible: 0,
    });

    expect(result.acaPremiumEstimate).toBe(24000);
    expect(result.acaSubsidyEstimate).toBe(22271.87);
    expect(result.netAcaCost).toBe(1728.13);
    expect(result.medicarePremiumEstimate).toBe(0);
    expect(result.totalHealthcarePremiumCost).toBe(1728.13);
  });

  it('adds Medicare baseline premium and IRMAA surcharge for eligible members', () => {
    const result = calculateHealthcarePremiums({
      agesByYear: [66, 63],
      filingStatus: 'married_filing_jointly',
      MAGI: 150000,
      // Working household: presumed on employer health insurance, so we
      // do NOT model an ACA premium for the non-Medicare spouse. (Updated
      // from the previous behavior, which billed the full ACA premium
      // with zero subsidy during working years and surfaced as a
      // misleading "ACA subsidy lost" signal in the Advisor card.)
      retirementStatus: false,
      medicareEligibilityByPerson: [true, false],
      baselineAcaPremiumAnnual: 10000,
      baselineMedicarePremiumAnnual: 2500,
      irmaaSurchargeAnnualPerEligible: 2000,
    });

    expect(result.acaPremiumEstimate).toBe(0);
    expect(result.acaSubsidyEstimate).toBe(0);
    expect(result.netAcaCost).toBe(0);
    expect(result.medicarePremiumEstimate).toBe(2500);
    expect(result.irmaaSurcharge).toBe(2000);
    expect(result.totalHealthcarePremiumCost).toBe(4500);
  });

  it('models zero ACA premium when household is still working pre-Medicare', () => {
    // Regression: the Advisor "Tax & coverage" chip used to flash
    // "ACA subsidy lost" during working years because the engine billed
    // the full marketplace premium even when the household had employer
    // insurance. The fix is to gate `acaPremiumEstimate` on
    // `retirementStatus`. This test pins that behavior.
    const result = calculateHealthcarePremiums({
      agesByYear: [60, 58],
      filingStatus: 'married_filing_jointly',
      MAGI: 250000,
      retirementStatus: false,
      medicareEligibilityByPerson: [false, false],
      baselineAcaPremiumAnnual: 12000,
      baselineMedicarePremiumAnnual: 2220,
      irmaaSurchargeAnnualPerEligible: 0,
    });

    expect(result.acaPremiumEstimate).toBe(0);
    expect(result.acaSubsidyEstimate).toBe(0);
    expect(result.netAcaCost).toBe(0);
    expect(result.medicarePremiumEstimate).toBe(0);
    expect(result.irmaaSurcharge).toBe(0);
    expect(result.totalHealthcarePremiumCost).toBe(0);
  });
});
