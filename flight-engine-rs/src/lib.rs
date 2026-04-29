//! Flight Engine — entry point.
//!
//! This crate re-exports the simulation primitives and the wasm-bindgen
//! glue. The big modules live in their own files:
//!
//!   trial.rs       — the per-year iteration loop (the hot path)
//!   tax.rs         — federal tax + AGI + IRMAA tier math
//!   withdrawal.rs  — multi-objective withdrawal optimizer
//!   types.rs       — shared types: Plan, Assumptions, BalanceState
//!
//! The exported WASM API is intentionally narrow:
//!
//!   simulate_trial(plan, assumptions, seed) → TrialTrace
//!     → run one Monte Carlo trial (30 years × per-year decisions)
//!   evaluate_policy(plan, assumptions, num_trials) → PolicyResult
//!     → run N trials, return aggregated stats (median, percentiles)
//!
//! Anything else stays in TS — the cockpit, the cluster orchestration,
//! the dispatcher, the audit CSVs. The Rust crate is the engine, not
//! the application.
//!
//! Status: scaffolding only. simulate_trial returns a placeholder
//! result while the port is in progress.

use wasm_bindgen::prelude::*;

// Set up better panic messages in debug WASM builds so a bug surfaces
// in the browser console instead of as "unreachable executed".
#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Smoke test: confirms the WASM module loaded and the JS bridge works.
/// Called from the TS bridge layer on first init to fail fast if the
/// build is broken.
#[wasm_bindgen]
pub fn engine_version() -> String {
    format!(
        "flight-engine v{} ({})",
        env!("CARGO_PKG_VERSION"),
        env!("CARGO_PKG_NAME")
    )
}

/// Add two integers — the canonical "is the WASM bridge wired right?"
/// sanity check. If this returns the expected value when called from TS,
/// the marshaling layer is working and we can move on to real port work.
#[wasm_bindgen]
pub fn smoke_add(a: i32, b: i32) -> i32 {
    a + b
}

/// Sum many floats — exercises the numeric path that the real
/// simulation will use. Compares against a pure-JS sum to validate
/// the WASM build actually performs faster on a hot loop.
#[wasm_bindgen]
pub fn smoke_sum(values: Vec<f64>) -> f64 {
    values.iter().sum()
}

/// Monte-Carlo-shaped benchmark — runs `num_trials` independent trials
/// where each trial loops `years_per_trial` iterations doing arithmetic
/// that mirrors the *shape* of the real engine's per-year work
/// (multiply by a return factor, conditional branches, accumulation).
/// Returns the sum of final balances across all trials so neither V8
/// nor the optimizer can dead-code-eliminate the work.
///
/// Calibration to the real engine:
///   - 30 years/trial × ~50 multiplications + 20 branches per year
///   - LCG-style PRNG (deterministic from seed) so JS comparison
///     uses the same RNG pattern → like-for-like speed comparison
///
/// The TS-side equivalent is in `wasm-engine.ts` (`runJsBenchmark`).
/// Calling both with the same args lets us measure speedup before
/// committing to the full port.
#[wasm_bindgen]
pub fn benchmark_montecarlo(
    num_trials: u32,
    years_per_trial: u32,
    seed: u32,
) -> f64 {
    // Tiny LCG (linear congruential generator) — same constants as
    // Numerical Recipes' "ranqd1". Deterministic for a given seed,
    // fast, and trivially portable to JS so both implementations use
    // identical sequences.
    let mut state: u32 = seed;
    let next = |s: &mut u32| -> f64 {
        *s = s
            .wrapping_mul(1664525)
            .wrapping_add(1013904223);
        // Map to [0, 1)
        (*s as f64) / 4_294_967_296.0
    };

    let mut total: f64 = 0.0;
    for _trial in 0..num_trials {
        let mut balance: f64 = 1_000_000.0;
        for year in 0..years_per_trial {
            // Stochastic equity return sample — N(0.07, 0.16) approximated
            // crudely as a uniform shifted by mean (good enough for shape).
            let r = next(&mut state) * 0.32 - 0.16 + 0.07;
            balance *= 1.0 + r;

            // A few "decisions" to simulate branching cost
            let withdraw = if balance > 2_000_000.0 {
                balance * 0.04
            } else if balance > 500_000.0 {
                balance * 0.035
            } else {
                balance * 0.025
            };
            balance -= withdraw;

            // Tax-bracket-style stepwise math
            let tax = if withdraw < 50_000.0 {
                withdraw * 0.12
            } else if withdraw < 100_000.0 {
                6_000.0 + (withdraw - 50_000.0) * 0.22
            } else if withdraw < 200_000.0 {
                17_000.0 + (withdraw - 100_000.0) * 0.24
            } else {
                41_000.0 + (withdraw - 200_000.0) * 0.32
            };
            balance -= tax * 0.5; // half the tax comes back via savings

            // Mild branchy condition that simulates IRMAA-tier check
            if year > 5 && balance > 1_500_000.0 {
                balance += balance * 0.001; // small bump
            }
            if balance < 0.0 {
                balance = 0.0;
                break;
            }
        }
        total += balance;
    }
    total
}

// Real engine modules.
pub mod tax;
pub mod trial;
pub mod types;

use serde_wasm_bindgen::{from_value, to_value};
use types::{AggregatedResult, AssumptionsInput, PlanInput, YearlyMedians};

/// Run one Monte Carlo trial. Inputs come in as plain JS objects
/// (deserialized via serde-wasm-bindgen). Returns a `TrialResult`
/// JS object with the year-by-year trace.
///
/// Coverage: minimal. See `trial.rs` for what's modeled vs not.
/// The output shape will evolve as more porting lands; current
/// callers should treat additional fields as additive.
#[wasm_bindgen]
pub fn simulate_trial(
    plan_js: JsValue,
    assumptions_js: JsValue,
    seed: u64,
) -> Result<JsValue, JsValue> {
    let plan: PlanInput = from_value(plan_js)
        .map_err(|e| JsValue::from_str(&format!("plan parse error: {e}")))?;
    let assumptions: AssumptionsInput = from_value(assumptions_js)
        .map_err(|e| JsValue::from_str(&format!("assumptions parse error: {e}")))?;
    let result = trial::run_trial(&plan, &assumptions, seed);
    to_value(&result).map_err(|e| JsValue::from_str(&format!("serialize error: {e}")))
}

/// Run N trials, return aggregated medians + headline stats. This is
/// what the cockpit baseline path and the cluster mining workers will
/// eventually call. For now it just batches `simulate_trial` and
/// computes per-year medians.
#[wasm_bindgen]
pub fn evaluate_policy(
    plan_js: JsValue,
    assumptions_js: JsValue,
    base_seed: u64,
) -> Result<JsValue, JsValue> {
    let plan: PlanInput = from_value(plan_js)
        .map_err(|e| JsValue::from_str(&format!("plan parse error: {e}")))?;
    let assumptions: AssumptionsInput = from_value(assumptions_js)
        .map_err(|e| JsValue::from_str(&format!("assumptions parse error: {e}")))?;
    let n = assumptions.simulation_runs.max(1) as usize;
    let years = plan.planning_horizon_years as usize;

    // Collect all trials.
    let mut all_trials = Vec::with_capacity(n);
    for i in 0..n {
        // Each trial gets a deterministic but distinct seed. Bit-mix
        // base_seed and trial index to avoid pathological correlations.
        let trial_seed = base_seed.wrapping_mul(2_862_933_555_777_941_757).wrapping_add(i as u64);
        all_trials.push(trial::run_trial(&plan, &assumptions, trial_seed));
    }

    // Aggregate: per-year medians across trials, plus headline stats.
    let success_rate = all_trials.iter().filter(|t| t.success).count() as f64 / n as f64;

    let mut ending_wealths: Vec<f64> = all_trials.iter().map(|t| t.ending_wealth).collect();
    ending_wealths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_ending_wealth = ending_wealths[ending_wealths.len() / 2];

    let mut yearly_series: Vec<YearlyMedians> = Vec::with_capacity(years);
    for year_idx in 0..years {
        let mut assets = Vec::with_capacity(n);
        let mut spending = Vec::with_capacity(n);
        let mut pretax = Vec::with_capacity(n);
        let mut taxable = Vec::with_capacity(n);
        let mut roth = Vec::with_capacity(n);
        let mut cash = Vec::with_capacity(n);

        for trial in &all_trials {
            if year_idx < trial.yearly.len() {
                let row = &trial.yearly[year_idx];
                assets.push(row.total_assets);
                spending.push(row.spending);
                pretax.push(row.pretax_balance_end);
                taxable.push(row.taxable_balance_end);
                roth.push(row.roth_balance_end);
                cash.push(row.cash_balance_end);
            }
        }

        let year = plan.start_year + year_idx as i32;
        yearly_series.push(YearlyMedians {
            year,
            median_assets: median(&mut assets),
            median_spending: median(&mut spending),
            median_pretax_balance: median(&mut pretax),
            median_taxable_balance: median(&mut taxable),
            median_roth_balance: median(&mut roth),
            median_cash_balance: median(&mut cash),
        });
    }

    let result = AggregatedResult {
        success_rate,
        median_ending_wealth,
        yearly_series,
    };
    to_value(&result).map_err(|e| JsValue::from_str(&format!("serialize error: {e}")))
}

/// Median helper. Mutates the input (sorts in place) — saves an
/// allocation per-year and we don't need the original ordering after.
fn median(values: &mut Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    }
}
