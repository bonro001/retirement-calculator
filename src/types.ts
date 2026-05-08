export type ScreenId =
  | 'cockpit'
  | 'mining'
  | 'history'
  | 'accounts'
  | 'social_security'
  | 'taxes'
  | 'export'
  // Below: legacy IDs retained for code that hasn't been pruned yet.
  // They're not in the sidebar navigation, so the household can't
  // reach them — but the components still exist in App.tsx and would
  // throw type errors if removed before a proper cleanup pass.
  | 'overview'
  | 'plan2'
  | 'explore'
  | 'paths'
  | 'compare'
  | 'solver'
  | 'autopilot'
  | 'spending'
  | 'income'
  | 'stress'
  | 'simulation'
  | 'insights';

export type AccountBucketType = 'pretax' | 'roth' | 'taxable' | 'cash';

export interface Household {
  robBirthDate: string;
  debbieBirthDate: string;
  filingStatus: string;
  planningAge: number;
  state: string;
}

export interface SocialSecurityEntry {
  person: string;
  fraMonthly: number;
  /**
   * SS claim age is now an ENGINE OUTPUT, not a household input. Left
   * optional for backwards compatibility with seeds that still carry
   * a claimAge value, and for the engine's per-trial calculations
   * which need a default when running without the optimizer chain.
   *
   * When `claimAge` is undefined, the engine treats it as FRA (67 for
   * anyone born after 1960) — a neutral baseline. The Cockpit's
   * `usePlanOptimization` always overrides this with the optimizer's
   * recommended pair before projecting the headline numbers, so
   * end-users never see the FRA fallback in practice.
   *
   * To get a different SS strategy, call `findOptimalSocialSecurityClaim`
   * (which sweeps 65..70 × 65..70) and clone the seed with the
   * recommended pair before calling `buildPathResults`.
   */
  claimAge: number;
}

export interface EmployerMatchFormula {
  matchRate: number;
  maxEmployeeContributionPercentOfSalary: number;
  assumptionSource?: string;
  verificationStatus?: 'verified' | 'user_confirmed_pending_document' | 'estimated';
}

export interface PreRetirementContributionSettings {
  employee401kPreTaxAnnualAmount?: number;
  employee401kPreTaxAnnualAmountByYear?: Record<string, number>;
  employee401kPreTaxPercentOfSalary?: number;
  employee401kRothAnnualAmount?: number;
  employee401kRothAnnualAmountByYear?: Record<string, number>;
  employee401kRothPercentOfSalary?: number;
  priorYearFicaWagesFromEmployer?: number;
  employerPlanSupportsRothDeferrals?: boolean;
  employerPlanSupportsSuperCatchUp?: boolean;
  planFeatureAssumptionSource?: string;
  // Legacy compatibility fields. When present, they map to pre-tax 401(k) targets.
  employee401kAnnualAmount?: number;
  employee401kAnnualAmountByYear?: Record<string, number>;
  employee401kPercentOfSalary?: number;
  employerMatch?: EmployerMatchFormula;
  hsaAnnualAmount?: number;
  hsaAnnualAmountByYear?: Record<string, number>;
  hsaPercentOfSalary?: number;
  hsaCoverageType?: 'self' | 'family';
}

export interface ContributionLimitSettings {
  employee401kBaseLimit?: number;
  employee401kCatchUpAge?: number;
  employee401kCatchUpLimit?: number;
  employee401kSuperCatchUpAges?: number[];
  employee401kSuperCatchUpLimit?: number;
  rothCatchUpWageThreshold?: number;
  employee401kBaseLimitByYear?: Record<string, number>;
  employee401kCatchUpLimitByYear?: Record<string, number>;
  employee401kSuperCatchUpLimitByYear?: Record<string, number>;
  rothCatchUpWageThresholdByYear?: Record<string, number>;
  hsaSelfLimit?: number;
  hsaFamilyLimit?: number;
  hsaCatchUpAge?: number;
  hsaCatchUpLimit?: number;
  hsaSelfLimitByYear?: Record<string, number>;
  hsaFamilyLimitByYear?: Record<string, number>;
  hsaCatchUpLimitByYear?: Record<string, number>;
  assumptionSource?: string;
}

export interface HousingAfterDownsizePolicy {
  mode?: 'own_replacement_home';
  startYear?: number;
  replacementHomeCost?: number;
  netLiquidityTarget?: number;
  postSaleAnnualTaxesInsurance?: number;
  certainty?: 'certain' | 'estimated' | 'uncertain';
  assumptionSource?: string;
}

export type WindfallTaxTreatment =
  | 'cash_non_taxable'
  | 'ordinary_income'
  | 'ltcg'
  | 'primary_home_sale'
  | 'inherited_ira_10y';

export interface WindfallEntry {
  name: string;
  year: number;
  amount: number;
  taxTreatment?: WindfallTaxTreatment;
  // Confidence classification for timing/amount assumptions.
  certainty?: 'certain' | 'estimated' | 'uncertain';
  // When certainty is not "certain", this captures potential timing drift.
  timingUncertaintyYears?: number;
  // When certainty is not "certain", this captures potential amount drift.
  amountUncertaintyPercent?: number;
  // Net cash available to the planning portfolio after reinvestment/uses.
  // If omitted, the model assumes full amount is available as liquidity.
  liquidityAmount?: number;
  // For taxable windfalls and home sales, used to estimate taxable gain.
  costBasis?: number;
  // For home sales, modeled transaction frictions.
  sellingCostPercent?: number;
  // For downsizing: purchase price of the next home, reducing investable liquidity.
  replacementHomeCost?: number;
  // For downsizing: buyer-side closing/friction cost on the replacement home.
  purchaseClosingCostPercent?: number;
  // For downsizing: moving, repairs, furnishing, and transition cash uses.
  movingCost?: number;
  // For primary-home-sale treatment, this exclusion is applied against gain.
  exclusionAmount?: number;
  // For inherited IRA treatment, defaulted to 10 when omitted.
  distributionYears?: number;
  // For windfalls held in a market account between today and `year`,
  // optionally compound the entered amount by this REAL rate of return
  // (per year). When set, the engine multiplies amount and liquidity by
  // (1 + presentValueGrowthRate)^(year - currentPlanningYear) before
  // crediting. Models the case where the source account (e.g., a parent's
  // brokerage holding the future gift / inheritance) is invested and
  // growing in real terms while it waits to land. When undefined,
  // current behavior is preserved (no growth applied — entered amount
  // is taken as the year-of-arrival amount in today's dollars).
  presentValueGrowthRate?: number;
}

export interface IncomeData {
  salaryAnnual: number;
  salaryEndDate: string;
  socialSecurity: SocialSecurityEntry[];
  windfalls: WindfallEntry[];
  preRetirementContributions?: PreRetirementContributionSettings;
  sabbatical?: SabbaticalObligation;
}

export interface SabbaticalObligation {
  returnDate: string;
  paidWeeks: number;
  weeksForgivenPerMonth: number;
}

export interface SpendingData {
  essentialMonthly: number;
  optionalMonthly: number;
  annualTaxesInsurance: number;
  travelEarlyRetirementAnnual: number;
  // Optional per-category minimums; when omitted, defaults are inferred.
  essentialMinimumMonthly?: number;
  optionalMinimumMonthly?: number;
  travelMinimumAnnual?: number;
}

export interface Holding {
  symbol: string;
  name?: string;
  value: number;
}

export interface SourceAccount {
  id: string;
  name: string;
  balance: number;
  owner?: 'rob' | 'debbie' | string;
  managed?: boolean;
  holdings?: Holding[];
}

export interface AccountBucket {
  balance: number;
  targetAllocation: Record<string, number>;
  sourceAccounts?: SourceAccount[];
}

export interface AccountsData {
  pretax: AccountBucket;
  roth: AccountBucket;
  taxable: AccountBucket;
  cash: AccountBucket;
  hsa?: AccountBucket;
}

export interface RulesData {
  withdrawalStyle: string;
  irmaaAware: boolean;
  replaceModeImports: boolean;
  rothConversionPolicy?: {
    enabled?: boolean;
    strategy?: 'aca_then_irmaa_headroom' | 'irmaa_headroom_only';
    minAnnualDollars?: number;
    /** Annual Roth conversion maximum. Older saved plans may not have it;
     *  those are migrated from the former magi-buffer proxy in buildPlan. */
    maxAnnualDollars?: number;
    maxPretaxBalancePercent?: number;
    magiBufferDollars?: number;
    lowIncomeBracketFill?: {
      enabled?: boolean;
      startYear?: number;
      endYear?: number;
      annualTargetDollars?: number;
      requireNoWageIncome?: boolean;
    };
  };
  assetClassMappingAssumptions?: {
    TRP_2030?: {
      US_EQUITY: number;
      INTL_EQUITY: number;
      BONDS: number;
      CASH: number;
    };
    CENTRAL_MANAGED?: {
      US_EQUITY: number;
      INTL_EQUITY: number;
      BONDS: number;
      CASH: number;
    };
  };
  assetClassMappingEvidence?: {
    TRP_2030?: 'exact_lookthrough' | 'proxy';
    CENTRAL_MANAGED?: 'exact_lookthrough' | 'proxy';
  };
  rmdPolicy?: {
    startAgeOverride?: number;
    source?: 'explicit_override' | 'legislation_default';
  };
  payrollModel?: {
    takeHomeFactor?: number;
    salaryProrationRule?: 'month_fraction' | 'daily';
    salaryProrationSource?: 'explicit_payroll_calendar' | 'assumed_month_fraction';
  };
  contributionLimits?: ContributionLimitSettings;
  housingAfterDownsizePolicy?: HousingAfterDownsizePolicy;
  healthcarePremiums?: {
    baselineAcaPremiumAnnual: number;
    baselineMedicarePremiumAnnual: number;
    medicalInflationAnnual?: number;
  };
  hsaStrategy?: {
    enabled: boolean;
    /**
     * How tax-free HSA withdrawals are used in the simulation.
     * - high_magi_years: legacy behavior; reimburse qualified costs only when MAGI is high.
     * - ongoing_qualified_expenses: reimburse modeled qualified medical/LTC costs every year.
     * - ltc_reserve: preserve HSA for LTC/large medical tail events only.
     */
    withdrawalMode?: 'high_magi_years' | 'ongoing_qualified_expenses' | 'ltc_reserve';
    annualQualifiedExpenseWithdrawalCap?: number;
    prioritizeHighMagiYears?: boolean;
    highMagiThreshold?: number;
  };
  ltcAssumptions?: {
    enabled: boolean;
    startAge: number;
    annualCostToday: number;
    durationYears: number;
    inflationAnnual?: number;
    // Probability that an LTC event occurs for the household within the modeled window.
    eventProbability?: number;
  };
}

export interface Stressor {
  id: string;
  name: string;
  type: string;
  salaryEndsEarly?: boolean;
  equityReturns?: number[];
  recoveryYears?: number;
  rate?: number;
  duration?: number;
}

export interface ResponseOption {
  id: string;
  name: string;
  optionalReductionPercent?: number;
  triggerYear?: number;
  amount?: number;
  delayYears?: number;
  claimAge?: number;
}

export interface SeedData {
  household: Household;
  income: IncomeData;
  spending: SpendingData;
  accounts: AccountsData;
  rules: RulesData;
  stressors: Stressor[];
  responses: ResponseOption[];
  goals?: {
    legacyTargetTodayDollars?: number | null;
    [key: string]: unknown;
  };
}

export interface GuardrailTier {
  id: string;
  triggerFundedYears: number;
  action: 'cut_optional' | 'cut_travel' | 'sell_house' | 'claim_ss_early';
  amountPercent?: number;
  label?: string;
}

export interface MarketAssumptions {
  equityMean: number;
  equityVolatility: number;
  internationalEquityMean: number;
  internationalEquityVolatility: number;
  bondMean: number;
  bondVolatility: number;
  cashMean: number;
  cashVolatility: number;
  inflation: number;
  inflationVolatility: number;
  simulationRuns: number;
  irmaaThreshold: number;
  guardrailFloorYears: number;
  guardrailCeilingYears: number;
  guardrailCutPercent: number;
  robPlanningEndAge: number;
  debbiePlanningEndAge: number;
  travelPhaseYears: number;
  pivotSellHouseFloorYears?: number;
  pivotClaimSSEarlyFloorYears?: number;
  guardrailLadder?: GuardrailTier[];
  simulationSeed?: number;
  assumptionsVersion?: string;
  // Opt-in: sample correlated asset-class returns via a fixed Cholesky
  // factor of long-run US correlations (US/INTL 0.85, US/BONDS 0.15,
  // BONDS/CASH 0.20, equity↔cash 0). Defaults to false (independent
  // samples) to preserve backward compatibility with existing goldens.
  useCorrelatedReturns?: boolean;
  // Opt-in: for each simulated year, sample a complete asset-class return
  // + inflation tuple from the historical annual-returns fixture instead
  // of drawing from bounded normals. Preserves historical skew, kurtosis,
  // and cross-asset correlation "for free" — matches what Fidelity's MC
  // explicitly does ("historical performance, risk, and correlation").
  // When enabled, `useCorrelatedReturns`, mean/stdDev parameters, and the
  // bounded-normal clip become no-ops for asset returns and inflation.
  // Stress overlays still apply on top.
  useHistoricalBootstrap?: boolean;
  // When useHistoricalBootstrap is true, sample in multi-year BLOCKS
  // instead of drawing each year independently. Preserves multi-year
  // autocorrelation (bad years cluster, crises last more than one year)
  // that iid-by-year bootstrap loses. Default 1 = iid.
  historicalBootstrapBlockLength?: number;
  // Phase 2.B perf: which sampler the engine uses for the per-year
  // 4-asset return shocks (US/INTL/BONDS/CASH). Defaults to 'mc' —
  // independent Mulberry32-driven Box-Muller normals, identical to
  // pre-Phase-2 behavior. Setting 'qmc' switches the asset-return
  // shocks to a deterministic 4-dim Sobol sequence (per-trial offset)
  // mapped through Wichura AS241 inverse-normal CDF, then through the
  // existing Cholesky correlation step. Other random consumers
  // (inflation, historical-bootstrap year sampling, LTC events) keep
  // using the seeded Mulberry32 stream — only the dominant variance
  // contributor (asset returns) is QMC-stratified. Empirically this
  // hybrid gives ~2-3× faster convergence than pure MC for our smooth
  // outcome metrics. When 'qmc', `MarketAssumptions.simulationSeed`
  // selects which Sobol sub-stream is used (different seeds → disjoint
  // sub-streams with no overlap up to 2^32 points).
  samplingStrategy?: 'mc' | 'qmc';
  // Maximum simulated years per trial; only used when samplingStrategy
  // is 'qmc' to size each trial's Sobol sub-stream offset. Default 60.
  // Trials that exceed this would silently re-use Sobol points from the
  // next trial's sub-stream, slightly weakening (but not breaking)
  // independence — set this safely above your actual horizon.
  maxYearsPerTrial?: number;
  /**
   * Equity-return tail-shape mode. Default 'normal' = bounded-normal
   * sampler (the engine's pre-2026-04-30 behavior). 'crash_mixture'
   * adds left-tail mass via a small per-year probability of a draw
   * from a curated list of historical worst equity years (1931, 2008,
   * 1937, 1974, 2002), recalibrating the non-crash mean to preserve
   * the overall `equityMean`. Closes the Fidelity p10 tail gap in
   * default *parametric* mode without changing the central
   * distribution shape. Has no effect when `useHistoricalBootstrap`
   * is true (that mode already samples from real history).
   */
  equityTailMode?: 'normal' | 'crash_mixture';
  // Optional deterministic mortality. When set, the engine treats the
  // named spouse as deceased starting in years where their age exceeds
  // this value. Today this only affects SS income (survivor switch
  // fires when the higher earner dies; surviving spouse converts to
  // 100% of the higher earner's claim amount). Spending continues to
  // the planning end age regardless — the household plans for legacy
  // longevity (95) and the death-age fields surface "what if one of
  // us dies earlier" as a sensitivity. When undefined, both spouses
  // are alive through planning end age (status quo before 2026-04-30).
  robDeathAge?: number;
  debbieDeathAge?: number;
  /**
   * Withdrawal rule — how each year's spending need is split across the
   * four account buckets. Default `tax_bracket_waterfall` matches
   * pre-2026-05-01 engine behavior. Mining sweeps this axis to find the
   * rule that best fits the household's stated north stars.
   */
  withdrawalRule?: WithdrawalRule;
}

export interface BoldinBenchmark {
  successRate: number | null;
  medianEndingWealth: number | null;
  medianFailureYear: number | null;
  annualTaxEstimate: number | null;
}

export interface PathYearResult {
  year: number;
  medianAssets: number;
  /** End-of-year balance per bucket (today's $ at sim resolution; nominal
   *  in trace, but median across runs). Used by the Cockpit's
   *  account-balance-by-time chart so the household can see how the mix
   *  shifts: pretax depleting via RMDs, Roth growing, etc. */
  medianPretaxBalance: number;
  medianTaxableBalance: number;
  medianRothBalance: number;
  medianCashBalance: number;
  tenthPercentileAssets: number;
  medianIncome: number;
  medianSocialSecurityIncome: number;
  medianSocialSecurityRob: number;
  medianSocialSecurityDebbie: number;
  medianSocialSecurityInflationIndex: number;
  robSocialSecurityClaimFactor: number;
  debbieSocialSecurityClaimFactor: number;
  robSocialSecuritySpousalFloorMonthly: number;
  debbieSocialSecuritySpousalFloorMonthly: number;
  medianSpending: number;
  medianFederalTax: number;
  medianTotalCashOutflow: number;
  medianWithdrawalTotal: number;
  medianUnresolvedFundingGap: number;
  medianRmdAmount: number;
  medianWithdrawalCash: number;
  medianWithdrawalTaxable: number;
  medianWithdrawalIra401k: number;
  medianWithdrawalRoth: number;
  medianRothConversion: number;
  dominantRothConversionReason: string;
  dominantRothConversionMotive: 'none' | 'opportunistic_headroom' | 'defensive_pressure';
  medianRothConversionOpportunistic: number;
  medianRothConversionDefensive: number;
  medianRothConversionMagiEffect: number;
  medianRothConversionTaxEffect: number;
  medianRothConversionAcaEffect: number;
  medianRothConversionIrmaaEffect: number;
  medianRothConversionPretaxBalanceEffect: number;
  medianTaxableIncome: number;
  medianMagi: number;
  dominantIrmaaTier: string;
  medianMedicareSurcharge: number;
  medianEmployee401kContribution: number;
  medianEmployerMatchContribution: number;
  medianTotal401kContribution: number;
  medianHsaContribution: number;
  medianAdjustedWages: number;
  medianTaxableWageReduction: number;
  medianPretaxBalanceAfterContributions: number;
  medianAcaPremiumEstimate: number;
  medianAcaSubsidyEstimate: number;
  medianNetAcaCost: number;
  medianMedicarePremiumEstimate: number;
  medianIrmaaSurcharge: number;
  medianTotalHealthcarePremiumCost: number;
  medianWindfallCashInflow: number;
  medianWindfallOrdinaryIncome: number;
  medianWindfallLtcgIncome: number;
  medianHomeSaleGrossProceeds: number;
  medianHomeSaleSellingCosts: number;
  medianHomeReplacementPurchaseCost: number;
  medianHomeDownsizeNetLiquidity: number;
  medianHsaOffsetUsed: number;
  medianHsaLtcOffsetUsed: number;
  medianLtcCostRemainingAfterHsa: number;
  medianHsaBalance: number;
  medianLtcCost: number;
  ltcHsaPathVisibility?: LtcHsaPathVisibility;
  dominantWithdrawalRationale: string;
  medianWithdrawalScoreSpendingNeed: number;
  medianWithdrawalScoreMarginalTaxCost: number;
  medianWithdrawalScoreMagiTarget: number;
  medianWithdrawalScoreAcaCliffAvoidance: number;
  medianWithdrawalScoreIrmaaCliffAvoidance: number;
  medianWithdrawalScoreRothOptionality: number;
  medianWithdrawalScoreSequenceDefense: number;
  closedLoopConverged: boolean;
  closedLoopConvergedRate: number;
  closedLoopConvergedBeforeMaxPasses: boolean;
  closedLoopConvergedBeforeMaxPassesRate: number;
  closedLoopPassesUsed: number;
  medianClosedLoopPassesUsed: number;
  closedLoopStopReason: string;
  finalMagiDelta: number;
  finalFederalTaxDelta: number;
  finalHealthcarePremiumDelta: number;
  medianClosedLoopLastMagiDelta: number;
  medianClosedLoopLastFederalTaxDelta: number;
  medianClosedLoopLastHealthcarePremiumDelta: number;
  dominantClosedLoopStopReason: string;
  cashflowReconciliation?: {
    method: string;
    inflows: {
      income: number;
      adjustedWages: number;
      socialSecurity: number;
      rmd: number;
      windfallCash: number;
    };
    withdrawals: {
      cash: number;
      taxable: number;
      ira401k: number;
      roth: number;
      total: number;
    };
    outflows: {
      spendingIncludingHealthcareAndLtc: number;
      federalTax: number;
      healthcarePremiums: number;
      ltcCost: number;
      hsaOffset: number;
      total: number;
    };
    totalAvailableForOutflows: number;
    surplusOrGap: number;
    unresolvedFundingGap: number;
    equationCheck: {
      availableMinusOutflowsMinusSurplusOrGap: number;
    };
    notes: string[];
  };
}

export interface ProjectionPoint {
  year: number;
  baseline: number;
  stressed: number;
  spending: number;
  income: number;
}

export type SimulationStrategyMode = 'planner_enhanced' | 'raw_simulation';

/**
 * The household's withdrawal rule — how each year's spending need is
 * split across the four account buckets (cash, taxable, pretax, roth).
 * Independent of `SimulationStrategyMode`, which controls awareness
 * (cliff/IRMAA defense, dynamic ordering, Roth preservation).
 *
 * - `tax_bracket_waterfall`: cash → taxable → pretax → roth. Drains the
 *   most-taxed bucket first, preserves tax-free for last. Matches the
 *   engine's historical default behavior. The canonical advice for most
 *   households.
 * - `proportional`: split each year's need pro-rata across all buckets
 *   by balance. The "naive" rule — no tax optimization, but easy to
 *   explain and surprisingly competitive in some scenarios.
 * - `reverse_waterfall`: cash → roth → pretax → taxable. Spend Roth
 *   first; defensive against future tax-rate hikes (you've already
 *   paid the tax on Roth, so you lock in today's rate on the rest).
 * - `guyton_klinger`: tax_bracket_waterfall PLUS guardrails forced on
 *   regardless of `SimulationStrategyMode`. Dynamic spend cuts when
 *   funded years drops below the floor, restored above the ceiling.
 */
export type WithdrawalRule =
  | 'tax_bracket_waterfall'
  | 'proportional'
  | 'reverse_waterfall'
  | 'guyton_klinger';

export interface ClosedLoopConvergenceThresholds {
  magiDeltaDollars: number;
  federalTaxDeltaDollars: number;
  healthcarePremiumDeltaDollars: number;
}

export interface SimulationTimingConventions {
  currentPlanningYear: number;
  salaryProrationRule: 'month_fraction';
  inflationCompounding: 'annual';
}

export interface BoundedNormalReturnGenerationAssumptions {
  model: 'bounded_normal_by_asset_class';
  boundsByAssetClass: {
    US_EQUITY: { min: number; max: number };
    INTL_EQUITY: { min: number; max: number };
    BONDS: { min: number; max: number };
    CASH: { min: number; max: number };
  };
  stressOverlayRules: string[];
}

export interface FutureReturnModelExtensionPoint {
  model: 'regime_switching_correlated' | 'fat_tailed_correlated';
  status: 'hook_only';
  description: string;
}

export type SimulationReturnGenerationAssumptions =
  BoundedNormalReturnGenerationAssumptions;

export interface SimulationConfigurationSnapshot {
  mode: SimulationStrategyMode;
  plannerLogicActive: boolean;
  activeStressors: string[];
  activeResponses: string[];
  withdrawalPolicy: {
    order: string[];
    dynamicDefenseOrdering: boolean;
    irmaaAware: boolean;
    acaAware: boolean;
    preserveRothPreference: boolean;
    closedLoopHealthcareTaxIteration: boolean;
    maxClosedLoopPasses: number;
    closedLoopConvergenceThresholds: ClosedLoopConvergenceThresholds;
  };
  rothConversionPolicy: {
    proactiveConversionsEnabled: boolean;
    strategy: 'aca_then_irmaa_headroom' | 'irmaa_headroom_only';
    minAnnualDollars: number;
    maxAnnualDollars: number | null;
    maxPretaxBalancePercent: number;
    magiBufferDollars: number;
    lowIncomeBracketFill?: {
      enabled: boolean;
      startYear: number | null;
      endYear: number | null;
      annualTargetDollars: number;
      requireNoWageIncome: boolean;
    };
    source: 'rules' | 'default';
    description: string;
  };
  liquidityFloorBehavior: {
    guardrailsEnabled: boolean;
    floorYears: number;
    ceilingYears: number;
    cutPercent: number;
  };
  inflationHandling: {
    baseMean: number;
    volatility: number;
    highInflationStressorFloor: number;
    highInflationStressorDurationYears: number;
  };
  returnGeneration: SimulationReturnGenerationAssumptions;
  returnModelExtensionPoints: FutureReturnModelExtensionPoint[];
  timingConventions: SimulationTimingConventions;
  simulationSettings: {
    seed: number;
    runCount: number;
    assumptionsVersion: string;
  };
}

export interface SimulationModeDiagnostics {
  effectiveSpendPath: Array<{ year: number; value: number }>;
  withdrawalPath: Array<{
    year: number;
    cash: number;
    taxable: number;
    ira401k: number;
    roth: number;
  }>;
  withdrawalRationalePath: Array<{
    year: number;
    rationale: string;
    objectiveScores: {
      spendingNeed: number;
      marginalTaxCost: number;
      magiTarget: number;
      acaCliffAvoidance: number;
      irmaaCliffAvoidance: number;
      rothOptionality: number;
      sequenceDefense: number;
    };
  }>;
  taxesPaidPath: Array<{ year: number; value: number }>;
  magiPath: Array<{ year: number; value: number }>;
  conversionPath: Array<{ year: number; value: number }>;
  rothConversionTracePath: Array<{
    year: number;
    amount: number;
    reason: string;
    motive: 'none' | 'opportunistic_headroom' | 'defensive_pressure';
    conversionKind: 'none' | 'safe_room' | 'strategic_extra';
    opportunisticAmount: number;
    defensiveAmount: number;
    safeRoomAvailable: number;
    safeRoomUsed: number;
    strategicExtraAvailable: number;
    strategicExtraUsed: number;
    annualPolicyMax: number | null;
    annualPolicyMaxBinding: boolean;
    safeRoomUnusedDueToAnnualPolicyMax: number;
    simulationModeUsedForConversion: SimulationStrategyMode;
    plannerLogicActiveAtConversion: boolean;
    conversionEngineInvoked: boolean;
    evaluatedCandidateAmounts: number[];
    bestCandidateAmount: number;
    bestScore: number;
    conversionExecuted: boolean;
    rawMAGI: number;
    irmaaThreshold: number | null;
    computedHeadroom: number;
    magiBuffer: number;
    headroomComputed: boolean;
    candidateAmountsGenerated: boolean;
    eligibilityBlockedReason: string | null;
    conversionReason: string;
    conversionScore: number;
    currentTaxCost: number;
    futureTaxReduction: number;
    irmaaAvoidanceValue: number;
    rmdReductionValue: number;
    rothOptionalityValue: number;
    conversionSuppressedReason: string | null;
    magiEffect: number;
    taxEffect: number;
    acaEffect: number;
    irmaaEffect: number;
    pretaxBalanceEffect: number;
    withdrawalRoth: number;
    representativeWithdrawalRoth: number;
    rothBalanceStart: number;
    rothBalanceEnd: number;
    rothContributionFlow: number;
    rothMarketGainLoss: number;
    rothNetChange: number;
    rothBalanceReconciliationDelta: number;
  }>;
  rothConversionEligibilityPath: Array<{
    year: number;
    simulationModeUsedForConversion: SimulationStrategyMode;
    plannerLogicActiveAtConversion: boolean;
    conversionEngineInvoked: boolean;
    evaluatedCandidateAmounts: number[];
    bestCandidateAmount: number;
    bestScore: number;
    conversionExecuted: boolean;
    rawMAGI: number;
    irmaaThreshold: number | null;
    computedHeadroom: number;
    magiBuffer: number;
    headroomComputed: boolean;
    candidateAmountsGenerated: boolean;
    eligibilityBlockedReason: string | null;
    executedRunRate: number;
    eligibleRunRate: number;
    blockedRunRate: number;
    noEconomicBenefitRunRate: number;
    notEligibleRunRate: number;
    representativeAmount: number;
    representativeReason: string;
    representativeMotive: 'none' | 'opportunistic_headroom' | 'defensive_pressure';
    representativeConversionKind: 'none' | 'safe_room' | 'strategic_extra';
    representativeOpportunisticAmount: number;
    representativeDefensiveAmount: number;
    safeRoomAvailable: number;
    safeRoomUsed: number;
    strategicExtraAvailable: number;
    strategicExtraUsed: number;
    annualPolicyMax: number | null;
    annualPolicyMaxBinding: boolean;
    safeRoomUnusedDueToAnnualPolicyMax: number;
    representativeMagiEffect: number;
    representativeTaxEffect: number;
    representativeAcaEffect: number;
    representativeIrmaaEffect: number;
    representativePretaxBalanceEffect: number;
    representativeWithdrawalRoth: number;
    representativeRothBalanceStart: number;
    representativeRothBalanceEnd: number;
    representativeRothContributionFlow: number;
    representativeRothMarketGainLoss: number;
    representativeRothNetChange: number;
    representativeRothBalanceReconciliationDelta: number;
    withdrawalRothMedianAllRuns: number;
    conversionScore: number;
    conversionOpportunityScore: number;
    futureTaxReduction: number;
    futureTaxBurdenReduction: number;
    irmaaAvoidanceValue: number;
    rmdReductionValue: number;
    rothOptionalityValue: number;
    future_tax_reduction_value: number;
    currentTaxCost: number;
    conversionSuppressedReason: string | null;
    projectedFutureMagiPeak: number;
    projectedRmdPressure: number;
    projectedIrmaaExposure: number;
    projectedRothShareAfter: number;
    medianMagiBefore: number;
    medianMagiAfter: number;
    medianTargetMagiCeiling: number | null;
  }>;
  rothConversionDecisionSummary: {
    executedYearCount: number;
    safeRoomExecutedYearCount: number;
    strategicExtraExecutedYearCount: number;
    annualPolicyMaxBindingYearCount: number;
    totalSafeRoomUsed: number;
    totalStrategicExtraUsed: number;
    totalSafeRoomUnusedDueToAnnualPolicyMax: number;
    blockedYearCount: number;
    noEconomicBenefitYearCount: number;
    notEligibleYearCount: number;
    reasons: Array<{
      reason: string;
      count: number;
      rate: number;
    }>;
  };
  failureYearDistribution: Array<{ year: number; count: number; rate: number }>;
  closedLoopConvergenceSummary: {
    converged: boolean;
    convergedRate: number;
    passesUsed: number;
    stopReason: string;
    finalMagiDelta: number;
    finalFederalTaxDelta: number;
    finalHealthcarePremiumDelta: number;
    convergedBeforeMaxPasses: boolean;
    convergedBeforeMaxPassesRate: number;
  };
  closedLoopConvergencePath: Array<{
    year: number;
    converged: boolean;
    convergedRate: number;
    passesUsed: number;
    stopReason: string;
    finalMagiDelta: number;
    finalFederalTaxDelta: number;
    finalHealthcarePremiumDelta: number;
    convergedBeforeMaxPasses: boolean;
    convergedBeforeMaxPassesRate: number;
  }>;
  closedLoopRunSummary: {
    runCount: number;
    convergedRunCount: number;
    nonConvergedRunCount: number;
    convergedRunRate: number;
    stopReasonCounts: {
      converged_thresholds_met: number;
      max_pass_limit_reached: number;
      no_change: number;
      oscillation_detected: number;
    };
    nonConvergedRunIndexes: number[];
  };
  closedLoopRunConvergence: Array<{
    runIndex: number;
    converged: boolean;
    convergedYearRate: number;
    yearsEvaluated: number;
    passesUsedMax: number;
    stopReasonCounts: {
      converged_thresholds_met: number;
      max_pass_limit_reached: number;
      no_change: number;
      oscillation_detected: number;
    };
    finalMagiDeltaMax: number;
    finalFederalTaxDeltaMax: number;
    finalHealthcarePremiumDeltaMax: number;
  }>;
}

export interface SimulationRiskMetrics {
  earlyFailureProbability: number;
  medianFailureShortfallDollars: number;
  medianDownsideSpendingCutRequired: number;
  worstDecileEndingWealth: number;
  equitySalesInAdverseEarlyYearsRate: number;
}

export interface MoneyPercentileSummary {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface LtcHsaPathVisibility {
  ltcEventTriggeredRate: number;
  ltcEventActiveRate: number;
  ltcCostPercentiles: MoneyPercentileSummary;
  hsaOffsetUsedPercentiles: MoneyPercentileSummary;
  hsaLtcOffsetUsedPercentiles: MoneyPercentileSummary;
  ltcCostRemainingAfterHsaPercentiles: MoneyPercentileSummary;
  hsaBalancePercentiles: MoneyPercentileSummary;
}

export interface LtcHsaDeterministicAuditYear {
  year: number;
  robAge: number;
  debbieAge: number;
  ltcEventActive: boolean;
  ltcCost: number;
  hsaOffsetUsed: number;
  hsaLtcOffsetUsed: number;
  ltcCostRemainingAfterHsa: number;
  hsaBalanceEnd: number;
}

export interface LtcHsaDiagnostics {
  assumptions: {
    enabled: boolean;
    startAge: number;
    annualCostToday: number;
    durationYears: number;
    inflationAnnual: number;
    eventProbability: number;
  };
  hsaStrategy: {
    enabled: boolean;
    withdrawalMode: string;
    annualQualifiedExpenseWithdrawalCap: number | 'uncapped';
  };
  monteCarlo: {
    trialCount: number;
    ltcEventRunCount: number;
    ltcEventIncidenceRate: number;
    ltcCostYearCountPercentiles: MoneyPercentileSummary;
    totalLtcCostPercentiles: MoneyPercentileSummary;
    totalHsaOffsetUsedPercentiles: MoneyPercentileSummary;
    totalHsaLtcOffsetUsedPercentiles: MoneyPercentileSummary;
    totalLtcCostRemainingAfterHsaPercentiles: MoneyPercentileSummary;
  };
  annualPath: Array<{
    year: number;
    ltcEventTriggeredRate: number;
    ltcEventActiveRate: number;
    ltcCostPercentiles: MoneyPercentileSummary;
    hsaOffsetUsedPercentiles: MoneyPercentileSummary;
    hsaLtcOffsetUsedPercentiles: MoneyPercentileSummary;
    ltcCostRemainingAfterHsaPercentiles: MoneyPercentileSummary;
    hsaBalancePercentiles: MoneyPercentileSummary;
  }>;
  deterministicAudit: {
    method: 'isolated_ltc_hsa_reserve_trace';
    noEvent: LtcHsaDeterministicAuditYear[];
    withEvent: LtcHsaDeterministicAuditYear[];
    expectedValue: LtcHsaDeterministicAuditYear[];
    notes: string[];
  };
}

export type InputFidelityStatus = 'exact' | 'estimated' | 'inferred' | 'missing';
export type ReliabilityImpactLevel = 'low' | 'medium' | 'high';

export interface ModelFidelityInput {
  id: string;
  label: string;
  status: InputFidelityStatus;
  reliabilityImpact: ReliabilityImpactLevel;
  blocking: boolean;
  detail: string;
}

export interface ModelFidelityAssessment {
  score: number;
  modelFidelityScore: number;
  modelCompleteness: 'faithful' | 'reconstructed';
  assessmentGrade: 'exploratory' | 'planning_grade' | 'decision_grade';
  blockingAssumptions: string[];
  softAssumptions: string[];
  effectOnReliability: string;
  inputs: ModelFidelityInput[];
}

export interface SimulationParityModeSummary {
  label: 'Raw Simulation' | 'Planner-Enhanced Simulation';
  mode: SimulationStrategyMode;
  successRate: number;
  medianEndingWealth: number;
  medianFailureYear: number | null;
  annualFederalTaxEstimate: number;
  plannerLogicActive: boolean;
  simulationConfiguration: SimulationConfigurationSnapshot;
  diagnostics: SimulationModeDiagnostics;
}

export interface SimulationParityReport {
  rawSimulation: SimulationParityModeSummary;
  plannerEnhancedSimulation: SimulationParityModeSummary;
  successRateDelta: number;
  medianEndingWealthDelta: number;
  annualFederalTaxDelta: number;
  seed: number;
  runCount: number;
  assumptionsVersion: string;
}

export interface PathResult {
  id: string;
  label: string;
  simulationMode: SimulationStrategyMode;
  plannerLogicActive: boolean;
  successRate: number;
  medianEndingWealth: number;
  tenthPercentileEndingWealth: number;
  yearsFunded: number;
  medianFailureYear: number | null;
  spendingCutRate: number;
  irmaaExposureRate: number;
  homeSaleDependenceRate: number;
  inheritanceDependenceRate: number;
  flexibilityScore: number;
  cornerRiskScore: number;
  rothDepletionRate: number;
  annualFederalTaxEstimate: number;
  irmaaExposure: 'Low' | 'Medium' | 'High';
  cornerRisk: 'Low' | 'Medium' | 'High';
  failureMode: string;
  notes: string;
  stressors: string[];
  responses: string[];
  endingWealthPercentiles: {
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  };
  failureYearDistribution: Array<{
    year: number;
    count: number;
    rate: number;
  }>;
  worstOutcome: {
    endingWealth: number;
    success: boolean;
    failureYear: number | null;
  };
  bestOutcome: {
    endingWealth: number;
    success: boolean;
    failureYear: number | null;
  };
  monteCarloMetadata: {
    seed: number;
    trialCount: number;
    assumptionsVersion: string;
    planningHorizonYears: number;
  };
  simulationConfiguration: SimulationConfigurationSnapshot;
  simulationDiagnostics: SimulationModeDiagnostics;
  riskMetrics: SimulationRiskMetrics;
  ltcHsaDiagnostics?: LtcHsaDiagnostics;
  yearlySeries: PathYearResult[];
}
