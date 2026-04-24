import { describe, it, expect } from 'vitest';
import { calculateFederalTax, type YearTaxInputs } from './tax-engine';

// Exercises the Pub-915 two-tier SS inclusion worksheet via calculateFederalTax.
// Inputs are crafted so every non-SS flow lands deterministically in
// ordinaryIncomeExcludingSS (via ira401kWithdrawals), keeping the setup
// trivially verifiable against the engine's formula:
//
//   provisionalIncome = ordinaryExcludingSS + preferentialIncome
//                       + taxExemptInterest + 0.5 * SS
//
// and:
//   if provisional <= firstBase  → taxable SS = 0
//   if firstBase < provisional <= secondBase → min(0.5*SS, 0.5*(prov-firstBase))
//   else → min(0.85*SS, 0.85*(prov-secondBase) + min(0.5*SS, secondTierCap))

interface Case {
  id: string;
  description: string;
  filingStatus: 'married_filing_jointly' | 'single' | 'married_filing_separately';
  ssBenefits: number;
  ira401kWithdrawals: number;
  expectedProvisional: number;
  expectedTaxableSs: number;
}

function mkInput(c: Case): YearTaxInputs {
  return {
    wages: 0,
    pension: 0,
    socialSecurityBenefits: c.ssBenefits,
    ira401kWithdrawals: c.ira401kWithdrawals,
    rothWithdrawals: 0,
    taxableInterest: 0,
    qualifiedDividends: 0,
    ordinaryDividends: 0,
    realizedLTCG: 0,
    realizedSTCG: 0,
    otherOrdinaryIncome: 0,
    taxExemptInterest: 0,
    filingStatus: c.filingStatus,
  };
}

const cases: Case[] = [
  // MFJ boundary: firstBase = 32,000. Inputs chosen so provisional = firstBase.
  {
    id: 'mfj_at_first_base',
    description: 'MFJ provisional exactly at $32k first base → 0% taxable',
    filingStatus: 'married_filing_jointly',
    ssBenefits: 20000,
    ira401kWithdrawals: 22000, // provisional = 22000 + 10000 = 32000
    expectedProvisional: 32000,
    expectedTaxableSs: 0,
  },
  {
    id: 'mfj_just_above_first_base',
    description: 'MFJ provisional $32,001 → tiny 50%-band inclusion',
    filingStatus: 'married_filing_jointly',
    ssBenefits: 20000,
    ira401kWithdrawals: 22001,
    expectedProvisional: 32001,
    expectedTaxableSs: 0.5, // min(0.5*SS=10000, (32001-32000)*0.5 = 0.50)
  },
  {
    id: 'mfj_at_second_base',
    description: 'MFJ provisional exactly at $44k second base → top of 50% band',
    filingStatus: 'married_filing_jointly',
    ssBenefits: 30000,
    ira401kWithdrawals: 29000, // provisional = 29000 + 15000 = 44000
    expectedProvisional: 44000,
    expectedTaxableSs: 6000, // min(0.5*SS=15000, (44000-32000)*0.5=6000)
  },
  {
    id: 'mfj_just_above_second_base',
    description: 'MFJ provisional $44,001 → enters 85% band',
    filingStatus: 'married_filing_jointly',
    ssBenefits: 30000,
    ira401kWithdrawals: 29001,
    // baseHalf = min(0.5*30000=15000, 6000) = 6000
    // secondTier = (44001-44000)*0.85 + 6000 = 0.85 + 6000 = 6000.85
    // cap = 0.85*30000 = 25500
    // taxable = min(6000.85, 25500) = 6000.85
    expectedProvisional: 44001,
    expectedTaxableSs: 6000.85,
  },
  {
    id: 'mfj_deep_85pct_not_capped',
    description: 'MFJ provisional well above second base, 85% tier but under cap',
    filingStatus: 'married_filing_jointly',
    ssBenefits: 50000,
    ira401kWithdrawals: 60000,
    // provisional = 60000 + 25000 = 85000
    // baseHalf = min(25000, 6000) = 6000
    // secondTier = (85000-44000)*0.85 + 6000 = 34850 + 6000 = 40850
    // cap = 0.85*50000 = 42500
    // taxable = min(40850, 42500) = 40850
    expectedProvisional: 85000,
    expectedTaxableSs: 40850,
  },
  {
    id: 'mfj_capped_at_85pct',
    description: 'MFJ huge provisional → 85% cap on benefits actually binds',
    filingStatus: 'married_filing_jointly',
    ssBenefits: 30000,
    ira401kWithdrawals: 200000,
    // provisional = 200000 + 15000 = 215000
    // baseHalf = min(15000, 6000) = 6000
    // secondTier = (215000-44000)*0.85 + 6000 = 145350 + 6000 = 151350
    // cap = 0.85 * 30000 = 25500
    // taxable = min(151350, 25500) = 25500
    expectedProvisional: 215000,
    expectedTaxableSs: 25500,
  },
  // Single filer: firstBase 25k, secondBase 34k, cap 4500.
  {
    id: 'single_at_first_base',
    description: 'Single provisional exactly at $25k → 0% taxable',
    filingStatus: 'single',
    ssBenefits: 20000,
    ira401kWithdrawals: 15000, // provisional = 15000 + 10000 = 25000
    expectedProvisional: 25000,
    expectedTaxableSs: 0,
  },
  {
    id: 'single_at_second_base',
    description: 'Single provisional exactly at $34k → top of 50% band',
    filingStatus: 'single',
    ssBenefits: 20000,
    ira401kWithdrawals: 24000, // provisional = 24000 + 10000 = 34000
    // min(0.5*20000=10000, (34000-25000)*0.5=4500) = 4500
    expectedProvisional: 34000,
    expectedTaxableSs: 4500,
  },
  {
    id: 'single_deep_85pct',
    description: 'Single provisional deep into 85% band',
    filingStatus: 'single',
    ssBenefits: 30000,
    ira401kWithdrawals: 60000,
    // provisional = 60000 + 15000 = 75000
    // baseHalf = min(15000, 4500) = 4500
    // secondTier = (75000-34000)*0.85 + 4500 = 34850 + 4500 = 39350
    // cap = 0.85*30000 = 25500
    // taxable = min(39350, 25500) = 25500
    expectedProvisional: 75000,
    expectedTaxableSs: 25500,
  },
  // MFS (living-together): all thresholds 0 → any SS immediately in 85% tier.
  {
    id: 'mfs_minimal_income',
    description: 'MFS SS + small draw → 85% on benefits immediately (cap 0 → second tier only)',
    filingStatus: 'married_filing_separately',
    ssBenefits: 20000,
    ira401kWithdrawals: 10000,
    // provisional = 10000 + 10000 = 20000
    // baseHalf = min(0.5*20000=10000, cap=0) = 0
    // secondTier = (20000 - 0) * 0.85 + 0 = 17000
    // cap = 0.85 * 20000 = 17000
    // taxable = min(17000, 17000) = 17000
    expectedProvisional: 20000,
    expectedTaxableSs: 17000,
  },
  // Zero-SS sanity — formula must return 0 regardless of provisional income.
  {
    id: 'no_ss_benefit',
    description: 'No SS benefit → taxable SS = 0 regardless of other income',
    filingStatus: 'married_filing_jointly',
    ssBenefits: 0,
    ira401kWithdrawals: 500000,
    expectedProvisional: 500000,
    expectedTaxableSs: 0,
  },
];

describe('Social Security taxation worksheet', () => {
  for (const c of cases) {
    it(`${c.id}: ${c.description}`, () => {
      const out = calculateFederalTax(mkInput(c));
      expect(out.provisionalIncome).toBeCloseTo(c.expectedProvisional, 2);
      expect(out.taxableSocialSecurity).toBeCloseTo(c.expectedTaxableSs, 2);
    });
  }

  it('inclusion never exceeds 85% of benefits', () => {
    // Stress it with many values; inclusion cap should never exceed 0.85 * SS.
    for (const ssBenefits of [10_000, 25_000, 40_000, 60_000, 90_000]) {
      for (const otherIncome of [0, 20_000, 100_000, 500_000, 2_000_000]) {
        const out = calculateFederalTax({
          wages: 0,
          pension: 0,
          socialSecurityBenefits: ssBenefits,
          ira401kWithdrawals: otherIncome,
          rothWithdrawals: 0,
          taxableInterest: 0,
          qualifiedDividends: 0,
          ordinaryDividends: 0,
          realizedLTCG: 0,
          realizedSTCG: 0,
          otherOrdinaryIncome: 0,
          taxExemptInterest: 0,
          filingStatus: 'married_filing_jointly',
        });
        expect(out.taxableSocialSecurity).toBeLessThanOrEqual(
          ssBenefits * 0.85 + 0.01,
        );
      }
    }
  });

  it('inclusion is monotone non-decreasing in provisional income', () => {
    let lastTaxableSs = -1;
    for (const draw of [0, 10_000, 25_000, 50_000, 100_000, 250_000]) {
      const out = calculateFederalTax({
        wages: 0,
        pension: 0,
        socialSecurityBenefits: 30_000,
        ira401kWithdrawals: draw,
        rothWithdrawals: 0,
        taxableInterest: 0,
        qualifiedDividends: 0,
        ordinaryDividends: 0,
        realizedLTCG: 0,
        realizedSTCG: 0,
        otherOrdinaryIncome: 0,
        taxExemptInterest: 0,
        filingStatus: 'married_filing_jointly',
      });
      expect(out.taxableSocialSecurity).toBeGreaterThanOrEqual(lastTaxableSs);
      lastTaxableSs = out.taxableSocialSecurity;
    }
  });

  it('tax-exempt interest increases provisional income dollar-for-dollar', () => {
    const baseInput: YearTaxInputs = {
      wages: 0,
      pension: 0,
      socialSecurityBenefits: 30_000,
      ira401kWithdrawals: 20_000,
      rothWithdrawals: 0,
      taxableInterest: 0,
      qualifiedDividends: 0,
      ordinaryDividends: 0,
      realizedLTCG: 0,
      realizedSTCG: 0,
      otherOrdinaryIncome: 0,
      taxExemptInterest: 0,
      filingStatus: 'married_filing_jointly',
    };
    const a = calculateFederalTax(baseInput);
    const b = calculateFederalTax({ ...baseInput, taxExemptInterest: 10_000 });
    expect(b.provisionalIncome - a.provisionalIncome).toBeCloseTo(10_000, 2);
  });
});
