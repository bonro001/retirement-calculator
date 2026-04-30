import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { approximateBequestAttainmentRate } from './plan-evaluation';
import {
  projectAnnualSocialSecurityIncome,
  totalLifetimeSocialSecurityTodayDollars,
  type SocialSecurityEarner,
} from './social-security';

/**
 * Social Security claim-age optimizer.
 *
 * Treats SS claim age as a *strategy lever* (like Roth conversion timing
 * or withdrawal cascade priority) — i.e. an OUTPUT of the engine, not an
 * input the household has to guess. Given the household's seed (current
 * spending, accounts, goals), it sweeps the SS claim-age axis and returns
 * the pair that best satisfies the north-star objective:
 *
 *   1. maximize solvent success rate (don't run out of money)
 *   2. tie-break: maximize bequest attainment vs the legacy target
 *   3. tie-break: maximize p50 ending wealth in today's dollars
 *
 * Why a separate, focused optimizer rather than reading from the policy
 * mining corpus: the corpus may be stale, partially populated, or absent
 * on first visit. This function runs a small (≤81-cell) sweep cheaply
 * and deterministically against the household's *current* seed, with no
 * dependency on the corpus or the cluster.
 *
 * Cost: at default `trialCount: 500` and 36 cells (65-70 × 65-70), one
 * full sweep is ~16s single-threaded — comparable to a single Cockpit
 * baseline render. Callers should cache by seed fingerprint.
 */

export type SocialSecurityBindingConstraint =
  | 'solvency'
  | 'legacy'
  | 'both'
  | null;

export interface SocialSecurityClaimCandidate {
  primaryAge: number;
  spouseAge: number | null;
  solventSuccessRate: number;
  bequestAttainmentRate: number;
  p10EndingWealthTodayDollars: number;
  p50EndingWealthTodayDollars: number;
  p90EndingWealthTodayDollars: number;
  /** Lifetime SS income (today's $) implied by this claim pair. Useful
   *  for displaying "claim later → bigger lifetime SS" framing in the UI. */
  approximateLifetimeSocialSecurityTodayDollars: number;
  /** True iff this candidate satisfies BOTH the solvency and legacy
   *  attainment floors (with legacy being skipped when no legacy
   *  target is provided). */
  meetsNorthStars: boolean;
  /** When `meetsNorthStars` is false, which constraint(s) bound. */
  bindingConstraint: SocialSecurityBindingConstraint;
}

export interface SocialSecurityOptimizationOptions {
  /** Lower bound on claim ages searched. Default 65 to match the V1
   *  policy-axis enumerator's household preference. Pass 62 for full SS
   *  range. */
  minClaimAge?: number;
  /** Upper bound on claim ages searched. Default 70 (max SS delayed
   *  retirement credit). */
  maxClaimAge?: number;
  /** Step between ages. Default 1 (yearly granularity). */
  ageStep?: number;
  /** Trials per cell. Default 500 — fast enough to run interactively in
   *  the Cockpit, accurate enough to rank candidates within ~1pp. Bump
   *  to 2000+ for publication-grade rankings. */
  trialCount?: number;
  /** Bequest target in today's dollars. If 0/null, the optimizer drops
   *  the bequest tie-break and ranks on solvent + p50 EW only. Defaults
   *  to `seed.goals?.legacyTargetTodayDollars` if present. */
  legacyTargetTodayDollars?: number;
  /** When set, candidates that meet BOTH constraints (solvent ≥
   *  `targetSolventRate` AND legacy attainment ≥
   *  `targetLegacyAttainmentRate`) are ranked AHEAD of any candidate
   *  that fails either. Within each tier (feasible / infeasible),
   *  the tuple (solvent, legacy, p50 EW) still orders. Defaults reflect
   *  the household's stated north stars (85% / 85%). Pass null for the
   *  legacy floor to drop that constraint. */
  targetSolventRate?: number;
  targetLegacyAttainmentRate?: number | null;
  /** Optional progress callback fired after each cell completes. */
  onProgress?: (completedCells: number, totalCells: number) => void;
  /** Optional cancellation signal. Checked between cells. */
  isCancelled?: () => boolean;
}

export interface SocialSecurityOptimizationResult {
  /** Every candidate evaluated, ranked best-first by the objective.
   *  Constraint-satisfying candidates always rank ahead of failing
   *  candidates; within each tier the tuple (solvent, legacy, p50 EW)
   *  orders. */
  ranked: SocialSecurityClaimCandidate[];
  /** Convenience: `ranked[0]`. */
  recommended: SocialSecurityClaimCandidate;
  /** The candidate matching the seed's *current* claim ages, for
   *  comparison. May be null if the seed's claim ages fall outside the
   *  searched range. */
  currentSeedCandidate: SocialSecurityClaimCandidate | null;
  /** Whether a spouse SS record was present in the seed. When false, the
   *  spouse axis is collapsed (spouseAge: null on every candidate). */
  hasSpouse: boolean;
  /** Searched age range, echoed back for the UI label. */
  ageRange: { min: number; max: number; step: number };
  /** Trial count used per cell. */
  trialCount: number;
  /** The constraint thresholds used for ranking. */
  targetSolventRate: number;
  targetLegacyAttainmentRate: number | null;
  /** Number of candidates that met BOTH north stars. When zero, no SS
   *  claim pair satisfies the household's stated goals — the issue is
   *  elsewhere (spending too high, returns too low, runway too thin). */
  feasibleCount: number;
}

interface SeedGoalsExtension {
  goals?: {
    legacyTargetTodayDollars?: number;
  };
}

/**
 * Inflation-deflate a nominal future-dollar amount to today's dollars.
 * Mirrors the deflation used elsewhere (policy-miner-eval, spend-solver).
 */
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
 * Approximate the lifetime SS payout in today's dollars for a given
 * claim pair. Doesn't run the engine — uses the seed's FRA monthly
 * benefits and the standard SS adjustment factors (8% delayed-retirement
 * credit per year past FRA, ~6.67%/yr reduction for early claim) and a
 * default longevity assumption.
 *
 * This is for display only — the optimizer's ranking uses the ACTUAL
 * engine output. If a household wants to see "claim 70 = $X more
 * lifetime SS," this gives them that number without spinning the engine.
 */
function approximateLifetimeSocialSecurity(
  seed: SeedData,
  primaryAge: number,
  spouseAge: number | null,
  longevityAge = 90,
): number {
  // Delegates to the enriched `social-security.ts` module which now
  // handles:
  //   - SSA-precise own-claim adjustment (5/9 of 1%/mo + 5/12 of 1%/mo
  //     for early; 8%/yr DRC capped at 70 for delayed)
  //   - Spousal-benefit floor (lower earner gets max(own, 50% × higher
  //     PIA) — non-trivial for Rob/Debbie's $4,100/$2,000 split)
  //   - Survivor switch (when higher earner dies, surviving spouse
  //     converts to 100% of higher earner's claim amount — preserves
  //     the value of delaying the higher earner's claim past 70)
  //
  // For display only — the optimizer's RANKING still comes from the
  // engine's actual buildPathResults run, which uses the seed's
  // simpler model. When the engine integration of this module lands
  // (BACKLOG: "Beef up Social Security modeling"), the ranking will
  // align with the lifetime number shown here. Until then, expect
  // small directional disagreements between the two when Rob/Debbie's
  // claim ages are very asymmetric.
  const ssEntries = seed.income?.socialSecurity ?? [];
  if (!ssEntries[0]) return 0;
  const robBirthYear = seed.household?.robBirthDate
    ? new Date(seed.household.robBirthDate).getUTCFullYear()
    : 1965;
  const debbieBirthYear = seed.household?.debbieBirthDate
    ? new Date(seed.household.debbieBirthDate).getUTCFullYear()
    : robBirthYear;
  const earner1: SocialSecurityEarner = {
    person: ssEntries[0].person ?? 'primary',
    fraMonthly: ssEntries[0].fraMonthly ?? 0,
    claimAge: primaryAge,
    birthYear: robBirthYear,
    assumedDeathAge: longevityAge,
  };
  const earner2: SocialSecurityEarner | null =
    ssEntries[1] && spouseAge !== null
      ? {
          person: ssEntries[1].person ?? 'spouse',
          fraMonthly: ssEntries[1].fraMonthly ?? 0,
          claimAge: spouseAge,
          birthYear: debbieBirthYear,
          assumedDeathAge: longevityAge,
        }
      : null;
  // Project from current year through `longevityAge`. The schedule
  // returns today's-dollar amounts (COLA-adjusted == inflation-
  // matched), so we sum directly.
  const currentYear = new Date().getUTCFullYear();
  const lastYear = robBirthYear + longevityAge;
  const schedule = projectAnnualSocialSecurityIncome(
    earner1,
    earner2,
    currentYear,
    lastYear,
    67, // FRA — anyone born after 1960 has FRA=67
  );
  return totalLifetimeSocialSecurityTodayDollars(schedule);
}

/**
 * Clone a seed and apply a candidate SS claim pair to it. Pure — does
 * not touch the input seed. Uses JSON round-trip clone (the engine does
 * its own deep clone internally too, but we want to be defensive).
 */
function cloneSeedWithSocialSecurityClaim(
  seed: SeedData,
  primaryAge: number,
  spouseAge: number | null,
): SeedData {
  const clone = JSON.parse(JSON.stringify(seed)) as SeedData;
  if (clone.income?.socialSecurity?.[0]) {
    clone.income.socialSecurity[0].claimAge = primaryAge;
  }
  if (clone.income?.socialSecurity?.[1] && spouseAge !== null) {
    clone.income.socialSecurity[1].claimAge = spouseAge;
  }
  return clone;
}

/**
 * Test feasibility of a candidate against the household's two
 * constraints. Mirrors `checkFeasibility` in `spend-optimizer.ts`.
 */
function checkCandidateFeasibility(
  candidate: SocialSecurityClaimCandidate,
  solventTarget: number,
  legacyTarget: number | null,
): { feasible: boolean; binding: SocialSecurityBindingConstraint } {
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
 * Score a candidate as a tuple. Higher tuple compares better
 * lexicographically. The first component encodes the constraint-
 * satisfaction tier (1 = meets both north stars, 0 = doesn't), so
 * feasible candidates always outrank infeasible ones.
 *
 * Within each tier we rank legacy-first to match the household's
 * stated value system: among plans that pass both north stars (or
 * none, when none do), prefer the one most likely to leave the
 * bequest, then most resilient, then fattest median. This aligns
 * with `policy-ranker.LEGACY_FIRST_LEXICOGRAPHIC` so the cockpit's
 * recommendation card and the mining corpus's top-1 pick converge.
 *
 * Pre-2026-05-01 this was solvency-first, which surfaced strategies
 * that had marginally tighter solvency cushion but left tens of
 * thousands of dollars of spousal-step-up SS income on the table
 * (e.g., recommending Debbie @ 70 instead of Debbie @ 67 with the
 * step-up at 70).
 */
function scoreCandidate(
  candidate: SocialSecurityClaimCandidate,
  legacyTarget: number,
): [number, number, number, number] {
  return [
    candidate.meetsNorthStars ? 1 : 0,
    legacyTarget > 0 ? candidate.bequestAttainmentRate : 0,
    candidate.solventSuccessRate,
    candidate.p50EndingWealthTodayDollars,
  ];
}

function compareCandidates(
  a: SocialSecurityClaimCandidate,
  b: SocialSecurityClaimCandidate,
  legacyTarget: number,
): number {
  const sa = scoreCandidate(a, legacyTarget);
  const sb = scoreCandidate(b, legacyTarget);
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return sb[i] - sa[i]; // descending
  }
  return 0;
}

/**
 * Run the SS optimization. Synchronous & deterministic given the same
 * inputs (the engine's internal RNG seed comes from `assumptions`).
 *
 * NOTE: this is CPU-bound. Callers in interactive contexts should run
 * it in a Web Worker or off the main thread to avoid blocking the UI.
 * Server-side / test contexts can call it directly.
 */
export function findOptimalSocialSecurityClaim(
  seed: SeedData,
  assumptions: MarketAssumptions,
  options: SocialSecurityOptimizationOptions = {},
): SocialSecurityOptimizationResult {
  const minAge = options.minClaimAge ?? 65;
  const maxAge = options.maxClaimAge ?? 70;
  const step = options.ageStep ?? 1;
  const trialCount = options.trialCount ?? 500;
  const legacyTarget =
    options.legacyTargetTodayDollars ??
    (seed as SeedData & SeedGoalsExtension).goals?.legacyTargetTodayDollars ??
    0;
  const targetSolventRate = options.targetSolventRate ?? 0.85;
  // The legacy attainment floor only applies when there's a legacy
  // goal at all. Default 0.85 — matches "north star 1: leave $1M in
  // today's dollars."
  const targetLegacyAttainmentRate =
    legacyTarget > 0
      ? options.targetLegacyAttainmentRate === undefined
        ? 0.85
        : options.targetLegacyAttainmentRate
      : null;

  const ssEntries = seed.income?.socialSecurity ?? [];
  const hasSpouse = ssEntries.length >= 2;

  // Build the age list. Preserve order so cancellation is well-defined.
  const ages: number[] = [];
  for (let a = minAge; a <= maxAge; a += step) ages.push(a);

  // Cells: every (primary, spouse) pair, or just (primary,) if no spouse.
  const spouseAges: (number | null)[] = hasSpouse ? ages.slice() : [null];
  const totalCells = ages.length * spouseAges.length;

  const cellAssumptions: MarketAssumptions = {
    ...assumptions,
    simulationRuns: trialCount,
  };

  const candidates: SocialSecurityClaimCandidate[] = [];
  let completed = 0;
  for (const primaryAge of ages) {
    for (const spouseAge of spouseAges) {
      if (options.isCancelled?.()) {
        // Bail out early. Caller gets whatever we've computed so far.
        break;
      }
      const candidateSeed = cloneSeedWithSocialSecurityClaim(
        seed,
        primaryAge,
        spouseAge,
      );
      let path;
      try {
        const paths = buildPathResults(
          candidateSeed,
          cellAssumptions,
          [],
          [],
          { pathMode: 'selected_only' },
        );
        path = paths[0];
      } catch (err) {
        // One bad cell shouldn't strand the whole sweep — log and skip.
        // (Mirrors the dust-balance-pretax fix in the Roth path.)
        // eslint-disable-next-line no-console
        console.warn(
          `[ss-optimizer] cell (${primaryAge}, ${spouseAge}) failed:`,
          err,
        );
        completed += 1;
        options.onProgress?.(completed, totalCells);
        continue;
      }
      if (!path) {
        completed += 1;
        options.onProgress?.(completed, totalCells);
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
      const draft: SocialSecurityClaimCandidate = {
        primaryAge,
        spouseAge,
        solventSuccessRate: path.successRate,
        bequestAttainmentRate,
        p10EndingWealthTodayDollars: p10,
        p50EndingWealthTodayDollars: p50,
        p90EndingWealthTodayDollars: p90,
        approximateLifetimeSocialSecurityTodayDollars:
          approximateLifetimeSocialSecurity(seed, primaryAge, spouseAge),
        meetsNorthStars: false,
        bindingConstraint: null,
      };
      const feasibility = checkCandidateFeasibility(
        draft,
        targetSolventRate,
        targetLegacyAttainmentRate,
      );
      draft.meetsNorthStars = feasibility.feasible;
      draft.bindingConstraint = feasibility.binding;
      candidates.push(draft);
      completed += 1;
      options.onProgress?.(completed, totalCells);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      'ss-optimizer: produced no valid candidates — check seed has a SS record and engine is healthy',
    );
  }

  const ranked = candidates.slice().sort((a, b) =>
    compareCandidates(a, b, legacyTarget),
  );

  // Find the candidate matching the seed's current claim ages.
  const seedPrimary = ssEntries[0]?.claimAge ?? null;
  const seedSpouse = hasSpouse ? ssEntries[1]?.claimAge ?? null : null;
  const currentSeedCandidate =
    candidates.find(
      (c) =>
        c.primaryAge === seedPrimary &&
        c.spouseAge === seedSpouse,
    ) ?? null;

  return {
    ranked,
    recommended: ranked[0],
    currentSeedCandidate,
    hasSpouse,
    ageRange: { min: minAge, max: maxAge, step },
    trialCount,
    targetSolventRate,
    targetLegacyAttainmentRate,
    feasibleCount: candidates.filter((c) => c.meetsNorthStars).length,
  };
}

/**
 * Yield-friendly async wrapper for browser contexts. Runs the optimizer
 * cell-by-cell, awaiting a microtask/macrotask break between cells so
 * the React render cycle and event loop stay responsive. No Web Worker —
 * the engine runs on the same thread but doesn't monopolize it.
 *
 * For Node / test contexts use the synchronous `findOptimalSocialSecurityClaim`.
 *
 * The implementation deliberately mirrors the sync version's logic
 * rather than wrapping it (we need the yield point to live INSIDE the
 * cell loop). Keep these in sync if the scoring or shape changes.
 */
export async function findOptimalSocialSecurityClaimAsync(
  seed: SeedData,
  assumptions: MarketAssumptions,
  options: SocialSecurityOptimizationOptions = {},
): Promise<SocialSecurityOptimizationResult> {
  const minAge = options.minClaimAge ?? 65;
  const maxAge = options.maxClaimAge ?? 70;
  const step = options.ageStep ?? 1;
  const trialCount = options.trialCount ?? 500;

  const ages: number[] = [];
  for (let a = minAge; a <= maxAge; a += step) ages.push(a);
  const hasSpouse = (seed.income?.socialSecurity?.length ?? 0) >= 2;
  const spouseAges: (number | null)[] = hasSpouse ? ages.slice() : [null];

  // Run the sweep one PRIMARY age at a time, yielding between primary
  // ages. Each primary-age call internally sweeps the spouse axis. So
  // for a 6×6=36 cell sweep we yield 6 times (~3s of CPU per yield) —
  // not great per-cell granularity, but enough to keep the UI from
  // looking frozen, and avoids re-cloning seed state per-cell.
  const collected: SocialSecurityClaimCandidate[] = [];
  let completed = 0;
  const totalCells = ages.length * spouseAges.length;
  for (const primaryAge of ages) {
    if (options.isCancelled?.() && collected.length > 0) break;
    const partial = findOptimalSocialSecurityClaim(seed, assumptions, {
      ...options,
      minClaimAge: primaryAge,
      maxClaimAge: primaryAge,
      ageStep: 1,
      trialCount,
      // Don't double-fire onProgress: the sub-call's own onProgress
      // would report (1/N, 2/N, ...) per primary-age slice. We tally
      // at the outer level for a single coherent progress signal.
      onProgress: undefined,
    });
    for (const candidate of partial.ranked) {
      collected.push(candidate);
      completed += 1;
      options.onProgress?.(completed, totalCells);
    }
    // Yield to the event loop so React can flush a frame.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (collected.length === 0) {
    // Defensive — shouldn't happen unless every cell threw.
    throw new Error(
      'ss-optimizer (async): produced no valid candidates',
    );
  }

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
  const ranked = collected.slice().sort((a, b) =>
    compareCandidates(a, b, legacyTarget),
  );
  const seedPrimary = seed.income?.socialSecurity?.[0]?.claimAge ?? null;
  const seedSpouse = hasSpouse
    ? seed.income?.socialSecurity?.[1]?.claimAge ?? null
    : null;
  const currentSeedCandidate =
    collected.find(
      (c) => c.primaryAge === seedPrimary && c.spouseAge === seedSpouse,
    ) ?? null;

  return {
    ranked,
    recommended: ranked[0],
    currentSeedCandidate,
    hasSpouse,
    ageRange: { min: minAge, max: maxAge, step },
    trialCount,
    targetSolventRate,
    targetLegacyAttainmentRate,
    feasibleCount: collected.filter((c) => c.meetsNorthStars).length,
  };
}
