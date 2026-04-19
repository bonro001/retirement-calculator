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
  employee401kAnnualAmount?: number;
  employee401kPercentOfSalary?: number;
  employerMatch?: EmployerMatchFormula;
  hsaAnnualAmount?: number;
  hsaPercentOfSalary?: number;
  hsaCoverageType?: 'self' | 'family';
}

export interface WindfallEntry {
  name: string;
  year: number;
  amount: number;
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
  healthcarePremiums?: {
    baselineAcaPremiumAnnual: number;
    baselineMedicarePremiumAnnual: number;
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
}

export interface ProjectionPoint {
  year: number;
  baseline: number;
  stressed: number;
  spending: number;
  income: number;
}

export type SimulationStrategyMode = 'planner_enhanced' | 'raw_simulation';

export interface SimulationTimingConventions {
  currentPlanningYear: number;
  salaryProrationRule: 'month_fraction';
  inflationCompounding: 'annual';
}

export interface SimulationReturnGenerationAssumptions {
  model: 'bounded_normal_by_asset_class';
  boundsByAssetClass: {
    US_EQUITY: { min: number; max: number };
    INTL_EQUITY: { min: number; max: number };
    BONDS: { min: number; max: number };
    CASH: { min: number; max: number };
  };
  stressOverlayRules: string[];
}

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
  };
  rothConversionPolicy: {
    proactiveConversionsEnabled: boolean;
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
  taxesPaidPath: Array<{ year: number; value: number }>;
  magiPath: Array<{ year: number; value: number }>;
  conversionPath: Array<{ year: number; value: number }>;
  failureYearDistribution: Array<{ year: number; count: number; rate: number }>;
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
  yearlySeries: PathYearResult[];
}
