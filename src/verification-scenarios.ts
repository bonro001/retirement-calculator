import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      successRate: 0.875,
      medianEndingWealth: 3223963.142562556,
      annualTaxEstimate: 4074.5588235294117,
      medianFailureYearRange: { min: 2054, max: 2057 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13153.47058823529,
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
      successRate: 0.455,
      medianEndingWealth: 0,
      annualTaxEstimate: 1300.6764705882354,
      medianFailureYearRange: { min: 2050, max: 2053 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12112.5,
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
      successRate: 0.995,
      medianEndingWealth: 5912586.570090866,
      annualTaxEstimate: 4252.117647058823,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13043.264705882353,
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
      successRate: 0.795,
      medianEndingWealth: 1988170.692978154,
      annualTaxEstimate: 2245.764705882353,
      medianFailureYearRange: { min: 2051, max: 2054 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12161.529411764706,
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
      medianEndingWealth: 12765415.924082853,
      annualTaxEstimate: 46534.117647058825,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 17852.323529411765,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      annualTaxEstimate: 1000,
    },
  },
];
