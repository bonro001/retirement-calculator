import { initialSeedData } from './data';
import type { MarketAssumptions, PathResult, SeedData, SimulationStrategyMode } from './types';
import { buildPathResults } from './utils';
import type { RandomTapeController, SimulationRandomTape } from './random-tape';
import {
  pathToPolicyMiningSummary,
  type PolicyMiningSummary,
} from './policy-mining-summary-contract';

export const DEFAULT_ENGINE_COMPARE_ASSUMPTIONS: MarketAssumptions = {
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

export interface EngineCompareOptions {
  data?: SeedData;
  assumptions?: Partial<MarketAssumptions>;
  trials?: number;
  mode?: SimulationStrategyMode;
  replayTape?: SimulationRandomTape;
  recordTape?: boolean;
  useHistoricalBootstrap?: boolean;
  tolerance?: number;
}

export interface EngineFirstDifference {
  field: string;
  expected: unknown;
  actual: unknown;
  delta: number | null;
  tolerance: number;
}

export interface EngineCompareReport {
  pass: boolean;
  checkedFields: number;
  firstDifference: EngineFirstDifference | null;
  referenceRuntimeMs: number;
  candidateRuntimeMs: number;
  recordedTape?: SimulationRandomTape;
  summary: {
    mode: SimulationStrategyMode;
    trials: number;
    successRate: number;
    medianEndingWealth: number;
    p10EndingWealth: number;
    p90EndingWealth: number;
  };
}

export interface EngineCandidateRequestV1 {
  schemaVersion: 'engine-candidate-request-v1';
  data: SeedData;
  assumptions: MarketAssumptions;
  mode: SimulationStrategyMode;
  tape: SimulationRandomTape;
  annualSpendTarget?: number;
  outputLevel?: 'full_trace' | 'policy_mining_summary';
  instrumentation?: {
    taxCallCounts?: boolean;
    moduleTimings?: boolean;
  };
}

export interface EngineCandidateResponseV1 {
  schemaVersion: 'engine-candidate-response-v1';
  runtime: string;
  path?: PathResult;
  summary?: PolicyMiningSummary;
  diagnostics?: Record<string, unknown>;
}

export type EngineCandidateRequest = EngineCandidateRequestV1;
export type EngineCandidateResponse = EngineCandidateResponseV1;

export interface EngineReferenceRun {
  data: SeedData;
  assumptions: MarketAssumptions;
  mode: SimulationStrategyMode;
  path: PathResult;
  runtimeMs: number;
  tape?: SimulationRandomTape;
}

function cloneSeedData(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function buildAssumptions(options: EngineCompareOptions): MarketAssumptions {
  return {
    ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
    ...options.assumptions,
    simulationRuns: Math.max(
      1,
      Math.floor(options.trials ?? options.assumptions?.simulationRuns ?? 200),
    ),
    useHistoricalBootstrap:
      options.useHistoricalBootstrap ??
      options.assumptions?.useHistoricalBootstrap ??
      DEFAULT_ENGINE_COMPARE_ASSUMPTIONS.useHistoricalBootstrap,
  };
}

function runSelectedPath(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  mode: SimulationStrategyMode;
  randomTape?: RandomTapeController;
}) {
  const paths = buildPathResults(input.data, input.assumptions, [], [], {
    pathMode: 'selected_only',
    strategyMode: input.mode,
    randomTape: input.randomTape,
  });
  const path = paths[0];
  if (!path) {
    throw new Error('Engine compare expected one selected path result');
  }
  return path;
}

export function runEngineReference(options: EngineCompareOptions = {}): EngineReferenceRun {
  const data = cloneSeedData(options.data ?? initialSeedData);
  const assumptions = buildAssumptions(options);
  const mode = options.mode ?? 'planner_enhanced';
  let recordedTape: SimulationRandomTape | undefined;
  const replayTape = options.replayTape;

  const referenceStart = performance.now();
  const path = runSelectedPath({
    data,
    assumptions,
    mode,
    randomTape: replayTape
      ? {
          mode: 'replay',
          tape: replayTape,
        }
      : options.recordTape
        ? {
            mode: 'record',
            label: `engine-compare:${mode}`,
            onRecord: (tape) => {
              recordedTape = tape;
            },
          }
        : undefined,
  });
  const runtimeMs = performance.now() - referenceStart;

  return {
    data,
    assumptions,
    mode,
    path,
    runtimeMs,
    tape: replayTape ?? recordedTape,
  };
}

export function buildEngineCandidateRequest(
  reference: EngineReferenceRun,
  outputLevel: EngineCandidateRequest['outputLevel'] = 'full_trace',
): EngineCandidateRequest {
  if (!reference.tape) {
    throw new Error('Candidate requests require a random tape');
  }
  return {
    schemaVersion: 'engine-candidate-request-v1',
    data: reference.data,
    assumptions: reference.assumptions,
    mode: reference.mode,
    tape: reference.tape,
    outputLevel,
  };
}

export function assertEngineCandidateRequest(
  value: unknown,
): asserts value is EngineCandidateRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('Candidate request must be a JSON object');
  }
  const request = value as Partial<EngineCandidateRequest>;
  if (request.schemaVersion !== 'engine-candidate-request-v1') {
    throw new Error(
      `Unsupported candidate request schema: ${String(request.schemaVersion ?? 'missing')}`,
    );
  }
  if (!request.data || !request.assumptions || !request.mode || !request.tape) {
    throw new Error('Candidate request is missing data, assumptions, mode, or tape');
  }
}

export function assertEngineCandidateResponse(
  value: unknown,
): asserts value is EngineCandidateResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('Candidate response must be a JSON object');
  }
  const response = value as Partial<EngineCandidateResponse>;
  if (response.schemaVersion !== 'engine-candidate-response-v1') {
    throw new Error(
      `Unsupported candidate response schema: ${String(response.schemaVersion ?? 'missing')}`,
    );
  }
  if (!response.path && !response.summary) {
    throw new Error('Candidate response is missing path or summary');
  }
}

export function runEngineCandidateRequest(
  request: EngineCandidateRequest,
): EngineCandidateResponse {
  const path = runSelectedPath({
    data: cloneSeedData(request.data),
    assumptions: request.assumptions,
    mode: request.mode,
    randomTape: {
      mode: 'replay',
      tape: request.tape,
    },
  });

  return {
    schemaVersion: 'engine-candidate-response-v1',
    runtime: 'typescript-replay',
    path: request.outputLevel === 'policy_mining_summary' ? undefined : path,
    summary: pathToPolicyMiningSummary(path),
  };
}

function isComparableLeaf(value: unknown) {
  return (
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function walkComparableLeaves(
  value: unknown,
  prefix: string,
  visit: (field: string, value: unknown) => void,
) {
  if (isComparableLeaf(value)) {
    visit(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkComparableLeaves(item, `${prefix}[${index}]`, visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walkComparableLeaves(child, prefix ? `${prefix}.${key}` : key, visit);
    }
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    const match = /^(.+?)\[(\d+)]$/.exec(segment);
    if (match) {
      const [, key, rawIndex] = match;
      const child = (current as Record<string, unknown>)[key];
      return Array.isArray(child) ? child[Number(rawIndex)] : undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function compareLeaf(
  field: string,
  expectedValue: unknown,
  actualValue: unknown,
  tolerance: number,
): EngineFirstDifference | null {
  if (actualValue === undefined) {
    return {
      field,
      expected: expectedValue,
      actual: undefined,
      delta: null,
      tolerance,
    };
  }
  if (typeof expectedValue === 'number' && typeof actualValue === 'number') {
    const effectiveTolerance =
      field.endsWith('Rate') ||
      field.includes('Rate') ||
      field.includes('Probability') ||
      field.includes('Year') ||
      field === 'successRate'
        ? tolerance
        : Math.max(tolerance, 1);
    const delta = Math.abs(expectedValue - actualValue);
    return delta > effectiveTolerance
      ? {
          field,
          expected: expectedValue,
          actual: actualValue,
          delta,
          tolerance: effectiveTolerance,
        }
      : null;
  }
  return expectedValue !== actualValue
    ? {
        field,
        expected: expectedValue,
        actual: actualValue,
        delta: null,
        tolerance,
      }
    : null;
}

const PRIORITY_COMPARE_FIELDS = [
  'successRate',
  'medianEndingWealth',
  'endingWealthPercentiles.p10',
  'endingWealthPercentiles.p50',
  'endingWealthPercentiles.p90',
  'annualFederalTaxEstimate',
  'irmaaExposureRate',
  'yearlySeries[0].medianAssets',
  'yearlySeries[0].medianSpending',
  'yearlySeries[0].medianFederalTax',
];

const SKIPPED_COMPARE_FIELDS = new Set([
  'flexibilityScore',
  'cornerRiskScore',
  'cornerRisk',
  'failureMode',
  'notes',
  'irmaaExposure',
  'yearsFunded',
  'simulationConfiguration',
  'simulationDiagnostics',
  'riskMetrics',
  'yearlySeries',
]);

function shouldSkipCompareField(field: string) {
  for (const skipped of SKIPPED_COMPARE_FIELDS) {
    if (field === skipped || field.startsWith(`${skipped}.`) || field.startsWith(`${skipped}[`)) {
      return true;
    }
  }
  return false;
}

export function comparePathResults(
  expected: PathResult,
  actual: PathResult,
  tolerance = 1e-9,
): Pick<EngineCompareReport, 'pass' | 'checkedFields' | 'firstDifference'> {
  const expectedLeaves = new Map<string, unknown>();
  walkComparableLeaves(expected, '', (field, value) => expectedLeaves.set(field, value));
  const actualLeaves = new Map<string, unknown>();
  walkComparableLeaves(actual, '', (field, value) => actualLeaves.set(field, value));

  let checkedFields = 0;
  let firstDifference: EngineFirstDifference | null = null;
  for (const field of PRIORITY_COMPARE_FIELDS) {
    if (!expectedLeaves.has(field)) {
      continue;
    }
    checkedFields += 1;
    firstDifference = compareLeaf(
      field,
      valueAtPath(expected, field),
      valueAtPath(actual, field),
      tolerance,
    );
    if (firstDifference) {
      break;
    }
  }
  for (const [field, actualValue] of actualLeaves.entries()) {
    if (firstDifference) {
      break;
    }
    if (shouldSkipCompareField(field)) {
      continue;
    }
    if (PRIORITY_COMPARE_FIELDS.includes(field)) {
      continue;
    }
    if (!expectedLeaves.has(field)) {
      firstDifference = {
        field,
        expected: undefined,
        actual: actualValue,
        delta: null,
        tolerance,
      };
      break;
    }
    checkedFields += 1;
    const expectedValue = expectedLeaves.get(field);
    firstDifference = compareLeaf(field, expectedValue, actualValue, tolerance);
  }
  if (!firstDifference) {
    for (const [field, expectedValue] of expectedLeaves.entries()) {
      if (shouldSkipCompareField(field)) {
        continue;
      }
      if (!actualLeaves.has(field)) {
        firstDifference = {
          field,
          expected: expectedValue,
          actual: undefined,
          delta: null,
          tolerance,
        };
        break;
      }
    }
  }

  return {
    pass: firstDifference === null,
    checkedFields,
    firstDifference,
  };
}

export function runEngineCompare(options: EngineCompareOptions = {}): EngineCompareReport {
  const reference = runEngineReference(options);
  const tapeForReplay = reference.tape;
  if (!tapeForReplay) {
    return {
      pass: true,
      checkedFields: 0,
      firstDifference: null,
      referenceRuntimeMs: reference.runtimeMs,
      candidateRuntimeMs: 0,
      summary: {
        mode: reference.mode,
        trials: reference.assumptions.simulationRuns,
        successRate: reference.path.successRate,
        medianEndingWealth: reference.path.medianEndingWealth,
        p10EndingWealth: reference.path.endingWealthPercentiles.p10,
        p90EndingWealth: reference.path.endingWealthPercentiles.p90,
      },
    };
  }

  const candidateStart = performance.now();
  const candidate = runSelectedPath({
    data: cloneSeedData(reference.data),
    assumptions: reference.assumptions,
    mode: reference.mode,
    randomTape: {
      mode: 'replay',
      tape: tapeForReplay,
    },
  });
  const candidateRuntimeMs = performance.now() - candidateStart;
  const comparison = comparePathResults(reference.path, candidate, options.tolerance);

  return {
    ...comparison,
    referenceRuntimeMs: reference.runtimeMs,
    candidateRuntimeMs,
    recordedTape: reference.tape,
    summary: {
      mode: reference.mode,
      trials: reference.assumptions.simulationRuns,
      successRate: reference.path.successRate,
      medianEndingWealth: reference.path.medianEndingWealth,
      p10EndingWealth: reference.path.endingWealthPercentiles.p10,
      p90EndingWealth: reference.path.endingWealthPercentiles.p90,
    },
  };
}
