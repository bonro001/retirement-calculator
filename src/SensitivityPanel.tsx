import { useEffect, useMemo, useRef, useState } from 'react';
import { useClusterSession } from './useClusterSession';
import {
  loadClusterEvaluations,
  ClusterFetchError,
} from './policy-mining-cluster';
import {
  buildSensitivitySweepAxes,
  extractSensitivityArms,
  formatAxisValue,
  formatBequestDelta,
  formatFeasibilityDelta,
  sensitivitySweepSize,
  type SensitivityArm,
  type SensitivityResult,
} from './sensitivity-sweep';
import type { Policy, PolicyEvaluation } from './policy-miner-types';
import type { MarketAssumptions, SeedData } from './types';

/**
 * E.5 — Sensitivity check panel.
 *
 * Mounts directly under the adoption surface. Answers the household's
 * obvious next question after clicking Adopt: "is this stable — what
 * if I bumped one thing?"
 *
 * Implementation notes:
 *   - The sweep runs through the same cluster pipeline as a regular mine
 *     (start_session via cluster-client, dispatcher fans out to hosts,
 *     evaluations land in the on-disk corpus). The only difference is
 *     `axesOverride` — a tight 3⁴ = 81 cartesian centered on the adopted
 *     policy. ~7 sec on a 24-worker cluster.
 *
 *   - We poll the dispatcher's GET /sessions/:id/evaluations endpoint
 *     for the in-flight session's results, so progress renders as cells
 *     come in. The marginal slices fill out one row at a time.
 *
 *   - Disabled when another cluster session is active. The dispatcher
 *     enforces single-session, but pre-empting here gives a clearer
 *     message than waiting for a silent rejection.
 *
 *   - Closes / collapses cleanly: the user can dismiss the panel at any
 *     time. The sweep keeps running on the cluster (no point cancelling;
 *     it's 7 sec) but the UI stops rendering progress.
 */

interface Props {
  adoptedPolicy: Policy;
  baseline: SeedData;
  baselineFingerprint: string;
  assumptions: MarketAssumptions;
  legacyTargetTodayDollars: number;
  /** Dispatcher URL for fetching the sweep's evaluations. */
  dispatcherUrl: string | null;
}

const POLL_INTERVAL_MS = 1_500;

type SweepState =
  | { kind: 'idle' }
  | { kind: 'launching'; startedAtMs: number }
  | { kind: 'running'; sessionId: string; startedAtMs: number }
  | { kind: 'complete'; sessionId: string; startedAtMs: number; finishedAtMs: number }
  | { kind: 'failed'; reason: string };

export function SensitivityPanel({
  adoptedPolicy,
  baseline,
  baselineFingerprint,
  assumptions,
  legacyTargetTodayDollars,
  dispatcherUrl,
}: Props): JSX.Element | null {
  const cluster = useClusterSession();
  const [sweepState, setSweepState] = useState<SweepState>({ kind: 'idle' });
  const [evaluations, setEvaluations] = useState<PolicyEvaluation[]>([]);

  // Sweep axes are derived from the adopted policy + baseline. Memo so
  // the policy-list ID and grid stay stable across renders.
  const sweepAxes = useMemo(
    () => buildSensitivitySweepAxes(adoptedPolicy, baseline),
    [adoptedPolicy, baseline],
  );
  const expectedSize = sensitivitySweepSize(sweepAxes);

  // Detect when our launched session shows up in the cluster snapshot.
  // The dispatcher generates the sessionId server-side; we read it
  // back from cluster.session once it propagates.
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (sweepState.kind !== 'launching') return;
    const session = cluster.session;
    if (!session) return;
    // The session belongs to us if it started after our launch tick.
    // (Race: another session could in theory start at the same tick;
    // for E.5 the household isn't running concurrent mines.)
    const startedMs = session.stats?.sessionStartedAtIso
      ? new Date(session.stats.sessionStartedAtIso).getTime()
      : Date.now();
    if (startedMs >= sweepState.startedAtMs - 1_000) {
      setSweepState({
        kind: 'running',
        sessionId: session.sessionId,
        startedAtMs: sweepState.startedAtMs,
      });
    }
  }, [cluster.session, sweepState]);

  // Detect completion: cluster.session becomes null while we were
  // running. Stamp the finish time for the "completed in X sec" line.
  useEffect(() => {
    if (sweepState.kind !== 'running') return;
    if (cluster.session === null) {
      setSweepState({
        kind: 'complete',
        sessionId: sweepState.sessionId,
        startedAtMs: sweepState.startedAtMs,
        finishedAtMs: Date.now(),
      });
    }
  }, [cluster.session, sweepState]);

  // Poll the dispatcher for evaluations belonging to our sweep session.
  useEffect(() => {
    if (
      (sweepState.kind !== 'running' && sweepState.kind !== 'complete') ||
      !dispatcherUrl
    ) {
      return undefined;
    }
    const sessionId = sweepState.sessionId;
    let cancelled = false;
    let stopAfterTick = false;
    const tick = async () => {
      try {
        const payload = await loadClusterEvaluations(dispatcherUrl, sessionId);
        if (cancelled) return;
        setEvaluations(payload.evaluations);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ClusterFetchError && e.kind === 'not_found') {
          // Session disk dir may not exist yet for the first tick or two.
          return;
        }
        // Soft fail — the panel stays usable, evaluations stop ticking.
        // eslint-disable-next-line no-console
        console.warn('[sensitivity-panel] poll failed:', e);
      }
    };
    void tick();
    if (sweepState.kind === 'complete') {
      // One more tick to capture the final batch, then stop polling.
      stopAfterTick = true;
    }
    if (stopAfterTick) {
      return () => {
        cancelled = true;
      };
    }
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [dispatcherUrl, sweepState]);

  // Run the marginal extraction whenever evaluations change. Anchor may
  // not be present yet, in which case we render the running banner only.
  const result: SensitivityResult | null = useMemo(
    () => extractSensitivityArms(evaluations, adoptedPolicy, sweepAxes),
    [evaluations, adoptedPolicy, sweepAxes],
  );

  const launchSweep = () => {
    if (cluster.state !== 'connected') {
      setSweepState({
        kind: 'failed',
        reason: 'cluster not connected — start the dispatcher first',
      });
      return;
    }
    if (cluster.session) {
      setSweepState({
        kind: 'failed',
        reason: 'another mine is in progress — wait for it to finish',
      });
      return;
    }
    const startedAtMs = Date.now();
    startedAtRef.current = startedAtMs;
    setEvaluations([]);
    setSweepState({ kind: 'launching', startedAtMs });
    try {
      cluster.startSession({
        baseline,
        assumptions,
        baselineFingerprint,
        legacyTargetTodayDollars,
        feasibilityThreshold: 0.7,
        maxPoliciesPerSession: expectedSize,
        axesOverride: sweepAxes,
      });
    } catch (e) {
      setSweepState({
        kind: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const reset = () => {
    setSweepState({ kind: 'idle' });
    setEvaluations([]);
  };

  // Header summary line — what the panel is asking, in one sentence.
  const subtitle = (
    <p className="text-[12px] text-stone-500">
      Re-runs the simulation on a tight grid around the adopted policy
      ({expectedSize} candidates, ~10 sec on the cluster) so you can
      see which knobs the bequest is most sensitive to.
    </p>
  );

  // -------------------------------------------------------------------------
  // Render arms
  // -------------------------------------------------------------------------

  const renderArm = (arm: SensitivityArm) => {
    const anchor = arm.points[arm.adoptedIndex];
    if (!anchor) return null;
    return (
      <div
        key={arm.axis}
        className="rounded-lg border border-stone-200 bg-white px-3 py-2"
      >
        <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
          {arm.label}
        </p>
        <table className="mt-1 w-full text-left text-[12px]">
          <thead>
            <tr className="text-[10px] font-medium uppercase tracking-wider text-stone-400">
              <th className="py-1 pr-2">value</th>
              <th className="py-1 pr-2 text-right">bequest P50</th>
              <th className="py-1 pr-2 text-right">Δ vs adopted</th>
              <th className="py-1 text-right">Δ feasibility</th>
            </tr>
          </thead>
          <tbody>
            {arm.points.map((p) => {
              const bequestDelta = p.bequestP50 - anchor.bequestP50;
              const feasDelta = p.feasibility - anchor.feasibility;
              return (
                <tr
                  key={p.axisValue}
                  className={`border-t border-stone-100 ${
                    p.isAdopted ? 'bg-emerald-50/50' : ''
                  }`}
                >
                  <td className="py-1 pr-2 font-medium tabular-nums text-stone-700">
                    {formatAxisValue(p.axisValue, arm.unit)}
                    {p.isAdopted && (
                      <span className="ml-1 text-[10px] font-semibold uppercase text-emerald-700">
                        adopted
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-stone-700">
                    {formatAxisValue(p.bequestP50, '$/yr').replace('/yr', '')}
                  </td>
                  <td
                    className={`py-1 pr-2 text-right tabular-nums ${
                      p.isAdopted
                        ? 'text-stone-400'
                        : bequestDelta > 0
                          ? 'text-emerald-700'
                          : bequestDelta < 0
                            ? 'text-rose-700'
                            : 'text-stone-500'
                    }`}
                  >
                    {p.isAdopted ? '—' : formatBequestDelta(bequestDelta)}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${
                      p.isAdopted
                        ? 'text-stone-400'
                        : feasDelta > 0
                          ? 'text-emerald-700'
                          : feasDelta < 0
                            ? 'text-rose-700'
                            : 'text-stone-500'
                    }`}
                  >
                    {p.isAdopted ? '—' : formatFeasibilityDelta(feasDelta)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // -------------------------------------------------------------------------
  // Top-level layout
  // -------------------------------------------------------------------------

  // Hide the panel entirely when there's nothing to do (no fingerprint,
  // no adopted policy). Parent shouldn't mount us in those cases anyway,
  // but defend in depth.
  if (!baselineFingerprint) return null;

  return (
    <div className="mt-3 rounded-2xl border border-stone-200 bg-stone-50/60 p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
            Sensitivity check
          </p>
          {subtitle}
        </div>
        <div className="flex items-center gap-2">
          {sweepState.kind === 'idle' && (
            <button
              type="button"
              onClick={launchSweep}
              disabled={cluster.state !== 'connected' || !!cluster.session}
              className="whitespace-nowrap rounded-lg bg-[#0066CC] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0071E3] disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none"
            >
              Run sensitivity check
            </button>
          )}
          {(sweepState.kind === 'complete' || sweepState.kind === 'failed') && (
            <button
              type="button"
              onClick={reset}
              className="whitespace-nowrap rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-700 ring-1 ring-stone-200 transition hover:bg-stone-50"
            >
              Re-run
            </button>
          )}
        </div>
      </div>

      {sweepState.kind === 'launching' && (
        <p className="text-[12px] text-stone-600">Launching sweep…</p>
      )}

      {sweepState.kind === 'running' && (
        <p className="text-[12px] text-stone-600">
          Evaluating {evaluations.length} of {expectedSize}…
        </p>
      )}

      {sweepState.kind === 'failed' && (
        <p className="text-[12px] text-rose-700">
          Couldn&apos;t run the sweep: {sweepState.reason}
        </p>
      )}

      {sweepState.kind === 'complete' && (
        <p className="text-[12px] text-stone-500">
          Completed in{' '}
          {Math.max(
            1,
            Math.round((sweepState.finishedAtMs - sweepState.startedAtMs) / 1000),
          )}{' '}
          sec · {evaluations.length} cells evaluated
        </p>
      )}

      {result ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {result.arms.map(renderArm)}
        </div>
      ) : (sweepState.kind === 'running' || sweepState.kind === 'complete') &&
        evaluations.length > 0 ? (
        <p className="mt-2 text-[12px] text-stone-500">
          Waiting for the adopted-policy cell to land before showing deltas…
        </p>
      ) : null}
    </div>
  );
}
