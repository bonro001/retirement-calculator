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
    expect(getRmdStartAgeForBirthYear(1950)).toBe(72);
    expect(getRmdStartAgeForBirthYear(1951)).toBe(73);
    expect(getRmdStartAgeForBirthYear(1955)).toBe(73);
    expect(getRmdStartAgeForBirthYear(1959)).toBe(73);
    expect(getRmdStartAgeForBirthYear(1960)).toBe(75);
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

  it('uses source-account ownership rather than splitting household pretax evenly', () => {
    const result = calculateRequiredMinimumDistribution({
      pretaxBalance: 387912,
      sourceAccounts: [
        { id: 'rob-ira', owner: 'rob', balance: 387912 },
      ],
      members: [
        {
          owner: 'rob',
          birthDate: '1964-12-08',
          age: 75,
          accountShare: 0.5,
        },
        {
          owner: 'debbie',
          birthDate: '1963-10-23',
          age: 76,
          accountShare: 0.5,
        },
      ],
    });

    expect(result.amount).toBeCloseTo(387912 / 24.6, 6);
    expect(result.details[0]?.accountShare).toBe(1);
  });

  it('allocates RMDs from unequal source-account ownership balances', () => {
    const result = calculateRequiredMinimumDistribution({
      pretaxBalance: 1_000_000,
      sourceAccounts: [
        { id: 'rob-ira', owner: 'rob', balance: 750_000 },
        { id: 'debbie-ira', owner: 'debbie', balance: 250_000 },
      ],
      members: [
        {
          owner: 'rob',
          birthDate: '1952-01-01',
          age: 74,
        },
        {
          owner: 'debbie',
          birthDate: '1951-01-01',
          age: 75,
        },
      ],
    });

    expect(result.amount).toBeCloseTo(750_000 / 25.5 + 250_000 / 24.6, 6);
    expect(result.details.map((detail) => detail.accountShare)).toEqual([
      0.75,
      0.25,
    ]);
  });

  it('does not calculate an RMD before a member reaches their start age', () => {
    const result = calculateRequiredMinimumDistribution({
      pretaxBalance: 500_000,
      members: [
        {
          birthDate: '1960-01-01',
          age: 74,
          accountShare: 1,
        },
      ],
    });

    expect(result.amount).toBe(0);
    expect(result.details).toEqual([]);
  });
});
