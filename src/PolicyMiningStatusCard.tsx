import { useEffect, useState } from 'react';
import {
  loadEvaluationsForBaseline,
  loadMiningStats,
} from './policy-mining-corpus';
import type { MiningStats, PolicyEvaluation } from './policy-miner-types';

/**
 * Read-only status card for the Policy Miner. Polls IndexedDB every 5s
 * for the latest MiningStats + corpus contents. Designed to be small and
 * unobtrusive — shows live progress while a session is running and a
 * "ready to mine" hint when the corpus is empty for this baseline.
 *
 * Why poll instead of subscribe to events: the miner runs in a worker
 * (Phase B+) on a different host eventually (Phase D). Polling IndexedDB
 * is the lowest-common-denominator that works in all those topologies
 * without changing the panel.
 *
 * Why no "Start mining" button yet: Phase A is single-host single-thread
 * — kicking it off from the UI would block interactive work for hours.
 * Wiring the start button comes in Phase B once the worker pool can
 * absorb the load without freezing the page.
 */

interface Props {
  baselineFingerprint: string | null;
  engineVersion: string;
}

const POLL_INTERVAL_MS = 5_000;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

function formatPct(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}k`;
  return `$${Math.round(amount)}`;
}

export function PolicyMiningStatusCard({
  baselineFingerprint,
  engineVersion,
}: Props): JSX.Element | null {
  const [stats, setStats] = useState<MiningStats | null>(null);
  const [bestEval, setBestEval] = useState<PolicyEvaluation | null>(null);
  const [evalCount, setEvalCount] = useState<number>(0);

  useEffect(() => {
    if (!baselineFingerprint) {
      setStats(null);
      setBestEval(null);
      setEvalCount(0);
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const [nextStats, evals] = await Promise.all([
          loadMiningStats(baselineFingerprint),
          loadEvaluationsForBaseline(baselineFingerprint, engineVersion),
        ]);
        if (cancelled) return;
        setStats(nextStats);
        setEvalCount(evals.length);
        // Best record by p50 today-dollar bequest among feasible (>=0.85).
        // Mirror the miner's lexicographic prefix here so the panel
        // doesn't need to call back into the miner module.
        const feasible = evals.filter(
          (e) => e.outcome.bequestAttainmentRate >= 0.85,
        );
        feasible.sort(
          (a, b) =>
            b.outcome.p50EndingWealthTodayDollars -
            a.outcome.p50EndingWealthTodayDollars,
        );
        setBestEval(feasible[0] ?? null);
      } catch (e) {
        // IDB hiccup — silent. The next tick recovers.
        // eslint-disable-next-line no-console
        console.warn('[mining-status-card] poll failed:', e);
      }
    };
    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [baselineFingerprint, engineVersion]);

  // No baseline yet — render nothing. The card only appears once the
  // user has a stable plan to mine against.
  if (!baselineFingerprint) return null;

  // Empty corpus, no active session — show a hint rather than nothing,
  // so the household knows the feature exists.
  if (!stats && evalCount === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50/60 p-4 text-sm text-stone-600">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          Policy Mining
        </p>
        <p>
          No mined policies yet for this plan. Background mining will
          search thousands of variations and surface the strategies that
          most reliably leave at least your North Star.
        </p>
      </div>
    );
  }

  // Active or completed session — show the live tally.
  const progressPct =
    stats && stats.totalPolicies > 0
      ? Math.round((stats.policiesEvaluated / stats.totalPolicies) * 100)
      : null;
  const stateColor =
    stats?.state === 'running'
      ? 'text-emerald-700'
      : stats?.state === 'paused'
        ? 'text-amber-700'
        : stats?.state === 'error'
          ? 'text-rose-700'
          : 'text-stone-700';

  return (
    <div className="mt-4 rounded-2xl border border-stone-200 bg-white/80 p-4 text-sm text-stone-700 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          Policy Mining
        </p>
        {stats?.state && (
          <span
            className={`text-[11px] font-semibold uppercase tracking-wider ${stateColor}`}
          >
            {stats.state}
          </span>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            Evaluated
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
            {stats
              ? `${stats.policiesEvaluated.toLocaleString()} / ${stats.totalPolicies.toLocaleString()}`
              : evalCount.toLocaleString()}
          </p>
          {progressPct !== null && (
            <p className="mt-1 text-[11px] text-stone-500">
              {progressPct}% complete
            </p>
          )}
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            Throughput
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
            {stats && stats.meanMsPerPolicy > 0
              ? `${(60_000 / stats.meanMsPerPolicy).toFixed(0)}/min`
              : '—'}
          </p>
          <p className="mt-1 text-[11px] text-stone-500">
            {stats && stats.meanMsPerPolicy > 0
              ? `mean ${(stats.meanMsPerPolicy / 1000).toFixed(1)}s per policy`
              : 'awaiting first batch'}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            Time remaining
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
            {stats && stats.state === 'running'
              ? formatDuration(stats.estimatedRemainingMs)
              : '—'}
          </p>
          <p className="mt-1 text-[11px] text-stone-500">
            {stats?.feasiblePolicies != null
              ? `${stats.feasiblePolicies.toLocaleString()} feasible found`
              : ''}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            Best so far
          </p>
          {bestEval ? (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-700">
                {formatPct(bestEval.outcome.bequestAttainmentRate)}
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                spend{' '}
                {formatCurrency(bestEval.policy.annualSpendTodayDollars)}/yr,
                bequest{' '}
                {formatCurrency(bestEval.outcome.p50EndingWealthTodayDollars)}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-400">
                —
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                no feasible candidate yet
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
