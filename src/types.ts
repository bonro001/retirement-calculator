export type ScreenId =
  | 'overview'
  | 'paths'
  | 'compare'
  | 'solver'
  | 'autopilot'
  | 'accounts'
  | 'spending'
  | 'income'
  | 'taxes'
  | 'stress'
  | 'simulation'
  | 'insights'
  | 'export';

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
  claimAge: number;
}

export interface EmployerMatchFormula {
  matchRate: number;
  maxEmployeeContributionPercentOfSalary: number;
}

export interface PreRetirementContributionSettings {
  employee401kPreTaxAnnualAmount?: number;
  employee401kPreTaxPercentOfSalary?: number;
  employee401kRothAnnualAmount?: number;
  employee401kRothPercentOfSalary?: number;
  // Legacy compatibility fields. When present, they map to pre-tax 401(k) targets.
  employee401kAnnualAmount?: number;
  employee401kPercentOfSalary?: number;
  employerMatch?: EmployerMatchFormula;
  hsaAnnualAmount?: number;
  hsaPercentOfSalary?: number;
  hsaCoverageType?: 'self' | 'family';
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
  // For primary-home-sale treatment, this exclusion is applied against gain.
  exclusionAmount?: number;
  // For inherited IRA treatment, defaulted to 10 when omitted.
  distributionYears?: number;
}

export interface IncomeData {
  salaryAnnual: number;
  salaryEndDate: string;
  socialSecurity: SocialSecurityEntry[];
  windfalls: WindfallEntry[];
  preRetirementContributions?: PreRetirementContributionSettings;
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
    maxPretaxBalancePercent?: number;
    magiBufferDollars?: number;
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
  healthcarePremiums?: {
    baselineAcaPremiumAnnual: number;
    baselineMedicarePremiumAnnual: number;
    medicalInflationAnnual?: number;
  };
  hsaStrategy?: {
    enabled: boolean;
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
  simulationSeed?: number;
  assumptionsVersion?: string;
  // Opt-in: sample correlated asset-class returns via a fixed Cholesky
  // factor of long-run US correlations (US/INTL 0.85, US/BONDS 0.15,
  // BONDS/CASH 0.20, equity↔cash 0). Defaults to false (independent
  // samples) to preserve backward compatibility with existing goldens.
  useCorrelatedReturns?: boolean;
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
  tenthPercentileAssets: number;
  medianIncome: number;
  medianSpending: number;
  medianFederalTax: number;
  medianRmdAmount: number;
  medianWithdrawalCash: number;
  medianWithdrawalTaxable: number;
  medianWithdrawalIra401k: number;
  medianWithdrawalRoth: number;
  medianRothConversion: number;
  dominantRothConversionReason: string;
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
  medianHsaOffsetUsed: number;
  medianLtcCost: number;
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
}

export interface ProjectionPoint {
  year: number;
  baseline: number;
  stressed: number;
  spending: number;
  income: number;
}

export type SimulationStrategyMode = 'planner_enhanced' | 'raw_simulation';

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
    maxPretaxBalancePercent: number;
    magiBufferDollars: number;
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
  yearlySeries: PathYearResult[];
}
