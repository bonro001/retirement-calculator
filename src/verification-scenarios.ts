import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      successRate: 0.825,
      medianEndingWealth: 2764751.23058357,
      annualTaxEstimate: 5050.911764705882,
      medianFailureYearRange: { min: 2054, max: 2056 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13104.911764705883,
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
      successRate: 0.36,
      medianEndingWealth: 0,
      annualTaxEstimate: 1521.264705882353,
      medianFailureYearRange: { min: 2050, max: 2052 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12250.882352941177,
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
      successRate: 0.99,
      medianEndingWealth: 5325062.464025388,
      annualTaxEstimate: 4872.029411764706,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13099.676470588236,
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
      successRate: 0.7,
      medianEndingWealth: 1601473.0440792663,
      annualTaxEstimate: 2550.3529411764707,
      medianFailureYearRange: { min: 2052, max: 2054 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12229.35294117647,
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
      medianEndingWealth: 12268032.70872794,
      annualTaxEstimate: 46752.23529411765,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 17043.558823529413,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      annualTaxEstimate: 1000,
    },
  },
];
