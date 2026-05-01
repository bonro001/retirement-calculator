import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { approximateBequestAttainmentRate } from './plan-evaluation';

/**
 * Roth-conversion-ceiling optimizer.
 *
 * Treats the Roth conversion annual ceiling as a strategy lever the
 * engine selects, not a knob the household sets. Mirrors the SS and
 * spend optimizers' constraint-satisfaction objective:
 *
 *   - Filter: candidate must satisfy BOTH north stars (solvency floor
 *     AND legacy-attainment floor when a legacy goal exists).
 *   - Rank: among feasible candidates, maximize p50 ending wealth in
 *     today's $ (Roth conversions trade slightly higher near-term tax
 *     for tax-free legacy growth — the right metric is real legacy
 *     wealth, not solvency margin).
 *
 * Architectural intent: this runs AFTER the SS optimizer and the spend
 * optimizer, so the joint plan being evaluated is "recommended SS,
 * recommended max spend, sweep Roth ceiling". That isolates the Roth
 * decision and gives the household a clean read on "given the rest of
 * my plan, how aggressively should I convert?"
 *
 * V1 caveat: the engine reads `magiBufferDollars` from
 * `seed.rules.rothConversionPolicy` as a proxy for the per-year cap
 * (see `policy-miner-eval.ts:applyPolicyToSeed`). That's the same
 * proxy the policy mine uses, so the optimizer's results are directly
 * comparable to mine corpus rows. A future engine PR that adds a real
 * per-year ceiling parameter will let this optimizer drop the proxy.
 *
 * Cost: 6 ceiling levels × ~3s = ~18s on first paint at 500 trials,
 * cached by seed fingerprint thereafter. Same cost class as the SS
 * optimizer.
 */

export type RothBindingConstraint = 'solvency' | 'legacy' | 'both' | null;

export interface RothCeilingCandidate {
  /** Annual ceiling in today's dollars. 0 means "no conversions." */
  ceilingTodayDollars: number;
  solventSuccessRate: number;
  /** 1 when no legacy goal is set (the bequest is then just decorative). */
  bequestAttainmentRate: number;
  p10EndingWealthTodayDollars: number;
  p50EndingWealthTodayDollars: number;
  p90EndingWealthTodayDollars: number;
  /** Median annual federal-tax estimate from the engine (nominal $). */
  medianAnnualFederalTaxEstimate: number;
  /** Whether this ceiling satisfies BOTH north stars. */
  meetsNorthStars: boolean;
  bindingConstraint: RothBindingConstraint;
}

export interface RothOptimizationOptions {
  /** Ceiling levels to evaluate. Defaults to the V1 policy-axis enumerator's
   *  6-level grid: [0, 40k, 80k, 120k, 160k, 200k]. */
  ceilingLevels?: number[];
  /** Trials per cell. Default 500. */
  trialCount?: number;
  /** Bequest target in today's dollars. Defaults to
   *  `seed.goals?.legacyTargetTodayDollars` if present. */
  legacyTargetTodayDollars?: number;
  /** Solvency floor for constraint satisfaction. Default 0.85. */
  targetSolventRate?: number;
  /** Legacy-attainment floor. Default 0.85 when a legacy goal exists,
   *  null when not. */
  targetLegacyAttainmentRate?: number | null;
  /** Optional progress callback fired after each cell completes. */
  onProgress?: (completed: number, total: number) => void;
  /** Optional cancellation signal. Checked between cells. */
  isCancelled?: () => boolean;
}

export interface RothOptimizationResult {
  /** Every ceiling level evaluated, ranked best-first by the objective. */
  ranked: RothCeilingCandidate[];
  /** `ranked[0]` — the recommended ceiling. */
  recommended: RothCeilingCandidate;
  /** Number of candidates that met BOTH constraints. When zero, no
   *  Roth ceiling rescues the plan from constraint violation —
   *  Roth strategy alone isn't the lever. */
  feasibleCount: number;
  /** Inputs echoed back. */
  trialCount: number;
  targetSolventRate: number;
  targetLegacyAttainmentRate: number | null;
}

interface SeedGoalsExtension {
  goals?: {
    legacyTargetTodayDollars?: number;
  };
}

const DEFAULT_CEILING_LEVELS = [0, 40_000, 80_000, 120_000, 160_000, 200_000];

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
 * Apply a Roth conversion ceiling to a seed clone. Mirrors
 * `applyPolicyToSeed` in `policy-miner-eval.ts` for the Roth knob —
 * uses `magiBufferDollars` as the V1 proxy for per-year ceiling.
 */
function cloneSeedWithRothCeiling(
  seed: SeedData,
  ceilingTodayDollars: number,
): SeedData {
  const clone = JSON.parse(JSON.stringify(seed)) as SeedData;
  if (!clone.rules) return clone;
  clone.rules.rothConversionPolicy = {
    ...(clone.rules.rothConversionPolicy ?? {}),
    enabled: ceilingTodayDollars > 0,
    minAnnualDollars: 0,
    magiBufferDollars: ceilingTodayDollars,
  };
  return clone;
}

function checkFeasibility(
  candidate: RothCeilingCandidate,
  solventTarget: number,
  legacyTarget: number | null,
): { feasible: boolean; binding: RothBindingConstraint } {
  const solvencyFails = candidate.solventSuccessRate < solventTarget;
  const legacyFails =
    legacyTarget !== null &&
    candidate.bequestAttainmentRate < legacyTarget;
  if (solvencyFails && legacyFails) return { feasible: false, binding: 'both' };
  if (solvencyFails) return { feasible: false, binding: 'solvency' };
  if (legacyFails) return { feasible: false, binding: 'legacy' };
  return { feasible: true, binding: null };
}

/**
 * Score: feasibility-tier first (1 if meets both north stars, 0 if not),
 * then maximize p50 ending wealth in today's $. Ties broken by lower
 * federal-tax estimate (prefer the conversion strategy that reduces
 * lifetime tax drag).
 */
function scoreCandidate(c: RothCeilingCandidate): [number, number, number] {
  return [
    c.meetsNorthStars ? 1 : 0,
    c.p50EndingWealthTodayDollars,
    -c.medianAnnualFederalTaxEstimate, // lower tax wins → negate so higher is better
  ];
}

function compareCandidates(
  a: RothCeilingCandidate,
  b: RothCeilingCandidate,
): number {
  const sa = scoreCandidate(a);
  const sb = scoreCandidate(b);
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return sb[i] - sa[i]; // descending
  }
  return 0;
}

/**
 * Synchronous optimizer. Run the engine at each ceiling level; rank.
 * The seed passed in is expected to be the joint-optimum seed —
 * recommended SS already applied — so the Roth decision is isolated
 * to the right plan context. The annual spend override is passed via
 * the caller's `assumptions.simulationRuns`-controlled call setup.
 */
export function findOptimalRothCeiling(
  seed: SeedData,
  assumptions: MarketAssumptions,
  /** Annual spend target (today's $) to project at. The Cockpit passes
   *  the spend optimizer's recommendation here so all three optimizers
   *  agree on the planning baseline. */
  annualSpendTarget: number,
  options: RothOptimizationOptions = {},
): RothOptimizationResult {
  const ceilingLevels = options.ceilingLevels ?? DEFAULT_CEILING_LEVELS;
  const trialCount = options.trialCount ?? 500;
  const legacyTarget =
    options.legacyTargetTodayDollars ??
    (seed as SeedData & SeedGoalsExtension).goals?.legacyTargetTodayDollars ??
    0;
  const targetSolventRate = options.targetSolventRate ?? 0.85;
  const targetLegacyAttainmentRate =
    legacyTarget > 0
      ? options.targetLegacyAttainmentRate === undefined
        ? 0.85
        : options.targetLegacyAttainmentRate
      : null;

  const cellAssumptions: MarketAssumptions = {
    ...assumptions,
    simulationRuns: trialCount,
  };

  const candidates: RothCeilingCandidate[] = [];
  let completed = 0;
  for (const ceiling of ceilingLevels) {
    if (options.isCancelled?.()) break;
    const candidateSeed = cloneSeedWithRothCeiling(seed, ceiling);
    let path;
    try {
      const paths = buildPathResults(candidateSeed, cellAssumptions, [], [], {
        annualSpendTarget,
        pathMode: 'selected_only',
      });
      path = paths[0];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[roth-optimizer] cell ceiling=${ceiling} failed:`,
        err,
      );
      completed += 1;
      options.onProgress?.(completed, ceilingLevels.length);
      continue;
    }
    if (!path) {
      completed += 1;
      options.onProgress?.(completed, ceilingLevels.length);
      continue;
    }
    const horizonYears = path.yearlySeries?.length ?? 30;
    const inflation = assumptions.inflation ?? 0.025;
    const deflate = (n: number) => toTodayDollars(n, inflation, horizonYears);
    const p10 = deflate(path.endingWealthPercentiles.p10);
    const p25 = deflate(path.endingWealthPercentiles.p25);
    const p50 = deflate(path.endingWealthPercentiles.p50);
    const p75 = deflate(path.endingWealthPercentiles.p75);
    const p90 = deflate(path.endingWealthPercentiles.p90);
    const bequestAttainmentRate =
      legacyTarget > 0
        ? approximateBequestAttainmentRate(legacyTarget, {
            p10,
            p25,
            p50,
            p75,
            p90,
          })
        : 1;
    const draft: RothCeilingCandidate = {
      ceilingTodayDollars: ceiling,
      solventSuccessRate: path.successRate,
      bequestAttainmentRate,
      p10EndingWealthTodayDollars: p10,
      p50EndingWealthTodayDollars: p50,
      p90EndingWealthTodayDollars: p90,
      medianAnnualFederalTaxEstimate: path.annualFederalTaxEstimate ?? 0,
      meetsNorthStars: false,
      bindingConstraint: null,
    };
    const feasibility = checkFeasibility(
      draft,
      targetSolventRate,
      targetLegacyAttainmentRate,
    );
    draft.meetsNorthStars = feasibility.feasible;
    draft.bindingConstraint = feasibility.binding;
    candidates.push(draft);
    completed += 1;
    options.onProgress?.(completed, ceilingLevels.length);
  }

  if (candidates.length === 0) {
    throw new Error(
      'roth-optimizer: produced no valid candidates — check seed has pretax balance and engine is healthy',
    );
  }

  const ranked = candidates.slice().sort(compareCandidates);
  return {
    ranked,
    recommended: ranked[0],
    feasibleCount: candidates.filter((c) => c.meetsNorthStars).length,
    trialCount,
    targetSolventRate,
    targetLegacyAttainmentRate,
  };
}

/**
 * Yield-friendly async wrapper. Awaits a microtask between cells so
 * the UI stays responsive.
 */
export async function findOptimalRothCeilingAsync(
  seed: SeedData,
  assumptions: MarketAssumptions,
  annualSpendTarget: number,
  options: RothOptimizationOptions = {},
): Promise<RothOptimizationResult> {
  const ceilingLevels = options.ceilingLevels ?? DEFAULT_CEILING_LEVELS;
  const trialCount = options.trialCount ?? 500;
  const legacyTarget =
    options.legacyTargetTodayDollars ??
    (seed as SeedData & SeedGoalsExtension).goals?.legacyTargetTodayDollars ??
    0;
  const targetSolventRate = options.targetSolventRate ?? 0.85;
  const targetLegacyAttainmentRate =
    legacyTarget > 0
      ? options.targetLegacyAttainmentRate === undefined
        ? 0.85
        : options.targetLegacyAttainmentRate
      : null;

  const cellAssumptions: MarketAssumptions = {
    ...assumptions,
    simulationRuns: trialCount,
  };

  const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));
  const candidates: RothCeilingCandidate[] = [];
  let completed = 0;

  for (const ceiling of ceilingLevels) {
    if (options.isCancelled?.()) break;
    const candidateSeed = cloneSeedWithRothCeiling(seed, ceiling);
    let path;
    try {
      const paths = buildPathResults(candidateSeed, cellAssumptions, [], [], {
        annualSpendTarget,
        pathMode: 'selected_only',
      });
      path = paths[0];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[roth-optimizer] cell ceiling=${ceiling} failed:`,
        err,
      );
      completed += 1;
      options.onProgress?.(completed, ceilingLevels.length);
      // eslint-disable-next-line no-await-in-loop
      await yieldNow();
      continue;
    }
    if (!path) {
      completed += 1;
      options.onProgress?.(completed, ceilingLevels.length);
      // eslint-disable-next-line no-await-in-loop
      await yieldNow();
      continue;
    }
    const horizonYears = path.yearlySeries?.length ?? 30;
    const inflation = assumptions.inflation ?? 0.025;
    const deflate = (n: number) => toTodayDollars(n, inflation, horizonYears);
    const p10 = deflate(path.endingWealthPercentiles.p10);
    const p25 = deflate(path.endingWealthPercentiles.p25);
    const p50 = deflate(path.endingWealthPercentiles.p50);
    const p75 = deflate(path.endingWealthPercentiles.p75);
    const p90 = deflate(path.endingWealthPercentiles.p90);
    const bequestAttainmentRate =
      legacyTarget > 0
        ? approximateBequestAttainmentRate(legacyTarget, {
            p10,
            p25,
            p50,
            p75,
            p90,
          })
        : 1;
    const draft: RothCeilingCandidate = {
      ceilingTodayDollars: ceiling,
      solventSuccessRate: path.successRate,
      bequestAttainmentRate,
      p10EndingWealthTodayDollars: p10,
      p50EndingWealthTodayDollars: p50,
      p90EndingWealthTodayDollars: p90,
      medianAnnualFederalTaxEstimate: path.annualFederalTaxEstimate ?? 0,
      meetsNorthStars: false,
      bindingConstraint: null,
    };
    const feasibility = checkFeasibility(
      draft,
      targetSolventRate,
      targetLegacyAttainmentRate,
    );
    draft.meetsNorthStars = feasibility.feasible;
    draft.bindingConstraint = feasibility.binding;
    candidates.push(draft);
    completed += 1;
    options.onProgress?.(completed, ceilingLevels.length);
    // eslint-disable-next-line no-await-in-loop
    await yieldNow();
  }

  if (candidates.length === 0) {
    throw new Error(
      'roth-optimizer (async): produced no valid candidates',
    );
  }

  const ranked = candidates.slice().sort(compareCandidates);
  return {
    ranked,
    recommended: ranked[0],
    feasibleCount: candidates.filter((c) => c.meetsNorthStars).length,
    trialCount,
    targetSolventRate,
    targetLegacyAttainmentRate,
  };
}
