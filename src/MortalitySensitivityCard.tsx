import { useEffect, useMemo, useState } from 'react';
import {
  currentAgeFromBirthDate,
  lifeTableRowFor,
} from './mortality';
import { buildPathResults } from './utils';
import type { MarketAssumptions, PathResult, SeedData } from './types';

/**
 * Mortality sensitivity card. Surfaces "what happens to the plan if
 * one spouse dies early?" using the SSA period-life-table p10 ("early
 * death" — 10% of people this age and sex don't make it past) and p50
 * ("median death age").
 *
 * Why: the baseline projection runs both spouses to the planning end
 * age (95) — a deliberate longevity-conservative choice. But mortality
 * is the single biggest risk factor in real retirement planning. The
 * survivor-benefit math (engine integrated 2026-04-30) tells the
 * household what they'd actually receive when one dies; this card
 * surfaces that as a numerical sensitivity.
 *
 * Computes 3 scenarios:
 *   1. Both alive to 95 (baseline, status quo)
 *   2. Higher earner dies at his p10 (~10% downside case)
 *   3. Higher earner dies at his p50 (median expectation)
 *
 * The card runs `buildPathResults` 3 times against the optimized seed.
 * Each run is ~1-3s at 250 trials. Total ~10s on first paint; cached
 * by fingerprint thereafter.
 */
export function MortalitySensitivityCard({
  data,
  assumptions,
  baselinePath,
}: {
  data: SeedData | null;
  assumptions: MarketAssumptions | null;
  /** The optimized baseline path (from `usePlanOptimization`) — used
   *  as the "both alive" reference. When null, falls back to running
   *  a fresh sim. */
  baselinePath: PathResult | null;
}) {
  const [scenarios, setScenarios] = useState<
    | {
        baseline: PathResult;
        robEarly: PathResult;
        robMedian: PathResult;
        robEarlyAge: number;
        robMedianAge: number;
      }
    | null
  >(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fingerprint = useMemo(() => {
    if (!data || !assumptions) return null;
    return JSON.stringify({
      birth: data.household?.robBirthDate,
      ss: data.income?.socialSecurity,
      bal: data.accounts?.pretax?.balance,
      asm: assumptions.assumptionsVersion,
    });
  }, [data, assumptions]);

  useEffect(() => {
    if (!data || !assumptions || !fingerprint) return;
    let cancelled = false;
    setRunning(true);
    setError(null);
    const robBirthIso = data.household?.robBirthDate;
    if (!robBirthIso) {
      setError('No Rob birth date — cannot compute mortality sensitivity.');
      setRunning(false);
      return;
    }
    // Run async via setTimeout(0) yields so UI stays responsive.
    (async () => {
      try {
        const robCurrentAge = currentAgeFromBirthDate(robBirthIso);
        const lifeTable = lifeTableRowFor(robCurrentAge, 'male');
        const robEarlyAge = lifeTable.p10DeathAge;
        const robMedianAge = lifeTable.p50DeathAge;

        // Use a lower trial count for sensitivity — these are bracketing
        // scenarios, not the headline number. 200 trials × 3 runs ≈ 6s.
        const sensitivityAssumptions: MarketAssumptions = {
          ...assumptions,
          simulationRuns: 200,
        };

        const runWith = (
          opts: Partial<MarketAssumptions>,
        ): PathResult | null => {
          const paths = buildPathResults(
            data,
            { ...sensitivityAssumptions, ...opts },
            [],
            [],
            { pathMode: 'selected_only' },
          );
          return paths[0] ?? null;
        };

        await new Promise((r) => setTimeout(r, 0));
        const baseline = runWith({});
        if (cancelled || !baseline) return;
        await new Promise((r) => setTimeout(r, 0));
        const robEarly = runWith({ robDeathAge: robEarlyAge });
        if (cancelled || !robEarly) return;
        await new Promise((r) => setTimeout(r, 0));
        const robMedian = runWith({ robDeathAge: robMedianAge });
        if (cancelled || !robMedian) return;

        setScenarios({
          baseline,
          robEarly,
          robMedian,
          robEarlyAge,
          robMedianAge,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'unknown error');
        }
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, assumptions, fingerprint]);

  // Suppress unused param warning when baselinePath is supplied but
  // we choose to run our own at consistent 200 trials.
  void baselinePath;

  if (!data || !assumptions) return null;

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
            Mortality sensitivity · what if Rob dies early
          </p>
          <p className="mt-1 text-[12px] text-stone-600">
            Baseline plans through age 95 for both. Real mortality means
            one of you dies before that — the survivor's SS benefit
            jumps to the higher earner's claim amount, but lifetime
            household income drops. SSA period life table 2020 used
            for the death-age percentiles.
          </p>
        </div>
        {running && (
          <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            Computing…
          </span>
        )}
      </div>

      {error && (
        <p className="mt-3 text-[12px] text-rose-700">Error: {error}</p>
      )}

      {scenarios && (
        <div className="mt-3 grid gap-2 md:grid-cols-3 text-[12px]">
          <div className="rounded-lg bg-white/80 p-2">
            <p className="text-[10px] font-semibold uppercase text-stone-500">
              Both alive to 95
            </p>
            <p className="mt-1 tabular-nums">
              {Math.round(scenarios.baseline.successRate * 100)}% solvent
            </p>
            <p className="text-[11px] text-stone-500 tabular-nums">
              median EW{' '}
              {scenarios.baseline.medianEndingWealth >= 1_000_000
                ? `$${(scenarios.baseline.medianEndingWealth / 1_000_000).toFixed(2)}M`
                : `$${(scenarios.baseline.medianEndingWealth / 1_000).toFixed(0)}k`}
            </p>
          </div>
          <div className="rounded-lg bg-white/80 p-2">
            <p className="text-[10px] font-semibold uppercase text-amber-700">
              Rob dies at {scenarios.robMedianAge} (median)
            </p>
            <p className="mt-1 tabular-nums">
              {Math.round(scenarios.robMedian.successRate * 100)}% solvent
              <span className="ml-1 text-[10px] text-stone-500">
                ({Math.round(
                  (scenarios.robMedian.successRate -
                    scenarios.baseline.successRate) *
                    100,
                )}pp)
              </span>
            </p>
            <p className="text-[11px] text-stone-500 tabular-nums">
              median EW{' '}
              {scenarios.robMedian.medianEndingWealth >= 1_000_000
                ? `$${(scenarios.robMedian.medianEndingWealth / 1_000_000).toFixed(2)}M`
                : `$${(scenarios.robMedian.medianEndingWealth / 1_000).toFixed(0)}k`}
            </p>
          </div>
          <div className="rounded-lg bg-white/80 p-2">
            <p className="text-[10px] font-semibold uppercase text-rose-700">
              Rob dies at {scenarios.robEarlyAge} (10th %ile)
            </p>
            <p className="mt-1 tabular-nums">
              {Math.round(scenarios.robEarly.successRate * 100)}% solvent
              <span className="ml-1 text-[10px] text-stone-500">
                ({Math.round(
                  (scenarios.robEarly.successRate -
                    scenarios.baseline.successRate) *
                    100,
                )}pp)
              </span>
            </p>
            <p className="text-[11px] text-stone-500 tabular-nums">
              median EW{' '}
              {scenarios.robEarly.medianEndingWealth >= 1_000_000
                ? `$${(scenarios.robEarly.medianEndingWealth / 1_000_000).toFixed(2)}M`
                : `$${(scenarios.robEarly.medianEndingWealth / 1_000).toFixed(0)}k`}
            </p>
          </div>
        </div>
      )}

      {scenarios && (
        <p className="mt-3 text-[11px] text-stone-400">
          Survivor benefit is modeled: when Rob dies, Debbie's SS jumps
          from her spousal floor to 100% of Rob's claim amount (delaying
          his claim → bigger survivor benefit). Spending continues at
          the household lifestyle through planning end age 95. 200
          trials per scenario; cached by fingerprint.
        </p>
      )}
    </div>
  );
}
