import { create } from 'zustand';
import { initialSeedData } from './data';
import type { PlanEvaluation } from './plan-evaluation';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
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
  JSON.parse(JSON.stringify(value)) as SeedData;

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
    fromHolding.value = Number((fromHolding.value - move).toFixed(2));

    const toHolding =
      sourceAccount.holdings.find((holding) => holding.symbol.toUpperCase() === normalizedTo) ??
      (() => {
        const created = { symbol: normalizedTo, value: 0 };
        sourceAccount.holdings?.push(created);
        return created;
      })();
    toHolding.value = Number((toHolding.value + move).toFixed(2));
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

const areSeedDataEqual = (left: SeedData, right: SeedData) =>
  JSON.stringify(left) === JSON.stringify(right);

interface PendingState {
  data: SeedData;
  appliedData: SeedData;
  draftSelectedStressors: string[];
  draftSelectedResponses: string[];
  draftAssumptions: MarketAssumptions;
  appliedSelectedStressors: string[];
  appliedSelectedResponses: string[];
  appliedAssumptions: MarketAssumptions;
}

const hasPendingChanges = (state: PendingState) =>
  !areSeedDataEqual(state.data, state.appliedData) ||
  !areIdListsEqual(state.draftSelectedStressors, state.appliedSelectedStressors) ||
  !areIdListsEqual(state.draftSelectedResponses, state.appliedSelectedResponses) ||
  !areAssumptionsEqual(state.draftAssumptions, state.appliedAssumptions);

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
  hasPendingSimulationChanges: boolean;
  unifiedPlanRerunNonce: number;
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
  updateIncome: <K extends 'salaryAnnual' | 'salaryEndDate'>(
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
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260416,
  assumptionsVersion: 'v1',
};

export const useAppStore = create<AppState>((set) => ({
  data: cloneSeedData(initialSeedData),
  appliedData: cloneSeedData(initialSeedData),
  currentScreen: 'overview',
  draftSelectedStressors: [],
  draftSelectedResponses: [],
  draftAssumptions: defaultAssumptions,
  appliedSelectedStressors: [],
  appliedSelectedResponses: [],
  appliedAssumptions: defaultAssumptions,
  hasPendingSimulationChanges: false,
  unifiedPlanRerunNonce: 0,
  draftTradeSetActivities: [],
  latestUnifiedPlanEvaluationContext: null,
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
    set((state) => ({
      latestUnifiedPlanEvaluationContext: {
        evaluation,
        capturedAtIso: new Date().toISOString(),
        fingerprint: buildEvaluationFingerprint({
          data: state.data,
          assumptions: state.draftAssumptions,
          selectedStressors: state.draftSelectedStressors,
          selectedResponses: state.draftSelectedResponses,
        }),
      },
    })),
  clearLatestUnifiedPlanEvaluationContext: () => set({ latestUnifiedPlanEvaluationContext: null }),
  toggleStressor: (id) =>
    set((state) => {
      const draftSelectedStressors = state.draftSelectedStressors.includes(id)
        ? state.draftSelectedStressors.filter((item) => item !== id)
        : [...state.draftSelectedStressors, id];
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        draftSelectedStressors,
      });

      return { draftSelectedStressors, hasPendingSimulationChanges };
    }),
  toggleResponse: (id) =>
    set((state) => {
      const draftSelectedResponses = state.draftSelectedResponses.includes(id)
        ? state.draftSelectedResponses.filter((item) => item !== id)
        : [...state.draftSelectedResponses, id];
      const hasPendingSimulationChanges = hasPendingChanges({
        ...state,
        draftSelectedResponses,
      });

      return { draftSelectedResponses, hasPendingSimulationChanges };
    }),
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

      return {
        appliedData,
        appliedSelectedStressors,
        appliedSelectedResponses,
        appliedAssumptions,
        hasPendingSimulationChanges: hasPendingChanges({
          ...state,
          appliedData,
          appliedSelectedStressors,
          appliedSelectedResponses,
          appliedAssumptions,
        }),
      };
    }),
  resetDraftToApplied: () =>
    set((state) => {
      const data = cloneSeedData(state.appliedData);
      const draftSelectedStressors = [...state.appliedSelectedStressors];
      const draftSelectedResponses = [...state.appliedSelectedResponses];
      const draftAssumptions = { ...state.appliedAssumptions };
      return {
        data,
        draftSelectedStressors,
        draftSelectedResponses,
        draftAssumptions,
        hasPendingSimulationChanges: hasPendingChanges({
          ...state,
          data,
          draftSelectedStressors,
          draftSelectedResponses,
          draftAssumptions,
        }),
      };
    }),
}));
