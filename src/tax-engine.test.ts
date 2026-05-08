import { describe, expect, it } from 'vitest';
import { calculateFederalTax } from './tax-engine';

describe('tax-engine', () => {
  it('calculates ordinary taxable income and bracketed federal tax', () => {
    const result = calculateFederalTax({
      wages: 100000,
      pension: 0,
      socialSecurityBenefits: 0,
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      taxableInterest: 0,
      qualifiedDividends: 0,
      ordinaryDividends: 0,
      realizedLTCG: 0,
      realizedSTCG: 0,
      otherOrdinaryIncome: 0,
      filingStatus: 'single',
    });

    expect(result.totalTaxableIncome).toBe(83900);
    expect(result.ordinaryTaxableIncome).toBe(83900);
    expect(result.LTCGTaxableIncome).toBe(0);
    expect(result.federalTax).toBe(13170);
    expect(result.marginalOrdinaryBracket).toBe(0.22);
  });

  it('calculates provisional income and taxable social security', () => {
    const result = calculateFederalTax({
      wages: 40000,
      pension: 0,
      socialSecurityBenefits: 40000,
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      taxableInterest: 0,
      qualifiedDividends: 0,
      ordinaryDividends: 0,
      realizedLTCG: 0,
      realizedSTCG: 0,
      otherOrdinaryIncome: 0,
      filingStatus: 'married_filing_jointly',
    });

    expect(result.provisionalIncome).toBe(60000);
    expect(result.taxableSocialSecurity).toBe(19600);
    expect(result.AGI).toBe(59600);
    expect(result.totalTaxableIncome).toBe(27400);
    expect(result.federalTax).toBe(2792);
  });
});
