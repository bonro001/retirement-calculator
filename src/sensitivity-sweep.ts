import type { Policy, PolicyAxes, PolicyEvaluation } from './policy-miner-types';
import type { SeedData } from './types';
import {
  buildDefaultPolicyAxes,
  computeMinimumSpendFloor,
} from './policy-axis-enumerator';

/**
 * E.5 — Sensitivity sweep around an adopted policy.
 *
 * The household has just clicked Adopt on a winner. The next question
 * they'd ask a human advisor is "is this stable — what if I claimed
 * one year earlier, or spent $5k more?". Without a sensitivity tool
 * they're left to either trust the rank-1 result or scroll the corpus
 * by hand looking for neighbors.
 *
 * Design decisions:
 *   - 3 ticks per axis (adopted, lower neighbor, upper neighbor) gives
 *     a 3⁴ = 81-policy cartesian. At ~2s/policy across a 24-worker
 *     cluster that's ~7 sec — fast enough to feel interactive after
 *     the click. Wider sweeps (5⁴ = 625, ~50 sec) buy curve resolution
 *     but blur the "is my pick stable?" signal with too much noise.
 *
 *   - Cartesian (not just 4 marginal arms of 5 each = 17 unique points)
 *     because the dispatcher's `enumeratePolicies(axes)` is cartesian-
 *     only. Going to "explicit policy list" requires a dispatcher API
 *     change; we instead pay a 4× compute cost for off-diagonal cells
 *     we don't display. At 81 policies the absolute cost is trivial.
 *
 *   - Marginal slices, not full surfaces. Households reason in terms
 *     of "if I bump THIS one thing" — pulling the slice where the other
 *     three axes equal the adopted values gives that 1-D answer. The
 *     off-diagonal cells stay in the corpus for callers who want them.
 *
 *   - Reuse the production trial count (2000). Sensitivity is only
 *     meaningful at the same precision as the original mine; otherwise
 *     the differences we surface are simulation noise, not real
 *     differences in the policy.
 */

/** How many ticks on each side of the adopted value to include. 1 = three values per axis. */
const SENSITIVITY_HALF_WIDTH = 1;

/**
 * Pick a window of values centered on the adopted-value index, half-
 * width on each side. Clamps at the array boundaries — if the adopted
 * value is at the edge of the legal range (e.g. SS age 70 is the upper
 * bound), the window is one-sided.
 */
function windowAround(values: number[], centerIdx: number, halfWidth: number): number[] {
  const lo = Math.max(0, centerIdx - halfWidth);
  const hi = Math.min(values.length - 1, centerIdx + halfWidth);
  return values.slice(lo, hi + 1);
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function windowAroundTarget(
  values: number[],
  target: number,
  halfWidth: number,
): number[] {
  if (values.length === 0) return [target];
  if (values.includes(target)) {
    return windowAround(values, values.indexOf(target), halfWidth);
  }
  const below = values.filter((value) => value < target).slice(-halfWidth);
  const above = values.filter((value) => value > target).slice(0, halfWidth);
  return uniqueSorted([...below, target, ...above]);
}

/**
 * Build a tight axes spec for a sensitivity sweep around `adopted`.
 *
 * Strategy: take the household's default axes (so we use the same
 * legal-value grid the miner already understands — including the spend
 * floor filter), find the closest grid value to each of the adopted
 * policy's axes, and produce a 3-element window centered there.
 *
 * Why not arbitrary ±$X / ±N years steps: keeping the sweep ON the
 * default grid means sensitivity records share policy ids with the main
 * corpus when they happen to coincide. This makes future "did I
 * already evaluate this point?" dedupe work for free.
 */
export function buildSensitivitySweepAxes(
  adopted: Policy,
  seedData: SeedData,
): PolicyAxes {
  const defaults = buildDefaultPolicyAxes(seedData);

  // Spend axis: snap to grid, then take a 3-wide window. Floor still
  // applies because we drew from `defaults`, which is already filtered.
  const spendValues = windowAroundTarget(
    defaults.annualSpendTodayDollars,
    adopted.annualSpendTodayDollars,
    SENSITIVITY_HALF_WIDTH,
  );

  // Primary SS age axis.
  const primaryValues = windowAroundTarget(
    defaults.primarySocialSecurityClaimAge,
    adopted.primarySocialSecurityClaimAge,
    SENSITIVITY_HALF_WIDTH,
  );

  // Spouse SS age axis — only if the household has a spouse SS record.
  let spouseValues: number[] | null = null;
  if (
    defaults.spouseSocialSecurityClaimAge &&
    adopted.spouseSocialSecurityClaimAge !== null
  ) {
    spouseValues = windowAroundTarget(
      defaults.spouseSocialSecurityClaimAge,
      adopted.spouseSocialSecurityClaimAge,
      SENSITIVITY_HALF_WIDTH,
    );
  }

  // Roth max axis.
  const rothValues = windowAroundTarget(
    defaults.rothConversionAnnualCeiling,
    adopted.rothConversionAnnualCeiling,
    SENSITIVITY_HALF_WIDTH,
  );

  // Defensive: the spend floor pre-filter could leave ZERO values in a
  // pathological case (very high floor + very low adopted). Fall back
  // to the adopted value alone so the sweep still runs and the user
  // sees a single-row "no neighbors available" rather than an error.
  return {
    annualSpendTodayDollars:
      spendValues.length > 0 ? spendValues : [adopted.annualSpendTodayDollars],
    primarySocialSecurityClaimAge:
      primaryValues.length > 0 ? primaryValues : [adopted.primarySocialSecurityClaimAge],
    spouseSocialSecurityClaimAge: spouseValues,
    rothConversionAnnualCeiling:
      rothValues.length > 0 ? rothValues : [adopted.rothConversionAnnualCeiling],
  };
}

/**
 * Count of cartesian policies the sweep will evaluate. Useful for the
 * UI's "running ~N policies" label.
 */
export function sensitivitySweepSize(axes: PolicyAxes): number {
  const spouse = axes.spouseSocialSecurityClaimAge ?? [null];
  return (
    axes.annualSpendTodayDollars.length *
    axes.primarySocialSecurityClaimAge.length *
    spouse.length *
    axes.rothConversionAnnualCeiling.length
  );
}

// ---------------------------------------------------------------------------
// Marginal slice extraction
// ---------------------------------------------------------------------------

export type SensitivityAxisKey =
  | 'annualSpendTodayDollars'
  | 'primarySocialSecurityClaimAge'
  | 'spouseSocialSecurityClaimAge'
  | 'rothConversionAnnualCeiling';

export interface SensitivityPoint {
  /** Raw axis value at this point (e.g. 130000 for spend, 70 for SS). */
  axisValue: number;
  /** True when this point is the adopted policy itself. */
  isAdopted: boolean;
  /** Bequest P50 in today's dollars. */
  bequestP50: number;
  /** Bequest P10 in today's dollars (worst-case anchor). */
  bequestP10: number;
  /** Feasibility = bequestAttainmentRate, in [0, 1]. */
  feasibility: number;
}

export interface SensitivityArm {
  axis: SensitivityAxisKey;
  /** Friendly label for the panel header, e.g. "Annual spend". */
  label: string;
  /** Friendly unit suffix for axis values, e.g. "/yr" or "" for ages. */
  unit: '$/yr' | 'years' | '$ ceiling';
  /** Sorted ascending by axisValue. Includes the adopted point. */
  points: SensitivityPoint[];
  /** Index of the adopted point inside `points`, for highlighting. */
  adoptedIndex: number;
}

export interface SensitivityResult {
  /** The four marginals — spouse may be null when the household has no spouse SS. */
  arms: SensitivityArm[];
  /** Total cartesian sweep size (for "X of Y evaluated" progress). */
  totalSweepPolicies: number;
}

/**
 * Filter the cluster's evaluations down to those that match the sweep's
 * axes spec, then carve out the four marginal arms. An arm holds three
 * other axes constant at the adopted values and varies one.
 *
 * Returns null until at least the adopted-cell evaluation is present —
 * otherwise we'd render arms with no anchor and the deltas would look
 * like the curve, not the deviation from a known point.
 */
export function extractSensitivityArms(
  evaluations: PolicyEvaluation[],
  adopted: Policy,
  sweepAxes: PolicyAxes,
): SensitivityResult | null {
  const totalSweepPolicies = sensitivitySweepSize(sweepAxes);

  // Filter to records whose policy lies INSIDE the sweep grid. The
  // dispatcher writes the same corpus that the main mine uses, so the
  // session may have far more records than just the 81 sweep cells.
  const inGrid = evaluations.filter(
    (e) =>
      sweepAxes.annualSpendTodayDollars.includes(
        e.policy.annualSpendTodayDollars,
      ) &&
      sweepAxes.primarySocialSecurityClaimAge.includes(
        e.policy.primarySocialSecurityClaimAge,
      ) &&
      ((sweepAxes.spouseSocialSecurityClaimAge === null &&
        e.policy.spouseSocialSecurityClaimAge === null) ||
        (sweepAxes.spouseSocialSecurityClaimAge !== null &&
          e.policy.spouseSocialSecurityClaimAge !== null &&
          sweepAxes.spouseSocialSecurityClaimAge.includes(
            e.policy.spouseSocialSecurityClaimAge,
          ))) &&
      sweepAxes.rothConversionAnnualCeiling.includes(
        e.policy.rothConversionAnnualCeiling,
      ),
  );

  // Anchor: the cell where ALL axes equal the adopted values. Required
  // before we render — the panel highlights deltas relative to this.
  const anchor = inGrid.find(
    (e) =>
      e.policy.annualSpendTodayDollars === adopted.annualSpendTodayDollars &&
      e.policy.primarySocialSecurityClaimAge ===
        adopted.primarySocialSecurityClaimAge &&
      e.policy.spouseSocialSecurityClaimAge ===
        adopted.spouseSocialSecurityClaimAge &&
      e.policy.rothConversionAnnualCeiling ===
        adopted.rothConversionAnnualCeiling,
  );
  if (!anchor) return null;

  function pointFor(e: PolicyEvaluation, axisValue: number): SensitivityPoint {
    return {
      axisValue,
      isAdopted: e === anchor,
      bequestP50: e.outcome.p50EndingWealthTodayDollars,
      bequestP10: e.outcome.p10EndingWealthTodayDollars,
      feasibility: e.outcome.bequestAttainmentRate,
    };
  }

  // Helper: pull the marginal arm for one axis. Holds the OTHER axes
  // pinned to the adopted values; varies the named axis.
  function buildArm(
    axis: SensitivityAxisKey,
    label: string,
    unit: SensitivityArm['unit'],
  ): SensitivityArm {
    const sliced = inGrid.filter((e) => {
      if (
        axis !== 'annualSpendTodayDollars' &&
        e.policy.annualSpendTodayDollars !== adopted.annualSpendTodayDollars
      )
        return false;
      if (
        axis !== 'primarySocialSecurityClaimAge' &&
        e.policy.primarySocialSecurityClaimAge !==
          adopted.primarySocialSecurityClaimAge
      )
        return false;
      if (
        axis !== 'spouseSocialSecurityClaimAge' &&
        e.policy.spouseSocialSecurityClaimAge !==
          adopted.spouseSocialSecurityClaimAge
      )
        return false;
      if (
        axis !== 'rothConversionAnnualCeiling' &&
        e.policy.rothConversionAnnualCeiling !==
          adopted.rothConversionAnnualCeiling
      )
        return false;
      return true;
    });

    const points = sliced
      .map((e) => {
        const axisValueRaw =
          axis === 'spouseSocialSecurityClaimAge'
            ? (e.policy[axis] ?? Number.NaN)
            : (e.policy[axis] as number);
        return pointFor(e, axisValueRaw);
      })
      .sort((a, b) => a.axisValue - b.axisValue);

    const adoptedIndex = points.findIndex((p) => p.isAdopted);

    return { axis, label, unit, points, adoptedIndex };
  }

  const arms: SensitivityArm[] = [
    buildArm('annualSpendTodayDollars', 'Annual spend', '$/yr'),
    buildArm('primarySocialSecurityClaimAge', 'Primary SS claim age', 'years'),
  ];

  if (sweepAxes.spouseSocialSecurityClaimAge !== null) {
    arms.push(
      buildArm('spouseSocialSecurityClaimAge', 'Spouse SS claim age', 'years'),
    );
  }

  arms.push(
    buildArm(
      'rothConversionAnnualCeiling',
      'Roth conversion max',
      '$ ceiling',
    ),
  );

  return { arms, totalSweepPolicies };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function formatAxisValue(
  value: number,
  unit: SensitivityArm['unit'],
): string {
  if (unit === 'years') return `${value}`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${Math.round(value)}`;
}

export function formatBequestDelta(deltaDollars: number): string {
  const sign = deltaDollars > 0 ? '+' : deltaDollars < 0 ? '−' : '';
  const abs = Math.abs(deltaDollars);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export function formatFeasibilityDelta(deltaRate: number): string {
  const sign = deltaRate > 0 ? '+' : deltaRate < 0 ? '−' : '';
  const abs = Math.abs(deltaRate) * 100;
  if (abs < 0.5) return '≈0';
  return `${sign}${abs.toFixed(0)}pp`;
}

/**
 * Floor the spend floor would have removed an adopted-spend value
 * itself? Real edge case: if the floor changes after adoption (user
 * edits essentials), the adopted policy may no longer be a valid grid
 * point. We can't sensibly sweep around a value that's now invalid.
 */
export function adoptedIsAboveFloor(
  adopted: Policy,
  seedData: SeedData,
): boolean {
  return adopted.annualSpendTodayDollars >= computeMinimumSpendFloor(seedData);
}
