import {
  applyPolicyToSeed,
  type SeedDataCloner,
} from './policy-miner-eval';
import { approximateBequestAttainmentRate } from './plan-evaluation';
import { buildPathResults, type SimulationStressorKnobs } from './utils';
import type { Policy } from './policy-miner-types';
import type { MarketAssumptions, SeedData } from './types';

/**
 * E.6 — Stress-test the adopted policy.
 *
 * After the household clicks "Adopt" on a mined policy, the obvious
 * next question is "but does it still hold up if things go badly?".
 * The Pareto front (E.4) and sensitivity sweep (E.5) both run on the
 * BASELINE return distribution — i.e. the engine's central market
 * assumptions. They tell you the spend/bequest tradeoff and how
 * sensitive the pick is to small knob changes, but they don't tell
 * you how the pick fares under adverse paths.
 *
 * This module re-evaluates the adopted policy under a small set of
 * named adverse scenarios — bad early sequence, sustained high
 * inflation, a delayed inheritance, plus a "perfect storm" combination
 * — and reports the bequest / feasibility / worst-case wealth deltas
 * versus the baseline run.
 *
 * Why these scenarios:
 *   - They reuse the engine's existing Stressor registry, so the
 *     household sees the same "Bad First 3 Years" / "High Inflation"
 *     vocabulary they already know from the Stress screen.
 *   - The scenario set is small enough (4-5 runs) that we run them
 *     inline on the main thread — total wall-clock is ~3-10 sec on
 *     M-series silicon. No worker pool, no cluster session needed.
 *   - Each scenario is a `string[]` of stressor IDs handed to
 *     `buildPathResults` with `pathMode: 'selected_only'`, so this
 *     module owns no engine logic of its own. New scenarios are a
 *     one-line registry addition.
 *
 * Why not push this back through the cluster: the scenarios are tiny
 * and the household wants the answer NOW, immediately after adopting.
 * Spinning up a cluster session, serializing baseline + assumptions,
 * round-tripping, and polling the dispatcher would feel slower than
 * just running the 4 paths in-process — even though wall-clock would
 * shave a couple seconds. UX > throughput here.
 */

/**
 * One named adverse scenario.
 *
 * `stressorIds` are resolved through `data.stressors` at run time;
 * IDs not present in the seed registry are silently dropped (so e.g.
 * an old saved scenario that references a renamed stressor degrades
 * to "no extra stressors" rather than throwing).
 */
export interface StressScenario {
  id: string;
  /** Short label for the table row. */
  name: string;
  /** One-sentence household-readable description of what's stressed. */
  description: string;
  /** Stressor IDs to feed into `buildPathResults`. Empty = baseline. */
  stressorIds: string[];
  /** Optional scenario-specific knobs, such as layoff date and severance. */
  stressorKnobs?:
    | SimulationStressorKnobs
    | ((seed: SeedData, policy: Policy) => SimulationStressorKnobs);
}

const OCTOBER_2026_LAYOFF_DATE = '2026-10-01';

function threeMonthsSeverance(seed: SeedData): number {
  return Math.max(0, Math.round((seed.income?.salaryAnnual ?? 0) / 4));
}

/**
 * Default scenario set. Picked to span the four directions a
 * retirement plan typically fails:
 *   1. Sequence risk (bad early returns).
 *   2. Purchasing-power erosion (sustained high inflation).
 *   3. Liquidity timing (an expected windfall slipping later).
 *   4. Compound shock (multiple at once).
 *
 * The IDs match the seed-data registry — see `seed-data.json`. If a
 * household's seed lacks one of these stressors, the scenario row
 * shows up labelled but its `stressorIds` will resolve to no-op and
 * its result will be ~indistinguishable from baseline; the panel
 * filters those out so the household isn't confused.
 */
export const DEFAULT_STRESS_SCENARIOS: StressScenario[] = [
  {
    id: 'sequence_risk',
    name: 'Bad early markets',
    description:
      'Equity returns of −18%, −12%, −8% in the first three retirement years.',
    stressorIds: ['market_down'],
  },
  {
    id: 'high_inflation',
    name: 'Sustained high inflation',
    description: '5% inflation for 10 years instead of the assumed ~2.5%.',
    stressorIds: ['inflation'],
  },
  {
    id: 'laid_off_october',
    name: 'Laid off in October',
    description:
      'Salary ends October 1, 2026 with three months of severance.',
    stressorIds: ['layoff'],
    stressorKnobs: (seed) => ({
      layoffRetireDate: OCTOBER_2026_LAYOFF_DATE,
      layoffSeverance: threeMonthsSeverance(seed),
    }),
  },
  {
    id: 'delayed_inheritance',
    name: 'Inheritance arrives late',
    description: 'Any modeled inheritance windfall slips beyond plan horizon.',
    stressorIds: ['delayed_inheritance'],
  },
  {
    id: 'perfect_storm',
    name: 'Perfect storm',
    description: 'Bad early markets and high inflation hit at the same time.',
    stressorIds: ['market_down', 'inflation'],
  },
];

/** Outcome metrics from a single stressed run. Subset of the engine's PathResult. */
export interface StressOutcome {
  bequestAttainmentRate: number;
  /** Number of simulated years represented by the ending-wealth percentiles. */
  horizonYears: number;
  p10EndingWealthTodayDollars: number;
  p25EndingWealthTodayDollars: number;
  p50EndingWealthTodayDollars: number;
  p75EndingWealthTodayDollars: number;
  p90EndingWealthTodayDollars: number;
  /** P(ending wealth > 0) — keeping the engine's lifetime success rate alongside. */
  solventSuccessRate: number;
}

/** One scenario's worth of result. */
export interface StressTestResult {
  scenario: StressScenario;
  /** True iff the scenario actually exercised any stressors (engine knew the IDs). */
  appliedStressors: string[];
  outcome: StressOutcome;
  /** Wall-clock ms for this scenario's MC run. Useful for the progress bar. */
  durationMs: number;
}

/** Full report — baseline + each scenario. */
export interface StressTestReport {
  /** Baseline (no stressors), used as the reference each scenario is compared to. */
  baseline: StressTestResult;
  /** One result per requested scenario, in input order. */
  scenarios: StressTestResult[];
  /** Total wall-clock for the full report. */
  totalDurationMs: number;
}

/**
 * Inflation-deflate a nominal dollar amount to today's dollars.
 * Identical to the helper in `policy-miner-eval.ts` — duplicated to
 * keep that module's exported surface tight (it's loaded by the
 * cluster host worker, where this stress-test module is not).
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

function resolveStressorKnobs(
  stressorKnobs: StressScenario['stressorKnobs'] | undefined,
  seed: SeedData,
  policy: Policy,
): SimulationStressorKnobs | undefined {
  if (!stressorKnobs) return undefined;
  return typeof stressorKnobs === 'function'
    ? stressorKnobs(seed, policy)
    : stressorKnobs;
}

/**
 * Run the engine on `policy` once with `stressorIds` applied. Pure
 * helper — no React, no IndexedDB, no cluster.
 *
 * Filters `stressorIds` against the seed's registered stressor IDs so
 * a missing stressor doesn't crash the run; the caller gets back the
 * `appliedStressors` actually used so the UI can warn about silent
 * drops.
 */
export function evaluatePolicyUnderStress(
  policy: Policy,
  baseline: SeedData,
  assumptions: MarketAssumptions,
  stressorIds: string[],
  legacyTargetTodayDollars: number,
  cloner: SeedDataCloner,
  stressorKnobs?: StressScenario['stressorKnobs'],
): { outcome: StressOutcome; appliedStressors: string[]; durationMs: number } {
  const startMs = Date.now();
  const seed = applyPolicyToSeed(cloner(baseline), policy);
  const knownIds = new Set(seed.stressors?.map((s) => s.id) ?? []);
  const appliedStressors = stressorIds.filter((id) => knownIds.has(id));
  const resolvedStressorKnobs = resolveStressorKnobs(
    stressorKnobs,
    seed,
    policy,
  );
  const paths = buildPathResults(seed, assumptions, appliedStressors, [], {
    annualSpendTarget: policy.annualSpendTodayDollars,
    pathMode: 'selected_only',
    stressorKnobs: resolvedStressorKnobs,
  });
  const path = paths[0];
  if (!path) {
    throw new Error('evaluatePolicyUnderStress: engine returned no path result');
  }
  const horizonYears = path.yearlySeries?.length ?? 30;
  const inflation = assumptions.inflation ?? 0.025;
  const deflate = (n: number) => toTodayDollars(n, inflation, horizonYears);
  const todayDollarsP10 = deflate(path.endingWealthPercentiles.p10);
  const todayDollarsP25 = deflate(path.endingWealthPercentiles.p25);
  const todayDollarsP50 = deflate(path.endingWealthPercentiles.p50);
  const todayDollarsP75 = deflate(path.endingWealthPercentiles.p75);
  const todayDollarsP90 = deflate(path.endingWealthPercentiles.p90);
  const bequestAttainmentRate =
    legacyTargetTodayDollars > 0
      ? approximateBequestAttainmentRate(legacyTargetTodayDollars, {
          p10: todayDollarsP10,
          p25: todayDollarsP25,
          p50: todayDollarsP50,
          p75: todayDollarsP75,
          p90: todayDollarsP90,
        })
      : 1;
  return {
    outcome: {
      bequestAttainmentRate,
      horizonYears,
      p10EndingWealthTodayDollars: todayDollarsP10,
      p25EndingWealthTodayDollars: todayDollarsP25,
      p50EndingWealthTodayDollars: todayDollarsP50,
      p75EndingWealthTodayDollars: todayDollarsP75,
      p90EndingWealthTodayDollars: todayDollarsP90,
      solventSuccessRate: path.successRate,
    },
    appliedStressors,
    durationMs: Date.now() - startMs,
  };
}

export interface RunPolicyStressTestOptions {
  /** Override the default scenario set. */
  scenarios?: StressScenario[];
  /**
   * Called after each scenario completes (including the baseline run
   * at index 0). `total` includes the baseline, so progress is
   * `completed / total ∈ [1/(N+1), 1]`. Used by the UI to render a
   * progress bar without knowing the engine's internals.
   */
  onProgress?: (completed: number, total: number) => void;
  /**
   * Inserted between scenarios to yield to the event loop so the UI
   * stays responsive. Defaults to 0 ms (no yield) for tests; the UI
   * caller should pass a small positive number (e.g. 16 ms).
   */
  yieldEveryMs?: number;
}

/**
 * Run the full stress-test report — one baseline run plus one run per
 * scenario. Returns once every run completes.
 *
 * Synchronous-feeling but async so the UI can yield between runs;
 * each engine call itself is synchronous and CPU-bound.
 */
export async function runPolicyStressTest(
  policy: Policy,
  baseline: SeedData,
  assumptions: MarketAssumptions,
  legacyTargetTodayDollars: number,
  cloner: SeedDataCloner,
  options: RunPolicyStressTestOptions = {},
): Promise<StressTestReport> {
  const scenarios = options.scenarios ?? DEFAULT_STRESS_SCENARIOS;
  const total = scenarios.length + 1; // +1 for baseline
  const reportStartMs = Date.now();

  // Baseline first — every scenario delta is computed against it.
  const baselineRun = evaluatePolicyUnderStress(
    policy,
    baseline,
    assumptions,
    [],
    legacyTargetTodayDollars,
    cloner,
  );
  const baselineResult: StressTestResult = {
    scenario: {
      id: 'baseline',
      name: 'Baseline',
      description: 'Engine central case — no stressors applied.',
      stressorIds: [],
    },
    appliedStressors: [],
    outcome: baselineRun.outcome,
    durationMs: baselineRun.durationMs,
  };
  options.onProgress?.(1, total);

  const results: StressTestResult[] = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i];
    if (options.yieldEveryMs && options.yieldEveryMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.yieldEveryMs));
    }
    const run = evaluatePolicyUnderStress(
      policy,
      baseline,
      assumptions,
      scenario.stressorIds,
      legacyTargetTodayDollars,
      cloner,
      scenario.stressorKnobs,
    );
    results.push({
      scenario,
      appliedStressors: run.appliedStressors,
      outcome: run.outcome,
      durationMs: run.durationMs,
    });
    options.onProgress?.(i + 2, total);
  }

  return {
    baseline: baselineResult,
    scenarios: results,
    totalDurationMs: Date.now() - reportStartMs,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers for the UI
// ---------------------------------------------------------------------------

/**
 * Categorize a feasibility delta into a tone for color coding.
 *
 *   ≤ −10 pp     → severe   (red)
 *   −10..−2 pp   → notable  (amber)
 *   −2..+2 pp    → neutral  (grey)
 *   > +2 pp      → positive (green)
 *
 * The thresholds are deliberately wide so noise from a single MC run
 * doesn't make the panel oscillate. A 1-percentage-point jitter is
 * normal at the engine's default trial count; ≥10 pp is a real
 * structural concern worth showing prominently.
 */
export type FeasibilityTone = 'severe' | 'notable' | 'neutral' | 'positive';

export function classifyFeasibilityDelta(deltaRate: number): FeasibilityTone {
  if (deltaRate <= -0.10) return 'severe';
  if (deltaRate <= -0.02) return 'notable';
  if (deltaRate >= 0.02) return 'positive';
  return 'neutral';
}

/** Format a +/- bequest delta in compact dollar form ("+$120k", "−$1.2M"). */
export function formatBequestDelta(deltaDollars: number): string {
  if (!Number.isFinite(deltaDollars) || deltaDollars === 0) return '—';
  const sign = deltaDollars > 0 ? '+' : '−';
  const abs = Math.abs(deltaDollars);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** Format a +/- feasibility delta in percentage points ("+3pp", "−12pp"). */
export function formatFeasibilityDelta(deltaRate: number): string {
  if (!Number.isFinite(deltaRate) || deltaRate === 0) return '—';
  const sign = deltaRate > 0 ? '+' : '−';
  const pp = Math.round(Math.abs(deltaRate) * 100);
  if (pp === 0) return '—';
  return `${sign}${pp}pp`;
}

/**
 * Quick household-readable summary of the WORST scenario in a report.
 * Used as a one-line header above the table.
 */
export function worstCaseSummary(report: StressTestReport): {
  scenarioName: string;
  feasibilityDeltaRate: number;
  bequestDeltaDollars: number;
} | null {
  if (report.scenarios.length === 0) return null;
  let worst = report.scenarios[0];
  let worstDelta =
    worst.outcome.bequestAttainmentRate -
    report.baseline.outcome.bequestAttainmentRate;
  for (let i = 1; i < report.scenarios.length; i += 1) {
    const r = report.scenarios[i];
    const d =
      r.outcome.bequestAttainmentRate -
      report.baseline.outcome.bequestAttainmentRate;
    if (d < worstDelta) {
      worstDelta = d;
      worst = r;
    }
  }
  return {
    scenarioName: worst.scenario.name,
    feasibilityDeltaRate: worstDelta,
    bequestDeltaDollars:
      worst.outcome.p50EndingWealthTodayDollars -
      report.baseline.outcome.p50EndingWealthTodayDollars,
  };
}
