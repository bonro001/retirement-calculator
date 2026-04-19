import { describe, expect, it } from 'vitest';
import { calculatePreRetirementContributions } from './contribution-engine';

describe('contribution-engine', () => {
  it('models employee 401k, employer match, HSA, and wage reduction', () => {
    const result = calculatePreRetirementContributions({
      age: 52,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      settings: {
        employee401kAnnualAmount: 26000,
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

    expect(result.employee401kContribution).toBe(26000);
    expect(result.employerMatchContribution).toBe(6300);
    expect(result.total401kContribution).toBe(32300);
    expect(result.hsaContribution).toBe(8550);
    expect(result.taxableWageReduction).toBe(34550);
    expect(result.adjustedWages).toBe(175450);
    expect(result.updatedPretaxBalance).toBe(140850);
    expect(result.updatedAccountBalances.hsa).toBe(13550);
  });

  it('applies catch-up limits for age-based contribution caps', () => {
    const result = calculatePreRetirementContributions({
      age: 56,
      salaryAnnual: 210000,
      salaryThisYear: 210000,
      settings: {
        employee401kAnnualAmount: 40000,
        hsaAnnualAmount: 20000,
        hsaCoverageType: 'family',
      },
      accountBalances: {
        pretax: 0,
      },
    });

    expect(result.employee401kContribution).toBe(31500);
    expect(result.hsaContribution).toBe(9550);
    expect(result.adjustedWages).toBe(168950);
  });
});

