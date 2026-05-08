import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      // 2026-05-08: re-pinned after current-law 2026 tax/contribution rule
      // packs, SECURE 2.0 catch-up handling, and north-star trace plumbing.
      successRate: 1,
      medianEndingWealth: 6450891.035073565,
      annualTaxEstimate: 3278.5588235294117,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13098.70588235294,
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
      // 2026-05-08: re-pinned after current-law 2026 tax/contribution rule
      // packs, SECURE 2.0 catch-up handling, and north-star trace plumbing.
      successRate: 0.965,
      medianEndingWealth: 2012848.616192121,
      annualTaxEstimate: 740.3823529411765,
      medianFailureYearRange: { min: 2056, max: 2056 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13816.882352941177,
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
      // 2026-05-08: re-pinned after current-law 2026 tax/contribution rule
      // packs, SECURE 2.0 catch-up handling, and north-star trace plumbing.
      successRate: 1,
      medianEndingWealth: 8304490.602959889,
      annualTaxEstimate: 2760.5882352941176,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13098.70588235294,
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
      // 2026-05-08: re-pinned after current-law 2026 tax/contribution rule
      // packs, SECURE 2.0 catch-up handling, and north-star trace plumbing.
      successRate: 0.985,
      medianEndingWealth: 4304215.645725329,
      annualTaxEstimate: 810.1764705882352,
      medianFailureYearRange: { min: 2059, max: 2059 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12657.470588235294,
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
      // 2026-05-08: re-pinned after current-law 2026 tax/contribution rule
      // packs, SECURE 2.0 catch-up handling, and north-star trace plumbing.
      successRate: 1,
      medianEndingWealth: 13190289.45995742,
      annualTaxEstimate: 52142.32352941176,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 18704.970588235294,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      annualTaxEstimate: 1000,
    },
  },
];
