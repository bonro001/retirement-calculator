/**
 * Quasi-Monte Carlo (QMC) primitives for the retirement engine.
 *
 * Phase 2.B perf: replace independent uniform draws with a low-discrepancy
 * Sobol sequence so the same statistical confidence requires fewer trials.
 * For smooth-ish integrands (portfolio outcome distributions), Sobol's
 * deterministic stratification gives 2-4× faster convergence in practice.
 *
 * This module is engine-agnostic: it produces a deterministic stream of
 * 4-dim uniform points (Sobol), and a high-accuracy inverse-normal CDF
 * (Wichura AS241) so callers can map uniforms → standard normals. The
 * engine's existing Cholesky correlation step then takes over.
 *
 * Design notes:
 *   - 4 dimensions is the natural fit for our workload: 4 correlated asset
 *     classes (US/INTL/BONDS/CASH) per simulated year.
 *   - We generate one 4-dim point per (trial, year) — i.e. the i-th point
 *     in the stream feeds the year-i return shock for one trial. Each
 *     trial gets a disjoint sub-stream offset by `trialIndex × maxYears`.
 *   - Box-Muller is NOT used for QMC: it consumes 2 uniforms per normal
 *     and shuffles their order in a way that breaks Sobol's stratification.
 *     Inverse-CDF preserves the per-dimension low-discrepancy property.
 *
 * References:
 *   - Joe & Kuo (2008), "Constructing Sobol sequences with better
 *     two-dimensional projections" — direction-number tables.
 *   - Wichura (1988), "Algorithm AS 241: The Percentage Points of the
 *     Normal Distribution" — fast inverse-normal with ~7-digit accuracy.
 *   - Antonov & Saleev (1979) Gray-code optimization — each next-point
 *     update is O(1) instead of O(log n).
 */

// ---------------------------------------------------------------------------
// Sobol generator (4-dim, Gray-code accelerated)
// ---------------------------------------------------------------------------

// Number of bits in our direction-number tables. 32 lets us generate up to
// 2^32 - 1 points before exhausting; our workloads use <1M, so this is huge
// headroom. Using 32 (vs 64) means each direction number fits in a JS i32
// and we get fast Math.imul / XOR throughout.
const SOBOL_BITS = 32;

// Joe-Kuo direction-number seeds for the first 4 dimensions.
// Format per dim:
//   degree s (degree of primitive polynomial)
//   a      (packed binary coefficients of polynomial, excluding leading
//           x^s term and trailing constant 1; bit i = coefficient of x^(s-1-i))
//   m      (initial m_1..m_s values, each odd and < 2^k)
// Dim 1 is the trivial van der Corput base 2 (s=1, no recurrence).
const SOBOL_SEEDS_4D: ReadonlyArray<{ s: number; a: number; m: readonly number[] }> = [
  { s: 1, a: 0, m: [1] },        // dim 1
  { s: 2, a: 1, m: [1, 1] },     // dim 2
  { s: 3, a: 1, m: [1, 3, 7] },  // dim 3
  { s: 3, a: 2, m: [1, 1, 5] },  // dim 4
];

/**
 * Pre-computed 4×SOBOL_BITS table of direction numbers.
 * directionNumbers[dim][k] is v_{k+1} << (SOBOL_BITS - 1 - k), i.e. the
 * 32-bit mask that gets XORed into the running x[dim] when bit k of the
 * Gray-code-flipped counter changes.
 *
 * One-time cost (~4×32 ops); reused across every Sobol stream.
 */
function buildDirectionTable(): Uint32Array[] {
  const tables: Uint32Array[] = [];
  for (let dim = 0; dim < 4; dim += 1) {
    const v = new Uint32Array(SOBOL_BITS);

    // Dim 1 is special: its primitive "polynomial" is the constant 1
    // (degree 0), not a real polynomial — the Joe-Kuo recurrence does
    // NOT apply. Direction numbers are just v_k = 2^(BITS - k), which
    // makes dim 1 the standard van der Corput sequence in base 2.
    // (Joe-Kuo's tables conventionally exclude dim 1 entirely; dims 2+
    // are where the polynomial recurrence kicks in.)
    if (dim === 0) {
      for (let k = 1; k <= SOBOL_BITS; k += 1) {
        v[k - 1] = (1 << (SOBOL_BITS - k)) >>> 0;
      }
      tables.push(v);
      continue;
    }

    const { s, a, m } = SOBOL_SEEDS_4D[dim];

    // First s direction numbers: v_k = m_k * 2^(BITS - k) for k = 1..s.
    // (m is 1-indexed in the literature; we use 0-indexed m[k-1].)
    for (let k = 1; k <= s; k += 1) {
      v[k - 1] = (m[k - 1] >>> 0) << (SOBOL_BITS - k);
    }

    // Recurrence for k > s:
    //   m_k = 2·a_1·m_{k-1} XOR 4·a_2·m_{k-2} XOR ... XOR 2^s·a_s·m_{k-s} XOR m_{k-s}
    // Equivalently in terms of v (= m << (BITS-k)):
    //   v_k = a_1·v_{k-1} XOR a_2·v_{k-2} XOR ... XOR a_s·v_{k-s} XOR (v_{k-s} >> s)
    for (let k = s + 1; k <= SOBOL_BITS; k += 1) {
      let next = (v[k - s - 1] >>> s) ^ v[k - s - 1];
      for (let j = 1; j < s; j += 1) {
        // bit (s-1-j) of `a` is the polynomial coefficient a_j
        const aj = (a >>> (s - 1 - j)) & 1;
        if (aj) next ^= v[k - j - 1];
      }
      v[k - 1] = next >>> 0;
    }

    tables.push(v);
  }
  return tables;
}

const DIRECTION_TABLE = buildDirectionTable();

/**
 * Number of trailing zero bits in (n+1). Used by the Antonov-Saleev
 * Gray-code update: when advancing from point n to n+1, exactly one bit
 * flips in the Gray code, and that bit's index is `ctz(n + 1)`.
 *
 * Math.clz32 is the V8 intrinsic for count-leading-zeros; ctz = 31 - clz
 * applied to the lowest-set-bit isolation `(n & -n)`. Works for n >= 1.
 */
function trailingZeros(n: number): number {
  // n must be > 0; caller guarantees this.
  return 31 - Math.clz32(n & -n);
}

/**
 * One 4-dimensional point in [0, 1)^4. Pre-allocated and mutated in place
 * by `nextSobol4()` to avoid per-call array allocation in the hot path.
 */
export type Sobol4Point = [number, number, number, number];

// 1 / 2^32, used to convert 32-bit unsigned ints to floats in [0, 1).
const TWO_NEG_32 = 1 / 4294967296;

/**
 * Create a 4-dimensional Sobol stream.
 *
 * @param skip  Number of points to skip from the start of the global Sobol
 *              sequence. Use this to give each trial a disjoint sub-stream:
 *              trial i with maxYears Y starts at skip = i * Y.
 *
 * The returned function fills the provided point array in place and
 * returns the same array (no allocation per call). Skipping the first
 * point (which is always [0,0,0,0]) is the caller's responsibility:
 * the standard convention is `skip >= 1`.
 *
 * Performance: each call does ~5 XORs and 4 multiplies. Comparable to a
 * Mulberry32 step but generates 4 uniforms instead of 1 — so per-uniform
 * cost is ~4× cheaper than Box-Muller, and per-Gaussian (after inverse-CDF)
 * is comparable to Box-Muller while preserving stratification.
 */
export function createSobol4Stream(skip: number = 0): (out: Sobol4Point) => Sobol4Point {
  // x[d] is the running 32-bit unsigned XOR-accumulator for dimension d.
  // The Antonov-Saleev recurrence: x_{n+1}[d] = x_n[d] XOR v[d][ctz(n+1)].
  let x0 = 0, x1 = 0, x2 = 0, x3 = 0;
  let n = 0;
  const v0 = DIRECTION_TABLE[0];
  const v1 = DIRECTION_TABLE[1];
  const v2 = DIRECTION_TABLE[2];
  const v3 = DIRECTION_TABLE[3];

  // Burn `skip` points so this stream's first emitted point is the
  // (skip+1)-th point of the global Sobol sequence.
  for (let i = 0; i < skip; i += 1) {
    n += 1;
    const c = trailingZeros(n);
    x0 = (x0 ^ v0[c]) >>> 0;
    x1 = (x1 ^ v1[c]) >>> 0;
    x2 = (x2 ^ v2[c]) >>> 0;
    x3 = (x3 ^ v3[c]) >>> 0;
  }

  return (out: Sobol4Point) => {
    n += 1;
    const c = trailingZeros(n);
    x0 = (x0 ^ v0[c]) >>> 0;
    x1 = (x1 ^ v1[c]) >>> 0;
    x2 = (x2 ^ v2[c]) >>> 0;
    x3 = (x3 ^ v3[c]) >>> 0;
    out[0] = x0 * TWO_NEG_32;
    out[1] = x1 * TWO_NEG_32;
    out[2] = x2 * TWO_NEG_32;
    out[3] = x3 * TWO_NEG_32;
    return out;
  };
}

// ---------------------------------------------------------------------------
// Inverse normal CDF (Wichura AS241)
// ---------------------------------------------------------------------------

// Coefficients for AS241. ~7-digit accuracy across the entire [0, 1) input
// range. Uses a piecewise rational approximation: central region (|p-0.5|
// <= 0.425) uses one polynomial, tails use a different polynomial with a
// log-transform. Source: Wichura, Applied Statistics 37(3), 1988.

// Central region coefficients (numerator a, denominator b)
const A = [
  3.3871328727963666080,
  133.14166789178437745,
  1971.5909503065514427,
  13731.693765509461125,
  45921.953931549871457,
  67265.770927008700853,
  33430.575583588128105,
  2509.0809287301226727,
];
const B = [
  42.313330701600911252,
  687.18700749205790830,
  5394.1960214247511077,
  21213.794301586595867,
  39307.895800092710610,
  28729.085735721942674,
  5226.4952788528545610,
];

// Intermediate-tail coefficients (used when |q| > 0.425 but log term is small)
const C = [
  1.42343711074968357734,
  4.63033784615654529590,
  5.76949722146069140550,
  3.64784832476320460504,
  1.27045825245236838258,
  0.241780725177450611770,
  0.0227238449892691845833,
  0.000774545014278341407640,
];
const D = [
  2.05319162663775882187,
  1.67638483018380384940,
  0.689767334985100004550,
  0.148103976427480074590,
  0.0151986665636164571966,
  0.000547593808499534494600,
  1.05075007164441684324e-9,
];

// Far-tail coefficients (very small p or 1-p)
const E = [
  6.65790464350110377720,
  5.46378491116411436990,
  1.78482653991729133580,
  0.296560571828504891230,
  0.0265321895265761230930,
  0.00124266094738807843860,
  2.71155556874348757815e-5,
  2.01033439929228813265e-7,
];
const F = [
  0.599832206555887937690,
  0.136929880922735805310,
  0.0148753612908506148525,
  0.000786869131145613259100,
  1.84631831751005468180e-5,
  1.42151175831644588870e-7,
  2.04426310338993978564e-15,
];

/**
 * Inverse normal CDF (quantile function) at probability p.
 * Returns the standard-normal value z such that P(Z <= z) = p.
 *
 * Accuracy: ~7 decimal digits across the full [1e-300, 1 - 1e-16] range.
 * Wichura AS241 is the standard high-quality inverse-normal — used by R's
 * `qnorm()` and most numerical libraries.
 *
 * @param p  Input probability in (0, 1). Caller is responsible for guarding
 *           against p === 0 or p === 1; this function returns ±Infinity
 *           respectively but doesn't validate.
 */
export function inverseNormalCdf(p: number): number {
  const q = p - 0.5;
  let r: number;

  if (Math.abs(q) <= 0.425) {
    // Central region: rational approximation in r = q^2.
    r = 0.180625 - q * q;
    return (
      (q *
        (((((((A[7] * r + A[6]) * r + A[5]) * r + A[4]) * r + A[3]) * r + A[2]) * r + A[1]) * r + A[0])) /
      (((((((B[6] * r + B[5]) * r + B[4]) * r + B[3]) * r + B[2]) * r + B[1]) * r + B[0]) * r + 1)
    );
  }

  // Tails: r = log(min(p, 1-p))
  r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));

  let value: number;
  if (r <= 5) {
    // Intermediate tail
    r -= 1.6;
    value =
      (((((((C[7] * r + C[6]) * r + C[5]) * r + C[4]) * r + C[3]) * r + C[2]) * r + C[1]) * r + C[0]) /
      (((((((D[6] * r + D[5]) * r + D[4]) * r + D[3]) * r + D[2]) * r + D[1]) * r + D[0]) * r + 1);
  } else {
    // Far tail
    r -= 5;
    value =
      (((((((E[7] * r + E[6]) * r + E[5]) * r + E[4]) * r + E[3]) * r + E[2]) * r + E[1]) * r + E[0]) /
      (((((((F[6] * r + F[5]) * r + F[4]) * r + F[3]) * r + F[2]) * r + F[1]) * r + F[0]) * r + 1);
  }

  return q < 0 ? -value : value;
}

/**
 * Convenience wrapper: produce a 4-dim standard-normal point from a Sobol
 * stream by inverse-CDF transform. Mutates `out` in place to avoid
 * allocations in the hot path.
 *
 * Guards against the edge case where Sobol emits a coordinate of 0 or 1
 * exactly — at SOBOL_BITS=32 with skip>=1, this shouldn't happen for any
 * realistic point count, but a defensive clamp to (epsilon, 1-epsilon)
 * keeps inverseNormalCdf from returning ±Infinity in pathological cases.
 */
const QMC_EPSILON = 2.2250738585072014e-308; // smallest positive normal double
const QMC_ONE_MINUS_EPSILON = 1 - 2.220446049250313e-16; // largest p < 1
function clampUniform(u: number): number {
  if (u < QMC_EPSILON) return QMC_EPSILON;
  if (u > QMC_ONE_MINUS_EPSILON) return QMC_ONE_MINUS_EPSILON;
  return u;
}

export function sobolToStandardNormals4(
  sobolPoint: Sobol4Point,
  out: Sobol4Point,
): Sobol4Point {
  out[0] = inverseNormalCdf(clampUniform(sobolPoint[0]));
  out[1] = inverseNormalCdf(clampUniform(sobolPoint[1]));
  out[2] = inverseNormalCdf(clampUniform(sobolPoint[2]));
  out[3] = inverseNormalCdf(clampUniform(sobolPoint[3]));
  return out;
}
