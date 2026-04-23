import { describe, expect, test } from 'vitest';
import { computeRetirementDateSensitivity, computeSabbaticalRepayment } from './sabbatical';
import type { IncomeData } from './types';

const baseIncome: IncomeData = {
  salaryAnnual: 210_000,
  salaryEndDate: '2027-07-01',
  socialSecurity: [],
  windfalls: [],
  preRetirementContributions: {
    employee401kPreTaxPercentOfSalary: 0.15,
    employee401kRothPercentOfSalary: 0,
    employerMatch: { matchRate: 0, maxEmployeeContributionPercentOfSalary: 0 },
    hsaPercentOfSalary: 0.016,
    hsaCoverageType: 'family',
  },
  sabbatical: {
    returnDate: '2026-07-01',
    paidWeeks: 6,
    weeksForgivenPerMonth: 0.5,
  },
};

describe('sabbatical repayment', () => {
  test('owes full weeks at return date', () => {
    const result = computeSabbaticalRepayment('2026-07-01', 210_000, baseIncome.sabbatical);
    expect(result?.weeksOwed).toBe(6);
    expect(result?.dollars).toBeCloseTo((210_000 / 52) * 6, 0);
  });

  test('owes zero after 12 months of work', () => {
    const result = computeSabbaticalRepayment('2027-07-01', 210_000, baseIncome.sabbatical);
    expect(result?.weeksOwed).toBe(0);
    expect(result?.dollars).toBe(0);
  });

  test('halfway through, owes about 3 weeks', () => {
    const result = computeSabbaticalRepayment('2027-01-01', 210_000, baseIncome.sabbatical);
    expect(result?.weeksOwed).toBeGreaterThan(2.5);
    expect(result?.weeksOwed).toBeLessThan(3.5);
  });
});

describe('retirement date sensitivity', () => {
  test('produces deltas at default offsets', () => {
    const points = computeRetirementDateSensitivity(baseIncome);
    expect(points.map((p) => p.monthsShift)).toEqual([-6, -3, 3, 6]);

    const earlyThree = points.find((p) => p.monthsShift === -3)!;
    expect(earlyThree.salaryIncomeDelta).toBeLessThan(0);
    expect(earlyThree.sabbaticalRepayment).toBeGreaterThan(0);

    const lateThree = points.find((p) => p.monthsShift === 3)!;
    expect(lateThree.salaryIncomeDelta).toBeGreaterThan(0);
    expect(lateThree.sabbaticalRepayment).toBe(0);
  });
});
