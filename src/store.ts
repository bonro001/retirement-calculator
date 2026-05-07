import { create } from 'zustand';
import { initialSeedData } from './data';
import type { PlanEvaluation } from './plan-evaluation';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { loadPlanEvalFromCache, savePlanEvalToCache } from './plan-eval-cache';
import {
  DEFAULT_LEGACY_TARGET_TODAY_DOLLARS,
  loadLegacyTargetFromCache,
  saveLegacyTargetToCache,
} from './legacy-target-cache';
import {
  buildSnapshot,
  loadSnapshots,
  saveSnapshots,
  type PlanSnapshot,
} from './plan-snapshots';
import { buildAdoptedSeedData, diffAdoption } from './policy-adoption';
import type { Policy, PolicyEvaluation } from './policy-miner-types';
import type {
  AccountsData,
  EmployerMatchFormula,
  IncomeData,
  MarketAssumptions,
  PreRetirementContributionSettings,
  ScreenId,
  SeedData,
  SpendingData,
  WindfallEntry,
} from './types';

const sortIds = (values: string[]) => [...values].sort();

const areIdListsEqual = (left: string[], right: string[]) => {
  if (left.length !== right.length) {
    return false;
  }

  const leftSorted = sortIds(left);
  const rightSorted = sortIds(right);
  return leftSorted.every((value, index) => value === rightSorted[index]);
};

const areAssumptionsEqual = (left: MarketAssumptions, right: MarketAssumptions) => {
  const keys = Object.keys(left) as Array<keyof MarketAssumptions>;
  return keys.every((key) => left[key] === right[key]);
};

const cloneSeedData = (value: SeedData): SeedData =>
  structuredClone(value) as SeedData;

type AccountBucketKey = keyof AccountsData;
type TradeInstruction = {
  accountBucket: AccountBucketKey;
  sourceAccountId: string | null;
  fromSymbol: string;
  toSymbol: string;
  dollarAmount: number;
};

export interface DraftTradeSetActivity {
  id: string;
  kind: 'apply' | 'undo';
  actionTitle: string;
  scenarioName: string;
  createdAtIso: string;
  instructions: TradeInstruction[];
}

interface DraftTradeSetActivityInput {
  kind: DraftTradeSetActivity['kind'];
  actionTitle: string;
  scenarioName: string;
  instructions: TradeInstruction[];
}

export interface UnifiedPlanEvaluationContext {
  evaluation: PlanEvaluation;
  capturedAtIso: string;
  fingerprint: string;
}

const DEFAULT_EMPLOYER_MATCH: EmployerMatchFormula = {
  matchRate: 0,
  maxEmployeeContributionPercentOfSalary: 0,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeAllocation = (allocation: Record<string, number>) => {
  const entries = Object.entries(allocation).map(([symbol, weight]) => [
    symbol.toUpperCase(),
    Math.max(0, weight),
  ]) as Array<[string, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) {
    return { CASH: 1 };
  }
  return Object.fromEntries(entries.map(([symbol, weight]) => [symbol, weight / total]));
};

function resolveBucketState(data: SeedData, bucket: AccountBucketKey) {
  return data.accounts[bucket];
}

function applyTradeInstructionsToData(data: SeedData, instructions: TradeInstruction[]) {
  const next = cloneSeedData(data);
  instructions.forEach((instruction) => {
    if (!(instruction.dollarAmount > 0)) {
      return;
    }

    const bucketState = resolveBucketState(next, instruction.accountBucket);
    if (!bucketState || !(bucketState.balance > 0)) {
      return;
    }

    const normalizedFrom = instruction.fromSymbol.toUpperCase();
    const normalizedTo = instruction.toSymbol.toUpperCase();
    const allocation = { ...bucketState.targetAllocation };
    const fromWeight = allocation[normalizedFrom] ?? 0;
    if (!(fromWeight > 0)) {
      return;
    }

    const shiftWeight = clamp(instruction.dollarAmount / bucketState.balance, 0, fromWeight);
    allocation[normalizedFrom] = Math.max(0, fromWeight - shiftWeight);
    allocation[normalizedTo] = (allocation[normalizedTo] ?? 0) + shiftWeight;
    bucketState.targetAllocation = normalizeAllocation(allocation);

    if (!bucketState.sourceAccounts?.length) {
      return;
    }

    const sourceAccount = instruction.sourceAccountId
      ? bucketState.sourceAccounts.find((account) => account.id === instruction.sourceAccountId)
      : null;
    if (!sourceAccount?.holdings?.length) {
      return;
    }

    const fromHolding = sourceAccount.holdings.find(
      (holding) => holding.symbol.toUpperCase() === normalizedFrom,
    );
    if (!fromHolding || !(fromHolding.value > 0)) {
      return;
    }
    const move = clamp(instruction.dollarAmount, 0, fromHolding.value);
    fromHolding.value = Math.round((fromHolding.value - move) * 100) / 100;

    const toHolding =
      sourceAccount.holdings.find((holding) => holding.symbol.toUpperCase() === normalizedTo) ??
      (() => {
        const created = { symbol: normalizedTo, value: 0 };
        sourceAccount.holdings?.push(created);
        return created;
      })();
    toHolding.value = Math.round((toHolding.value + move) * 100) / 100;
  });

  return next;
}

function applyContributionSettingsPatchToData(
  data: SeedData,
  patch: Partial<PreRetirementContributionSettings>,
) {
  const next = cloneSeedData(data);
  const current = next.income.preRetirementContributions ?? {};
  const currentMatch = current.employerMatch ?? DEFAULT_EMPLOYER_MATCH;
  const patchMatch = patch.employerMatch;
  const mergedMatch = patchMatch
    ? {
        matchRate: patchMatch.matchRate ?? currentMatch.matchRate,
        maxEmployeeContributionPercentOfSalary:
          patchMatch.maxEmployeeContributionPercentOfSalary ??
          currentMatch.maxEmployeeContributionPercentOfSalary,
      }
    : current.employerMatch
      ? {
          matchRate: currentMatch.matchRate,
          maxEmployeeContributionPercentOfSalary:
            currentMatch.maxEmployeeContributionPercentOfSalary,
        }
      : {
        ...DEFAULT_EMPLOYER_MATCH,
      };

  next.income.preRetirementContributions = {
    ...current,
    ...patch,
    employerMatch: mergedMatch,
  };
  return next;
}

function normalizeEmployerMatch(
  value: PreRetirementContributionSettings['employerMatch'] | undefined,
) {
  if (!value) {
    return { ...DEFAULT_EMPLOYER_MATCH };
  }
  return {
    matchRate: value.matchRate ?? DEFAULT_EMPLOYER_MATCH.matchRate,
    maxEmployeeContributionPercentOfSalary:
      value.maxEmployeeContributionPercentOfSalary ??
      DEFAULT_EMPLOYER_MATCH.maxEmployeeContributionPercentOfSalary,
  };
}

function normalizeContributionSettings(
  value: PreRetirementContributionSettings | undefined,
): PreRetirementContributionSettings {
  if (!value) {
    return {
      employerMatch: { ...DEFAULT_EMPLOYER_MATCH },
    };
  }
  return {
    ...value,
    employerMatch: normalizeEmployerMatch(value.employerMatch),
  };
}

const areSeedDataEqual = (left: SeedData, right: SeedData) => {
  // Fast path: reference equality. Every mutating action creates a new object
  // via spread/immer, so when the references match, the values are equal and
  // we can skip an expensive JSON.stringify on the entire seed graph.
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
};

export type StressorKnobs = {
  delayedInheritanceYears: number;
  cutSpendingPercent: number;
  /** ISO date (YYYY-MM-DD) the layoff stressor uses as salary-end. Defaults to today. */
  layoffRetireDate: string;
  /** Lump-sum severance paid in the layoff year (real dollars). Defaults to 0. */
  layoffSeverance: number;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export const DEFAULT_STRESSOR_KNOBS: StressorKnobs = {
  delayedInheritanceYears: 5,
  cutSpendingPercent: 20,
  layoffRetireDate: todayIso(),
  layoffSeverance: 0,
};

const areStressorKnobsEqual = (a: StressorKnobs, b: StressorKnobs) =>
  a.delayedInheritanceYears === b.delayedInheritanceYears &&
  a.cutSpendingPercent === b.cutSpendingPercent &&
  a.layoffRetireDate === b.layoffRetireDate &&
  a.layoffSeverance === b.layoffSeverance;

interface PendingState {
  data: SeedData;
  appliedData: SeedData;
  draftSelectedStressors: string[];
  draftSelectedResponses: string[];
  draftAssumptions: MarketAssumptions;
  draftStressorKnobs: StressorKnobs;
  appliedSelectedStressors: string[];
  appliedSelectedResponses: string[];
  appliedAssumptions: MarketAssumptions;
  appliedStressorKnobs: StressorKnobs;
}

const hasPendingChanges = (state: PendingState) =>
  !areSeedDataEqual(state.data, state.appliedData) ||
  !areIdListsEqual(state.draftSelectedStressors, state.appliedSelectedStressors) ||
  !areIdListsEqual(state.draftSelectedResponses, state.appliedSelectedResponses) ||
  !areAssumptionsEqual(state.draftAssumptions, state.appliedAssumptions) ||
  !areStressorKnobsEqual(state.draftStressorKnobs, state.appliedStressorKnobs);

interface AppState {
  data: SeedData;
  appliedData: SeedData;
  currentScreen: ScreenId;
  draftSelectedStressors: string[];
  draftSelectedResponses: string[];
  draftAssumptions: MarketAssumptions;
  appliedSelectedStressors: string[];
  appliedSelectedResponses: string[];
  appliedAssumptions: MarketAssumptions;
  draftStressorKnobs: StressorKnobs;
  appliedStressorKnobs: StressorKnobs;
  updateStressorKnob: <K extends keyof StressorKnobs>(key: K, value: StressorKnobs[K]) => void;
  hasPendingSimulationChanges: boolean;
  unifiedPlanRerunNonce: number;
  planAnalysisStatus: 'pending' | 'running' | 'fresh' | 'stale';
  setPlanAnalysisStatus: (status: 'pending' | 'running' | 'fresh' | 'stale') => void;
  draftTradeSetActivities: DraftTradeSetActivity[];
  latestUnifiedPlanEvaluationContext: UnifiedPlanEvaluationContext | null;
  setCurrentScreen: (screen: ScreenId) => void;
  requestUnifiedPlanRerun: () => void;
  recordDraftTradeSetActivity: (input: DraftTradeSetActivityInput) => void;
  clearDraftTradeSetActivities: () => void;
  setLatestUnifiedPlanEvaluationContext: (evaluation: PlanEvaluation) => void;
  clearLatestUnifiedPlanEvaluationContext: () => void;
  toggleStressor: (id: string) => void;
  toggleResponse: (id: string) => void;
  updateAssumption: <K extends keyof MarketAssumptions>(
    key: K,
    value: MarketAssumptions[K],
  ) => void;
  updateSpending: <K extends keyof SpendingData>(key: K, value: SpendingData[K]) => void;
  /**
   * Set (or clear) the household's end-of-plan legacy goal in today's
   * dollars. Lives on `data.goals.legacyTargetTodayDollars`. Pass
   * `undefined` to clear the target — the Advisor falls back to its
   * "no target set" prompt. Touches both `data` and `appliedData` so the
   * North Star reads consistently across draft and committed views; goals
   * are presentation-only today and don't trigger a pending-changes flag.
   */
  setLegacyTarget: (value: number | undefined) => void;
  updateIncome: <K extends 'salaryAnnual' | 'salaryEndDate' | 'windfalls'>(
    key: K,
    value: IncomeData[K],
  ) => void;
  updatePreRetirementContribution: <K extends keyof PreRetirementContributionSettings>(
    key: K,
    value: PreRetirementContributionSettings[K],
  ) => void;
  updateEmployerMatchContribution: <K extends keyof EmployerMatchFormula>(
    key: K,
    value: EmployerMatchFormula[K],
  ) => void;
  applyPreRetirementContributionPatch: (
    patch: Partial<PreRetirementContributionSettings>,
  ) => void;
  updateSocialSecurityClaim: (person: string, claimAge: number) => void;
  updateWindfall: (
    name: string,
    field:
      | 'year'
      | 'amount'
      | 'costBasis'
      | 'exclusionAmount'
      | 'distributionYears'
      | 'liquidityAmount',
    value: number,
  ) => void;
  applyAccountTradeInstructions: (instructions: TradeInstruction[]) => void;
  replaceDraftData: (nextData: SeedData) => void;
  commitDraftToApplied: () => void;
  resetDraftToApplied: () => void;
  planSnapshots: PlanSnapshot[];
  appendPlanSnapshot: (options?: { label?: string; capturedAt?: string }) => PlanSnapshot;
  applyAccountImport: (nextAccounts: AccountsData, options?: { label?: string }) => PlanSnapshot;
  /**
   * One-shot undo slot for the most recent mined-policy adoption (E.2).
   * Null until the user adopts a policy; cleared on undo or when the
   * user adopts a different policy. We keep only the most recent
   * adoption — the user's mental model is "I just adopted that, undo it"
   * rather than a deep history. For deeper history, snapshots already
   * exist via `appendPlanSnapshot`.
   */
  lastPolicyAdoption: PolicyAdoptionUndo | null;
  /**
   * Adopt a mined policy into the draft and applied plan. Scales spending categories
   * proportionally to hit the policy's annual-spend target, writes SS
   * claim ages, and writes the Roth conversion max. Does NOT touch
   * accounts. Stores the previous draft/applied snapshots in
   * `lastPolicyAdoption` so the change is undoable.
   */
  adoptMinedPolicy: (policy: Policy, evaluation?: PolicyEvaluation | null) => void;
  /** Restore the draft plan to what it was before the last adoption. */
  undoLastPolicyAdoption: () => void;
  /** Forget the last-adoption undo slot without changing the plan. */
  clearLastPolicyAdoption: () => void;
}

export interface PolicyAdoptionUndo {
  /** Snapshot of `data` before the adoption write — restored on undo. */
  previousData: SeedData;
  /** Snapshot of `appliedData` before adoption — restored on undo. */
  previousAppliedData: SeedData;
  /** Which policy was adopted. Used to render the undo banner copy. */
  policy: Policy;
  /** The mined row that was adopted, when available. Lets Cockpit cite
   *  the exact record after adoption changes the plan fingerprint. */
  evaluation?: PolicyEvaluation | null;
  /** Pre-formatted summary line ("$130k/yr · SS 70/68 · Roth $40k"). */
  summary: string;
  /** ISO timestamp the adoption happened, for display. */
  adoptedAtIso: string;
}

const ADOPTED_PLAN_LS_KEY = 'retirement-calc:adopted-plan:v1';

interface PersistedAdoptedPlan {
  version: 1;
  data: SeedData;
  appliedData: SeedData;
  lastPolicyAdoption: PolicyAdoptionUndo;
  savedAtIso: string;
}

function readPersistedAdoptedPlan(): PersistedAdoptedPlan | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(ADOPTED_PLAN_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAdoptedPlan;
    if (parsed?.version !== 1) return null;
    if (!parsed.data || !parsed.appliedData || !parsed.lastPolicyAdoption?.policy) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedAdoptedPlan(payload: PersistedAdoptedPlan | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!payload) {
      window.localStorage.removeItem(ADOPTED_PLAN_LS_KEY);
      return;
    }
    window.localStorage.setItem(ADOPTED_PLAN_LS_KEY, JSON.stringify(payload));
  } catch {
    // localStorage quota / private browsing — adoption still succeeds in memory.
  }
}

const defaultAssumptions: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.074,
  internationalEquityVolatility: 0.18,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 5000,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  // Pre-committed pivots are off by default — enabling them makes the model
  // assume the household will actually pull these levers under stress, which
  // can raise the supported monthly headline by reducing late-life ruin risk.
  pivotSellHouseFloorYears: undefined,
  pivotClaimSSEarlyFloorYears: undefined,
  // Staircase guardrail OFF by default — falls back to single-tier rule.
  // Users can toggle it on in the sandbox tuner; we then seed a sensible
  // 4-tier ladder they can edit row-by-row.
  guardrailLadder: undefined,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260416,
  assumptionsVersion: 'v1',
};

const initialFingerprint = buildEvaluationFingerprint({
  data: initialSeedData,
  assumptions: defaultAssumptions,
  selectedStressors: [],
  selectedResponses: [],
});
const restoredEvalContext = loadPlanEvalFromCache(initialFingerprint);

// Restore the household's North Star (`legacyTargetTodayDollars`) from
// localStorage so a refresh doesn't force them to re-enter it. We splice
// the cached value into the seed data here rather than as a follow-up
// `set()` call so the very first render already shows the right number
// — no flash of the seed default.
const restoredLegacyTarget = loadLegacyTargetFromCache();
const initialLegacyTarget =
  restoredLegacyTarget ?? DEFAULT_LEGACY_TARGET_TODAY_DOLLARS;
const withRestoredLegacyTarget = (data: SeedData): SeedData => ({
  ...cloneSeedData(data),
  goals: {
    ...(data.goals ?? {}),
    legacyTargetTodayDollars: initialLegacyTarget,
  },
});
const seedDataWithRestoredLegacy: SeedData =
  withRestoredLegacyTarget(initialSeedData);
const persistedAdoptedPlan = readPersistedAdoptedPlan();
const initialStoreData: SeedData = persistedAdoptedPlan
  ? withRestoredLegacyTarget(persistedAdoptedPlan.data)
  : seedDataWithRestoredLegacy;
const initialAppliedStoreData: SeedData = persistedAdoptedPlan
  ? withRestoredLegacyTarget(persistedAdoptedPlan.appliedData)
  : seedDataWithRestoredLegacy;
const initialPolicyAdoption: PolicyAdoptionUndo | null = persistedAdoptedPlan
  ? {
      ...persistedAdoptedPlan.lastPolicyAdoption,
      previousData: withRestoredLegacyTarget(
        persistedAdoptedPlan.lastPolicyAdoption.previousData,
      ),
      previousAppliedData: withRestoredLegacyTarget(
        persistedAdoptedPlan.lastPolicyAdoption.previousAppliedData,
      ),
    }
  : null;

const initialSnapshots: PlanSnapshot[] = (() => {
  const existing = loadSnapshots();
  if (existing.length) return existing;
  const seeded = [
    buildSnapshot(seedDataWithRestoredLegacy, {
      capturedAt: new Date().toISOString(),
      label: 'baseline',
      successRate: restoredEvalContext?.evaluation?.summary?.successRate ?? null,
    }),
  ];
  saveSnapshots(seeded);
  return seeded;
})();

export const useAppStore = create<AppState>((set) => ({
  data: cloneSeedData(initialStoreData),
  appliedData: cloneSeedData(initialAppliedStoreData),
  currentScreen: 'mining',
  draftSelectedStressors: [],
  draftSelectedResponses: [],
  draftAssumptions: defaultAssumptions,
  appliedSelectedStressors: [],
  appliedSelectedResponses: [],
  appliedAssumptions: defaultAssumptions,
  draftStressorKnobs: { ...DEFAULT_STRESSOR_KNOBS },
  appliedStressorKnobs: { ...DEFAULT_STRESSOR_KNOBS },
  updateStressorKnob: (key, value) =>
    set((state) => {
      const draftStressorKnobs = { ...state.draftStressorKnobs, [key]: value };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        draftStressorKnobs,
      });
      return { draftStressorKnobs, hasPendingSimulationChanges };
    }),
  hasPendingSimulationChanges: false,
  unifiedPlanRerunNonce: 0,
  planAnalysisStatus: 'pending',
  setPlanAnalysisStatus: (status) => set({ planAnalysisStatus: status }),
  draftTradeSetActivities: [],
  latestUnifiedPlanEvaluationContext: restoredEvalContext,
  setCurrentScreen: (screen) => set({ currentScreen: screen }),
  requestUnifiedPlanRerun: () =>
    set((state) => ({
      unifiedPlanRerunNonce: state.unifiedPlanRerunNonce + 1,
    })),
  recordDraftTradeSetActivity: (input) =>
    set((state) => {
      const nextActivity: DraftTradeSetActivity = {
        id: `draft-trade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: input.kind,
        actionTitle: input.actionTitle,
        scenarioName: input.scenarioName,
        createdAtIso: new Date().toISOString(),
        instructions: input.instructions.map((instruction) => ({
          ...instruction,
        })),
      };

      return {
        draftTradeSetActivities: [nextActivity, ...state.draftTradeSetActivities].slice(0, 25),
      };
    }),
  clearDraftTradeSetActivities: () => set({ draftTradeSetActivities: [] }),
  setLatestUnifiedPlanEvaluationContext: (evaluation) =>
    set((state) => {
      const context = {
        evaluation,
        capturedAtIso: new Date().toISOString(),
        fingerprint: buildEvaluationFingerprint({
          data: state.data,
          assumptions: state.draftAssumptions,
          selectedStressors: state.draftSelectedStressors,
          selectedResponses: state.draftSelectedResponses,
        }),
      };
      savePlanEvalToCache(context);
      return { latestUnifiedPlanEvaluationContext: context };
    }),
  clearLatestUnifiedPlanEvaluationContext: () => set({ latestUnifiedPlanEvaluationContext: null }),
  toggleStressor: (id) => {
    const t0 = performance.now();
    set((state) => {
      const draftSelectedStressors = state.draftSelectedStressors.includes(id)
        ? state.draftSelectedStressors.filter((item) => item !== id)
        : [...state.draftSelectedStressors, id];
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        draftSelectedStressors,
      });

      return { draftSelectedStressors, hasPendingSimulationChanges };
    });
    // eslint-disable-next-line no-console
    console.log(
      `[toggle-perf] toggleStressor(${id}) reducer: ${(performance.now() - t0).toFixed(1)}ms`,
    );
    // Log again after the next paint so we see how long React's render+commit took.
    const clickTs = t0;
    requestAnimationFrame(() => {
      // eslint-disable-next-line no-console
      console.log(
        `[toggle-perf] toggleStressor(${id}) paint-after: ${(
          performance.now() - clickTs
        ).toFixed(1)}ms`,
      );
    });
  },
  toggleResponse: (id) => {
    const t0 = performance.now();
    set((state) => {
      const draftSelectedResponses = state.draftSelectedResponses.includes(id)
        ? state.draftSelectedResponses.filter((item) => item !== id)
        : [...state.draftSelectedResponses, id];
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        draftSelectedResponses,
      });

      return { draftSelectedResponses, hasPendingSimulationChanges };
    });
    // eslint-disable-next-line no-console
    console.log(
      `[toggle-perf] toggleResponse(${id}) reducer: ${(performance.now() - t0).toFixed(1)}ms`,
    );
    const clickTs = t0;
    requestAnimationFrame(() => {
      // eslint-disable-next-line no-console
      console.log(
        `[toggle-perf] toggleResponse(${id}) paint-after: ${(
          performance.now() - clickTs
        ).toFixed(1)}ms`,
      );
    });
  },
  updateAssumption: (key, value) =>
    set((state) => {
      const draftAssumptions = {
        ...state.draftAssumptions,
        [key]: value,
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        draftAssumptions,
      });

      return { draftAssumptions, hasPendingSimulationChanges };
    }),
  updateSpending: (key, value) =>
    set((state) => {
      const data = {
        ...state.data,
        spending: {
          ...state.data.spending,
          [key]: value,
        },
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  setLegacyTarget: (value) =>
    set((state) => {
      // Mirror the value into both draft (`data`) and committed
      // (`appliedData`) — goals don't drive simulation today, so there's
      // no reason to gate the North Star behind a "Run plan" click.
      const writeGoals = (target: SeedData) => ({
        ...target,
        goals: { ...(target.goals ?? {}), legacyTargetTodayDollars: value },
      });
      // Persist to localStorage so the value survives a page refresh.
      // Cache writes are best-effort (storage may be full or disabled);
      // failures are swallowed inside the cache helper.
      saveLegacyTargetToCache(value);
      return {
        data: writeGoals(state.data),
        appliedData: writeGoals(state.appliedData),
      };
    }),
  updateIncome: (key, value) =>
    set((state) => {
      const data = {
        ...state.data,
        income: {
          ...state.data.income,
          [key]: value,
        },
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  updatePreRetirementContribution: (key, value) =>
    set((state) => {
      const normalized = normalizeContributionSettings(
        state.data.income.preRetirementContributions,
      );
      const data = {
        ...state.data,
        income: {
          ...state.data.income,
          preRetirementContributions: {
            ...normalized,
            [key]: value,
          },
        },
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  updateEmployerMatchContribution: (key, value) =>
    set((state) => {
      const current = normalizeContributionSettings(
        state.data.income.preRetirementContributions,
      );
      const data = {
        ...state.data,
        income: {
          ...state.data.income,
          preRetirementContributions: {
            ...current,
            employerMatch: {
              ...normalizeEmployerMatch(current.employerMatch),
              [key]: value,
            },
          },
        },
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  applyPreRetirementContributionPatch: (patch) =>
    set((state) => {
      const data = applyContributionSettingsPatchToData(state.data, patch);
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  updateSocialSecurityClaim: (person, claimAge) =>
    set((state) => {
      const data = {
        ...state.data,
        income: {
          ...state.data.income,
          socialSecurity: state.data.income.socialSecurity.map((entry) =>
            entry.person === person ? { ...entry, claimAge } : entry,
          ),
        },
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  updateWindfall: (name, field, value) =>
    set((state) => {
      const normalizedValue = (() => {
        if (field === 'year' || field === 'distributionYears') {
          return Math.max(0, Math.round(value));
        }
        return Math.max(0, value);
      })();
      const data = {
        ...state.data,
        income: {
          ...state.data.income,
          windfalls: state.data.income.windfalls.map((item): WindfallEntry =>
            item.name !== name
              ? item
              : {
                  ...item,
                  [field]: normalizedValue,
                },
          ),
        },
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  applyAccountTradeInstructions: (instructions) =>
    set((state) => {
      if (!instructions.length) {
        return state;
      }
      const data = applyTradeInstructionsToData(state.data, instructions);
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  replaceDraftData: (nextData) =>
    set((state) => {
      const data = cloneSeedData(nextData);
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
      });

      return { data, hasPendingSimulationChanges };
    }),
  commitDraftToApplied: () =>
    set((state) => {
      const appliedData = cloneSeedData(state.data);
      const appliedSelectedStressors = [...state.draftSelectedStressors];
      const appliedSelectedResponses = [...state.draftSelectedResponses];
      const appliedAssumptions = { ...state.draftAssumptions };
      const appliedStressorKnobs = { ...state.draftStressorKnobs };

      return {
        appliedData,
        appliedSelectedStressors,
        appliedSelectedResponses,
        appliedAssumptions,
        appliedStressorKnobs,
        hasPendingSimulationChanges: hasPendingChanges({
          ...state,
          appliedData,
          appliedSelectedStressors,
          appliedSelectedResponses,
          appliedAssumptions,
          appliedStressorKnobs,
        }),
      };
    }),
  resetDraftToApplied: () =>
    set((state) => {
      const data = cloneSeedData(state.appliedData);
      const draftSelectedStressors = [...state.appliedSelectedStressors];
      const draftSelectedResponses = [...state.appliedSelectedResponses];
      const draftAssumptions = { ...state.appliedAssumptions };
      const draftStressorKnobs = { ...state.appliedStressorKnobs };
      return {
        data,
        draftSelectedStressors,
        draftSelectedResponses,
        draftAssumptions,
        draftStressorKnobs,
        hasPendingSimulationChanges: hasPendingChanges({
          ...state,
          data,
          draftSelectedStressors,
          draftSelectedResponses,
          draftAssumptions,
          draftStressorKnobs,
        }),
      };
    }),
  planSnapshots: initialSnapshots,
  appendPlanSnapshot: (options) => {
    let created: PlanSnapshot | null = null;
    set((state) => {
      const snapshot = buildSnapshot(state.data, {
        capturedAt: options?.capturedAt,
        label: options?.label,
        successRate:
          state.latestUnifiedPlanEvaluationContext?.evaluation?.summary?.successRate ?? null,
      });
      const planSnapshots = [...state.planSnapshots, snapshot];
      saveSnapshots(planSnapshots);
      created = snapshot;
      return { planSnapshots };
    });
    return created as unknown as PlanSnapshot;
  },
  applyAccountImport: (nextAccounts, options) => {
    let created: PlanSnapshot | null = null;
    set((state) => {
      const data: SeedData = { ...state.data, accounts: nextAccounts };
      const appliedData: SeedData = { ...state.appliedData, accounts: nextAccounts };
      const snapshot = buildSnapshot(data, {
        label: options?.label,
        successRate:
          state.latestUnifiedPlanEvaluationContext?.evaluation?.summary?.successRate ?? null,
      });
      const planSnapshots = [...state.planSnapshots, snapshot];
      saveSnapshots(planSnapshots);
      created = snapshot;
      return {
        data,
        appliedData,
        planSnapshots,
        hasPendingSimulationChanges: hasPendingChanges({ ...state, data, appliedData }),
      };
    });
    return created as unknown as PlanSnapshot;
  },
  lastPolicyAdoption: initialPolicyAdoption,
  adoptMinedPolicy: (policy, evaluation = null) =>
    set((state) => {
      const previousData = cloneSeedData(state.data);
      const previousAppliedData = cloneSeedData(state.appliedData);
      const nextData = buildAdoptedSeedData(state.appliedData, policy);
      const appliedData = cloneSeedData(nextData);
      const summary = diffAdoption(state.appliedData, policy).summary;
      const undo: PolicyAdoptionUndo = {
        previousData,
        previousAppliedData,
        policy,
        evaluation,
        summary,
        adoptedAtIso: new Date().toISOString(),
      };
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data: nextData,
        appliedData,
      });
      writePersistedAdoptedPlan({
        version: 1,
        data: nextData,
        appliedData,
        lastPolicyAdoption: undo,
        savedAtIso: new Date().toISOString(),
      });
      // Bump the rerun nonce so UnifiedPlanScreen's existing rerun
      // effect kicks off a fresh Plan Analysis with the adopted policy
      // applied. Otherwise the household has to spot the "stale" banner
      // and click "Run Plan Analysis" themselves before they can see
      // what their adopted policy actually looks like in the projection
      // chart — and the most common feedback was "I clicked adopt, why
      // is the chart not changing?"
      return {
        data: nextData,
        appliedData,
        hasPendingSimulationChanges,
        lastPolicyAdoption: undo,
        unifiedPlanRerunNonce: state.unifiedPlanRerunNonce + 1,
      };
    }),
  undoLastPolicyAdoption: () =>
    set((state) => {
      if (!state.lastPolicyAdoption) return {};
      const data = cloneSeedData(state.lastPolicyAdoption.previousData);
      const appliedData = cloneSeedData(
        state.lastPolicyAdoption.previousAppliedData,
      );
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        data,
        appliedData,
      });
      writePersistedAdoptedPlan(null);
      // Symmetric with adoptMinedPolicy: undo also changes the seed
      // data and the household will want the projection to follow.
      return {
        data,
        appliedData,
        hasPendingSimulationChanges,
        lastPolicyAdoption: null,
        unifiedPlanRerunNonce: state.unifiedPlanRerunNonce + 1,
      };
    }),
  clearLastPolicyAdoption: () => set({ lastPolicyAdoption: null }),
}));
