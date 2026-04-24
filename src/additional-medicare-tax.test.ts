import { describe, it, expect } from 'vitest';
import { calculateFederalTax, type YearTaxInputs } from './tax-engine';

// IRC §1401(b) Additional Medicare tax: 0.9% on wages above the filing-
// status threshold. Statutory — not indexed. Applies only to wages
// (employee-side Medicare wages), NOT to retirement distributions or
// investment income.
//
// For a retiree household with no wages this is permanently zero. For
// a household still earning high wages (or in Roth-conversion years if
// we ever modeled conversion income as wages — we don't), it kicks in.

function make(overrides: Partial<YearTaxInputs>): YearTaxInputs {
  return {
    wages: 0,
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
    taxExemptInterest: 0,
    filingStatus: 'single',
    ...overrides,
  };
}

describe('additional Medicare tax (IRC §1401(b))', () => {
  it('single filer wages under $200k → no tax', () => {
    const out = calculateFederalTax(make({ wages: 199_000 }));
    expect(out.additionalMedicareTax).toBe(0);
  });

  it('single filer wages exactly at $200k → no tax', () => {
    const out = calculateFederalTax(make({ wages: 200_000 }));
    expect(out.additionalMedicareTax).toBe(0);
  });

  it('single filer wages $1 over threshold → rounds to $0.01', () => {
    const out = calculateFederalTax(make({ wages: 200_001 }));
    // 0.009 * 1 = 0.009, rounded to 2dp by normalizeMoney → 0.01
    expect(out.additionalMedicareTax).toBe(0.01);
  });

  it('single filer wages $250k → 0.9% × $50k = $450', () => {
    const out = calculateFederalTax(make({ wages: 250_000 }));
    expect(out.additionalMedicareTax).toBeCloseTo(450, 2);
  });

  it('MFJ wages $250k → no tax (at threshold)', () => {
    const out = calculateFederalTax(
      make({ wages: 250_000, filingStatus: 'married_filing_jointly' }),
    );
    expect(out.additionalMedicareTax).toBe(0);
  });

  it('MFJ wages $500k → 0.9% × $250k = $2250', () => {
    const out = calculateFederalTax(
      make({ wages: 500_000, filingStatus: 'married_filing_jointly' }),
    );
    expect(out.additionalMedicareTax).toBeCloseTo(2250, 2);
  });

  it('MFS wages $125k → no tax (at threshold)', () => {
    const out = calculateFederalTax(
      make({ wages: 125_000, filingStatus: 'married_filing_separately' }),
    );
    expect(out.additionalMedicareTax).toBe(0);
  });

  it('MFS wages $200k → 0.9% × $75k = $675', () => {
    const out = calculateFederalTax(
      make({ wages: 200_000, filingStatus: 'married_filing_separately' }),
    );
    expect(out.additionalMedicareTax).toBeCloseTo(675, 2);
  });

  it('head of household wages $250k → 0.9% × $50k = $450', () => {
    const out = calculateFederalTax(
      make({ wages: 250_000, filingStatus: 'head_of_household' }),
    );
    expect(out.additionalMedicareTax).toBeCloseTo(450, 2);
  });

  it('does NOT apply to IRA withdrawals (retirement distribution not wages)', () => {
    const out = calculateFederalTax(
      make({
        wages: 0,
        ira401kWithdrawals: 500_000,
        filingStatus: 'married_filing_jointly',
      }),
    );
    expect(out.additionalMedicareTax).toBe(0);
  });

  it('does NOT apply to LTCG (investment income not wages)', () => {
    const out = calculateFederalTax(
      make({
        wages: 0,
        realizedLTCG: 500_000,
        filingStatus: 'married_filing_jointly',
      }),
    );
    expect(out.additionalMedicareTax).toBe(0);
  });

  it('is included in the returned federalTax total', () => {
    const out = calculateFederalTax(make({ wages: 250_000 }));
    // Single filer wages 250k: ordinary tax on 235400 taxable + 450 amt.
    // Just check that federalTax is higher than it would be without amt.
    expect(out.additionalMedicareTax).toBeCloseTo(450, 2);
    expect(out.federalTax).toBeGreaterThan(out.additionalMedicareTax);
  });
});
