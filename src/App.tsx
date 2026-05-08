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
import { SocialSecurityScreen } from './screens/SocialSecurityScreen';
import { SpendingScreen } from './screens/SpendingScreen';

const Plan20Screen = lazy(() =>
  import('./Plan20Screen').then((m) => ({ default: m.Plan20Screen })),
);

const CockpitScreen = lazy(() =>
  import('./CockpitScreen').then((m) => ({ default: m.CockpitScreen })),
);

const MiningScreen = lazy(() =>
  import('./MiningScreen').then((m) => ({ default: m.MiningScreen })),
);

const HistoryScreen = lazy(() =>
  import('./HistoryScreen').then((m) => ({ default: m.HistoryScreen })),
);

const ExploreScreen = lazy(() =>
  import('./ExploreScreen').then((m) => ({ default: m.ExploreScreen })),
);

const ExportScreen = lazy(() =>
  import('./ExportScreen').then((m) => ({ default: m.ExportScreen })),
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
  SolvedSpendProfile,
} from './simulation-worker-types';
import type {
  SuggestionBaselineOutcome,
  SuggestionOutcome,
  SuggestionRankerWorkerRequest,
  SuggestionRankerWorkerResponse,
} from './suggestion-ranker-worker-types';
import type {
  PlanAnalysisWorkerRequest,
  PlanAnalysisWorkerResponse,
} from './plan-analysis-worker-types';
import type {
  DecisionEngineWorkerRequest,
  DecisionEngineWorkerResponse,
} from './decision-engine-worker-types';
import type { Plan } from './plan-evaluation';
import { approximateBequestAttainmentRate } from './plan-evaluation';
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
import { solveSpendByReverseTimeline, type SpendSolverResult } from './spend-solver';
import { useAppStore } from './store';
import {
  SANDBOX_STRESSORS,
  buildSandboxEngineRun,
  estimateScenarioImpact,
  getReactionDef,
  getStressorDef,
  type SandboxReactionId,
  type SandboxStressorId,
  type ScenarioImpact,
  type ScenarioReactionSelection,
} from './sandbox-scenarios';
import { rollupHoldingsToAssetClasses } from './asset-class-mapper';
import { usePlanningExportPayload } from './usePlanningExportPayload';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import {
  loadScenarioCompareFromCache,
  saveScenarioCompareToCache,
} from './scenario-compare-cache';
import { loadSimulationResultFromCache, saveSimulationResultToCache } from './simulation-result-cache';
import type {
  GuardrailTier,
  AccountsData,
  MarketAssumptions,
  Holding,
  PathResult,
  PathYearResult,
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

/**
 * Top-level "rooms" — the household-facing reframe.
 *
 *   ADVISOR   the monthly check-in. Spend headline, flight path, "easy to miss".
 *             No knobs. Default landing.
 *   SANDBOX   "what if X happens, and I react Y" — the existing stressor +
 *             response sim, surfaced as its own room.
 *   INSPECTOR everything we built before — current tabbed UI lives here
 *             unchanged. Keeps debugging / curiosity surface available.
 *
 * PR-1 scope is just the navigation shell + stubs. The existing per-screen
 * sidebar (the `navigation` array below) continues to work inside Inspector;
 * Advisor and Sandbox get filled in by PR-2 / PR-3.
 */
type Room = 'advisor' | 'sandbox' | 'cockpit' | 'inspector' | 'export';
const ROOMS: { id: Room; label: string }[] = [
  { id: 'cockpit', label: 'Cockpit' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'inspector', label: 'Inspector' },
  { id: 'export', label: 'Export' },
];

type NavSection = 'today' | 'analyze' | 'configure';

const navigation: {
  id: ScreenId;
  label: string;
  shortLabel: string;
  section: NavSection;
  /** Inline SVG path for the leading icon. Heroicons "outline" style,
   *  20×20 grid, stroke-width 1.5 — matches the Apple-y restraint. */
  iconPath: string;
}[] = [
  {
    id: 'cockpit',
    label: 'Cockpit',
    shortLabel: 'Cockpit',
    section: 'today',
    // Compass / target — "where am I right now"
    iconPath:
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-3.75a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5Zm0-3a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z',
  },
  {
    id: 'mining',
    label: 'Re-run Model',
    shortLabel: 'Mining',
    section: 'analyze',
    // Lightning bolt — "compute / generate"
    iconPath: 'M13 2 4.09 12.97a.5.5 0 0 0 .39.81H11l-1 8.22 8.91-10.97a.5.5 0 0 0-.39-.81H13l0-7.22Z',
  },
  {
    id: 'history',
    label: 'History',
    shortLabel: 'History',
    section: 'analyze',
    // Clock — "over time"
    iconPath:
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2.25',
  },
  {
    id: 'accounts',
    label: 'Accounts',
    shortLabel: 'Accounts',
    section: 'configure',
    // Briefcase / wallet
    iconPath:
      'M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Zm5-3A2.5 2.5 0 0 1 10.5 2h3A2.5 2.5 0 0 1 16 4.5V5h-2v-.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5V5H8v-.5Z',
  },
  {
    id: 'social_security',
    label: 'Social Security',
    shortLabel: 'SS',
    section: 'configure',
    // Shield
    iconPath:
      'M12 2 4 5v6c0 4.97 3.42 9.59 8 11 4.58-1.41 8-6.03 8-11V5l-8-3Z',
  },
  {
    id: 'income',
    label: 'Income',
    shortLabel: 'Income',
    section: 'configure',
    // Sparkle/cash event — income timing and one-off inflows.
    iconPath:
      'M12 3v3m0 12v3m7.5-10.5h-3m-9 0h-3m12.3-5.3-2.1 2.1m-7.4 7.4-2.1 2.1m0-11.6 2.1 2.1m7.4 7.4 2.1 2.1M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z',
  },
  {
    id: 'taxes',
    label: 'Taxes',
    shortLabel: 'Taxes',
    section: 'configure',
    // Document with lines
    iconPath:
      'M6 2.25A2.25 2.25 0 0 0 3.75 4.5v15A2.25 2.25 0 0 0 6 21.75h12a2.25 2.25 0 0 0 2.25-2.25V8.25L14.25 2.25H6Zm7.5 0V8.25h6.75M7.5 12h9M7.5 16h9',
  },
  {
    id: 'export',
    label: 'Export',
    shortLabel: 'Export',
    section: 'configure',
    // Arrow up out of tray
    iconPath:
      'M3.75 19.5h16.5M12 4.5v11.25m0 0-4.5-4.5m4.5 4.5 4.5-4.5',
  },
];

const NAV_SECTION_LABELS: Record<NavSection, string> = {
  today: 'Today',
  analyze: 'Analyze',
  configure: 'Configure',
};

const chartPalette = ['#2563eb', '#0891b2', '#1d4ed8', '#0369a1'];
const SIMULATION_REQUEST_PREFIX = 'simulation-request';

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
    safeRoomExecutedYearCount: 0,
    strategicExtraExecutedYearCount: 0,
    annualPolicyMaxBindingYearCount: 0,
    totalSafeRoomUsed: 0,
    totalStrategicExtraUsed: 0,
    totalSafeRoomUnusedDueToAnnualPolicyMax: 0,
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
      oscillation_detected: 0,
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
    maxAnnualDollars: null,
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
  solvedSpendProfile?: SolvedSpendProfile | null;
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
  stressorKnobs: {
    delayedInheritanceYears: number;
    cutSpendingPercent?: number;
    layoffRetireDate?: string;
    layoffSeverance?: number;
  };
  fingerprint: string;
}

function buildDataFingerprint(data: SeedData, assumptions: MarketAssumptions) {
  return JSON.stringify({ data, assumptions });
}

function buildToggleFingerprint(
  selectedStressors: string[],
  selectedResponses: string[],
) {
  // Sort copies so insertion order doesn't change the fingerprint, then join
  // with separators that can't appear in our ids.
  return `${[...selectedStressors].sort().join(',')}|${[...selectedResponses]
    .sort()
    .join(',')}`;
}

function buildSimulationInputFingerprint(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  return `${buildDataFingerprint(input.data, input.assumptions)}::${buildToggleFingerprint(
    input.selectedStressors,
    input.selectedResponses,
  )}`;
}

export function App() {
  const simulationDraft = useAppStore((state) => state.data);
  const simulationDraftAssumptions = useAppStore((state) => state.draftAssumptions);
  const simulationDraftSelectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const simulationDraftSelectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const simulationDraftStressorKnobs = useAppStore((state) => state.draftStressorKnobs);
  const currentPlan = useAppStore((state) => state.appliedData);
  const currentPlanAssumptions = useAppStore((state) => state.appliedAssumptions);
  const currentPlanSelectedResponses = useAppStore((state) => state.appliedSelectedResponses);
  const currentPlanSelectedStressors = useAppStore((state) => state.appliedSelectedStressors);
  const currentPlanStressorKnobs = useAppStore((state) => state.appliedStressorKnobs);
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

  // Redirect any screen that's no longer in the sidebar back to Cockpit.
  // Keeps stale persisted store state (e.g. someone with currentScreen
  // === 'overview' from before the navigation cleanup) from landing on
  // an unreachable screen.
  const REACHABLE_SCREENS: ScreenId[] = [
    'cockpit',
    'mining',
    'history',
    'accounts',
    'social_security',
    'income',
    'taxes',
    'export',
  ];
  useEffect(() => {
    if (!REACHABLE_SCREENS.includes(currentScreen)) {
      setCurrentScreen('cockpit');
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
  const suggestionRankerWorkerRef = useRef<Worker | null>(null);
  const suggestionRankerRequestIdRef = useRef<string | null>(null);

  // Top-level room. Local state for PR-1 — promote into the Zustand store later
  // if we want it to persist across reloads. Default to Advisor: the household
  // should land in the "monthly check-in" view, not the engine-internals tab list.
  const [room, setRoom] = useState<Room>('cockpit');
  /**
   * Deep-link handoff: Advisor's Easy-to-miss cards push a scenario in here
   * before flipping the room to 'sandbox'. SandboxRoom consumes it on mount
   * and clears the slot so it doesn't re-apply on refresh.
   */
  const [pendingSandboxScenario, setPendingSandboxScenario] =
    useState<SandboxInitialScenario | null>(null);

  const [currentPlanResult, setCurrentPlanResult] = useState<SimulationResultState | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResultState | null>(null);
  const [simCacheCheckPending, setSimCacheCheckPending] = useState(true);
  const [planResultFromCache, setPlanResultFromCache] = useState(false);

  const [planResultStatus, setPlanResultStatus] = useState<SimulationStatus>('stale');
  const [simulationStatus, setSimulationStatus] = useState<SimulationStatus>('stale');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [planResultError, setPlanResultError] = useState<string | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [showTradeList, setShowTradeList] = useState(false);

  const isSimulationRunning = simulationStatus === 'running';

  // Split the expensive data/assumptions stringify from the cheap toggle hash
  // so toggling a stressor/response checkbox doesn't re-serialize the entire
  // SeedData graph on every click.
  const planDataFingerprint = useMemo(
    () => buildDataFingerprint(currentPlan, currentPlanAssumptions),
    [currentPlan, currentPlanAssumptions],
  );
  const planInputFingerprint = useMemo(
    () =>
      `${planDataFingerprint}::${buildToggleFingerprint(
        currentPlanSelectedStressors,
        currentPlanSelectedResponses,
      )}|di=${currentPlanStressorKnobs.delayedInheritanceYears};cs=${currentPlanStressorKnobs.cutSpendingPercent};lo=${currentPlanStressorKnobs.layoffRetireDate};ls=${currentPlanStressorKnobs.layoffSeverance}`,
    [
      planDataFingerprint,
      currentPlanSelectedResponses,
      currentPlanSelectedStressors,
      currentPlanStressorKnobs,
    ],
  );

  const simulationDataFingerprint = useMemo(
    () => buildDataFingerprint(simulationDraft, simulationDraftAssumptions),
    [simulationDraft, simulationDraftAssumptions],
  );
  const simulationInputFingerprint = useMemo(
    () =>
      `${simulationDataFingerprint}::${buildToggleFingerprint(
        simulationDraftSelectedStressors,
        simulationDraftSelectedResponses,
      )}|di=${simulationDraftStressorKnobs.delayedInheritanceYears};cs=${simulationDraftStressorKnobs.cutSpendingPercent};lo=${simulationDraftStressorKnobs.layoffRetireDate};ls=${simulationDraftStressorKnobs.layoffSeverance}`,
    [
      simulationDataFingerprint,
      simulationDraftSelectedResponses,
      simulationDraftSelectedStressors,
      simulationDraftStressorKnobs,
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
            solvedSpendProfile: message.solvedSpendProfile ?? null,
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
            solvedSpendProfile: message.solvedSpendProfile ?? null,
          });
          setPlanResultFromCache(false);
          if (completedInputFingerprint) {
            lastPlanRunInputsRef.current = completedInputFingerprint;
            void saveSimulationResultToCache(
              completedInputFingerprint,
              message.pathResults,
              message.parityReport,
              message.solvedSpendProfile ?? null,
            );
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
    worker.onerror = (event) => {
      const activeRequestId = activeRequestIdRef.current;
      const activeMeta = activeRequestMetaRef.current;
      if (!activeRequestId || !activeMeta) return;
      const message = event.message || 'Simulation worker failed';
      stopTrackedAnalysis(activeRequestId, 'error', { error: message });
      activeRequestIdRef.current = null;
      activeRequestMetaRef.current = null;
      if (activeMeta.target === 'simulation') {
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
      setAnalysisProgress(0);
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
            stressorKnobs: simulationDraftStressorKnobs,
            fingerprint: simulationInputFingerprint,
          }
        : {
            data: currentPlan,
            assumptions: currentPlanAssumptions,
            selectedStressors: currentPlanSelectedStressors,
            selectedResponses: currentPlanSelectedResponses,
            stressorKnobs: currentPlanStressorKnobs,
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
          { stressorKnobs: analysisInput.stressorKnobs },
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
              stressorKnobs: analysisInput.stressorKnobs,
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
        stressorKnobs: analysisInput.stressorKnobs,
        solvedSpendMode: target === 'plan' ? 'skip' : 'fast',
      },
    };
    worker.postMessage(runMessage);
  }, [
    currentPlan,
    currentPlanAssumptions,
    currentPlanSelectedResponses,
    currentPlanSelectedStressors,
    currentPlanStressorKnobs,
    planInputFingerprint,
    simulationDraft,
    simulationDraftAssumptions,
    simulationDraftSelectedResponses,
    simulationDraftSelectedStressors,
    simulationDraftStressorKnobs,
    simulationInputFingerprint,
    stopTrackedAnalysis,
  ]);

  const commitSimulationToPlan = useCallback(() => {
    const nextPlanInput: AnalysisInput = {
      data: simulationDraft,
      assumptions: simulationDraftAssumptions,
      selectedStressors: simulationDraftSelectedStressors,
      selectedResponses: simulationDraftSelectedResponses,
      stressorKnobs: simulationDraftStressorKnobs,
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
    simulationDraftStressorKnobs,
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
    if (currentScreen !== 'overview' && currentScreen !== 'insights') {
      return;
    }
    perfLog('simulation', 'effect-triggered initial plan analysis');
    runAnalysis('plan');
  }, [runAnalysis, currentPlanResult, currentScreen, simCacheCheckPending]);

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

    // IMPORTANT: don't terminate the worker on every deps change (checkbox toggles
    // re-fire this effect). The worker's own onmessage handler already terminates
    // on result/error/cancel. A dedicated unmount-only cleanup below handles the
    // page-unmount case. Killing and respawning on every toggle causes visible
    // main-thread lag on checkbox clicks.
  }, [
    latestUnifiedPlanEvaluationContext,
    planResultStatus,
    simulationDraft,
    simulationDraftAssumptions,
    simulationDraftSelectedStressors,
    simulationDraftSelectedResponses,
    setLatestUnifiedPlanEvaluationContext,
  ]);

  // Unmount-only cleanup for the background Plan-2.0 eval worker.
  useEffect(
    () => () => {
      bgEvalWorkerRef.current?.terminate();
      bgEvalWorkerRef.current = null;
    },
    [],
  );

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

  // --- Suggestion ranking (Find my best solution) -----------------------------
  const [suggestionRankingStatus, setSuggestionRankingStatus] = useState<
    'idle' | 'running' | 'ready' | 'error'
  >('idle');
  const [suggestionRankingProgress, setSuggestionRankingProgress] = useState<{
    completed: number;
    total: number;
  }>({ completed: 0, total: 0 });
  const [suggestionRankingError, setSuggestionRankingError] = useState<string | null>(
    null,
  );
  const [suggestionRankingResults, setSuggestionRankingResults] = useState<{
    baseline: SuggestionBaselineOutcome;
    candidates: SuggestionOutcome[];
    stressorIds: string[];
    fixedResponseIds: string[];
  } | null>(null);

  const runSuggestionRanking = useCallback(() => {
    // Candidates = every response not already in the user's picked set.
    const fixedResponses = simulationDraftSelectedResponses;
    const candidates = simulationDraft.responses
      .map((r) => r.id)
      .filter((id) => !fixedResponses.includes(id));

    if (candidates.length === 0) {
      setSuggestionRankingStatus('ready');
      setSuggestionRankingResults(null);
      setSuggestionRankingError(
        'Every solution is already ticked — untick one to compare alternatives.',
      );
      return;
    }

    if (!suggestionRankerWorkerRef.current) {
      suggestionRankerWorkerRef.current = new Worker(
        new URL('./suggestion-ranker.worker.ts', import.meta.url),
        { type: 'module' },
      );
    }
    const worker = suggestionRankerWorkerRef.current;
    const requestId = `suggest-${Date.now()}-${requestCounterRef.current++}`;

    // Cancel any in-flight ranking.
    if (suggestionRankerRequestIdRef.current) {
      worker.postMessage({
        type: 'cancel',
        requestId: suggestionRankerRequestIdRef.current,
      } as SuggestionRankerWorkerRequest);
    }
    suggestionRankerRequestIdRef.current = requestId;
    setSuggestionRankingStatus('running');
    setSuggestionRankingProgress({ completed: 0, total: candidates.length });
    setSuggestionRankingError(null);

    const fixedResponseIdsSnapshot = [...fixedResponses];
    const stressorIdsSnapshot = [...simulationDraftSelectedStressors];

    worker.onmessage = (event: MessageEvent<SuggestionRankerWorkerResponse>) => {
      const msg = event.data;
      if (msg.requestId !== requestId) return;

      if (msg.type === 'progress') {
        setSuggestionRankingProgress({ completed: msg.completed, total: msg.total });
        return;
      }
      if (msg.type === 'result') {
        suggestionRankerRequestIdRef.current = null;
        setSuggestionRankingResults({
          baseline: msg.baseline,
          candidates: msg.candidates,
          stressorIds: stressorIdsSnapshot,
          fixedResponseIds: fixedResponseIdsSnapshot,
        });
        setSuggestionRankingStatus('ready');
        return;
      }
      if (msg.type === 'error') {
        suggestionRankerRequestIdRef.current = null;
        setSuggestionRankingError(msg.error);
        setSuggestionRankingStatus('error');
        return;
      }
      if (msg.type === 'cancelled') {
        suggestionRankerRequestIdRef.current = null;
        setSuggestionRankingStatus('idle');
      }
    };

    const request: SuggestionRankerWorkerRequest = {
      type: 'run',
      payload: {
        requestId,
        data: simulationDraft,
        assumptions: simulationDraftAssumptions,
        selectedStressors: simulationDraftSelectedStressors,
        fixedResponses: fixedResponseIdsSnapshot,
        candidates: candidates.map((responseId) => ({ responseId })),
      },
    };
    worker.postMessage(request);
  }, [
    simulationDraft,
    simulationDraftAssumptions,
    simulationDraftSelectedResponses,
    simulationDraftSelectedStressors,
  ]);

  const cancelSuggestionRanking = useCallback(() => {
    const worker = suggestionRankerWorkerRef.current;
    const requestId = suggestionRankerRequestIdRef.current;
    if (!worker || !requestId) return;
    worker.postMessage({
      type: 'cancel',
      requestId,
    } as SuggestionRankerWorkerRequest);
    suggestionRankerRequestIdRef.current = null;
    setSuggestionRankingStatus('idle');
  }, []);

  const applySuggestion = useAppStore((state) => state.toggleResponse);

  // Tear down the suggestion ranker worker on unmount.
  useEffect(() => {
    return () => {
      suggestionRankerWorkerRef.current?.terminate();
      suggestionRankerWorkerRef.current = null;
    };
  }, []);
  // --------------------------------------------------------------------------

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
    <div className="min-h-screen bg-[#F7F5F2] text-stone-900">
      {/* Single unified layout: left sidebar with Cockpit + Accounts +
          Social Security + Taxes + Export. The room-pill nav and
          AdvisorRoom / SandboxRoom shells are intentionally not
          rendered here — code remains in this file for reference but
          is unreachable. Cleanup pass to delete unused components is
          a separate task. */}
      <div className="mx-auto flex min-h-screen max-w-[1700px] flex-col lg:flex-row">
        <aside className="bg-transparent px-4 py-6 lg:min-h-screen lg:w-[210px] lg:shrink-0">
          <div className="mb-8 flex items-center justify-between lg:block">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0066CC]">
                Welcome to Flight Path
              </p>
              <h1 className="mt-3 max-w-[14ch] text-3xl font-semibold leading-tight tracking-tight text-stone-900">
                Compare futures, not just scenarios.
              </h1>
            </div>
          </div>

          <nav className="hidden lg:block">
            {(['today', 'analyze', 'configure'] as NavSection[]).map(
              (section) => {
                const items = navigation.filter((n) => n.section === section);
                if (items.length === 0) return null;
                return (
                  <div key={section} className="mb-5">
                    <p className="mb-1.5 px-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
                      {NAV_SECTION_LABELS[section]}
                    </p>
                    <div className="space-y-0.5">
                      {items.map((item) => {
                        const active = currentScreen === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setCurrentScreen(item.id)}
                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-base transition ${
                              active
                                ? 'bg-[#0071E3]/10 font-semibold text-[#0066CC]'
                                : 'font-medium text-stone-600 hover:bg-stone-100/80 hover:text-stone-900'
                            }`}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className={`h-5 w-5 shrink-0 ${
                                active ? 'text-[#0066CC]' : 'text-stone-400'
                              }`}
                            >
                              <path d={item.iconPath} />
                            </svg>
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              },
            )}
          </nav>

        </aside>

        <main className="flex-1 min-w-0 px-4 py-4 sm:px-6 lg:px-8 lg:flex lg:max-h-screen lg:flex-col lg:overflow-hidden">
          <div className="mb-4 overflow-x-auto lg:hidden">
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
                  description={`Current assets divided by current lifestyle spending input. Planning horizon is ${horizonYears} years.`}
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
              {currentScreen === 'cockpit' && (
                <Suspense fallback={<LazyScreenFallback label="Loading Cockpit…" />}>
                  <CockpitScreen />
                </Suspense>
              )}
              {currentScreen === 'mining' && (
                <Suspense fallback={<LazyScreenFallback label="Loading Mining…" />}>
                  <MiningScreen />
                </Suspense>
              )}
              {currentScreen === 'history' && (
                <Suspense fallback={<LazyScreenFallback label="Loading History…" />}>
                  <HistoryScreen />
                </Suspense>
              )}
              {currentScreen === 'export' && (
                <Suspense fallback={<LazyScreenFallback label="Loading Export…" />}>
                  <ExportScreen />
                </Suspense>
              )}
              {currentScreen === 'overview' && (
                <>
                  <PlanReadingCard
                    data={currentPlan}
                    assumptions={currentPlanAssumptions}
                    solvedSpendProfile={currentPlanResult?.solvedSpendProfile ?? null}
                    onJumpToSandbox={() => setCurrentScreen('simulation')}
                  />
                  <UnifiedPlanScreen
                    data={currentPlan}
                    assumptions={currentPlanAssumptions}
                    simulationStatus={planResultStatus}
                    selectedStressors={currentPlanSelectedStressors}
                    selectedResponses={currentPlanSelectedResponses}
                    pathResults={displayedPlanPathResults}
                    showPlanControls
                  />
                </>
              )}
              {currentScreen === 'plan2' && (
                <Suspense fallback={<LazyScreenFallback label="Loading Plan 2.0…" />}>
                  <Plan20Screen />
                </Suspense>
              )}
              {currentScreen === 'explore' && (
                <Suspense fallback={<LazyScreenFallback label="Loading Explore…" />}>
                  <ExploreScreen />
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
              {currentScreen === 'social_security' && <SocialSecurityScreen />}
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
                  baselinePath={planPrimaryPath}
                  solvedSpendProfile={simulationResult?.solvedSpendProfile ?? null}
                  baselineSolvedSpendProfile={currentPlanResult?.solvedSpendProfile ?? null}
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
                  suggestionRankingStatus={suggestionRankingStatus}
                  suggestionRankingProgress={suggestionRankingProgress}
                  suggestionRankingError={suggestionRankingError}
                  suggestionRankingResults={suggestionRankingResults}
                  onRunSuggestionRanking={runSuggestionRanking}
                  onCancelSuggestionRanking={cancelSuggestionRanking}
                  onApplySuggestion={applySuggestion}
                />
              )}
              {currentScreen === 'insights' && (
                <UnifiedPlanScreen
                  data={currentPlan}
                  assumptions={currentPlanAssumptions}
                  simulationStatus={planResultStatus}
                  selectedStressors={currentPlanSelectedStressors}
                  selectedResponses={currentPlanSelectedResponses}
                  pathResults={displayedPlanPathResults}
                  showPlanControls={false}
                />
              )}
            </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Advisor room — the household-facing monthly check-in.
 *
 * Two sections in PR-2:
 *
 *   "This month"  one spend number, one confidence sentence, one "what to do
 *                 right now" sentence based on the current guardrail zone.
 *
 *   "Flight path" the next ~6 dated events from the household's plan: SS
 *                 claim ages, Medicare eligibility, RMD start, retirement
 *                 date, inheritance windfalls, spending-phase shifts. Pure
 *                 derivation from SeedData + today's date — no path data
 *                 required, so it renders even before the simulation finishes.
 *
 * "Easy to miss" (Roth window, ACA cliff, IRMAA, withdrawal sequencing) is
 * PR-3.
 */
interface FlightPathEvent {
  date: Date;
  /** Sort key when two events share a month (stable ordering for the list). */
  tieBreak: number;
  title: string;
  detail: string;
  category:
    | 'social_security'
    | 'medicare'
    | 'rmd'
    | 'retirement'
    | 'spending_phase'
    | 'windfall';
}

/**
 * Rough estimate of how long until the portfolio recovers above the guardrail
 * ceiling (the "Restore @" line). Pure analytic projection — NOT a Monte
 * Carlo. Intentionally simple so the Advisor can answer "how long until we're
 * back?" with a single sentence.
 *
 * Math:
 *   - Weighted nominal expected return = sum over asset classes (allocation
 *     share × class expected return), using the household's actual mix.
 *   - Real return = nominal − inflation.
 *   - Net annual draw = post-cut annual spend − Social Security currently
 *     being received (spouses already past their claim age).
 *   - Iterate P(t+1) = P(t) × (1 + r) − netDraw until P >= ceiling, capped
 *     at `maxYears`.
 *
 * Limitations the caller should be aware of:
 *   - No volatility, sequence risk, taxes, or future SS step-ups during the
 *     recovery window. The Monte Carlo handles all of that — this is the
 *     advisor's "back of the envelope" so the household has a number to hold.
 *   - If the projection never recovers within `maxYears`, returns the next
 *     unclaimed SS event so the advisor can say "but X starts in N years,
 *     which changes the math."
 */
function estimateRecoveryYears(args: {
  portfolio: number;
  ceilingPortfolio: number;
  postCutAnnualSpend: number;
  data: SeedData;
  assumptions: MarketAssumptions;
  today: Date;
  maxYears?: number;
}): {
  years: number | null;
  realReturnPct: number;
  nextSocialSecurity: { person: string; yearsAway: number } | null;
} {
  const {
    portfolio,
    ceilingPortfolio,
    postCutAnnualSpend,
    data,
    assumptions,
    today,
    maxYears = 30,
  } = args;

  // ---- Weighted real return from the household's actual allocation. -------
  // Walk every account bucket; for each, multiply its dollars by its target
  // allocation fractions and accumulate per-asset-class dollars. Then divide
  // by household total to get fractional weights.
  const weighted = { US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 0, CASH: 0 };
  let totalWithAllocation = 0;
  let cashOnlyDollars = 0;
  const buckets = [
    data.accounts?.pretax,
    data.accounts?.roth,
    data.accounts?.taxable,
    data.accounts?.cash,
    data.accounts?.hsa,
  ];
  for (const bucket of buckets) {
    if (!bucket) continue;
    const balance = bucket.balance ?? 0;
    if (balance <= 0) continue;
    const allocation = bucket.targetAllocation ?? {};
    const sumAllocated = Object.values(allocation).reduce(
      (sum, frac) => sum + (frac || 0),
      0,
    );
    if (sumAllocated <= 0) {
      // No allocation declared — assume cash-equivalent. The cash bucket
      // typically lands here (no targetAllocation set), as does any custodial
      // account we haven't classified yet.
      cashOnlyDollars += balance;
      continue;
    }
    totalWithAllocation += balance;
    weighted.US_EQUITY += balance * (allocation.US_EQUITY ?? 0);
    weighted.INTL_EQUITY += balance * (allocation.INTL_EQUITY ?? 0);
    weighted.BONDS += balance * (allocation.BONDS ?? 0);
    weighted.CASH += balance * (allocation.CASH ?? 0);
  }
  const total = totalWithAllocation + cashOnlyDollars;
  const w =
    total > 0
      ? {
          US_EQUITY: weighted.US_EQUITY / total,
          INTL_EQUITY: weighted.INTL_EQUITY / total,
          BONDS: weighted.BONDS / total,
          CASH: (weighted.CASH + cashOnlyDollars) / total,
        }
      : { US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 0, CASH: 1 };
  const nominalReturn =
    w.US_EQUITY * assumptions.equityMean +
    w.INTL_EQUITY * assumptions.internationalEquityMean +
    w.BONDS * assumptions.bondMean +
    w.CASH * assumptions.cashMean;
  const realReturn = nominalReturn - assumptions.inflation;

  // ---- Currently active Social Security ------------------------------------
  // Sum monthly benefits for spouses who are already past their claim age.
  // Apply a rough actuarial factor (8%/yr after 67, 6.67%/yr before) so the
  // dollar number isn't wildly off when the user has chosen 62 or 70 claim.
  const ssEntries = data.income?.socialSecurity ?? [];
  const personBirthDates = new Map<string, string>();
  if (data.household?.robBirthDate) {
    personBirthDates.set('rob', data.household.robBirthDate);
  }
  if (data.household?.debbieBirthDate) {
    personBirthDates.set('debbie', data.household.debbieBirthDate);
  }
  let currentMonthlySS = 0;
  let nextSocialSecurity: { person: string; yearsAway: number } | null = null;
  for (const entry of ssEntries) {
    const personKey = entry.person?.toLowerCase() ?? '';
    const birth = personBirthDates.get(personKey);
    if (!birth) continue;
    const claimDate = dateAtAge(birth, entry.claimAge);
    const factor =
      entry.claimAge >= 67
        ? 1 + (entry.claimAge - 67) * 0.08
        : Math.max(0, 1 - (67 - entry.claimAge) * 0.0667);
    if (claimDate <= today) {
      currentMonthlySS += entry.fraMonthly * factor;
    } else {
      const yearsAway = Math.max(0, yearsBetween(today, claimDate));
      if (!nextSocialSecurity || yearsAway < nextSocialSecurity.yearsAway) {
        nextSocialSecurity = {
          person: entry.person ?? personKey,
          yearsAway,
        };
      }
    }
  }
  const currentAnnualSS = currentMonthlySS * 12;

  // ---- Iterate forward until recovery or maxYears ----
  const netAnnualDraw = Math.max(0, postCutAnnualSpend - currentAnnualSS);
  let p = portfolio;
  for (let y = 1; y <= maxYears; y += 1) {
    p = p * (1 + realReturn) - netAnnualDraw;
    if (p >= ceilingPortfolio) {
      return { years: y, realReturnPct: realReturn, nextSocialSecurity };
    }
    if (p <= 0) break;
  }
  return { years: null, realReturnPct: realReturn, nextSocialSecurity };
}

/** Required Minimum Distribution start age — SECURE 2.0 rules. */
function getRmdStartAge(birthDate: string): number {
  const birthYear = new Date(birthDate).getUTCFullYear();
  if (birthYear >= 1960) return 75;
  if (birthYear >= 1951) return 73;
  return 72; // legacy SECURE 1.0 cohort — unlikely in this household but keep safe.
}

/** Date a person reaches a given age (using their birth month/day). */
function dateAtAge(birthDate: string, age: number): Date {
  const birth = new Date(birthDate);
  return new Date(
    Date.UTC(
      birth.getUTCFullYear() + age,
      birth.getUTCMonth(),
      birth.getUTCDate(),
    ),
  );
}

/** Whole years between two dates (positive when `later` is after `earlier`). */
function yearsBetween(earlier: Date, later: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return ms / (365.2425 * 24 * 60 * 60 * 1000);
}

function formatFlightPathDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "in 7 months" / "in 4 years" — copy that tells you what's near vs far. */
function describeRelativeTime(today: Date, when: Date): string {
  const months = Math.round(
    (when.getUTCFullYear() - today.getUTCFullYear()) * 12 +
      (when.getUTCMonth() - today.getUTCMonth()),
  );
  if (months <= 0) return 'this month';
  if (months === 1) return 'next month';
  if (months < 12) return `in ${months} months`;
  const years = months / 12;
  if (years < 1.5) return 'in about a year';
  if (years < 10) return `in ${Math.round(years)} years`;
  return `in ${Math.round(years)} years`;
}

/**
 * Derive the next N dated events from SeedData. Pure function, deterministic,
 * does not consume path results — so it renders correctly even before the
 * Monte Carlo finishes (or fails). Sort by date, drop anything in the past,
 * cap at `limit`.
 */
function buildFlightPath(
  data: SeedData,
  today: Date,
  limit: number,
): FlightPathEvent[] {
  const events: FlightPathEvent[] = [];
  const household = data.household;
  const people: Array<{ name: string; birthDate: string }> = [];
  if (household?.robBirthDate) {
    people.push({ name: 'Rob', birthDate: household.robBirthDate });
  }
  if (household?.debbieBirthDate) {
    people.push({ name: 'Debbie', birthDate: household.debbieBirthDate });
  }

  // Retirement date (when the salary stops). Only meaningful if it's still in
  // the future; otherwise the household is already retired and this isn't an
  // upcoming event.
  if (data.income?.salaryEndDate) {
    const retire = new Date(data.income.salaryEndDate);
    if (!Number.isNaN(retire.getTime()) && retire > today) {
      events.push({
        date: retire,
        tieBreak: 0,
        title: 'Retirement — salary ends',
        detail:
          'After this date the portfolio carries the full spend until Social Security and other guaranteed income kick in.',
        category: 'retirement',
      });
    }
  }

  // Per-person life-stage markers.
  for (const person of people) {
    // Social Security claim age (per SS entry attributed to this person).
    const ssEntries = (data.income?.socialSecurity ?? []).filter(
      (entry) =>
        entry.person?.toLowerCase() === person.name.toLowerCase() ||
        entry.person?.toLowerCase().startsWith(person.name.toLowerCase()),
    );
    for (const entry of ssEntries) {
      const claimDate = dateAtAge(person.birthDate, entry.claimAge);
      if (claimDate > today) {
        const monthly = Math.round(
          entry.fraMonthly *
            // FRA is approximately 67; if claiming earlier or later we'd
            // apply the actuarial factor. The advisor headline doesn't need
            // that precision — surface the FRA-equivalent figure and let
            // Inspector show the exact factor.
            (entry.claimAge >= 67 ? 1 + (entry.claimAge - 67) * 0.08 : 1 - (67 - entry.claimAge) * 0.0667),
        );
        events.push({
          date: claimDate,
          tieBreak: 1,
          title: `${person.name} claims Social Security at ${entry.claimAge}`,
          detail: `Adds roughly ${formatCurrency(monthly)}/mo of guaranteed real income — the portfolio's job shrinks accordingly.`,
          category: 'social_security',
        });
      }
    }

    // Medicare eligibility (age 65). Worth flagging because it ends the ACA
    // bridge for this person and brings IRMAA into play.
    const medicare = dateAtAge(person.birthDate, 65);
    if (medicare > today) {
      events.push({
        date: medicare,
        tieBreak: 2,
        title: `${person.name} turns 65 — Medicare starts`,
        detail:
          'Premiums (Part B + IRMAA surcharge if MAGI is over the threshold) begin. The pre-65 ACA-subsidy window closes for this spouse.',
        category: 'medicare',
      });
    }

    // First RMD year — the bracket cliff that ends the cheap-conversion window.
    const rmdAge = getRmdStartAge(person.birthDate);
    const rmdStart = dateAtAge(person.birthDate, rmdAge);
    if (rmdStart > today) {
      events.push({
        date: rmdStart,
        tieBreak: 3,
        title: `${person.name} hits ${rmdAge} — RMDs begin`,
        detail:
          'Forced pretax withdrawals start. After this point Roth conversions stop being cheap; the window before this date is when the math works.',
        category: 'rmd',
      });
    }

    // Spending-phase transitions — the household-side milestones of the
    // retirement smile. We mark transitions for the FIRST spouse to hit each
    // age (typically the household reads their spend by the older spouse).
    if (person === people[0]) {
      const slowGo = dateAtAge(person.birthDate, 70);
      if (slowGo > today) {
        events.push({
          date: slowGo,
          tieBreak: 4,
          title: 'Travel-heavy phase ends (~age 70)',
          detail:
            'The plan shifts from go-go spending to a quieter pace. Travel budget steps down; portfolio glide path eases.',
          category: 'spending_phase',
        });
      }
      const lateLife = dateAtAge(person.birthDate, 80);
      if (lateLife > today) {
        events.push({
          date: lateLife,
          tieBreak: 5,
          title: 'Late-life phase begins (~age 80)',
          detail:
            'Discretionary spending steps down again; healthcare and long-term-care reserves carry more weight.',
          category: 'spending_phase',
        });
      }
    }
  }

  // Windfalls — inheritance, home sales, anything dated in the future.
  for (const windfall of data.income?.windfalls ?? []) {
    if (!windfall?.year || windfall.year < today.getUTCFullYear()) continue;
    const when = new Date(Date.UTC(windfall.year, 0, 1));
    if (when <= today) continue;
    events.push({
      date: when,
      tieBreak: 6,
      title: `${windfall.name.charAt(0).toUpperCase() + windfall.name.slice(1)} expected`,
      detail: `Roughly ${formatCurrency(windfall.amount)} ${
        windfall.certainty && windfall.certainty !== 'certain'
          ? `(${windfall.certainty} timing)`
          : ''
      }`.trim(),
      category: 'windfall',
    });
  }

  events.sort((a, b) => {
    const dt = a.date.getTime() - b.date.getTime();
    if (dt !== 0) return dt;
    return a.tieBreak - b.tieBreak;
  });
  return events.slice(0, limit);
}

// ============================================================================
// "Easy to miss" — the advisor's watchlist of expensive things retirees forget.
//
// MVP rule pack (PR-3): Roth window, ACA cliff, IRMAA bracket, withdrawal
// sequencing. Each rule is a pure function of (data, assumptions, today) that
// returns a card if applicable to this household, or null. Registry pattern
// makes adding the next card a one-liner.
//
// The dollar tags are deliberately back-of-envelope — order-of-magnitude
// directional, not precise. Where we can compute a real number from SeedData
// (Roth window pretax balance × bracket spread, IRMAA per-spouse surcharge),
// we do. Where we can't easily (ACA cliff projection, sequencing), we surface
// a typical range. PR-4 would upgrade individual cards to "diff-scenario"
// (run two simulations and report the actual delta) once we know which cards
// are pulling weight.
// ============================================================================
interface EasyToMissCard {
  id: string;
  title: string;
  /** Big-text dollar callout on the right of the card. */
  dollarTag: string;
  /** 1-2 sentence plain-English explanation. */
  body: string;
  /** Optional dated window ("Through Apr 2032"). */
  window?: string;
  /** Sort key: rough lifetime dollars at stake. Higher = more prominent. */
  priority: number;
  /**
   * Optional Sandbox deep-link. When present, the card renders a "Try in
   * Sandbox" affordance that pre-selects the listed stressor + reactions.
   * Cards whose topic doesn't map to a real Sandbox stressor (ACA cliff,
   * IRMAA, withdrawal sequencing — these are planner choices, not external
   * shocks) leave this undefined; they instead get a generic "Open Sandbox"
   * button so the household can explore from a clean slate.
   */
  sandboxScenario?: SandboxInitialScenario;
}

interface EasyToMissRuleArgs {
  data: SeedData;
  assumptions: MarketAssumptions;
  today: Date;
}

type EasyToMissRule = (args: EasyToMissRuleArgs) => EasyToMissCard | null;

/** Conservative estimate of MFJ headroom in the 12% bracket post-deduction. */
const ROTH_ANNUAL_HEADROOM_MFJ = 50_000;
/** Bracket arbitrage assumed for Roth window math: 12% now → 22% later. */
const ROTH_BRACKET_SPREAD = 0.10;
/** Round dollar amount to nearest thousand for headline display. */
const roundToThousand = (n: number) => Math.round(n / 1000) * 1000;

/**
 * Roth conversion window. Triggers when the household has meaningful pretax
 * balance and at least one year before RMDs start. Estimates lifetime tax
 * savings as `min(pretax, yearsAvailable × annualHeadroom) × bracketSpread`.
 *
 * Why this rule matters: the years between "stopped earning" and "RMDs start"
 * are typically the lowest-bracket years of a household's lifetime. Filling
 * the 12% bracket with conversions during this window converts pretax to
 * Roth at half the rate it would otherwise come out as forced RMDs.
 */
const rothConversionWindowRule: EasyToMissRule = ({ data, today }) => {
  const people: Array<{ name: string; birthDate: string }> = [];
  if (data.household?.robBirthDate) {
    people.push({ name: 'Rob', birthDate: data.household.robBirthDate });
  }
  if (data.household?.debbieBirthDate) {
    people.push({ name: 'Debbie', birthDate: data.household.debbieBirthDate });
  }
  if (people.length === 0) return null;

  const pretaxBalance = data.accounts?.pretax?.balance ?? 0;
  if (pretaxBalance < 100_000) return null;

  // Window closes the year the FIRST spouse hits their RMD age.
  const firstRmdEvent = people
    .map((p) => ({
      name: p.name,
      date: dateAtAge(p.birthDate, getRmdStartAge(p.birthDate)),
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime())[0];

  const yearsAvailable = yearsBetween(today, firstRmdEvent.date);
  if (yearsAvailable < 0.5) return null;

  const maxConvertible = Math.min(
    pretaxBalance,
    Math.floor(yearsAvailable) * ROTH_ANNUAL_HEADROOM_MFJ,
  );
  const lifetimeSavings = roundToThousand(
    maxConvertible * ROTH_BRACKET_SPREAD,
  );
  if (lifetimeSavings < 5_000) return null;

  return {
    id: 'roth_window',
    title: 'Roth conversion window',
    dollarTag: `~${formatCurrency(lifetimeSavings)} of lifetime tax in play`,
    body: `Pretax balance is ${formatCurrency(pretaxBalance)} and you have about ${Math.round(yearsAvailable)} years until RMDs start. Filling the 12% bracket each year now converts pretax to Roth at roughly half the rate it would otherwise come out as forced RMDs.`,
    window: `Window closes ${formatFlightPathDate(firstRmdEvent.date)}`,
    priority: lifetimeSavings,
    // Sandbox mapping: market crashes are the highest-leverage moment for
    // Roth conversions (convert at depressed values, recover tax-free). This
    // isn't the only Roth-window scenario, but it's the one where the
    // Sandbox math has something to say.
    sandboxScenario: {
      stressorId: 'market_down',
      stressorKnobValue: 25,
      reactions: [],
    },
  };
};

/**
 * ACA subsidy cliff. Triggers when at least one spouse is pre-65 (still
 * eligible for marketplace coverage) and the household isn't currently drawing
 * salary (subsidy planning is meaningful only when you control your MAGI).
 *
 * The dollar number is generic — we don't have a household MAGI projection
 * available without the simulator's tax engine. The card's job is to flag
 * existence of the window, not compute the exact subsidy.
 */
const acaSubsidyCliffRule: EasyToMissRule = ({ data, today }) => {
  const people: Array<{ name: string; birthDate: string }> = [];
  if (data.household?.robBirthDate) {
    people.push({ name: 'Rob', birthDate: data.household.robBirthDate });
  }
  if (data.household?.debbieBirthDate) {
    people.push({ name: 'Debbie', birthDate: data.household.debbieBirthDate });
  }
  if (people.length === 0) return null;

  // Skip if the household is still earning salary — ACA optimization is much
  // less actionable while W-2 income dominates.
  const salaryEnd = data.income?.salaryEndDate
    ? new Date(data.income.salaryEndDate)
    : null;
  if (salaryEnd && salaryEnd > today) return null;

  // Find the pre-65 spouse who hits Medicare LAST — that's when the ACA
  // window closes for the household.
  const preMedicare = people
    .map((p) => ({ name: p.name, date: dateAtAge(p.birthDate, 65) }))
    .filter((m) => m.date > today)
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  if (!preMedicare) return null;

  const yearsRemaining = Math.max(1, Math.round(yearsBetween(today, preMedicare.date)));
  // Conservative MFJ subsidy estimate at moderate income — actual subsidy can
  // be $0–$25K/yr depending on MAGI position vs threshold. We display the
  // upper-mid end as "up to" so we're not overpromising.
  const ANNUAL_SUBSIDY_ESTIMATE = 12_000;
  const lifetimeAtStake = ANNUAL_SUBSIDY_ESTIMATE * yearsRemaining;

  return {
    id: 'aca_cliff',
    title: 'ACA subsidy window',
    dollarTag: `Up to ~${formatCurrency(ANNUAL_SUBSIDY_ESTIMATE)}/yr through ${formatFlightPathDate(preMedicare.date)}`,
    body: `Until ${preMedicare.name} hits Medicare at 65, keeping household MAGI under the ACA cliff is worth real subsidy dollars on health insurance. Roth conversions and large IRA withdrawals are the usual income that pushes a household over.`,
    window: `~${yearsRemaining} ${yearsRemaining === 1 ? 'year' : 'years'} remaining`,
    priority: lifetimeAtStake,
  };
};

/**
 * IRMAA Medicare premium surcharge. Triggers when at least one spouse is age
 * 63+ (Medicare imminent or active) AND the household has meaningful pretax
 * balance (RMDs and conversions can push MAGI over a threshold).
 *
 * IRMAA is a "cliff" tax — crossing a threshold by $1 costs $1,000+/yr per
 * spouse. The most common own-goal: a year-end Roth conversion that pushes
 * MAGI just over the next bracket. Worth standing watch for.
 */
const irmaaBracketRule: EasyToMissRule = ({ data, assumptions, today }) => {
  const people: Array<{ name: string; birthDate: string }> = [];
  if (data.household?.robBirthDate) {
    people.push({ name: 'Rob', birthDate: data.household.robBirthDate });
  }
  if (data.household?.debbieBirthDate) {
    people.push({ name: 'Debbie', birthDate: data.household.debbieBirthDate });
  }
  if (people.length === 0) return null;

  const oldestAge = Math.max(
    ...people.map((p) =>
      Math.floor(yearsBetween(new Date(p.birthDate), today)),
    ),
  );
  if (oldestAge < 63) return null;

  const pretaxBalance = data.accounts?.pretax?.balance ?? 0;
  if (pretaxBalance < 250_000) return null; // RMDs unlikely to push MAGI over

  // Per-spouse Part B + Part D surcharge at the first IRMAA tier is roughly
  // $1,700/yr in current dollars. Real number depends on bracket; this is
  // the typical "first-cliff" cost to put a number on it.
  const PER_SPOUSE_FIRST_TIER_COST = 1_700;
  const annualCost = PER_SPOUSE_FIRST_TIER_COST * people.length;

  return {
    id: 'irmaa',
    title: 'IRMAA Medicare surcharge',
    dollarTag: `~${formatCurrency(annualCost)}/yr if MAGI crosses ${formatCurrency(assumptions.irmaaThreshold)}`,
    body: `IRMAA is a cliff: crossing the next bracket by $1 adds the full surcharge for the year. Year-end Roth conversions and unexpected capital gains are the usual offender — worth checking December tax positioning before year-end.`,
    priority: annualCost * 10, // 10-year rough horizon for sort priority
  };
};

/**
 * Withdrawal sequencing. Triggers when the household has meaningful balance
 * across at least two account-tax-treatments (taxable + pretax + Roth) and is
 * already retired. The plan models the optimal sequence; the risk is the
 * household's REAL withdrawals don't match what the model assumed.
 */
const withdrawalSequencingRule: EasyToMissRule = ({ data, today }) => {
  const taxableBalance = data.accounts?.taxable?.balance ?? 0;
  const pretaxBalance = data.accounts?.pretax?.balance ?? 0;
  const rothBalance = data.accounts?.roth?.balance ?? 0;
  const distinctTypesWithBalance =
    (taxableBalance > 0 ? 1 : 0) +
    (pretaxBalance > 0 ? 1 : 0) +
    (rothBalance > 0 ? 1 : 0);
  if (distinctTypesWithBalance < 2) return null;

  const salaryEnd = data.income?.salaryEndDate
    ? new Date(data.income.salaryEndDate)
    : null;
  if (salaryEnd && salaryEnd > today) return null; // not retired yet

  const totalLiquid = taxableBalance + pretaxBalance + rothBalance;
  // Order of magnitude: 10-15bps of leakage per year on a poorly-sequenced
  // withdrawal mix over 20 years ≈ 2-3% of portfolio cumulative. Round.
  const lifetimeImpact = roundToThousand(totalLiquid * 0.025);

  return {
    id: 'sequencing',
    title: 'Withdrawal sequencing',
    dollarTag: `~${formatCurrency(lifetimeImpact)} cumulative if your real withdrawals drift from the plan`,
    body: `You have meaningful balances across taxable, pretax, and Roth. The plan models the optimal sequence (taxable → pretax → Roth, with Roth conversions in the gap). Worth a quarterly check that your actual transfers match — pulling from the wrong account quietly leaks five-figure tax over a decade.`,
    priority: lifetimeImpact,
  };
};

const EASY_TO_MISS_RULES: EasyToMissRule[] = [
  rothConversionWindowRule,
  acaSubsidyCliffRule,
  irmaaBracketRule,
  withdrawalSequencingRule,
];

/**
 * Top N highest-priority cards that apply to this household. Higher priority
 * (rough lifetime dollars at stake) sorts first — we want the household's
 * eyes on the most expensive miss, not whatever happens to be alphabetically
 * earliest.
 */
function buildEasyToMissCards(
  args: EasyToMissRuleArgs,
  limit = 3,
): EasyToMissCard[] {
  const cards: EasyToMissCard[] = [];
  for (const rule of EASY_TO_MISS_RULES) {
    const card = rule(args);
    if (card) cards.push(card);
  }
  cards.sort((a, b) => b.priority - a.priority);
  return cards.slice(0, limit);
}

/**
 * Per-year card on the Advisor flight path. Renders one slice of the
 * `yearlySeries` median trajectory: target spend, where the dollars come
 * from (per-bucket withdrawals), and any flight-path events that land in
 * the same calendar year. Used three places: "This year", "Next year",
 * and the dropdown-selected future year.
 *
 * Withdrawal bar buckets:
 *   pretax   — `medianWithdrawalIra401k`
 *   roth     — `medianWithdrawalRoth`
 *   taxable  — `medianWithdrawalTaxable`
 *   cash     — `medianWithdrawalCash`
 *
 * If `yearData` is null (i.e. the year is past the simulation horizon)
 * we still render the card with events so the household sees the dated
 * milestones, just without numbers — better than hiding it.
 */
// ---------------------------------------------------------------------------
// Tax & coverage signals for the YearCard
// ---------------------------------------------------------------------------
// We turn the raw engine numbers (`medianFederalTax`, `medianMagi`,
// `dominantIrmaaTier`, `medianAcaSubsidyEstimate`, `medianRothConversion`)
// into 2-4 plain-English status rows that tell the household whether this
// year's spending is "thoughtfully funded":
//   - tax bite (effective federal tax as % of spend) — sanity check on
//     whether withdrawal sequencing keeps tax drag reasonable
//   - IRMAA tier (post-65) — staying in tier 1 means no Medicare surcharge
//   - ACA subsidy (pre-65) — non-zero subsidy means MAGI is below the
//     premium-tax-credit cliff, which is the big pre-65 trap
//   - Roth conversion — surfaced when present so "extra tax this year"
//     reads as deliberate planning, not an accident
//
// We don't try to replicate Inspector's full tax detail here; the Advisor
// surface should answer "is this OK?" not "show me every number."
type SignalTone = 'good' | 'watch' | 'bad' | 'info';
interface YearTaxSignal {
  key: string;
  label: string;
  value: string;
  tone: SignalTone;
  /**
   * Optional one-sentence "what could I do?" nudge, rendered as small
   * italic text below the row. Omitted when the signal is already
   * optimal AND there's nothing useful to suggest — silence is better
   * than padding the UI with "looks good!" filler.
   */
  hint?: string;
}
const SIGNAL_DOT_CLASS: Record<SignalTone, string> = {
  good: 'bg-emerald-500',
  watch: 'bg-amber-500',
  bad: 'bg-rose-500',
  info: 'bg-blue-500',
};
const SIGNAL_TEXT_CLASS: Record<SignalTone, string> = {
  good: 'text-emerald-700',
  watch: 'text-amber-700',
  bad: 'text-rose-700',
  info: 'text-blue-700',
};
function buildYearTaxSignals(yearData: PathYearResult): YearTaxSignal[] {
  const signals: YearTaxSignal[] = [];
  const spend = Math.max(0, yearData.medianSpending ?? 0);
  const tax = Math.max(0, yearData.medianFederalTax ?? 0);
  const conversion = Math.max(0, yearData.medianRothConversion ?? 0);
  const hasConversion = conversion >= 1000;
  const wages = Math.max(0, yearData.medianAdjustedWages ?? 0);
  // "Working year" proxy — W-2 wages dominate the tax picture, so the
  // levers are very different from a retired year. Used both for the ACA
  // gating below and for the tax-bite hint copy.
  const isWorkingYear = wages >= 5000;

  // --- Tax bite -----------------------------------------------------------
  // Effective federal tax / spend gives a quick "is the engine over-paying
  // tax to fund this lifestyle?" read. We use spend (not income) as the
  // denominator because the household reasons in spend dollars. Bands are
  // intentionally coarse: <12% feels good, 12–20% is normal-but-watch,
  // >20% is paying real money to the IRS and worth a Sandbox look.
  //
  // Hint copy is *honest about the actual lever*. The right lever depends
  // entirely on whether the household is still working:
  //   - Working year: tax is mostly federal income tax on W-2 wages.
  //     Withdrawal sequencing does ~nothing. The real movers are
  //     401k/HSA contributions, timing of any large sales / conversions,
  //     and (long term) the retirement date itself.
  //   - Retired year: the engine actually picks the withdrawal mix, so
  //     "draw more from Roth/cash, less from pretax" is a real lever and
  //     trimming a Roth conversion lowers tax now (at the cost of bigger
  //     RMDs / IRMAA risk later).
  // We branch the hint accordingly so we never tell a W-2 employee to
  // "draw from Roth" — they're not drawing from anything.
  if (spend > 0) {
    const ratio = tax / spend;
    const pct = Math.round(ratio * 100);
    const tone: SignalTone = ratio < 0.12 ? 'good' : ratio < 0.2 ? 'watch' : 'bad';
    let hint: string | undefined;
    if (isWorkingYear) {
      // Working-year hints. We don't tag tones as "watch/bad" too
      // aggressively here because a 12-20% effective federal rate on
      // wages is just normal — not a planning failure.
      if (tone === 'good') {
        hint = undefined; // Already efficient — nothing useful to add.
      } else {
        hint =
          'Mostly federal income tax on W-2 wages — withdrawal sequencing won\u2019t move this. Real levers in working years: max 401k / HSA contributions, time any large sales or Roth conversions, and (long-term) the retirement date.';
      }
    } else if (tone === 'good' && hasConversion) {
      hint =
        'Most of this tax is the Roth conversion below — trim the conversion to pay less now (but expect bigger RMDs and possible IRMAA later).';
    } else if (tone === 'watch') {
      hint =
        'Lower by drawing more from Roth/cash and less from pretax this year, or trim the Roth conversion if there is one.';
    } else if (tone === 'bad') {
      hint =
        'Big tax bite — try Sandbox: shift the order to Roth/cash first, or split this year\u2019s Roth conversion across more years.';
    }
    signals.push({
      key: 'tax',
      label: 'Federal tax vs spend',
      value: `${pct}% (${formatCurrency(Math.round(tax))})`,
      tone,
      hint,
    });
  }

  // --- IRMAA --------------------------------------------------------------
  // Only show when the household is actually on Medicare this year (proxy:
  // the engine is modeling a Medicare premium). Tier 1 = no surcharge,
  // which is the goal. Tier 2 is a minor brush; tier 3+ is real money.
  //
  // Note on the hint for tier 1: the relevant "lookback" is the *2-year-
  // prior* MAGI per the IRMAA rules. We don't have that per-year here, so
  // the hint stays directional rather than naming a dollar threshold.
  const onMedicare = (yearData.medianMedicarePremiumEstimate ?? 0) > 0;
  if (onMedicare) {
    const tierLabel = yearData.dominantIrmaaTier || 'Tier 1';
    const tierNum = Number.parseInt(tierLabel.replace(/[^0-9]/g, ''), 10) || 1;
    const surcharge = Math.max(0, yearData.medianIrmaaSurcharge ?? 0);
    let tone: SignalTone;
    let value: string;
    let hint: string | undefined;
    if (tierNum <= 1) {
      tone = 'good';
      value = 'Tier 1 · no surcharge';
      // Intentionally no hint — already optimal.
    } else if (tierNum === 2) {
      tone = 'watch';
      value = `Tier 2 · +${formatCurrency(Math.round(surcharge))}/yr`;
      hint =
        'One Medicare bracket up. Reduce 2-year-prior MAGI by leaning on Roth/cash before pretax, or by spreading conversions thinner.';
    } else {
      tone = 'bad';
      value = `Tier ${tierNum} · +${formatCurrency(Math.round(surcharge))}/yr`;
      hint =
        'Real surcharge dollars. Consider larger Roth conversions in earlier (lower-MAGI) years so future MAGI lands in a lower bracket.';
    }
    signals.push({
      key: 'irmaa',
      label: 'IRMAA (Medicare)',
      value,
      tone,
      hint,
    });
  }

  // --- ACA ----------------------------------------------------------------
  // Trust the engine here. Since the 2026-04-25 healthcare-premium-engine
  // fix, `acaPremiumEstimate` is gated on `retirementStatus` — it's only
  // non-zero when the household is actually retired and pre-Medicare (the
  // "needs marketplace coverage" window). Earlier we layered a UI-side
  // `!isWorkingYear` guard on top to mask the engine bug, but that guard
  // is now redundant *and* actively wrong for retirement-transition years
  // like the salary-ends-July case: the household has W-2 wages for half
  // the year (so `isWorkingYear=true`) but is genuinely on the ACA from
  // July onward. Dropping the guard lets the chip surface in those
  // transition years too. If the engine ever emits ACA cost for a year
  // that shouldn't have it, that's an engine bug — not a UI gate to fix.
  const onAca = (yearData.medianAcaPremiumEstimate ?? 0) > 0;
  if (onAca) {
    const subsidy = Math.max(0, yearData.medianAcaSubsidyEstimate ?? 0);
    const netCost = Math.max(0, yearData.medianNetAcaCost ?? 0);
    if (subsidy > 0) {
      signals.push({
        key: 'aca',
        label: 'ACA subsidy preserved',
        value: `${formatCurrency(Math.round(subsidy))}/yr off premium`,
        tone: 'good',
        // Soft warning, not a "do something" — but worth knowing.
        hint: hasConversion
          ? 'Subsidy held even with the Roth conversion. Watch headroom if you add more conversion or take a windfall this year.'
          : undefined,
      });
    } else {
      signals.push({
        key: 'aca',
        label: 'ACA subsidy lost',
        value: `paying ${formatCurrency(Math.round(netCost))}/yr full freight`,
        tone: 'bad',
        // Hint depends on what's driving MAGI this year. In a transition
        // year (still some W-2 wages) the wages dominate MAGI and the
        // engine's withdrawal sequencing can't fix it — the real lever
        // is retirement timing or a smaller conversion. In a fully
        // retired year, sequencing is the lever.
        hint: isWorkingYear
          ? 'MAGI driven by W-2 wages this year — withdrawal sequencing can\u2019t lower it. The real levers are the retirement date, deferring this year\u2019s Roth conversion, or accepting full-freight ACA for a partial year.'
          : 'MAGI is over the cliff. Try drawing from Roth/cash instead of pretax this year, or trim the Roth conversion — even a small shift can put the subsidy back.',
      });
    }
  }

  // --- Roth conversion ---------------------------------------------------
  // Surfaced as informational ("we're paying extra tax now on purpose") so
  // the year's tax bite reads as deliberate, not a surprise. $1k floor
  // suppresses noise from sub-cent or tiny optimization passes.
  if (hasConversion) {
    signals.push({
      key: 'roth',
      label: 'Roth conversion this year',
      value: `${formatCurrency(Math.round(conversion))} pretax → Roth`,
      tone: 'info',
      hint:
        'Deliberate — paying tax now at a low rate to shrink future RMDs (and IRMAA risk at 65+). Trim only if cash flow is tight.',
    });
  }

  return signals;
}

interface YearCardProps {
  year: number;
  label: string;
  yearData: PathYearResult | null;
  events: FlightPathEvent[];
  isPrimary?: boolean;
}
function YearCard({ year, label, yearData, events, isPrimary }: YearCardProps) {
  const totalWithdrawals = yearData
    ? Math.max(
        0,
        (yearData.medianWithdrawalIra401k ?? 0) +
          (yearData.medianWithdrawalRoth ?? 0) +
          (yearData.medianWithdrawalTaxable ?? 0) +
          (yearData.medianWithdrawalCash ?? 0),
      )
    : 0;
  // Bucket order is intentional — we want the chart to read tax-deferred
  // first (the bucket that grows if untouched), then tax-free (Roth),
  // then taxable, then cash. Cash last because it's typically smallest
  // and the "spend down" of cash early is the household's intuition
  // anyway. Color contract is reused across the page.
  const buckets: Array<{
    key: 'pretax' | 'roth' | 'taxable' | 'cash';
    label: string;
    amount: number;
    fillClass: string;
    textClass: string;
  }> = yearData
    ? [
        {
          key: 'pretax',
          label: 'Pre-tax (IRA / 401k)',
          amount: yearData.medianWithdrawalIra401k ?? 0,
          fillClass: 'bg-blue-500',
          textClass: 'text-blue-700',
        },
        {
          key: 'roth',
          label: 'Roth',
          amount: yearData.medianWithdrawalRoth ?? 0,
          fillClass: 'bg-emerald-500',
          textClass: 'text-emerald-700',
        },
        {
          key: 'taxable',
          label: 'Taxable',
          amount: yearData.medianWithdrawalTaxable ?? 0,
          fillClass: 'bg-amber-500',
          textClass: 'text-amber-700',
        },
        {
          key: 'cash',
          label: 'Cash',
          amount: yearData.medianWithdrawalCash ?? 0,
          fillClass: 'bg-stone-500',
          textClass: 'text-stone-700',
        },
      ]
    : [];

  const cardClass = isPrimary
    ? 'rounded-[24px] border border-blue-200 bg-white p-5 shadow-sm'
    : 'rounded-[24px] border border-stone-200 bg-white/80 p-5 shadow-sm';

  return (
    <article className={cardClass}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
            {label}
          </p>
          <p className="text-2xl font-semibold tabular-nums text-stone-900">
            {year}
          </p>
        </div>
        {yearData && (
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Spend (median)
            </p>
            <p className="text-xl font-semibold tabular-nums text-stone-900">
              {formatCurrency(Math.round(yearData.medianSpending ?? 0))}
            </p>
          </div>
        )}
      </div>

      {/* Where the money comes from — stacked bar + per-bucket dollar list.
          The mix bar percentages are scoped to *withdrawals*, not spend.
          When portfolio withdrawals are a small share of total spend (e.g.
          working years where wages cover most of spending), we surface
          the implied "income covered $X" line so the household doesn't
          read "Cash 100%" as "all my spending is cash". */}
      {yearData && totalWithdrawals > 0 && (() => {
        const spend = Math.max(0, yearData.medianSpending ?? 0);
        const incomeCovered = Math.max(0, spend - totalWithdrawals);
        const portfolioShareOfSpend = spend > 0 ? totalWithdrawals / spend : 1;
        const showIncomeCoverNote = incomeCovered > 0 && portfolioShareOfSpend < 0.95;
        return (
          <div className="mt-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Where it comes from
            </p>
            {showIncomeCoverNote && (
              <p className="mt-1 text-[11px] text-stone-500">
                Income (wages / SS / pension) covers{' '}
                <span className="font-medium text-stone-700">
                  {formatCurrency(Math.round(incomeCovered))}
                </span>
                . Portfolio withdrawals fund the remaining{' '}
                <span className="font-medium text-stone-700">
                  {formatCurrency(Math.round(totalWithdrawals))}
                </span>
                {spend > 0 && (
                  <> ({Math.round(portfolioShareOfSpend * 100)}% of spend).</>
                )}
              </p>
            )}
            <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-stone-100">
              {buckets.map((b) =>
                b.amount > 0 ? (
                  <div
                    key={b.key}
                    className={b.fillClass}
                    style={{ width: `${(b.amount / totalWithdrawals) * 100}%` }}
                    title={`${b.label}: ${formatCurrency(Math.round(b.amount))}`}
                  />
                ) : null,
              )}
            </div>
            <ul className="mt-2 space-y-1 text-xs">
              {buckets.map((b) => (
                <li
                  key={b.key}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="flex items-center gap-1.5 text-stone-700">
                    <span className={`h-2 w-2 rounded-full ${b.fillClass}`} />
                    {b.label}
                  </span>
                  <span className={`tabular-nums ${b.textClass}`}>
                    {b.amount > 0
                      ? `${formatCurrency(Math.round(b.amount))} · ${Math.round((b.amount / totalWithdrawals) * 100)}% of withdrawals`
                      : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {yearData && totalWithdrawals === 0 && (
        <p className="mt-4 text-xs text-stone-500">
          No portfolio withdrawals modeled this year — income (salary, SS,
          pension) is covering plan spend.
        </p>
      )}

      {/* Tax & coverage signals — gives the household a 5-second read on
          whether this year's spend is "thoughtfully funded": is the tax
          bite reasonable, are we preserving ACA subsidy (pre-Medicare),
          and are we staying in low IRMAA tiers (post-65)? Each row is a
          single phrase with a traffic-light dot — no charts, no jargon.
          We deliberately omit chips that don't apply this year (e.g.
          ACA when both members are on Medicare). */}
      {yearData && (() => {
        const signals = buildYearTaxSignals(yearData);
        // MAGI = Modified Adjusted Gross Income — the single number the IRS,
        // ACA, and IRMAA all key off. We surface it as the "context number"
        // above the chips so the household can see *what's driving* the
        // signals (a chip saying "ACA subsidy lost" makes a lot more sense
        // when the MAGI line right above it reads $300k). Hidden if missing
        // or non-positive (early-year noise, or scenarios where the engine
        // didn't compute it).
        const magi = Math.round(yearData.medianMagi ?? 0);
        const showMagi = magi > 0;
        if (signals.length === 0 && !showMagi) return null;
        return (
          <div className="mt-4 border-t border-stone-100 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Tax &amp; coverage
            </p>
            {showMagi && (
              <div className="mt-2 flex items-baseline justify-between gap-3 text-xs text-stone-700">
                <span title="Modified Adjusted Gross Income — the IRS-relevant income figure that drives your tax bracket, ACA subsidy, and IRMAA tier">
                  Projected income (MAGI)
                </span>
                <span className="tabular-nums text-stone-900">
                  {formatCurrency(magi)}
                </span>
              </div>
            )}
            <ul className="mt-2 space-y-2 text-xs">
              {signals.map((sig) => (
                <li key={sig.key}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-stone-700">
                      <span
                        className={`h-2 w-2 rounded-full ${SIGNAL_DOT_CLASS[sig.tone]}`}
                      />
                      {sig.label}
                    </span>
                    <span
                      className={`tabular-nums ${SIGNAL_TEXT_CLASS[sig.tone]}`}
                    >
                      {sig.value}
                    </span>
                  </div>
                  {sig.hint && (
                    <p className="mt-0.5 pl-3.5 text-[11px] leading-snug text-stone-500">
                      {sig.hint}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {/* Dated milestones in this year. */}
      {events.length > 0 && (
        <div className="mt-4 border-t border-stone-100 pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
            Milestones
          </p>
          <ul className="mt-2 space-y-2 text-sm">
            {events.map((event) => (
              <li key={`${event.date.toISOString()}-${event.title}`}>
                <p className="font-medium text-stone-900">
                  <span className="mr-2 text-xs font-normal text-stone-500">
                    {formatFlightPathDate(event.date)}
                  </span>
                  {event.title}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!yearData && events.length === 0 && (
        <p className="mt-4 text-xs text-stone-500">
          No simulation data or events for this year.
        </p>
      )}
    </article>
  );
}

/**
 * Tiny inline editor used by the Advisor's North Star card when no legacy
 * target is set yet. Kept deliberately dumb: a number field + Save button.
 * The full edit affordance for the populated state is a window.prompt
 * inline on the card — no need for a second floating form when the target
 * already exists. Empty / non-numeric / negative input is silently rejected
 * so the household can't accidentally save a $0 goal.
 */
interface LegacyTargetEditorProps {
  currentValue: number | undefined;
  onSave: (value: number | undefined) => void;
}
function LegacyTargetEditor({ currentValue, onSave }: LegacyTargetEditorProps) {
  const [draft, setDraft] = useState(
    currentValue !== undefined ? String(currentValue) : '',
  );
  const submit = () => {
    const cleaned = draft.replace(/[$,\s]/g, '');
    if (cleaned === '') {
      onSave(undefined);
      return;
    }
    const parsed = Number.parseFloat(cleaned);
    if (Number.isFinite(parsed) && parsed >= 0) {
      onSave(parsed);
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-sm text-stone-700">$</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="e.g. 250,000"
        className="w-40 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm tabular-nums text-stone-900 shadow-inner focus:border-blue-400 focus:outline-none"
      />
      <button
        type="button"
        onClick={submit}
        className="rounded-full bg-blue-700 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-blue-800"
      >
        Set as North Star
      </button>
    </div>
  );
}


interface AdvisorRoomProps {
  data: SeedData;
  assumptions: MarketAssumptions;
  solvedSpendProfile: SolvedSpendProfile | null;
  planResultStatus: SimulationStatus;
  /**
   * Baseline (no-stressor) path result from the most recent simulation.
   * Used to read the projected end-of-plan portfolio (median + p10) so the
   * North Star card can compare the household's stated legacy goal against
   * what the engine actually projects. Null while the first run is still
   * pending — the card renders a "running…" state in that case.
   */
  baselinePathResult: PathResult | null;
  /**
   * Deep-link to Sandbox. Called from Easy-to-miss cards' "Try in Sandbox"
   * affordance. `scenario` is omitted for cards without a clean stressor
   * mapping — Sandbox opens to its empty state in that case.
   */
  onOpenSandbox: (scenario?: SandboxInitialScenario) => void;
}

function AdvisorRoom({
  data,
  assumptions,
  solvedSpendProfile,
  planResultStatus,
  baselinePathResult,
  onOpenSandbox,
}: AdvisorRoomProps) {
  const setLegacyTarget = useAppStore((state) => state.setLegacyTarget);
  // Memoize the flight path so we don't recompute it on every parent render.
  // Today's date is the only "live" input — fine to recompute when seedData
  // changes (rare). Capture it once per render so all calls inside this
  // component agree on "now".
  const today = useMemo(() => new Date(), []);
  const flightPath = useMemo(
    () => buildFlightPath(data, today, 6),
    [data, today],
  );
  const easyToMiss = useMemo(
    () => buildEasyToMissCards({ data, assumptions, today }),
    [data, assumptions, today],
  );

  // ----- Loading + empty states ---------------------------------------------
  // The plan auto-runs on load; until it produces a SolvedSpendProfile we
  // can still show the flight path (it's pure SeedData), but the spend
  // headline gets a placeholder.
  const spendReady = solvedSpendProfile !== null;
  const planRunning = planResultStatus === 'running';

  // ----- "This month" derivations --------------------------------------------
  // Mirror the GuardrailZonePanel logic: compute portfolio, fundedYears, zone.
  // Same formula as the engine's runtime trigger so the Advisor sentence
  // matches what the simulator actually does in each path.
  const portfolio =
    (data.accounts?.pretax?.balance ?? 0) +
    (data.accounts?.roth?.balance ?? 0) +
    (data.accounts?.taxable?.balance ?? 0) +
    (data.accounts?.cash?.balance ?? 0) +
    (data.accounts?.hsa?.balance ?? 0);

  const monthlySpend = solvedSpendProfile?.monthlySpendNow ?? 0;
  const annualSpend = monthlySpend * 12;
  const fundedYears = annualSpend > 0 ? portfolio / annualSpend : 0;
  const floorYears = assumptions.guardrailFloorYears;
  const ceilingYears = assumptions.guardrailCeilingYears;
  const cutPercent = assumptions.guardrailCutPercent;

  const zone: 'green' | 'yellow' | 'red' = !spendReady
    ? 'green'
    : fundedYears >= ceilingYears
      ? 'green'
      : fundedYears <= floorYears
        ? 'red'
        : 'yellow';

  // Plain-English sentence about what to do this month. The numbers are
  // intentionally implicit ("comfortable", "watch zone", "below the action
  // line") — the dollar tags belong in Inspector for users who want to drill in.
  // The red-zone version also includes a back-of-envelope recovery estimate
  // so the household has a number to hold ("how long until we're back?").
  const optionalMonthly = data.spending?.optionalMonthly ?? 0;
  const travelMonthly = (data.spending?.travelEarlyRetirementAnnual ?? 0) / 12;
  const cutAmount = (optionalMonthly + travelMonthly) * cutPercent;
  const postCutAnnualSpend = annualSpend - cutAmount * 12;
  const ceilingPortfolio = ceilingYears * annualSpend;

  const recovery =
    zone === 'red' && spendReady
      ? estimateRecoveryYears({
          portfolio,
          ceilingPortfolio,
          postCutAnnualSpend,
          data,
          assumptions,
          today,
        })
      : null;

  // Recovery clause — only for red zone. Two flavors:
  //   - Recovery happens in N years at the household's expected real return:
  //     give the year count and the return assumption used.
  //   - Recovery doesn't happen at current rates: be honest about it, and
  //     point at the next SS event as the thing that changes the math.
  const recoveryClause = recovery
    ? recovery.years !== null
      ? ` At today's mix (~${formatPercent(recovery.realReturnPct)} real expected return), recovery looks like about ${recovery.years} ${recovery.years === 1 ? 'year' : 'years'}.`
      : recovery.nextSocialSecurity
        ? ` At today's draw rate the portfolio doesn't recover on its own — ${recovery.nextSocialSecurity.person}'s Social Security starts in about ${Math.round(recovery.nextSocialSecurity.yearsAway)} ${Math.round(recovery.nextSocialSecurity.yearsAway) === 1 ? 'year' : 'years'}, which materially changes the math.`
        : ` At today's draw rate the portfolio is not projected to recover on its own.`
    : '';

  const ruleSentence =
    zone === 'green'
      ? `Your portfolio is comfortably above the planned cushion. Spend the full target this month.`
      : zone === 'yellow'
        ? `You're in the watch zone. Hold current spending; don't expand travel or big-ticket optional this month.`
        : `Your portfolio is below the action line. The plan calls for trimming travel + optional by a combined ~${formatCurrency(Math.round(cutAmount))}/mo until it recovers.${recoveryClause}`;

  const zoneStyles = {
    green: {
      eyebrow: 'text-emerald-700',
      dot: 'bg-emerald-500',
    },
    yellow: {
      eyebrow: 'text-amber-700',
      dot: 'bg-amber-500',
    },
    red: {
      eyebrow: 'text-rose-700',
      dot: 'bg-rose-500',
    },
  }[zone];

  // ----- Year-by-year flight path -----------------------------------------
  // The household plans in calendar years. We split the dated FlightPath
  // events into per-year buckets, then pair each bucket with the matching
  // PathYearResult (median trajectory) so each year card can show
  // "what you spend, where it comes from, what changes" as a single read.
  const eventsByYear = useMemo(() => {
    // Bucket by UTC year — the display formatter (formatFlightPathDate)
    // uses timeZone: 'UTC' so a Jan-1 UTC inheritance event must be bucketed
    // into its UTC year, not the local-time year (which can shift it back
    // a day in negative-offset zones like PST).
    const map = new Map<number, FlightPathEvent[]>();
    for (const event of flightPath) {
      const year = event.date.getUTCFullYear();
      const list = map.get(year) ?? [];
      list.push(event);
      map.set(year, list);
    }
    return map;
  }, [flightPath]);
  const yearlySeriesByYear = useMemo(() => {
    const map = new Map<number, PathYearResult>();
    if (!baselinePathResult) return map;
    for (const row of baselinePathResult.yearlySeries) {
      map.set(row.year, row);
    }
    return map;
  }, [baselinePathResult]);
  const currentCalendarYear = today.getFullYear();
  const firstSimYear = baselinePathResult?.yearlySeries?.[0]?.year ?? currentCalendarYear;
  const lastSimYear =
    baselinePathResult?.yearlySeries?.length
      ? baselinePathResult.yearlySeries[baselinePathResult.yearlySeries.length - 1]?.year
      : currentCalendarYear + 30;
  const flightPathYearChoices = useMemo(() => {
    const start = Math.max(currentCalendarYear + 2, firstSimYear);
    const end = lastSimYear ?? currentCalendarYear + 30;
    const out: number[] = [];
    for (let y = start; y <= end; y++) out.push(y);
    return out;
  }, [currentCalendarYear, firstSimYear, lastSimYear]);
  const [extraFlightYear, setExtraFlightYear] = useState<number | null>(null);
  const yearCardSpec: Array<{ year: number; label: string; isPrimary: boolean }> = [
    { year: currentCalendarYear, label: 'This year', isPrimary: true },
    { year: currentCalendarYear + 1, label: 'Next year', isPrimary: false },
  ];
  if (extraFlightYear !== null) {
    yearCardSpec.push({
      year: extraFlightYear,
      label: `In ${extraFlightYear - currentCalendarYear} years`,
      isPrimary: false,
    });
  }

  // ----- North Star (end-of-plan / legacy goal) -----------------------------
  // The thing this app respects that other calculators don't: the dollar
  // amount the household wants left at the end of the plan.
  //
  // We pull ending-wealth percentiles from `solvedSpendProfile.cemetery` —
  // those are denominated in TODAY'S dollars, which is the same unit the
  // user enters their target in. The previous version of this card pulled
  // `baselinePathResult.medianEndingWealth` instead, which is nominal future
  // dollars — that's why a $1M target showed a phantom "+$2.4M cushion"
  // even on plans that were actually cutting it close in real terms.
  //
  // The headline metric households actually care about is "what's the chance
  // I leave at least my goal?" — computed from the 5-percentile cemetery
  // distribution via linear interpolation of the CDF.
  const legacyTarget = data.goals?.legacyTargetTodayDollars ?? null;
  const cemetery = solvedSpendProfile?.cemetery ?? null;
  const projectedMedianLegacy = cemetery?.medianTodayDollars ?? null;
  const projectedP10Legacy = cemetery?.p10TodayDollars ?? null;
  const projectedP90Legacy = cemetery?.p90TodayDollars ?? null;
  const bequestAttainmentRate =
    legacyTarget !== null && legacyTarget > 0 && cemetery !== null
      ? approximateBequestAttainmentRate(legacyTarget, {
          p10: cemetery.p10TodayDollars,
          p25: cemetery.p25TodayDollars,
          p50: cemetery.medianTodayDollars,
          p75: cemetery.p75TodayDollars,
          p90: cemetery.p90TodayDollars,
        })
      : null;
  // 80% is the soft "comfortable" threshold — same standard used elsewhere
  // for plan-level success targets. Below that we paint amber/rose so the
  // household sees the gap; at or above we paint emerald.
  const bequestComfortable =
    bequestAttainmentRate !== null && bequestAttainmentRate >= 0.8;
  const bequestStretched =
    bequestAttainmentRate !== null && bequestAttainmentRate < 0.5;

  // ----- Bucket allocation guidance ---------------------------------------
  // The household reads year-by-year flight cards above to see *which*
  // buckets fund each year. This card zooms out to the next ~5 years of
  // planned withdrawals per bucket and pairs that against the current
  // bucket balance — so they (or their stock advisor) can see which
  // bucket is over-/under-funded for the upcoming spending.
  //
  // Safety reserve — what we're actually trying to measure: sequence-of-
  // returns defense. If equities drop 30% in year 1 of retirement, you
  // don't want to be forced to sell equities to fund spending — so you
  // want enough non-equity (cash + bonds) to cover the *portfolio*
  // outflow until equities recover.
  //
  // Two corrections vs. the original v1 of this card:
  //   (a) Target is 2y of NET PORTFOLIO WITHDRAWALS, not gross spending.
  //       SS / pension / wages already cover most spending; the reserve
  //       only has to bridge what the portfolio actually pays. Using
  //       `medianWithdrawal*` series (already in PathYearResult) gives
  //       the honest number.
  //   (b) "Cash on hand" is too narrow — bonds and money-market positions
  //       inside taxable / pretax / roth are sellable in a bear market
  //       without realizing equity losses. Roll up each bucket's
  //       targetAllocation through `rollupHoldingsToAssetClasses` and
  //       count CASH + BONDS exposure as the real liquid runway.
  const ALLOCATION_HORIZON_YEARS = 5;
  const allocationGuidance = useMemo(() => {
    if (!baselinePathResult) return null;
    const series = baselinePathResult.yearlySeries;
    if (!series || series.length === 0) return null;
    const horizonRows = series
      .filter((r) => r.year >= currentCalendarYear)
      .slice(0, ALLOCATION_HORIZON_YEARS);
    if (horizonRows.length === 0) return null;
    const sum = (pick: (r: PathYearResult) => number) =>
      horizonRows.reduce((acc, r) => acc + Math.max(0, pick(r) ?? 0), 0);
    const need = {
      pretax: sum((r) => r.medianWithdrawalIra401k ?? 0),
      roth: sum((r) => r.medianWithdrawalRoth ?? 0),
      taxable: sum((r) => r.medianWithdrawalTaxable ?? 0),
      cash: sum((r) => r.medianWithdrawalCash ?? 0),
    };
    const have = {
      pretax: data.accounts?.pretax?.balance ?? 0,
      roth: data.accounts?.roth?.balance ?? 0,
      taxable: data.accounts?.taxable?.balance ?? 0,
      cash: data.accounts?.cash?.balance ?? 0,
    };
    const totalWithdrawn =
      need.pretax + need.roth + need.taxable + need.cash;

    // Reserve target: 2 years of *portfolio* outflow. Sums every bucket's
    // median withdrawal across the next two horizon rows — the actual
    // dollars the portfolio must produce after income covers what it
    // covers. For households whose SS/pension covers most of spending
    // this can be 1/3 to 1/2 of the gross-spending number we used to
    // show.
    const reserveHorizonYears = Math.min(2, horizonRows.length);
    const twoYearReserveTarget = horizonRows
      .slice(0, reserveHorizonYears)
      .reduce(
        (acc, r) =>
          acc +
          Math.max(0, r.medianWithdrawalCash ?? 0) +
          Math.max(0, r.medianWithdrawalTaxable ?? 0) +
          Math.max(0, r.medianWithdrawalIra401k ?? 0) +
          Math.max(0, r.medianWithdrawalRoth ?? 0),
        0,
      );

    // Liquid runway: cash + bond exposure across all buckets the
    // household would actually draw against in a downturn. Roll up each
    // account's targetAllocation to {US_EQUITY, INTL_EQUITY, BONDS, CASH}
    // and sum balance × (CASH + BONDS) per bucket. Pretax bonds count
    // because withdrawing from pretax doesn't force selling pretax
    // equities — you can choose to liquidate the bond sleeve inside the
    // bucket.
    const accountsForLiquidity = data.accounts;
    const assumptions = data.rules?.assetClassMappingAssumptions;
    const liquidFromBucket = (bucket: keyof AccountsData) => {
      const account = accountsForLiquidity?.[bucket];
      if (!account) return 0;
      const exposure = rollupHoldingsToAssetClasses(
        account.targetAllocation ?? {},
        assumptions,
      );
      const liquidShare = exposure.CASH + exposure.BONDS;
      return Math.max(0, account.balance) * liquidShare;
    };
    const liquidByBucket = {
      cash: liquidFromBucket('cash'),
      taxable: liquidFromBucket('taxable'),
      pretax: liquidFromBucket('pretax'),
      roth: liquidFromBucket('roth'),
      hsa: liquidFromBucket('hsa'),
    };
    const liquidRunwayTotal =
      liquidByBucket.cash +
      liquidByBucket.taxable +
      liquidByBucket.pretax +
      liquidByBucket.roth +
      liquidByBucket.hsa;
    // "Reachable without tax friction" view: cash + taxable bond/cash
    // sleeve. This is the number a household can actually tap this year
    // without triggering ordinary-income or penalty consequences.
    const liquidRunwayTaxFree =
      liquidByBucket.cash + liquidByBucket.taxable;

    // Gap — measured against the broader liquid runway, since bonds in
    // any bucket are sellable in a downturn. Negative means surplus.
    const reserveGap = twoYearReserveTarget - liquidRunwayTotal;
    const reserveGapTaxFree = twoYearReserveTarget - liquidRunwayTaxFree;
    // Taxable cushion vs. its own planned draws — same honesty check as
    // before, used by the advice copy when the household is short on
    // tax-frictionless runway specifically.
    const taxableCushion = have.taxable - need.taxable;

    return {
      horizonYears: horizonRows.length,
      reserveHorizonYears,
      need,
      have,
      totalWithdrawn,
      twoYearReserveTarget,
      liquidByBucket,
      liquidRunwayTotal,
      liquidRunwayTaxFree,
      reserveGap,
      reserveGapTaxFree,
      taxableCushion,
    };
  }, [baselinePathResult, currentCalendarYear, data]);

  // ----- PDF export ---------------------------------------------------------
  // The household wants a printable "rubber hits the road" handout. We use
  // window.print() with a body class that toggles a print-only stylesheet
  // (see src/styles.css). The button itself is .no-print so it doesn't
  // render on paper. Cleanup is in `afterprint` so it always runs even if
  // the user cancels the dialog.
  const handleSaveAsPdf = () => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    document.body.classList.add('print-advisor-only');
    const cleanup = () => {
      document.body.classList.remove('print-advisor-only');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  };

  return (
    <main
      id="advisor-print-root"
      className="mx-auto max-w-[900px] px-4 py-8 sm:px-6 lg:px-8"
    >
      {/* Greeting line — sets the "advisor sitting with you" tone. */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-blue-700">
          Advisor · monthly check-in
        </p>
        <button
          type="button"
          onClick={handleSaveAsPdf}
          className="no-print rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 shadow-sm hover:border-blue-300 hover:text-blue-800"
          title="Open the print dialog. Choose 'Save as PDF' to download a printable copy."
        >
          Save as PDF
        </button>
      </div>

      {/* ------------------------ North Star (end-of-plan goal) ------------ */}
      {/* Sits ABOVE everything else — it's the anchor the rest of the page
          reads against. The household's stated end-of-plan target compared
          to the engine's projected median + p10. If no target is set yet,
          the card prompts the household to enter one rather than rendering
          a hollow $0 reading. */}
      <section className="mb-6 rounded-[28px] border border-blue-200 bg-blue-50/60 p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-blue-700" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-800">
            North Star · end-of-plan goal
          </p>
        </div>
        {legacyTarget === undefined ? (
          <div className="mt-3">
            <p className="max-w-[60ch] text-base leading-relaxed text-stone-800">
              Set the dollar amount you want left at the end of the plan —
              inheritance, charitable bequest, or your own late-life cushion.
              Every other number on this page reads against it.
            </p>
            <LegacyTargetEditor
              currentValue={undefined}
              onSave={(next) => setLegacyTarget(next)}
            />
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* GOAL — the household's stated target. Editable. */}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
                Goal
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums text-stone-900">
                {formatCurrency(Math.round(legacyTarget ?? 0))}
              </p>
              <button
                type="button"
                onClick={() => {
                  const raw = window.prompt(
                    'New end-of-plan goal (today\u0027s dollars). Leave blank to clear.',
                    String(legacyTarget),
                  );
                  if (raw === null) return;
                  const cleaned = raw.replace(/[$,\s]/g, '');
                  if (cleaned === '') {
                    setLegacyTarget(undefined);
                    return;
                  }
                  const parsed = Number.parseFloat(cleaned);
                  if (Number.isFinite(parsed) && parsed >= 0) {
                    setLegacyTarget(parsed);
                  }
                }}
                className="mt-1 text-[11px] font-medium text-blue-700 hover:text-blue-900"
              >
                Edit goal
              </button>
            </div>

            {/* HEADLINE METRIC — chance of leaving ≥ the goal. This is the
                question the household is actually asking when they set a
                North Star. Color-coded vs the 80% comfortable threshold. */}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
                Likely to leave at least your goal
              </p>
              <p
                className={`mt-1 text-3xl font-semibold tabular-nums ${
                  bequestAttainmentRate === null
                    ? 'text-stone-400'
                    : bequestComfortable
                      ? 'text-emerald-700'
                      : bequestStretched
                        ? 'text-rose-700'
                        : 'text-amber-700'
                }`}
              >
                {bequestAttainmentRate === null
                  ? planRunning ? '…' : '—'
                  : `${Math.round(bequestAttainmentRate * 100)}%`}
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                {bequestAttainmentRate === null
                  ? 'engine running'
                  : bequestComfortable
                    ? 'comfortable margin'
                    : bequestStretched
                      ? 'stretched — would you spend less or work longer?'
                      : 'doable but tight — small misses matter'}
              </p>
            </div>

            {/* TYPICAL OUTCOME — what the middle path actually leaves behind,
                in today's dollars. The number that answers "if things go
                roughly as expected, how much will I leave?" */}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
                Typical outcome
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums text-stone-900">
                {projectedMedianLegacy !== null
                  ? formatCurrency(Math.round(projectedMedianLegacy))
                  : planRunning ? '…' : '—'}
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                middle of all simulated paths
              </p>
            </div>

            {/* TAIL READ — what the worst 10% of paths leave. The number
                that answers "if markets misbehave, how much do I leave?" */}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
                If markets misbehave
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums text-stone-900">
                {projectedP10Legacy !== null
                  ? formatCurrency(Math.round(projectedP10Legacy))
                  : planRunning ? '…' : '—'}
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                worst 10% of paths leave at least this
              </p>
            </div>
          </div>
        )}
        {/* Subtle reminder so it's clear all three numbers are in the same
            unit as the goal. Suppress while no goal is set (the prompt copy
            above already explains today-dollar framing). */}
        {legacyTarget !== undefined && cemetery !== null && (
          <p className="mt-3 text-[11px] text-stone-500">
            All values in today&rsquo;s dollars. {projectedP90Legacy !== null
              ? `If markets are kind, the best 10% of paths leave more than ${formatCurrency(Math.round(projectedP90Legacy))}.`
              : ''}
          </p>
        )}
      </section>

      {/* ------------------------ This month ------------------------------- */}
      <section className="mb-8 rounded-[28px] border border-stone-200 bg-white/80 p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${zoneStyles.dot}`} />
          <p
            className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${zoneStyles.eyebrow}`}
          >
            This month
          </p>
        </div>

        {spendReady ? (
          <>
            <p className="mt-3 text-[42px] font-semibold leading-none text-stone-900">
              {formatCurrency(Math.round(monthlySpend))}
              <span className="ml-1 text-base font-normal text-stone-500">
                /mo
              </span>
            </p>
            <p className="mt-2 text-sm text-stone-600">
              {formatPercent(solvedSpendProfile.achievedSuccess)} of
              simulated futures finish with money left over.
            </p>
            <p className="mt-4 max-w-[60ch] text-base leading-relaxed text-stone-800">
              {ruleSentence}
            </p>
          </>
        ) : (
          <>
            <p className="mt-3 text-[42px] font-semibold leading-none text-stone-400">
              {planRunning ? '…' : '—'}
            </p>
            <p className="mt-2 text-sm text-stone-500">
              {planRunning
                ? 'Running the model — your spend headline appears here once the simulation finishes (~30 seconds on first load).'
                : 'No plan result yet. Open Inspector to run a simulation.'}
            </p>
          </>
        )}
      </section>

      {/* ------------------------ Flight path ----------------------------- */}
      {/* Year-by-year cards: This year, Next year, plus an optional
          household-picked future year. Each card shows median spend, the
          per-bucket withdrawal mix (so the household sees *where* the money
          comes from), and any dated milestones that fall inside the year. */}
      <section className="mb-8 rounded-[28px] border border-stone-200 bg-white/80 p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">
              Flight path · year by year
            </p>
          </div>
          {flightPathYearChoices.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-stone-600">
              <span>See another year:</span>
              <select
                value={extraFlightYear ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setExtraFlightYear(v === '' ? null : Number.parseInt(v, 10));
                }}
                className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-800 shadow-sm focus:border-blue-400 focus:outline-none"
              >
                <option value="">— pick a year —</option>
                {flightPathYearChoices.map((y) => (
                  <option key={y} value={y}>
                    {y} (in {y - currentCalendarYear} years)
                  </option>
                ))}
              </select>
              {extraFlightYear !== null && (
                <button
                  type="button"
                  onClick={() => setExtraFlightYear(null)}
                  className="rounded-full px-2 py-1 text-[11px] text-stone-500 hover:text-stone-800"
                >
                  Clear
                </button>
              )}
            </label>
          )}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {yearCardSpec.map((spec) => (
            <YearCard
              key={spec.year}
              year={spec.year}
              label={spec.label}
              yearData={yearlySeriesByYear.get(spec.year) ?? null}
              events={eventsByYear.get(spec.year) ?? []}
              isPrimary={spec.isPrimary}
            />
          ))}
        </div>

        {/* Long-horizon dated milestones that don't fall inside a rendered
            year card — surfaced as a compact list so they don't disappear. */}
        {(() => {
          const renderedYears = new Set(yearCardSpec.map((s) => s.year));
          const remaining = flightPath.filter(
            (e) => !renderedYears.has(e.date.getUTCFullYear()),
          );
          if (remaining.length === 0) return null;
          return (
            <div className="mt-6 border-t border-stone-100 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                Other dated milestones
              </p>
              <ol className="mt-3 space-y-2">
                {remaining.slice(0, 6).map((event) => (
                  <li
                    key={`${event.date.toISOString()}-${event.title}`}
                    className="grid grid-cols-[110px_1fr] items-baseline gap-3 text-sm"
                  >
                    <div>
                      <p className="font-medium text-stone-800">
                        {formatFlightPathDate(event.date)}
                      </p>
                      <p className="text-xs text-stone-500">
                        {describeRelativeTime(today, event.date)}
                      </p>
                    </div>
                    <p className="text-stone-700">{event.title}</p>
                  </li>
                ))}
              </ol>
            </div>
          );
        })()}

        {flightPath.length === 0 && !baselinePathResult && (
          <p className="mt-4 text-sm text-stone-600">
            No upcoming dated events and no simulation result yet. Open
            Inspector to run a baseline plan or add Social Security claim
            ages, retirement dates, or windfalls.
          </p>
        )}
      </section>

      {/* ------------------------ Allocation guidance --------------------- */}
      {/* "What should sit where" — the page above tells the household which
          bucket funds each year. This card zooms out and tells them how the
          balances should look across the next ~5 years of spending. Two
          parts: (a) per-bucket need-vs-have table, (b) safety-reserve check
          (liquid bond/cash sleeve across all buckets vs. next 2 years of
          actual portfolio withdrawals — net of SS, pension, wages). */}
      {allocationGuidance && allocationGuidance.totalWithdrawn > 0 && (
        <section className="mb-8 rounded-[28px] border border-stone-200 bg-white/80 p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Allocation · what should sit where
            </p>
          </div>
          <p className="mt-3 text-sm text-stone-700">
            Over the next {allocationGuidance.horizonYears} years your plan
            pulls about{' '}
            <span className="font-semibold tabular-nums text-stone-900">
              {formatCurrency(Math.round(allocationGuidance.totalWithdrawn))}
            </span>{' '}
            from your portfolio. Here&rsquo;s how the buckets line up against
            that draw — useful to share with your stock advisor.
          </p>

          {/* Bucket need-vs-have table */}
          <div className="mt-4 overflow-hidden rounded-2xl border border-stone-100">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-[10px] uppercase tracking-[0.14em] text-stone-500">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Bucket</th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Balance now
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Needed next {allocationGuidance.horizonYears}y
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Cushion
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-stone-800">
                {(
                  [
                    {
                      key: 'pretax' as const,
                      label: 'Pre-tax (IRA / 401k)',
                      dot: 'bg-blue-500',
                    },
                    { key: 'roth' as const, label: 'Roth', dot: 'bg-emerald-500' },
                    {
                      key: 'taxable' as const,
                      label: 'Taxable',
                      dot: 'bg-amber-500',
                    },
                    { key: 'cash' as const, label: 'Cash', dot: 'bg-stone-500' },
                  ]
                ).map((b) => {
                  const have = allocationGuidance.have[b.key];
                  const need = allocationGuidance.need[b.key];
                  const cushion = have - need;
                  return (
                    <tr key={b.key}>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${b.dot}`} />
                          {b.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(Math.round(have))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {need > 0 ? formatCurrency(Math.round(need)) : '—'}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          cushion >= 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {cushion >= 0 ? '+' : '−'}
                        {formatCurrency(Math.abs(Math.round(cushion)))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Safety reserve guidance — measured against the *liquid runway*
              (cash + bond/MM exposure across all buckets), not just the
              cash account, and against 2 years of *portfolio withdrawals*
              rather than 2 years of gross spending. SS / pension / wages
              cover most of the spending; the reserve only has to bridge
              what the portfolio actually pays. */}
          <div className="mt-4 rounded-2xl border border-stone-100 bg-stone-50/60 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Safety reserve · {allocationGuidance.reserveHorizonYears} years of portfolio draws
            </p>
            <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs text-stone-500">
                  Target ({allocationGuidance.reserveHorizonYears}y of withdrawals)
                </p>
                <p className="text-base font-semibold tabular-nums text-stone-900">
                  {formatCurrency(
                    Math.round(allocationGuidance.twoYearReserveTarget),
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-stone-500">Liquid runway (cash + bonds)</p>
                <p className="text-base font-semibold tabular-nums text-stone-900">
                  {formatCurrency(
                    Math.round(allocationGuidance.liquidRunwayTotal),
                  )}
                </p>
                <p className="mt-0.5 text-[11px] text-stone-500">
                  of which cash + taxable bonds:{' '}
                  {formatCurrency(
                    Math.round(allocationGuidance.liquidRunwayTaxFree),
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-stone-500">Pure cash</p>
                <p className="text-base font-semibold tabular-nums text-stone-900">
                  {formatCurrency(Math.round(allocationGuidance.have.cash))}
                </p>
              </div>
            </div>
            {/* Honest source-of-funds. The total liquid runway (any-bucket
                bonds + cash) is the right defense against sequence risk;
                the tax-free runway is a tighter check for "can I tap this
                without triggering ordinary-income consequences this year?". */}
            {(() => {
              const {
                reserveGap,
                reserveGapTaxFree,
                taxableCushion,
              } = allocationGuidance;
              if (reserveGap <= 0) {
                return (
                  <p className="mt-3 text-sm leading-relaxed text-emerald-700">
                    Reserve covered — your bond/cash sleeve across all
                    buckets carries roughly{' '}
                    {formatCurrency(Math.round(-reserveGap))} of headroom
                    beyond two years of portfolio draws.
                    {reserveGapTaxFree > 0
                      ? ` Note ${formatCurrency(Math.round(reserveGapTaxFree))} of that comes from pretax/Roth bonds — selling those still requires an account withdrawal, but doesn't force selling equities.`
                      : ' You can also tap it without an IRA withdrawal — taxable cash + bonds alone exceed the target.'}
                  </p>
                );
              }
              if (reserveGapTaxFree <= 0) {
                return (
                  <p className="mt-3 text-sm leading-relaxed text-amber-700">
                    Total liquid runway is short by about{' '}
                    {formatCurrency(Math.round(reserveGap))} versus two
                    years of portfolio draws. Taxable cash + bonds alone
                    cover it, so the gap can be closed without forcing an
                    early IRA/401k withdrawal — worth a conversation with
                    your advisor about which sleeve to draw from first.
                  </p>
                );
              }
              return (
                <p className="mt-3 text-sm leading-relaxed text-amber-700">
                  Liquid runway is short by about{' '}
                  {formatCurrency(Math.round(reserveGap))} versus two years
                  of portfolio draws.{' '}
                  {taxableCushion > 0
                    ? `Taxable has about ${formatCurrency(Math.round(taxableCushion))} of cushion beyond its own planned draws — shifting some of that into bonds or money-market would be the cheapest way to close the gap.`
                    : 'Realistic levers are shifting more of the bond allocation into the buckets you draw from first, or accepting a thinner reserve.'}{' '}
                  Worth a conversation with your advisor.
                </p>
              );
            })()}
          </div>

          <p className="mt-3 text-xs text-stone-500">
            These figures are median plan draws — actual years vary. Use them
            as a planning anchor, not a precise allocation prescription.
          </p>
        </section>
      )}

      {/* ------------------------ Easy to miss ---------------------------- */}
      <section className="rounded-[28px] border border-stone-200 bg-white/80 p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
            Easy to miss · what we&rsquo;re watching
          </p>
        </div>
        {easyToMiss.length === 0 ? (
          <p className="mt-4 text-sm text-stone-600">
            Nothing material on the advisor&rsquo;s watchlist right now —
            either the household is past the high-leverage windows or the
            applicable rules don&rsquo;t fire on your current plan. Re-run
            the simulation in Inspector for a deeper read.
          </p>
        ) : (
          <ol className="mt-5 space-y-4">
            {easyToMiss.map((card) => (
              <li
                key={card.id}
                className="rounded-2xl border border-stone-100 bg-white/90 p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-base font-semibold text-stone-900">
                    {card.title}
                  </p>
                  <p className="whitespace-nowrap text-sm font-semibold text-amber-700">
                    {card.dollarTag}
                  </p>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-stone-600">
                  {card.body}
                </p>
                <div className="mt-3 flex items-center justify-between gap-3">
                  {card.window ? (
                    <p className="text-xs text-stone-500">{card.window}</p>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenSandbox(card.sandboxScenario)}
                    className="rounded-full px-3 py-1 text-xs font-medium text-blue-700 hover:text-blue-900"
                  >
                    {card.sandboxScenario
                      ? 'Try in Sandbox →'
                      : 'Explore in Sandbox →'}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-4 border-t border-stone-100 pt-3 text-[11px] text-stone-500">
          Dollar amounts are advisor estimates — back-of-envelope math, not the
          full Monte Carlo. Open Inspector to see the simulator&rsquo;s
          honest projection for any of these.
        </p>
      </section>

      {/* Audit / recent-months disclosure removed — credit-card / actuals
          ingestion is out of scope for this tool. The household tracks
          spend in their own accounting tool and brings the headline back
          here as a plan input. */}
    </main>
  );
}

/**
 * Sandbox room — scenario builder. The household picks ONE stressor, dials
 * its knob, picks zero or more reactions (each with their own knob), and
 * Sandbox returns a plain-English impact estimate plus a horizontal-bar
 * comparison of unmitigated vs mitigated damage.
 *
 * Scope decision: heuristic estimates only (see sandbox-scenarios.ts for the
 * math). The full Monte Carlo lives in Inspector — Sandbox is the
 * conversation surface, Inspector is the proof. A "Run this in the engine"
 * affordance bridges the two.
 *
 * Single-stressor selection (vs. multi-select) is deliberate: real household
 * conversations are "what if THIS happens?", not "what if all five happen at
 * once?" Compounding stressors is a useful Monte Carlo question and stays in
 * Inspector where the engine handles them honestly.
 *
 * `initialScenario` is the deep-link entry point used by the Advisor's
 * Easy-to-Miss cards — they pre-select a stressor + reaction combo so the
 * household lands in Sandbox already on the right page.
 */
// ─── Sandbox engine run hook ────────────────────────────────────────────────
// Self-contained simulation worker driver for Sandbox. Owns its own worker
// instance and request id, exposes run/cancel + status/progress/result, and
// terminates the worker on unmount. Intentionally NOT plugged into the
// shared simulation cache / fingerprint pipeline used by Plan/Simulation —
// Sandbox runs are short-lived "what if I push this knob" experiments and
// the household leaving the room shouldn't pollute Plan's cache state.

type SandboxRunStatus = 'idle' | 'running' | 'ready' | 'error' | 'cancelled';

interface SandboxRunResult {
  baseline: PathResult;
  stressed: PathResult;
  mitigated: PathResult | null;
  solvedSpendProfile: SolvedSpendProfile | null;
  /** Wall-clock seconds the run took; surfaced in the result panel footer. */
  elapsedSeconds: number;
  /** Mutation notes from the synthesizer, for the diagnostic disclosure. */
  mutationNotes: string[];
}

function useSandboxSimulation() {
  const [status, setStatus] = useState<SandboxRunStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SandboxRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const requestCounterRef = useRef(0);
  const runStartMsRef = useRef(0);
  const pendingNotesRef = useRef<string[]>([]);

  // Always tear down the worker on unmount — leaving it dangling spams
  // postMessages into the void and holds the SeedData primed.
  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const cancel = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (workerRef.current && requestId) {
      const cancelMessage: SimulationWorkerRequest = { type: 'cancel', requestId };
      workerRef.current.postMessage(cancelMessage);
    }
    setStatus('cancelled');
  }, []);

  const run = useCallback((engineRun: ReturnType<typeof buildSandboxEngineRun>) => {
    if (typeof Worker === 'undefined') {
      setError('Worker unavailable in this environment.');
      setStatus('error');
      return;
    }
    // Spin up a fresh worker each run. They're cheap, and a fresh worker
    // means we never have to reason about lingering state from a prior run.
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    const requestId = `sandbox-sim-${requestCounterRef.current++}`;
    activeRequestIdRef.current = requestId;
    runStartMsRef.current = performance.now();
    pendingNotesRef.current = engineRun.mutationNotes;
    setStatus('running');
    setProgress(0);
    setError(null);

    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<SimulationWorkerResponse>) => {
      const msg = event.data;
      if (msg.requestId !== activeRequestIdRef.current) return;
      if (msg.type === 'progress') {
        setProgress(msg.progress);
        return;
      }
      if (msg.type === 'cancelled') {
        setStatus('cancelled');
        return;
      }
      if (msg.type === 'error') {
        setError(msg.error);
        setStatus('error');
        return;
      }
      // 'result' — pathResults is [baseline, stressed, mitigated?] following
      // buildPathResults' convention. Mitigated is only present when
      // selectedResponses is non-empty.
      const [baseline, stressed, mitigated] = msg.pathResults;
      if (!baseline || !stressed) {
        setError('Engine returned an incomplete result set.');
        setStatus('error');
        return;
      }
      setResult({
        baseline,
        stressed,
        mitigated: mitigated ?? null,
        solvedSpendProfile: msg.solvedSpendProfile,
        elapsedSeconds: (performance.now() - runStartMsRef.current) / 1000,
        mutationNotes: pendingNotesRef.current,
      });
      setStatus('ready');
      setProgress(1);
    };

    const runMessage: SimulationWorkerRequest = {
      type: 'run',
      payload: {
        requestId,
        data: engineRun.data,
        assumptions: engineRun.assumptions,
        selectedStressors: engineRun.selectedStressorIds,
        selectedResponses: engineRun.selectedResponseIds,
        stressorKnobs: engineRun.stressorKnobs,
      },
    };
    worker.postMessage(runMessage);
  }, []);

  const reset = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    activeRequestIdRef.current = null;
    setStatus('idle');
    setProgress(0);
    setResult(null);
    setError(null);
  }, []);

  return { status, progress, result, error, run, cancel, reset };
}

/**
 * Translate a reaction + slider value into a "current → new $/mo" line for
 * the mixer row. Returns null for reactions where a dollar before/after is
 * not the right framing (timing levers like delay_retirement / early_ss).
 *
 * Why this lives here: the dollar buckets each reaction touches come from
 * SeedData (optional spend, travel spend, home-sale windfall), which the
 * SandboxRoom already has. Computing the strings inline at the call site
 * would clutter the mixer JSX; computing them in sandbox-scenarios.ts would
 * leak presentation concerns into the data layer.
 */
function computeReactionConcreteImpact(
  reactionId: SandboxReactionId,
  value: number,
  data: SeedData,
): { currentLabel: string; nextLabel?: string } | null {
  const fmtMoPerMo = (n: number) =>
    `$${Math.round(n).toLocaleString()}/mo`;
  const fmtYrPerYr = (n: number) =>
    `$${Math.round(n).toLocaleString()}/yr`;

  switch (reactionId) {
    case 'cut_spending': {
      const current = data.spending?.optionalMonthly ?? 0;
      if (current <= 0) return null;
      const next = current * (1 - Math.max(0, Math.min(100, value)) / 100);
      return {
        currentLabel: `Optional now: ${fmtMoPerMo(current)}`,
        nextLabel: value > 0 ? fmtMoPerMo(next) : undefined,
      };
    }
    case 'cut_travel': {
      const annual = data.spending?.travelEarlyRetirementAnnual ?? 0;
      if (annual <= 0) return null;
      const next = annual * (1 - Math.max(0, Math.min(100, value)) / 100);
      return {
        currentLabel: `Travel now: ${fmtYrPerYr(annual)}`,
        nextLabel: value > 0 ? fmtYrPerYr(next) : undefined,
      };
    }
    case 'defer_travel': {
      const annual = data.spending?.travelEarlyRetirementAnnual ?? 0;
      if (annual <= 0) return null;
      // "Pause" framing: dollars freed = annual × years deferred.
      const yrs = Math.max(0, Math.round(value));
      return {
        currentLabel: `Travel now: ${fmtYrPerYr(annual)}`,
        nextLabel:
          yrs > 0
            ? `paused ${yrs}yr (~${fmtYrPerYr(annual * yrs).replace('/yr', '')} freed)`
            : undefined,
      };
    }
    default:
      // delay_retirement, early_ss, sell_home_early — already self-explanatory
      // from the def.description + the slider value; no $-bucket framing.
      return null;
  }
}

interface SandboxRoomProps {
  data: SeedData;
  assumptions: MarketAssumptions;
  initialScenario: SandboxInitialScenario | null;
  onConsumeInitialScenario: () => void;
  /**
   * The committed plan's solved monthly spend (today's $/mo). Used as the
   * "before" reference in the Sandbox header's Monthly-spend stat so the
   * household can see how a scenario moves their sustainable spend, not
   * just an absolute number with no comparison.
   */
  baselineMonthlySpendNow: number | null;
  /**
   * The committed plan's projected median ending wealth from the baseline
   * (no-stressor) path. Anchors the North Star stat in the Sandbox header
   * so every scenario the household tries reads as "what does this do to
   * the end goal" — the single thing this tool respects that calculators
   * don't.
   */
  baselineMedianEndingWealth: number | null;
}

interface SandboxInitialScenario {
  stressorId: SandboxStressorId;
  /** Optional: knob value for the stressor (else uses the default). */
  stressorKnobValue?: number;
  /** Optional: pre-selected reactions with knob values. */
  reactions?: ScenarioReactionSelection[];
}

function SandboxRoom({
  data,
  assumptions,
  initialScenario,
  onConsumeInitialScenario,
  baselineMonthlySpendNow,
  baselineMedianEndingWealth,
}: SandboxRoomProps) {
  const today = useMemo(() => new Date(), []);

  // Selected stressor + its knob value. Single-select; switching stressors
  // resets the reactions because the applicable list differs per stressor.
  const [stressorId, setStressorId] = useState<SandboxStressorId | null>(null);
  const [stressorKnobValue, setStressorKnobValue] = useState<number>(0);
  const [reactions, setReactions] = useState<ScenarioReactionSelection[]>([]);

  // One-shot deep-link consumption: when Advisor hands us an initial scenario
  // we apply it once, then notify the parent to clear the handoff slot so a
  // refresh / re-mount doesn't keep re-applying it.
  useEffect(() => {
    if (!initialScenario) return;
    const def = getStressorDef(initialScenario.stressorId);
    setStressorId(initialScenario.stressorId);
    setStressorKnobValue(
      initialScenario.stressorKnobValue ?? def.knob?.defaultValue ?? 0,
    );
    setReactions(initialScenario.reactions ?? []);
    onConsumeInitialScenario();
  }, [initialScenario, onConsumeInitialScenario]);

  const stressorDef = stressorId ? getStressorDef(stressorId) : null;

  // Picker-side card click: select-only (no toggle-off). Switching crises
  // resets reactions because the applicable list differs per stressor; the
  // knob defaults to the new crisis's default.
  const selectStressor = (id: SandboxStressorId) => {
    if (stressorId === id) return;
    const def = getStressorDef(id);
    setStressorId(id);
    setStressorKnobValue(def.knob?.defaultValue ?? 0);
    setReactions([]);
  };

  const impact = useMemo(() => {
    if (!stressorId) return null;
    return estimateScenarioImpact({
      data,
      assumptions,
      today,
      stressorId,
      stressorKnobValue,
      reactions,
    });
  }, [data, assumptions, today, stressorId, stressorKnobValue, reactions]);

  // Engine run: lives below the heuristic preview. Knob changes don't auto-
  // re-fire (sims are ~30s) — the user clicks "Run the simulator" and a
  // result sticks until they tweak the knobs again, at which point it's
  // marked stale and they can re-run.
  const sim = useSandboxSimulation();
  // Fingerprint of the current knob state. When it changes after a run, the
  // last engine result is stale and the panel surfaces a re-run prompt.
  const knobsFingerprint = useMemo(
    () =>
      JSON.stringify({
        stressorId,
        stressorKnobValue,
        reactions: reactions.map((r) => [r.id, r.knobValue]),
      }),
    [stressorId, stressorKnobValue, reactions],
  );
  const lastRunFingerprintRef = useRef<string | null>(null);
  const engineResultStale =
    sim.status === 'ready' &&
    lastRunFingerprintRef.current !== null &&
    lastRunFingerprintRef.current !== knobsFingerprint;

  const runEngine = () => {
    if (!stressorId) return;
    const engineRun = buildSandboxEngineRun({
      data,
      assumptions,
      today,
      stressorId,
      stressorKnobValue,
      reactions,
    });
    lastRunFingerprintRef.current = knobsFingerprint;
    sim.run(engineRun);
  };

  /**
   * Auto-tune currently-engaged reactions until heuristic damage hits zero.
   *
   * The household's manual workflow is "nudge sliders until 'With your
   * reactions' lands near $0." That's a target-seek the page can do for
   * them. Binary-search a single scalar α that scales every engaged knob
   * proportionally — preserves the user's chosen mix of levers, just
   * dials them up (or down) together until the offset covers the damage.
   *
   * Why proportional scale instead of independent per-reaction solve:
   * the user already expressed intent by which reactions they enabled
   * and at what relative weight. Independently maxing levers would erase
   * that signal. Linear-in-knob offsets (see `reactionOffset()` in
   * sandbox-scenarios.ts) make the proportional scale well-behaved.
   *
   * Reactions without a knob (`early_ss`) are passed through unchanged.
   * If no knob'd reaction is engaged we can't solve — caller disables
   * the button in that case.
   */
  const solveForBreakeven = () => {
    if (!stressorId || !impact || impact.baselineImpactDollars <= 0) return;
    if (reactions.length === 0) return;

    const knobReactions: Array<{
      id: SandboxReactionId;
      base: number;
      min: number;
      max: number;
      step: number;
    }> = [];
    const fixedReactions: ScenarioReactionSelection[] = [];
    for (const r of reactions) {
      const def = getReactionDef(r.id);
      if (def.knob) {
        // If the row is engaged at 0 (shouldn't happen — mixer drops
        // those), fall back to the knob default so the scale has
        // something to work with.
        const base = r.knobValue > 0 ? r.knobValue : def.knob.defaultValue;
        knobReactions.push({
          id: r.id,
          base,
          min: def.knob.min,
          max: def.knob.max,
          step: def.knob.step,
        });
      } else {
        fixedReactions.push({ id: r.id, knobValue: r.knobValue });
      }
    }
    if (knobReactions.length === 0) return;

    const buildSelection = (alpha: number): ScenarioReactionSelection[] => {
      const scaled = knobReactions.map((k) => {
        const raw = alpha * k.base;
        const stepped = Math.round(raw / k.step) * k.step;
        const clamped = Math.max(k.min, Math.min(k.max, stepped));
        return { id: k.id, knobValue: clamped };
      });
      return [...fixedReactions, ...scaled];
    };

    const evalAlpha = (alpha: number): number =>
      estimateScenarioImpact({
        data,
        assumptions,
        today,
        stressorId,
        stressorKnobValue,
        reactions: buildSelection(alpha),
      }).mitigatedImpactDollars;

    // Find an upper bound that covers the damage. αHi grows until either
    // it lands at zero or every knob is pinned to its max.
    let alphaHi = 1;
    let mitigatedHi = evalAlpha(alphaHi);
    let allPinned = false;
    for (let i = 0; i < 12 && mitigatedHi > 0 && !allPinned; i++) {
      alphaHi *= 2;
      mitigatedHi = evalAlpha(alphaHi);
      allPinned = knobReactions.every((k) => alphaHi * k.base >= k.max);
    }

    // Binary search the smallest α where mitigated == 0. ~25 iterations
    // get us within 1/2^25 of the true root; cheap because each eval is
    // a closed-form arithmetic on the reaction breakdown.
    let lo = 0;
    let hi = alphaHi;
    for (let i = 0; i < 25; i++) {
      const mid = (lo + hi) / 2;
      if (evalAlpha(mid) <= 0) {
        hi = mid;
      } else {
        lo = mid;
      }
    }

    setReactions(buildSelection(hi));
  };

  const reset = () => {
    setStressorId(null);
    setStressorKnobValue(0);
    setReactions([]);
    sim.reset();
    lastRunFingerprintRef.current = null;
  };

  // Engaged-reaction count for the header chip ("+ 2 reactions").
  const engagedReactionCount = reactions.length;

  // Reaction-row toggler factored out — was inlined twice in the old picker /
  // solver views. The mixer manages its own per-row knob state via the slider.
  const updateReactionFromMixer = (
    reactionId: SandboxReactionId,
    next: number,
    hasKnob: boolean,
  ) => {
    if (next === 0) {
      setReactions((prev) => prev.filter((r) => r.id !== reactionId));
      return;
    }
    if (hasKnob) {
      setReactions((prev) => {
        const exists = prev.find((r) => r.id === reactionId);
        if (exists) {
          return prev.map((r) =>
            r.id === reactionId ? { ...r, knobValue: next } : r,
          );
        }
        return [...prev, { id: reactionId, knobValue: next }];
      });
    } else {
      setReactions((prev) => {
        if (prev.some((r) => r.id === reactionId)) return prev;
        return [...prev, { id: reactionId, knobValue: 1 }];
      });
    }
  };

  return (
    <div className="mx-auto max-w-[1280px] px-4 pb-12 sm:px-6 lg:px-8">
      {/*
        ── Fixed header ────────────────────────────────────────────────────
        Always-visible status strip carrying the scenario identity, headline
        numbers, and Run/Cancel control. Stays put as the user scrolls
        through the solver below so they never lose sight of the read.
      */}
      <div className="sticky top-0 z-20 -mx-4 mb-5 border-b border-stone-200 bg-white/85 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <SandboxStickyHeader
          stressorDef={stressorDef}
          stressorKnobValue={stressorKnobValue}
          reactionCount={engagedReactionCount}
          impact={impact}
          simStatus={sim.status}
          simProgress={sim.progress}
          simResult={sim.result}
          isStale={engineResultStale}
          canRun={!!stressorId}
          baselineMonthlySpendNow={baselineMonthlySpendNow}
          baselineMedianEndingWealth={baselineMedianEndingWealth}
          legacyTarget={data.goals?.legacyTargetTodayDollars ?? null}
          onRun={runEngine}
          onCancel={sim.cancel}
          onReset={reset}
          onSolveBreakeven={solveForBreakeven}
          canSolveBreakeven={
            reactions.some((r) => getReactionDef(r.id).knob !== null) &&
            !!impact &&
            impact.baselineImpactDollars > 0
          }
        />
      </div>

      {/*
        ── Crisis row ──────────────────────────────────────────────────────
        Compact pill bar — labels only, no descriptions. Selecting a pill
        reveals the inline knob ("how bad?") and unlocks the reaction
        mixer + results below. No nav stack: everything happens on this
        page.
      */}
      <section className="mb-5">
        <div className="flex flex-wrap gap-2">
          {SANDBOX_STRESSORS.map((s) => {
            const isSelected = stressorId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => selectStressor(s.id)}
                aria-pressed={isSelected}
                className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                  isSelected
                    ? 'border-stone-900 bg-stone-900 text-stone-50'
                    : 'border-stone-300 bg-white text-stone-800 hover:border-stone-500'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Inline knob — appears only when a crisis is selected */}
        {stressorDef?.knob && (
          <div className="mt-3 flex items-center gap-3 rounded-2xl border border-stone-200 bg-white/70 px-4 py-3">
            <span className="text-sm font-medium text-stone-700">
              {stressorDef.knob.label}
            </span>
            <input
              type="range"
              min={stressorDef.knob.min}
              max={stressorDef.knob.max}
              step={stressorDef.knob.step}
              value={stressorKnobValue}
              onChange={(e) => setStressorKnobValue(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-16 shrink-0 text-right text-sm tabular-nums text-stone-700">
              {stressorKnobValue}
              {stressorDef.knob.unit}
            </span>
          </div>
        )}
      </section>

      {/*
        ── Solver ──────────────────────────────────────────────────────────
        Reactions on the left, results on the right. Hidden until a crisis
        is selected (no point showing empty levers).
      */}
      {stressorDef ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
          {/* Reactions mixer — no header, no descriptions, just the rows. */}
          <div className="space-y-3">
            <div className="divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white/80">
              {stressorDef.applicableReactions.map((reactionId) => {
                const def = getReactionDef(reactionId);
                const selected = reactions.find((r) => r.id === reactionId);
                const value = selected?.knobValue ?? 0;
                const engaged = def.knob ? value > 0 : !!selected;
                const concreteImpact = computeReactionConcreteImpact(
                  reactionId,
                  value,
                  data,
                );
                return (
                  <ReactionMixerRow
                    key={reactionId}
                    def={def}
                    value={value}
                    engaged={engaged}
                    concreteImpact={concreteImpact}
                    onChange={(next) =>
                      updateReactionFromMixer(reactionId, next, !!def.knob)
                    }
                  />
                );
              })}
            </div>
            <p className="px-1 text-[11px] italic text-stone-500">
              Essentials never on the table.
            </p>
          </div>

          {/* Results column */}
          <div className="space-y-4">
            {impact && (
              <SandboxResultPanel
                stressorLabel={stressorDef.label}
                impact={impact}
                onReset={reset}
              />
            )}
            <SandboxEngineSection
              stressorLabel={stressorDef.label}
              status={sim.status}
              progress={sim.progress}
              result={sim.result}
              error={sim.error}
              isStale={engineResultStale}
              onRun={runEngine}
              onCancel={sim.cancel}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Result block for the Sandbox. Shows the plain-English summary, a per-
 * reaction breakdown so the household can see where the offset comes from,
 * and a two-bar visual comparing unmitigated to mitigated damage.
 *
 * Bar visual rather than a line chart: the heuristic estimate is a single
 * dollar number, not a time series, and a fake time-series chart would
 * suggest precision the math doesn't have. The bar is honest.
 */

/**
 * Sticky status strip that rides at the top of the Sandbox screen as the
 * household tweaks knobs below. It carries three things at all times:
 *   • What scenario is loaded (label + knob value + reaction count)
 *   • The best-available headline numbers — heuristic dollars before the
 *     engine has run, real success% / median legacy after it has
 *   • The Run / Cancel control + a Clear-scenario escape hatch
 *
 * Why sticky and not a fixed page header: the rest of the app uses scrolling
 * non-sticky chrome, so a position:fixed bar would float over other rooms
 * after navigation. `sticky top-0` glues it to the top of the Sandbox view
 * and unsticks naturally when the user leaves.
 */
function SandboxStickyHeader({
  stressorDef,
  stressorKnobValue,
  reactionCount,
  impact,
  simStatus,
  simProgress,
  simResult,
  isStale,
  canRun,
  baselineMonthlySpendNow,
  baselineMedianEndingWealth,
  legacyTarget,
  onRun,
  onCancel,
  onReset,
  onSolveBreakeven,
  canSolveBreakeven,
}: {
  stressorDef: ReturnType<typeof getStressorDef> | null;
  stressorKnobValue: number;
  reactionCount: number;
  impact: ScenarioImpact | null;
  simStatus: SandboxRunStatus;
  simProgress: number;
  simResult: SandboxRunResult | null;
  isStale: boolean;
  canRun: boolean;
  /** Committed-plan monthly spend; used as the "before" reference. */
  baselineMonthlySpendNow: number | null;
  /** Committed-plan median ending wealth — anchors the North Star compare. */
  baselineMedianEndingWealth: number | null;
  /** Household-stated end-of-plan target (today $). Null when unset. */
  legacyTarget: number | null;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
  /** Auto-tune engaged reaction knobs to neutralize heuristic damage. */
  onSolveBreakeven: () => void;
  /** Solver enabled only when there's damage AND a knob'd reaction engaged. */
  canSolveBreakeven: boolean;
}) {
  const formatPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const formatDollars = (n: number) => {
    const abs = Math.abs(Math.round(n));
    if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `$${Math.round(n / 1_000)}k`;
    return `$${Math.round(n)}`;
  };
  const formatDeltaPp = (next: number, base: number) => {
    const delta = next - base;
    const sign = delta > 0 ? '+' : delta < 0 ? '' : '±';
    return `${sign}${(delta * 100).toFixed(1)}pp`;
  };
  const formatDeltaDollars = (next: number, base: number) => {
    const delta = next - base;
    const abs = Math.abs(Math.round(delta));
    const prefix = delta > 0 ? '+' : delta < 0 ? '−' : '±';
    if (abs >= 1_000_000) return `${prefix}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${prefix}$${Math.round(abs / 1_000)}k`;
    return `${prefix}$${abs}`;
  };

  // ── Empty state: no stressor selected ─────────────────────────────────────
  if (!stressorDef) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
            Sandbox
          </p>
          <p className="text-sm text-stone-700">
            Pick a stressor below to start a what-if.
          </p>
        </div>
      </div>
    );
  }

  const knobChip = stressorDef.knob
    ? `${stressorKnobValue}${stressorDef.knob.unit}`
    : null;
  const reactionChip =
    reactionCount > 0
      ? `+ ${reactionCount} reaction${reactionCount === 1 ? '' : 's'}`
      : null;

  // Decide which numbers to surface in the headline. Engine result wins when
  // available; heuristic dollars fill in until the user runs the sim.
  const useEngineNumbers = simResult !== null;

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      {/* LEFT: scenario identity */}
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
          Scenario
        </p>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="truncate text-base font-semibold text-stone-900">
            {stressorDef.label}
          </p>
          {knobChip && (
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
              {knobChip}
            </span>
          )}
          {reactionChip && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
              {reactionChip}
            </span>
          )}
          {isStale && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              stale
            </span>
          )}
        </div>
      </div>

      {/* MIDDLE: headline numbers (engine if available, heuristic otherwise) */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {useEngineNumbers ? (
          <>
            <HeaderStat
              label="Success"
              base={formatPct(simResult.baseline.successRate)}
              now={formatPct(
                (simResult.mitigated ?? simResult.stressed).successRate,
              )}
              delta={formatDeltaPp(
                (simResult.mitigated ?? simResult.stressed).successRate,
                simResult.baseline.successRate,
              )}
            />
            {(() => {
              const nowLegacy = (simResult.mitigated ?? simResult.stressed).medianEndingWealth;
              const gapToTarget = legacyTarget !== null ? nowLegacy - legacyTarget : null;
              return (
                <HeaderStat
                  label="Legacy"
                  base={formatDollars(simResult.baseline.medianEndingWealth)}
                  now={formatDollars(nowLegacy)}
                  delta={formatDeltaDollars(
                    nowLegacy,
                    simResult.baseline.medianEndingWealth,
                  )}
                  caption={
                    gapToTarget === null
                      ? undefined
                      : `vs goal ${gapToTarget >= 0 ? '+' : '−'}${formatDollars(Math.abs(gapToTarget))}`
                  }
                  captionTone={
                    gapToTarget === null
                      ? 'neutral'
                      : gapToTarget >= 0
                        ? 'positive'
                        : 'negative'
                  }
                />
              );
            })()}
            {simResult.solvedSpendProfile && (
              <HeaderStat
                label="Monthly spend"
                base={
                  baselineMonthlySpendNow !== null
                    ? formatDollars(baselineMonthlySpendNow)
                    : ''
                }
                now={formatDollars(simResult.solvedSpendProfile.monthlySpendNow)}
                delta={
                  baselineMonthlySpendNow !== null
                    ? formatDeltaDollars(
                        simResult.solvedSpendProfile.monthlySpendNow,
                        baselineMonthlySpendNow,
                      )
                    : 'solver'
                }
              />
            )}
          </>
        ) : impact ? (
          <>
            <HeaderStat
              label="Unmitigated"
              base=""
              now={formatDollars(impact.baselineImpactDollars)}
              delta="estimate"
            />
            <HeaderStat
              label="With reactions"
              base=""
              now={formatDollars(impact.mitigatedImpactDollars)}
              delta="estimate"
            />
            {/* Pre-run Legacy stat — surfaces the household's North Star
                target alongside the heuristic damage so they see the goal
                being threatened before the engine confirms it. */}
            {legacyTarget !== null && baselineMedianEndingWealth !== null && (
              <HeaderStat
                label="Legacy goal"
                base={formatDollars(baselineMedianEndingWealth)}
                now={formatDollars(legacyTarget)}
                delta="target"
                caption={(() => {
                  const gap = baselineMedianEndingWealth - legacyTarget;
                  return `${gap >= 0 ? '+' : '−'}${formatDollars(Math.abs(gap))} cushion at median`;
                })()}
                captionTone={
                  baselineMedianEndingWealth >= legacyTarget ? 'positive' : 'negative'
                }
              />
            )}
          </>
        ) : null}
      </div>

      {/* RIGHT: run / cancel + escape hatch */}
      <div className="flex shrink-0 items-center gap-2">
        {simStatus === 'running' ? (
          <>
            <div className="flex h-8 w-32 items-center overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full bg-amber-500 transition-all duration-300"
                style={{
                  width: `${Math.min(100, Math.round(simProgress * 100))}%`,
                }}
              />
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-700 hover:text-stone-900"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onSolveBreakeven}
              disabled={!canSolveBreakeven}
              title={
                canSolveBreakeven
                  ? 'Auto-tune the engaged reactions until heuristic damage hits zero'
                  : 'Engage at least one reaction with a slider to enable the solver'
              }
              className={`rounded-full px-3 py-2 text-xs font-medium transition ${
                canSolveBreakeven
                  ? 'border border-stone-300 bg-white text-stone-800 hover:border-stone-500'
                  : 'cursor-not-allowed border border-stone-200 bg-stone-100 text-stone-400'
              }`}
            >
              Solve for break-even
            </button>
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                canRun
                  ? 'bg-stone-900 text-stone-50 hover:bg-stone-700'
                  : 'cursor-not-allowed bg-stone-200 text-stone-400'
              }`}
            >
              {simResult ? 'Re-run' : 'Run sim →'}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onReset}
          className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 hover:text-stone-800"
          title="Clear scenario"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/**
 * Compact stat block for the sticky header. Shows current value bold,
 * baseline as a faint "from $X" label, and a delta chip on the right.
 * Empty `base` collapses the "from" line — used for heuristic-mode
 * numbers where there's no baseline-vs-scenario pair to compare.
 *
 * `caption` adds a second line below the headline numbers — used by the
 * Legacy stat to show "vs target: ±$X" when the household has set a
 * North Star goal. `captionTone` colorizes it (positive = on track,
 * negative = short of target).
 */
function HeaderStat({
  label,
  base,
  now,
  delta,
  caption,
  captionTone,
}: {
  label: string;
  base: string;
  now: string;
  delta: string;
  caption?: string;
  captionTone?: 'positive' | 'negative' | 'neutral';
}) {
  const captionClass =
    captionTone === 'positive'
      ? 'text-emerald-700'
      : captionTone === 'negative'
        ? 'text-rose-700'
        : 'text-stone-500';
  return (
    <div className="leading-tight">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        {base && (
          <span className="text-xs tabular-nums text-stone-400">
            {base} →
          </span>
        )}
        <span className="text-base font-semibold tabular-nums text-stone-900">
          {now}
        </span>
        <span className="text-[11px] font-medium tabular-nums text-stone-500">
          {delta}
        </span>
      </div>
      {caption && (
        <p className={`text-[10px] font-medium tabular-nums ${captionClass}`}>
          {caption}
        </p>
      )}
    </div>
  );
}

function SandboxResultPanel({
  stressorLabel,
  impact,
  onReset,
}: {
  stressorLabel: string;
  impact: ScenarioImpact;
  onReset: () => void;
}) {
  const { baselineImpactDollars, mitigatedImpactDollars, summary, reactionBreakdown } =
    impact;
  // Bar widths: scale to baseline so "fully offset" reads as a tiny bar
  // rather than zero (which feels like nothing happened).
  const baselineWidth = baselineImpactDollars > 0 ? '100%' : '0%';
  const mitigatedWidth =
    baselineImpactDollars > 0
      ? `${Math.max(2, (mitigatedImpactDollars / baselineImpactDollars) * 100)}%`
      : '0%';
  const formatBig = (n: number): string => {
    const abs = Math.abs(Math.round(n));
    if (abs >= 1_000_000) return `~$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `~$${Math.round(abs / 1_000)}k`;
    return `~$${abs}`;
  };

  return (
    <section className="mb-8 rounded-[28px] border border-stone-200 bg-white/80 p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">
          Estimated impact
        </p>
      </div>

      <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-stone-800">
        {summary}
      </p>

      {/* Two-bar comparison */}
      {baselineImpactDollars > 0 && (
        <div className="mt-5 space-y-4">
          <div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-stone-800">
                {stressorLabel}, no reaction
              </span>
              <span className="tabular-nums font-semibold text-rose-700">
                {formatBig(baselineImpactDollars)}
              </span>
            </div>
            <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full bg-rose-500"
                style={{ width: baselineWidth }}
              />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-stone-800">
                With your reactions
              </span>
              <span className="tabular-nums font-semibold text-emerald-700">
                {formatBig(mitigatedImpactDollars)}
              </span>
            </div>
            <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full bg-emerald-500"
                style={{ width: mitigatedWidth }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Per-reaction breakdown — only show when there are reactions */}
      {reactionBreakdown.length > 0 && (
        <ol className="mt-5 space-y-2 border-t border-stone-100 pt-4 text-sm">
          {reactionBreakdown.map((r) => (
            <li key={r.id} className="text-stone-700">
              <span className="font-medium text-stone-900">{r.label}</span>
              <span className="text-stone-500"> · </span>
              <span>{r.note}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-5 flex items-center justify-between border-t border-stone-100 pt-4">
        <p className="text-[11px] text-stone-500">
          Back-of-envelope estimate. Run the simulator below for the honest
          Monte Carlo projection.
        </p>
        <button
          type="button"
          onClick={onReset}
          className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-700 hover:text-stone-900"
        >
          Clear scenario
        </button>
      </div>
    </section>
  );
}

/**
 * Sandbox's "real engine" panel — sits below the heuristic preview. Owns its
 * own run lifecycle: idle ⇒ "Run the simulator" CTA, running ⇒ progress bar
 * + cancel, ready ⇒ baseline-vs-scenario(-vs-mitigated) success/wealth cards
 * with a stale-state indicator when the user tweaks knobs after a run.
 *
 * Honesty principles for the result panel:
 *   - Always show baseline alongside scenario so deltas are obvious
 *   - Show wall-clock time and trial count so the household sees this is
 *     a measured number, not a guess
 *   - Surface the "what we mutated" disclosure so the engine treatment is
 *     auditable (especially important for market_down, where we swap a
 *     true sequence-of-returns event for an instant-haircut approximation)
 */
function SandboxEngineSection({
  stressorLabel,
  status,
  progress,
  result,
  error,
  isStale,
  onRun,
  onCancel,
}: {
  stressorLabel: string;
  status: SandboxRunStatus;
  progress: number;
  result: SandboxRunResult | null;
  error: string | null;
  isStale: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  const formatPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const formatDollars = (n: number) => {
    const abs = Math.abs(Math.round(n));
    if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `$${Math.round(n / 1_000)}k`;
    return `$${Math.round(n)}`;
  };
  const formatPctDelta = (next: number, base: number) => {
    const delta = next - base;
    const sign = delta > 0 ? '+' : delta < 0 ? '' : '±';
    return `${sign}${(delta * 100).toFixed(1)}pp`;
  };
  const formatDollarDelta = (next: number, base: number) => {
    const delta = next - base;
    const abs = Math.abs(Math.round(delta));
    const prefix = delta > 0 ? '+' : delta < 0 ? '−' : '±';
    if (abs >= 1_000_000) return `${prefix}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${prefix}$${Math.round(abs / 1_000)}k`;
    return `${prefix}$${abs}`;
  };

  return (
    <section className="mb-8 rounded-[28px] border border-stone-200 bg-white/80 p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
          Honest sim · monte carlo
        </p>
      </div>

      {/*
        Idle/running/cancelled/error states: the sticky header already owns
        the Run button, Cancel button, and progress bar — we don't repeat
        them here. This panel just narrates state for context.
      */}
      {status === 'idle' && (
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
          The estimate above is a back-of-envelope read. Hit{' '}
          <strong>Run sim</strong> in the header for the honest Monte Carlo
          (about <strong>30 seconds</strong>).
        </p>
      )}
      {status === 'running' && (
        <p className="mt-3 text-sm text-stone-600">
          Running {stressorLabel.toLowerCase()} scenario… {Math.round(progress * 100)}%
        </p>
      )}
      {status === 'cancelled' && (
        <p className="mt-3 text-sm text-stone-600">
          Cancelled — re-run from the header when you&rsquo;re ready.
        </p>
      )}
      {status === 'error' && (
        <p className="mt-3 text-sm text-rose-700">
          Simulation failed: {error ?? 'unknown error'}
        </p>
      )}

      {/* READY — show baseline vs scenario vs mitigated */}
      {status === 'ready' && result && (
        <div className="mt-4 space-y-5">
          {isStale && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
              <p className="text-xs text-amber-900">
                Knob values changed since this run — results may be stale.
              </p>
              <button
                type="button"
                onClick={onRun}
                className="rounded-full bg-amber-700 px-3 py-1 text-xs font-medium text-amber-50 hover:bg-amber-800"
              >
                Re-run
              </button>
            </div>
          )}

          {/* Success-rate row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <EngineMetricCard
              label="Baseline"
              accent="stone"
              primary={formatPct(result.baseline.successRate)}
              primaryLabel="plan success"
              secondary={formatDollars(result.baseline.medianEndingWealth)}
              secondaryLabel="median legacy"
            />
            <EngineMetricCard
              label="With stressor"
              accent="rose"
              primary={formatPct(result.stressed.successRate)}
              primaryLabel="plan success"
              primaryDelta={formatPctDelta(
                result.stressed.successRate,
                result.baseline.successRate,
              )}
              secondary={formatDollars(result.stressed.medianEndingWealth)}
              secondaryLabel="median legacy"
              secondaryDelta={formatDollarDelta(
                result.stressed.medianEndingWealth,
                result.baseline.medianEndingWealth,
              )}
            />
            {result.mitigated ? (
              <EngineMetricCard
                label="With your reactions"
                accent="emerald"
                primary={formatPct(result.mitigated.successRate)}
                primaryLabel="plan success"
                primaryDelta={formatPctDelta(
                  result.mitigated.successRate,
                  result.baseline.successRate,
                )}
                secondary={formatDollars(result.mitigated.medianEndingWealth)}
                secondaryLabel="median legacy"
                secondaryDelta={formatDollarDelta(
                  result.mitigated.medianEndingWealth,
                  result.baseline.medianEndingWealth,
                )}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-stone-300 bg-white/40 p-4">
                <p className="text-xs text-stone-500">
                  Pick one or more reactions to see how they offset the
                  scenario.
                </p>
              </div>
            )}
          </div>

          {/* Solved spend headline (if solver succeeded) */}
          {result.solvedSpendProfile && (
            <div className="rounded-2xl bg-stone-50 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-600">
                Sustainable monthly spend (
                {Math.round(result.solvedSpendProfile.successTarget * 100)}%
                target)
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                ${Math.round(result.solvedSpendProfile.monthlySpendNow).toLocaleString()}
                <span className="ml-2 align-middle text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
                  / mo
                </span>
              </p>
              <p className="mt-1 text-xs text-stone-600">
                Achieved {formatPct(result.solvedSpendProfile.achievedSuccess)}{' '}
                success at this constant-real spend.
              </p>
            </div>
          )}

          {/* Diagnostic disclosure: what we mutated */}
          {result.mutationNotes.length > 0 && (
            <details className="rounded-xl bg-stone-50/80 px-4 py-3 text-xs text-stone-700">
              <summary className="cursor-pointer font-medium text-stone-800">
                What the engine actually ran
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {result.mutationNotes.map((note, idx) => (
                  <li key={idx}>{note}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex items-center justify-between border-t border-stone-100 pt-3">
            <p className="text-[11px] text-stone-500">
              Real Monte Carlo · {result.elapsedSeconds.toFixed(1)}s ·{' '}
              {result.baseline.successRate !== undefined
                ? 'measured, not estimated'
                : ''}
            </p>
            <button
              type="button"
              onClick={onRun}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-700 hover:text-stone-900"
            >
              Re-run
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * One row in the Sandbox reaction mixing board. Always rendered (no
 * "click to enable" gate) — engagement comes from the slider being above 0.
 *
 * Visual treatment:
 *   - Engaged rows tint emerald + show the dialed value in green
 *   - Idle rows stay neutral so the engaged ones pop
 *   - The slider track shows a colored fill that grows with the value
 *     (custom CSS via background gradient on the input — keeps the row
 *     compact without needing a separate progress div)
 */
function ReactionMixerRow({
  def,
  value,
  engaged,
  onChange,
  concreteImpact,
}: {
  def: ReturnType<typeof getReactionDef>;
  value: number;
  engaged: boolean;
  onChange: (next: number) => void;
  /**
   * Optional plain-English "current → new" line that appears under the
   * description while the row is engaged. For dollar-bucket reactions
   * (`cut_spending`, `cut_travel`) the parent computes the live before/after
   * so the household sees real numbers as they slide instead of just a
   * percentage.
   */
  concreteImpact?: { currentLabel: string; nextLabel?: string } | null;
}) {
  const knob = def.knob;
  // Slider goes from 0 → max so 0 is "off" without needing a separate
  // toggle. Below the def.knob.min would be a partial step; step still
  // applies, so values snap (e.g. 0 → 5 → 10 for cut_spending).
  const sliderMin = 0;
  const sliderMax = knob?.max ?? 1;
  const sliderStep = knob?.step ?? 1;
  const fillPct = sliderMax > 0 ? (value / sliderMax) * 100 : 0;
  return (
    <div
      className={`flex flex-col gap-2 px-4 py-3 transition-colors sm:flex-row sm:items-center sm:gap-4 ${
        engaged ? 'bg-emerald-50/60' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-semibold ${
            engaged ? 'text-emerald-900' : 'text-stone-900'
          }`}
        >
          {def.label}
        </p>
        {concreteImpact && (
          <p
            className={`mt-0.5 text-xs tabular-nums ${
              engaged ? 'text-emerald-800' : 'text-stone-500'
            }`}
          >
            {concreteImpact.currentLabel}
            {concreteImpact.nextLabel && (
              <>
                {' '}
                <span aria-hidden>→</span>{' '}
                <span
                  className={engaged ? 'font-semibold' : ''}
                >
                  {concreteImpact.nextLabel}
                </span>
              </>
            )}
          </p>
        )}
      </div>
      {knob ? (
        <div className="flex items-center gap-3 sm:w-[260px]">
          <input
            type="range"
            min={sliderMin}
            max={sliderMax}
            step={sliderStep}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            // Inline gradient gives the slider track a colored fill matching
            // the current value without depending on a Tailwind plugin.
            style={{
              background: `linear-gradient(to right, ${
                engaged ? '#10b981' : '#a8a29e'
              } 0%, ${engaged ? '#10b981' : '#a8a29e'} ${fillPct}%, #e7e5e4 ${fillPct}%, #e7e5e4 100%)`,
            }}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full"
          />
          <span
            className={`w-16 shrink-0 text-right text-sm tabular-nums ${
              engaged ? 'font-semibold text-emerald-700' : 'text-stone-400'
            }`}
          >
            {engaged ? `${value}${knob.unit}` : 'off'}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onChange(engaged ? 0 : 1)}
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            engaged
              ? 'bg-emerald-600 text-emerald-50 hover:bg-emerald-700'
              : 'bg-stone-200 text-stone-600 hover:bg-stone-300'
          }`}
        >
          {engaged ? 'on' : 'off'}
        </button>
      )}
    </div>
  );
}

function EngineMetricCard({
  label,
  accent,
  primary,
  primaryLabel,
  primaryDelta,
  secondary,
  secondaryLabel,
  secondaryDelta,
}: {
  label: string;
  accent: 'stone' | 'rose' | 'emerald';
  primary: string;
  primaryLabel: string;
  primaryDelta?: string;
  secondary: string;
  secondaryLabel: string;
  secondaryDelta?: string;
}) {
  // Tailwind's JIT needs concrete class names — can't interpolate accent
  // into bg-${accent}-500 because the safelist won't pick it up.
  const accentClasses = {
    stone: { dot: 'bg-stone-400', delta: 'text-stone-600' },
    rose: { dot: 'bg-rose-500', delta: 'text-rose-700' },
    emerald: { dot: 'bg-emerald-500', delta: 'text-emerald-700' },
  }[accent];
  return (
    <div className="rounded-2xl border border-stone-200 bg-white/90 p-4">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${accentClasses.dot}`} />
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-600">
          {label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-stone-900">
        {primary}
        {primaryDelta && (
          <span className={`ml-2 align-middle text-xs font-medium ${accentClasses.delta}`}>
            {primaryDelta}
          </span>
        )}
      </p>
      <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
        {primaryLabel}
      </p>
      <p className="mt-3 text-sm tabular-nums text-stone-700">
        {secondary}
        {secondaryDelta && (
          <span className={`ml-1.5 text-xs ${accentClasses.delta}`}>
            {secondaryDelta}
          </span>
        )}
      </p>
      <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
        {secondaryLabel}
      </p>
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
        subtitle="This shell is built around the idea that retirement is a set of paths, not a single forecast. The current household inputs show where the plan looks resilient and where it still depends on favorable timing."
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
  const spendSolverStressorKnobs = useAppStore(
    (state) => state.draftStressorKnobs,
  );
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
      void (async () => {
        try {
          const solved = await solveSpendByReverseTimeline({
            data,
            assumptions: getInteractiveSolverAssumptions(assumptions),
            selectedStressors,
            selectedResponses,
            stressorKnobs: spendSolverStressorKnobs,
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
      })();
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

function getEffectiveInheritanceYear(
  data: SeedData,
  selectedStressors: string[],
  delayedInheritanceYears: number = 5,
) {
  const inheritance = data.income.windfalls.find((item) => item.name === 'inheritance');
  if (!inheritance) {
    return null;
  }
  const delayedYears = selectedStressors.includes('delayed_inheritance')
    ? Math.max(1, Math.round(delayedInheritanceYears))
    : 0;
  return inheritance.year + delayedYears;
}

function buildAutopilotWealthTimelineViewModel({
  result,
  data,
  selectedStressors,
  delayedInheritanceYears,
}: {
  result: AutopilotPlanResult;
  data: SeedData;
  selectedStressors: string[];
  delayedInheritanceYears?: number;
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

  const inheritanceYear = getEffectiveInheritanceYear(
    data,
    selectedStressors,
    delayedInheritanceYears,
  );
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
  const delayedInheritanceYears = useAppStore(
    (state) => state.appliedStressorKnobs.delayedInheritanceYears,
  );
  const timeline = useMemo(
    () =>
      buildAutopilotWealthTimelineViewModel({
        result,
        data,
        selectedStressors,
        delayedInheritanceYears,
      }),
    [data, delayedInheritanceYears, result, selectedStressors],
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
  const delayedInheritanceYearsKnob = useAppStore(
    (state) => state.draftStressorKnobs.delayedInheritanceYears,
  );
  const layoffRetireDateKnob = useAppStore(
    (state) => state.draftStressorKnobs.layoffRetireDate,
  );
  const layoffSeveranceKnob = useAppStore(
    (state) => state.draftStressorKnobs.layoffSeverance,
  );

  const runAutopilot = () => {
    if (isRunning) {
      perfLog('retirement-plan', 'skip duplicate autopilot run');
      return;
    }
    setError(null);
    setIsRunning(true);
    setResult(null);

    nextPaint(() => {
      void (async () => {
        try {
          const plan = await generateAutopilotPlan({
            data,
            assumptions: getInteractiveSolverAssumptions(assumptions),
            selectedStressors,
            selectedResponses,
            targetLegacyTodayDollars: Math.max(0, targetLegacy),
            minSuccessRate: clampRate(minSuccessRatePercent / 100),
            doNotSellPrimaryResidence,
            successRateRange: undefined,
            stressorKnobs: {
              delayedInheritanceYears: delayedInheritanceYearsKnob,
              layoffRetireDate: layoffRetireDateKnob,
              layoffSeverance: layoffSeveranceKnob,
            },
          });
          setResult(plan);
        } catch (autopilotError) {
          setError(
            autopilotError instanceof Error ? autopilotError.message : 'Autopilot generation failed.',
          );
        } finally {
          setIsRunning(false);
        }
      })();
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

const TWEAK_COPY: Record<string, { name: string; hint: string }> = {
  layoff: {
    name: 'Laid off early',
    hint: 'Your salary ends before your planned retirement date.',
  },
  market_down: {
    name: 'Bad first 3 years',
    hint: 'Equity returns of −18%, −12%, −8% right at retirement.',
  },
  market_up: {
    name: 'Strong early market',
    hint: 'Upside case: equities run +12%, +10%, +8% early on.',
  },
  inflation: {
    name: 'High inflation for a decade',
    hint: '5% inflation sustained for 10 years.',
  },
  delayed_inheritance: {
    name: 'Inheritance delayed',
    hint: 'Expected inheritance arrives later than planned.',
  },
};

const SOLUTION_COPY: Record<string, { name: string; hint: string }> = {
  cut_spending: {
    name: 'Trim optional spending 20%',
    hint: 'Cut discretionary / optional spending by 20%.',
  },
  sell_home_early: {
    name: 'Sell the house sooner',
    hint: 'Downsize in year 3, freeing up ~$500k.',
  },
  delay_retirement: {
    name: 'Work one more year',
    hint: 'Push retirement out by 12 months.',
  },
  early_ss: {
    name: 'Claim Social Security at 62',
    hint: 'Take SS early instead of waiting to full retirement age.',
  },
  preserve_roth: {
    name: 'Protect the Roth',
    hint: 'Spend from Roth last so it keeps compounding tax-free.',
  },
  increase_cash_buffer: {
    name: 'Beef up cash buffer',
    hint: 'Hold more cash to ride out bad early-retirement markets.',
  },
};

// Return a concrete, data-driven one-liner explaining what the solution actually
// does to *this* plan — e.g. "Moves $500k home sale from 2037 → 2029" rather
// than the generic hint. Falls back to the SOLUTION_COPY hint if we can't
// derive a number.
function describeResponseMechanic(responseId: string, data: SeedData): string {
  const response = data.responses.find((r) => r.id === responseId);
  const fallback = SOLUTION_COPY[responseId]?.hint ?? '';

  if (responseId === 'cut_spending') {
    const pct = response?.optionalReductionPercent ?? 20;
    const monthly = data.spending?.optionalMonthly ?? 0;
    const monthlyCut = Math.round(monthly * (pct / 100));
    const annualCut = monthlyCut * 12;
    if (!monthlyCut) return fallback;
    return `Cuts optional spending by ${pct}% — about ${formatCurrency(monthlyCut)}/mo (${formatCurrency(annualCut)}/yr).`;
  }

  if (responseId === 'sell_home_early') {
    const homeSale = data.income?.windfalls?.find((w) => w.name === 'home_sale');
    const triggerYear = response?.triggerYear ?? 3;
    if (!homeSale) return fallback;
    const newYear = new Date().getFullYear() + triggerYear;
    return `Moves the ${formatCurrency(homeSale.amount)} home sale from ${homeSale.year} → ${newYear} (year ${triggerYear}).`;
  }

  if (responseId === 'delay_retirement') {
    const years = response?.delayYears ?? 1;
    const end = data.income?.salaryEndDate;
    if (!end) return fallback;
    const current = new Date(end);
    const shifted = new Date(current);
    shifted.setFullYear(shifted.getFullYear() + years);
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return `Pushes retirement out ${years} year${years === 1 ? '' : 's'} — salary ends ${fmt(shifted)} instead of ${fmt(current)}.`;
  }

  if (responseId === 'early_ss') {
    const claimAge = response?.claimAge ?? 62;
    const currentAges = data.income?.socialSecurity
      ?.map((s) => s.claimAge)
      .filter((n): n is number => typeof n === 'number');
    if (currentAges && currentAges.length) {
      const minCurrent = Math.min(...currentAges);
      if (minCurrent !== claimAge) {
        return `Claims Social Security at ${claimAge} instead of ${minCurrent}.`;
      }
    }
    return `Claims Social Security at ${claimAge}.`;
  }

  return fallback;
}

function summarizeYearlyEffects(path: PathResult) {
  let lifetimeFedTax = 0;
  let lifetimeRothConverted = 0;
  let irmaaYears = 0;
  let firstConversionYear: number | null = null;
  let lifetimeIrmaaSurcharge = 0;
  for (const y of path.yearlySeries) {
    lifetimeFedTax += y.medianFederalTax ?? 0;
    lifetimeRothConverted += y.medianRothConversion ?? 0;
    lifetimeIrmaaSurcharge += y.medianIrmaaSurcharge ?? 0;
    if ((y.medianIrmaaSurcharge ?? 0) > 0) irmaaYears += 1;
    if (firstConversionYear === null && (y.medianRothConversion ?? 0) > 0) {
      firstConversionYear = y.year;
    }
  }
  return {
    lifetimeFedTax,
    lifetimeRothConverted,
    irmaaYears,
    lifetimeIrmaaSurcharge,
    firstConversionYear,
  };
}

function supportedMonthlyFromPath(path: PathResult): number {
  // Median spending in the first post-retirement year the plan actually supports.
  // Falls back to median of the series if we can't pick a retirement year.
  const firstNonZero = path.yearlySeries.find((y) => (y.medianSpending ?? 0) > 0);
  const spend = firstNonZero?.medianSpending ?? 0;
  return spend / 12;
}

function formatDeltaCurrency(delta: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1) return 'no change';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${formatCurrency(Math.abs(delta))}`;
}

function formatDeltaPercent(delta: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.0005) return 'no change';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${(Math.abs(delta) * 100).toFixed(1)} pts`;
}

function describeSpendDelta(deltaMonthly: number): string {
  if (!Number.isFinite(deltaMonthly) || Math.abs(deltaMonthly) < 5) {
    return 'holds steady at';
  }
  return deltaMonthly < 0 ? 'drops to' : 'rises to';
}

function SimulationScreen({
  assumptions,
  distributionSeries,
  parityReport,
  primaryPath,
  baselinePath,
  solvedSpendProfile,
  baselineSolvedSpendProfile,
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
  suggestionRankingStatus,
  suggestionRankingProgress,
  suggestionRankingError,
  suggestionRankingResults,
  onRunSuggestionRanking,
  onCancelSuggestionRanking,
  onApplySuggestion,
}: {
  assumptions: MarketAssumptions;
  distributionSeries: ReturnType<typeof buildDistributionSeries>;
  parityReport: SimulationParityReport;
  primaryPath: PathResult;
  baselinePath: PathResult;
  solvedSpendProfile: SolvedSpendProfile | null;
  baselineSolvedSpendProfile: SolvedSpendProfile | null;
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
  suggestionRankingStatus: 'idle' | 'running' | 'ready' | 'error';
  suggestionRankingProgress: { completed: number; total: number };
  suggestionRankingError: string | null;
  suggestionRankingResults: {
    baseline: SuggestionBaselineOutcome;
    candidates: SuggestionOutcome[];
    stressorIds: string[];
    fixedResponseIds: string[];
  } | null;
  onRunSuggestionRanking: () => void;
  onCancelSuggestionRanking: () => void;
  onApplySuggestion: (responseId: string) => void;
}) {
  const data = useAppStore((state) => state.data);
  const stressors = useAppStore((state) => state.data.stressors);
  const responses = useAppStore((state) => state.data.responses);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const toggleStressor = useAppStore((state) => state.toggleStressor);
  const toggleResponse = useAppStore((state) => state.toggleResponse);
  const draftStressorKnobs = useAppStore((state) => state.draftStressorKnobs);
  const updateStressorKnob = useAppStore((state) => state.updateStressorKnob);

  // Prefer the solver's constant-real monthly at the 85% success target. It's
  // the "honest" committed number — moves when later-year stressors (like
  // delayed inheritance) erode the sustainable level. Only use it when BOTH
  // sides (baseline + stressed) have a solver result; otherwise we'd be
  // comparing flex pace ($12k) against solved constant-real ($6k), which
  // produces a nonsense delta. Fall back to flex pace on both sides when
  // incomplete.
  const baseMonthlyFlex = supportedMonthlyFromPath(baselinePath);
  const simMonthlyFlex = supportedMonthlyFromPath(primaryPath);
  const usingSolvedNumber =
    solvedSpendProfile !== null && baselineSolvedSpendProfile !== null;
  const baseMonthly = usingSolvedNumber
    ? baselineSolvedSpendProfile.monthlySpendNow
    : baseMonthlyFlex;
  const simMonthly = usingSolvedNumber
    ? solvedSpendProfile.monthlySpendNow
    : simMonthlyFlex;
  const successTarget =
    solvedSpendProfile?.successTarget ?? baselineSolvedSpendProfile?.successTarget ?? 0.85;
  const monthlyDelta = simMonthly - baseMonthly;
  const annualDelta = monthlyDelta * 12;
  const successDelta = primaryPath.successRate - baselinePath.successRate;
  const cutRateDelta = primaryPath.spendingCutRate - baselinePath.spendingCutRate;
  const irmaaRateDelta = primaryPath.irmaaExposureRate - baselinePath.irmaaExposureRate;
  const endingDelta = primaryPath.medianEndingWealth - baselinePath.medianEndingWealth;

  const baseEffects = summarizeYearlyEffects(baselinePath);
  const simEffects = summarizeYearlyEffects(primaryPath);

  const hasToggles = selectedStressors.length + selectedResponses.length > 0;
  const isFresh = simulationStatus === 'fresh';
  const showDelta = hasToggles && isFresh;
  // Distinguish "we have simulation numbers to show" (first run not yet done =>
  // empty sentinel path; don't render the zero-filled EffectRow grid).
  const hasSimulationData =
    primaryPath.medianEndingWealth !== 0 ||
    primaryPath.yearsFunded !== 0 ||
    primaryPath.successRate !== 0;

  const verb = describeSpendDelta(monthlyDelta);
  const spendNumberLabel = usingSolvedNumber
    ? `sustainable monthly spend (${formatPercent(successTarget)} success)`
    : 'starting monthly spend';
  const spendHeadline = showDelta
    ? `Your ${spendNumberLabel} ${verb} ${formatCurrency(Math.round(simMonthly))} (${formatDeltaCurrency(Math.round(monthlyDelta))}/mo, ${formatDeltaCurrency(Math.round(annualDelta))}/yr).`
    : `This input run supports ${formatCurrency(Math.round(baseMonthly))}/mo (${formatCurrency(Math.round(baseMonthly * 12))}/yr) ${usingSolvedNumber ? `at ${formatPercent(successTarget)} success` : 'as a starting pace'}. Tick tweaks or solutions, then Run to see what changes.`;

  const successHeadline = showDelta
    ? `Flex success ${formatDeltaPercent(successDelta)} (now ${formatPercent(primaryPath.successRate)}).`
    : `Flex success: ${formatPercent(baselinePath.successRate)}.`;

  return (
    <Panel
      title="Simulations"
      subtitle="Sandbox. Tweak your model, see what changes in plain English, then commit to Plan if you like it."
    >
      {/* Hero + controls */}
      <div className="mb-6 rounded-[28px] border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
              {showDelta ? 'What changes with your tweaks' : 'Your current plan'}
            </p>
            <p className="mt-2 text-xl font-semibold leading-snug text-stone-900">
              {spendHeadline}
            </p>
            <p className="mt-2 text-sm text-stone-600">{successHeadline}</p>
            {!isFresh && hasToggles ? (
              <p className="mt-2 text-xs text-amber-700">
                Results are out of date — press Run Simulation to refresh.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onRunSimulation}
                disabled={isSimulationRunning}
                className="rounded-full bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSimulationRunning
                  ? `Running… ${Math.round(simulationProgress * 100)}%`
                  : 'Run Simulation'}
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
                  className="rounded-full border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50"
                >
                  Cancel
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-2 text-xs text-stone-500">
              {simulationStatus === 'fresh' ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
                  Fresh
                </span>
              ) : simulationStatus === 'running' ? (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 font-semibold text-blue-800">
                  Running
                </span>
              ) : (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                  Outdated
                </span>
              )}
              {simulationError ? (
                <span className="text-red-700">Error: {simulationError}</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Guardrail zone — where the household stands TODAY against the
          dynamic-withdrawal triggers the engine already simulates inside
          every path. Tells the user "green / yellow / red" in plain English
          and in dollar terms, so the monthly headline stops feeling like a
          fixed verdict and starts feeling like the first reading of a living
          rulebook. */}
      {usingSolvedNumber ? (
        <GuardrailZonePanel
          data={data}
          assumptions={assumptions}
          current={solvedSpendProfile}
        />
      ) : null}

      {/* Retirement smile — shows how real spending tapers through retirement */}
      {usingSolvedNumber ? (
        <SmileCurve
          baseline={baselineSolvedSpendProfile}
          current={solvedSpendProfile}
          showDelta={showDelta}
        />
      ) : null}

      {/* Cemetery card — how much is left at planning horizon across futures */}
      {usingSolvedNumber ? (
        <CemeteryCard current={solvedSpendProfile} />
      ) : null}

      {/* Tweaks & Solutions */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Tweaks</p>
          <p className="mt-1 text-sm text-stone-600">
            Things that might happen to you.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {stressors.map((item) => {
              const copy = TWEAK_COPY[item.id] ?? { name: item.name, hint: '' };
              const checked = selectedStressors.includes(item.id);
              return (
                <label
                  key={item.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-2 transition ${
                    checked
                      ? 'border-blue-300 bg-blue-50/60'
                      : 'border-stone-200 bg-stone-50 hover:bg-stone-100'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    onChange={() => toggleStressor(item.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-stone-900">{copy.name}</span>
                    {copy.hint ? (
                      <span className="block text-xs text-stone-500">{copy.hint}</span>
                    ) : null}
                    {item.id === 'delayed_inheritance' && checked ? (
                      <span className="mt-2 flex items-center gap-2 text-xs text-stone-600">
                        Delay by
                        <input
                          type="number"
                          min={1}
                          max={10}
                          step={1}
                          value={draftStressorKnobs.delayedInheritanceYears}
                          onChange={(event) => {
                            const raw = Number(event.target.value);
                            if (Number.isNaN(raw)) return;
                            const clamped = Math.max(1, Math.min(10, Math.round(raw)));
                            updateStressorKnob('delayedInheritanceYears', clamped);
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="w-14 rounded-md border border-stone-300 bg-white px-2 py-1 text-right text-xs text-stone-900 focus:border-blue-400 focus:outline-none"
                        />
                        years
                      </span>
                    ) : null}
                    {item.id === 'layoff' && checked ? (
                      <span className="mt-2 flex flex-col gap-1 text-xs text-stone-600">
                        <span className="flex items-center gap-2">
                          Last day
                          <input
                            type="date"
                            value={draftStressorKnobs.layoffRetireDate}
                            onChange={(event) => {
                              const raw = event.target.value;
                              if (!raw) return;
                              updateStressorKnob('layoffRetireDate', raw);
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900 focus:border-blue-400 focus:outline-none"
                          />
                        </span>
                        <span className="flex items-center gap-2">
                          Severance $
                          <input
                            type="number"
                            min={0}
                            step={1000}
                            value={draftStressorKnobs.layoffSeverance}
                            onChange={(event) => {
                              const raw = Number(event.target.value);
                              if (Number.isNaN(raw)) return;
                              updateStressorKnob(
                                'layoffSeverance',
                                Math.max(0, Math.round(raw)),
                              );
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className="w-28 rounded-md border border-stone-300 bg-white px-2 py-1 text-right text-xs text-stone-900 focus:border-blue-400 focus:outline-none"
                          />
                        </span>
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </article>
        <article className="rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
            Solutions
          </p>
          <p className="mt-1 text-sm text-stone-600">
            Levers you can pull in response. Mix and match.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {responses.map((item) => {
              const copy = SOLUTION_COPY[item.id] ?? { name: item.name, hint: '' };
              const checked = selectedResponses.includes(item.id);
              return (
                <label
                  key={item.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-2 transition ${
                    checked
                      ? 'border-emerald-300 bg-emerald-50/60'
                      : 'border-stone-200 bg-stone-50 hover:bg-stone-100'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    onChange={() => toggleResponse(item.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-stone-900">{copy.name}</span>
                    {copy.hint ? (
                      <span className="block text-xs text-stone-500">{copy.hint}</span>
                    ) : null}
                    {item.id === 'cut_spending' && checked ? (
                      <span className="mt-2 flex items-center gap-2 text-xs text-stone-600">
                        Cut optional by
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={5}
                          value={draftStressorKnobs.cutSpendingPercent}
                          onChange={(event) => {
                            const raw = Number(event.target.value);
                            if (Number.isNaN(raw)) return;
                            const clamped = Math.max(0, Math.min(100, Math.round(raw)));
                            updateStressorKnob('cutSpendingPercent', clamped);
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="w-14 rounded-md border border-stone-300 bg-white px-2 py-1 text-right text-xs text-stone-900 focus:border-emerald-400 focus:outline-none"
                        />
                        %
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </article>
      </div>

      {/* Suggestions (stack-ranked solutions) */}
      <SuggestionsCard
        status={suggestionRankingStatus}
        progress={suggestionRankingProgress}
        error={suggestionRankingError}
        results={suggestionRankingResults}
        selectedStressors={selectedStressors}
        selectedResponses={selectedResponses}
        onRun={onRunSuggestionRanking}
        onCancel={onCancelSuggestionRanking}
        onApply={onApplySuggestion}
      />

      {/* Effects breakdown */}
      <article className="mb-6 rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
          Effects on your plan
        </p>
        <p className="mt-1 text-sm text-stone-600">
          {isSimulationRunning && !hasSimulationData
            ? 'Running the Monte Carlo against your tweaks. Typically 60–90 seconds.'
            : showDelta
              ? 'How the tweaks and solutions you picked change the ride, compared to your current plan.'
              : 'Pick some tweaks/solutions and press Run to see deltas here.'}
        </p>
        {isSimulationRunning && !hasSimulationData ? (
          <div className="mt-4 rounded-2xl border border-stone-100 bg-stone-50/70 p-4">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-stone-700">
                Monte Carlo simulation
              </span>
              <span className="font-mono text-xs text-stone-500">
                {Math.round(simulationProgress * 100)}%
              </span>
            </div>
            <div
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-200"
              role="progressbar"
              aria-valuenow={Math.round(simulationProgress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-blue-600 transition-[width] duration-200 ease-out"
                style={{ width: `${Math.max(2, Math.round(simulationProgress * 100))}%` }}
              />
            </div>
            <p className="mt-3 text-xs text-stone-500">
              Running thousands of market paths against your selected tweaks and solutions. Numbers
              populate together when the run finishes — no partial results to avoid misleading
              early reads.
            </p>
          </div>
        ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <EffectRow
            label="Success rate (flex)"
            baseline={formatPercent(baselinePath.successRate)}
            current={formatPercent(primaryPath.successRate)}
            delta={showDelta ? formatDeltaPercent(successDelta) : null}
            goodWhenUp
          />
          <EffectRow
            label="Monthly supported spend"
            baseline={formatCurrency(Math.round(baseMonthly))}
            current={formatCurrency(Math.round(simMonthly))}
            delta={showDelta ? formatDeltaCurrency(Math.round(monthlyDelta)) : null}
            goodWhenUp
          />
          <EffectRow
            label="Annual supported spend"
            baseline={formatCurrency(Math.round(baseMonthly * 12))}
            current={formatCurrency(Math.round(simMonthly * 12))}
            delta={showDelta ? formatDeltaCurrency(Math.round(annualDelta)) : null}
            goodWhenUp
          />
          <EffectRow
            label="Lifetime federal tax (median)"
            baseline={formatCurrency(Math.round(baseEffects.lifetimeFedTax))}
            current={formatCurrency(Math.round(simEffects.lifetimeFedTax))}
            delta={
              showDelta
                ? formatDeltaCurrency(
                    Math.round(simEffects.lifetimeFedTax - baseEffects.lifetimeFedTax),
                  )
                : null
            }
            goodWhenUp={false}
          />
          <EffectRow
            label="Lifetime Roth conversions"
            baseline={formatCurrency(Math.round(baseEffects.lifetimeRothConverted))}
            current={formatCurrency(Math.round(simEffects.lifetimeRothConverted))}
            delta={
              showDelta
                ? formatDeltaCurrency(
                    Math.round(simEffects.lifetimeRothConverted - baseEffects.lifetimeRothConverted),
                  )
                : null
            }
          />
          <EffectRow
            label="First conversion year"
            baseline={
              baseEffects.firstConversionYear ? String(baseEffects.firstConversionYear) : '—'
            }
            current={
              simEffects.firstConversionYear ? String(simEffects.firstConversionYear) : '—'
            }
            delta={null}
          />
          <EffectRow
            label="IRMAA years (median)"
            baseline={`${baseEffects.irmaaYears} yrs`}
            current={`${simEffects.irmaaYears} yrs`}
            delta={
              showDelta
                ? simEffects.irmaaYears === baseEffects.irmaaYears
                  ? 'no change'
                  : `${simEffects.irmaaYears > baseEffects.irmaaYears ? '+' : '−'}${Math.abs(
                      simEffects.irmaaYears - baseEffects.irmaaYears,
                    )} yrs`
                : null
            }
            goodWhenUp={false}
          />
          <EffectRow
            label="Guardrail-cut rate"
            baseline={formatPercent(baselinePath.spendingCutRate)}
            current={formatPercent(primaryPath.spendingCutRate)}
            delta={showDelta ? formatDeltaPercent(cutRateDelta) : null}
            goodWhenUp={false}
          />
          <EffectRow
            label="IRMAA exposure rate"
            baseline={formatPercent(baselinePath.irmaaExposureRate)}
            current={formatPercent(primaryPath.irmaaExposureRate)}
            delta={showDelta ? formatDeltaPercent(irmaaRateDelta) : null}
            goodWhenUp={false}
          />
          <EffectRow
            label="Median ending wealth"
            baseline={formatCurrency(baselinePath.medianEndingWealth)}
            current={formatCurrency(primaryPath.medianEndingWealth)}
            delta={showDelta ? formatDeltaCurrency(Math.round(endingDelta)) : null}
          />
          <EffectRow
            label="10th-percentile ending wealth"
            baseline={formatCurrency(baselinePath.tenthPercentileEndingWealth)}
            current={formatCurrency(primaryPath.tenthPercentileEndingWealth)}
            delta={
              showDelta
                ? formatDeltaCurrency(
                    Math.round(
                      primaryPath.tenthPercentileEndingWealth -
                        baselinePath.tenthPercentileEndingWealth,
                    ),
                  )
                : null
            }
            goodWhenUp
          />
          <EffectRow
            label="Years funded"
            baseline={`${baselinePath.yearsFunded} yrs`}
            current={`${primaryPath.yearsFunded} yrs`}
            delta={
              showDelta && primaryPath.yearsFunded !== baselinePath.yearsFunded
                ? `${primaryPath.yearsFunded > baselinePath.yearsFunded ? '+' : '−'}${Math.abs(
                    primaryPath.yearsFunded - baselinePath.yearsFunded,
                  )} yrs`
                : showDelta
                  ? 'no change'
                  : null
            }
            goodWhenUp
          />
        </div>
        )}
      </article>

      {/* Engine diagnostics — collapsed by default */}
      <details className="mb-4 rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
          Engine diagnostics
        </summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricTile label="Equity mean" value={formatPercent(assumptions.equityMean)} />
          <MetricTile
            label="Equity volatility"
            value={formatPercent(assumptions.equityVolatility)}
          />
          <MetricTile label="Bond mean" value={formatPercent(assumptions.bondMean)} />
          <MetricTile label="Runs" value={assumptions.simulationRuns.toLocaleString()} />
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
        <div className="mt-3 rounded-2xl bg-stone-50 p-3 text-xs text-stone-600">
          <p>
            Assumptions version: {parityReport.assumptionsVersion} • Return model:{' '}
            {parityReport.plannerEnhancedSimulation.simulationConfiguration.returnGeneration.model}{' '}
            • IRMAA-aware (planner/raw):{' '}
            {parityReport.plannerEnhancedSimulation.simulationConfiguration.withdrawalPolicy
              .irmaaAware
              ? 'on'
              : 'off'}
            /
            {parityReport.rawSimulation.simulationConfiguration.withdrawalPolicy.irmaaAware
              ? 'on'
              : 'off'}
          </p>
          <p className="mt-1">
            Withdrawal order (planner):{' '}
            {parityReport.plannerEnhancedSimulation.simulationConfiguration.withdrawalPolicy.order.join(
              ' → ',
            )}
          </p>
          <p className="mt-1">
            Withdrawal order (raw):{' '}
            {parityReport.rawSimulation.simulationConfiguration.withdrawalPolicy.order.join(' → ')}
          </p>
        </div>
        <details className="mt-3 rounded-xl bg-stone-50 p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
            Internal diagnostics JSON
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
      </details>

      {/* Charts — collapsed by default */}
      <details className="rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
          Charts
        </summary>
        <div className="mt-4 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-[24px] bg-stone-50 p-4">
            <p className="text-sm font-medium text-stone-500">Path outcome mix</p>
            <h3 className="text-lg font-semibold text-stone-900">Success vs failure share</h3>
            <div className="mt-3 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={distributionSeries}>
                  <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} />
                  <YAxis
                    tickFormatter={(value) => `${value}%`}
                    tickLine={false}
                    axisLine={false}
                  />
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
          <div className="rounded-[24px] bg-stone-50 p-4">
            <p className="text-sm font-medium text-stone-500">Income vs spending</p>
            <h3 className="text-lg font-semibold text-stone-900">Funding pressure over time</h3>
            <div className="mt-3 h-64">
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
                    dataKey="income"
                    stroke="#2563eb"
                    strokeWidth={3}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="spending"
                    stroke="#1e3a8a"
                    strokeWidth={3}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </details>
    </Panel>
  );
}

// Fixed retirement-smile multipliers used purely for UI display so baseline and
// stressed scenarios always share the same shape. The solver may find a
// different optimal shape internally, but for apples-to-apples comparison the
// three phase cards derive their numbers from a single headline by applying
// these multipliers (matches Kitces-style retirement smile).
const DISPLAY_SMILE = { goGo: 1.08, slowGo: 0.92, late: 0.78 };

function SmileCurve({
  baseline,
  current,
  showDelta,
}: {
  baseline: SolvedSpendProfile | null;
  current: SolvedSpendProfile | null;
  showDelta: boolean;
}) {
  if (!baseline || !current) return null;

  type PhaseRow = {
    label: string;
    sub: string;
    base: number;
    now: number;
    floor: number;
    rawNow: number;
  };

  // Plan-mode solver results predate the floor/raw fields — guard with ?? 0
  // so we don't leak NaN into the baseline cards.
  const baseFloor60 = baseline.floorMonthly60s ?? 0;
  const baseFloor70 = baseline.floorMonthly70s ?? 0;
  const baseFloor80 = baseline.floorMonthly80Plus ?? 0;
  const curFloor60 = current.floorMonthly60s ?? 0;
  const curFloor70 = current.floorMonthly70s ?? 0;
  const curFloor80 = current.floorMonthly80Plus ?? 0;

  const phases: PhaseRow[] = [
    {
      label: 'Now through ~69',
      sub: 'Go-go years — travel, hobbies, eating out',
      base: Math.max(baseline.monthlySpendNow * DISPLAY_SMILE.goGo, baseFloor60),
      now: Math.max(current.monthlySpendNow * DISPLAY_SMILE.goGo, curFloor60),
      floor: curFloor60,
      rawNow: current.monthlySpendNow * DISPLAY_SMILE.goGo,
    },
    {
      label: 'Age 70 to 79',
      sub: 'Slow-go years — travel slows, lifestyle settles',
      base: Math.max(baseline.monthlySpendNow * DISPLAY_SMILE.slowGo, baseFloor70),
      now: Math.max(current.monthlySpendNow * DISPLAY_SMILE.slowGo, curFloor70),
      floor: curFloor70,
      rawNow: current.monthlySpendNow * DISPLAY_SMILE.slowGo,
    },
    {
      label: 'Age 80+',
      sub: 'No-go years — mostly home + healthcare',
      base: Math.max(baseline.monthlySpendNow * DISPLAY_SMILE.late, baseFloor80),
      now: Math.max(current.monthlySpendNow * DISPLAY_SMILE.late, curFloor80),
      floor: curFloor80,
      rawNow: current.monthlySpendNow * DISPLAY_SMILE.late,
    },
  ];
  return (
    <article className="mb-6 rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
        Real monthly spend by phase
      </p>
      <p className="mt-1 text-sm text-stone-600">
        Retirement smile: real spending naturally tapers through the decades. Numbers below
        are inflation-adjusted monthly spend targets at {formatPercent(current.successTarget)}{' '}
        success.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {phases.map((phase) => {
          const delta = phase.now - phase.base;
          const deltaLabel =
            Math.abs(delta) < 5
              ? 'no change'
              : `${delta > 0 ? '+' : '−'}${formatCurrency(Math.round(Math.abs(delta)))}/mo`;
          const deltaTone =
            Math.abs(delta) < 5
              ? 'text-stone-500'
              : delta > 0
                ? 'text-emerald-700'
                : 'text-rose-700';
          // Flag when the portfolio alone couldn't support this phase and the
          // number is being held up by Social Security. Users were (rightly)
          // confused when the card showed "$6,100/mo" and the delta looked
          // small, when in truth the portfolio was contributing $0 above SS.
          const atFloor = phase.floor > 0 && phase.rawNow < phase.floor;
          const portfolioSupplement = Math.max(0, phase.now - phase.floor);
          return (
            <div
              key={phase.label}
              className={`rounded-2xl border p-3 ${
                atFloor
                  ? 'border-amber-200 bg-amber-50/70'
                  : 'border-stone-200 bg-stone-50'
              }`}
            >
              <p className="text-xs font-semibold text-stone-700">{phase.label}</p>
              <p className="mt-0.5 text-[11px] text-stone-500">{phase.sub}</p>
              <p className="mt-2 text-2xl font-semibold text-teal-700">
                {formatCurrency(Math.round(phase.now))}
              </p>
              {atFloor ? (
                <p className="mt-1 text-[11px] font-medium text-amber-800">
                  at SS floor · portfolio supplement {formatCurrency(Math.round(portfolioSupplement))}/mo
                </p>
              ) : phase.floor > 0 ? (
                <p className="mt-1 text-[11px] text-stone-500">
                  SS floor {formatCurrency(Math.round(phase.floor))} · portfolio +
                  {formatCurrency(Math.round(portfolioSupplement))}/mo
                </p>
              ) : null}
              <p className="mt-1 text-[11px] text-stone-500">
                baseline {formatCurrency(Math.round(phase.base))}/mo
                {showDelta ? (
                  <>
                    {' '}
                    · <span className={`font-semibold ${deltaTone}`}>{deltaLabel}</span>
                  </>
                ) : null}
              </p>
            </div>
          );
        })}
      </div>
    </article>
  );
}

/**
 * Compact "what the plan is telling you to do today" card for the home
 * (overview) screen. One line: zone + monthly spend + key trigger thresholds.
 * Click-through jumps to the Simulations sandbox for the full panel.
 */
function PlanReadingCard({
  data,
  assumptions,
  solvedSpendProfile,
  onJumpToSandbox,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  solvedSpendProfile: SolvedSpendProfile | null;
  onJumpToSandbox: () => void;
}) {
  if (!solvedSpendProfile) {
    return (
      <article className="mb-4 rounded-[24px] border border-stone-200 bg-stone-50/70 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
          Today's plan reading
        </p>
        <p className="mt-1 text-sm text-stone-600">
          Run the sandbox to compute today's monthly spend and guardrail zone.
        </p>
        <button
          type="button"
          onClick={onJumpToSandbox}
          className="mt-3 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
        >
          Open sandbox →
        </button>
      </article>
    );
  }

  const portfolio =
    (data.accounts.pretax?.balance ?? 0) +
    (data.accounts.roth?.balance ?? 0) +
    (data.accounts.taxable?.balance ?? 0) +
    (data.accounts.cash?.balance ?? 0) +
    (data.accounts.hsa?.balance ?? 0);
  const annualSpend = solvedSpendProfile.monthlySpendNow * 12;
  const fundedYears = annualSpend > 0 ? portfolio / annualSpend : 0;
  const floorYears = assumptions.guardrailFloorYears;
  const ceilingYears = assumptions.guardrailCeilingYears;
  const cutPercent = assumptions.guardrailCutPercent;

  const zone: 'green' | 'yellow' | 'red' =
    fundedYears >= ceilingYears ? 'green' : fundedYears <= floorYears ? 'red' : 'yellow';

  const action =
    zone === 'green'
      ? `Spend up to ${formatCurrency(Math.round(solvedSpendProfile.monthlySpendNow))}/mo this month.`
      : zone === 'yellow'
        ? `Hold spending at ${formatCurrency(Math.round(solvedSpendProfile.monthlySpendNow))}/mo. Don't expand travel or big-ticket optional.`
        : `Cut optional + travel by ${Math.round(cutPercent * 100)}% until portfolio recovers above ${formatCurrency(Math.round(ceilingYears * annualSpend))}.`;

  const tone = {
    green: { border: 'border-emerald-300', bg: 'bg-emerald-50/80', dot: 'bg-emerald-500', text: 'text-emerald-900', sub: 'text-emerald-700' },
    yellow: { border: 'border-amber-300', bg: 'bg-amber-50/80', dot: 'bg-amber-500', text: 'text-amber-900', sub: 'text-amber-700' },
    red: { border: 'border-rose-300', bg: 'bg-rose-50/80', dot: 'bg-rose-500', text: 'text-rose-900', sub: 'text-rose-700' },
  }[zone];

  const zoneLabel = zone === 'green' ? 'GREEN' : zone === 'yellow' ? 'YELLOW' : 'RED';

  return (
    <article className={`mb-4 rounded-[24px] border p-4 shadow-sm ${tone.border} ${tone.bg}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`h-3 w-3 rounded-full ${tone.dot}`} />
            <p className={`text-xs font-semibold uppercase tracking-[0.18em] ${tone.sub}`}>
              Today's plan reading · {zoneLabel} zone · {fundedYears.toFixed(1)}yr runway
            </p>
          </div>
          <h3 className={`mt-2 text-lg font-semibold leading-snug ${tone.text}`}>{action}</h3>
          <p className={`mt-1 text-xs ${tone.sub}`}>
            Cut trigger {formatCurrency(Math.round(floorYears * annualSpend))} · Restore trigger{' '}
            {formatCurrency(Math.round(ceilingYears * annualSpend))} · Portfolio today{' '}
            <strong>{formatCurrency(Math.round(portfolio))}</strong>.
          </p>
        </div>
        <button
          type="button"
          onClick={onJumpToSandbox}
          className="rounded-full border border-stone-300 bg-white/70 px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:bg-white"
        >
          Tune in sandbox →
        </button>
      </div>
    </article>
  );
}

/**
 * Current guardrail-zone reading for the household today.
 *
 * The Monte Carlo engine already runs Guyton-Klinger-style optional-spending
 * guardrails inside every simulated path (see `guardrails` block in utils.ts):
 *   - If fundedYears drops below `floorYears` → cut optional + travel by `cutPercent`.
 *   - If fundedYears recovers above `ceilingYears` → restore optional + travel.
 *
 * This card surfaces where the household is RIGHT NOW against those triggers,
 * so the committed monthly spend stops reading as a verdict and starts reading
 * as the first reading of a live rulebook. Every recalc moves the needle.
 *
 * fundedYears = totalPortfolio / annualSpendTarget. Zones:
 *   RED    → fundedYears <= floorYears         (cut-triggered in the sim)
 *   YELLOW → floorYears < fundedYears < ceilingYears (restore band)
 *   GREEN  → fundedYears >= ceilingYears       (full-throttle spend)
 */
/**
 * Sensible default ladder when the user toggles staircase mode on. Mirrors
 * the kind of pivot sequence someone would actually plan: trim travel mildly
 * → start cutting optional → sell the house → cut harder. Each tier is
 * editable in the UI; this is just the seed.
 */
function defaultGuardrailLadder(): GuardrailTier[] {
  return [
    {
      id: 'tier-mild-travel',
      triggerFundedYears: 16,
      action: 'cut_travel',
      amountPercent: 0.2,
      label: 'Trim travel',
    },
    {
      id: 'tier-mild-optional',
      triggerFundedYears: 12,
      action: 'cut_optional',
      amountPercent: 0.1,
      label: 'Cut optional',
    },
    {
      id: 'tier-sell-house',
      triggerFundedYears: 9,
      action: 'sell_house',
      label: 'Sell house early',
    },
    {
      id: 'tier-deep-optional',
      triggerFundedYears: 7,
      action: 'cut_optional',
      amountPercent: 0.15,
      label: 'Deeper optional cut',
    },
  ];
}

const TIER_ACTION_LABELS: Record<GuardrailTier['action'], string> = {
  cut_optional: 'Cut optional',
  cut_travel: 'Cut travel',
  sell_house: 'Sell house early',
  claim_ss_early: 'Claim SS early',
};

function GuardrailZonePanel({
  data,
  assumptions,
  current,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  current: SolvedSpendProfile | null;
}) {
  const updateAssumption = useAppStore((state) => state.updateAssumption);
  const [tunerOpen, setTunerOpen] = useState(false);
  if (!current) return null;

  const floorYears = assumptions.guardrailFloorYears;
  const ceilingYears = assumptions.guardrailCeilingYears;
  const cutPercent = assumptions.guardrailCutPercent;
  const pivotSellHouseFloorYears = assumptions.pivotSellHouseFloorYears ?? 0;
  const pivotClaimSSEarlyFloorYears = assumptions.pivotClaimSSEarlyFloorYears ?? 0;
  const pivotSellEnabled = pivotSellHouseFloorYears > 0;
  const pivotSSEnabled = pivotClaimSSEarlyFloorYears > 0;
  const ladder = assumptions.guardrailLadder;
  const ladderEnabled = !!ladder && ladder.length > 0;

  // Mutator helper: replaces the whole ladder. Cheap given small tier counts.
  const setLadder = (next: GuardrailTier[] | undefined) =>
    updateAssumption('guardrailLadder', next);

  const portfolio =
    (data.accounts.pretax?.balance ?? 0) +
    (data.accounts.roth?.balance ?? 0) +
    (data.accounts.taxable?.balance ?? 0) +
    (data.accounts.cash?.balance ?? 0) +
    (data.accounts.hsa?.balance ?? 0);

  const annualSpend = current.monthlySpendNow * 12;
  const fundedYears = annualSpend > 0 ? portfolio / annualSpend : 0;
  const floorPortfolio = floorYears * annualSpend;
  const ceilingPortfolio = ceilingYears * annualSpend;

  const zone: 'green' | 'yellow' | 'red' =
    fundedYears >= ceilingYears ? 'green' : fundedYears <= floorYears ? 'red' : 'yellow';

  const zoneColors = {
    green: {
      border: 'border-emerald-200',
      bg: 'bg-emerald-50/80',
      dot: 'bg-emerald-500',
      eyebrow: 'text-emerald-700',
      headline: 'text-emerald-900',
      accent: 'text-emerald-800',
    },
    yellow: {
      border: 'border-amber-200',
      bg: 'bg-amber-50/80',
      dot: 'bg-amber-500',
      eyebrow: 'text-amber-700',
      headline: 'text-amber-900',
      accent: 'text-amber-800',
    },
    red: {
      border: 'border-rose-200',
      bg: 'bg-rose-50/80',
      dot: 'bg-rose-500',
      eyebrow: 'text-rose-700',
      headline: 'text-rose-900',
      accent: 'text-rose-800',
    },
  }[zone];

  const zoneLabel =
    zone === 'green'
      ? 'GREEN · full spending'
      : zone === 'yellow'
        ? 'YELLOW · watch'
        : 'RED · hunker down';

  const zoneBlurb =
    zone === 'green'
      ? `Portfolio covers ${fundedYears.toFixed(1)}yr of current spending — above the ${ceilingYears}-year ceiling. Spend the full monthly target.`
      : zone === 'yellow'
        ? `Portfolio covers ${fundedYears.toFixed(1)}yr of current spending — between the ${floorYears}yr cut trigger and the ${ceilingYears}yr restore trigger. Hold current spending; watch the ratio.`
        : `Portfolio covers only ${fundedYears.toFixed(1)}yr of current spending — at or below the ${floorYears}yr floor. The plan calls for cutting optional + travel by ${Math.round(cutPercent * 100)}% until the portfolio recovers.`;

  // Estimated monthly optional + travel dollars from seed spending (travel is
  // annual so divide by 12). Lets us show the actual dollar cut instead of
  // just a percent.
  const optionalMonthly = data.spending?.optionalMonthly ?? 0;
  const travelMonthly = (data.spending?.travelEarlyRetirementAnnual ?? 0) / 12;
  const cutAmountMonthly = (optionalMonthly + travelMonthly) * cutPercent;

  // Progress bar: where the portfolio sits on a 0 → ceiling scale.
  const barMax = Math.max(ceilingPortfolio * 1.25, portfolio);
  const floorPct = Math.min(100, (floorPortfolio / barMax) * 100);
  const ceilingPct = Math.min(100, (ceilingPortfolio / barMax) * 100);
  const portfolioPct = Math.min(100, (portfolio / barMax) * 100);

  return (
    <article className={`mb-6 rounded-[24px] border p-4 shadow-sm ${zoneColors.border} ${zoneColors.bg}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`h-3 w-3 rounded-full ${zoneColors.dot}`} />
            <p className={`text-xs font-semibold uppercase tracking-[0.18em] ${zoneColors.eyebrow}`}>
              Zone today · {zoneLabel}
            </p>
          </div>
          <h3 className={`mt-2 text-xl font-semibold leading-snug ${zoneColors.headline}`}>
            {zoneBlurb}
          </h3>
        </div>
        <div className="text-right">
          <p className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${zoneColors.eyebrow}`}>
            funded years
          </p>
          <p className={`text-3xl font-semibold ${zoneColors.headline}`}>
            {fundedYears.toFixed(1)}
          </p>
        </div>
      </div>

      {/* Trigger bar: RED below floor, YELLOW between, GREEN above ceiling. */}
      <div className="mt-4">
        <div className="relative h-3 rounded-full bg-white/70 ring-1 ring-stone-200">
          <div
            className="absolute inset-y-0 left-0 rounded-l-full bg-rose-300/70"
            style={{ width: `${floorPct}%` }}
          />
          <div
            className="absolute inset-y-0 bg-amber-200/80"
            style={{ left: `${floorPct}%`, width: `${Math.max(0, ceilingPct - floorPct)}%` }}
          />
          <div
            className="absolute inset-y-0 right-0 rounded-r-full bg-emerald-200/80"
            style={{ left: `${ceilingPct}%` }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-5 w-1 rounded-full bg-stone-900"
            style={{ left: `${portfolioPct}%` }}
            title={`Portfolio ${formatCurrency(Math.round(portfolio))}`}
          />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-stone-600">
          <span>
            Cut @ {formatCurrency(Math.round(floorPortfolio))}
          </span>
          <span>
            Portfolio today · <strong>{formatCurrency(Math.round(portfolio))}</strong>
          </span>
          <span>
            Restore @ {formatCurrency(Math.round(ceilingPortfolio))}
          </span>
        </div>
      </div>

      {/* Rulebook: legacy 3-zone view OR staircase tier list when ladder is on. */}
      {ladderEnabled && ladder ? (
        <div className="mt-4 rounded-2xl border border-stone-200 bg-white/70 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-700">
            Staircase · pivots fire as runway drops
          </p>
          <p className="mt-1 text-[11px] text-stone-500">
            Tiers compose: every active tier applies. Today&rsquo;s portfolio covers{' '}
            <strong>{fundedYears.toFixed(1)}yr</strong> of spend; tiers below that trigger fire on
            this path.
          </p>
          <ol className="mt-3 space-y-1.5">
            {[...ladder]
              .sort((a, b) => b.triggerFundedYears - a.triggerFundedYears)
              .map((tier) => {
                const active = fundedYears < tier.triggerFundedYears;
                const amt =
                  tier.amountPercent != null
                    ? ` ${Math.round(tier.amountPercent * 100)}%`
                    : '';
                return (
                  <li
                    key={tier.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
                      active
                        ? 'border-rose-300 bg-rose-50/80 text-rose-900'
                        : 'border-stone-200 bg-white text-stone-700'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          active ? 'bg-rose-500' : 'bg-stone-300'
                        }`}
                      />
                      <span>
                        <strong>{tier.label ?? TIER_ACTION_LABELS[tier.action]}</strong>
                        <span className="ml-1 text-stone-500">
                          · {TIER_ACTION_LABELS[tier.action]}
                          {amt}
                        </span>
                      </span>
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {active ? 'firing' : `at ${tier.triggerFundedYears}yr`}
                    </span>
                  </li>
                );
              })}
          </ol>
        </div>
      ) : (
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          <div
            className={`rounded-2xl border bg-white/70 p-3 ${
              zone === 'green' ? 'border-emerald-300 ring-1 ring-emerald-400' : 'border-stone-200'
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
              Green · full spend
            </p>
            <p className="mt-1 text-sm text-stone-700">
              Portfolio &gt; {formatCurrency(Math.round(ceilingPortfolio))}.<br />
              Spend up to <strong>{formatCurrency(Math.round(current.monthlySpendNow))}/mo</strong>.
            </p>
          </div>
          <div
            className={`rounded-2xl border bg-white/70 p-3 ${
              zone === 'yellow' ? 'border-amber-300 ring-1 ring-amber-400' : 'border-stone-200'
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
              Yellow · hold &amp; watch
            </p>
            <p className="mt-1 text-sm text-stone-700">
              Between {formatCurrency(Math.round(floorPortfolio))} and{' '}
              {formatCurrency(Math.round(ceilingPortfolio))}. Hold current spend; don&rsquo;t
              expand travel or big-ticket optional.
            </p>
          </div>
          <div
            className={`rounded-2xl border bg-white/70 p-3 ${
              zone === 'red' ? 'border-rose-300 ring-1 ring-rose-400' : 'border-stone-200'
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-rose-700">
              Red · hunker down
            </p>
            <p className="mt-1 text-sm text-stone-700">
              Portfolio &lt; {formatCurrency(Math.round(floorPortfolio))}. Cut optional + travel
              by {Math.round(cutPercent * 100)}% (≈{formatCurrency(Math.round(cutAmountMonthly))}/mo) until
              funded-years recovers above {ceilingYears}.
            </p>
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] text-stone-500">
        This is the same dynamic-guardrail rule the Monte Carlo engine already runs
        inside every one of the {assumptions.simulationRuns.toLocaleString()} simulated paths behind the
        monthly spend headline. Re-run the sim any time to refresh the zone reading.
      </p>

      {/* Tuner — own the rules. Sliders + pivot toggles. */}
      <div className="mt-4 border-t border-stone-200/70 pt-3">
        <button
          type="button"
          onClick={() => setTunerOpen((v) => !v)}
          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-600 hover:text-stone-900"
        >
          {tunerOpen ? '▾ Hide rules' : '▸ Tune the rules'}
        </button>
        {tunerOpen ? (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-stone-200 bg-white/70 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-700">
                    Core guardrail
                  </p>
                  <p className="mt-1 text-[11px] text-stone-500">
                    {ladderEnabled
                      ? 'Staircase mode: tiers compose as runway drops. Restore band still uses the ceiling below.'
                      : 'When portfolio runway drops, cut optional + travel; when it recovers, restore.'}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-[11px] text-stone-700">
                  <input
                    type="checkbox"
                    checked={ladderEnabled}
                    onChange={(e) =>
                      setLadder(e.target.checked ? defaultGuardrailLadder() : undefined)
                    }
                  />
                  <span className="font-semibold">Staircase</span>
                </label>
              </div>

              {ladderEnabled && ladder ? (
                <div className="mt-3 space-y-2">
                  {[...ladder]
                    .sort((a, b) => b.triggerFundedYears - a.triggerFundedYears)
                    .map((tier) => {
                      const idx = ladder.findIndex((t) => t.id === tier.id);
                      const updateTier = (patch: Partial<GuardrailTier>) => {
                        const next = ladder.map((t) =>
                          t.id === tier.id ? { ...t, ...patch } : t,
                        );
                        setLadder(next);
                      };
                      const removeTier = () => {
                        const next = ladder.filter((t) => t.id !== tier.id);
                        setLadder(next.length ? next : undefined);
                      };
                      const showAmount =
                        tier.action === 'cut_optional' || tier.action === 'cut_travel';
                      return (
                        <div
                          key={tier.id}
                          className="rounded-lg border border-stone-200 bg-white p-2"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={tier.label ?? ''}
                              placeholder={TIER_ACTION_LABELS[tier.action]}
                              onChange={(e) => updateTier({ label: e.target.value })}
                              className="flex-1 rounded border border-stone-200 px-2 py-1 text-xs"
                            />
                            <select
                              value={tier.action}
                              onChange={(e) =>
                                updateTier({
                                  action: e.target.value as GuardrailTier['action'],
                                })
                              }
                              className="rounded border border-stone-200 px-2 py-1 text-xs"
                            >
                              <option value="cut_optional">Cut optional</option>
                              <option value="cut_travel">Cut travel</option>
                              <option value="sell_house">Sell house early</option>
                              <option value="claim_ss_early">Claim SS early</option>
                            </select>
                            <button
                              type="button"
                              onClick={removeTier}
                              className="rounded px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50"
                              title="Remove tier"
                            >
                              ✕
                            </button>
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <SliderRow
                              label={`Trigger: < ${tier.triggerFundedYears}yr funded`}
                              value={tier.triggerFundedYears}
                              min={4}
                              max={25}
                              step={1}
                              onChange={(v) => updateTier({ triggerFundedYears: v })}
                            />
                            {showAmount ? (
                              <SliderRow
                                label={`Amount: ${Math.round((tier.amountPercent ?? 0) * 100)}%`}
                                value={Math.round((tier.amountPercent ?? 0) * 100)}
                                min={5}
                                max={50}
                                step={5}
                                onChange={(v) => updateTier({ amountPercent: v / 100 })}
                              />
                            ) : (
                              <div className="flex items-end pb-1 text-[11px] text-stone-500">
                                {tier.action === 'sell_house'
                                  ? 'One-shot · home_sale windfall pulled to trigger year.'
                                  : 'One-shot · SS claim age dropped to 62 (engine wiring pending).'}
                              </div>
                            )}
                          </div>
                          <input type="hidden" value={idx} readOnly />
                        </div>
                      );
                    })}
                  <button
                    type="button"
                    onClick={() => {
                      const newTier: GuardrailTier = {
                        id: `tier-${Date.now()}`,
                        triggerFundedYears: 10,
                        action: 'cut_optional',
                        amountPercent: 0.1,
                      };
                      setLadder([...(ladder ?? []), newTier]);
                    }}
                    className="w-full rounded-lg border border-dashed border-stone-300 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-600 hover:border-stone-400 hover:text-stone-900"
                  >
                    + Add tier
                  </button>
                  <SliderRow
                    label={`Restore trigger (ceiling): ${ceilingYears}yr`}
                    value={ceilingYears}
                    min={8}
                    max={30}
                    step={1}
                    onChange={(v) => updateAssumption('guardrailCeilingYears', v)}
                  />
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <SliderRow
                    label={`Cut trigger (floor): ${floorYears}yr`}
                    value={floorYears}
                    min={6}
                    max={20}
                    step={1}
                    onChange={(v) => updateAssumption('guardrailFloorYears', v)}
                  />
                  <SliderRow
                    label={`Restore trigger (ceiling): ${ceilingYears}yr`}
                    value={ceilingYears}
                    min={Math.max(8, floorYears + 1)}
                    max={30}
                    step={1}
                    onChange={(v) => updateAssumption('guardrailCeilingYears', v)}
                  />
                  <SliderRow
                    label={`Cut size: ${Math.round(cutPercent * 100)}% of optional + travel`}
                    value={Math.round(cutPercent * 100)}
                    min={5}
                    max={50}
                    step={5}
                    onChange={(v) => updateAssumption('guardrailCutPercent', v / 100)}
                  />
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-stone-200 bg-white/70 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-700">
                Pre-committed pivots
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                Levers you'd actually pull "if shit hits the fan." Turning these on tells
                the engine the household will respond — should raise the monthly headline
                by reducing the worst-case ruin paths.
              </p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input
                      type="checkbox"
                      checked={pivotSellEnabled}
                      onChange={(e) =>
                        updateAssumption(
                          'pivotSellHouseFloorYears',
                          e.target.checked ? 8 : undefined,
                        )
                      }
                    />
                    <span>
                      <strong>Sell house early</strong> if runway drops below trigger
                    </span>
                  </label>
                  {pivotSellEnabled ? (
                    <div className="mt-2 pl-6">
                      <SliderRow
                        label={`Trigger: fundedYears < ${pivotSellHouseFloorYears}yr`}
                        value={pivotSellHouseFloorYears}
                        min={4}
                        max={Math.max(4, floorYears)}
                        step={1}
                        onChange={(v) => updateAssumption('pivotSellHouseFloorYears', v)}
                      />
                      <p className="mt-1 text-[11px] text-stone-500">
                        Engine wired ✓ — home_sale windfall ({formatCurrency(
                          data.income.windfalls?.find((w) => w.name === 'home_sale')?.amount ?? 0,
                        )}
                        ) moves to the trigger year on any path where this fires.
                      </p>
                    </div>
                  ) : null}
                </div>
                <div className="border-t border-stone-100 pt-3">
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input
                      type="checkbox"
                      checked={pivotSSEnabled}
                      onChange={(e) =>
                        updateAssumption(
                          'pivotClaimSSEarlyFloorYears',
                          e.target.checked ? 8 : undefined,
                        )
                      }
                    />
                    <span>
                      <strong>Claim SS early</strong> if runway drops below trigger
                    </span>
                  </label>
                  {pivotSSEnabled ? (
                    <div className="mt-2 pl-6">
                      <SliderRow
                        label={`Trigger: fundedYears < ${pivotClaimSSEarlyFloorYears}yr`}
                        value={pivotClaimSSEarlyFloorYears}
                        min={4}
                        max={Math.max(4, floorYears)}
                        step={1}
                        onChange={(v) => updateAssumption('pivotClaimSSEarlyFloorYears', v)}
                      />
                      <p className="mt-1 text-[11px] text-amber-700">
                        UI ready · engine integration pending — toggle is captured but the
                        per-path SS claim-age override is on the next pass.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-stone-600">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-blue-600"
      />
    </div>
  );
}

function CemeteryCard({ current }: { current: SolvedSpendProfile | null }) {
  if (!current) return null;
  // Plan-mode cache (pre-cemetery fields) won't have this block — bail cleanly.
  const cem = current.cemetery;
  if (!cem) return null;

  const median = Math.max(0, Math.round(cem.medianTodayDollars));
  const p25 = Math.max(0, Math.round(cem.p25TodayDollars));
  const p75 = Math.max(0, Math.round(cem.p75TodayDollars));
  const p10 = Math.max(0, Math.round(cem.p10TodayDollars));
  const p90 = Math.max(0, Math.round(cem.p90TodayDollars));

  // Use $25k of cemetery legacy as the threshold for "meaningfully unspent."
  // Below that it's rounding noise; above that we should draw attention to it.
  const hasMeaningfulLegacy = median >= 25_000;

  return (
    <article
      className={`mb-6 rounded-[24px] border p-4 shadow-sm ${
        hasMeaningfulLegacy
          ? 'border-indigo-200 bg-indigo-50/60'
          : 'border-stone-200 bg-white'
      }`}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
        What's left in the cemetery
      </p>
      <p className="mt-1 text-sm text-stone-600">
        Unspent portfolio at age {95} across 1,000 simulated futures, in today's dollars. This
        is money the solver is holding back to satisfy the{' '}
        {formatPercent(current.successTarget)} success target on the worst sequence-risk paths.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-5">
        <div className="rounded-2xl border border-stone-200 bg-white/70 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            worst 10%
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-900">{formatCurrency(p10)}</p>
          <p className="mt-0.5 text-[11px] text-stone-500">sequence-risk paths</p>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white/70 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            25th pct
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-900">{formatCurrency(p25)}</p>
          <p className="mt-0.5 text-[11px] text-stone-500">below-average</p>
        </div>
        <div className="rounded-2xl border border-indigo-300 bg-white px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-700">
            median
          </p>
          <p className="mt-1 text-2xl font-semibold text-indigo-900">
            {formatCurrency(median)}
          </p>
          <p className="mt-0.5 text-[11px] text-indigo-700/80">typical future</p>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white/70 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            75th pct
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-900">{formatCurrency(p75)}</p>
          <p className="mt-0.5 text-[11px] text-stone-500">above-average</p>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white/70 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            best 10%
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-900">{formatCurrency(p90)}</p>
          <p className="mt-0.5 text-[11px] text-stone-500">upside paths</p>
        </div>
      </div>
      {hasMeaningfulLegacy ? (
        <p className="mt-3 text-sm text-indigo-900">
          In the typical future you die with{' '}
          <strong>{formatCurrency(median)}</strong> unspent. Half of the simulated futures end
          with <em>more</em> than that. The solver can't raise your monthly spend without
          pushing the worst 10% (
          {formatCurrency(p10)}) below zero — so this legacy is the cost of insuring against
          the bottom sequence-risk paths.
        </p>
      ) : (
        <p className="mt-3 text-sm text-stone-600">
          The typical future has essentially nothing left at horizon — the solver is spending
          the portfolio down on purpose to maximize lifetime spending.
        </p>
      )}
    </article>
  );
}

function EffectRow({
  label,
  baseline,
  current,
  delta,
  goodWhenUp,
}: {
  label: string;
  baseline: string;
  current: string;
  delta: string | null;
  goodWhenUp?: boolean;
}) {
  const deltaTone = (() => {
    if (!delta || delta === 'no change') return 'text-stone-500';
    const isUp = delta.startsWith('+');
    if (goodWhenUp === undefined) return 'text-stone-700';
    const good = goodWhenUp ? isUp : !isUp;
    return good ? 'text-emerald-700' : 'text-rose-700';
  })();
  return (
    <div className="rounded-2xl border border-stone-100 bg-stone-50/70 px-3 py-2">
      <p className="text-xs font-medium text-stone-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-stone-900">{current}</p>
      <p className="mt-0.5 text-xs text-stone-500">
        was {baseline}
        {delta ? (
          <>
            {' '}
            · <span className={`font-semibold ${deltaTone}`}>{delta}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

// Rank candidates: primary = flex success rate, secondary = monthly supported spend.
// Compared against the baseline (no additional solution), return a sorted list
// where the top entry is the most helpful solution.
interface ScoredSuggestion {
  responseId: string;
  successDelta: number;
  monthlyDelta: number;
  outcome: SuggestionOutcome;
}
function rankSuggestions(
  baseline: SuggestionBaselineOutcome,
  candidates: SuggestionOutcome[],
): ScoredSuggestion[] {
  return candidates
    .map<ScoredSuggestion>((c) => ({
      responseId: c.responseId,
      successDelta: c.successRate - baseline.successRate,
      monthlyDelta: c.monthlyEstimate - baseline.monthlyEstimate,
      outcome: c,
    }))
    .sort((a, b) => {
      if (Math.abs(a.successDelta - b.successDelta) > 0.005) {
        return b.successDelta - a.successDelta;
      }
      return b.monthlyDelta - a.monthlyDelta;
    });
}

function describeSuggestion(s: ScoredSuggestion): string {
  const successFragment =
    Math.abs(s.successDelta) < 0.005
      ? 'keeps success about the same'
      : `${s.successDelta > 0 ? 'lifts' : 'drops'} flex success by ${(
          Math.abs(s.successDelta) * 100
        ).toFixed(1)} pts`;
  const spendFragment =
    Math.abs(s.monthlyDelta) < 5
      ? 'monthly spend roughly flat'
      : `monthly spend ${s.monthlyDelta > 0 ? '+' : '−'}${formatCurrency(
          Math.round(Math.abs(s.monthlyDelta)),
        )}`;
  return `${successFragment}, ${spendFragment}`;
}

function SuggestionsCard({
  status,
  progress,
  error,
  results,
  selectedStressors,
  selectedResponses,
  onRun,
  onCancel,
  onApply,
}: {
  status: 'idle' | 'running' | 'ready' | 'error';
  progress: { completed: number; total: number };
  error: string | null;
  results: {
    baseline: SuggestionBaselineOutcome;
    candidates: SuggestionOutcome[];
    stressorIds: string[];
    fixedResponseIds: string[];
  } | null;
  selectedStressors: string[];
  selectedResponses: string[];
  onRun: () => void;
  onCancel: () => void;
  onApply: (responseId: string) => void;
}) {
  const data = useAppStore((state) => state.data);
  const hasTweaks = selectedStressors.length > 0;
  const ranked = results ? rankSuggestions(results.baseline, results.candidates) : [];
  // Detect "stale" — the user has since changed tweaks/responses, so the results
  // shown might no longer reflect the current inputs.
  const isStale =
    status === 'ready' &&
    results !== null &&
    (results.stressorIds.join(',') !== selectedStressors.join(',') ||
      results.fixedResponseIds.join(',') !== selectedResponses.join(','));

  return (
    <article className="mb-6 rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
            Suggestions
          </p>
          <p className="mt-1 text-sm text-stone-600">
            {hasTweaks
              ? 'Stack-rank the remaining solutions against the tweaks you picked. Runs ~' +
                (selectedResponses.length > 0 ? '' : '') +
                'one simulation per candidate, about 10–20 seconds total.'
              : 'Pick at least one tweak on the left first, then I can rank which solution helps most.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === 'running' ? (
            <>
              <span className="text-xs text-stone-500">
                {progress.completed}/{progress.total}
              </span>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-full border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onRun}
              disabled={!hasTweaks}
              className="rounded-full bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Find my best solution
            </button>
          )}
        </div>
      </div>

      {error ? (
        <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>
      ) : null}

      {status === 'ready' && ranked.length > 0 ? (
        <div className="mt-4">
          {isStale ? (
            <p className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Your tweaks or solutions changed since these suggestions were ranked — run again to
              refresh.
            </p>
          ) : null}
          <p className="text-xs text-stone-500">
            Baseline (no new solution): flex success{' '}
            <span className="font-semibold text-stone-700">
              {formatPercent(results!.baseline.successRate)}
            </span>
            , monthly{' '}
            <span className="font-semibold text-stone-700">
              {formatCurrency(Math.round(results!.baseline.monthlyEstimate))}
            </span>
            .
          </p>
          <ol className="mt-3 flex flex-col gap-2">
            {ranked.map((s, idx) => {
              const copy = SOLUTION_COPY[s.responseId] ?? {
                name: s.responseId,
                hint: '',
              };
              const mechanic = describeResponseMechanic(s.responseId, data);
              const positive = s.successDelta > 0.005 || s.monthlyDelta > 5;
              const cutLabel =
                s.outcome.spendingCutRate >= 0.99
                  ? 'Almost always trims spending in bad years'
                  : s.outcome.spendingCutRate >= 0.5
                    ? 'Often trims spending in bad years'
                    : s.outcome.spendingCutRate > 0.05
                      ? 'Occasionally trims spending in bad years'
                      : 'Rarely trims spending';
              const irmaaLabel =
                s.outcome.irmaaExposureRate < 0.01
                  ? 'No Medicare IRMAA surcharges'
                  : s.outcome.irmaaExposureRate < 0.25
                    ? 'Rare Medicare IRMAA surcharges'
                    : s.outcome.irmaaExposureRate < 0.6
                      ? 'Some Medicare IRMAA surcharges'
                      : 'Frequent Medicare IRMAA surcharges';
              return (
                <li
                  key={s.responseId}
                  className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-3 py-3 ${
                    idx === 0 && positive
                      ? 'border-emerald-300 bg-emerald-50/60'
                      : 'border-stone-200 bg-stone-50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-stone-900">
                      {idx + 1}. {copy.name}
                      {idx === 0 && positive ? (
                        <span className="ml-2 rounded-full bg-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
                          Best pick
                        </span>
                      ) : null}
                    </p>
                    {mechanic ? (
                      <p className="mt-0.5 text-xs text-stone-600">{mechanic}</p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-stone-500">
                      Plan works {formatPercent(s.outcome.successRate)} of the time · {cutLabel} ·{' '}
                      {irmaaLabel}
                    </p>
                  </div>
                  <div className="flex flex-col items-end leading-tight">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
                      Monthly spend
                    </span>
                    <span className="text-xl font-semibold text-teal-700">
                      {formatCurrency(Math.round(s.outcome.monthlyEstimate))}
                    </span>
                    <span
                      className={`text-[11px] font-semibold ${
                        Math.abs(s.monthlyDelta) < 5
                          ? 'text-stone-500'
                          : s.monthlyDelta > 0
                            ? 'text-emerald-700'
                            : 'text-rose-700'
                      }`}
                    >
                      {Math.abs(s.monthlyDelta) < 5
                        ? 'no change'
                        : `${s.monthlyDelta > 0 ? '+' : '−'}${formatCurrency(
                            Math.round(Math.abs(s.monthlyDelta)),
                          )}/mo vs baseline`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onApply(s.responseId)}
                    className="rounded-full border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-800 transition hover:bg-indigo-100"
                  >
                    Apply
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-[11px] text-stone-400">
            Ranking uses a reduced-run simulation (1,500 trials) for speed; commit to Plan to
            refresh at full resolution.
          </p>
        </div>
      ) : null}

      {status === 'running' && progress.total > 0 ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
          <div
            className="h-full bg-indigo-500 transition-all"
            style={{
              width: `${Math.min(100, Math.round((progress.completed / progress.total) * 100))}%`,
            }}
          />
        </div>
      ) : null}
    </article>
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
    const runStartMs = performance.now();
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
          console.log(
            `[perf] run-analysis (worker): ${(performance.now() - runStartMs).toFixed(0)}ms`,
          );
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
        seedBase: interactiveAssumptions.simulationSeed ?? 0,
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
