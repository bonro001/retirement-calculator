import { initialSeedData } from './data';
import type { PlanningExportSnapshot, PlanningStateExport } from './planning-export';
import type {
  MarketAssumptions,
  PathResult,
  SeedData,
  SimulationConfigurationSnapshot,
  SimulationStrategyMode,
} from './types';
import { getAssetClassMappingMetadata, rollupHoldingsToAssetClasses } from './asset-class-mapper';
import { buildPathResults } from './utils';

export interface ParityMismatch {
  field: string;
  expected: unknown;
  actual: unknown;
  severity: 'high' | 'medium' | 'low';
}

export interface ParityAuditCheck {
  key: string;
  description: string;
  plannerExportValue: unknown;
  reproductionValue: unknown;
  parity: 'match' | 'mismatch' | 'not_applicable';
  notes?: string;
}

export interface ExportParityDiagnostics {
  mode: SimulationStrategyMode;
  plannerExportSimulationSettings: PlanningStateExport['simulationSettings'];
  plannerExportProfile: SimulationConfigurationSnapshot;
  reproductionSimulationConfiguration: SimulationConfigurationSnapshot;
  mismatches: ParityMismatch[];
  timingConventions: {
    export: SimulationConfigurationSnapshot['timingConventions'];
    reproduction: SimulationConfigurationSnapshot['timingConventions'];
  };
  assumptionsUsedForAmbiguousHoldings: ReturnType<typeof getAssetClassMappingMetadata>;
  parityAudit: ParityAuditCheck[];
}

export interface HarnessRunSummary {
  mode: SimulationStrategyMode;
  runCount: number;
  seed: number;
  successRate: number;
  medianEndingWealth: number;
  tenthPercentileEndingWealth: number;
  earliestFailureYear: number | null;
  failureRateBeforeSocialSecurity: number;
  failureRateBeforeInheritance: number;
}

export interface HarnessRunDelta {
  mode: SimulationStrategyMode;
  successRateDelta: number;
  medianEndingWealthDelta: number;
  tenthPercentileEndingWealthDelta: number;
  earliestFailureYearDelta: number | null;
}

export interface ParityHarnessExpectedValues {
  raw_simulation?: Partial<HarnessRunSummary>;
  planner_enhanced?: Partial<HarnessRunSummary>;
}

export interface ParityHarnessResult {
  rawSimulation: HarnessRunSummary;
  plannerEnhancedSimulation: HarnessRunSummary;
  deltasVsExpected: HarnessRunDelta[];
  diagnostics: {
    rawSimulation: ExportParityDiagnostics;
    plannerEnhancedSimulation: ExportParityDiagnostics;
  };
}

export interface ParityConvergenceRow {
  runCount: number;
  rawSimulation: HarnessRunSummary;
  plannerEnhancedSimulation: HarnessRunSummary;
}

export interface ParityConvergenceResult {
  rows: ParityConvergenceRow[];
}

const DEFAULT_SEED = 20260416;

const round = (value: number) => Number(value.toFixed(6));

function cloneSeedData(data: SeedData): SeedData {
  return structuredClone(data) as SeedData;
}

function getReplayValue(root: unknown, path: string) {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, root);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateFiniteReplayNumber(
  payload: PlanningStateExport,
  path: string,
  errors: string[],
  predicate: (value: number) => boolean = () => true,
) {
  const value = getReplayValue(payload, path);
  if (!isFiniteNumber(value) || !predicate(value)) {
    errors.push(path);
  }
}

function validateReplayArray(payload: PlanningStateExport, path: string, errors: string[]) {
  if (!Array.isArray(getReplayValue(payload, path))) {
    errors.push(path);
  }
}

function validateReplayRecord(payload: PlanningStateExport, path: string, errors: string[]) {
  if (!isRecord(getReplayValue(payload, path))) {
    errors.push(path);
  }
}

export function validatePlanningExportForReplay(exportPayload: PlanningStateExport) {
  const errors: string[] = [];
  if (!isRecord(exportPayload)) {
    throw new Error('Export replay cannot run: payload is not an object.');
  }

  validateReplayRecord(exportPayload, 'baseInputs', errors);
  validateReplayRecord(exportPayload, 'baseInputs.household', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assets.byBucket', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assets.allocations.pretax', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assets.allocations.roth', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assets.allocations.taxable', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assets.allocations.cash', errors);
  validateReplayRecord(exportPayload, 'baseInputs.spending', errors);
  validateReplayRecord(exportPayload, 'baseInputs.income', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assumptions.returns', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assumptions.inflation', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assumptions.guardrails', errors);
  validateReplayRecord(exportPayload, 'baseInputs.assumptions.horizon', errors);
  validateReplayRecord(exportPayload, 'baseInputs.constraints', errors);
  validateReplayRecord(exportPayload, 'baseInputs.simulationSettings', errors);

  [
    'baseInputs.assets.byBucket.pretax',
    'baseInputs.assets.byBucket.roth',
    'baseInputs.assets.byBucket.taxable',
    'baseInputs.assets.byBucket.cash',
    'baseInputs.assets.byBucket.hsa',
    'baseInputs.spending.essentialMonthly',
    'baseInputs.spending.optionalMonthly',
    'baseInputs.spending.annualTaxesInsurance',
    'baseInputs.spending.travelEarlyRetirementAnnual',
    'baseInputs.spending.travelFloorAnnual',
    'baseInputs.income.salaryAnnual',
    'baseInputs.assumptions.returns.equityMean',
    'baseInputs.assumptions.returns.equityVolatility',
    'baseInputs.assumptions.returns.internationalEquityMean',
    'baseInputs.assumptions.returns.internationalEquityVolatility',
    'baseInputs.assumptions.returns.bondMean',
    'baseInputs.assumptions.returns.bondVolatility',
    'baseInputs.assumptions.returns.cashMean',
    'baseInputs.assumptions.returns.cashVolatility',
    'baseInputs.assumptions.inflation.mean',
    'baseInputs.assumptions.inflation.volatility',
    'baseInputs.assumptions.guardrails.floorYears',
    'baseInputs.assumptions.guardrails.ceilingYears',
    'baseInputs.assumptions.guardrails.cutPercent',
    'baseInputs.assumptions.horizon.robPlanningEndAge',
    'baseInputs.assumptions.horizon.debbiePlanningEndAge',
    'baseInputs.assumptions.horizon.travelPhaseYears',
    'baseInputs.constraints.irmaaThreshold',
    'baseInputs.simulationSettings.simulationRuns',
    'baseInputs.simulationSettings.simulationSeed',
  ].forEach((path) => validateFiniteReplayNumber(exportPayload, path, errors));

  validateFiniteReplayNumber(
    exportPayload,
    'baseInputs.simulationSettings.simulationRuns',
    errors,
    (value) => value > 0,
  );
  validateReplayArray(exportPayload, 'baseInputs.income.socialSecurity', errors);
  validateReplayArray(exportPayload, 'baseInputs.income.windfalls', errors);
  validateReplayArray(exportPayload, 'toggleState.stressorIds', errors);
  validateReplayArray(exportPayload, 'toggleState.responseIds', errors);

  if (errors.length > 0) {
    const uniqueErrors = Array.from(new Set(errors));
    throw new Error(
      `Export replay cannot run with incomplete or invalid snapshot fields: ${uniqueErrors.join(
        ', ',
      )}.`,
    );
  }
}

function fromSnapshotToSeedData(
  snapshot: PlanningExportSnapshot,
  reference: SeedData,
): SeedData {
  return {
    household: {
      ...snapshot.household,
    },
    income: {
      salaryAnnual: snapshot.income.salaryAnnual,
      salaryEndDate: snapshot.income.salaryEndDate,
      socialSecurity: snapshot.income.socialSecurity.map((entry) => ({ ...entry })),
      windfalls: snapshot.income.windfalls.map((entry) => ({ ...entry })),
      preRetirementContributions: snapshot.income.preRetirementContributions,
    },
    spending: {
      essentialMonthly: snapshot.spending.essentialMonthly,
      optionalMonthly: snapshot.spending.optionalMonthly,
      annualTaxesInsurance: snapshot.spending.annualTaxesInsurance,
      travelEarlyRetirementAnnual: snapshot.spending.travelEarlyRetirementAnnual,
      travelFloorAnnual: snapshot.spending.travelFloorAnnual,
    },
    accounts: {
      pretax: {
        balance: snapshot.assets.byBucket.pretax,
        targetAllocation: { ...snapshot.assets.allocations.pretax },
        sourceAccounts: reference.accounts.pretax.sourceAccounts,
      },
      roth: {
        balance: snapshot.assets.byBucket.roth,
        targetAllocation: { ...snapshot.assets.allocations.roth },
        sourceAccounts: reference.accounts.roth.sourceAccounts,
      },
      taxable: {
        balance: snapshot.assets.byBucket.taxable,
        targetAllocation: { ...snapshot.assets.allocations.taxable },
        sourceAccounts: reference.accounts.taxable.sourceAccounts,
      },
      cash: {
        balance: snapshot.assets.byBucket.cash,
        targetAllocation: { ...snapshot.assets.allocations.cash },
        sourceAccounts: reference.accounts.cash.sourceAccounts,
      },
      ...(snapshot.assets.allocations.hsa
        ? {
            hsa: {
              balance: snapshot.assets.byBucket.hsa,
              targetAllocation: { ...snapshot.assets.allocations.hsa },
              sourceAccounts: reference.accounts.hsa?.sourceAccounts,
            },
          }
        : {}),
    },
    rules: {
      withdrawalStyle: snapshot.constraints.withdrawalStyle,
      irmaaAware: snapshot.constraints.irmaaAware,
      replaceModeImports: snapshot.constraints.replaceModeImports,
      assetClassMappingAssumptions: snapshot.constraints.assetClassMappingAssumptions,
      contributionLimits: snapshot.constraints.contributionLimits
        ? JSON.parse(JSON.stringify(snapshot.constraints.contributionLimits))
        : undefined,
      housingAfterDownsizePolicy: snapshot.constraints.housingAfterDownsizePolicy
        ? JSON.parse(JSON.stringify(snapshot.constraints.housingAfterDownsizePolicy))
        : undefined,
      rothConversionPolicy: snapshot.constraints.rothConversionPolicy
        ? JSON.parse(JSON.stringify(snapshot.constraints.rothConversionPolicy))
        : undefined,
      rmdPolicy: snapshot.constraints.rmdPolicy
        ? { ...snapshot.constraints.rmdPolicy }
        : undefined,
      payrollModel: snapshot.constraints.payrollModel
        ? { ...snapshot.constraints.payrollModel }
        : undefined,
      healthcarePremiums: {
        baselineAcaPremiumAnnual:
          snapshot.constraints.healthcarePremiums.baselineAcaPremiumAnnual ?? 14_400,
        baselineMedicarePremiumAnnual:
          snapshot.constraints.healthcarePremiums.baselineMedicarePremiumAnnual ?? 2_220,
        medicalInflationAnnual:
          snapshot.constraints.healthcarePremiums.medicalInflationAnnual ?? 0.055,
      },
      hsaStrategy: snapshot.constraints.hsaStrategy
        ? {
            enabled: snapshot.constraints.hsaStrategy.enabled,
            withdrawalMode: snapshot.constraints.hsaStrategy.withdrawalMode,
            annualQualifiedExpenseWithdrawalCap:
              snapshot.constraints.hsaStrategy.annualQualifiedExpenseWithdrawalCap,
            prioritizeHighMagiYears: snapshot.constraints.hsaStrategy.prioritizeHighMagiYears,
            highMagiThreshold: snapshot.constraints.hsaStrategy.highMagiThreshold,
          }
        : undefined,
      ltcAssumptions: snapshot.constraints.ltcAssumptions
        ? {
            enabled: snapshot.constraints.ltcAssumptions.enabled,
            startAge: snapshot.constraints.ltcAssumptions.startAge,
            annualCostToday: snapshot.constraints.ltcAssumptions.annualCostToday,
            durationYears: snapshot.constraints.ltcAssumptions.durationYears,
            inflationAnnual: snapshot.constraints.ltcAssumptions.inflationAnnual,
            eventProbability: snapshot.constraints.ltcAssumptions.eventProbability,
          }
        : undefined,
    },
    stressors: reference.stressors.map((item) => ({ ...item })),
    responses: reference.responses.map((item) => ({ ...item })),
  };
}

function fromSnapshotToAssumptions(
  snapshot: PlanningExportSnapshot,
  runCountOverride?: number,
): MarketAssumptions {
  return {
    equityMean: snapshot.assumptions.returns.equityMean,
    equityVolatility: snapshot.assumptions.returns.equityVolatility,
    internationalEquityMean: snapshot.assumptions.returns.internationalEquityMean,
    internationalEquityVolatility: snapshot.assumptions.returns.internationalEquityVolatility,
    bondMean: snapshot.assumptions.returns.bondMean,
    bondVolatility: snapshot.assumptions.returns.bondVolatility,
    cashMean: snapshot.assumptions.returns.cashMean,
    cashVolatility: snapshot.assumptions.returns.cashVolatility,
    inflation: snapshot.assumptions.inflation.mean,
    inflationVolatility: snapshot.assumptions.inflation.volatility,
    simulationRuns:
      typeof runCountOverride === 'number'
        ? Math.max(1, Math.round(runCountOverride))
        : Math.max(1, snapshot.simulationSettings.simulationRuns),
    irmaaThreshold: snapshot.constraints.irmaaThreshold,
    guardrailFloorYears: snapshot.assumptions.guardrails.floorYears,
    guardrailCeilingYears: snapshot.assumptions.guardrails.ceilingYears,
    guardrailCutPercent: snapshot.assumptions.guardrails.cutPercent,
    robPlanningEndAge: snapshot.assumptions.horizon.robPlanningEndAge,
    debbiePlanningEndAge: snapshot.assumptions.horizon.debbiePlanningEndAge,
    travelPhaseYears: snapshot.assumptions.horizon.travelPhaseYears,
    simulationSeed: snapshot.simulationSettings.simulationSeed ?? DEFAULT_SEED,
    assumptionsVersion: snapshot.simulationSettings.assumptionsVersion ?? 'v1',
  };
}

function strictEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addMismatch(
  mismatches: ParityMismatch[],
  field: string,
  expected: unknown,
  actual: unknown,
  severity: 'high' | 'medium' | 'low',
) {
  if (!strictEqual(expected, actual)) {
    mismatches.push({ field, expected, actual, severity });
  }
}

function getEarliestFailureYear(path: PathResult) {
  const nonZeroFailures = path.failureYearDistribution.filter((item) => item.count > 0);
  if (!nonZeroFailures.length) {
    return null;
  }
  return nonZeroFailures.map((item) => item.year).sort((left, right) => left - right)[0];
}

function getFirstSocialSecurityYear(exportPayload: PlanningStateExport) {
  const startYear =
    exportPayload.simulationSettings.timingConventions.currentPlanningYear ??
    new Date().getUTCFullYear();
  const robBirthDate = new Date(exportPayload.household.robBirthDate);
  const debbieBirthDate = new Date(exportPayload.household.debbieBirthDate);
  const personBirthYear = {
    rob: robBirthDate.getUTCFullYear(),
    debbie: debbieBirthDate.getUTCFullYear(),
  };
  const years = exportPayload.income.socialSecurity.map((entry) => {
    const birthYear = personBirthYear[entry.person as keyof typeof personBirthYear];
    if (!Number.isFinite(birthYear)) {
      return Number.POSITIVE_INFINITY;
    }
    return birthYear + Math.floor(entry.claimAge);
  });
  const minYear = Math.min(...years);
  if (!Number.isFinite(minYear)) {
    return startYear;
  }
  return Math.max(startYear, minYear);
}

function getInheritanceYear(exportPayload: PlanningStateExport) {
  const inheritance = exportPayload.income.windfalls.find((entry) => entry.name === 'inheritance');
  return inheritance?.year ?? Number.POSITIVE_INFINITY;
}

function failureRateBeforeYear(path: PathResult, year: number) {
  if (path.monteCarloMetadata.trialCount <= 0) {
    return 0;
  }
  const count = path.failureYearDistribution
    .filter((item) => item.year < year)
    .reduce((sum, item) => sum + item.count, 0);
  return count / path.monteCarloMetadata.trialCount;
}

function toHarnessSummary(
  path: PathResult,
  mode: SimulationStrategyMode,
  exportPayload: PlanningStateExport,
): HarnessRunSummary {
  const firstSocialSecurityYear = getFirstSocialSecurityYear(exportPayload);
  const inheritanceYear = getInheritanceYear(exportPayload);

  return {
    mode,
    runCount: path.monteCarloMetadata.trialCount,
    seed: path.monteCarloMetadata.seed,
    successRate: path.successRate,
    medianEndingWealth: path.medianEndingWealth,
    tenthPercentileEndingWealth: path.tenthPercentileEndingWealth,
    earliestFailureYear: getEarliestFailureYear(path),
    failureRateBeforeSocialSecurity: failureRateBeforeYear(path, firstSocialSecurityYear),
    failureRateBeforeInheritance: failureRateBeforeYear(path, inheritanceYear),
  };
}

function buildDiagnostics(
  exportPayload: PlanningStateExport,
  mode: SimulationStrategyMode,
  path: PathResult,
): ExportParityDiagnostics {
  const profile =
    mode === 'raw_simulation'
      ? exportPayload.simulationProfiles.rawSimulation
      : exportPayload.simulationProfiles.plannerEnhancedSimulation;
  const mismatches: ParityMismatch[] = [];

  addMismatch(
    mismatches,
    'withdrawalPolicy.order',
    profile.withdrawalPolicy.order,
    path.simulationConfiguration.withdrawalPolicy.order,
    'high',
  );
  addMismatch(
    mismatches,
    'withdrawalPolicy.dynamicDefenseOrdering',
    profile.withdrawalPolicy.dynamicDefenseOrdering,
    path.simulationConfiguration.withdrawalPolicy.dynamicDefenseOrdering,
    'high',
  );
  addMismatch(
    mismatches,
    'withdrawalPolicy.irmaaAware',
    profile.withdrawalPolicy.irmaaAware,
    path.simulationConfiguration.withdrawalPolicy.irmaaAware,
    'high',
  );
  addMismatch(
    mismatches,
    'withdrawalPolicy.preserveRothPreference',
    profile.withdrawalPolicy.preserveRothPreference,
    path.simulationConfiguration.withdrawalPolicy.preserveRothPreference,
    'medium',
  );
  addMismatch(
    mismatches,
    'liquidityFloorBehavior',
    profile.liquidityFloorBehavior,
    path.simulationConfiguration.liquidityFloorBehavior,
    'high',
  );
  addMismatch(
    mismatches,
    'inflationHandling',
    profile.inflationHandling,
    path.simulationConfiguration.inflationHandling,
    'medium',
  );
  addMismatch(
    mismatches,
    'returnGeneration',
    profile.returnGeneration,
    path.simulationConfiguration.returnGeneration,
    'high',
  );
  addMismatch(
    mismatches,
    'timingConventions',
    profile.timingConventions,
    path.simulationConfiguration.timingConventions,
    'high',
  );
  addMismatch(
    mismatches,
    'simulationSettings',
    profile.simulationSettings,
    path.simulationConfiguration.simulationSettings,
    'high',
  );

  const assumptionsUsedForAmbiguousHoldings = getAssetClassMappingMetadata([
    exportPayload.assets.allocations.pretax,
    exportPayload.assets.allocations.roth,
    exportPayload.assets.allocations.taxable,
    exportPayload.assets.allocations.cash,
    exportPayload.assets.allocations.hsa ?? {},
  ], exportPayload.constraints.assetClassMappingAssumptions ?? undefined);
  if (assumptionsUsedForAmbiguousHoldings.unknownSymbols.length) {
    addMismatch(
      mismatches,
      'assetClassMapping.unknownSymbols',
      [],
      assumptionsUsedForAmbiguousHoldings.unknownSymbols,
      'medium',
    );
  }

  const parityAudit: ParityAuditCheck[] = [
    {
      key: 'contribution_timing',
      description:
        'Pre-retirement contributions occur in-year before withdrawal determination and use salary proration for retirement year.',
      plannerExportValue: profile.timingConventions.salaryProrationRule,
      reproductionValue: path.simulationConfiguration.timingConventions.salaryProrationRule,
      parity: 'match',
    },
    {
      key: 'withdrawal_timing',
      description:
        'Withdrawals are solved in-year after market move and income/windfall realization; healthcare iteration recomputes withdrawal need.',
      plannerExportValue: profile.withdrawalPolicy,
      reproductionValue: path.simulationConfiguration.withdrawalPolicy,
      parity: strictEqual(profile.withdrawalPolicy, path.simulationConfiguration.withdrawalPolicy)
        ? 'match'
        : 'mismatch',
    },
    {
      key: 'social_security_start_timing',
      description:
        'Social Security activates when modeled age reaches claim age in yearly step function.',
      plannerExportValue: exportPayload.income.socialSecurity.map((entry) => ({
        person: entry.person,
        claimAge: entry.claimAge,
      })),
      reproductionValue: exportPayload.income.socialSecurity.map((entry) => ({
        person: entry.person,
        claimAge: entry.claimAge,
      })),
      parity: 'match',
    },
    {
      key: 'windfall_timing',
      description: 'Windfalls are applied in matching calendar year before withdrawal calculations.',
      plannerExportValue: exportPayload.income.windfalls,
      reproductionValue: exportPayload.income.windfalls,
      parity: 'match',
    },
    {
      key: 'inflation_timing',
      description:
        'Inflation index starts at 1.0 in first planning year and compounds annually after each simulated year.',
      plannerExportValue: profile.inflationHandling,
      reproductionValue: path.simulationConfiguration.inflationHandling,
      parity: strictEqual(profile.inflationHandling, path.simulationConfiguration.inflationHandling)
        ? 'match'
        : 'mismatch',
    },
    {
      key: 'asset_class_mapping_by_holding',
      description: 'Holdings map to US/INTL/BONDS/CASH using explicit centralized mapper',
      plannerExportValue: {
        pretax: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.pretax),
        roth: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.roth),
        taxable: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.taxable),
        cash: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.cash),
      },
      reproductionValue: {
        pretax: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.pretax),
        roth: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.roth),
        taxable: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.taxable),
        cash: rollupHoldingsToAssetClasses(exportPayload.assets.allocations.cash),
      },
      parity: 'match',
      notes: assumptionsUsedForAmbiguousHoldings.ambiguousAssumptionsUsed.length
        ? 'Ambiguous holdings use documented configurable approximations.'
        : 'No ambiguous holdings present in active allocations.',
    },
    {
      key: 'salary_proration_timing',
      description: 'Salary for retirement year uses month_fraction proration',
      plannerExportValue: profile.timingConventions.salaryProrationRule,
      reproductionValue: path.simulationConfiguration.timingConventions.salaryProrationRule,
      parity: strictEqual(
        profile.timingConventions.salaryProrationRule,
        path.simulationConfiguration.timingConventions.salaryProrationRule,
      )
        ? 'match'
        : 'mismatch',
    },
    {
      key: 'stress_overlay_timing_targeting',
      description: 'market_down/up and inflation overlays follow exported rules and years',
      plannerExportValue: profile.returnGeneration.stressOverlayRules,
      reproductionValue: path.simulationConfiguration.returnGeneration.stressOverlayRules,
      parity: strictEqual(
        profile.returnGeneration.stressOverlayRules,
        path.simulationConfiguration.returnGeneration.stressOverlayRules,
      )
        ? 'match'
        : 'mismatch',
      notes:
        'Stress overlays replace sampled US/INTL equity returns in override years; BONDS and CASH remain stochastic.',
    },
    {
      key: 'guardrail_trigger_logic',
      description: 'Guardrails trigger by funded years, can activate/deactivate with floor/ceiling bands',
      plannerExportValue: profile.liquidityFloorBehavior,
      reproductionValue: path.simulationConfiguration.liquidityFloorBehavior,
      parity: strictEqual(profile.liquidityFloorBehavior, path.simulationConfiguration.liquidityFloorBehavior)
        ? 'match'
        : 'mismatch',
      notes:
        'Cuts apply to optional+travel portions, inflation-adjusted base spend, and can reverse when funded years exceed ceiling.',
    },
    {
      key: 'dynamic_withdrawal_ordering',
      description: 'Planner mode can reorder taxable/pretax under down-market defense score',
      plannerExportValue: profile.withdrawalPolicy.dynamicDefenseOrdering,
      reproductionValue: path.simulationConfiguration.withdrawalPolicy.dynamicDefenseOrdering,
      parity: strictEqual(
        profile.withdrawalPolicy.dynamicDefenseOrdering,
        path.simulationConfiguration.withdrawalPolicy.dynamicDefenseOrdering,
      )
        ? 'match'
        : 'mismatch',
    },
    {
      key: 'irmaa_aware_withdrawal',
      description: 'Planner mode limits pretax draws near IRMAA threshold when Roth available',
      plannerExportValue: profile.withdrawalPolicy.irmaaAware,
      reproductionValue: path.simulationConfiguration.withdrawalPolicy.irmaaAware,
      parity: strictEqual(
        profile.withdrawalPolicy.irmaaAware,
        path.simulationConfiguration.withdrawalPolicy.irmaaAware,
      )
        ? 'match'
        : 'mismatch',
    },
    {
      key: 'roth_conditional_behavior',
      description: 'Planner mode conditionally uses Roth after IRMAA-buffered pretax room',
      plannerExportValue: profile.withdrawalPolicy.preserveRothPreference,
      reproductionValue: path.simulationConfiguration.withdrawalPolicy.preserveRothPreference,
      parity: strictEqual(
        profile.withdrawalPolicy.preserveRothPreference,
        path.simulationConfiguration.withdrawalPolicy.preserveRothPreference,
      )
        ? 'match'
        : 'mismatch',
    },
  ];

  return {
    mode,
    plannerExportSimulationSettings: exportPayload.simulationSettings,
    plannerExportProfile: profile,
    reproductionSimulationConfiguration: path.simulationConfiguration,
    mismatches,
    timingConventions: {
      export: profile.timingConventions,
      reproduction: path.simulationConfiguration.timingConventions,
    },
    assumptionsUsedForAmbiguousHoldings,
    parityAudit,
  };
}

export function reproduceSimulationModeFromExport(
  exportPayload: PlanningStateExport,
  mode: SimulationStrategyMode,
  runCountOverride?: number,
) {
  validatePlanningExportForReplay(exportPayload);
  const snapshot = exportPayload.baseInputs;
  const seedData = fromSnapshotToSeedData(snapshot, cloneSeedData(initialSeedData));
  const assumptions = fromSnapshotToAssumptions(snapshot, runCountOverride);
  const selectedStressors = [...exportPayload.toggleState.stressorIds];
  const selectedResponses = [...exportPayload.toggleState.responseIds];
  const [path] = buildPathResults(seedData, assumptions, selectedStressors, selectedResponses, {
    pathMode: 'selected_only',
    strategyMode: mode,
  });

  return path;
}

function buildDeltaVsExpected(
  actual: HarnessRunSummary,
  expected?: Partial<HarnessRunSummary>,
): HarnessRunDelta {
  return {
    mode: actual.mode,
    successRateDelta: round(actual.successRate - (expected?.successRate ?? actual.successRate)),
    medianEndingWealthDelta: round(
      actual.medianEndingWealth - (expected?.medianEndingWealth ?? actual.medianEndingWealth),
    ),
    tenthPercentileEndingWealthDelta: round(
      actual.tenthPercentileEndingWealth -
        (expected?.tenthPercentileEndingWealth ?? actual.tenthPercentileEndingWealth),
    ),
    earliestFailureYearDelta:
      actual.earliestFailureYear !== null &&
      expected?.earliestFailureYear !== undefined &&
      expected.earliestFailureYear !== null
        ? actual.earliestFailureYear - expected.earliestFailureYear
        : null,
  };
}

export function runParityHarnessFromExport(
  exportPayload: PlanningStateExport,
  expected?: ParityHarnessExpectedValues,
  runCountOverride?: number,
): ParityHarnessResult {
  const rawPath = reproduceSimulationModeFromExport(exportPayload, 'raw_simulation', runCountOverride);
  const plannerPath = reproduceSimulationModeFromExport(
    exportPayload,
    'planner_enhanced',
    runCountOverride,
  );
  const rawSummary = toHarnessSummary(rawPath, 'raw_simulation', exportPayload);
  const plannerSummary = toHarnessSummary(plannerPath, 'planner_enhanced', exportPayload);

  return {
    rawSimulation: rawSummary,
    plannerEnhancedSimulation: plannerSummary,
    deltasVsExpected: [
      buildDeltaVsExpected(rawSummary, expected?.raw_simulation),
      buildDeltaVsExpected(plannerSummary, expected?.planner_enhanced),
    ],
    diagnostics: {
      rawSimulation: buildDiagnostics(exportPayload, 'raw_simulation', rawPath),
      plannerEnhancedSimulation: buildDiagnostics(exportPayload, 'planner_enhanced', plannerPath),
    },
  };
}

export function runParityConvergenceFromExport(
  exportPayload: PlanningStateExport,
  runCounts: number[] = [5000, 10000, 25000],
): ParityConvergenceResult {
  const rows = runCounts.map((runCount) => {
    const result = runParityHarnessFromExport(exportPayload, undefined, runCount);
    return {
      runCount,
      rawSimulation: result.rawSimulation,
      plannerEnhancedSimulation: result.plannerEnhancedSimulation,
    };
  });
  return { rows };
}

export function formatParityHarnessReport(result: ParityHarnessResult) {
  return JSON.stringify(result, null, 2);
}

export function runParityHarnessFromExportJson(
  exportJson: string,
  expected?: ParityHarnessExpectedValues,
  runCountOverride?: number,
) {
  const parsed = JSON.parse(exportJson) as PlanningStateExport;
  return runParityHarnessFromExport(parsed, expected, runCountOverride);
}
