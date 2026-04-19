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
      retirementStatus: false,
      medicareEligibilityByPerson: [true, false],
      baselineAcaPremiumAnnual: 10000,
      baselineMedicarePremiumAnnual: 2500,
      irmaaSurchargeAnnualPerEligible: 2000,
    });

    expect(result.acaPremiumEstimate).toBe(10000);
    expect(result.acaSubsidyEstimate).toBe(0);
    expect(result.netAcaCost).toBe(10000);
    expect(result.medicarePremiumEstimate).toBe(2500);
    expect(result.irmaaSurcharge).toBe(2000);
    expect(result.totalHealthcarePremiumCost).toBe(14500);
  });
});
