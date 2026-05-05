import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureSnapshot, saveSnapshot } from './history-store';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import {
  findOptimalSocialSecurityClaimAsync,
  type SocialSecurityOptimizationResult,
} from './ss-optimizer';
import {
  findMaxSustainableSpendAsync,
  type SpendOptimizationResult,
} from './spend-optimizer';
import {
  findOptimalRothCeilingAsync,
  type RothOptimizationResult,
} from './roth-optimizer';
import { approximateBequestAttainmentRate } from './plan-evaluation';
import { CalibrationDashboard } from './CalibrationDashboard';
import { MedicareReminderCard } from './MedicareReminderCard';
import { MortalitySensitivityCard } from './MortalitySensitivityCard';
import { LogActualsCard } from './LogActualsCard';
import { getActualsStore, getPredictionStore } from './calibration-stores';
import { buildPredictionRecord, logPrediction } from './prediction-log';
import { MountWhenVisible } from './MountWhenVisible';

/**
 * Stage of the chained plan-optimization run. The Cockpit uses this
 * to drive the progress label ("Optimizing SS..." vs "Optimizing
 * spending...") and to decide which cards have data to render.
 */
type PlanOptimizationStage =
  | 'idle'
  | 'ss'
  | 'spend'
  | 'roth'
  | 'done'
  | 'error';

interface PlanOptimizationOutput {
  ssResult: SocialSecurityOptimizationResult | null;
  spendResult: SpendOptimizationResult | null;
  rothResult: RothOptimizationResult | null;
  /** Full engine path at the optimized plan (recommended SS + spend +
   *  Roth ceiling). Drives the Cockpit's year-by-year details, the
   *  trajectory chart, and the actions-due tile — keeping every panel
   *  consistent with the Trust headline. */
  optimizedPath: PathResult | null;
  /** The final seed used for the optimized projection — useful for
   *  downstream views that need to see "what plan are we projecting
   *  against?" without re-deriving from results. */
  optimizedSeed: SeedData | null;
  stage: PlanOptimizationStage;
  error: string | null;
  /** Composite progress 0..1 across the optimizers. */
  progressFraction: number;
}

/**
 * Chain SS-optimizer → spend-optimizer.
 *
 * The architectural shift this enables: the Cockpit's "current plan"
 * is the *engine's recommended plan*, not the seed's monthly-spending
 * + SS values. Seed inputs are an initial guess; the optimizers
 * produce the planning baseline.
 *
 * Stage 1: run SS optimizer with the seed.
 * Stage 2: clone the seed with the recommended SS pair applied, then
 *          run the spend optimizer against that clone — so the
 *          recommended max spend is computed under the optimal SS
 *          strategy, not the seed's strategy.
 *
 * Total cost: ~10-15s (SS) + ~20-27s (spend) = ~35-45s on first paint.
 * Cached by seed fingerprint so it doesn't re-run on tab swap.
 */
/**
 * Module-level cache for optimizer results. Keyed on the same
 * fingerprint the hook uses; survives Cockpit unmount/remount (tab
 * swaps Cockpit → Mining → Cockpit no longer re-trigger the
 * ~30-50s optimization chain). Cleared implicitly when the seed
 * fingerprint changes — old entries stay in memory for the lifetime
 * of the page; that's fine, they're small (~few KB) and only one
 * baseline is ever active at a time.
 */
interface CachedPlanOptimization {
  ssResult: SocialSecurityOptimizationResult;
  spendResult: SpendOptimizationResult;
  rothResult: RothOptimizationResult;
  optimizedPath: PathResult | null;
  optimizedSeed: SeedData;
}

// localStorage key for the persisted cache. Bump this suffix when the
// CachedPlanOptimization shape changes — old entries get ignored on
// load, which is safer than partial deserialization.
const PLAN_CACHE_LS_KEY = 'retirement-calc:plan-opt-cache:v1';
const PLAN_CACHE_MAX_ENTRIES = 8; // FIFO evict; small to fit in 5MB localStorage.

function loadPlanCacheFromLocalStorage(): Map<string, CachedPlanOptimization> {
  try {
    if (typeof window === 'undefined') return new Map();
    const raw = window.localStorage?.getItem(PLAN_CACHE_LS_KEY);
    if (!raw) return new Map();
    const entries = JSON.parse(raw) as Array<[string, CachedPlanOptimization]>;
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function persistPlanCacheToLocalStorage(
  cache: Map<string, CachedPlanOptimization>,
): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    let entries = Array.from(cache.entries());
    if (entries.length > PLAN_CACHE_MAX_ENTRIES) {
      entries = entries.slice(entries.length - PLAN_CACHE_MAX_ENTRIES);
    }
    window.localStorage.setItem(PLAN_CACHE_LS_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded / private browsing / disabled storage — non-fatal.
  }
}

// Module-level cache, hydrated from localStorage on module import. A
// page refresh now restores the optimizer result instantly instead of
// triggering a fresh ~12s recompute. Survives across the entire session
// AND across hard refreshes; cleared implicitly when fingerprint changes.
const planOptimizationCache = loadPlanCacheFromLocalStorage();

function usePlanOptimization(
  data: SeedData | null,
  assumptions: MarketAssumptions | null,
  /**
   * When true, the bisection chain is skipped entirely. The cockpit
   * sets this when the mining corpus has a recommendation — the
   * household sees that pick directly, no need to spend ~30s of main-
   * thread MC on a parallel bisection. Returned state stays at idle
   * so banners / running flags don't fire.
   */
  skip = false,
): PlanOptimizationOutput {
  const [ssResult, setSsResult] =
    useState<SocialSecurityOptimizationResult | null>(null);
  const [spendResult, setSpendResult] =
    useState<SpendOptimizationResult | null>(null);
  const [rothResult, setRothResult] =
    useState<RothOptimizationResult | null>(null);
  const [optimizedPath, setOptimizedPath] = useState<PathResult | null>(null);
  const [optimizedSeed, setOptimizedSeed] = useState<SeedData | null>(null);
  const [stage, setStage] = useState<PlanOptimizationStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progressFraction, setProgressFraction] = useState(0);
  const lastKeyRef = useRef<string | null>(null);
  // Run-id based cancellation. We bump this on each new optimization
  // run; the in-flight async checks `runIdRef.current === myRunId` at
  // every await checkpoint and bails if it's been superseded. This is
  // safer than a `cancelRef` boolean because in React 18 strict mode
  // an effect's cleanup fires BEFORE the second mount's body, which
  // would set the boolean to "cancelled" and cause the (still valid)
  // second-mount work to be skipped. With run ids, the second mount
  // bumps the id and proceeds; the first mount's async sees a stale
  // id and bails. Same for genuine cancellation across fingerprints.
  const runIdRef = useRef(0);

  const fingerprint = useMemo(() => {
    if (!data || !assumptions) return null;
    return JSON.stringify({
      ss: data.income?.socialSecurity,
      windfalls: data.income?.windfalls,
      accts: {
        pretax: data.accounts?.pretax?.balance,
        roth: data.accounts?.roth?.balance,
        taxable: data.accounts?.taxable?.balance,
        cash: data.accounts?.cash?.balance,
        hsa: data.accounts?.hsa?.balance,
      },
      birth: {
        rob: data.household?.robBirthDate,
        debbie: data.household?.debbieBirthDate,
      },
      goals: (data as SeedData & { goals?: { legacyTargetTodayDollars?: number } })
        .goals,
      asm: {
        equityMean: assumptions.equityMean,
        inflation: assumptions.inflation,
        version: assumptions.assumptionsVersion,
      },
    });
  }, [data, assumptions]);

  useEffect(() => {
    if (skip) return;
    if (!data || !assumptions || !fingerprint) return;
    // Module-cache fast path: if we already optimized for this
    // fingerprint earlier (e.g. user swapped to Mining tab and back),
    // restore the result synchronously and skip the async chain.
    // This is the big perf win — tab swaps used to trigger a fresh
    // ~30-50s optimization; now it's instant.
    const cached = planOptimizationCache.get(fingerprint);
    if (cached) {
      lastKeyRef.current = fingerprint;
      setSsResult(cached.ssResult);
      setSpendResult(cached.spendResult);
      setRothResult(cached.rothResult);
      setOptimizedPath(cached.optimizedPath);
      setOptimizedSeed(cached.optimizedSeed);
      setStage('done');
      setProgressFraction(1);
      setError(null);
      return;
    }
    // Skip if work for this fingerprint has already started (either
    // in-flight or completed). Reset of `lastKeyRef.current` happens
    // only on error (so we can retry) or never on success (cache).
    // This is the strict-mode-safe gate: in StrictMode, the effect
    // mounts twice; the second mount sees lastKeyRef already pointing
    // at this fingerprint and short-circuits, leaving the first
    // mount's async intact.
    if (lastKeyRef.current === fingerprint) return;
    lastKeyRef.current = fingerprint;
    const myRunId = ++runIdRef.current;
    setStage('ss');
    setError(null);
    setSsResult(null);
    setSpendResult(null);
    setRothResult(null);
    setOptimizedPath(null);
    setOptimizedSeed(null);
    setProgressFraction(0);

    (async () => {
      try {
        // Stage 1: SS optimizer.
        const ss = await findOptimalSocialSecurityClaimAsync(data, assumptions, {
          minClaimAge: 65,
          maxClaimAge: 70,
          // Trial count tuned for Cockpit interactivity. 250 trials per
          // cell gives ~±1.5pp accuracy on solvency/legacy rates —
          // close enough to rank candidates and call out the headline,
          // and 2× faster than the policy-mining 500-trial baseline.
          // The mining cluster still uses 2000 trials for the
          // certification corpus; this is just for the live in-app
          // recommendation surface.
          trialCount: 250,
          // Constraint targets default to (0.85, 0.85) inside the optimizer
          // when the household has a legacy goal. Pass through explicitly
          // for clarity.
          targetSolventRate: 0.85,
          onProgress: (done, total) => {
            // SS phase contributes the first 40% of composite progress.
            setProgressFraction(total > 0 ? (done / total) * 0.4 : 0);
          },
          isCancelled: () => runIdRef.current !== myRunId,
        });
        if (runIdRef.current !== myRunId) return;
        setSsResult(ss);

        // Stage 2: clone seed with recommended SS, run spend optimizer.
        setStage('spend');
        const clone = JSON.parse(JSON.stringify(data)) as SeedData;
        if (clone.income?.socialSecurity?.[0] && ss.recommended) {
          clone.income.socialSecurity[0].claimAge = ss.recommended.primaryAge;
        }
        if (
          clone.income?.socialSecurity?.[1] &&
          ss.recommended?.spouseAge !== null &&
          ss.recommended?.spouseAge !== undefined
        ) {
          clone.income.socialSecurity[1].claimAge = ss.recommended.spouseAge;
        }
        const spend = await findMaxSustainableSpendAsync(clone, assumptions, {
          minAnnualSpend: 60_000,
          maxAnnualSpend: 250_000,
          targetSolventRate: 0.85,
          targetLegacyAttainmentRate: 0.85,
          // Trial count tuned for Cockpit interactivity. 250 trials per
          // cell gives ~±1.5pp accuracy on solvency/legacy rates —
          // close enough to rank candidates and call out the headline,
          // and 2× faster than the policy-mining 500-trial baseline.
          // The mining cluster still uses 2000 trials for the
          // certification corpus; this is just for the live in-app
          // recommendation surface.
          trialCount: 250,
          toleranceDollars: 2_000,
          onProgress: (iter, lo, hi) => {
            // Spend phase contributes 35% (40-75% of composite).
            // Bisection converges in ~log2((max-min)/tol) ≈ 8 iters.
            void lo;
            void hi;
            const phaseFrac = Math.min(1, iter / 8);
            setProgressFraction(0.4 + phaseFrac * 0.35);
          },
          isCancelled: () => runIdRef.current !== myRunId,
        });
        if (runIdRef.current !== myRunId) return;
        setSpendResult(spend);

        // Stage 3: Roth ceiling optimizer. Sweeps 6 ceiling levels at
        // the joint plan (recommended SS + recommended spend already
        // applied via clone + spend override) and picks the ceiling
        // that maximizes p50 EW subject to both constraints.
        setStage('roth');
        const roth = await findOptimalRothCeilingAsync(
          clone,
          assumptions,
          spend.recommendedAnnualSpendTodayDollars,
          {
            // Trial count tuned for Cockpit interactivity. 250 trials per
          // cell gives ~±1.5pp accuracy on solvency/legacy rates —
          // close enough to rank candidates and call out the headline,
          // and 2× faster than the policy-mining 500-trial baseline.
          // The mining cluster still uses 2000 trials for the
          // certification corpus; this is just for the live in-app
          // recommendation surface.
          trialCount: 250,
            targetSolventRate: 0.85,
            onProgress: (done, total) => {
              // Roth phase contributes 15% (75-90% of composite).
              setProgressFraction(0.75 + (done / Math.max(1, total)) * 0.15);
            },
            isCancelled: () => runIdRef.current !== myRunId,
          },
        );
        if (runIdRef.current !== myRunId) return;
        setRothResult(roth);

        // Apply the recommended Roth ceiling to the clone before the
        // final projection.
        if (roth.recommended && clone.rules) {
          clone.rules.rothConversionPolicy = {
            ...(clone.rules.rothConversionPolicy ?? {}),
            enabled: roth.recommended.ceilingTodayDollars > 0,
            minAnnualDollars: 0,
            magiBufferDollars: roth.recommended.ceilingTodayDollars,
          };
        }

        // Stage 4: build the optimizedPath. Run the full engine ONCE
        // at the joint plan (recommended SS + spend + Roth ceiling all
        // applied). This becomes the canonical projection for every
        // Cockpit panel below the Trust card — year-by-year tiles,
        // trajectory chart, actions due.
        const optPaths = buildPathResults(clone, assumptions, [], [], {
          pathMode: 'selected_only',
          annualSpendTarget: spend.recommendedAnnualSpendTodayDollars,
        });
        const optPath = optPaths[0] ?? null;
        if (runIdRef.current !== myRunId) return;
        // Persist the full result in the module-level cache so a tab
        // swap returns to instant load. Keyed on fingerprint; old
        // entries naturally fall out of relevance when the seed
        // changes (the fingerprint becomes a different key).
        planOptimizationCache.set(fingerprint, {
          ssResult: ss,
          spendResult: spend,
          rothResult: roth,
          optimizedPath: optPath,
          optimizedSeed: clone,
        });
        // Persist to localStorage so a hard refresh / new browser tab
        // restores the result instantly instead of running another
        // ~12s optimizer chain.
        persistPlanCacheToLocalStorage(planOptimizationCache);
        // Auto-log prediction record. Captures (timestamp,
        // planFingerprint, full inputs snapshot, headline outputs,
        // yearly trajectory) so the reconciliation layer can diff
        // against actuals later. Append-only; localStorage-backed
        // with FIFO eviction at 500 records (~1 year of daily uses).
        // Logged once per finished optimization chain — the cache
        // gate above ensures we only log when the chain RAN, not on
        // cache hits (already logged when the chain originally ran).
        if (optPath) {
          try {
            logPrediction(
              getPredictionStore(),
              buildPredictionRecord(clone, assumptions, optPath),
            );
          } catch (logErr) {
            // Non-fatal: prediction logging failure shouldn't break
            // the household's view of their plan.
            // eslint-disable-next-line no-console
            console.warn('[cockpit] prediction-log failed:', logErr);
          }
        }
        setOptimizedPath(optPath);
        setOptimizedSeed(clone);
        setProgressFraction(1);
        setStage('done');
      } catch (err) {
        if (runIdRef.current !== myRunId) return;
        // Reset cache key so a future render can retry — otherwise the
        // failure is sticky for the lifetime of this fingerprint.
        lastKeyRef.current = null;
        const message =
          err instanceof Error ? err.message : 'unknown optimization error';
        // eslint-disable-next-line no-console
        console.warn('[cockpit] plan optimization failed:', err);
        setError(message);
        setStage('error');
      }
    })();

    // No cleanup function: we use runIdRef as the cancellation
    // signal, which a NEW run bumps. A unmount/remount cycle in
    // strict mode doesn't change runIdRef on its own (only the body
    // of the effect bumps it), so the in-flight async survives. A
    // genuine fingerprint change runs the body, bumps runIdRef, and
    // the prior async bails on its next checkpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, assumptions, fingerprint, skip]);

  return {
    ssResult,
    spendResult,
    rothResult,
    optimizedPath,
    optimizedSeed,
    stage,
    error,
    progressFraction,
  };
}
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAppStore } from './store';
import { buildPathResults } from './utils';
import {
  getCachedBaselinePathBoth,
  type BaselinePathBoth,
} from './baseline-path-cache';
import { useRecommendedPolicy } from './use-recommended-policy';
import { useRecommendedPath } from './use-recommended-path';
import { useClusterSession } from './useClusterSession';
import type {
  MarketAssumptions,
  PathResult,
  PathYearResult,
  SeedData,
} from './types';

/**
 * "Now" cockpit — fresh take on the post-adoption planner UX.
 *
 * Existing planner screens are great for the strategic question ("what's
 * the best 30-year policy?"). After adoption, the household's actual
 * questions are operational:
 *   - This year, am I on track? What hard stops are nearby?
 *   - Next year, what's coming up? What decisions to prep for?
 *   - This month, what discrete moves should happen?
 *
 * This screen is a scaffold — real data wired in where the engine
 * already produces it (per-year MAGI, withdrawals, IRMAA tier,
 * Roth conversion, healthcare premiums, etc.); placeholder where the
 * data isn't structured yet (sensitivity tile shows fixed scenarios
 * pending integration with the stress-sweep machinery).
 *
 * Per-month tiles divide annual outputs by 12 with a caption noting
 * the simplification. The simulator runs at year resolution; a true
 * monthly view would need an engine refactor — out of scope for this
 * prototype.
 */

/**
 * Module-level cache for the baseline path. Lives outside the component
 * so navigating away from Cockpit and back doesn't trigger another
 * 5-second Monte Carlo recompute — useMemo only survives within a
 * mounted instance, but the cockpit unmounts when the user clicks
 * another sidebar item.
 *
 * Single-entry cache keyed by an input fingerprint. When inputs change
 * (adoption, applied edits, assumption tweaks), the key changes and
 * the next render recomputes once.
 */
/**
 * Phase 3 dual view: the cockpit runs the same plan through two engine
 * modes side-by-side. `forwardLooking` uses the conservative parametric
 * defaults (equityMean: 0.074 etc.). `historical` uses 1926-2023 bootstrap.
 * Both numbers are valid; they answer different questions, and the
 * difference between them is the "future returns lower than past?" wager
 * the user has implicitly taken on.
 */
// Baseline-path cache moved to ./baseline-path-cache so the Mining
// screen can share the same persisted result. One engine pass populates
// both screens; refreshes hit localStorage and skip the engine entirely.

// IRMAA + ACA cliff thresholds for 2026 (MFJ). Hardcoded constants
// here — the existing engine has these elsewhere; for the prototype
// we mirror them so the cockpit can show distance-to-cliff without
// importing the whole tax module.
const IRMAA_TIERS_MFJ_2026: Array<{ name: string; magiCeiling: number; surchargePerPerson: number }> = [
  { name: 'IRMAA Tier 1', magiCeiling: 206_000, surchargePerPerson: 74 },
  { name: 'IRMAA Tier 2', magiCeiling: 258_000, surchargePerPerson: 184 },
  { name: 'IRMAA Tier 3', magiCeiling: 322_000, surchargePerPerson: 295 },
  { name: 'IRMAA Tier 4', magiCeiling: 386_000, surchargePerPerson: 405 },
  { name: 'IRMAA Tier 5', magiCeiling: 750_000, surchargePerPerson: 444 },
];

// 0% LTCG bracket top for MFJ in 2026 (rough — engine has the real
// number). Used to show "spread between projected ordinary income and
// the harvest cliff."
const LTCG_ZERO_BRACKET_TOP_MFJ_2026 = 96_700;

/**
 * Sensitivity scenarios for the Cockpit. Each one perturbs the seed
 * data and/or assumptions, runs the engine, and reports the delta to
 * solvency and median bequest. Grouped by household relevance:
 *
 *   - 'response' — things the household chooses to do (cut spending,
 *     work longer). High likelihood, low cost.
 *   - 'stressor' — things that may happen (markets, inflation,
 *     spending creep). External; the household reacts after the fact.
 *   - 'big_event' — low-probability, high-impact (LTC, SS cuts).
 *
 * The note on each scenario captures the household's intuition about
 * relative likelihood — this is the "we are most likely to cut
 * spending, less likely to sell the house" framing.
 */
type ScenarioGroup = 'pair' | 'stressor' | 'response' | 'big_event';

interface ScenarioDef {
  id: string;
  group: ScenarioGroup;
  /** Static label, OR a function taking the current seed so the label
   *  can reflect derived dollar amounts (e.g. paired stressor+response
   *  showing the actual cut size in today's dollars). */
  label: string | ((data: SeedData) => string);
  note: string;
  perturb: (
    data: SeedData,
    assumptions: MarketAssumptions,
  ) => { data: SeedData; assumptions: MarketAssumptions };
  /** Optional break-even solver. When present, the panel runs an
   *  additional bisection: apply `baseStressor` (the bad thing), then
   *  search for the smallest annual cut that restores baseline
   *  solvency. The cut is split between optional and travel
   *  proportionally to current sizes. */
  breakEvenSolver?: {
    baseStressor: (
      data: SeedData,
      assumptions: MarketAssumptions,
    ) => { data: SeedData; assumptions: MarketAssumptions };
  };
}

/**
 * Apply just the delayed-inheritance stressor (no spending response).
 * Bumps the inheritance windfall's year by 3. If no inheritance entry
 * is present in the seed, returns data unchanged — caller should
 * detect via the label and surface a friendly "no inheritance" note.
 */
function applyInheritanceDelay(
  data: SeedData,
  assumptions: MarketAssumptions,
): { data: SeedData; assumptions: MarketAssumptions } {
  const idx = data.income.windfalls.findIndex(
    (w) => w.name === 'inheritance',
  );
  if (idx < 0) return { data, assumptions };
  const next = [...data.income.windfalls];
  next[idx] = { ...next[idx], year: next[idx].year + 3 };
  return {
    data: { ...data, income: { ...data.income, windfalls: next } },
    assumptions,
  };
}

/**
 * Apply just the layoff stressor (no spending response). Reused by:
 *   - the standalone "Layoff today" stressor row
 *   - the layoff pair (where it gets layered with cuts)
 *   - the break-even bisection (which also applies cuts on top)
 * Centralizing the perturbation prevents the three callers from
 * drifting in subtle ways (severance amount, layoff date, tax
 * treatment).
 */
function applyLayoff(
  data: SeedData,
  assumptions: MarketAssumptions,
): { data: SeedData; assumptions: MarketAssumptions } {
  const today = new Date();
  const monthlySalary = data.income.salaryAnnual / 12;
  const severance = Math.round(monthlySalary * 3);
  const layoffDateIso = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  ).toISOString();
  return {
    data: {
      ...data,
      income: {
        ...data.income,
        salaryEndDate: layoffDateIso,
        windfalls: [
          ...data.income.windfalls,
          {
            name: 'severance',
            year: today.getUTCFullYear(),
            amount: severance,
            taxTreatment: 'ordinary_income',
            certainty: 'certain',
          },
        ],
      },
    },
    assumptions,
  };
}

/**
 * Apply a total annual spending cut split proportionally between
 * optional and travel. If both are zero, falls back to taking the
 * cut entirely from optional (so the bisection still has a knob to
 * turn). Used by the break-even solver and by paired pre-set cuts.
 */
function applyProportionalCut(
  data: SeedData,
  totalAnnualCut: number,
): { data: SeedData; optionalCut: number; travelCut: number } {
  const optionalAnnual = data.spending.optionalMonthly * 12;
  const travelAnnual = data.spending.travelEarlyRetirementAnnual;
  const totalCuttable = optionalAnnual + travelAnnual;
  let optionalCut: number;
  let travelCut: number;
  if (totalCuttable <= 0) {
    optionalCut = totalAnnualCut;
    travelCut = 0;
  } else {
    optionalCut = totalAnnualCut * (optionalAnnual / totalCuttable);
    travelCut = totalAnnualCut * (travelAnnual / totalCuttable);
  }
  return {
    data: {
      ...data,
      spending: {
        ...data.spending,
        optionalMonthly: Math.max(
          0,
          data.spending.optionalMonthly - optionalCut / 12,
        ),
        travelEarlyRetirementAnnual: Math.max(
          0,
          data.spending.travelEarlyRetirementAnnual - travelCut,
        ),
      },
    },
    optionalCut,
    travelCut,
  };
}

const SCENARIOS: ScenarioDef[] = [
  // ── Pair: stressor + reaction layered together ─────────────────────
  {
    id: 'layoff_then_split_cut',
    group: 'pair',
    label: (data) => {
      // Cut optional 10% and travel 50% — the household's "we cut
      // these first" responses. Show the actual dollars so the
      // magnitude is concrete instead of buried in percentages.
      const optionalCut = data.spending.optionalMonthly * 12 * 0.1;
      const travelCut = data.spending.travelEarlyRetirementAnnual * 0.5;
      const total = Math.round(optionalCut + travelCut);
      return `Layoff today + cut ${formatCurrency(total)}/yr (optional + travel)`;
    },
    note:
      'Layoff hits, household reacts: 10% off optional spend, 50% off travel. Pairs the stressor with the most-likely response.',
    perturb: (data, assumptions) => {
      const layoff = applyLayoff(data, assumptions);
      return {
        data: {
          ...layoff.data,
          spending: {
            ...layoff.data.spending,
            optionalMonthly: layoff.data.spending.optionalMonthly * 0.9,
            travelEarlyRetirementAnnual:
              layoff.data.spending.travelEarlyRetirementAnnual * 0.5,
          },
        },
        assumptions: layoff.assumptions,
      };
    },
    breakEvenSolver: { baseStressor: applyLayoff },
  },
  {
    id: 'inheritance_delayed_with_bridge_cut',
    group: 'pair',
    label: (data) => {
      const inh = data.income.windfalls.find((w) => w.name === 'inheritance');
      if (!inh) {
        return 'Inheritance delayed 3yr + bridge cut (no inheritance in seed)';
      }
      // Bridge cut size = inheritance amount spread over the 3 delay
      // years. This is the "cash flow we needed but didn't get"
      // amount — directionally the right size for a temporary cut.
      const bridgeCutPerYear = Math.round(inh.amount / 3);
      return `Inheritance delayed 3yr + bridge cut ~${formatCurrency(bridgeCutPerYear)}/yr`;
    },
    note:
      'Inheritance arrives 3 years late; household tightens spending during the delay. Engine runs at year resolution and seed spending is flat across years — modeled here as a smaller permanent cut roughly equal to (inheritance ÷ 3 years) × delay-years/total-years. The break-even row below tells you the actual cut needed.',
    perturb: (data, assumptions) => {
      const delayed = applyInheritanceDelay(data, assumptions);
      const inh = data.income.windfalls.find((w) => w.name === 'inheritance');
      if (!inh) return delayed;
      // Time-averaged approximation: total bridge-cut dollars
      // (inheritance amount) spread across the full plan horizon.
      // Engine doesn't support 3-year-only cuts on a flat seed; the
      // break-even bisection below uses the same approach (permanent
      // cut) so the comparison is consistent.
      const horizonYears = 30; // engine's typical sim length
      const annualBridge = Math.max(
        0,
        Math.round(inh.amount / horizonYears),
      );
      const cut = applyProportionalCut(delayed.data, annualBridge);
      return { data: cut.data, assumptions: delayed.assumptions };
    },
    breakEvenSolver: { baseStressor: applyInheritanceDelay },
  },
  // ── Responses (household-controlled, high likelihood) ─────────────
  {
    id: 'cut_optional_10',
    group: 'response',
    label: 'Cut optional spending 10%',
    note: 'First lever to pull — easiest dial, no lifestyle disruption.',
    perturb: (data, assumptions) => ({
      data: {
        ...data,
        spending: {
          ...data.spending,
          optionalMonthly: data.spending.optionalMonthly * 0.9,
        },
      },
      assumptions,
    }),
  },
  {
    id: 'pause_travel_5yr',
    group: 'response',
    label: 'Pause travel 50% for 5 years',
    note: 'Skip discretionary travel to weather a downturn.',
    perturb: (data, assumptions) => ({
      data: {
        ...data,
        spending: {
          ...data.spending,
          travelEarlyRetirementAnnual:
            data.spending.travelEarlyRetirementAnnual * 0.5,
        },
      },
      assumptions,
    }),
  },
  {
    id: 'work_one_more_year',
    group: 'response',
    label: 'Work one more year',
    note: 'Push salary end date out 12 months.',
    perturb: (data, assumptions) => {
      try {
        const next = new Date(data.income.salaryEndDate);
        next.setUTCFullYear(next.getUTCFullYear() + 1);
        return {
          data: {
            ...data,
            income: { ...data.income, salaryEndDate: next.toISOString() },
          },
          assumptions,
        };
      } catch {
        return { data, assumptions };
      }
    },
  },
  // ── Stressors (external; medium likelihood) ────────────────────────
  {
    id: 'layoff_3mo_severance',
    group: 'stressor',
    label: 'Layoff today (3 mo severance)',
    note: 'Salary ends now, severance lands as a one-time taxable windfall.',
    perturb: applyLayoff,
  },
  {
    id: 'market_drop_year_1',
    group: 'stressor',
    label: 'Market −20% in year 1',
    note: 'Sequence-of-returns hit right at retirement — worst-case timing.',
    perturb: (data, assumptions) => ({
      data,
      assumptions: {
        ...assumptions,
        // Drop expected equity return for the simulation by replacing
        // mean with one volatility-adjusted year of −20%. Simpler proxy:
        // shift equityMean down 4pp for this run (~−20% in the first
        // year on average across runs).
        equityMean: assumptions.equityMean - 0.04,
        internationalEquityMean: assumptions.internationalEquityMean - 0.04,
      },
    }),
  },
  {
    id: 'inflation_4pct',
    group: 'stressor',
    label: 'Inflation runs 4%',
    note: 'Sustained higher CPI than assumed — costs compound.',
    perturb: (data, assumptions) => ({
      data,
      assumptions: { ...assumptions, inflation: 0.04 },
    }),
  },
  {
    id: 'spend_creep_10pct',
    group: 'stressor',
    label: 'Spend 10% more than planned',
    note: 'Lifestyle creep, recurring unbudgeted costs.',
    perturb: (data, assumptions) => ({
      data: {
        ...data,
        spending: {
          ...data.spending,
          essentialMonthly: data.spending.essentialMonthly * 1.1,
          optionalMonthly: data.spending.optionalMonthly * 1.1,
          travelEarlyRetirementAnnual:
            data.spending.travelEarlyRetirementAnnual * 1.1,
        },
      },
      assumptions,
    }),
  },
  {
    id: 'inheritance_delayed_3yr',
    group: 'stressor',
    label: (data) => {
      const inh = data.income.windfalls.find((w) => w.name === 'inheritance');
      if (!inh) return 'Inheritance delayed 3 years (no inheritance in seed)';
      return `Inheritance delayed 3 years (${formatCurrency(inh.amount)} now ${inh.year + 3})`;
    },
    note:
      'The inheritance windfall arrives 3 years later than your seed assumes. Tests how much the plan leans on that timing.',
    perturb: (data, assumptions) => {
      const idx = data.income.windfalls.findIndex(
        (w) => w.name === 'inheritance',
      );
      if (idx < 0) return { data, assumptions };
      const next = [...data.income.windfalls];
      next[idx] = { ...next[idx], year: next[idx].year + 3 };
      return {
        data: { ...data, income: { ...data.income, windfalls: next } },
        assumptions,
      };
    },
  },
  // ── Big events (low likelihood, high impact) ──────────────────────
  {
    id: 'ltc_event_certain',
    group: 'big_event',
    label: 'LTC event triggers (certain)',
    note: 'Long-term care kicks in at planned start age — no probability discount.',
    perturb: (data, assumptions) => ({
      data: {
        ...data,
        rules: {
          ...data.rules,
          ltcAssumptions: {
            enabled: true,
            startAge: data.rules.ltcAssumptions?.startAge ?? 78,
            annualCostToday:
              data.rules.ltcAssumptions?.annualCostToday ?? 100_000,
            durationYears: data.rules.ltcAssumptions?.durationYears ?? 3,
            inflationAnnual: data.rules.ltcAssumptions?.inflationAnnual,
            eventProbability: 1,
          },
        },
      },
      assumptions,
    }),
  },
  {
    id: 'equity_return_minus_1',
    group: 'big_event',
    label: 'Equity returns 1pp lower forever',
    note: 'Forward equity premium compresses — secular shift.',
    perturb: (data, assumptions) => ({
      data,
      assumptions: {
        ...assumptions,
        equityMean: assumptions.equityMean - 0.01,
        internationalEquityMean: assumptions.internationalEquityMean - 0.01,
      },
    }),
  },
];

interface ScenarioResult {
  successRate: number;
  medianEndingWealth: number;
}

interface BreakEvenResult {
  /** Total annual cut (today's $) that restores baseline solvency. */
  cutAnnual: number;
  /** Cut allocated to optional spend (today's $/yr). */
  optionalCut: number;
  /** Cut allocated to travel (today's $/yr). */
  travelCut: number;
  /** Solvency rate at the converged cut. */
  finalSuccessRate: number;
  /** Bisection iterations consumed. */
  iterations: number;
  /** True when the solver converged below the cut tolerance. */
  converged: boolean;
}

/**
 * Approximate the equivalent N-year bridge cut from a permanent cut.
 *
 * Solvency-equivalence is dominated by future-value of the cuts at
 * end of plan. Match cumulative compounded value:
 *
 *   bridge × Σ(1+r)^(H-t) for t=0..N  =  permanent × Σ(1+r)^(H-t) for t=0..H
 *
 * Closed form: bridge / permanent = (PV_H − 1) / (PV_H − PV_(H−N))
 * where PV_k = (1+r)^k. At r=0.05, H=30, N=5: ratio ≈ 3.3.
 *
 * Caveat: this is a present-value approximation, not a sim-equivalence.
 * Actual bridge cut may be a little higher or lower depending on the
 * household's portfolio mix and the year-by-year withdrawal pressure.
 * Used for directional display, NOT as a substitute for the permanent
 * answer (which IS sim-validated).
 */
function permanentToBridgeEquivalent(
  permanentAnnual: number,
  bridgeYears: number,
  horizonYears: number,
  realReturn: number,
): number {
  if (permanentAnnual <= 0 || bridgeYears <= 0 || horizonYears <= 0) return 0;
  if (bridgeYears >= horizonYears) return permanentAnnual;
  const pvHorizon = Math.pow(1 + realReturn, horizonYears);
  const pvAfterBridge = Math.pow(1 + realReturn, horizonYears - bridgeYears);
  const numerator = pvHorizon - 1;
  const denominator = pvHorizon - pvAfterBridge;
  if (denominator <= 0) return permanentAnnual;
  return permanentAnnual * (numerator / denominator);
}

const GROUP_META: Record<
  ScenarioGroup,
  { title: string; subtitle: string; tone: string }
> = {
  pair: {
    title: 'Stressor + response · paired',
    subtitle:
      'Something happens AND the household reacts. The combination is what really matters when you think about safety margins.',
    tone: 'border-blue-200 bg-blue-50/50',
  },
  stressor: {
    title: 'Stressors · external events',
    subtitle:
      'Things that might happen to the plan — markets, inflation, spending creep, layoff.',
    tone: 'border-amber-200 bg-amber-50/40',
  },
  response: {
    title: 'Likely responses · you control',
    subtitle:
      'Things the household would actually do first — cheap to deploy, high probability of being used.',
    tone: 'border-emerald-200 bg-emerald-50/50',
  },
  big_event: {
    title: 'Big events · low probability, high impact',
    subtitle:
      'Tail-risk shocks that change the picture if they hit.',
    tone: 'border-rose-200 bg-rose-50/30',
  },
};

function formatCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

function formatCurrencyExact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function ageThisYear(birthDateIso: string, currentYear: number): number {
  const birth = new Date(birthDateIso);
  return currentYear - birth.getFullYear();
}

function findUpcomingMilestones(data: SeedData, currentYear: number) {
  const out: Array<{ year: number; offsetYears: number; label: string }> = [];
  const robAge = ageThisYear(data.household.robBirthDate, currentYear);
  const debbieAge = ageThisYear(data.household.debbieBirthDate, currentYear);

  // Medicare 65 — both
  if (robAge < 65) out.push({ year: currentYear + (65 - robAge), offsetYears: 65 - robAge, label: 'Rob → Medicare (65)' });
  if (debbieAge < 65) out.push({ year: currentYear + (65 - debbieAge), offsetYears: 65 - debbieAge, label: 'Debbie → Medicare (65)' });

  // RMD start — assume 73 (Secure 2.0; engine has the real per-birth-year override)
  const rmdAge = 73;
  if (robAge < rmdAge) out.push({ year: currentYear + (rmdAge - robAge), offsetYears: rmdAge - robAge, label: `Rob → RMDs start (${rmdAge})` });
  if (debbieAge < rmdAge) out.push({ year: currentYear + (rmdAge - debbieAge), offsetYears: rmdAge - debbieAge, label: `Debbie → RMDs start (${rmdAge})` });

  // SS claim ages — show whichever is configured for each
  const ssRob = data.income?.socialSecurity?.find((s) => s.person === 'rob');
  const ssDebbie = data.income?.socialSecurity?.find((s) => s.person === 'debbie');
  if (ssRob && robAge < ssRob.claimAge) {
    out.push({ year: currentYear + (ssRob.claimAge - robAge), offsetYears: ssRob.claimAge - robAge, label: `Rob → SS claim (${ssRob.claimAge})` });
  }
  if (ssDebbie && debbieAge < ssDebbie.claimAge) {
    out.push({ year: currentYear + (ssDebbie.claimAge - debbieAge), offsetYears: ssDebbie.claimAge - debbieAge, label: `Debbie → SS claim (${ssDebbie.claimAge})` });
  }

  return out.sort((a, b) => a.offsetYears - b.offsetYears).slice(0, 6);
}

function findActiveIrmaaTier(magi: number) {
  for (const tier of IRMAA_TIERS_MFJ_2026) {
    if (magi <= tier.magiCeiling) return { current: tier, next: IRMAA_TIERS_MFJ_2026[IRMAA_TIERS_MFJ_2026.indexOf(tier) + 1] ?? null, distance: tier.magiCeiling - magi };
  }
  return { current: null, next: null, distance: 0 };
}

/**
 * Phase 3 assumption panel — exposes the inputs powering the dual TRUST
 * view (forward-looking parametric vs historical-precedent bootstrap).
 * Collapsed by default; opens on click for users who want to see what
 * the headline number embodies. Validated against Trinity Study within
 * 2-3pp in historical mode (see CALIBRATION_WORKPLAN.md "External
 * validation" section).
 */
function AssumptionPanel({
  assumptions,
  forwardLooking,
  historical,
}: {
  assumptions: MarketAssumptions;
  forwardLooking: PathResult | null;
  historical: PathResult | null;
}) {
  const [open, setOpen] = useState(false);
  const fwdSolv = forwardLooking
    ? Math.round(forwardLooking.successRate * 100)
    : null;
  const histSolv = historical ? Math.round(historical.successRate * 100) : null;
  const gap =
    fwdSolv !== null && histSolv !== null ? histSolv - fwdSolv : null;
  return (
    <div className="rounded-2xl border border-stone-200 bg-white/60 p-4 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
            Assumptions behind the trust number
          </p>
          <p className="mt-1 text-[13px] text-stone-600">
            {fwdSolv !== null && histSolv !== null ? (
              <>
                Forward-looking{' '}
                <span className="font-semibold text-stone-900">{fwdSolv}%</span>{' '}
                vs historical-precedent{' '}
                <span className="font-semibold text-stone-900">{histSolv}%</span>
                {gap !== null && gap !== 0 && (
                  <span className="text-stone-400">
                    {' '}
                    · {gap > 0 ? '+' : ''}
                    {gap}pp
                  </span>
                )}
                . The gap is the conservatism premium baked into the default.
              </>
            ) : (
              'Tap to inspect inputs.'
            )}
          </p>
        </div>
        <span className="mt-0.5 shrink-0 text-[12px] text-stone-400">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div className="mt-4 grid gap-4 text-[12px] md:grid-cols-2">
          <div className="rounded-xl bg-stone-50/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Forward-looking · parametric
            </p>
            <p className="mt-1 text-[11px] text-stone-500">
              Independent normal samples per asset class. Conservative;
              encodes the "future returns lower than past" thesis.
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
              <dt className="text-stone-500">Equity mean</dt>
              <dd className="text-stone-900">
                {(assumptions.equityMean * 100).toFixed(1)}%
              </dd>
              <dt className="text-stone-500">Equity vol</dt>
              <dd className="text-stone-900">
                {(assumptions.equityVolatility * 100).toFixed(1)}% (bounded ±45%)
              </dd>
              <dt className="text-stone-500">Equity tail</dt>
              <dd className="text-stone-900">
                {assumptions.equityTailMode === 'crash_mixture'
                  ? 'crash mixture (3%/yr from 1931/2008/1937/1974/2002)'
                  : 'symmetric Gaussian'}
              </dd>
              <dt className="text-stone-500">Bond mean</dt>
              <dd className="text-stone-900">
                {(assumptions.bondMean * 100).toFixed(1)}%
              </dd>
              <dt className="text-stone-500">Bond vol</dt>
              <dd className="text-stone-900">
                {(assumptions.bondVolatility * 100).toFixed(1)}% (bounded ±20%)
              </dd>
              <dt className="text-stone-500">Inflation</dt>
              <dd className="text-stone-900">
                {(assumptions.inflation * 100).toFixed(1)}% ±
                {(assumptions.inflationVolatility * 100).toFixed(1)}%
              </dd>
              <dt className="text-stone-500">Trials</dt>
              <dd className="text-stone-900">{assumptions.simulationRuns}</dd>
            </dl>
          </div>
          <div className="rounded-xl bg-stone-50/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Historical-precedent · bootstrap
            </p>
            <p className="mt-1 text-[11px] text-stone-500">
              Sampled from 1926-2023 historical year tuples. Preserves
              joint distribution (1929-32, 1973-74, 2008 are real options).
              Validated within 2-3pp of Trinity Study.
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
              <dt className="text-stone-500">Source</dt>
              <dd className="text-stone-900">1926–2023 fixture</dd>
              <dt className="text-stone-500">Equity mean (computed)</dt>
              <dd className="text-stone-900">~12.2% nominal</dd>
              <dt className="text-stone-500">Bond mean (computed)</dt>
              <dd className="text-stone-900">~4.9%</dd>
              <dt className="text-stone-500">Inflation (computed)</dt>
              <dd className="text-stone-900">~3.0% nominal</dd>
              <dt className="text-stone-500">Block length</dt>
              <dd className="text-stone-900">1 (iid)</dd>
              <dt className="text-stone-500">Trials</dt>
              <dd className="text-stone-900">{assumptions.simulationRuns}</dd>
            </dl>
          </div>
          <p className="text-[11px] text-stone-500 md:col-span-2">
            <span className="font-semibold text-stone-700">Why two numbers?</span>{' '}
            Forward-looking embeds a conservative future-returns view (equity
            mean ~7.4% vs historical ~12.2% nominal). Historical-precedent shows
            what the same plan would have done across every 30-year window of
            real US market data. Plan with the lower number; sleep with the higher.
          </p>
        </div>
      )}
    </div>
  );
}

function CockpitTile({
  eyebrow,
  title,
  subtitle,
  children,
  emphasis = false,
}: {
  eyebrow: string;
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  /** When true, render larger, more prominent — used for the Trust
   *  card so the household's headline confidence number gets visual
   *  weight matching its importance. */
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-3xl bg-white p-5 transition ${
        emphasis
          ? 'shadow-[0_2px_24px_rgba(15,40,80,0.05)]'
          : 'shadow-[0_1px_8px_rgba(15,40,80,0.04)]'
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-stone-400">
        {eyebrow}
      </p>
      {title && (
        <p
          className={`mt-2 tabular-nums text-stone-900 ${
            emphasis ? 'text-4xl font-light' : 'text-2xl font-semibold'
          }`}
        >
          {title}
        </p>
      )}
      {subtitle && (
        <p className="mt-1.5 text-[11px] text-stone-400">{subtitle}</p>
      )}
      {children && (
        <div
          className={`mt-3 space-y-2 text-stone-700 ${
            emphasis ? 'text-sm' : 'text-[13px]'
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function HardStopRow({
  label,
  current,
  threshold,
  consequence,
  unit = '$',
}: {
  label: string;
  current: number;
  threshold: number;
  consequence: string;
  unit?: string;
}) {
  const distance = threshold - current;
  const isPast = distance < 0;
  const pct = Math.max(0, Math.min(100, (current / threshold) * 100));
  return (
    <div className="border-l-2 border-stone-200 pl-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-semibold text-stone-700">{label}</span>
        <span
          className={`text-[11px] tabular-nums ${
            isPast ? 'text-rose-600' : distance < threshold * 0.1 ? 'text-amber-600' : 'text-stone-500'
          }`}
        >
          {isPast
            ? `OVER by ${unit === '$' ? formatCurrency(Math.abs(distance)) : Math.abs(distance)}`
            : `${unit === '$' ? formatCurrency(distance) : distance} ${unit === '$' ? 'below' : 'until'}`}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
        <div
          className={`h-full ${
            isPast ? 'bg-rose-500' : pct > 90 ? 'bg-amber-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-stone-500">
        Cliff at {unit === '$' ? formatCurrencyExact(threshold) : threshold}. {consequence}
      </p>
    </div>
  );
}

/**
 * Inline editor for `data.income.salaryEndDate`. Surfaced inside the
 * year column when the engine treats that year as a working year but
 * the household is asking why withdrawals aren't happening. Edits the
 * editable seed (`updateIncome`) and offers an "Apply" button that
 * commits to `appliedData` so the cockpit's projection re-derives
 * immediately — closing the loop without sending the household to
 * the Plan screen and back.
 */
function SalaryEndDateEditorBanner({
  year,
  wages,
  salaryEndDate,
}: {
  year: number;
  wages: number;
  salaryEndDate: string | null;
}) {
  const updateIncome = useAppStore((state) => state.updateIncome);
  const commitDraftToApplied = useAppStore(
    (state) => state.commitDraftToApplied,
  );
  const editableEndDate = useAppStore(
    (state) => state.data.income?.salaryEndDate,
  );

  // Drive the input from the editable seed; the prop reflects
  // appliedData (which lags). Display both so the household can see
  // staged-vs-applied state.
  const initial = (editableEndDate ?? salaryEndDate ?? '').slice(0, 10);
  const [draft, setDraft] = useState(initial);

  // Re-sync if the underlying value changes (e.g. another screen edits it).
  // Cheap effect-less reset: if `initial` and `draft` diverge because the
  // seed updated AND the user hasn't typed since, snap to the new value.
  if (initial !== draft && draft === '') {
    setDraft(initial);
  }

  const isValid = /^\d{4}-\d{2}-\d{2}$/.test(draft);
  const isStaged = isValid && draft !== (salaryEndDate ?? '').slice(0, 10);

  const onChangeDate = (value: string) => {
    setDraft(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      const iso = new Date(Date.UTC(y, m - 1, d)).toISOString();
      updateIncome('salaryEndDate', iso);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 space-y-1.5">
      <div>
        <span className="font-semibold">Working year per engine.</span>{' '}
        Salary {formatCurrencyExact(wages)}, no withdrawals. The engine
        prorates wages for the partial year of retirement, but spending
        stays full-year — so withdrawals only appear when wages + SS +
        windfalls fall short of annual spend.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>If you retire before {year}, change end date:</span>
        <input
          type="date"
          value={draft}
          onChange={(e) => onChangeDate(e.target.value)}
          className="rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] text-stone-900 focus:border-amber-600 focus:outline-none"
        />
        <button
          type="button"
          disabled={!isStaged}
          onClick={() => commitDraftToApplied()}
          className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
            isStaged
              ? 'bg-amber-600 text-white hover:bg-amber-700'
              : 'bg-stone-200 text-stone-400'
          }`}
          title={
            isStaged
              ? 'Commit edited end date to applied data and re-project'
              : 'Pick a different date to enable apply'
          }
        >
          Apply
        </button>
        {isStaged && (
          <span className="text-[10px] text-amber-700">
            Staged — click Apply to re-project.
          </span>
        )}
      </div>
      <p className="text-[10px] text-amber-700">
        Currently applied:{' '}
        <span className="font-mono">{salaryEndDate ?? '(not set)'}</span>.
        Adopting a policy doesn't change retirement date — that's a
        separate seed field.
      </p>
    </div>
  );
}

/**
 * Project a single PathYearResult into a column tile of human-readable
 * summary lines. The engine produces median estimates per year — we
 * display them as the "expected" values with no error bars (the user
 * gets the full distribution view from the existing Plan 2.0 screen;
 * this is the cockpit, intentionally simplified).
 */
function YearColumn({
  eyebrow,
  year,
  yr,
  monthly = false,
  policyTargetSpend,
  spendBuckets,
  salaryEndDate,
}: {
  eyebrow: string;
  year: number;
  yr: PathYearResult | null;
  /** When true, divide annual values by 12 so the tile reads as
   *  per-month. Caption notes the simplification. */
  monthly?: boolean;
  /** Adopted policy's annual spend target in today's dollars. Shown
   *  alongside the engine's projected median so the household can see
   *  both the plan intent and the engine's realized number — and any
   *  gap (pre-retirement transition, cash-flow constraint) is
   *  explicit rather than hidden. */
  policyTargetSpend?: number | null;
  /** Per-category annual spend from `appliedData.spending`. The engine's
   *  `medianSpending` is the realized total — these are the targets
   *  that get scaled by adoption and reduced by stressors. We show
   *  them so the household can see what's essential vs travel vs
   *  optional rather than one combined number. */
  spendBuckets?: {
    essentialAnnual: number;
    optionalAnnual: number;
    travelAnnual: number;
    taxesInsuranceAnnual: number;
  } | null;
  /** Current `appliedData.income.salaryEndDate` — surfaced when the
   *  engine projects salary in this year so the household sees the
   *  exact value to fix. */
  salaryEndDate?: string | null;
}) {
  if (!yr) {
    return (
      <CockpitTile eyebrow={eyebrow} subtitle={`Year ${year}`}>
        <p className="text-stone-400">No projection yet — adopt a plan and run it.</p>
      </CockpitTile>
    );
  }
  const div = monthly ? 12 : 1;
  const totalSpend = yr.medianSpending;
  const target =
    policyTargetSpend != null && Number.isFinite(policyTargetSpend)
      ? policyTargetSpend / div
      : null;
  const projected = totalSpend / div;
  const gap = target != null ? projected - target : null;
  const gapPct = target != null && target > 0 ? (gap! / target) * 100 : null;
  const totalWithdraw =
    yr.medianWithdrawalCash +
    yr.medianWithdrawalTaxable +
    yr.medianWithdrawalIra401k +
    yr.medianWithdrawalRoth;

  // Diagnostic: surface "working year per engine" only when the year
  // is at-or-after the configured salary-end year. Showing it on years
  // strictly before the end year is a false alarm — the household
  // really IS planning to work then.
  const wages = yr.medianAdjustedWages ?? 0;
  const salaryEndYear = salaryEndDate
    ? Number.parseInt(salaryEndDate.slice(0, 4), 10)
    : null;
  const looksLikeWorkingYear =
    wages > 5_000 &&
    totalWithdraw < 1_000 &&
    (salaryEndYear == null || year >= salaryEndYear);

  // All columns start collapsed — keeps the cockpit short by default.
  // Each column manages its own state so the user can flip them
  // independently after expanding.
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  const Row = ({
    label,
    value,
    valueClass = 'text-stone-700',
    indent = false,
    bold = false,
  }: {
    label: string;
    value: string;
    valueClass?: string;
    indent?: boolean;
    bold?: boolean;
  }) => (
    <>
      <span className={`text-stone-500 ${indent ? 'pl-2' : ''}`}>{label}</span>
      <span
        className={`tabular-nums text-right ${valueClass} ${
          bold ? 'font-semibold text-stone-900' : ''
        }`}
      >
        {value}
      </span>
    </>
  );

  return (
    <CockpitTile
      eyebrow={eyebrow}
      title={year.toString()}
      subtitle={
        monthly
          ? 'per-month view (annual ÷ 12 — engine runs yearly)'
          : 'projected · median across stochastic trials'
      }
    >
      {looksLikeWorkingYear && !monthly && (
        <SalaryEndDateEditorBanner
          year={year}
          wages={wages}
          salaryEndDate={salaryEndDate ?? null}
        />
      )}

      {/* Headline totals — always visible. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
        {target != null && (
          <Row
            label="Plan spend (target)"
            value={formatCurrencyExact(target)}
            bold
          />
        )}
        <span className="text-stone-500">
          {target != null ? 'Engine projected' : 'Spend'}
        </span>
        <span
          className={`tabular-nums text-right ${
            target == null
              ? 'font-semibold text-stone-900'
              : Math.abs(gapPct ?? 0) <= 2
              ? 'text-stone-700'
              : 'text-amber-700'
          }`}
        >
          {formatCurrencyExact(projected)}
          {target != null && gapPct != null && Math.abs(gapPct) > 2 && (
            <span className="ml-1 text-[10px] text-stone-500">
              ({gapPct > 0 ? '+' : ''}
              {gapPct.toFixed(0)}%)
            </span>
          )}
        </span>
        <Row
          label="Income"
          value={formatCurrencyExact(yr.medianIncome / div)}
        />
        <Row
          label="Withdraw total"
          value={formatCurrencyExact(totalWithdraw / div)}
        />
        <Row
          label="Federal tax"
          value={formatCurrencyExact(yr.medianFederalTax / div)}
        />
        <Row label="MAGI" value={formatCurrencyExact(yr.medianMagi / div)} />
        {yr.medianRothConversion > 0 && !monthly && (
          <Row
            label="Roth convert"
            value={formatCurrencyExact(yr.medianRothConversion)}
            valueClass="text-emerald-700"
          />
        )}
        {yr.medianRmdAmount > 0 && !monthly && (
          <Row
            label="RMD forced"
            value={formatCurrencyExact(yr.medianRmdAmount)}
            valueClass="text-amber-700"
          />
        )}
        <Row
          label="Assets EOY"
          value={formatCurrency(yr.medianAssets)}
        />
      </div>

      {/* Breakdown — collapsible. Holds the spend buckets, healthcare/
       *  IRMAA/LTC/HSA additions, withdrawal split, and salary sub-line.
       *  The household sees the bottom-line numbers above without
       *  scrolling; the detail is one click away. */}
      <button
        type="button"
        onClick={() => setBreakdownOpen((prev) => !prev)}
        className="mt-3 flex w-full items-center justify-between rounded-md border border-stone-200 bg-stone-50/60 px-2 py-1.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100"
      >
        <span>{breakdownOpen ? 'Hide' : 'Show'} detail breakdown</span>
        <span className="text-stone-400">{breakdownOpen ? '▾' : '▸'}</span>
      </button>
      {breakdownOpen && (
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
          {spendBuckets && (() => {
            // Two numbers worth surfacing:
            //   1. Plan dial (seed targets): essential + optional + travel + tax/insur
            //      from data.spending. This is YOUR dial setting — what the
            //      household has decided to spend in today's dollars.
            //   2. Engine lifestyle realized: medianSpending minus the
            //      engine-added components (healthcare, LTC, plus HSA
            //      offset). This is what the simulation actually spent
            //      this year, after time-varying logic (travel-phase,
            //      isRetired, scheduled spend, guardrails, plus median
            //      across stochastic runs).
            // Just show both. Don't try to attribute the gap to any one
            // mechanism — there are at least 5 (travel-phase end,
            // pre-retirement zeroing of travel, scheduled-spend scale,
            // guardrails, stochastic median noise) and we'd be guessing.
            const lifestyleRealized =
              yr.medianSpending -
              yr.medianAcaPremiumEstimate -
              yr.medianMedicarePremiumEstimate -
              yr.medianIrmaaSurcharge -
              yr.medianLtcCost +
              yr.medianHsaOffsetUsed;
            const seedTotal =
              spendBuckets.essentialAnnual +
              spendBuckets.optionalAnnual +
              spendBuckets.travelAnnual +
              spendBuckets.taxesInsuranceAnnual;
            const gap = lifestyleRealized - seedTotal;
            const gapPct = seedTotal > 0 ? (gap / seedTotal) * 100 : 0;
            const materialGap = Math.abs(gap) > seedTotal * 0.02;
            return (
              <>
                <span className="col-span-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                  Plan dial (your spending targets, today's $)
                </span>
                <Row
                  label="· essential"
                  value={formatCurrencyExact(spendBuckets.essentialAnnual / div)}
                  valueClass="text-stone-500"
                  indent
                />
                <Row
                  label="· optional"
                  value={formatCurrencyExact(spendBuckets.optionalAnnual / div)}
                  valueClass="text-stone-500"
                  indent
                />
                <Row
                  label="· travel"
                  value={formatCurrencyExact(spendBuckets.travelAnnual / div)}
                  valueClass="text-stone-500"
                  indent
                />
                <Row
                  label="· tax/insur."
                  value={formatCurrencyExact(
                    spendBuckets.taxesInsuranceAnnual / div,
                  )}
                  valueClass="text-stone-500"
                  indent
                />
                <Row
                  label="dial total"
                  value={formatCurrencyExact(seedTotal / div)}
                  valueClass="text-stone-700 font-semibold"
                />
                <Row
                  label="engine lifestyle realized"
                  value={formatCurrencyExact(lifestyleRealized / div)}
                  valueClass={
                    materialGap
                      ? 'text-amber-700 font-semibold'
                      : 'text-stone-700 font-semibold'
                  }
                />
                {materialGap && (
                  <span className="col-span-2 text-[10px] text-stone-500">
                    {gap < 0 ? 'Engine spent ' : 'Engine spent '}
                    <span
                      className={
                        gap < 0 ? 'text-amber-700' : 'text-emerald-700'
                      }
                    >
                      {gap < 0 ? '−' : '+'}
                      {formatCurrency(Math.abs(gap) / div)} (
                      {gapPct > 0 ? '+' : ''}
                      {gapPct.toFixed(0)}%)
                    </span>{' '}
                    {gap < 0 ? 'less' : 'more'} than dial. Likely causes:
                    travel phase not active yet (pre-retirement /
                    post-early-retirement), guardrails firing in some
                    stochastic runs, or scheduled-spend scaling. Engine
                    doesn't track per-bucket breakdown per year — only the
                    totals are honest.
                  </span>
                )}
              </>
            );
          })()}
          {(yr.medianAcaPremiumEstimate > 0 ||
            yr.medianMedicarePremiumEstimate > 0 ||
            yr.medianIrmaaSurcharge > 0 ||
            yr.medianLtcCost > 0 ||
            yr.medianHsaOffsetUsed > 0) && (
            <>
              <span className="col-span-2 mt-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                Spend (engine adds)
              </span>
              {(yr.medianAcaPremiumEstimate > 0 ||
                yr.medianMedicarePremiumEstimate > 0) && (
                <Row
                  label="· healthcare prem."
                  value={formatCurrencyExact(
                    (yr.medianAcaPremiumEstimate +
                      yr.medianMedicarePremiumEstimate) /
                      div,
                  )}
                  valueClass="text-stone-500"
                  indent
                />
              )}
              {yr.medianIrmaaSurcharge > 0 && (
                <Row
                  label="· IRMAA surcharge"
                  value={formatCurrencyExact(yr.medianIrmaaSurcharge / div)}
                  valueClass="text-amber-700"
                  indent
                />
              )}
              {yr.medianLtcCost > 0 && (
                <Row
                  label="· LTC (expected)"
                  value={formatCurrencyExact(yr.medianLtcCost / div)}
                  valueClass="text-rose-700"
                  indent
                />
              )}
              {yr.medianHsaOffsetUsed > 0 && (
                <Row
                  label="· HSA offset"
                  value={`−${formatCurrencyExact(
                    yr.medianHsaOffsetUsed / div,
                  )}`}
                  valueClass="text-emerald-700"
                  indent
                />
              )}
            </>
          )}
          <span className="col-span-2 mt-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
            Income sources
          </span>
          {wages > 0 && (
            <Row
              label="· salary"
              value={formatCurrencyExact(wages / div)}
              valueClass="text-stone-500"
              indent
            />
          )}
          <Row
            label="· other (SS, etc.)"
            value={formatCurrencyExact((yr.medianIncome - wages) / div)}
            valueClass="text-stone-500"
            indent
          />
          <span className="col-span-2 mt-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
            Withdrawal split
          </span>
          <Row
            label="· pretax"
            value={formatCurrencyExact(yr.medianWithdrawalIra401k / div)}
            valueClass="text-stone-500"
            indent
          />
          <Row
            label="· taxable"
            value={formatCurrencyExact(yr.medianWithdrawalTaxable / div)}
            valueClass="text-stone-500"
            indent
          />
          <Row
            label="· roth"
            value={formatCurrencyExact(yr.medianWithdrawalRoth / div)}
            valueClass="text-stone-500"
            indent
          />
          {yr.medianWithdrawalCash > 0 && (
            <Row
              label="· cash"
              value={formatCurrencyExact(yr.medianWithdrawalCash / div)}
              valueClass="text-stone-500"
              indent
            />
          )}
        </div>
      )}
    </CockpitTile>
  );
}

/**
 * Forward Monte Carlo bisection for a TIME-WINDOWED bridge cut.
 *
 * Unlike `solveBreakEvenCut` (which finds a permanent cut), this
 * solver finds the smallest annual cut applied for `bridgeYears`
 * starting now that restores baseline solvency. Uses the engine's
 * `annualSpendScheduleByYear` per-year spend override to actually
 * apply the cut only during the bridge window — sim-validated, not a
 * PV approximation.
 *
 * Returns null when even cutting all of optional+travel during the
 * bridge can't recover (rare, since concentrated early-year cuts are
 * efficient — but possible for very large stressors).
 */
function solveBridgeBreakEvenForward({
  data,
  assumptions,
  baseStressor,
  baselineSuccessRate,
  selectedStressors,
  selectedResponses,
  bridgeYears,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  baseStressor: (
    d: SeedData,
    a: MarketAssumptions,
  ) => { data: SeedData; assumptions: MarketAssumptions };
  baselineSuccessRate: number;
  selectedStressors: string[];
  selectedResponses: string[];
  bridgeYears: number;
}): {
  cutAnnual: number;
  totalCut: number;
  finalSuccessRate: number;
  iterations: number;
} | null {
  const TOLERANCE_RATE = 0.005;
  const MAX_ITER = 12;
  const stressed = baseStressor(data, assumptions);
  const startYear = new Date().getUTCFullYear();
  const bridgeYearList: number[] = [];
  for (let i = 0; i < bridgeYears; i++) {
    bridgeYearList.push(startYear + i);
  }

  // Total annual spend dial (today's $) from the perturbed seed.
  // Schedule entries override the engine's discretionary scale for
  // those years; we pass (full_dial − cut) to model the bridge.
  const fullDial =
    stressed.data.spending.essentialMonthly * 12 +
    stressed.data.spending.optionalMonthly * 12 +
    stressed.data.spending.travelEarlyRetirementAnnual +
    stressed.data.spending.annualTaxesInsurance;

  // Upper bound: cut to just essentials + tax/insur (i.e., zero
  // discretionary) for the whole bridge window. If even that can't
  // recover baseline solvency, no bridge cut alone will.
  const protectedFloor =
    stressed.data.spending.essentialMonthly * 12 +
    stressed.data.spending.annualTaxesInsurance;
  const maxCut = fullDial - protectedFloor;
  if (maxCut <= 0) return null;

  const runWithCut = (cutAnnual: number): number | null => {
    const schedule: Record<number, number> = {};
    for (const y of bridgeYearList) {
      schedule[y] = Math.max(protectedFloor, fullDial - cutAnnual);
    }
    const paths = buildPathResults(
      stressed.data,
      stressed.assumptions,
      selectedStressors,
      selectedResponses,
      { pathMode: 'selected_only', annualSpendScheduleByYear: schedule },
    );
    return paths[0]?.successRate ?? null;
  };

  // Probe upper bound first.
  const maxSr = runWithCut(maxCut);
  if (maxSr == null || maxSr < baselineSuccessRate - TOLERANCE_RATE) {
    return null;
  }

  // Bisect.
  let lo = 0;
  let hi = maxCut;
  let best: { cut: number; sr: number } | null = null;
  let iterations = 0;
  while (iterations < MAX_ITER && hi - lo > 500) {
    iterations++;
    const mid = (lo + hi) / 2;
    const sr = runWithCut(mid);
    if (sr == null) break;
    if (sr >= baselineSuccessRate - TOLERANCE_RATE) {
      hi = mid;
      best = { cut: mid, sr };
    } else {
      lo = mid;
    }
  }
  if (!best) {
    best = { cut: maxCut, sr: maxSr };
  }
  return {
    cutAnnual: best.cut,
    totalCut: best.cut * bridgeYears,
    finalSuccessRate: best.sr,
    iterations,
  };
}

/**
 * Bisect on total annual spending cut until the layoff (or other base
 * stressor) recovers to the baseline solvency rate (within tolerance).
 * Each iteration runs one full Monte Carlo pass via `buildPathResults`,
 * so we cap at 12 iterations — enough to land within ~$500/yr on a
 * search range of ~$100k/yr.
 *
 * Returns null if even cutting 100% of optional+travel can't restore
 * baseline solvency (the layoff is too damaging for a spending-only
 * response — household would need to delay retirement, sell assets,
 * etc.).
 */
function solveBreakEvenCut({
  data,
  assumptions,
  baseStressor,
  baselineSuccessRate,
  selectedStressors,
  selectedResponses,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  baseStressor: (
    d: SeedData,
    a: MarketAssumptions,
  ) => { data: SeedData; assumptions: MarketAssumptions };
  baselineSuccessRate: number;
  selectedStressors: string[];
  selectedResponses: string[];
}): BreakEvenResult | null {
  const TOLERANCE_RATE = 0.005; // 0.5pp
  const MAX_ITER = 12;
  const stressed = baseStressor(data, assumptions);

  // Upper bound: cut everything cuttable (optional + travel). If even
  // that doesn't get us back to baseline, no break-even exists for the
  // pair "stressor + spending cut alone" — signal with null.
  const optionalAnnual = stressed.data.spending.optionalMonthly * 12;
  const travelAnnual = stressed.data.spending.travelEarlyRetirementAnnual;
  const maxCut = optionalAnnual + travelAnnual;
  if (maxCut <= 0) return null;

  // Probe upper bound first to see if break-even is reachable.
  const probeMax = applyProportionalCut(stressed.data, maxCut);
  const maxResultPath = buildPathResults(
    probeMax.data,
    stressed.assumptions,
    selectedStressors,
    selectedResponses,
    { pathMode: 'selected_only' },
  )[0];
  if (
    !maxResultPath ||
    maxResultPath.successRate < baselineSuccessRate - TOLERANCE_RATE
  ) {
    return null;
  }

  // Bisect over total annual cut amount.
  let lo = 0;
  let hi = maxCut;
  let best: { cut: number; sr: number } | null = null;
  let iterations = 0;
  while (iterations < MAX_ITER && hi - lo > 500) {
    iterations++;
    const mid = (lo + hi) / 2;
    const cutApplied = applyProportionalCut(stressed.data, mid);
    const path = buildPathResults(
      cutApplied.data,
      stressed.assumptions,
      selectedStressors,
      selectedResponses,
      { pathMode: 'selected_only' },
    )[0];
    if (!path) break;
    if (path.successRate >= baselineSuccessRate - TOLERANCE_RATE) {
      hi = mid;
      best = { cut: mid, sr: path.successRate };
    } else {
      lo = mid;
    }
  }

  if (!best) {
    // Fall back to the max-cut answer when bisection didn't capture it.
    best = { cut: maxCut, sr: maxResultPath.successRate };
  }
  const split = applyProportionalCut(data, best.cut);
  return {
    cutAnnual: best.cut,
    optionalCut: split.optionalCut,
    travelCut: split.travelCut,
    finalSuccessRate: best.sr,
    iterations,
    converged: hi - lo <= 500,
  };
}

/**
 * Balance-by-bucket line chart. Y axis = today's $ (well, sim-time
 * nominal — we don't deflate, so later years look bigger; that
 * matches how the household will see balances on statements).
 * X axis = year. One line per bucket: pretax (IRA/401k), Roth,
 * taxable, cash. Total is shown as a darker dashed reference line
 * so the household can see "is the mix shifting away from pretax?"
 * without losing the full-portfolio picture.
 */
function BalanceTrajectoryChart({
  yearlySeries,
}: {
  yearlySeries: PathYearResult[];
}) {
  const chartData = useMemo(() => {
    return yearlySeries.map((y) => ({
      year: y.year,
      pretax: y.medianPretaxBalance,
      taxable: y.medianTaxableBalance,
      roth: y.medianRothBalance,
      cash: y.medianCashBalance,
      total: y.medianAssets,
    }));
  }, [yearlySeries]);

  if (chartData.length === 0) {
    return null;
  }

  const formatY = (value: number): string => {
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}k`;
    return `$${Math.round(value)}`;
  };

  const formatTooltip = (value: number): string => {
    return `$${Math.round(value).toLocaleString()}`;
  };

  return (
    <div className="rounded-3xl bg-white p-6 shadow-[0_2px_24px_rgba(15,40,80,0.05)]">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-stone-400">
          Account balances over time
        </p>
        <p className="text-[11px] text-stone-400">
          {chartData[0].year} → {chartData[chartData.length - 1].year}
        </p>
      </div>
      <p className="mt-2 text-sm text-stone-500">
        Pretax tends to drop with RMDs and withdrawals; Roth grows with
        conversions; taxable funds the bridge years.
      </p>
      <div className="mt-4" style={{ width: '100%', height: 340 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
          >
            <defs>
              <linearGradient id="totalFill" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="#0071E3"
                  stopOpacity={0.18}
                />
                <stop
                  offset="95%"
                  stopColor="#0071E3"
                  stopOpacity={0.02}
                />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#f0ede7" strokeDasharray="3 3" />
            <XAxis
              dataKey="year"
              tick={{ fontSize: 11, fill: '#a8a29e' }}
              stroke="#d6d3d1"
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#a8a29e' }}
              stroke="#d6d3d1"
              tickFormatter={formatY}
              width={56}
            />
            <Tooltip
              formatter={formatTooltip}
              labelFormatter={(label) => `Year ${label}`}
              contentStyle={{
                fontSize: 12,
                borderRadius: 12,
                border: 'none',
                boxShadow: '0 4px 24px rgba(60,70,40,0.12)',
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              iconType="line"
              iconSize={14}
            />
            <Area
              type="monotone"
              dataKey="total"
              name="Total"
              stroke="#0071E3"
              strokeWidth={2.5}
              fill="url(#totalFill)"
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="pretax"
              name="Pretax (IRA/401k)"
              stroke="#78716c"
              strokeWidth={1.5}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="taxable"
              name="Taxable"
              stroke="#a8a29e"
              strokeWidth={1.5}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="roth"
              name="Roth"
              stroke="#3B9DEB"
              strokeWidth={1.5}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="cash"
              name="Cash"
              stroke="#d6d3d1"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[10px] text-stone-400">
        Nominal dollars (engine doesn't deflate). Each line is the
        median balance across stochastic trials at end-of-year. The
        crossover where Roth or taxable overtakes pretax is the
        Roth-conversion strategy paying off; if pretax stays high
        late, RMDs will be material.
      </p>
    </div>
  );
}

/**
 * Cockpit Sensitivity panel — runs each scenario through the engine
 * and reports the delta vs baseline. Lazy: nothing is computed until
 * the user clicks "Run scenarios" (each run is another full Monte
 * Carlo path, which adds up fast). Results stream in progressively
 * via setTimeout(0) yields between scenarios so the UI stays
 * responsive instead of blocking on a single tick.
 */
function CockpitSensitivityPanel({
  baseline,
  data,
  assumptions,
  selectedStressors,
  selectedResponses,
}: {
  baseline: PathResult | null;
  data: SeedData | null | undefined;
  assumptions: MarketAssumptions | null | undefined;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  const [results, setResults] = useState<Map<string, ScenarioResult>>(
    new Map(),
  );
  const [breakEvens, setBreakEvens] = useState<
    Map<string, BreakEvenResult | 'unreachable'>
  >(new Map());
  const [forwardBridges, setForwardBridges] = useState<
    Map<
      string,
      | { cutAnnual: number; totalCut: number; finalSuccessRate: number }
      | 'unreachable'
    >
  >(new Map());
  const [computing, setComputing] = useState(false);
  const [computingBreakEven, setComputingBreakEven] = useState<string | null>(
    null,
  );
  const [computedKey, setComputedKey] = useState<string | null>(null);

  // Cache key — rerun scenarios whenever the underlying inputs change.
  const inputKey = useMemo(() => {
    if (!data || !assumptions || !baseline) return null;
    return JSON.stringify({
      // Cheap fingerprint — just the dials that materially change
      // the perturbation outcomes. Not perfect, but good enough to
      // invalidate when the user adopts a policy / changes assumptions.
      spending: data.spending,
      salaryEndDate: data.income?.salaryEndDate,
      socialSecurity: data.income?.socialSecurity,
      ltc: data.rules?.ltcAssumptions,
      equityMean: assumptions.equityMean,
      inflation: assumptions.inflation,
      simulationRuns: assumptions.simulationRuns,
    });
  }, [data, assumptions, baseline]);

  const isStale = computedKey != null && computedKey !== inputKey;

  const runScenarios = useCallback(async () => {
    if (!data || !assumptions || !baseline) return;
    setComputing(true);
    setBreakEvens(new Map());
    const next = new Map<string, ScenarioResult>();
    setResults(next);
    for (const def of SCENARIOS) {
      // Yield to the browser so progress is visible scenario-by-scenario.
      await new Promise((r) => setTimeout(r, 0));
      try {
        const perturbed = def.perturb(data, assumptions);
        const paths = buildPathResults(
          perturbed.data,
          perturbed.assumptions,
          selectedStressors,
          selectedResponses,
          { pathMode: 'selected_only' },
        );
        const path = paths[0];
        if (path) {
          next.set(def.id, {
            successRate: path.successRate,
            medianEndingWealth: path.medianEndingWealth,
          });
          // New Map ref so React re-renders.
          setResults(new Map(next));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[cockpit-sensitivity] scenario ${def.id} failed:`, err);
      }
    }

    // Phase 2: break-even bisection for pair scenarios that opt in.
    // Each solve is ~10–12 sim runs, so we run them after the main
    // panel has rendered all the basic deltas. Streams in the same
    // way (one solver per scenario, yielding between).
    for (const def of SCENARIOS) {
      if (!def.breakEvenSolver) continue;
      setComputingBreakEven(def.id);
      await new Promise((r) => setTimeout(r, 0));
      try {
        const breakEven = solveBreakEvenCut({
          data,
          assumptions,
          baseStressor: def.breakEvenSolver.baseStressor,
          baselineSuccessRate: baseline.successRate,
          selectedStressors,
          selectedResponses,
        });
        setBreakEvens((prev) => {
          const m = new Map(prev);
          m.set(def.id, breakEven ?? 'unreachable');
          return m;
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[cockpit-sensitivity] break-even for ${def.id} failed:`,
          err,
        );
      }
    }
    setComputingBreakEven(null);

    // Phase 3: forward Monte Carlo for the bridge cut. Uses the
    // engine's annualSpendScheduleByYear to apply cuts ONLY during
    // years 0..4 from now, then resume full spend. Sim-validated
    // answer that supersedes the PV approximation when it matches,
    // and surfaces any discrepancy when it doesn't.
    for (const def of SCENARIOS) {
      if (!def.breakEvenSolver) continue;
      await new Promise((r) => setTimeout(r, 0));
      try {
        const fwd = solveBridgeBreakEvenForward({
          data,
          assumptions,
          baseStressor: def.breakEvenSolver.baseStressor,
          baselineSuccessRate: baseline.successRate,
          selectedStressors,
          selectedResponses,
          bridgeYears: 5,
        });
        setForwardBridges((prev) => {
          const m = new Map(prev);
          m.set(def.id, fwd ?? 'unreachable');
          return m;
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[cockpit-sensitivity] forward bridge for ${def.id} failed:`,
          err,
        );
      }
    }

    setComputing(false);
    setComputedKey(inputKey);
  }, [data, assumptions, baseline, selectedStressors, selectedResponses, inputKey]);

  const grouped = useMemo(() => {
    const map: Record<ScenarioGroup, ScenarioDef[]> = {
      pair: [],
      stressor: [],
      response: [],
      big_event: [],
    };
    for (const def of SCENARIOS) map[def.group].push(def);
    return map;
  }, []);

  const showResults = results.size > 0;

  return (
    <div className="rounded-2xl border border-stone-200 bg-white/80 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
            Sensitivity · what would change the recommendation
          </p>
          <p className="mt-1 text-[11px] text-stone-500">
            Δ vs baseline — solvency (never runs out) and median bequest.
            Each row reruns the engine with one dial perturbed.
          </p>
        </div>
        <button
          type="button"
          disabled={computing || !baseline}
          onClick={runScenarios}
          className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${
            computing
              ? 'bg-stone-300 text-stone-500'
              : isStale
              ? 'bg-amber-600 text-white hover:bg-amber-700'
              : 'bg-stone-900 text-white hover:bg-stone-700'
          } disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {computing
            ? computingBreakEven
              ? `Solving break-even…`
              : `Computing… ${results.size}/${SCENARIOS.length}`
            : showResults && !isStale
            ? 'Re-run'
            : isStale
            ? 'Inputs changed — re-run'
            : 'Run scenarios'}
        </button>
      </div>

      {!baseline && (
        <p className="mt-3 text-[12px] text-stone-400">
          Run a baseline plan first — sensitivity needs something to
          compare against.
        </p>
      )}

      {baseline && !showResults && !computing && (
        <p className="mt-3 text-[12px] text-stone-500">
          Click <span className="font-semibold">Run scenarios</span> to see
          how each lever moves the trust metrics. Each scenario takes a
          fraction of a second; results stream in.
        </p>
      )}

      {(showResults || computing) && baseline && (
        <div className="mt-3 space-y-3">
          {(['pair', 'stressor', 'response', 'big_event'] as ScenarioGroup[]).map(
            (group) => {
              const meta = GROUP_META[group];
              return (
                <div
                  key={group}
                  className={`rounded-lg border ${meta.tone} p-3`}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-700">
                    {meta.title}
                  </p>
                  <p className="mt-0.5 text-[10px] text-stone-500">
                    {meta.subtitle}
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {grouped[group].map((def) => {
                      const r = results.get(def.id);
                      const pending = computing && !r;
                      const dSolvent =
                        r != null
                          ? (r.successRate - baseline.successRate) * 100
                          : null;
                      const dBequest =
                        r != null
                          ? r.medianEndingWealth - baseline.medianEndingWealth
                          : null;
                      const labelText =
                        typeof def.label === 'function'
                          ? data
                            ? def.label(data)
                            : def.id
                          : def.label;
                      const breakEven = breakEvens.get(def.id);
                      const breakEvenPending =
                        def.breakEvenSolver != null &&
                        breakEven == null &&
                        (computing || computingBreakEven === def.id);
                      return (
                        <div
                          key={def.id}
                          className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 border-b border-stone-100 pb-1.5 last:border-b-0 last:pb-0"
                        >
                          <div>
                            <div className="text-[12px] font-medium text-stone-800">
                              {labelText}
                            </div>
                            <div className="text-[10px] text-stone-500">
                              {def.note}
                            </div>
                            {def.breakEvenSolver && (
                              <div className="mt-1 rounded-md bg-blue-100/60 px-2 py-1 text-[11px] text-blue-900">
                                {breakEvenPending && (
                                  <span className="text-blue-700">
                                    🎯 Solving break-even cut…{' '}
                                    {computingBreakEven === def.id
                                      ? '(bisecting)'
                                      : '(queued)'}
                                  </span>
                                )}
                                {!breakEvenPending &&
                                  breakEven === 'unreachable' && (
                                    <span className="text-rose-700">
                                      ⚠ No spending cut alone restores
                                      baseline solvency — even cutting
                                      optional + travel to zero falls
                                      short. You'd need to delay
                                      retirement, sell assets, or accept
                                      lower solvency.
                                    </span>
                                  )}
                                {!breakEvenPending &&
                                  breakEven &&
                                  breakEven !== 'unreachable' && (
                                    <div className="space-y-1">
                                      <div>
                                        🎯{' '}
                                        <strong>
                                          Permanent cut:
                                        </strong>{' '}
                                        <strong>
                                          {formatCurrencyExact(
                                            Math.round(breakEven.cutAnnual),
                                          )}
                                          /yr
                                        </strong>{' '}
                                        ={' '}
                                        {formatCurrencyExact(
                                          Math.round(breakEven.optionalCut),
                                        )}{' '}
                                        optional +{' '}
                                        {formatCurrencyExact(
                                          Math.round(breakEven.travelCut),
                                        )}{' '}
                                        travel · restores solvency to{' '}
                                        {Math.round(
                                          breakEven.finalSuccessRate * 100,
                                        )}
                                        % (baseline{' '}
                                        {Math.round(
                                          baseline.successRate * 100,
                                        )}
                                        %) · over{' '}
                                        {(baseline.yearlySeries.length || 30)}-yr plan
                                        ={' '}
                                        {formatCurrency(
                                          breakEven.cutAnnual *
                                            (baseline.yearlySeries.length || 30),
                                        )}{' '}
                                        total
                                      </div>
                                      <div className="text-blue-800">
                                        ⚡{' '}
                                        <strong>
                                          5-yr bridge (PV approx):
                                        </strong>{' '}
                                        ~
                                        {formatCurrencyExact(
                                          Math.round(
                                            permanentToBridgeEquivalent(
                                              breakEven.cutAnnual,
                                              5,
                                              baseline.yearlySeries.length || 30,
                                              0.05,
                                            ),
                                          ),
                                        )}
                                        /yr × 5 yrs ={' '}
                                        {formatCurrency(
                                          permanentToBridgeEquivalent(
                                            breakEven.cutAnnual,
                                            5,
                                            baseline.yearlySeries.length || 30,
                                            0.05,
                                          ) * 5,
                                        )}{' '}
                                        total
                                      </div>
                                      {(() => {
                                        const fwd = forwardBridges.get(def.id);
                                        if (fwd == null) {
                                          return (
                                            <div className="text-[10px] text-stone-500">
                                              🔬 Forward sim validation
                                              queued…
                                            </div>
                                          );
                                        }
                                        if (fwd === 'unreachable') {
                                          return (
                                            <div className="text-[11px] text-rose-700">
                                              🔬 Forward sim: bridge cut
                                              alone can't restore baseline
                                              solvency.
                                            </div>
                                          );
                                        }
                                        const pvApprox =
                                          permanentToBridgeEquivalent(
                                            breakEven.cutAnnual,
                                            5,
                                            baseline.yearlySeries.length || 30,
                                            0.05,
                                          );
                                        const pvDeltaPct =
                                          pvApprox > 0
                                            ? ((fwd.cutAnnual - pvApprox) /
                                                pvApprox) *
                                              100
                                            : 0;
                                        const verdict =
                                          Math.abs(pvDeltaPct) <= 15
                                            ? 'PV approx is close (within 15%)'
                                            : `PV approx off by ${Math.round(pvDeltaPct)}% — trust the forward sim`;
                                        return (
                                          <div className="font-semibold text-emerald-800">
                                            🔬{' '}
                                            <strong>
                                              5-yr bridge (forward sim):
                                            </strong>{' '}
                                            <strong>
                                              {formatCurrencyExact(
                                                Math.round(fwd.cutAnnual),
                                              )}
                                              /yr × 5 yrs
                                            </strong>{' '}
                                            ={' '}
                                            {formatCurrency(fwd.totalCut)}{' '}
                                            total · restores solvency to{' '}
                                            {Math.round(
                                              fwd.finalSuccessRate * 100,
                                            )}
                                            %
                                            <div className="mt-0.5 text-[10px] font-normal text-stone-500">
                                              {verdict}
                                            </div>
                                          </div>
                                        );
                                      })()}
                                      <div className="text-[10px] text-stone-500">
                                        Forward sim uses engine's
                                        annualSpendScheduleByYear to
                                        actually apply cuts in years 0–4
                                        only — sim-validated, not an
                                        approximation.
                                      </div>
                                    </div>
                                  )}
                              </div>
                            )}
                          </div>
                          <div
                            className={`text-right text-[12px] tabular-nums ${
                              dSolvent == null
                                ? 'text-stone-300'
                                : dSolvent >= -0.5
                                ? 'text-emerald-700'
                                : dSolvent >= -3
                                ? 'text-amber-700'
                                : 'text-rose-600'
                            }`}
                          >
                            {pending
                              ? '…'
                              : dSolvent == null
                              ? '—'
                              : `${dSolvent >= 0 ? '+' : ''}${dSolvent.toFixed(1)}pp`}
                            <div className="text-[9px] uppercase tracking-wider text-stone-400">
                              solvent
                            </div>
                          </div>
                          <div
                            className={`text-right text-[12px] tabular-nums ${
                              dBequest == null
                                ? 'text-stone-300'
                                : dBequest >= 0
                                ? 'text-emerald-700'
                                : dBequest > -250_000
                                ? 'text-amber-700'
                                : 'text-rose-600'
                            }`}
                          >
                            {pending
                              ? '…'
                              : dBequest == null
                              ? '—'
                              : `${dBequest >= 0 ? '+' : ''}${formatCurrency(
                                  dBequest,
                                )}`}
                            <div className="text-[9px] uppercase tracking-wider text-stone-400">
                              bequest
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            },
          )}
          <p className="text-[10px] text-stone-400">
            Solvency Δ in percentage points (e.g. +1.5pp = 84% → 85.5%).
            Bequest Δ in today's dollars vs baseline median ending wealth.
            Negative isn't necessarily bad — "Cut spending 10%" preserves
            wealth (positive bequest) but may not be what you'd actually
            want. Read the row in context.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Recommended SS claim card. SS claim age is purely an engine output —
 * household has no preset; the optimizer evaluates the (65..70 × 65..70)
 * grid against the household's north-star constraints and surfaces the
 * pair that wins. There's no "Your current seed" comparison anymore —
 * SS flows like income and taxes, computed from facts (FRA monthly,
 * birth dates) plus the engine's strategy choice.
 *
 * Cost: ~10-15s of CPU on a 36-cell sweep at 500 trials per cell. Runs
 * with yields between primary-age slices so the UI stays responsive.
 * Cached by seed fingerprint via the inner ref.
 */
function RecommendedSocialSecurityCard({
  result,
  running,
  error,
}: {
  result: SocialSecurityOptimizationResult | null;
  running: boolean;
  error: string | null;
}) {
  const recommended = result?.recommended ?? null;

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Recommended SS claim · engine output
          </p>
          <p className="mt-1 text-[12px] text-stone-600">
            SS claim age flows from the engine — like income and taxes —
            optimized against your solvency + legacy goals. No preset; the
            household just supplies FRA monthly amounts and birth dates.
          </p>
        </div>
        {running && !result && (
          <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            Searching…
          </span>
        )}
      </div>

      {error && (
        <p className="mt-3 text-[12px] text-rose-700">
          Optimizer error: {error}
        </p>
      )}

      {!result && !error && (
        <p className="mt-3 text-[12px] text-stone-500">
          Searching the 6×6 SS claim grid (ages 65–70 each). ~10–15s on
          first pass; cached after.
        </p>
      )}

      {result && recommended && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2 rounded-xl bg-white/80 p-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
              Engine recommendation
            </p>
            <p className="mt-2 text-[20px] font-semibold tabular-nums text-stone-900">
              Rob @ {recommended.primaryAge}
              {result.hasSpouse && recommended.spouseAge !== null && (
                <> · Debbie @ {recommended.spouseAge}</>
              )}
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-0.5 text-[12px] tabular-nums">
              <dt className="text-stone-500">Solvent</dt>
              <dt className="text-stone-500">Hits legacy</dt>
              <dt className="text-stone-500">p50 EW (today $)</dt>
              <dd className="font-semibold text-stone-900">
                {Math.round(recommended.solventSuccessRate * 100)}%
              </dd>
              <dd className="font-semibold text-stone-900">
                {result.targetLegacyAttainmentRate !== null
                  ? `${Math.round(recommended.bequestAttainmentRate * 100)}%`
                  : '—'}
              </dd>
              <dd className="font-semibold text-stone-900">
                {formatCurrency(recommended.p50EndingWealthTodayDollars)}
              </dd>
            </dl>
          </div>

          <div className="md:col-span-2 rounded-xl border border-emerald-200/60 bg-white p-3 text-[12px]">
            <p className="text-stone-700">
              {result.feasibleCount} of {result.ranked.length} (
              {result.ageRange.min}–{result.ageRange.max} × {result.ageRange.min}
              –{result.ageRange.max}) claim pairs satisfy both north stars.
              Engine pick maximizes solvent rate → bequest attainment → p50
              ending wealth.
            </p>
            <p className="mt-1 text-[11px] text-stone-400">
              {result.trialCount} trials per cell. The Cockpit projection
              above already runs at this recommended pair — no manual adoption
              needed.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Max-sustainable-spend card. Companion to the SS recommendation:
 * answers "how much COULD we spend if we wanted to?" by bisecting on
 * annual spending until we find the highest level that sustains the
 * target solvency. Doesn't change the household's lifestyle decision —
 * just exposes the frontier so they can decide where to sit relative to
 * it.
 *
 * Cost: ~7-9 engine calls × ~3s = ~20-27s on first paint at 500 trials,
 * cached by seed fingerprint thereafter.
 */
function MaxSustainableSpendCard({
  result,
  running,
  error,
}: {
  result: SpendOptimizationResult | null;
  running: boolean;
  error: string | null;
}) {
  const recommended = result?.recommendedEvaluation ?? null;
  const current = result?.currentSeedEvaluation ?? null;
  const spendDelta =
    recommended && current
      ? recommended.annualSpendTodayDollars -
        current.annualSpendTodayDollars
      : null;
  const isAtFrontier =
    spendDelta !== null && Math.abs(spendDelta) < 5_000;

  return (
    <div className="rounded-2xl border border-sky-200 bg-sky-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
            Max sustainable spending · engine output
          </p>
          <p className="mt-1 text-[12px] text-stone-600">
            How much you could spend each year while satisfying both
            north stars (≥85% solvent AND ≥85% chance of hitting the
            legacy target), with the engine's recommended SS strategy
            already applied.
          </p>
        </div>
        {running && !result && (
          <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-medium text-sky-700">
            Bisecting…
          </span>
        )}
      </div>

      {error && (
        <p className="mt-3 text-[12px] text-rose-700">
          Optimizer error: {error}
        </p>
      )}

      {!result && !error && (
        <p className="mt-3 text-[12px] text-stone-500">
          Bisecting the spending frontier ($60k–$250k) at 500 trials per
          step. ~20–27s on first pass; cached after.
        </p>
      )}

      {result && recommended && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {/* Recommended frontier */}
          <div className="rounded-xl bg-white/80 p-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-700">
              Frontier (
              {Math.round(result.targetSolventRate * 100)}% solvent
              {result.targetLegacyAttainmentRate !== null && (
                <>
                  {' '}+ {Math.round(result.targetLegacyAttainmentRate * 100)}% legacy
                </>
              )}
              )
            </p>
            <p className="mt-2 text-[20px] font-semibold tabular-nums text-stone-900">
              {formatCurrencyExact(
                recommended.annualSpendTodayDollars,
              )}
              /yr
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] tabular-nums">
              <dt className="text-stone-500">Solvent</dt>
              <dd className="font-semibold text-stone-900">
                {Math.round(recommended.solventSuccessRate * 100)}%
              </dd>
              {recommended.legacyAttainmentRate !== null && (
                <>
                  <dt className="text-stone-500">Hits legacy</dt>
                  <dd className="font-semibold text-stone-900">
                    {Math.round(recommended.legacyAttainmentRate * 100)}%
                  </dd>
                </>
              )}
              <dt className="text-stone-500">p50 EW (today $)</dt>
              <dd className="font-semibold text-stone-900">
                {formatCurrency(recommended.p50EndingWealthTodayDollars)}
              </dd>
            </dl>
          </div>

          {/* Current seed spending */}
          <div className="rounded-xl bg-white/60 p-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Your current lifestyle
            </p>
            {current ? (
              <>
                <p className="mt-2 text-[20px] font-semibold tabular-nums text-stone-900">
                  {formatCurrencyExact(current.annualSpendTodayDollars)}/yr
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] tabular-nums">
                  <dt className="text-stone-500">Solvent</dt>
                  <dd className="font-semibold text-stone-900">
                    {Math.round(current.solventSuccessRate * 100)}%
                  </dd>
                  {current.legacyAttainmentRate !== null && (
                    <>
                      <dt className="text-stone-500">Hits legacy</dt>
                      <dd className="font-semibold text-stone-900">
                        {Math.round(current.legacyAttainmentRate * 100)}%
                      </dd>
                    </>
                  )}
                  <dt className="text-stone-500">p50 EW (today $)</dt>
                  <dd className="font-semibold text-stone-900">
                    {formatCurrency(current.p50EndingWealthTodayDollars)}
                  </dd>
                </dl>
              </>
            ) : (
              <p className="mt-2 text-[12px] text-stone-500">
                Seed has no spending configured.
              </p>
            )}
          </div>

          {/* Headroom callout */}
          <div className="md:col-span-2 rounded-xl border border-sky-200/60 bg-white p-3 text-[12px]">
            {!result.feasible ? (
              <p className="text-rose-700">
                <span className="font-semibold">North star violation.</span>{' '}
                Even at the search floor (
                {formatCurrencyExact(result.searchRange.min)}/yr), your plan
                fails the{' '}
                {result.bindingConstraint === 'legacy'
                  ? 'legacy attainment'
                  : result.bindingConstraint === 'solvency'
                  ? 'solvency'
                  : 'solvency AND legacy attainment'}{' '}
                floor. No spending tweak fixes this — the strategy needs
                to change (returns, retirement timing, more savings, or
                relax the legacy target).
              </p>
            ) : isAtFrontier ? (
              <p className="text-stone-700">
                You're sitting essentially at the frontier — no meaningful
                headroom to spend more without violating a north star.
                Binding: <span className="font-semibold">{result.bindingConstraint}</span>.
              </p>
            ) : spendDelta !== null && spendDelta > 0 ? (
              <p className="text-stone-700">
                <span className="font-semibold text-sky-700 tabular-nums">
                  +{formatCurrencyExact(spendDelta)}/yr
                </span>{' '}
                of headroom while still meeting both north stars. Binding
                constraint at the frontier:{' '}
                <span className="font-semibold">{result.bindingConstraint}</span>
                .
              </p>
            ) : (
              <p className="text-amber-800">
                <span className="font-semibold tabular-nums">
                  {formatCurrencyExact(spendDelta ?? 0)}/yr
                </span>{' '}
                relative to frontier — your current spending is above the
                level that satisfies both north stars. Cut to the frontier,
                relax a constraint, or shift strategy (SS, allocation,
                retirement timing).
              </p>
            )}
            <p className="mt-1 text-[11px] text-stone-400">
              Bisection · {result.trace.length} engine evals · {result.trialCount} trials each ·
              tolerance {formatCurrencyExact(2_000)}/yr.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Recommended Roth conversion ceiling card. Companion to the SS and
 * spend optimizer cards: at the engine-recommended SS strategy + max
 * spend, sweeps the Roth-conversion-ceiling axis and picks the level
 * that maximizes p50 ending wealth (today's $) subject to both north
 * stars. The current household value is read from the seed's
 * `rules.rothConversionPolicy.magiBufferDollars` proxy.
 */
function RecommendedRothCeilingCard({
  result,
  currentSeedCeiling,
  running,
  error,
}: {
  result: RothOptimizationResult | null;
  currentSeedCeiling: number | null;
  running: boolean;
  error: string | null;
}) {
  const recommended = result?.recommended ?? null;
  const currentInRanked =
    currentSeedCeiling !== null && result
      ? result.ranked.find(
          (c) => c.ceilingTodayDollars === currentSeedCeiling,
        ) ?? null
      : null;
  const ewDelta =
    recommended && currentInRanked
      ? recommended.p50EndingWealthTodayDollars -
        currentInRanked.p50EndingWealthTodayDollars
      : null;
  const isSameCeiling =
    recommended != null &&
    currentSeedCeiling !== null &&
    recommended.ceilingTodayDollars === currentSeedCeiling;
  return (
    <div className="rounded-2xl border border-violet-200 bg-violet-50/40 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-700">
            Recommended Roth ceiling · engine output
          </p>
          <p className="mt-1 text-[12px] text-stone-600">
            How aggressively to convert pretax → Roth each year. Engine
            evaluates at your recommended SS + spend, picks the ceiling
            that maximizes p50 ending wealth in today's $ while still
            meeting both north stars.
          </p>
        </div>
        {running && !result && (
          <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-medium text-violet-700">
            Sweeping…
          </span>
        )}
      </div>

      {error && (
        <p className="mt-3 text-[12px] text-rose-700">
          Optimizer error: {error}
        </p>
      )}

      {!result && !error && (
        <p className="mt-3 text-[12px] text-stone-500">
          Sweeping 6 ceiling levels ($0 – $200k/yr) at 500 trials each.
          ~15–20s; cached after.
        </p>
      )}

      {result && recommended && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl bg-white/80 p-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-700">
              Recommended
            </p>
            <p className="mt-2 text-[20px] font-semibold tabular-nums text-stone-900">
              {formatCurrencyExact(recommended.ceilingTodayDollars)}/yr
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] tabular-nums">
              <dt className="text-stone-500">Solvent</dt>
              <dd className="font-semibold text-stone-900">
                {Math.round(recommended.solventSuccessRate * 100)}%
              </dd>
              {result.targetLegacyAttainmentRate !== null && (
                <>
                  <dt className="text-stone-500">Hits legacy</dt>
                  <dd className="font-semibold text-stone-900">
                    {Math.round(recommended.bequestAttainmentRate * 100)}%
                  </dd>
                </>
              )}
              <dt className="text-stone-500">p50 EW (today $)</dt>
              <dd className="font-semibold text-stone-900">
                {formatCurrency(recommended.p50EndingWealthTodayDollars)}
              </dd>
            </dl>
          </div>

          <div className="rounded-xl bg-white/60 p-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Your current seed
            </p>
            {currentInRanked ? (
              <>
                <p className="mt-2 text-[20px] font-semibold tabular-nums text-stone-900">
                  {formatCurrencyExact(currentInRanked.ceilingTodayDollars)}/yr
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] tabular-nums">
                  <dt className="text-stone-500">Solvent</dt>
                  <dd className="font-semibold text-stone-900">
                    {Math.round(currentInRanked.solventSuccessRate * 100)}%
                  </dd>
                  {result.targetLegacyAttainmentRate !== null && (
                    <>
                      <dt className="text-stone-500">Hits legacy</dt>
                      <dd className="font-semibold text-stone-900">
                        {Math.round(currentInRanked.bequestAttainmentRate * 100)}%
                      </dd>
                    </>
                  )}
                  <dt className="text-stone-500">p50 EW (today $)</dt>
                  <dd className="font-semibold text-stone-900">
                    {formatCurrency(currentInRanked.p50EndingWealthTodayDollars)}
                  </dd>
                </dl>
              </>
            ) : (
              <p className="mt-2 text-[12px] text-stone-500">
                Seed ceiling is outside the searched grid — adopt the
                recommendation to apply.
              </p>
            )}
          </div>

          <div className="md:col-span-2 rounded-xl border border-violet-200/60 bg-white p-3 text-[12px]">
            {isSameCeiling ? (
              <p className="text-stone-700">
                Your seed's Roth ceiling already matches the recommendation —
                no change indicated.
              </p>
            ) : ewDelta !== null && ewDelta > 0 ? (
              <p className="text-stone-700">
                Switching to the recommended ceiling lifts p50 ending wealth
                by{' '}
                <span className="font-semibold text-violet-700 tabular-nums">
                  +{formatCurrency(ewDelta)}
                </span>{' '}
                (today $) under the same SS + spend plan.
              </p>
            ) : ewDelta !== null && ewDelta < 0 ? (
              <p className="text-amber-800">
                The recommended ceiling lowers p50 ending wealth by{' '}
                <span className="font-semibold tabular-nums">
                  {formatCurrency(ewDelta)}
                </span>{' '}
                vs your seed — that's because your seed sits at a more
                aggressive level than the engine prefers under the
                constraints. Use either; this is an information signal.
              </p>
            ) : (
              <p className="text-stone-700">
                {result.feasibleCount} of {result.ranked.length} ceilings
                meet both north stars.
              </p>
            )}
            <p className="mt-1 text-[11px] text-stone-400">
              Sweep · 6 ceiling levels · {result.trialCount} trials each.
              Ranking: feasibility (north stars) → max p50 EW (today $) →
              lower median federal tax. The engine's per-year IRMAA-
              and bracket-aware Roth logic still operates within this
              ceiling.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function CockpitScreen() {
  const data = useAppStore((state) => state.appliedData);
  const editableData = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.appliedAssumptions);
  const selectedStressors = useAppStore((state) => state.appliedSelectedStressors);
  const selectedResponses = useAppStore((state) => state.appliedSelectedResponses);
  // Adopted policy lives on the store, not on SeedData. Read it
  // directly so the cockpit reflects the household's adopted plan even
  // before they've re-applied (in which case `appliedData` still has
  // pre-adoption spend buckets — we surface that gap explicitly).
  const lastPolicyAdoption = useAppStore((state) => state.lastPolicyAdoption);
  const commitDraftToApplied = useAppStore((state) => state.commitDraftToApplied);
  const setCurrentScreen = useAppStore((state) => state.setCurrentScreen);

  // Mining-corpus-backed recommendation. Phase 1 of MINER_REFACTOR:
  // surface the corpus state as a banner above the existing TRUST
  // card. The cockpit's headline numbers still read from the legacy
  // bisection chain — Phase 2 retires that and rewires TRUST to the
  // corpus directly.
  const cluster = useClusterSession();
  const recommendation = useRecommendedPolicy(
    data ?? null,
    assumptions ?? null,
    selectedStressors ?? [],
    selectedResponses ?? [],
    cluster.snapshot.dispatcherUrl ?? null,
  );

  // Run a baseline path so we have year-by-year medians for the tiles.
  // Memoized on the inputs so flipping into the cockpit tab is cheap
  // after the first render. (For a Full mine corpus with an adopted
  // policy, the more correct source is the adopted policy's stored
  // result — but for the prototype we run the live baseline and label
  // it "current plan projection".)
  const baselinePathBoth = useMemo(() => {
    if (!data || !assumptions)
      return { forwardLooking: null, historical: null } as BaselinePathBoth;
    return getCachedBaselinePathBoth(
      data,
      assumptions,
      selectedStressors ?? [],
      selectedResponses ?? [],
    );
  }, [data, assumptions, selectedStressors, selectedResponses]);
  const baselinePath: PathResult | null = baselinePathBoth.forwardLooking;
  const historicalPath: PathResult | null = baselinePathBoth.historical;

  // Phase 2: when the mining corpus has a top-1 record, that's our
  // recommendation. If no corpus exists yet, do not run the old
  // bisection fallback automatically; it can monopolize the main thread
  // long enough that the user cannot click into the mining screen.
  //
  // Stale-corpus is treated as no-corpus for the path-MC step: the cached
  // policy was mined against a different fingerprint, so running two full
  // Monte Carlo passes for it (forward-looking + historical, ~5-15s on
  // main thread) is wasted work — the household just gets the banner
  // telling them to re-mine. Only run the recommended-path MC when the
  // corpus is actually fresh.
  const corpusRecommendation =
    recommendation.state === 'fresh' ? recommendation.policy : null;
  const useCorpusPick = corpusRecommendation != null;

  const recommendedPath = useRecommendedPath(
    data ?? null,
    assumptions ?? null,
    corpusRecommendation,
    selectedStressors ?? [],
    selectedResponses ?? [],
  );

  // Plan-optimization chain (SS → spend → Roth → optimizedPath).
  // Kept as a dormant fallback API, but skipped by default so mining is
  // the authoritative recommendation path and startup remains clickable.
  const planOpt = usePlanOptimization(data, assumptions, true);
  const ssOptResult = planOpt.ssResult;
  const spendOptResult = planOpt.spendResult;
  const rothOptResult = planOpt.rothResult;
  const optimizedPath = useCorpusPick
    ? recommendedPath.forwardLooking
    : planOpt.optimizedPath;
  const planOptRunning =
    planOpt.stage === 'ss' ||
    planOpt.stage === 'spend' ||
    planOpt.stage === 'roth';
  const planOptError = planOpt.error;
  const currentSeedRothCeiling =
    data?.rules?.rothConversionPolicy?.magiBufferDollars ?? null;

  // Drive every panel below the Trust card off the optimized path
  // when it's ready. Falls back to the seed-based baselinePath while
  // the optimization is still running so the UI doesn't blank out.
  const planPath: PathResult | null = optimizedPath ?? baselinePath;

  // Year-by-year series: prefer the optimized projection so every
  // tile (this month, this year, next year, trajectory chart, actions
  // due) stays consistent with the Trust headline. Fall back to
  // baselinePath while the optimizer is still running.
  const yearlySeries =
    optimizedPath?.yearlySeries ?? baselinePath?.yearlySeries ?? [];
  const currentYear = new Date().getFullYear();
  const yearIndex = Math.max(
    0,
    yearlySeries.findIndex((y) => y.year >= currentYear),
  );
  const thisYear = yearlySeries[yearIndex] ?? null;
  const nextYear = yearlySeries[yearIndex + 1] ?? null;

  const milestones = useMemo(
    () => (data ? findUpcomingMilestones(data, currentYear) : []),
    [data, currentYear],
  );

  const irmaaThisYear = thisYear ? findActiveIrmaaTier(thisYear.medianMagi) : null;
  const irmaaNextYear = nextYear ? findActiveIrmaaTier(nextYear.medianMagi) : null;

  const adopted = lastPolicyAdoption?.policy ?? null;
  const legacyTarget = data?.goals?.legacyTargetTodayDollars;

  // Legacy attainment — second half of the north star ("leave money").
  // Computed for BOTH modes: forward-looking parametric (the
  // conservative default that drives the headline) and historical-
  // precedent bootstrap (matches what most other retirement planners
  // — Boldin, FICalc, Empower — show by default). The gap between the
  // two is the same conservatism premium that's already visible on
  // solvency. Cheap — no extra engine calls; reuses the cached paths.
  const legacyAttainmentBoth = useMemo(() => {
    if (!legacyTarget || legacyTarget <= 0) {
      return { forwardLooking: null, historical: null };
    }
    const inflation = assumptions?.inflation ?? 0.025;
    const computeFor = (path: PathResult | null): number | null => {
      if (!path) return null;
      const horizonYears = path.yearlySeries?.length ?? 30;
      const factor = Math.pow(
        1 + Math.max(-0.99, inflation),
        Math.max(0, horizonYears),
      );
      const deflate = (n: number) => (factor > 0 ? n / factor : n);
      const pcts = path.endingWealthPercentiles;
      return approximateBequestAttainmentRate(legacyTarget, {
        p10: deflate(pcts.p10),
        p25: deflate(pcts.p25),
        p50: deflate(pcts.p50),
        p75: deflate(pcts.p75),
        p90: deflate(pcts.p90),
      });
    };
    return {
      forwardLooking: computeFor(baselinePath),
      historical: computeFor(historicalPath),
    };
  }, [baselinePath, historicalPath, legacyTarget, assumptions?.inflation]);
  const legacyAttainmentRate = legacyAttainmentBoth.forwardLooking;
  const legacyAttainmentHistorical = legacyAttainmentBoth.historical;

  // Headline source-of-truth: the mining corpus's recommended policy
  // (Phase 2 of MINER_REFACTOR). When the corpus has a pick, the TRUST
  // card and footer cite ITS solvency / legacy / spend — the bisection
  // chain is skipped entirely. Falls back to the bisection chain's
  // output for plans without a corpus (transitional state until every
  // household has run their first mine).
  const optimizedSolventRate = useCorpusPick
    ? corpusRecommendation!.outcome.solventSuccessRate
    : (spendOptResult?.recommendedEvaluation.solventSuccessRate ?? null);
  const optimizedLegacyRate = useCorpusPick
    ? corpusRecommendation!.outcome.bequestAttainmentRate
    : (spendOptResult?.recommendedEvaluation.legacyAttainmentRate ?? null);
  const optimizedSpend = useCorpusPick
    ? corpusRecommendation!.policy.annualSpendTodayDollars
    : (spendOptResult?.recommendedAnnualSpendTodayDollars ?? null);
  const optimizedFeasible = useCorpusPick
    ? // Corpus picks always pass the ranker's gates (legacy ≥ 85%,
      // solvency ≥ 70%) — feasibility is implicit in the recommendation.
      true
    : (spendOptResult?.feasible ?? null);
  // Banner triggers only when the legacy bisection chain runs and
  // declares the plan infeasible. Corpus path never sets this — when
  // no record clears the ranker's gates, `recommendation.policy` is
  // null and the cockpit's empty-state banner takes over.
  const northStarViolated =
    !useCorpusPick &&
    spendOptResult !== null &&
    spendOptResult.feasible === false;
  // SS / Roth ages for the footer copy. Corpus picks expose these on
  // the policy itself; bisection picks expose them on the per-stage
  // results.
  const recommendedPrimarySsAge = useCorpusPick
    ? corpusRecommendation!.policy.primarySocialSecurityClaimAge
    : (ssOptResult?.recommended.primaryAge ?? null);
  const recommendedSpouseSsAge = useCorpusPick
    ? corpusRecommendation!.policy.spouseSocialSecurityClaimAge
    : (ssOptResult?.recommended.spouseAge ?? null);
  const recommendedRothCeiling = useCorpusPick
    ? corpusRecommendation!.policy.rothConversionAnnualCeiling
    : (rothOptResult?.recommended.ceilingTodayDollars ?? null);
  const recommendedWithdrawalRule = useCorpusPick
    ? corpusRecommendation!.policy.withdrawalRule ?? null
    : null;

  // Total spend currently in `appliedData` (what the engine actually
  // sees) vs the editable seed (what they're staging). When adoption
  // hasn't been re-applied, these diverge — surface that gap.
  const appliedSpendTotal = data?.spending
    ? data.spending.essentialMonthly * 12 +
      data.spending.optionalMonthly * 12 +
      data.spending.travelEarlyRetirementAnnual +
      data.spending.annualTaxesInsurance
    : null;
  const editableSpendTotal = editableData?.spending
    ? editableData.spending.essentialMonthly * 12 +
      editableData.spending.optionalMonthly * 12 +
      editableData.spending.travelEarlyRetirementAnnual +
      editableData.spending.annualTaxesInsurance
    : null;
  const spendStale =
    adopted != null &&
    appliedSpendTotal != null &&
    Math.abs(appliedSpendTotal - adopted.annualSpendTodayDollars) > 1;

  const spendBuckets = data?.spending
    ? {
        essentialAnnual: data.spending.essentialMonthly * 12,
        optionalAnnual: data.spending.optionalMonthly * 12,
        travelAnnual: data.spending.travelEarlyRetirementAnnual,
        taxesInsuranceAnnual: data.spending.annualTaxesInsurance,
      }
    : null;

  return (
    <div className="space-y-6 py-2">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0066CC]">
            Today
          </p>
          <h1 className="mt-2 text-4xl font-semibold leading-tight tracking-tight text-stone-900">
            Plan cockpit
          </h1>
        </div>
        <p className="text-xs text-stone-400">
          {baselinePath
            ? `${yearlySeries.length}-year horizon`
            : 'Run a plan to populate'}
        </p>
      </div>

      {/* Engine activity banner. The optimizer chain (SS → spend → Roth)
       *  runs asynchronously after the baseline lands, but takes 5-15s
       *  total. Without a visible signal, users see stale numbers
       *  morph mid-glance — call it out. The progress bar reuses the
       *  composite progressFraction the optimizer already updates. */}
      {planOptRunning && !useCorpusPick && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5 text-[12px] text-blue-900">
          <div className="flex items-center justify-between gap-3">
            <span>
              <span
                className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500 align-middle"
                aria-hidden
              />
              <span className="font-semibold">Optimizing plan…</span>{' '}
              {planOpt.stage === 'ss'
                ? 'searching Social Security claim ages'
                : planOpt.stage === 'spend'
                  ? 'finding sustainable spending level'
                  : 'tuning Roth conversion ceiling'}
              . Numbers below will update when it finishes.
            </span>
            <span className="tabular-nums text-blue-700">
              {Math.round((planOpt.progressFraction ?? 0) * 100)}%
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-blue-100">
            <div
              className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
              style={{
                width: `${Math.min(100, Math.max(0, (planOpt.progressFraction ?? 0) * 100))}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* MINER_REFACTOR Phase 1 — corpus-state banners. The TRUST card
       *  below still reads from the legacy bisection chain; these
       *  banners surface the mining corpus's state so the household
       *  can run a mine if needed. Phase 2 retires the bisection chain
       *  and rewires TRUST to read from the corpus directly. */}
      {recommendation.state === 'no-corpus' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-300 bg-blue-50/70 p-3 text-[12px] text-blue-900">
          <div className="flex-1 min-w-[260px]">
            <span className="font-semibold">No mined corpus for this plan.</span>{' '}
            The cockpit's recommendation comes from a mining run that
            evaluates ~50,000 strategy combinations against your plan.
            Run one to populate the recommended policy on this screen.
          </div>
          <button
            type="button"
            onClick={() => setCurrentScreen('mining')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Run a mine →
          </button>
        </div>
      )}
      {recommendation.state === 'stale-corpus' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50/70 p-3 text-[12px] text-amber-900">
          <div className="flex-1 min-w-[260px]">
            <span className="font-semibold">Plan changed since last mine.</span>{' '}
            Recommendations on this screen reflect a previous version of
            your plan. Re-mine to refresh with the current inputs.
          </div>
          <button
            type="button"
            onClick={() => setCurrentScreen('mining')}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-amber-700"
          >
            Re-run mine →
          </button>
        </div>
      )}
      {spendStale && adopted && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50/70 p-3 text-[12px] text-amber-900">
          <div className="flex-1 min-w-[260px]">
            <span className="font-semibold">Stale projection.</span>{' '}
            Adopted policy spend is{' '}
            <span className="font-semibold">
              {formatCurrencyExact(adopted.annualSpendTodayDollars)}/yr
            </span>
            , but the projection below was run against{' '}
            <span className="font-semibold">
              {formatCurrencyExact(appliedSpendTotal)}/yr
            </span>
            .
          </div>
          {editableSpendTotal != null &&
          Math.abs(editableSpendTotal - adopted.annualSpendTodayDollars) < 1 ? (
            <button
              type="button"
              onClick={commitDraftToApplied}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-amber-700"
            >
              Apply adopted policy &amp; refresh
            </button>
          ) : (
            <span className="text-[11px] text-amber-800">
              Adoption isn't staged in the editor either — open the Plan
              screen and re-adopt, or undo + re-adopt from Policy Mining.
            </span>
          )}
        </div>
      )}

      {/* North-star violation banner. Appears when the engine completed
       *  a full optimization pass and the household's plan can't satisfy
       *  both stated north stars at any spend level in the search range. */}
      {northStarViolated && spendOptResult && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50/80 p-4 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
            North star violation
          </p>
          <p className="mt-1 text-[13px] text-stone-800">
            <span className="font-semibold">No spending level satisfies both north stars.</span>{' '}
            Even at{' '}
            <span className="tabular-nums">
              {formatCurrencyExact(spendOptResult.searchRange.min)}/yr
            </span>{' '}
            (the search floor), with the engine's recommended SS strategy
            applied, your plan fails the{' '}
            {spendOptResult.bindingConstraint === 'legacy' ? (
              <>
                <span className="font-semibold">legacy attainment</span> floor (
                {Math.round((spendOptResult.targetLegacyAttainmentRate ?? 0.85) * 100)}% target).
              </>
            ) : spendOptResult.bindingConstraint === 'solvency' ? (
              <>
                <span className="font-semibold">solvency</span> floor (
                {Math.round(spendOptResult.targetSolventRate * 100)}% target).
              </>
            ) : (
              <>
                <span className="font-semibold">solvency AND legacy</span> floors
                (both {Math.round(spendOptResult.targetSolventRate * 100)}%).
              </>
            )}
          </p>
          <p className="mt-2 text-[12px] text-stone-700">
            Spending alone can't fix this. Real options:{' '}
            <span className="font-semibold">delay retirement</span>,{' '}
            <span className="font-semibold">add savings before retirement</span>,{' '}
            <span className="font-semibold">relax a north star</span> (lower the
            legacy target or the solvency floor), or{' '}
            <span className="font-semibold">accept the conservative forward-looking projection</span>{' '}
            (the historical-precedent reading on the Trust card may already meet
            the stars under more typical assumptions).
          </p>
        </div>
      )}

      {/* Top banner: Trust gets the lion's share (2 cols, big number),
       *  Adopted policy and Actions due are quieter sidekicks. */}
      <div className="grid gap-4 lg:grid-cols-4">
        <div className="lg:col-span-2 rounded-3xl bg-white p-7 shadow-[0_2px_24px_rgba(15,40,80,0.05)]">
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-stone-400">
            Trust
          </p>
          {baselinePath ? (
            <>
              {/* The Trust card now reads from the OPTIMIZED plan when
               *  available — i.e., the projection at (recommended SS,
               *  recommended max spend). The seed-based baselinePath is
               *  only used as a fallback while the optimizers run. The
               *  85% threshold is the household's stated north-star
               *  floor; below it the number paints rose. */}
              {(() => {
                const useOpt = optimizedSolventRate !== null;
                const solventForDisplay = useOpt
                  ? optimizedSolventRate!
                  : baselinePath.successRate;
                const legacyForDisplay = useOpt
                  ? optimizedLegacyRate
                  : legacyAttainmentRate;
                return (
                  <div className="mt-3 grid grid-cols-2 gap-x-6">
                    <div>
                      <p
                        className={`font-serif text-6xl font-light tabular-nums leading-none ${
                          solventForDisplay >= 0.85
                            ? 'text-[#0066CC]'
                            : solventForDisplay >= 0.70
                            ? 'text-amber-700'
                            : 'text-rose-600'
                        }`}
                      >
                        {Math.round(solventForDisplay * 100)}%
                      </p>
                      <p className="mt-1 text-[12px] text-stone-500">
                        stays solvent
                      </p>
                    </div>
                    <div>
                      {legacyForDisplay !== null ? (
                        <>
                          <p
                            className={`font-serif text-6xl font-light tabular-nums leading-none ${
                              legacyForDisplay >= 0.85
                                ? 'text-emerald-700'
                                : legacyForDisplay >= 0.5
                                ? 'text-amber-700'
                                : 'text-rose-600'
                            }`}
                          >
                            {Math.round(legacyForDisplay * 100)}%
                          </p>
                          <p className="mt-1 text-[12px] text-stone-500">
                            hits {formatCurrencyExact(legacyTarget ?? null)} legacy
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="font-serif text-6xl font-light tabular-nums leading-none text-stone-300">
                            —
                          </p>
                          <p className="mt-1 text-[12px] text-stone-400">
                            legacy target not set
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                );
              })()}
              <p className="mt-3 text-[11px] text-stone-400">
                {assumptions?.simulationRuns ?? '?'} trials · forward-looking
                {optimizedSpend !== null && (
                  <>
                    {' '}· at {useCorpusPick ? 'mined' : 'engine'} plan (
                    {formatCurrencyExact(optimizedSpend)}/yr,
                    SS {recommendedPrimarySsAge ?? '—'}/{recommendedSpouseSsAge ?? '—'}
                    {recommendedRothCeiling != null && (
                      <>, Roth ≤ {formatCurrencyExact(recommendedRothCeiling)}/yr</>
                    )}
                    {recommendedWithdrawalRule && (
                      <>, {recommendedWithdrawalRule.replace(/_/g, ' ')}</>
                    )}
                    )
                  </>
                )}
                {optimizedSpend === null && planOptRunning && !useCorpusPick && (
                  <span className="text-stone-400"> · optimizing plan…</span>
                )}
                {recommendedPath.computing && useCorpusPick && (
                  <span className="text-stone-400"> · projecting recommended plan…</span>
                )}
              </p>
              {historicalPath && (
                <p className="mt-1 text-[12px] text-stone-500">
                  Historical-precedent reading:{' '}
                  <span className="font-medium text-stone-700 tabular-nums">
                    {Math.round(historicalPath.successRate * 100)}%
                  </span>{' '}
                  solvent
                  {legacyAttainmentHistorical !== null && (
                    <>
                      {' · '}
                      <span className="font-medium text-stone-700 tabular-nums">
                        {Math.round(legacyAttainmentHistorical * 100)}%
                      </span>{' '}
                      hits legacy
                    </>
                  )}
                  {' · '}
                  median EW{' '}
                  <span className="font-medium text-stone-700 tabular-nums">
                    {formatCurrency(historicalPath.medianEndingWealth)}
                  </span>
                  {' · '}
                  <span className="text-stone-400">1926–2023 bootstrap</span>
                </p>
              )}
              <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-stone-400">
                    Legacy target
                  </p>
                  <p className="mt-1 font-medium text-stone-900 tabular-nums">
                    {formatCurrencyExact(legacyTarget ?? null)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-stone-400">
                    Median ending wealth
                  </p>
                  <p className="mt-1 font-medium text-stone-900 tabular-nums">
                    {formatCurrency(
                      (optimizedPath ?? baselinePath).medianEndingWealth,
                    )}
                  </p>
                </div>
              </div>
              <p className="mt-4 text-[11px] text-stone-400">
                "Solvent" = didn't run out of money. "Hits legacy" =
                approximate % chance of leaving at least the target,
                interpolated from the today's-dollars cemetery distribution.
                Other planners (Boldin, FICalc, Empower) typically default
                to historical-style assumptions — their headline numbers
                are usually close to our historical-precedent reading, not
                the conservative forward-looking default above.
              </p>
            </>
          ) : (
            <p className="mt-4 text-sm text-stone-400">No projection yet.</p>
          )}
        </div>

        <CockpitTile eyebrow="Adopted policy">
          {adopted ? (
            <div className="space-y-1.5 text-[13px]">
              <div>
                Spend{' '}
                <span className="font-semibold text-stone-900">
                  {formatCurrencyExact(adopted.annualSpendTodayDollars)}/yr
                </span>
              </div>
              <div className="text-stone-600">
                Rob SS @{' '}
                <span className="font-semibold text-stone-900">
                  {adopted.primarySocialSecurityClaimAge}
                </span>
                , Debbie SS @{' '}
                <span className="font-semibold text-stone-900">
                  {adopted.spouseSocialSecurityClaimAge ?? '—'}
                </span>
              </div>
              <div className="text-stone-600">
                Roth ceiling{' '}
                <span className="font-semibold text-stone-900">
                  {formatCurrencyExact(adopted.rothConversionAnnualCeiling)}/yr
                </span>
              </div>
            </div>
          ) : (
            <p className="text-stone-400 text-sm">
              No adopted policy yet. Open Re-run Model and pick one.
            </p>
          )}
        </CockpitTile>

        <CockpitTile eyebrow="Actions due">
          {thisYear && thisYear.medianRothConversion > 0 ? (
            <div className="space-y-1 text-[12px]">
              <div>
                Roth conversion this year:{' '}
                <span className="font-semibold text-stone-900">
                  {formatCurrencyExact(thisYear.medianRothConversion)}
                </span>
              </div>
              <p className="text-[11px] text-stone-500">
                {thisYear.dominantRothConversionReason || 'Recommended by withdrawal optimizer.'}
              </p>
            </div>
          ) : thisYear && thisYear.medianRmdAmount > 0 ? (
            <div className="space-y-1 text-[12px]">
              <div>
                RMD this year:{' '}
                <span className="font-semibold text-amber-700">
                  {formatCurrencyExact(thisYear.medianRmdAmount)}
                </span>
              </div>
              <p className="text-[11px] text-stone-500">
                Required minimum distribution from pretax accounts.
              </p>
            </div>
          ) : (
            <p className="text-stone-400 text-[12px]">
              No discrete actions this year.
            </p>
          )}
        </CockpitTile>
      </div>

      {/* Phase 2 of MINER_REFACTOR: when the corpus has the recommended
       *  policy, the bisection-chain detail cards have nothing to show
       *  (we skipped that work). Hide them so the cockpit doesn't
       *  display empty "running…" placeholders. The TRUST card and
       *  footer above already cite the corpus pick. Phase 2.B will
       *  rebuild these tiles on top of the corpus's per-axis stats. */}
      {!useCorpusPick && (
        <>
          <RecommendedSocialSecurityCard
            result={ssOptResult}
            running={planOptRunning && ssOptResult === null}
            error={planOptError}
          />

          <MaxSustainableSpendCard
            result={spendOptResult}
            running={planOptRunning}
            error={planOptError}
          />

          <RecommendedRothCeilingCard
            result={rothOptResult}
            currentSeedCeiling={currentSeedRothCeiling}
            running={planOptRunning && rothOptResult === null}
            error={planOptError}
          />
        </>
      )}

      {/* Mortality sensitivity — what if Rob dies at his p10 ("early")
          or p50 ("median") death age per SSA period life table 2020.
          Shows the survivor switch in action: Debbie jumps from spousal
          floor to 100% of Rob's claim amount when he dies. Rendered
          below the optimizer cards because it's a sensitivity, not the
          baseline; the baseline projects to 95 for both.
          Lazy-mounted: 3 extra engine runs (~6s) start ONLY when the
          user scrolls within 300px of this card. eagerAfterMs disabled
          because each of these cards runs sync MC on mount — auto-
          mounting them after a fixed timer triggers the same
          page-unresponsive hang the IntersectionObserver fix was
          meant to prevent. */}
      {/* DISABLED 2026-05-05: MortalitySensitivityCard runs 3 sync MC
          passes on mount, and CalibrationDashboard's UncertaintyRange-
          Tile runs 6 perturbation MC passes — both block the main
          thread for 5-15s when the household scrolls past them and
          locks the browser. Hidden behind a flag until the compute
          is moved to simulation.worker.ts (backlog item). Cockpit
          headline numbers still render from the corpus — they don't
          depend on these cards. */}
      <div className="rounded-2xl border border-stone-200 bg-stone-50/40 p-4 text-sm text-stone-600">
        <p className="font-medium text-stone-700">Calibration signals temporarily hidden</p>
        <p className="mt-1 text-xs text-stone-500">
          The mortality sensitivity card and the uncertainty / tax-
          efficiency tiles each run synchronous Monte Carlo on mount
          and block the main thread for 5–15s on a real plan. Hidden
          until the compute is moved to a Web Worker (tracked in the
          backlog). Cockpit headline numbers still render from the
          corpus — they don&apos;t depend on these cards.
        </p>
      </div>

      {/* Log actuals — household enters real balances / spending /
          taxes; engine writes them to the actuals log; reconciliation
          surfaces drift in the DeltaDashboardTile above. Form-only
          (no MC), so eager mount is harmless — keep the default
          2.5s fallback. */}
      <MountWhenVisible minHeight="200px">
        <LogActualsCard data={data} assumptions={assumptions} />
      </MountWhenVisible>

      {assumptions && (
        <AssumptionPanel
          assumptions={assumptions}
          forwardLooking={baselinePath}
          historical={historicalPath}
        />
      )}

      {/* Three time horizons */}
      <div className="grid gap-3 lg:grid-cols-3">
        <YearColumn
          eyebrow="This month (≈)"
          year={currentYear}
          yr={thisYear}
          monthly
          policyTargetSpend={adopted?.annualSpendTodayDollars ?? null}
          spendBuckets={spendBuckets}
          salaryEndDate={data?.income?.salaryEndDate ?? null}
        />
        <YearColumn
          eyebrow="This year"
          year={currentYear}
          yr={thisYear}
          policyTargetSpend={adopted?.annualSpendTodayDollars ?? null}
          spendBuckets={spendBuckets}
          salaryEndDate={data?.income?.salaryEndDate ?? null}
        />
        <YearColumn
          eyebrow="Next year"
          year={currentYear + 1}
          yr={nextYear}
          policyTargetSpend={adopted?.annualSpendTodayDollars ?? null}
          spendBuckets={spendBuckets}
          salaryEndDate={data?.income?.salaryEndDate ?? null}
        />
      </div>

      <BalanceTrajectoryChart yearlySeries={yearlySeries} />

      {/* Hard stops on the radar */}
      <div className="rounded-2xl border border-stone-200 bg-white/80 p-4 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          Hard stops on the radar
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {/* Medicare IEP + HSA-stop check. Self-hides when no spouse
              is within ~24 months of age 65 and no HSA conflict.
              Spans both columns at any breakpoint via md:col-span-2. */}
          {data && <MedicareReminderCard data={data} />}
          {/* IRMAA cliff for this year */}
          {thisYear && irmaaThisYear?.next && (
            <HardStopRow
              label={`This year · ${irmaaThisYear.next.name}`}
              current={thisYear.medianMagi}
              threshold={irmaaThisYear.next.magiCeiling}
              consequence={`Crossing adds ~$${
                (irmaaThisYear.next.surchargePerPerson - (irmaaThisYear.current?.surchargePerPerson ?? 0)) * 12 * 2
              }/yr in Medicare premium (couple).`}
            />
          )}
          {/* IRMAA cliff for next year */}
          {nextYear && irmaaNextYear?.next && (
            <HardStopRow
              label={`Next year · ${irmaaNextYear.next.name}`}
              current={nextYear.medianMagi}
              threshold={irmaaNextYear.next.magiCeiling}
              consequence={`Crossing adds ~$${
                (irmaaNextYear.next.surchargePerPerson - (irmaaNextYear.current?.surchargePerPerson ?? 0)) * 12 * 2
              }/yr in Medicare premium.`}
            />
          )}
          {/* LTCG 0% bracket */}
          {thisYear && (
            <HardStopRow
              label={`This year · 0% LTCG bracket top`}
              current={thisYear.medianTaxableIncome - thisYear.medianMagi + (thisYear.medianMagi - 0)}
              threshold={LTCG_ZERO_BRACKET_TOP_MFJ_2026}
              consequence="Long-term capital gains taxed at 15% above this."
            />
          )}
          {/* Upcoming age milestones */}
          {milestones.length > 0 && (
            <div className="border-l-2 border-stone-200 pl-3">
              <span className="text-[12px] font-semibold text-stone-700">
                Upcoming age events
              </span>
              <ul className="mt-1 space-y-1 text-[11px] text-stone-600">
                {milestones.map((m) => (
                  <li key={`${m.label}-${m.year}`}>
                    <span className="tabular-nums text-stone-500">{m.year}</span>
                    {' · '}
                    {m.label}{' '}
                    <span className="text-stone-400">
                      ({m.offsetYears} {m.offsetYears === 1 ? 'yr' : 'yrs'})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <CockpitSensitivityPanel
        baseline={baselinePath}
        data={data}
        assumptions={assumptions}
        selectedStressors={selectedStressors ?? []}
        selectedResponses={selectedResponses ?? []}
      />

      <SaveSnapshotPanel
        data={data}
        assumptions={assumptions}
        yearlySeries={yearlySeries}
        baselinePath={planPath}
        adoptedPolicy={adopted}
      />

      <YearlyAuditDownload data={data} yearlySeries={yearlySeries} />

      <p className="text-[11px] text-stone-400">
        Prototype scaffold · feedback welcome before iteration. The "this
        month" tile divides annual outputs by 12 (engine runs at yearly
        resolution); sensitivity values are placeholders pending the
        stress-sweep wiring.
      </p>
    </div>
  );
}

/**
 * Cockpit-side trigger for the year-by-year audit CSV. Same data as
 * the Inspector → Export screen's audit table, packaged behind a
 * single download button so the household doesn't have to navigate to
 * a different room when they want a CPA-readable artifact.
 *
 * Column set is small/different from the Inspector audit on purpose —
 * the cockpit is meant to be the household's daily surface; the
 * Inspector view stays the place to see every column.
 */

/**
 * "Save snapshot" panel — captures the current plan state into the
 * history store. Pulls all the inputs from the cockpit's existing
 * memos (no duplicate sim runs) and writes via `history-store.ts`.
 *
 * UX: a single button + an optional label input. After save, shows
 * a brief confirmation with a "View history" link. Doesn't block the
 * page or steal focus — meant to be a one-click monthly habit.
 */
function SaveSnapshotPanel({
  data,
  assumptions,
  yearlySeries,
  baselinePath,
  adoptedPolicy,
}: {
  data: SeedData | null | undefined;
  assumptions: MarketAssumptions | null | undefined;
  yearlySeries: PathYearResult[];
  baselinePath: PathResult | null;
  adoptedPolicy: { annualSpendTodayDollars: number; primarySocialSecurityClaimAge: number; spouseSocialSecurityClaimAge: number | null; rothConversionAnnualCeiling: number } | null;
}) {
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!data || !assumptions || !baselinePath || yearlySeries.length === 0) {
    return null;
  }

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const snapshot = captureSnapshot({
        label: label.trim(),
        data,
        assumptions,
        yearlySeries,
        successRate: baselinePath.successRate,
        medianEndingWealth: baselinePath.medianEndingWealth,
        adoptedPolicy: adoptedPolicy as any,
        engineVersion: POLICY_MINER_ENGINE_VERSION,
      });
      await saveSnapshot(snapshot);
      setSavedAt(new Date().toLocaleTimeString());
      setLabel('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex-1 min-w-[280px]">
          <p className="text-[12px] font-semibold text-stone-700">
            📸 Save plan snapshot
          </p>
          <p className="text-[11px] text-stone-500">
            Capture today's state for month-over-month tracking. Solvency,
            assets, projection trajectory, and adopted policy get archived
            locally — view trends in the History tab.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional label (e.g. April 2026 review)"
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm placeholder:text-stone-400 focus:border-[#0066CC] focus:outline-none"
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave();
            }}
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="whitespace-nowrap rounded-lg bg-[#0066CC] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0071E3] disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {saving ? 'Saving…' : 'Save snapshot'}
          </button>
        </div>
      </div>
      {savedAt && (
        <p className="mt-2 text-[11px] text-emerald-700">
          ✓ Saved at {savedAt}. Open the History tab to see it.
        </p>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-rose-600">⚠ {error}</p>
      )}
    </div>
  );
}

function YearlyAuditDownload({
  data,
  yearlySeries,
}: {
  data: SeedData | null | undefined;
  yearlySeries: PathYearResult[];
}) {
  if (!data || yearlySeries.length === 0) return null;

  const downloadCsv = () => {
    const robBirthYear = data.household.robBirthDate
      ? new Date(data.household.robBirthDate).getUTCFullYear()
      : 0;
    const debbieBirthYear = data.household.debbieBirthDate
      ? new Date(data.household.debbieBirthDate).getUTCFullYear()
      : 0;
    const escape = (cell: string): string =>
      /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
    const round = (n: number) => Math.round(n).toString();
    const headers = [
      'Year',
      'Rob age',
      'Debbie age',
      'Salary',
      'Social Security',
      'Windfall cash',
      'Income total',
      'Spend total',
      'ACA premium',
      'Medicare premium',
      'IRMAA surcharge',
      'LTC cost',
      'HSA offset',
      'Federal tax',
      'Taxable income',
      'MAGI',
      'IRMAA tier',
      'Roth conversion',
      'RMD forced',
      '401k employee',
      '401k match',
      'HSA contribution',
      'Withdraw pretax',
      'Withdraw taxable',
      'Withdraw Roth',
      'Withdraw cash',
      'Bal pretax',
      'Bal taxable',
      'Bal Roth',
      'Bal cash',
      'Bal total',
    ].map(escape);
    const rows = yearlySeries.map((y) => {
      const ss = Math.max(
        0,
        y.medianIncome -
          y.medianAdjustedWages -
          y.medianWindfallCashInflow -
          y.medianRmdAmount,
      );
      return [
        y.year.toString(),
        (y.year - robBirthYear).toString(),
        (y.year - debbieBirthYear).toString(),
        round(y.medianAdjustedWages),
        round(ss),
        round(y.medianWindfallCashInflow),
        round(y.medianIncome),
        round(y.medianSpending),
        round(y.medianAcaPremiumEstimate),
        round(y.medianMedicarePremiumEstimate),
        round(y.medianIrmaaSurcharge),
        round(y.medianLtcCost),
        round(y.medianHsaOffsetUsed),
        round(y.medianFederalTax),
        round(y.medianTaxableIncome),
        round(y.medianMagi),
        escape(y.dominantIrmaaTier ?? ''),
        round(y.medianRothConversion),
        round(y.medianRmdAmount),
        round(y.medianEmployee401kContribution),
        round(y.medianEmployerMatchContribution),
        round(y.medianHsaContribution),
        round(y.medianWithdrawalIra401k),
        round(y.medianWithdrawalTaxable),
        round(y.medianWithdrawalRoth),
        round(y.medianWithdrawalCash),
        round(y.medianPretaxBalance),
        round(y.medianTaxableBalance),
        round(y.medianRothBalance),
        round(y.medianCashBalance),
        round(y.medianAssets),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `retirement-plan-yearly-audit-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-stone-50/70 p-3">
      <div className="flex-1 min-w-[260px]">
        <p className="text-[12px] font-semibold text-stone-700">
          📥 Download year-by-year audit (CSV)
        </p>
        <p className="text-[11px] text-stone-500">
          One row per simulated year, 31 columns — income, spend,
          tax, withdrawals, balances. Open in a spreadsheet and verify
          the plan column-by-column with a CPA / second opinion.
        </p>
      </div>
      <button
        type="button"
        onClick={downloadCsv}
        className="rounded-md bg-emerald-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-emerald-700"
      >
        Download CSV ({yearlySeries.length} yrs)
      </button>
    </div>
  );
}
