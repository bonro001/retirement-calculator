import { useEffect, useState } from 'react';
import {
  analyzeAxisPruning,
  summarizeAxisPruning,
  type AxisPruningAnalysis,
  type AxisAnalysis,
} from './axis-pruning-analyzer';
import { buildDefaultPolicyAxes } from './policy-axis-enumerator';
import { loadEvaluationsForBaseline } from './policy-mining-corpus';
import type { SeedData } from './types';
import type { PolicyAxes } from './policy-miner-types';

/**
 * Axis-pruning insight card. Loads the policy mining corpus for the
 * current baseline + engine, runs the pure analyzer, and surfaces the
 * recommendation when one exists. Display-only for V1 — the Apply
 * button is wired to copy the recommended axes JSON to clipboard so
 * the household can paste it into a follow-up override; full
 * single-click Apply requires plumbing axesOverride through
 * `PolicyMiningStatusCard` and the cluster client (already supported
 * via `axesOverride` opt in `cluster-client.ts`).
 *
 * Surfaces only when:
 *  - the corpus has at least 50 evaluations (small corpora aren't
 *    statistically interesting and the recommendation would flap
 *    on random RNG noise), and
 *  - the analyzer recommends at least one axis narrowing.
 */
export function AxisPruningCard({
  seedData,
  baselineFingerprint,
  engineVersion,
}: {
  seedData: SeedData;
  baselineFingerprint: string | null;
  engineVersion: string;
}) {
  const [analysis, setAnalysis] = useState<AxisPruningAnalysis | null>(null);
  const [evalCount, setEvalCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAnalysis(null);
    setEvalCount(0);
    setError(null);
    if (!baselineFingerprint) return;
    let cancelled = false;
    loadEvaluationsForBaseline(baselineFingerprint, engineVersion)
      .then((evals) => {
        if (cancelled) return;
        setEvalCount(evals.length);
        if (evals.length === 0) return;
        const axes = buildDefaultPolicyAxes(seedData);
        setAnalysis(analyzeAxisPruning(evals, axes));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'unknown corpus error');
      });
    return () => {
      cancelled = true;
    };
  }, [seedData, baselineFingerprint, engineVersion]);

  // Don't surface for tiny corpora — analyzer would over-fit RNG noise.
  if (evalCount < 50) return null;
  if (!analysis) {
    if (error) {
      return (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-3 text-[12px] text-rose-700">
          Axis-pruning analyzer error: {error}
        </div>
      );
    }
    return null;
  }
  if (!analysis.hasRecommendation && analysis.corpusHasFeasibleCandidates) {
    // No-op; don't clutter the UI with "everything's fine."
    return null;
  }

  const summary = summarizeAxisPruning(analysis);
  const isInfeasible = !analysis.corpusHasFeasibleCandidates;

  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm ${
        isInfeasible
          ? 'border-rose-300 bg-rose-50/60'
          : 'border-violet-200 bg-violet-50/40'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p
            className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${
              isInfeasible ? 'text-rose-700' : 'text-violet-700'
            }`}
          >
            {isInfeasible
              ? 'Axis-pruning · corpus is fully infeasible'
              : 'Axis-pruning · auto-applied in next Full mine'}
          </p>
          <p className="mt-1 text-[12px] text-stone-700">{summary}</p>
        </div>
      </div>

      {!isInfeasible && (
        <div className="mt-3 grid gap-2 md:grid-cols-2 text-[11px]">
          {(['annualSpendTodayDollars', 'primarySocialSecurityClaimAge', 'spouseSocialSecurityClaimAge', 'rothConversionAnnualCeiling'] as const).map((axisName) => {
            const ax: AxisAnalysis = analysis.axes[axisName];
            if (!ax || ax.values.length === 0) return null;
            const dropped = ax.originalValues.filter(
              (v) => !ax.recommendedValues.includes(v),
            );
            return (
              <div
                key={axisName}
                className={`rounded-lg p-2 ${
                  ax.shouldPrune
                    ? 'bg-white border border-violet-200'
                    : 'bg-white/40 border border-stone-200'
                }`}
              >
                <p className="font-semibold text-stone-700">
                  {axisName === 'annualSpendTodayDollars'
                    ? 'Spend levels'
                    : axisName === 'primarySocialSecurityClaimAge'
                      ? 'Primary SS ages'
                      : axisName === 'spouseSocialSecurityClaimAge'
                        ? 'Spouse SS ages'
                        : 'Roth ceilings'}
                </p>
                <p className="mt-1 tabular-nums text-stone-600">
                  {ax.recommendedValues.join(', ')}
                </p>
                {ax.shouldPrune && dropped.length > 0 && (
                  <p className="mt-1 text-rose-700 tabular-nums">
                    drop: {dropped.join(', ')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-[11px] text-stone-400">
        Based on {evalCount} corpus evaluations. Analyzer is pure (no
        engine calls). Narrowed grid is composed into the next Full
        mine&apos;s pass-2 automatically.
      </p>
    </div>
  );
}
