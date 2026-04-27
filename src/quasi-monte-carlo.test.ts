import { describe, it, expect } from 'vitest';
import {
  createSobol4Stream,
  inverseNormalCdf,
  sobolToStandardNormals4,
  type Sobol4Point,
} from './quasi-monte-carlo';

/**
 * Phase 2.B QMC primitives — correctness suite.
 *
 * These are the only tests guarding against the QMC engine path silently
 * producing wrong distributions. If any of them fail, do NOT relax the
 * tolerance — fix the math.
 */

describe('Sobol 4-dim sequence', () => {
  it('first point matches the published van der Corput / Sobol convention', () => {
    // Convention: point #1 (the first emitted, with skip=0) is
    // (0.5, 0.5, 0.5, 0.5) for 4 dimensions of Sobol' starting from
    // index 1. The point at index 0 is (0,0,0,0) and is conventionally
    // skipped; our generator's "first emitted" is index 1.
    const next = createSobol4Stream(0);
    const out: Sobol4Point = [0, 0, 0, 0];
    next(out);
    expect(out[0]).toBeCloseTo(0.5, 12);
    expect(out[1]).toBeCloseTo(0.5, 12);
    expect(out[2]).toBeCloseTo(0.5, 12);
    expect(out[3]).toBeCloseTo(0.5, 12);
  });

  it('second point is (0.75, 0.75, 0.25, 0.75) — Joe-Kuo dim-2-4 polynomials', () => {
    // Point #2 with our chosen primitive polynomials (Joe-Kuo 2008
    // tables for dims 2-4: x²+x+1, x³+x+1, x³+x²+1):
    //   dim 1 vdC base 2 in Gray-code order: 0.5, 0.75, ...
    //   dim 2 (m=[1,1]):                     0.5, 0.75, ...
    //   dim 3 (m=[1,3,7]):                   0.5, 0.25, ...
    //   dim 4 (m=[1,1,5]):                   0.5, 0.75, ...
    // Different references quote different "second point" values for
    // 4D Sobol — the differences are entirely due to which primitive
    // polynomials are picked for dims 2+. We use Joe-Kuo's choices as
    // documented in the SOBOL_SEEDS_4D table.
    const next = createSobol4Stream(0);
    const out: Sobol4Point = [0, 0, 0, 0];
    next(out); // discard #1
    next(out);
    expect(out[0]).toBeCloseTo(0.75, 12);
    expect(out[1]).toBeCloseTo(0.75, 12);
    expect(out[2]).toBeCloseTo(0.25, 12);
    expect(out[3]).toBeCloseTo(0.75, 12);
  });

  it('first 4 points of dim 1 form the standard van der Corput base 2', () => {
    // Dim 1 should be 1/2, 3/4, 1/4, 3/8 — the canonical vdC sequence.
    const next = createSobol4Stream(0);
    const out: Sobol4Point = [0, 0, 0, 0];
    next(out); expect(out[0]).toBeCloseTo(0.5, 12);
    next(out); expect(out[0]).toBeCloseTo(0.75, 12);
    next(out); expect(out[0]).toBeCloseTo(0.25, 12);
    next(out); expect(out[0]).toBeCloseTo(0.375, 12);
  });

  it('all points are in [0, 1)', () => {
    // Sobol output should never produce 0.0 (after skip>=1) or >= 1.0.
    const next = createSobol4Stream(0);
    const out: Sobol4Point = [0, 0, 0, 0];
    for (let i = 0; i < 1024; i += 1) {
      next(out);
      for (let d = 0; d < 4; d += 1) {
        expect(out[d]).toBeGreaterThan(0);
        expect(out[d]).toBeLessThan(1);
      }
    }
  });

  it('skip parameter advances the stream deterministically', () => {
    // Two streams with skip=0 and skip=10 should agree on point #11.
    const a = createSobol4Stream(0);
    const b = createSobol4Stream(10);
    const outA: Sobol4Point = [0, 0, 0, 0];
    const outB: Sobol4Point = [0, 0, 0, 0];
    for (let i = 0; i < 10; i += 1) a(outA); // burn 10 from A
    a(outA); // 11th from A
    b(outB); // 11th from B (10 already skipped)
    expect(outA[0]).toBeCloseTo(outB[0], 14);
    expect(outA[1]).toBeCloseTo(outB[1], 14);
    expect(outA[2]).toBeCloseTo(outB[2], 14);
    expect(outA[3]).toBeCloseTo(outB[3], 14);
  });

  it('discrepancy beats independent uniforms on a smooth integrand', () => {
    // Integrate f(x,y,z,w) = x*y*z*w over [0,1]^4. Exact value = (1/2)^4
    // = 0.0625. Sobol at N=1024 should have much smaller error than
    // independent uniforms at the same N.
    const exact = 0.0625;
    const N = 1024;
    const sobolNext = createSobol4Stream(1); // skip the (0,0,0,0) origin
    const out: Sobol4Point = [0, 0, 0, 0];
    let sobolSum = 0;
    for (let i = 0; i < N; i += 1) {
      sobolNext(out);
      sobolSum += out[0] * out[1] * out[2] * out[3];
    }
    const sobolEstimate = sobolSum / N;
    const sobolError = Math.abs(sobolEstimate - exact);

    // Independent uniforms via a deterministic seed so this test is stable.
    let s = 0x12345678;
    const rand = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let mcSum = 0;
    for (let i = 0; i < N; i += 1) {
      mcSum += rand() * rand() * rand() * rand();
    }
    const mcEstimate = mcSum / N;
    const mcError = Math.abs(mcEstimate - exact);

    // For this smooth integrand at N=1024, Sobol should beat MC by 5-50×.
    // We assert at least 3× to leave headroom for seed-dependent variance.
    expect(sobolError).toBeLessThan(mcError / 3);
  });
});

describe('inverseNormalCdf (Wichura AS241)', () => {
  it('matches known quantiles to 7+ decimal places', () => {
    // These are the canonical reference values from R's qnorm() to 12dp.
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 12);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959963984540054, 7);
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.6448536269514722, 7);
    expect(inverseNormalCdf(0.84134474606854293)).toBeCloseTo(1, 7);
    expect(inverseNormalCdf(0.99865010196836975)).toBeCloseTo(3, 7);
  });

  it('is symmetric about 0.5', () => {
    // P_inv(1-p) = -P_inv(p) for any p in (0, 1).
    for (const p of [0.001, 0.05, 0.1, 0.25, 0.4]) {
      expect(inverseNormalCdf(1 - p)).toBeCloseTo(-inverseNormalCdf(p), 10);
    }
  });

  it('handles tail inputs within AS241 design range without overflow', () => {
    // AS241's documented accuracy is ~7 digits across roughly p in
    // [1e-9, 1 - 1e-9]. Beyond that, accuracy degrades — but our
    // workload (30y × ≤5000 trials) never queries below ~1e-9 quantiles
    // in practice, so we test within that range.
    expect(inverseNormalCdf(1e-9)).toBeCloseTo(-5.997807164824767, 5);
    expect(inverseNormalCdf(1 - 1e-9)).toBeCloseTo(5.997807164824767, 5);
    expect(inverseNormalCdf(1e-6)).toBeCloseTo(-4.753424308822543, 6);
  });
});

describe('sobolToStandardNormals4', () => {
  it('first point gives all zeros (uniform 0.5 → normal 0)', () => {
    const next = createSobol4Stream(0);
    const sobolOut: Sobol4Point = [0, 0, 0, 0];
    const normalOut: Sobol4Point = [0, 0, 0, 0];
    next(sobolOut);
    sobolToStandardNormals4(sobolOut, normalOut);
    expect(normalOut[0]).toBeCloseTo(0, 12);
    expect(normalOut[1]).toBeCloseTo(0, 12);
    expect(normalOut[2]).toBeCloseTo(0, 12);
    expect(normalOut[3]).toBeCloseTo(0, 12);
  });

  it('sample mean and stddev converge to (0, 1) per dim', () => {
    // 4096 Sobol points → standard normals. Each dim should have
    // sample mean ≈ 0 (within ±0.05) and sample stddev ≈ 1 (within ±0.05).
    const N = 4096;
    const next = createSobol4Stream(1); // skip origin
    const sobolOut: Sobol4Point = [0, 0, 0, 0];
    const normalOut: Sobol4Point = [0, 0, 0, 0];
    const sums = [0, 0, 0, 0];
    const sumSquares = [0, 0, 0, 0];
    for (let i = 0; i < N; i += 1) {
      next(sobolOut);
      sobolToStandardNormals4(sobolOut, normalOut);
      for (let d = 0; d < 4; d += 1) {
        sums[d] += normalOut[d];
        sumSquares[d] += normalOut[d] * normalOut[d];
      }
    }
    for (let d = 0; d < 4; d += 1) {
      const mean = sums[d] / N;
      const variance = sumSquares[d] / N - mean * mean;
      const stddev = Math.sqrt(variance);
      expect(Math.abs(mean)).toBeLessThan(0.05);
      expect(Math.abs(stddev - 1)).toBeLessThan(0.05);
    }
  });
});
