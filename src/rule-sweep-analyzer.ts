/**
 * Rule-sweep analyzer — pairs with pass-1's single-rule mining
 * (`tax_bracket_waterfall` only) to recommend a tightly-scoped pass-2
 * that re-mines only the top contenders under the OTHER three
 * withdrawal rules.
 *
 * Why two-phase rather than the V2 four-rule cartesian sweep: most
 * (spend, SS, Roth) combos have one rule that obviously wins. Mining
 * all four just to confirm three losers is wasteful — the household
 * only cares about rule comparison on policies that contend for the
 * recommendation. Two-phase gets the same data on the contenders at
 * a quarter of the wall-time cost.
 *
 * Approach: take pass-1's top survivors by legacy-first-lexicographic
 * order, compute the cartesian bounding box around their (spend, SS,
 * Roth) combos, and emit a pass-2 axes spec covering that box across
 * the three non-default rules. Any candidate that contended for the
 * recommendation under waterfall is re-evaluated under the others.
 *
 * Risk: a candidate that flunks under waterfall but would have shined
 * under e.g. proportional could miss the top-N cutoff and never get
 * mined under its winning rule. Mitigation: use a generous N (default
 * 200, bounded by a feasibility-attainment-rate threshold) so the
 * cutoff captures everything within striking distance of the leaders.
 *
 * Pairs with `cliff-refinement-analyzer.ts`: the two pass-2 modes
 * compose. The recommended workflow is pass-1 → cliff refinement →
 * rule sweep, but they can run in either order; both narrow the axes
 * via `axesOverride` and both leave pass-1 records untouched in the
 * corpus.
 */

import {
  ALL_WITHDRAWAL_RULES,
  buildDefaultPolicyAxes,
} from './policy-axis-enumerator';
import type {
  Policy,
  PolicyAxes,
  PolicyEvaluation,
} from './policy-miner-types';
import type { SeedData } from './types';

export interface RuleSweepRecommendation {
  /** True if a pass-2 rule sweep would meaningfully expand the
   *  rule-comparison data on the contenders. */
  hasRecommendation: boolean;
  /** Pass-2 axes — same as default EXCEPT (spend, SS, Roth) are pruned
   *  to the contenders' bounding box and `withdrawalRule` is the three
   *  non-default rules. */
  axes: PolicyAxes;
  /** How many pass-1 records made the contender cut. */
  contenderCount: number;
  /** Estimated pass-2 candidate count = bounding-box-size × 3 rules. */
  estimatedPass2Candidates: number;
  /** Threshold the analyzer used to pick contenders (legacy attainment). */
  legacyAttainmentFloor: number;
  /** Plain-English reason: "31 of 12,342 pass-1 records cleared 80%
   *  legacy — pass-2 will compare them under proportional, reverse
   *  waterfall, and Guyton-Klinger." */
  rationale: string;
}

/**
 * Pick the contenders from a pass-1 corpus. A contender is anything
 * within `attainmentMargin` of the top legacy-attainment-rate observed.
 * Caller can additionally cap the count via `maxContenders`.
 *
 * Why margin-based and not a hard top-N: top-N is too brittle — when
 * the cliff is sharp, top-100 might include obviously-infeasible
 * candidates; when the cliff is shallow, top-100 might miss real
 * contenders just past the cutoff. Using "everything within X of the
 * leader" adapts to the corpus's shape automatically.
 */
function pickContenders(
  evaluations: readonly PolicyEvaluation[],
  attainmentMargin: number,
  maxContenders: number,
): { contenders: PolicyEvaluation[]; floor: number } {
  if (evaluations.length === 0) return { contenders: [], floor: 0 };
  let topAttainment = 0;
  for (const e of evaluations) {
    if (e.outcome.bequestAttainmentRate > topAttainment) {
      topAttainment = e.outcome.bequestAttainmentRate;
    }
  }
  const floor = Math.max(0, topAttainment - attainmentMargin);
  const eligible = evaluations.filter(
    (e) => e.outcome.bequestAttainmentRate >= floor,
  );
  // Rank descending by attainment then spend (legacy-first lexicographic
  // proxy). Take the top maxContenders.
  eligible.sort((a, b) => {
    if (b.outcome.bequestAttainmentRate !== a.outcome.bequestAttainmentRate) {
      return b.outcome.bequestAttainmentRate - a.outcome.bequestAttainmentRate;
    }
    return (
      b.policy.annualSpendTodayDollars - a.policy.annualSpendTodayDollars
    );
  });
  return { contenders: eligible.slice(0, maxContenders), floor };
}

/**
 * Distinct sorted values of `getter(policy)` across the contender set.
 * Returns null when every contender's value is null (used for the
 * spouse-SS axis: single-earner households).
 */
function distinctSorted<T>(
  contenders: readonly PolicyEvaluation[],
  getter: (p: Policy) => T,
): T[] {
  const set = new Set<T>();
  for (const c of contenders) set.add(getter(c.policy));
  return Array.from(set).sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  });
}

export interface RuleSweepOptions {
  /** Contender-cut margin below the corpus's top legacy-attainment-rate.
   *  Default 0.10 (10pp) — captures everything within striking distance
   *  of the leaders. */
  attainmentMargin?: number;
  /** Hard cap on contenders even when the margin allows more. Default
   *  200 — keeps pass-2 bounded for sharp-cliff households whose top
   *  attainment plateau spans hundreds of records. */
  maxContenders?: number;
}

export function recommendRuleSweep(
  evaluations: readonly PolicyEvaluation[],
  seedData: SeedData,
  options: RuleSweepOptions = {},
): RuleSweepRecommendation {
  const baseAxes = buildDefaultPolicyAxes(seedData);
  const margin = options.attainmentMargin ?? 0.10;
  const maxN = options.maxContenders ?? 200;

  const { contenders, floor } = pickContenders(evaluations, margin, maxN);

  if (contenders.length === 0) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      contenderCount: 0,
      estimatedPass2Candidates: 0,
      legacyAttainmentFloor: floor,
      rationale: 'Pass-1 corpus is empty — nothing to sweep.',
    };
  }

  // Skip the recommendation when the corpus already covers the rule
  // sweep — i.e., the auto-pipeline (or a prior manual pass-2) has
  // already re-mined contenders under the non-default rules. Without
  // this check the card keeps surfacing "PASS 2 RECOMMENDED" even
  // after the work has been done, which confuses the household.
  //
  // Heuristic: examine the contender set's withdrawal-rule coverage.
  // If contenders include records under all four named rules, the
  // sweep has already happened.
  const contenderRules = new Set<string>();
  for (const c of contenders) {
    if (c.policy.withdrawalRule) contenderRules.add(c.policy.withdrawalRule);
  }
  if (
    ALL_WITHDRAWAL_RULES.every((rule) => contenderRules.has(rule))
  ) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      contenderCount: contenders.length,
      estimatedPass2Candidates: 0,
      legacyAttainmentFloor: floor,
      rationale:
        'Rule sweep already covered — corpus has contender records under all four withdrawal rules.',
    };
  }

  // Bounding box across the contenders' (spend, SS, Roth) values. The
  // cartesian box may include combos that weren't in the contender set,
  // but the over-mining is small relative to a full grid sweep — and
  // those box-fillers might themselves contend under a non-default
  // rule, so it's not pure waste.
  const spends = distinctSorted(contenders, (p) => p.annualSpendTodayDollars);
  const primarySS = distinctSorted(
    contenders,
    (p) => p.primarySocialSecurityClaimAge,
  );
  const spouseSSValues = distinctSorted(
    contenders,
    (p) => p.spouseSocialSecurityClaimAge,
  );
  const spouseSS =
    spouseSSValues.length === 1 && spouseSSValues[0] === null
      ? null
      : (spouseSSValues.filter((v) => v !== null) as number[]);
  const roth = distinctSorted(
    contenders,
    (p) => p.rothConversionAnnualCeiling,
  );

  const otherRules = ALL_WITHDRAWAL_RULES.filter(
    (r) => r !== 'tax_bracket_waterfall',
  );

  const sweepAxes: PolicyAxes = {
    annualSpendTodayDollars: spends,
    primarySocialSecurityClaimAge: primarySS,
    spouseSocialSecurityClaimAge: spouseSS,
    rothConversionAnnualCeiling: roth,
    withdrawalRule: [...otherRules],
  };

  const estimated =
    spends.length *
    primarySS.length *
    (spouseSS?.length ?? 1) *
    roth.length *
    otherRules.length;

  // No-op recommendation if pass-2 would mine zero candidates (e.g.,
  // every contender shares identical axes — degenerate). Bail rather
  // than ship an empty session.
  if (estimated === 0) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      contenderCount: contenders.length,
      estimatedPass2Candidates: 0,
      legacyAttainmentFloor: floor,
      rationale:
        'Pass-1 contenders share degenerate axes — no rule sweep work to do.',
    };
  }

  const contenderPct = Math.round(floor * 100);
  const ruleNames = otherRules
    .map((r) => r.replace(/_/g, ' '))
    .join(', ');

  return {
    hasRecommendation: true,
    axes: sweepAxes,
    contenderCount: contenders.length,
    estimatedPass2Candidates: estimated,
    legacyAttainmentFloor: floor,
    rationale: `${contenders.length} pass-1 record${contenders.length === 1 ? '' : 's'} cleared ${contenderPct}% legacy attainment. Pass-2 will re-mine the (spend, SS, Roth) bounding box of those contenders under ${ruleNames} — ~${estimated.toLocaleString()} candidates.`,
  };
}
