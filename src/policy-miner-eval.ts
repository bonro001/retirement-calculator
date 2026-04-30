import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { approximateBequestAttainmentRate } from './plan-evaluation';
import { policyId } from './policy-axis-enumerator';
import type { Policy, PolicyEvaluation } from './policy-miner-types';

/**
 * Pure evaluation helpers for the policy miner.
 *
 * This module is the import surface that BOTH the browser worker
 * (`src/policy-miner.worker.ts`) and the Node host worker
 * (`cluster/host-worker.ts`) load. It deliberately avoids importing
 * anything that touches:
 *   - `indexedDB` (browser-only persistence in `policy-mining-corpus.ts`)
 *   - `Worker` constructors / module URLs (browser-only in `policy-miner-pool.ts`)
 *
 * The dependency graph from here is engine-only: `utils.ts` →
 * `monte-carlo-engine.ts` + tax tables + path builders. Nothing in that
 * subtree references `window`, `document`, `IndexedDB`, or `Worker`, so
 * `tsx cluster/host-worker.ts` can load this file under Node without
 * polyfills.
 *
 * The full mining session orchestrator (`runMiningSession*`) and the
 * IndexedDB corpus writes still live in `policy-miner.ts` — those run
 * only in the browser, where the corpus is stored.
 */

/** A function the host environment provides to clone SeedData safely. */
export type SeedDataCloner = (seed: SeedData) => SeedData;

/**
 * Apply a Policy to a SeedData baseline. Mutates the *clone*, not the
 * original — caller must clone first.
 *
 * Knobs not (yet) honored end-to-end:
 *   - rothConversionAnnualCeiling: stored in `seed.rules.rothConversionPolicy`
 *     but the engine's policy module reads `maxPretaxBalancePercent` /
 *     `magiBufferDollars` rather than a flat dollar ceiling. We convert
 *     by setting the floor to 0 and using `magiBufferDollars` as a proxy
 *     ceiling for V1 — full ceiling support is a small engine PR for V1.1.
 */
export function applyPolicyToSeed(seed: SeedData, policy: Policy): SeedData {
  // Adjust SS claim ages. SeedData.income.socialSecurity is an array
  // (primary first by convention).
  if (seed.income?.socialSecurity?.[0]) {
    seed.income.socialSecurity[0].claimAge =
      policy.primarySocialSecurityClaimAge;
  }
  if (
    seed.income?.socialSecurity?.[1] &&
    policy.spouseSocialSecurityClaimAge !== null
  ) {
    seed.income.socialSecurity[1].claimAge =
      policy.spouseSocialSecurityClaimAge;
  }
  // Roth conversion ceiling: see caveat above.
  if (!seed.rules) {
    // SeedData.rules is required by the type, but be defensive.
    return seed;
  }
  seed.rules.rothConversionPolicy = {
    ...(seed.rules.rothConversionPolicy ?? {}),
    enabled: policy.rothConversionAnnualCeiling > 0,
    minAnnualDollars: 0,
    // Use the ceiling as a magi-buffer proxy. V1.1 will swap this for
    // a real per-year cap.
    magiBufferDollars: policy.rothConversionAnnualCeiling,
  };
  return seed;
}

/**
 * Inflation-deflate a nominal future-dollar amount to today's dollars,
 * matching `spend-solver.ts:toTodayDollars` exactly.
 *
 * Inlined here rather than imported to keep the spend-solver module's
 * surface area minimal and to avoid an export from a hot-path file.
 */
function toTodayDollars(
  nominal: number,
  inflation: number,
  horizonYears: number,
): number {
  const factor = Math.pow(
    1 + Math.max(-0.99, inflation),
    Math.max(0, horizonYears),
  );
  if (factor <= 0) return nominal;
  return nominal / factor;
}

/**
 * Run the engine on a single policy. The host passes its own SeedData
 * cloner so this module stays free of lodash / structuredClone version
 * concerns (the worker context may not have structuredClone).
 */
export async function evaluatePolicy(
  policy: Policy,
  baseline: SeedData,
  assumptions: MarketAssumptions,
  baselineFingerprint: string,
  engineVersion: string,
  evaluatedByNodeId: string,
  cloner: SeedDataCloner,
  legacyTargetTodayDollars: number,
): Promise<PolicyEvaluation> {
  const startMs = Date.now();
  const seed = applyPolicyToSeed(cloner(baseline), policy);
  // Per-candidate assumptions clone with the policy's withdrawal rule
  // applied. Mining sweeps this axis so each candidate runs against
  // its own rule; the engine reads `assumptions.withdrawalRule` in
  // `getStrategyBehavior` and the rule drives the per-year cascade.
  const policyAssumptions: MarketAssumptions = policy.withdrawalRule
    ? { ...assumptions, withdrawalRule: policy.withdrawalRule }
    : assumptions;
  // Run all four standard paths (baseline + downside + upside + selected
  // stressors). For the miner we want the BASELINE path — `paths[0]` per
  // convention — so we run with no stressors and pull the first path.
  const paths = buildPathResults(seed, policyAssumptions, [], [], {
    annualSpendTarget: policy.annualSpendTodayDollars,
    pathMode: 'selected_only',
  });
  const baselinePath = paths[0];
  if (!baselinePath) {
    throw new Error('evaluatePolicy: engine returned no path results');
  }

  // Convert nominal cemetery percentiles to today's dollars. The horizon
  // is (last-sim-year - first-sim-year). Use yearlySeries length as a
  // proxy when an explicit horizon isn't on the path result.
  const horizonYears = baselinePath.yearlySeries?.length ?? 30;
  const inflation = assumptions.inflation ?? 0.025;
  const deflate = (nominal: number) =>
    toTodayDollars(nominal, inflation, horizonYears);
  const todayDollarsP10 = deflate(baselinePath.endingWealthPercentiles.p10);
  const todayDollarsP25 = deflate(baselinePath.endingWealthPercentiles.p25);
  const todayDollarsP50 = deflate(baselinePath.endingWealthPercentiles.p50);
  const todayDollarsP75 = deflate(baselinePath.endingWealthPercentiles.p75);
  const todayDollarsP90 = deflate(baselinePath.endingWealthPercentiles.p90);

  const bequestAttainmentRate =
    legacyTargetTodayDollars > 0
      ? approximateBequestAttainmentRate(legacyTargetTodayDollars, {
          p10: todayDollarsP10,
          p25: todayDollarsP25,
          p50: todayDollarsP50,
          p75: todayDollarsP75,
          p90: todayDollarsP90,
        })
      : 1;

  return {
    id: policyId(policy, baselineFingerprint, engineVersion),
    baselineFingerprint,
    engineVersion,
    evaluatedByNodeId,
    evaluatedAtIso: new Date().toISOString(),
    policy,
    outcome: {
      solventSuccessRate: baselinePath.successRate,
      bequestAttainmentRate,
      p10EndingWealthTodayDollars: todayDollarsP10,
      p25EndingWealthTodayDollars: todayDollarsP25,
      p50EndingWealthTodayDollars: todayDollarsP50,
      p75EndingWealthTodayDollars: todayDollarsP75,
      p90EndingWealthTodayDollars: todayDollarsP90,
      // V1 placeholders — these need engine-side aggregation that isn't
      // on PathResult yet. Phase A ships with success/cemetery only;
      // V1.1 adds the spend / tax aggregations.
      medianLifetimeSpendTodayDollars: 0,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars:
        baselinePath.annualFederalTaxEstimate ?? 0,
      irmaaExposureRate: baselinePath.irmaaExposureRate ?? 0,
    },
    evaluationDurationMs: Date.now() - startMs,
  };
}
