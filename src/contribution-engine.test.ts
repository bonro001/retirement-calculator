import { describe, expect, it } from 'vitest';
import {
  calculatePreRetirementContributions,
  calculateSalaryProrationFraction,
} from './contribution-engine';

describe('contribution-engine', () => {
  it('models employee 401k, employer match, HSA, and wage reduction', () => {
    const result = calculatePreRetirementContributions({
      age: 52,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      settings: {
        employee401kPreTaxAnnualAmount: 26000,
        employerMatch: {
          matchRate: 0.5,
          maxEmployeeContributionPercentOfSalary: 0.06,
        },
        hsaAnnualAmount: 13000,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 100000,
        hsa: 5000,
      },
    });

    expect(result.employee401kPreTaxContribution).toBe(26000);
    expect(result.employee401kRothContribution).toBe(0);
    expect(result.employee401kContribution).toBe(26000);
    expect(result.employerMatchContribution).toBe(6300);
    expect(result.total401kContribution).toBe(32300);
    expect(result.hsaContribution).toBe(8550);
    expect(result.taxableWageReduction).toBe(34550);
    expect(result.adjustedWages).toBe(175450);
    expect(result.updatedPretaxBalance).toBe(140850);
    expect(result.updatedRothBalance).toBe(0);
    expect(result.updatedAccountBalances.hsa).toBe(13550);
    expect(result.employee401kRemainingRoom).toBe(5500);
    expect(result.hsaRemainingRoom).toBe(0);
  });

  it('adds Athena-style employer match to pretax assets without reducing wages', () => {
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      salaryThisYear: 105000,
      settings: {
        employee401kPreTaxAnnualAmount: 32500,
        employerMatch: {
          matchRate: 0.5,
          maxEmployeeContributionPercentOfSalary: 0.06,
        },
      },
      accountBalances: {
        pretax: 100000,
      },
    });

    expect(result.employee401kPreTaxContribution).toBe(31500);
    expect(result.employerMatchContribution).toBe(3150);
    expect(result.total401kContribution).toBe(34650);
    expect(result.taxableWageReduction).toBe(31500);
    expect(result.adjustedWages).toBe(73500);
    expect(result.updatedPretaxBalance).toBe(134650);
  });

  it('applies catch-up limits for age-based contribution caps', () => {
    const result = calculatePreRetirementContributions({
      age: 56,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      settings: {
        employee401kPreTaxAnnualAmount: 40000,
        hsaAnnualAmount: 20000,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 0,
      },
    });

    expect(result.employee401kPreTaxContribution).toBe(31500);
    expect(result.employee401kContribution).toBe(31500);
    expect(result.hsaContribution).toBe(9550);
    expect(result.adjustedWages).toBe(168950);
  });

  it('splits pre-tax and Roth employee deferrals under one 401k cap', () => {
    const result = calculatePreRetirementContributions({
      age: 45,
      salaryAnnual: 240000,
      salaryThisYear: 240000,
      settings: {
        employee401kPreTaxAnnualAmount: 18000,
        employee401kRothAnnualAmount: 12000,
        hsaAnnualAmount: 8550,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 50000,
        roth: 30000,
      },
    });

    expect(result.employee401kContribution).toBe(24000);
    expect(result.employee401kPreTaxContribution).toBeCloseTo(14400, 2);
    expect(result.employee401kRothContribution).toBeCloseTo(9600, 2);
    expect(result.taxableWageReduction).toBeCloseTo(22950, 2);
    expect(result.adjustedWages).toBeCloseTo(217050, 2);
    expect(result.updatedPretaxBalance).toBeCloseTo(72950, 2);
    expect(result.updatedRothBalance).toBeCloseTo(39600, 2);
  });

  it('supports legacy employee401kAnnualAmount as pre-tax target', () => {
    const result = calculatePreRetirementContributions({
      age: 52,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      settings: {
        employee401kAnnualAmount: 26000,
        hsaAnnualAmount: 8550,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 0,
      },
    });

    expect(result.employee401kPreTaxContribution).toBe(26000);
    expect(result.employee401kRothContribution).toBe(0);
    expect(result.taxableWageReduction).toBe(34550);
  });

  it('treats fixed-dollar elections as plan-year targets in partial salary years', () => {
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      salaryThisYear: 105000,
      projectionYear: 2027,
      settings: {
        employee401kPreTaxAnnualAmount: 32500,
        hsaAnnualAmount: 9550,
        hsaCoverageType: 'family',
      },
      limitSettings: {
        employee401kBaseLimitByYear: {
          '2027': 25000,
        },
      },
      accountBalances: {
        pretax: 0,
        hsa: 0,
      },
    });

    expect(result.employee401kAnnualLimit).toBe(32500);
    expect(result.employee401kPreTaxContribution).toBe(32500);
    expect(result.hsaContribution).toBe(9550);
    expect(result.taxableWageReduction).toBe(42050);
  });

  it('keeps percentage elections naturally scaled to actual salary paid', () => {
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      salaryThisYear: 105000,
      projectionYear: 2027,
      settings: {
        employee401kPreTaxPercentOfSalary: 0.1499,
      },
      limitSettings: {
        employee401kBaseLimitByYear: {
          '2027': 25000,
        },
      },
    });

    expect(result.employee401kAnnualLimit).toBe(32500);
    expect(result.employee401kPreTaxContribution).toBeCloseTo(15739.5, 2);
    expect(result.employee401kRemainingRoom).toBeCloseTo(16760.5, 2);
  });

  it('prorates a July 1 salary end date as six full paid months', () => {
    const salaryFraction = calculateSalaryProrationFraction({
      retirementDate: '2027-07-01',
      projectionYear: 2027,
      rule: 'month_fraction',
    });
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      retirementDate: '2027-07-01',
      projectionYear: 2027,
      salaryProrationRule: 'month_fraction',
      settings: {
        employee401kPreTaxPercentOfSalary: 0.1499,
        hsaPercentOfSalary: 0.0159,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 0,
        hsa: 0,
      },
    });

    expect(salaryFraction).toBe(0.5);
    expect(result.salaryThisYear).toBe(105000);
    expect(result.employee401kPreTaxContribution).toBeCloseTo(15739.5, 2);
    expect(result.hsaContribution).toBeCloseTo(1669.5, 2);
  });

  it('allows explicit year-specific payroll amount overrides', () => {
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      salaryThisYear: 105000,
      projectionYear: 2027,
      settings: {
        employee401kPreTaxPercentOfSalary: 0.1499,
        employee401kPreTaxAnnualAmountByYear: {
          '2027': 13116,
        },
      },
      limitSettings: {
        employee401kBaseLimitByYear: {
          '2027': 25000,
        },
      },
    });

    expect(result.employee401kPreTaxContribution).toBe(13116);
    expect(result.employee401kRemainingRoom).toBe(19384);
  });
});
