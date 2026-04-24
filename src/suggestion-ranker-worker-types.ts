import type { MarketAssumptions, SeedData } from './types';

/** One candidate solution to evaluate against the fixed stressor + response set. */
export interface SuggestionCandidate {
  /** Response id to add on top of the fixed responses. */
  responseId: string;
}

export interface SuggestionRankingRequest {
  type: 'run';
  payload: {
    requestId: string;
    data: SeedData;
    assumptions: MarketAssumptions;
    selectedStressors: string[];
    /** Responses the user has already ticked; each candidate is evaluated *in addition* to these. */
    fixedResponses: string[];
    /** Responses to evaluate, one at a time, as additions to `fixedResponses`. */
    candidates: SuggestionCandidate[];
    /** Optional run count override (defaults to 1500 — faster than a full plan run). */
    runsPerCandidate?: number;
  };
}

export interface SuggestionRankingCancel {
  type: 'cancel';
  requestId: string;
}

export type SuggestionRankerWorkerRequest =
  | SuggestionRankingRequest
  | SuggestionRankingCancel;

/** Summary of one candidate's simulated outcome. */
export interface SuggestionOutcome {
  responseId: string;
  /** Flex success rate (planner-enhanced primary path). */
  successRate: number;
  /** Monthly supported spend derived from the first non-zero spending year. */
  monthlyEstimate: number;
  /** Median ending wealth. */
  medianEndingWealth: number;
  /** Guardrail-cut rate. */
  spendingCutRate: number;
  /** IRMAA exposure rate. */
  irmaaExposureRate: number;
  /** Lifetime federal tax (median) summed across the yearly series. */
  lifetimeFederalTax: number;
}

export interface SuggestionBaselineOutcome extends SuggestionOutcome {
  /** Marker for the "do nothing more" case — no candidate added. */
  isBaseline: true;
}

export interface SuggestionRankingProgress {
  type: 'progress';
  requestId: string;
  /** Number of candidates completed so far (excluding the baseline). */
  completed: number;
  /** Total candidates to evaluate (excluding the baseline). */
  total: number;
}

export interface SuggestionRankingResult {
  type: 'result';
  requestId: string;
  baseline: SuggestionBaselineOutcome;
  candidates: SuggestionOutcome[];
}

export interface SuggestionRankingError {
  type: 'error';
  requestId: string;
  error: string;
}

export interface SuggestionRankingCancelled {
  type: 'cancelled';
  requestId: string;
}

export type SuggestionRankerWorkerResponse =
  | SuggestionRankingProgress
  | SuggestionRankingResult
  | SuggestionRankingError
  | SuggestionRankingCancelled;
