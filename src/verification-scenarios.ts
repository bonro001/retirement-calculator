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
      // 2026-04-29: re-pinned after Phase 2.2 LTC inflation fix
      // (calculateLtcCostForYear now inflates from year-zero, not from
      // event start, matching industry actuarial projections). Solvency
      // dropped 0.455 → 0.42 reflecting the more realistic LTC cost
      // projection. Within the corridor predicted in CALIBRATION_WORKPLAN
      // Phase 0.5 #2 ("1-3pp downward shift").
      successRate: 0.42,
      medianEndingWealth: 0,
      annualTaxEstimate: 1204.9117647058824,
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
      // 2026-04-29: re-pinned after Phase 2.2 LTC inflation fix.
      // Median ending wealth dropped $6.08M → $5.76M (-$319k, just over
      // prior $300k tolerance). The lower-spending scenario survives
      // most trials so the LTC impact shows up in EW rather than
      // solvency. Earlier 2026-04-25 re-baseline was for the
      // healthcare-engine ACA-gating fix.
      successRate: 0.995,
      medianEndingWealth: 5760070.09633492,
      annualTaxEstimate: 3999.205882352941,
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
      // 2026-04-29: re-pinned after Phase 2.2 LTC inflation fix.
      // Solvency dropped 0.795 → 0.765 (-3pp). ACA-bridge scenario is
      // long-horizon retirement so LTC events at age 85+ have full
      // impact. Earlier 2026-04-25 re-baseline was for the healthcare-
      // engine ACA-gating fix.
      successRate: 0.765,
      medianEndingWealth: 1857659.963307565,
      annualTaxEstimate: 2079.117647058823,
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
