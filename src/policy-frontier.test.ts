import { describe, it, expect } from 'vitest';
import {
  computeParetoFront,
  isDominated,
  projectEvaluations,
  thinForOverplot,
  type FrontierPoint,
} from './policy-frontier';
import type { PolicyEvaluation } from './policy-miner-types';

/**
 * E.4 — Pareto math. The user-facing claim is "policies on the green
 * line are the ones worth picking from; everything else is strictly
 * worse on at least one dimension". If the front math is wrong, the
 * household either rules out a winning policy or considers a dominated
 * one — directly defeats the point of the visualization.
 */

function fp(spend: number, bequest: number, feasibility = 0.85): FrontierPoint {
  return {
    evaluation: {} as PolicyEvaluation,
    spend,
    bequest,
    feasibility,
  };
}

describe('computeParetoFront', () => {
  it('returns empty for empty input', () => {
    expect(computeParetoFront([])).toEqual([]);
  });

  it('keeps the only point when there is one', () => {
    const p = fp(100_000, 1_500_000);
    expect(computeParetoFront([p])).toEqual([p]);
  });

  it('drops a point dominated on both axes', () => {
    const winner = fp(120_000, 1_500_000);
    const dominated = fp(100_000, 1_000_000); // less spend AND less bequest
    const front = computeParetoFront([winner, dominated]);
    expect(front).toContain(winner);
    expect(front).not.toContain(dominated);
  });

  it('keeps both points on a true tradeoff', () => {
    const high_spend_low_bequest = fp(150_000, 1_000_000);
    const low_spend_high_bequest = fp(100_000, 2_000_000);
    const front = computeParetoFront([
      high_spend_low_bequest,
      low_spend_high_bequest,
    ]);
    expect(front.length).toBe(2);
    expect(front).toContain(high_spend_low_bequest);
    expect(front).toContain(low_spend_high_bequest);
  });

  it('returns the front sorted by ascending spend', () => {
    const points = [
      fp(180_000, 500_000),
      fp(140_000, 1_200_000),
      fp(100_000, 2_000_000),
      fp(60_000, 3_000_000),
    ];
    const front = computeParetoFront(points);
    for (let i = 1; i < front.length; i += 1) {
      expect(front[i].spend).toBeGreaterThan(front[i - 1].spend);
    }
  });

  it('handles ties in spend by keeping the highest-bequest one only', () => {
    const a = fp(100_000, 1_500_000);
    const b = fp(100_000, 1_200_000); // same spend, less bequest = dominated
    const front = computeParetoFront([a, b]);
    expect(front).toContain(a);
    expect(front).not.toContain(b);
  });

  it('produces a strictly-decreasing bequest curve as spend rises', () => {
    // Realistic frontier: as spend goes up, achievable bequest goes down.
    const points = [
      fp(80_000, 2_500_000),
      fp(100_000, 2_000_000),
      fp(120_000, 1_500_000),
      fp(140_000, 800_000),
      // Dominated point — same spend as the 100k point but worse bequest.
      fp(100_000, 1_900_000),
      // Dominated point — same bequest as the 80k but more spend.
      fp(90_000, 2_500_000),
    ];
    const front = computeParetoFront(points);
    for (let i = 1; i < front.length; i += 1) {
      expect(front[i].bequest).toBeLessThan(front[i - 1].bequest);
    }
  });
});

describe('projectEvaluations', () => {
  it('filters by minimum feasibility before projecting', () => {
    const evals = [
      {
        policy: { annualSpendTodayDollars: 100_000 },
        outcome: {
          bequestAttainmentRate: 0.5,
          p50EndingWealthTodayDollars: 1_000_000,
        },
      },
      {
        policy: { annualSpendTodayDollars: 110_000 },
        outcome: {
          bequestAttainmentRate: 0.85,
          p50EndingWealthTodayDollars: 1_500_000,
        },
      },
    ] as PolicyEvaluation[];
    const projected = projectEvaluations(evals, 0.7);
    expect(projected.length).toBe(1);
    expect(projected[0].spend).toBe(110_000);
  });
});

describe('isDominated', () => {
  it('returns true when another point dominates strictly', () => {
    const p = fp(100_000, 1_000_000);
    const winner = fp(120_000, 1_500_000);
    expect(isDominated(p, [p, winner])).toBe(true);
  });

  it('returns false when the point is on the frontier', () => {
    const p = fp(100_000, 2_000_000);
    const other = fp(150_000, 1_000_000);
    expect(isDominated(p, [p, other])).toBe(false);
  });
});

describe('thinForOverplot', () => {
  it('reduces multiple points in the same bin to one representative', () => {
    const cluster = [
      fp(100_000, 1_500_000, 0.85),
      fp(100_500, 1_500_000, 0.85), // close enough to bin together
      fp(100_200, 1_500_000, 0.85),
    ];
    const out = thinForOverplot(cluster, 5_000, 5);
    expect(out.length).toBe(1);
  });

  it('keeps points in distinct spend bins separate', () => {
    const points = [
      fp(100_000, 1_500_000, 0.85),
      fp(150_000, 1_000_000, 0.85),
    ];
    const out = thinForOverplot(points, 5_000, 5);
    expect(out.length).toBe(2);
  });
});
