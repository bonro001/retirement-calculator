import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MarketAssumptions, PathResult, SeedData } from './types';
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
import { getRmdStartAgeForBirthYear } from './retirement-rules';
import type { IrmaaPosture } from './retirement-plan';
import { useAppStore } from './store';
import { formatCurrency, formatPercent } from './utils';

const INTERACTIVE_UNIFIED_PLAN_MAX_RUNS = 250;
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
  const updateIncome = useAppStore((state) => state.updateIncome);
  const updateSpending = useAppStore((state) => state.updateSpending);
  const updateSocialSecurityClaim = useAppStore((state) => state.updateSocialSecurityClaim);
  const updateWindfall = useAppStore((state) => state.updateWindfall);
  const updateAssumption = useAppStore((state) => state.updateAssumption);

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
  const [planAnalysisStatus, setPlanAnalysisStatus] = useState<PlanAnalysisStatus>('running');
  const [error, setError] = useState<string | null>(null);
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
      latestEvaluationRef.current = message.evaluation;
      lastRunFingerprintRef.current = runFingerprint;
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
  }, [clearTrackedPlanAnalysisTimeout, stopTrackedPlanAnalysis]);

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
          latestEvaluationRef.current = evaluation;
          lastRunFingerprintRef.current = runFingerprint;
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
    successFloorMode,
    stopTrackedPlanAnalysis,
    currentEvaluation,
    clearTrackedPlanAnalysisTimeout,
    targetSuccessRatePercent,
    travelFlexPercent,
  ]);

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
    if (hasInitializedRef.current) {
      return;
    }
    hasInitializedRef.current = true;
    perfLog('unified-plan', 'effect-triggered initial plan analysis');
    runUnifiedAnalysis('initial-load', appliedConstraintModifiers);
  }, [appliedConstraintModifiers, runUnifiedAnalysis]);

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
  const flightPathSummary = currentEvaluation
    ? `Current course is being evaluated under “${activeOptimizationObjectiveLabel}”. The current feasible plan supports about ${formatCurrency(currentEvaluation.summary.planSupportsAnnual)}/year with ${formatPercent(currentEvaluation.summary.successRate)} success.`
    : `Current course is anchored by the latest plan snapshot (${formatPercent(primaryPath.successRate)} success).`;
  const autopilotSummary = currentEvaluation
    ? `${currentEvaluation.responsePolicy.posture} posture · ${currentEvaluation.responsePolicy.routeSummary}`
    : 'Defensive posture assumed while guidance is loading.';
  const primaryPressure = currentEvaluation
    ? toReadableConstraint(currentEvaluation.responsePolicy.primaryBindingConstraint)
    : toReadableConstraint(primaryPath.failureMode);
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
  }, [currentEvaluation, data]);
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
  const bestImprovementLeverLabel =
    strategicPrepRecommendations[0]?.title ?? 'Waiting for strategic prep pass';
  const suggestedLevers = strategicPrepRecommendations.length
    ? strategicPrepRecommendations.map((item) => item.title)
    : ['No lever available yet'];
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
            {isRunning
              ? 'Analysis running'
              : error
                ? 'Analysis error'
                : planAnalysisStatus === 'stale'
                  ? 'Analysis outdated'
                : currentEvaluation
                  ? 'Analysis current'
                  : 'Analysis pending'}
          </span>
          <button
            type="button"
            onClick={() => runUnifiedAnalysis('manual', appliedConstraintModifiers)}
            disabled={isRunning}
            className="rounded-full bg-blue-700 px-3 py-1 text-xs font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning ? 'Running Plan Analysis…' : 'Run Plan Analysis'}
          </button>
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

      <SectionCard title="Flight Path">
        <div className="rounded-xl bg-white p-4 text-sm text-stone-700">
          <p>{flightPathSummary}</p>
          <p className="mt-2">
            <span className="font-semibold">Active objective:</span> {activeOptimizationObjectiveLabel}
          </p>
          <p className="mt-2">
            <span className="font-semibold">Autopilot posture:</span> {autopilotSummary}
          </p>
          <p className="mt-1">
            <span className="font-semibold">Primary pressure:</span> {primaryPressure}
          </p>
          <p className="mt-1">
            <span className="font-semibold">Best improvement lever:</span>{' '}
            {bestImprovementLeverLabel}
          </p>
          {timePreference ? (
            <p className="mt-1">
              <span className="font-semibold">Time preference:</span>{' '}
              60s {formatTimePreferenceLabel(timePreference.profile.ages60to69)} · 70s{' '}
              {formatTimePreferenceLabel(timePreference.profile.ages70to79)} · 80+{' '}
              {formatTimePreferenceLabel(timePreference.profile.ages80plus)}
            </p>
          ) : null}

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
        <div className="mt-4">
          <SectionCard title="Plan Verdict">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Verdict</p>
              <p className={`mt-1 text-lg font-semibold ${verdictClassName(currentEvaluation.summary.planVerdict)}`}>
                {currentEvaluation.summary.planVerdict}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Modeled success</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatPercent(currentEvaluation.summary.successRate)}
              </p>
            </div>
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
            summary={`${formatCurrency(data.income.salaryAnnual)} salary · ends ${data.income.salaryEndDate.slice(0, 10)}`}
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
                  value={data.income.salaryEndDate.slice(0, 10)}
                  onChange={(event) => updateIncome('salaryEndDate', new Date(event.target.value).toISOString())}
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
                  <div key={windfall.name} className="grid gap-3 md:grid-cols-2">
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
