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
import { buildPathResults } from './utils';
import { PolicyMiningStatusCard } from './PolicyMiningStatusCard';
import { PolicyMiningResultsTable } from './PolicyMiningResultsTable';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import type { MarketAssumptions } from './types';

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

  // Run baseline path so we have a primary path's median ending
  // wealth to feed into the results table for delta columns.
  const primaryPath = useMemo(() => {
    if (!data || !assumptions) return null;
    try {
      const paths = buildPathResults(
        data,
        assumptions,
        selectedStressors ?? [],
        selectedResponses ?? [],
        { pathMode: 'selected_only' },
      );
      return paths[0] ?? null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[mining] baseline path failed:', err);
      return null;
    }
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
    </div>
  );
}
