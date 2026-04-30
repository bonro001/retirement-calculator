import { describe, it, expect } from 'vitest';
import { approximateBequestAttainmentRate } from './plan-evaluation';

// Tests pin the linear-interpolation contract the helper promises:
//   - At a knot value, return the exact pAbove for that quantile.
//   - Between knots, interpolate linearly.
//   - Below P10 / above P90, clamp to 0.99 / 0.01 (explicit bound on
//     unmeasured tails — we don't pretend to know more than the engine
//     told us, but we don't squash comfortable plans into the same
//     0.95 ceiling either).
//   - Non-positive or non-finite targets return 1 (no constraint).

const dist = {
  p10: 400_000,
  p25: 1_300_000,
  p50: 3_400_000,
  p75: 6_000_000,
  p90: 9_000_000,
};

describe('approximateBequestAttainmentRate', () => {
  it('returns 1.0 for non-positive target (no bequest constraint)', () => {
    expect(approximateBequestAttainmentRate(0, dist)).toBe(1);
    expect(approximateBequestAttainmentRate(-100, dist)).toBe(1);
  });

  it('returns 0.99 below P10 (capped lower bound, tail unmeasured)', () => {
    expect(approximateBequestAttainmentRate(100_000, dist)).toBe(0.99);
  });

  it('returns 0.01 above P90 (capped upper bound, tail unmeasured)', () => {
    expect(approximateBequestAttainmentRate(15_000_000, dist)).toBe(0.01);
  });

  it('returns exact pAbove at each knot value', () => {
    expect(approximateBequestAttainmentRate(dist.p10, dist)).toBeCloseTo(0.9, 5);
    expect(approximateBequestAttainmentRate(dist.p25, dist)).toBeCloseTo(0.75, 5);
    expect(approximateBequestAttainmentRate(dist.p50, dist)).toBeCloseTo(0.5, 5);
    expect(approximateBequestAttainmentRate(dist.p75, dist)).toBeCloseTo(0.25, 5);
    expect(approximateBequestAttainmentRate(dist.p90, dist)).toBeCloseTo(0.1, 5);
  });

  it('interpolates linearly between knots', () => {
    // Target $1M sits between P10 ($400k, pAbove 0.9) and P25 ($1.3M, pAbove 0.75).
    // Fraction = (1_000_000 - 400_000) / (1_300_000 - 400_000) = 0.6667
    // Expected = 0.9 + 0.6667 * (0.75 - 0.9) = 0.9 - 0.1 = 0.80
    expect(approximateBequestAttainmentRate(1_000_000, dist)).toBeCloseTo(0.8, 2);
  });

  it('handles degenerate dist (all percentiles equal) without dividing by zero', () => {
    const flat = { p10: 1_000_000, p25: 1_000_000, p50: 1_000_000, p75: 1_000_000, p90: 1_000_000 };
    // Below the value: clamped to 0.99
    expect(approximateBequestAttainmentRate(500_000, flat)).toBe(0.99);
    // Exactly at value: returns first knot's pAbove (0.9) — the zero-span
    // branch in the loop short-circuits to a.pAbove rather than dividing.
    expect(approximateBequestAttainmentRate(1_000_000, flat)).toBe(0.9);
    // Above the value: clamped to 0.01
    expect(approximateBequestAttainmentRate(1_500_000, flat)).toBe(0.01);
  });
});
