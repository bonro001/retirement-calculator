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
 * V1 default axes, calibrated for the household's "in transition to
 * retirement" baseline. Tuned to keep the corpus around 1,728 entries
 * (8 × 6 × 6 × 6) — small enough to mine in ~10 minutes single-threaded
 * on the M4 mini, ~2 minutes on the cluster.
 *
 * Tuning notes (V1.1, narrowed from V1):
 *   - Spend levels $80k–$160k in $10k steps (8 levels). The household
 *     has stated they wouldn't realistically spend below $80k or above
 *     $160k — so spending search-time on those candidates is wasted
 *     compute. Re-widen if the household's situation shifts.
 *   - SS claim ages 65..70 in 1-year increments (6 ages). The household
 *     has stated neither will claim before 65. Cuts 1/3 of the SS axis
 *     versus the full 62..70 default.
 *   - Roth conversion caps span $0–$200k in $40k steps (6 levels) —
 *     unchanged. The $0 case anchors the "no conversions" baseline;
 *     $200k covers fully filling the 24% bracket. The engine's
 *     withdrawal optimizer uses this cap PLUS its IRMAA-cliff awareness
 *     to pick the actual conversion amount per year.
 */
export function buildDefaultPolicyAxes(seedData: SeedData): PolicyAxes {
  const ssEntries = seedData.income?.socialSecurity ?? [];
  const hasSpouseSs = ssEntries.length >= 2;
  // V2 (2026-05-01): 6-month SS resolution to match real claim
  // flexibility. Engine supports fractional claim ages with
  // partial-year-of-claim payment in the crossing year.
  const ssAges = [
    65, 65.5, 66, 66.5, 67, 67.5, 68, 68.5, 69, 69.5, 70,
  ];
  return {
    // V2: $5k spend resolution from $80k–$160k. This is the COARSE pass.
    // After it completes, `cliff-refinement-analyzer.ts` inspects the
    // corpus, identifies the spend tier where feasibility crosses the
    // household's threshold, and recommends a FINE second pass at $1k
    // resolution around that cliff. The fine pass mines via the
    // existing `axesOverride` plumbing — same ranker, same corpus,
    // ids stay distinct because spend changes.
    annualSpendTodayDollars: [
      80_000, 85_000, 90_000, 95_000, 100_000, 105_000, 110_000, 115_000,
      120_000, 125_000, 130_000, 135_000, 140_000, 145_000, 150_000, 155_000,
      160_000,
    ],
    primarySocialSecurityClaimAge: ssAges,
    spouseSocialSecurityClaimAge: hasSpouseSs ? ssAges : null,
    rothConversionAnnualCeiling: [0, 40_000, 80_000, 120_000, 160_000, 200_000],
    // V2: withdrawal-rule axis. Four named strategies the ranker
    // sweeps. tax_bracket_waterfall (the historical default) is first
    // so any backward-compat caller that grabs `axes.withdrawalRule[0]`
    // gets the safe choice.
    withdrawalRule: [
      'tax_bracket_waterfall',
      'proportional',
      'reverse_waterfall',
      'guyton_klinger',
    ],
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
  const withdrawalRules = axes.withdrawalRule ?? ['tax_bracket_waterfall'];
  return (
    axes.annualSpendTodayDollars.length *
    axes.primarySocialSecurityClaimAge.length *
    spouseAges.length *
    axes.rothConversionAnnualCeiling.length *
    withdrawalRules.length
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
  // Default to a single-rule sweep (tax_bracket_waterfall) when the
  // axis isn't supplied — preserves pre-V2 corpus shape for callers
  // that haven't been updated to specify a withdrawal-rule list.
  const withdrawalRules = axes.withdrawalRule ?? ['tax_bracket_waterfall'];
  for (const rule of withdrawalRules) {
    for (const roth of axes.rothConversionAnnualCeiling) {
      for (const spouse of spouseAges) {
        for (const primary of axes.primarySocialSecurityClaimAge) {
          for (const spend of axes.annualSpendTodayDollars) {
            out.push({
              annualSpendTodayDollars: spend,
              primarySocialSecurityClaimAge: primary,
              spouseSocialSecurityClaimAge: spouse,
              rothConversionAnnualCeiling: roth,
              withdrawalRule: rule,
            });
          }
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
  // Withdrawal rule is included because two policies with identical
  // (spend, SS, Roth) but different withdrawal rules produce different
  // outcomes — they're distinct candidates, not duplicates.
  const canonical = JSON.stringify({
    a: policy.annualSpendTodayDollars,
    p: policy.primarySocialSecurityClaimAge,
    s: policy.spouseSocialSecurityClaimAge,
    r: policy.rothConversionAnnualCeiling,
    w: policy.withdrawalRule ?? 'tax_bracket_waterfall',
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
