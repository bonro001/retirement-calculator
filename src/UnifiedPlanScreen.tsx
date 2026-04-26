import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { deriveAnnual401kTargets, deriveAnnualHsaTarget } from './contribution-engine';
import type {
  MarketAssumptions,
  PathResult,
  SeedData,
} from './types';
import { perfLog, perfStart } from './debug-perf';
import type { OptimizationObjective } from './optimization-objective';
import {
  evaluatePlan,
  type Plan,
  type LegacyPriority,
  type PlanEvaluation,
  type SuccessFloorMode,
  SUCCESS_FLOOR_MODE_TARGETS,
} from './plan-evaluation';
import type {
  PlanAnalysisWorkerRequest,
  PlanAnalysisWorkerResponse,
} from './plan-analysis-worker-types';
import {
  buildFlightPathStrategicPrepRecommendations,
  type StrategicPrepRecommendation,
} from './flight-path-policy';
import { buildFlightPathPhasePlaybook } from './flight-path-action-playbook';
import { buildExecutiveFlightSummary } from './flight-path-summary';
import { buildProbeChecklist, type ProbeStatus } from './probe-checklist';
import { computeRetirementDateSensitivity } from './sabbatical';
import { getRmdStartAgeForBirthYear } from './retirement-rules';
import type { IrmaaPosture } from './retirement-plan';
import { loadAnalysisResultFromCache, saveAnalysisResultToCache } from './analysis-result-cache';
import { useAppStore } from './store';
import { formatCurrency, formatPercent } from './utils';
import { PolicyMiningStatusCard } from './PolicyMiningStatusCard';
import { PolicyMiningResultsTable } from './PolicyMiningResultsTable';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import { useClusterSession } from './useClusterSession';

const INTERACTIVE_UNIFIED_PLAN_MAX_RUNS = 250;
/**
 * Trial count the policy miner uses, regardless of the user's interactive
 * UI dial. Pinning it here means:
 *   - the corpus is built at a single, known fidelity (so percentile
 *     comparisons across mined records are apples-to-apples)
 *   - bumping this number deliberately busts the corpus (see
 *     `policyMiningFingerprint` below) instead of silently mixing
 *     2000-trial and 5000-trial results in the same dedupe bucket.
 *
 * 2000 trials is the Phase A "good enough" point: per the throughput probe,
 * ~31 min for the full ~8,748-candidate corpus on the M4 mini's 8-worker
 * pool, with bequest p10/p90 stable enough to rank-order policies. 5000
 * trials is more accurate but pushes a single mining run past 75 min,
 * which kills the iterative loop. Re-evaluate when Phase D (multi-host)
 * lands.
 */
const POLICY_MINING_TRIAL_COUNT = 2000;
const PLAN_ANALYSIS_TIMEOUT_MS = 45_000;
const PLAN_ANALYSIS_REQUEST_PREFIX = 'plan-analysis-request';
const INTERACTIVE_RUNTIME_BUDGETS = {
  timeoutMs: 60_000,
  finalEvaluationSimulationRuns: 180,
  solverSearchSimulationRuns: 90,
  solverFinalSimulationRuns: 180,
  solverMaxIterations: 14,
  solverDiagnosticsMode: 'core' as const,
  solverEnableSuccessRelaxationProbe: false,
  decisionSimulationRuns: 72,
  decisionScenarioEvaluationLimit: 12,
  decisionEvaluateExcludedScenarios: false,
  stressTestComplexity: 'reduced' as const,
};
const STRATEGIC_PREP_ROLLOUT_MODE = 'policy_default_shadow_validated' as const;
const PHASE_PLAYBOOK_SECTION_ANCHOR_ID = 'phase-action-playbook';
type PlanSimulationStatus = 'fresh' | 'stale' | 'running';
type PlanAnalysisStatus = 'fresh' | 'stale' | 'running';

type ConstraintModifierKey =
  | 'retireLater'
  | 'sellHouse';

interface ConstraintModifiers {
  retireLater: boolean;
  sellHouse: boolean;
}

const DEFAULT_CONSTRAINT_MODIFIERS: ConstraintModifiers = {
  retireLater: false,
  sellHouse: false,
};

const CONSTRAINT_MODIFIER_LABELS: Record<ConstraintModifierKey, string> = {
  retireLater: 'Retire later',
  sellHouse: 'Sell the house',
};

interface PlanControlsSectionState {
  stressors: boolean;
  responses: boolean;
  baseInputs: boolean;
  spending: boolean;
  incomeTiming: boolean;
  assumptions: boolean;
  planSettings: boolean;
  legacyGoal: boolean;
  recommendationOverlay: boolean;
}

const DEFAULT_PLAN_CONTROLS_SECTION_STATE: PlanControlsSectionState = {
  stressors: false,
  responses: false,
  baseInputs: false,
  spending: false,
  incomeTiming: false,
  assumptions: false,
  planSettings: false,
  legacyGoal: false,
  recommendationOverlay: false,
};

const DEFAULT_TIME_PREFERENCE_PROFILE = {
  ages60to69: 'high',
  ages70to79: 'medium',
  ages80plus: 'low',
} as const;

function formatSuccessFloorModeLabel(mode: SuccessFloorMode) {
  if (mode === 'conservative') {
    return 'Conservative (95%)';
  }
  if (mode === 'balanced') {
    return 'Balanced (92%)';
  }
  if (mode === 'aggressive') {
    return 'Aggressive (85%)';
  }
  return 'Custom';
}

function resolveModeTargetSuccessPercent(mode: SuccessFloorMode) {
  if (mode === 'custom') {
    return Math.round(SUCCESS_FLOOR_MODE_TARGETS.balanced * 100);
  }
  return Math.round(SUCCESS_FLOOR_MODE_TARGETS[mode] * 100);
}

function getInteractiveUnifiedPlanAssumptions(
  assumptions: MarketAssumptions,
): MarketAssumptions {
  if (assumptions.simulationRuns <= INTERACTIVE_UNIFIED_PLAN_MAX_RUNS) {
    return assumptions;
  }
  return {
    ...assumptions,
    simulationRuns: INTERACTIVE_UNIFIED_PLAN_MAX_RUNS,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-plan`
      : 'plan',
  };
}

/**
 * Override the user's interactive trial count with the pinned mining
 * value (`POLICY_MINING_TRIAL_COUNT`). Used for both the controls passed
 * to the miner and the fingerprint suffix — keep them in sync or the
 * dedupe layer will drift from what the engine actually ran.
 */
function getPolicyMiningAssumptions(
  assumptions: MarketAssumptions,
): MarketAssumptions {
  return {
    ...assumptions,
    simulationRuns: POLICY_MINING_TRIAL_COUNT,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-mining-${POLICY_MINING_TRIAL_COUNT}`
      : `mining-${POLICY_MINING_TRIAL_COUNT}`,
  };
}

function nextPaint(callback: () => void) {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    callback();
    return;
  }
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      callback();
    });
  });
}

function deltaPresentation(value: number) {
  if (Math.abs(value) < 0.005) {
    return { label: 'No meaningful change', className: 'text-stone-600' };
  }
  if (value > 0) {
    return { label: `↑ ${(value * 100).toFixed(1)}%`, className: 'text-emerald-700' };
  }
  return { label: `↓ ${(Math.abs(value) * 100).toFixed(1)}%`, className: 'text-red-700' };
}

function buildRunDelta(
  previousRun: PlanEvaluation | null,
  currentRun: PlanEvaluation,
) {
  if (!previousRun) {
    return null;
  }
  const successDelta =
    currentRun.calibration.achievedSuccessRate - previousRun.calibration.achievedSuccessRate;
  const currentTop = currentRun.raw.decision.rankedRecommendations[0]?.name ?? null;
  const previousTop = previousRun.raw.decision.rankedRecommendations[0]?.name ?? null;
  const currentDriver = currentRun.raw.decision.biggestDriver?.scenarioName ?? null;
  const previousDriver = previousRun.raw.decision.biggestDriver?.scenarioName ?? null;
  const projectedLegacyTodayDollarsDelta =
    currentRun.calibration.projectedLegacyTodayDollars -
    previousRun.calibration.projectedLegacyTodayDollars;

  return {
    successDelta,
    topRecommendationMessage:
      currentTop === previousTop
        ? 'Top recommendation unchanged.'
        : `Top recommendation changed from ${previousTop ?? 'none'} to ${currentTop ?? 'none'}.`,
    biggestDriverMessage:
      currentDriver === previousDriver
        ? 'Biggest driver unchanged.'
        : `Biggest driver changed from ${previousDriver ?? 'none'} to ${currentDriver ?? 'none'}.`,
    projectedLegacyTodayDollarsDelta,
  };
}

function verdictClassName(verdict: 'Strong' | 'Moderate' | 'Fragile') {
  if (verdict === 'Strong') {
    return 'text-emerald-700';
  }
  if (verdict === 'Moderate') {
    return 'text-amber-700';
  }
  return 'text-rose-700';
}

function toReadableConstraint(value: string) {
  return value.replaceAll('_', ' ');
}

function toAnchorSlug(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'item';
}

function phaseAnchorId(phaseId: string) {
  return `phase-${toAnchorSlug(phaseId)}`;
}

function phaseActionAnchorId(phaseId: string, actionId: string) {
  return `phase-action-${toAnchorSlug(phaseId)}-${toAnchorSlug(actionId)}`;
}

function buildVerdictExplanation(input: {
  verdict: 'Strong' | 'Moderate' | 'Fragile';
  successRate: number;
  biggestRisk: string;
  primaryBindingConstraint: string;
}) {
  const success = `${Math.round(input.successRate * 100)}%`;
  const binding = toReadableConstraint(input.primaryBindingConstraint);

  if (input.verdict === 'Strong') {
    return `This plan looks strong today because it sustains a ${success} success rate while keeping the main pressure (${binding}) contained.`;
  }
  if (input.verdict === 'Moderate') {
    return `This plan is stable but watchful: success is ${success}, and the main pressure is ${binding}. ${input.biggestRisk}`;
  }
  return `This plan is fragile right now. Success is ${success}, and the route is being constrained by ${binding}. ${input.biggestRisk}`;
}

function formatImpactPoints(value: number) {
  const points = value * 100;
  const sign = points > 0 ? '+' : '';
  return `${sign}${points.toFixed(1)} pts success`;
}

function formatOptimizationObjectiveLabel(value: OptimizationObjective) {
  if (value === 'preserve_legacy') {
    return 'Preserve legacy';
  }
  if (value === 'minimize_failure_risk') {
    return 'Minimize failure risk';
  }
  if (value === 'maximize_time_weighted_spending') {
    return 'Maximize time-weighted spending';
  }
  return 'Maximize flat spending';
}

function formatPhaseLabel(value: 'go_go' | 'slow_go' | 'late') {
  if (value === 'go_go') {
    return '60s (Go-Go)';
  }
  if (value === 'slow_go') {
    return '70s (Slow-Go)';
  }
  return '80+ (Late)';
}

interface StrategicPrepShadowComparison {
  rolloutMode: typeof STRATEGIC_PREP_ROLLOUT_MODE;
  policyCount: number;
  legacyCount: number;
  overlapCount: number;
  overlapRate: number;
  policyOnly: string[];
  legacyOnly: string[];
}

function normalizeRecommendationLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildStrategicPrepShadowComparison(input: {
  policyRecommendations: StrategicPrepRecommendation[];
  legacyRecommendationNames: string[];
}): StrategicPrepShadowComparison {
  const policyLabels = input.policyRecommendations.map((item) => item.title);
  const policySet = new Set(policyLabels.map(normalizeRecommendationLabel));
  const legacySet = new Set(input.legacyRecommendationNames.map(normalizeRecommendationLabel));

  const overlapCount = [...policySet].filter((value) => legacySet.has(value)).length;
  const overlapRate = policySet.size
    ? Number((overlapCount / policySet.size).toFixed(2))
    : 0;

  const policyOnly = policyLabels.filter(
    (label) => !legacySet.has(normalizeRecommendationLabel(label)),
  );
  const legacyOnly = input.legacyRecommendationNames.filter(
    (label) => !policySet.has(normalizeRecommendationLabel(label)),
  );

  return {
    rolloutMode: STRATEGIC_PREP_ROLLOUT_MODE,
    policyCount: policyLabels.length,
    legacyCount: input.legacyRecommendationNames.length,
    overlapCount,
    overlapRate,
    policyOnly,
    legacyOnly,
  };
}

interface FlightPathTimelineEvent {
  id: string;
  when: Date;
  category: 'retirement' | 'medicare' | 'social_security' | 'irmaa' | 'rmd';
  title: string;
  why: string;
  prepLeadMonths: number;
  actionNow: string;
  ageLabel?: string;
}

interface SavedAppliedScenario {
  id: string;
  name: string;
  actionTitle: string;
  createdAtLabel: string;
  successRate: number;
  supportedMonthlySpendNow: number;
  projectedLegacyTodayDollars: number;
  annualFederalTaxEstimate: number;
}

interface PendingScenarioCapture {
  id: string;
  name: string;
  actionTitle: string;
  sourceEvaluationFingerprint: string;
}

const FLIGHT_PATH_EVENT_VISUAL: Record<
  FlightPathTimelineEvent['category'],
  { label: string; markerClassName: string; softClassName: string }
> = {
  retirement: {
    label: 'Retirement',
    markerClassName: 'bg-indigo-600',
    softClassName: 'bg-indigo-100 text-indigo-700',
  },
  medicare: {
    label: 'Medicare',
    markerClassName: 'bg-cyan-600',
    softClassName: 'bg-cyan-100 text-cyan-700',
  },
  social_security: {
    label: 'Social Security',
    markerClassName: 'bg-emerald-600',
    softClassName: 'bg-emerald-100 text-emerald-700',
  },
  irmaa: {
    label: 'IRMAA',
    markerClassName: 'bg-amber-600',
    softClassName: 'bg-amber-100 text-amber-700',
  },
  rmd: {
    label: 'RMD',
    markerClassName: 'bg-rose-600',
    softClassName: 'bg-rose-100 text-rose-700',
  },
};

function parseDateSafe(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function addYears(base: Date, years: number) {
  const next = new Date(base.getTime());
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function addMonths(base: Date, months: number) {
  const next = new Date(base.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

function formatMonthYear(value: Date) {
  return value.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

function formatTimelineDate(value: Date) {
  return value.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fromDateInputValue(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function toDateInputValue(value: string) {
  return value.slice(0, 10);
}

function isDateInputValue(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function ageAtDate(birthDate: string, when: Date) {
  const birth = parseDateSafe(birthDate);
  if (!birth) {
    return null;
  }

  let age = when.getFullYear() - birth.getFullYear();
  const hasBirthdayThisYear =
    when.getMonth() > birth.getMonth() ||
    (when.getMonth() === birth.getMonth() && when.getDate() >= birth.getDate());
  if (!hasBirthdayThisYear) {
    age -= 1;
  }

  return age;
}

function resolveBirthDateForPerson(data: SeedData, person: string | undefined) {
  const normalized = (person ?? '').toLowerCase();
  if (normalized.includes('deb')) {
    return data.household.debbieBirthDate;
  }
  if (normalized.includes('rob')) {
    return data.household.robBirthDate;
  }
  return data.household.robBirthDate;
}

function resolvePersonName(person: string | undefined) {
  const normalized = (person ?? '').toLowerCase();
  if (normalized.includes('deb')) {
    return 'Debbie';
  }
  if (normalized.includes('rob')) {
    return 'Rob';
  }
  return formatPersonLabel(person ?? 'Rob');
}

function formatPrepWindow(months: number) {
  if (months >= 24) {
    return `${Math.round(months / 12)} years`;
  }
  if (months >= 12) {
    return '12 months';
  }
  return `${months} months`;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function priorityClasses(value: StrategicPrepRecommendation['priority']) {
  if (value === 'now') {
    return 'bg-rose-100 text-rose-700';
  }
  if (value === 'soon') {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-blue-100 text-blue-700';
}

function priorityLabel(value: StrategicPrepRecommendation['priority']) {
  if (value === 'now') {
    return 'Do now';
  }
  if (value === 'soon') {
    return 'Do soon';
  }
  return 'Watch';
}

function executiveUrgencyClasses(value: 'act_now' | 'soon' | 'agenda') {
  if (value === 'act_now') {
    return 'bg-rose-100 text-rose-700';
  }
  if (value === 'soon') {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-blue-100 text-blue-700';
}

function executiveUrgencyLabel(value: 'act_now' | 'soon' | 'agenda') {
  if (value === 'act_now') {
    return 'Act now';
  }
  if (value === 'soon') {
    return 'Do soon';
  }
  return 'Agenda';
}

function executiveConfidenceClasses(value: 'high' | 'medium' | 'low' | 'unknown') {
  if (value === 'high') {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (value === 'medium') {
    return 'bg-blue-100 text-blue-700';
  }
  if (value === 'low') {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-stone-200 text-stone-700';
}

function executiveConfidenceLabel(value: 'high' | 'medium' | 'low' | 'unknown') {
  if (value === 'high') {
    return 'High confidence';
  }
  if (value === 'medium') {
    return 'Medium confidence';
  }
  if (value === 'low') {
    return 'Low confidence';
  }
  return 'Confidence pending';
}

function probeStatusClasses(value: ProbeStatus) {
  if (value === 'modeled') {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (value === 'partial') {
    return 'bg-amber-100 text-amber-700';
  }
  if (value === 'attention') {
    return 'bg-rose-100 text-rose-700';
  }
  return 'bg-stone-200 text-stone-700';
}

function probeStatusLabel(value: ProbeStatus) {
  if (value === 'modeled') {
    return 'Modeled';
  }
  if (value === 'partial') {
    return 'Partial';
  }
  if (value === 'attention') {
    return 'Attention';
  }
  return 'Missing';
}

function trustCheckStatusClasses(value: 'pass' | 'warn' | 'fail') {
  if (value === 'pass') {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (value === 'warn') {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-rose-100 text-rose-700';
}

function trustCheckStatusLabel(value: 'pass' | 'warn' | 'fail') {
  if (value === 'pass') {
    return 'Pass';
  }
  if (value === 'warn') {
    return 'Watch';
  }
  return 'Fail';
}

function trustConfidenceClasses(value: 'high' | 'medium' | 'low') {
  if (value === 'high') {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (value === 'medium') {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-rose-100 text-rose-700';
}

function phaseStatusClasses(value: 'active' | 'upcoming' | 'completed') {
  if (value === 'active') {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (value === 'upcoming') {
    return 'bg-blue-100 text-blue-700';
  }
  return 'bg-stone-200 text-stone-600';
}

function phaseStatusLabel(value: 'active' | 'upcoming' | 'completed') {
  if (value === 'active') {
    return 'Active';
  }
  if (value === 'upcoming') {
    return 'Upcoming';
  }
  return 'Completed';
}

function acaRiskBandClasses(value: 'green' | 'yellow' | 'red' | 'unknown') {
  if (value === 'green') {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (value === 'yellow') {
    return 'bg-amber-100 text-amber-700';
  }
  if (value === 'red') {
    return 'bg-rose-100 text-rose-700';
  }
  return 'bg-stone-200 text-stone-700';
}

function acaRiskBandLabel(value: 'green' | 'yellow' | 'red' | 'unknown') {
  if (value === 'green') {
    return 'Subsidy guardrail: safe';
  }
  if (value === 'yellow') {
    return 'Subsidy guardrail: near limit';
  }
  if (value === 'red') {
    return 'Subsidy guardrail: over limit';
  }
  return 'Subsidy guardrail: unknown';
}

function modelCompletenessClasses(value: 'faithful' | 'reconstructed') {
  return value === 'faithful'
    ? 'bg-emerald-100 text-emerald-700'
    : 'bg-amber-100 text-amber-700';
}

function formatRetirementFlowRegimeLabel(value: 'standard' | 'aca_bridge' | 'unknown') {
  if (value === 'aca_bridge') {
    return 'ACA bridge';
  }
  if (value === 'standard') {
    return 'Standard';
  }
  return 'Unknown';
}

function formatIntermediateLabel(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTradeInstructionAccountLabel(input: {
  sourceAccountName: string;
  sourceAccountId: string | null;
}) {
  if (!input.sourceAccountId) {
    return input.sourceAccountName;
  }
  return `${input.sourceAccountName} (${input.sourceAccountId})`;
}

function roundToCents(value: number) {
  return Number(value.toFixed(2));
}

function annualAmountToSalaryPercent(annualAmount: number, salaryAnnual: number) {
  if (!(salaryAnnual > 0)) {
    return 0;
  }
  return roundToCents(annualAmount / salaryAnnual);
}

function sumTradeInstructionDollars(
  instructions: Array<{ dollarAmount: number }>,
) {
  return roundToCents(instructions.reduce((sum, instruction) => sum + instruction.dollarAmount, 0));
}

function scaleTradeInstructionsToGoal(
  instructions: Array<{
    accountBucket: 'pretax' | 'roth' | 'taxable' | 'cash' | 'hsa';
    sourceAccountId: string | null;
    fromSymbol: string;
    toSymbol: string;
    dollarAmount: number;
  }>,
  goalDollars: number,
) {
  if (!instructions.length) {
    return [];
  }
  const normalizedGoal = Math.max(0, roundToCents(goalDollars));
  if (!(normalizedGoal > 0)) {
    return [];
  }
  const baseTotal = sumTradeInstructionDollars(instructions);
  if (!(baseTotal > 0)) {
    return [];
  }

  let assigned = 0;
  return instructions.map((instruction, index) => {
    const isLast = index === instructions.length - 1;
    const proportional = roundToCents(normalizedGoal * (instruction.dollarAmount / baseTotal));
    const scaledAmount = isLast ? roundToCents(normalizedGoal - assigned) : proportional;
    assigned = roundToCents(assigned + scaledAmount);
    return {
      ...instruction,
      dollarAmount: Math.max(0, scaledAmount),
    };
  });
}

function resolveContributionTargets(data: SeedData) {
  const settings = data.income.preRetirementContributions;
  const annual401kTargets = deriveAnnual401kTargets(settings, data.income.salaryAnnual);
  const salaryAnnual = Math.max(0, data.income.salaryAnnual);
  const toSalaryPercent = (annualAmount: number) =>
    salaryAnnual > 0 ? roundToCents(annualAmount / salaryAnnual) : 0;
  const preTaxAnnualAmount = roundToCents(annual401kTargets.preTaxAnnualTarget);
  const rothAnnualAmount = roundToCents(annual401kTargets.rothAnnualTarget);
  const hsaAnnualAmount = roundToCents(deriveAnnualHsaTarget(settings, data.income.salaryAnnual));

  return {
    employee401kPreTaxAnnualAmount: preTaxAnnualAmount,
    employee401kPreTaxPercentOfSalary: toSalaryPercent(preTaxAnnualAmount),
    employee401kRothAnnualAmount: rothAnnualAmount,
    employee401kRothPercentOfSalary: toSalaryPercent(rothAnnualAmount),
    hsaAnnualAmount,
    hsaPercentOfSalary: toSalaryPercent(hsaAnnualAmount),
    hsaCoverageType: settings?.hsaCoverageType ?? 'family',
    employerMatchRate: settings?.employerMatch?.matchRate ?? 0,
    employerMatchCapPercent: settings?.employerMatch?.maxEmployeeContributionPercentOfSalary ?? 0,
  };
}

function isContributionPatchGoalReached(
  data: SeedData,
  patch:
    | {
        employee401kPreTaxAnnualAmount?: number;
        employee401kRothAnnualAmount?: number;
        hsaAnnualAmount?: number;
      }
    | null
    | undefined,
) {
  if (!patch) {
    return false;
  }
  const current = resolveContributionTargets(data);
  const withinTolerance = (currentValue: number, targetValue: number) =>
    Math.abs(currentValue - targetValue) <= 1;
  const preTaxReached =
    typeof patch.employee401kPreTaxAnnualAmount === 'number'
      ? withinTolerance(current.employee401kPreTaxAnnualAmount, patch.employee401kPreTaxAnnualAmount)
      : true;
  const rothReached =
    typeof patch.employee401kRothAnnualAmount === 'number'
      ? withinTolerance(current.employee401kRothAnnualAmount, patch.employee401kRothAnnualAmount)
      : true;
  const hsaReached =
    typeof patch.hsaAnnualAmount === 'number'
      ? withinTolerance(current.hsaAnnualAmount, patch.hsaAnnualAmount)
      : true;
  return preTaxReached && rothReached && hsaReached;
}

function buildEvaluationFingerprint(evaluation: PlanEvaluation | null) {
  if (!evaluation) {
    return 'none';
  }
  return [
    evaluation.summary.successRate.toFixed(6),
    evaluation.calibration.supportedMonthlySpendNow.toFixed(2),
    evaluation.calibration.projectedLegacyTodayDollars.toFixed(2),
    evaluation.raw.spendingCalibration.annualFederalTaxEstimate.toFixed(2),
  ].join('|');
}

function toSavedScenario(
  evaluation: PlanEvaluation,
  draft: PendingScenarioCapture,
): SavedAppliedScenario {
  return {
    id: draft.id,
    name: draft.name,
    actionTitle: draft.actionTitle,
    createdAtLabel: new Date().toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    successRate: evaluation.summary.successRate,
    supportedMonthlySpendNow: evaluation.calibration.supportedMonthlySpendNow,
    projectedLegacyTodayDollars: evaluation.calibration.projectedLegacyTodayDollars,
    annualFederalTaxEstimate: evaluation.raw.spendingCalibration.annualFederalTaxEstimate,
  };
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <p className="text-sm font-medium text-stone-500">{title}</p>
      {subtitle ? <p className="mt-1 text-sm text-stone-600">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </article>
  );
}

function ControlSection({
  title,
  summary,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white/85">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-stone-100/80"
      >
        <div>
          <p className="text-sm font-semibold text-stone-900">{title}</p>
          <p className="mt-1 text-xs text-stone-500">{summary}</p>
        </div>
        <span className="rounded-full bg-stone-200 px-2 py-1 text-xs font-semibold text-stone-700">
          {isOpen ? 'Hide' : 'Show'}
        </span>
      </button>
      {isOpen ? <div className="space-y-3 px-4 pb-4">{children}</div> : null}
    </section>
  );
}

function areConstraintModifiersEqual(
  left: ConstraintModifiers,
  right: ConstraintModifiers,
) {
  return left.retireLater === right.retireLater && left.sellHouse === right.sellHouse;
}

function summarizeSelectedModifiers(modifiers: ConstraintModifiers) {
  const selected = (Object.keys(CONSTRAINT_MODIFIER_LABELS) as ConstraintModifierKey[])
    .filter((key) => modifiers[key])
    .map((key) => CONSTRAINT_MODIFIER_LABELS[key]);

  if (!selected.length) {
    return 'No modifiers selected';
  }
  return selected.join(' · ');
}

function summarizeActiveControls(input: {
  stressorCount: number;
  responseCount: number;
  legacySummary: string;
  modifierSummary: string;
}) {
  return `Stressors ${input.stressorCount} active · Responses ${input.responseCount} active · Legacy ${input.legacySummary} · ${input.modifierSummary}`;
}

function summarizeSelectorNames(names: string[]) {
  if (!names.length) {
    return 'None selected';
  }

  return `${names.length} selected: ${names.join(', ')}`;
}

function formatPersonLabel(value: string) {
  if (!value) {
    return '';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatWindfallLabel(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatLegacyPriorityLabel(value: LegacyPriority) {
  if (value === 'nice_to_have') {
    return 'Nice to have';
  }
  if (value === 'must_preserve') {
    return 'Must preserve';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTimePreferenceLabel(value: 'high' | 'medium' | 'low') {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildPlanAnalysisFingerprint(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  legacyTargetTodayDollars: number;
  legacyPriority: LegacyPriority;
  successFloorMode: SuccessFloorMode;
  optimizationObjective: OptimizationObjective;
  targetSuccessRatePercent: number;
  irmaaPosture: IrmaaPosture;
  appliedConstraintModifiers: ConstraintModifiers;
  autopilotDefensive: boolean;
  autopilotOptionalCutsAllowed: boolean;
  optionalFlexPercent: number;
  travelFlexPercent: number;
  preserveRothPreference: boolean;
  runtimeBudgets: typeof INTERACTIVE_RUNTIME_BUDGETS;
}) {
  return JSON.stringify({
    data: input.data,
    assumptions: input.assumptions,
    selectedStressors: [...input.selectedStressors].sort(),
    selectedResponses: [...input.selectedResponses].sort(),
    calibration: {
      legacyTargetTodayDollars: input.legacyTargetTodayDollars,
      legacyPriority: input.legacyPriority,
      successFloorMode: input.successFloorMode,
      optimizationObjective: input.optimizationObjective,
      targetSuccessRatePercent: input.targetSuccessRatePercent,
    },
    policy: {
      irmaaPosture: input.irmaaPosture,
      appliedConstraintModifiers: input.appliedConstraintModifiers,
      autopilotDefensive: input.autopilotDefensive,
      autopilotOptionalCutsAllowed: input.autopilotOptionalCutsAllowed,
      optionalFlexPercent: input.optionalFlexPercent,
      travelFlexPercent: input.travelFlexPercent,
      preserveRothPreference: input.preserveRothPreference,
    },
    runtimeBudgets: input.runtimeBudgets,
  });
}

function buildPlanForAnalysis(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  modifiers: ConstraintModifiers;
  preserveRothPreference: boolean;
  irmaaPosture: IrmaaPosture;
  legacyTargetTodayDollars: number;
  legacyPriority: LegacyPriority;
  successFloorMode: SuccessFloorMode;
  optimizationObjective: OptimizationObjective;
  targetSuccessRatePercent: number;
  autopilotDefensive: boolean;
  autopilotOptionalCutsAllowed: boolean;
  optionalFlexPercent: number;
  travelFlexPercent: number;
  runtimeBudgets: typeof INTERACTIVE_RUNTIME_BUDGETS;
}): Plan {
  return {
    data: input.data,
    assumptions: getInteractiveUnifiedPlanAssumptions(input.assumptions),
    controls: {
      selectedStressorIds: input.selectedStressors,
      selectedResponseIds: input.selectedResponses,
      toggles: {
        preserveRoth: input.preserveRothPreference,
        increaseCashBuffer: false,
        avoidRetirementDelayRecommendations: !input.modifiers.retireLater,
        avoidHomeSaleRecommendations: !input.modifiers.sellHouse,
      },
    },
    preferences: {
      irmaaPosture: input.irmaaPosture,
      preserveLifestyleFloor: true,
      timePreference: DEFAULT_TIME_PREFERENCE_PROFILE,
      calibration: {
        targetLegacyTodayDollars: Math.max(0, input.legacyTargetTodayDollars),
        legacyPriority: input.legacyPriority,
        successFloorMode: input.successFloorMode,
        optimizationObjective: input.optimizationObjective,
        minSuccessRate: Math.max(0, Math.min(1, input.targetSuccessRatePercent / 100)),
        successRateRange: undefined,
      },
      responsePolicy: {
        posture: input.autopilotDefensive ? 'defensive' : 'balanced',
        optionalSpendingCutsAllowed: input.autopilotOptionalCutsAllowed,
        optionalSpendingFlexPercent: input.optionalFlexPercent,
        travelFlexPercent: input.travelFlexPercent,
        preserveRothPreference: input.preserveRothPreference,
      },
      runtime: input.runtimeBudgets,
    },
  };
}

export function UnifiedPlanScreen({
  data,
  assumptions,
  simulationStatus,
  selectedStressors,
  selectedResponses,
  pathResults,
  showPlanControls = false,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  simulationStatus: PlanSimulationStatus;
  selectedStressors: string[];
  selectedResponses: string[];
  pathResults: PathResult[];
  showPlanControls?: boolean;
}) {
  const toggleStressor = useAppStore((state) => state.toggleStressor);
  const toggleResponse = useAppStore((state) => state.toggleResponse);
  // Subscribe to the cluster client snapshot so the results table below
  // can flip to a remote dispatcher's session corpus. Reads only — the
  // status card owns connect/disconnect via the same singleton hook.
  const cluster = useClusterSession();
  const dispatcherUrl = cluster.snapshot.dispatcherUrl ?? null;
  const updateIncome = useAppStore((state) => state.updateIncome);
  const updatePreRetirementContribution = useAppStore(
    (state) => state.updatePreRetirementContribution,
  );
  const updateEmployerMatchContribution = useAppStore(
    (state) => state.updateEmployerMatchContribution,
  );
  const applyPreRetirementContributionPatch = useAppStore(
    (state) => state.applyPreRetirementContributionPatch,
  );
  const updateSpending = useAppStore((state) => state.updateSpending);
  const updateSocialSecurityClaim = useAppStore((state) => state.updateSocialSecurityClaim);
  const updateWindfall = useAppStore((state) => state.updateWindfall);
  const updateAssumption = useAppStore((state) => state.updateAssumption);
  const applyAccountTradeInstructions = useAppStore(
    (state) => state.applyAccountTradeInstructions,
  );
  const replaceDraftData = useAppStore((state) => state.replaceDraftData);
  const recordDraftTradeSetActivity = useAppStore(
    (state) => state.recordDraftTradeSetActivity,
  );
  const setLatestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.setLatestUnifiedPlanEvaluationContext,
  );
  const setPlanAnalysisStatusInStore = useAppStore((state) => state.setPlanAnalysisStatus);
  const unifiedPlanRerunNonce = useAppStore((state) => state.unifiedPlanRerunNonce);

  const [legacyTargetTodayDollars, setLegacyTargetTodayDollars] = useState(1_000_000);
  const [legacyPriority, setLegacyPriority] = useState<LegacyPriority>('important');
  const [successFloorMode, setSuccessFloorMode] =
    useState<SuccessFloorMode>('balanced');
  const [optimizationObjective, setOptimizationObjective] =
    useState<OptimizationObjective>('maximize_time_weighted_spending');
  const [targetSuccessRatePercent, setTargetSuccessRatePercent] = useState(
    resolveModeTargetSuccessPercent('balanced'),
  );
  const [irmaaPosture, setIrmaaPosture] = useState<IrmaaPosture>('balanced');
  const [draftConstraintModifiers, setDraftConstraintModifiers] = useState<ConstraintModifiers>(
    DEFAULT_CONSTRAINT_MODIFIERS,
  );
  const [appliedConstraintModifiers, setAppliedConstraintModifiers] =
    useState<ConstraintModifiers>(DEFAULT_CONSTRAINT_MODIFIERS);
  const [autopilotDefensive, setAutopilotDefensive] = useState(true);
  const [autopilotOptionalCutsAllowed, setAutopilotOptionalCutsAllowed] = useState(true);
  const [optionalFlexPercent, setOptionalFlexPercent] = useState(12);
  const [travelFlexPercent, setTravelFlexPercent] = useState(20);
  const [preserveRothPreference, setPreserveRothPreference] = useState(false);
  const [currentEvaluation, setCurrentEvaluation] = useState<PlanEvaluation | null>(null);
  const [previousEvaluation, setPreviousEvaluation] = useState<PlanEvaluation | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [analysisCacheCheckPending, setAnalysisCacheCheckPending] = useState(true);
  const [planAnalysisStatus, setPlanAnalysisStatus] = useState<PlanAnalysisStatus>('running');
  const [error, setError] = useState<string | null>(null);
  const [playbookApplyMessage, setPlaybookApplyMessage] = useState<string | null>(null);
  const [savedAppliedScenarios, setSavedAppliedScenarios] = useState<SavedAppliedScenario[]>([]);
  const [pendingScenarioCapture, setPendingScenarioCapture] = useState<PendingScenarioCapture | null>(
    null,
  );
  const [pendingPlaybookAutoRunNonce, setPendingPlaybookAutoRunNonce] = useState(0);
  const [pendingPlaybookAutoRunSourceSignature, setPendingPlaybookAutoRunSourceSignature] =
    useState<string | null>(null);
  const [lastAppliedDraftSnapshot, setLastAppliedDraftSnapshot] = useState<{
    actionTitle: string;
    scenarioName: string;
    instructions: Array<{
      accountBucket: 'pretax' | 'roth' | 'taxable' | 'cash' | 'hsa';
      sourceAccountId: string | null;
      fromSymbol: string;
      toSymbol: string;
      dollarAmount: number;
    }>;
    dataSnapshot: SeedData;
  } | null>(null);
  const lastHandledPlaybookAutoRunNonceRef = useRef(0);
  const lastHandledHeaderRerunNonceRef = useRef(0);
  const latestEvaluationRef = useRef<PlanEvaluation | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const requestCounterRef = useRef(0);
  const requestFingerprintByIdRef = useRef(new Map<string, string>());
  const analysisTimersRef = useRef(
    new Map<string, ReturnType<typeof perfStart>>(),
  );
  const analysisTimeoutsRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const analysisInFlightRef = useRef(false);
  const analysisRunCountRef = useRef(0);
  const hasInitializedRef = useRef(false);
  const lastRunFingerprintRef = useRef<string | null>(null);
  const latestFingerprintRef = useRef<string>('');
  const lastPhaseByRequestRef = useRef(
    new Map<
      string,
      { phase: string; status: 'start' | 'end'; durationMs?: number; meta?: Record<string, unknown> }
    >(),
  );
  const [controlsSectionState, setControlsSectionState] = useState<PlanControlsSectionState>(
    DEFAULT_PLAN_CONTROLS_SECTION_STATE,
  );
  const salaryEndDateValue = useMemo(
    () => toDateInputValue(data.income.salaryEndDate),
    [data.income.salaryEndDate],
  );
  const [salaryEndDateText, setSalaryEndDateText] = useState(salaryEndDateValue);

  useEffect(() => {
    setSalaryEndDateText(salaryEndDateValue);
  }, [salaryEndDateValue]);
  const contributionTargets = useMemo(() => resolveContributionTargets(data), [data]);

  const setSuccessFloorModeAndTarget = useCallback((mode: SuccessFloorMode) => {
    setSuccessFloorMode(mode);
    if (mode !== 'custom') {
      setTargetSuccessRatePercent(resolveModeTargetSuccessPercent(mode));
    }
  }, []);

  const updateTargetSuccessRatePercent = useCallback((nextPercent: number) => {
    const normalized = Math.max(1, Math.min(99, Math.round(nextPercent || 0)));
    setTargetSuccessRatePercent(normalized);
    if (normalized === resolveModeTargetSuccessPercent('conservative')) {
      setSuccessFloorMode('conservative');
      return;
    }
    if (normalized === resolveModeTargetSuccessPercent('balanced')) {
      setSuccessFloorMode('balanced');
      return;
    }
    if (normalized === resolveModeTargetSuccessPercent('aggressive')) {
      setSuccessFloorMode('aggressive');
      return;
    }
    setSuccessFloorMode('custom');
  }, []);

  const primaryPath = pathResults[2] ?? pathResults[0];
  const constraintSummary = summarizeSelectedModifiers(draftConstraintModifiers);
  const legacySummary = `${formatCurrency(legacyTargetTodayDollars)} · ${formatLegacyPriorityLabel(legacyPriority)}`;
  const activeControlsSummary = summarizeActiveControls({
    stressorCount: selectedStressors.length,
    responseCount: selectedResponses.length,
    legacySummary,
    modifierSummary: constraintSummary,
  });
  const hasDraftConstraintChanges = !areConstraintModifiersEqual(
    draftConstraintModifiers,
    appliedConstraintModifiers,
  );
  const activeStressorNames = data.stressors
    .filter((item) => selectedStressors.includes(item.id))
    .map((item) => item.name);
  const activeResponseNames = data.responses
    .filter((item) => selectedResponses.includes(item.id))
    .map((item) => item.name);
  const stressorSummary = summarizeSelectorNames(activeStressorNames);
  const responseSummary = summarizeSelectorNames(activeResponseNames);
  const contributionSummary = `${formatCurrency(contributionTargets.employee401kPreTaxAnnualAmount)} pre-tax 401(k) (${formatPercent(contributionTargets.employee401kPreTaxPercentOfSalary)}) · ${formatCurrency(contributionTargets.employee401kRothAnnualAmount)} Roth 401(k) (${formatPercent(contributionTargets.employee401kRothPercentOfSalary)}) · ${formatCurrency(contributionTargets.hsaAnnualAmount)} HSA (${formatPercent(contributionTargets.hsaPercentOfSalary)})`;
  const analysisInputFingerprint = useMemo(
    () =>
      buildPlanAnalysisFingerprint({
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
        legacyTargetTodayDollars,
        legacyPriority,
        successFloorMode,
        optimizationObjective,
        targetSuccessRatePercent,
        irmaaPosture,
        appliedConstraintModifiers,
        autopilotDefensive,
        autopilotOptionalCutsAllowed,
        optionalFlexPercent,
        travelFlexPercent,
        preserveRothPreference,
        runtimeBudgets: INTERACTIVE_RUNTIME_BUDGETS,
      }),
    [
      appliedConstraintModifiers,
      assumptions,
      autopilotDefensive,
      autopilotOptionalCutsAllowed,
      data,
      irmaaPosture,
      legacyPriority,
      legacyTargetTodayDollars,
      optimizationObjective,
      optionalFlexPercent,
      preserveRothPreference,
      selectedResponses,
      selectedStressors,
      successFloorMode,
      targetSuccessRatePercent,
      travelFlexPercent,
      INTERACTIVE_RUNTIME_BUDGETS,
    ],
  );

  const setControlsSectionOpen = (
    key: keyof PlanControlsSectionState,
    open: boolean,
  ) => {
    setControlsSectionState((previous) => ({
      ...previous,
      [key]: open,
    }));
  };

  const applySalaryEndDateInput = useCallback(
    (value: string) => {
      const next = fromDateInputValue(value);
      if (!next) {
        return;
      }
      updateIncome('salaryEndDate', next);
    },
    [updateIncome],
  );

  const applyPlaybookActionTradeSet = useCallback(
    (
      actionTitle: string,
      instructions: Array<{
        accountBucket: 'pretax' | 'roth' | 'taxable' | 'cash' | 'hsa';
        sourceAccountId: string | null;
        fromSymbol: string;
        toSymbol: string;
        dollarAmount: number;
      }>,
    ) => {
      if (!instructions.length) {
        setPlaybookApplyMessage(`No trade instructions found for "${actionTitle}".`);
        return;
      }
      const sourceSignature = JSON.stringify(data);
      const snapshot = structuredClone(data) as SeedData;
      const scenarioName = `${actionTitle} (${new Date().toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })})`;
      const currentFingerprint = buildEvaluationFingerprint(currentEvaluation);
      const normalizedInstructions = instructions.map((instruction) => ({
        ...instruction,
      }));

      setLastAppliedDraftSnapshot({
        actionTitle,
        scenarioName,
        instructions: normalizedInstructions,
        dataSnapshot: snapshot,
      });
      applyAccountTradeInstructions(normalizedInstructions);
      recordDraftTradeSetActivity({
        kind: 'apply',
        actionTitle,
        scenarioName,
        instructions: normalizedInstructions,
      });
      setPlaybookApplyMessage(
        `Applied "${actionTitle}" to draft account targets. Auto-running analysis and saving scenario "${scenarioName}".`,
      );
      setPendingScenarioCapture({
        id: `applied-scenario-${Date.now()}`,
        name: scenarioName,
        actionTitle,
        sourceEvaluationFingerprint: currentFingerprint,
      });
      setPendingPlaybookAutoRunSourceSignature(sourceSignature);
      setPendingPlaybookAutoRunNonce((value) => value + 1);
      setPlanAnalysisStatus('stale');
    },
    [applyAccountTradeInstructions, currentEvaluation, data, recordDraftTradeSetActivity],
  );

  const applyPlaybookContributionSettingsAction = useCallback(
    (
      actionTitle: string,
      patch: {
        employee401kPreTaxAnnualAmount?: number;
        employee401kRothAnnualAmount?: number;
        hsaAnnualAmount?: number;
      },
    ) => {
      const patchEntries = Object.entries(patch).filter(([, value]) => typeof value === 'number');
      if (!patchEntries.length) {
        setPlaybookApplyMessage(`No payroll settings patch found for "${actionTitle}".`);
        return;
      }
      const sourceSignature = JSON.stringify(data);
      const snapshot = structuredClone(data) as SeedData;
      const scenarioName = `${actionTitle} (${new Date().toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })})`;
      const currentFingerprint = buildEvaluationFingerprint(currentEvaluation);
      const summary = patchEntries
        .map(([key, value]) => `${formatIntermediateLabel(key)} ${formatCurrency(value as number)}`)
        .join(' · ');

      setLastAppliedDraftSnapshot({
        actionTitle,
        scenarioName,
        instructions: [],
        dataSnapshot: snapshot,
      });
      applyPreRetirementContributionPatch(patch);
      setPlaybookApplyMessage(
        `Applied "${actionTitle}" payroll settings (${summary}). Auto-running analysis and saving scenario "${scenarioName}".`,
      );
      setPendingScenarioCapture({
        id: `applied-scenario-${Date.now()}`,
        name: scenarioName,
        actionTitle,
        sourceEvaluationFingerprint: currentFingerprint,
      });
      setPendingPlaybookAutoRunSourceSignature(sourceSignature);
      setPendingPlaybookAutoRunNonce((value) => value + 1);
      setPlanAnalysisStatus('stale');
    },
    [applyPreRetirementContributionPatch, currentEvaluation, data],
  );

  const undoLastAppliedTradeSet = useCallback(() => {
    if (!lastAppliedDraftSnapshot) {
      setPlaybookApplyMessage('No applied trade set to undo.');
      return;
    }
    const sourceSignature = JSON.stringify(data);
    replaceDraftData(lastAppliedDraftSnapshot.dataSnapshot);
    setPlaybookApplyMessage(
      `Undid "${lastAppliedDraftSnapshot.actionTitle}". Auto-running analysis.`,
    );
    recordDraftTradeSetActivity({
      kind: 'undo',
      actionTitle: lastAppliedDraftSnapshot.actionTitle,
      scenarioName: `${lastAppliedDraftSnapshot.scenarioName} (undo)`,
      instructions: lastAppliedDraftSnapshot.instructions,
    });
    setPendingScenarioCapture(null);
    setPendingPlaybookAutoRunSourceSignature(sourceSignature);
    setPendingPlaybookAutoRunNonce((value) => value + 1);
    setLastAppliedDraftSnapshot(null);
    setPlanAnalysisStatus('stale');
  }, [data, lastAppliedDraftSnapshot, recordDraftTradeSetActivity, replaceDraftData]);

  const clearSavedAppliedScenarios = useCallback(() => {
    setSavedAppliedScenarios([]);
    setPlaybookApplyMessage('Cleared saved applied scenarios.');
  }, []);

  const stopTrackedPlanAnalysis = useCallback(
    (
      requestId: string,
      outcome: 'ok' | 'error' | 'cancelled',
      extra?: Record<string, unknown>,
    ) => {
      requestFingerprintByIdRef.current.delete(requestId);
      const end = analysisTimersRef.current.get(requestId);
      if (!end) {
        return;
      }
      end(outcome, extra);
      analysisTimersRef.current.delete(requestId);
    },
    [],
  );

  const clearTrackedPlanAnalysisTimeout = useCallback((requestId: string) => {
    const timeoutId = analysisTimeoutsRef.current.get(requestId);
    if (!timeoutId) {
      return;
    }
    clearTimeout(timeoutId);
    analysisTimeoutsRef.current.delete(requestId);
  }, []);

  useEffect(() => {
    if (typeof Worker === 'undefined') {
      return undefined;
    }

    const worker = new Worker(new URL('./plan-analysis.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<PlanAnalysisWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== activeRequestIdRef.current) {
        return;
      }

      if (message.type === 'progress') {
        lastPhaseByRequestRef.current.set(message.requestId, {
          phase: message.phase,
          status: message.status,
          durationMs: message.durationMs,
          meta: message.meta,
        });
        return;
      }

      if (message.type === 'cancelled') {
        requestFingerprintByIdRef.current.delete(message.requestId);
        lastPhaseByRequestRef.current.delete(message.requestId);
        clearTrackedPlanAnalysisTimeout(message.requestId);
        stopTrackedPlanAnalysis(message.requestId, 'cancelled');
        activeRequestIdRef.current = null;
        analysisInFlightRef.current = false;
        setIsRunning(false);
        setPlanAnalysisStatus(
          lastRunFingerprintRef.current === latestFingerprintRef.current ? 'fresh' : 'stale',
        );
        return;
      }

      if (message.type === 'error') {
        requestFingerprintByIdRef.current.delete(message.requestId);
        lastPhaseByRequestRef.current.delete(message.requestId);
        clearTrackedPlanAnalysisTimeout(message.requestId);
        stopTrackedPlanAnalysis(message.requestId, 'error', { error: message.error });
        activeRequestIdRef.current = null;
        analysisInFlightRef.current = false;
        setIsRunning(false);
        setError(message.error);
        setPlanAnalysisStatus(
          lastRunFingerprintRef.current === latestFingerprintRef.current ? 'fresh' : 'stale',
        );
        return;
      }

      const runFingerprint =
        requestFingerprintByIdRef.current.get(message.requestId) ??
        latestFingerprintRef.current;
      requestFingerprintByIdRef.current.delete(message.requestId);
      lastPhaseByRequestRef.current.delete(message.requestId);
      clearTrackedPlanAnalysisTimeout(message.requestId);
      activeRequestIdRef.current = null;
      analysisInFlightRef.current = false;
      setIsRunning(false);
      setPreviousEvaluation(latestEvaluationRef.current);
      setCurrentEvaluation(message.evaluation);
      setLatestUnifiedPlanEvaluationContext(message.evaluation);
      latestEvaluationRef.current = message.evaluation;
      lastRunFingerprintRef.current = runFingerprint;
      if (runFingerprint === latestFingerprintRef.current) {
        void saveAnalysisResultToCache(runFingerprint, message.evaluation);
      }
      setPlanAnalysisStatus(
        runFingerprint === latestFingerprintRef.current ? 'fresh' : 'stale',
      );
      stopTrackedPlanAnalysis(message.requestId, 'ok', {
        staleAtCompletion: runFingerprint !== latestFingerprintRef.current,
      });
      perfLog('unified-plan', 'simulation end', {
        runCount: analysisRunCountRef.current,
        successRate: message.evaluation.summary.successRate,
        staleAtCompletion: runFingerprint !== latestFingerprintRef.current,
      });
    };

    return () => {
      const activeRequestId = activeRequestIdRef.current;
      if (activeRequestId) {
        clearTrackedPlanAnalysisTimeout(activeRequestId);
        const cancelMessage: PlanAnalysisWorkerRequest = {
          type: 'cancel',
          requestId: activeRequestId,
        };
        worker.postMessage(cancelMessage);
        lastPhaseByRequestRef.current.delete(activeRequestId);
        stopTrackedPlanAnalysis(activeRequestId, 'cancelled', { reason: 'component-unmount' });
      }
      worker.terminate();
      workerRef.current = null;
      activeRequestIdRef.current = null;
      analysisTimersRef.current.clear();
      analysisTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
      analysisTimeoutsRef.current.clear();
      requestFingerprintByIdRef.current.clear();
      lastPhaseByRequestRef.current.clear();
    };
  }, [
    clearTrackedPlanAnalysisTimeout,
    setLatestUnifiedPlanEvaluationContext,
    stopTrackedPlanAnalysis,
  ]);

  const runUnifiedAnalysis = useCallback((
    reason: 'initial-load' | 'manual' | 'update-model',
    modifiersToApply = appliedConstraintModifiers,
  ) => {
    const runFingerprint = buildPlanAnalysisFingerprint({
      data,
      assumptions,
      selectedStressors,
      selectedResponses,
      legacyTargetTodayDollars,
      legacyPriority,
      successFloorMode,
      optimizationObjective,
      targetSuccessRatePercent,
      irmaaPosture,
      appliedConstraintModifiers: modifiersToApply,
      autopilotDefensive,
      autopilotOptionalCutsAllowed,
      optionalFlexPercent,
      travelFlexPercent,
      preserveRothPreference,
      runtimeBudgets: INTERACTIVE_RUNTIME_BUDGETS,
    });

    if (analysisInFlightRef.current) {
      perfLog('unified-plan', 'skip duplicate plan analysis (already running)', {
        reason,
      });
      return;
    }

    if (
      reason !== 'manual' &&
      currentEvaluation &&
      lastRunFingerprintRef.current === runFingerprint
    ) {
      perfLog('unified-plan', 'skip duplicate plan analysis (already fresh)', {
        reason,
      });
      return;
    }

    const finishPerf = perfStart('unified-plan', 'plan-analysis', {
      reason,
      stressorCount: selectedStressors.length,
      responseCount: selectedResponses.length,
    });
    const requestId = `${PLAN_ANALYSIS_REQUEST_PREFIX}-${requestCounterRef.current++}`;

    analysisInFlightRef.current = true;
    analysisRunCountRef.current += 1;
    activeRequestIdRef.current = requestId;
    requestFingerprintByIdRef.current.set(requestId, runFingerprint);
    lastPhaseByRequestRef.current.set(requestId, {
      phase: 'queued',
      status: 'start',
    });
    analysisTimersRef.current.set(requestId, finishPerf);
    latestFingerprintRef.current = runFingerprint;
    setError(null);
    setIsRunning(true);
    setPlanAnalysisStatus('running');
    perfLog('unified-plan', 'simulation start', {
      reason,
      runCount: analysisRunCountRef.current,
      stressorCount: selectedStressors.length,
      responseCount: selectedResponses.length,
    });
    const planToAnalyze = buildPlanForAnalysis({
      data,
      assumptions,
      selectedStressors,
      selectedResponses,
      modifiers: modifiersToApply,
      preserveRothPreference,
      irmaaPosture,
      legacyTargetTodayDollars,
      legacyPriority,
      successFloorMode,
      optimizationObjective,
      targetSuccessRatePercent,
      autopilotDefensive,
      autopilotOptionalCutsAllowed,
      optionalFlexPercent,
      travelFlexPercent,
      runtimeBudgets: INTERACTIVE_RUNTIME_BUDGETS,
    });
    const timeoutMs =
      planToAnalyze.preferences?.runtime?.timeoutMs ?? PLAN_ANALYSIS_TIMEOUT_MS;
    const worker = workerRef.current;
    const timeoutId = setTimeout(() => {
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      const latestPhase = lastPhaseByRequestRef.current.get(requestId);
      perfLog('unified-plan', 'simulation timeout', {
        requestId,
        timeoutMs,
        runCount: analysisRunCountRef.current,
        phase: latestPhase?.phase,
      });
      requestFingerprintByIdRef.current.delete(requestId);
      lastPhaseByRequestRef.current.delete(requestId);
      clearTrackedPlanAnalysisTimeout(requestId);
      stopTrackedPlanAnalysis(requestId, 'cancelled', { reason: 'timeout' });
      const timeoutCancelMessage: PlanAnalysisWorkerRequest = {
        type: 'cancel',
        requestId,
      };
      workerRef.current?.postMessage(timeoutCancelMessage);
      activeRequestIdRef.current = null;
      analysisInFlightRef.current = false;
      setIsRunning(false);
      setError(
        `Plan analysis timed out during ${latestPhase?.phase ?? 'an unknown phase'}. Settings: runs=${planToAnalyze.preferences?.runtime?.finalEvaluationSimulationRuns ?? planToAnalyze.assumptions.simulationRuns}, stressors=${selectedStressors.length}, objective=${optimizationObjective}, diagnostics=${planToAnalyze.preferences?.runtime?.solverDiagnosticsMode ?? 'full'}, scenarioLimit=${planToAnalyze.preferences?.runtime?.decisionScenarioEvaluationLimit ?? 'full'}, timeoutMs=${timeoutMs}.`,
      );
      setPlanAnalysisStatus(
        lastRunFingerprintRef.current === latestFingerprintRef.current ? 'fresh' : 'stale',
      );
    }, timeoutMs);
    analysisTimeoutsRef.current.set(requestId, timeoutId);

    if (worker) {
      const runMessage: PlanAnalysisWorkerRequest = {
        type: 'run',
        payload: {
          requestId,
          plan: planToAnalyze,
        },
      };
      try {
        worker.postMessage(runMessage);
      } catch (postError) {
        requestFingerprintByIdRef.current.delete(requestId);
        clearTrackedPlanAnalysisTimeout(requestId);
        stopTrackedPlanAnalysis(requestId, 'error', { reason: 'worker-post-failed' });
        activeRequestIdRef.current = null;
        analysisInFlightRef.current = false;
        setIsRunning(false);
        setPlanAnalysisStatus(
          lastRunFingerprintRef.current === latestFingerprintRef.current ? 'fresh' : 'stale',
        );
        const message =
          postError instanceof Error
            ? postError.message
            : 'Failed to start plan analysis in worker.';
        setError(message);
      }
      return;
    }

    nextPaint(() => {
      void (async () => {
        try {
          const evaluation = await evaluatePlan(planToAnalyze, {
            onPhaseProgress: (progress) => {
              lastPhaseByRequestRef.current.set(requestId, {
                phase: progress.phase,
                status: progress.status,
                durationMs: progress.durationMs,
                meta: progress.meta,
              });
            },
          });
          if (activeRequestIdRef.current !== requestId) {
            stopTrackedPlanAnalysis(requestId, 'cancelled', {
              reason: 'superseded',
            });
            clearTrackedPlanAnalysisTimeout(requestId);
            lastPhaseByRequestRef.current.delete(requestId);
            return;
          }
          setPreviousEvaluation(latestEvaluationRef.current);
          setCurrentEvaluation(evaluation);
          setLatestUnifiedPlanEvaluationContext(evaluation);
          latestEvaluationRef.current = evaluation;
          lastRunFingerprintRef.current = runFingerprint;
          if (runFingerprint === latestFingerprintRef.current) {
            void saveAnalysisResultToCache(runFingerprint, evaluation);
          }
          setPlanAnalysisStatus(
            runFingerprint === latestFingerprintRef.current ? 'fresh' : 'stale',
          );
          stopTrackedPlanAnalysis(requestId, 'ok', {
            staleAtCompletion: runFingerprint !== latestFingerprintRef.current,
            fallback: true,
          });
          clearTrackedPlanAnalysisTimeout(requestId);
          lastPhaseByRequestRef.current.delete(requestId);
          perfLog('unified-plan', 'simulation end', {
            runCount: analysisRunCountRef.current,
            successRate: evaluation.summary.successRate,
            staleAtCompletion: runFingerprint !== latestFingerprintRef.current,
            fallback: true,
          });
        } catch (runError) {
          if (activeRequestIdRef.current !== requestId) {
            stopTrackedPlanAnalysis(requestId, 'cancelled', {
              reason: 'superseded',
              fallback: true,
            });
            clearTrackedPlanAnalysisTimeout(requestId);
            lastPhaseByRequestRef.current.delete(requestId);
            return;
          }
          const message = runError instanceof Error ? runError.message : 'Unified plan analysis failed.';
          setError(message);
          setPlanAnalysisStatus(
            lastRunFingerprintRef.current === latestFingerprintRef.current ? 'fresh' : 'stale',
          );
          stopTrackedPlanAnalysis(requestId, 'error', {
            message,
            fallback: true,
          });
          clearTrackedPlanAnalysisTimeout(requestId);
          lastPhaseByRequestRef.current.delete(requestId);
        } finally {
          if (activeRequestIdRef.current === requestId) {
            activeRequestIdRef.current = null;
          }
          analysisInFlightRef.current = false;
          setIsRunning(false);
        }
      })();
    });
  }, [
    appliedConstraintModifiers,
    assumptions,
    autopilotDefensive,
    autopilotOptionalCutsAllowed,
    data,
    irmaaPosture,
    legacyPriority,
    legacyTargetTodayDollars,
    optimizationObjective,
    optionalFlexPercent,
    preserveRothPreference,
    selectedResponses,
    selectedStressors,
    setLatestUnifiedPlanEvaluationContext,
    successFloorMode,
    stopTrackedPlanAnalysis,
    currentEvaluation,
    clearTrackedPlanAnalysisTimeout,
    targetSuccessRatePercent,
    travelFlexPercent,
  ]);

  const currentEvaluationFingerprint = useMemo(
    () => buildEvaluationFingerprint(currentEvaluation),
    [currentEvaluation],
  );

  // Mining-specific fingerprint: same baseline output digest as the UI uses,
  // plus the trial count the miner is pinned to. Two reasons it's separate:
  //   1) The interactive UI dial (`assumptions.simulationRuns`) does NOT
  //      affect what the miner runs — `getPolicyMiningAssumptions` always
  //      pins to `POLICY_MINING_TRIAL_COUNT` — so the corpus key must
  //      reflect that pinned value, not whatever the user has dialed in.
  //   2) Bumping `POLICY_MINING_TRIAL_COUNT` to e.g. 5000 must invalidate
  //      every existing record so the dedupe layer doesn't quietly mix
  //      2000-trial and 5000-trial percentiles in the same ranking.
  // The "v1" tag is reserved for a future change to the fingerprint scheme
  // itself — bump it (without changing trial count) and the corpus resets
  // cleanly without confusing anyone.
  const policyMiningFingerprint = useMemo(
    () =>
      currentEvaluationFingerprint
        ? `${currentEvaluationFingerprint}|trials=${POLICY_MINING_TRIAL_COUNT}|fpv1`
        : '',
    [currentEvaluationFingerprint],
  );

  useEffect(() => {
    if (!pendingPlaybookAutoRunNonce) {
      return;
    }
    if (pendingPlaybookAutoRunNonce === lastHandledPlaybookAutoRunNonceRef.current) {
      return;
    }
    if (
      pendingPlaybookAutoRunSourceSignature !== null &&
      JSON.stringify(data) === pendingPlaybookAutoRunSourceSignature
    ) {
      return;
    }
    lastHandledPlaybookAutoRunNonceRef.current = pendingPlaybookAutoRunNonce;
    setPendingPlaybookAutoRunSourceSignature(null);
    runUnifiedAnalysis('manual', appliedConstraintModifiers);
  }, [
    appliedConstraintModifiers,
    data,
    pendingPlaybookAutoRunNonce,
    pendingPlaybookAutoRunSourceSignature,
    runUnifiedAnalysis,
  ]);

  useEffect(() => {
    if (!unifiedPlanRerunNonce) {
      return;
    }
    if (unifiedPlanRerunNonce === lastHandledHeaderRerunNonceRef.current) {
      return;
    }
    lastHandledHeaderRerunNonceRef.current = unifiedPlanRerunNonce;
    runUnifiedAnalysis('manual', appliedConstraintModifiers);
  }, [appliedConstraintModifiers, runUnifiedAnalysis, unifiedPlanRerunNonce]);

  useEffect(() => {
    if (!pendingScenarioCapture) {
      return;
    }
    if (isRunning || !currentEvaluation) {
      return;
    }
    if (currentEvaluationFingerprint === pendingScenarioCapture.sourceEvaluationFingerprint) {
      return;
    }

    const savedScenario = toSavedScenario(currentEvaluation, pendingScenarioCapture);
    setSavedAppliedScenarios((previous) => [savedScenario, ...previous].slice(0, 12));
    setPlaybookApplyMessage(
      `Auto-run complete. Saved scenario "${pendingScenarioCapture.name}" for side-by-side comparison.`,
    );
    setPendingScenarioCapture(null);
  }, [currentEvaluation, currentEvaluationFingerprint, isRunning, pendingScenarioCapture]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const intervalId = window.setInterval(() => {
      const hasActiveRequest = activeRequestIdRef.current !== null;
      const isInFlight = analysisInFlightRef.current;
      if (hasActiveRequest && isInFlight) {
        return;
      }
      if (activeRequestIdRef.current) {
        requestFingerprintByIdRef.current.delete(activeRequestIdRef.current);
        lastPhaseByRequestRef.current.delete(activeRequestIdRef.current);
        clearTrackedPlanAnalysisTimeout(activeRequestIdRef.current);
        stopTrackedPlanAnalysis(activeRequestIdRef.current, 'cancelled', {
          reason: 'stale-running-state-guard',
        });
        activeRequestIdRef.current = null;
      }
      analysisInFlightRef.current = false;
      setIsRunning(false);
      setPlanAnalysisStatus(
        lastRunFingerprintRef.current === latestFingerprintRef.current ? 'fresh' : 'stale',
      );
      perfLog('unified-plan', 'running-state guard reset applied');
    }, 1000);
    return () => {
      clearInterval(intervalId);
    };
  }, [isRunning, clearTrackedPlanAnalysisTimeout, stopTrackedPlanAnalysis]);

  const handleUpdateModelFromDraft = () => {
    const nextApplied = { ...draftConstraintModifiers };
    setAppliedConstraintModifiers(nextApplied);
    runUnifiedAnalysis('update-model', nextApplied);
  };

  const setDraftModifier = (key: ConstraintModifierKey, checked: boolean) => {
    setDraftConstraintModifiers((previous) => ({
      ...previous,
      [key]: checked,
    }));
  };

  useEffect(() => {
    latestFingerprintRef.current = analysisInputFingerprint;
    if (!hasInitializedRef.current || analysisInFlightRef.current) {
      return;
    }
    if (!lastRunFingerprintRef.current) {
      return;
    }
    if (lastRunFingerprintRef.current === analysisInputFingerprint) {
      return;
    }
    perfLog('unified-plan', 'effect-triggered stale mark after input change', {
      reason: 'render-triggered recompute detected',
    });
    setPlanAnalysisStatus('stale');
  }, [analysisInputFingerprint]);

  useEffect(() => {
    setPlanAnalysisStatusInStore(planAnalysisStatus);
  }, [planAnalysisStatus, setPlanAnalysisStatusInStore]);

  useEffect(() => {
    if (hasInitializedRef.current) {
      return;
    }
    hasInitializedRef.current = true;
    void (async () => {
      try {
        const cached = await loadAnalysisResultFromCache(analysisInputFingerprint);
        if (cached) {
          setCurrentEvaluation(cached);
          lastRunFingerprintRef.current = analysisInputFingerprint;
          setPlanAnalysisStatus('fresh');
          perfLog('unified-plan', 'restored from cache, skipping initial analysis');
        } else {
          perfLog('unified-plan', 'effect-triggered initial plan analysis');
          runUnifiedAnalysis('initial-load', appliedConstraintModifiers);
        }
      } finally {
        setAnalysisCacheCheckPending(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount — analysisInputFingerprint captured at mount time

  const currentRun = currentEvaluation?.raw.run ?? null;
  const runDelta = currentEvaluation ? buildRunDelta(previousEvaluation, currentEvaluation) : null;
  const successDeltaPresentation = runDelta ? deltaPresentation(runDelta.successDelta) : null;
  const annualEssentialSpend = data.spending.essentialMonthly * 12;
  const annualFlexibleSpend = data.spending.optionalMonthly * 12;
  const annualFlexibleSpendMinimum = currentEvaluation?.raw.spendingCalibration.flexibleSpendingMinimum ??
    annualFlexibleSpend;
  const annualTravelSpend = data.spending.travelEarlyRetirementAnnual;
  const annualTravelSpendMinimum = currentEvaluation?.raw.spendingCalibration.travelSpendingMinimum ??
    annualTravelSpend;
  const annualTotalSpend =
    annualEssentialSpend +
    annualFlexibleSpend +
    annualTravelSpend +
    data.spending.annualTaxesInsurance;
  const userTargetMonthlySpend =
    currentEvaluation?.calibration.userTargetMonthlySpendNow ?? annualTotalSpend / 12;
  const plannerSupportedMonthlySpend =
    currentEvaluation?.calibration.supportedMonthlySpendNow ??
    (primaryPath.yearlySeries[0]?.medianSpending ?? annualTotalSpend) / 12;
  const spendGapNowMonthly =
    currentEvaluation?.calibration.spendGapNowMonthly ?? (plannerSupportedMonthlySpend - userTargetMonthlySpend);
  const topRecommendation = currentEvaluation?.recommendations.top[0] ?? null;
  const timePreference = currentEvaluation?.timePreference ?? null;
  const nextBestStepText = timePreference?.earlySpendingCanIncreaseSafely
    ? timePreference.recommendation
    : topRecommendation?.summary ??
      currentEvaluation?.summary.bestAction ??
      'Keep current spending steady and rerun after meaningful input changes.';
  const nextBestStepLabel = timePreference?.earlySpendingCanIncreaseSafely
    ? 'Time-shifted spending move'
    : topRecommendation?.name ?? 'Stability move';
  const currentRisk =
    currentEvaluation?.summary.biggestRisk ??
    'The current plan is most exposed to early-sequence pressure.';
  const currentOpportunity =
    timePreference?.explanation ??
    topRecommendation?.summary ??
    currentEvaluation?.summary.bestAction ??
    'Reducing flexible spending by a small amount is usually the lowest-disruption lever.';
  const activeOptimizationObjective: OptimizationObjective =
    currentEvaluation?.summary.activeOptimizationObjective ?? optimizationObjective;
  const activeOptimizationObjectiveLabel = formatOptimizationObjectiveLabel(
    activeOptimizationObjective,
  );
  const verdictExplanation = currentEvaluation
    ? buildVerdictExplanation({
        verdict: currentEvaluation.summary.planVerdict,
        successRate: currentEvaluation.summary.successRate,
        biggestRisk: currentEvaluation.summary.biggestRisk,
        primaryBindingConstraint: currentEvaluation.responsePolicy.primaryBindingConstraint,
      })
    : 'Plan verdict explanation will appear once the latest plan analysis completes.';
  const hardConstraints = currentRun
    ? [
        `Success floor: ${formatPercent(currentEvaluation?.calibration.minimumSuccessRateTarget ?? currentRun.plan.targets.minSuccessRate)}`,
        `Legacy floor: ${formatCurrency(currentEvaluation?.calibration.legacyFloorTodayDollars ?? currentRun.plan.targets.exitTargetTodayDollars)} (today's dollars)`,
        `Legacy target band: ${formatCurrency(currentEvaluation?.calibration.legacyTargetBandLowerTodayDollars ?? currentRun.plan.targets.exitTargetTodayDollars)} to ${formatCurrency(currentEvaluation?.calibration.legacyTargetBandUpperTodayDollars ?? currentRun.plan.targets.exitTargetTodayDollars)} (today's dollars)`,
        'Preserve essential spending floor',
        ...(currentRun.plan.constraints.doNotSellHouse ? ['Keep house (no primary residence sale)'] : []),
        ...(currentRun.plan.constraints.doNotRetireLater ? ['Do not retire later'] : []),
      ]
    : [];
  const softPreferences = currentRun
    ? [
        `Autopilot posture: ${currentRun.plan.autopilotPolicy.posture}`,
        `IRMAA posture: ${currentRun.plan.irmaaPolicy.posture}`,
        currentRun.plan.withdrawalPolicy.preserveRothPreference
          ? 'Preserve Roth preference enabled'
          : 'Preserve Roth preference disabled',
        currentRun.plan.constraints.minimumTravelBudgetAnnual
          ? `Travel floor: ${formatCurrency(currentRun.plan.constraints.minimumTravelBudgetAnnual)}/yr`
          : 'Travel floor: none',
      ]
    : [];
  const solverDiagnostics = currentEvaluation?.raw.spendingCalibration;
  const solverDiagnosticsRecord = solverDiagnostics as unknown as Record<string, unknown> | undefined;
  const debugDiagnosticsPayload = solverDiagnosticsRecord
    ? {
        activeOptimizationObjective: solverDiagnosticsRecord.activeOptimizationObjective ?? null,
        minimumSuccessRateTarget: solverDiagnosticsRecord.minimumSuccessRateTarget ?? null,
        achievedSuccessRate: solverDiagnosticsRecord.achievedSuccessRate ?? null,
        bindingGuardrail: solverDiagnosticsRecord.bindingGuardrail ?? null,
        bindingGuardrailExplanation: solverDiagnosticsRecord.bindingGuardrailExplanation ?? null,
        nextUnlock: solverDiagnosticsRecord.nextUnlock ?? null,
        nextUnlockImpactMonthly:
          solverDiagnosticsRecord.nextUnlockImpactMonthly ??
          solverDiagnosticsRecord.successFloorRelaxationDeltaMonthly ??
          null,
        projectedLegacyTodayDollars:
          solverDiagnosticsRecord.projectedLegacyTodayDollars ??
          solverDiagnosticsRecord.projectedLegacyOutcomeTodayDollars ??
          null,
        overReservedAmount: solverDiagnosticsRecord.overReservedAmount ?? null,
        runtimeDiagnostics:
          solverDiagnosticsRecord.runtimeDiagnostics ??
          currentEvaluation?.raw.run.runtimeDiagnostics ??
          null,
      }
    : null;
  const requiredDebugFields = [
    'activeOptimizationObjective',
    'minimumSuccessRateTarget',
    'achievedSuccessRate',
    'bindingGuardrail',
    'bindingGuardrailExplanation',
    'nextUnlock',
    'nextUnlockImpactMonthly',
    'projectedLegacyTodayDollars',
    'overReservedAmount',
  ];
  const missingDebugFields = solverDiagnosticsRecord
    ? requiredDebugFields.filter(
        (field) => !Object.prototype.hasOwnProperty.call(solverDiagnosticsRecord, field),
      )
    : [];
  const acaExposureYears = currentEvaluation
    ? currentEvaluation.raw.run.autopilot.years.filter(
        (year) => year.acaStatus === 'Above subsidy range' || year.acaStatus === 'Bridge breached',
      ).length
    : 0;
  const flightPathTimeline = useMemo(() => {
    const now = new Date();
    const nowMs = now.getTime();
    const events: FlightPathTimelineEvent[] = [];
    const pushEvent = (event: FlightPathTimelineEvent | null) => {
      if (!event || Number.isNaN(event.when.getTime())) {
        return;
      }
      events.push(event);
    };

    const robBirthDate = parseDateSafe(data.household.robBirthDate);
    const debbieBirthDate = parseDateSafe(data.household.debbieBirthDate);
    const retirementDate = parseDateSafe(data.income.salaryEndDate);
    const medicareDates: Date[] = [];

    if (retirementDate) {
      const robAge = ageAtDate(data.household.robBirthDate, retirementDate);
      const debbieAge = ageAtDate(data.household.debbieBirthDate, retirementDate);
      pushEvent({
        id: 'retirement',
        when: retirementDate,
        category: 'retirement',
        title: 'Retirement',
        why: 'Salary income ends and withdrawals become the primary funding source.',
        prepLeadMonths: 24,
        actionNow:
          'Lock the monthly spending target and confirm the first 24 months of withdrawal liquidity.',
        ageLabel:
          robAge !== null && debbieAge !== null
            ? `Rob ${robAge} · Debbie ${debbieAge}`
            : undefined,
      });
    }

    const medicarePeople = [
      { id: 'rob', label: 'Rob', birthDate: robBirthDate, birthDateRaw: data.household.robBirthDate },
      {
        id: 'debbie',
        label: 'Debbie',
        birthDate: debbieBirthDate,
        birthDateRaw: data.household.debbieBirthDate,
      },
    ];
    medicarePeople.forEach((person) => {
      if (!person.birthDate) {
        return;
      }
      const medicareDate = addYears(person.birthDate, 65);
      medicareDates.push(medicareDate);
      pushEvent({
        id: `${person.id}-medicare-65`,
        when: medicareDate,
        category: 'medicare',
        title: `${person.label} turns 65 (Medicare window)`,
        why: 'Coverage and premium decisions start to affect healthcare cost and MAGI strategy.',
        prepLeadMonths: 12,
        actionNow: 'Confirm enrollment timing and pick the Medicare path before penalties can apply.',
        ageLabel: `Age ${ageAtDate(person.birthDateRaw, medicareDate) ?? 65}`,
      });
    });

    data.income.socialSecurity.forEach((entry, index) => {
      const claimAge = Math.max(0, Math.round(entry.claimAge));
      const birthDateRaw = resolveBirthDateForPerson(data, entry.person);
      const birthDate = parseDateSafe(birthDateRaw);
      if (!birthDate) {
        return;
      }
      const claimDate = addYears(birthDate, claimAge);
      const personLabel = resolvePersonName(entry.person);
      pushEvent({
        id: `ss-${personLabel.toLowerCase()}-${claimAge}-${index}`,
        when: claimDate,
        category: 'social_security',
        title: `${personLabel} starts Social Security`,
        why: 'Guaranteed income begins and can reduce portfolio draw pressure.',
        prepLeadMonths: 12,
        actionNow: 'Reconfirm claiming age against taxes, IRMAA, and cash-flow needs.',
        ageLabel: `Age ${claimAge}`,
      });
    });

    const autopilotYears = currentEvaluation?.raw.run.autopilot.years ?? [];
    const firstIrmaaPressureYear = autopilotYears.find((year) => {
      const hasMedicareMembers = year.robAge >= 65 || year.debbieAge >= 65;
      if (!hasMedicareMembers) {
        return false;
      }
      const status = year.irmaaStatus.toLowerCase();
      return status.includes('surcharge') || (typeof year.irmaaHeadroom === 'number' && year.irmaaHeadroom < 8_000);
    });

    if (firstIrmaaPressureYear) {
      const lookbackYear = firstIrmaaPressureYear.year - 2;
      pushEvent({
        id: `irmaa-watch-${lookbackYear}`,
        when: new Date(lookbackYear, 0, 1),
        category: 'irmaa',
        title: 'IRMAA watch zone begins',
        why: `First modeled Medicare surcharge pressure appears in ${firstIrmaaPressureYear.year}, and IRMAA uses a 2-year MAGI lookback.`,
        prepLeadMonths: 0,
        actionNow: 'Start smoothing MAGI now by coordinating withdrawals and Roth conversion pace.',
        ageLabel: `Rob ${Math.max(0, firstIrmaaPressureYear.robAge - 2)} · Debbie ${Math.max(0, firstIrmaaPressureYear.debbieAge - 2)}`,
      });
    } else if (medicareDates.length) {
      const earliestMedicareDate = medicareDates.reduce((earliest, candidate) =>
        candidate.getTime() < earliest.getTime() ? candidate : earliest,
      );
      const irmaaLookbackDate = addYears(earliestMedicareDate, -2);
      pushEvent({
        id: 'irmaa-lookback',
        when: irmaaLookbackDate,
        category: 'irmaa',
        title: 'IRMAA lookback window begins',
        why: 'Medicare surcharges are based on MAGI from two tax years earlier.',
        prepLeadMonths: 6,
        actionNow: 'Pre-plan taxable income and conversion steps before Medicare eligibility arrives.',
      });
    }

    const firstRmdYear = autopilotYears.find((year) => year.rmdAmount > 1);
    if (firstRmdYear) {
      pushEvent({
        id: `rmd-${firstRmdYear.year}`,
        when: new Date(firstRmdYear.year, 0, 1),
        category: 'rmd',
        title: 'RMD phase starts',
        why: 'Required distributions force taxable income and can increase guardrail pressure.',
        prepLeadMonths: 18,
        actionNow: 'Set a withholding and withdrawal plan so forced income does not create avoidable spikes.',
        ageLabel: `Rob ${firstRmdYear.robAge} · Debbie ${firstRmdYear.debbieAge}`,
      });
    } else {
      const rmdCandidates = medicarePeople
        .filter((person) => person.birthDate)
        .map((person) => {
          const birthYear = person.birthDate?.getFullYear() ?? 0;
          const startAge = getRmdStartAgeForBirthYear(birthYear);
          const when = addYears(person.birthDate as Date, startAge);
          return {
            personLabel: person.label,
            startAge,
            when,
          };
        });
      if (rmdCandidates.length) {
        const earliestRmd = rmdCandidates.reduce((earliest, candidate) =>
          candidate.when.getTime() < earliest.when.getTime() ? candidate : earliest,
        );
        pushEvent({
          id: `rmd-estimate-${earliestRmd.personLabel.toLowerCase()}`,
          when: earliestRmd.when,
          category: 'rmd',
          title: 'Estimated RMD start',
          why: 'Required minimum distributions are expected to begin and raise taxable income.',
          prepLeadMonths: 18,
          actionNow: 'Model conversion timing before RMDs begin to reduce later tax and IRMAA pressure.',
          ageLabel: `${earliestRmd.personLabel} age ${earliestRmd.startAge}`,
        });
      }
    }

    const uniqueSortedEvents = events
      .filter((event, index, collection) =>
        index === collection.findIndex((candidate) => candidate.id === event.id),
      )
      .sort((left, right) => left.when.getTime() - right.when.getTime());
    const shortHorizonEvents = uniqueSortedEvents.filter((event) => event.category !== 'rmd');
    const recentThresholdMs = addMonths(now, -18).getTime();
    const timelineEvents = shortHorizonEvents.filter((event) => event.when.getTime() >= recentThresholdMs);
    const limitedEvents = (timelineEvents.length ? timelineEvents : shortHorizonEvents).slice(0, 8);
    const nextEventIndex = limitedEvents.findIndex((event) => event.when.getTime() >= nowMs);

    const earliestEventMs = limitedEvents[0]?.when.getTime() ?? nowMs;
    const latestEventMs = limitedEvents[limitedEvents.length - 1]?.when.getTime() ?? nowMs;
    const timelineStartMs = Math.min(addMonths(now, -6).getTime(), addMonths(new Date(earliestEventMs), -3).getTime());
    const timelineEndMs = Math.max(addMonths(now, 24).getTime(), addMonths(new Date(latestEventMs), 3).getTime());
    const timelineSpanMs = Math.max(1, timelineEndMs - timelineStartMs);

    const displayEvents = limitedEvents.map((event, index) => {
      const prepStart = addMonths(event.when, -event.prepLeadMonths);
      const prepStartsLabel =
        prepStart.getTime() <= nowMs
          ? `Now (${formatPrepWindow(event.prepLeadMonths)} lead)`
          : `${formatMonthYear(prepStart)} (${formatPrepWindow(event.prepLeadMonths)} lead)`;
      return {
        ...event,
        isPast: event.when.getTime() < nowMs,
        isNext: nextEventIndex >= 0 ? index === nextEventIndex : index === limitedEvents.length - 1,
        markerRow: index % 2,
        positionPct: clampPercent(((event.when.getTime() - timelineStartMs) / timelineSpanMs) * 100),
        whenLabel: formatTimelineDate(event.when),
        prepStartsLabel,
      };
    });

    return {
      events: displayEvents,
      nextEvent: nextEventIndex >= 0 ? displayEvents[nextEventIndex] : null,
      legendCategories: Array.from(new Set(displayEvents.map((event) => event.category))),
      rangeStartLabel: formatMonthYear(new Date(timelineStartMs)),
      rangeEndLabel: formatMonthYear(new Date(timelineEndMs)),
      nowPositionPct: clampPercent(((nowMs - timelineStartMs) / timelineSpanMs) * 100),
    };
  }, [currentEvaluation, data.household, data.income]);
  const strategicPrepPolicy = useMemo(
    () =>
      buildFlightPathStrategicPrepRecommendations({
        evaluation: currentEvaluation,
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
        counterfactualSimulationRuns: 72,
      }),
    [assumptions, currentEvaluation, data, selectedResponses, selectedStressors],
  );
  const phasePlaybook = useMemo(
    () =>
      buildFlightPathPhasePlaybook({
        evaluation: currentEvaluation,
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
      }),
    [assumptions, currentEvaluation, data, selectedResponses, selectedStressors],
  );
  const acaBridgeMetrics = phasePlaybook.phases.find((phase) => phase.id === 'aca_bridge')?.acaMetrics;
  const retirementDateSensitivity = useMemo(
    () => computeRetirementDateSensitivity(data.income),
    [data.income],
  );
  const acaGuardrailAdjustment = phasePlaybook.diagnostics.acaGuardrailAdjustment;
  const subsidyRecoveryModeActive = acaGuardrailAdjustment.mode === 'recovery';
  const subsidyWatchModeActive = acaGuardrailAdjustment.mode === 'watch';
  const prioritizedPhaseId = acaGuardrailAdjustment.prioritizedPhaseIds[0] ?? null;
  const prioritizedPhase = prioritizedPhaseId
    ? phasePlaybook.phases.find((phase) => phase.id === prioritizedPhaseId) ?? null
    : null;
  const prioritizedPhaseTopAction = prioritizedPhase
    ? prioritizedPhase.actions.find((action) => action.isTopRecommendation) ??
      prioritizedPhase.actions[0] ??
      null
    : null;
  const prioritizedJumpHref = prioritizedPhaseTopAction && prioritizedPhase
    ? `#${phaseActionAnchorId(prioritizedPhase.id, prioritizedPhaseTopAction.id)}`
    : prioritizedPhase
      ? `#${phaseAnchorId(prioritizedPhase.id)}`
      : `#${PHASE_PLAYBOOK_SECTION_ANCHOR_ID}`;
  const prioritizedPayrollRateRecommendation = (() => {
    const preTaxAnnualTarget =
      prioritizedPhaseTopAction?.contributionSettingsPatch?.employee401kPreTaxAnnualAmount;
    if (!(typeof preTaxAnnualTarget === 'number' && preTaxAnnualTarget > 0)) {
      return null;
    }
    const salaryAnnual = Math.max(0, data.income.salaryAnnual);
    if (!(salaryAnnual > 0)) {
      return null;
    }
    const currentRate = contributionTargets.employee401kPreTaxPercentOfSalary;
    const targetRate = annualAmountToSalaryPercent(preTaxAnnualTarget, salaryAnnual);
    const cushionRate = roundToCents(Math.min(1, targetRate + 0.005));
    return {
      currentRate,
      targetRate,
      cushionRate,
      bridgeYear: acaBridgeMetrics?.bridgeYear ?? null,
    };
  })();
  const strategicPrepRecommendations = strategicPrepPolicy.recommendations;
  const legacySuggestedLevers = currentEvaluation?.recommendations.top.length
    ? currentEvaluation.recommendations.top.map((item) => item.name)
    : [];
  const strategicPrepShadowComparison = useMemo(
    () =>
      buildStrategicPrepShadowComparison({
        policyRecommendations: strategicPrepRecommendations,
        legacyRecommendationNames: legacySuggestedLevers,
      }),
    [legacySuggestedLevers, strategicPrepRecommendations],
  );
  const suggestedLevers = strategicPrepRecommendations.length
    ? strategicPrepRecommendations.map((item) => item.title)
    : ['No lever available yet'];
  const executiveSummary = useMemo(
    () =>
      buildExecutiveFlightSummary({
        data,
        evaluation: currentEvaluation,
        phasePlaybook,
        strategicPrepRecommendations,
      }),
    [currentEvaluation, data, phasePlaybook, strategicPrepRecommendations],
  );
  const probeChecklist = useMemo(
    () =>
      buildProbeChecklist({
        data,
        assumptions,
        evaluation: currentEvaluation,
      }),
    [assumptions, currentEvaluation, data],
  );
  const trustPanel = currentEvaluation?.trustPanel ?? null;
  const inheritanceDependenceRate = trustPanel?.metrics.inheritanceDependenceRate ?? 0;
  const inheritanceSensitivityDelta =
    currentEvaluation?.raw.decision.allScenarioResults.find(
      (s) => s.scenarioId === 'assumption_remove_inheritance',
    )?.delta.deltaSuccessRate ?? null;
  const baselineSuccessRate = currentEvaluation?.summary.successRate ?? null;
  const successWithoutInheritance =
    baselineSuccessRate !== null && inheritanceSensitivityDelta !== null
      ? Math.max(0, baselineSuccessRate + inheritanceSensitivityDelta)
      : null;
  const showInheritanceFragility =
    inheritanceDependenceRate >= 0.35 ||
    (inheritanceSensitivityDelta !== null && inheritanceSensitivityDelta <= -0.1);
  const debugDiagnosticsPayloadWithStrategicPrep = debugDiagnosticsPayload
    ? {
        ...debugDiagnosticsPayload,
        strategicPrepRollout: strategicPrepShadowComparison,
        strategicPrepDiagnostics: strategicPrepPolicy.diagnostics,
      }
    : null;
  const substantialWealthReasons = solverDiagnostics
    ? [
        solverDiagnostics.surplusPreservedBecause,
        `Binding constraint: ${toReadableConstraint(solverDiagnostics.bindingConstraint)}.`,
        `Legacy floor: ${formatCurrency(solverDiagnostics.legacyFloorTodayDollars)}; target band: ${formatCurrency(solverDiagnostics.legacyTargetBandLowerTodayDollars)} to ${formatCurrency(solverDiagnostics.legacyTargetBandUpperTodayDollars)}; projected ending wealth: ${formatCurrency(solverDiagnostics.projectedLegacyOutcomeTodayDollars)}.`,
        solverDiagnostics.overReservedAmount > 0
          ? `Over-reserved amount versus legacy target: ${formatCurrency(solverDiagnostics.overReservedAmount)}.`
          : solverDiagnostics.legacyWithinTargetBand
            ? 'Projected ending wealth is inside the legacy target band.'
            : 'Projected ending wealth is at or below the legacy target band.',
        `Flexible spending target/min: ${formatCurrency(solverDiagnostics.flexibleSpendingTarget)} / ${formatCurrency(solverDiagnostics.flexibleSpendingMinimum)} per year.`,
        `Travel spending target/min: ${formatCurrency(solverDiagnostics.travelSpendingTarget)} / ${formatCurrency(solverDiagnostics.travelSpendingMinimum)} per year.`,
        solverDiagnostics.constrainedBySpendingFloors
          ? 'Spending floors are currently binding the optimization.'
          : solverDiagnostics.constrainedByLegacyTarget
            ? 'Legacy target proximity is currently binding the optimization.'
            : `Primary optimizer driver: ${toReadableConstraint(solverDiagnostics.optimizationConstraintDriver)}.`,
        solverDiagnostics.houseRetentionContribution,
        solverDiagnostics.inheritanceMateriality === 'high'
          ? 'Inheritance is materially supporting feasibility in this path.'
          : solverDiagnostics.inheritanceMateriality === 'medium'
            ? 'Inheritance contributes meaningfully in some downside paths.'
            : 'Inheritance is not a major dependency in this path.',
        `Median outcomes can stay high while tail-risk remains: p10 ending wealth is ${formatCurrency(solverDiagnostics.p10EndingWealth)} and first-10-year failure risk is ${formatPercent(solverDiagnostics.first10YearFailureRisk)}.`,
      ]
    : [];
  const showTimeWeightedComparison =
    activeOptimizationObjective === 'maximize_time_weighted_spending' &&
    Boolean(solverDiagnostics?.spendingDeltaByPhase.length);

  return (
    <section className="rounded-[32px] border border-white/70 bg-white/80 p-6 shadow-lg shadow-amber-950/5 backdrop-blur">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-serif text-3xl tracking-tight text-stone-900">Current Flight Path</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700">
            {analysisCacheCheckPending
              ? 'Loading from cache…'
              : isRunning
                ? 'Analysis running'
                : error
                  ? 'Analysis error'
                  : planAnalysisStatus === 'stale'
                    ? 'Analysis outdated'
                  : currentEvaluation
                    ? 'Analysis current'
                    : 'Analysis pending'}
          </span>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              simulationStatus === 'fresh'
                ? 'bg-emerald-100 text-emerald-800'
                : simulationStatus === 'running'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-amber-100 text-amber-800'
            }`}
          >
            {simulationStatus === 'fresh'
              ? 'Plan data fresh'
              : simulationStatus === 'running'
                ? 'Simulation running'
                : 'Plan data outdated'}
          </span>
        </div>
      </div>

      {/* Policy Mining: forward-search corpus over spend × SS × Roth axes.
          Mounted at the top so the controls are immediately discoverable
          rather than buried below the verdict / plan-controls sections.
          Read-only when no plan fingerprint yet; live controls (Start /
          Pause / Resume / Cancel) appear once an evaluation has run. */}
      <div className="mb-4">
        <PolicyMiningStatusCard
          baselineFingerprint={policyMiningFingerprint || null}
          engineVersion={POLICY_MINER_ENGINE_VERSION}
          controls={
            policyMiningFingerprint
              ? {
                  baseline: data,
                  // Pin the miner's trial count via the helper, not the
                  // UI-dialed `assumptions`. Keeping these in sync with
                  // `policyMiningFingerprint` is the dedupe contract.
                  assumptions: getPolicyMiningAssumptions(assumptions),
                  evaluatedByNodeId: 'local-browser',
                  legacyTargetTodayDollars,
                }
              : undefined
          }
        />
        {/* Mined Plan Candidates: ranked, filterable view of the corpus.
            currentPlan reference enables Δ-vs-current columns so the
            household sees recommendations as deltas from where they
            stand today, not as raw absolute numbers. */}
        <PolicyMiningResultsTable
          baselineFingerprint={policyMiningFingerprint || null}
          engineVersion={POLICY_MINER_ENGINE_VERSION}
          dispatcherUrl={dispatcherUrl}
          currentPlan={
            policyMiningFingerprint
              ? {
                  annualSpendTodayDollars: annualTotalSpend,
                  primarySocialSecurityClaimAge:
                    data.income.socialSecurity[0]?.claimAge ?? null,
                  spouseSocialSecurityClaimAge:
                    data.income.socialSecurity[1]?.claimAge ?? null,
                  // Roth conversion in the engine is policy-driven (strategy +
                  // MAGI buffer), not a simple annual ceiling, so there's no
                  // clean apples-to-apples diff against the miner's ceiling axis.
                  // Leaving this null surfaces the miner's absolute ceiling
                  // without a misleading delta.
                  rothConversionAnnualCeiling: null,
                  p50EndingWealthTodayDollars:
                    primaryPath?.medianEndingWealth ?? null,
                }
              : undefined
          }
        />
      </div>

      {error ? (
        <p className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {!error && planAnalysisStatus === 'stale' ? (
        <p className="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Plan analysis is outdated relative to current inputs. Run Plan Analysis to update results.
        </p>
      ) : null}
      {acaBridgeMetrics ? (
        <div className="mb-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-stone-900">ACA Subsidy Guardrail</p>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] ${acaRiskBandClasses(
                acaBridgeMetrics.subsidyRiskBand,
              )}`}
            >
              {acaRiskBandLabel(acaBridgeMetrics.subsidyRiskBand)}
            </span>
          </div>
          <p className="mt-1 text-xs">
            Bridge year {acaBridgeMetrics.bridgeYear ?? 'not modeled'} · projected MAGI{' '}
            {formatCurrency(acaBridgeMetrics.projectedMagi)} · ACA-friendly ceiling{' '}
            {acaBridgeMetrics.acaFriendlyMagiCeiling === null
              ? 'not modeled'
              : formatCurrency(acaBridgeMetrics.acaFriendlyMagiCeiling)}{' '}
            · headroom{' '}
            {acaBridgeMetrics.headroomToCeiling === null
              ? 'not modeled'
              : formatCurrency(acaBridgeMetrics.headroomToCeiling)}
            .
          </p>
          <p className="mt-1 text-xs text-stone-600">
            Yellow starts within {formatCurrency(acaBridgeMetrics.guardrailBufferDollars)} of the
            ceiling; red means projected MAGI is above the modeled ceiling.
          </p>
          {subsidyRecoveryModeActive ? (
            <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-800">
              Flight path auto-adjusted: subsidy recovery mode is active. ACA bridge actions are now prioritized to close an estimated{' '}
              {formatCurrency(acaGuardrailAdjustment.requiredMagiReduction)} MAGI gap.{' '}
              {prioritizedPayrollRateRecommendation ? (
                <>
                  Current pre-tax 401(k) rate {formatPercent(prioritizedPayrollRateRecommendation.currentRate)}; recommended target{' '}
                  {formatPercent(prioritizedPayrollRateRecommendation.targetRate)} (set {formatPercent(
                    prioritizedPayrollRateRecommendation.cushionRate,
                  )} for cushion).
                </>
              ) : null}{' '}
              <a
                href={prioritizedJumpHref}
                className="font-semibold underline decoration-rose-400 underline-offset-2"
              >
                Jump to prioritized action
              </a>
              .
            </p>
          ) : null}
          {subsidyWatchModeActive ? (
            <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
              Flight path auto-adjusted: subsidy watch mode is active. ACA bridge actions are being ranked ahead while headroom is tight.{' '}
              {prioritizedPayrollRateRecommendation ? (
                <>
                  Current pre-tax 401(k) rate {formatPercent(prioritizedPayrollRateRecommendation.currentRate)}; recommendation points to{' '}
                  {formatPercent(prioritizedPayrollRateRecommendation.targetRate)} (or {formatPercent(
                    prioritizedPayrollRateRecommendation.cushionRate,
                  )} for cushion).
                </>
              ) : null}{' '}
              <a
                href={prioritizedJumpHref}
                className="font-semibold underline decoration-amber-500 underline-offset-2"
              >
                Jump to prioritized action
              </a>
              .
            </p>
          ) : null}
        </div>
      ) : null}
      {retirementDateSensitivity.length ? (
        <div className="mb-4 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
          <p className="font-semibold text-stone-900">Retirement date sensitivity</p>
          <p className="mt-1 text-xs text-stone-600">
            Passive readout only — current plan ends salary on{' '}
            {new Date(data.income.salaryEndDate).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
            . Earlier exits reduce wage MAGI (helpful for ACA bridge years) but may trigger sabbatical repayment.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-stone-500">
                  <th className="py-1 pr-4 font-medium">Shift</th>
                  <th className="py-1 pr-4 font-medium">Shifted date</th>
                  <th className="py-1 pr-4 font-medium">Wage income Δ</th>
                  <th className="py-1 pr-4 font-medium">Wage MAGI Δ</th>
                  <th className="py-1 pr-4 font-medium">Sabbatical owed</th>
                  <th className="py-1 pr-4 font-medium">Net cash Δ</th>
                </tr>
              </thead>
              <tbody>
                {retirementDateSensitivity.map((point) => (
                  <tr key={point.monthsShift} className="border-t border-stone-100">
                    <td className="py-1 pr-4">
                      {point.monthsShift > 0 ? '+' : ''}
                      {point.monthsShift} mo
                    </td>
                    <td className="py-1 pr-4 text-stone-600">{point.shiftedRetireDate}</td>
                    <td className="py-1 pr-4">
                      {point.salaryIncomeDelta >= 0 ? '+' : ''}
                      {formatCurrency(point.salaryIncomeDelta)}
                    </td>
                    <td className="py-1 pr-4">
                      {point.magiDelta >= 0 ? '+' : ''}
                      {formatCurrency(point.magiDelta)}
                    </td>
                    <td className="py-1 pr-4 text-rose-700">
                      {point.sabbaticalRepayment
                        ? `-${formatCurrency(point.sabbaticalRepayment)}`
                        : '$0'}
                    </td>
                    <td className="py-1 pr-4 font-semibold">
                      {point.netCashDelta >= 0 ? '+' : ''}
                      {formatCurrency(point.netCashDelta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.income.sabbatical ? (
            <p className="mt-2 text-xs text-stone-500">
              Sabbatical: {data.income.sabbatical.paidWeeks} paid weeks from{' '}
              {data.income.sabbatical.returnDate}; {data.income.sabbatical.weeksForgivenPerMonth}{' '}
              week forgiven per month worked.
            </p>
          ) : null}
        </div>
      ) : null}

      <SectionCard title="Flight Path">
        <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
          {trustPanel ? (
            <div className="mb-3 rounded-xl border border-stone-200 bg-stone-50/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Decision Trust Panel</p>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${trustConfidenceClasses(
                      trustPanel.confidence,
                    )}`}
                  >
                    {trustPanel.confidence} confidence
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                      trustPanel.safeToRely ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                    }`}
                  >
                    {trustPanel.safeToRely ? 'safe to rely' : 'needs review'}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-xs text-stone-700">{trustPanel.summary}</p>
              <p className="mt-1 text-[11px] text-stone-600">
                Pass {trustPanel.metrics.passCount} · Watch {trustPanel.metrics.warnCount} · Fail{' '}
                {trustPanel.metrics.failCount} · Recommendation evidence coverage{' '}
                {Math.round(trustPanel.metrics.recommendationEvidenceCoverage * 100)}%
              </p>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {trustPanel.checks.map((check) => (
                  <div
                    key={check.id}
                    className="rounded-md border border-stone-200 bg-white px-2 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-stone-900">{check.title}</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${trustCheckStatusClasses(
                          check.status,
                        )}`}
                      >
                        {trustCheckStatusLabel(check.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-700">{check.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {showInheritanceFragility ? (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.14em] text-amber-700">Inheritance Fragility</p>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-800">
                  {inheritanceSensitivityDelta !== null
                    ? `${Math.round(Math.abs(inheritanceSensitivityDelta) * 100)} pt drop if removed`
                    : `${Math.round(inheritanceDependenceRate * 100)}% dependent`}
                </span>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                <div className="rounded-lg bg-white px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-stone-500">With inheritance</p>
                  <p className="mt-1 text-sm font-semibold text-stone-900">
                    {baselineSuccessRate !== null ? `${Math.round(baselineSuccessRate * 100)}%` : '—'}
                  </p>
                  <p className="text-[11px] text-stone-500">success rate</p>
                </div>
                <div className="rounded-lg bg-white px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-stone-500">Without inheritance</p>
                  <p className="mt-1 text-sm font-semibold text-rose-700">
                    {successWithoutInheritance !== null ? `${Math.round(successWithoutInheritance * 100)}%` : '—'}
                  </p>
                  <p className="text-[11px] text-stone-500">success rate</p>
                </div>
                <div className="rounded-lg bg-white px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-stone-500">Delta</p>
                  <p className="mt-1 text-sm font-semibold text-rose-700">
                    {inheritanceSensitivityDelta !== null
                      ? `${(inheritanceSensitivityDelta * 100).toFixed(0)} pts`
                      : '—'}
                  </p>
                  <p className="text-[11px] text-stone-500">success impact</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-amber-900">
                This plan relies heavily on a $500K inheritance arriving on schedule. If it is delayed or does not arrive, ACA bridge liquidity and spending flexibility become the primary resilience levers. Consider the &ldquo;Delayed inheritance&rdquo; stressor to stress-test this scenario.
              </p>
            </div>
          ) : null}

          <div className="rounded-xl border border-stone-200 bg-stone-50/70 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Executive Summary</p>
            <div className="mt-2 grid gap-2 md:grid-cols-4">
              <div className="rounded-lg bg-white px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.12em] text-stone-500">Tracked net worth</p>
                <p className="mt-1 text-sm font-semibold text-stone-900">
                  {formatCurrency(executiveSummary.headlineMetrics.trackedNetWorth)}
                </p>
              </div>
              <div className="rounded-lg bg-white px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.12em] text-stone-500">Salary through</p>
                <p className="mt-1 text-sm font-semibold text-stone-900">
                  {executiveSummary.headlineMetrics.salaryEndDateIso}
                </p>
              </div>
              <div className="rounded-lg bg-white px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.12em] text-stone-500">Windfalls modeled</p>
                <p className="mt-1 text-sm font-semibold text-stone-900">
                  {formatCurrency(executiveSummary.headlineMetrics.windfallTotal)}
                </p>
                <p className="text-[11px] text-stone-500">
                  {executiveSummary.headlineMetrics.windfallCount} event(s)
                </p>
              </div>
              <div className="rounded-lg bg-white px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.12em] text-stone-500">Modeled success</p>
                <p className="mt-1 text-sm font-semibold text-stone-900">
                  {executiveSummary.planHealth.successRate === null
                    ? 'Pending'
                    : formatPercent(executiveSummary.planHealth.successRate)}
                </p>
              </div>
            </div>
            <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-stone-700">
              {executiveSummary.narrative.whereThingsStand}
            </p>
            <p className="mt-2 rounded-lg bg-white px-3 py-2 text-sm text-stone-700">
              {executiveSummary.narrative.whatMattersNow}
            </p>
            <div className="mt-3 rounded-lg border border-stone-200 bg-white p-3">
              <p className="text-xs uppercase tracking-[0.12em] text-stone-500">
                Advisor Probe Checklist
              </p>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {probeChecklist.items.map((item) => (
                  <div key={item.id} className="rounded-md border border-stone-200 bg-stone-50 px-2 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-stone-900">{item.title}</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${probeStatusClasses(
                          item.status,
                        )}`}
                      >
                        {probeStatusLabel(item.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-700">{item.summary}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-3">
              {executiveSummary.actionCards.map((card) => {
                const jumpHref = card.phaseAnchorTarget
                  ? card.phaseAnchorTarget.actionId
                    ? `#${phaseActionAnchorId(card.phaseAnchorTarget.phaseId, card.phaseAnchorTarget.actionId)}`
                    : `#${phaseAnchorId(card.phaseAnchorTarget.phaseId)}`
                  : null;
                return (
                  <div key={card.id} className="rounded-lg border border-stone-200 bg-white p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${executiveUrgencyClasses(
                          card.urgency,
                        )}`}
                      >
                        {executiveUrgencyLabel(card.urgency)}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${executiveConfidenceClasses(
                          card.confidence,
                        )}`}
                      >
                        {executiveConfidenceLabel(card.confidence)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-stone-900">{card.title}</p>
                    <p className="mt-1 text-xs text-stone-700">{card.detail}</p>
                    <p className="mt-1 text-xs text-stone-600">{card.whyItMatters}</p>
                    <p className="mt-1 text-xs text-stone-600">
                      <span className="font-semibold">Expected impact:</span> {card.expectedImpact}
                    </p>
                    {jumpHref ? (
                      <a
                        href={jumpHref}
                        className="mt-2 inline-block text-xs font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2"
                      >
                        Jump to modeled action
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-stone-600">
              Objective: {activeOptimizationObjectiveLabel}
              {timePreference ? (
                <>
                  {' '}· Time preference 60s {formatTimePreferenceLabel(timePreference.profile.ages60to69)} · 70s{' '}
                  {formatTimePreferenceLabel(timePreference.profile.ages70to79)} · 80+{' '}
                  {formatTimePreferenceLabel(timePreference.profile.ages80plus)}
                </>
              ) : null}
            </p>
          </div>

          {flightPathTimeline.events.length ? (
            <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
                Major Event Timeline (MVP)
              </p>
              <div className="mt-2 rounded-lg border border-stone-200 bg-white px-3 py-2">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-stone-500">
                  <span>{flightPathTimeline.rangeStartLabel}</span>
                  <span>Now Marker</span>
                  <span>{flightPathTimeline.rangeEndLabel}</span>
                </div>
                <div className="relative mt-2 h-20">
                  <div className="absolute left-0 right-0 top-9 h-2 rounded-full bg-gradient-to-r from-slate-300 via-slate-200 to-slate-300" />
                  <div
                    className="absolute top-5 h-10 w-[2px] bg-stone-400"
                    style={{ left: `${flightPathTimeline.nowPositionPct}%` }}
                  />
                  {flightPathTimeline.events.map((event) => (
                    <div
                      key={`${event.id}-marker`}
                      className="absolute"
                      style={{
                        left: `${event.positionPct}%`,
                        top: event.markerRow === 0 ? '4px' : '38px',
                        transform: 'translateX(-50%)',
                      }}
                    >
                      <div
                        className={`h-3 w-3 rounded-full ring-2 ring-white shadow ${
                          FLIGHT_PATH_EVENT_VISUAL[event.category].markerClassName
                        } ${event.isNext ? 'h-4 w-4' : ''}`}
                        title={event.title}
                      />
                      <p className="mt-1 w-24 truncate text-[10px] leading-4 text-stone-600">
                        {event.title}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {flightPathTimeline.legendCategories.map((category) => (
                    <span
                      key={category}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        FLIGHT_PATH_EVENT_VISUAL[category].softClassName
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          FLIGHT_PATH_EVENT_VISUAL[category].markerClassName
                        }`}
                      />
                      {FLIGHT_PATH_EVENT_VISUAL[category].label}
                    </span>
                  ))}
                </div>
              </div>
              {flightPathTimeline.nextEvent ? (
                <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">
                  Next milestone: {flightPathTimeline.nextEvent.title} ({flightPathTimeline.nextEvent.whenLabel})
                </p>
              ) : null}
              <ol className="mt-3 space-y-2">
                {flightPathTimeline.events.map((event) => (
                  <li
                    key={event.id}
                    className={`rounded-lg border px-3 py-2 ${
                      event.isNext
                        ? 'border-blue-200 bg-blue-50/70'
                        : 'border-stone-200 bg-white'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-stone-900">{event.title}</p>
                        <p className="text-xs text-stone-500">
                          {event.whenLabel}
                          {event.ageLabel ? ` · ${event.ageLabel}` : ''}
                        </p>
                        <span
                          className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            FLIGHT_PATH_EVENT_VISUAL[event.category].softClassName
                          }`}
                        >
                          {FLIGHT_PATH_EVENT_VISUAL[event.category].label}
                        </span>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                          event.isNext
                            ? 'bg-blue-100 text-blue-700'
                            : event.isPast
                              ? 'bg-stone-200 text-stone-600'
                              : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {event.isNext ? 'Next' : event.isPast ? 'Started' : 'Upcoming'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-700">{event.why}</p>
                    <p className="mt-1 text-xs text-stone-600">
                      <span className="font-semibold">Prep starts:</span> {event.prepStartsLabel}
                    </p>
                    <p className="mt-1 text-xs text-stone-600">
                      <span className="font-semibold">Action now:</span> {event.actionNow}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {phasePlaybook.phases.length ? (
            <div
              id={PHASE_PLAYBOOK_SECTION_ANCHOR_ID}
              className="mt-4 rounded-xl border border-stone-200 bg-white p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
                  Phase Action Playbook (MVP)
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {acaGuardrailAdjustment.active ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        subsidyRecoveryModeActive
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {subsidyRecoveryModeActive ? 'Subsidy recovery mode' : 'Subsidy watch mode'}
                    </span>
                  ) : null}
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-600">
                    Runs/seed {phasePlaybook.diagnostics.scenarioRuns} / {phasePlaybook.diagnostics.simulationSeed}
                  </span>
                </div>
              </div>
              {phasePlaybook.diagnostics.inferredAssumptions.length ? (
                <details className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
                  <summary className="cursor-pointer font-semibold">
                    Global inferred assumptions ({phasePlaybook.diagnostics.inferredAssumptions.length})
                  </summary>
                  <ul className="mt-1 space-y-1 text-amber-900">
                    {phasePlaybook.diagnostics.inferredAssumptions.map((assumption) => (
                      <li key={`global-assumption-${assumption}`}>- {assumption}</li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p className="mt-2 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-900">
                  <span className="font-semibold">Model completeness:</span> faithful (no inferred assumptions in phase playbook generation).
                </p>
              )}
              {playbookApplyMessage ? (
                <p className="mt-2 rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-900">
                  {playbookApplyMessage}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!lastAppliedDraftSnapshot}
                  onClick={undoLastAppliedTradeSet}
                  className="rounded-full bg-stone-700 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-stone-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Undo Last Applied Trade Set
                </button>
                <button
                  type="button"
                  disabled={!savedAppliedScenarios.length}
                  onClick={clearSavedAppliedScenarios}
                  className="rounded-full bg-stone-200 px-3 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-stone-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Clear Saved Scenarios
                </button>
              </div>
              {savedAppliedScenarios.length ? (
                <div className="mt-2 overflow-x-auto rounded-md border border-stone-200">
                  <p className="bg-stone-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-600">
                    Saved Applied Scenarios (Side-By-Side)
                  </p>
                  <table className="min-w-full text-left text-xs text-stone-700">
                    <thead className="bg-white text-[10px] uppercase tracking-[0.12em] text-stone-500">
                      <tr>
                        <th className="px-2 py-1">Scenario</th>
                        <th className="px-2 py-1">Created</th>
                        <th className="px-2 py-1">Success</th>
                        <th className="px-2 py-1">Supported Now</th>
                        <th className="px-2 py-1">Legacy (Today $)</th>
                        <th className="px-2 py-1">Annual Fed Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {savedAppliedScenarios.map((scenario) => (
                        <tr key={scenario.id} className="border-t border-stone-100">
                          <td className="px-2 py-1">
                            <p className="font-semibold text-stone-900">{scenario.name}</p>
                            <p className="text-[11px] text-stone-500">{scenario.actionTitle}</p>
                          </td>
                          <td className="px-2 py-1">{scenario.createdAtLabel}</td>
                          <td className="px-2 py-1">{formatPercent(scenario.successRate)}</td>
                          <td className="px-2 py-1">{formatCurrency(scenario.supportedMonthlySpendNow)}/mo</td>
                          <td className="px-2 py-1">{formatCurrency(scenario.projectedLegacyTodayDollars)}</td>
                          <td className="px-2 py-1">{formatCurrency(scenario.annualFederalTaxEstimate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <div className="mt-2 space-y-2">
                {phasePlaybook.phases.map((phase) => (
                  <details
                    key={phase.id}
                    id={phaseAnchorId(phase.id)}
                    open={
                      phase.status === 'active' ||
                      (acaGuardrailAdjustment.active && prioritizedPhaseId === phase.id)
                    }
                    className="rounded-lg border border-stone-200 bg-stone-50/70 p-3"
                  >
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-stone-900">{phase.label}</p>
                          <p className="text-xs text-stone-600">
                            {phase.windowStartYear} - {phase.windowEndYear}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${phaseStatusClasses(
                              phase.status,
                            )}`}
                          >
                            {phaseStatusLabel(phase.status)}
                          </span>
                          <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-700">
                            {phase.actions.length} action{phase.actions.length === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                    </summary>
                    <div className="mt-2 space-y-2 text-xs text-stone-700">
                      <p>
                        <span className="font-semibold">Objective:</span> {phase.objective}
                      </p>
                      {phase.acaMetrics ? (
                        <div className="rounded-md border border-stone-200 bg-stone-100/80 px-2 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-semibold text-stone-900">ACA bridge metrics</p>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${acaRiskBandClasses(
                                phase.acaMetrics.subsidyRiskBand,
                              )}`}
                            >
                              {acaRiskBandLabel(phase.acaMetrics.subsidyRiskBand)}
                            </span>
                          </div>
                          <p className="mt-1">
                            Bridge year {phase.acaMetrics.bridgeYear ?? 'not modeled'} · projected
                            MAGI {formatCurrency(phase.acaMetrics.projectedMagi)} · ceiling{' '}
                            {phase.acaMetrics.acaFriendlyMagiCeiling === null
                              ? 'not modeled'
                              : formatCurrency(phase.acaMetrics.acaFriendlyMagiCeiling)}{' '}
                            · headroom{' '}
                            {phase.acaMetrics.headroomToCeiling === null
                              ? 'not modeled'
                              : formatCurrency(phase.acaMetrics.headroomToCeiling)}
                            .
                          </p>
                          {phase.acaMetrics.inferredAssumptions.length ? (
                            <details className="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-900">
                              <summary className="cursor-pointer font-semibold">
                                ACA inferred assumptions ({phase.acaMetrics.inferredAssumptions.length})
                              </summary>
                              <ul className="mt-1 space-y-1">
                                {phase.acaMetrics.inferredAssumptions.map((assumption) => (
                                  <li key={`${phase.id}-aca-assumption-${assumption}`}>- {assumption}</li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                        </div>
                      ) : null}
                      {phase.actions.length ? (
                        phase.actions.map((action) => {
                          const normalizedTradeInstructions = action.tradeInstructions.map((instruction) => ({
                            accountBucket: instruction.accountBucket,
                            sourceAccountId: instruction.sourceAccountId,
                            fromSymbol: instruction.fromSymbol,
                            toSymbol: instruction.toSymbol,
                            dollarAmount: instruction.dollarAmount,
                          }));
                          const fullGoalInstructions = scaleTradeInstructionsToGoal(
                            normalizedTradeInstructions,
                            action.fullGoalDollars,
                          );
                          const isContributionAction = Boolean(action.contributionSettingsPatch);
                          const fullGoalReached = isContributionAction
                            ? isContributionPatchGoalReached(data, action.contributionSettingsPatch)
                            : action.fullGoalDollars <= 1 || !fullGoalInstructions.length;
                          return (
                          <div
                            key={action.id}
                            id={phaseActionAnchorId(phase.id, action.id)}
                            className="rounded-md border border-stone-200 bg-white p-2"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm font-semibold text-stone-900">{action.title}</p>
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                                    action.isTopRecommendation
                                      ? 'bg-emerald-100 text-emerald-700'
                                      : 'bg-stone-200 text-stone-700'
                                  }`}
                                >
                                  {action.isTopRecommendation ? 'Top recommendation' : `Alternative #${action.rankWithinPhase}`}
                                </span>
                                {subsidyRecoveryModeActive &&
                                phase.id === 'aca_bridge' &&
                                action.isTopRecommendation ? (
                                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-700">
                                    Subsidy fix priority
                                  </span>
                                ) : null}
                                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-700">
                                  Score {action.rankScore.toFixed(3)}
                                </span>
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${priorityClasses(
                                    action.priority,
                                  )}`}
                                >
                                  {priorityLabel(action.priority)}
                                </span>
                                {fullGoalReached ? (
                                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                                    Goal reached
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <p className="mt-1">
                              <span className="font-semibold">Why now:</span> {action.whyNow}
                            </p>
                            <details className="mt-2 rounded-md border border-stone-200 bg-stone-50 px-2 py-2 text-xs text-stone-700">
                              <summary className="cursor-pointer font-semibold text-stone-800">
                                Layman Walkthrough (what to do + why)
                              </summary>
                              <div className="mt-2 space-y-2">
                                <p>
                                  <span className="font-semibold">Big picture:</span>{' '}
                                  {action.laymanExpansion.storyHook}
                                </p>
                                <p>
                                  <span className="font-semibold">Your task in plain English:</span>{' '}
                                  {action.laymanExpansion.plainEnglishTask}
                                </p>
                                <p>
                                  <span className="font-semibold">Why this matters:</span>{' '}
                                  {action.laymanExpansion.whyImportant}
                                </p>
                                <div>
                                  <p className="font-semibold">Step-by-step</p>
                                  <ol className="mt-1 space-y-1">
                                    {action.laymanExpansion.walkthroughSteps.map((step, stepIndex) => (
                                      <li key={`${action.id}-layman-step-${stepIndex}`}>
                                        {stepIndex + 1}. {step}
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                                <div>
                                  <p className="font-semibold">Watch-outs</p>
                                  <ul className="mt-1 space-y-1">
                                    {action.laymanExpansion.watchOuts.map((watchOut, watchOutIndex) => (
                                      <li key={`${action.id}-layman-watchout-${watchOutIndex}`}>
                                        - {watchOut}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </details>
                            <div className="mt-2">
                              <button
                                type="button"
                                disabled={fullGoalReached}
                                onClick={() => {
                                  if (action.contributionSettingsPatch) {
                                    applyPlaybookContributionSettingsAction(
                                      action.title,
                                      action.contributionSettingsPatch,
                                    );
                                    return;
                                  }
                                  applyPlaybookActionTradeSet(
                                    action.title,
                                    fullGoalInstructions,
                                  );
                                }}
                                className="rounded-full bg-blue-700 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {fullGoalReached
                                  ? 'Goal Reached'
                                  : action.contributionSettingsPatch
                                    ? 'Apply Payroll Settings To Draft'
                                    : `Apply Full Goal To Draft (${formatCurrency(
                                        sumTradeInstructionDollars(fullGoalInstructions),
                                      )})`}
                              </button>
                              {action.contributionSettingsPatch ? (
                                <p className="mt-1 text-[11px] text-stone-600">
                                  This click updates paycheck contribution settings and reruns the plan.
                                </p>
                              ) : (
                                <p className="mt-1 text-[11px] text-stone-600">
                                  This click applies{' '}
                                  {formatCurrency(sumTradeInstructionDollars(fullGoalInstructions))} ·
                                  scoring template set{' '}
                                  {formatCurrency(sumTradeInstructionDollars(normalizedTradeInstructions))}
                                </p>
                              )}
                            </div>
                            {action.contributionSettingsPatch ? (
                              <div className="mt-2 overflow-x-auto rounded-md border border-stone-200">
                                <table className="min-w-full text-left text-xs text-stone-700">
                                  <thead className="bg-stone-100 text-[10px] uppercase tracking-[0.12em] text-stone-500">
                                    <tr>
                                      <th className="px-2 py-1">Setting</th>
                                      <th className="px-2 py-1">Current</th>
                                      <th className="px-2 py-1">Target</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {typeof action.contributionSettingsPatch.employee401kPreTaxAnnualAmount === 'number' ? (
                                      <>
                                        <tr className="border-t border-stone-100">
                                          <td className="px-2 py-1">Pre-tax 401(k)</td>
                                          <td className="px-2 py-1">{formatCurrency(contributionTargets.employee401kPreTaxAnnualAmount)}/yr</td>
                                          <td className="px-2 py-1">{formatCurrency(action.contributionSettingsPatch.employee401kPreTaxAnnualAmount)}/yr</td>
                                        </tr>
                                        <tr className="border-t border-stone-100 bg-stone-50/70">
                                          <td className="px-2 py-1">Pre-tax 401(k) rate</td>
                                          <td className="px-2 py-1">{formatPercent(contributionTargets.employee401kPreTaxPercentOfSalary)}</td>
                                          <td className="px-2 py-1">
                                            {formatPercent(
                                              annualAmountToSalaryPercent(
                                                action.contributionSettingsPatch.employee401kPreTaxAnnualAmount,
                                                data.income.salaryAnnual,
                                              ),
                                            )}{' '}
                                            <span className="text-[11px] text-stone-500">
                                              (or {formatPercent(
                                                roundToCents(
                                                  Math.min(
                                                    1,
                                                    annualAmountToSalaryPercent(
                                                      action.contributionSettingsPatch.employee401kPreTaxAnnualAmount,
                                                      data.income.salaryAnnual,
                                                    ) + 0.005,
                                                  ),
                                                ),
                                              )}{' '}
                                              for cushion)
                                            </span>
                                          </td>
                                        </tr>
                                      </>
                                    ) : null}
                                    {typeof action.contributionSettingsPatch.employee401kRothAnnualAmount === 'number' ? (
                                      <tr className="border-t border-stone-100">
                                        <td className="px-2 py-1">Roth 401(k)</td>
                                        <td className="px-2 py-1">{formatCurrency(contributionTargets.employee401kRothAnnualAmount)}/yr</td>
                                        <td className="px-2 py-1">{formatCurrency(action.contributionSettingsPatch.employee401kRothAnnualAmount)}/yr</td>
                                      </tr>
                                    ) : null}
                                    {typeof action.contributionSettingsPatch.hsaAnnualAmount === 'number' ? (
                                      <tr className="border-t border-stone-100">
                                        <td className="px-2 py-1">HSA</td>
                                        <td className="px-2 py-1">{formatCurrency(contributionTargets.hsaAnnualAmount)}/yr</td>
                                        <td className="px-2 py-1">{formatCurrency(action.contributionSettingsPatch.hsaAnnualAmount)}/yr</td>
                                      </tr>
                                    ) : null}
                                  </tbody>
                                </table>
                              </div>
                            ) : action.tradeInstructions.length ? (
                              <div className="mt-2 overflow-x-auto rounded-md border border-stone-200">
                                <table className="min-w-full text-left text-xs text-stone-700">
                                  <thead className="bg-stone-100 text-[10px] uppercase tracking-[0.12em] text-stone-500">
                                    <tr>
                                      <th className="px-2 py-1">Bucket</th>
                                      <th className="px-2 py-1">Account</th>
                                      <th className="px-2 py-1">Move</th>
                                      <th className="px-2 py-1">Amount (full goal)</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {action.tradeInstructions.map((instruction, instructionIndex) => (
                                      (() => {
                                        const fullGoalInstruction = fullGoalInstructions[instructionIndex];
                                        const appliedAmount =
                                          fullGoalInstruction?.dollarAmount ?? instruction.dollarAmount;
                                        const appliedPercent =
                                          instruction.dollarAmount > 0
                                            ? Math.max(
                                                0,
                                                Math.min(
                                                  100,
                                                  instruction.percentOfHolding *
                                                    (appliedAmount / instruction.dollarAmount),
                                                ),
                                              )
                                            : instruction.percentOfHolding;
                                        return (
                                          <tr
                                            key={`${action.id}-trade-${instructionIndex}`}
                                            className="border-t border-stone-100"
                                          >
                                            <td className="px-2 py-1">{instruction.accountBucket}</td>
                                            <td className="px-2 py-1">
                                              {formatTradeInstructionAccountLabel({
                                                sourceAccountName: instruction.sourceAccountName,
                                                sourceAccountId: instruction.sourceAccountId,
                                              })}
                                            </td>
                                            <td className="px-2 py-1">
                                              {instruction.fromSymbol} {'->'} {instruction.toSymbol}
                                            </td>
                                            <td className="px-2 py-1">
                                              {appliedPercent.toFixed(2)}% ({formatCurrency(appliedAmount)})
                                            </td>
                                          </tr>
                                        );
                                      })()
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <p className="mt-1 rounded-md bg-stone-100 px-2 py-1 text-xs text-stone-700">
                                No fund-level trade instruction generated for this action.
                              </p>
                            )}
                            <p className="mt-2">
                              <span className="font-semibold">Estimated impact:</span> spend{' '}
                              {action.estimatedImpact.supportedMonthlyDelta >= 0 ? '+' : ''}
                              {formatCurrency(action.estimatedImpact.supportedMonthlyDelta)}/mo · success{' '}
                              {(action.estimatedImpact.successRateDelta * 100).toFixed(1)} pts · ending wealth{' '}
                              {action.estimatedImpact.medianEndingWealthDelta >= 0 ? '+' : ''}
                              {formatCurrency(action.estimatedImpact.medianEndingWealthDelta)} · annual tax{' '}
                              {action.estimatedImpact.annualFederalTaxDelta >= 0 ? '+' : ''}
                              {formatCurrency(action.estimatedImpact.annualFederalTaxDelta)}
                            </p>
                            <p className="mt-1">
                              <span className="font-semibold">Sensitivity:</span>{' '}
                              {Math.round(action.sensitivity.directionConsistencyScore * 100)}% direction consistency
                              across {action.sensitivity.scenarios.length} scenarios.
                            </p>
                            <p className="mt-1">
                              <span className="font-semibold">Scenario deltas:</span>{' '}
                              {action.sensitivity.scenarios
                                .map(
                                  (scenario) =>
                                    `${scenario.name} ${scenario.supportedMonthlyDelta >= 0 ? '+' : ''}${formatCurrency(
                                      scenario.supportedMonthlyDelta,
                                    )}/mo, ${(scenario.successRateDelta * 100).toFixed(1)} pts success`,
                                )
                                .join(' · ')}
                            </p>
                            <p className="mt-1">
                              <span className="font-semibold">Model completeness:</span> {action.modelCompleteness}
                            </p>
                            {action.inferredAssumptions.length ? (
                              <details className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-amber-900">
                                <summary className="cursor-pointer font-semibold">
                                  Action-specific inferred assumptions ({action.inferredAssumptions.length})
                                </summary>
                                <ul className="mt-1 space-y-1 text-amber-900">
                                  {action.inferredAssumptions.map((assumption) => (
                                    <li key={`${action.id}-assumption-${assumption}`}>- {assumption}</li>
                                  ))}
                                </ul>
                              </details>
                            ) : null}
                            <div className="mt-2 grid gap-1 md:grid-cols-2">
                              {Object.entries(action.intermediateCalculations).map(([key, value]) => (
                                <div
                                  key={`${action.id}-calc-${key}`}
                                  className="rounded bg-stone-100 px-2 py-1 text-[11px] text-stone-700"
                                >
                                  <span className="font-semibold">{formatIntermediateLabel(key)}:</span>{' '}
                                  {typeof value === 'number' ? formatCurrency(value) : value}
                                </div>
                              ))}
                            </div>
                          </div>
                          );
                        })
                      ) : (
                        <p className="rounded-md bg-stone-100 px-2 py-1 text-xs text-stone-700">
                          No actions generated for this phase with current inputs.
                        </p>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          ) : null}

          {phasePlaybook.retirementFlowYears.length ? (
            <div className="mt-4 rounded-xl border border-stone-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
                  Retirement Account Flows By Year
                </p>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-600">
                  Deterministic flow projection
                </span>
              </div>
              <div className="mt-2 overflow-x-auto rounded-md border border-stone-200">
                <table className="min-w-full text-left text-xs text-stone-700">
                  <thead className="bg-stone-100 text-[10px] uppercase tracking-[0.12em] text-stone-500">
                    <tr>
                      <th className="px-2 py-1">Year</th>
                      <th className="px-2 py-1">Regime</th>
                      <th className="px-2 py-1">Taxable</th>
                      <th className="px-2 py-1">Roth</th>
                      <th className="px-2 py-1">IRA/401k</th>
                      <th className="px-2 py-1">Cash</th>
                      <th className="px-2 py-1">Other Income</th>
                      <th className="px-2 py-1">Total Income</th>
                      <th className="px-2 py-1">Expected MAGI</th>
                      <th className="px-2 py-1">ACA Ceiling</th>
                      <th className="px-2 py-1">ACA Headroom</th>
                      <th className="px-2 py-1">IRMAA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {phasePlaybook.retirementFlowYears.map((row) => {
                      const otherIncome = row.salaryIncome + row.socialSecurityIncome + row.windfallIncome;
                      return (
                        <Fragment key={`retirement-flow-${row.year}`}>
                          <tr className="border-t border-stone-100">
                            <td className="px-2 py-1">
                              <p className="font-semibold text-stone-900">
                                {row.year}
                                {row.monthsInRetirement < 12 ? ` (${row.monthsInRetirement} months)` : ''}
                              </p>
                              <span
                                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${modelCompletenessClasses(
                                  row.modelCompleteness,
                                )}`}
                              >
                                {row.modelCompleteness}
                              </span>
                            </td>
                            <td className="px-2 py-1">{formatRetirementFlowRegimeLabel(row.regime)}</td>
                            <td className="px-2 py-1">{formatCurrency(row.taxableFlow)}</td>
                            <td className="px-2 py-1">{formatCurrency(row.rothFlow)}</td>
                            <td className="px-2 py-1">{formatCurrency(row.iraFlow)}</td>
                            <td className="px-2 py-1">{formatCurrency(row.cashFlow)}</td>
                            <td className="px-2 py-1">{formatCurrency(otherIncome)}</td>
                            <td className="px-2 py-1 font-semibold text-stone-900">
                              {formatCurrency(row.totalIncome)}
                            </td>
                            <td className="px-2 py-1">{formatCurrency(row.expectedMagi)}</td>
                            <td className="px-2 py-1">
                              {row.acaFriendlyMagiCeiling === null
                                ? 'not modeled'
                                : formatCurrency(row.acaFriendlyMagiCeiling)}
                            </td>
                            <td className="px-2 py-1">
                              {row.acaHeadroomToCeiling === null
                                ? 'not modeled'
                                : formatCurrency(row.acaHeadroomToCeiling)}
                            </td>
                            <td className="px-2 py-1">
                              <p>{row.irmaaStatus}</p>
                              <p className="text-[11px] text-stone-500">
                                {row.irmaaLookbackTaxYear === null
                                  ? 'Lookback n/a'
                                  : `Lookback ${row.irmaaLookbackTaxYear}`}
                              </p>
                            </td>
                          </tr>
                          {row.inferredAssumptions.length ? (
                            <tr className="border-t border-stone-100 bg-amber-50/40">
                              <td className="px-2 py-1 text-[11px] text-amber-900" colSpan={12}>
                                <span className="font-semibold">Inferred assumptions:</span>{' '}
                                {row.inferredAssumptions.join(' ')}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-stone-600">
                Other income = salary + Social Security + windfalls for the year. IRA flow includes
                modeled RMDs when applicable.
              </p>
            </div>
          ) : null}

          {strategicPrepRecommendations.length ? (
            <div className="mt-4 rounded-xl border border-stone-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
                  Strategic Prep Recommendations
                </p>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-600">
                  {strategicPrepPolicy.policyVersion}
                </span>
              </div>
              <div className="mt-2 space-y-2">
                {strategicPrepRecommendations.map((item) => (
                  <div key={item.id} className="rounded-lg border border-stone-200 bg-stone-50/70 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-stone-900">{item.title}</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${priorityClasses(
                          item.priority,
                        )}`}
                      >
                        {priorityLabel(item.priority)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-700">
                      <span className="font-semibold">Action:</span> {item.action}
                    </p>
                    <p className="mt-1 text-xs text-stone-600">
                      <span className="font-semibold">Trigger:</span> {item.triggerReason}
                    </p>
                    {item.amountHint ? (
                      <p className="mt-1 text-xs text-stone-600">
                        <span className="font-semibold">Amount guide:</span> {item.amountHint}
                      </p>
                    ) : null}
                    {item.estimatedImpact ? (
                      <p className="mt-1 text-xs text-stone-600">
                        <span className="font-semibold">Estimated impact:</span>{' '}
                        spend {item.estimatedImpact.supportedMonthlyDelta >= 0 ? '+' : ''}
                        {formatCurrency(item.estimatedImpact.supportedMonthlyDelta)}/mo · success{' '}
                        {(item.estimatedImpact.successRateDelta * 100).toFixed(1)} pts · ending wealth{' '}
                        {item.estimatedImpact.medianEndingWealthDelta >= 0 ? '+' : ''}
                        {formatCurrency(item.estimatedImpact.medianEndingWealthDelta)}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-stone-600">
                      <span className="font-semibold">Confidence:</span>{' '}
                      {item.confidence.label} ({Math.round(item.confidence.score * 100)}%) - {item.confidence.rationale}
                    </p>
                    {item.tradeoffs.length ? (
                      <p className="mt-1 text-xs text-stone-600">
                        <span className="font-semibold">Tradeoffs:</span> {item.tradeoffs.join(' ')}
                      </p>
                    ) : null}
                    <div className="mt-2 rounded-md border border-stone-200 bg-white px-2 py-2 text-xs text-stone-600">
                      <p className="font-semibold text-stone-700">Supporting evidence</p>
                      {item.evidence.baseline ? (
                        <p className="mt-1">
                          Baseline: {formatPercent(item.evidence.baseline.successRate)} success ·{' '}
                          {formatCurrency(item.evidence.baseline.supportedMonthlySpendApprox)}/mo spend ·{' '}
                          {formatCurrency(item.evidence.baseline.medianEndingWealth)} ending wealth.
                        </p>
                      ) : null}
                      {item.evidence.counterfactual ? (
                        <p className="mt-1">
                          Counterfactual: {formatPercent(item.evidence.counterfactual.successRate)} success ·{' '}
                          {formatCurrency(item.evidence.counterfactual.supportedMonthlySpendApprox)}/mo spend ·{' '}
                          {formatCurrency(item.evidence.counterfactual.medianEndingWealth)} ending wealth.
                        </p>
                      ) : (
                        <p className="mt-1">Counterfactual: not modeled for this recommendation.</p>
                      )}
                      {item.evidence.simulationRunsUsed !== null || item.evidence.simulationSeedUsed !== null ? (
                        <p className="mt-1">
                          Runs/seed: {item.evidence.simulationRunsUsed ?? 'n/a'} /{' '}
                          {item.evidence.simulationSeedUsed ?? 'n/a'}.
                        </p>
                      ) : null}
                      {item.evidence.notes.length ? (
                        <ul className="mt-1 space-y-1">
                          {item.evidence.notes.map((note, noteIndex) => (
                            <li key={`${item.id}-evidence-${noteIndex}`}>- {note}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </SectionCard>

      <div className="mt-4">
        <SectionCard title="Current Spending Profile">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Essential</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(annualEssentialSpend)}/yr
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Flexible / optional target</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(annualFlexibleSpend)}/yr
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Min {formatCurrency(annualFlexibleSpendMinimum)}/yr
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Travel / lifestyle target</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(annualTravelSpend)}/yr
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Min {formatCurrency(annualTravelSpendMinimum)}/yr
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Total annual spend</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(annualTotalSpend)}/yr
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">
              <p className="text-xs uppercase tracking-[0.12em] text-blue-700">User Target Now</p>
              <p className="mt-1 font-semibold">{formatCurrency(userTargetMonthlySpend)}/mo</p>
            </div>
            <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">
              <p className="text-xs uppercase tracking-[0.12em] text-emerald-700">Planner-Supported Now</p>
              <p className="mt-1 font-semibold">{formatCurrency(plannerSupportedMonthlySpend)}/mo</p>
            </div>
            <div className="rounded-xl bg-stone-100 p-3 text-sm text-stone-800">
              <p className="text-xs uppercase tracking-[0.12em] text-stone-600">Spend Gap Now</p>
              <p className="mt-1 font-semibold">
                {spendGapNowMonthly >= 0 ? '+' : ''}
                {formatCurrency(spendGapNowMonthly)}/mo
              </p>
            </div>
          </div>
          {currentEvaluation ? (
            <div className="mt-3 rounded-xl bg-white p-4 text-sm text-stone-700">
              <p className="text-xs uppercase tracking-[0.12em] text-stone-500">
                Safe Spending Band
              </p>
              <div className="mt-2 grid gap-3 md:grid-cols-3">
                <div className="rounded-lg bg-stone-100 px-3 py-2">
                  <p className="text-xs text-stone-500">Conservative</p>
                  <p className="mt-1 font-semibold">
                    {formatCurrency(currentEvaluation.calibration.safeBandAnnual.lower)}/yr
                  </p>
                  <p className="text-xs text-stone-600">
                    {formatCurrency(currentEvaluation.calibration.safeBandAnnual.lower / 12)}/mo
                  </p>
                </div>
                <div className="rounded-lg bg-blue-50 px-3 py-2">
                  <p className="text-xs text-blue-700">Target</p>
                  <p className="mt-1 font-semibold text-blue-900">
                    {formatCurrency(currentEvaluation.calibration.safeBandAnnual.target)}/yr
                  </p>
                  <p className="text-xs text-blue-700">
                    {formatCurrency(currentEvaluation.calibration.safeBandAnnual.target / 12)}/mo
                  </p>
                </div>
                <div className="rounded-lg bg-emerald-50 px-3 py-2">
                  <p className="text-xs text-emerald-700">Stretch</p>
                  <p className="mt-1 font-semibold text-emerald-900">
                    {formatCurrency(currentEvaluation.calibration.safeBandAnnual.upper)}/yr
                  </p>
                  <p className="text-xs text-emerald-700">
                    {formatCurrency(currentEvaluation.calibration.safeBandAnnual.upper / 12)}/mo
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </SectionCard>
      </div>

      {currentEvaluation ? (
        <div className="mt-4">
          <SectionCard title="Planner Interpretation">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
                <p>“You asked to spend {formatCurrency(currentEvaluation.calibration.userTargetMonthlySpendNow)}/month.”</p>
                <p className="mt-2">
                  Current supported spending is {formatCurrency(currentEvaluation.calibration.supportedMonthlySpendNow)}/month with{' '}
                  {formatPercent(currentEvaluation.summary.successRate)} success.
                </p>
                <p className="mt-2">
                  Supported annual spending now: {formatCurrency(currentEvaluation.calibration.supportedAnnualSpendNow)}/year.
                </p>
                <p className="mt-2">
                  Success floor target: {formatPercent(currentEvaluation.calibration.minimumSuccessRateTarget)} · achieved{' '}
                  {formatPercent(currentEvaluation.calibration.achievedSuccessRate)}.
                </p>
                <p className="mt-2">
                  Binding guardrail: {toReadableConstraint(currentEvaluation.calibration.bindingGuardrail)}.
                </p>
                <p className="mt-2">
                  Binding constraint: {toReadableConstraint(currentEvaluation.calibration.bindingConstraint)}.
                </p>
                <p className="mt-2">
                  Primary tradeoff: {currentEvaluation.calibration.primaryTradeoff}
                </p>
                {currentEvaluation.calibration.nextUnlock ? (
                  <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-blue-900">
                    Next unlock: {currentEvaluation.calibration.nextUnlock}
                  </p>
                ) : null}
                {currentEvaluation.calibration.successConstraintBinding ? (
                  <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                    {currentEvaluation.calibration.successFloorNextUnlock ??
                      'Success floor is binding. Relaxing the floor can increase supported spending with a tradeoff in robustness.'}
                  </p>
                ) : null}
                {currentEvaluation.calibration.successConstraintBinding &&
                currentEvaluation.calibration.successFloorRelaxationTradeoff ? (
                  <p className="mt-2 text-xs text-stone-600">
                    {currentEvaluation.calibration.successFloorRelaxationTradeoff}
                  </p>
                ) : null}
                <ul className="mt-3 space-y-1 text-stone-600">
                  <li>
                    • Reducing flexible spending toward its floor ({formatCurrency(currentEvaluation.calibration.flexibleSpendingMinimum)}/yr)
                    can improve resilience without cutting core needs.
                  </li>
                  <li>
                    • Supported spend at current floor: {formatCurrency(currentEvaluation.calibration.supportedSpendAtCurrentSuccessFloor)}/yr.{' '}
                    If floor is relaxed: {formatCurrency(currentEvaluation.calibration.supportedSpendIfSuccessFloorRelaxed)}/yr.
                  </li>
                  <li>
                    • Supported spend by phase: 60s {formatCurrency(currentEvaluation.calibration.supportedSpend60s)}/yr, 70s{' '}
                    {formatCurrency(currentEvaluation.calibration.supportedSpend70s)}/yr, 80+{' '}
                    {formatCurrency(currentEvaluation.calibration.supportedSpend80Plus)}/yr.
                  </li>
                </ul>
              </div>
              <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
                <p>
                  Tax + healthcare pressure: federal tax estimate{' '}
                  {formatCurrency(currentEvaluation.raw.spendingCalibration.annualFederalTaxEstimate)}/yr and
                  healthcare premiums{' '}
                  {formatCurrency(currentEvaluation.raw.spendingCalibration.annualHealthcareCostEstimate)}/yr.
                </p>
                <p className="mt-2">
                  IRMAA outlook: {currentEvaluation.summary.irmaaOutlook}.
                </p>
                <p className="mt-2">
                  ACA exposure: {acaExposureYears > 0 ? `${acaExposureYears} years above subsidy-safe range.` : 'No ACA breach years in current route.'}
                </p>
                <p className="mt-2">
                  Legacy landing (today $): center {formatCurrency(currentEvaluation.calibration.projectedLegacyTodayDollars)} with
                  approx 1σ robust range {formatCurrency(currentEvaluation.calibration.endingWealthOneSigmaLowerTodayDollars)} to{' '}
                  {formatCurrency(currentEvaluation.calibration.endingWealthOneSigmaUpperTodayDollars)}. Target band is{' '}
                  {formatCurrency(currentEvaluation.calibration.legacyTargetBandLowerTodayDollars)} to{' '}
                  {formatCurrency(currentEvaluation.calibration.legacyTargetBandUpperTodayDollars)} (floor{' '}
                  {formatCurrency(currentEvaluation.calibration.legacyFloorTodayDollars)}).
                </p>
                {currentEvaluation.calibration.overReservedAmount > 0 ? (
                  <p className="mt-2">
                    This plan is currently over-reserved by {formatCurrency(currentEvaluation.calibration.overReservedAmount)} relative to the legacy target.
                  </p>
                ) : null}
                <p className="mt-2">
                  {currentEvaluation.calibration.whySupportedSpendIsNotHigher}
                </p>
              </div>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {currentEvaluation ? (
        <div className="mt-4">
          <SectionCard title="Year-By-Year Supported Spending">
            <div className="overflow-x-auto rounded-xl bg-white p-3">
              <table className="min-w-full text-left text-sm text-stone-700">
                <thead className="text-xs uppercase tracking-[0.12em] text-stone-500">
                  <tr>
                    <th className="px-2 py-2">Year</th>
                    <th className="px-2 py-2">Age</th>
                    <th className="px-2 py-2">Annual</th>
                    <th className="px-2 py-2">Monthly</th>
                  </tr>
                </thead>
                <tbody>
                  {currentEvaluation.calibration.supportedSpendingSchedule.map((point) => (
                    <tr key={`${point.year}-${point.age}`} className="border-t border-stone-100">
                      <td className="px-2 py-2">{point.year}</td>
                      <td className="px-2 py-2">{point.age}</td>
                      <td className="px-2 py-2">{formatCurrency(point.annualSpend)}</td>
                      <td className="px-2 py-2">{formatCurrency(point.monthlySpend)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Current Risk">
          <p className="rounded-xl bg-white p-4 text-sm text-stone-700">{currentRisk}</p>
        </SectionCard>
        <SectionCard title="Current Opportunity">
          <p className="rounded-xl bg-white p-4 text-sm text-stone-700">{currentOpportunity}</p>
        </SectionCard>
      </div>

      {currentEvaluation && currentRun ? (
        <div className="mt-4">
          <SectionCard title="Constraints And Levers" subtitle="Hard constraints are enforced; soft preferences shape guidance; suggested levers are optional actions.">
            <div className="grid gap-3 lg:grid-cols-3">
              <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Hard constraints</p>
                <ul className="mt-2 space-y-1">
                  {hardConstraints.map((item) => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Soft preferences</p>
                <ul className="mt-2 space-y-1">
                  {softPreferences.map((item) => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Suggested levers</p>
                <ul className="mt-2 space-y-1">
                  {suggestedLevers.map((item) => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </SectionCard>
        </div>
      ) : null}

      <div className="mt-4">
        <SectionCard title="Next Best Step">
          <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
            {topRecommendation || timePreference ? (
              <>
                <p className="font-semibold text-stone-900">{nextBestStepLabel}</p>
                <p className="mt-2">{nextBestStepText}</p>
                {timePreference?.estimatedSafeEarlyAnnualShift ? (
                  <p className="mt-2 text-stone-600">
                    Suggested early-life shift: {formatCurrency(timePreference.estimatedSafeEarlyAnnualShift)}/yr
                  </p>
                ) : topRecommendation ? (
                  <p className="mt-2 text-stone-600">
                    Expected impact: {formatImpactPoints(topRecommendation.deltaSuccessRate)}
                  </p>
                ) : null}
              </>
            ) : (
              <p>
                Guidance is still loading. The likely low-friction move is reducing flexible spending slightly while
                keeping essential spending intact.
              </p>
            )}
          </div>
        </SectionCard>
      </div>

      {solverDiagnostics ? (
        <div className="mt-4">
          <SectionCard title="Why Am I Still Ending With Substantial Wealth?">
            <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
              <ul className="space-y-1">
                {substantialWealthReasons.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            </div>

            {showTimeWeightedComparison ? (
              <div className="mt-3 rounded-xl bg-white p-4 text-sm text-stone-700">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
                  Time-Weighted Spending Comparison
                </p>
                <p className="mt-2">
                  Current path average: {formatCurrency(annualTotalSpend)}/yr · Optimized path average:{' '}
                  {formatCurrency(solverDiagnostics.recommendedAnnualSpend)}/yr
                </p>
                <p className="mt-1">
                  Constraint that bound first:{' '}
                  <span className="font-semibold">
                    {toReadableConstraint(solverDiagnostics.bindingConstraint)}
                  </span>
                </p>
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  {solverDiagnostics.spendingDeltaByPhase.map((phase) => (
                    <div key={phase.phase} className="rounded-lg bg-stone-100 px-3 py-2">
                      <p className="text-xs text-stone-500">{formatPhaseLabel(phase.phase)}</p>
                      <p className="text-sm text-stone-700">
                        Current {formatCurrency(phase.currentAnnual)}/yr
                      </p>
                      <p className="text-sm text-stone-700">
                        Optimized {formatCurrency(phase.optimizedAnnual)}/yr
                      </p>
                      <p
                        className={`text-sm font-semibold ${
                          phase.deltaAnnual >= 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        Delta {phase.deltaAnnual >= 0 ? '+' : ''}
                        {formatCurrency(phase.deltaAnnual)}/yr
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </SectionCard>
        </div>
      ) : null}

      {currentEvaluation && currentRun ? (
        <div className="mt-4 space-y-4">
          <SectionCard title="Plan Verdict">
          <div className={`grid gap-3 ${currentEvaluation.summary.bequestAttainmentRate !== null ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Verdict</p>
              <p className={`mt-1 text-lg font-semibold ${verdictClassName(currentEvaluation.summary.planVerdict)}`}>
                {currentEvaluation.summary.planVerdict}
              </p>
            </div>
            <div
              className="rounded-xl bg-white p-3"
              title="Probability the plan does not run out of money before end of horizon. Distinct from bequest attainment — a plan can be solvent and still fall short of the legacy goal."
            >
              <p className="text-xs text-stone-500">Modeled success</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatPercent(currentEvaluation.summary.successRate)}
              </p>
              <p className="mt-0.5 text-[10px] text-stone-500">
                Did not run out of money
              </p>
            </div>
            {currentEvaluation.summary.bequestAttainmentRate !== null ? (
              <div
                className="rounded-xl bg-white p-3"
                title="Approximate probability ending wealth meets or exceeds your North Star bequest. Interpolated from the P10/P25/P50/P75/P90 distribution; clamped at 95% / 5% in the unmeasured tails."
              >
                <p className="text-xs text-stone-500">Bequest on target</p>
                <p className="mt-1 text-lg font-semibold text-stone-900">
                  {formatPercent(currentEvaluation.summary.bequestAttainmentRate)}
                </p>
                <p className="mt-0.5 text-[10px] text-stone-500">
                  Reaches{' '}
                  {formatCurrency(currentEvaluation.calibration.targetLegacyTodayDollars)}{' '}
                  bequest
                </p>
              </div>
            ) : null}
          </div>
          <div className="mt-3 rounded-xl bg-white p-4 text-sm text-stone-700">
            <p>{verdictExplanation}</p>
            {timePreference ? (
              <p className="mt-2">
                <span className="font-semibold">Time-weighted read:</span> {timePreference.explanation}
              </p>
            ) : null}
            <p className="mt-2">
              <span className="font-semibold">IRMAA outlook:</span> {currentEvaluation.summary.irmaaOutlook}
            </p>
            <p>
              <span className="font-semibold">Legacy outlook:</span> {currentEvaluation.summary.legacyOutlook}
            </p>
            <p className="mt-1">
              <span className="font-semibold">Binding constraint:</span>{' '}
              {toReadableConstraint(currentEvaluation.calibration.bindingConstraint)}
            </p>
          </div>
          </SectionCard>
          {(() => {
            // Bequest distribution panel. The single legacyOutlook line
            // above only describes the median; this panel surfaces the
            // full distribution so the user can see whether the plan
            // over- or under-shoots their North Star, and how much of
            // any "overshoot" is the cost of bad-tail insurance vs.
            // genuine unspent capacity.
            const target = currentEvaluation.calibration.targetLegacyTodayDollars;
            const dist = currentEvaluation.calibration.bequestDistributionTodayDollars;
            const legacyOff = currentEvaluation.calibration.legacyPriority === 'off';
            if (legacyOff || !target || target <= 0) return null;
            const medianGap = dist.p50 - target;
            const p10Gap = dist.p10 - target;
            const isBigOvershoot = medianGap > Math.max(target * 0.5, 250_000);
            const p10Below = p10Gap < 0;
            const headline = (() => {
              if (medianGap < 0) {
                return `Median ending wealth lands ${formatCurrency(Math.abs(medianGap))} below your ${formatCurrency(target)} North Star — the plan is not currently funded to clear the bequest at the median.`;
              }
              if (isBigOvershoot && p10Below) {
                return `At the median you overshoot the ${formatCurrency(target)} North Star by ${formatCurrency(medianGap)} — but the bottom 10% of paths still falls ${formatCurrency(Math.abs(p10Gap))} short. The median surplus is the cost of insuring against the bad tail, not free money.`;
              }
              if (isBigOvershoot && !p10Below) {
                return `Median ending wealth overshoots your ${formatCurrency(target)} North Star by ${formatCurrency(medianGap)}, and even the bottom 10% of paths clears the target. That's real unspent capacity — there's room to spend more, gift more, or convert more aggressively to Roth without violating the goal.`;
              }
              if (medianGap > 0 && p10Below) {
                return `Median ending wealth clears your ${formatCurrency(target)} North Star by ${formatCurrency(medianGap)}, but the bottom 10% of paths falls ${formatCurrency(Math.abs(p10Gap))} short.`;
              }
              return `Median ending wealth clears the ${formatCurrency(target)} North Star by ${formatCurrency(medianGap)}; the distribution stays above target through P10.`;
            })();
            const cells: Array<{ label: string; value: number }> = [
              { label: 'P10', value: dist.p10 },
              { label: 'P25', value: dist.p25 },
              { label: 'P50', value: dist.p50 },
              { label: 'P75', value: dist.p75 },
              { label: 'P90', value: dist.p90 },
            ];
            return (
              <SectionCard title="Bequest distribution">
                <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
                  <p>{headline}</p>
                  <div className="mt-3 grid grid-cols-5 gap-2">
                    {cells.map(({ label, value }) => {
                      const above = value >= target;
                      const gap = value - target;
                      return (
                        <div
                          key={label}
                          className={`rounded-lg p-2 text-center ${
                            above ? 'bg-emerald-50' : 'bg-rose-50'
                          }`}
                          title={`${
                            above ? 'Above' : 'Below'
                          } North Star by ${formatCurrency(Math.abs(gap))}`}
                        >
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                            {label}
                          </p>
                          <p
                            className={`mt-0.5 tabular-nums text-xs ${
                              above ? 'text-emerald-800' : 'text-rose-800'
                            }`}
                          >
                            {formatCurrency(Math.round(value))}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-stone-500">
                    Today's dollars. North Star: {formatCurrency(target)}. Green
                    cells clear the target; red cells fall short. P10 = bottom
                    10% of Monte Carlo paths; P90 = top 10%.
                  </p>
                </div>
              </SectionCard>
            );
          })()}
        </div>
      ) : (
        <div className="mt-4 rounded-[24px] bg-stone-100/80 p-5 text-sm text-stone-600">
          Building the live plan interpretation from the current plan state and latest simulation snapshot.
        </div>
      )}

      {showPlanControls ? (
        <SectionCard title="Plan Controls">
        <div className="rounded-2xl bg-white/90 p-4">
          <p className="text-sm font-medium text-stone-700">Active controls</p>
          <p className="mt-1 text-sm text-stone-600">{activeControlsSummary}</p>
          <p className="mt-1 text-xs text-stone-500">
            Active stressors: {activeStressorNames.length ? activeStressorNames.join(', ') : 'None'}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Active responses: {activeResponseNames.length ? activeResponseNames.join(', ') : 'None'}
          </p>
        </div>

        <div className="mt-4 space-y-3">
          <ControlSection
            title="Stressors"
            summary={stressorSummary}
            isOpen={controlsSectionState.stressors}
            onToggle={() => setControlsSectionOpen('stressors', !controlsSectionState.stressors)}
          >
            <div className="grid gap-2 md:grid-cols-2">
              {data.stressors.map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={selectedStressors.includes(item.id)}
                    onChange={() => toggleStressor(item.id)}
                  />
                  {item.name}
                </label>
              ))}
            </div>
          </ControlSection>

          <ControlSection
            title="Responses"
            summary={responseSummary}
            isOpen={controlsSectionState.responses}
            onToggle={() => setControlsSectionOpen('responses', !controlsSectionState.responses)}
          >
            <div className="grid gap-2 md:grid-cols-2">
              {data.responses.map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={selectedResponses.includes(item.id)}
                    onChange={() => toggleResponse(item.id)}
                  />
                  {item.name}
                </label>
              ))}
            </div>
          </ControlSection>

          <ControlSection
            title="Base Inputs"
            summary={`${formatCurrency(data.income.salaryAnnual)} salary · ends ${data.income.salaryEndDate.slice(0, 10)} · ${contributionSummary}`}
            isOpen={controlsSectionState.baseInputs}
            onToggle={() => setControlsSectionOpen('baseInputs', !controlsSectionState.baseInputs)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-stone-700">
                Salary annual
                <input
                  type="number"
                  value={data.income.salaryAnnual}
                  min={0}
                  step={1000}
                  onChange={(event) => updateIncome('salaryAnnual', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Salary end date
                <input
                  type="date"
                  value={salaryEndDateValue}
                  onChange={(event) => {
                    const raw = event.target.value;
                    setSalaryEndDateText(raw);
                    applySalaryEndDateInput(raw);
                  }}
                  onInput={(event) => {
                    const raw = (event.target as HTMLInputElement).value;
                    setSalaryEndDateText(raw);
                  }}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={salaryEndDateText}
                  placeholder="YYYY-MM-DD"
                  onChange={(event) => setSalaryEndDateText(event.target.value)}
                  onBlur={() => {
                    if (isDateInputValue(salaryEndDateText)) {
                      applySalaryEndDateInput(salaryEndDateText);
                      return;
                    }
                    setSalaryEndDateText(salaryEndDateValue);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') {
                      return;
                    }
                    if (!isDateInputValue(salaryEndDateText)) {
                      setSalaryEndDateText(salaryEndDateValue);
                      return;
                    }
                    applySalaryEndDateInput(salaryEndDateText);
                  }}
                  className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 font-mono text-xs tracking-[0.08em]"
                />
                <p className="mt-1 text-[11px] text-stone-500">
                  If the calendar picker is stubborn, type date as YYYY-MM-DD and press Enter.
                </p>
              </label>
              <label className="text-sm text-stone-700">
                Employee 401(k) pre-tax annual target
                <input
                  type="number"
                  value={contributionTargets.employee401kPreTaxAnnualAmount}
                  min={0}
                  step={500}
                  onChange={(event) =>
                    updatePreRetirementContribution(
                      'employee401kPreTaxAnnualAmount',
                      Number(event.target.value) || 0,
                    )}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
                <p className="mt-1 text-[11px] text-stone-500">
                  Effective rate: {formatPercent(contributionTargets.employee401kPreTaxPercentOfSalary)} of salary
                </p>
              </label>
              <label className="text-sm text-stone-700">
                Employee 401(k) Roth annual target
                <input
                  type="number"
                  value={contributionTargets.employee401kRothAnnualAmount}
                  min={0}
                  step={500}
                  onChange={(event) =>
                    updatePreRetirementContribution(
                      'employee401kRothAnnualAmount',
                      Number(event.target.value) || 0,
                    )}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
                <p className="mt-1 text-[11px] text-stone-500">
                  Effective rate: {formatPercent(contributionTargets.employee401kRothPercentOfSalary)} of salary
                </p>
              </label>
              <label className="text-sm text-stone-700">
                HSA annual target
                <input
                  type="number"
                  value={contributionTargets.hsaAnnualAmount}
                  min={0}
                  step={250}
                  onChange={(event) =>
                    updatePreRetirementContribution('hsaAnnualAmount', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
                <p className="mt-1 text-[11px] text-stone-500">
                  Effective rate: {formatPercent(contributionTargets.hsaPercentOfSalary)} of salary
                </p>
              </label>
              <label className="text-sm text-stone-700">
                HSA coverage type
                <select
                  value={contributionTargets.hsaCoverageType}
                  onChange={(event) =>
                    updatePreRetirementContribution(
                      'hsaCoverageType',
                      event.target.value as 'self' | 'family',
                    )}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="self">Self</option>
                  <option value="family">Family</option>
                </select>
              </label>
              <label className="text-sm text-stone-700">
                Employer match rate
                <input
                  type="number"
                  value={contributionTargets.employerMatchRate}
                  min={0}
                  max={2}
                  step={0.01}
                  onChange={(event) =>
                    updateEmployerMatchContribution('matchRate', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Employer match cap (% salary)
                <input
                  type="number"
                  value={contributionTargets.employerMatchCapPercent}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(event) =>
                    updateEmployerMatchContribution(
                      'maxEmployeeContributionPercentOfSalary',
                      Number(event.target.value) || 0,
                    )}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Spending Inputs"
            summary={`${formatCurrency(data.spending.essentialMonthly)}/mo essential · ${formatCurrency(data.spending.optionalMonthly)}/mo optional · ${formatCurrency(data.spending.travelEarlyRetirementAnnual)}/yr travel`}
            isOpen={controlsSectionState.spending}
            onToggle={() => setControlsSectionOpen('spending', !controlsSectionState.spending)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-stone-700">
                Essential monthly
                <input
                  type="number"
                  value={data.spending.essentialMonthly}
                  min={0}
                  step={100}
                  onChange={(event) => updateSpending('essentialMonthly', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Optional monthly
                <input
                  type="number"
                  value={data.spending.optionalMonthly}
                  min={0}
                  step={100}
                  onChange={(event) => updateSpending('optionalMonthly', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Taxes + insurance annual
                <input
                  type="number"
                  value={data.spending.annualTaxesInsurance}
                  min={0}
                  step={500}
                  onChange={(event) => updateSpending('annualTaxesInsurance', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Travel annual
                <input
                  type="number"
                  value={data.spending.travelEarlyRetirementAnnual}
                  min={0}
                  step={500}
                  onChange={(event) => updateSpending('travelEarlyRetirementAnnual', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Income Timing"
            summary={`SS ${data.income.socialSecurity.map((entry) => `${formatPersonLabel(entry.person)} ${entry.claimAge}`).join(' / ')} · windfalls ${data.income.windfalls.map((item) => `${formatWindfallLabel(item.name)} ${item.year}`).join(' / ')}`}
            isOpen={controlsSectionState.incomeTiming}
            onToggle={() => setControlsSectionOpen('incomeTiming', !controlsSectionState.incomeTiming)}
          >
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                {data.income.socialSecurity.map((entry) => (
                  <label key={entry.person} className="text-sm text-stone-700">
                    {formatPersonLabel(entry.person)} SS claim age
                    <input
                      type="number"
                      min={62}
                      max={70}
                      step={1}
                      value={entry.claimAge}
                      onChange={(event) =>
                        updateSocialSecurityClaim(
                          entry.person,
                          Math.max(62, Math.min(70, Number(event.target.value) || 62)),
                        )
                      }
                      className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                    />
                  </label>
                ))}
              </div>
              <div className="space-y-3">
                {data.income.windfalls.map((windfall) => (
                  <div key={windfall.name} className="rounded-xl border border-stone-200 bg-stone-50/80 p-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="text-sm text-stone-700">
                        {formatWindfallLabel(windfall.name)} year
                        <input
                          type="number"
                          min={new Date().getFullYear()}
                          step={1}
                          value={windfall.year}
                          onChange={(event) =>
                            updateWindfall(
                              windfall.name,
                              'year',
                              Math.max(new Date().getFullYear(), Math.round(Number(event.target.value) || 0)),
                            )
                          }
                          className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                        />
                      </label>
                      <label className="text-sm text-stone-700">
                        {formatWindfallLabel(windfall.name)} amount
                        <input
                          type="number"
                          min={0}
                          step={10000}
                          value={windfall.amount}
                          onChange={(event) =>
                            updateWindfall(windfall.name, 'amount', Math.max(0, Number(event.target.value) || 0))
                          }
                          className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                        />
                      </label>
                    </div>
                    {windfall.name === 'home_sale' ? (
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <label className="text-sm text-stone-700">
                          Home cost basis
                          <input
                            type="number"
                            min={0}
                            step={10000}
                            value={windfall.costBasis ?? ''}
                            onChange={(event) =>
                              updateWindfall(
                                windfall.name,
                                'costBasis',
                                Math.max(0, Number(event.target.value) || 0),
                              )
                            }
                            className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                          />
                        </label>
                        <label className="text-sm text-stone-700">
                          Capital-gains exclusion
                          <input
                            type="number"
                            min={0}
                            step={50000}
                            value={windfall.exclusionAmount ?? ''}
                            onChange={(event) =>
                              updateWindfall(
                                windfall.name,
                                'exclusionAmount',
                                Math.max(0, Number(event.target.value) || 0),
                              )
                            }
                            className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                          />
                        </label>
                        <label className="text-sm text-stone-700">
                          Net liquidity from sale
                          <input
                            type="number"
                            min={0}
                            step={10000}
                            value={windfall.liquidityAmount ?? ''}
                            onChange={(event) =>
                              updateWindfall(
                                windfall.name,
                                'liquidityAmount',
                                Math.max(0, Number(event.target.value) || 0),
                              )
                            }
                            className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </ControlSection>

          <ControlSection
            title="Market Assumptions"
            summary={`Eq ${formatPercent(assumptions.equityMean)} · Vol ${formatPercent(assumptions.equityVolatility)} · Inflation ${formatPercent(assumptions.inflation)}`}
            isOpen={controlsSectionState.assumptions}
            onToggle={() => setControlsSectionOpen('assumptions', !controlsSectionState.assumptions)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-stone-700">
                Equity mean
                <input
                  type="number"
                  min={0.04}
                  max={0.1}
                  step={0.002}
                  value={assumptions.equityMean}
                  onChange={(event) => updateAssumption('equityMean', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Equity volatility
                <input
                  type="number"
                  min={0.08}
                  max={0.28}
                  step={0.005}
                  value={assumptions.equityVolatility}
                  onChange={(event) => updateAssumption('equityVolatility', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Inflation
                <input
                  type="number"
                  min={0.01}
                  max={0.07}
                  step={0.002}
                  value={assumptions.inflation}
                  onChange={(event) => updateAssumption('inflation', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Simulation runs
                <input
                  type="number"
                  min={100}
                  max={25000}
                  step={100}
                  value={assumptions.simulationRuns}
                  onChange={(event) => updateAssumption('simulationRuns', Math.max(100, Number(event.target.value) || 100))}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Plan Settings"
            summary={`Objective ${formatOptimizationObjectiveLabel(optimizationObjective)} · IRMAA ${irmaaPosture} · Autopilot ${autopilotDefensive ? 'defensive' : 'balanced'} · Success floor ${targetSuccessRatePercent}% (${formatSuccessFloorModeLabel(successFloorMode)})`}
            isOpen={controlsSectionState.planSettings}
            onToggle={() => setControlsSectionOpen('planSettings', !controlsSectionState.planSettings)}
          >
            <div className="grid gap-4 lg:grid-cols-3">
              <label className="text-sm text-stone-700">
                Optimization objective
                <select
                  value={optimizationObjective}
                  onChange={(event) =>
                    setOptimizationObjective(event.target.value as OptimizationObjective)
                  }
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="preserve_legacy">Preserve legacy</option>
                  <option value="minimize_failure_risk">Minimize failure risk</option>
                  <option value="maximize_flat_spending">Maximize flat spending</option>
                  <option value="maximize_time_weighted_spending">
                    Maximize time-weighted spending
                  </option>
                </select>
              </label>
              <label className="text-sm text-stone-700">
                Success floor mode
                <select
                  value={successFloorMode}
                  onChange={(event) => setSuccessFloorModeAndTarget(event.target.value as SuccessFloorMode)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="conservative">Conservative (95%)</option>
                  <option value="balanced">Balanced (92%)</option>
                  <option value="aggressive">Aggressive (85%)</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label className="text-sm text-stone-700">
                Target success rate (%)
                <input
                  type="number"
                  value={targetSuccessRatePercent}
                  min={1}
                  max={99}
                  step={1}
                  onChange={(event) => updateTargetSuccessRatePercent(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                IRMAA posture
                <select
                  value={irmaaPosture}
                  onChange={(event) => setIrmaaPosture(event.target.value as IrmaaPosture)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="minimize">Minimize</option>
                  <option value="balanced">Balanced</option>
                  <option value="ignore">Ignore</option>
                </select>
              </label>
              <label className="text-sm text-stone-700">
                Autopilot posture
                <select
                  value={autopilotDefensive ? 'defensive' : 'balanced'}
                  onChange={(event) => setAutopilotDefensive(event.target.value === 'defensive')}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="defensive">Defensive</option>
                  <option value="balanced">Balanced</option>
                </select>
              </label>
              <label className="text-sm text-stone-700">
                Optional spending flexibility (%)
                <input
                  type="number"
                  value={optionalFlexPercent}
                  min={0}
                  max={40}
                  step={1}
                  onChange={(event) => setOptionalFlexPercent(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Travel flexibility (%)
                <input
                  type="number"
                  value={travelFlexPercent}
                  min={0}
                  max={60}
                  step={1}
                  onChange={(event) => setTravelFlexPercent(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  checked={autopilotOptionalCutsAllowed}
                  onChange={(event) => setAutopilotOptionalCutsAllowed(event.target.checked)}
                />
                Optional cuts allowed
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  checked={preserveRothPreference}
                  onChange={(event) => setPreserveRothPreference(event.target.checked)}
                />
                Prefer preserving Roth
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Legacy Goal"
            summary={legacySummary}
            isOpen={controlsSectionState.legacyGoal}
            onToggle={() => setControlsSectionOpen('legacyGoal', !controlsSectionState.legacyGoal)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-stone-700">
                Legacy target ($)
                <input
                  type="number"
                  value={legacyTargetTodayDollars}
                  min={0}
                  step={10000}
                  onChange={(event) => setLegacyTargetTodayDollars(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Legacy priority
                <select
                  value={legacyPriority}
                  onChange={(event) => setLegacyPriority(event.target.value as LegacyPriority)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="off">Off</option>
                  <option value="nice_to_have">Nice to have</option>
                  <option value="important">Important</option>
                  <option value="must_preserve">Must preserve</option>
                </select>
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Excluded High-Impact Options"
            summary={constraintSummary}
            isOpen={controlsSectionState.recommendationOverlay}
            onToggle={() =>
              setControlsSectionOpen(
                'recommendationOverlay',
                !controlsSectionState.recommendationOverlay,
              )
            }
          >
            <div className="grid gap-2 md:grid-cols-2">
              {(Object.keys(CONSTRAINT_MODIFIER_LABELS) as ConstraintModifierKey[]).map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={draftConstraintModifiers[key]}
                    onChange={(event) => setDraftModifier(key, event.target.checked)}
                  />
                  {CONSTRAINT_MODIFIER_LABELS[key]}
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={isRunning || !hasDraftConstraintChanges}
                onClick={handleUpdateModelFromDraft}
                className="rounded-full bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRunning ? 'Updating…' : 'Update Model'}
              </button>
              <p className="text-xs text-stone-500">
                {hasDraftConstraintChanges
                  ? 'Draft modifiers differ from the applied model.'
                  : 'Draft and applied modifiers are in sync.'}
              </p>
            </div>
          </ControlSection>
        </div>
        </SectionCard>
      ) : null}

      {currentEvaluation && currentRun ? (
        <SectionCard title="Plan Interpretation">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">IRMAA + legacy read</p>
              <p className="mt-2 text-sm text-stone-700">{currentEvaluation.irmaa.explanation}</p>
              <p className="mt-2 text-sm text-stone-700">
                Legacy floor {formatCurrency(currentEvaluation.calibration.legacyFloorTodayDollars)} · target band{' '}
                {formatCurrency(currentEvaluation.calibration.legacyTargetBandLowerTodayDollars)} to{' '}
                {formatCurrency(currentEvaluation.calibration.legacyTargetBandUpperTodayDollars)} (
                {formatLegacyPriorityLabel(currentEvaluation.calibration.legacyPriority)}) · projected{' '}
                {formatCurrency(currentEvaluation.calibration.projectedLegacyTodayDollars)} · approx 1σ robust range{' '}
                {formatCurrency(currentEvaluation.calibration.endingWealthOneSigmaLowerTodayDollars)} to{' '}
                {formatCurrency(currentEvaluation.calibration.endingWealthOneSigmaUpperTodayDollars)}.
              </p>
            </div>

            <div className="rounded-xl bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">What changed from last run</p>
              {!runDelta ? (
                <p className="mt-2 text-sm text-stone-600">No previous run yet.</p>
              ) : (
                <div className="mt-2 space-y-2 text-sm text-stone-700">
                  <p>
                    Change from last run:{' '}
                    <span className={`font-semibold ${successDeltaPresentation?.className ?? ''}`}>
                      {successDeltaPresentation?.label}
                    </span>
                  </p>
                  <p>{runDelta.topRecommendationMessage}</p>
                  <p>{runDelta.biggestDriverMessage}</p>
                  <p>
                    Projected legacy (today $) change:{' '}
                    <span className="font-semibold">
                      {formatCurrency(runDelta.projectedLegacyTodayDollarsDelta)}
                    </span>
                  </p>
                </div>
              )}
            </div>
          </div>

          {currentRun.plan.inferredAssumptions.length ? (
            <p className="mt-3 text-sm text-stone-700">
              Model completeness: <span className="font-semibold">{currentRun.plan.modelCompleteness}</span> ·
              inferred assumptions: {currentRun.plan.inferredAssumptions.join('; ')}
            </p>
          ) : (
            <p className="mt-3 text-sm text-stone-700">
              Model completeness: <span className="font-semibold">{currentRun.plan.modelCompleteness}</span>
            </p>
          )}
        </SectionCard>
      ) : null}

      {debugDiagnosticsPayloadWithStrategicPrep ? (
        <SectionCard title="Diagnostics">
          <details className="rounded-xl bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-stone-800">
              Diagnostics (temporary debug)
            </summary>
            <p className="mt-3 text-xs text-stone-600">
              Missing expected fields in spendingCalibration:{' '}
              {missingDebugFields.length ? missingDebugFields.join(', ') : 'none'}
            </p>
            <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-stone-900 p-3 text-[11px] leading-5 text-stone-100">
              <code>{JSON.stringify(debugDiagnosticsPayloadWithStrategicPrep, null, 2)}</code>
            </pre>
          </details>
        </SectionCard>
      ) : null}
    </section>
  );
}
