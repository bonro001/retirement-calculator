import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      // Regenerated 2026-04-25 after the healthcare-engine fix that
      // gates `acaPremiumEstimate` on retirementStatus (working years
      // assumed to be on employer insurance). Per-year ACA cost during
      // pre-retirement years dropped to $0, lifting median ending wealth
      // ~$125k and lowering averageHealthcarePremiumCost ~$850/yr.
      // Primary metrics (success_rate, ending_wealth, annual_tax) were
      // already inside their existing tolerances; only the per-scenario
      // expected values were re-pinned to keep the harness honest.
      // Earlier baseline (TRP_2030 proxy tightening, 2026-04-23): success
      // 0.825 → 0.875, ending wealth 2.76M → 3.29M, tax 3904 → 3808.
      successRate: 0.89,
      medianEndingWealth: 3412040.0743031665,
      annualTaxEstimate: 3796.294117647059,
      medianFailureYearRange: { min: 2055, max: 2057 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12312.79411764706,
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
      // 2026-04-25: the layoff stressor pushes the household into
      // retirement immediately, so the ACA-gating engine fix has minimal
      // effect here (only a small annual_tax shift + a healthcare delta
      // inside tolerance). Numbers re-pinned for fidelity.
      successRate: 0.455,
      medianEndingWealth: 0,
      annualTaxEstimate: 1204.6470588235295,
      medianFailureYearRange: { min: 2050, max: 2053 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12390.617647058823,
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
      // Regenerated 2026-04-25 after the healthcare-engine ACA-gating
      // fix; same delta pattern as baseline-near-retirement (~$107k more
      // ending wealth, ~$850 less average healthcare cost). Earlier
      // 2026-04-23 re-baseline was for the TRP_2030 proxy tightening
      // (prior values 0.99 / 5.33M / 3873).
      successRate: 0.995,
      medianEndingWealth: 6078957.980721643,
      annualTaxEstimate: 4021.6470588235293,
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12307.823529411764,
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
      // 2026-04-25: ACA-bridge already retires Jan 2026 so post-fix
      // ACA cost behaves identically (engine still bills marketplace
      // premium because retirementStatus=true). Small re-pin for ending
      // wealth + tax drift inside tolerance; healthcare delta unchanged.
      successRate: 0.795,
      medianEndingWealth: 2032978.9741290263,
      annualTaxEstimate: 2079.176470588235,
      medianFailureYearRange: { min: 2051, max: 2054 },
      maxIrmaaTier: 1,
      averageHealthcarePremiumCost: 12301.176470588236,
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
      // Regenerated 2026-04-25 after the healthcare-engine ACA-gating
      // fix. Median ending wealth and tax barely budged (RMD-heavy
      // households are already past retirement age in this scenario);
      // averageHealthcarePremiumCost dropped ~$640 because the few
      // pre-retirement working years no longer carry an ACA charge.
      // Prior 2026-04-23 re-baseline was for TRP_2030 proxy tightening
      // (prior 12.27M / 45357 dates back to the 30%-US-equity proxy).
      // This scenario remains the tier-5 IRMAA canary it was intended as.
      successRate: 1,
      medianEndingWealth: 12957146.966157803,
      annualTaxEstimate: 45932.32352941176,
      maxIrmaaTier: 5,
      averageHealthcarePremiumCost: 16903.147058823528,
    },
    tolerance: {
      successRate: 0.02,
      medianEndingWealth: 400000,
      annualTaxEstimate: 1000,
    },
  },
];
