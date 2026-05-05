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
}

export function RuleSweepCard({
  seedData,
  baselineFingerprint,
  engineVersion,
  dispatcherUrl,
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
    loadCorpusEvaluations(
      baselineFingerprint,
      engineVersion,
      dispatcherUrl ?? null,
    )
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
  }, [seedData, baselineFingerprint, engineVersion, dispatcherUrl]);

  if (evalCount < 50) return null;
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-3 text-[12px] text-rose-700">
        Rule-sweep analyzer error: {error}
      </div>
    );
  }
  if (!recommendation || !recommendation.hasRecommendation) return null;

  const ruleNames = (recommendation.axes.withdrawalRule ?? []).map((r) =>
    r.replace(/_/g, ' '),
  );

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-700">
            Withdrawal-rule sweep · auto-applied in next Full mine
          </p>
          <p className="mt-1 text-[13px] text-stone-800">
            {recommendation.rationale}
          </p>
          <p className="mt-2 text-[11px] text-stone-500">
            On the next Full mine, pass 2 will re-mine the contenders'
            (spend, SS, Roth) bounding box under {ruleNames.join(', ')}.
            Pass-1 records (under tax_bracket_waterfall) stay in the
            corpus — the rule sweep adds new records, it doesn't
            replace anything.
          </p>
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
