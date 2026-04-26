import { useEffect, useMemo, useState } from 'react';
import {
  loadEvaluationsForBaseline,
} from './policy-mining-corpus';
import {
  isBetterFeasibleCandidate,
} from './policy-miner';
import {
  buildDefaultPolicyAxes,
  computeMinimumSpendFloor,
  countPolicyCandidates,
} from './policy-axis-enumerator';
import type {
  PolicyEvaluation,
} from './policy-miner-types';
import type { MarketAssumptions, SeedData } from './types';
import { useClusterSession } from './useClusterSession';
import { browserPoolHint } from './cluster-client';

/**
 * Read+control card for the Policy Miner running across the cluster.
 *
 * Phase D.3 swap: this card no longer kicks off a local
 * `runMiningSessionWithPool`. It's a cluster controller now — it talks
 * to the dispatcher (default `ws://localhost:8765`), which enumerates
 * policies, dispatches batches to every connected host (the browser
 * itself, via cluster-client, plus any Node hosts on the LAN), ingests
 * results into the canonical on-disk corpus.
 *
 * The browser is always BOTH a host (its 12-worker pool serves the
 * dispatcher) and a controller (the Start button below sends
 * `start_session`). With no other hosts connected, all the work runs
 * locally — the only cost is one localhost WS roundtrip per batch.
 *
 * Why no "local-only" fallback: it doubles the code paths and the
 * dispatcher is a single tsx process — `npm run cluster:dispatcher`
 * starts it in 50ms. The card surfaces a clear "no dispatcher reachable"
 * state with retry so the missing-dispatcher case is obvious.
 *
 * The card still polls IndexedDB for the LEGACY (Phase B) corpus so
 * historical results from before D.3 stay visible. Live cluster sessions
 * write to the dispatcher's on-disk corpus, not IDB; for now the legacy
 * IDB read is a fallback for "best so far" when the dispatcher hasn't
 * yet reported one.
 */

export interface PolicyMiningControls {
  baseline: SeedData;
  assumptions: MarketAssumptions;
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
  /** Soft cap to keep first runs interactive — defaults to whole corpus. */
  maxPoliciesPerSession?: number;
  /** Min bequest attainment rate to count a policy as feasible (default 0.70). */
  feasibilityThreshold?: number;
  /** Trials per policy this session. Default 2000 (production). */
  trialCount?: number;
}

interface Props {
  baselineFingerprint: string | null;
  engineVersion: string;
  controls?: PolicyMiningControls;
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

function formatRelative(ms: number | null): string {
  if (ms === null) return '';
  const ageSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (ageSec < 5) return 'just now';
  if (ageSec < 60) return `${ageSec}s ago`;
  return `${Math.round(ageSec / 60)}m ago`;
}

export function PolicyMiningStatusCard({
  baselineFingerprint,
  engineVersion,
  controls,
}: Props): JSX.Element | null {
  const cluster = useClusterSession();
  const [bestEval, setBestEval] = useState<PolicyEvaluation | null>(null);
  const [evalCount, setEvalCount] = useState<number>(0);
  const [startError, setStartError] = useState<string | null>(null);
  // Inline editor for the dispatcher URL (collapsed by default to keep
  // the chrome quiet for the common case).
  const [showUrlEditor, setShowUrlEditor] = useState(false);
  const [urlDraft, setUrlDraft] = useState(cluster.snapshot.dispatcherUrl);

  // Keep the draft in sync if the URL changes externally (e.g. another
  // tab updates localStorage — rare but cheap to handle).
  useEffect(() => {
    if (!showUrlEditor) setUrlDraft(cluster.snapshot.dispatcherUrl);
  }, [cluster.snapshot.dispatcherUrl, showUrlEditor]);

  // Poll IDB for legacy "best so far" — pre-D.3 sessions wrote here.
  // Cluster sessions write to the dispatcher's on-disk corpus; that path
  // doesn't update IDB, so live cluster progress is reflected via
  // cluster.session below, not this poll.
  useEffect(() => {
    if (!baselineFingerprint) {
      setBestEval(null);
      setEvalCount(0);
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const evals = await loadEvaluationsForBaseline(
          baselineFingerprint,
          engineVersion,
        );
        if (cancelled) return;
        setEvalCount(evals.length);
        const feasible = evals.filter(
          (e) => e.outcome.bequestAttainmentRate >= 0.7,
        );
        let best: typeof feasible[number] | null = null;
        for (const e of feasible) {
          if (isBetterFeasibleCandidate(e, best)) best = e;
        }
        setBestEval(best);
      } catch (e) {
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

  // -------------------------------------------------------------------------
  // Total candidate count — needed for the "Start" tooltip and to size the
  // expected-duration line. Computed off the controls' baseline so it
  // stays in sync with what the dispatcher will enumerate.
  // -------------------------------------------------------------------------
  const totalCandidates = useMemo(() => {
    if (!controls) return null;
    try {
      return countPolicyCandidates(buildDefaultPolicyAxes(controls.baseline));
    } catch {
      return null;
    }
  }, [controls]);

  // -------------------------------------------------------------------------
  // Controls — dispatch through the cluster client, no local pool work
  // -------------------------------------------------------------------------
  const startMining = () => {
    if (!controls || !baselineFingerprint) return;
    setStartError(null);
    try {
      cluster.startSession({
        baseline: controls.baseline,
        assumptions: controls.assumptions,
        baselineFingerprint,
        legacyTargetTodayDollars: controls.legacyTargetTodayDollars,
        feasibilityThreshold: controls.feasibilityThreshold ?? 0.7,
        maxPoliciesPerSession: controls.maxPoliciesPerSession,
        trialCount: controls.trialCount,
      });
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    }
  };
  const cancelMining = () => cluster.cancelSession('user clicked cancel');

  if (!baselineFingerprint) return null;

  // -------------------------------------------------------------------------
  // Derived state for rendering
  // -------------------------------------------------------------------------
  const session = cluster.session;
  const stats = session?.stats ?? null;
  const sessionRunning = !!session;
  const canStart = !!controls && cluster.state === 'connected' && !sessionRunning;
  const canCancel = !!controls && cluster.state === 'connected' && sessionRunning;

  // Connection state badge color
  const connColor =
    cluster.state === 'connected'
      ? 'text-emerald-700'
      : cluster.state === 'connecting'
        ? 'text-amber-700'
        : cluster.state === 'error'
          ? 'text-rose-700'
          : 'text-stone-500';
  const connLabel =
    cluster.state === 'connected'
      ? `connected · ${cluster.peers.length} peer${cluster.peers.length === 1 ? '' : 's'}`
      : cluster.state === 'connecting'
        ? 'connecting…'
        : cluster.state === 'error'
          ? 'disconnected'
          : cluster.state === 'disconnected'
            ? 'disconnected'
            : 'idle';

  // Session state for the upper-right badge
  const sessionStateLabel: string | null = sessionRunning
    ? 'running'
    : evalCount > 0
      ? 'idle (corpus has data)'
      : null;
  const sessionStateColor = sessionRunning
    ? 'text-emerald-700'
    : 'text-stone-500';

  // Pool hint for the diagnostics line
  const poolHint = browserPoolHint();
  const spendFloor = controls
    ? computeMinimumSpendFloor(controls.baseline)
    : 0;

  // Throughput: prefer cluster snapshot value (it includes ALL hosts);
  // fallback to "?" until the first batch lands.
  const throughputLabel = (() => {
    if (!stats || !sessionRunning) return '—';
    if (!stats.sessionStartedAtIso) return '—';
    const elapsedMs = Date.now() - new Date(stats.sessionStartedAtIso).getTime();
    if (elapsedMs <= 0 || stats.policiesEvaluated === 0) return '—';
    const perMin = (stats.policiesEvaluated / elapsedMs) * 60_000;
    return `${perMin.toFixed(0)}/min`;
  })();

  const progressPct =
    stats && stats.totalPolicies > 0
      ? Math.round((stats.policiesEvaluated / stats.totalPolicies) * 100)
      : null;

  // -------------------------------------------------------------------------
  // Sub-renders
  // -------------------------------------------------------------------------

  const renderConnectionRow = () => (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-600">
      <span className={`font-semibold uppercase tracking-wider ${connColor}`}>
        {connLabel}
      </span>
      <span className="font-mono text-stone-500">
        {cluster.snapshot.dispatcherUrl}
      </span>
      <button
        type="button"
        className="text-stone-500 underline-offset-2 hover:underline"
        onClick={() => setShowUrlEditor((v) => !v)}
      >
        {showUrlEditor ? 'cancel' : 'edit'}
      </button>
      {cluster.state === 'error' && (
        <button
          type="button"
          className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100"
          onClick={cluster.reconnect}
        >
          retry now
        </button>
      )}
      {cluster.snapshot.lastError && (
        <span className="text-rose-600">{cluster.snapshot.lastError}</span>
      )}
      {cluster.snapshot.nextReconnectAtMs && (
        <span className="text-stone-500">
          retrying in{' '}
          {Math.max(
            0,
            Math.round(
              (cluster.snapshot.nextReconnectAtMs - Date.now()) / 1000,
            ),
          )}
          s
        </span>
      )}
      {showUrlEditor && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            cluster.setDispatcherUrl(urlDraft.trim());
            setShowUrlEditor(false);
          }}
        >
          <input
            type="text"
            className="w-64 rounded-md border border-stone-300 px-2 py-0.5 font-mono text-[11px]"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="ws://localhost:8765"
          />
          <button
            type="submit"
            className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-700 hover:bg-stone-200"
          >
            save
          </button>
        </form>
      )}
    </div>
  );

  const renderControls = () =>
    !controls ? null : (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canStart}
          onClick={startMining}
          className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
        >
          Start mining
        </button>
        <button
          type="button"
          disabled={!canCancel}
          onClick={cancelMining}
          className="rounded-full bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:text-stone-400"
        >
          Cancel
        </button>
        {startError && (
          <span className="text-xs text-rose-600">{startError}</span>
        )}
        <span className="ml-auto text-[11px] text-stone-500">
          floor: {formatCurrency(spendFloor)}/yr
          {' · '}
          pool:{' '}
          {poolHint.actualPoolSize !== null &&
          poolHint.actualPoolSize !== poolHint.poolSize
            ? `${poolHint.actualPoolSize} actual / ${poolHint.poolSize} target`
            : `${poolHint.poolSize}`}{' '}
          workers
          {' · '}
          {poolHint.hardwareConcurrency} cores
          {totalCandidates !== null && ` · ${totalCandidates.toLocaleString()} candidates`}
        </span>
      </div>
    );

  const renderHostPanel = () => {
    if (cluster.peers.length === 0) return null;
    // Sort: hosts before controllers, then by displayName.
    const ordered = [...cluster.peers].sort((a, b) => {
      const aHost = a.roles.includes('host') ? 0 : 1;
      const bHost = b.roles.includes('host') ? 0 : 1;
      if (aHost !== bHost) return aHost - bHost;
      return a.displayName.localeCompare(b.displayName);
    });
    return (
      <div className="mt-4 border-t border-stone-100 pt-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-stone-500">
          Cluster peers
        </p>
        <div className="space-y-1">
          {ordered.map((peer) => {
            const isHost = peer.roles.includes('host');
            const ms = peer.meanMsPerPolicy;
            const throughputCol =
              isHost && ms !== null && ms > 0
                ? `${(60_000 / ms).toFixed(0)} pol/min/worker`
                : isHost
                  ? 'awaiting first batch'
                  : peer.roles.join('+');
            return (
              <div
                key={peer.peerId}
                className="grid grid-cols-12 items-center gap-2 text-[11px]"
              >
                <span className="col-span-4 truncate text-stone-700">
                  <span
                    className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                      isHost ? 'bg-emerald-500' : 'bg-sky-500'
                    }`}
                  />
                  {peer.displayName}
                </span>
                <span className="col-span-2 text-stone-500">
                  {peer.capabilities
                    ? `${peer.capabilities.workerCount}w`
                    : '—'}
                </span>
                <span className="col-span-3 text-stone-500">
                  {throughputCol}
                </span>
                <span className="col-span-2 text-stone-500">
                  {peer.inFlightBatchCount > 0
                    ? `${peer.inFlightBatchCount} in flight`
                    : ''}
                </span>
                <span className="col-span-1 text-right text-stone-400">
                  {formatRelative(peer.lastHeartbeatTs)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // -------------------------------------------------------------------------
  // Top-level layout
  // -------------------------------------------------------------------------

  // Empty corpus, no active session — show a hint rather than nothing,
  // so the household knows the feature exists. Connection row + controls
  // render here too.
  if (!session && evalCount === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50/60 p-4 text-sm text-stone-600">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          Policy Mining
        </p>
        {renderConnectionRow()}
        <p>
          No mined policies yet for this plan. Background mining will
          search thousands of variations and surface the strategies that
          most reliably leave at least your North Star.
        </p>
        {renderControls()}
        {renderHostPanel()}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-stone-200 bg-white/80 p-4 text-sm text-stone-700 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          Policy Mining
        </p>
        {sessionStateLabel && (
          <span
            className={`text-[11px] font-semibold uppercase tracking-wider ${sessionStateColor}`}
          >
            {sessionStateLabel}
          </span>
        )}
      </div>
      {renderConnectionRow()}
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
            {throughputLabel}
          </p>
          <p className="mt-1 text-[11px] text-stone-500">
            {stats && stats.meanMsPerPolicy > 0
              ? `cluster mean ${(stats.meanMsPerPolicy / 1000).toFixed(1)}s/policy`
              : sessionRunning
                ? 'awaiting first batch'
                : ''}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            Time remaining
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
            {stats && sessionRunning
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
                {sessionRunning
                  ? 'no feasible candidate yet'
                  : 'no historical results'}
              </p>
            </>
          )}
        </div>
      </div>
      {renderControls()}
      {renderHostPanel()}
    </div>
  );
}
