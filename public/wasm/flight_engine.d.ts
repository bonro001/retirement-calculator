/* tslint:disable */
/* eslint-disable */

/**
 * Monte-Carlo-shaped benchmark — runs `num_trials` independent trials
 * where each trial loops `years_per_trial` iterations doing arithmetic
 * that mirrors the *shape* of the real engine's per-year work
 * (multiply by a return factor, conditional branches, accumulation).
 * Returns the sum of final balances across all trials so neither V8
 * nor the optimizer can dead-code-eliminate the work.
 *
 * Calibration to the real engine:
 *   - 30 years/trial × ~50 multiplications + 20 branches per year
 *   - LCG-style PRNG (deterministic from seed) so JS comparison
 *     uses the same RNG pattern → like-for-like speed comparison
 *
 * The TS-side equivalent is in `wasm-engine.ts` (`runJsBenchmark`).
 * Calling both with the same args lets us measure speedup before
 * committing to the full port.
 */
export function benchmark_montecarlo(num_trials: number, years_per_trial: number, seed: number): number;

/**
 * Smoke test: confirms the WASM module loaded and the JS bridge works.
 * Called from the TS bridge layer on first init to fail fast if the
 * build is broken.
 */
export function engine_version(): string;

/**
 * Run N trials, return aggregated medians + headline stats. This is
 * what the cockpit baseline path and the cluster mining workers will
 * eventually call. For now it just batches `simulate_trial` and
 * computes per-year medians.
 */
export function evaluate_policy(plan_js: any, assumptions_js: any, base_seed: bigint): any;

/**
 * Run one Monte Carlo trial. Inputs come in as plain JS objects
 * (deserialized via serde-wasm-bindgen). Returns a `TrialResult`
 * JS object with the year-by-year trace.
 *
 * Coverage: minimal. See `trial.rs` for what's modeled vs not.
 * The output shape will evolve as more porting lands; current
 * callers should treat additional fields as additive.
 */
export function simulate_trial(plan_js: any, assumptions_js: any, seed: bigint): any;

/**
 * Add two integers — the canonical "is the WASM bridge wired right?"
 * sanity check. If this returns the expected value when called from TS,
 * the marshaling layer is working and we can move on to real port work.
 */
export function smoke_add(a: number, b: number): number;

/**
 * Sum many floats — exercises the numeric path that the real
 * simulation will use. Compares against a pure-JS sum to validate
 * the WASM build actually performs faster on a hot loop.
 */
export function smoke_sum(values: Float64Array): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly benchmark_montecarlo: (a: number, b: number, c: number) => number;
    readonly engine_version: () => [number, number];
    readonly evaluate_policy: (a: any, b: any, c: bigint) => [number, number, number];
    readonly simulate_trial: (a: any, b: any, c: bigint) => [number, number, number];
    readonly smoke_add: (a: number, b: number) => number;
    readonly smoke_sum: (a: number, b: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
