/**
 * Mining screen — the household's "re-run the model" surface.
 *
 * Two things live here:
 *   1. PolicyMiningStatusCard — start / pause / resume mines, see
 *      cluster peers, throughput, best-so-far.
 *   2. PolicyMiningResultsTable — the ranked corpus with adopt buttons.
 *
 * Both used to live inside the old `UnifiedPlanScreen` (the dropped
 * "Plan" tab). When we collapsed the navigation to 5 sidebar items
 * for the household-facing surface, the mining workflow became
 * unreachable — this screen restores the path.
 *
 * Why a separate file from UnifiedPlanScreen: keeps the mining
 * surface decoupled from the legacy plan-controls / verdict / flight
 * path UI. The Cockpit + Mining + Export trio is the new "what the
 * household actually uses"; UnifiedPlanScreen and friends remain in
 * the codebase for reference but aren't on the household's path.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from './store';
import { useClusterSession } from './useClusterSession';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { getCachedBaselinePath } from './baseline-path-cache';
import { PolicyMiningStatusCard } from './PolicyMiningStatusCard';
import { PolicyMiningResultsTable } from './PolicyMiningResultsTable';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import { countPolicyCandidates } from './policy-axis-enumerator';
import type { MarketAssumptions } from './types';
import type { PolicyAxes, PolicyEvaluation } from './policy-miner-types';
import { AxisPruningCard } from './AxisPruningCard';
import { CliffRefinementCard } from './CliffRefinementCard';
import { recommendCliffRefinement } from './cliff-refinement-analyzer';
import {
  loadClusterEvaluations,
  loadClusterSessions,
} from './policy-mining-cluster';
import { loadEvaluationsForBaseline } from './policy-mining-corpus';

const POLICY_MINING_TRIAL_COUNT = 2000;

/**
 * Pin the miner to its own trial count so the corpus key (which
 * embeds `simulationRuns`) doesn't change when the household dials
 * the interactive UI's run count up or down. Mirrors the helper
 * inside UnifiedPlanScreen — duplicated rather than imported because
 * UnifiedPlanScreen is on the deprecation path.
 */
function getPolicyMiningAssumptions(
  assumptions: MarketAssumptions,
): MarketAssumptions {
  return {
    ...assumptions,
    simulationRuns: POLICY_MINING_TRIAL_COUNT,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-mining-${POLICY_MINING_TRIAL_COUNT}`
      : `mining-${POLICY_MINING_TRIAL_COUNT}`,
  };
}

export function MiningScreen() {
  const data = useAppStore((state) => state.appliedData);
  const assumptions = useAppStore((state) => state.appliedAssumptions);
  const selectedStressors = useAppStore(
    (state) => state.appliedSelectedStressors,
  );
  const selectedResponses = useAppStore(
    (state) => state.appliedSelectedResponses,
  );
  const cluster = useClusterSession();
  const dispatcherUrl = cluster.snapshot.dispatcherUrl ?? null;

  // Axis-pruning Apply-and-rerun state. When the household clicks
  // "Apply narrower range" on the AxisPruningCard, the recommended
  // narrowed grid lands here and is forwarded to PolicyMiningStatusCard,
  // which threads it to `cluster.startSession({ axesOverride })`. The
  // override is volatile (component-local) — closing the screen
  // resets to the default grid. To persist across visits, lift to
  // zustand store; tonight's scope kept it local for simplicity.
  const [axesOverride, setAxesOverride] = useState<PolicyAxes | null>(null);

  // Auto cliff-refinement state. After a Full mine completes, we run the
  // analyzer; if it detects a feasibility cliff, we automatically start a
  // pass-2 mine with hybrid axes (full $5k grid + $1k inserts across the
  // cliff). Pass-2 supersedes pass-1 so the cockpit and mining table all
  // converge on the dense $1k record near the adoption boundary — the
  // household's pick is "pretty close" without a manual click.
  const [autoRefine, setAutoRefine] = useState<{
    status: 'analyzing' | 'starting' | 'running' | 'complete';
    cliffLowerSpend?: number;
    cliffUpperSpend?: number;
    message: string;
  } | null>(null);
  const autoRefinedFingerprintsRef = useRef<Set<string>>(new Set());
  const prevSessionIdRef = useRef<string | null>(null);
  // Run-id based cancellation. Survives across effect re-runs (cleanup of
  // a non-triggering re-run doesn't kill an in-flight refinement). Bumped
  // only when a NEW running→idle transition fires, so concurrent refines
  // are impossible by construction.
  const refineRunIdRef = useRef<number>(0);

  // Build the evaluation fingerprint that scopes mining results to
  // the current baseline. Keeps the corpus on disk segregated by
  // baseline — a different policy adoption / spending dial / SS claim
  // age makes for a different "what's optimal here" question, so the
  // results shouldn't pool.
  const baselineFingerprint = useMemo(() => {
    if (!data || !assumptions) return null;
    try {
      return buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors: selectedStressors ?? [],
        selectedResponses: selectedResponses ?? [],
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[mining] fingerprint build failed:', err);
      return null;
    }
  }, [data, assumptions, selectedStressors, selectedResponses]);

  // Suffix the fingerprint with the trial count + scheme version so
  // bumping POLICY_MINING_TRIAL_COUNT cleanly invalidates the corpus
  // (rather than mixing 2000-trial and 5000-trial percentiles).
  const policyMiningFingerprint = baselineFingerprint
    ? `${baselineFingerprint}|trials=${POLICY_MINING_TRIAL_COUNT}|fpv1`
    : '';

  const legacyTargetTodayDollars = data?.goals?.legacyTargetTodayDollars ?? 0;

  // Auto cliff-refinement effect. Watches session lifecycle: when a mine
  // transitions from running → idle, run the analyzer on the freshest
  // corpus and, if a cliff is detected, kick off pass-2 with hybrid axes
  // ($5k base grid + $1k inserts across the cliff). Pass-2's evaluations
  // supersede pass-1 from the cockpit's POV (latest session wins), so
  // the household's "Adopt" lands on a $1k-resolution record near the
  // boundary without any manual click on a refinement card.
  //
  // Loop guard: each fingerprint is auto-refined at most once. After
  // pass-2 ends, `autoRefinedFingerprintsRef` already includes it, so
  // we don't kick a pass-3.
  //
  // Effect dep is the primitive sessionId, not `cluster.session` (a fresh
  // object reference on every dispatcher tick). Without that, the cleanup
  // would fire ~1×/second and cancel the in-flight corpus-fetch promise
  // before it could resolve — banner stuck on "Analyzing".
  const currentSessionId = cluster.session?.sessionId ?? null;
  const startSession = cluster.startSession;
  useEffect(() => {
    const currentId = currentSessionId;
    const previousId = prevSessionIdRef.current;
    prevSessionIdRef.current = currentId;

    // Trigger only on the running → idle transition.
    if (previousId == null || currentId != null) return;
    if (!policyMiningFingerprint || !data || !assumptions) return;
    if (autoRefinedFingerprintsRef.current.has(policyMiningFingerprint)) {
      // Pass-2 just ended for this fingerprint. Mark complete regardless
      // of where the prior status got stuck (analyzing/starting/running)
      // so the banner doesn't strand on an in-progress label after the
      // refine session actually wrapped.
      setAutoRefine((prev) => {
        if (!prev || prev.status === 'complete') return prev;
        return {
          ...prev,
          status: 'complete',
          message:
            prev.cliffLowerSpend != null && prev.cliffUpperSpend != null
              ? `Cliff refined at $1k resolution across $${(prev.cliffLowerSpend / 1000).toFixed(0)}k–$${(prev.cliffUpperSpend / 1000).toFixed(0)}k.`
              : 'Cliff refinement complete.',
        };
      });
      return;
    }

    // Mark immediately to defend against any synchronous re-trigger.
    autoRefinedFingerprintsRef.current.add(policyMiningFingerprint);

    setAutoRefine({
      status: 'analyzing',
      message: 'Pass 1 complete. Checking for a feasibility cliff…',
    });

    const myRunId = ++refineRunIdRef.current;
    const aborted = () => refineRunIdRef.current !== myRunId;
    void (async () => {
      try {
        // Small delay so the dispatcher can flush the summary file
        // before we read the corpus over HTTP. 200ms is generous on
        // the local cluster; the analyzer doesn't care about being
        // exact-on-the-millisecond.
        await new Promise((r) => setTimeout(r, 250));
        if (aborted()) return;

        // Pull the freshest corpus. Cluster is authoritative when
        // attached; fall back to local IDB so the analyzer can still
        // run on a browser-only mine.
        let evals: PolicyEvaluation[] = [];
        if (dispatcherUrl) {
          try {
            const sessions = await loadClusterSessions(dispatcherUrl);
            const match = sessions.find(
              (s) =>
                s.manifest?.config?.baselineFingerprint ===
                policyMiningFingerprint,
            );
            if (match) {
              const payload = await loadClusterEvaluations(
                dispatcherUrl,
                match.sessionId,
                { topN: 0, minFeasibility: 0.5 },
              );
              evals = payload?.evaluations ?? [];
            }
          } catch {
            // fall through to local
          }
        }
        if (evals.length === 0) {
          evals = await loadEvaluationsForBaseline(
            policyMiningFingerprint,
            POLICY_MINER_ENGINE_VERSION,
          );
        }
        if (aborted()) return;

        if (evals.length < 50) {
          // Tiny corpus (Quick mine, sparse local); analyzer would
          // overfit MC noise. Quietly drop the auto-refine UI.
          autoRefinedFingerprintsRef.current.delete(policyMiningFingerprint);
          setAutoRefine(null);
          return;
        }

        const recommendation = recommendCliffRefinement(evals, data, 0.85);
        if (aborted()) return;

        if (!recommendation.hasRecommendation) {
          // No cliff — either uniformly feasible or uniformly infeasible.
          // Surface a one-line "no cliff found" so the household knows
          // the analyzer ran, then fade.
          setAutoRefine({
            status: 'complete',
            message: 'No feasibility cliff in this corpus — pass 1 stands.',
          });
          return;
        }

        // Cliff found. Start pass-2 with hybrid axes. The analyzer
        // already returns the merged $5k grid + $1k inserts as
        // `recommendation.axes`.
        const cap = countPolicyCandidates(recommendation.axes);
        setAutoRefine({
          status: 'starting',
          cliffLowerSpend: recommendation.cliffLowerSpend,
          cliffUpperSpend: recommendation.cliffUpperSpend,
          message: `Cliff at $${(recommendation.cliffLowerSpend / 1000).toFixed(0)}k–$${(recommendation.cliffUpperSpend / 1000).toFixed(0)}k. Starting pass 2 at $1k resolution (${cap.toLocaleString()} candidates)…`,
        });
        setAxesOverride(recommendation.axes);
        startSession({
          baseline: data,
          assumptions: getPolicyMiningAssumptions(assumptions),
          baselineFingerprint: policyMiningFingerprint,
          legacyTargetTodayDollars,
          feasibilityThreshold: 0.7,
          maxPoliciesPerSession: cap,
          trialCount: POLICY_MINING_TRIAL_COUNT,
          axesOverride: recommendation.axes,
        });
        setAutoRefine({
          status: 'running',
          cliffLowerSpend: recommendation.cliffLowerSpend,
          cliffUpperSpend: recommendation.cliffUpperSpend,
          message: `Refining $${(recommendation.cliffLowerSpend / 1000).toFixed(0)}k–$${(recommendation.cliffUpperSpend / 1000).toFixed(0)}k at $1k resolution. Adoption-grade results land when this finishes.`,
        });
      } catch (err) {
        if (aborted()) return;
        // Roll back the guard so a manual retry isn't blocked.
        autoRefinedFingerprintsRef.current.delete(policyMiningFingerprint);
        setAutoRefine({
          status: 'complete',
          message: `Auto-refinement failed: ${err instanceof Error ? err.message : String(err)}. The pass-1 corpus is still available.`,
        });
      }
    })();
  }, [
    currentSessionId,
    startSession,
    policyMiningFingerprint,
    data,
    assumptions,
    dispatcherUrl,
    legacyTargetTodayDollars,
  ]);

  const annualTotalSpend = useMemo(() => {
    if (!data?.spending) return 0;
    return (
      data.spending.essentialMonthly * 12 +
      data.spending.optionalMonthly * 12 +
      data.spending.travelEarlyRetirementAnnual +
      data.spending.annualTaxesInsurance
    );
  }, [data]);

  // Baseline path drives the "vs current" delta columns in the results
  // table. Routed through the shared cache so navigating from Cockpit to
  // here doesn't re-run the 5000-trial Monte Carlo (Cockpit already
  // computed the same path; we hit the localStorage entry it wrote).
  const primaryPath = useMemo(() => {
    if (!data || !assumptions) return null;
    return getCachedBaselinePath(
      data,
      assumptions,
      selectedStressors ?? [],
      selectedResponses ?? [],
    );
  }, [data, assumptions, selectedStressors, selectedResponses]);

  if (!data || !assumptions) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white/70 p-6 text-stone-500">
        <p>Load a plan first — mining needs a baseline to work against.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">
          Re-run the model
        </h1>
        <p className="mt-1 text-[12px] text-stone-500 max-w-2xl">
          Policy mining searches thousands of spend × Social-Security ×
          Roth-conversion combinations against your current plan to find
          the strategies that most reliably hit your legacy target. Run
          a Quick mine for fast exploration, a Full mine for
          certification before you commit to a policy.
        </p>
      </div>

      {autoRefine && (
        <div
          className={`rounded-2xl border p-3 text-[12px] shadow-sm ${
            autoRefine.status === 'complete'
              ? 'border-stone-200 bg-stone-50/80 text-stone-700'
              : 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
          }`}
        >
          <div className="flex items-center gap-2">
            {autoRefine.status !== 'complete' && (
              <span
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500"
                aria-hidden
              />
            )}
            <span className="font-semibold uppercase tracking-[0.16em] text-[10px]">
              {autoRefine.status === 'analyzing' && 'Analyzing'}
              {autoRefine.status === 'starting' && 'Pass 2 starting'}
              {autoRefine.status === 'running' && 'Refining cliff'}
              {autoRefine.status === 'complete' && 'Refinement done'}
            </span>
            <span className="flex-1">{autoRefine.message}</span>
            {autoRefine.status === 'complete' && (
              <button
                type="button"
                className="rounded-md border border-stone-300 bg-white px-2 py-0.5 text-[11px] text-stone-700 hover:bg-stone-100"
                onClick={() => setAutoRefine(null)}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      <PolicyMiningStatusCard
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
        controls={
          policyMiningFingerprint
            ? {
                baseline: data,
                assumptions: getPolicyMiningAssumptions(assumptions),
                evaluatedByNodeId: 'local-browser',
                legacyTargetTodayDollars,
              }
            : undefined
        }
        axesOverride={axesOverride}
        autoRefinePhase={autoRefine?.status ?? null}
      />

      <PolicyMiningResultsTable
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
        dispatcherUrl={dispatcherUrl}
        currentPlan={
          policyMiningFingerprint
            ? {
                annualSpendTodayDollars: annualTotalSpend,
                primarySocialSecurityClaimAge:
                  data.income.socialSecurity[0]?.claimAge ?? null,
                spouseSocialSecurityClaimAge:
                  data.income.socialSecurity[1]?.claimAge ?? null,
                rothConversionAnnualCeiling: null,
                p50EndingWealthTodayDollars:
                  primaryPath?.medianEndingWealth ?? null,
              }
            : undefined
        }
        sensitivityControls={
          policyMiningFingerprint
            ? {
                baseline: data,
                assumptions: getPolicyMiningAssumptions(assumptions),
                legacyTargetTodayDollars,
              }
            : undefined
        }
      />

      {/* Adaptive axis-pruning insight. Surfaces only when the corpus
          for the current baseline has ≥ 50 evaluations AND at least
          one axis value contributed zero feasible candidates. Pure
          analyzer; no engine calls. */}
      <AxisPruningCard
        seedData={data}
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
        axesOverride={axesOverride}
        onApplyAxesOverride={setAxesOverride}
      />

      {/* Cliff-refinement card. Auto-refinement now drives pass-2
       *  automatically (see the banner above the status card), so this
       *  card is informational — it surfaces the per-tier feasibility
       *  readout and the cliff bracket so the household can see WHY
       *  the auto-refine is firing. The Apply button is intentionally
       *  hidden (no `onApplyAxesOverride` prop): the household doesn't
       *  need to click anything to get $1k resolution near adoption. */}
      <CliffRefinementCard
        seedData={data}
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
      />
    </div>
  );
}
