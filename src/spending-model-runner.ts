import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import {
  SPENDING_MODEL_SIMULATION_MODES,
  buildDefaultSpendingModelPresetDefinitions,
  buildSpendingModelPresetDefinition,
  buildSpendingModelSchedule,
  resolveHouseholdSpendingModifiers,
  type HouseholdSpendingModifiers,
  type SpendingModelPresetDefinition,
  type SpendingModelPresetId,
  type SpendingModelScheduleResult,
  type SpendingModelSimulationMode,
  type SpendingModelWarning,
} from './jpmorgan-spending-surprises';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults } from './utils';

export interface SpendingModelSimulationSummary {
  status: 'complete' | 'failed';
  errorMessage?: string;
  successRate: number | null;
  medianEndingWealth: number | null;
  p10EndingWealth: number | null;
  p90EndingWealth: number | null;
  first10YearFailureRisk: number | null;
  age80AnnualSpend: number | null;
  age95AnnualSpend: number | null;
}

export interface SpendingModelRunResult
  extends Omit<SpendingModelScheduleResult, 'status' | 'provenance'> {
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  provenance: SpendingModelScheduleResult['provenance'] & {
    generatedAtIso: string;
    planFingerprint: string;
    engineVersion: string;
  };
  simulation: {
    byMode: Record<SpendingModelSimulationMode, SpendingModelSimulationSummary>;
  };
}

export interface SpendingModelRunnerInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  presetIds?: SpendingModelPresetId[];
  presetDefinitions?: SpendingModelPresetDefinition[];
  modifiers?: Partial<HouseholdSpendingModifiers>;
  selectedStressors?: string[];
  selectedResponses?: string[];
  startYear?: number;
  nonHealthcareInflationGap?: number;
  generatedAtIso?: string;
  engineVersion?: string;
  runPathResults?: typeof buildPathResults;
}

const DEFAULT_SPENDING_MODEL_ENGINE_VERSION = 'spending-model-runner-v1';

function emptySimulationSummary(errorMessage?: string): SpendingModelSimulationSummary {
  return {
    status: 'failed',
    errorMessage,
    successRate: null,
    medianEndingWealth: null,
    p10EndingWealth: null,
    p90EndingWealth: null,
    first10YearFailureRisk: null,
    age80AnnualSpend: null,
    age95AnnualSpend: null,
  };
}

function buildModeAssumptions(
  assumptions: MarketAssumptions,
  mode: SpendingModelSimulationMode,
): MarketAssumptions {
  return {
    ...assumptions,
    useHistoricalBootstrap: mode === 'historical_precedent',
  };
}

export function buildSpendingModelModeAssumptions(
  assumptions: MarketAssumptions,
) {
  return Object.fromEntries(
    SPENDING_MODEL_SIMULATION_MODES.map((mode) => [
      mode,
      buildModeAssumptions(assumptions, mode),
    ]),
  ) as Record<SpendingModelSimulationMode, MarketAssumptions>;
}

function summarizePath(
  path: PathResult,
  schedule: SpendingModelScheduleResult,
): SpendingModelSimulationSummary {
  return {
    status: 'complete',
    successRate: path.successRate,
    medianEndingWealth: path.medianEndingWealth,
    p10EndingWealth: path.endingWealthPercentiles.p10,
    p90EndingWealth: path.endingWealthPercentiles.p90,
    first10YearFailureRisk: path.riskMetrics.earlyFailureProbability,
    age80AnnualSpend: schedule.intermediateCalculations.age80AnnualSpend,
    age95AnnualSpend: schedule.intermediateCalculations.age95AnnualSpend,
  };
}

function modeFailureWarning(
  mode: SpendingModelSimulationMode,
  errorMessage: string,
): SpendingModelWarning {
  return {
    code: 'mode_failed',
    severity: 'warning',
    message: `${mode} simulation failed: ${errorMessage}`,
    relatedFields: ['simulation.byMode', mode],
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolvePresetDefinitions(input: SpendingModelRunnerInput) {
  const { modifiers } = resolveHouseholdSpendingModifiers(input.modifiers);
  if (input.presetDefinitions) {
    return input.presetDefinitions;
  }
  if (input.presetIds) {
    return input.presetIds.map((id) => buildSpendingModelPresetDefinition(id, modifiers));
  }
  return buildDefaultSpendingModelPresetDefinitions(modifiers).filter(
    (preset) => preset.defaultSelected,
  );
}

function completeProvenance(
  schedule: SpendingModelScheduleResult,
  input: SpendingModelRunnerInput,
) {
  return {
    ...schedule.provenance,
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    planFingerprint: buildEvaluationFingerprint({
      data: input.data,
      assumptions: input.assumptions,
      selectedStressors: input.selectedStressors ?? [],
      selectedResponses: input.selectedResponses ?? [],
    }),
    engineVersion: input.engineVersion ?? DEFAULT_SPENDING_MODEL_ENGINE_VERSION,
  };
}

function skippedRunResult(
  schedule: SpendingModelScheduleResult,
  input: SpendingModelRunnerInput,
): SpendingModelRunResult {
  return {
    ...schedule,
    status: 'skipped',
    provenance: completeProvenance(schedule, input),
    simulation: {
      byMode: {
        forward_parametric: emptySimulationSummary('Skipped before simulation.'),
        historical_precedent: emptySimulationSummary('Skipped before simulation.'),
      },
    },
  };
}

export function runSpendingModels(input: SpendingModelRunnerInput): SpendingModelRunResult[] {
  const presetDefinitions = resolvePresetDefinitions(input);
  if (!presetDefinitions.length) {
    return [];
  }

  const runPathResults = input.runPathResults ?? buildPathResults;
  const selectedStressors = input.selectedStressors ?? [];
  const selectedResponses = input.selectedResponses ?? [];
  const modeAssumptions = buildSpendingModelModeAssumptions(input.assumptions);

  return presetDefinitions.map((preset) => {
    let schedule: SpendingModelScheduleResult;
    try {
      schedule = buildSpendingModelSchedule(input.data, input.assumptions, {
        presetId: preset.id,
        modifiers: input.modifiers,
        startYear: input.startYear,
        nonHealthcareInflationGap: input.nonHealthcareInflationGap,
      });
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      const fallbackSchedule = buildSpendingModelSchedule(
        input.data,
        input.assumptions,
        {
          presetId: 'current_faithful',
          modifiers: input.modifiers,
          startYear: input.startYear,
          nonHealthcareInflationGap: input.nonHealthcareInflationGap,
        },
      );
      return {
        ...fallbackSchedule,
        id: preset.id,
        label: preset.label,
        status: 'failed',
        warnings: [
          ...fallbackSchedule.warnings,
          modeFailureWarning('forward_parametric', errorMessage),
          modeFailureWarning('historical_precedent', errorMessage),
        ],
        provenance: completeProvenance(fallbackSchedule, input),
        preset,
        annualSpendScheduleByYear: {},
        yearlySchedule: [],
        simulation: {
          byMode: {
            forward_parametric: emptySimulationSummary(errorMessage),
            historical_precedent: emptySimulationSummary(errorMessage),
          },
        },
      };
    }

    if (
      schedule.status === 'skipped' ||
      schedule.warnings.some((warning) => warning.severity === 'blocking')
    ) {
      return skippedRunResult(schedule, input);
    }

    const warnings = [...schedule.warnings];
    const byMode = Object.fromEntries(
      SPENDING_MODEL_SIMULATION_MODES.map((mode) => {
        try {
          const [path] = runPathResults(
            input.data,
            modeAssumptions[mode],
            selectedStressors,
            selectedResponses,
            {
              pathMode: 'selected_only',
              annualSpendScheduleByYear: schedule.annualSpendScheduleByYear,
            },
          );
          return [mode, summarizePath(path, schedule)];
        } catch (error) {
          const errorMessage = toErrorMessage(error);
          warnings.push(modeFailureWarning(mode, errorMessage));
          return [mode, emptySimulationSummary(errorMessage)];
        }
      }),
    ) as Record<SpendingModelSimulationMode, SpendingModelSimulationSummary>;

    const completedModes = SPENDING_MODEL_SIMULATION_MODES.filter(
      (mode) => byMode[mode].status === 'complete',
    ).length;
    const status =
      completedModes === SPENDING_MODEL_SIMULATION_MODES.length
        ? 'complete'
        : completedModes > 0
          ? 'partial'
          : 'failed';

    return {
      ...schedule,
      status,
      warnings,
      provenance: completeProvenance(schedule, input),
      simulation: {
        byMode,
      },
    };
  });
}
