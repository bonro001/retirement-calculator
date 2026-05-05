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
import { loadCorpusEvaluations } from './policy-mining-corpus-source';
import type { SeedData } from './types';

interface Props {
  seedData: SeedData;
  baselineFingerprint: string | null;
  engineVersion: string;
  /** Cluster dispatcher URL when the user is mining via the cluster.
   *  When set, the card prefers the cluster's HTTP corpus over the
   *  local IndexedDB (cluster mines don't mirror to local). */
  dispatcherUrl?: string | null;
  /** Threshold to use for cliff detection. Defaults to 0.85, matching
   *  the canonical legacy attainment gate. The slider's live value
   *  could be passed in to refine relative to whatever the user's
   *  currently filtering at. */
  feasibilityThreshold?: number;
}

export function CliffRefinementCard({
  seedData,
  baselineFingerprint,
  engineVersion,
  dispatcherUrl,
  feasibilityThreshold = 0.85,
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
    loadCorpusEvaluations(
      baselineFingerprint,
      engineVersion,
      dispatcherUrl ?? null,
    )
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
  }, [seedData, baselineFingerprint, engineVersion, dispatcherUrl, feasibilityThreshold]);

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

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Cliff refinement · auto-applied in next Full mine
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
