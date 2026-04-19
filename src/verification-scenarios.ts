import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      successRate: 0.885,
      medianEndingWealth: 2758389.626190057,
      annualTaxEstimate: 15905.5,
      medianFailureYearRange: { min: 2055, max: 2057 },
      maxIrmaaTier: 2,
      averageHealthcarePremiumCost: 8292.470588235294,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      annualTaxEstimate: 750,
    },
  },
  {
    id: 'early-retirement-stress',
    name: 'Early Retirement Stress Case',
    selectedStressors: ['layoff', 'market_down'],
    selectedResponses: [],
    pathKind: 'stressed',
    expected: {
      successRate: 0.41,
      medianEndingWealth: 0,
      annualTaxEstimate: 2059.294117647059,
      medianFailureYearRange: { min: 2051, max: 2053 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 7356.35294117647,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      annualTaxEstimate: 750,
    },
  },
  {
    id: 'lower-spending',
    name: 'Lower Spending Case',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    mutateData: (data) => {
      data.spending.optionalMonthly = 3000;
    },
    expected: {
      successRate: 1,
      medianEndingWealth: 4795739.8843002785,
      annualTaxEstimate: 12798.970588235294,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 7994.794117647059,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      annualTaxEstimate: 750,
    },
  },
  {
    id: 'aca-bridge',
    name: 'ACA Bridge Pre-65 Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    mutateData: (data) => {
      data.income.salaryEndDate = '2026-01-01';
      data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
        ...entry,
        claimAge: 67,
      }));
    },
    expected: {
      successRate: 0.785,
      medianEndingWealth: 1650176.4353186702,
      annualTaxEstimate: 8159.911764705882,
      medianFailureYearRange: { min: 2052, max: 2054 },
      maxIrmaaTier: 2,
      averageHealthcarePremiumCost: 7196.64705882353,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      annualTaxEstimate: 750,
    },
  },
  {
    id: 'rmd-heavy',
    name: 'High Tax-Deferred Balance (RMD Heavy)',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    mutateData: (data) => {
      data.accounts.pretax.balance = 2_400_000;
      data.accounts.roth.balance = 50_000;
      data.accounts.taxable.balance = 60_000;
      data.accounts.cash.balance = 40_000;
    },
    expected: {
      successRate: 1,
      medianEndingWealth: 10476871.04613161,
      annualTaxEstimate: 60640.35294117647,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 13402.14705882353,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      annualTaxEstimate: 750,
    },
  },
];
