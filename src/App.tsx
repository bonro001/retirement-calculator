import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UnifiedPlanScreen } from './UnifiedPlanScreen';
import {
  InsightCard,
  MetricTile,
  Panel,
  RiskPill,
  Tag,
  TimelineCard,
  WithdrawalStep,
} from './ui-primitives';
import { TaxesScreen } from './screens/TaxesScreen';
import { IncomeScreen } from './screens/IncomeScreen';
import { SpendingScreen } from './screens/SpendingScreen';

const Plan20Screen = lazy(() =>
  import('./Plan20Screen').then((m) => ({ default: m.Plan20Screen })),
);

function LazyScreenFallback({ label }: { label: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-stone-200 border-t-blue-600" />
      <p className="text-sm font-medium text-stone-600">{label}</p>
    </div>
  );
}
import { perfLog, perfStart } from './debug-perf';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from './simulation-worker-types';
import type {
  PlanAnalysisWorkerRequest,
  PlanAnalysisWorkerResponse,
} from './plan-analysis-worker-types';
import type {
  DecisionEngineWorkerRequest,
  DecisionEngineWorkerResponse,
} from './decision-engine-worker-types';
import type { Plan } from './plan-evaluation';
import {
  evaluateDecisionLevers,
  type DecisionEngineReport,
  type LeverScenarioResult,
  type RecommendationConstraints,
} from './decision-engine';
import {
  buildExplainabilityReportFromSimulation,
  type ExplainabilityReport,
} from './explainability';
import {
  buildScenarioCompareDisplayRows,
  getScenarioCompareRegistry,
  runScenarioCompare,
  type ScenarioCompareReport,
} from './scenario-compare';
import { generateAutopilotPlan, type AutopilotPlanResult } from './autopilot-timeline';
import {
  buildPlanningStateExportWithResolvedContext,
  PLANNING_EXPORT_CACHE_VERSION,
  type PlanningStateExport,
} from './planning-export';
import type {
  PlanningExportWorkerRequest,
  PlanningExportWorkerResponse,
} from './planning-export-worker-types';
import { solveSpendByReverseTimeline, type SpendSolverResult } from './spend-solver';
import { useAppStore } from './store';
import { usePlanningExportPayload } from './usePlanningExportPayload';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import {
  loadScenarioCompareFromCache,
  saveScenarioCompareToCache,
} from './scenario-compare-cache';
import { loadSimulationResultFromCache, saveSimulationResultToCache } from './simulation-result-cache';
import type {
  MarketAssumptions,
  Holding,
  PathResult,
  SeedData,
  ScreenId,
  SimulationParityReport,
  SourceAccount,
} from './types';
import {
  buildDistributionSeries,
  buildPathResults,
  buildSimulationParityReport,
  buildProjectionSeries,
  calculateCurrentAges,
  formatCurrency,
  formatDate,
  formatPercent,
  getAnnualCoreSpend,
  getAnnualStretchSpend,
  getRetirementHorizonYears,
  getTotalPortfolioBalance,
} from './utils';
import {
  DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS,
  DEFAULT_MAX_CLOSED_LOOP_PASSES,
} from './closed-loop-config';

const navigation: { id: ScreenId; label: string; shortLabel: string }[] = [
  { id: 'overview', label: 'Plan', shortLabel: 'Plan' },
  { id: 'plan2', label: 'Plan 2.0', shortLabel: 'Plan 2.0' },
  { id: 'paths', label: 'Path Comparison', shortLabel: 'Paths' },
  { id: 'compare', label: 'Scenario Compare', shortLabel: 'Compare' },
  { id: 'accounts', label: 'Accounts', shortLabel: 'Accounts' },
  { id: 'spending', label: 'Spending', shortLabel: 'Spending' },
  { id: 'income', label: 'Income', shortLabel: 'Income' },
  { id: 'taxes', label: 'Taxes', shortLabel: 'Taxes' },
  { id: 'stress', label: 'Stress Tests', shortLabel: 'Stress' },
  { id: 'simulation', label: 'Simulation', shortLabel: 'Sim' },
  { id: 'export', label: 'Export', shortLabel: 'Export' },
];

const chartPalette = ['#2563eb', '#0891b2', '#1d4ed8', '#0369a1'];
const SIMULATION_REQUEST_PREFIX = 'simulation-request';
const EXPORT_REQUEST_PREFIX = 'planning-export-request';
const exportPayloadCache = new Map<string, PlanningStateExport>();

const EMPTY_SIMULATION_DIAGNOSTICS: PathResult['simulationDiagnostics'] = {
  effectiveSpendPath: [],
  withdrawalPath: [],
  withdrawalRationalePath: [],
  taxesPaidPath: [],
  magiPath: [],
  conversionPath: [],
  rothConversionTracePath: [],
  rothConversionEligibilityPath: [],
  rothConversionDecisionSummary: {
    executedYearCount: 0,
    blockedYearCount: 0,
    noEconomicBenefitYearCount: 0,
    notEligibleYearCount: 0,
    reasons: [],
  },
  failureYearDistribution: [],
  closedLoopConvergenceSummary: {
    converged: false,
    convergedRate: 0,
    passesUsed: 0,
    stopReason: 'max_pass_limit_reached',
    finalMagiDelta: 0,
    finalFederalTaxDelta: 0,
    finalHealthcarePremiumDelta: 0,
    convergedBeforeMaxPasses: false,
    convergedBeforeMaxPassesRate: 0,
  },
  closedLoopConvergencePath: [],
  closedLoopRunSummary: {
    runCount: 0,
    convergedRunCount: 0,
    nonConvergedRunCount: 0,
    convergedRunRate: 0,
    stopReasonCounts: {
      converged_thresholds_met: 0,
      max_pass_limit_reached: 0,
      no_change: 0,
    },
    nonConvergedRunIndexes: [],
  },
  closedLoopRunConvergence: [],
};

const EMPTY_SIMULATION_CONFIGURATION: PathResult['simulationConfiguration'] = {
  mode: 'planner_enhanced',
  plannerLogicActive: true,
  activeStressors: [],
  activeResponses: [],
  withdrawalPolicy: {
    order: ['cash', 'taxable', 'pretax', 'roth'],
    dynamicDefenseOrdering: true,
    irmaaAware: true,
    acaAware: false,
    preserveRothPreference: true,
    closedLoopHealthcareTaxIteration: true,
    maxClosedLoopPasses: DEFAULT_MAX_CLOSED_LOOP_PASSES,
    closedLoopConvergenceThresholds: {
      ...DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS,
    },
  },
  rothConversionPolicy: {
    proactiveConversionsEnabled: false,
    strategy: 'aca_then_irmaa_headroom',
    minAnnualDollars: 500,
    maxPretaxBalancePercent: 0.12,
    magiBufferDollars: 2000,
    source: 'default',
    description: 'Pending simulation run.',
  },
  liquidityFloorBehavior: {
    guardrailsEnabled: true,
    floorYears: 0,
    ceilingYears: 0,
    cutPercent: 0,
  },
  inflationHandling: {
    baseMean: 0,
    volatility: 0,
    highInflationStressorFloor: 0.05,
    highInflationStressorDurationYears: 10,
  },
  returnGeneration: {
    model: 'bounded_normal_by_asset_class',
    boundsByAssetClass: {
      US_EQUITY: { min: -0.45, max: 0.45 },
      INTL_EQUITY: { min: -0.5, max: 0.45 },
      BONDS: { min: -0.2, max: 0.2 },
      CASH: { min: -0.01, max: 0.08 },
    },
    stressOverlayRules: [],
  },
  returnModelExtensionPoints: [
    {
      model: 'regime_switching_correlated',
      status: 'hook_only',
      description:
        'Extension hook reserved for future regime-switching correlated return generator.',
    },
    {
      model: 'fat_tailed_correlated',
      status: 'hook_only',
      description:
        'Extension hook reserved for future fat-tailed correlated return generator.',
    },
  ],
  timingConventions: {
    currentPlanningYear: new Date().getUTCFullYear(),
    salaryProrationRule: 'month_fraction',
    inflationCompounding: 'annual',
  },
  simulationSettings: {
    seed: 0,
    runCount: 0,
    assumptionsVersion: 'v1',
  },
};

const EMPTY_PARITY_REPORT: SimulationParityReport = {
  rawSimulation: {
    label: 'Raw Simulation',
    mode: 'raw_simulation',
    successRate: 0,
    medianEndingWealth: 0,
    medianFailureYear: null,
    annualFederalTaxEstimate: 0,
    plannerLogicActive: false,
    simulationConfiguration: {
      ...EMPTY_SIMULATION_CONFIGURATION,
      mode: 'raw_simulation',
      plannerLogicActive: false,
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        dynamicDefenseOrdering: false,
        irmaaAware: false,
        acaAware: false,
        preserveRothPreference: false,
        closedLoopHealthcareTaxIteration: true,
        maxClosedLoopPasses: DEFAULT_MAX_CLOSED_LOOP_PASSES,
        closedLoopConvergenceThresholds: {
          ...DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS,
        },
      },
      liquidityFloorBehavior: {
        guardrailsEnabled: false,
        floorYears: 0,
        ceilingYears: 0,
        cutPercent: 0,
      },
    },
    diagnostics: EMPTY_SIMULATION_DIAGNOSTICS,
  },
  plannerEnhancedSimulation: {
    label: 'Planner-Enhanced Simulation',
    mode: 'planner_enhanced',
    successRate: 0,
    medianEndingWealth: 0,
    medianFailureYear: null,
    annualFederalTaxEstimate: 0,
    plannerLogicActive: true,
    simulationConfiguration: EMPTY_SIMULATION_CONFIGURATION,
    diagnostics: EMPTY_SIMULATION_DIAGNOSTICS,
  },
  successRateDelta: 0,
  medianEndingWealthDelta: 0,
  annualFederalTaxDelta: 0,
  seed: 0,
  runCount: 0,
  assumptionsVersion: 'v1',
};

type SelectorHelpCategory = 'Stressor assumption' | 'Planner response' | 'Planner setting';

interface SelectorHelpText {
  label: string;
  whatChanges: string;
  whenApplies: string;
  category: SelectorHelpCategory;
}

const DRAWER_SECTION_HELP = {
  stressors:
    'Stressors are assumptions that make the baseline environment harder so you can test resilience under pressure.',
  solutions:
    'Solutions are planner responses the model can apply to improve resilience when stressors are active.',
} as const;

const DRAWER_SELECTOR_HELP: {
  stressors: Record<string, SelectorHelpText>;
  responses: Record<string, SelectorHelpText>;
} = {
  stressors: {
    layoff: {
      label: 'Laid Off Early',
      whatChanges:
        'Sets salary end date to January 1 of the current planning year (immediate layoff), creating an earlier income gap.',
      whenApplies:
        'Applies immediately and replaces the baseline retirement date for all later years.',
      category: 'Stressor assumption',
    },
    market_down: {
      label: 'Bad First 3 Years',
      whatChanges:
        'Overrides early market returns to -18%, -12%, and -8% equity in years 1-3, with a modest rebound boost in years 4-8.',
      whenApplies:
        'Applies from the current planning year; strongest impact is in early retirement (sequence risk).',
      category: 'Stressor assumption',
    },
    market_up: {
      label: 'Strong Early Market (Upside Case)',
      whatChanges:
        'Overrides early market returns to +12%, +10%, and +8% equity in years 1-3 as an upside comparison case.',
      whenApplies:
        'Applies from the current planning year; strongest impact is in the first three years.',
      category: 'Stressor assumption',
    },
    inflation: {
      label: 'High Inflation',
      whatChanges:
        'Forces inflation to at least 5% for the first 10 planning years, increasing expense growth pressure.',
      whenApplies:
        'Applies in years 1-10, then returns to the normal inflation assumption after that window.',
      category: 'Stressor assumption',
    },
    delayed_inheritance: {
      label: 'Delayed Inheritance',
      whatChanges:
        'Shifts the inheritance windfall 5 years later than baseline, reducing early bridge liquidity.',
      whenApplies:
        'Applies from now through the delayed arrival year; baseline timing resumes after receipt.',
      category: 'Stressor assumption',
    },
  },
  responses: {
    cut_spending: {
      label: 'Reduce Optional Spending',
      whatChanges:
        'Reduces optional spending by 20% (default), lowering annual withdrawals needed from the portfolio.',
      whenApplies: 'Applies immediately and continues for all modeled years while enabled.',
      category: 'Planner response',
    },
    sell_home_early: {
      label: 'Sell Home Early',
      whatChanges:
        'Moves the home-sale windfall to current year +3 (default), adding liquidity earlier in retirement.',
      whenApplies:
        'Applies at the configured trigger year and then behaves like a normal received windfall.',
      category: 'Planner response',
    },
    delay_retirement: {
      label: 'Delay Retirement',
      whatChanges:
        'Pushes salary end date later by 1 year (default), adding one more earning year before withdrawals.',
      whenApplies: 'Applies before retirement only, by shifting the salary stop date forward.',
      category: 'Planner response',
    },
    early_ss: {
      label: 'Claim Social Security Early',
      whatChanges:
        'Caps Social Security claim age at 62 (default), starting benefits sooner with reduced monthly amounts.',
      whenApplies:
        'Applies once each person reaches the selected claim age and continues thereafter.',
      category: 'Planner response',
    },
    preserve_roth: {
      label: 'Preserve Roth',
      whatChanges:
        'Enables a Roth-preservation preference so withdrawals favor other buckets first when practical.',
      whenApplies:
        'Applies during withdrawal sequencing years, especially when taxable and pre-tax assets are available.',
      category: 'Planner response',
    },
    increase_cash_buffer: {
      label: 'Increase Cash Buffer',
      whatChanges:
        'Builds an initial cash reserve target of roughly 2 years of essential spending by moving assets into cash.',
      whenApplies:
        'Applies immediately at plan setup, then the larger cushion is available for early withdrawal years.',
      category: 'Planner response',
    },
  },
};

const EMPTY_PATH_RESULT: PathResult = {
  id: 'loading',
  label: 'Simulation pending',
  simulationMode: 'planner_enhanced',
  plannerLogicActive: true,
  successRate: 0,
  medianEndingWealth: 0,
  tenthPercentileEndingWealth: 0,
  yearsFunded: 0,
  medianFailureYear: null,
  spendingCutRate: 0,
  irmaaExposureRate: 0,
  homeSaleDependenceRate: 0,
  inheritanceDependenceRate: 0,
  flexibilityScore: 0,
  cornerRiskScore: 0,
  rothDepletionRate: 0,
  annualFederalTaxEstimate: 0,
  irmaaExposure: 'Low',
  cornerRisk: 'Low',
  failureMode: 'simulation in progress',
  notes: 'Run Simulation to refresh this path.',
  stressors: [],
  responses: [],
  endingWealthPercentiles: {
    p10: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p90: 0,
  },
  failureYearDistribution: [],
  worstOutcome: {
    endingWealth: 0,
    success: false,
    failureYear: null,
  },
  bestOutcome: {
    endingWealth: 0,
    success: false,
    failureYear: null,
  },
  monteCarloMetadata: {
    seed: 0,
    trialCount: 0,
    assumptionsVersion: 'v1',
    planningHorizonYears: 0,
  },
  simulationConfiguration: EMPTY_SIMULATION_CONFIGURATION,
  simulationDiagnostics: EMPTY_SIMULATION_DIAGNOSTICS,
  riskMetrics: {
    earlyFailureProbability: 0,
    medianFailureShortfallDollars: 0,
    medianDownsideSpendingCutRequired: 0,
    worstDecileEndingWealth: 0,
    equitySalesInAdverseEarlyYearsRate: 0,
  },
  yearlySeries: [],
};
const EMPTY_PATH_RESULTS: PathResult[] = [EMPTY_PATH_RESULT];

type SimulationStatus = 'fresh' | 'stale' | 'running';

interface SimulationResultState {
  pathResults: PathResult[];
  parityReport: SimulationParityReport;
}

type AnalysisTarget = 'plan' | 'simulation';

interface ActiveAnalysisRequestMeta {
  target: AnalysisTarget;
  inputFingerprint: string;
}

interface AnalysisInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  fingerprint: string;
}

function buildSimulationInputFingerprint(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  return JSON.stringify({
    data: input.data,
    assumptions: input.assumptions,
    selectedStressors: [...input.selectedStressors].sort(),
    selectedResponses: [...input.selectedResponses].sort(),
  });
}

export function App() {
  const simulationDraft = useAppStore((state) => state.data);
  const simulationDraftAssumptions = useAppStore((state) => state.draftAssumptions);
  const simulationDraftSelectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const simulationDraftSelectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const currentPlan = useAppStore((state) => state.appliedData);
  const currentPlanAssumptions = useAppStore((state) => state.appliedAssumptions);
  const currentPlanSelectedResponses = useAppStore((state) => state.appliedSelectedResponses);
  const currentPlanSelectedStressors = useAppStore((state) => state.appliedSelectedStressors);
  const commitDraftToApplied = useAppStore((state) => state.commitDraftToApplied);
  const hasPendingSimulationChanges = useAppStore((state) => state.hasPendingSimulationChanges);
  const requestUnifiedPlanRerun = useAppStore((state) => state.requestUnifiedPlanRerun);
  const draftTradeSetActivities = useAppStore((state) => state.draftTradeSetActivities);
  const clearDraftTradeSetActivities = useAppStore((state) => state.clearDraftTradeSetActivities);
  const currentScreen = useAppStore((state) => state.currentScreen);
  const setCurrentScreen = useAppStore((state) => state.setCurrentScreen);
  const latestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.latestUnifiedPlanEvaluationContext,
  );
  const setLatestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.setLatestUnifiedPlanEvaluationContext,
  );
  const planAnalysisStatus = useAppStore((state) => state.planAnalysisStatus);

  useEffect(() => {
    if (currentScreen === 'solver' || currentScreen === 'autopilot') {
      setCurrentScreen('overview');
    }
  }, [currentScreen, setCurrentScreen]);

  const workerRef = useRef<Worker | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeRequestMetaRef = useRef<ActiveAnalysisRequestMeta | null>(null);
  const latestPlanInputFingerprintRef = useRef<string>('');
  const latestSimulationInputFingerprintRef = useRef<string>('');
  const lastPlanRunInputsRef = useRef<string | null>(null);
  const lastSimulationRunInputsRef = useRef<string | null>(null);
  const requestCounterRef = useRef(0);
  const analysisTimersRef = useRef(
    new Map<string, { target: AnalysisTarget; end: ReturnType<typeof perfStart> }>(),
  );
  const bgEvalWorkerRef = useRef<Worker | null>(null);

  const [currentPlanResult, setCurrentPlanResult] = useState<SimulationResultState | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResultState | null>(null);
  const [simCacheCheckPending, setSimCacheCheckPending] = useState(true);
  const [planResultFromCache, setPlanResultFromCache] = useState(false);

  const [planResultStatus, setPlanResultStatus] = useState<SimulationStatus>('running');
  const [simulationStatus, setSimulationStatus] = useState<SimulationStatus>('stale');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [planResultError, setPlanResultError] = useState<string | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [showTradeList, setShowTradeList] = useState(false);

  const isSimulationRunning = simulationStatus === 'running';

  const planInputFingerprint = useMemo(
    () =>
      buildSimulationInputFingerprint({
        data: currentPlan,
        assumptions: currentPlanAssumptions,
        selectedStressors: currentPlanSelectedStressors,
        selectedResponses: currentPlanSelectedResponses,
      }),
    [
      currentPlan,
      currentPlanAssumptions,
      currentPlanSelectedResponses,
      currentPlanSelectedStressors,
    ],
  );

  const simulationInputFingerprint = useMemo(
    () =>
      buildSimulationInputFingerprint({
        data: simulationDraft,
        assumptions: simulationDraftAssumptions,
        selectedStressors: simulationDraftSelectedStressors,
        selectedResponses: simulationDraftSelectedResponses,
      }),
    [
      simulationDraft,
      simulationDraftAssumptions,
      simulationDraftSelectedResponses,
      simulationDraftSelectedStressors,
    ],
  );

  // On mount, try to restore the plan result from IndexedDB before starting a fresh run.
  useEffect(() => {
    let cancelled = false;
    loadSimulationResultFromCache(planInputFingerprint).then((cached) => {
      if (cancelled) return;
      if (cached) {
        setCurrentPlanResult(cached);
        setPlanResultStatus('fresh');
        setPlanResultFromCache(true);
      }
      setSimCacheCheckPending(false);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount only

  const stopTrackedAnalysis = useCallback(
    (requestId: string, outcome: 'ok' | 'error' | 'cancelled', extra?: Record<string, unknown>) => {
      const timer = analysisTimersRef.current.get(requestId);
      if (!timer) {
        return;
      }
      timer.end(outcome, {
        target: timer.target,
        ...(extra ?? {}),
      });
      analysisTimersRef.current.delete(requestId);
    },
    [],
  );

  useEffect(() => {
    if (typeof Worker === 'undefined') {
      return undefined;
    }

    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<SimulationWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== activeRequestIdRef.current) {
        return;
      }
      const activeMeta = activeRequestMetaRef.current;
      if (!activeMeta) {
        return;
      }

      if (message.type === 'progress') {
        if (activeMeta.target === 'simulation') {
          setSimulationStatus('running');
        } else {
          setPlanResultStatus('running');
        }
        setAnalysisProgress(message.progress);
        return;
      }

      if (message.type === 'result') {
        const completedInputFingerprint = activeMeta.inputFingerprint;
        stopTrackedAnalysis(message.requestId, 'ok', {
          pathCount: message.pathResults.length,
        });
        activeRequestIdRef.current = null;
        activeRequestMetaRef.current = null;

        if (activeMeta.target === 'simulation') {
          setSimulationResult({
            pathResults: message.pathResults,
            parityReport: message.parityReport,
          });
          if (completedInputFingerprint) {
            lastSimulationRunInputsRef.current = completedInputFingerprint;
          }
          setSimulationStatus(
            completedInputFingerprint !== latestSimulationInputFingerprintRef.current
              ? 'stale'
              : 'fresh',
          );
          setSimulationError(null);
        } else {
          setCurrentPlanResult({
            pathResults: message.pathResults,
            parityReport: message.parityReport,
          });
          setPlanResultFromCache(false);
          if (completedInputFingerprint) {
            lastPlanRunInputsRef.current = completedInputFingerprint;
            void saveSimulationResultToCache(completedInputFingerprint, message.pathResults, message.parityReport);
          }
          setPlanResultStatus(
            completedInputFingerprint !== latestPlanInputFingerprintRef.current
              ? 'stale'
              : 'fresh',
          );
          setPlanResultError(null);
        }
        setAnalysisProgress(1);
        return;
      }

      if (message.type === 'cancelled') {
        stopTrackedAnalysis(message.requestId, 'cancelled');
        activeRequestIdRef.current = null;
        activeRequestMetaRef.current = null;

        if (activeMeta.target === 'simulation') {
          setSimulationStatus(
            lastSimulationRunInputsRef.current === latestSimulationInputFingerprintRef.current
              ? 'fresh'
              : 'stale',
          );
        } else {
          setPlanResultStatus(
            lastPlanRunInputsRef.current === latestPlanInputFingerprintRef.current
              ? 'fresh'
              : 'stale',
          );
        }
        setAnalysisProgress(0);
        return;
      }

      stopTrackedAnalysis(message.requestId, 'error', { error: message.error });
      activeRequestIdRef.current = null;
      activeRequestMetaRef.current = null;
      if (activeMeta.target === 'simulation') {
        setSimulationStatus(
          lastSimulationRunInputsRef.current === latestSimulationInputFingerprintRef.current
            ? 'fresh'
            : 'stale',
        );
        setSimulationError(message.error);
      } else {
        setPlanResultStatus(
          lastPlanRunInputsRef.current === latestPlanInputFingerprintRef.current
            ? 'fresh'
            : 'stale',
        );
        setPlanResultError(message.error);
      }
    };

    return () => {
      const activeRequestId = activeRequestIdRef.current;
      if (activeRequestId) {
        const cancelMessage: SimulationWorkerRequest = {
          type: 'cancel',
          requestId: activeRequestId,
        };
        worker.postMessage(cancelMessage);
      }

      worker.terminate();
      workerRef.current = null;
      activeRequestIdRef.current = null;
      activeRequestMetaRef.current = null;
      analysisTimersRef.current.clear();
    };
  }, [stopTrackedAnalysis]);

  const runAnalysis = useCallback((target: AnalysisTarget, overrideInput?: AnalysisInput) => {
    const requestId = `${SIMULATION_REQUEST_PREFIX}-${requestCounterRef.current++}`;
    const analysisInput: AnalysisInput =
      overrideInput ??
      target === 'simulation'
        ? {
            data: simulationDraft,
            assumptions: simulationDraftAssumptions,
            selectedStressors: simulationDraftSelectedStressors,
            selectedResponses: simulationDraftSelectedResponses,
            fingerprint: simulationInputFingerprint,
          }
        : {
            data: currentPlan,
            assumptions: currentPlanAssumptions,
            selectedStressors: currentPlanSelectedStressors,
            selectedResponses: currentPlanSelectedResponses,
            fingerprint: planInputFingerprint,
          };

    const activeMeta = activeRequestMetaRef.current;
    if (
      activeMeta &&
      activeMeta.target === target &&
      activeMeta.inputFingerprint === analysisInput.fingerprint
    ) {
      perfLog('simulation', 'skip duplicate analysis request', { target });
      return;
    }

    const finishPerf = perfStart('simulation', 'analysis-run', {
      target,
      hasWorker: Boolean(workerRef.current),
      stressorCount: analysisInput.selectedStressors.length,
      responseCount: analysisInput.selectedResponses.length,
    });

    if (target === 'simulation') {
      setSimulationStatus('running');
      setSimulationError(null);
    } else {
      setPlanResultStatus('running');
      setPlanResultError(null);
    }
    setAnalysisProgress(0);

    const worker = workerRef.current;
    if (!worker) {
      try {
        const nextPathResults = buildPathResults(
          analysisInput.data,
          analysisInput.assumptions,
          analysisInput.selectedStressors,
          analysisInput.selectedResponses,
        );
        const nextResult = {
          pathResults: nextPathResults,
          parityReport: buildSimulationParityReport(
            analysisInput.data,
            analysisInput.assumptions,
            analysisInput.selectedStressors,
            analysisInput.selectedResponses,
            {
              plannerPathOverride: nextPathResults[2] ?? nextPathResults[0],
            },
          ),
        };

        if (target === 'simulation') {
          setSimulationResult(nextResult);
          lastSimulationRunInputsRef.current = analysisInput.fingerprint;
          setSimulationStatus('fresh');
        } else {
          setCurrentPlanResult(nextResult);
          lastPlanRunInputsRef.current = analysisInput.fingerprint;
          setPlanResultStatus('fresh');
        }
        setAnalysisProgress(1);
        finishPerf('ok', { pathCount: nextPathResults.length, fallback: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Simulation failed';
        if (target === 'simulation') {
          setSimulationError(message);
          setSimulationStatus(
            lastSimulationRunInputsRef.current === latestSimulationInputFingerprintRef.current
              ? 'fresh'
              : 'stale',
          );
        } else {
          setPlanResultError(message);
          setPlanResultStatus(
            lastPlanRunInputsRef.current === latestPlanInputFingerprintRef.current
            ? 'fresh'
            : 'stale',
          );
        }
        finishPerf('error', { fallback: true, error: message });
      }
      return;
    }

    if (activeRequestIdRef.current) {
      const cancelMessage: SimulationWorkerRequest = {
        type: 'cancel',
        requestId: activeRequestIdRef.current,
      };
      worker.postMessage(cancelMessage);
      stopTrackedAnalysis(activeRequestIdRef.current, 'cancelled', {
        replacedBy: requestId,
      });
    }

    activeRequestIdRef.current = requestId;
    activeRequestMetaRef.current = {
      target,
      inputFingerprint: analysisInput.fingerprint,
    };
    analysisTimersRef.current.set(requestId, {
      target,
      end: finishPerf,
    });
    const runMessage: SimulationWorkerRequest = {
      type: 'run',
      payload: {
        requestId,
        data: analysisInput.data,
        assumptions: analysisInput.assumptions,
        selectedStressors: analysisInput.selectedStressors,
        selectedResponses: analysisInput.selectedResponses,
      },
    };
    worker.postMessage(runMessage);
  }, [
    currentPlan,
    currentPlanAssumptions,
    currentPlanSelectedResponses,
    currentPlanSelectedStressors,
    planInputFingerprint,
    simulationDraft,
    simulationDraftAssumptions,
    simulationDraftSelectedResponses,
    simulationDraftSelectedStressors,
    simulationInputFingerprint,
    stopTrackedAnalysis,
  ]);

  const commitSimulationToPlan = useCallback(() => {
    const nextPlanInput: AnalysisInput = {
      data: simulationDraft,
      assumptions: simulationDraftAssumptions,
      selectedStressors: simulationDraftSelectedStressors,
      selectedResponses: simulationDraftSelectedResponses,
      fingerprint: simulationInputFingerprint,
    };
    commitDraftToApplied();
    runAnalysis('plan', nextPlanInput);
  }, [
    commitDraftToApplied,
    runAnalysis,
    simulationDraft,
    simulationDraftAssumptions,
    simulationDraftSelectedResponses,
    simulationDraftSelectedStressors,
    simulationInputFingerprint,
  ]);

  useEffect(() => {
    latestPlanInputFingerprintRef.current = planInputFingerprint;
    if (!lastPlanRunInputsRef.current || planResultStatus === 'running') {
      return;
    }
    perfLog('simulation', 'effect-triggered plan status recompute', {
      stale: lastPlanRunInputsRef.current !== planInputFingerprint,
    });
    setPlanResultStatus(
      lastPlanRunInputsRef.current === planInputFingerprint ? 'fresh' : 'stale',
    );
  }, [planInputFingerprint, planResultStatus]);

  useEffect(() => {
    latestSimulationInputFingerprintRef.current = simulationInputFingerprint;
    if (!lastSimulationRunInputsRef.current || simulationStatus === 'running') {
      return;
    }

    perfLog('simulation', 'effect-triggered simulation status recompute', {
      stale: lastSimulationRunInputsRef.current !== simulationInputFingerprint,
    });
    setSimulationStatus(
      lastSimulationRunInputsRef.current === simulationInputFingerprint ? 'fresh' : 'stale',
    );
  }, [simulationInputFingerprint, simulationStatus]);

  useEffect(() => {
    if (simCacheCheckPending || currentPlanResult || activeRequestIdRef.current) {
      return;
    }
    perfLog('simulation', 'effect-triggered initial plan analysis');
    runAnalysis('plan');
  }, [runAnalysis, currentPlanResult, simCacheCheckPending]);

  // Proactively run plan evaluation in the background after the main simulation
  // completes, so Plan 2.0 doesn't need to cold-start its own evaluation.
  useEffect(() => {
    if (latestUnifiedPlanEvaluationContext !== null) return;
    if (planResultStatus === 'running') return;
    if (bgEvalWorkerRef.current) return;

    const worker = new Worker(new URL('./plan-analysis.worker.ts', import.meta.url), {
      type: 'module',
    });
    bgEvalWorkerRef.current = worker;
    const requestId = `bg-eval-${Date.now()}`;

    const timeoutId = setTimeout(() => {
      worker.terminate();
      bgEvalWorkerRef.current = null;
    }, 60_000);

    worker.onmessage = (event: MessageEvent<PlanAnalysisWorkerResponse>) => {
      const msg = event.data;
      if (msg.type === 'result') {
        setLatestUnifiedPlanEvaluationContext(msg.evaluation);
      }
      if (msg.type === 'result' || msg.type === 'error' || msg.type === 'cancelled') {
        clearTimeout(timeoutId);
        worker.terminate();
        bgEvalWorkerRef.current = null;
      }
    };

    const plan: Plan = {
      data: simulationDraft,
      assumptions: simulationDraftAssumptions,
      controls: {
        selectedStressorIds: simulationDraftSelectedStressors,
        selectedResponseIds: simulationDraftSelectedResponses,
        toggles: {
          preserveRoth: simulationDraftSelectedResponses.includes('preserve_roth'),
          increaseCashBuffer: simulationDraftSelectedResponses.includes('increase_cash_buffer'),
        },
      },
      preferences: {
        calibration: { optimizationObjective: 'maximize_time_weighted_spending' },
      },
    };

    const request: PlanAnalysisWorkerRequest = {
      type: 'run',
      payload: { requestId, plan },
    };
    worker.postMessage(request);

    return () => {
      clearTimeout(timeoutId);
      worker.terminate();
      bgEvalWorkerRef.current = null;
    };
  }, [
    latestUnifiedPlanEvaluationContext,
    planResultStatus,
    simulationDraft,
    simulationDraftAssumptions,
    simulationDraftSelectedStressors,
    simulationDraftSelectedResponses,
    setLatestUnifiedPlanEvaluationContext,
  ]);

  const cancelSimulation = () => {
    const worker = workerRef.current;
    const activeRequestId = activeRequestIdRef.current;
    const activeMeta = activeRequestMetaRef.current;

    if (!worker || !activeRequestId || activeMeta?.target !== 'simulation') {
      return;
    }

    const cancelMessage: SimulationWorkerRequest = {
      type: 'cancel',
      requestId: activeRequestId,
    };
    worker.postMessage(cancelMessage);
    stopTrackedAnalysis(activeRequestId, 'cancelled', { reason: 'manual-cancel' });
  };

  const planPathResults = currentPlanResult?.pathResults ?? [];
  const isInitialLoad = planPathResults.length === 0 && planResultStatus === 'running';
  const displayedPlanPathResults = planPathResults.length ? planPathResults : EMPTY_PATH_RESULTS;
  const planProjectionSeries = useMemo(
    () => buildProjectionSeries(displayedPlanPathResults),
    [displayedPlanPathResults],
  );
  const simulationPathResults = simulationResult?.pathResults ?? [];
  const displayedSimulationPathResults = simulationPathResults.length
    ? simulationPathResults
    : EMPTY_PATH_RESULTS;
  const simulationDistributionSeries = useMemo(
    () => buildDistributionSeries(displayedSimulationPathResults),
    [displayedSimulationPathResults],
  );
  const simulationProjectionSeries = useMemo(
    () => buildProjectionSeries(displayedSimulationPathResults),
    [displayedSimulationPathResults],
  );
  const simulationParityReport = simulationResult?.parityReport ?? EMPTY_PARITY_REPORT;

  const currentAges = calculateCurrentAges(currentPlan);
  const totalPortfolio = getTotalPortfolioBalance(currentPlan);
  const annualCoreSpend = getAnnualCoreSpend(currentPlan);
  const annualStretchSpend = getAnnualStretchSpend(currentPlan);
  const horizonYears = getRetirementHorizonYears(currentPlan, currentPlanAssumptions);
  const planPrimaryPath = displayedPlanPathResults[2] ?? displayedPlanPathResults[0];
  const { payload: planExportPayload } = usePlanningExportPayload('compact');
  const planExportCompact = planExportPayload as
    | { activeSimulationOutcome?: { successRate?: number }; simulationOutcomes?: { rawSimulation?: { successRate?: number } }; debug?: { rawSimulation?: { successRate?: number } } }
    | null;
  const flexSuccessRate = planExportCompact?.activeSimulationOutcome?.successRate ?? null;
  const handsOffSuccessRate =
    planExportCompact?.simulationOutcomes?.rawSimulation?.successRate ??
    planExportCompact?.debug?.rawSimulation?.successRate ??
    null;
  const simulationPrimaryPath =
    displayedSimulationPathResults[2] ?? displayedSimulationPathResults[0];
  const isPlanHomeScreen = currentScreen === 'overview' || currentScreen === 'insights';

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(96,165,250,0.22),_transparent_30%),linear-gradient(135deg,#f6fbff_0%,#edf5fb_42%,#dce9f5_100%)] text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1700px] flex-col xl:flex-row">
        <aside className="border-b border-stone-300/60 bg-white/75 px-4 py-5 backdrop-blur xl:min-h-screen xl:w-[280px] xl:border-b-0 xl:border-r">
          <div className="mb-6 flex items-center justify-between xl:block">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.24em] text-blue-700">
                Retirement Path Lab
              </p>
              <h1 className="mt-2 max-w-[14ch] font-serif text-3xl leading-tight text-stone-900">
                Compare futures, not just scenarios.
              </h1>
            </div>
            <div className="hidden rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-900 xl:inline-flex">
              Local-first shell
            </div>
          </div>

          <nav className="hidden space-y-2 xl:block">
            {navigation.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setCurrentScreen(item.id)}
                className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition ${
                  currentScreen === item.id
                    ? 'bg-stone-900 text-stone-50 shadow-lg shadow-stone-900/10'
                    : 'bg-stone-100/70 text-stone-700 hover:bg-stone-200/80'
                }`}
              >
                <span className="font-medium">{item.label}</span>
                <span className="text-xs uppercase tracking-[0.18em] opacity-70">
                  {item.shortLabel}
                </span>
              </button>
            ))}
          </nav>

        </aside>

        <main className="flex-1 px-4 py-4 sm:px-6 lg:px-8 lg:flex lg:max-h-screen lg:flex-col lg:overflow-hidden">
          <div className="mb-4 overflow-x-auto xl:hidden">
            <div className="flex min-w-max gap-2 pb-2">
              {navigation.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setCurrentScreen(item.id)}
                  className={`rounded-full px-4 py-2 text-sm font-medium ${
                    currentScreen === item.id
                      ? 'bg-stone-900 text-white'
                      : 'bg-white/80 text-stone-700'
                  }`}
                >
                  {item.shortLabel}
                </button>
              ))}
            </div>
          </div>

          {isPlanHomeScreen ? (
            <section className="mb-6 lg:sticky lg:top-0 lg:z-20 lg:bg-white/85 lg:pb-4 lg:backdrop-blur">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-stone-700">Plan snapshot</span>
                  {planResultStatus === 'fresh' ? (
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                      Fresh
                    </span>
                  ) : planResultStatus === 'running' ? (
                    <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800">
                      Running {Math.round(analysisProgress * 100)}%
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                      Outdated
                    </span>
                  )}
                  {planResultFromCache && planResultStatus === 'fresh' ? (
                    <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
                      from cache
                    </span>
                  ) : null}
                  {planResultError ? (
                    <span className="text-xs text-red-700">Error: {planResultError}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {planAnalysisStatus === 'fresh' ? (
                    <span className="flex items-center gap-1.5 text-xs text-stone-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      Analysis current
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={requestUnifiedPlanRerun}
                    disabled={planResultStatus === 'running' || planAnalysisStatus === 'fresh' || planAnalysisStatus === 'running'}
                    className="rounded-full bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {planAnalysisStatus === 'running' ? 'Analyzing…' : 'Run Plan Analysis'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTradeList((previous) => !previous)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                      showTradeList
                        ? 'bg-stone-900 text-white'
                        : 'bg-stone-200 text-stone-700 hover:bg-stone-300'
                    }`}
                  >
                    Trades ({draftTradeSetActivities.length})
                  </button>
                </div>
              </div>
              {showTradeList ? (
                <div className="mb-3 rounded-2xl border border-stone-200 bg-white/90 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-600">
                      Draft Trade Activity
                    </p>
                    <button
                      type="button"
                      onClick={clearDraftTradeSetActivities}
                      disabled={!draftTradeSetActivities.length}
                      className="rounded-full bg-stone-200 px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-stone-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Clear
                    </button>
                  </div>
                  {draftTradeSetActivities.length ? (
                    <div className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
                      {draftTradeSetActivities.map((activity) => (
                        <div
                          key={activity.id}
                          className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs font-semibold text-stone-900">
                              {activity.kind === 'undo' ? 'Undo' : 'Applied'}: {activity.actionTitle}
                            </p>
                            <p className="text-[11px] text-stone-500">
                              {new Date(activity.createdAtIso).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </p>
                          </div>
                          <p className="mt-1 text-[11px] text-stone-600">{activity.scenarioName}</p>
                          {activity.instructions.length ? (
                            <ul className="mt-1 space-y-1 text-[11px] text-stone-700">
                              {activity.instructions.map((instruction, index) => (
                                <li key={`${activity.id}-trade-${index}`}>
                                  {instruction.accountBucket.toUpperCase()}: {instruction.fromSymbol} {'->'}{' '}
                                  {instruction.toSymbol} ({formatCurrency(instruction.dollarAmount)})
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-[11px] text-stone-500">No trade legs recorded.</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-stone-500">
                      No trade-set activity yet. Use “Apply Trade Set To Draft” in the playbook and it will appear here.
                    </p>
                  )}
                </div>
              ) : null}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <SummaryStatCard
                  title="Primary path success"
                  value={
                    isInitialLoad
                      ? '—'
                      : formatPercent(flexSuccessRate ?? planPrimaryPath.successRate)
                  }
                  valueLabel="Flex"
                  secondaryValue={
                    isInitialLoad || handsOffSuccessRate === null
                      ? undefined
                      : formatPercent(handsOffSuccessRate)
                  }
                  secondaryLabel="Hands off"
                  description="Flex = with adaptive guardrails and planner moves. Hands off = same plan with no adjustments taken."
                />
                <SummaryStatCard
                  title="Starting runway"
                  value={isInitialLoad ? '—' : `${planPrimaryPath.yearsFunded} yrs`}
                  description={`Current assets divided by current annual spending. Planning horizon is ${horizonYears} years.`}
                />
                <SummaryStatCard
                  title="IRMAA exposure"
                  value={isInitialLoad ? '—' : planPrimaryPath.irmaaExposure}
                  description="Directional signal from the latest run for Medicare-related income pressure."
                />
              </div>
            </section>
          ) : null}

          <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
            {isInitialLoad || simCacheCheckPending ? (
              <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-stone-200 border-t-blue-600" />
                <p className="text-base font-medium text-stone-700">
                  {simCacheCheckPending ? 'Loading from cache…' : 'Computing your retirement plan…'}
                </p>
                <p className="text-sm text-stone-500">
                  {simCacheCheckPending ? 'Checking saved simulation results' : 'Running Monte Carlo simulation'}
                </p>
              </div>
            ) : (
            <section className="space-y-6">
              <div className={currentScreen === 'overview' ? '' : 'hidden'}>
                <UnifiedPlanScreen
                  data={simulationDraft}
                  assumptions={simulationDraftAssumptions}
                  simulationStatus={planResultStatus}
                  selectedStressors={simulationDraftSelectedStressors}
                  selectedResponses={simulationDraftSelectedResponses}
                  pathResults={displayedPlanPathResults}
                  showPlanControls
                />
              </div>
              {currentScreen === 'plan2' && (
                <Suspense fallback={<LazyScreenFallback label="Loading Plan 2.0…" />}>
                  <Plan20Screen />
                </Suspense>
              )}
              {currentScreen === 'paths' && (
                <PathComparisonScreen
                  pathResults={displayedPlanPathResults}
                  selectedStressors={currentPlanSelectedStressors}
                  selectedResponses={currentPlanSelectedResponses}
                />
              )}
              {currentScreen === 'compare' && (
                <ScenarioCompareScreen
                  data={currentPlan}
                  assumptions={currentPlanAssumptions}
                  selectedStressors={currentPlanSelectedStressors}
                  selectedResponses={currentPlanSelectedResponses}
                />
              )}
              {currentScreen === 'accounts' && <AccountsScreen />}
              {currentScreen === 'spending' && (
                <SpendingScreen
                  annualCoreSpend={annualCoreSpend}
                  annualStretchSpend={annualStretchSpend}
                  retirementDate={currentPlan.income.salaryEndDate}
                />
              )}
              {currentScreen === 'income' && <IncomeScreen />}
              {currentScreen === 'taxes' && <TaxesScreen />}
              {currentScreen === 'stress' && (
                <StressScreen projectionSeries={planProjectionSeries} />
              )}
              {currentScreen === 'simulation' && (
                <SimulationScreen
                  assumptions={simulationDraftAssumptions}
                  distributionSeries={simulationDistributionSeries}
                  parityReport={simulationParityReport}
                  primaryPath={simulationPrimaryPath}
                  projectionSeries={simulationProjectionSeries}
                  simulationStatus={simulationStatus}
                  simulationProgress={analysisProgress}
                  simulationError={simulationError}
                  isSimulationRunning={isSimulationRunning}
                  onRunSimulation={() => runAnalysis('simulation')}
                  onCancelSimulation={cancelSimulation}
                  onCommitToPlan={commitSimulationToPlan}
                  canCommitToPlan={hasPendingSimulationChanges}
                  isPlanResultRunning={planResultStatus === 'running'}
                />
              )}
              {currentScreen === 'insights' && (
                <UnifiedPlanScreen
                  data={simulationDraft}
                  assumptions={simulationDraftAssumptions}
                  simulationStatus={planResultStatus}
                  selectedStressors={simulationDraftSelectedStressors}
                  selectedResponses={simulationDraftSelectedResponses}
                  pathResults={displayedPlanPathResults}
                  showPlanControls={false}
                />
              )}
              {currentScreen === 'export' && <ExportScreen />}
            </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function SummaryStatCard({
  title,
  value,
  valueLabel,
  secondaryValue,
  secondaryLabel,
  description,
}: {
  title: string;
  value: string;
  valueLabel?: string;
  secondaryValue?: string;
  secondaryLabel?: string;
  description: string;
}) {
  return (
    <article className="rounded-[28px] border border-white/70 bg-white/80 p-5 shadow-lg shadow-amber-950/5 backdrop-blur">
      <p className="text-sm font-medium text-stone-500">{title}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">
        {value}
        {valueLabel ? (
          <span className="ml-2 align-middle text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            {valueLabel}
          </span>
        ) : null}
      </p>
      {secondaryValue ? (
        <p className="mt-1 text-sm text-stone-500">
          <span className="font-medium text-stone-700">{secondaryValue}</span>
          {secondaryLabel ? (
            <span className="ml-2 text-xs uppercase tracking-[0.14em] text-stone-500">
              {secondaryLabel}
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="mt-3 text-sm leading-6 text-stone-600">{description}</p>
    </article>
  );
}

function OverviewScreen({
  currentAges,
  data,
  pathResults,
  projectionSeries,
  totalPortfolio,
}: {
  currentAges: { rob: number; debbie: number };
  data: ReturnType<typeof useAppStore.getState>['data'];
  pathResults: PathResult[];
  projectionSeries: ReturnType<typeof buildProjectionSeries>;
  totalPortfolio: number;
}) {
  const baseline = pathResults[0];
  const inheritance =
    data.income.windfalls.find((item) => item.name === 'inheritance') ??
    data.income.windfalls[0];
  const homeSale =
    data.income.windfalls.find((item) => item.name === 'home_sale') ??
    data.income.windfalls[1];

  return (
    <>
      <Panel
        title="Overview"
        subtitle="This shell is built around the idea that retirement is a set of paths, not a single forecast. The current seed data shows where the plan looks resilient and where it still depends on favorable timing."
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricTile label="Rob age" value={`${currentAges.rob}`} />
          <MetricTile label="Debbie age" value={`${currentAges.debbie}`} />
          <MetricTile label="Cash reserve" value={formatCurrency(data.accounts.cash.balance)} />
          <MetricTile label="Future windfalls" value={formatCurrency(1_000_000)} />
        </div>
        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[28px] bg-stone-100/85 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-stone-500">Net worth path preview</p>
                <h3 className="text-2xl font-semibold text-stone-900">Baseline vs stressed</h3>
              </div>
              <p className="text-sm text-stone-500">Median simulated path</p>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={projectionSeries}>
                  <defs>
                    <linearGradient id="baselineFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2563eb" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0.03} />
                    </linearGradient>
                    <linearGradient id="stressFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0891b2" stopOpacity={0.32} />
                      <stop offset="95%" stopColor="#0891b2" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                  <XAxis dataKey="year" tickLine={false} axisLine={false} />
                  <YAxis
                    tickFormatter={(value) => `${Math.round(value / 1000)}k`}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Area
                    type="monotone"
                    dataKey="baseline"
                    stroke="#2563eb"
                    fill="url(#baselineFill)"
                    strokeWidth={2.5}
                  />
                  <Area
                    type="monotone"
                    dataKey="stressed"
                    stroke="#0891b2"
                    fill="url(#stressFill)"
                    strokeWidth={2.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="space-y-4">
            <InsightCard
              eyebrow="Primary read"
              title="The plan is investable, but the first decade still matters a lot."
              body={`Current investable assets are ${formatCurrency(totalPortfolio)} and the shell expects the biggest resilience boost to come from the ${formatCurrency(500_000)} inheritance plus a flexible spending response.`}
            />
            <InsightCard
              eyebrow="Key lever"
              title="Optional spending is the easiest pressure valve."
              body="The app treats your optional monthly spend and travel budget as the fastest way to improve survival without forcing a permanent lifestyle change."
            />
            <InsightCard
              eyebrow="Key risk"
              title={`Baseline failure mode: ${baseline.failureMode}.`}
              body="That is why the core product defaults to comparing paths side by side instead of hiding everything behind one probability score."
            />
          </div>
        </div>
      </Panel>

      <Panel
        title="What Matters Next"
        subtitle="This shell is already structured for the next implementation pass: real account imports, a Monte Carlo engine, and a more detailed withdrawal tax model."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <TimelineCard
            year="2027"
            title="Planned retirement"
            body={`Salary currently ends on ${formatDate(data.income.salaryEndDate)}.`}
          />
          <TimelineCard
            year={`${inheritance?.year ?? 'TBD'}`}
            title="Inheritance arrives"
            body={`Currently modeled at ${formatCurrency(inheritance?.amount ?? 0)} and treated as an explicit event, not a guarantee.`}
          />
          <TimelineCard
            year={`${homeSale?.year ?? 'TBD'}`}
            title="Home sale option"
            body={`Currently modeled at ${formatCurrency(homeSale?.amount ?? 0)} as a later-stage flexibility lever.`}
          />
        </div>
      </Panel>
    </>
  );
}

function PathComparisonScreen({
  pathResults,
  selectedStressors,
  selectedResponses,
}: {
  pathResults: PathResult[];
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  return (
    <Panel
      title="Path Comparison"
      subtitle="The shell defaults to the comparison-first table from the product spec. It shows how resilience changes when you combine the current stressors and responses instead of viewing them in isolation."
    >
      <div className="mb-5 flex flex-wrap gap-2">
        {selectedStressors.map((item) => (
          <Tag key={item} tone="stress">
            {item.replaceAll('_', ' ')}
          </Tag>
        ))}
        {selectedResponses.map((item) => (
          <Tag key={item} tone="response">
            {item.replaceAll('_', ' ')}
          </Tag>
        ))}
      </div>
      <div className="overflow-hidden rounded-[28px] border border-stone-200">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-stone-200 text-left">
            <thead className="bg-stone-100/80 text-sm uppercase tracking-[0.16em] text-stone-500">
              <tr>
                <th className="px-4 py-4 font-medium">Path</th>
                <th className="px-4 py-4 font-medium">Success</th>
                <th className="px-4 py-4 font-medium">End wealth</th>
                <th className="px-4 py-4 font-medium">Runway (start)</th>
                <th className="px-4 py-4 font-medium">IRMAA</th>
                <th className="px-4 py-4 font-medium">Corner risk</th>
                <th className="px-4 py-4 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 bg-white/80">
              {pathResults.map((path) => (
                <tr key={path.id} className="align-top">
                  <td className="px-4 py-4">
                    <p className="font-semibold text-stone-900">{path.label}</p>
                    <p className="mt-1 text-sm text-stone-500">
                      {path.failureMode}
                    </p>
                  </td>
                  <td className="px-4 py-4 text-stone-800">
                      <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-semibold text-blue-900">
                        {formatPercent(path.successRate)}
                      </span>
                  </td>
                  <td className="px-4 py-4 text-stone-700">
                    {formatCurrency(path.medianEndingWealth)}
                  </td>
                  <td className="px-4 py-4 text-stone-700">{path.yearsFunded} yrs</td>
                  <td className="px-4 py-4">
                    <RiskPill>{path.irmaaExposure}</RiskPill>
                  </td>
                  <td className="px-4 py-4">
                    <RiskPill>{path.cornerRisk}</RiskPill>
                  </td>
                  <td className="px-4 py-4 text-sm leading-6 text-stone-600">
                    {path.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

function ScenarioCompareScreen({
  data,
  assumptions,
  selectedStressors,
  selectedResponses,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  const registry = useMemo(() => getScenarioCompareRegistry(), []);
  const [selectedScenarioIds, setSelectedScenarioIds] = useState<string[]>(
    () => registry.map((scenario) => scenario.id),
  );
  const [report, setReport] = useState<ScenarioCompareReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const compareFingerprint = useMemo(
    () =>
      `${[...selectedScenarioIds].sort().join(',')}|${assumptions.simulationSeed}|${buildEvaluationFingerprint(
        {
          data,
          assumptions,
          selectedStressors,
          selectedResponses,
        },
      )}`,
    [data, assumptions, selectedStressors, selectedResponses, selectedScenarioIds],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached =
        await loadScenarioCompareFromCache<ScenarioCompareReport>(compareFingerprint);
      if (cancelled) return;
      if (cached) {
        setReport(cached);
        setFromCache(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compareFingerprint]);

  const displayRows = useMemo(
    () => (report ? buildScenarioCompareDisplayRows(report) : []),
    [report],
  );
  const resultByScenarioId = useMemo(
    () => new Map((report?.results ?? []).map((result) => [result.scenarioId, result])),
    [report],
  );

  const toggleScenario = (scenarioId: string) => {
    setSelectedScenarioIds((current) =>
      current.includes(scenarioId)
        ? current.filter((id) => id !== scenarioId)
        : [...current, scenarioId],
    );
  };

  const runCompare = () => {
    if (isRunning) {
      perfLog('simulation', 'skip duplicate scenario-compare run');
      return;
    }
    if (!selectedScenarioIds.length) {
      setError('Select at least one scenario to compare.');
      return;
    }

    setError(null);
    setIsRunning(true);
    setFromCache(false);
    nextPaint(() => {
      void (async () => {
        try {
          const compareReport = await runScenarioCompare(
            {
              data,
              assumptions: getInteractiveScenarioCompareAssumptions(assumptions),
              selectedStressors,
              selectedResponses,
              strategyMode: 'planner_enhanced',
            },
            {
              scenarioIds: selectedScenarioIds,
              seedBase: assumptions.simulationSeed,
              simulationRunsOverride: getInteractiveScenarioCompareRuns(assumptions),
              strategyMode: 'planner_enhanced',
              seedStrategy: 'shared',
            },
          );
          setReport(compareReport);
          void saveScenarioCompareToCache(compareFingerprint, compareReport);
          console.log('[Scenario Compare] full report', compareReport);
        } catch (runError) {
          setError(runError instanceof Error ? runError.message : 'Scenario compare failed.');
        } finally {
          setIsRunning(false);
        }
      })();
    });
  };

  return (
    <Panel
      title="Scenario Compare"
      subtitle="Compare named scenarios side by side using the same seed and run settings."
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runCompare}
          disabled={isRunning}
          className="rounded-full bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRunning
            ? 'Running Scenario Compare…'
            : fromCache
              ? 'Re-run Scenario Compare'
              : 'Run Scenario Compare'}
        </button>
        <p className="text-sm text-stone-600">
          Running {selectedScenarioIds.length} scenario
          {selectedScenarioIds.length === 1 ? '' : 's'} with deterministic seeds.
        </p>
        {fromCache && !isRunning ? (
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
            Loaded from cache
          </span>
        ) : null}
      </div>

      <div className="mb-5 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {registry.map((scenario) => {
          const checked = selectedScenarioIds.includes(scenario.id);
          return (
            <label
              key={scenario.id}
              className={`flex items-start gap-2 rounded-2xl border px-3 py-2 text-sm ${
                checked
                  ? 'border-blue-300 bg-blue-50/70 text-stone-900'
                  : 'border-stone-200 bg-white/70 text-stone-700'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleScenario(scenario.id)}
                className="mt-1"
              />
              <span>
                <span className="font-semibold">{scenario.name}</span>
                <span className="mt-1 block text-xs text-stone-500">{scenario.description}</span>
              </span>
            </label>
          );
        })}
      </div>

      {error ? (
        <p className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}

      {!report ? (
        <div className="rounded-[24px] bg-stone-100/80 p-5 text-sm text-stone-600">
          Run Scenario Compare to generate side-by-side outcomes and top recommendations.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[24px] border border-stone-200 bg-white/80">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-stone-200 text-left">
              <thead className="bg-stone-100/80 text-xs uppercase tracking-[0.16em] text-stone-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Scenario</th>
                  <th className="px-4 py-3 font-medium">Success</th>
                  <th className="px-4 py-3 font-medium">Median Wealth</th>
                  <th className="px-4 py-3 font-medium">P10 Wealth</th>
                  <th className="px-4 py-3 font-medium">Earliest Failure</th>
                  <th className="px-4 py-3 font-medium">Top Recommendation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200">
                {displayRows.map((row) => {
                  const fullResult = resultByScenarioId.get(row.scenarioId);
                  const topRecommendationSummary = fullResult?.topRecommendation?.summary;
                  return (
                    <tr key={row.scenarioId} className="align-top">
                      <td className="px-4 py-3 font-semibold text-stone-900">{row.scenarioName}</td>
                      <td className="px-4 py-3 text-stone-700">{row.successRate}</td>
                      <td className="px-4 py-3 text-stone-700">{row.medianEndingWealth}</td>
                      <td className="px-4 py-3 text-stone-700">{row.p10EndingWealth}</td>
                      <td className="px-4 py-3 text-stone-700">{row.earliestFailureYear}</td>
                      <td className="px-4 py-3 text-sm text-stone-700">
                        <p className="font-medium text-stone-900">{row.topRecommendation}</p>
                        {topRecommendationSummary ? (
                          <p className="mt-1 text-xs leading-5 text-stone-500">{topRecommendationSummary}</p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}

function SpendSolverScreen({
  data,
  assumptions,
  selectedStressors,
  selectedResponses,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  const [targetLegacy, setTargetLegacy] = useState(1_000_000);
  const [minSuccessRatePercent, setMinSuccessRatePercent] = useState(92);
  const [useSuccessRange, setUseSuccessRange] = useState(false);
  const [successRangeMinPercent, setSuccessRangeMinPercent] = useState(92);
  const [successRangeMaxPercent, setSuccessRangeMaxPercent] = useState(95);
  const [doNotSellPrimaryResidence, setDoNotSellPrimaryResidence] = useState(false);
  const [spendingFloorAnnual, setSpendingFloorAnnual] = useState('');
  const [spendingCeilingAnnual, setSpendingCeilingAnnual] = useState('');
  const [toleranceAnnual, setToleranceAnnual] = useState(250);
  const [result, setResult] = useState<SpendSolverResult | null>(null);
  const [isSolving, setIsSolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionKey = 'retirement-path-lab-spend-solver-v1';

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const saved = window.sessionStorage.getItem(sessionKey);
    if (!saved) {
      return;
    }

    try {
      const parsed = JSON.parse(saved) as {
        targetLegacy?: number;
        minSuccessRatePercent?: number;
        useSuccessRange?: boolean;
        successRangeMinPercent?: number;
        successRangeMaxPercent?: number;
        doNotSellPrimaryResidence?: boolean;
        spendingFloorAnnual?: string;
        spendingCeilingAnnual?: string;
        toleranceAnnual?: number;
      };
      if (typeof parsed.targetLegacy === 'number') {
        setTargetLegacy(parsed.targetLegacy);
      }
      if (typeof parsed.minSuccessRatePercent === 'number') {
        setMinSuccessRatePercent(parsed.minSuccessRatePercent);
      }
      if (typeof parsed.useSuccessRange === 'boolean') {
        setUseSuccessRange(parsed.useSuccessRange);
      }
      if (typeof parsed.successRangeMinPercent === 'number') {
        setSuccessRangeMinPercent(parsed.successRangeMinPercent);
      }
      if (typeof parsed.successRangeMaxPercent === 'number') {
        setSuccessRangeMaxPercent(parsed.successRangeMaxPercent);
      }
      if (typeof parsed.doNotSellPrimaryResidence === 'boolean') {
        setDoNotSellPrimaryResidence(parsed.doNotSellPrimaryResidence);
      }
      if (typeof parsed.spendingFloorAnnual === 'string') {
        setSpendingFloorAnnual(parsed.spendingFloorAnnual);
      }
      if (typeof parsed.spendingCeilingAnnual === 'string') {
        setSpendingCeilingAnnual(parsed.spendingCeilingAnnual);
      }
      if (typeof parsed.toleranceAnnual === 'number') {
        setToleranceAnnual(parsed.toleranceAnnual);
      }
    } catch {
      window.sessionStorage.removeItem(sessionKey);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.sessionStorage.setItem(
      sessionKey,
      JSON.stringify({
        targetLegacy,
        minSuccessRatePercent,
        useSuccessRange,
        successRangeMinPercent,
        successRangeMaxPercent,
        doNotSellPrimaryResidence,
        spendingFloorAnnual,
        spendingCeilingAnnual,
        toleranceAnnual,
      }),
    );
  }, [
    targetLegacy,
    minSuccessRatePercent,
    useSuccessRange,
    successRangeMinPercent,
    successRangeMaxPercent,
    doNotSellPrimaryResidence,
    spendingFloorAnnual,
    spendingCeilingAnnual,
    toleranceAnnual,
  ]);

  const handleSolve = () => {
    if (isSolving) {
      perfLog('solver', 'skip duplicate spend solver run');
      return;
    }
    const parsedFloor = parseOptionalNumber(spendingFloorAnnual);
    const parsedCeiling = parseOptionalNumber(spendingCeilingAnnual);
    const normalizedMinSuccessRate = clampRate(minSuccessRatePercent / 100);
    const normalizedRange = useSuccessRange
      ? {
          min: clampRate(successRangeMinPercent / 100),
          max: clampRate(successRangeMaxPercent / 100),
        }
      : undefined;

    setError(null);
    setIsSolving(true);
    setResult(null);
    nextPaint(() => {
      try {
        const solved = solveSpendByReverseTimeline({
          data,
          assumptions: getInteractiveSolverAssumptions(assumptions),
          selectedStressors,
          selectedResponses,
          targetLegacyTodayDollars: Math.max(0, targetLegacy),
          minSuccessRate: normalizedMinSuccessRate,
          successRateRange: normalizedRange,
          spendingFloorAnnual: parsedFloor,
          spendingCeilingAnnual: parsedCeiling,
          toleranceAnnual: Math.max(10, toleranceAnnual),
          maxIterations: 14,
          housingFundingPolicy: doNotSellPrimaryResidence
            ? 'do_not_sell_primary_residence'
            : 'allow_primary_residence_sale',
        });
        setResult(solved);
      } catch (solverError) {
        setError(
          solverError instanceof Error ? solverError.message : 'Spend solve failed.',
        );
      } finally {
        setIsSolving(false);
      }
    });
  };

  const annualStretchSpend = getAnnualStretchSpend(data);

  return (
    <Panel
      title="Spend Solver"
      subtitle="Reverse timeline mode solves for spending from your target outcomes. Set your legacy and success guardrails, then run solve to get a recommended spend and safe band."
    >
      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <article className="rounded-[28px] bg-stone-100/85 p-5">
          <p className="text-sm font-medium text-stone-500">Inputs</p>
          <div className="mt-4 space-y-4">
            <SolverNumberField
              label="Target legacy (today's dollars)"
              value={targetLegacy}
              onChange={setTargetLegacy}
              min={0}
              step={10000}
            />
            <SolverNumberField
              label="Minimum success rate (%)"
              value={minSuccessRatePercent}
              onChange={setMinSuccessRatePercent}
              min={1}
              max={99}
              step={1}
            />

            <label className="flex items-center gap-3 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={useSuccessRange}
                onChange={(event) => setUseSuccessRange(event.target.checked)}
              />
              Use target success-rate range
            </label>

            <label className="flex items-center gap-3 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={doNotSellPrimaryResidence}
                onChange={(event) => setDoNotSellPrimaryResidence(event.target.checked)}
              />
              Do not sell primary residence
            </label>

            {useSuccessRange ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <SolverNumberField
                  label="Success range min (%)"
                  value={successRangeMinPercent}
                  onChange={setSuccessRangeMinPercent}
                  min={1}
                  max={99}
                  step={1}
                />
                <SolverNumberField
                  label="Success range max (%)"
                  value={successRangeMaxPercent}
                  onChange={setSuccessRangeMaxPercent}
                  min={1}
                  max={99}
                  step={1}
                />
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <SolverOptionalField
                label="Spending floor (annual, optional)"
                value={spendingFloorAnnual}
                onChange={setSpendingFloorAnnual}
                placeholder="Auto"
              />
              <SolverOptionalField
                label="Spending ceiling (annual, optional)"
                value={spendingCeilingAnnual}
                onChange={setSpendingCeilingAnnual}
                placeholder="Auto"
              />
            </div>

            <SolverNumberField
              label="Solve tolerance (annual)"
              value={toleranceAnnual}
              onChange={setToleranceAnnual}
              min={10}
              step={10}
            />
          </div>

          <div className="mt-5 rounded-2xl bg-white px-4 py-3 text-sm text-stone-600">
            Current modeled spend baseline: <strong>{formatCurrency(annualStretchSpend)}</strong> per
            year.
          </div>

          <button
            type="button"
            onClick={handleSolve}
            disabled={isSolving}
            className={`mt-5 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition ${
              isSolving
                ? 'cursor-not-allowed bg-stone-300 text-stone-600'
                : 'bg-blue-600 text-white hover:bg-blue-500'
            }`}
          >
            {isSolving ? 'Solving...' : 'Solve Spend'}
          </button>
          {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
        </article>

        <article className="rounded-[28px] bg-stone-100/85 p-5">
          <p className="text-sm font-medium text-stone-500">Recommended plan</p>
          {result ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <MetricTile
                  label="Monthly spend"
                  value={formatCurrency(result.recommendedMonthlySpend)}
                />
                <MetricTile
                  label="Annual spend"
                  value={formatCurrency(result.recommendedAnnualSpend)}
                />
              </div>

              <div className="rounded-2xl bg-white p-4">
                <p className="text-sm font-medium text-stone-500">Safe spending band</p>
                <div className="mt-2 grid gap-2 text-sm text-stone-700 sm:grid-cols-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">Lower</p>
                    <p className="mt-1 font-semibold">
                      {formatCurrency(result.safeSpendingBand.lowerAnnual)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">Target</p>
                    <p className="mt-1 font-semibold">
                      {formatCurrency(result.safeSpendingBand.targetAnnual)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">Upper</p>
                    <p className="mt-1 font-semibold">
                      {formatCurrency(result.safeSpendingBand.upperAnnual)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-white p-4">
                <div className="grid gap-3 text-sm text-stone-700 sm:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                      Modeled success
                    </p>
                    <p className="mt-1 font-semibold">
                      {formatPercent(result.modeledSuccessRate)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                      Approx 1σ range (today $)
                    </p>
                    <p className="mt-1 font-semibold">
                      {formatCurrency(result.endingWealthOneSigmaLowerTodayDollars)} to{' '}
                      {formatCurrency(result.endingWealthOneSigmaUpperTodayDollars)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                      Legacy target (today $)
                    </p>
                    <p className="mt-1 font-semibold">
                      {formatCurrency(result.targetLegacyTodayDollars)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                      Projected legacy (today $)
                    </p>
                    <p className="mt-1 font-semibold">
                      {formatCurrency(result.projectedLegacyOutcomeTodayDollars)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                      Success buffer
                    </p>
                    <p className="mt-1 font-semibold">
                      {formatPercent(result.successBuffer)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                      Legacy buffer (today $)
                    </p>
                    <p className="mt-1 font-semibold">
                      {formatCurrency(result.legacyBuffer)}
                    </p>
                  </div>
                </div>
              </div>

              <article className="rounded-2xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-blue-700">
                  Constraint explanation
                </p>
                <h3 className="mt-2 text-lg font-semibold text-stone-900">
                  {result.bindingConstraint}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-700">
                  {result.actionableExplanation}
                </p>
                {result.nonConvergenceDetected ? (
                  <p className="mt-2 text-xs text-amber-700">
                    Solver reached the iteration cap and returned the best stable feasible point.
                  </p>
                ) : null}
              </article>

              <article className="rounded-2xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-blue-700">
                  Tradeoff balance
                </p>
                <p className="mt-2 text-sm leading-6 text-stone-700">
                  {result.tradeoffExplanation}
                </p>
              </article>
            </div>
          ) : (
            <div className="mt-4 rounded-2xl bg-white p-5 text-sm text-stone-600">
              Run Solve Spend to generate a recommended monthly/annual spend target and safe
              range.
            </div>
          )}
        </article>
      </div>
    </Panel>
  );
}

type WealthTimelineEventType =
  | 'aca_bridge'
  | 'aca_breach'
  | 'irmaa_surcharge'
  | 'rmd_start'
  | 'inheritance'
  | 'roth_conversion'
  | 'liquidity_pressure';

interface AutopilotWealthTimelinePoint {
  year: number;
  ageLabel: string;
  wealth: number;
  spend: number;
  withdrawalCash: number;
  withdrawalTaxable: number;
  withdrawalIra401k: number;
  withdrawalRoth: number;
  magi: number;
  tax: number;
  primaryConstraint: string;
}

interface AutopilotWealthTimelineEventPoint extends AutopilotWealthTimelinePoint {
  eventType: WealthTimelineEventType;
  eventLabel: string;
  eventDetail: string;
}

interface WealthPhaseRange {
  startYear: number;
  endYear: number;
}

interface AutopilotWealthTimelineViewModel {
  points: AutopilotWealthTimelinePoint[];
  markersByType: Record<WealthTimelineEventType, AutopilotWealthTimelineEventPoint[]>;
  acaBridgeRanges: WealthPhaseRange[];
  rmdPhaseRange: WealthPhaseRange | null;
}

const TIMELINE_EVENT_META: Record<
  WealthTimelineEventType,
  { label: string; fill: string; detail: string }
> = {
  aca_bridge: {
    label: 'ACA bridge year',
    fill: '#2563eb',
    detail: 'Pre-65 subsidy-preservation bridge year.',
  },
  aca_breach: {
    label: 'ACA breach',
    fill: '#dc2626',
    detail: 'Modeled ACA income ceiling was breached in this year.',
  },
  irmaa_surcharge: {
    label: 'IRMAA surcharge',
    fill: '#7c3aed',
    detail: 'Medicare premium surcharge is active.',
  },
  rmd_start: {
    label: 'RMD start',
    fill: '#f59e0b',
    detail: 'First year with required minimum distributions.',
  },
  inheritance: {
    label: 'Inheritance',
    fill: '#0d9488',
    detail: 'Inheritance windfall arrival year.',
  },
  roth_conversion: {
    label: 'Major Roth conversion',
    fill: '#0891b2',
    detail: 'Roth conversion is materially above baseline pace.',
  },
  liquidity_pressure: {
    label: 'Liquidity pressure',
    fill: '#be123c',
    detail: 'Liquidity floor pressure warning is active.',
  },
};

const TIMELINE_EVENT_ORDER: WealthTimelineEventType[] = [
  'aca_bridge',
  'aca_breach',
  'irmaa_surcharge',
  'rmd_start',
  'inheritance',
  'roth_conversion',
  'liquidity_pressure',
];

function buildContiguousYearRanges(years: number[]): WealthPhaseRange[] {
  if (!years.length) {
    return [];
  }

  const sorted = [...years].sort((left, right) => left - right);
  const ranges: WealthPhaseRange[] = [];
  let startYear = sorted[0];
  let endYear = sorted[0];

  for (let index = 1; index < sorted.length; index += 1) {
    const year = sorted[index];
    if (year === endYear + 1) {
      endYear = year;
      continue;
    }
    ranges.push({ startYear, endYear });
    startYear = year;
    endYear = year;
  }
  ranges.push({ startYear, endYear });
  return ranges;
}

function getEffectiveInheritanceYear(data: SeedData, selectedStressors: string[]) {
  const inheritance = data.income.windfalls.find((item) => item.name === 'inheritance');
  if (!inheritance) {
    return null;
  }
  const delayedYears = selectedStressors.includes('delayed_inheritance') ? 5 : 0;
  return inheritance.year + delayedYears;
}

function buildAutopilotWealthTimelineViewModel({
  result,
  data,
  selectedStressors,
}: {
  result: AutopilotPlanResult;
  data: SeedData;
  selectedStressors: string[];
}): AutopilotWealthTimelineViewModel {
  const points: AutopilotWealthTimelinePoint[] = result.years.map((year) => ({
    year: year.year,
    ageLabel: `${year.robAge}/${year.debbieAge}`,
    wealth: year.totalWealth,
    spend: year.plannedAnnualSpend,
    withdrawalCash: year.withdrawalCash,
    withdrawalTaxable: year.withdrawalTaxable,
    withdrawalIra401k: year.withdrawalIra401k,
    withdrawalRoth: year.withdrawalRoth,
    magi: year.estimatedMAGI,
    tax: year.estimatedFederalTax,
    primaryConstraint: formatConstraintLabel(year.primaryBindingConstraint),
  }));

  const pointByYear = new Map(points.map((point) => [point.year, point]));
  const markersByType: Record<WealthTimelineEventType, AutopilotWealthTimelineEventPoint[]> = {
    aca_bridge: [],
    aca_breach: [],
    irmaa_surcharge: [],
    rmd_start: [],
    inheritance: [],
    roth_conversion: [],
    liquidity_pressure: [],
  };

  const pushMarker = (eventType: WealthTimelineEventType, point: AutopilotWealthTimelinePoint) => {
    const meta = TIMELINE_EVENT_META[eventType];
    markersByType[eventType].push({
      ...point,
      eventType,
      eventLabel: meta.label,
      eventDetail: meta.detail,
    });
  };

  const firstRmdYear = result.years.find((year) => year.rmdAmount > 1)?.year ?? null;

  result.years.forEach((year) => {
    const point = pointByYear.get(year.year);
    if (!point) {
      return;
    }

    if (year.regime === 'aca_bridge') {
      pushMarker('aca_bridge', point);
    }
    if (year.acaStatus === 'Bridge breached' || year.acaStatus === 'Above subsidy range') {
      pushMarker('aca_breach', point);
    }
    if (year.irmaaStatus.includes('surcharge')) {
      pushMarker('irmaa_surcharge', point);
    }
    if (firstRmdYear !== null && year.year === firstRmdYear) {
      pushMarker('rmd_start', point);
    }
    const majorConversionThreshold = Math.max(20_000, year.plannedAnnualSpend * 0.12);
    if (year.suggestedRothConversion >= majorConversionThreshold) {
      pushMarker('roth_conversion', point);
    }
    if (year.diagnostics.warningFlags.includes('liquidity_floor_pressure')) {
      pushMarker('liquidity_pressure', point);
    }
  });

  const inheritanceYear = getEffectiveInheritanceYear(data, selectedStressors);
  if (inheritanceYear !== null) {
    const inheritancePoint = pointByYear.get(inheritanceYear);
    if (inheritancePoint) {
      pushMarker('inheritance', inheritancePoint);
    }
  }

  const acaBridgeRanges = buildContiguousYearRanges(
    result.years.filter((year) => year.regime === 'aca_bridge').map((year) => year.year),
  );
  const lastYear = result.years[result.years.length - 1]?.year ?? null;
  const rmdPhaseRange =
    firstRmdYear !== null && lastYear !== null
      ? {
          startYear: firstRmdYear,
          endYear: lastYear,
        }
      : null;

  return {
    points,
    markersByType,
    acaBridgeRanges,
    rmdPhaseRange,
  };
}

function WealthTimelineTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: AutopilotWealthTimelinePoint | AutopilotWealthTimelineEventPoint }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0].payload;
  const event =
    'eventType' in point ? TIMELINE_EVENT_META[point.eventType] : null;

  return (
    <div className="max-w-[320px] rounded-xl border border-stone-300 bg-white p-3 text-xs text-stone-700 shadow-xl">
      <p className="font-semibold text-stone-900">
        {point.year} (Age {point.ageLabel})
      </p>
      {event ? (
        <p className="mt-1 font-medium" style={{ color: event.fill }}>
          {event.label}
        </p>
      ) : null}
      <div className="mt-2 space-y-1">
        <p>Wealth: {formatCurrency(point.wealth)}</p>
        <p>Spend: {formatCurrency(point.spend)}</p>
        <p>
          Withdrawals: Cash {formatCurrency(point.withdrawalCash)} | Taxable{' '}
          {formatCurrency(point.withdrawalTaxable)} | IRA/401k{' '}
          {formatCurrency(point.withdrawalIra401k)} | Roth {formatCurrency(point.withdrawalRoth)}
        </p>
        <p>MAGI: {formatCurrency(point.magi)}</p>
        <p>Federal tax: {formatCurrency(point.tax)}</p>
        <p>Primary constraint: {point.primaryConstraint}</p>
      </div>
    </div>
  );
}

function AutopilotWealthTimeline({
  result,
  data,
  selectedStressors,
}: {
  result: AutopilotPlanResult;
  data: SeedData;
  selectedStressors: string[];
}) {
  const timeline = useMemo(
    () => buildAutopilotWealthTimelineViewModel({ result, data, selectedStressors }),
    [data, result, selectedStressors],
  );

  if (!timeline.points.length) {
    return null;
  }

  return (
    <article className="mt-5 rounded-[24px] bg-stone-100/85 p-4">
      <p className="text-sm font-medium text-stone-600">Wealth timeline</p>
      <p className="mt-1 text-sm text-stone-600">
        Visual route of total wealth with key guardrail events over time.
      </p>
      <div className="mt-3 h-[360px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={timeline.points} margin={{ left: 4, right: 16, top: 8, bottom: 8 }}>
            <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
            {timeline.acaBridgeRanges.map((range) => (
              <ReferenceArea
                key={`aca-${range.startYear}-${range.endYear}`}
                x1={range.startYear}
                x2={range.endYear}
                fill="#bfdbfe"
                fillOpacity={0.35}
                strokeOpacity={0}
              />
            ))}
            {timeline.rmdPhaseRange ? (
              <ReferenceArea
                x1={timeline.rmdPhaseRange.startYear}
                x2={timeline.rmdPhaseRange.endYear}
                fill="#fde68a"
                fillOpacity={0.2}
                strokeOpacity={0}
              />
            ) : null}
            <XAxis dataKey="year" tickLine={false} axisLine={false} />
            <YAxis
              tickFormatter={(value) => `${Math.round(value / 1000)}k`}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={<WealthTimelineTooltip />} />
            <Line
              type="monotone"
              dataKey="wealth"
              stroke="#1d4ed8"
              strokeWidth={3}
              dot={false}
              name="Total wealth"
            />
            {TIMELINE_EVENT_ORDER.map((eventType) =>
              timeline.markersByType[eventType].length ? (
                <Scatter
                  key={eventType}
                  data={timeline.markersByType[eventType]}
                  dataKey="wealth"
                  fill={TIMELINE_EVENT_META[eventType].fill}
                />
              ) : null,
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-800">
          ACA bridge phase
        </span>
        {timeline.rmdPhaseRange ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
            RMD phase
          </span>
        ) : null}
        {TIMELINE_EVENT_ORDER.map((eventType) =>
          timeline.markersByType[eventType].length ? (
            <span
              key={eventType}
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={{
                backgroundColor: `${TIMELINE_EVENT_META[eventType].fill}20`,
                color: TIMELINE_EVENT_META[eventType].fill,
              }}
            >
              {TIMELINE_EVENT_META[eventType].label} ({timeline.markersByType[eventType].length})
            </span>
          ) : null,
        )}
      </div>
    </article>
  );
}

function AutopilotPlanScreen({
  data,
  assumptions,
  selectedStressors,
  selectedResponses,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  const [targetLegacy, setTargetLegacy] = useState(1_000_000);
  const [minSuccessRatePercent, setMinSuccessRatePercent] = useState(92);
  const [doNotSellPrimaryResidence, setDoNotSellPrimaryResidence] = useState(false);
  const [result, setResult] = useState<AutopilotPlanResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAutopilot = () => {
    if (isRunning) {
      perfLog('retirement-plan', 'skip duplicate autopilot run');
      return;
    }
    setError(null);
    setIsRunning(true);
    setResult(null);

    nextPaint(() => {
      try {
        const plan = generateAutopilotPlan({
          data,
          assumptions: getInteractiveSolverAssumptions(assumptions),
          selectedStressors,
          selectedResponses,
          targetLegacyTodayDollars: Math.max(0, targetLegacy),
          minSuccessRate: clampRate(minSuccessRatePercent / 100),
          doNotSellPrimaryResidence,
          successRateRange: undefined,
        });
        setResult(plan);
      } catch (autopilotError) {
        setError(
          autopilotError instanceof Error ? autopilotError.message : 'Autopilot generation failed.',
        );
      } finally {
        setIsRunning(false);
      }
    });
  };

  return (
    <Panel
      title="Autopilot Plan"
      subtitle="Autopilot v1 generates a deterministic year-by-year route using the current model, spend constraints, and guardrail priorities."
    >
      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-[24px] bg-stone-100/85 p-4">
          <p className="text-sm font-medium text-stone-600">Plan targets</p>
          <div className="mt-3 space-y-3">
            <SolverNumberField
              label="Target legacy (today's dollars)"
              value={targetLegacy}
              onChange={setTargetLegacy}
              min={0}
              step={10000}
            />
            <SolverNumberField
              label="Minimum success rate (%)"
              value={minSuccessRatePercent}
              onChange={setMinSuccessRatePercent}
              min={1}
              max={99}
              step={1}
            />
            <label className="flex items-center gap-3 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={doNotSellPrimaryResidence}
                onChange={(event) => setDoNotSellPrimaryResidence(event.target.checked)}
              />
              Do not sell primary residence
            </label>
          </div>
          <button
            type="button"
            onClick={runAutopilot}
            disabled={isRunning}
            className={`mt-4 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition ${
              isRunning
                ? 'cursor-not-allowed bg-stone-300 text-stone-600'
                : 'bg-blue-600 text-white hover:bg-blue-500'
            }`}
          >
            {isRunning ? 'Building route...' : 'Generate Autopilot Plan'}
          </button>
          {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
        </article>

        <article className="rounded-[24px] bg-stone-100/85 p-4">
          <p className="text-sm font-medium text-stone-600">Route balance</p>
          {result ? (
            <div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <MetricTile
                  label="Overall success"
                  value={formatPercent(result.summary.successRate)}
                />
                <MetricTile
                  label="Projected legacy"
                  value={formatCurrency(result.summary.projectedLegacyOutcomeTodayDollars)}
                />
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                  Binding constraint
                </p>
                <p className="mt-1 text-sm font-semibold text-stone-900">
                  {formatConstraintLabel(result.summary.primaryBindingConstraint)}
                </p>
                <p className="mt-2 text-sm leading-6 text-stone-700">
                  {result.summary.bindingConstraintDescription}
                </p>
                <p className="mt-2 text-sm leading-6 text-stone-700">
                  {result.summary.whatThisMeans}
                </p>
                <p className="mt-2 text-sm leading-6 text-stone-700">{result.summary.routeSummary}</p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-stone-500">Tradeoffs</p>
                <p className="mt-1 text-sm text-stone-700">{result.summary.tradeoffSummary}</p>
                <div className="mt-3 space-y-2">
                  {result.summary.tradeoffs.slice(0, 3).map((tradeoff, index) => (
                    <div key={`${tradeoff.category}-${index}`} className="rounded-xl bg-stone-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
                        {formatConstraintLabel(tradeoff.category)} · {tradeoff.severity}
                      </p>
                      <p className="mt-1 text-sm text-stone-800">{tradeoff.summary}</p>
                      <p className="mt-1 text-xs text-stone-600">{tradeoff.impact}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-2xl bg-white p-4 text-sm text-stone-600">
              Generate a plan to see route-level summary and tradeoff visibility.
            </div>
          )}
        </article>
      </div>

      {result ? (
        <article className="mt-5 rounded-[24px] bg-stone-100/85 p-4">
          <p className="text-sm font-medium text-stone-600">Plan diagnostics</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">ACA bridge years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.totalAcaBridgeYears}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">ACA-safe years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.acaSafeYears}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">ACA breach years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.acaBreachYears}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Avoidable ACA breach years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.avoidableAcaBreachYears}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">IRMAA surcharge years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.irmaaSurchargeYears}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Years with Roth conversions</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.yearsWithRothConversions}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Years with RMDs</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.yearsWithRmds}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Primarily cash-funded years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.yearsFundedPrimarilyByCash}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Primarily taxable-funded years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.yearsFundedPrimarilyByTaxable}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Primarily IRA/401k-funded years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.yearsFundedPrimarilyByIra401k}
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-stone-500">Primarily Roth-funded years</p>
              <p className="text-base font-semibold text-stone-900">
                {result.diagnostics.yearsFundedPrimarilyByRoth}
              </p>
            </div>
          </div>
          <div className="mt-3 rounded-2xl bg-white p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Diagnostic warnings</p>
            {result.diagnostics.warningFlags.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {result.diagnostics.warningFlags.map((flag) => (
                  <span
                    key={flag}
                    className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800"
                  >
                    {formatDiagnosticWarningLabel(flag)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-stone-600">No diagnostic warnings detected.</p>
            )}
          </div>
        </article>
      ) : null}

      {result ? (
        <AutopilotWealthTimeline
          result={result}
          data={data}
          selectedStressors={selectedStressors}
        />
      ) : null}

      {result ? (
        <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-200">
          <div className="max-h-[620px] overflow-auto">
            <table className="min-w-full divide-y divide-stone-200 text-left">
              <thead className="sticky top-0 bg-stone-100/95 text-xs uppercase tracking-[0.14em] text-stone-500 backdrop-blur">
                <tr>
                  <th className="px-3 py-3 font-medium">Year</th>
                  <th className="px-3 py-3 font-medium">Age</th>
                  <th className="px-3 py-3 font-medium">Spend</th>
                  <th className="px-3 py-3 font-medium">Cash</th>
                  <th className="px-3 py-3 font-medium">Taxable</th>
                  <th className="px-3 py-3 font-medium">IRA/401k</th>
                  <th className="px-3 py-3 font-medium">Roth</th>
                  <th className="px-3 py-3 font-medium">Roth conv.</th>
                  <th className="px-3 py-3 font-medium">MAGI</th>
                  <th className="px-3 py-3 font-medium">Tax</th>
                  <th className="px-3 py-3 font-medium">IRMAA</th>
                  <th className="px-3 py-3 font-medium">ACA</th>
                  <th className="px-3 py-3 font-medium">RMD</th>
                  <th className="px-3 py-3 font-medium">Constraint</th>
                  <th className="px-3 py-3 font-medium">Tradeoff</th>
                  <th className="px-3 py-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 bg-white/85 text-sm text-stone-700">
                {result.years.map((year) => (
                  <tr key={year.year} className="align-top">
                    <td className="px-3 py-3 font-medium text-stone-900">{year.year}</td>
                    <td className="px-3 py-3">
                      {year.robAge}/{year.debbieAge}
                    </td>
                    <td className="px-3 py-3">{formatCurrency(year.plannedAnnualSpend)}</td>
                    <td className="px-3 py-3">{formatCurrency(year.withdrawalCash)}</td>
                    <td className="px-3 py-3">{formatCurrency(year.withdrawalTaxable)}</td>
                    <td className="px-3 py-3">{formatCurrency(year.withdrawalIra401k)}</td>
                    <td className="px-3 py-3">{formatCurrency(year.withdrawalRoth)}</td>
                    <td className="px-3 py-3">{formatCurrency(year.suggestedRothConversion)}</td>
                    <td className="px-3 py-3">{formatCurrency(year.estimatedMAGI)}</td>
                    <td className="px-3 py-3">{formatCurrency(year.estimatedFederalTax)}</td>
                    <td className="px-3 py-3">
                      <p>{year.irmaaStatus}</p>
                      <p className="text-xs text-stone-500">
                        {year.irmaaHeadroom === null
                          ? '—'
                          : `Headroom ${formatCurrency(year.irmaaHeadroom)}`}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <p>{year.acaStatus}</p>
                      <p className="text-xs text-stone-500">
                        {year.acaHeadroom === null
                          ? '—'
                          : `Headroom ${formatCurrency(year.acaHeadroom)}`}
                      </p>
                    </td>
                    <td className="px-3 py-3">{formatCurrency(year.rmdAmount)}</td>
                    <td className="px-3 py-3">
                      <p className="text-xs font-semibold text-stone-800">
                        {formatConstraintLabel(year.primaryBindingConstraint)}
                      </p>
                      <p className="text-xs text-stone-500">
                        {year.secondaryBindingConstraints.length
                          ? `Secondary: ${year.secondaryBindingConstraints
                              .map((constraint) => formatConstraintLabel(constraint))
                              .join(', ')}`
                          : '—'}
                      </p>
                      <p className="text-xs text-stone-500">
                        Funding: {formatFundingSourceLabel(year.diagnostics.primaryFundingSource)}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-stone-600">
                      <p>{year.tradeoffChosen}</p>
                      <p className="mt-1 text-stone-500">
                        {year.diagnostics.warningFlags.length
                          ? `Warnings: ${year.diagnostics.warningFlags
                              .map((flag) => formatDiagnosticWarningLabel(flag))
                              .join(', ')}`
                          : 'Warnings: none'}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-stone-600">
                      {year.explanation}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function AccountsScreen() {
  const data = useAppStore((state) => state.data);
  const bucketEntries = Object.entries(data.accounts);
  const totalBalance = bucketEntries.reduce(
    (sum, [, bucket]) => sum + (bucket.balance ?? 0),
    0,
  );

  return (
    <Panel
      title="Accounts"
      subtitle="This pass seeds the real bucket totals from your current accounts, keeps the bucket-level allocation view, and adds the source accounts and holdings underneath so the shell is no longer empty."
    >
      <div className="mb-5 flex items-baseline justify-between rounded-2xl bg-stone-900 px-5 py-4 text-stone-50">
        <p className="text-xs uppercase tracking-[0.18em] text-stone-300">Total portfolio</p>
        <p className="text-3xl font-semibold">{formatCurrency(totalBalance)}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {bucketEntries.map(([key, bucket]) => (
          <article
            key={key}
            className="rounded-[28px] bg-stone-100/85 p-5 transition hover:bg-stone-100"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.18em] text-stone-500">
                  {formatBucketName(key)}
                </p>
                <h3 className="mt-2 text-3xl font-semibold text-stone-900">
                  {formatCurrency(bucket.balance)}
                </h3>
              </div>
              <div className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-stone-600">
                {bucket.sourceAccounts?.length ?? 0} accounts
              </div>
            </div>
            <div className="mt-5 space-y-3">
              <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                Bucket allocation
              </p>
              {(Object.entries(bucket.targetAllocation) as [string, number][]).map(
                ([symbol, weight]) => (
                  <div
                    key={symbol}
                    className="grid grid-cols-[90px_1fr_56px] items-center gap-3"
                  >
                    <p className="font-medium text-stone-700">{symbol}</p>
                    <div className="h-2 rounded-full bg-white">
                      <div
                        className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-cyan-500"
                        style={{ width: `${weight * 100}%` }}
                      />
                    </div>
                    <p className="text-right text-sm text-stone-500">
                      {Math.round(weight * 100)}%
                    </p>
                  </div>
                ),
              )}
            </div>
            {bucket.sourceAccounts?.length ? (
              <div className="mt-6 space-y-4 border-t border-stone-200 pt-5">
                <p className="text-xs uppercase tracking-[0.16em] text-stone-500">
                  Source accounts
                </p>
                {bucket.sourceAccounts.map((account: SourceAccount) => (
                  <div key={account.id} className="rounded-[22px] bg-white p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-semibold text-stone-900">{account.name}</p>
                        <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">
                          {account.id}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold text-stone-900">
                          {formatCurrency(account.balance)}
                        </p>
                        {account.managed ? (
                          <p className="text-xs text-stone-500">Managed sleeve</p>
                        ) : null}
                      </div>
                    </div>
                    {account.holdings?.length ? (
                      <div className="mt-4 space-y-2">
                        {account.holdings.map((holding: Holding) => (
                          <div
                            key={`${account.id}-${holding.symbol}`}
                            className="flex items-center justify-between gap-4 text-sm"
                          >
                            <div className="min-w-0">
                              <p className="font-medium text-stone-700">{holding.symbol}</p>
                              {holding.name ? (
                                <p className="truncate text-xs text-stone-500">{holding.name}</p>
                              ) : null}
                            </div>
                            <p className="whitespace-nowrap text-stone-700">
                              {formatCurrency(holding.value)}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </Panel>
  );
}

function StressScreen({
  projectionSeries,
}: {
  projectionSeries: ReturnType<typeof buildProjectionSeries>;
}) {
  const stressors = useAppStore((state) => state.data.stressors);

  return (
    <Panel
      title="Stress Tests"
      subtitle="Stress tests now feed the annual simulation engine. They can change return paths, inflation, salary timing, and event dates so you can see how the plan behaves under pressure instead of only reading static assumptions."
    >
      <div className="grid gap-4 md:grid-cols-2">
        {stressors.map((stressor) => (
          <article key={stressor.id} className="rounded-[28px] bg-stone-100/85 p-5">
            <p className="text-sm uppercase tracking-[0.16em] text-stone-500">
              {stressor.type}
            </p>
            <h3 className="mt-2 text-2xl font-semibold text-stone-900">{stressor.name}</h3>
            <p className="mt-3 text-sm leading-6 text-stone-600">
              {stressor.salaryEndsEarly
                ? 'Brings forward the salary stop date to test whether retiring under pressure traps the plan.'
                : stressor.id === 'delayed_inheritance'
                  ? 'Pushes the inheritance out by five years so we can see how much early resilience depends on that event arriving on time.'
                : stressor.equityReturns
                  ? `Pins the first years to ${stressor.equityReturns
                      .map((item) => formatPercent(item))
                      .join(', ')} before recovery.`
                  : `Overrides inflation to ${formatPercent(stressor.rate ?? 0)} for ${stressor.duration} years.`}
            </p>
          </article>
        ))}
      </div>

      <div className="mt-6 rounded-[28px] bg-stone-100/85 p-4">
        <div className="mb-4">
          <p className="text-sm font-medium text-stone-500">Stress curve preview</p>
          <h3 className="text-2xl font-semibold text-stone-900">
            Three-year drawdown, five-year expansion
          </h3>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={projectionSeries}>
              <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
              <XAxis dataKey="year" tickLine={false} axisLine={false} />
              <YAxis
                tickFormatter={(value) => `${Math.round(value / 1000)}k`}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
              <Line
                type="monotone"
                dataKey="baseline"
                stroke="#2563eb"
                strokeWidth={3}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="stressed"
                stroke="#0891b2"
                strokeWidth={3}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Panel>
  );
}

function SimulationScreen({
  assumptions,
  distributionSeries,
  parityReport,
  primaryPath,
  projectionSeries,
  simulationStatus,
  simulationProgress,
  simulationError,
  isSimulationRunning,
  onRunSimulation,
  onCancelSimulation,
  onCommitToPlan,
  canCommitToPlan,
  isPlanResultRunning,
}: {
  assumptions: MarketAssumptions;
  distributionSeries: ReturnType<typeof buildDistributionSeries>;
  parityReport: SimulationParityReport;
  primaryPath: PathResult;
  projectionSeries: ReturnType<typeof buildProjectionSeries>;
  simulationStatus: SimulationStatus;
  simulationProgress: number;
  simulationError: string | null;
  isSimulationRunning: boolean;
  onRunSimulation: () => void;
  onCancelSimulation: () => void;
  onCommitToPlan: () => void;
  canCommitToPlan: boolean;
  isPlanResultRunning: boolean;
}) {
  const stressors = useAppStore((state) => state.data.stressors);
  const responses = useAppStore((state) => state.data.responses);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const toggleStressor = useAppStore((state) => state.toggleStressor);
  const toggleResponse = useAppStore((state) => state.toggleResponse);

  return (
    <Panel
      title="Simulations"
      subtitle="Run and inspect simulation outcomes here. Plan uses the last completed simulation result."
    >
      <div className="mb-6 rounded-[24px] bg-stone-100/85 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
            <span className="font-medium text-stone-700">Status</span>
            {simulationStatus === 'fresh' ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                Fresh
              </span>
            ) : simulationStatus === 'running' ? (
              <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800">
                Running {Math.round(simulationProgress * 100)}%
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                Outdated
              </span>
            )}
            {simulationError ? (
              <span className="text-xs text-red-700">Error: {simulationError}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRunSimulation}
              disabled={isSimulationRunning}
              className="rounded-full bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSimulationRunning ? 'Running Simulation…' : 'Run Simulation'}
            </button>
            <button
              type="button"
              onClick={onCommitToPlan}
              disabled={isSimulationRunning || isPlanResultRunning || !canCommitToPlan}
              className="rounded-full border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPlanResultRunning ? 'Committing…' : 'Commit to Plan'}
            </button>
            {isSimulationRunning ? (
              <button
                type="button"
                onClick={onCancelSimulation}
                className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Simulation is a sandbox. Changes affect the live Plan only after you commit.
        </p>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-[24px] bg-stone-100/85 p-4">
          <p className="text-sm font-medium text-stone-700">Scenario controls: stressors</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {stressors.map((item) => (
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
        </article>
        <article className="rounded-[24px] bg-stone-100/85 p-4">
          <p className="text-sm font-medium text-stone-700">Scenario controls: responses</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {responses.map((item) => (
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
        </article>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Equity mean" value={formatPercent(assumptions.equityMean)} />
        <MetricTile
          label="Equity volatility"
          value={formatPercent(assumptions.equityVolatility)}
        />
        <MetricTile label="Bond mean" value={formatPercent(assumptions.bondMean)} />
        <MetricTile label="Runs" value={assumptions.simulationRuns.toLocaleString()} />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="10th percentile"
          value={formatCurrency(primaryPath.tenthPercentileEndingWealth)}
        />
        <MetricTile
          label="Failure year"
          value={primaryPath.medianFailureYear ? `${primaryPath.medianFailureYear}` : 'None'}
        />
        <MetricTile
          label="Guardrail rate"
          value={formatPercent(primaryPath.spendingCutRate)}
        />
        <MetricTile
          label="IRMAA rate"
          value={formatPercent(primaryPath.irmaaExposureRate)}
        />
      </div>

      <article className="mt-6 rounded-[28px] bg-stone-100/85 p-4">
        <p className="text-sm font-medium text-stone-500">Simulation parity / validation</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Raw Simulation"
            value={formatPercent(parityReport.rawSimulation.successRate)}
          />
          <MetricTile
            label="Planner-Enhanced"
            value={formatPercent(parityReport.plannerEnhancedSimulation.successRate)}
          />
          <MetricTile
            label="Success delta"
            value={formatPercent(parityReport.successRateDelta)}
          />
          <MetricTile
            label="Run settings"
            value={`${parityReport.runCount.toLocaleString()} @ ${parityReport.seed}`}
          />
        </div>
        <div className="mt-3 rounded-2xl bg-white p-4 text-sm text-stone-700">
          <p>
            Planner logic active: {parityReport.plannerEnhancedSimulation.plannerLogicActive ? 'yes' : 'no'} •
            Raw planner logic active: {parityReport.rawSimulation.plannerLogicActive ? 'yes' : 'no'}
          </p>
          <p className="mt-1">
            Assumptions version: {parityReport.assumptionsVersion} • IRMAA-aware withdrawals (planner/raw):{' '}
            {parityReport.plannerEnhancedSimulation.simulationConfiguration.withdrawalPolicy.irmaaAware
              ? 'on'
              : 'off'}
            /
            {parityReport.rawSimulation.simulationConfiguration.withdrawalPolicy.irmaaAware
              ? 'on'
              : 'off'}
          </p>
          <p className="mt-1">
            Inflation mean/vol:{' '}
            {formatPercent(
              parityReport.plannerEnhancedSimulation.simulationConfiguration.inflationHandling.baseMean,
            )}{' '}
            /{' '}
            {formatPercent(
              parityReport.plannerEnhancedSimulation.simulationConfiguration.inflationHandling.volatility,
            )}{' '}
            • Return model:{' '}
            {parityReport.plannerEnhancedSimulation.simulationConfiguration.returnGeneration.model}
          </p>
          <p className="mt-1">
            Withdrawal order (planner):{' '}
            {parityReport.plannerEnhancedSimulation.simulationConfiguration.withdrawalPolicy.order.join(
              ' -> ',
            )}
          </p>
          <p className="mt-1">
            Withdrawal order (raw):{' '}
            {parityReport.rawSimulation.simulationConfiguration.withdrawalPolicy.order.join(' -> ')}
          </p>
          <p className="mt-2 text-xs text-stone-500">
            Raw Simulation and Planner-Enhanced Simulation are not equivalent. Use this panel to validate
            whether deltas are driven by strategy behavior versus input mismatch.
          </p>
          <details className="mt-3 rounded-xl bg-stone-50 p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
              Internal diagnostics
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-stone-900 p-3 text-[11px] leading-5 text-stone-100">
              <code>
                {JSON.stringify(
                  {
                    raw: parityReport.rawSimulation.diagnostics,
                    planner: parityReport.plannerEnhancedSimulation.diagnostics,
                  },
                  null,
                  2,
                )}
              </code>
            </pre>
          </details>
        </div>
      </article>

      <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[28px] bg-stone-100/85 p-4">
          <div className="mb-4">
            <p className="text-sm font-medium text-stone-500">Path outcome mix</p>
            <h3 className="text-2xl font-semibold text-stone-900">
              Success vs failure share
            </h3>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={distributionSeries}>
                <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                <XAxis dataKey="name" tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value: number) => `${value}%`} />
                <Bar dataKey="success" stackId="a" radius={[8, 8, 0, 0]}>
                  {distributionSeries.map((entry, index) => (
                    <Cell key={entry.name} fill={chartPalette[index % chartPalette.length]} />
                  ))}
                </Bar>
                <Bar dataKey="failure" stackId="a" fill="#d6d3d1" radius={[0, 0, 8, 8]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-[28px] bg-stone-100/85 p-4">
          <div className="mb-4">
            <p className="text-sm font-medium text-stone-500">Income vs spending</p>
            <h3 className="text-2xl font-semibold text-stone-900">
              Funding pressure over time
            </h3>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={projectionSeries}>
                <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                <XAxis dataKey="year" tickLine={false} axisLine={false} />
                <YAxis
                  tickFormatter={(value) => `${Math.round(value / 1000)}k`}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Line type="monotone" dataKey="income" stroke="#2563eb" strokeWidth={3} dot={false} />
                <Line type="monotone" dataKey="spending" stroke="#1e3a8a" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function InsightsScreen({
  pathResults,
  data,
  assumptions,
  selectedStressors,
  selectedResponses,
}: {
  pathResults: PathResult[];
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  const [currentReport, setCurrentReport] = useState<DecisionEngineReport | null>(null);
  const [previousReport, setPreviousReport] = useState<DecisionEngineReport | null>(null);
  const [explainabilityReport, setExplainabilityReport] = useState<ExplainabilityReport | null>(null);
  const [baselinePath, setBaselinePath] = useState<PathResult | null>(null);
  const [isRunningAnalysis, setIsRunningAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [disallowRetirementDelay, setDisallowRetirementDelay] = useState(false);
  const [disallowHomeSaleChanges, setDisallowHomeSaleChanges] = useState(false);
  const [disallowEssentialCuts, setDisallowEssentialCuts] = useState(false);
  const [disallowAllocationChanges, setDisallowAllocationChanges] = useState(false);
  const [disallowInheritanceReliance, setDisallowInheritanceReliance] = useState(false);
  const report = currentReport;

  const topRecommendations = report?.rankedRecommendations.slice(0, 3) ?? [];
  const topLowDisruption = report?.topLowDisruption[0] ?? null;
  const biggestDownsideRisk = report?.worstSensitivityScenarios[0] ?? null;
  const noInheritanceRisk =
    report?.worstSensitivityScenarios.find(
      (scenario) => scenario.scenarioId === 'assumption_remove_inheritance',
    ) ?? null;
  const bestPath = [...pathResults].sort((a, b) => b.successRate - a.successRate)[0];
  const recommendationConstraints = useMemo(
    () =>
      buildRecommendationConstraintsFromToggles({
        disallowRetirementDelay,
        disallowHomeSaleChanges,
        disallowEssentialCuts,
        disallowAllocationChanges,
        disallowInheritanceReliance,
      }),
    [
      disallowRetirementDelay,
      disallowHomeSaleChanges,
      disallowEssentialCuts,
      disallowAllocationChanges,
      disallowInheritanceReliance,
    ],
  );

  const decisionEngineWorkerRef = useRef<Worker | null>(null);
  const activeAnalysisRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      const activeId = activeAnalysisRequestIdRef.current;
      const worker = decisionEngineWorkerRef.current;
      if (worker && activeId) {
        const cancelMsg: DecisionEngineWorkerRequest = { type: 'cancel', requestId: activeId };
        worker.postMessage(cancelMsg);
      }
      if (worker) {
        worker.terminate();
        decisionEngineWorkerRef.current = null;
      }
    };
  }, []);

  const handleRunAnalysis = () => {
    const priorReportSnapshot = currentReport
      ? cloneDecisionEngineReport(currentReport)
      : null;
    setAnalysisError(null);
    setIsRunningAnalysis(true);
    setExplainabilityReport(null);

    if (typeof Worker === 'undefined') {
      // Graceful fallback: keep the old main-thread path for non-worker envs
      // (mainly SSR / tests). Wrapped in nextPaint so the spinner paints first.
      nextPaint(() => {
        void (async () => {
          try {
            const interactiveAssumptions = getInteractiveDecisionAssumptions(assumptions);
            const [nextBaselinePath] = buildPathResults(
              data,
              interactiveAssumptions,
              selectedStressors,
              selectedResponses,
              { pathMode: 'selected_only', strategyMode: 'planner_enhanced' },
            );
            const nextReport = await evaluateDecisionLevers(
              {
                data,
                assumptions: interactiveAssumptions,
                selectedStressors,
                selectedResponses,
                strategyMode: 'planner_enhanced',
              },
              {
                strategyMode: 'planner_enhanced',
                simulationRunsOverride: interactiveAssumptions.simulationRuns,
                seedBase: interactiveAssumptions.simulationSeed,
                seedStrategy: 'shared',
                constraints: recommendationConstraints,
                evaluateExcludedScenarios: true,
              },
            );
            setBaselinePath(nextBaselinePath);
            setPreviousReport(priorReportSnapshot);
            setCurrentReport(nextReport);
            setExplainabilityReport(
              buildExplainabilityReportFromSimulation(nextBaselinePath, nextReport),
            );
          } catch (error) {
            setAnalysisError(error instanceof Error ? error.message : 'Analysis failed');
          } finally {
            setIsRunningAnalysis(false);
          }
        })();
      });
      return;
    }

    // Cancel any prior in-flight analysis on the same worker before
    // dispatching a new one.
    if (decisionEngineWorkerRef.current && activeAnalysisRequestIdRef.current) {
      const cancelMsg: DecisionEngineWorkerRequest = {
        type: 'cancel',
        requestId: activeAnalysisRequestIdRef.current,
      };
      decisionEngineWorkerRef.current.postMessage(cancelMsg);
    }

    if (!decisionEngineWorkerRef.current) {
      decisionEngineWorkerRef.current = new Worker(
        new URL('./decision-engine.worker.ts', import.meta.url),
        { type: 'module' },
      );
      decisionEngineWorkerRef.current.onmessage = (
        event: MessageEvent<DecisionEngineWorkerResponse>,
      ) => {
        const msg = event.data;
        if (msg.requestId !== activeAnalysisRequestIdRef.current) return;
        if (msg.type === 'result') {
          setBaselinePath(msg.baselinePath);
          setPreviousReport(priorReportSnapshot);
          setCurrentReport(msg.report);
          setExplainabilityReport(
            buildExplainabilityReportFromSimulation(msg.baselinePath, msg.report),
          );
          setIsRunningAnalysis(false);
          activeAnalysisRequestIdRef.current = null;
        } else if (msg.type === 'error') {
          setAnalysisError(msg.error || 'Analysis failed');
          setIsRunningAnalysis(false);
          activeAnalysisRequestIdRef.current = null;
        } else if (msg.type === 'cancelled') {
          // Don't clear spinner — a fresher analysis is presumably running.
          if (activeAnalysisRequestIdRef.current === null) {
            setIsRunningAnalysis(false);
          }
        }
      };
    }

    const interactiveAssumptions = getInteractiveDecisionAssumptions(assumptions);
    const requestId = `decision-engine-${Date.now()}`;
    activeAnalysisRequestIdRef.current = requestId;
    const runMsg: DecisionEngineWorkerRequest = {
      type: 'run',
      payload: {
        requestId,
        data,
        assumptions: interactiveAssumptions,
        selectedStressors,
        selectedResponses,
        strategyMode: 'planner_enhanced',
        simulationRunsOverride: interactiveAssumptions.simulationRuns,
        seedBase: interactiveAssumptions.simulationSeed,
        constraints: recommendationConstraints,
      },
    };
    decisionEngineWorkerRef.current.postMessage(runMsg);
  };

  return (
    <Panel
      title="Insights"
      subtitle="Run a focused decision analysis from the current plan, then review top levers and downside sensitivities."
    >
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleRunAnalysis}
          disabled={isRunningAnalysis}
          className="rounded-full bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRunningAnalysis ? 'Running Analysis…' : 'Run Analysis'}
        </button>
        <p className="text-sm text-stone-600">
          Current baseline quick read: {bestPath.label} at {formatPercent(bestPath.successRate)} success.
        </p>
      </div>
      <div className="mb-5 grid gap-2 rounded-2xl bg-stone-100/80 p-4 md:grid-cols-2">
        <ConstraintToggle
          label="Do not recommend retiring later"
          checked={disallowRetirementDelay}
          onChange={setDisallowRetirementDelay}
        />
        <ConstraintToggle
          label="Do not recommend selling the house"
          checked={disallowHomeSaleChanges}
          onChange={setDisallowHomeSaleChanges}
        />
        <ConstraintToggle
          label="Do not recommend cutting essential spending"
          checked={disallowEssentialCuts}
          onChange={setDisallowEssentialCuts}
        />
        <ConstraintToggle
          label="Do not recommend changing allocation"
          checked={disallowAllocationChanges}
          onChange={setDisallowAllocationChanges}
        />
        <ConstraintToggle
          label="Do not rely on inheritance"
          checked={disallowInheritanceReliance}
          onChange={setDisallowInheritanceReliance}
        />
      </div>

      {analysisError ? (
        <p className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          Analysis error: {analysisError}
        </p>
      ) : null}

      {!report || !baselinePath ? (
        <div className="rounded-[24px] bg-stone-100/80 p-5 text-sm text-stone-600">
          Press <span className="font-semibold">Run Analysis</span> to run baseline Monte Carlo +
          Decision Engine and load recommendations.
        </div>
      ) : (
        <div className="space-y-4">
          <SummaryPanel report={report} baselinePath={baselinePath} />
          <RunChangeSummary previousReport={previousReport} currentReport={report} />
          <RecommendationsPanel
            recommendations={topRecommendations}
            topLowDisruption={topLowDisruption}
          />
          <RiskPanel
            biggestDownsideRisk={biggestDownsideRisk}
            noInheritanceRisk={noInheritanceRisk}
          />
          {report.recommendationUniverseNotes.length ? (
            <article className="rounded-[24px] bg-stone-100/80 p-5">
              <p className="text-sm font-medium text-stone-500">Recommendation Universe Notes</p>
              <ul className="mt-2 space-y-1 text-sm text-stone-700">
                {report.recommendationUniverseNotes.map((note) => (
                  <li key={note}>• {note}</li>
                ))}
              </ul>
            </article>
          ) : null}
          {explainabilityReport ? (
            <WhyThisPlanAtRiskPanel report={explainabilityReport} />
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function SummaryPanel({
  report,
  baselinePath,
}: {
  report: DecisionEngineReport;
  baselinePath: PathResult;
}) {
  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <p className="text-sm font-medium text-stone-500">Summary</p>
      <p className="mt-2 text-5xl font-semibold text-blue-800">
        {formatPercent(report.baseline.successRate)}
      </p>
      <p className="mt-1 text-sm text-stone-600">Baseline success rate</p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <MetricTile
          label="Median ending wealth"
          value={formatCurrency(report.baseline.medianEndingWealth)}
        />
        <MetricTile
          label="P10 ending wealth"
          value={formatCurrency(report.baseline.p10EndingWealth)}
        />
        <MetricTile
          label="Median failure year"
          value={baselinePath.medianFailureYear ? `${baselinePath.medianFailureYear}` : 'None'}
        />
      </div>
    </article>
  );
}

function RunChangeSummary({
  previousReport,
  currentReport,
}: {
  previousReport: DecisionEngineReport | null;
  currentReport: DecisionEngineReport;
}) {
  const delta = buildRunChangeSummary(previousReport, currentReport);
  if (!delta) {
    return (
      <article className="rounded-[24px] bg-stone-100/80 p-5">
        <p className="text-sm font-medium text-stone-500">What changed from last run?</p>
        <p className="mt-2 text-sm text-stone-600">
          No previous run yet. Run analysis again after changing inputs to see deltas.
        </p>
      </article>
    );
  }

  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <p className="text-sm font-medium text-stone-500">What changed from last run?</p>
      {(() => {
        const successDeltaPresentation = getDeltaPresentation(delta.successRateDelta, 'percent');
        const wealthDeltaPresentation = getDeltaPresentation(
          delta.medianEndingWealthDelta,
          'currency',
        );
        return (
          <div className="mt-2 space-y-2 text-sm text-stone-700">
            <p>
              Change from last run:{' '}
              <span className={`font-semibold ${successDeltaPresentation.className}`}>
                {successDeltaPresentation.label}
              </span>
            </p>
            <p>{delta.topRecommendationChange}</p>
            <p>{delta.biggestDriverChange}</p>
            <p>
              Median ending wealth change:{' '}
              <span className={`font-semibold ${wealthDeltaPresentation.className}`}>
                {wealthDeltaPresentation.label}
              </span>
            </p>
          </div>
        );
      })()}
    </article>
  );
}

function RecommendationsPanel({
  recommendations,
  topLowDisruption,
}: {
  recommendations: LeverScenarioResult[];
  topLowDisruption: LeverScenarioResult | null;
}) {
  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-stone-500">Recommendations</p>
        {topLowDisruption ? (
          <p className="text-sm text-blue-800">
            Best low-disruption: <span className="font-semibold">{topLowDisruption.name}</span>
          </p>
        ) : null}
      </div>
      {recommendations.length ? (
        <div className="space-y-3">
          {recommendations.map((scenario, index) => (
            <div
              key={scenario.scenarioId}
              className="rounded-2xl border border-stone-200 bg-white/80 p-4"
            >
              <p className="text-sm font-semibold text-stone-800">
                #{index + 1} {scenario.name}
              </p>
              <p className="mt-1 text-sm text-stone-600">{scenario.recommendationSummary}</p>
              <p className="mt-2 text-xs uppercase tracking-[0.16em] text-stone-500">
                Success delta {formatPercentPointDelta(scenario.delta.deltaSuccessRate)} • P10 delta{' '}
                {formatSignedCurrencyDelta(scenario.delta.deltaP10EndingWealth)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-stone-600">No positive recommendation candidates were found.</p>
      )}
    </article>
  );
}

function RiskPanel({
  biggestDownsideRisk,
  noInheritanceRisk,
}: {
  biggestDownsideRisk: LeverScenarioResult | null;
  noInheritanceRisk: LeverScenarioResult | null;
}) {
  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <p className="text-sm font-medium text-stone-500">Risks / sensitivities</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-stone-200 bg-white/80 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-stone-500">Biggest downside risk</p>
          {biggestDownsideRisk ? (
            <>
              <p className="mt-1 text-base font-semibold text-stone-900">{biggestDownsideRisk.name}</p>
              <p className="mt-1 text-sm text-stone-600">
                Success delta {formatPercentPointDelta(biggestDownsideRisk.delta.deltaSuccessRate)} •
                P10 delta {formatSignedCurrencyDelta(biggestDownsideRisk.delta.deltaP10EndingWealth)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-stone-600">No sensitivity results yet.</p>
          )}
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white/80 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-stone-500">No inheritance check</p>
          {noInheritanceRisk ? (
            <>
              <p className="mt-1 text-base font-semibold text-stone-900">{noInheritanceRisk.name}</p>
              <p className="mt-1 text-sm text-stone-600">
                Success delta {formatPercentPointDelta(noInheritanceRisk.delta.deltaSuccessRate)} •
                First-10-year failure delta{' '}
                {formatPercentPointDelta(noInheritanceRisk.delta.deltaFailFirst10Years)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-stone-600">No inheritance sensitivity not found.</p>
          )}
        </div>
      </div>
    </article>
  );
}

function WhyThisPlanAtRiskPanel({ report }: { report: ExplainabilityReport }) {
  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <p className="text-sm font-medium text-stone-500">Why This Plan Is at Risk</p>
      <h3 className="mt-2 text-xl font-semibold text-stone-900">{report.primaryIssueExplanation}</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-stone-200 bg-white/80 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-stone-500">Why failures happen</p>
          <ul className="mt-2 space-y-2 text-sm text-stone-700">
            {report.whyFailuresHappen.map((line) => (
              <li key={line}>• {line}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white/80 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-stone-500">When failures happen</p>
          <ul className="mt-2 space-y-2 text-sm text-stone-700">
            {report.whenFailuresHappen.map((line) => (
              <li key={line}>• {line}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-3 rounded-2xl border border-stone-200 bg-white/80 p-4 text-sm text-stone-700">
        <p>
          First 10-year failures: <span className="font-semibold">{formatPercent(report.failureProfile.percentFailFirst10Years)}</span> •
          Before Social Security: <span className="font-semibold">{formatPercent(report.failureProfile.percentFailBeforeSocialSecurity)}</span> •
          Before inheritance: <span className="font-semibold">{formatPercent(report.failureProfile.percentFailBeforeInheritance)}</span>
        </p>
      </div>
    </article>
  );
}

function ConstraintToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-stone-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function ExportScreen() {
  const data = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.draftAssumptions);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const latestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.latestUnifiedPlanEvaluationContext,
  );
  const [copied, setCopied] = useState(false);
  const [payload, setPayload] = useState<PlanningStateExport | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestCounterRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const currentEvaluationFingerprint = useMemo(
    () =>
      buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
      }),
    [assumptions, data, selectedResponses, selectedStressors],
  );
  const unifiedPlanContextIsFresh =
    latestUnifiedPlanEvaluationContext?.fingerprint === currentEvaluationFingerprint;

  const exportCacheKey = useMemo(
    () =>
      JSON.stringify({
        cacheVersion: PLANNING_EXPORT_CACHE_VERSION,
        fingerprint: currentEvaluationFingerprint,
        unifiedPlanContext: unifiedPlanContextIsFresh
          ? {
              fingerprint: latestUnifiedPlanEvaluationContext?.fingerprint ?? null,
              capturedAtIso: latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null,
            }
          : null,
      }),
    [
      currentEvaluationFingerprint,
      latestUnifiedPlanEvaluationContext,
      unifiedPlanContextIsFresh,
    ],
  );
  useEffect(() => {
    const cached = exportPayloadCache.get(exportCacheKey) ?? null;
    if (cached) {
      setPayload(cached);
      setLoadState('ready');
      setLoadError(null);
      return;
    }

    setLoadState('loading');
    setLoadError(null);

    const requestId = `${EXPORT_REQUEST_PREFIX}-${requestCounterRef.current++}`;
    activeRequestIdRef.current = requestId;

    const workerAvailable = typeof Worker !== 'undefined';
    if (!workerAvailable) {
      void (async () => {
        try {
          const next = await buildPlanningStateExportWithResolvedContext({
            data,
            assumptions,
            selectedStressorIds: selectedStressors,
            selectedResponseIds: selectedResponses,
            unifiedPlanEvaluation:
              unifiedPlanContextIsFresh
                ? latestUnifiedPlanEvaluationContext?.evaluation ?? null
                : null,
            unifiedPlanEvaluationCapturedAtIso:
              unifiedPlanContextIsFresh
                ? latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null
                : null,
          });
          exportPayloadCache.set(exportCacheKey, next);
          if (activeRequestIdRef.current === requestId) {
            setPayload(next);
            setLoadState('ready');
            setLoadError(null);
          }
        } catch (error) {
          if (activeRequestIdRef.current === requestId) {
            setLoadState('error');
            setLoadError(error instanceof Error ? error.message : 'Failed to generate export.');
          }
        }
      })();
      return;
    }

    const worker = new Worker(new URL('./planning-export.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<PlanningExportWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== activeRequestIdRef.current) {
        return;
      }
      if (message.type === 'error') {
        setLoadState('error');
        setLoadError(message.error);
        return;
      }
      exportPayloadCache.set(exportCacheKey, message.payload);
      setPayload(message.payload);
      setLoadState('ready');
      setLoadError(null);
    };

    const requestMessage: PlanningExportWorkerRequest = {
      type: 'run',
      payload: {
        requestId,
        data,
        assumptions,
        selectedStressorIds: selectedStressors,
        selectedResponseIds: selectedResponses,
        unifiedPlanEvaluation:
          unifiedPlanContextIsFresh
            ? latestUnifiedPlanEvaluationContext?.evaluation ?? null
            : null,
        unifiedPlanEvaluationCapturedAtIso:
          unifiedPlanContextIsFresh
            ? latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null
            : null,
      },
    };
    worker.postMessage(requestMessage);

    return () => {
      worker.terminate();
    };
  }, [
    assumptions,
    data,
    exportCacheKey,
    latestUnifiedPlanEvaluationContext,
    selectedResponses,
    selectedStressors,
    unifiedPlanContextIsFresh,
  ]);
  const payloadJson = useMemo(
    () => (payload ? JSON.stringify(payload, null, 2) : ''),
    [payload],
  );
  const probeStatusCounts = useMemo(() => {
    const counts = {
      modeled: 0,
      partial: 0,
      attention: 0,
      missing: 0,
    };
    payload?.probeChecklist.items.forEach((item) => {
      counts[item.status] += 1;
    });
    return counts;
  }, [payload?.probeChecklist.items]);

  const copyPayload = async () => {
    const text = payloadJson;
    if (!text) {
      return;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const element = document.createElement('textarea');
        element.value = text;
        element.setAttribute('readonly', 'true');
        element.style.position = 'absolute';
        element.style.left = '-9999px';
        document.body.appendChild(element);
        element.select();
        document.execCommand('copy');
        document.body.removeChild(element);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Panel
      title="Export"
      subtitle="Machine-readable snapshot of the current planning state for external AI/simulation runners."
    >
      <div className="rounded-[24px] bg-stone-100/85 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-stone-600">
              Current state export ({payload?.version.schema ?? 'pending'})
            </p>
            <p className="text-xs text-stone-500">
              Unified plan context: {payload?.flightPath.evaluationContext.available
                ? `included (${payload.flightPath.evaluationContext.capturedAtIso ?? 'timestamp unavailable'})`
                : latestUnifiedPlanEvaluationContext
                  ? 'stale versus current draft inputs (rerun Unified Plan to refresh summary metrics)'
                  : 'not available (run Unified Plan to include route-based recommendations)'}
            </p>
            <p className="text-xs text-stone-500">
              Probe checklist: {payload?.probeChecklist.items.length ?? 0} items · modeled {probeStatusCounts.modeled} · partial {probeStatusCounts.partial} · attention {probeStatusCounts.attention} · missing {probeStatusCounts.missing}
            </p>
            {loadState === 'loading' ? (
              <p className="text-xs text-blue-700">Generating export in background…</p>
            ) : null}
            {loadState === 'error' ? (
              <p className="text-xs text-red-700">Export failed: {loadError}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={copyPayload}
            disabled={!payload}
            className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {payload ? (
          <pre className="mt-3 max-h-[640px] overflow-auto rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-100">
            <code>{payloadJson}</code>
          </pre>
        ) : (
          <div className="mt-3 rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-200">
            Building export payload...
          </div>
        )}
      </div>
    </Panel>
  );
}

function AccordionSection({
  title,
  summary,
  isOpen,
  isCollapsible,
  disabled = false,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  isOpen: boolean;
  isCollapsible: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[24px] border border-stone-800 bg-stone-900/70">
      {isCollapsible ? (
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition ${
            disabled
              ? 'cursor-not-allowed text-stone-500'
              : 'hover:bg-stone-800/60'
          }`}
        >
          <div>
            <h3 className="text-lg font-semibold">{title}</h3>
            <p className="mt-1 text-xs text-stone-400">{summary}</p>
          </div>
          <span className="rounded-full bg-stone-800 px-2 py-1 text-xs font-semibold text-stone-300">
            {isOpen ? 'Hide' : 'Show'}
          </span>
        </button>
      ) : (
        <div className="px-4 py-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-stone-400">{summary}</p>
        </div>
      )}
      {isOpen ? <div className="space-y-3 px-4 pb-4 pt-1">{children}</div> : null}
    </section>
  );
}

function InfoPopover({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button || typeof window === 'undefined') {
        return;
      }

      const gutter = 8;
      const panelWidth = 288;
      const rect = button.getBoundingClientRect();
      const panelHeight = panelRef.current?.offsetHeight ?? 200;

      let left = rect.right - panelWidth;
      left = Math.max(gutter, Math.min(left, window.innerWidth - panelWidth - gutter));

      let top = rect.bottom + gutter;
      if (top + panelHeight > window.innerHeight - gutter) {
        top = Math.max(gutter, rect.top - panelHeight - gutter);
      }

      setPosition({ top, left });
    };

    updatePosition();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const outsideButton =
        containerRef.current && target && !containerRef.current.contains(target);
      const outsidePanel = panelRef.current && target && !panelRef.current.contains(target);
      if (outsideButton && outsidePanel) {
        setIsOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      setPosition({ top: 0, left: 0 });
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !panelRef.current || typeof window === 'undefined') {
      return;
    }

    const button = buttonRef.current;
    if (!button) {
      return;
    }

    const gutter = 8;
    const panelWidth = 288;
    const rect = button.getBoundingClientRect();
    const panelHeight = panelRef.current.offsetHeight;

    let left = rect.right - panelWidth;
    left = Math.max(gutter, Math.min(left, window.innerWidth - panelWidth - gutter));

    let top = rect.bottom + gutter;
    if (top + panelHeight > window.innerHeight - gutter) {
      top = Math.max(gutter, rect.top - panelHeight - gutter);
    }

    setPosition({ top, left });
  }, [isOpen, body]);

  const popover =
    isOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={panelRef}
            style={{ top: `${position.top}px`, left: `${position.left}px` }}
            className="fixed z-[9999] w-72 rounded-xl border border-stone-700 bg-stone-950 p-3 text-xs leading-5 text-stone-200 opacity-100 shadow-2xl shadow-black/70 ring-1 ring-black/50"
          >
            <p className="font-semibold text-stone-100">{title}</p>
            <div className="mt-1 text-stone-300">{body}</div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={containerRef} className={`relative inline-flex items-center ${isOpen ? 'z-[999]' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((previous) => !previous);
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-stone-500/60 bg-stone-900 text-[11px] font-semibold text-stone-300 transition hover:border-stone-300 hover:text-stone-100 focus:outline-none focus:ring-2 focus:ring-blue-400/70"
        aria-label={`What does ${title} mean?`}
        aria-expanded={isOpen}
      >
        i
      </button>
      {popover}
    </div>
  );
}

function ToggleChip({
  active,
  label,
  helpText,
  disabled = false,
  onClick,
}: {
  active: boolean;
  label: string;
  helpText?: SelectorHelpText;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="relative overflow-visible">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`w-full rounded-2xl py-3 pl-4 pr-12 text-left text-sm transition ${
          active
            ? 'bg-blue-400 text-slate-950'
            : disabled
              ? 'cursor-not-allowed bg-stone-900 text-stone-500'
              : 'bg-stone-900 text-stone-300 hover:bg-stone-800'
        }`}
      >
        {label}
      </button>
      {helpText ? (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <InfoPopover
            title={helpText.label}
            body={
              <>
                <p>{helpText.whatChanges}</p>
                <p className="mt-1">{helpText.whenApplies}</p>
                <p className="mt-1 text-stone-400">Type: {helpText.category}</p>
              </>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function SolverNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="block">
      <p className="mb-2 text-sm text-stone-700">{label}</p>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) {
            onChange(next);
          }
        }}
        className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-blue-500"
      />
    </label>
  );
}

function SolverOptionalField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <p className="mb-2 text-sm text-stone-700">{label}</p>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-blue-500"
      />
    </label>
  );
}

function RangeControl({
  label,
  min,
  max,
  step,
  value,
  valueDisplay,
  disabled = false,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueDisplay?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between text-sm text-stone-300">
        <span>{label}</span>
        <span>{valueDisplay ?? value.toFixed(3)}</span>
      </div>
      <input
        className="range-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function NumberInputControl({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between text-sm text-stone-300">
        <span>{label}</span>
        <span>{Math.round(value).toLocaleString()}</span>
      </div>
      <input
        className={`w-full rounded-xl border px-3 py-2 text-sm outline-none transition ${
          disabled
            ? 'cursor-not-allowed border-stone-800 bg-stone-900 text-stone-500'
            : 'border-stone-700 bg-stone-900 text-stone-100 focus:border-blue-400'
        }`}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) {
            onChange(next);
          }
        }}
      />
    </label>
  );
}

function DateInputControl({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between text-sm text-stone-300">
        <span>{label}</span>
        <span>{formatDate(value)}</span>
      </div>
      <input
        className={`w-full rounded-xl border px-3 py-2 text-sm outline-none transition ${
          disabled
            ? 'cursor-not-allowed border-stone-800 bg-stone-900 text-stone-500'
            : 'border-stone-700 bg-stone-900 text-stone-100 focus:border-blue-400'
        }`}
        type="date"
        value={toDateInputValue(value)}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value) {
            onChange(fromDateInputValue(event.target.value));
          }
        }}
      />
    </label>
  );
}

function toDateInputValue(value: string) {
  return value.slice(0, 10);
}

function fromDateInputValue(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function formatPersonLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatWindfallLabel(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatBucketName(value: string) {
  if (value === 'hsa') {
    return 'HSA';
  }

  return value.replaceAll('_', ' ');
}

function formatConstraintLabel(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDiagnosticWarningLabel(value: string) {
  return value
    .replaceAll('_detected', '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatFundingSourceLabel(value: string) {
  if (value === 'ira_401k') {
    return 'IRA/401k';
  }
  return formatConstraintLabel(value);
}

function formatPercentPointDelta(value: number) {
  const points = value * 100;
  const sign = points > 0 ? '+' : '';
  return `${sign}${points.toFixed(1)} pts`;
}

function formatAbsolutePercentDelta(value: number) {
  return `${(Math.abs(value) * 100).toFixed(1)}%`;
}

function formatSignedCurrencyDelta(value: number) {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${formatCurrency(rounded)}`;
}

function formatAbsoluteCurrencyDelta(value: number) {
  return formatCurrency(Math.round(Math.abs(value)));
}

function getDeltaPresentation(
  value: number,
  kind: 'percent' | 'currency',
): { label: string; className: string } {
  if (kind === 'percent' && Math.abs(value) < 0.005) {
    return {
      label: 'No meaningful change',
      className: 'text-stone-600',
    };
  }

  if (value > 0) {
    return {
      label: `↑ ${kind === 'percent' ? formatAbsolutePercentDelta(value) : formatAbsoluteCurrencyDelta(value)}`,
      className: 'text-emerald-700',
    };
  }
  if (value < 0) {
    return {
      label: `↓ ${kind === 'percent' ? formatAbsolutePercentDelta(value) : formatAbsoluteCurrencyDelta(value)}`,
      className: 'text-red-700',
    };
  }
  return {
    label: kind === 'percent' ? 'No meaningful change' : formatSignedCurrencyDelta(value),
    className: 'text-stone-600',
  };
}

function cloneDecisionEngineReport(report: DecisionEngineReport): DecisionEngineReport {
  return structuredClone(report) as DecisionEngineReport;
}

function formatDriverLabel(
  driver: DecisionEngineReport['biggestDriver'],
) {
  if (!driver) {
    return 'none';
  }
  return driver.scenarioName;
}

function buildRunChangeSummary(
  previousReport: DecisionEngineReport | null,
  currentReport: DecisionEngineReport,
) {
  if (!previousReport) {
    return null;
  }

  const successRateDelta =
    currentReport.baseline.successRate - previousReport.baseline.successRate;
  const medianEndingWealthDelta =
    currentReport.baseline.medianEndingWealth - previousReport.baseline.medianEndingWealth;

  const previousTopRecommendation = previousReport.rankedRecommendations[0]?.name ?? null;
  const currentTopRecommendation = currentReport.rankedRecommendations[0]?.name ?? null;
  let topRecommendationChange = 'Top recommendation unchanged.';
  if (previousTopRecommendation !== currentTopRecommendation) {
    if (previousTopRecommendation && currentTopRecommendation) {
      topRecommendationChange = `Top recommendation changed from ${previousTopRecommendation} to ${currentTopRecommendation}.`;
    } else if (!previousTopRecommendation && currentTopRecommendation) {
      topRecommendationChange = `Top recommendation is now ${currentTopRecommendation}.`;
    } else if (previousTopRecommendation && !currentTopRecommendation) {
      topRecommendationChange = `Top recommendation is now unavailable (previously ${previousTopRecommendation}).`;
    }
  }

  const previousDriver = previousReport.biggestDriver ?? null;
  const currentDriver = currentReport.biggestDriver ?? null;
  let biggestDriverChange = 'Biggest driver unchanged.';
  if (formatDriverLabel(previousDriver) !== formatDriverLabel(currentDriver)) {
    biggestDriverChange = `Biggest driver changed from ${formatDriverLabel(previousDriver)} to ${formatDriverLabel(currentDriver)}.`;
  }

  return {
    successRateDelta,
    medianEndingWealthDelta,
    topRecommendationChange,
    biggestDriverChange,
  };
}

function buildRecommendationConstraintsFromToggles(input: {
  disallowRetirementDelay: boolean;
  disallowHomeSaleChanges: boolean;
  disallowEssentialCuts: boolean;
  disallowAllocationChanges: boolean;
  disallowInheritanceReliance: boolean;
}): RecommendationConstraints | undefined {
  const hasActiveConstraint = Object.values(input).some(Boolean);
  if (!hasActiveConstraint) {
    return undefined;
  }

  return {
    rules: {
      allowRetirementDelay: !input.disallowRetirementDelay,
      allowHomeSaleChanges: !input.disallowHomeSaleChanges,
      allowEarlierHomeSale: !input.disallowHomeSaleChanges,
      allowLaterHomeSale: !input.disallowHomeSaleChanges,
      allowEssentialSpendingCuts: !input.disallowEssentialCuts,
      allowAllocationChanges: !input.disallowAllocationChanges,
      allowInheritanceReliance: !input.disallowInheritanceReliance,
    },
  };
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampRate(value: number) {
  return Math.max(0, Math.min(1, value));
}

const INTERACTIVE_SOLVER_MAX_RUNS = 600;
const INTERACTIVE_DECISION_ENGINE_MAX_RUNS = 800;
const INTERACTIVE_SCENARIO_COMPARE_MAX_RUNS = 400;

function getInteractiveSolverAssumptions(assumptions: MarketAssumptions): MarketAssumptions {
  if (assumptions.simulationRuns <= INTERACTIVE_SOLVER_MAX_RUNS) {
    return assumptions;
  }

  return {
    ...assumptions,
    simulationRuns: INTERACTIVE_SOLVER_MAX_RUNS,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-solver`
      : 'solver',
  };
}

function getInteractiveDecisionAssumptions(
  assumptions: MarketAssumptions,
): MarketAssumptions {
  if (assumptions.simulationRuns <= INTERACTIVE_DECISION_ENGINE_MAX_RUNS) {
    return assumptions;
  }

  return {
    ...assumptions,
    simulationRuns: INTERACTIVE_DECISION_ENGINE_MAX_RUNS,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-decision`
      : 'decision',
  };
}

function getInteractiveScenarioCompareRuns(assumptions: MarketAssumptions) {
  return Math.min(assumptions.simulationRuns, INTERACTIVE_SCENARIO_COMPARE_MAX_RUNS);
}

function getInteractiveScenarioCompareAssumptions(
  assumptions: MarketAssumptions,
): MarketAssumptions {
  const runs = getInteractiveScenarioCompareRuns(assumptions);
  if (runs === assumptions.simulationRuns) {
    return assumptions;
  }
  return {
    ...assumptions,
    simulationRuns: runs,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-compare`
      : 'compare',
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
