/**
 * Die-With-Zero what-if simulator.
 *
 * Answers the question: "If we give $X to recipient Y in year Z from
 * account A, what does it do to our end amount?"
 *
 * Runs the engine twice — once against the current baseline (with any
 * already-adopted outflows intact) and once with the candidate outflows
 * appended on top — then returns a side-by-side comparison.
 */

import { evaluatePolicy } from '../policy-miner-eval';
import type { ScheduledOutflow, SeedData } from '../types';
import type { Policy, PolicyEvaluation } from '../policy-miner-types';
import type { EvalContext, WhatIfComparison, WhatIfOutcome } from './types';

/**
 * Extract the subset of `PolicyEvaluation` fields we care about for
 * what-if comparison.
 */
function outcomeFromEval(ev: PolicyEvaluation): WhatIfOutcome {
  return {
    medianEndingWealthTodayDollars: ev.outcome.p50EndingWealthTodayDollars,
    p25EndingWealthTodayDollars: ev.outcome.p25EndingWealthTodayDollars,
    solventSuccessRate: ev.outcome.solventSuccessRate,
    bequestAttainmentRate: ev.outcome.bequestAttainmentRate,
  };
}

/**
 * Simulate one what-if scenario: what changes if `candidateOutflows` are
 * added to the plan?
 *
 * - `baseline` is the household's current SeedData (may already contain
 *   previously-adopted outflows in `baseline.scheduledOutflows`).
 * - `basePolicy` is the policy (spend, SS ages, Roth ceiling) to hold
 *   constant across both runs so the comparison isolates the gift effect.
 * - `candidateOutflows` are the new gifts being considered; they are
 *   appended on top of any existing `baseline.scheduledOutflows`.
 * - `ctx` bundles the engine dependencies (assumptions, cloner, etc.).
 *
 * Returns a `WhatIfComparison` with baseline outcome, with-gift outcome,
 * deltas, and the applied outflows echoed back.
 */
export async function simulateGift(
  baseline: SeedData,
  basePolicy: Policy,
  candidateOutflows: ScheduledOutflow[],
  ctx: EvalContext,
): Promise<WhatIfComparison> {
  // ── Baseline run ──────────────────────────────────────────────────────────
  // Evaluate the policy against the current baseline as-is. Any already-
  // adopted outflows in baseline.scheduledOutflows stay in the picture.
  const baselineEval = await evaluatePolicy(
    basePolicy,
    baseline,
    ctx.assumptions,
    ctx.baselineFingerprint,
    ctx.engineVersion,
    ctx.evaluatedByNodeId,
    ctx.cloner,
    ctx.legacyTargetTodayDollars,
  );

  // ── With-gift run ─────────────────────────────────────────────────────────
  // Clone the baseline and append the candidate outflows. We append (not
  // replace) so past adopted gifts remain in the picture — the comparison
  // shows the marginal cost of this set of new gifts only.
  const giftSeed = ctx.cloner(baseline);
  giftSeed.scheduledOutflows = [
    ...(baseline.scheduledOutflows ?? []),
    ...candidateOutflows,
  ];

  const giftEval = await evaluatePolicy(
    basePolicy,
    giftSeed,
    ctx.assumptions,
    ctx.baselineFingerprint,
    ctx.engineVersion,
    ctx.evaluatedByNodeId,
    ctx.cloner,
    ctx.legacyTargetTodayDollars,
  );

  // ── Comparison ────────────────────────────────────────────────────────────
  const baselineOutcome = outcomeFromEval(baselineEval);
  const giftOutcome = outcomeFromEval(giftEval);

  return {
    baseline: baselineOutcome,
    withGift: giftOutcome,
    delta: {
      medianEndingWealthTodayDollars:
        giftOutcome.medianEndingWealthTodayDollars -
        baselineOutcome.medianEndingWealthTodayDollars,
      p25EndingWealthTodayDollars:
        giftOutcome.p25EndingWealthTodayDollars -
        baselineOutcome.p25EndingWealthTodayDollars,
      solventSuccessRate:
        giftOutcome.solventSuccessRate - baselineOutcome.solventSuccessRate,
      bequestAttainmentRate:
        giftOutcome.bequestAttainmentRate - baselineOutcome.bequestAttainmentRate,
    },
    appliedOutflows: candidateOutflows,
  };
}
