/**
 * Rule Sweep card. Renders below the Mined Plan Candidates table when
 * a pass-1 corpus exists and the analyzer detects enough contenders to
 * warrant a pass-2 sweep across the three non-default withdrawal rules.
 *
 * Pairs with V2.1's single-rule pass-1: pass-1 mines under
 * tax_bracket_waterfall only (12,342 candidates instead of 49,368), then
 * this card offers a one-click pass-2 that re-mines the contenders
 * under proportional, reverse waterfall, and Guyton-Klinger. Composes
 * with CliffRefinementCard via the same axesOverride plumbing — the
 * household can run either pass-2 mode after pass-1, or both
 * sequentially.
 */

import { useEffect, useState } from 'react';
import {
  recommendRuleSweep,
  type RuleSweepRecommendation,
} from './rule-sweep-analyzer';
import { loadEvaluationsForBaseline } from './policy-mining-corpus';
import type { SeedData } from './types';
import type { PolicyAxes } from './policy-miner-types';

interface Props {
  seedData: SeedData;
  baselineFingerprint: string | null;
  engineVersion: string;
  /** Wired to MiningScreen's `axesOverride` state which threads into
   *  `cluster.startSession({ axesOverride })`. */
  onApplyAxesOverride?: (axes: PolicyAxes | null) => void;
  /** Current override (so we can show "Currently mining sweep · Reset"
   *  once pass-2 has been applied). */
  axesOverride?: PolicyAxes | null;
}

export function RuleSweepCard({
  seedData,
  baselineFingerprint,
  engineVersion,
  onApplyAxesOverride,
  axesOverride,
}: Props) {
  const [recommendation, setRecommendation] =
    useState<RuleSweepRecommendation | null>(null);
  const [evalCount, setEvalCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecommendation(null);
    setEvalCount(0);
    setError(null);
    if (!baselineFingerprint) return;
    let cancelled = false;
    loadEvaluationsForBaseline(baselineFingerprint, engineVersion)
      .then((evals) => {
        if (cancelled) return;
        setEvalCount(evals.length);
        if (evals.length === 0) return;
        setRecommendation(recommendRuleSweep(evals, seedData));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'unknown corpus error');
      });
    return () => {
      cancelled = true;
    };
  }, [seedData, baselineFingerprint, engineVersion]);

  if (evalCount < 50) return null;
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-3 text-[12px] text-rose-700">
        Rule-sweep analyzer error: {error}
      </div>
    );
  }
  if (!recommendation || !recommendation.hasRecommendation) return null;

  const isOverrideActive =
    axesOverride != null &&
    JSON.stringify(axesOverride.withdrawalRule) ===
      JSON.stringify(recommendation.axes.withdrawalRule) &&
    JSON.stringify(axesOverride.annualSpendTodayDollars) ===
      JSON.stringify(recommendation.axes.annualSpendTodayDollars);

  const handleApply = () => {
    if (onApplyAxesOverride) onApplyAxesOverride(recommendation.axes);
  };
  const handleReset = () => {
    if (onApplyAxesOverride) onApplyAxesOverride(null);
  };

  const ruleNames = (recommendation.axes.withdrawalRule ?? []).map((r) =>
    r.replace(/_/g, ' '),
  );

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-700">
            Compare withdrawal rules · pass 2 recommended
          </p>
          <p className="mt-1 text-[13px] text-stone-800">
            {recommendation.rationale}
          </p>
          <p className="mt-2 text-[11px] text-stone-500">
            Pass 2 will mine the contenders' (spend, SS, Roth) bounding
            box under {ruleNames.join(', ')}. Pass-1 records (under
            tax_bracket_waterfall) stay in the corpus — the rule sweep
            adds new records, it doesn't replace anything.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          {onApplyAxesOverride ? (
            <>
              <button
                type="button"
                onClick={handleApply}
                disabled={isOverrideActive}
                className="rounded-md bg-indigo-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
              >
                {isOverrideActive
                  ? 'Sweep axes loaded · run a mine'
                  : 'Use sweep axes →'}
              </button>
              {isOverrideActive && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded-md border border-stone-300 bg-white px-3 py-1 text-[11px] font-medium text-stone-700 shadow-sm hover:bg-stone-100"
                >
                  Back to default grid
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-white/70 p-2 text-[11px] text-stone-600 md:grid-cols-4">
        <div>
          <span className="text-stone-500">Contenders</span>
          <div className="font-semibold text-stone-800">
            {recommendation.contenderCount.toLocaleString()}
          </div>
        </div>
        <div>
          <span className="text-stone-500">Attainment floor</span>
          <div className="font-semibold text-stone-800">
            {Math.round(recommendation.legacyAttainmentFloor * 100)}%
          </div>
        </div>
        <div>
          <span className="text-stone-500">Pass-2 candidates</span>
          <div className="font-semibold text-stone-800">
            ~{recommendation.estimatedPass2Candidates.toLocaleString()}
          </div>
        </div>
        <div>
          <span className="text-stone-500">Rules added</span>
          <div className="font-semibold text-stone-800">
            {ruleNames.length}
          </div>
        </div>
      </div>
    </div>
  );
}
