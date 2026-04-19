import { create } from 'zustand';
import { initialSeedData } from './data';
import type {
  IncomeData,
  MarketAssumptions,
  ScreenId,
  SeedData,
  SpendingData,
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
  setCurrentScreen: (screen: ScreenId) => void;
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
  updateSocialSecurityClaim: (person: string, claimAge: number) => void;
  updateWindfall: (name: string, field: 'year' | 'amount', value: number) => void;
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
  setCurrentScreen: (screen) => set({ currentScreen: screen }),
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
      const data = {
        ...state.data,
        income: {
          ...state.data.income,
          windfalls: state.data.income.windfalls.map((item) =>
            item.name === name
              ? {
                  ...item,
                  [field]: value,
                }
              : item,
          ),
        },
      };
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
