/**
 * Monthly Review screen — the household's "re-run the model" surface.
 *
 * Layout:
 *   1. Monthly Review panel (hero) — mine → certify → AI review → adopt
 *      with live progress narrated inside each StepCard. The Step 1 card
 *      now carries the active mine progress inline, so there's no need
 *      for a separate cluster monitor on this screen.
 *   2. Diagnostics (collapsed) — candidate table, axis pruning, cliff
 *      refinement, rule sweep. Power-user surface.
 *
 * Browser-as-host mode stays off (MonthlyReviewPanel enforces
 * controller-only before reconnecting) — all mining work goes to Node hosts.
 */
import { useMemo, useState } from 'react';
import { useAppStore } from './store';
import { useClusterSession } from './useClusterSession';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { getCachedBaselinePath } from './baseline-path-cache';
import { PolicyMiningResultsTable } from './PolicyMiningResultsTable';
import { MonthlyReviewPanel } from './MonthlyReviewPanel';
import { MONTHLY_REVIEW_HIDE_CANDIDATE_TABLE } from './monthly-review-flow-debug';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import { POLICY_MINING_TRIAL_COUNT } from './policy-mining-config';
import { DEFAULT_LEGACY_TARGET_TODAY_DOLLARS } from './legacy-target-cache';
import type { MarketAssumptions } from './types';
import type { PolicyAxes } from './policy-miner-types';
import { AxisPruningCard } from './AxisPruningCard';
import { CliffRefinementCard } from './CliffRefinementCard';
import { RuleSweepCard } from './RuleSweepCard';

function getPolicyMiningAssumptions(assumptions: MarketAssumptions): MarketAssumptions {
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
  const selectedStressors = useAppStore((state) => state.appliedSelectedStressors);
  const selectedResponses = useAppStore((state) => state.appliedSelectedResponses);
  const cluster = useClusterSession();
  const dispatcherUrl = cluster.snapshot.dispatcherUrl ?? null;
  const [axesOverride, setAxesOverride] = useState<PolicyAxes | null>(null);

  const baselineFingerprint = useMemo(() => {
    if (!data || !assumptions) return null;
    try {
      return buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors: selectedStressors ?? [],
        selectedResponses: selectedResponses ?? [],
      });
    } catch {
      return null;
    }
  }, [data, assumptions, selectedStressors, selectedResponses]);

  const annualTotalSpend = useMemo(() => {
    if (!data?.spending) return 0;
    return (
      data.spending.essentialMonthly * 12 +
      data.spending.optionalMonthly * 12 +
      data.spending.travelEarlyRetirementAnnual +
      data.spending.annualTaxesInsurance
    );
  }, [data]);

  const primaryPath = useMemo(() => {
    if (!data || !assumptions) return null;
    return getCachedBaselinePath(
      data,
      assumptions,
      selectedStressors ?? [],
      selectedResponses ?? [],
    );
  }, [data, assumptions, selectedStressors, selectedResponses]);

  const legacyTargetTodayDollars =
    data?.goals?.legacyTargetTodayDollars ?? DEFAULT_LEGACY_TARGET_TODAY_DOLLARS;

  const policyMiningFingerprint = baselineFingerprint
    ? `${baselineFingerprint}|trials=${POLICY_MINING_TRIAL_COUNT}|basis=current_faithful|fpv2`
    : '';

  if (!data || !assumptions) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white/70 p-6 text-stone-500">
        <p>Load a plan first — monthly review needs a baseline to work against.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Monthly review</h1>
        <p className="mt-1 max-w-xl text-[12px] text-stone-500">
          One button. One answer. Run each month to get the amount you can spend right now.
        </p>
      </div>

      {/* Hero: the monthly review panel — its Step 1 card carries live mine
         progress inline, so no separate cluster monitor is needed on this
         screen. Diagnostics below holds the deep dive when you want it. */}
      <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-5 shadow-sm">
        <MonthlyReviewPanel
          baseline={data}
          assumptions={assumptions}
          baselineFingerprint={baselineFingerprint}
          engineVersion={POLICY_MINER_ENGINE_VERSION}
          dispatcherUrl={dispatcherUrl}
          legacyTargetTodayDollars={legacyTargetTodayDollars}
          selectedStrategyId="current_faithful"
        />
      </div>

      {/* Diagnostics — collapsed by default, lives below the household-facing
         hero so it never competes with the answer. Contains the full mined
         candidate table plus the analyzer/refinement/sweep cards. */}
      {!MONTHLY_REVIEW_HIDE_CANDIDATE_TABLE && (
        <details className="rounded-2xl border border-stone-200 bg-white/80 shadow-sm">
          <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-stone-700 hover:bg-stone-50/80 rounded-2xl">
            Diagnostics
            <span className="ml-2 text-[11px] font-normal text-stone-400">
              Candidate table · axis pruning · cliff refinement · rule sweep
            </span>
          </summary>
          <div className="space-y-4 px-5 pb-5 pt-2">
            <PolicyMiningResultsTable
              baselineFingerprint={policyMiningFingerprint || null}
              engineVersion={POLICY_MINER_ENGINE_VERSION}
              dispatcherUrl={dispatcherUrl}
              legacyTargetTodayDollars={legacyTargetTodayDollars}
              currentPlan={
                policyMiningFingerprint
                  ? {
                      annualSpendTodayDollars: annualTotalSpend,
                      primarySocialSecurityClaimAge:
                        data.income.socialSecurity[0]?.claimAge ?? null,
                      spouseSocialSecurityClaimAge:
                        data.income.socialSecurity[1]?.claimAge ?? null,
                      rothConversionAnnualCeiling: null,
                      p50EndingWealthTodayDollars: primaryPath?.medianEndingWealth ?? null,
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
              certificationControls={
                policyMiningFingerprint
                  ? {
                      baseline: data,
                      assumptions,
                      legacyTargetTodayDollars,
                      spendingScheduleBasis: undefined,
                    }
                  : undefined
              }
            />

            <AxisPruningCard
              seedData={data}
              baselineFingerprint={policyMiningFingerprint || null}
              engineVersion={POLICY_MINER_ENGINE_VERSION}
              axesOverride={axesOverride}
              onApplyAxesOverride={setAxesOverride}
            />

            <CliffRefinementCard
              seedData={data}
              baselineFingerprint={policyMiningFingerprint || null}
              engineVersion={POLICY_MINER_ENGINE_VERSION}
              dispatcherUrl={dispatcherUrl}
              axesOverride={axesOverride}
              onApplyAxesOverride={setAxesOverride}
            />

            <RuleSweepCard
              seedData={data}
              baselineFingerprint={policyMiningFingerprint || null}
              engineVersion={POLICY_MINER_ENGINE_VERSION}
              dispatcherUrl={dispatcherUrl}
              axesOverride={axesOverride}
              onApplyAxesOverride={setAxesOverride}
            />
          </div>
        </details>
      )}
    </div>
  );
}
