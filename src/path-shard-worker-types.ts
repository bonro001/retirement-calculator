// @ts-nocheck
import type {
  MarketAssumptions,
  ResponseOption,
  SeedData,
  SimulationStrategyMode,
  Stressor,
} from './types';
import type {
  MonteCarloShardOutput,
  MonteCarloTrialRange,
} from './monte-carlo-engine';
import type { SimulationRunResult, SimulationStressorKnobs } from './utils';

/**
 * Shard worker request/response protocol.
 *
 * The orchestrator (simulation.worker.ts) partitions a path's trial space into
 * K disjoint ranges and dispatches each to a shard worker via `RunRequest`.
 * Each shard runs `runSimulationShard()` over its `trialRange` and returns
 * the engine's raw shard output. The orchestrator merges all K outputs back
 * together via `mergeShardOutputs()` (in identical trial-index order) and
 * feeds the merged output to `aggregateShardedSimulation()` for the final
 * SimulationSummary.
 *
 * Function-typed options on `SimulationExecutionOptions` (onProgress,
 * isCancelled, precomputedEngineOutput, trialRange) are NOT serializable and
 * are stripped from the payload here. The shard worker reconstructs a local
 * isCancelled hook from its `cancelledRequests` set and injects `trialRange`
 * from the payload directly. Progress reporting is intentionally omitted —
 * shard runs are short and the orchestrator reports aggregate progress.
 */
export interface PathShardRunPayload {
  requestId: string;
  /**
   * Worker-side session lookup key. The orchestrator primes every worker
   * with `{ data }` once per simulation request via a `prime` message; each
   * subsequent `run` references that primed payload by sessionId so we don't
   * pay the SeedData clone cost on every shard call (SeedData is the dominant
   * bytes on the wire — 50–500KB for real PDF-imported plans, vs 30+ shard
   * batches per simulation).
   */
  sessionId: string;
  assumptions: MarketAssumptions;
  stressors: Stressor[];
  responses: ResponseOption[];
  trialRange: MonteCarloTrialRange;
  // Subset of SimulationExecutionOptions that crosses the worker boundary
  // cleanly. We deliberately omit onProgress/isCancelled (functions are not
  // structured-cloneable) and the engine-output options (the shard always
  // runs in trialRange mode, never precomputed mode).
  annualSpendTarget?: number;
  annualSpendScheduleByYear?: Record<number, number>;
  pathMode?: 'all' | 'selected_only';
  strategyMode?: SimulationStrategyMode;
  stressorKnobs?: SimulationStressorKnobs;
}

export interface PathShardPrimePayload {
  sessionId: string;
  data: SeedData;
}

export interface PathShardRunRequest {
  type: 'run';
  payload: PathShardRunPayload;
}

export interface PathShardPrimeRequest {
  type: 'prime';
  payload: PathShardPrimePayload;
}

export interface PathShardUnprimeRequest {
  type: 'unprime';
  sessionId: string;
}

export interface PathShardCancelRequest {
  type: 'cancel';
  requestId: string;
}

export type PathShardRequest =
  | PathShardRunRequest
  | PathShardPrimeRequest
  | PathShardUnprimeRequest
  | PathShardCancelRequest;

export interface PathShardResultResponse {
  type: 'result';
  requestId: string;
  output: MonteCarloShardOutput<SimulationRunResult>;
}

export interface PathShardErrorResponse {
  type: 'error';
  requestId: string;
  error: string;
}

export interface PathShardCancelledResponse {
  type: 'cancelled';
  requestId: string;
}

export type PathShardResponse =
  | PathShardResultResponse
  | PathShardErrorResponse
  | PathShardCancelledResponse;
