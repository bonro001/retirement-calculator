import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      // Updated 2026-04-23: absorbed accumulated tax-engine drift including
      // the NIIT + age-65 standard-deduction-bump additions (commit 4eeea11).
      // Prior expected annualTaxEstimate was 5050.91 against the old engine
      // without the age-65 bump.
      successRate: 0.825,
      medianEndingWealth: 2764751.23058357,
      annualTaxEstimate: 3904.735294117647,
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
      // Updated 2026-04-23 same as baseline-near-retirement: absorbs tax
      // drift from NIIT + age-65 standard-deduction-bump. Prior expected
      // annualTaxEstimate was 4872.03 under the old engine.
      successRate: 0.99,
      medianEndingWealth: 5325062.464025388,
      annualTaxEstimate: 3873.4411764705883,
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
      // Updated 2026-04-23: absorbs tax drift from NIIT + age-65 std-ded
      // (prior annualTaxEstimate was 46752.24). Healthcare cost delta also
      // crept above the 500 tolerance floor (averagePremium rose ~$500
      // because of RMD-driven IRMAA interactions with the larger std ded);
      // accepting new baseline of 17546.09 so this scenario remains the
      // tier-5 IRMAA canary it was intended as.
      successRate: 1,
      medianEndingWealth: 12268032.70872794,
      annualTaxEstimate: 45357.26470588235,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 17546.09,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      annualTaxEstimate: 1000,
    },
  },
];
