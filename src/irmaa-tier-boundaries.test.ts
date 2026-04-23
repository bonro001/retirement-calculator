import { describe, it, expect } from 'vitest';
import {
  calculateIrmaaTier,
  DEFAULT_IRMAA_CONFIG,
} from './retirement-rules';

// Each boundary case tests MAGI = threshold (should be in tier N) and
// MAGI = threshold + 1 (should be in tier N+1). The engine uses
// `referenceMagi <= bracket.maxMagi` so the boundary itself belongs to the
// lower tier.
//
// Expected surcharge totals are (partB + partD) * 12 from
// DEFAULT_IRMAA_CONFIG in src/retirement-rules.ts. Kept as literal numbers
// here so a threshold change in the engine surfaces immediately as a test
// failure rather than silently tracking the engine.

interface Boundary {
  status: 'single' | 'married_filing_jointly' | 'head_of_household' | 'married_filing_separately';
  threshold: number;
  tierAtThreshold: number;
  tierJustAbove: number;
}

const mfjBoundaries: Boundary[] = [
  { status: 'married_filing_jointly', threshold: 218_000, tierAtThreshold: 1, tierJustAbove: 2 },
  { status: 'married_filing_jointly', threshold: 274_000, tierAtThreshold: 2, tierJustAbove: 3 },
  { status: 'married_filing_jointly', threshold: 342_000, tierAtThreshold: 3, tierJustAbove: 4 },
  { status: 'married_filing_jointly', threshold: 410_000, tierAtThreshold: 4, tierJustAbove: 5 },
  { status: 'married_filing_jointly', threshold: 750_000, tierAtThreshold: 5, tierJustAbove: 6 },
];

const singleBoundaries: Boundary[] = [
  { status: 'single', threshold: 109_000, tierAtThreshold: 1, tierJustAbove: 2 },
  { status: 'single', threshold: 137_000, tierAtThreshold: 2, tierJustAbove: 3 },
  { status: 'single', threshold: 171_000, tierAtThreshold: 3, tierJustAbove: 4 },
  { status: 'single', threshold: 205_000, tierAtThreshold: 4, tierJustAbove: 5 },
  { status: 'single', threshold: 500_000, tierAtThreshold: 5, tierJustAbove: 6 },
];

const mfsBoundaries: Boundary[] = [
  // MFS has a collapsed three-tier structure in the engine.
  { status: 'married_filing_separately', threshold: 109_000, tierAtThreshold: 1, tierJustAbove: 2 },
  { status: 'married_filing_separately', threshold: 391_000, tierAtThreshold: 2, tierJustAbove: 3 },
];

// Expected (partB + partD) surcharge per tier per DEFAULT_IRMAA_CONFIG.
// MFJ/Single/HoH use the same per-tier surcharges; MFS jumps straight from
// tier 1 to tier 5-equivalent rates.
const STANDARD_MONTHLY_SURCHARGE_BY_TIER: Record<number, number> = {
  1: 0,
  2: 81.2 + 14.5,
  3: 202.9 + 37.5,
  4: 324.6 + 60.4,
  5: 446.3 + 83.3,
  6: 487.0 + 91.0,
};

const MFS_MONTHLY_SURCHARGE_BY_TIER: Record<number, number> = {
  1: 0,
  2: 446.3 + 83.3,
  3: 487.0 + 91.0,
};

function monthlySurchargeFor(boundary: Boundary, tier: number): number {
  return boundary.status === 'married_filing_separately'
    ? MFS_MONTHLY_SURCHARGE_BY_TIER[tier]
    : STANDARD_MONTHLY_SURCHARGE_BY_TIER[tier];
}

describe('IRMAA tier boundaries', () => {
  for (const boundary of [...mfjBoundaries, ...singleBoundaries, ...mfsBoundaries]) {
    it(`${boundary.status}: MAGI = ${boundary.threshold} → tier ${boundary.tierAtThreshold}`, () => {
      const result = calculateIrmaaTier(boundary.threshold, boundary.status);
      expect(result.tier).toBe(boundary.tierAtThreshold);
      const expectedMonthly = monthlySurchargeFor(boundary, boundary.tierAtThreshold);
      expect(result.surchargeMonthly).toBeCloseTo(expectedMonthly, 2);
      expect(result.surchargeAnnual).toBeCloseTo(expectedMonthly * 12, 2);
      expect(result.filingStatus).toBe(boundary.status);
    });

    it(`${boundary.status}: MAGI = ${boundary.threshold + 1} → tier ${boundary.tierJustAbove}`, () => {
      const result = calculateIrmaaTier(boundary.threshold + 1, boundary.status);
      expect(result.tier).toBe(boundary.tierJustAbove);
      const expectedMonthly = monthlySurchargeFor(boundary, boundary.tierJustAbove);
      expect(result.surchargeMonthly).toBeCloseTo(expectedMonthly, 2);
    });
  }

  it('below the first MFJ threshold → tier 1 with zero surcharge', () => {
    const result = calculateIrmaaTier(150_000, 'married_filing_jointly');
    expect(result.tier).toBe(1);
    expect(result.surchargeMonthly).toBe(0);
    expect(result.surchargeAnnual).toBe(0);
  });

  it('unknown filing status normalizes to single', () => {
    const result = calculateIrmaaTier(500_000, 'mystery-status');
    expect(result.filingStatus).toBe('single');
    expect(result.tier).toBe(5); // single tier 5 is up to 500k
  });

  it('head_of_household mirrors single thresholds', () => {
    const hohResult = calculateIrmaaTier(200_000, 'head_of_household');
    const singleResult = calculateIrmaaTier(200_000, 'single');
    expect(hohResult.tier).toBe(singleResult.tier);
    expect(hohResult.surchargeMonthly).toBe(singleResult.surchargeMonthly);
  });

  it('MFJ tier 6 applies above $750k exactly', () => {
    const result = calculateIrmaaTier(1_000_000, 'married_filing_jointly');
    expect(result.tier).toBe(6);
    expect(result.surchargeMonthly).toBeCloseTo(487.0 + 91.0, 2);
  });

  it('config tax year matches what the engine advertises', () => {
    const result = calculateIrmaaTier(100_000, 'married_filing_jointly');
    expect(result.taxYear).toBe(DEFAULT_IRMAA_CONFIG.taxYear);
  });
});
