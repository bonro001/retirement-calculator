import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      // 2026-05-16: re-pinned after planning end ages moved to
      // Rob 88 / Debbie 91.
      successRate: 0.885,
      medianEndingWealth: 2911471.1605613427,
      tenthPercentileEndingWealth: 160253.22309257626,
      annualTaxEstimate: 3048.6666666666665,
      firstYearTotalCashOutflow: 148694,
      medianLegacySurplus: 1911471.1605613427,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 11973.466666666667,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      tenthPercentileEndingWealth: 150000,
      annualTaxEstimate: 750,
      firstYearTotalCashOutflow: 1000,
      medianLegacySurplus: 300000,
    },
  },
  {
    id: 'early-retirement-stress',
    name: 'Early Retirement Stress Case',
    selectedStressors: ['layoff', 'market_down'],
    selectedResponses: [],
    pathKind: 'stressed',
    expected: {
      // 2026-05-16: re-pinned after planning end ages moved to
      // Rob 88 / Debbie 91.
      successRate: 0.405,
      medianEndingWealth: 146949.4279747689,
      tenthPercentileEndingWealth: 0,
      annualTaxEstimate: 746.2333333333333,
      firstYearTotalCashOutflow: 164425,
      medianLegacySurplus: -853050.5720252311,
      medianFailureYearRange: { min: 2049, max: 2049 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12637.433333333332,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      tenthPercentileEndingWealth: 1,
      annualTaxEstimate: 750,
      firstYearTotalCashOutflow: 1000,
      medianLegacySurplus: 300000,
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
      // 2026-05-16: re-pinned after planning end ages moved to
      // Rob 88 / Debbie 91.
      successRate: 0.99,
      medianEndingWealth: 5121509.101647649,
      tenthPercentileEndingWealth: 1208754.7052229885,
      annualTaxEstimate: 3868.9666666666667,
      firstYearTotalCashOutflow: 131462,
      medianLegacySurplus: 4121509.101647649,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 11973.466666666667,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      tenthPercentileEndingWealth: 200000,
      annualTaxEstimate: 750,
      firstYearTotalCashOutflow: 1000,
      medianLegacySurplus: 300000,
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
      // 2026-05-16: re-pinned after planning end ages moved to
      // Rob 88 / Debbie 91.
      successRate: 0.735,
      medianEndingWealth: 1568851.0330301477,
      tenthPercentileEndingWealth: 0,
      annualTaxEstimate: 1190.5,
      firstYearTotalCashOutflow: 135026,
      medianLegacySurplus: 568851.0330301477,
      medianFailureYearRange: { min: 2050, max: 2050 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 11475.5,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 300000,
      tenthPercentileEndingWealth: 1,
      annualTaxEstimate: 750,
      firstYearTotalCashOutflow: 1000,
      medianLegacySurplus: 300000,
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
      // 2026-05-16: re-pinned after planning end ages moved to
      // Rob 88 / Debbie 91.
      successRate: 0.995,
      medianEndingWealth: 9261556.659192218,
      tenthPercentileEndingWealth: 2245934.714339214,
      annualTaxEstimate: 44660.066666666666,
      firstYearTotalCashOutflow: 163002,
      medianLegacySurplus: 8261556.6591922175,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 16246.466666666667,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      tenthPercentileEndingWealth: 300000,
      annualTaxEstimate: 1000,
      firstYearTotalCashOutflow: 1000,
      medianLegacySurplus: 400000,
    },
  },
];
