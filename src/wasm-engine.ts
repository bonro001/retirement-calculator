/**
 * WASM engine bridge — load the Rust-compiled flight-engine and expose
 * its functions as a typed TypeScript module.
 *
 * The wasm-pack build emits `public/wasm/flight_engine.js` (a glue
 * shim) and `flight_engine_bg.wasm` (the binary). We import the shim
 * dynamically so the WASM payload is only fetched when something
 * actually needs the engine — keeps initial cockpit load fast.
 *
 * Status: smoke-test phase. The Rust crate currently exports just
 * `engine_version`, `smoke_add`, `smoke_sum`. Real `simulate_trial` /
 * `evaluate_policy` exports come once the per-year loop is ported.
 *
 * Usage:
 *   import { initWasmEngine, getEngine } from './wasm-engine';
 *   await initWasmEngine();
 *   const engine = getEngine();
 *   console.log(engine.engine_version());
 */

// Type-only import so the build doesn't break if the wasm directory is
// missing (e.g. fresh clone before someone runs `npm run wasm:build`).
// At runtime the dynamic import below loads the actual JS shim.
type WasmModule = typeof import('./wasm/flight_engine.js');

let cachedModule: WasmModule | null = null;
let initPromise: Promise<WasmModule> | null = null;

/**
 * Initialize the WASM engine. Idempotent — repeated calls return the
 * same in-flight promise so we never double-load. Returns the module
 * once instantiation completes.
 *
 * Vite/wasm-bindgen handle the `.wasm` fetch automatically. The shim
 * default-exports an init function that takes a URL or Response; in
 * Vite's dev/build the asset URL is auto-resolved relative to the
 * shim's location (which we serve from /public/wasm/).
 */
export async function initWasmEngine(): Promise<WasmModule> {
  if (cachedModule) return cachedModule;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Dynamic import from src/wasm/ — Vite bundles the JS shim and
    // serves the .wasm as a static asset automatically when the
    // shim is imported normally. Putting wasm-pack output in src/
    // (not public/) is the standard Vite pattern.
    const mod = (await import('./wasm/flight_engine.js')) as WasmModule;
    // wasm-bindgen's default export is the init function. Call it
    // once to fetch + instantiate the .wasm binary.
    // @ts-expect-error — TS sees the module as a namespace, not callable
    if (typeof mod.default === 'function') {
      // @ts-expect-error — same reason
      await mod.default();
    }
    cachedModule = mod;
    return mod;
  })();

  return initPromise;
}

/**
 * Get the loaded engine module. Throws if `initWasmEngine` hasn't been
 * awaited yet — caller is responsible for the lifecycle. We do this
 * (vs lazy-init in the getter) because the engine should only be
 * loaded by code that knows it'll be used; lazy-init in a sync getter
 * is a footgun for "why did my page suddenly fetch a 200KB binary."
 */
export function getEngine(): WasmModule {
  if (!cachedModule) {
    throw new Error(
      'WASM engine not initialized. Call `await initWasmEngine()` first.',
    );
  }
  return cachedModule;
}

/**
 * Pure-JS implementation of the Monte-Carlo-shaped benchmark. Mirrors
 * `benchmark_montecarlo` in the Rust crate exactly — same LCG, same
 * per-year math, same branches. Used to measure the speedup
 * empirically before investing in the full engine port.
 *
 * IMPORTANT: keep this in sync with the Rust version. If the Rust
 * version changes, this one must change too — otherwise the
 * comparison is meaningless.
 */
export function runJsBenchmark(
  numTrials: number,
  yearsPerTrial: number,
  seed: number,
): number {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };

  let total = 0;
  for (let trial = 0; trial < numTrials; trial++) {
    let balance = 1_000_000;
    for (let year = 0; year < yearsPerTrial; year++) {
      const r = next() * 0.32 - 0.16 + 0.07;
      balance *= 1 + r;

      let withdraw: number;
      if (balance > 2_000_000) withdraw = balance * 0.04;
      else if (balance > 500_000) withdraw = balance * 0.035;
      else withdraw = balance * 0.025;
      balance -= withdraw;

      let tax: number;
      if (withdraw < 50_000) tax = withdraw * 0.12;
      else if (withdraw < 100_000) tax = 6_000 + (withdraw - 50_000) * 0.22;
      else if (withdraw < 200_000) tax = 17_000 + (withdraw - 100_000) * 0.24;
      else tax = 41_000 + (withdraw - 200_000) * 0.32;
      balance -= tax * 0.5;

      if (year > 5 && balance > 1_500_000) {
        balance += balance * 0.001;
      }
      if (balance < 0) {
        balance = 0;
        break;
      }
    }
    total += balance;
  }
  return total;
}

/**
 * Run Rust+WASM and JS implementations of the Monte-Carlo-shaped
 * benchmark, time both, return speedup. Used to validate the perf
 * hypothesis (3-5× speedup) before committing to porting the real
 * engine. Also asserts both produce the same result — if not, the
 * implementations have drifted.
 */
export async function runBenchmark(
  numTrials = 1000,
  yearsPerTrial = 30,
  seed = 12345,
): Promise<{
  jsResult: number;
  wasmResult: number;
  jsTimeMs: number;
  wasmTimeMs: number;
  speedup: number;
  match: boolean;
  trials: number;
  yearsPerTrial: number;
}> {
  const engine = await initWasmEngine();

  // Warm up — first run pays JIT/compile cost; second run is steady-state.
  // Mirroring this on both sides for fairness.
  runJsBenchmark(10, 5, seed);
  engine.benchmark_montecarlo(10, 5, seed);

  const jsStart = performance.now();
  const jsResult = runJsBenchmark(numTrials, yearsPerTrial, seed);
  const jsTimeMs = performance.now() - jsStart;

  const wasmStart = performance.now();
  const wasmResult = engine.benchmark_montecarlo(numTrials, yearsPerTrial, seed);
  const wasmTimeMs = performance.now() - wasmStart;

  // Float math should be bit-identical between JS and Rust given
  // identical operations. Allow tiny tolerance just in case rounding
  // diverges on transcendental ops (we don't use any here, but
  // future versions might).
  const match = Math.abs(jsResult - wasmResult) / Math.abs(jsResult || 1) < 1e-6;

  return {
    jsResult,
    wasmResult,
    jsTimeMs,
    wasmTimeMs,
    speedup: jsTimeMs / wasmTimeMs,
    match,
    trials: numTrials,
    yearsPerTrial,
  };
}

/**
 * Run the full simulation via Rust+WASM. Takes the same shape inputs
 * as buildPathResults and returns an aggregated result with
 * year-by-year medians plus headline solvency / ending-wealth.
 *
 * This is the fast path. Use for cockpit instant-baseline,
 * sensitivity scenarios, and any other "compute this projection
 * NOW" caller. Mining still uses the cluster (which uses TS engine
 * for now; Rust napi-rs version is a follow-up).
 */
export interface WasmEvaluation {
  successRate: number;
  medianEndingWealth: number;
  yearlySeries: Array<{
    year: number;
    medianAssets: number;
    medianSpending: number;
    medianPretaxBalance: number;
    medianTaxableBalance: number;
    medianRothBalance: number;
    medianCashBalance: number;
  }>;
}

export interface WasmPlan {
  startingBalances: {
    pretax: number;
    roth: number;
    taxable: number;
    cash: number;
    hsa?: number;
  };
  annualSpendTodayDollars: number;
  travelAnnualTodayDollars?: number;
  travelPhaseYears?: number;
  planningHorizonYears: number;
  startYear: number;
  salaryAnnual?: number;
  salaryEndDate?: string;
  socialSecurity?: Array<{ person: string; fraMonthly: number; claimAge: number }>;
  robBirthYear?: number;
  debbieBirthYear?: number;
  windfalls?: Array<{
    name: string;
    year: number;
    amount: number;
    taxTreatment?: string;
  }>;
  filingStatus?: string;
  employee401kPretaxPercent?: number;
  employerMatchRate?: number;
  employerMatchMaxPct?: number;
  baselineAcaPremiumAnnual?: number;
  baselineMedicarePremiumAnnual?: number;
  medicalInflationAnnual?: number;
  ltcEventProbability?: number;
  ltcStartAge?: number;
  ltcAnnualCostToday?: number;
  ltcDurationYears?: number;
  hsaAnnualQualifiedWithdrawalCap?: number;
  hsaContributionPctOfSalary?: number;
}

export interface WasmAssumptions {
  equityMean: number;
  equityVolatility: number;
  bondMean: number;
  bondVolatility: number;
  cashMean: number;
  cashVolatility: number;
  inflation: number;
  inflationVolatility: number;
  simulationRuns: number;
  simulationSeed?: number;
  guardrailFloorYears?: number;
  guardrailCeilingYears?: number;
  guardrailCutPercent?: number;
}

export async function evaluateViaWasm(
  plan: WasmPlan,
  assumptions: WasmAssumptions,
  baseSeed = 20260416,
): Promise<WasmEvaluation> {
  const engine = await initWasmEngine();
  // wasm-bindgen exposes evaluate_policy with BigInt seed. Convert
  // from the JS number argument so callers don't need to think about it.
  // @ts-expect-error — TS types from .d.ts mark seed as bigint
  const result = engine.evaluate_policy(plan, assumptions, BigInt(baseSeed));
  return result as WasmEvaluation;
}

/**
 * Convert SeedData + MarketAssumptions (the TS engine's input shape)
 * into the WasmPlan + WasmAssumptions shape. Pulls everything the
 * Rust engine knows how to use; ignores fields it doesn't model yet
 * (those are simply absent in the projection — same effect as if the
 * household had set them to zero).
 *
 * Caller is responsible for choosing whether to use this path —
 * `isWasmEngineAvailable()` returns true after `initWasmEngine()`
 * has been called once successfully.
 */
export function adaptSeedToWasm(
  data: { [k: string]: unknown },
  assumptions: { [k: string]: unknown },
  startYear?: number,
  planningHorizonYears = 30,
): { plan: WasmPlan; assumptions: WasmAssumptions } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = assumptions as any;
  const robBirthYear = d.household?.robBirthDate
    ? new Date(d.household.robBirthDate).getUTCFullYear()
    : undefined;
  const debbieBirthYear = d.household?.debbieBirthDate
    ? new Date(d.household.debbieBirthDate).getUTCFullYear()
    : undefined;
  const annualSpend =
    (d.spending?.essentialMonthly ?? 0) * 12 +
    (d.spending?.optionalMonthly ?? 0) * 12 +
    (d.spending?.travelEarlyRetirementAnnual ?? 0) +
    (d.spending?.annualTaxesInsurance ?? 0);
  const wasmPlan: WasmPlan = {
    startingBalances: {
      pretax: d.accounts?.pretax?.balance ?? 0,
      roth: d.accounts?.roth?.balance ?? 0,
      taxable: d.accounts?.taxable?.balance ?? 0,
      cash: d.accounts?.cash?.balance ?? 0,
      hsa: d.accounts?.hsa?.balance ?? 0,
    },
    annualSpendTodayDollars: annualSpend,
    travelAnnualTodayDollars: d.spending?.travelEarlyRetirementAnnual ?? 0,
    travelPhaseYears: a.travelPhaseYears ?? 10,
    planningHorizonYears,
    startYear: startYear ?? new Date().getUTCFullYear(),
    salaryAnnual: d.income?.salaryAnnual ?? 0,
    salaryEndDate: d.income?.salaryEndDate,
    socialSecurity: d.income?.socialSecurity ?? [],
    robBirthYear,
    debbieBirthYear,
    windfalls: d.income?.windfalls ?? [],
    filingStatus: d.household?.filingStatus,
    employee401kPretaxPercent:
      d.income?.preRetirementContributions?.employee401kPreTaxPercentOfSalary ?? 0,
    employerMatchRate:
      d.income?.preRetirementContributions?.employerMatch?.matchRate ?? 0,
    employerMatchMaxPct:
      d.income?.preRetirementContributions
        ?.employerMatch?.maxEmployeeContributionPercentOfSalary ?? 0,
    baselineAcaPremiumAnnual:
      d.rules?.healthcarePremiums?.baselineAcaPremiumAnnual ?? 0,
    baselineMedicarePremiumAnnual:
      d.rules?.healthcarePremiums?.baselineMedicarePremiumAnnual ?? 0,
    medicalInflationAnnual:
      d.rules?.healthcarePremiums?.medicalInflationAnnual ?? 0.055,
    ltcEventProbability: d.rules?.ltcAssumptions?.eventProbability ?? 0,
    ltcStartAge: d.rules?.ltcAssumptions?.startAge ?? 85,
    ltcAnnualCostToday: d.rules?.ltcAssumptions?.annualCostToday ?? 0,
    ltcDurationYears: d.rules?.ltcAssumptions?.durationYears ?? 3,
    hsaAnnualQualifiedWithdrawalCap:
      d.rules?.hsaStrategy?.annualQualifiedExpenseWithdrawalCap ?? 0,
    hsaContributionPctOfSalary:
      d.income?.preRetirementContributions?.hsaPercentOfSalary ?? 0,
  };
  const wasmAssumptions: WasmAssumptions = {
    equityMean: a.equityMean ?? 0.074,
    equityVolatility: a.equityVolatility ?? 0.16,
    bondMean: a.bondMean ?? 0.038,
    bondVolatility: a.bondVolatility ?? 0.07,
    cashMean: a.cashMean ?? 0.02,
    cashVolatility: a.cashVolatility ?? 0.01,
    inflation: a.inflation ?? 0.028,
    inflationVolatility: a.inflationVolatility ?? 0.01,
    simulationRuns: a.simulationRuns ?? 2000,
    simulationSeed: a.simulationSeed,
    guardrailFloorYears: a.guardrailFloorYears ?? 12,
    guardrailCeilingYears: a.guardrailCeilingYears ?? 18,
    guardrailCutPercent: a.guardrailCutPercent ?? 0.2,
  };
  return { plan: wasmPlan, assumptions: wasmAssumptions };
}

export function isWasmEngineAvailable(): boolean {
  return cachedModule !== null;
}

/**
 * Smoke test runner — calls the three exported sanity functions and
 * verifies they return the expected values. Used by the dev console
 * + tests to confirm the WASM build is wired up correctly.
 *
 * Call from the browser console while looking at the cockpit:
 *   import('/src/wasm-engine.ts').then(m => m.runSmokeTest());
 */
export async function runSmokeTest(): Promise<{
  ok: boolean;
  details: string[];
}> {
  const details: string[] = [];
  let ok = true;

  try {
    const engine = await initWasmEngine();
    details.push(`✓ WASM module loaded`);

    const version = engine.engine_version();
    details.push(`✓ engine_version() → "${version}"`);

    const sum = engine.smoke_add(40, 2);
    if (sum !== 42) {
      ok = false;
      details.push(`✗ smoke_add(40,2) returned ${sum}, expected 42`);
    } else {
      details.push(`✓ smoke_add(40,2) → 42`);
    }

    const arr = new Float64Array([1.5, 2.5, 3.5, 4.5]);
    const total = engine.smoke_sum(arr);
    const expected = 12;
    if (Math.abs(total - expected) > 1e-9) {
      ok = false;
      details.push(`✗ smoke_sum([1.5,2.5,3.5,4.5]) returned ${total}, expected ${expected}`);
    } else {
      details.push(`✓ smoke_sum([1.5,2.5,3.5,4.5]) → 12`);
    }
  } catch (err) {
    ok = false;
    details.push(`✗ exception: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok, details };
}
