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
import { useMemo, useState } from 'react';
import { useAppStore } from './store';
import { useClusterSession } from './useClusterSession';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { getCachedBaselinePath } from './baseline-path-cache';
import { PolicyMiningStatusCard } from './PolicyMiningStatusCard';
import { PolicyMiningResultsTable } from './PolicyMiningResultsTable';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import type { MarketAssumptions } from './types';
import type { PolicyAxes } from './policy-miner-types';
import { AxisPruningCard } from './AxisPruningCard';
import { CliffRefinementCard } from './CliffRefinementCard';
import { RuleSweepCard } from './RuleSweepCard';

// Lowered 2000 → 1000 → 500 after the ranking-stability validator
// (see policy-miner.ranking-stability.test.ts) showed top-20 perfectly
// preserved and Spearman 0.9992 across a 90-policy grid at 500 vs 2000
// trials. Quarters fine-pass cost on the cluster (~56% total mine
// speedup vs original 2000). Bumping invalidates the corpus.
const POLICY_MINING_TRIAL_COUNT = 500;

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

  const legacyTargetTodayDollars = data?.goals?.legacyTargetTodayDollars ?? 0;

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

      {/* Cliff-refinement card. Watches the corpus, detects the spend
       *  tier where feasibility crosses 85%, and offers a one-click
       *  pass-2 axis at $1k resolution across the cliff band. Dynamic:
       *  recomputes whenever the corpus changes, so a fresh mine on
       *  a different plan picks up the new cliff automatically. */}
      <CliffRefinementCard
        seedData={data}
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
        dispatcherUrl={dispatcherUrl}
        axesOverride={axesOverride}
        onApplyAxesOverride={setAxesOverride}
      />

      {/* Rule-sweep card. Pairs with V2.1's single-rule pass-1: when the
       *  pass-1 corpus has contenders, this card offers a one-click
       *  pass-2 that re-mines them under the three non-default
       *  withdrawal rules (proportional, reverse waterfall,
       *  Guyton-Klinger). Same axesOverride plumbing as cliff
       *  refinement; the two pass-2 modes can run in either order. */}
      <RuleSweepCard
        seedData={data}
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
        dispatcherUrl={dispatcherUrl}
        axesOverride={axesOverride}
        onApplyAxesOverride={setAxesOverride}
      />
    </div>
  );
}
