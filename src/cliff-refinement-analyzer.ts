/**
 * Cliff refinement analyzer — looks at a completed pass-1 corpus and
 * recommends a refined pass-2 axis spec that drills into the spend
 * tier where feasibility crosses the household's threshold.
 *
 * Background: today's pass-1 mine sweeps spend at $5k uniform resolution.
 * For a household with a tight feasibility floor (e.g., 85% legacy
 * attainment), the cliff between "feasible" and "infeasible" usually
 * sits between two adjacent $5k tiers — say $115k (88% legacy) and
 * $120k (81% legacy). The household's true max-spend at the 85% floor
 * is somewhere in [$115k, $120k] but pass-1's grid can't tell us where.
 *
 * Pass-2's job: re-mine $1k steps in that band. With the same 4×6×11×11
 * grid on the other axes, that's ~24,000 additional candidates per $5k
 * sub-band — a few minutes on the cluster, much sharper recommendation.
 *
 * Why dynamic rather than hard-coded: every household's cliff lands in
 * a different spend tier, and the cliff moves as the plan evolves
 * (boulders change, seed updates, etc.). Hard-coding $113k-$119k
 * worked for one snapshot of one household; a dynamic recommendation
 * keeps working as the plan moves.
 */

import type { PolicyEvaluation, PolicyAxes } from './policy-miner-types';
import type { SeedData } from './types';
import { buildDefaultPolicyAxes } from './policy-axis-enumerator';

export type FeasibilityMetric = 'legacy' | 'solvency';

function metricValue(e: PolicyEvaluation, metric: FeasibilityMetric): number {
  return metric === 'solvency'
    ? e.outcome.solventSuccessRate
    : e.outcome.bequestAttainmentRate;
}

function metricLabel(metric: FeasibilityMetric): string {
  return metric === 'solvency' ? 'solvency' : 'legacy';
}

export interface CliffRefinementRecommendation {
  /** True if a refined pass-2 axis would meaningfully improve precision. */
  hasRecommendation: boolean;
  /** The recommended axes for pass-2 mining. Same as the default coarse
   *  axes EXCEPT the spend list is replaced with $1k steps in the
   *  cliff band. Other axes stay full-resolution to preserve search
   *  power. */
  axes: PolicyAxes;
  /** Where the cliff sits, for the UI's explanation copy. */
  cliffLowerSpend: number;
  cliffUpperSpend: number;
  /** What threshold the analyzer used to identify the cliff. */
  feasibilityThreshold: number;
  /** Diagnostic counts so the UI can say "12 of 432 records at $115k
   *  cleared 85%" — the household sees WHY pass-2 is recommended. */
  spendTierFeasibility: Array<{
    spend: number;
    totalRecords: number;
    feasibleRecords: number;
    maxFeasibility: number;
  }>;
  /** Plain-English reason: "Cliff between $115k (52% feasible) and
   *  $120k (0%) — refining at $1k resolution will pin the precise
   *  max-spend at the threshold." */
  rationale: string;
}

/**
 * Identify the spend tier where the corpus's max feasibility crosses
 * `threshold`. Returns the (lowerSpend, upperSpend) bracket — the
 * highest spend with maxFeasibility ≥ threshold, and the lowest spend
 * with maxFeasibility < threshold.
 *
 * Returns null when the cliff is either above or below the entire
 * mined range (no refinement possible — the household either spends
 * less than the floor or has slack everywhere).
 */
function findCliffBracket(
  perTier: Array<{ spend: number; maxFeasibility: number }>,
  threshold: number,
): { lowerSpend: number; upperSpend: number } | null {
  // Walk the sorted-ascending tier list once. The cliff is the FIRST
  // adjacent pair where lower clears the threshold and upper falls
  // below. There may be local non-monotonicity in maxFeasibility (MC
  // noise across a 2000-trial run is ~±0.5pp), so we look for the
  // CROSSOVER, not just any drop.
  for (let i = 0; i < perTier.length - 1; i += 1) {
    const lower = perTier[i];
    const upper = perTier[i + 1];
    if (
      lower.maxFeasibility >= threshold &&
      upper.maxFeasibility < threshold
    ) {
      return { lowerSpend: lower.spend, upperSpend: upper.spend };
    }
  }
  return null;
}

/**
 * Build the per-tier feasibility summary from a corpus. Sorted ascending
 * by spend.
 */
function summarizePerSpendTier(
  evaluations: PolicyEvaluation[],
  metric: FeasibilityMetric,
  threshold: number,
): Array<{
  spend: number;
  totalRecords: number;
  feasibleRecords: number;
  maxFeasibility: number;
}> {
  const byTier = new Map<
    number,
    { total: number; feasible: number; maxF: number }
  >();
  for (const e of evaluations) {
    const spend = e.policy.annualSpendTodayDollars;
    const f = metricValue(e, metric);
    const t = byTier.get(spend) ?? { total: 0, feasible: 0, maxF: 0 };
    t.total += 1;
    if (f >= threshold) t.feasible += 1;
    if (f > t.maxF) t.maxF = f;
    byTier.set(spend, t);
  }
  return Array.from(byTier.entries())
    .map(([spend, t]) => ({
      spend,
      totalRecords: t.total,
      feasibleRecords: t.feasible,
      maxFeasibility: t.maxF,
    }))
    .sort((a, b) => a.spend - b.spend);
}

/**
 * Compute the recommended pass-2 axis. Returns `hasRecommendation: false`
 * when no cliff is detected (corpus is uniformly feasible or uniformly
 * infeasible) — in that case the household either has more slack than
 * pass-1 saw, or needs a different lever entirely.
 *
 * `feasibilityThreshold` defaults to 0.85 — the canonical legacy gate.
 * Callers can pass the user's slider value if they want pass-2 tuned to
 * a different threshold.
 */
export function recommendCliffRefinement(
  evaluations: PolicyEvaluation[],
  seedData: SeedData,
  feasibilityThreshold = 0.85,
  metric: FeasibilityMetric = 'legacy',
): CliffRefinementRecommendation {
  const baseAxes = buildDefaultPolicyAxes(seedData);
  const perTier = summarizePerSpendTier(
    evaluations,
    metric,
    feasibilityThreshold,
  );
  const label = metricLabel(metric);

  if (perTier.length < 2) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      cliffLowerSpend: 0,
      cliffUpperSpend: 0,
      feasibilityThreshold,
      spendTierFeasibility: perTier,
      rationale: `Pass-1 corpus has fewer than 2 spend tiers — no ${label} cliff to refine.`,
    };
  }

  const cliff = findCliffBracket(perTier, feasibilityThreshold);

  if (!cliff) {
    const allFeasible = perTier.every(
      (t) => t.maxFeasibility >= feasibilityThreshold,
    );
    return {
      hasRecommendation: false,
      axes: baseAxes,
      cliffLowerSpend: 0,
      cliffUpperSpend: 0,
      feasibilityThreshold,
      spendTierFeasibility: perTier,
      rationale: allFeasible
        ? `Every mined spend tier clears the ${Math.round(feasibilityThreshold * 100)}% ${label} floor — your plan has slack across the entire $${perTier[0].spend.toLocaleString()}–$${perTier.at(-1)!.spend.toLocaleString()} range. Widen the spend axis upward to find the real cliff.`
        : `No mined spend tier clears the ${Math.round(feasibilityThreshold * 100)}% ${label} floor — your plan can't support that risk target at any spend in the mined range. Adjusting boulders (retirement date, allocation) is the next step, not finer mining.`,
    };
  }

  // Build $1k-resolution spend axis covering the cliff bracket. Include
  // the bracket endpoints so the household can see "exactly where" the
  // crossover is. Skip if the bracket is already <= $1k wide (caller
  // already mined as fine as we can recommend).
  const stepDollars = 1_000;
  if (cliff.upperSpend - cliff.lowerSpend <= stepDollars) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      cliffLowerSpend: cliff.lowerSpend,
      cliffUpperSpend: cliff.upperSpend,
      feasibilityThreshold,
      spendTierFeasibility: perTier,
      rationale: `Cliff already pinned to $${cliff.lowerSpend.toLocaleString()}-$${cliff.upperSpend.toLocaleString()} at $1k resolution — no further refinement adds precision.`,
    };
  }

  // Skip the recommendation when refinement has already happened — i.e.,
  // the corpus already has spend records *between* the cliff endpoints
  // at finer-than-$5k resolution. Pass-1 mines $5k-spaced; pass-2 adds
  // $1k-spaced. Any spend record strictly inside the cliff bracket
  // whose value isn't a multiple of $5,000 means refinement landed.
  // Without this check the card keeps surfacing "PASS 2 RECOMMENDED"
  // after the auto-pipeline has run it.
  const refinementAlreadyDone = evaluations.some((e) => {
    const s = e.policy.annualSpendTodayDollars;
    return (
      s > cliff.lowerSpend &&
      s < cliff.upperSpend &&
      s % 5_000 !== 0
    );
  });
  if (refinementAlreadyDone) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      cliffLowerSpend: cliff.lowerSpend,
      cliffUpperSpend: cliff.upperSpend,
      feasibilityThreshold,
      spendTierFeasibility: perTier,
      rationale: `Cliff already refined — corpus has $1k-resolution spend records inside the $${cliff.lowerSpend.toLocaleString()}–$${cliff.upperSpend.toLocaleString()} band.`,
    };
  }

  const refinedSpend: number[] = [];
  for (
    let v = cliff.lowerSpend;
    v <= cliff.upperSpend;
    v += stepDollars
  ) {
    refinedSpend.push(v);
  }

  // Build pass-2 axes: same base except spend is the refined band only.
  // Other axes stay full-resolution so the ranker can still find the
  // best (SS, Roth, withdrawal) combo at each refined spend.
  const refinedAxes: PolicyAxes = {
    ...baseAxes,
    annualSpendTodayDollars: refinedSpend,
  };

  const lowerTier = perTier.find((t) => t.spend === cliff.lowerSpend);
  const upperTier = perTier.find((t) => t.spend === cliff.upperSpend);
  const lowerPct = lowerTier
    ? Math.round(lowerTier.maxFeasibility * 100)
    : 0;
  const upperPct = upperTier
    ? Math.round(upperTier.maxFeasibility * 100)
    : 0;

  return {
    hasRecommendation: true,
    axes: refinedAxes,
    cliffLowerSpend: cliff.lowerSpend,
    cliffUpperSpend: cliff.upperSpend,
    feasibilityThreshold,
    spendTierFeasibility: perTier,
    rationale: `${label[0].toUpperCase()}${label.slice(1)} crosses the ${Math.round(feasibilityThreshold * 100)}% floor between $${cliff.lowerSpend.toLocaleString()} (${lowerPct}%) and $${cliff.upperSpend.toLocaleString()} (${upperPct}%). A second mining pass at $1k resolution across this band will pin the precise max-spend at your floor — typically within 1-2 minutes on the cluster.`,
  };
}
