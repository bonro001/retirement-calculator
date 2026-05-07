import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      // 2026-05-07: re-pinned after current-law ACA subsidies, July 1
      // salary proration, explicit pretax RMD ownership, and tax-funded
      // withdrawal loops changed modeled cashflows.
      successRate: 0.96,
      medianEndingWealth: 4220036.427142805,
      annualTaxEstimate: 3254.470588235294,
      medianFailureYearRange: { min: 2055, max: 2058 },
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
      // 2026-05-07: re-pinned after current-law ACA subsidies, July 1
      // salary proration, explicit pretax RMD ownership, and tax-funded
      // withdrawal loops changed modeled cashflows.
      successRate: 0.66,
      medianEndingWealth: 547154.3223532573,
      annualTaxEstimate: 844.7352941176471,
      medianFailureYearRange: { min: 2052, max: 2055 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13817.882352941177,
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
      // 2026-05-07: re-pinned after current-law ACA subsidies, July 1
      // salary proration, explicit pretax RMD ownership, and tax-funded
      // withdrawal loops changed modeled cashflows.
      successRate: 1,
      medianEndingWealth: 6501526.465254109,
      annualTaxEstimate: 3518.794117647059,
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
      // 2026-05-07: re-pinned after current-law ACA subsidies, July 1
      // salary proration, explicit pretax RMD ownership, and tax-funded
      // withdrawal loops changed modeled cashflows.
      successRate: 0.875,
      medianEndingWealth: 2606863.474486013,
      annualTaxEstimate: 1494.7058823529412,
      medianFailureYearRange: { min: 2053, max: 2056 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12647.823529411764,
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
      // 2026-05-07: re-pinned after explicit pretax RMD ownership moved
      // the full seeded pretax bucket to Rob's divisor instead of a 50/50
      // household split. RMD-heavy remains fully solvent with higher taxes.
      successRate: 1,
      medianEndingWealth: 12560445.669770617,
      annualTaxEstimate: 52038.08823529412,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 18568.470588235294,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      annualTaxEstimate: 1000,
    },
  },
];
