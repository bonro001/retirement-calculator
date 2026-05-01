import type { GoldenScenarioDefinition } from './verification-harness';

export const GOLDEN_SCENARIOS: GoldenScenarioDefinition[] = [
  {
    id: 'baseline-near-retirement',
    name: 'Baseline Near Retirement',
    selectedStressors: [],
    selectedResponses: [],
    pathKind: 'baseline',
    expected: {
      // 2026-04-29: re-pinned after the SS engine integration landed.
      // `getSocialSecurityIncome` in utils.ts now uses
      // `social-security.ts` which models the spousal-benefit floor —
      // Debbie's effective FRA benefit went from $1,444 own → $2,050
      // spousal floor (50% × Rob's $4,100 PIA) once Rob files. Net
      // effect on this scenario: solvency 0.89 → 0.96 (+7pp), median
      // ending wealth $3.41M → $3.94M (+$525k), tax $3796 → $3901
      // (+$105). All shifts in the "household has more income"
      // direction — the engine was previously undercounting Debbie by
      // ~$7,272/yr. Earlier 2026-04-25 was the healthcare-engine
      // ACA-gating fix.
      successRate: 0.96,
      medianEndingWealth: 3937365.0547095365,
      annualTaxEstimate: 3901,
      // 2026-04-29: failure year shifted earlier (2055-2057 → 2050-2054)
      // because higher solvency (96% vs 89%) means fewer failing trials,
      // concentrated in worse market sequences that crash earlier.
      medianFailureYearRange: { min: 2050, max: 2054 },
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
      // 2026-04-29: re-pinned after the SS engine integration landed
      // (spousal-floor support in `getSocialSecurityIncome`). For this
      // layoff+market_down stress scenario, the spousal floor lifted
      // Debbie's effective benefit and pulled solvency 0.42 → 0.595
      // (+17.5pp), median ending wealth $0 → $247k. The earlier
      // re-pin (Phase 2.2 LTC inflation fix) had already moved this
      // from 0.455 → 0.42; the SS lift now more than restores it.
      successRate: 0.595,
      medianEndingWealth: 247219.21721207135,
      annualTaxEstimate: 1117,
      // 2026-04-30: failure-year window shifted +1yr (2050-2053 → 2052-2055)
      // after FCNTX/FDGRX mappings reflected actual ~8% intl exposure.
      // Slight ending-wealth lift means the few failing trials fail later.
      medianFailureYearRange: { min: 2052, max: 2055 },
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
      // 2026-04-29: re-pinned after SS engine integration. Lower-
      // spending scenario was already at 0.995 solvency; SS lift
      // shows up in EW: $5.76M → $6.12M (+$358k). Tax $3999 → $4106.
      successRate: 0.995,
      medianEndingWealth: 6118287.33239286,
      annualTaxEstimate: 4106.205882352941,
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
      // 2026-04-29: re-pinned after SS engine integration. ACA-bridge
      // scenario benefits the most from the spousal floor because
      // retirement starts in 2026 with a long pre-SS period followed
      // by a long post-SS period (where the spousal floor compounds).
      // Solvency 0.765 → 0.835 (+7pp), median EW $1.86M → $2.46M
      // (+$605k), tax $2079 → $1886.
      successRate: 0.835,
      medianEndingWealth: 2462171.6093117557,
      annualTaxEstimate: 1886.3823529411766,
      // 2026-04-29: failure year window shifted later (2051-2054 → 2053-2056)
      // because the spousal floor extends solvency for failing trials.
      medianFailureYearRange: { min: 2053, max: 2056 },
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
      // 2026-04-29: re-pinned after SS engine integration. RMD-heavy
      // scenario is already at 100% solvency so the lift shows in EW:
      // $12.96M → $13.45M (+$492k). Earlier 2026-04-25 was healthcare-
      // engine ACA-gating; 2026-04-23 was TRP_2030 proxy tightening.
      // Remains the tier-5 IRMAA canary.
      successRate: 1,
      medianEndingWealth: 13449454.686288854,
      annualTaxEstimate: 46054.5,
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
