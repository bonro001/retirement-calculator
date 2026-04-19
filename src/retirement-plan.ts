import {
  evaluateDecisionLevers,
  type DecisionEngineReport,
  type RecommendationConstraints,
} from './decision-engine';
import { perfStart } from './debug-perf';
import { generateAutopilotPlan, type AutopilotPlanResult } from './autopilot-timeline';
import {
  solveSpendByReverseTimeline,
  type SpendSolverResult,
  type SpendSolverSuccessRange,
} from './spend-solver';
import type {
  OptimizationObjective,
  TimePreferenceWeights,
} from './optimization-objective';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import {
  buildPathResults,
  getAnnualSpendingMinimums,
  getAnnualSpendingTargets,
  getAnnualStretchSpend,
} from './utils';

export type ModelCompleteness = 'faithful' | 'reconstructed';
export type IrmaaPosture = 'minimize' | 'balanced' | 'ignore';

export interface PlanConstraintsModel {
  doNotRetireLater: boolean;
  doNotSellHouse: boolean;
  minimumTravelBudgetAnnual?: number;
}

export interface WithdrawalPolicyModel {
  order: Array<'cash' | 'taxable' | 'pretax' | 'roth'>;
  dynamicDefenseOrdering: boolean;
  preserveRothPreference: boolean;
  irmaaAware: boolean;
}

export interface AutopilotPolicyModel {
  posture: 'defensive' | 'balanced';
  optionalSpendingCutsAllowed: boolean;
  optionalSpendingFlexPercent: number;
  travelFlexPercent: number;
  defensiveResponses: string[];
}

export interface ExitSpendingTargets {
  exitTargetTodayDollars: number;
  spendingTargetAnnual: number;
  minSuccessRate: number;
  successRateRange?: SpendSolverSuccessRange;
  optimizationObjective: OptimizationObjective;
  timePreferenceWeights?: TimePreferenceWeights;
}

export interface IrmaaPolicyModel {
  posture: IrmaaPosture;
}

export interface DecisionEngineSettingsModel {
  strategyMode: 'planner_enhanced';
  simulationRunsOverride?: number;
  seedStrategy: 'shared' | 'scenario_derived';
}

export interface RetirementPlan {
  modelCompleteness: ModelCompleteness;
  inferredAssumptions: string[];
  household: SeedData['household'];
  assets: SeedData['accounts'];
  income: SeedData['income'];
  spending: SeedData['spending'];
  constraints: PlanConstraintsModel;
  scenarioToggles: {
    stressors: string[];
    responses: string[];
  };
  withdrawalPolicy: WithdrawalPolicyModel;
  autopilotPolicy: AutopilotPolicyModel;
  targets: ExitSpendingTargets;
  irmaaPolicy: IrmaaPolicyModel;
  decisionEngineSettings: DecisionEngineSettingsModel;
  assumptions: MarketAssumptions;
  baseData: SeedData;
  effectiveData: SeedData;
}

export interface IrmaaExposureAnalysis {
  posture: IrmaaPosture;
  exposureLevel: 'Low' | 'Medium' | 'High';
  likelyYearsAtRisk: number[];
  mainDrivers: string[];
  whatToChangeToLowerExposure: string[];
}

export interface UnifiedPlanSummary {
  supportedAnnualSpending: number;
  supportedMonthlySpending: number;
  exitTargetTodayDollars: number;
  projectedExitTodayDollars: number;
  successRate: number;
  planVerdict: 'Strong' | 'Watch' | 'At Risk';
  biggestDriverOfImprovement: string;
  biggestRisk: string;
  nextBestAction: string;
  narrative: string[];
}

export interface RetirementPlanRunResult {
  plan: RetirementPlan;
  baselinePath: PathResult;
  solver: SpendSolverResult;
  autopilot: AutopilotPlanResult;
  decision: DecisionEngineReport;
  irmaa: IrmaaExposureAnalysis;
  summary: UnifiedPlanSummary;
}

export interface BuildRetirementPlanInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  constraints: PlanConstraintsModel;
  autopilotPolicy: Partial<AutopilotPolicyModel>;
  withdrawalPolicy: Partial<WithdrawalPolicyModel>;
  targets: Partial<ExitSpendingTargets>;
  irmaaPolicy: Partial<IrmaaPolicyModel>;
  decisionEngineSettings?: Partial<DecisionEngineSettingsModel>;
}

const DEFAULT_EXIT_TARGET = 1_000_000;
const DEFAULT_MIN_SUCCESS_RATE = 0.8;
const DEFAULT_OPTIMIZATION_OBJECTIVE: OptimizationObjective = 'maximize_flat_spending';

function cloneSeedData(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function clampRate(value: number) {
  return Math.max(0, Math.min(1, value));
}

function applyAssumptionOverrides(
  data: SeedData,
  constraints: PlanConstraintsModel,
): SeedData {
  let next = cloneSeedData(data);
  if (constraints.doNotSellHouse) {
    next = {
      ...next,
      income: {
        ...next.income,
        windfalls: next.income.windfalls.map((windfall) =>
          windfall.name === 'home_sale' ? { ...windfall, amount: 0 } : windfall,
        ),
      },
    };
  }
  return next;
}

function toRecommendationConstraints(
  constraints: PlanConstraintsModel,
): RecommendationConstraints {
  return {
    rules: {
      allowRetirementDelay: !constraints.doNotRetireLater,
      allowHomeSaleChanges: !constraints.doNotSellHouse,
      allowEarlierHomeSale: !constraints.doNotSellHouse,
      allowLaterHomeSale: !constraints.doNotSellHouse,
    },
    minimumTravelBudgetAnnual: constraints.minimumTravelBudgetAnnual,
  };
}

function normalizeScenarioResponses(
  selectedResponses: string[],
  autopilotPolicy: AutopilotPolicyModel,
  withdrawalPolicy: WithdrawalPolicyModel,
  constraints: PlanConstraintsModel,
) {
  let responses = [...selectedResponses];

  if (autopilotPolicy.posture === 'defensive' && !responses.includes('cut_spending')) {
    responses.push('cut_spending');
  }
  if (withdrawalPolicy.preserveRothPreference && !responses.includes('preserve_roth')) {
    responses.push('preserve_roth');
  }
  if (constraints.doNotSellHouse) {
    responses = responses.filter((id) => id !== 'sell_home_early');
  }
  return Array.from(new Set(responses));
}

function deriveSpendingFloorAnnual(plan: RetirementPlan) {
  const targets = getAnnualSpendingTargets(plan.effectiveData);
  const baselineAnnual = targets.totalAnnual;
  const flexibleFloorFromPolicy = plan.autopilotPolicy.optionalSpendingCutsAllowed
    ? targets.flexibleAnnual * (1 - plan.autopilotPolicy.optionalSpendingFlexPercent / 100)
    : targets.flexibleAnnual;
  const travelFloorFromPolicy = plan.autopilotPolicy.optionalSpendingCutsAllowed
    ? targets.travelAnnual * (1 - plan.autopilotPolicy.travelFlexPercent / 100)
    : targets.travelAnnual;

  const minimums = getAnnualSpendingMinimums(plan.effectiveData, {
    flexibleAnnualMinimum: flexibleFloorFromPolicy,
    travelAnnualMinimum: Math.max(
      0,
      plan.constraints.minimumTravelBudgetAnnual ?? travelFloorFromPolicy,
    ),
  });

  if (!plan.autopilotPolicy.optionalSpendingCutsAllowed) {
    return Math.max(0, baselineAnnual);
  }
  return Math.max(0, minimums.totalAnnualMinimum);
}

function deriveSpendingMinimums(plan: RetirementPlan) {
  const targets = getAnnualSpendingTargets(plan.effectiveData);
  const flexibleFloorFromPolicy = plan.autopilotPolicy.optionalSpendingCutsAllowed
    ? targets.flexibleAnnual * (1 - plan.autopilotPolicy.optionalSpendingFlexPercent / 100)
    : targets.flexibleAnnual;
  const travelFloorFromPolicy = plan.autopilotPolicy.optionalSpendingCutsAllowed
    ? targets.travelAnnual * (1 - plan.autopilotPolicy.travelFlexPercent / 100)
    : targets.travelAnnual;

  return getAnnualSpendingMinimums(plan.effectiveData, {
    flexibleAnnualMinimum: flexibleFloorFromPolicy,
    travelAnnualMinimum: Math.max(
      0,
      plan.constraints.minimumTravelBudgetAnnual ?? travelFloorFromPolicy,
    ),
  });
}

function analyzeIrmaaExposure(
  plan: RetirementPlan,
  autopilot: AutopilotPlanResult,
): IrmaaExposureAnalysis {
  const medicareYears = autopilot.years.filter((year) => year.robAge >= 65 || year.debbieAge >= 65);
  const riskYears = medicareYears.filter(
    (year) =>
      year.irmaaStatus.toLowerCase().includes('surcharge') ||
      (typeof year.irmaaHeadroom === 'number' && year.irmaaHeadroom < 0),
  );
  const riskRate = medicareYears.length ? riskYears.length / medicareYears.length : 0;
  const exposureLevel: IrmaaExposureAnalysis['exposureLevel'] =
    riskRate >= 0.45 ? 'High' : riskRate >= 0.2 ? 'Medium' : 'Low';

  const avgPretaxInRiskYears =
    riskYears.reduce((sum, year) => sum + year.withdrawalIra401k, 0) / Math.max(1, riskYears.length);
  const avgRmdInRiskYears =
    riskYears.reduce((sum, year) => sum + year.rmdAmount, 0) / Math.max(1, riskYears.length);
  const avgConversionInRiskYears =
    riskYears.reduce((sum, year) => sum + year.suggestedRothConversion, 0) /
    Math.max(1, riskYears.length);

  const mainDrivers: string[] = [];
  if (avgPretaxInRiskYears > 30_000) {
    mainDrivers.push('Pretax withdrawals remain elevated in Medicare years.');
  }
  if (avgRmdInRiskYears > 10_000) {
    mainDrivers.push('Later RMD-heavy years are pushing MAGI higher.');
  }
  if (avgConversionInRiskYears > 15_000) {
    mainDrivers.push('Income spikes from Roth conversions increase surcharge exposure.');
  }
  if (!mainDrivers.length) {
    mainDrivers.push('Income concentration in Medicare years is driving periodic threshold pressure.');
  }

  const whatToChangeToLowerExposure: string[] = [];
  if (avgPretaxInRiskYears > 20_000) {
    whatToChangeToLowerExposure.push('Shift more withdrawals toward taxable/cash/Roth in Medicare years.');
  }
  if (avgRmdInRiskYears > 0) {
    whatToChangeToLowerExposure.push('Reduce future pretax balances before RMD age where practical.');
  }
  if (avgConversionInRiskYears > 0) {
    whatToChangeToLowerExposure.push('Smooth conversions and avoid stacking income spikes.');
  }
  if (!whatToChangeToLowerExposure.length) {
    whatToChangeToLowerExposure.push('Maintain current withdrawal pacing and continue monitoring MAGI headroom.');
  }

  return {
    posture: plan.irmaaPolicy.posture,
    exposureLevel,
    likelyYearsAtRisk: riskYears.map((year) => year.year),
    mainDrivers,
    whatToChangeToLowerExposure,
  };
}

function toVerdict(successRate: number): UnifiedPlanSummary['planVerdict'] {
  if (successRate >= 0.85) {
    return 'Strong';
  }
  if (successRate >= 0.7) {
    return 'Watch';
  }
  return 'At Risk';
}

function formatOptimizationObjectiveLabel(value: OptimizationObjective) {
  if (value === 'preserve_legacy') {
    return 'preserve legacy';
  }
  if (value === 'minimize_failure_risk') {
    return 'minimize failure risk';
  }
  if (value === 'maximize_time_weighted_spending') {
    return 'maximize time-weighted spending';
  }
  return 'maximize flat spending';
}

function buildNarrative(
  plan: RetirementPlan,
  solver: SpendSolverResult,
  decision: DecisionEngineReport,
  irmaa: IrmaaExposureAnalysis,
): string[] {
  const biggestRisk = decision.baselineRiskWarning
    ? decision.baselineRiskWarning
    : 'If nothing changes, the main risk is sequence and spending pressure in early retirement years.';
  const objectiveLabel = formatOptimizationObjectiveLabel(plan.targets.optimizationObjective);
  return [
    `Active objective is ${objectiveLabel}. Current feasible spend level is approximately ${Math.round(
      solver.recommendedAnnualSpend,
    ).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    })} with ${(decision.baseline.successRate * 100).toFixed(1)}% success.`,
    `Autopilot is currently set to a ${plan.autopilotPolicy.posture} posture.`,
    `IRMAA exposure is ${irmaa.exposureLevel.toLowerCase()} because ${irmaa.mainDrivers[0].toLowerCase()}`,
    `Given your constraints, the best path forward is ${decision.recommendationSummary.summary}`,
    biggestRisk,
  ];
}

export function buildRetirementPlan(input: BuildRetirementPlanInput): RetirementPlan {
  const inferredAssumptions: string[] = [];
  const targets: ExitSpendingTargets = {
    exitTargetTodayDollars: input.targets.exitTargetTodayDollars ?? DEFAULT_EXIT_TARGET,
    spendingTargetAnnual:
      input.targets.spendingTargetAnnual ?? getAnnualStretchSpend(input.data),
    minSuccessRate: clampRate(input.targets.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE),
    successRateRange: input.targets.successRateRange,
    optimizationObjective:
      input.targets.optimizationObjective ?? DEFAULT_OPTIMIZATION_OBJECTIVE,
    timePreferenceWeights: input.targets.timePreferenceWeights,
  };
  if (input.targets.exitTargetTodayDollars === undefined) {
    inferredAssumptions.push('Defaulted exit target to $1,000,000.');
  }
  if (input.targets.minSuccessRate === undefined) {
    inferredAssumptions.push('Defaulted minimum success rate to 80%.');
  }
  if (input.targets.spendingTargetAnnual === undefined) {
    inferredAssumptions.push('Defaulted spending target to current annual stretch spending.');
  }
  if (input.targets.optimizationObjective === undefined) {
    inferredAssumptions.push('Defaulted optimization objective to maximize_flat_spending.');
  }

  const irmaaPolicy: IrmaaPolicyModel = {
    posture: input.irmaaPolicy.posture ?? 'balanced',
  };
  if (!input.irmaaPolicy.posture) {
    inferredAssumptions.push('Defaulted IRMAA posture to balanced.');
  }

  const autopilotPolicy: AutopilotPolicyModel = {
    posture: input.autopilotPolicy.posture ?? 'defensive',
    optionalSpendingCutsAllowed: input.autopilotPolicy.optionalSpendingCutsAllowed ?? true,
    optionalSpendingFlexPercent: input.autopilotPolicy.optionalSpendingFlexPercent ?? 12,
    travelFlexPercent: input.autopilotPolicy.travelFlexPercent ?? 20,
    defensiveResponses: input.autopilotPolicy.defensiveResponses ?? ['cut_spending'],
  };
  const withdrawalPolicy: WithdrawalPolicyModel = {
    order: input.withdrawalPolicy.order ?? ['cash', 'taxable', 'pretax', 'roth'],
    dynamicDefenseOrdering: input.withdrawalPolicy.dynamicDefenseOrdering ?? true,
    preserveRothPreference: input.withdrawalPolicy.preserveRothPreference ?? false,
    irmaaAware:
      input.withdrawalPolicy.irmaaAware ??
      (irmaaPolicy.posture === 'ignore' ? false : true),
  };
  const effectiveData = applyAssumptionOverrides(input.data, input.constraints);
  const responses = normalizeScenarioResponses(
    input.selectedResponses,
    autopilotPolicy,
    withdrawalPolicy,
    input.constraints,
  );

  return {
    modelCompleteness: inferredAssumptions.length ? 'reconstructed' : 'faithful',
    inferredAssumptions,
    household: input.data.household,
    assets: input.data.accounts,
    income: input.data.income,
    spending: input.data.spending,
    constraints: input.constraints,
    scenarioToggles: {
      stressors: [...input.selectedStressors],
      responses,
    },
    withdrawalPolicy,
    autopilotPolicy,
    targets,
    irmaaPolicy,
    decisionEngineSettings: {
      strategyMode: 'planner_enhanced',
      seedStrategy: input.decisionEngineSettings?.seedStrategy ?? 'shared',
      simulationRunsOverride: input.decisionEngineSettings?.simulationRunsOverride,
    },
    assumptions: input.assumptions,
    baseData: cloneSeedData(input.data),
    effectiveData,
  };
}

export async function analyzeRetirementPlan(
  plan: RetirementPlan,
): Promise<RetirementPlanRunResult> {
  const finishPerf = perfStart('retirement-plan', 'analyze-retirement-plan', {
    stressorCount: plan.scenarioToggles.stressors.length,
    responseCount: plan.scenarioToggles.responses.length,
    objective: plan.targets.optimizationObjective,
  });
  const baselinePath = buildPathResults(
    plan.effectiveData,
    plan.assumptions,
    plan.scenarioToggles.stressors,
    plan.scenarioToggles.responses,
    {
      pathMode: 'selected_only',
      strategyMode: plan.decisionEngineSettings.strategyMode,
    },
  )[0];

  const recommendationConstraints = toRecommendationConstraints(plan.constraints);
  const finishDecisionPerf = perfStart('retirement-plan', 'decision-engine');
  const decision = await evaluateDecisionLevers(
    {
      data: plan.effectiveData,
      assumptions: plan.assumptions,
      selectedStressors: plan.scenarioToggles.stressors,
      selectedResponses: plan.scenarioToggles.responses,
      strategyMode: plan.decisionEngineSettings.strategyMode,
    },
    {
      strategyMode: plan.decisionEngineSettings.strategyMode,
      simulationRunsOverride: plan.decisionEngineSettings.simulationRunsOverride,
      seedBase: plan.assumptions.simulationSeed,
      seedStrategy: plan.decisionEngineSettings.seedStrategy,
      constraints: recommendationConstraints,
      evaluateExcludedScenarios: true,
    },
  );
  finishDecisionPerf('ok', {
    successRate: decision.baseline.successRate,
  });

  const finishSolverPerf = perfStart('retirement-plan', 'spend-solver');
  const spendingMinimums = deriveSpendingMinimums(plan);
  const solver = solveSpendByReverseTimeline({
    data: plan.effectiveData,
    assumptions: plan.assumptions,
    selectedStressors: plan.scenarioToggles.stressors,
    selectedResponses: plan.scenarioToggles.responses,
    optimizationObjective: plan.targets.optimizationObjective,
    timePreferenceWeights: plan.targets.timePreferenceWeights,
    targetLegacyTodayDollars: plan.targets.exitTargetTodayDollars,
    minSuccessRate: plan.targets.minSuccessRate,
    successRateRange: plan.targets.successRateRange,
    spendingFloorAnnual: deriveSpendingFloorAnnual(plan),
    spendingCeilingAnnual: plan.targets.spendingTargetAnnual * 1.4,
    spendingMinimums: {
      essentialAnnualMinimum: spendingMinimums.essentialAnnualMinimum,
      flexibleAnnualMinimum: spendingMinimums.flexibleAnnualMinimum,
      travelAnnualMinimum: spendingMinimums.travelAnnualMinimum,
    },
    toleranceAnnual: 250,
    housingFundingPolicy: plan.constraints.doNotSellHouse
      ? 'do_not_sell_primary_residence'
      : 'allow_primary_residence_sale',
  });
  finishSolverPerf('ok', {
    recommendedAnnualSpend: solver.recommendedAnnualSpend,
    objective: solver.activeOptimizationObjective,
  });

  const finishAutopilotPerf = perfStart('retirement-plan', 'autopilot');
  const autopilot = generateAutopilotPlan({
    data: plan.effectiveData,
    assumptions: plan.assumptions,
    selectedStressors: plan.scenarioToggles.stressors,
    selectedResponses: plan.scenarioToggles.responses,
    targetLegacyTodayDollars: plan.targets.exitTargetTodayDollars,
    minSuccessRate: plan.targets.minSuccessRate,
    successRateRange: plan.targets.successRateRange,
    spendingFloorAnnual: deriveSpendingFloorAnnual(plan),
    spendingCeilingAnnual: plan.targets.spendingTargetAnnual * 1.4,
    doNotSellPrimaryResidence: plan.constraints.doNotSellHouse,
  });
  finishAutopilotPerf('ok', {
    years: autopilot.years.length,
  });

  const irmaa = analyzeIrmaaExposure(plan, autopilot);

  const summary: UnifiedPlanSummary = {
    supportedAnnualSpending: solver.recommendedAnnualSpend,
    supportedMonthlySpending: solver.recommendedMonthlySpend,
    exitTargetTodayDollars: plan.targets.exitTargetTodayDollars,
    projectedExitTodayDollars: solver.projectedLegacyOutcomeTodayDollars,
    successRate: decision.baseline.successRate,
    planVerdict: toVerdict(decision.baseline.successRate),
    biggestDriverOfImprovement:
      decision.biggestDriver?.summary ?? 'No clear single lever currently dominates.',
    biggestRisk:
      decision.baselineRiskWarning ??
      'Primary risk remains early-retirement sequence and spending pressure.',
    nextBestAction:
      decision.recommendationSummary.summary ||
      'No single low-impact change materially improves the plan. Consider combining smaller adjustments.',
    narrative: buildNarrative(plan, solver, decision, irmaa),
  };

  const result: RetirementPlanRunResult = {
    plan,
    baselinePath,
    solver,
    autopilot,
    decision,
    irmaa,
    summary,
  };
  finishPerf('ok', {
    successRate: decision.baseline.successRate,
    verdict: summary.planVerdict,
  });
  return result;
}
