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
    expect(result.hsaContribution).toBe(8750);
    expect(result.taxableWageReduction).toBe(34750);
    expect(result.adjustedWages).toBe(175250);
    expect(result.updatedPretaxBalance).toBe(141050);
    expect(result.updatedRothBalance).toBe(0);
    expect(result.updatedAccountBalances.hsa).toBe(13750);
    expect(result.employee401kRemainingRoom).toBe(6500);
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

    expect(result.employee401kPreTaxContribution).toBe(32500);
    expect(result.employerMatchContribution).toBe(3150);
    expect(result.total401kContribution).toBe(35650);
    expect(result.taxableWageReduction).toBe(32500);
    expect(result.adjustedWages).toBe(72500);
    expect(result.updatedPretaxBalance).toBe(135650);
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

    expect(result.employee401kPreTaxContribution).toBe(32500);
    expect(result.employee401kContribution).toBe(32500);
    expect(result.hsaContribution).toBe(9750);
    expect(result.adjustedWages).toBe(167750);
  });

  it('splits pre-tax and Roth employee deferrals under one 401k cap', () => {
    const result = calculatePreRetirementContributions({
      age: 45,
      salaryAnnual: 240000,
      salaryThisYear: 240000,
      settings: {
        employee401kPreTaxAnnualAmount: 18000,
        employee401kRothAnnualAmount: 12000,
        hsaAnnualAmount: 8750,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 50000,
        roth: 30000,
      },
    });

    expect(result.employee401kContribution).toBe(24500);
    expect(result.employee401kPreTaxContribution).toBeCloseTo(14700, 2);
    expect(result.employee401kRothContribution).toBeCloseTo(9800, 2);
    expect(result.taxableWageReduction).toBeCloseTo(23450, 2);
    expect(result.adjustedWages).toBeCloseTo(216550, 2);
    expect(result.updatedPretaxBalance).toBeCloseTo(73450, 2);
    expect(result.updatedRothBalance).toBeCloseTo(39800, 2);
  });

  it('supports legacy employee401kAnnualAmount as pre-tax target', () => {
    const result = calculatePreRetirementContributions({
      age: 52,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      settings: {
        employee401kAnnualAmount: 26000,
        hsaAnnualAmount: 8750,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 0,
      },
    });

    expect(result.employee401kPreTaxContribution).toBe(26000);
    expect(result.employee401kRothContribution).toBe(0);
    expect(result.taxableWageReduction).toBe(34750);
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

    expect(result.employee401kAnnualLimit).toBe(33000);
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

    expect(result.employee401kAnnualLimit).toBe(33000);
    expect(result.employee401kPreTaxContribution).toBeCloseTo(15739.5, 2);
    expect(result.employee401kRemainingRoom).toBeCloseTo(17260.5, 2);
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
    expect(result.employee401kRemainingRoom).toBe(19884);
  });

  it('routes high-earner age-60-63 super catch-up dollars to Roth when required', () => {
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      projectionYear: 2026,
      settings: {
        employee401kPreTaxAnnualAmount: 40000,
        priorYearFicaWagesFromEmployer: 210000,
        employerPlanSupportsRothDeferrals: true,
        employerPlanSupportsSuperCatchUp: true,
      },
    });

    expect(result.employee401kAnnualLimit).toBe(35750);
    expect(result.employee401kPreTaxAnnualLimit).toBe(24500);
    expect(result.employee401kPreTaxContribution).toBe(24500);
    expect(result.employee401kRothContribution).toBe(11250);
    expect(result.employee401kCatchUpLimit).toBe(11250);
    expect(result.employee401kCatchUpContribution).toBe(11250);
    expect(result.employee401kRothRequiredCatchUpLimit).toBe(11250);
    expect(result.employee401kRothRequiredCatchUpContribution).toBe(11250);
    expect(result.taxableWageReduction).toBe(24500);
    expect(result.rothCatchUpRequirementApplies).toBe(true);
  });

  it('keeps age-60-63 super catch-up pre-tax when prior-year FICA wages do not exceed the Roth threshold', () => {
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      projectionYear: 2026,
      settings: {
        employee401kPreTaxAnnualAmount: 40000,
        priorYearFicaWagesFromEmployer: 150000,
        employerPlanSupportsRothDeferrals: true,
        employerPlanSupportsSuperCatchUp: true,
      },
    });

    expect(result.employee401kAnnualLimit).toBe(35750);
    expect(result.employee401kPreTaxAnnualLimit).toBe(35750);
    expect(result.employee401kPreTaxContribution).toBe(35750);
    expect(result.employee401kRothContribution).toBe(0);
    expect(result.taxableWageReduction).toBe(35750);
    expect(result.rothCatchUpRequirementApplies).toBe(false);
  });

  it('disallows high-earner catch-up room when the employer plan lacks Roth deferrals', () => {
    const result = calculatePreRetirementContributions({
      age: 62,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      projectionYear: 2026,
      settings: {
        employee401kPreTaxAnnualAmount: 40000,
        priorYearFicaWagesFromEmployer: 210000,
        employerPlanSupportsRothDeferrals: false,
        employerPlanSupportsSuperCatchUp: true,
      },
    });

    expect(result.employee401kAnnualLimit).toBe(24500);
    expect(result.employee401kPreTaxAnnualLimit).toBe(24500);
    expect(result.employee401kPreTaxContribution).toBe(24500);
    expect(result.employee401kRothContribution).toBe(0);
    expect(result.employee401kCatchUpDisallowedDueToMissingRoth).toBe(11250);
    expect(result.taxableWageReduction).toBe(24500);
    expect(result.rothCatchUpRequirementApplies).toBe(true);
  });
});
