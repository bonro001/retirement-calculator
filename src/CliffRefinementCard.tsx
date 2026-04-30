/**
 * Cliff Refinement card. Renders below the Mined Plan Candidates table
 * when a pass-1 corpus exists and the analyzer detects a feasibility
 * cliff between two adjacent spend tiers. Click → pass-2 mine runs at
 * $1k resolution across the cliff band.
 *
 * Two-pass mining is dynamic by design: each household's cliff sits at
 * a different spend, and the cliff moves when the plan boulders shift
 * (retirement date, allocation, balances). A static "always mine
 * $113k–$119k" axis would be wrong for the next plan and need
 * hand-editing every time.
 */

import { useEffect, useState } from 'react';
import { recommendCliffRefinement, type CliffRefinementRecommendation } from './cliff-refinement-analyzer';
import { loadEvaluationsForBaseline } from './policy-mining-corpus';
import type { SeedData } from './types';
import type { PolicyAxes } from './policy-miner-types';

interface Props {
  seedData: SeedData;
  baselineFingerprint: string | null;
  engineVersion: string;
  /** Threshold to use for cliff detection. Defaults to 0.85, matching
   *  the canonical legacy attainment gate. The slider's live value
   *  could be passed in to refine relative to whatever the user's
   *  currently filtering at. */
  feasibilityThreshold?: number;
  /** When provided, the "Refine cliff" button calls this with the
   *  recommended pass-2 axes. Wired to MiningScreen's `axesOverride`
   *  state, which threads through the cluster-client. */
  onApplyAxesOverride?: (axes: PolicyAxes | null) => void;
  /** Current override (so we can show "Currently mining narrower
   *  band · Reset" once pass-2 has been applied). */
  axesOverride?: PolicyAxes | null;
}

export function CliffRefinementCard({
  seedData,
  baselineFingerprint,
  engineVersion,
  feasibilityThreshold = 0.85,
  onApplyAxesOverride,
  axesOverride,
}: Props) {
  const [recommendation, setRecommendation] = useState<CliffRefinementRecommendation | null>(
    null,
  );
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
        setRecommendation(
          recommendCliffRefinement(evals, seedData, feasibilityThreshold),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'unknown corpus error');
      });
    return () => {
      cancelled = true;
    };
  }, [seedData, baselineFingerprint, engineVersion, feasibilityThreshold]);

  // Don't surface for tiny corpora — analyzer would over-fit MC noise.
  if (evalCount < 50) return null;
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-3 text-[12px] text-rose-700">
        Cliff-refinement analyzer error: {error}
      </div>
    );
  }
  if (!recommendation) return null;
  if (!recommendation.hasRecommendation) {
    // Quietly suppress when there's no cliff to refine. The rationale
    // is logged in the recommendation object for diagnostic poking but
    // we don't clutter the UI with "everything's fine."
    return null;
  }

  const isOverrideActive =
    axesOverride != null &&
    JSON.stringify(axesOverride.annualSpendTodayDollars) ===
      JSON.stringify(recommendation.axes.annualSpendTodayDollars);

  const handleApply = () => {
    if (onApplyAxesOverride) onApplyAxesOverride(recommendation.axes);
  };
  const handleReset = () => {
    if (onApplyAxesOverride) onApplyAxesOverride(null);
  };

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Refine the cliff · pass 2 recommended
          </p>
          <p className="mt-1 text-[13px] text-stone-800">
            {recommendation.rationale}
          </p>
          <p className="mt-2 text-[11px] text-stone-500">
            Pass 2 axis: spend ∈{' '}
            {recommendation.axes.annualSpendTodayDollars
              .map((v) => `$${(v / 1000).toFixed(0)}k`)
              .join(' · ')}{' '}
            · same SS, Roth, and withdrawal-rule grid as pass 1.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          {onApplyAxesOverride ? (
            <>
              <button
                type="button"
                onClick={handleApply}
                disabled={isOverrideActive}
                className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {isOverrideActive
                  ? 'Pass 2 axes loaded · run a mine'
                  : 'Use pass 2 axes →'}
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

      <div className="mt-3 grid grid-cols-1 gap-1 rounded-md bg-white/70 p-2 text-[11px] text-stone-600 md:grid-cols-2">
        {recommendation.spendTierFeasibility.map((t) => {
          const inCliff =
            t.spend >= recommendation.cliffLowerSpend &&
            t.spend <= recommendation.cliffUpperSpend;
          return (
            <div key={t.spend} className={inCliff ? 'font-semibold text-emerald-800' : ''}>
              ${(t.spend / 1000).toFixed(0)}k → max{' '}
              {Math.round(t.maxFeasibility * 100)}%
              {' · '}
              {t.feasibleRecords}/{t.totalRecords} clear 85%
              {inCliff ? ' · in cliff band' : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}
