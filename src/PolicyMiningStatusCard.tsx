import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDefaultPolicyAxes,
  computeMinimumSpendFloor,
  countPolicyCandidates,
} from './policy-axis-enumerator';
import type {
  PolicyEvaluation,
  PolicyAxes,
} from './policy-miner-types';
import type { MarketAssumptions, SeedData } from './types';
import { useClusterSession } from './useClusterSession';
import { browserPoolHint, setBrowserHostMode } from './cluster-client';
import { MiningPhaseSegments, type PipelinePhase } from './MiningPhaseSegments';
import { recommendCombinedPass2 } from './combined-pass2-analyzer';
import { loadCorpusEvaluations } from './policy-mining-corpus-source';
import { loadClusterEvaluations } from './policy-mining-cluster';
import {
  bestPolicy,
  LEGACY_ATTAINMENT_FLOOR,
  SOLVENCY_DEFENSE_FLOOR,
} from './policy-ranker';
import {
  buildPeerViewList,
  formatAgo,
  formatEngineRuntime,
  formatPerfClass,
  formatThroughput,
  type PeerView,
} from './cluster-peer-view';
import type { ClusterRuntimeMetrics } from './mining-protocol';

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
 * The browser can be a host (its Web Worker pool serves the dispatcher)
 * and is always a controller (the Start button below sends
 * `start_session`). With no other hosts connected, Browser Max runs the
 * work locally; with Node hosts connected, Node Hosts Only keeps this
 * tab out of the compute pool.
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
  /** Min bequest attainment rate to count a policy as feasible (default 0.85). */
  feasibilityThreshold?: number;
  /** Min lifetime solvency rate for the sleep-at-night risk floor. */
  solvencyThreshold?: number;
  /** Trials per policy this session. Default is owned by caller. */
  trialCount?: number;
}

interface Props {
  baselineFingerprint: string | null;
  engineVersion: string;
  controls?: PolicyMiningControls;
  /** Optional override of the policy axes (spend/SS/Roth grid) to mine
   *  against. When set, replaces `buildDefaultPolicyAxes(baseline)`'s
   *  output for THIS session — used by the AxisPruningCard's "Apply
   *  narrower range" workflow. Cluster-client already supports this
   *  via `StartSessionOptions.axesOverride`; we just thread it through
   *  the UI. Pass `null` to use the default grid (the common case). */
  axesOverride?: import('./policy-miner-types').PolicyAxes | null;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * Quick-mine cap. Sized so a re-validation pass after a baseline tweak
 * fits inside a 5-minute window on a single 8-core box and ~1-2 minutes
 * on a 24-worker cluster — the "I changed something, does my winner
 * still hold?" use case. Not a Pareto-smart subset (yet — see E.5
 * sensitivity sweep); just the first N policies in axis-enumeration
 * order, which is consistent across runs so the household isn't
 * comparing apples-to-oranges across Quick mines.
 */
const QUICK_MINE_POLICY_COUNT = 200;

type SessionSize = 'quick' | 'full';

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/** More precise wall-time formatter for elapsed/last-run displays.
 *  Distinct from formatDuration (which rounds to whole minutes) because
 *  Quick mines complete in under a minute and "0 min" reads as broken.
 *  Sub-minute: "23s". Sub-hour: "2m 14s". Beyond: "1h 23m". */
function formatWallTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m ${remSec}s`;
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return `${hours}h ${remMin}m`;
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

function formatMetricMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBuildLabel(view: PeerView): string | null {
  // Auto-update handles mismatch/dirty silently — workers self-heal on the
  // next idle window. Don't surface those transient states in the UI.
  if (view.buildStatus !== 'match') return null;
  const commit = view.buildInfo?.gitCommit;
  return commit ? commit.slice(0, 7) : 'current';
}

export function PolicyMiningStatusCard({
  baselineFingerprint,
  engineVersion,
  controls,
  axesOverride,
}: Props): JSX.Element | null {
  const cluster = useClusterSession();
  const [bestEval, setBestEval] = useState<PolicyEvaluation | null>(null);
  const [evalCount, setEvalCount] = useState<number>(0);
  const [startError, setStartError] = useState<string | null>(null);
  // Inline editor for the dispatcher URL (collapsed by default to keep
  // the chrome quiet for the common case).
  const [showUrlEditor, setShowUrlEditor] = useState(false);
  const [urlDraft, setUrlDraft] = useState(cluster.snapshot.dispatcherUrl);
  // 2-second wall-clock tick so the per-host "X ago" labels and
  // live/stale/offline status pills update even when no snapshot is
  // arriving (e.g. a host has dropped and is silently aging). Cheap;
  // the panel is only mounted while the user is on this screen.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 2_000);
    return () => clearInterval(id);
  }, []);
  // Session size picker — Quick (200 policies) for fast re-validation
  // after a baseline tweak, Full (whole corpus) for initial exploration
  // or final certification. Default flips to Quick once a corpus exists,
  // since at that point the household is iterating, not exploring.
  const [sessionSize, setSessionSize] = useState<SessionSize>('full');
  // Track wall time for the household: live elapsed during a running
  // session, and the just-completed wall time between sessions so they
  // can compare runs. The cluster snapshot drops session info the
  // moment a session ends (snapshot.session → null), so we capture the
  // wall time at that transition by stashing the start in a ref while
  // a session is active. Cleared when a new session starts so the UI
  // doesn't display stale "last run" info from a different session.
  const runningStartMsRef = useRef<number | null>(null);
  const [lastRunWallMs, setLastRunWallMs] = useState<number | null>(null);
  const [lastRunMetrics, setLastRunMetrics] = useState<ClusterRuntimeMetrics | null>(null);
  useEffect(() => {
    if (cluster.session) {
      if (cluster.session.metrics) setLastRunMetrics(cluster.session.metrics);
      if (runningStartMsRef.current === null) {
        // Session just appeared — stamp the start, clear any prior
        // last-run-wall-time so it doesn't bleed into the running tile.
        runningStartMsRef.current = new Date(
          cluster.session.startedAtIso,
        ).getTime();
        setLastRunWallMs(null);
        setLastRunMetrics(cluster.session.metrics ?? null);
      }
    } else if (runningStartMsRef.current !== null) {
      // Session just ended — freeze the final wall time for display
      // until a new session starts.
      setLastRunWallMs(Date.now() - runningStartMsRef.current);
      runningStartMsRef.current = null;
    }
  }, [cluster.session]);
  // Live elapsed for a running session — updates with the existing
  // 2-second wall-clock tick (`nowMs`) so the display refreshes without
  // adding another timer.
  const runningElapsedMs =
    runningStartMsRef.current !== null
      ? nowMs - runningStartMsRef.current
      : null;

  // -------------------------------------------------------------------------
  // Auto-pipeline: pass-1 (default rule, full grid) → combined pass-2 (cliff
  // refine + rule sweep on contenders) → done. Replaces the household's
  // need to manually click cliff and rule-sweep cards. Activated only on
  // Start Full Mine with no axesOverride; Quick mines and manual overrides
  // skip the pipeline (single-pass, segmented control hidden).
  // -------------------------------------------------------------------------
  const [pipelinePhase, setPipelinePhase] = useState<PipelinePhase>('idle');
  const [pipelinePass1Total, setPipelinePass1Total] = useState<number | null>(
    null,
  );
  const [pipelinePass2Total, setPipelinePass2Total] = useState<number | null>(
    null,
  );
  const [pipelineBestPolicyId, setPipelineBestPolicyId] = useState<string | null>(
    null,
  );
  // True for the duration of a pipeline run — set when Start fires the
  // pass-1 session, cleared on completion, error, or cancel. Used to
  // gate the auto-fire in the session-ended watcher so cancelled or
  // manual sessions don't accidentally trigger pass-2.
  const pipelineActiveRef = useRef<boolean>(false);
  // 0 = expecting pass-1, 1 = pass-1 has ended, expecting pass-2, 2 =
  // pass-2 has ended (pipeline done). The watcher uses this to decide
  // what "session just ended" means without depending on session-id
  // identity (which is racy because cluster.session updates separately
  // from snapshot ticks).
  const pipelineCompletionsRef = useRef<number>(0);
  // Track the last seen sessionId across renders so we only act on
  // actual session transitions (X → null), not on every snapshot
  // tick where session is incidentally null. Without this, the effect
  // fires the "pass-1 ended" branch as soon as Start is clicked,
  // before the dispatcher's session ack arrives.
  const pipelineLastSessionIdRef = useRef<string | null>(null);
  const currentSessionId = cluster.session?.sessionId ?? null;
  // Stable refs for things we read inside the effect but don't want as
  // deps (because they get fresh references every render and would
  // spuriously re-run the watcher). The pipeline only needs to react
  // to session-id transitions; other dep changes are noise.
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const clusterRef = useRef(cluster);
  clusterRef.current = cluster;
  // Watch session transitions: pass-1 end → fire pass-2; pass-2 end →
  // mark done. Reads the corpus from the cluster's HTTP API (or local
  // IDB fallback) to compute combined pass-2 axes.
  useEffect(() => {
    const lastSessionId = pipelineLastSessionIdRef.current;
    // Session is active: just track the id and bail. The effect re-runs
    // when the id changes (start of a session OR end of a session).
    if (currentSessionId) {
      pipelineLastSessionIdRef.current = currentSessionId;
      return;
    }
    // Session id is null. Was it null before? Then this is just the
    // initial mount — no transition to act on.
    if (lastSessionId === null) return;
    // A session just ended. Clear the last-seen id so subsequent null
    // ticks don't keep re-firing this branch.
    pipelineLastSessionIdRef.current = null;
    if (!pipelineActiveRef.current) return;
    const ctrls = controlsRef.current;
    if (!baselineFingerprint || !ctrls) return;

    const completionsBefore = pipelineCompletionsRef.current;
    pipelineCompletionsRef.current = completionsBefore + 1;

    // Pass-2 just ended: pipeline is done.
    if (completionsBefore >= 1) {
      pipelineActiveRef.current = false;
      pipelineCompletionsRef.current = 0;
      setPipelinePhase('done');
      return;
    }

    // Pass-1 just ended: fetch the just-ended session's evaluations
    // directly via its sessionId (which we captured before clearing
    // lastSessionId). Using `/sessions/<id>/evaluations` skips the
    // race window where the dispatcher has broadcast session_ended
    // but hasn't yet listed the session in `/sessions`. Retries
    // briefly to absorb the disk-persistence lag.
    //
    // No effect-cleanup-based cancellation — the watcher's deps are
    // narrow enough now that re-runs are rare, and a cleanup-cancel
    // pattern would race against the async fetch (the cleanup fires
    // before .then resolves, leaving pipelinePhase stuck on
    // 'exploring' forever). Instead, we gate post-fetch work on
    // `pipelineActiveRef.current` — that's a ref, so a Cancel click
    // synchronously flips it without depending on effect lifecycle.
    const dispatcherUrl = clusterRef.current.snapshot.dispatcherUrl ?? null;
    const justEndedSessionId = lastSessionId;
    const fetchPass1Evaluations = async () => {
      if (dispatcherUrl) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            const payload = await loadClusterEvaluations(
              dispatcherUrl,
              justEndedSessionId,
            );
            if (payload.evaluations.length > 0) return payload.evaluations;
          } catch {
            // 404 / network blip — wait and retry.
          }
          await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 300));
        }
      }
      // Last-resort fallback: corpus-source helper (cluster session list
      // OR local IDB). Empty result → pipeline gives up gracefully.
      return loadCorpusEvaluations(
        baselineFingerprint,
        engineVersion,
        dispatcherUrl,
      );
    };
    void fetchPass1Evaluations()
      .then((evals) => {
        if (!pipelineActiveRef.current) return; // user cancelled mid-fetch
        const ctrls2 = controlsRef.current;
        if (!ctrls2) return;
        const recommendation = recommendCombinedPass2(
          evals,
          ctrls2.baseline,
          ctrls2.feasibilityThreshold ?? LEGACY_ATTAINMENT_FLOOR,
          'legacy',
          ctrls2.solvencyThreshold ?? SOLVENCY_DEFENSE_FLOOR,
        );
        if (!recommendation.hasRecommendation) {
          pipelineActiveRef.current = false;
          pipelineCompletionsRef.current = 0;
          setPipelinePhase('done');
          return;
        }
        setPipelinePass2Total(recommendation.estimatedPass2Candidates);
        setPipelinePhase('refining');
        try {
          clusterRef.current.startSession({
            baseline: ctrls2.baseline,
            assumptions: ctrls2.assumptions,
            baselineFingerprint,
            legacyTargetTodayDollars: ctrls2.legacyTargetTodayDollars,
            feasibilityThreshold:
              ctrls2.feasibilityThreshold ?? LEGACY_ATTAINMENT_FLOOR,
            maxPoliciesPerSession: recommendation.estimatedPass2Candidates,
            trialCount: ctrls2.trialCount,
            axesOverride: recommendation.axes,
          });
        } catch (e) {
          pipelineActiveRef.current = false;
          pipelineCompletionsRef.current = 0;
          setPipelinePhase('done');
          setStartError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((err: unknown) => {
        if (!pipelineActiveRef.current) return;
        pipelineActiveRef.current = false;
        pipelineCompletionsRef.current = 0;
        setPipelinePhase('done');
        setStartError(err instanceof Error ? err.message : 'pipeline corpus load failed');
      });
  }, [currentSessionId, baselineFingerprint, engineVersion]);
  // Best-policy display in the 'done' segment — surface whatever the
  // corpus's top record is at the time the pipeline ends.
  useEffect(() => {
    if (pipelinePhase !== 'done') return;
    if (!baselineFingerprint) return;
    let cancelled = false;
    const dispatcherUrl = cluster.snapshot.dispatcherUrl ?? null;
    void loadCorpusEvaluations(
      baselineFingerprint,
      engineVersion,
      dispatcherUrl,
    ).then((evals) => {
      if (cancelled) return;
      const best = bestPolicy(evals);
      setPipelineBestPolicyId(best?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [pipelinePhase, baselineFingerprint, engineVersion, cluster.snapshot.dispatcherUrl]);
  // Phase 2.C two-stage screening — UI toggle removed 2026-04-27.
  // End-to-end cluster testing showed two-stage doesn't deliver a
  // wall-time win on the cluster path at tested workloads (correctness
  // preserved across all variants; per-batch cluster overhead doubles
  // since each policy is processed twice). The underlying capability
  // stays in cluster-client.startSession's StartSessionOptions, the
  // dispatcher state machine, and the miner — so two-stage can be
  // re-enabled via env var, programmatic API, or the future event-
  // driven dispatcher work without any code change. Pass 1 / Pass 2
  // stage indicators in the Evaluated tile remain too — gated on
  // stats.coarseEvaluated > 0 so they cost nothing during single-pass
  // sessions but light up automatically if two-stage is enabled
  // upstream of the UI.

  // Keep the draft in sync if the URL changes externally (e.g. another
  // tab updates localStorage — rare but cheap to handle).
  useEffect(() => {
    if (!showUrlEditor) setUrlDraft(cluster.snapshot.dispatcherUrl);
  }, [cluster.snapshot.dispatcherUrl, showUrlEditor]);

  // Once a corpus exists for THIS baseline, default to Quick — the
  // household is now iterating (tweak baseline, re-validate winner),
  // not exploring from scratch. Resets when the baseline fingerprint
  // changes so a fresh plan can also auto-flip the first time its
  // corpus appears. Only flips on transitions, so an explicit user
  // choice mid-session sticks until the baseline changes.
  const [flippedForFingerprint, setFlippedForFingerprint] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (
      baselineFingerprint &&
      evalCount > 0 &&
      flippedForFingerprint !== baselineFingerprint
    ) {
      setSessionSize('quick');
      setFlippedForFingerprint(baselineFingerprint);
    }
  }, [baselineFingerprint, evalCount, flippedForFingerprint]);

  // Poll the canonical corpus source for "best so far". Cluster sessions
  // write to the dispatcher's on-disk corpus; legacy pre-D.3 sessions wrote
  // to IDB. The shared loader checks cluster first and falls back to IDB so
  // the status card and results table agree after a completed cluster mine.
  useEffect(() => {
    if (!baselineFingerprint) {
      setBestEval(null);
      setEvalCount(0);
      return undefined;
    }
    let cancelled = false;
    const dispatcherUrl = cluster.snapshot.dispatcherUrl ?? null;
    const tick = async () => {
      try {
        const evals = await loadCorpusEvaluations(
          baselineFingerprint,
          engineVersion,
          dispatcherUrl,
        );
        if (cancelled) return;
        setEvalCount(evals.length);
        setBestEval(bestPolicy(evals));
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
  }, [baselineFingerprint, engineVersion, cluster.snapshot.dispatcherUrl]);

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
    if (
      !Number.isFinite(controls.legacyTargetTodayDollars) ||
      controls.legacyTargetTodayDollars <= 0
    ) {
      setStartError('Set a legacy target before mining.');
      return;
    }
    // The picker (Quick / Full) wins over any cap the caller passed,
    // since the picker is the household's just-now choice. Caller's
    // cap is the floor for legacy code paths that don't show a picker.
    const cap =
      sessionSize === 'quick'
        ? QUICK_MINE_POLICY_COUNT
        : controls.maxPoliciesPerSession;
    // Auto-pipeline activation: a Full mine with no manual axesOverride
    // gets the pass-1 → combined pass-2 pipeline. Quick mines and
    // manual override paths skip the pipeline (single-pass behavior).
    const enablePipeline =
      sessionSize === 'full' && !axesOverride;
    if (enablePipeline) {
      pipelineActiveRef.current = true;
      pipelineCompletionsRef.current = 0;
      pipelineLastSessionIdRef.current = null;
      setPipelinePhase('exploring');
      setPipelinePass1Total(totalCandidates);
      setPipelinePass2Total(null);
      setPipelineBestPolicyId(null);
    } else {
      pipelineActiveRef.current = false;
      pipelineCompletionsRef.current = 0;
      pipelineLastSessionIdRef.current = null;
      setPipelinePhase('idle');
    }
    try {
      cluster.startSession({
        baseline: controls.baseline,
        assumptions: controls.assumptions,
        baselineFingerprint,
        legacyTargetTodayDollars: controls.legacyTargetTodayDollars,
        feasibilityThreshold:
          controls.feasibilityThreshold ?? LEGACY_ATTAINMENT_FLOOR,
        maxPoliciesPerSession: cap,
        trialCount: controls.trialCount,
        // axesOverride is the Apply-narrowed-range path — when the
        // AxisPruningCard's "Apply" button has fired, this is set;
        // otherwise undefined, in which case the cluster client falls
        // back to `buildDefaultPolicyAxes(baseline)` (the default
        // 1,728-cell grid).
        axesOverride: axesOverride ?? undefined,
        // Phase 2.C: two-stage screening capability remains on
        // StartSessionOptions but is no longer surfaced in the UI
        // (testing showed no cluster wall-time win). Future code
        // paths can populate `coarseStage` here to opt in.
      });
    } catch (e) {
      pipelineActiveRef.current = false;
      setPipelinePhase('idle');
      setStartError(e instanceof Error ? e.message : String(e));
    }
  };
  const cancelMining = () => {
    // Cancel aborts the pipeline so the session-ended watcher doesn't
    // auto-fire pass-2. Pass-1 records that already landed stay in the
    // corpus.
    pipelineActiveRef.current = false;
    pipelineCompletionsRef.current = 0;
    pipelineLastSessionIdRef.current = null;
    setPipelinePhase('idle');
    cluster.cancelSession('user clicked cancel');
  };

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
      {(cluster.state === 'idle' || cluster.state === 'disconnected') && (
        <button
          type="button"
          className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
          onClick={cluster.reconnect}
        >
          connect
        </button>
      )}
      {(cluster.state === 'connected' || cluster.state === 'connecting') && (
        <button
          type="button"
          className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-600 hover:bg-stone-200"
          onClick={cluster.disconnect}
        >
          disconnect
        </button>
      )}
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

  // Per-policy cost across the cluster. Prefer the live session's mean
  // (most accurate); fall back to the last completed session's mean if
  // the dispatcher exposes it; null if we have no data yet.
  const meanMsPerPolicy =
    stats && stats.meanMsPerPolicy > 0 ? stats.meanMsPerPolicy : null;

  // Estimate wall-clock for a session of `policyCount` policies given
  // the observed cluster throughput. Returns null when we have nothing
  // to extrapolate from — UI shows '~?' rather than a fake number.
  const estimateSessionMs = (policyCount: number): number | null => {
    if (meanMsPerPolicy === null) return null;
    // Sum of in-flight worker counts across all peers (host role only).
    const totalWorkers = cluster.peers
      .filter((p) => p.roles.includes('host'))
      .reduce((s, p) => s + (p.capabilities?.workerCount ?? 0), 0);
    if (totalWorkers === 0) return null;
    return (policyCount * meanMsPerPolicy) / totalWorkers;
  };

  const quickEtaMs = estimateSessionMs(QUICK_MINE_POLICY_COUNT);
  const fullEtaMs =
    totalCandidates !== null ? estimateSessionMs(totalCandidates) : null;

  // Live evaluated count for the active pass — feeds the segmented
  // progress control's per-segment subtitle.
  const liveEvaluatedCount = stats?.policiesEvaluated ?? null;
  const renderControls = () =>
    !controls ? null : (
      <div className="mt-3 space-y-2">
        <MiningPhaseSegments
          phase={pipelinePhase}
          pass1Total={pipelinePass1Total}
          pass1Evaluated={pipelinePhase === 'exploring' ? liveEvaluatedCount : null}
          pass2Total={pipelinePass2Total}
          pass2Evaluated={pipelinePhase === 'refining' ? liveEvaluatedCount : null}
          bestPolicyId={pipelineBestPolicyId}
        />
        <div className="flex flex-wrap items-center gap-2">
          {/* Session size picker — the iteration-vs-exploration choice.
              Disabled while a session runs so the picker can't drift
              away from what's actually being mined. */}
          <div
            role="radiogroup"
            aria-label="Session size"
            className="inline-flex overflow-hidden rounded-full border border-stone-200 text-[11px]"
          >
            <button
              type="button"
              role="radio"
              aria-checked={sessionSize === 'quick'}
              disabled={sessionRunning}
              onClick={() => setSessionSize('quick')}
              className={`px-3 py-1 font-semibold transition ${
                sessionSize === 'quick'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-white text-stone-600 hover:bg-stone-50'
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Quick · {QUICK_MINE_POLICY_COUNT}
              {quickEtaMs !== null && (
                <span className="ml-1 font-normal opacity-90">
                  (~{formatDuration(quickEtaMs)})
                </span>
              )}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={sessionSize === 'full'}
              disabled={sessionRunning}
              onClick={() => setSessionSize('full')}
              className={`border-l border-stone-200 px-3 py-1 font-semibold transition ${
                sessionSize === 'full'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-white text-stone-600 hover:bg-stone-50'
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Full
              {totalCandidates !== null && (
                <span className="ml-1 font-normal opacity-90">
                  · {totalCandidates.toLocaleString()}
                </span>
              )}
              {fullEtaMs !== null && (
                <span className="ml-1 font-normal opacity-90">
                  (~{formatDuration(fullEtaMs)})
                </span>
              )}
            </button>
          </div>
          <button
            type="button"
            disabled={!canStart}
            onClick={startMining}
            className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
          >
            {sessionSize === 'quick' ? 'Start quick mine' : 'Start full mine'}
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
          </span>
        </div>
        {/* Phase 2.C UX — compute mode picker. Lets the household decide
            whether this browser contributes workers or only controls a
            dedicated Node/Rust host pool. Changing modes reconnects the
            browser so the dispatcher immediately sees the new role.
            Stays visible (disabled) during sessions so the operator
            always knows what mode the running session is using —
            screenshots of in-flight progress carry the configuration
            context. */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-600">
          <span className="font-semibold text-stone-700">
            Compute:
          </span>
          <div
            role="radiogroup"
            className="inline-flex overflow-hidden rounded-full border border-stone-200"
          >
            {(['off', 'reduced', 'full'] as const).map((mode) => {
              const labels: Record<typeof mode, string> = {
                off: 'Node hosts only',
                reduced: 'Mixed',
                full: 'Browser max',
              };
              const isActive = poolHint.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  disabled={sessionRunning}
                  onClick={() => {
                    setBrowserHostMode(mode);
                    setNowMs(Date.now());
                    cluster.reconnect();
                  }}
                  className={`px-2.5 py-0.5 transition ${
                    isActive
                      ? 'bg-stone-700 text-white'
                      : 'bg-white text-stone-600 hover:bg-stone-50'
                  } ${mode === 'reduced' ? 'border-l border-r border-stone-200' : ''} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {labels[mode]}
                </button>
              );
            })}
          </div>
          <span className="text-stone-400">
            {poolHint.mode === 'off'
              ? 'controller only'
              : poolHint.mode === 'reduced'
                ? `${Math.min(4, poolHint.hardwareConcurrency)} browser workers`
                : `${poolHint.poolSize} browser workers`}
          </span>
        </div>
        {/* One-line caption tying the picker to the iteration loop so
            the household understands WHY the picker exists. Hidden once
            a session is running — the throughput row above tells the
            same story live. */}
        {!sessionRunning && (
          <p className="text-[11px] text-stone-500">
            {sessionSize === 'quick'
              ? `Validates the top of the frontier against your current baseline. Use after editing the plan.`
              : `Searches every spend × SS × Roth combination. Use for initial exploration or final certification.`}
          </p>
        )}
      </div>
    );

  const renderHostPanel = () => {
    const views = buildPeerViewList(cluster.peers, cluster.ghosts, nowMs);
    if (views.length === 0) return null;

    const statusPill = (view: PeerView) => {
      // Status drives both color and an explicit label so red/green
      // colorblindness doesn't strand the operator at a glance.
      const cls =
        view.status === 'live'
          ? 'bg-emerald-500'
          : view.status === 'stale'
            ? 'bg-amber-500'
            : 'bg-stone-400';
      const label =
        view.status === 'live'
          ? 'live'
          : view.status === 'stale'
            ? 'stale'
            : 'offline';
      return (
        <span className="inline-flex items-center gap-1">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />
          <span className="text-[10px] uppercase tracking-wider text-stone-500">
            {label}
          </span>
        </span>
      );
    };

    return (
      <div className="mt-4 border-t border-stone-100 pt-3">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            Cluster peers
          </p>
          <span className="text-[10px] text-stone-400">
            {views.filter((v) => v.status === 'live').length} live ·{' '}
            {views.filter((v) => v.status === 'stale').length} stale ·{' '}
            {views.filter((v) => v.status === 'offline').length} offline
          </span>
        </div>
        <div className="space-y-1.5">
          {views.map((v) => {
            const isHost = v.roles.includes('host');
            const isGhost = v.status === 'offline';
            // Load bar: in-flight / worker count, capped at 1.0. Visual
            // cue for "this host is busy" without the operator having to
            // mentally divide.
            const loadFrac =
              v.workerCount && v.workerCount > 0
                ? Math.min(1, v.reservedWorkerSlots / v.workerCount)
                : 0;
            const throughputLabel = isHost
              ? v.dispatchBlockedReason
                ? v.dispatchBlockedReason.replace(/^build_/, 'build ')
                : v.totalPolPerMin !== null
                  ? formatThroughput(v.totalPolPerMin)
                  : 'awaiting first batch'
              : v.roles.join('+');
            return (
              <div
                key={v.peerId}
                className={`grid grid-cols-12 items-center gap-2 text-[11px] ${
                  isGhost ? 'opacity-60' : ''
                }`}
              >
                <span className="col-span-4 truncate text-stone-700">
                  <span className="mr-1.5 inline-flex items-center align-middle">
                    {statusPill(v)}
                  </span>
                  <span className={isGhost ? 'line-through' : ''}>
                    {v.displayName}
                  </span>
                </span>
                <span className="col-span-3 truncate text-stone-500">
                  {v.workerCount !== null
                    ? `${v.workerCount}w · ${formatPerfClass(v.capabilities?.perfClass)} · ${formatEngineRuntime(v.capabilities?.engineRuntime)}`
                    : v.roles.includes('controller')
                      ? 'controller'
                      : '—'}
                  {v.workerCount !== null && formatBuildLabel(v) !== null && (
                    <span className="ml-1 text-stone-400">
                      · {formatBuildLabel(v)}
                    </span>
                  )}
                </span>
                <span className="col-span-2 text-stone-500">
                  {throughputLabel}
                </span>
                <span className="col-span-2">
                  {isHost && v.workerCount !== null && !isGhost ? (
                    <span className="flex items-center gap-1.5">
                      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-stone-200">
                        <span
                          className={`absolute inset-y-0 left-0 ${
                            loadFrac > 0.85
                              ? 'bg-amber-500'
                              : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.round(loadFrac * 100)}%` }}
                        />
                      </span>
                      <span className="text-[10px] text-stone-500">
                        {v.reservedWorkerSlots}/{v.workerCount}
                      </span>
                    </span>
                  ) : null}
                </span>
                <span className="col-span-1 text-right text-stone-400">
                  {formatAgo(v.lastSeenAt, nowMs)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderPerformancePanel = () => {
    const metrics = cluster.session?.metrics ?? lastRunMetrics;
    if (!metrics) return null;
    const isLive = !!cluster.session?.metrics;
    const views = buildPeerViewList(cluster.peers, cluster.ghosts, nowMs);
    const liveHosts = views.filter((v) => v.status === 'live' && v.roles.includes('host'));
    const rustHosts = liveHosts.filter(
      (v) => v.capabilities?.engineRuntime === 'rust-native-compact',
    );
    const nonRustHosts = liveHosts.filter(
      (v) => v.capabilities?.engineRuntime !== 'rust-native-compact',
    );
    const idleRatio =
      metrics.hostBusySlotMs + metrics.hostIdleWhilePendingSlotMs > 0
        ? metrics.hostIdleWhilePendingSlotMs /
          (metrics.hostBusySlotMs + metrics.hostIdleWhilePendingSlotMs)
        : 0;
    const capacityNackRate =
      metrics.batchesAssigned > 0 ? metrics.capacityNacks / metrics.batchesAssigned : 0;
    const hint =
      nonRustHosts.length > 0
        ? `${nonRustHosts.length} live host${nonRustHosts.length === 1 ? '' : 's'} not on Rust compact`
        : metrics.policiesDropped > 0
        ? 'dropped policies need investigation'
        : capacityNackRate > 0.1
          ? 'capacity backpressure is the next scheduler target'
          : idleRatio > 0.15 && metrics.pendingPolicies > 0
            ? 'idle slots while work is pending point at dispatch handoff'
            : metrics.avgBatchSize !== null && metrics.avgBatchSize < 3 && metrics.pendingPolicies > 0
              ? 'tail batches are now dominating completion time'
              : 'engine compute and tape cache are likely the next limit';

    return (
      <div className="mt-4 border-t border-stone-100 pt-3">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            {isLive ? 'Performance' : 'Last Run Performance'}
          </p>
          <span className="text-[10px] text-stone-400">
            {hint}
          </span>
        </div>
        <div className="grid gap-3 text-[11px] sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <p className="uppercase tracking-wider text-stone-400">Utilization</p>
            <p className="mt-0.5 font-semibold tabular-nums text-stone-800">
              {metrics.hostUtilizationRate === null
                ? '—'
                : `${Math.round(metrics.hostUtilizationRate * 100)}%`}
            </p>
            <p className="text-stone-500">
              idle debt {formatWallTime(metrics.hostIdleWhilePendingSlotMs)}
              {metrics.quarantinedHostCount ? ` · ${metrics.quarantinedHostCount} quarantined` : ''}
              {metrics.unavailableHostCount ? ` · ${metrics.unavailableHostCount} unavailable` : ''}
              {metrics.calibratingHostCount ? ` · ${metrics.calibratingHostCount} calibrating` : ''}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wider text-stone-400">Batching</p>
            <p className="mt-0.5 font-semibold tabular-nums text-stone-800">
              {metrics.avgBatchSize === null ? '—' : metrics.avgBatchSize.toFixed(1)} pol/batch
            </p>
            <p className="text-stone-500">
              {metrics.pendingPolicies.toLocaleString()} pending ·{' '}
              {metrics.inFlightBatches.toLocaleString()} in flight
              {metrics.avgBatchesAssignedPerPump == null
                ? ''
                : ` · ${metrics.avgBatchesAssignedPerPump.toFixed(1)}/pump`}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wider text-stone-400">Backpressure</p>
            <p className="mt-0.5 font-semibold tabular-nums text-stone-800">
              {metrics.capacityNacks.toLocaleString()} capacity nacks
            </p>
            <p className="text-stone-500">
              {metrics.policiesRequeued.toLocaleString()} requeued ·{' '}
              {metrics.policiesDropped.toLocaleString()} dropped
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wider text-stone-400">Latency</p>
            <p className="mt-0.5 font-semibold tabular-nums text-stone-800">
              {formatMetricMs(metrics.avgDispatchToResultMs)}
            </p>
            <p className="text-stone-500">
              queue {formatMetricMs(metrics.avgHostQueueDelayMs ?? null)} · write{' '}
              {formatMetricMs(metrics.avgCorpusAppendMs ?? null)}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wider text-stone-400">Runtime Mix</p>
            <p className="mt-0.5 font-semibold tabular-nums text-stone-800">
              {rustHosts.length}/{liveHosts.length} Rust compact
            </p>
            <p className="text-stone-500">
              {nonRustHosts.length === 0
                ? 'all live hosts on compiled path'
                : nonRustHosts.map((v) => v.displayName).join(', ')}
            </p>
          </div>
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
          {/* Phase 2.C — explicit Pass 1 / Pass 2 indicators when two-stage
              is active, so the household sees the workflow clearly. Three
              visual states based on derived stage:
                - inCoarse:  Pass 1 of 2 — Screening + coarse counter
                - inFine:    Pass 2 of 2 — Full evaluation + survivor count
                - else:      Single-pass "Evaluated" tile (legacy behavior)
              The dispatcher's MiningStats doesn't expose `currentStage`
              directly; we derive it from coarseEvaluated being populated
              and policiesEvaluated being 0 (= still in coarse) vs
              policiesEvaluated > 0 (= fine started or done). */}
          {(() => {
            const inTwoStage = stats !== null && stats.coarseEvaluated > 0;
            const inCoarse = inTwoStage && stats!.policiesEvaluated === 0;
            const inFine = inTwoStage && stats!.policiesEvaluated > 0;
            const survivors = inTwoStage
              ? stats!.coarseEvaluated - stats!.coarseScreenedOut
              : 0;

            if (inCoarse) {
              return (
                <>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-emerald-700">
                    Pass 1 of 2 · Screening
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                    {stats!.coarseEvaluated.toLocaleString()} /{' '}
                    {stats!.totalPolicies.toLocaleString()}
                  </p>
                  <p className="mt-1 text-[11px] text-stone-500">
                    {Math.round(
                      (stats!.coarseEvaluated / Math.max(1, stats!.totalPolicies)) * 100,
                    )}
                    % screened
                  </p>
                  <p className="mt-1 text-[11px] text-emerald-700">
                    {survivors.toLocaleString()} kept ·{' '}
                    {stats!.coarseScreenedOut.toLocaleString()} dropped
                  </p>
                </>
              );
            }
            if (inFine) {
              return (
                <>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-emerald-700">
                    Pass 2 of 2 · Full evaluation
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                    {stats!.policiesEvaluated.toLocaleString()} /{' '}
                    {survivors.toLocaleString()}
                  </p>
                  <p className="mt-1 text-[11px] text-stone-500">
                    {Math.round((stats!.policiesEvaluated / Math.max(1, survivors)) * 100)}
                    % of survivors
                  </p>
                  <p className="mt-1 text-[11px] text-emerald-700">
                    Pass 1: screened {stats!.coarseEvaluated.toLocaleString()},{' '}
                    {stats!.coarseScreenedOut.toLocaleString()} dropped
                  </p>
                </>
              );
            }
            return (
              <>
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
              </>
            );
          })()}
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
          {/* Wall-time tile. Three display states:
              - Running session: big "elapsed" (live), small "remaining" subtitle
              - Just-completed session: big "last run wall" (frozen), small
                "feasible found" subtitle so the household can compare
                runs at a glance
              - Idle (no session ever, no last-run): "—" placeholder */}
          {sessionRunning && runningElapsedMs !== null ? (
            <>
              <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
                Elapsed
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                {formatWallTime(runningElapsedMs)}
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                {stats
                  ? `~${formatDuration(stats.estimatedRemainingMs)} remaining · browser host: ${poolHint.mode}`
                  : `browser host: ${poolHint.mode}`}
              </p>
            </>
          ) : lastRunWallMs !== null ? (
            <>
              <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
                Last run
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                {formatWallTime(lastRunWallMs)}
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                {stats?.feasiblePolicies != null
                  ? `${stats.feasiblePolicies.toLocaleString()} feasible · browser host: ${poolHint.mode}`
                  : `browser host: ${poolHint.mode}`}
              </p>
            </>
          ) : (
            <>
              <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
                Time remaining
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                —
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                {stats?.feasiblePolicies != null
                  ? `${stats.feasiblePolicies.toLocaleString()} feasible found`
                  : ''}
              </p>
            </>
          )}
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
            Best so far
          </p>
          {bestEval ? (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-700">
                {formatPct(bestEval.outcome.solventSuccessRate)}
              </p>
              <p className="mt-1 text-[11px] text-stone-500">
                solvency · legacy {formatPct(bestEval.outcome.bequestAttainmentRate)} ·{' '}
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
      {renderPerformancePanel()}
      {renderHostPanel()}
    </div>
  );
}
