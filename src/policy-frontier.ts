import type { PolicyEvaluation } from './policy-miner-types';

/**
 * E.4 — Pareto frontier in the (spend ↑, bequest ↑) plane.
 *
 * The household is choosing between two goods that conflict: spend
 * more today vs leave more behind. The Pareto frontier is the set of
 * policies for which you can't have more of one without giving up
 * the other. Everything off the frontier is dominated — there's a
 * strictly-better policy at the same or higher spend AND same or
 * higher bequest.
 *
 * Why this is useful in the UI: the frontier is the entire decision
 * space worth considering. The 100s-or-1000s of dominated points are
 * noise — picking among them means actively choosing to leave money
 * on the table somewhere. A scatter that highlights the frontier line
 * makes that visible at a glance.
 *
 * Both axes are MAXIMIZED — more spend is good (household quality of
 * life), more bequest is good (household values). The frontier slopes
 * downward when plotted with spend on X and bequest on Y, because the
 * portfolio is finite.
 */

export interface FrontierPoint {
  /** Underlying corpus record. */
  evaluation: PolicyEvaluation;
  /** X coordinate for plotting (annual spend in today's $). */
  spend: number;
  /** Y coordinate for plotting (median bequest in today's $). */
  bequest: number;
  /** Feasibility = bequestAttainmentRate ∈ [0, 1]. */
  feasibility: number;
}

/**
 * Project a corpus into plottable points, optionally pre-filtering by
 * feasibility. Filter by feasibility BEFORE running Pareto math; an
 * "infeasible Pareto frontier" misleads — it shows the best dominated
 * policies, not the best decisions.
 */
export function projectEvaluations(
  evaluations: PolicyEvaluation[],
  minFeasibility = 0,
): FrontierPoint[] {
  const out: FrontierPoint[] = [];
  for (const e of evaluations) {
    const feasibility = e.outcome.bequestAttainmentRate;
    if (feasibility < minFeasibility) continue;
    out.push({
      evaluation: e,
      spend: e.policy.annualSpendTodayDollars,
      bequest: e.outcome.p50EndingWealthTodayDollars,
      feasibility,
    });
  }
  return out;
}

/**
 * Compute the Pareto front in O(n log n).
 *
 * Algorithm: sort by spend descending (with bequest descending as
 * tiebreak so duplicates don't all enter the frontier), walk through
 * tracking maxBequestSoFar. A point is on the frontier iff its bequest
 * strictly exceeds everything seen at higher spends. Reverse at the
 * end so callers get the frontier sorted by ascending spend (natural
 * left-to-right plot order).
 */
export function computeParetoFront(points: FrontierPoint[]): FrontierPoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => {
    if (b.spend !== a.spend) return b.spend - a.spend;
    return b.bequest - a.bequest;
  });
  const front: FrontierPoint[] = [];
  let maxBequestSoFar = -Infinity;
  for (const p of sorted) {
    if (p.bequest > maxBequestSoFar) {
      front.push(p);
      maxBequestSoFar = p.bequest;
    }
  }
  // Plot order: ascending spend.
  front.reverse();
  return front;
}

/**
 * Test whether a point is dominated by ANY point in `others`. A point
 * is dominated iff some other has spend ≥ AND bequest ≥ with at least
 * one strictly greater. Useful for hover labels ("this policy is on
 * the frontier" vs "this policy is dominated").
 *
 * O(n) per call — for a tooltip that's fine. Don't use this in a hot
 * loop over the whole corpus; use computeParetoFront and a Set for
 * batch membership tests instead.
 */
export function isDominated(
  point: FrontierPoint,
  others: FrontierPoint[],
): boolean {
  for (const o of others) {
    if (o === point) continue;
    if (
      o.spend >= point.spend &&
      o.bequest >= point.bequest &&
      (o.spend > point.spend || o.bequest > point.bequest)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Bucket the corpus into spend bins so a chart with 8000+ points
 * doesn't waste pixels overplotting. Returns one representative point
 * per (spend, feasibility-band) cell — the one closest to the cell's
 * average bequest, so the visualization remains faithful to the
 * density distribution.
 *
 * Off by default; opt in when the corpus is dense enough that overplot
 * is hiding the frontier.
 */
export function thinForOverplot(
  points: FrontierPoint[],
  spendBinSize = 5_000,
  feasibilityBins = 5,
): FrontierPoint[] {
  if (points.length === 0) return [];
  const buckets = new Map<string, FrontierPoint[]>();
  for (const p of points) {
    const spendBin = Math.round(p.spend / spendBinSize) * spendBinSize;
    const feasibilityBin = Math.min(
      feasibilityBins - 1,
      Math.floor(p.feasibility * feasibilityBins),
    );
    const key = `${spendBin}|${feasibilityBin}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(p);
  }
  const out: FrontierPoint[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      out.push(bucket[0]);
      continue;
    }
    const meanBequest =
      bucket.reduce((s, p) => s + p.bequest, 0) / bucket.length;
    let representative = bucket[0];
    let bestDist = Math.abs(representative.bequest - meanBequest);
    for (let i = 1; i < bucket.length; i += 1) {
      const dist = Math.abs(bucket[i].bequest - meanBequest);
      if (dist < bestDist) {
        bestDist = dist;
        representative = bucket[i];
      }
    }
    out.push(representative);
  }
  return out;
}
