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

  it('stacks preferential income into the 0% MFJ capital-gains bracket', () => {
    const atThreshold = calculateFederalTax({
      wages: 0,
      pension: 0,
      socialSecurityBenefits: 0,
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      taxableInterest: 0,
      qualifiedDividends: 131100,
      ordinaryDividends: 0,
      realizedLTCG: 0,
      realizedSTCG: 0,
      otherOrdinaryIncome: 0,
      filingStatus: 'married_filing_jointly',
    });

    expect(atThreshold.totalTaxableIncome).toBe(98900);
    expect(atThreshold.LTCGTaxableIncome).toBe(98900);
    expect(atThreshold.federalTax).toBe(0);

    const oneDollarOver = calculateFederalTax({
      ...{
        wages: 0,
        pension: 0,
        socialSecurityBenefits: 0,
        ira401kWithdrawals: 0,
        rothWithdrawals: 0,
        taxableInterest: 0,
        ordinaryDividends: 0,
        realizedLTCG: 0,
        realizedSTCG: 0,
        otherOrdinaryIncome: 0,
        filingStatus: 'married_filing_jointly',
      },
      qualifiedDividends: 131101,
    });

    expect(oneDollarOver.totalTaxableIncome).toBe(98901);
    expect(oneDollarOver.federalTax).toBeCloseTo(0.15, 6);
    expect(oneDollarOver.marginalLTCGBracket).toBe(0.15);
  });

  it('stacks capital gains above ordinary income before applying the 15% bracket', () => {
    const result = calculateFederalTax({
      wages: 82200,
      pension: 0,
      socialSecurityBenefits: 0,
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      taxableInterest: 0,
      qualifiedDividends: 50000,
      ordinaryDividends: 0,
      realizedLTCG: 0,
      realizedSTCG: 0,
      otherOrdinaryIncome: 0,
      filingStatus: 'married_filing_jointly',
    });

    expect(result.ordinaryTaxableIncome).toBe(50000);
    expect(result.LTCGTaxableIncome).toBe(50000);
    expect(result.federalTax).toBeCloseTo(5669, 6);
  });

  it('applies the age-65 standard deduction add-on for both MFJ spouses', () => {
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
      filingStatus: 'married_filing_jointly',
      headAge: 65,
      spouseAge: 65,
    });

    expect(result.standardDeductionApplied).toBe(35500);
    expect(result.totalTaxableIncome).toBe(64500);
    expect(result.federalTax).toBeCloseTo(7244, 6);
  });

  it('applies NIIT to the lesser of investment income or MAGI excess', () => {
    const result = calculateFederalTax({
      wages: 250000,
      pension: 0,
      socialSecurityBenefits: 0,
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      taxableInterest: 10000,
      qualifiedDividends: 0,
      ordinaryDividends: 0,
      realizedLTCG: 40000,
      realizedSTCG: 0,
      otherOrdinaryIncome: 0,
      filingStatus: 'married_filing_jointly',
    });

    expect(result.MAGI).toBe(300000);
    expect(result.netInvestmentIncomeTax).toBeCloseTo(1900, 6);
    expect(result.federalTax).toBeGreaterThan(result.netInvestmentIncomeTax);
  });

  it('limits NIIT to MAGI excess when excess is smaller than investment income', () => {
    const result = calculateFederalTax({
      wages: 240000,
      pension: 0,
      socialSecurityBenefits: 0,
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      taxableInterest: 0,
      qualifiedDividends: 20000,
      ordinaryDividends: 0,
      realizedLTCG: 0,
      realizedSTCG: 0,
      otherOrdinaryIncome: 0,
      filingStatus: 'married_filing_jointly',
    });

    expect(result.MAGI).toBe(260000);
    expect(result.netInvestmentIncomeTax).toBeCloseTo(380, 6);
  });
});
