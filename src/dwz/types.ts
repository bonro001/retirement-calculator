/**
 * Die-With-Zero analyzer — shared types.
 *
 * Phase 1 MVP: minimal surface needed by the what-if simulator.
 * Utility model, recipient stage curves, gift schedule builder, and
 * bequest solver are deferred to later phases.
 */

import type { MarketAssumptions, ScheduledOutflow, SeedData } from '../types';
import type { Policy, PolicyEvaluation } from '../policy-miner-types';

// Re-export so analyzer modules don't need to reach into policy-miner-eval.ts.
export type { Policy, PolicyEvaluation };

// Type alias for SeedData cloner — matches the shape exported by
// policy-miner-eval.ts (`(seed: SeedData) => SeedData`).
export type SeedDataCloner = (data: SeedData) => SeedData;

/**
 * Bundle of inputs `evaluatePolicy` needs. Callers construct this once and
 * pass it through to analyzer functions, avoiding repeated threading of
 * individually-named params.
 */
export interface EvalContext {
  assumptions: MarketAssumptions;
  /** Hash of the SeedData this session is evaluating against. */
  baselineFingerprint: string;
  /** Engine version string — must match the value written into evaluations. */
  engineVersion: string;
  /** Node/host identifier; 'local' is fine for in-process use. */
  evaluatedByNodeId: string;
  /** Deep-clone function for SeedData — avoids lodash/structuredClone version concerns. */
  cloner: SeedDataCloner;
  /** Legacy bequest target in today's dollars (passed to evaluatePolicy). */
  legacyTargetTodayDollars: number;
}

/**
 * One-shot what-if outcome — what happens to the end amount and other
 * key metrics when a candidate gift (or set of gifts) is added to the plan.
 *
 * All dollar fields are in today's dollars (engine deflates internally).
 */
export interface WhatIfOutcome {
  /** Median ending wealth across MC trials (p50). */
  medianEndingWealthTodayDollars: number;
  /** 25th-percentile ending wealth ("painless threshold"). */
  p25EndingWealthTodayDollars: number;
  /** P(ending wealth > 0) — the historical solvent-success rate. */
  solventSuccessRate: number;
  /** P(ending wealth >= legacy target) — bequest-attainment rate. */
  bequestAttainmentRate: number;
}

/**
 * Result of comparing a candidate-gift scenario to the no-gift baseline.
 * All delta values are `withGift − baseline`; negative means the gift
 * reduced the metric.
 */
export interface WhatIfComparison {
  baseline: WhatIfOutcome;
  withGift: WhatIfOutcome;
  delta: {
    /** withGift.medianEndingWealthTodayDollars − baseline (negative = cost). */
    medianEndingWealthTodayDollars: number;
    /** withGift.p25EndingWealthTodayDollars − baseline. */
    p25EndingWealthTodayDollars: number;
    /** withGift.solventSuccessRate − baseline. */
    solventSuccessRate: number;
    /** withGift.bequestAttainmentRate − baseline. */
    bequestAttainmentRate: number;
  };
  /** The candidate outflows that were simulated (echoed back for UI display). */
  appliedOutflows: ScheduledOutflow[];
}
