import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { approximateBequestAttainmentRate } from './plan-evaluation';

/**
 * Spend-level optimizer — finds the maximum annual spending (today's $)
 * that the household can sustain at a target solvency level, given the
 * current strategy (SS claim ages, Roth conversion policy, allocations,
 * etc.) baked into the seed.
 *
 * Why this is a separate optimizer rather than a "max safe spend" knob
 * on the engine: the household's seed-level spending is a *lifestyle
 * input* (how much they want to live on). This optimizer answers a
 * different question — "what's the most you COULD spend if you wanted
 * to?" — without changing the input. It's the complement to the SS
 * optimizer: SS optimizes a strategy lever; this surfaces a derived
 * frontier number for the spending lifestyle decision.
 *
 * Method: bisection. The engine accepts `annualSpendTarget` as an
 * override to top-level seed spending (see `evaluatePolicy` and
 * `simulatePath`), so we can sweep spending without rebuilding the
 * spend buckets. Solvency vs spending is monotonic-decreasing for any
 * fixed strategy — bisection is exact.
 *
 * Output: the top-of-frontier spending level, plus the projected
 * solvency, legacy attainment, and median ending wealth at that level.
 *
 * Cost: O(log(range/tolerance)) engine calls. With $80k–$200k range and
 * $1k tolerance, that's ~7 iterations × ~3s each = ~20s at 500 trials.
 * Like the SS optimizer, this is intended for occasional Cockpit
 * compute — cache by seed fingerprint.
 */

export interface SpendOptimizationOptions {
  /** Lower bound (annual today's $) for the bisection. Default $40k —
   *  well below any realistic household floor, but a positive lower
   *  bound is required for log-style searches. */
  minAnnualSpend?: number;
  /** Upper bound (annual today's $) for the bisection. Default $300k —
   *  if your seed solvency is >= target at $300k spending, the
   *  optimizer will report exactly $300k (the top of search range)
   *  rather than running unbounded. */
  maxAnnualSpend?: number;
  /** Target solvency rate (the floor we're searching for). Default
   *  0.85 — matches the household's stated "north star 2: maintain 85%
   *  solvency." Raise to 0.95 for ultra-conservative; lower (with
   *  caution) for aggressive plans. */
  targetSolventRate?: number;
  /** Target legacy-attainment rate (the second binding constraint).
   *  Default 0.85 — matches "north star 1: leave $1M in today's $."
   *  When `legacyTargetTodayDollars` is null/0 (no legacy goal), this
   *  constraint is skipped automatically. The bisection finds the
   *  largest spend where BOTH constraints hold. */
  targetLegacyAttainmentRate?: number;
  /** Trials per evaluation. Default 500 — accurate to ~2pp solvency.
   *  Raise to 2000 for publication-grade precision (4× cost). */
  trialCount?: number;
  /** Stop bisecting when the high-low gap shrinks below this many
   *  dollars/year. Default $1,000. */
  toleranceDollars?: number;
  /** Hard cap on iterations. Default 12 (max 12 engine evaluations).
   *  Bisection converges to log2((max-min)/tol) ≈ 8 iterations on
   *  default settings; the cap is for safety against pathological
   *  monotonicity violations. */
  maxIterations?: number;
  /** Bequest target in today's $. If 0/null, the result's
   *  `legacyAttainmentRate` is null. Defaults to
   *  `seed.goals?.legacyTargetTodayDollars` if present. */
  legacyTargetTodayDollars?: number;
  /** Optional progress callback fired after each iteration completes.
   *  Reports (current low, current high) so the caller can show
   *  "narrowing $X – $Y." */
  onProgress?: (iteration: number, low: number, high: number) => void;
  /** Optional cancellation signal. Checked between iterations. */
  isCancelled?: () => boolean;
}

export interface SpendOptimizationEvaluation {
  /** The annual-spend level evaluated (today's $). */
  annualSpendTodayDollars: number;
  /** Solvency rate at that spend level. */
  solventSuccessRate: number;
  /** Legacy attainment rate (null if no target was provided). */
  legacyAttainmentRate: number | null;
  /** Median ending wealth in today's $. */
  p50EndingWealthTodayDollars: number;
}

export type SpendBindingConstraint = 'solvency' | 'legacy' | 'both' | null;

export interface SpendOptimizationResult {
  /** The maximum sustainable spend level we found. The result of the
   *  bisection — the highest spend that meets BOTH constraints
   *  (solvency AND legacy attainment when a legacy target exists). */
  recommendedAnnualSpendTodayDollars: number;
  /** Engine output at the recommended spend level. */
  recommendedEvaluation: SpendOptimizationEvaluation;
  /** Engine output at the seed's *current* total annual spending, for
   *  comparison. May be null if the optimizer was cancelled before
   *  evaluating it. */
  currentSeedEvaluation: SpendOptimizationEvaluation | null;
  /** All bisection iterations recorded — for the UI to show the search
   *  trace if desired, and for tests/diagnostics. */
  trace: SpendOptimizationEvaluation[];
  /** Inputs echoed back. */
  searchRange: { min: number; max: number };
  targetSolventRate: number;
  /** The legacy-attainment floor used in the search. Null when there's
   *  no legacy goal in the seed (constraint is skipped). */
  targetLegacyAttainmentRate: number | null;
  trialCount: number;
  /** True when the bisection found a spend level satisfying BOTH
   *  constraints inside the search range. False when even the search
   *  floor violates a north star — i.e. the household's plan can't
   *  meet both constraints at any reasonable spend level. */
  feasible: boolean;
  /** When `feasible: false`, which constraint(s) bound the failure at
   *  the search floor. When `feasible: true`, which constraint was
   *  binding at the recommended spend level (the one the household
   *  would relax first to spend more). */
  bindingConstraint: SpendBindingConstraint;
}

interface SeedGoalsExtension {
  goals?: {
    legacyTargetTodayDollars?: number;
  };
}

/** Total annual spend implied by the seed's bucket-style spending. */
function getSeedAnnualSpend(seed: SeedData): number {
  const s = seed.spending;
  if (!s) return 0;
  return (
    s.essentialMonthly * 12 +
    s.optionalMonthly * 12 +
    s.travelEarlyRetirementAnnual +
    s.annualTaxesInsurance
  );
}

function toTodayDollars(
  nominal: number,
  inflation: number,
  horizonYears: number,
): number {
  const factor = Math.pow(
    1 + Math.max(-0.99, inflation),
    Math.max(0, horizonYears),
  );
  if (factor <= 0) return nominal;
  return nominal / factor;
}

/**
 * Run the engine at a single annual spend level. Pure — does not mutate
 * the seed; uses the engine's `annualSpendTarget` override.
 */
function evaluateAtSpend(
  seed: SeedData,
  assumptions: MarketAssumptions,
  annualSpend: number,
  legacyTarget: number,
): SpendOptimizationEvaluation {
  const paths = buildPathResults(seed, assumptions, [], [], {
    annualSpendTarget: annualSpend,
    pathMode: 'selected_only',
  });
  const path = paths[0];
  if (!path) {
    throw new Error('spend-optimizer: engine returned no path results');
  }
  const horizonYears = path.yearlySeries?.length ?? 30;
  const inflation = assumptions.inflation ?? 0.025;
  const deflate = (n: number) => toTodayDollars(n, inflation, horizonYears);
  const pcts = path.endingWealthPercentiles;
  const p10 = deflate(pcts.p10);
  const p25 = deflate(pcts.p25);
  const p50 = deflate(pcts.p50);
  const p75 = deflate(pcts.p75);
  const p90 = deflate(pcts.p90);
  const legacyAttainmentRate =
    legacyTarget > 0
      ? approximateBequestAttainmentRate(legacyTarget, {
          p10,
          p25,
          p50,
          p75,
          p90,
        })
      : null;
  return {
    annualSpendTodayDollars: annualSpend,
    solventSuccessRate: path.successRate,
    legacyAttainmentRate,
    p50EndingWealthTodayDollars: p50,
  };
}

/**
 * Test feasibility of an evaluation against the household's two
 * constraints. The legacy floor is skipped when no target is set.
 *
 * Returns the binding constraint (or null when feasible).
 */
function checkFeasibility(
  ev: SpendOptimizationEvaluation,
  solventTarget: number,
  legacyTarget: number | null,
  solventTolerance = 0,
): { feasible: boolean; binding: SpendBindingConstraint } {
  const solvencyFails = ev.solventSuccessRate + solventTolerance < solventTarget;
  const legacyFails =
    legacyTarget !== null &&
    ev.legacyAttainmentRate !== null &&
    ev.legacyAttainmentRate < legacyTarget;
  if (solvencyFails && legacyFails) return { feasible: false, binding: 'both' };
  if (solvencyFails) return { feasible: false, binding: 'solvency' };
  if (legacyFails) return { feasible: false, binding: 'legacy' };
  return { feasible: true, binding: null };
}

/**
 * Identify which constraint is "binding" at a feasible point — the
 * one closer to its threshold. Used to label the frontier ("legacy is
 * what stops you from spending more").
 */
function bindingAtFeasible(
  ev: SpendOptimizationEvaluation,
  solventTarget: number,
  legacyTarget: number | null,
): SpendBindingConstraint {
  const solvencyMargin = ev.solventSuccessRate - solventTarget;
  if (legacyTarget === null || ev.legacyAttainmentRate === null) {
    return 'solvency';
  }
  const legacyMargin = ev.legacyAttainmentRate - legacyTarget;
  if (Math.abs(solvencyMargin - legacyMargin) < 0.005) return 'both';
  return solvencyMargin < legacyMargin ? 'solvency' : 'legacy';
}

/**
 * Synchronous bisection. Deterministic given the same inputs (the
 * engine's RNG seed is fixed via assumptions). Now enforces BOTH
 * constraints (solvency AND legacy attainment when a target exists)
 * — feasibility means meeting the household's two stated north stars.
 *
 * NOTE: CPU-bound. For interactive contexts use the async wrapper to
 * yield between iterations.
 */
export function findMaxSustainableSpend(
  seed: SeedData,
  assumptions: MarketAssumptions,
  options: SpendOptimizationOptions = {},
): SpendOptimizationResult {
  const minSpend = options.minAnnualSpend ?? 40_000;
  const maxSpend = options.maxAnnualSpend ?? 300_000;
  const targetSolventRate = options.targetSolventRate ?? 0.85;
  const trialCount = options.trialCount ?? 500;
  const tolerance = options.toleranceDollars ?? 1_000;
  const maxIterations = options.maxIterations ?? 12;
  const legacyTargetDollars =
    options.legacyTargetTodayDollars ??
    (seed as SeedData & SeedGoalsExtension).goals?.legacyTargetTodayDollars ??
    0;
  // The legacy ATTAINMENT floor only applies when there's a legacy
  // goal at all. When `legacyTargetDollars` is 0, we skip the
  // attainment constraint entirely (a household that doesn't care
  // about leaving anything has only one north star).
  const targetLegacyAttainmentRate =
    legacyTargetDollars > 0 ? options.targetLegacyAttainmentRate ?? 0.85 : null;
  const solventTolerance = 1 / Math.max(1, trialCount);

  if (minSpend >= maxSpend) {
    throw new Error(
      `spend-optimizer: minAnnualSpend (${minSpend}) must be < maxAnnualSpend (${maxSpend})`,
    );
  }

  const cellAssumptions: MarketAssumptions = {
    ...assumptions,
    simulationRuns: trialCount,
  };

  const trace: SpendOptimizationEvaluation[] = [];

  // Step 1: bracket-test the lower bound. If the seed can't satisfy
  // BOTH constraints even at the search floor, declare infeasible —
  // the household's plan as-is violates a north star, and no spending
  // tweak fixes that. Strategy change is needed (SS, returns, etc.).
  const atMin = evaluateAtSpend(
    seed,
    cellAssumptions,
    minSpend,
    legacyTargetDollars,
  );
  trace.push(atMin);
  const minCheck = checkFeasibility(
    atMin,
    targetSolventRate,
    targetLegacyAttainmentRate,
    solventTolerance,
  );
  if (!minCheck.feasible) {
    const seedAnnualSpend = getSeedAnnualSpend(seed);
    let currentSeedEvaluation: SpendOptimizationEvaluation | null = null;
    if (seedAnnualSpend > 0) {
      currentSeedEvaluation = evaluateAtSpend(
        seed,
        cellAssumptions,
        seedAnnualSpend,
        legacyTargetDollars,
      );
      trace.push(currentSeedEvaluation);
    }
    return {
      recommendedAnnualSpendTodayDollars: minSpend,
      recommendedEvaluation: atMin,
      currentSeedEvaluation,
      trace,
      searchRange: { min: minSpend, max: maxSpend },
      targetSolventRate,
      targetLegacyAttainmentRate,
      trialCount,
      feasible: false,
      bindingConstraint: minCheck.binding,
    };
  }

  // Step 2: bracket-test the upper bound. If the seed satisfies BOTH
  // constraints at maxSpend too, the frontier sits above our search
  // range — report the cap so the caller can widen.
  const atMax = evaluateAtSpend(
    seed,
    cellAssumptions,
    maxSpend,
    legacyTargetDollars,
  );
  trace.push(atMax);
  const maxCheck = checkFeasibility(
    atMax,
    targetSolventRate,
    targetLegacyAttainmentRate,
    solventTolerance,
  );
  if (maxCheck.feasible) {
    const seedAnnualSpend = getSeedAnnualSpend(seed);
    let currentSeedEvaluation: SpendOptimizationEvaluation | null = null;
    if (seedAnnualSpend > 0) {
      currentSeedEvaluation = evaluateAtSpend(
        seed,
        cellAssumptions,
        seedAnnualSpend,
        legacyTargetDollars,
      );
      trace.push(currentSeedEvaluation);
    }
    return {
      recommendedAnnualSpendTodayDollars: maxSpend,
      recommendedEvaluation: atMax,
      currentSeedEvaluation,
      trace,
      searchRange: { min: minSpend, max: maxSpend },
      targetSolventRate,
      targetLegacyAttainmentRate,
      trialCount,
      feasible: true,
      bindingConstraint: bindingAtFeasible(
        atMax,
        targetSolventRate,
        targetLegacyAttainmentRate,
      ),
    };
  }

  // Step 3: bisection. Invariant: lo is feasible, hi is infeasible.
  // Both constraints are monotone-decreasing in spend (as we spend
  // more, both solvency and legacy attainment fall), so the feasible
  // region is a contiguous interval [minSpend, frontier]. We tighten
  // (lo, hi) until hi - lo < tolerance.
  let lo = minSpend;
  let loEval = atMin;
  let hi = maxSpend;
  let iteration = 0;
  while (hi - lo > tolerance && iteration < maxIterations) {
    if (options.isCancelled?.()) break;
    const mid = (lo + hi) / 2;
    const midEval = evaluateAtSpend(
      seed,
      cellAssumptions,
      mid,
      legacyTargetDollars,
    );
    trace.push(midEval);
    const midCheck = checkFeasibility(
      midEval,
      targetSolventRate,
      targetLegacyAttainmentRate,
      solventTolerance,
    );
    if (midCheck.feasible) {
      lo = mid;
      loEval = midEval;
    } else {
      hi = mid;
    }
    iteration += 1;
    options.onProgress?.(iteration, lo, hi);
  }

  // Step 4: evaluate the household's current lifestyle input for the
  // comparison panel. This is a reference point, not the optimized answer.
  // Skip if the input has zero spending.
  const seedAnnualSpend = getSeedAnnualSpend(seed);
  let currentSeedEvaluation: SpendOptimizationEvaluation | null = null;
  if (seedAnnualSpend > 0) {
    currentSeedEvaluation = evaluateAtSpend(
      seed,
      cellAssumptions,
      seedAnnualSpend,
      legacyTargetDollars,
    );
    trace.push(currentSeedEvaluation);
  }

  return {
    recommendedAnnualSpendTodayDollars: lo,
    recommendedEvaluation: loEval,
    currentSeedEvaluation,
    trace,
    searchRange: { min: minSpend, max: maxSpend },
    targetSolventRate,
    targetLegacyAttainmentRate,
    trialCount,
    feasible: true,
    bindingConstraint: bindingAtFeasible(
      loEval,
      targetSolventRate,
      targetLegacyAttainmentRate,
    ),
  };
}

/**
 * Yield-friendly async wrapper for browser contexts. Same dual-
 * constraint feasibility check as the sync version; awaits a microtask
 * between bisection iterations so the UI stays responsive. Total wall
 * time is identical.
 */
export async function findMaxSustainableSpendAsync(
  seed: SeedData,
  assumptions: MarketAssumptions,
  options: SpendOptimizationOptions = {},
): Promise<SpendOptimizationResult> {
  const minSpend = options.minAnnualSpend ?? 40_000;
  const maxSpend = options.maxAnnualSpend ?? 300_000;
  const targetSolventRate = options.targetSolventRate ?? 0.85;
  const trialCount = options.trialCount ?? 500;
  const tolerance = options.toleranceDollars ?? 1_000;
  const maxIterations = options.maxIterations ?? 12;
  const legacyTargetDollars =
    options.legacyTargetTodayDollars ??
    (seed as SeedData & SeedGoalsExtension).goals?.legacyTargetTodayDollars ??
    0;
  const targetLegacyAttainmentRate =
    legacyTargetDollars > 0 ? options.targetLegacyAttainmentRate ?? 0.85 : null;
  const solventTolerance = 1 / Math.max(1, trialCount);

  const cellAssumptions: MarketAssumptions = {
    ...assumptions,
    simulationRuns: trialCount,
  };

  const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));
  const trace: SpendOptimizationEvaluation[] = [];

  const atMin = evaluateAtSpend(
    seed,
    cellAssumptions,
    minSpend,
    legacyTargetDollars,
  );
  trace.push(atMin);
  await yieldNow();
  const minCheck = checkFeasibility(
    atMin,
    targetSolventRate,
    targetLegacyAttainmentRate,
    solventTolerance,
  );

  if (!minCheck.feasible) {
    const seedAnnualSpend = getSeedAnnualSpend(seed);
    let currentSeedEvaluation: SpendOptimizationEvaluation | null = null;
    if (seedAnnualSpend > 0) {
      currentSeedEvaluation = evaluateAtSpend(
        seed,
        cellAssumptions,
        seedAnnualSpend,
        legacyTargetDollars,
      );
      trace.push(currentSeedEvaluation);
      await yieldNow();
    }
    return {
      recommendedAnnualSpendTodayDollars: minSpend,
      recommendedEvaluation: atMin,
      currentSeedEvaluation,
      trace,
      searchRange: { min: minSpend, max: maxSpend },
      targetSolventRate,
      targetLegacyAttainmentRate,
      trialCount,
      feasible: false,
      bindingConstraint: minCheck.binding,
    };
  }

  const atMax = evaluateAtSpend(
    seed,
    cellAssumptions,
    maxSpend,
    legacyTargetDollars,
  );
  trace.push(atMax);
  await yieldNow();
  const maxCheck = checkFeasibility(
    atMax,
    targetSolventRate,
    targetLegacyAttainmentRate,
    solventTolerance,
  );

  if (maxCheck.feasible) {
    const seedAnnualSpend = getSeedAnnualSpend(seed);
    let currentSeedEvaluation: SpendOptimizationEvaluation | null = null;
    if (seedAnnualSpend > 0) {
      currentSeedEvaluation = evaluateAtSpend(
        seed,
        cellAssumptions,
        seedAnnualSpend,
        legacyTargetDollars,
      );
      trace.push(currentSeedEvaluation);
      await yieldNow();
    }
    return {
      recommendedAnnualSpendTodayDollars: maxSpend,
      recommendedEvaluation: atMax,
      currentSeedEvaluation,
      trace,
      searchRange: { min: minSpend, max: maxSpend },
      targetSolventRate,
      targetLegacyAttainmentRate,
      trialCount,
      feasible: true,
      bindingConstraint: bindingAtFeasible(
        atMax,
        targetSolventRate,
        targetLegacyAttainmentRate,
      ),
    };
  }

  let lo = minSpend;
  let loEval = atMin;
  let hi = maxSpend;
  let iteration = 0;
  while (hi - lo > tolerance && iteration < maxIterations) {
    if (options.isCancelled?.()) break;
    const mid = (lo + hi) / 2;
    const midEval = evaluateAtSpend(
      seed,
      cellAssumptions,
      mid,
      legacyTargetDollars,
    );
    trace.push(midEval);
    const midCheck = checkFeasibility(
      midEval,
      targetSolventRate,
      targetLegacyAttainmentRate,
      solventTolerance,
    );
    if (midCheck.feasible) {
      lo = mid;
      loEval = midEval;
    } else {
      hi = mid;
    }
    iteration += 1;
    options.onProgress?.(iteration, lo, hi);
    // eslint-disable-next-line no-await-in-loop
    await yieldNow();
  }

  const seedAnnualSpend = getSeedAnnualSpend(seed);
  let currentSeedEvaluation: SpendOptimizationEvaluation | null = null;
  if (seedAnnualSpend > 0) {
    currentSeedEvaluation = evaluateAtSpend(
      seed,
      cellAssumptions,
      seedAnnualSpend,
      legacyTargetDollars,
    );
    trace.push(currentSeedEvaluation);
  }

  return {
    recommendedAnnualSpendTodayDollars: lo,
    recommendedEvaluation: loEval,
    currentSeedEvaluation,
    trace,
    searchRange: { min: minSpend, max: maxSpend },
    targetSolventRate,
    targetLegacyAttainmentRate,
    trialCount,
    feasible: true,
    bindingConstraint: bindingAtFeasible(
      loEval,
      targetSolventRate,
      targetLegacyAttainmentRate,
    ),
  };
}
