//! Shared types for the simulation engine.
//!
//! Most types are mirrors of TypeScript shapes from `src/types.ts` —
//! deliberately structural so serde can deserialize the same JSON the
//! TS code produces. Field names match the TS camelCase via serde's
//! `rename_all` so the bridge can pass plan objects without translation.
//!
//! Coverage status (this iteration): minimal. Just enough to run a
//! simplified 30-year trial. Real engine has many more fields
//! (LTC settings, healthcare premiums, sabbatical, windfalls, …) —
//! those land in subsequent porting passes.

use serde::{Deserialize, Serialize};

/// Account bucket types we track. Names match the TS engine's
/// `AccountBucketType` so JSON round-trips cleanly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BucketType {
    Pretax,
    Roth,
    Taxable,
    Cash,
}

/// End-of-year balance state per bucket. Plain f64 — no
/// representation tricks. Matches the trace fields the TS engine
/// writes per year.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceState {
    pub pretax: f64,
    pub roth: f64,
    pub taxable: f64,
    pub cash: f64,
    /// HSA balance — separate bucket because of its tax treatment
    /// (triple-tax-advantaged: deductible contribution, tax-free
    /// growth, tax-free withdrawal for qualified medical). Default 0
    /// for households without an HSA.
    #[serde(default)]
    pub hsa: f64,
}

impl BalanceState {
    pub fn total(&self) -> f64 {
        // HSA balance is a pure tracker — the investment value lives
        // inside `pretax`. Don't double-count.
        self.pretax + self.roth + self.taxable + self.cash
    }

    pub fn apply_returns(&mut self, returns: &MarketReturns) {
        // 60/40 stock/bond blended return for non-cash buckets. The
        // real TS engine uses per-account targetAllocation × per-asset
        // returns (see `getBucketReturn` in utils.ts); 60/40 is the
        // "moderate retirement" default that approximates a typical
        // multi-fund portfolio. Critical for parity: previously every
        // non-cash bucket was 100% equity (16% vol), which inflated
        // ending-wealth dispersion, fattened both tails, and tanked
        // solvency. With 60/40, vol drops to ~10%, mean to ~6.0%.
        // TODO: pass per-account allocations through the WASM adapter
        // and use them here for full parity.
        // Per-bucket defaults that match common asset-location patterns
        // (and approximately match the user's actual allocations):
        //   pretax:  65/35 — bonds parked here for tax efficiency
        //   roth:    95/5  — aggressive growth, tax-free compounding
        //   taxable: 85/15 — mostly equity, some bonds
        //   hsa:     90/10 — long horizon, mostly equity
        //   cash:    100% cash bucket return
        let pretax_blend = 0.65 * returns.equity_return + 0.35 * returns.bond_return;
        let roth_blend = 0.95 * returns.equity_return + 0.05 * returns.bond_return;
        let taxable_blend = 0.85 * returns.equity_return + 0.15 * returns.bond_return;
        self.pretax *= 1.0 + pretax_blend;
        self.roth *= 1.0 + roth_blend;
        self.taxable *= 1.0 + taxable_blend;
        // HSA is a pure tracker (matching TS engine semantics) — its
        // investment value lives inside `pretax` (the adapter merges
        // HSA balance into pretax at startup). HSA balance here is
        // only used to cap tax-free medical withdrawals. No returns.
        self.cash *= 1.0 + returns.cash_return;
    }
}

/// One year's market draw. Sampled per trial+year.
#[derive(Debug, Clone, Copy)]
pub struct MarketReturns {
    pub equity_return: f64,
    pub bond_return: f64,
    pub cash_return: f64,
    pub inflation: f64,
}

/// Social Security benefit entry per person. Mirrors TS
/// `SocialSecurityEntry` shape so JSON round-trips cleanly.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialSecurityEntry {
    /// "rob" | "debbie" — used to look up which household member's
    /// age gates the claim. The TS engine uses string matching here
    /// rather than an enum; we match for compat.
    pub person: String,
    /// Full Retirement Age monthly benefit in today's $.
    pub fra_monthly: f64,
    /// Age the household claims at. <67 = reduction, >67 = bump.
    pub claim_age: u32,
}

/// Windfall — a one-time inflow at a specific year. Matches TS
/// `WindfallEntry` for the fields we use now.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindfallEntry {
    /// "inheritance" | "home_sale" | etc. Currently only used for
    /// tax-treatment inference; future iterations will use it for
    /// home-sale exclusion math.
    pub name: String,
    pub year: i32,
    pub amount: f64,
    /// "cash_non_taxable" | "ordinary_income" | "primary_home_sale" |
    /// "ltcg" — same string set the TS engine uses. None means infer
    /// from name.
    #[serde(default)]
    pub tax_treatment: Option<String>,
}

/// Simplified plan input — what the trial needs to know about the
/// household. Fewer fields than `SeedData` so we can ramp up gradually.
/// Matches TS naming via serde rename_all.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    /// Starting balances. Sums to total assets day 1.
    pub starting_balances: BalanceState,
    /// Annual lifestyle spend in today's $ (pre-tax, pre-healthcare).
    /// Sum of essential + optional + travel + tax/insur from the TS
    /// SpendingData buckets.
    pub annual_spend_today_dollars: f64,
    /// Travel-phase budget in today's $ — included in annual spend
    /// during go-go years (first `travel_phase_years` of retirement),
    /// removed after. Mirrors `travelEarlyRetirementAnnual` in the
    /// TS spending bucket. If 0 or unset, no taper happens.
    #[serde(default)]
    pub travel_annual_today_dollars: f64,
    /// Number of "go-go years" — typically 10. After this many years
    /// past `salary_end_date`, travel budget drops to zero.
    #[serde(default = "default_travel_phase_years")]
    pub travel_phase_years: u32,
    /// Years to simulate (30 typical, household can plan further).
    pub planning_horizon_years: u32,
    /// Calendar year the simulation starts (e.g. 2026). Used so trace
    /// rows have absolute years, not just offsets.
    pub start_year: i32,

    // ── Income inputs ─────────────────────────────────────────────
    /// Annual salary in today's $. Zero if already retired.
    #[serde(default)]
    pub salary_annual: f64,
    /// ISO-8601 date when salary stops. Mid-year ends produce
    /// fractional-year salary in that year, mirroring TS engine
    /// (`getSalaryForYear`).
    #[serde(default)]
    pub salary_end_date: Option<String>,

    /// Social Security benefits per household member.
    #[serde(default)]
    pub social_security: Vec<SocialSecurityEntry>,
    /// Year both members were born. Used for age-gated SS claims and
    /// future RMD math. Year-only (we don't model fractional ages).
    #[serde(default)]
    pub rob_birth_year: Option<i32>,
    #[serde(default)]
    pub debbie_birth_year: Option<i32>,

    /// One-time inflows (inheritance, home sale, etc.).
    #[serde(default)]
    pub windfalls: Vec<WindfallEntry>,

    /// Filing status — used for primary-home-sale exclusion in
    /// future iterations. Defaults to MFJ if absent.
    #[serde(default)]
    pub filing_status: Option<String>,

    /// Pre-retirement 401k contribution rate (employee pretax % of salary).
    /// Matches `preRetirementContributions.employee401kPreTaxPercentOfSalary`
    /// in the TS seed. 0.15 = 15% of salary diverted to pretax. Active
    /// only during salary-paying years. Capped at IRS limit ($23,000
    /// MFJ 2026 + catch-up).
    #[serde(default)]
    pub employee_401k_pretax_percent: f64,
    /// Employer match rate. Matches matchRate × min(employee%, maxPct).
    #[serde(default)]
    pub employer_match_rate: f64,
    /// Cap on employee % the match applies to (e.g., 0.06 = match up to 6%).
    #[serde(default)]
    pub employer_match_max_pct: f64,

    // ── Healthcare premiums ───────────────────────────────────────
    /// ACA premium baseline (today's $/yr). Applied during pre-Medicare
    /// retirement years. Inflation-indexed at medical_inflation rate.
    #[serde(default)]
    pub baseline_aca_premium_annual: f64,
    /// Medicare premium baseline (today's $/yr). Applied per Medicare-
    /// eligible household member. Standard Part B + Part D estimate.
    #[serde(default)]
    pub baseline_medicare_premium_annual: f64,
    /// Medical inflation rate annual. Compounds separately from CPI
    /// since healthcare typically outpaces general inflation.
    #[serde(default = "default_medical_inflation")]
    pub medical_inflation_annual: f64,

    // ── Long-term care ────────────────────────────────────────────
    /// LTC event probability (0..1) within the planning horizon.
    #[serde(default)]
    pub ltc_event_probability: f64,
    /// Age at which LTC event triggers (if it occurs).
    #[serde(default = "default_ltc_start_age")]
    pub ltc_start_age: u32,
    /// LTC annual cost in today's $.
    #[serde(default)]
    pub ltc_annual_cost_today: f64,
    /// Years the LTC event lasts.
    #[serde(default = "default_ltc_duration")]
    pub ltc_duration_years: u32,

    // ── HSA strategy ──────────────────────────────────────────────
    /// Annual cap on HSA qualified-medical withdrawals (today's $).
    /// Mirrors `hsaStrategy.annualQualifiedExpenseWithdrawalCap` in
    /// the TS seed. Used to offset healthcare costs tax-free.
    #[serde(default)]
    pub hsa_annual_qualified_withdrawal_cap: f64,
    /// HSA contribution rate during salary years (% of salary).
    /// Mirrors `preRetirementContributions.hsaPercentOfSalary`.
    #[serde(default)]
    pub hsa_contribution_pct_of_salary: f64,
}

fn default_medical_inflation() -> f64 { 0.055 }
fn default_ltc_start_age() -> u32 { 85 }
fn default_ltc_duration() -> u32 { 3 }
fn default_travel_phase_years() -> u32 { 10 }

/// Market assumptions — the dials that govern stochastic behavior.
/// Matches TS `MarketAssumptions` for the fields we need now;
/// remaining fields ignored for this iteration.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssumptionsInput {
    pub equity_mean: f64,
    pub equity_volatility: f64,
    pub bond_mean: f64,
    pub bond_volatility: f64,
    pub cash_mean: f64,
    pub cash_volatility: f64,
    pub inflation: f64,
    pub inflation_volatility: f64,
    pub simulation_runs: u32,
    pub simulation_seed: Option<u32>,

    // ── Guardrail config (Guyton-Klinger style) ───────────────────
    /// Years of spending the portfolio must cover before guardrail
    /// "release" (cut deactivates). Default 18 in TS.
    #[serde(default = "default_ceiling_years")]
    pub guardrail_ceiling_years: f64,
    /// Years below which guardrail "trigger" activates the cut. Default 12.
    #[serde(default = "default_floor_years")]
    pub guardrail_floor_years: f64,
    /// Cut applied to optional + travel when guardrail is active.
    /// Default 0.20 (20%) in TS.
    #[serde(default = "default_cut_percent")]
    pub guardrail_cut_percent: f64,
}

fn default_ceiling_years() -> f64 { 18.0 }
fn default_floor_years() -> f64 { 12.0 }
fn default_cut_percent() -> f64 { 0.20 }

/// One trace row — what the engine records per simulated year.
/// Field set for this iteration is minimal; will grow to mirror
/// `RunTrace` in `src/utils.ts` as more port work lands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRow {
    pub year: i32,
    pub total_assets: f64,
    pub spending: f64,
    pub income: f64,
    pub withdrawal_cash: f64,
    pub withdrawal_taxable: f64,
    pub withdrawal_ira401k: f64,
    pub withdrawal_roth: f64,
    pub pretax_balance_end: f64,
    pub taxable_balance_end: f64,
    pub roth_balance_end: f64,
    pub cash_balance_end: f64,
}

/// Result of running one Monte Carlo trial — the year-by-year trace
/// plus headline outcomes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialResult {
    pub yearly: Vec<TraceRow>,
    pub success: bool,
    pub failure_year: Option<i32>,
    pub ending_wealth: f64,
}

/// Aggregated output from running N trials. Maps to a small subset
/// of `PathYearResult` for now — median balances and basic stats.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregatedResult {
    pub success_rate: f64,
    pub median_ending_wealth: f64,
    pub yearly_series: Vec<YearlyMedians>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearlyMedians {
    pub year: i32,
    pub median_assets: f64,
    pub median_spending: f64,
    pub median_pretax_balance: f64,
    pub median_taxable_balance: f64,
    pub median_roth_balance: f64,
    pub median_cash_balance: f64,
}
