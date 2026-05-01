import type { MarketAssumptions, SeedData } from './types';
import type {
  Policy,
  PolicyEvaluation,
  PolicyMinerShadowStats,
} from './policy-miner-types';

/**
 * Wire protocol for the policy-miner worker pool.
 *
 * Design notes:
 *   - The pool primes each worker once per session with the SeedData +
 *     assumptions + session metadata. Subsequent run messages reference
 *     the primed session by id, so we don't pay the SeedData clone cost
 *     on every policy. SeedData is the dominant payload — 50KB to several
 *     hundred KB for real PDF-imported plans — and a 7,776-policy mining
 *     session would otherwise transfer it 7,776× per worker × N workers.
 *   - A single `run` message can carry one OR many policies (see
 *     `policies` field). Batches of 4-8 amortize postMessage overhead
 *     for sub-second policies; single-policy runs keep cancellation
 *     responsive when policies are slow (~5s at production trial counts).
 *   - The worker mirrors the in-process `evaluatePolicy` exactly — same
 *     deterministic ids, same metric extraction. So a future remote
 *     dispatcher could swap the worker for an HTTP endpoint without
 *     touching anything upstream.
 */

export interface PolicyMinerPrimePayload {
  sessionId: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
}

export interface PolicyMinerRunPayload {
  requestId: string;
  sessionId: string;
  /** One or many policies. Worker evaluates them sequentially in order. */
  policies: Policy[];
}

export interface PolicyMinerPrimeRequest {
  type: 'prime';
  payload: PolicyMinerPrimePayload;
}

export interface PolicyMinerRunRequest {
  type: 'run';
  payload: PolicyMinerRunPayload;
}

export interface PolicyMinerUnprimeRequest {
  type: 'unprime';
  sessionId: string;
}

export interface PolicyMinerCancelRequest {
  type: 'cancel';
  requestId: string;
}

export type PolicyMinerWorkerRequest =
  | PolicyMinerPrimeRequest
  | PolicyMinerRunRequest
  | PolicyMinerUnprimeRequest
  | PolicyMinerCancelRequest;

export interface PolicyMinerResultResponse {
  type: 'result';
  requestId: string;
  evaluations: PolicyEvaluation[];
  /** Wall-clock time the worker spent on this batch, milliseconds. */
  batchDurationMs: number;
  shadowStats?: PolicyMinerShadowStats;
}

export interface PolicyMinerErrorResponse {
  type: 'error';
  requestId: string;
  error: string;
  /** Evaluations completed before the failure, if any. */
  partial: PolicyEvaluation[];
  shadowStats?: PolicyMinerShadowStats;
}

export interface PolicyMinerCancelledResponse {
  type: 'cancelled';
  requestId: string;
  partial: PolicyEvaluation[];
  shadowStats?: PolicyMinerShadowStats;
}

export type PolicyMinerWorkerResponse =
  | PolicyMinerResultResponse
  | PolicyMinerErrorResponse
  | PolicyMinerCancelledResponse;
