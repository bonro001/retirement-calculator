import { describe, expect, it } from 'vitest';
import {
  calculateIrmaaTier,
  calculateRequiredMinimumDistribution,
  getRmdStartAgeForBirthYear,
} from './retirement-rules';

describe('retirement-rules', () => {
  it('selects the correct IRMAA tier from MAGI and filing status', () => {
    const result = calculateIrmaaTier(300000, 'married_filing_jointly');

    expect(result.tier).toBe(3);
    expect(result.tierLabel).toBe('Tier 3');
    expect(result.partBSurchargeMonthly).toBe(202.9);
    expect(result.partDSurchargeMonthly).toBe(37.5);
    expect(result.surchargeAnnual).toBeCloseTo(2884.8, 6);
  });

  it('returns expected RMD start ages by birth year bands', () => {
    expect(getRmdStartAgeForBirthYear(1949)).toBe(72);
    expect(getRmdStartAgeForBirthYear(1955)).toBe(73);
    expect(getRmdStartAgeForBirthYear(1962)).toBe(75);
  });

  it('calculates RMD amount using IRS uniform lifetime divisors', () => {
    const result = calculateRequiredMinimumDistribution({
      pretaxBalance: 265000,
      members: [
        {
          birthDate: '1953-06-01',
          age: 73,
          accountShare: 1,
        },
      ],
    });

    expect(result.amount).toBeCloseTo(10000, 6);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]?.divisor).toBe(26.5);
    expect(result.details[0]?.startAge).toBe(73);
  });
});

