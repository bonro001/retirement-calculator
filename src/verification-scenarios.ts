import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      // Regenerated 2026-04-23 after TRP_2030 proxy tightening landed
      // (30% → 45% US equity per 2026-03-31 fact sheet), which shifted
      // every baseline scenario upward. Prior expected successRate 0.825
      // / medianEndingWealth 2.76M / annualTax 3904.74 dates back to the
      // pre-fact-sheet proxy.
      successRate: 0.875,
      medianEndingWealth: 3286372.7291788994,
      annualTaxEstimate: 3808.323529411765,
      medianFailureYearRange: { min: 2055, max: 2057 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13160.676470588236,
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
      // Regenerated 2026-04-23 after TRP_2030 proxy tightening (see
      // baseline-near-retirement). Prior expected values (0.99 / 5.33M /
      // 3873) were calibrated against the older 30%-US-equity proxy.
      successRate: 0.995,
      medianEndingWealth: 5972081.123971995,
      annualTaxEstimate: 3997.823529411765,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 13157.970588235294,
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
      // Regenerated 2026-04-23 after TRP_2030 proxy tightening. Prior
      // expected medianEndingWealth 12.27M / annualTax 45357 dates back
      // to the 30%-US-equity proxy. This scenario remains the tier-5
      // IRMAA canary it was intended as.
      successRate: 1,
      medianEndingWealth: 12955515.235473957,
      annualTaxEstimate: 45596.882352941175,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 17546.08823529412,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      annualTaxEstimate: 1000,
    },
  },
];
