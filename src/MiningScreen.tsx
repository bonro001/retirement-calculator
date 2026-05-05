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
import { useMemo } from 'react';
import { useAppStore } from './store';
import { useClusterSession } from './useClusterSession';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { getCachedBaselinePath } from './baseline-path-cache';
import { PolicyMiningStatusCard } from './PolicyMiningStatusCard';
import { PolicyMiningResultsTable } from './PolicyMiningResultsTable';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import type { MarketAssumptions } from './types';
import { AxisPruningCard } from './AxisPruningCard';
import { CliffRefinementCard } from './CliffRefinementCard';
import { RuleSweepCard } from './RuleSweepCard';

// Lowered from 2000 → 1000 after the ranking-stability validator
// (see policy-miner.ranking-stability.test.ts) showed top-20 perfectly
// preserved and Spearman 0.9997 across a 90-policy grid. Halves
// fine-pass cost on the cluster (~37% total mine speedup).
//
// Tried 500 briefly: extra ~25% speedup but the run *feels* janky —
// coarse stage (still at 200 trials) becomes the relative bottleneck,
// the coarse → fine transition is visible, and the fine tail starves
// more (RTT/work ratio rises with smaller per-batch work). 1000 is
// the sweet spot for steady throughput. To go faster from here, attack
// the coarse stage (SESSION_COARSE_TRIALS or SESSION_COARSE_BUFFER).
//
// Bumping this constant invalidates the corpus.
const POLICY_MINING_TRIAL_COUNT = 1000;

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

  // Manual axesOverride is retired — the Full mine pipeline now composes
  // axis-pruning + cliff-refinement + rule-sweep into a single pass-2
  // automatically. The 3 cards (AxisPruning / Cliff / RuleSweep) remain
  // visible as informational previews of what pass-2 will do. Hard-null
  // here keeps PolicyMiningStatusCard's pipeline-enabling condition
  // (`!axesOverride`) always true for Full mines.
  const axesOverride = null;

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

      {/* Adaptive axis-pruning preview. Surfaces only when the corpus
          for the current baseline has ≥ 50 evaluations AND at least
          one axis value contributed zero feasible candidates. Pure
          analyzer; no engine calls. The narrowed grid is composed
          into the next Full mine's pass-2 automatically. */}
      <AxisPruningCard
        seedData={data}
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
      />

      {/* Cliff-refinement preview. Watches the corpus, detects the
       *  spend tier where feasibility crosses 85%, and previews the
       *  pass-2 axis at $1k resolution across the cliff band.
       *  Auto-applied by the next Full mine's pipeline. */}
      <CliffRefinementCard
        seedData={data}
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
        dispatcherUrl={dispatcherUrl}
      />

      {/* Rule-sweep preview. When pass-1 corpus has contenders,
       *  previews the pass-2 sweep across non-default withdrawal
       *  rules (proportional, reverse waterfall, Guyton-Klinger).
       *  Auto-applied by the next Full mine's pipeline. */}
      <RuleSweepCard
        seedData={data}
        baselineFingerprint={policyMiningFingerprint || null}
        engineVersion={POLICY_MINER_ENGINE_VERSION}
        dispatcherUrl={dispatcherUrl}
      />
    </div>
  );
}
