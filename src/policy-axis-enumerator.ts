import type { Policy, PolicyAxes } from './policy-miner-types';
import type { SeedData } from './types';

/**
 * Policy Axis Enumerator — turns a `PolicyAxes` spec into the full
 * cartesian product of `Policy` candidates.
 *
 * Why this lives in its own module: the V1 axis defaults are heuristics
 * (16 spend levels, ages 62..70 for SS, 6 Roth caps). Households or the
 * advisor layer may override them per session — by isolating enumeration
 * here, we can test the math, swap the defaults, and add new axes without
 * touching the miner.
 *
 * Also: enumeration is the natural place to short-circuit obviously-bad
 * candidates BEFORE the engine runs. We do a small amount of pre-filtering
 * (e.g. spouse-claim-age axis is ignored if the household has no spouse
 * SS record) so the miner doesn't waste time on no-op variations.
 */

/**
 * V1 default axes, calibrated for a typical "in transition to retirement"
 * household. Tuned to keep the corpus around 7,776 entries — fits in
 * <500MB IndexedDB and finishes in a few hours single-threaded on the
 * M4 mini.
 *
 * Tuning notes:
 *   - Spend levels span $40k–$250k in $10k steps (16 levels). Below $40k
 *     is rarely interesting (Social Security alone covers it for the
 *     households we model); above $250k is rarely feasible at typical
 *     portfolio sizes.
 *   - SS claim ages 62..70 in 1-year increments (9 ages). Including 62
 *     because some households with health-driven plans want to compare;
 *     including 70 because that's the last year delayed credits accrue.
 *   - Roth conversion caps span $0–$200k in $40k steps (6 levels). The
 *     $0 case anchors the "no conversions" baseline; $200k covers fully
 *     filling the 24% bracket for a high-deferred household.
 */
export function buildDefaultPolicyAxes(seedData: SeedData): PolicyAxes {
  const ssEntries = seedData.income?.socialSecurity ?? [];
  const hasSpouseSs = ssEntries.length >= 2;
  // Eight ages × eight ages × … is enough resolution to find the kink in
  // the ROI curve without combinatorial explosion. 1-year granularity is
  // the smallest unit SS itself uses for delayed-retirement-credit math.
  const ssAges = [62, 63, 64, 65, 66, 67, 68, 69, 70];
  return {
    annualSpendTodayDollars: [
      40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000, 110_000,
      120_000, 130_000, 140_000, 160_000, 180_000, 200_000, 225_000, 250_000,
    ],
    primarySocialSecurityClaimAge: ssAges,
    spouseSocialSecurityClaimAge: hasSpouseSs ? ssAges : null,
    rothConversionAnnualCeiling: [0, 40_000, 80_000, 120_000, 160_000, 200_000],
  };
}

/**
 * The lowest annual spend the default axes will consider for a given
 * baseline. Used by the status card (to show what the floor is) and by
 * the sensitivity sweep (to refuse sweeps around an adopted policy that
 * sits below the floor — that means the corpus didn't actually include
 * it as a candidate).
 */
export function computeMinimumSpendFloor(seedData: SeedData): number {
  const axes = buildDefaultPolicyAxes(seedData);
  return Math.min(...axes.annualSpendTodayDollars);
}

/**
 * Compute the total candidate count for an axes spec without materializing
 * the full list. Useful for the status panel ETA before mining starts.
 */
export function countPolicyCandidates(axes: PolicyAxes): number {
  const spouseAges = axes.spouseSocialSecurityClaimAge ?? [null];
  return (
    axes.annualSpendTodayDollars.length *
    axes.primarySocialSecurityClaimAge.length *
    spouseAges.length *
    axes.rothConversionAnnualCeiling.length
  );
}

/**
 * Materialize the full candidate list. For 7,776 candidates × ~80 bytes
 * per Policy that's ~600KB in memory — fine to hold all at once. If V2
 * axes push this past a few MB, switch to a generator.
 *
 * Iteration order matters: we sweep the most-impactful axis (spend) in
 * the inner loop so adjacent records in the corpus differ by small amounts.
 * The Phase B parallel dispatcher batches contiguous slices, so adjacent
 * runs share most cached intermediate state at the engine level.
 */
export function enumeratePolicies(axes: PolicyAxes): Policy[] {
  const out: Policy[] = [];
  const spouseAges = axes.spouseSocialSecurityClaimAge ?? [null];
  for (const roth of axes.rothConversionAnnualCeiling) {
    for (const spouse of spouseAges) {
      for (const primary of axes.primarySocialSecurityClaimAge) {
        for (const spend of axes.annualSpendTodayDollars) {
          out.push({
            annualSpendTodayDollars: spend,
            primarySocialSecurityClaimAge: primary,
            spouseSocialSecurityClaimAge: spouse,
            rothConversionAnnualCeiling: roth,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Stable, deterministic id for a policy under a given baseline + engine.
 * Collisions imply identical inputs — by design — so two hosts that
 * evaluate the same policy converge on the same record id and the corpus
 * dedupes for free.
 *
 * We use a simple FNV-1a hash on the JSON-canonicalized inputs. Not
 * cryptographic, but the input space is tiny (< 1M policies × < 100
 * baselines) and FNV's collision rate at that scale is effectively zero.
 */
export function policyId(
  policy: Policy,
  baselineFingerprint: string,
  engineVersion: string,
): string {
  // Canonical JSON: stable key order so two hosts agree on the bytes.
  const canonical = JSON.stringify({
    a: policy.annualSpendTodayDollars,
    p: policy.primarySocialSecurityClaimAge,
    s: policy.spouseSocialSecurityClaimAge,
    r: policy.rothConversionAnnualCeiling,
    b: baselineFingerprint,
    e: engineVersion,
  });
  // FNV-1a 32-bit. Plenty of bits for our cardinality.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    // Multiply by FNV prime 16777619, mask to 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pol_${hash.toString(16).padStart(8, '0')}`;
}
