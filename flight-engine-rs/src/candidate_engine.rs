use serde_json::{json, Map, Value};
#[cfg(any(feature = "module-timers", feature = "tax-counters"))]
use std::cell::RefCell;
use std::collections::BTreeMap;
#[cfg(feature = "module-timers")]
use std::time::Instant;

const MIN_FAILURE_SHORTFALL_DOLLARS: f64 = 0.01;
pub const COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT: usize = 11;

#[cfg(feature = "tax-counters")]
#[derive(Clone, Default)]
struct TaxCallCounters {
    federal_tax_exact: u64,
    tax_for_withdrawals: u64,
    tax_for_conversion: u64,
    withdrawal_attempt: u64,
    proactive_roth_conversion: u64,
    proactive_roth_candidate: u64,
    proactive_roth_eligible: u64,
    proactive_roth_no_headroom: u64,
    proactive_roth_ceiling_reject: u64,
    proactive_roth_survivor: u64,
    proactive_roth_eval_zero: u64,
    proactive_roth_eval_one: u64,
    proactive_roth_eval_two: u64,
    proactive_roth_eval_three: u64,
    proactive_roth_eval_four: u64,
    proactive_roth_eval_five_plus: u64,
    proactive_roth_best_first: u64,
    proactive_roth_best_second: u64,
    proactive_roth_best_third: u64,
    proactive_roth_best_fourth: u64,
    proactive_roth_best_five_plus: u64,
    proactive_roth_shadow_largest_survivor: u64,
    proactive_roth_shadow_largest_positive: u64,
    proactive_roth_shadow_largest_matches_best: u64,
    proactive_roth_shadow_largest_differs: u64,
    proactive_roth_shadow_monotonic_scores: u64,
    proactive_roth_shadow_non_monotonic_scores: u64,
    proactive_roth_shadow_score_gap_total: f64,
    proactive_roth_shadow_tax_delta_total: f64,
    proactive_roth_shadow_magi_delta_total: f64,
    proactive_roth_fast_tax_matches: u64,
    proactive_roth_fast_tax_differs: u64,
    proactive_roth_fast_tax_delta_total: f64,
    proactive_roth_fast_magi_delta_total: f64,
    proactive_roth_already_optimal: u64,
    proactive_roth_no_survivor: u64,
    proactive_roth_negative_score: u64,
    proactive_roth_conversion_kept: u64,
    closed_loop_pass: u64,
    fallback_base_tax: u64,
    fallback_final_tax: u64,
    closed_loop_year: u64,
    closed_loop_one_pass: u64,
    closed_loop_two_pass: u64,
    closed_loop_three_plus_pass: u64,
    closed_loop_break_state_converged: u64,
    closed_loop_break_needed_delta: u64,
    closed_loop_break_oscillation: u64,
    closed_loop_break_pass_limit: u64,
    closed_loop_abs_needed_diff_total: f64,
}

#[cfg(feature = "tax-counters")]
thread_local! {
    static TAX_CALL_COUNTERS: RefCell<Option<TaxCallCounters>> = const { RefCell::new(None) };
}

#[cfg(feature = "tax-counters")]
fn reset_tax_call_counters(enabled: bool) {
    TAX_CALL_COUNTERS.with(|counters| {
        *counters.borrow_mut() = enabled.then(TaxCallCounters::default);
    });
}

#[cfg(feature = "tax-counters")]
fn record_tax_counter(update: impl FnOnce(&mut TaxCallCounters)) {
    TAX_CALL_COUNTERS.with(|counters| {
        if let Some(counters) = counters.borrow_mut().as_mut() {
            update(counters);
        }
    });
}

#[cfg(feature = "tax-counters")]
fn take_tax_call_counters() -> Option<TaxCallCounters> {
    TAX_CALL_COUNTERS.with(|counters| counters.borrow_mut().take())
}

#[cfg(feature = "tax-counters")]
impl TaxCallCounters {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        macro_rules! insert_counter {
            ($name:literal, $value:expr) => {
                object.insert($name.to_string(), json!($value));
            };
        }
        insert_counter!("federalTaxExact", self.federal_tax_exact);
        insert_counter!("taxForWithdrawals", self.tax_for_withdrawals);
        insert_counter!("taxForConversion", self.tax_for_conversion);
        insert_counter!("withdrawalAttempt", self.withdrawal_attempt);
        insert_counter!("proactiveRothConversion", self.proactive_roth_conversion);
        insert_counter!("proactiveRothCandidate", self.proactive_roth_candidate);
        insert_counter!("proactiveRothEligible", self.proactive_roth_eligible);
        insert_counter!("proactiveRothNoHeadroom", self.proactive_roth_no_headroom);
        insert_counter!(
            "proactiveRothCeilingReject",
            self.proactive_roth_ceiling_reject
        );
        insert_counter!("proactiveRothSurvivor", self.proactive_roth_survivor);
        insert_counter!("proactiveRothEvalZero", self.proactive_roth_eval_zero);
        insert_counter!("proactiveRothEvalOne", self.proactive_roth_eval_one);
        insert_counter!("proactiveRothEvalTwo", self.proactive_roth_eval_two);
        insert_counter!("proactiveRothEvalThree", self.proactive_roth_eval_three);
        insert_counter!("proactiveRothEvalFour", self.proactive_roth_eval_four);
        insert_counter!(
            "proactiveRothEvalFivePlus",
            self.proactive_roth_eval_five_plus
        );
        insert_counter!("proactiveRothBestFirst", self.proactive_roth_best_first);
        insert_counter!("proactiveRothBestSecond", self.proactive_roth_best_second);
        insert_counter!("proactiveRothBestThird", self.proactive_roth_best_third);
        insert_counter!("proactiveRothBestFourth", self.proactive_roth_best_fourth);
        insert_counter!(
            "proactiveRothBestFivePlus",
            self.proactive_roth_best_five_plus
        );
        insert_counter!(
            "proactiveRothShadowLargestSurvivor",
            self.proactive_roth_shadow_largest_survivor
        );
        insert_counter!(
            "proactiveRothShadowLargestPositive",
            self.proactive_roth_shadow_largest_positive
        );
        insert_counter!(
            "proactiveRothShadowLargestMatchesBest",
            self.proactive_roth_shadow_largest_matches_best
        );
        insert_counter!(
            "proactiveRothShadowLargestDiffers",
            self.proactive_roth_shadow_largest_differs
        );
        insert_counter!(
            "proactiveRothShadowMonotonicScores",
            self.proactive_roth_shadow_monotonic_scores
        );
        insert_counter!(
            "proactiveRothShadowNonMonotonicScores",
            self.proactive_roth_shadow_non_monotonic_scores
        );
        insert_counter!(
            "proactiveRothShadowScoreGapTotal",
            self.proactive_roth_shadow_score_gap_total
        );
        insert_counter!(
            "proactiveRothShadowTaxDeltaTotal",
            self.proactive_roth_shadow_tax_delta_total
        );
        insert_counter!(
            "proactiveRothShadowMagiDeltaTotal",
            self.proactive_roth_shadow_magi_delta_total
        );
        insert_counter!(
            "proactiveRothFastTaxMatches",
            self.proactive_roth_fast_tax_matches
        );
        insert_counter!(
            "proactiveRothFastTaxDiffers",
            self.proactive_roth_fast_tax_differs
        );
        insert_counter!(
            "proactiveRothFastTaxDeltaTotal",
            self.proactive_roth_fast_tax_delta_total
        );
        insert_counter!(
            "proactiveRothFastMagiDeltaTotal",
            self.proactive_roth_fast_magi_delta_total
        );
        insert_counter!(
            "proactiveRothAlreadyOptimal",
            self.proactive_roth_already_optimal
        );
        insert_counter!("proactiveRothNoSurvivor", self.proactive_roth_no_survivor);
        insert_counter!(
            "proactiveRothNegativeScore",
            self.proactive_roth_negative_score
        );
        insert_counter!(
            "proactiveRothConversionKept",
            self.proactive_roth_conversion_kept
        );
        insert_counter!("closedLoopPass", self.closed_loop_pass);
        insert_counter!("fallbackBaseTax", self.fallback_base_tax);
        insert_counter!("fallbackFinalTax", self.fallback_final_tax);
        insert_counter!("closedLoopYear", self.closed_loop_year);
        insert_counter!("closedLoopOnePass", self.closed_loop_one_pass);
        insert_counter!("closedLoopTwoPass", self.closed_loop_two_pass);
        insert_counter!("closedLoopThreePlusPass", self.closed_loop_three_plus_pass);
        insert_counter!(
            "closedLoopBreakStateConverged",
            self.closed_loop_break_state_converged
        );
        insert_counter!(
            "closedLoopBreakNeededDelta",
            self.closed_loop_break_needed_delta
        );
        insert_counter!(
            "closedLoopBreakOscillation",
            self.closed_loop_break_oscillation
        );
        insert_counter!(
            "closedLoopBreakPassLimit",
            self.closed_loop_break_pass_limit
        );
        insert_counter!(
            "closedLoopAbsNeededDiffTotal",
            self.closed_loop_abs_needed_diff_total
        );
        Value::Object(object)
    }
}

#[cfg(feature = "tax-counters")]
#[derive(Clone, Copy)]
enum ClosedLoopBreakReason {
    StateConverged,
    NeededDelta,
    Oscillation,
    PassLimit,
}

#[cfg(feature = "tax-counters")]
fn record_closed_loop_outcome(
    pass_count: u64,
    reason: ClosedLoopBreakReason,
    abs_needed_diff: f64,
) {
    record_tax_counter(|counters| {
        counters.closed_loop_year += 1;
        counters.closed_loop_abs_needed_diff_total += abs_needed_diff;
        match pass_count {
            0 | 1 => counters.closed_loop_one_pass += 1,
            2 => counters.closed_loop_two_pass += 1,
            _ => counters.closed_loop_three_plus_pass += 1,
        }
        match reason {
            ClosedLoopBreakReason::StateConverged => {
                counters.closed_loop_break_state_converged += 1
            }
            ClosedLoopBreakReason::NeededDelta => counters.closed_loop_break_needed_delta += 1,
            ClosedLoopBreakReason::Oscillation => counters.closed_loop_break_oscillation += 1,
            ClosedLoopBreakReason::PassLimit => counters.closed_loop_break_pass_limit += 1,
        }
    });
}

#[cfg(feature = "tax-counters")]
fn record_roth_eval_count(evaluated_candidate_count: u64) {
    record_tax_counter(|counters| match evaluated_candidate_count {
        0 => counters.proactive_roth_eval_zero += 1,
        1 => counters.proactive_roth_eval_one += 1,
        2 => counters.proactive_roth_eval_two += 1,
        3 => counters.proactive_roth_eval_three += 1,
        4 => counters.proactive_roth_eval_four += 1,
        _ => counters.proactive_roth_eval_five_plus += 1,
    });
}

#[cfg(feature = "tax-counters")]
fn record_roth_best_candidate(best_candidate_index: u64) {
    record_tax_counter(|counters| match best_candidate_index {
        1 => counters.proactive_roth_best_first += 1,
        2 => counters.proactive_roth_best_second += 1,
        3 => counters.proactive_roth_best_third += 1,
        4 => counters.proactive_roth_best_fourth += 1,
        _ => counters.proactive_roth_best_five_plus += 1,
    });
}

#[cfg(feature = "tax-counters")]
fn record_roth_largest_shadow(
    largest_score: f64,
    largest_tax: TaxOutput,
    best_score: f64,
    best_tax: TaxOutput,
    scores_monotonic: bool,
) {
    record_tax_counter(|counters| {
        counters.proactive_roth_shadow_largest_survivor += 1;
        if largest_score > 0.0 {
            counters.proactive_roth_shadow_largest_positive += 1;
        }
        if (best_score - largest_score).abs() <= 0.01
            && (best_tax.federal_tax - largest_tax.federal_tax).abs() <= 0.01
            && (best_tax.magi - largest_tax.magi).abs() <= 0.01
        {
            counters.proactive_roth_shadow_largest_matches_best += 1;
        } else {
            counters.proactive_roth_shadow_largest_differs += 1;
            counters.proactive_roth_shadow_score_gap_total += (best_score - largest_score).abs();
            counters.proactive_roth_shadow_tax_delta_total +=
                (best_tax.federal_tax - largest_tax.federal_tax).abs();
            counters.proactive_roth_shadow_magi_delta_total +=
                (best_tax.magi - largest_tax.magi).abs();
        }
        if scores_monotonic {
            counters.proactive_roth_shadow_monotonic_scores += 1;
        } else {
            counters.proactive_roth_shadow_non_monotonic_scores += 1;
        }
    });
}

#[cfg(feature = "tax-counters")]
fn record_roth_fast_tax_shadow(exact: TaxOutput, fast: TaxOutput) {
    record_tax_counter(|counters| {
        let tax_delta = (exact.federal_tax - fast.federal_tax).abs();
        let magi_delta = (exact.magi - fast.magi).abs();
        if tax_delta <= 0.01 && magi_delta <= 0.01 {
            counters.proactive_roth_fast_tax_matches += 1;
        } else {
            counters.proactive_roth_fast_tax_differs += 1;
            counters.proactive_roth_fast_tax_delta_total += tax_delta;
            counters.proactive_roth_fast_magi_delta_total += magi_delta;
        }
    });
}

#[cfg(feature = "module-timers")]
#[derive(Clone, Default)]
struct ModuleTimerCounters {
    compact_year_at_calls: u64,
    compact_year_at_ns: u128,
    federal_tax_exact_calls: u64,
    federal_tax_exact_ns: u128,
    healthcare_premium_calls: u64,
    healthcare_premium_ns: u128,
    ordinary_tax_calls: u64,
    ordinary_tax_ns: u128,
    withdrawal_attempt_calls: u64,
    withdrawal_attempt_ns: u128,
    percentile_calls: u64,
    percentile_ns: u128,
}

#[cfg(feature = "module-timers")]
thread_local! {
    static MODULE_TIMER_COUNTERS: RefCell<Option<ModuleTimerCounters>> = const { RefCell::new(None) };
}

#[cfg(feature = "module-timers")]
#[derive(Clone, Copy)]
enum ModuleTimer {
    CompactYearAt,
    FederalTaxExact,
    HealthcarePremium,
    OrdinaryTax,
    WithdrawalAttempt,
    Percentile,
}

#[cfg(not(feature = "module-timers"))]
#[derive(Clone, Copy)]
enum ModuleTimer {
    CompactYearAt,
    FederalTaxExact,
    HealthcarePremium,
    OrdinaryTax,
    WithdrawalAttempt,
    Percentile,
}

#[cfg(not(feature = "module-timers"))]
fn time_module<R>(_module: ModuleTimer, work: impl FnOnce() -> R) -> R {
    work()
}

#[cfg(feature = "module-timers")]
fn reset_module_timer_counters(enabled: bool) {
    MODULE_TIMER_COUNTERS.with(|counters| {
        *counters.borrow_mut() = enabled.then(ModuleTimerCounters::default);
    });
}

#[cfg(feature = "module-timers")]
fn time_module<R>(module: ModuleTimer, work: impl FnOnce() -> R) -> R {
    if !MODULE_TIMER_COUNTERS.with(|counters| counters.borrow().is_some()) {
        return work();
    }
    let started_at = Instant::now();
    let result = work();
    let elapsed_ns = started_at.elapsed().as_nanos();
    MODULE_TIMER_COUNTERS.with(|counters| {
        if let Some(counters) = counters.borrow_mut().as_mut() {
            match module {
                ModuleTimer::CompactYearAt => {
                    counters.compact_year_at_calls += 1;
                    counters.compact_year_at_ns += elapsed_ns;
                }
                ModuleTimer::FederalTaxExact => {
                    counters.federal_tax_exact_calls += 1;
                    counters.federal_tax_exact_ns += elapsed_ns;
                }
                ModuleTimer::HealthcarePremium => {
                    counters.healthcare_premium_calls += 1;
                    counters.healthcare_premium_ns += elapsed_ns;
                }
                ModuleTimer::OrdinaryTax => {
                    counters.ordinary_tax_calls += 1;
                    counters.ordinary_tax_ns += elapsed_ns;
                }
                ModuleTimer::WithdrawalAttempt => {
                    counters.withdrawal_attempt_calls += 1;
                    counters.withdrawal_attempt_ns += elapsed_ns;
                }
                ModuleTimer::Percentile => {
                    counters.percentile_calls += 1;
                    counters.percentile_ns += elapsed_ns;
                }
            }
        }
    });
    result
}

#[cfg(feature = "module-timers")]
fn take_module_timer_counters() -> Option<ModuleTimerCounters> {
    MODULE_TIMER_COUNTERS.with(|counters| counters.borrow_mut().take())
}

#[cfg(feature = "module-timers")]
fn module_timer_json(calls: u64, total_ns: u128) -> Value {
    let total_ms = total_ns as f64 / 1_000_000.0;
    json!({
        "calls": calls,
        "totalNs": total_ns as f64,
        "totalMs": total_ms,
        "perCallUs": if calls > 0 { total_ns as f64 / calls as f64 / 1_000.0 } else { 0.0 },
    })
}

#[cfg(feature = "module-timers")]
impl ModuleTimerCounters {
    fn to_json(&self) -> Value {
        json!({
            "compactYearAt": module_timer_json(self.compact_year_at_calls, self.compact_year_at_ns),
            "federalTaxExact": module_timer_json(self.federal_tax_exact_calls, self.federal_tax_exact_ns),
            "healthcarePremium": module_timer_json(self.healthcare_premium_calls, self.healthcare_premium_ns),
            "ordinaryTax": module_timer_json(self.ordinary_tax_calls, self.ordinary_tax_ns),
            "withdrawalAttempt": module_timer_json(self.withdrawal_attempt_calls, self.withdrawal_attempt_ns),
            "percentile": module_timer_json(self.percentile_calls, self.percentile_ns),
        })
    }
}

pub struct CompactSummaryTapeInput<'a> {
    pub metadata: Value,
    pub trial_index: &'a [i32],
    pub trial_seed: &'a [f64],
    pub ltc_event_occurs: &'a [u8],
    pub cashflow_present: &'a [u8],
    pub market_state: &'a [u8],
    pub market_years: &'a [f64],
    pub year_field_count: usize,
}

pub struct CompactSummaryTapeDimensions {
    pub trial_count: usize,
    pub years_per_trial: usize,
    pub row_count: usize,
}

pub struct CompactSummaryTapeYear {
    pub year: i64,
    pub year_offset: i64,
    pub inflation: f64,
    pub us_equity_return: f64,
    pub intl_equity_return: f64,
    pub bond_return: f64,
    pub cash_return: f64,
    pub bucket_returns: Option<CompactBucketReturns>,
    pub cashflow_present: bool,
    pub market_state: &'static str,
}

#[derive(Clone, Copy)]
pub struct CompactBucketReturns {
    pub pretax: f64,
    pub roth: f64,
    pub taxable: f64,
    pub cash: f64,
}

#[derive(Clone, Copy)]
struct AssetReturns {
    us_equity: f64,
    intl_equity: f64,
    bonds: f64,
    cash: f64,
}

struct ReplayYear {
    year: i64,
    inflation: f64,
    asset_returns: AssetReturns,
    bucket_returns: Option<CompactBucketReturns>,
    cashflow_present: bool,
    market_state: String,
}

struct ReplayTrial {
    trial_index: i64,
    ltc_event_occurs: bool,
    years: Vec<ReplayYear>,
}

struct ReplayTape {
    seed: i64,
    planning_horizon_years: i64,
    trials: Vec<ReplayTrial>,
}

struct CompactReplayTape<'a> {
    input: CompactSummaryTapeInput<'a>,
    dimensions: CompactSummaryTapeDimensions,
}

enum ReplayTapeInput<'a> {
    Materialized(ReplayTape),
    Compact(CompactReplayTape<'a>),
}

enum ReplayTrialView<'a> {
    Materialized(&'a ReplayTrial),
    Compact {
        tape: &'a CompactReplayTape<'a>,
        trial_offset: usize,
    },
}

enum ReplayYearView<'a> {
    Materialized(&'a ReplayYear),
    Compact(CompactSummaryTapeYear),
}

impl AssetReturns {
    fn from_json(value: &Value) -> Self {
        Self {
            us_equity: as_f64(value.get("US_EQUITY")),
            intl_equity: as_f64(value.get("INTL_EQUITY")),
            bonds: as_f64(value.get("BONDS")),
            cash: as_f64(value.get("CASH")),
        }
    }
}

impl ReplayYear {
    fn from_json(value: &Value) -> Self {
        let bucket_returns = value.get("bucketReturns").and_then(|bucket| {
            Some(CompactBucketReturns {
                pretax: bucket.get("pretax")?.as_f64()?,
                roth: bucket.get("roth")?.as_f64()?,
                taxable: bucket.get("taxable")?.as_f64()?,
                cash: bucket.get("cash")?.as_f64()?,
            })
        });
        Self {
            year: as_i64(value.get("year")),
            inflation: as_f64(value.get("inflation")),
            asset_returns: AssetReturns::from_json(&value["assetReturns"]),
            bucket_returns,
            cashflow_present: value.get("cashflow").is_some(),
            market_state: value
                .get("marketState")
                .and_then(Value::as_str)
                .unwrap_or("normal")
                .to_string(),
        }
    }
}

impl ReplayTape {
    fn from_json(tape: &Value) -> Result<Self, Box<dyn std::error::Error>> {
        let trials = tape
            .get("trials")
            .and_then(Value::as_array)
            .ok_or("random tape is missing trials")?
            .iter()
            .map(|trial| {
                let years = trial
                    .get("marketPath")
                    .and_then(Value::as_array)
                    .ok_or("random tape trial is missing marketPath")?
                    .iter()
                    .map(ReplayYear::from_json)
                    .collect();
                Ok(ReplayTrial {
                    trial_index: as_i64(trial.get("trialIndex")),
                    ltc_event_occurs: trial
                        .get("ltcEventOccurs")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    years,
                })
            })
            .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
        Ok(Self {
            seed: as_i64(tape.get("seed")),
            planning_horizon_years: as_i64(tape.get("planningHorizonYears")),
            trials,
        })
    }
}

impl<'a> CompactReplayTape<'a> {
    fn new(input: CompactSummaryTapeInput<'a>) -> Result<Self, String> {
        let dimensions = input.dimensions()?;
        Ok(Self { input, dimensions })
    }
}

impl<'a> ReplayTapeInput<'a> {
    fn from_compact(input: CompactSummaryTapeInput<'a>) -> Result<Self, String> {
        Ok(Self::Compact(CompactReplayTape::new(input)?))
    }

    fn seed(&self) -> i64 {
        match self {
            Self::Materialized(tape) => tape.seed,
            Self::Compact(tape) => as_i64(tape.input.metadata.get("seed")),
        }
    }

    fn planning_horizon_years(&self) -> i64 {
        match self {
            Self::Materialized(tape) => tape.planning_horizon_years,
            Self::Compact(tape) => as_i64(tape.input.metadata.get("planningHorizonYears")),
        }
    }

    fn trial_count(&self) -> usize {
        match self {
            Self::Materialized(tape) => tape.trials.len(),
            Self::Compact(tape) => tape.dimensions.trial_count,
        }
    }

    fn trial_at(&'a self, trial_offset: usize) -> ReplayTrialView<'a> {
        match self {
            Self::Materialized(tape) => ReplayTrialView::Materialized(&tape.trials[trial_offset]),
            Self::Compact(tape) => ReplayTrialView::Compact { tape, trial_offset },
        }
    }
}

impl<'a> ReplayTrialView<'a> {
    fn trial_index(&self) -> i64 {
        match self {
            Self::Materialized(trial) => trial.trial_index,
            Self::Compact { tape, trial_offset } => tape.input.trial_index[*trial_offset] as i64,
        }
    }

    fn ltc_event_occurs(&self) -> bool {
        match self {
            Self::Materialized(trial) => trial.ltc_event_occurs,
            Self::Compact { tape, trial_offset } => tape.input.ltc_event_occurs[*trial_offset] != 0,
        }
    }

    fn year_count(&self) -> usize {
        match self {
            Self::Materialized(trial) => trial.years.len(),
            Self::Compact { tape, .. } => tape.dimensions.years_per_trial,
        }
    }

    fn year_at(&self, year_offset: usize) -> ReplayYearView<'a> {
        match self {
            Self::Materialized(trial) => ReplayYearView::Materialized(&trial.years[year_offset]),
            Self::Compact { tape, trial_offset } => ReplayYearView::Compact(tape.input.year_at(
                &tape.dimensions,
                *trial_offset,
                year_offset,
            )),
        }
    }
}

impl ReplayYearView<'_> {
    fn year(&self) -> i64 {
        match self {
            Self::Materialized(year) => year.year,
            Self::Compact(year) => year.year,
        }
    }

    fn inflation(&self) -> f64 {
        match self {
            Self::Materialized(year) => year.inflation,
            Self::Compact(year) => year.inflation,
        }
    }

    fn asset_returns(&self) -> AssetReturns {
        match self {
            Self::Materialized(year) => year.asset_returns,
            Self::Compact(year) => AssetReturns {
                us_equity: year.us_equity_return,
                intl_equity: year.intl_equity_return,
                bonds: year.bond_return,
                cash: year.cash_return,
            },
        }
    }

    fn bucket_returns(&self) -> Option<CompactBucketReturns> {
        match self {
            Self::Materialized(year) => year.bucket_returns,
            Self::Compact(year) => year.bucket_returns,
        }
    }

    fn cashflow_present(&self) -> bool {
        match self {
            Self::Materialized(year) => year.cashflow_present,
            Self::Compact(year) => year.cashflow_present,
        }
    }

    fn market_state(&self) -> &str {
        match self {
            Self::Materialized(year) => year.market_state.as_str(),
            Self::Compact(year) => year.market_state,
        }
    }
}

impl CompactSummaryTapeInput<'_> {
    pub fn dimensions(&self) -> Result<CompactSummaryTapeDimensions, String> {
        if self.year_field_count != COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT {
            return Err(format!(
                "unsupported compact tape year field count: {}",
                self.year_field_count
            ));
        }
        let trial_count =
            self.metadata
                .get("trialCount")
                .and_then(Value::as_u64)
                .ok_or("compact tape metadata is missing trialCount")? as usize;
        let years_per_trial = self
            .metadata
            .get("planningHorizonYears")
            .and_then(Value::as_u64)
            .ok_or("compact tape metadata is missing planningHorizonYears")?
            as usize;
        let row_count = trial_count
            .checked_mul(years_per_trial)
            .ok_or("compact tape row count overflow")?;
        if self.trial_index.len() != trial_count
            || self.trial_seed.len() != trial_count
            || self.ltc_event_occurs.len() != trial_count
        {
            return Err("compact tape trial arrays do not match trialCount".to_string());
        }
        if self.cashflow_present.len() != row_count
            || self.market_state.len() != row_count
            || self.market_years.len() != row_count * self.year_field_count
        {
            return Err(
                "compact tape market arrays do not match trial/year dimensions".to_string(),
            );
        }
        Ok(CompactSummaryTapeDimensions {
            trial_count,
            years_per_trial,
            row_count,
        })
    }

    pub fn year_at(
        &self,
        dimensions: &CompactSummaryTapeDimensions,
        trial_offset: usize,
        year_offset: usize,
    ) -> CompactSummaryTapeYear {
        time_module(ModuleTimer::CompactYearAt, || {
            let row = trial_offset * dimensions.years_per_trial + year_offset;
            let base = row * self.year_field_count;
            let bucket_pretax = self.market_years[base + 7];
            let bucket_roth = self.market_years[base + 8];
            let bucket_taxable = self.market_years[base + 9];
            let bucket_cash = self.market_years[base + 10];
            CompactSummaryTapeYear {
                year: self.market_years[base] as i64,
                year_offset: self.market_years[base + 1] as i64,
                inflation: self.market_years[base + 2],
                us_equity_return: self.market_years[base + 3],
                intl_equity_return: self.market_years[base + 4],
                bond_return: self.market_years[base + 5],
                cash_return: self.market_years[base + 6],
                bucket_returns: if bucket_pretax.is_finite()
                    && bucket_roth.is_finite()
                    && bucket_taxable.is_finite()
                    && bucket_cash.is_finite()
                {
                    Some(CompactBucketReturns {
                        pretax: bucket_pretax,
                        roth: bucket_roth,
                        taxable: bucket_taxable,
                        cash: bucket_cash,
                    })
                } else {
                    None
                },
                cashflow_present: self.cashflow_present[row] != 0,
                market_state: match self.market_state[row] {
                    1 => "down",
                    2 => "up",
                    _ => "normal",
                },
            }
        })
    }
}

#[derive(Clone, Copy)]
struct Balances {
    pretax: f64,
    roth: f64,
    taxable: f64,
    cash: f64,
}

struct ContributionResult {
    adjusted_wages: f64,
    employee_401k_contribution: f64,
    employer_match_contribution: f64,
    hsa_contribution: f64,
    roth_contribution_flow: f64,
    updated_hsa_balance: f64,
}

struct ContributionSettings {
    pretax_annual_target: f64,
    pretax_target_is_amount: bool,
    pretax_annual_target_by_year: Vec<(i64, f64)>,
    roth_annual_target: f64,
    roth_target_is_amount: bool,
    roth_annual_target_by_year: Vec<(i64, f64)>,
    match_rate: f64,
    match_cap_percent: f64,
    hsa_annual_target: f64,
    hsa_target_is_amount: bool,
    hsa_annual_target_by_year: Vec<(i64, f64)>,
    hsa_self_coverage: bool,
}

#[derive(Clone)]
struct ContributionLimits {
    employee_401k_base_limit: f64,
    employee_401k_catch_up_age: i64,
    employee_401k_catch_up_limit: f64,
    employee_401k_base_limit_by_year: Vec<(i64, f64)>,
    employee_401k_catch_up_limit_by_year: Vec<(i64, f64)>,
    hsa_self_limit: f64,
    hsa_family_limit: f64,
    hsa_catch_up_age: i64,
    hsa_catch_up_limit: f64,
    hsa_self_limit_by_year: Vec<(i64, f64)>,
    hsa_family_limit_by_year: Vec<(i64, f64)>,
    hsa_catch_up_limit_by_year: Vec<(i64, f64)>,
}

#[derive(Clone, Copy)]
enum HsaWithdrawalMode {
    HighMagiYears,
    OngoingQualifiedExpenses,
    LtcReserve,
}

impl HsaWithdrawalMode {
    fn from_str(value: &str) -> Self {
        match value {
            "high_magi_years" => Self::HighMagiYears,
            "ltc_reserve" => Self::LtcReserve,
            _ => Self::OngoingQualifiedExpenses,
        }
    }
}

#[derive(Clone, Copy)]
struct HsaStrategy {
    enabled: bool,
    withdrawal_mode: HsaWithdrawalMode,
    prioritize_high_magi: bool,
    high_magi_threshold: f64,
    annual_cap: f64,
}

#[derive(Clone, Copy)]
struct RothConversionPolicy {
    enabled: bool,
    min_annual: f64,
    max_annual: f64,
    max_pretax_balance_percent: f64,
    magi_buffer: f64,
    low_income_bracket_fill_enabled: bool,
    low_income_bracket_fill_start_year: Option<i64>,
    low_income_bracket_fill_end_year: Option<i64>,
    low_income_bracket_fill_annual_target: f64,
    low_income_bracket_fill_require_no_wage_income: bool,
}

#[derive(Clone)]
struct SocialSecurityEntry {
    person: String,
    claim_age: f64,
    fra_monthly: f64,
}

#[derive(Clone)]
struct SocialSecuritySchedule {
    entries: Vec<SocialSecurityEntry>,
    rob_index: Option<usize>,
    debbie_index: Option<usize>,
    rob_death_age: Option<f64>,
    debbie_death_age: Option<f64>,
}

#[derive(Clone)]
struct WindfallEntry {
    name: String,
    amount: f64,
    year: i64,
    treatment: String,
    distribution_years: i64,
    selling_cost_percent: f64,
    liquidity_amount: Option<f64>,
    cost_basis: Option<f64>,
    exclusion_amount: Option<f64>,
    replacement_home_cost: Option<f64>,
    purchase_closing_cost_percent: Option<f64>,
    moving_cost: Option<f64>,
}

#[derive(Clone)]
struct WindfallSchedule {
    entries: Vec<WindfallEntry>,
    default_home_sale_exclusion: f64,
}

#[derive(Clone, Copy)]
struct HousingAfterDownsizePolicy {
    start_year: i64,
    replacement_home_cost: f64,
    post_sale_annual_taxes_insurance: Option<f64>,
    current_home_value: f64,
}

#[derive(Clone, Copy)]
struct TaxConstants {
    married_filing_jointly: bool,
    standard_deduction_base: f64,
    standard_deduction_bump_each: f64,
    social_security_first_base: f64,
    social_security_second_base: f64,
    social_security_base_cap: f64,
    ordinary_brackets: &'static [(f64, f64)],
    ltcg_zero_top: f64,
    ltcg_fifteen_top: f64,
    niit_threshold: f64,
    additional_medicare_threshold: f64,
    irmaa_thresholds: &'static [f64],
    irmaa_surcharge_bracket: &'static [(f64, f64)],
    aca_baseline_fpl: f64,
}

#[derive(Clone, Copy)]
struct TaxOutput {
    federal_tax: f64,
    magi: f64,
}

#[derive(Clone, Copy)]
struct ReturnWeights {
    us_equity: f64,
    intl_equity: f64,
    bonds: f64,
    cash: f64,
}

impl ReturnWeights {
    fn from_bucket(data: &Value, bucket: &str) -> Self {
        let Some(allocation) = data
            .pointer(&format!("/accounts/{bucket}/targetAllocation"))
            .and_then(Value::as_object)
        else {
            return Self::default();
        };
        allocation
            .iter()
            .fold(Self::default(), |mut weights, (symbol, weight)| {
                let weight = weight.as_f64().unwrap_or(0.0);
                let (us_w, intl_w, bonds_w, cash_w) = symbol_exposure(symbol.as_str());
                weights.us_equity += weight * us_w;
                weights.intl_equity += weight * intl_w;
                weights.bonds += weight * bonds_w;
                weights.cash += weight * cash_w;
                weights
            })
    }

    fn apply(self, asset_returns: AssetReturns) -> f64 {
        self.us_equity * asset_returns.us_equity
            + self.intl_equity * asset_returns.intl_equity
            + self.bonds * asset_returns.bonds
            + self.cash * asset_returns.cash
    }
}

impl Default for ReturnWeights {
    fn default() -> Self {
        Self {
            us_equity: 0.0,
            intl_equity: 0.0,
            bonds: 0.0,
            cash: 0.0,
        }
    }
}

struct SimulationConstants {
    start_balances: Balances,
    hsa_balance: f64,
    hsa_return_weights: ReturnWeights,
    annual_spending: f64,
    essential_annual: f64,
    optional_annual: f64,
    taxes_insurance_annual: f64,
    housing_after_downsize_policy: Option<HousingAfterDownsizePolicy>,
    travel_annual: f64,
    travel_floor_annual: f64,
    rob_current_age: i64,
    debbie_current_age: i64,
    rob_rmd_start_age: i64,
    debbie_rmd_start_age: i64,
    pretax_rob_rmd_share: f64,
    pretax_debbie_rmd_share: f64,
    salary_annual: f64,
    salary_end_year: i64,
    salary_end_month_for_proration: i64,
    retirement_year: i64,
    travel_phase_years: i64,
    travel_flat_years: i64,
    guardrail_floor_years: f64,
    guardrail_ceiling_years: f64,
    guardrail_cut_percent: f64,
    withdrawal_rule: String,
    guardrails_enabled: bool,
    irmaa_aware_withdrawal_buffer: bool,
    irmaa_threshold: f64,
    ltc_enabled: bool,
    ltc_start_age: i64,
    ltc_duration_years: i64,
    ltc_annual_cost_today: f64,
    ltc_inflation_annual: f64,
    contribution_settings: ContributionSettings,
    contribution_limits: ContributionLimits,
    social_security_schedule: SocialSecuritySchedule,
    windfall_schedule: WindfallSchedule,
    tax_constants: TaxConstants,
    hsa_strategy: HsaStrategy,
    roth_conversion_policy: RothConversionPolicy,
    taxable_defense_score: f64,
    pretax_defense_score: f64,
    baseline_aca_premium_annual: f64,
    baseline_medicare_premium_annual: f64,
}

impl Balances {
    fn total(self) -> f64 {
        self.pretax + self.roth + self.taxable + self.cash
    }
}

fn total_assets_with_hsa(balances: Balances, hsa_balance: f64) -> f64 {
    balances.total() + hsa_balance.max(0.0)
}

impl SimulationConstants {
    fn from(
        data: &Value,
        assumptions: &Value,
        planner_logic_active: bool,
        annual_spend_target: Option<f64>,
    ) -> Self {
        let rob_birth_date = data
            .pointer("/household/robBirthDate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let debbie_birth_date = data
            .pointer("/household/debbieBirthDate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let rmd_policy_override = data
            .pointer("/rules/rmdPolicy/startAgeOverride")
            .and_then(Value::as_i64);
        let salary_end_date = data
            .pointer("/income/salaryEndDate")
            .and_then(Value::as_str)
            .unwrap_or("2027-01-01");
        let salary_end_year = year_from_iso(salary_end_date);
        let salary_end_month_for_proration = (month_from_iso(salary_end_date) - 1).max(0);
        let (pretax_rob_rmd_share, pretax_debbie_rmd_share) = pretax_owner_rmd_shares(data);
        let (essential_annual, raw_optional_annual, taxes_insurance_annual, travel_annual) =
            spending_parts(data);
        let optional_annual = annual_spend_target
            .filter(|target| target.is_finite() && *target >= 0.0)
            .map(|target| {
                (target - essential_annual - taxes_insurance_annual - travel_annual).max(0.0)
            })
            .unwrap_or(raw_optional_annual);
        let annual_spending =
            essential_annual + optional_annual + taxes_insurance_annual + travel_annual;
        let withdrawal_rule = assumptions
            .get("withdrawalRule")
            .and_then(Value::as_str)
            .unwrap_or("tax_bracket_waterfall");
        let travel_phase_years = as_i64(assumptions.get("travelPhaseYears")).max(0);
        let travel_flat_years = assumptions
            .get("travelFlatYears")
            .and_then(Value::as_i64)
            .unwrap_or(travel_phase_years)
            .max(0);
        Self {
            start_balances: starting_balances(data),
            hsa_balance: bucket_balance(data, "hsa"),
            hsa_return_weights: ReturnWeights::from_bucket(data, "hsa"),
            annual_spending,
            essential_annual,
            optional_annual,
            taxes_insurance_annual,
            housing_after_downsize_policy: HousingAfterDownsizePolicy::from(data),
            travel_annual,
            travel_floor_annual: as_f64(data.pointer("/spending/travelFloorAnnual")).max(0.0),
            rob_current_age: current_age_at_2026_04_16(rob_birth_date),
            debbie_current_age: current_age_at_2026_04_16(debbie_birth_date),
            rob_rmd_start_age: rmd_policy_override
                .unwrap_or_else(|| rmd_start_age_for_birth_year(year_from_iso(rob_birth_date))),
            debbie_rmd_start_age: rmd_policy_override
                .unwrap_or_else(|| rmd_start_age_for_birth_year(year_from_iso(debbie_birth_date))),
            pretax_rob_rmd_share,
            pretax_debbie_rmd_share,
            salary_annual: as_f64(data.pointer("/income/salaryAnnual")).max(0.0),
            salary_end_year,
            salary_end_month_for_proration,
            retirement_year: year_from_iso(salary_end_date),
            travel_phase_years,
            travel_flat_years,
            guardrail_floor_years: as_f64(assumptions.get("guardrailFloorYears")),
            guardrail_ceiling_years: as_f64(assumptions.get("guardrailCeilingYears")),
            guardrail_cut_percent: as_f64(assumptions.get("guardrailCutPercent")),
            withdrawal_rule: withdrawal_rule.to_string(),
            guardrails_enabled: planner_logic_active || withdrawal_rule == "guyton_klinger",
            irmaa_aware_withdrawal_buffer: planner_logic_active
                && data
                    .pointer("/rules/irmaaAware")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            irmaa_threshold: as_f64(assumptions.get("irmaaThreshold")),
            ltc_enabled: data
                .pointer("/rules/ltcAssumptions/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            ltc_start_age: as_i64(data.pointer("/rules/ltcAssumptions/startAge")).max(82),
            ltc_duration_years: as_f64(data.pointer("/rules/ltcAssumptions/durationYears"))
                .round()
                .max(1.0) as i64,
            ltc_annual_cost_today: as_f64(data.pointer("/rules/ltcAssumptions/annualCostToday")),
            ltc_inflation_annual: data
                .pointer("/rules/ltcAssumptions/inflationAnnual")
                .and_then(Value::as_f64)
                .unwrap_or(0.055),
            contribution_settings: ContributionSettings::from(
                data.pointer("/income/preRetirementContributions"),
                as_f64(data.pointer("/income/salaryAnnual")).max(0.0),
            ),
            contribution_limits: ContributionLimits::from(data),
            social_security_schedule: SocialSecuritySchedule::from(data, assumptions),
            windfall_schedule: WindfallSchedule::from(data),
            tax_constants: TaxConstants::from(data),
            hsa_strategy: HsaStrategy::from(data),
            roth_conversion_policy: RothConversionPolicy::from(data),
            taxable_defense_score: defense_score(data, "taxable"),
            pretax_defense_score: defense_score(data, "pretax"),
            baseline_aca_premium_annual: as_f64(
                data.pointer("/rules/healthcarePremiums/baselineAcaPremiumAnnual"),
            )
            .max(14_400.0),
            baseline_medicare_premium_annual: as_f64(
                data.pointer("/rules/healthcarePremiums/baselineMedicarePremiumAnnual"),
            )
            .max(2_220.0),
        }
    }

    fn rob_age(&self, year_offset: usize) -> i64 {
        self.rob_current_age + year_offset as i64
    }

    fn debbie_age(&self, year_offset: usize) -> i64 {
        self.debbie_current_age + year_offset as i64
    }

    fn salary_for_year(&self, year: i64) -> f64 {
        if year < self.salary_end_year {
            self.salary_annual
        } else if year > self.salary_end_year {
            0.0
        } else {
            self.salary_annual * (self.salary_end_month_for_proration.max(0) as f64 / 12.0)
        }
    }

    fn taxes_insurance_for_year(&self, year: i64) -> f64 {
        let base = self.taxes_insurance_annual;
        let Some(policy) = self.housing_after_downsize_policy else {
            return base;
        };
        if year < policy.start_year {
            return base;
        }
        if let Some(post_sale) = policy.post_sale_annual_taxes_insurance {
            return post_sale;
        }
        if policy.replacement_home_cost <= 0.0 {
            return base;
        }
        let value_ratio = if policy.current_home_value > 0.0 {
            policy.replacement_home_cost / policy.current_home_value
        } else {
            1.0
        };
        base * value_ratio.max(0.0)
    }

    fn travel_for_year(&self, year: i64) -> f64 {
        let years_into_retirement = year - self.retirement_year;
        if years_into_retirement < self.travel_flat_years {
            return self.travel_annual;
        }
        if years_into_retirement >= self.travel_phase_years
            || self.travel_flat_years >= self.travel_phase_years
        {
            return self.travel_floor_annual;
        }
        let progress = (years_into_retirement - self.travel_flat_years) as f64
            / (self.travel_phase_years - self.travel_flat_years) as f64;
        self.travel_annual + (self.travel_floor_annual - self.travel_annual) * progress
    }

    fn medicare_eligible_count(&self, year_offset: usize) -> i64 {
        (if self.rob_age(year_offset) >= 65 {
            1
        } else {
            0
        }) + (if self.debbie_age(year_offset) >= 65 {
            1
        } else {
            0
        })
    }

    fn required_minimum_distribution(&self, pretax_balance: f64, year_offset: usize) -> f64 {
        let members = [
            (
                self.rob_age(year_offset),
                self.rob_rmd_start_age,
                self.pretax_rob_rmd_share,
            ),
            (
                self.debbie_age(year_offset),
                self.debbie_rmd_start_age,
                self.pretax_debbie_rmd_share,
            ),
        ];
        members.iter().fold(0.0, |total, (age, start_age, share)| {
            if age < start_age || *share <= 0.0 {
                total
            } else {
                total + (pretax_balance.max(0.0) * share) / uniform_lifetime_divisor(*age)
            }
        })
    }

    fn years_until_rmd_start(&self, rob_age: i64, debbie_age: i64) -> i64 {
        0.max((self.rob_rmd_start_age - rob_age).min(self.debbie_rmd_start_age - debbie_age))
    }

    fn ltc_cost_for_event(&self, ltc_event_occurs: bool, year_offset: usize) -> f64 {
        if !ltc_event_occurs || !self.ltc_enabled || self.ltc_annual_cost_today <= 0.0 {
            return 0.0;
        }
        let household_age = self.rob_age(year_offset).max(self.debbie_age(year_offset));
        let years_into_ltc = household_age - self.ltc_start_age;
        if years_into_ltc < 0 || years_into_ltc >= self.ltc_duration_years {
            0.0
        } else {
            self.ltc_annual_cost_today * (1.0 + self.ltc_inflation_annual).powi(year_offset as i32)
        }
    }
}

impl HsaStrategy {
    fn from(data: &Value) -> Self {
        Self {
            enabled: data
                .pointer("/rules/hsaStrategy/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            withdrawal_mode: HsaWithdrawalMode::from_str(
                data.pointer("/rules/hsaStrategy/withdrawalMode")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| {
                        if data
                            .pointer("/rules/hsaStrategy/prioritizeHighMagiYears")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            "high_magi_years"
                        } else {
                            "ongoing_qualified_expenses"
                        }
                    }),
            ),
            prioritize_high_magi: data
                .pointer("/rules/hsaStrategy/prioritizeHighMagiYears")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            high_magi_threshold: data
                .pointer("/rules/hsaStrategy/highMagiThreshold")
                .and_then(Value::as_f64)
                .unwrap_or(180_000.0),
            annual_cap: data
                .pointer("/rules/hsaStrategy/annualQualifiedExpenseWithdrawalCap")
                .and_then(Value::as_f64)
                .unwrap_or(f64::INFINITY)
                .max(0.0),
        }
    }

    fn offset_for_year(
        self,
        hsa_balance: f64,
        magi: f64,
        healthcare_cost: f64,
        ltc_cost: f64,
    ) -> f64 {
        let eligible_need = if matches!(self.withdrawal_mode, HsaWithdrawalMode::LtcReserve) {
            ltc_cost.max(0.0)
        } else {
            healthcare_cost.max(0.0) + ltc_cost.max(0.0)
        };
        if !self.enabled || hsa_balance <= 0.0 || eligible_need <= 0.0 {
            return 0.0;
        }
        if (self.prioritize_high_magi
            || matches!(self.withdrawal_mode, HsaWithdrawalMode::HighMagiYears))
            && magi < self.high_magi_threshold
        {
            return 0.0;
        }
        let capped_need = if self.annual_cap.is_finite() {
            eligible_need.min(self.annual_cap)
        } else {
            eligible_need
        };
        hsa_balance.min(capped_need)
    }
}
impl RothConversionPolicy {
    fn from(data: &Value) -> Self {
        Self {
            enabled: data
                .pointer("/rules/rothConversionPolicy/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            min_annual: data
                .pointer("/rules/rothConversionPolicy/minAnnualDollars")
                .and_then(Value::as_f64)
                .unwrap_or(500.0)
                .max(0.0),
            max_annual: data
                .pointer("/rules/rothConversionPolicy/maxAnnualDollars")
                .and_then(Value::as_f64)
                .unwrap_or(f64::INFINITY)
                .max(0.0),
            max_pretax_balance_percent: clamp(
                data.pointer("/rules/rothConversionPolicy/maxPretaxBalancePercent")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.12),
                0.0,
                1.0,
            ),
            magi_buffer: data
                .pointer("/rules/rothConversionPolicy/magiBufferDollars")
                .and_then(Value::as_f64)
                .unwrap_or(2_000.0)
                .max(0.0),
            low_income_bracket_fill_enabled: data
                .pointer("/rules/rothConversionPolicy/lowIncomeBracketFill/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            low_income_bracket_fill_start_year: data
                .pointer("/rules/rothConversionPolicy/lowIncomeBracketFill/startYear")
                .and_then(Value::as_i64),
            low_income_bracket_fill_end_year: data
                .pointer("/rules/rothConversionPolicy/lowIncomeBracketFill/endYear")
                .and_then(Value::as_i64),
            low_income_bracket_fill_annual_target: data
                .pointer("/rules/rothConversionPolicy/lowIncomeBracketFill/annualTargetDollars")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0),
            low_income_bracket_fill_require_no_wage_income: data
                .pointer("/rules/rothConversionPolicy/lowIncomeBracketFill/requireNoWageIncome")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }
    }
}

impl TaxConstants {
    fn from(data: &Value) -> Self {
        let filing_status = data
            .pointer("/household/filingStatus")
            .and_then(Value::as_str)
            .unwrap_or("single");
        let married_filing_jointly = filing_status == "married_filing_jointly";
        let ordinary_brackets = match filing_status {
            "married_filing_jointly" => &[
                (23_200.0, 0.10),
                (94_300.0, 0.12),
                (201_050.0, 0.22),
                (383_900.0, 0.24),
                (487_450.0, 0.32),
                (731_200.0, 0.35),
                (f64::INFINITY, 0.37),
            ][..],
            "head_of_household" => &[
                (16_550.0, 0.10),
                (63_100.0, 0.12),
                (100_500.0, 0.22),
                (191_950.0, 0.24),
                (243_700.0, 0.32),
                (609_350.0, 0.35),
                (f64::INFINITY, 0.37),
            ][..],
            "married_filing_separately" => &[
                (11_600.0, 0.10),
                (47_150.0, 0.12),
                (100_525.0, 0.22),
                (191_950.0, 0.24),
                (243_725.0, 0.32),
                (365_600.0, 0.35),
                (f64::INFINITY, 0.37),
            ][..],
            _ => &[
                (11_600.0, 0.10),
                (47_150.0, 0.12),
                (100_525.0, 0.22),
                (191_950.0, 0.24),
                (243_725.0, 0.32),
                (609_350.0, 0.35),
                (f64::INFINITY, 0.37),
            ][..],
        };
        let (standard_deduction_base, standard_deduction_bump_each) = match filing_status {
            "married_filing_jointly" => (29_200.0, 1_550.0),
            "head_of_household" => (21_900.0, 1_950.0),
            "single" => (14_600.0, 1_950.0),
            _ => (14_600.0, 1_550.0),
        };
        let (social_security_first_base, social_security_second_base, social_security_base_cap) =
            match filing_status {
                "married_filing_jointly" => (32_000.0, 44_000.0, 6_000.0),
                "married_filing_separately" => (0.0, 0.0, 0.0),
                _ => (25_000.0, 34_000.0, 4_500.0),
            };
        let (ltcg_zero_top, ltcg_fifteen_top) = match filing_status {
            "married_filing_jointly" => (94_050.0, 583_750.0),
            "head_of_household" => (63_000.0, 551_350.0),
            "married_filing_separately" => (47_025.0, 291_850.0),
            _ => (47_025.0, 518_900.0),
        };
        Self {
            married_filing_jointly,
            standard_deduction_base,
            standard_deduction_bump_each,
            social_security_first_base,
            social_security_second_base,
            social_security_base_cap,
            ordinary_brackets,
            ltcg_zero_top,
            ltcg_fifteen_top,
            niit_threshold: match filing_status {
                "married_filing_jointly" => 250_000.0,
                "married_filing_separately" => 125_000.0,
                _ => 200_000.0,
            },
            additional_medicare_threshold: match filing_status {
                "married_filing_jointly" => 250_000.0,
                "married_filing_separately" => 125_000.0,
                _ => 200_000.0,
            },
            irmaa_thresholds: match filing_status {
                "married_filing_jointly" => {
                    &[218_000.0, 274_000.0, 342_000.0, 410_000.0, 750_000.0][..]
                }
                "married_filing_separately" => &[109_000.0, 391_000.0][..],
                _ => &[109_000.0, 137_000.0, 171_000.0, 205_000.0, 500_000.0][..],
            },
            irmaa_surcharge_bracket: match filing_status {
                "married_filing_separately" => &[(0.0, 0.0), (446.3, 83.3), (487.0, 91.0)][..],
                _ => &[
                    (0.0, 0.0),
                    (81.2, 14.5),
                    (202.9, 37.5),
                    (324.6, 60.4),
                    (446.3, 83.3),
                    (487.0, 91.0),
                ][..],
            },
            aca_baseline_fpl: if married_filing_jointly {
                21_150.0
            } else {
                15_650.0
            },
        }
    }

    fn standard_deduction(self, rob_age: i64, debbie_age: i64) -> f64 {
        let elderly_count = if self.married_filing_jointly {
            (if rob_age >= 65 { 1 } else { 0 }) + (if debbie_age >= 65 { 1 } else { 0 })
        } else if rob_age >= 65 {
            1
        } else {
            0
        };
        self.standard_deduction_base + self.standard_deduction_bump_each * elderly_count as f64
    }

    fn ltcg_tax(self, ordinary_taxable_income: f64, ltcg_taxable_income: f64) -> f64 {
        let mut remaining = ltcg_taxable_income.max(0.0);
        let zero_room = (self.ltcg_zero_top - ordinary_taxable_income).max(0.0);
        let zero_amount = remaining.min(zero_room);
        remaining -= zero_amount;
        let fifteen_room = (self.ltcg_fifteen_top - ordinary_taxable_income - zero_amount).max(0.0);
        let fifteen_amount = remaining.min(fifteen_room);
        remaining -= fifteen_amount;
        fifteen_amount * 0.15 + remaining * 0.20
    }

    fn net_investment_income_tax(self, magi: f64, net_investment_income: f64) -> f64 {
        if net_investment_income <= 0.0 || magi <= self.niit_threshold {
            0.0
        } else {
            0.038 * net_investment_income.min(magi - self.niit_threshold)
        }
    }

    fn additional_medicare_tax(self, wages: f64) -> f64 {
        0.009 * (wages - self.additional_medicare_threshold).max(0.0)
    }

    fn aca_friendly_magi_ceiling(self, inflation_index: f64) -> f64 {
        (self.aca_baseline_fpl * 4.0 * inflation_index - 2_000.0).max(0.0)
    }

    fn irmaa_tier(self, magi: f64) -> i64 {
        for (index, threshold) in self.irmaa_thresholds.iter().enumerate() {
            if magi.max(0.0) <= *threshold {
                return index as i64 + 1;
            }
        }
        self.irmaa_thresholds.len() as i64 + 1
    }

    fn irmaa_surcharge_annual(self, tier: i64) -> f64 {
        let index = (tier - 1).max(0) as usize;
        let (part_b, part_d) = self
            .irmaa_surcharge_bracket
            .get(index)
            .copied()
            .unwrap_or_else(|| *self.irmaa_surcharge_bracket.last().unwrap_or(&(0.0, 0.0)));
        (part_b + part_d) * 12.0
    }
}

impl ContributionSettings {
    fn year_overrides(value: Option<&Value>) -> Vec<(i64, f64)> {
        value
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(year, value)| {
                        let year = year.parse::<i64>().ok()?;
                        let amount = value.as_f64()?;
                        if amount > 0.0 {
                            Some((year, amount))
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn year_amount(overrides: &[(i64, f64)], year: i64) -> Option<f64> {
        overrides.iter().find_map(|(entry_year, amount)| {
            if *entry_year == year {
                Some(*amount)
            } else {
                None
            }
        })
    }

    fn annual_target(
        settings: Option<&Value>,
        amount_key: &str,
        _amount_by_year_key: &str,
        percent_key: &str,
        fallback_amount_key: Option<&str>,
        _fallback_amount_by_year_key: Option<&str>,
        fallback_percent_key: Option<&str>,
        salary_annual: f64,
    ) -> (f64, bool) {
        let amount = settings
            .and_then(|v| v.get(amount_key))
            .and_then(Value::as_f64)
            .or_else(|| {
                fallback_amount_key
                    .and_then(|key| settings.and_then(|v| v.get(key)).and_then(Value::as_f64))
            });
        if let Some(amount) = amount {
            if amount > 0.0 {
                return (amount, true);
            }
        }
        let percent = settings
            .and_then(|v| v.get(percent_key))
            .and_then(Value::as_f64)
            .or_else(|| {
                fallback_percent_key
                    .and_then(|key| settings.and_then(|v| v.get(key)).and_then(Value::as_f64))
            });
        if let Some(percent) = percent {
            if percent > 0.0 {
                return (salary_annual * percent, false);
            }
        }
        (0.0, false)
    }

    fn from(settings: Option<&Value>, salary_annual: f64) -> Self {
        let pretax_annual_target_by_year = Self::year_overrides(
            settings
                .and_then(|v| v.get("employee401kPreTaxAnnualAmountByYear"))
                .or_else(|| settings.and_then(|v| v.get("employee401kAnnualAmountByYear"))),
        );
        let roth_annual_target_by_year = Self::year_overrides(
            settings.and_then(|v| v.get("employee401kRothAnnualAmountByYear")),
        );
        let hsa_annual_target_by_year =
            Self::year_overrides(settings.and_then(|v| v.get("hsaAnnualAmountByYear")));
        let (pretax_annual_target, pretax_target_is_amount) = Self::annual_target(
            settings,
            "employee401kPreTaxAnnualAmount",
            "employee401kPreTaxAnnualAmountByYear",
            "employee401kPreTaxPercentOfSalary",
            Some("employee401kAnnualAmount"),
            Some("employee401kAnnualAmountByYear"),
            Some("employee401kPercentOfSalary"),
            salary_annual,
        );
        let (roth_annual_target, roth_target_is_amount) = Self::annual_target(
            settings,
            "employee401kRothAnnualAmount",
            "employee401kRothAnnualAmountByYear",
            "employee401kRothPercentOfSalary",
            None,
            None,
            None,
            salary_annual,
        );
        let (hsa_annual_target, hsa_target_is_amount) = Self::annual_target(
            settings,
            "hsaAnnualAmount",
            "hsaAnnualAmountByYear",
            "hsaPercentOfSalary",
            None,
            None,
            None,
            salary_annual,
        );
        Self {
            pretax_annual_target,
            pretax_target_is_amount,
            pretax_annual_target_by_year,
            roth_annual_target,
            roth_target_is_amount,
            roth_annual_target_by_year,
            match_rate: clamp(
                settings
                    .and_then(|v| v.pointer("/employerMatch/matchRate"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                0.0,
                2.0,
            ),
            match_cap_percent: clamp(
                settings
                    .and_then(|v| {
                        v.pointer("/employerMatch/maxEmployeeContributionPercentOfSalary")
                    })
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                0.0,
                1.0,
            ),
            hsa_annual_target,
            hsa_target_is_amount,
            hsa_annual_target_by_year,
            hsa_self_coverage: settings
                .and_then(|v| v.get("hsaCoverageType"))
                .and_then(Value::as_str)
                == Some("self"),
        }
    }
}

impl ContributionLimits {
    fn year_overrides(value: Option<&Value>) -> Vec<(i64, f64)> {
        value
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(year, value)| {
                        let year = year.parse::<i64>().ok()?;
                        let amount = value.as_f64()?;
                        if amount > 0.0 {
                            Some((year, amount))
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn from(data: &Value) -> Self {
        let rules = data.pointer("/rules/contributionLimits");
        Self {
            employee_401k_base_limit: rules
                .and_then(|v| v.get("employee401kBaseLimit"))
                .and_then(Value::as_f64)
                .unwrap_or(24_000.0),
            employee_401k_catch_up_age: rules
                .and_then(|v| v.get("employee401kCatchUpAge"))
                .and_then(Value::as_i64)
                .unwrap_or(50),
            employee_401k_catch_up_limit: rules
                .and_then(|v| v.get("employee401kCatchUpLimit"))
                .and_then(Value::as_f64)
                .unwrap_or(7_500.0),
            employee_401k_base_limit_by_year: Self::year_overrides(
                rules.and_then(|v| v.get("employee401kBaseLimitByYear")),
            ),
            employee_401k_catch_up_limit_by_year: Self::year_overrides(
                rules.and_then(|v| v.get("employee401kCatchUpLimitByYear")),
            ),
            hsa_self_limit: rules
                .and_then(|v| v.get("hsaSelfLimit"))
                .and_then(Value::as_f64)
                .unwrap_or(4_300.0),
            hsa_family_limit: rules
                .and_then(|v| v.get("hsaFamilyLimit"))
                .and_then(Value::as_f64)
                .unwrap_or(8_550.0),
            hsa_catch_up_age: rules
                .and_then(|v| v.get("hsaCatchUpAge"))
                .and_then(Value::as_i64)
                .unwrap_or(55),
            hsa_catch_up_limit: rules
                .and_then(|v| v.get("hsaCatchUpLimit"))
                .and_then(Value::as_f64)
                .unwrap_or(1_000.0),
            hsa_self_limit_by_year: Self::year_overrides(
                rules.and_then(|v| v.get("hsaSelfLimitByYear")),
            ),
            hsa_family_limit_by_year: Self::year_overrides(
                rules.and_then(|v| v.get("hsaFamilyLimitByYear")),
            ),
            hsa_catch_up_limit_by_year: Self::year_overrides(
                rules.and_then(|v| v.get("hsaCatchUpLimitByYear")),
            ),
        }
    }

    fn year_limit(fallback: f64, overrides: &[(i64, f64)], year: i64) -> f64 {
        overrides
            .iter()
            .find_map(|(entry_year, value)| {
                if *entry_year == year {
                    Some(*value)
                } else {
                    None
                }
            })
            .unwrap_or(fallback)
    }

    fn employee_401k_limit(&self, year: i64, age: i64) -> f64 {
        Self::year_limit(
            self.employee_401k_base_limit,
            &self.employee_401k_base_limit_by_year,
            year,
        ) + if age >= self.employee_401k_catch_up_age {
            Self::year_limit(
                self.employee_401k_catch_up_limit,
                &self.employee_401k_catch_up_limit_by_year,
                year,
            )
        } else {
            0.0
        }
    }

    fn hsa_limit(&self, year: i64, age: i64, self_coverage: bool) -> f64 {
        let base = if self_coverage {
            Self::year_limit(self.hsa_self_limit, &self.hsa_self_limit_by_year, year)
        } else {
            Self::year_limit(self.hsa_family_limit, &self.hsa_family_limit_by_year, year)
        };
        base + if age >= self.hsa_catch_up_age {
            Self::year_limit(
                self.hsa_catch_up_limit,
                &self.hsa_catch_up_limit_by_year,
                year,
            )
        } else {
            0.0
        }
    }
}

fn as_f64(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

fn as_i64(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    value.max(minimum).min(maximum)
}

fn to_currency(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn bucket_balance(data: &Value, bucket: &str) -> f64 {
    as_f64(data.pointer(&format!("/accounts/{bucket}/balance")))
}

fn pretax_owner_rmd_shares(data: &Value) -> (f64, f64) {
    let Some(source_accounts) = data
        .pointer("/accounts/pretax/sourceAccounts")
        .and_then(Value::as_array)
    else {
        return (0.5, 0.5);
    };

    let mut rob_total = 0.0;
    let mut debbie_total = 0.0;
    for account in source_accounts {
        let balance = account
            .get("balance")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        let owner = account
            .get("owner")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if owner == "rob" {
            rob_total += balance;
        } else if owner == "debbie" {
            debbie_total += balance;
        }
    }

    let owned_total = rob_total + debbie_total;
    if owned_total > 0.0 {
        (rob_total / owned_total, debbie_total / owned_total)
    } else {
        (0.5, 0.5)
    }
}

fn starting_balances(data: &Value) -> Balances {
    Balances {
        pretax: bucket_balance(data, "pretax") + bucket_balance(data, "hsa"),
        roth: bucket_balance(data, "roth"),
        taxable: bucket_balance(data, "taxable"),
        cash: bucket_balance(data, "cash"),
    }
}

fn spending_parts(data: &Value) -> (f64, f64, f64, f64) {
    (
        as_f64(data.pointer("/spending/essentialMonthly")) * 12.0,
        as_f64(data.pointer("/spending/optionalMonthly")) * 12.0,
        as_f64(data.pointer("/spending/annualTaxesInsurance")),
        as_f64(data.pointer("/spending/travelEarlyRetirementAnnual")),
    )
}

fn annual_spend_schedule_by_year(request: &Value) -> BTreeMap<i64, f64> {
    request
        .get("annualSpendScheduleByYear")
        .and_then(Value::as_object)
        .map(|schedule| {
            schedule
                .iter()
                .filter_map(|(year, value)| {
                    let year = year.parse::<i64>().ok()?;
                    let amount = value.as_f64()?;
                    amount.is_finite().then_some((year, amount.max(0.0)))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn year_from_iso(value: &str) -> i64 {
    value.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn month_from_iso(value: &str) -> i64 {
    value.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(1)
}

fn current_age_at_2026_04_16(birth_date: &str) -> i64 {
    let birth_year = year_from_iso(birth_date);
    let birth_month = month_from_iso(birth_date);
    let birth_day = birth_date
        .get(8..10)
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(1);
    let had_birthday = birth_month < 4 || (birth_month == 4 && birth_day <= 16);
    2026 - birth_year - if had_birthday { 0 } else { 1 }
}

fn calculate_contributions(
    constants: &SimulationConstants,
    balances: &mut Balances,
    hsa_balance: f64,
    rob_age: i64,
    year: i64,
    salary_this_year: f64,
) -> ContributionResult {
    let settings = &constants.contribution_settings;
    let salary_fraction = if constants.salary_annual > 0.0 {
        clamp(salary_this_year / constants.salary_annual, 0.0, 1.0)
    } else {
        0.0
    };

    let annual_401k_limit = constants
        .contribution_limits
        .employee_401k_limit(year, rob_age);
    let requested_target = |annual_target: f64, is_amount: bool, overrides: &[(i64, f64)]| {
        if let Some(amount) = ContributionSettings::year_amount(overrides, year) {
            amount
        } else if is_amount {
            annual_target
        } else {
            annual_target * salary_fraction
        }
    };
    let requested_pretax = clamp(
        requested_target(
            settings.pretax_annual_target,
            settings.pretax_target_is_amount,
            &settings.pretax_annual_target_by_year,
        ),
        0.0,
        salary_this_year,
    );
    let requested_roth = clamp(
        requested_target(
            settings.roth_annual_target,
            settings.roth_target_is_amount,
            &settings.roth_annual_target_by_year,
        ),
        0.0,
        salary_this_year,
    );
    let requested_total = requested_pretax + requested_roth;
    let employee_401k_contribution = clamp(
        requested_total.min(annual_401k_limit).min(salary_this_year),
        0.0,
        f64::INFINITY,
    );
    let mut employee_pretax = requested_pretax;
    let mut employee_roth = requested_roth;
    if requested_total > 0.0 && employee_401k_contribution < requested_total {
        let scale = employee_401k_contribution / requested_total;
        employee_pretax = requested_pretax * scale;
        employee_roth = requested_roth * scale;
    }

    let employer_match = employee_401k_contribution
        .min(salary_this_year * settings.match_cap_percent)
        * settings.match_rate;

    let hsa_limit =
        constants
            .contribution_limits
            .hsa_limit(year, rob_age, settings.hsa_self_coverage);
    let hsa_contribution = clamp(
        requested_target(
            settings.hsa_annual_target,
            settings.hsa_target_is_amount,
            &settings.hsa_annual_target_by_year,
        )
        .min(hsa_limit)
        .min((salary_this_year - employee_pretax).max(0.0)),
        0.0,
        f64::INFINITY,
    );

    let pretax_before = balances.pretax;
    let roth_before = balances.roth;
    let total_pretax = employee_pretax + employer_match + hsa_contribution;
    balances.pretax = to_currency(pretax_before + total_pretax);
    balances.roth = to_currency(roth_before + employee_roth);
    let updated_hsa_balance = to_currency(hsa_balance + hsa_contribution);
    let adjusted_wages = (salary_this_year - employee_pretax - hsa_contribution).max(0.0);

    ContributionResult {
        adjusted_wages: to_currency(adjusted_wages),
        employee_401k_contribution: to_currency(employee_401k_contribution),
        employer_match_contribution: to_currency(employer_match),
        hsa_contribution: to_currency(hsa_contribution),
        roth_contribution_flow: balances.roth - roth_before,
        updated_hsa_balance,
    }
}

fn benefit_factor(claim_age: f64) -> f64 {
    if claim_age < 67.0 {
        (1.0 - (67.0 - claim_age) * 0.06).max(0.7)
    } else if claim_age > 67.0 {
        1.0 + (claim_age - 67.0) * 0.08
    } else {
        1.0
    }
}

fn own_claim_adjustment_factor(fra_age: f64, claim_age: f64) -> f64 {
    if claim_age < fra_age {
        let months_early = ((fra_age - claim_age) * 12.0).max(0.0);
        let tier1 = months_early.min(36.0);
        let tier2 = (months_early - 36.0).max(0.0);
        1.0 - (tier1 * 5.0) / 900.0 - (tier2 * 5.0) / 1200.0
    } else if claim_age > fra_age {
        1.0 + 0.08 * (claim_age.min(70.0) - fra_age)
    } else {
        1.0
    }
}

impl SocialSecuritySchedule {
    fn from(data: &Value, assumptions: &Value) -> Self {
        let mut entries = Vec::new();
        let mut rob_index = None;
        let mut debbie_index = None;
        if let Some(values) = data
            .pointer("/income/socialSecurity")
            .and_then(Value::as_array)
        {
            for value in values {
                let person = value
                    .get("person")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let index = entries.len();
                if person == "rob" {
                    rob_index = Some(index);
                } else if person == "debbie" {
                    debbie_index = Some(index);
                }
                entries.push(SocialSecurityEntry {
                    person,
                    claim_age: value
                        .get("claimAge")
                        .and_then(Value::as_f64)
                        .unwrap_or(67.0),
                    fra_monthly: as_f64(value.get("fraMonthly")),
                });
            }
        }
        Self {
            entries,
            rob_index,
            debbie_index,
            rob_death_age: assumptions.get("robDeathAge").and_then(Value::as_f64),
            debbie_death_age: assumptions.get("debbieDeathAge").and_then(Value::as_f64),
        }
    }

    fn income(&self, rob_age: i64, debbie_age: i64, inflation_index: f64) -> f64 {
        let fra_age = 67.0;
        let Some(rob_entry) = self.rob_index.and_then(|index| self.entries.get(index)) else {
            return self.entries.iter().fold(0.0, |total, entry| {
                let age = if entry.person == "debbie" {
                    debbie_age
                } else {
                    rob_age
                };
                let floor = entry.claim_age.floor() as i64;
                let months = if age > floor {
                    12.0
                } else if age == floor {
                    ((1.0 - (entry.claim_age - floor as f64)) * 12.0)
                        .round()
                        .max(0.0)
                } else {
                    0.0
                };
                total
                    + entry.fra_monthly * months * benefit_factor(entry.claim_age) * inflation_index
            });
        };
        let Some(debbie_entry) = self.debbie_index.and_then(|index| self.entries.get(index)) else {
            let filed = rob_age as f64 >= rob_entry.claim_age;
            return if filed {
                rob_entry.fra_monthly
                    * own_claim_adjustment_factor(fra_age, rob_entry.claim_age)
                    * 12.0
                    * inflation_index
            } else {
                0.0
            };
        };

        let rob_alive = self
            .rob_death_age
            .map(|age| rob_age as f64 <= age)
            .unwrap_or(true);
        let debbie_alive = self
            .debbie_death_age
            .map(|age| debbie_age as f64 <= age)
            .unwrap_or(true);
        let rob_filed = rob_alive && rob_age as f64 >= rob_entry.claim_age;
        let debbie_filed = debbie_alive && debbie_age as f64 >= debbie_entry.claim_age;
        let rob_own = if rob_filed {
            rob_entry.fra_monthly * own_claim_adjustment_factor(fra_age, rob_entry.claim_age)
        } else {
            0.0
        };
        let debbie_own = if debbie_filed {
            debbie_entry.fra_monthly * own_claim_adjustment_factor(fra_age, debbie_entry.claim_age)
        } else {
            0.0
        };
        let mut rob_effective = rob_own;
        let mut debbie_effective = debbie_own;
        if rob_filed && debbie_filed {
            if rob_entry.fra_monthly < debbie_entry.fra_monthly {
                let floor = debbie_entry.fra_monthly * 0.5;
                let adjusted = if rob_entry.claim_age < fra_age {
                    floor * own_claim_adjustment_factor(fra_age, rob_entry.claim_age)
                } else {
                    floor
                };
                rob_effective = rob_effective.max(adjusted);
            } else if debbie_entry.fra_monthly < rob_entry.fra_monthly {
                let floor = rob_entry.fra_monthly * 0.5;
                let adjusted = if debbie_entry.claim_age < fra_age {
                    floor * own_claim_adjustment_factor(fra_age, debbie_entry.claim_age)
                } else {
                    floor
                };
                debbie_effective = debbie_effective.max(adjusted);
            }
        }
        let rob_is_higher = rob_entry.fra_monthly >= debbie_entry.fra_monthly;
        if rob_is_higher && !rob_alive && debbie_alive && debbie_age >= 60 {
            debbie_effective = debbie_effective.max(
                rob_entry.fra_monthly * own_claim_adjustment_factor(fra_age, rob_entry.claim_age),
            );
        } else if !rob_is_higher && !debbie_alive && rob_alive && rob_age >= 60 {
            rob_effective = rob_effective.max(
                debbie_entry.fra_monthly
                    * own_claim_adjustment_factor(fra_age, debbie_entry.claim_age),
            );
        }

        (rob_effective + debbie_effective) * 12.0 * inflation_index
    }
}

fn default_home_sale_exclusion(data: &Value) -> f64 {
    if data
        .pointer("/household/filingStatus")
        .and_then(Value::as_str)
        == Some("married_filing_jointly")
    {
        500_000.0
    } else {
        250_000.0
    }
}

impl WindfallSchedule {
    fn from(data: &Value) -> Self {
        let default_home_sale_exclusion = default_home_sale_exclusion(data);
        let entries = data
            .pointer("/income/windfalls")
            .and_then(Value::as_array)
            .map(|windfalls| {
                windfalls
                    .iter()
                    .map(|item| {
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let treatment = item
                            .get("taxTreatment")
                            .and_then(Value::as_str)
                            .or_else(|| {
                                if name == "home_sale" {
                                    Some("primary_home_sale")
                                } else if name == "inheritance" {
                                    Some("cash_non_taxable")
                                } else {
                                    None
                                }
                            })
                            .unwrap_or("cash_non_taxable")
                            .to_string();
                        WindfallEntry {
                            name,
                            amount: as_f64(item.get("amount")).max(0.0),
                            year: as_i64(item.get("year")),
                            treatment,
                            distribution_years: as_f64(item.get("distributionYears"))
                                .round()
                                .max(1.0) as i64,
                            selling_cost_percent: clamp(
                                as_f64(item.get("sellingCostPercent")),
                                0.0,
                                1.0,
                            ),
                            liquidity_amount: item.get("liquidityAmount").and_then(Value::as_f64),
                            cost_basis: item.get("costBasis").and_then(Value::as_f64),
                            exclusion_amount: item.get("exclusionAmount").and_then(Value::as_f64),
                            replacement_home_cost: item
                                .get("replacementHomeCost")
                                .and_then(Value::as_f64),
                            purchase_closing_cost_percent: item
                                .get("purchaseClosingCostPercent")
                                .and_then(Value::as_f64),
                            moving_cost: item.get("movingCost").and_then(Value::as_f64),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            entries,
            default_home_sale_exclusion,
        }
    }

    fn liquidity_for(entry: &WindfallEntry) -> f64 {
        let is_home_sale = entry.name == "home_sale";
        let modeled_selling_cost = if is_home_sale {
            entry.amount * entry.selling_cost_percent
        } else {
            0.0
        };
        let replacement_home_cost = if is_home_sale {
            entry.replacement_home_cost.unwrap_or(0.0).max(0.0)
        } else {
            0.0
        };
        let purchase_closing_cost = if is_home_sale {
            replacement_home_cost
                * clamp(entry.purchase_closing_cost_percent.unwrap_or(0.0), 0.0, 1.0)
        } else {
            0.0
        };
        let moving_cost = if is_home_sale {
            entry.moving_cost.unwrap_or(0.0).max(0.0)
        } else {
            0.0
        };
        let default_liquidity = (entry.amount
            - modeled_selling_cost
            - replacement_home_cost
            - purchase_closing_cost
            - moving_cost)
            .max(0.0);
        entry.liquidity_amount.unwrap_or(default_liquidity).max(0.0)
    }

    fn cash_for_year(&self, year: i64) -> f64 {
        self.entries.iter().fold(0.0, |total, entry| {
            if entry.amount <= 0.0 {
                return total;
            }
            if entry.treatment == "inherited_ira_10y" {
                if year >= entry.year && year < entry.year + entry.distribution_years {
                    return total + entry.amount / entry.distribution_years as f64;
                }
                return total;
            }
            if entry.year != year {
                return total;
            }
            total + Self::liquidity_for(entry)
        })
    }

    fn taxable_for_year(&self, year: i64) -> (f64, f64) {
        self.entries
            .iter()
            .fold((0.0, 0.0), |(ordinary, ltcg), entry| {
                if entry.amount <= 0.0 {
                    return (ordinary, ltcg);
                }
                if entry.treatment == "inherited_ira_10y" {
                    if year >= entry.year && year < entry.year + entry.distribution_years {
                        let annual = entry.amount / entry.distribution_years as f64;
                        return (ordinary + annual, ltcg);
                    }
                    return (ordinary, ltcg);
                }
                if entry.year != year {
                    return (ordinary, ltcg);
                }
                match entry.treatment.as_str() {
                    "ordinary_income" => (ordinary + entry.amount, ltcg),
                    "ltcg" => {
                        let cost_basis = entry.cost_basis.unwrap_or(entry.amount).max(0.0);
                        (ordinary, ltcg + (entry.amount - cost_basis).max(0.0))
                    }
                    "primary_home_sale" => {
                        let cost_basis = entry.cost_basis.unwrap_or(entry.amount).max(0.0);
                        let exclusion = entry
                            .exclusion_amount
                            .unwrap_or(self.default_home_sale_exclusion)
                            .max(0.0);
                        let gain = (entry.amount - cost_basis).max(0.0);
                        (ordinary, ltcg + (gain - exclusion).max(0.0))
                    }
                    _ => (ordinary, ltcg),
                }
            })
    }

    fn has_named_for_year(&self, year: i64, name: &str) -> bool {
        self.entries.iter().any(|entry| {
            entry.year == year && entry.name == name && Self::liquidity_for(entry) > 0.0
        })
    }
}

impl HousingAfterDownsizePolicy {
    fn from(data: &Value) -> Option<Self> {
        let policy = data.pointer("/rules/housingAfterDownsizePolicy")?;
        if policy.get("mode").and_then(Value::as_str) != Some("own_replacement_home") {
            return None;
        }
        let home_sale = data
            .pointer("/income/windfalls")
            .and_then(Value::as_array)
            .and_then(|windfalls| {
                windfalls
                    .iter()
                    .find(|entry| entry.get("name").and_then(Value::as_str) == Some("home_sale"))
            });
        let start_year = policy
            .get("startYear")
            .and_then(Value::as_i64)
            .or_else(|| home_sale.and_then(|entry| entry.get("year").and_then(Value::as_i64)))?;
        let replacement_home_cost = policy
            .get("replacementHomeCost")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        let current_home_value = home_sale
            .and_then(|entry| entry.get("amount").and_then(Value::as_f64))
            .unwrap_or(0.0)
            .max(0.0);
        Some(Self {
            start_year,
            replacement_home_cost,
            post_sale_annual_taxes_insurance: policy
                .get("postSaleAnnualTaxesInsurance")
                .and_then(Value::as_f64)
                .map(|value| value.max(0.0)),
            current_home_value,
        })
    }
}

fn rmd_start_age_for_birth_year(birth_year: i64) -> i64 {
    if birth_year <= 1950 {
        72
    } else if birth_year <= 1959 {
        73
    } else {
        75
    }
}

fn uniform_lifetime_divisor(age: i64) -> f64 {
    match age.clamp(72, 120) {
        72 => 27.4,
        73 => 26.5,
        74 => 25.5,
        75 => 24.6,
        76 => 23.7,
        77 => 22.9,
        78 => 22.0,
        79 => 21.1,
        80 => 20.2,
        81 => 19.4,
        82 => 18.5,
        83 => 17.7,
        84 => 16.8,
        85 => 16.0,
        86 => 15.2,
        87 => 14.4,
        88 => 13.7,
        89 => 12.9,
        90 => 12.2,
        91 => 11.5,
        92 => 10.8,
        93 => 10.1,
        94 => 9.5,
        95 => 8.9,
        96 => 8.4,
        97 => 7.8,
        98 => 7.3,
        99 => 6.8,
        100 => 6.4,
        101 => 6.0,
        102 => 5.6,
        103 => 5.2,
        104 => 4.9,
        105 => 4.6,
        106 => 4.3,
        107 => 4.1,
        108 => 3.9,
        109 => 3.7,
        110 => 3.5,
        111 => 3.4,
        112 => 3.3,
        113 => 3.1,
        114 => 3.0,
        115 => 2.9,
        116 => 2.8,
        117 => 2.7,
        118 => 2.5,
        119 => 2.3,
        _ => 2.0,
    }
}

fn calculate_ordinary_tax(taxable_income: f64, brackets: &[(f64, f64)]) -> f64 {
    time_module(ModuleTimer::OrdinaryTax, || {
        let taxable_income = taxable_income.max(0.0);
        let mut previous_top = 0.0;
        let mut tax = 0.0;
        for (up_to, rate) in brackets {
            if taxable_income <= *up_to {
                let taxable_in_bracket = (taxable_income - previous_top).max(0.0);
                if taxable_in_bracket > 0.0 {
                    tax += taxable_in_bracket * rate;
                }
                return tax;
            }
            tax += (*up_to - previous_top) * rate;
            previous_top = *up_to;
        }
        tax
    })
}

fn interpolate_aca_rate(fpl_ratio: f64) -> f64 {
    let bands = [
        (0.0, 1.33, 0.021, 0.021),
        (1.33, 1.5, 0.0314, 0.0419),
        (1.5, 2.0, 0.0419, 0.066),
        (2.0, 2.5, 0.066, 0.0844),
        (2.5, 3.0, 0.0844, 0.0996),
        (3.0, 4.0, 0.0996, 0.0996),
    ];
    for (min_fpl, max_fpl, min_rate, max_rate) in bands {
        if fpl_ratio >= min_fpl && fpl_ratio < max_fpl {
            let width = max_fpl - min_fpl;
            if !width.is_finite() || width <= 0.0 {
                return clamp(max_rate, 0.0, 1.0);
            }
            let relative = clamp((fpl_ratio - min_fpl) / width, 0.0, 1.0);
            return clamp(min_rate + (max_rate - min_rate) * relative, 0.0, 1.0);
        }
    }
    clamp(0.0996, 0.0, 1.0)
}

struct HealthcarePremiumContext {
    medicare_count: i64,
    non_medicare_count: i64,
    retirement_status: bool,
    baseline_aca: f64,
    baseline_medicare: f64,
    fpl: f64,
}

impl HealthcarePremiumContext {
    fn from(
        constants: &SimulationConstants,
        year: i64,
        year_offset: usize,
        medical_index: f64,
    ) -> Self {
        let medicare_count = constants.medicare_eligible_count(year_offset);
        let household_size = 2.0;
        Self {
            medicare_count,
            non_medicare_count: 2 - medicare_count,
            retirement_status: year >= constants.retirement_year,
            baseline_aca: constants.baseline_aca_premium_annual * medical_index,
            baseline_medicare: constants.baseline_medicare_premium_annual * medical_index,
            fpl: 21_150.0 + (household_size - 2.0_f64).max(0.0) * 5_500.0,
        }
    }
}

fn compute_healthcare_premium_cost(
    constants: &SimulationConstants,
    healthcare_context: &HealthcarePremiumContext,
    magi: f64,
    irmaa_tier_for_year: i64,
) -> f64 {
    time_module(ModuleTimer::HealthcarePremium, || {
        let medicare_count = healthcare_context.medicare_count;
        let non_medicare_count = healthcare_context.non_medicare_count;
        if !healthcare_context.retirement_status && medicare_count == 0 {
            return 0.0;
        }
        let aca_premium = if healthcare_context.retirement_status {
            healthcare_context.baseline_aca * non_medicare_count as f64
        } else {
            0.0
        };
        let medicare_premium = healthcare_context.baseline_medicare * medicare_count as f64;
        let aca_subsidy = if healthcare_context.retirement_status && non_medicare_count > 0 {
            let fpl_ratio = if healthcare_context.fpl > 0.0 {
                magi.max(0.0) / healthcare_context.fpl
            } else {
                f64::INFINITY
            };
            if fpl_ratio <= 4.0 {
                let expected_aca_contribution = interpolate_aca_rate(fpl_ratio) * magi.max(0.0);
                clamp(aca_premium - expected_aca_contribution, 0.0, aca_premium)
            } else {
                0.0
            }
        } else {
            0.0
        };
        let net_aca = (aca_premium - aca_subsidy).max(0.0);
        let irmaa = constants
            .tax_constants
            .irmaa_surcharge_annual(irmaa_tier_for_year)
            * medicare_count as f64;
        to_currency(net_aca) + to_currency(medicare_premium) + to_currency(irmaa)
    })
}

fn federal_tax_exact(input: &TaxInput) -> TaxOutput {
    #[cfg(feature = "tax-counters")]
    record_tax_counter(|counters| counters.federal_tax_exact += 1);

    time_module(ModuleTimer::FederalTaxExact, || {
        let tax_constants = input.tax_constants;
        let ordinary_income_excluding_ss = input.wages.max(0.0)
            + input.ira_withdrawals.max(0.0)
            + input.taxable_interest.max(0.0)
            + input.ordinary_dividends.max(0.0)
            + input.realized_stcg.max(0.0)
            + input.other_ordinary_income.max(0.0);
        let preferential_income = input.qualified_dividends.max(0.0) + input.realized_ltcg.max(0.0);
        let provisional_income = ordinary_income_excluding_ss
            + preferential_income
            + input.tax_exempt_interest.max(0.0)
            + input.social_security.max(0.0) * 0.5;
        let first_base = tax_constants.social_security_first_base;
        let second_base = tax_constants.social_security_second_base;
        let cap = tax_constants.social_security_base_cap;
        let taxable_ss = if input.social_security <= 0.0 || provisional_income <= first_base {
            0.0
        } else if provisional_income <= second_base {
            (input.social_security * 0.5).min((provisional_income - first_base) * 0.5)
        } else {
            let base_half = (input.social_security * 0.5).min(cap);
            (input.social_security * 0.85)
                .min((provisional_income - second_base) * 0.85 + base_half)
        };
        let agi = ordinary_income_excluding_ss + taxable_ss + preferential_income;
        let magi = agi + input.tax_exempt_interest.max(0.0);
        let total_taxable_income = (agi - input.standard_deduction).max(0.0);
        let ltcg_taxable_income = preferential_income.min(total_taxable_income);
        let ordinary_taxable_income = (total_taxable_income - ltcg_taxable_income).max(0.0);
        let ordinary_tax =
            calculate_ordinary_tax(ordinary_taxable_income, tax_constants.ordinary_brackets);
        let ltcg_tax = tax_constants.ltcg_tax(ordinary_taxable_income, ltcg_taxable_income);
        let niit = tax_constants.net_investment_income_tax(
            magi,
            input.taxable_interest.max(0.0)
                + input.qualified_dividends.max(0.0)
                + input.ordinary_dividends.max(0.0)
                + input.realized_ltcg.max(0.0)
                + input.realized_stcg.max(0.0),
        );
        TaxOutput {
            federal_tax: ordinary_tax + ltcg_tax + niit + input.additional_medicare_tax,
            magi,
        }
    })
}

struct TaxInput {
    tax_constants: TaxConstants,
    wages: f64,
    social_security: f64,
    ira_withdrawals: f64,
    taxable_interest: f64,
    qualified_dividends: f64,
    ordinary_dividends: f64,
    realized_ltcg: f64,
    realized_stcg: f64,
    other_ordinary_income: f64,
    tax_exempt_interest: f64,
    standard_deduction: f64,
    additional_medicare_tax: f64,
}

#[derive(Clone, Copy)]
struct WithdrawalAmounts {
    cash: f64,
    taxable: f64,
    pretax: f64,
    roth: f64,
}

#[derive(Clone, Copy)]
struct WithdrawalAttempt {
    balances: Balances,
    withdrawals: WithdrawalAmounts,
    remaining: f64,
    rmd_surplus_to_cash: f64,
    tax: TaxOutput,
}

struct WithdrawalContext {
    tax_constants: TaxConstants,
    roth_conversion_policy: RothConversionPolicy,
    starting_balances: Balances,
    needed: f64,
    rmd_amount: f64,
    wages: f64,
    social_security: f64,
    windfall_ordinary_income: f64,
    windfall_ltcg_income: f64,
    standard_deduction: f64,
    additional_medicare_tax: f64,
}

struct WithdrawalStrategy<'a> {
    planner_logic_active: bool,
    withdrawal_rule: &'a str,
    market_state: &'a str,
    aca_friendly_magi_ceiling: Option<f64>,
    irmaa_aware_withdrawal_buffer: bool,
    preserve_roth_preference: bool,
    irmaa_threshold: f64,
    taxable_first_when_down: bool,
}

fn defense_score(data: &Value, bucket: &str) -> f64 {
    let Some(allocation) = data
        .pointer(&format!("/accounts/{bucket}/targetAllocation"))
        .and_then(Value::as_object)
    else {
        return 0.0;
    };
    allocation.iter().fold(0.0, |total, (symbol, weight)| {
        let weight = weight.as_f64().unwrap_or(0.0);
        let (_, _, bonds_w, cash_w) = symbol_exposure(symbol.as_str());
        total + weight * (bonds_w + cash_w)
    })
}

fn balance_for_bucket(balances: &Balances, bucket: &str) -> f64 {
    match bucket {
        "cash" => balances.cash,
        "taxable" => balances.taxable,
        "pretax" => balances.pretax,
        "roth" => balances.roth,
        _ => 0.0,
    }
}

fn take_from_bucket(balances: &mut Balances, bucket: &str, need: &mut f64, cap: f64) -> f64 {
    if *need <= 0.0 || cap <= 0.0 {
        return 0.0;
    }
    match bucket {
        "cash" => {
            let take = balances.cash.max(0.0).min(*need).min(cap);
            balances.cash -= take;
            *need -= take;
            take
        }
        "taxable" => {
            let take = balances.taxable.max(0.0).min(*need).min(cap);
            balances.taxable -= take;
            *need -= take;
            take
        }
        "pretax" => {
            let take = balances.pretax.max(0.0).min(*need).min(cap);
            balances.pretax -= take;
            *need -= take;
            take
        }
        "roth" => {
            let take = balances.roth.max(0.0).min(*need).min(cap);
            balances.roth -= take;
            *need -= take;
            take
        }
        _ => 0.0,
    }
}

fn add_withdrawal(withdrawals: &mut WithdrawalAmounts, bucket: &str, amount: f64) {
    match bucket {
        "cash" => withdrawals.cash += amount,
        "taxable" => withdrawals.taxable += amount,
        "pretax" => withdrawals.pretax += amount,
        "roth" => withdrawals.roth += amount,
        _ => {}
    }
}

fn tax_for_withdrawals(input: &WithdrawalContext, withdrawals: &WithdrawalAmounts) -> TaxOutput {
    #[cfg(feature = "tax-counters")]
    record_tax_counter(|counters| counters.tax_for_withdrawals += 1);

    federal_tax_exact(&TaxInput {
        tax_constants: input.tax_constants,
        wages: input.wages,
        social_security: input.social_security,
        ira_withdrawals: withdrawals.pretax,
        taxable_interest: 0.0,
        qualified_dividends: 0.0,
        ordinary_dividends: 0.0,
        realized_ltcg: input.windfall_ltcg_income + withdrawals.taxable * 0.25,
        realized_stcg: 0.0,
        other_ordinary_income: input.windfall_ordinary_income,
        tax_exempt_interest: 0.0,
        standard_deduction: input.standard_deduction,
        additional_medicare_tax: input.additional_medicare_tax,
    })
}

#[cfg(feature = "tax-counters")]
fn tax_for_conversion(
    input: &WithdrawalContext,
    withdrawals: &WithdrawalAmounts,
    conversion_amount: f64,
) -> TaxOutput {
    #[cfg(feature = "tax-counters")]
    record_tax_counter(|counters| counters.tax_for_conversion += 1);

    federal_tax_exact(&TaxInput {
        tax_constants: input.tax_constants,
        wages: input.wages,
        social_security: input.social_security,
        ira_withdrawals: withdrawals.pretax + conversion_amount,
        taxable_interest: 0.0,
        qualified_dividends: 0.0,
        ordinary_dividends: 0.0,
        realized_ltcg: input.windfall_ltcg_income + withdrawals.taxable * 0.25,
        realized_stcg: 0.0,
        other_ordinary_income: input.windfall_ordinary_income,
        tax_exempt_interest: 0.0,
        standard_deduction: input.standard_deduction,
        additional_medicare_tax: input.additional_medicare_tax,
    })
}

#[derive(Clone, Copy)]
struct ConversionTaxContext {
    tax_constants: TaxConstants,
    ordinary_income_base: f64,
    preferential_income: f64,
    provisional_income_base: f64,
    social_security: f64,
    tax_exempt_interest: f64,
    standard_deduction: f64,
    additional_medicare_tax: f64,
    net_investment_income: f64,
}

impl ConversionTaxContext {
    fn from(input: &WithdrawalContext, withdrawals: &WithdrawalAmounts) -> Self {
        let ira_withdrawals_base = withdrawals.pretax.max(0.0);
        let realized_ltcg = input.windfall_ltcg_income + withdrawals.taxable * 0.25;
        let preferential_income = realized_ltcg.max(0.0);
        let tax_exempt_interest = 0.0_f64;
        let social_security = input.social_security;
        let ordinary_income_base =
            input.wages.max(0.0) + ira_withdrawals_base + input.windfall_ordinary_income.max(0.0);
        Self {
            tax_constants: input.tax_constants,
            ordinary_income_base,
            preferential_income,
            provisional_income_base: ordinary_income_base
                + preferential_income
                + tax_exempt_interest
                + social_security.max(0.0) * 0.5,
            social_security,
            tax_exempt_interest,
            standard_deduction: input.standard_deduction,
            additional_medicare_tax: input.additional_medicare_tax,
            net_investment_income: preferential_income,
        }
    }

    fn tax_for_conversion(self, conversion_amount: f64) -> TaxOutput {
        let tax_constants = self.tax_constants;
        let ordinary_income_excluding_ss = self.ordinary_income_base + conversion_amount.max(0.0);
        let provisional_income = self.provisional_income_base + conversion_amount.max(0.0);
        let first_base = tax_constants.social_security_first_base;
        let second_base = tax_constants.social_security_second_base;
        let cap = tax_constants.social_security_base_cap;
        let taxable_ss = if self.social_security <= 0.0 || provisional_income <= first_base {
            0.0
        } else if provisional_income <= second_base {
            (self.social_security * 0.5).min((provisional_income - first_base) * 0.5)
        } else {
            let base_half = (self.social_security * 0.5).min(cap);
            (self.social_security * 0.85).min((provisional_income - second_base) * 0.85 + base_half)
        };
        let agi = ordinary_income_excluding_ss + taxable_ss + self.preferential_income;
        let magi = agi + self.tax_exempt_interest.max(0.0);
        let total_taxable_income = (agi - self.standard_deduction).max(0.0);
        let ltcg_taxable_income = self.preferential_income.min(total_taxable_income);
        let ordinary_taxable_income = (total_taxable_income - ltcg_taxable_income).max(0.0);
        let ordinary_tax =
            calculate_ordinary_tax(ordinary_taxable_income, tax_constants.ordinary_brackets);
        let ltcg_tax = tax_constants.ltcg_tax(ordinary_taxable_income, ltcg_taxable_income);
        let niit = tax_constants.net_investment_income_tax(magi, self.net_investment_income);
        TaxOutput {
            federal_tax: ordinary_tax + ltcg_tax + niit + self.additional_medicare_tax,
            magi,
        }
    }
}

fn proactive_roth_conversion(
    year: i64,
    input: &WithdrawalContext,
    strategy: &WithdrawalStrategy<'_>,
    balances: &Balances,
    withdrawals: &WithdrawalAmounts,
    tax_before: TaxOutput,
    required_rmd_amount: f64,
    years_until_rmd: i64,
    is_retired: bool,
) -> (f64, TaxOutput) {
    #[cfg(feature = "tax-counters")]
    record_tax_counter(|counters| counters.proactive_roth_conversion += 1);

    if !strategy.planner_logic_active
        || !is_retired
        || !input.roth_conversion_policy.enabled
        || balances.pretax <= 0.0
    {
        return (0.0, tax_before);
    }
    #[cfg(feature = "tax-counters")]
    record_tax_counter(|counters| counters.proactive_roth_eligible += 1);

    let irmaa_threshold = strategy.irmaa_threshold;
    let magi_buffer = input.roth_conversion_policy.magi_buffer;
    let target_magi_ceiling = (irmaa_threshold - magi_buffer).max(0.0);
    let magi_before = tax_before.magi;
    let federal_tax_before = tax_before.federal_tax;
    let already_above_irmaa_threshold = magi_before > irmaa_threshold;
    let bracket_fill_window_active = input.roth_conversion_policy.low_income_bracket_fill_enabled
        && input
            .roth_conversion_policy
            .low_income_bracket_fill_annual_target
            > 0.0
        && input
            .roth_conversion_policy
            .low_income_bracket_fill_start_year
            .map_or(true, |start_year| year >= start_year)
        && input
            .roth_conversion_policy
            .low_income_bracket_fill_end_year
            .map_or(true, |end_year| year <= end_year)
        && (!input
            .roth_conversion_policy
            .low_income_bracket_fill_require_no_wage_income
            || input.wages <= 1.0);
    let mut effective_balance_cap =
        balances.pretax.max(0.0) * input.roth_conversion_policy.max_pretax_balance_percent;
    if bracket_fill_window_active {
        effective_balance_cap = effective_balance_cap.max(
            input
                .roth_conversion_policy
                .low_income_bracket_fill_annual_target,
        );
    }
    if years_until_rmd <= 8 {
        let target_depletion_years = (years_until_rmd + 3).max(2) as f64;
        let smooth_depletion_cap = balances.pretax.max(0.0) / target_depletion_years;
        if !already_above_irmaa_threshold || years_until_rmd <= 3 {
            effective_balance_cap = effective_balance_cap.max(smooth_depletion_cap);
        }
    }
    effective_balance_cap = effective_balance_cap.min(balances.pretax.max(0.0));
    let total_conversion_budget = effective_balance_cap
        .min(input.roth_conversion_policy.max_annual)
        .min(balances.pretax.max(0.0));
    let available_headroom = (irmaa_threshold - magi_before - magi_buffer)
        .max(0.0)
        .min(total_conversion_budget);
    if available_headroom <= 0.0 {
        #[cfg(feature = "tax-counters")]
        record_tax_counter(|counters| counters.proactive_roth_no_headroom += 1);
        return (0.0, tax_before);
    }

    let pretax_balance = balances.pretax.max(0.0);
    let roth_balance = balances.roth.max(0.0);
    let total_tax_advantaged_balance = (pretax_balance + roth_balance).max(1.0);
    let rmd_proximity = clamp((10.0 - years_until_rmd.max(0) as f64) / 10.0, 0.0, 1.0);
    let projected_rmd_pressure = if required_rmd_amount > 0.0 {
        required_rmd_amount
    } else {
        pretax_balance / (years_until_rmd.max(0) as f64 + 14.0).max(14.0)
    };
    let projected_future_magi =
        magi_before.max(0.0) + projected_rmd_pressure + (pretax_balance * 0.01).max(0.0);
    let roth_share_before = roth_balance / total_tax_advantaged_balance;
    let conversion_tax_context = ConversionTaxContext::from(input, withdrawals);

    let mut best_amount = 0.0;
    let mut best_tax = tax_before;
    let mut best_score = 0.0;
    let mut best_projected_irmaa_exposure = 0.0;
    let mut saw_candidate = false;
    #[cfg(feature = "tax-counters")]
    let mut evaluated_candidate_count = 0u64;
    #[cfg(feature = "tax-counters")]
    let mut best_candidate_index = 0u64;
    #[cfg(feature = "tax-counters")]
    let mut largest_survivor_score = 0.0;
    #[cfg(feature = "tax-counters")]
    let mut largest_survivor_tax = tax_before;
    #[cfg(feature = "tax-counters")]
    let mut previous_survivor_score: Option<f64> = None;
    #[cfg(feature = "tax-counters")]
    let mut scores_monotonic = true;

    let mut candidate_amounts = [
        available_headroom * 0.25,
        available_headroom * 0.5,
        available_headroom * 0.75,
        available_headroom,
        0.0,
    ];
    let mut candidate_count = 4usize;
    if bracket_fill_window_active {
        candidate_amounts[candidate_count] = input
            .roth_conversion_policy
            .low_income_bracket_fill_annual_target;
        candidate_count += 1;
    }
    for index in 1..candidate_count {
        let value = candidate_amounts[index];
        let mut scan = index;
        while scan > 0
            && cmp_f64_for_summary(&candidate_amounts[scan - 1], &value)
                == std::cmp::Ordering::Greater
        {
            candidate_amounts[scan] = candidate_amounts[scan - 1];
            scan -= 1;
        }
        candidate_amounts[scan] = value;
    }
    let mut previous_candidate = 0.0;
    for raw_amount in candidate_amounts.into_iter().take(candidate_count) {
        let mut amount = raw_amount;
        amount = amount
            .min(total_conversion_budget)
            .min(balances.pretax.max(0.0));
        amount = (amount * 100.0).round() / 100.0;
        if amount <= 0.0 || amount == previous_candidate {
            continue;
        }
        previous_candidate = amount;
        if amount < input.roth_conversion_policy.min_annual {
            continue;
        }
        #[cfg(feature = "tax-counters")]
        {
            record_tax_counter(|counters| counters.proactive_roth_candidate += 1);
            evaluated_candidate_count += 1;
        }

        let tax_after = conversion_tax_context.tax_for_conversion(amount);
        #[cfg(feature = "tax-counters")]
        record_roth_fast_tax_shadow(tax_for_conversion(input, withdrawals, amount), tax_after);
        if !already_above_irmaa_threshold && tax_after.magi > target_magi_ceiling + 0.01 {
            #[cfg(feature = "tax-counters")]
            record_tax_counter(|counters| counters.proactive_roth_ceiling_reject += 1);
            continue;
        }
        #[cfg(feature = "tax-counters")]
        record_tax_counter(|counters| counters.proactive_roth_survivor += 1);
        let current_tax_cost = (tax_after.federal_tax - federal_tax_before).max(0.0);
        let current_tax_rate = if amount > 0.0 {
            current_tax_cost / amount
        } else {
            0.0
        };
        let expected_future_tax_rate_lift =
            (projected_rmd_pressure / pretax_balance.max(1.0)).min(0.12) + rmd_proximity * 0.04;
        let expected_future_tax_rate = current_tax_rate
            .max(current_tax_rate + expected_future_tax_rate_lift)
            .min(0.45);
        let future_tax_reduction =
            ((expected_future_tax_rate - current_tax_rate) * amount * 0.85).max(0.0);
        let irmaa_avoidance_value = if projected_future_magi > irmaa_threshold {
            0.15 * amount
        } else {
            0.0
        };
        let rmd_reduction_value = 0.12 * amount;
        let roth_optionality_value = 0.05 * amount;
        let conversion_score = future_tax_reduction
            + irmaa_avoidance_value
            + rmd_reduction_value
            + roth_optionality_value
            - current_tax_cost;
        let projected_peak_magi_reduction = amount * (0.04 + rmd_proximity * 0.12);
        let projected_future_magi_peak =
            (projected_future_magi - projected_peak_magi_reduction).max(0.0);
        let projected_irmaa_exposure = (projected_future_magi_peak - irmaa_threshold).max(0.0);
        saw_candidate = true;
        #[cfg(feature = "tax-counters")]
        {
            if let Some(previous_score) = previous_survivor_score {
                if conversion_score + 0.01 < previous_score {
                    scores_monotonic = false;
                }
            }
            previous_survivor_score = Some(conversion_score);
            largest_survivor_score = conversion_score;
            largest_survivor_tax = tax_after;
        }
        if best_amount == 0.0 || conversion_score > best_score {
            best_amount = amount;
            best_tax = tax_after;
            best_score = conversion_score;
            best_projected_irmaa_exposure = projected_irmaa_exposure;
            #[cfg(feature = "tax-counters")]
            {
                best_candidate_index = evaluated_candidate_count;
            }
        }
    }
    #[cfg(feature = "tax-counters")]
    record_roth_eval_count(evaluated_candidate_count);

    let already_optimal = pretax_balance <= 25_000.0
        && best_projected_irmaa_exposure <= 1.0
        && rmd_proximity < 0.1
        && roth_share_before >= 0.65;
    if already_optimal {
        #[cfg(feature = "tax-counters")]
        record_tax_counter(|counters| counters.proactive_roth_already_optimal += 1);
        (0.0, tax_before)
    } else if !saw_candidate {
        #[cfg(feature = "tax-counters")]
        record_tax_counter(|counters| counters.proactive_roth_no_survivor += 1);
        (0.0, tax_before)
    } else if best_score <= 0.0 {
        #[cfg(feature = "tax-counters")]
        record_tax_counter(|counters| counters.proactive_roth_negative_score += 1);
        (0.0, tax_before)
    } else {
        #[cfg(feature = "tax-counters")]
        {
            record_tax_counter(|counters| counters.proactive_roth_conversion_kept += 1);
            record_roth_best_candidate(best_candidate_index);
            record_roth_largest_shadow(
                largest_survivor_score,
                largest_survivor_tax,
                best_score,
                best_tax,
                scores_monotonic,
            );
        }
        (best_amount, best_tax)
    }
}

fn withdrawal_order(strategy: &WithdrawalStrategy<'_>) -> [&'static str; 4] {
    if strategy.withdrawal_rule == "reverse_waterfall" {
        return ["cash", "roth", "pretax", "taxable"];
    }
    if strategy.withdrawal_rule == "proportional" || !strategy.planner_logic_active {
        return ["cash", "taxable", "pretax", "roth"];
    }
    let taxable_first = strategy.market_state != "down" || strategy.taxable_first_when_down;
    if taxable_first {
        ["cash", "taxable", "pretax", "roth"]
    } else {
        ["cash", "pretax", "taxable", "roth"]
    }
}

fn withdrawal_attempt(
    input: &WithdrawalContext,
    strategy: &WithdrawalStrategy<'_>,
) -> WithdrawalAttempt {
    #[cfg(feature = "tax-counters")]
    record_tax_counter(|counters| counters.withdrawal_attempt += 1);

    time_module(ModuleTimer::WithdrawalAttempt, || {
        let mut balances = input.starting_balances;
        let mut withdrawals = WithdrawalAmounts {
            cash: 0.0,
            taxable: 0.0,
            pretax: 0.0,
            roth: 0.0,
        };
        let mut remaining = input.needed.max(0.0);
        let mut rmd_surplus_to_cash = 0.0;
        let required_take = input.rmd_amount.max(0.0).min(balances.pretax.max(0.0));
        if required_take > 0.0 {
            balances.pretax -= required_take;
            withdrawals.pretax += required_take;
            let applied_to_need = remaining.min(required_take);
            remaining -= applied_to_need;
            rmd_surplus_to_cash = (required_take - applied_to_need).max(0.0);
            if rmd_surplus_to_cash > 0.0 {
                balances.cash += rmd_surplus_to_cash;
            }
        }

        let tax = if strategy.withdrawal_rule == "proportional" && remaining > 0.0 {
            let buckets = ["cash", "taxable", "pretax", "roth"];
            let mut need_left = remaining;
            for _ in 0..4 {
                if need_left <= 0.0 {
                    break;
                }
                let live_balance = buckets
                    .iter()
                    .map(|bucket| balance_for_bucket(&balances, bucket).max(0.0))
                    .sum::<f64>();
                if live_balance <= 0.0 {
                    break;
                }
                let pass_need = need_left;
                for bucket in buckets {
                    if need_left <= 0.0 {
                        break;
                    }
                    let balance = balance_for_bucket(&balances, bucket);
                    if balance <= 0.0 {
                        continue;
                    }
                    let share = (balance / live_balance) * pass_need;
                    let take = take_from_bucket(&mut balances, bucket, &mut need_left, share);
                    if take > 0.0 {
                        add_withdrawal(&mut withdrawals, bucket, take);
                    }
                }
            }
            remaining = need_left;
            tax_for_withdrawals(input, &withdrawals)
        } else {
            let mut tax = tax_for_withdrawals(input, &withdrawals);
            for bucket in withdrawal_order(strategy) {
                if remaining <= 0.0 {
                    break;
                }
                let mut available = balance_for_bucket(&balances, bucket);
                if available <= 0.0 {
                    continue;
                }
                if bucket == "pretax" {
                    if let Some(aca_ceiling) = strategy.aca_friendly_magi_ceiling {
                        available = available.min((aca_ceiling - tax.magi).max(0.0));
                    }
                    if strategy.irmaa_aware_withdrawal_buffer {
                        available = available.min((strategy.irmaa_threshold - tax.magi).max(0.0));
                    }
                    if available <= 0.0
                        && strategy.preserve_roth_preference
                        && balances.roth > 0.0
                        && remaining > 0.0
                    {
                        let roth_take =
                            take_from_bucket(&mut balances, "roth", &mut remaining, f64::INFINITY);
                        add_withdrawal(&mut withdrawals, "roth", roth_take);
                    }
                }
                if available <= 0.0 || remaining <= 0.0 {
                    continue;
                }
                let take = take_from_bucket(&mut balances, bucket, &mut remaining, available);
                if take <= 0.0 {
                    continue;
                }
                add_withdrawal(&mut withdrawals, bucket, take);
                if bucket == "pretax" || bucket == "taxable" {
                    tax = tax_for_withdrawals(input, &withdrawals);
                }
            }
            tax
        };

        WithdrawalAttempt {
            balances,
            withdrawals,
            remaining,
            rmd_surplus_to_cash,
            tax,
        }
    })
}

fn symbol_exposure(symbol: &str) -> (f64, f64, f64, f64) {
    match symbol {
        "CASH" => (0.0, 0.0, 0.0, 1.0),
        "BND" | "MUB" | "FSRIX" => (0.0, 0.0, 1.0, 0.0),
        "VXUS" | "IEFA" | "IEMG" => (0.0, 1.0, 0.0, 0.0),
        "TRP_2030" => (0.42, 0.18, 0.37, 0.03),
        "CENTRAL_MANAGED" => (0.45, 0.12, 0.35, 0.08),
        _ => (1.0, 0.0, 0.0, 0.0),
    }
}

#[derive(Clone, Copy)]
struct AssetExposure {
    us_equity: f64,
    intl_equity: f64,
    bonds: f64,
    cash: f64,
}

impl AssetExposure {
    fn normalized(self) -> Self {
        let total = (self.us_equity + self.intl_equity + self.bonds + self.cash).max(0.0);
        if total <= 0.0 {
            return Self {
                us_equity: 1.0,
                intl_equity: 0.0,
                bonds: 0.0,
                cash: 0.0,
            };
        }
        Self {
            us_equity: self.us_equity.max(0.0) / total,
            intl_equity: self.intl_equity.max(0.0) / total,
            bonds: self.bonds.max(0.0) / total,
            cash: self.cash.max(0.0) / total,
        }
    }

    fn apply(self, asset_returns: AssetReturns) -> f64 {
        self.us_equity * asset_returns.us_equity
            + self.intl_equity * asset_returns.intl_equity
            + self.bonds * asset_returns.bonds
            + self.cash * asset_returns.cash
    }
}

fn bucket_exposure_from_data(data: &Value, bucket: &str) -> AssetExposure {
    let Some(allocation) = data
        .pointer(&format!("/accounts/{bucket}/targetAllocation"))
        .and_then(Value::as_object)
    else {
        return AssetExposure {
            us_equity: 1.0,
            intl_equity: 0.0,
            bonds: 0.0,
            cash: 0.0,
        };
    };
    allocation
        .iter()
        .fold(
            AssetExposure {
                us_equity: 0.0,
                intl_equity: 0.0,
                bonds: 0.0,
                cash: 0.0,
            },
            |mut total, (symbol, weight)| {
                let weight = weight.as_f64().unwrap_or(0.0).max(0.0);
                let (us_w, intl_w, bonds_w, cash_w) = symbol_exposure(symbol.as_str());
                total.us_equity += us_w * weight;
                total.intl_equity += intl_w * weight;
                total.bonds += bonds_w * weight;
                total.cash += cash_w * weight;
                total
            },
        )
        .normalized()
}

fn current_invested_exposure(
    data: &Value,
    balances: Balances,
    taxable_exposure: AssetExposure,
) -> AssetExposure {
    let buckets = [
        (
            "pretax",
            balances.pretax,
            bucket_exposure_from_data(data, "pretax"),
        ),
        (
            "roth",
            balances.roth,
            bucket_exposure_from_data(data, "roth"),
        ),
        ("taxable", balances.taxable, taxable_exposure),
    ];
    let mut weighted = AssetExposure {
        us_equity: 0.0,
        intl_equity: 0.0,
        bonds: 0.0,
        cash: 0.0,
    };
    let mut total_balance = 0.0;
    for (_, balance, exposure) in buckets {
        let balance = balance.max(0.0);
        if balance <= 0.0 {
            continue;
        }
        weighted.us_equity += exposure.us_equity * balance;
        weighted.intl_equity += exposure.intl_equity * balance;
        weighted.bonds += exposure.bonds * balance;
        weighted.cash += exposure.cash * balance;
        total_balance += balance;
    }
    if total_balance <= 0.0 {
        return taxable_exposure.normalized();
    }
    AssetExposure {
        us_equity: weighted.us_equity / total_balance,
        intl_equity: weighted.intl_equity / total_balance,
        bonds: weighted.bonds / total_balance,
        cash: weighted.cash / total_balance,
    }
    .normalized()
}

fn blend_exposure(
    existing: AssetExposure,
    existing_balance: f64,
    added: AssetExposure,
    added_balance: f64,
) -> AssetExposure {
    let existing_balance = existing_balance.max(0.0);
    let added_balance = added_balance.max(0.0);
    let total = existing_balance + added_balance;
    if total <= 0.0 {
        return existing.normalized();
    }
    AssetExposure {
        us_equity: (existing.us_equity * existing_balance + added.us_equity * added_balance)
            / total,
        intl_equity: (existing.intl_equity * existing_balance + added.intl_equity * added_balance)
            / total,
        bonds: (existing.bonds * existing_balance + added.bonds * added_balance) / total,
        cash: (existing.cash * existing_balance + added.cash * added_balance) / total,
    }
    .normalized()
}

fn bucket_return_from_parts(data: &Value, bucket: &str, asset_returns: AssetReturns) -> f64 {
    bucket_exposure_from_data(data, bucket).apply(asset_returns)
}

fn withdraw_from(balance: &mut f64, need: &mut f64) -> f64 {
    if *need <= 0.0 {
        return 0.0;
    }
    let amount = balance.min(*need);
    *balance -= amount;
    *need -= amount;
    amount
}

fn protected_hsa_in_pretax(balances: &Balances, hsa_balance: f64) -> f64 {
    balances.pretax.max(0.0).min(hsa_balance.max(0.0))
}

fn remove_protected_hsa_from_pretax(mut balances: Balances, hsa_balance: f64) -> (Balances, f64) {
    let protected = protected_hsa_in_pretax(&balances, hsa_balance);
    balances.pretax = (balances.pretax - protected).max(0.0);
    (balances, protected)
}

fn restore_protected_hsa_to_pretax(mut balances: Balances, protected_hsa: f64) -> Balances {
    balances.pretax += protected_hsa.max(0.0);
    balances
}

fn subtract_capped(balance: &mut f64, amount: f64) -> f64 {
    let applied = balance.max(0.0).min(amount.max(0.0));
    *balance -= applied;
    if balance.abs() < 0.005 {
        *balance = 0.0;
    }
    applied
}

fn percentile(values: &mut [f64], fraction: f64) -> f64 {
    time_module(ModuleTimer::Percentile, || {
        if values.is_empty() {
            return 0.0;
        }
        let index = percentile_index(values.len(), fraction);
        let (_, value, _) = values.select_nth_unstable_by(index, |a, b| cmp_f64_for_summary(a, b));
        *value
    })
}

fn median(values: &mut [f64]) -> f64 {
    percentile(values, 0.5)
}

fn percentile_index(len: usize, fraction: f64) -> usize {
    ((len - 1) as f64 * fraction).floor() as usize
}

fn cmp_f64_for_summary(left: &f64, right: &f64) -> std::cmp::Ordering {
    left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
}

fn percentile_values<const N: usize>(values: &mut [f64], fractions: [f64; N]) -> [f64; N] {
    let mut output = [0.0; N];
    if values.is_empty() {
        return output;
    }
    for (index, fraction) in fractions.into_iter().enumerate() {
        output[index] = percentile(values, fraction);
    }
    output
}

pub fn compact_summary_tape_to_json(input: CompactSummaryTapeInput<'_>) -> Result<Value, String> {
    let dimensions = input.dimensions()?;
    let mut tape = input
        .metadata
        .as_object()
        .cloned()
        .ok_or("compact tape metadata must be a JSON object")?;

    let mut trials = Vec::with_capacity(dimensions.trial_count);
    for trial_offset in 0..dimensions.trial_count {
        let mut market_path = Vec::with_capacity(dimensions.years_per_trial);
        for year_offset in 0..dimensions.years_per_trial {
            let year = input.year_at(&dimensions, trial_offset, year_offset);
            let mut year_point = Map::new();
            year_point.insert("year".to_string(), json!(year.year));
            year_point.insert("yearOffset".to_string(), json!(year.year_offset));
            year_point.insert("inflation".to_string(), json!(year.inflation));
            year_point.insert(
                "assetReturns".to_string(),
                json!({
                    "US_EQUITY": year.us_equity_return,
                    "INTL_EQUITY": year.intl_equity_return,
                    "BONDS": year.bond_return,
                    "CASH": year.cash_return,
                }),
            );
            if let Some(bucket_returns) = year.bucket_returns {
                year_point.insert(
                    "bucketReturns".to_string(),
                    json!({
                        "pretax": bucket_returns.pretax,
                        "roth": bucket_returns.roth,
                        "taxable": bucket_returns.taxable,
                        "cash": bucket_returns.cash,
                    }),
                );
            }
            if year.cashflow_present {
                year_point.insert("cashflow".to_string(), json!({}));
            }
            year_point.insert("marketState".to_string(), json!(year.market_state));
            market_path.push(Value::Object(year_point));
        }
        trials.push(json!({
            "trialIndex": input.trial_index[trial_offset],
            "trialSeed": input.trial_seed[trial_offset],
            "ltcEventOccurs": input.ltc_event_occurs[trial_offset] != 0,
            "marketPath": market_path,
        }));
    }
    tape.insert("trials".to_string(), Value::Array(trials));
    Ok(Value::Object(tape))
}

pub fn handle_request_with_compact_summary_tape(
    request_without_tape: &Value,
    compact_tape: CompactSummaryTapeInput<'_>,
) -> Result<Value, Box<dyn std::error::Error>> {
    let mut request = request_without_tape
        .as_object()
        .cloned()
        .ok_or("compact summary request must be a JSON object")?;
    let replay_tape = ReplayTapeInput::from_compact(compact_tape)?;
    request.insert("outputLevel".to_string(), json!("policy_mining_summary"));
    handle_request_with_replay_tape(&Value::Object(request), replay_tape)
}

pub fn handle_request(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    if request.get("schemaVersion").and_then(Value::as_str) != Some("engine-candidate-request-v1") {
        return Err("unsupported candidate request schema".into());
    }
    let replay_tape = ReplayTapeInput::Materialized(ReplayTape::from_json(&request["tape"])?);
    handle_request_with_replay_tape(request, replay_tape)
}

fn handle_request_with_replay_tape<'a>(
    request: &Value,
    replay_tape: ReplayTapeInput<'a>,
) -> Result<Value, Box<dyn std::error::Error>> {
    if request.get("schemaVersion").and_then(Value::as_str) != Some("engine-candidate-request-v1") {
        return Err("unsupported candidate request schema".into());
    }
    #[cfg(feature = "tax-counters")]
    reset_tax_call_counters(
        request
            .pointer("/instrumentation/taxCallCounts")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    #[cfg(feature = "module-timers")]
    reset_module_timer_counters(
        request
            .pointer("/instrumentation/moduleTimings")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );

    let data = &request["data"];
    let assumptions = &request["assumptions"];
    let mode = request
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("planner_enhanced");
    let output_level = request
        .get("outputLevel")
        .and_then(Value::as_str)
        .unwrap_or("full_trace");
    let summary_only = output_level == "policy_mining_summary";
    let planner_logic_active = mode == "planner_enhanced";
    let requested_annual_spend = request
        .get("annualSpendTarget")
        .and_then(Value::as_f64)
        .filter(|target| target.is_finite() && *target >= 0.0);
    let constants = SimulationConstants::from(
        data,
        assumptions,
        planner_logic_active,
        requested_annual_spend,
    );
    let base_spend = constants.annual_spending;
    let annual_spend_schedule = annual_spend_schedule_by_year(request);
    let start_balances = constants.start_balances;
    let trial_count_hint = replay_tape.trial_count();
    let planning_horizon_years = replay_tape.planning_horizon_years().max(0) as usize;
    let mut ending_wealths = Vec::with_capacity(trial_count_hint);
    let mut worst_outcome: Option<(f64, bool, Option<i64>)> = None;
    let mut best_outcome: Option<(f64, bool, Option<i64>)> = None;
    let mut failure_years = Vec::with_capacity(trial_count_hint);
    let mut yearly_years = vec![0i64; planning_horizon_years];
    let mut yearly_assets: Vec<Vec<f64>> = if summary_only {
        Vec::new()
    } else {
        (0..planning_horizon_years)
            .map(|_| Vec::with_capacity(trial_count_hint))
            .collect()
    };
    let mut yearly_spending: Vec<Vec<f64>> = if summary_only {
        Vec::new()
    } else {
        (0..planning_horizon_years)
            .map(|_| Vec::with_capacity(trial_count_hint))
            .collect()
    };
    let mut yearly_taxes: Vec<Vec<f64>> = (0..planning_horizon_years)
        .map(|_| Vec::with_capacity(trial_count_hint))
        .collect();
    let mut diagnostic_trials: Vec<Value> = if summary_only {
        Vec::new()
    } else {
        Vec::with_capacity(trial_count_hint)
    };
    let mut spending_cut_count = 0usize;
    let mut irmaa_triggered_count = 0usize;
    let mut home_sale_dependent_count = 0usize;
    let mut inheritance_dependent_count = 0usize;
    let mut roth_depleted_count = 0usize;
    let mut magi_history = vec![f64::NAN; planning_horizon_years.max(1)];

    for trial_offset in 0..replay_tape.trial_count() {
        let trial = replay_tape.trial_at(trial_offset);
        let trial_year_count = trial.year_count();
        if magi_history.len() < trial_year_count {
            magi_history.resize(trial_year_count, f64::NAN);
        }
        magi_history[..trial_year_count].fill(f64::NAN);
        let mut balances = start_balances;
        let mut taxable_exposure = bucket_exposure_from_data(data, "taxable");
        let mut taxable_exposure_dynamic = false;
        let mut hsa_balance = constants.hsa_balance;
        let mut inflation_index = 1.0;
        let mut medical_index = 1.0;
        let mut failure_year: Option<i64> = None;
        let trial_index = trial.trial_index();
        let mut diagnostic_yearly: Option<Vec<Value>> = if summary_only {
            None
        } else {
            Some(Vec::with_capacity(trial_year_count))
        };
        let mut irmaa_triggered = false;
        let mut spending_cuts_triggered = 0i64;
        let mut optional_cut_active = false;
        let mut home_sale_dependent = false;
        let mut inheritance_dependent = false;
        let mut roth_depleted_early = false;
        let mut roth_was_positive = balances.roth > 0.0;
        let ltc_event_occurs = trial.ltc_event_occurs();

        for offset in 0..trial_year_count {
            let replay_year = trial.year_at(offset);
            let year = replay_year.year();
            let total_assets_at_start = total_assets_with_hsa(balances, hsa_balance);
            let pretax_balance_for_rmd = (balances.pretax - hsa_balance.max(0.0)).max(0.0);
            let rob_age = constants.rob_age(offset);
            let debbie_age = constants.debbie_age(offset);
            let salary_this_year = constants.salary_for_year(year);
            let standard_deduction_for_year = constants
                .tax_constants
                .standard_deduction(rob_age, debbie_age);
            let contribution_result = calculate_contributions(
                &constants,
                &mut balances,
                hsa_balance,
                rob_age,
                year,
                salary_this_year,
            );
            hsa_balance = contribution_result.updated_hsa_balance;
            let bucket_returns = replay_year.bucket_returns();
            let asset_returns = replay_year.asset_returns();
            let pretax_return = bucket_returns
                .as_ref()
                .map(|returns| returns.pretax)
                .unwrap_or_else(|| bucket_return_from_parts(data, "pretax", asset_returns));
            let roth_return = bucket_returns
                .as_ref()
                .map(|returns| returns.roth)
                .unwrap_or_else(|| bucket_return_from_parts(data, "roth", asset_returns));
            let taxable_return = bucket_returns
                .as_ref()
                .map(|returns| returns.taxable)
                .unwrap_or_else(|| bucket_return_from_parts(data, "taxable", asset_returns));
            let taxable_return = if taxable_exposure_dynamic {
                taxable_exposure.apply(asset_returns)
            } else {
                taxable_return
            };
            let cash_return = bucket_returns
                .as_ref()
                .map(|returns| returns.cash)
                .unwrap_or_else(|| bucket_return_from_parts(data, "cash", asset_returns));
            balances.pretax *= 1.0 + pretax_return;
            balances.roth *= 1.0 + roth_return;
            balances.taxable *= 1.0 + taxable_return;
            balances.cash *= 1.0 + cash_return;
            let hsa_return = constants.hsa_return_weights.apply(asset_returns);
            hsa_balance *= 1.0 + hsa_return;

            let salary = contribution_result.adjusted_wages;
            let additional_medicare_tax_for_year =
                constants.tax_constants.additional_medicare_tax(salary);
            let ss_income =
                constants
                    .social_security_schedule
                    .income(rob_age, debbie_age, inflation_index);
            let windfall_cash = constants.windfall_schedule.cash_for_year(year);
            balances.cash += windfall_cash;

            let taxes_insurance_for_year = constants.taxes_insurance_for_year(year);
            let baseline_travel_annual = constants.travel_for_year(year);
            let fixed_spend_annual = constants.essential_annual + taxes_insurance_for_year;
            let baseline_discretionary = constants.optional_annual + baseline_travel_annual;
            let target_annual_spend = annual_spend_schedule
                .get(&year)
                .copied()
                .unwrap_or(fixed_spend_annual + baseline_discretionary);
            let discretionary_target_annual = (target_annual_spend - fixed_spend_annual).max(0.0);
            let discretionary_scale = if baseline_discretionary > 0.0 {
                discretionary_target_annual / baseline_discretionary
            } else {
                0.0
            };
            let optional_annual_for_year = constants.optional_annual * discretionary_scale;
            let travel_annual_for_year = baseline_travel_annual * discretionary_scale;
            let base_spending_for_guardrail =
                fixed_spend_annual + optional_annual_for_year + travel_annual_for_year;
            let funded_years = total_assets_at_start / base_spending_for_guardrail.max(1.0);
            if constants.guardrails_enabled
                && !optional_cut_active
                && funded_years < constants.guardrail_floor_years
            {
                optional_cut_active = true;
                spending_cuts_triggered += 1;
            } else if constants.guardrails_enabled
                && optional_cut_active
                && funded_years > constants.guardrail_ceiling_years
            {
                optional_cut_active = false;
            }
            let cut_multiplier = if optional_cut_active {
                1.0 - constants.guardrail_cut_percent
            } else {
                1.0
            };
            let spending_before_healthcare = (constants.essential_annual
                + taxes_insurance_for_year
                + optional_annual_for_year * cut_multiplier
                + travel_annual_for_year * cut_multiplier)
                * inflation_index;
            let mut healthcare_premium_cost = 0.0;
            let ltc_cost_for_year = constants.ltc_cost_for_event(ltc_event_occurs, offset);
            let mut hsa_offset_for_year = 0.0;
            let mut spending =
                spending_before_healthcare + healthcare_premium_cost + ltc_cost_for_year
                    - hsa_offset_for_year;
            if windfall_cash > 0.0 {
                let years_funded_before_event =
                    total_assets_at_start / spending_before_healthcare.max(1.0);
                if years_funded_before_event < 5.0 {
                    if constants
                        .windfall_schedule
                        .has_named_for_year(year, "home_sale")
                    {
                        home_sale_dependent = true;
                    }
                    if constants
                        .windfall_schedule
                        .has_named_for_year(year, "inheritance")
                    {
                        inheritance_dependent = true;
                    }
                }
            }
            let rmd_amount =
                constants.required_minimum_distribution(pretax_balance_for_rmd, offset);
            let base_income = salary + ss_income;
            let income = base_income + rmd_amount;
            let shortfall_before_healthcare = (spending_before_healthcare - base_income).max(0.0);
            let balances_before_withdrawal = balances;
            let (spendable_balances_before_withdrawal, protected_hsa_at_withdrawal) =
                remove_protected_hsa_from_pretax(balances_before_withdrawal, hsa_balance);
            let (windfall_ordinary_income, windfall_ltcg_income) =
                constants.windfall_schedule.taxable_for_year(year);
            let mut debug_withdrawals = WithdrawalAmounts {
                cash: 0.0,
                taxable: 0.0,
                pretax: 0.0,
                roth: 0.0,
            };
            let mut cash_withdrawn_for_year = 0.0;
            let (final_tax, need) = if replay_year.cashflow_present() || !planner_logic_active {
                let market_state = replay_year.market_state();
                let healthcare_context =
                    HealthcarePremiumContext::from(&constants, year, offset, medical_index);
                let medicare_count = healthcare_context.medicare_count;
                let is_retired = healthcare_context.retirement_status;
                let is_low_earned_income = salary_this_year <= constants.salary_annual * 0.35;
                let aca_friendly_magi_ceiling = if planner_logic_active
                    && medicare_count < 2
                    && (is_retired || is_low_earned_income)
                {
                    Some(
                        constants
                            .tax_constants
                            .aca_friendly_magi_ceiling(inflation_index),
                    )
                } else {
                    None
                };
                let withdrawal_strategy = WithdrawalStrategy {
                    planner_logic_active,
                    withdrawal_rule: constants.withdrawal_rule.as_str(),
                    market_state,
                    aca_friendly_magi_ceiling,
                    irmaa_aware_withdrawal_buffer: constants.irmaa_aware_withdrawal_buffer,
                    preserve_roth_preference: planner_logic_active,
                    irmaa_threshold: constants.irmaa_threshold,
                    taxable_first_when_down: constants.taxable_defense_score
                        >= constants.pretax_defense_score,
                };
                let mut closed_loop_needed = shortfall_before_healthcare;
                let mut previous_state: Option<(f64, f64, f64)> = None;
                let mut last_needed_sign = 0;
                let mut oscillation_flips = 0;
                let mut final_attempt: Option<WithdrawalAttempt> = None;
                #[cfg(feature = "tax-counters")]
                let mut closed_loop_pass_count = 0u64;
                #[cfg(feature = "tax-counters")]
                let mut closed_loop_break_reason = ClosedLoopBreakReason::PassLimit;
                #[cfg(feature = "tax-counters")]
                let mut closed_loop_abs_needed_diff = 0.0;

                for pass in 1..=10 {
                    #[cfg(feature = "tax-counters")]
                    {
                        closed_loop_pass_count = pass;
                        record_tax_counter(|counters| counters.closed_loop_pass += 1);
                    }

                    let withdrawal_context = WithdrawalContext {
                        tax_constants: constants.tax_constants,
                        roth_conversion_policy: constants.roth_conversion_policy,
                        starting_balances: spendable_balances_before_withdrawal,
                        needed: closed_loop_needed,
                        rmd_amount,
                        wages: salary,
                        social_security: ss_income,
                        windfall_ordinary_income,
                        windfall_ltcg_income,
                        standard_deduction: standard_deduction_for_year,
                        additional_medicare_tax: additional_medicare_tax_for_year,
                    };
                    let attempt = withdrawal_attempt(&withdrawal_context, &withdrawal_strategy);
                    let magi = attempt.tax.magi;
                    let irmaa_reference_magi = offset
                        .checked_sub(2)
                        .and_then(|history_offset| magi_history.get(history_offset).copied())
                        .filter(|value| value.is_finite())
                        .unwrap_or(magi);
                    let pass_irmaa_tier = constants.tax_constants.irmaa_tier(irmaa_reference_magi);
                    let healthcare_for_pass = compute_healthcare_premium_cost(
                        &constants,
                        &healthcare_context,
                        magi,
                        pass_irmaa_tier,
                    );
                    let hsa_offset_for_pass = constants.hsa_strategy.offset_for_year(
                        hsa_balance,
                        magi,
                        healthcare_for_pass,
                        ltc_cost_for_year,
                    );
                    let next_needed = (shortfall_before_healthcare
                        + healthcare_for_pass
                        + ltc_cost_for_year
                        + attempt.tax.federal_tax
                        - hsa_offset_for_pass)
                        .max(0.0);

                    final_attempt = Some(attempt);

                    if let Some((previous_magi, previous_tax, previous_healthcare)) = previous_state
                    {
                        let magi_delta = (magi - previous_magi).abs();
                        let tax_delta = (attempt.tax.federal_tax - previous_tax).abs();
                        let healthcare_delta = (healthcare_for_pass - previous_healthcare).abs();
                        if magi_delta <= 50.0 && tax_delta <= 50.0 && healthcare_delta <= 50.0 {
                            #[cfg(feature = "tax-counters")]
                            {
                                closed_loop_break_reason = ClosedLoopBreakReason::StateConverged;
                                closed_loop_abs_needed_diff =
                                    (next_needed - closed_loop_needed).abs();
                            }
                            break;
                        }
                        if (next_needed - closed_loop_needed).abs() <= 1.0 {
                            #[cfg(feature = "tax-counters")]
                            {
                                closed_loop_break_reason = ClosedLoopBreakReason::NeededDelta;
                                closed_loop_abs_needed_diff =
                                    (next_needed - closed_loop_needed).abs();
                            }
                            break;
                        }
                    }

                    if pass == 10 {
                        #[cfg(feature = "tax-counters")]
                        {
                            closed_loop_break_reason = ClosedLoopBreakReason::PassLimit;
                            closed_loop_abs_needed_diff = (next_needed - closed_loop_needed).abs();
                        }
                        break;
                    }

                    previous_state = Some((magi, attempt.tax.federal_tax, healthcare_for_pass));
                    let needed_diff = next_needed - closed_loop_needed;
                    let current_sign = if needed_diff > 0.0 {
                        1
                    } else if needed_diff < 0.0 {
                        -1
                    } else {
                        0
                    };
                    if last_needed_sign != 0
                        && current_sign != 0
                        && current_sign != last_needed_sign
                    {
                        oscillation_flips += 1;
                    }
                    if current_sign != 0 {
                        last_needed_sign = current_sign;
                    }
                    if oscillation_flips >= 2 {
                        #[cfg(feature = "tax-counters")]
                        {
                            closed_loop_break_reason = ClosedLoopBreakReason::Oscillation;
                            closed_loop_abs_needed_diff = needed_diff.abs();
                        }
                        break;
                    }
                    let damping_factor = if oscillation_flips >= 1 { 0.3 } else { 0.5 };
                    closed_loop_needed += damping_factor * needed_diff;
                }
                #[cfg(feature = "tax-counters")]
                record_closed_loop_outcome(
                    closed_loop_pass_count,
                    closed_loop_break_reason,
                    closed_loop_abs_needed_diff,
                );

                let attempt = final_attempt.expect("raw withdrawal loop should run at least once");
                let _rmd_surplus_to_cash = attempt.rmd_surplus_to_cash;
                debug_withdrawals = attempt.withdrawals;
                cash_withdrawn_for_year = debug_withdrawals.cash;
                let mut spendable_balances_after_withdrawal = attempt.balances;
                let years_until_rmd = constants.years_until_rmd_start(rob_age, debbie_age);
                let (roth_conversion, computed_tax) = proactive_roth_conversion(
                    year,
                    &WithdrawalContext {
                        tax_constants: constants.tax_constants,
                        roth_conversion_policy: constants.roth_conversion_policy,
                        starting_balances: spendable_balances_before_withdrawal,
                        needed: closed_loop_needed,
                        rmd_amount,
                        wages: salary,
                        social_security: ss_income,
                        windfall_ordinary_income,
                        windfall_ltcg_income,
                        standard_deduction: standard_deduction_for_year,
                        additional_medicare_tax: additional_medicare_tax_for_year,
                    },
                    &withdrawal_strategy,
                    &spendable_balances_after_withdrawal,
                    &attempt.withdrawals,
                    attempt.tax,
                    rmd_amount,
                    years_until_rmd,
                    is_retired,
                );
                if roth_conversion > 0.0 {
                    subtract_capped(
                        &mut spendable_balances_after_withdrawal.pretax,
                        roth_conversion,
                    );
                    spendable_balances_after_withdrawal.roth += roth_conversion;
                }
                balances = restore_protected_hsa_to_pretax(
                    spendable_balances_after_withdrawal,
                    protected_hsa_at_withdrawal,
                );
                let irmaa_reference_magi = offset
                    .checked_sub(2)
                    .and_then(|history_offset| magi_history.get(history_offset).copied())
                    .filter(|value| value.is_finite())
                    .unwrap_or(computed_tax.magi);
                let computed_irmaa_tier = constants.tax_constants.irmaa_tier(irmaa_reference_magi);
                if computed_irmaa_tier > 1 && medicare_count > 0 {
                    irmaa_triggered = true;
                }
                magi_history[offset] = computed_tax.magi;
                healthcare_premium_cost = compute_healthcare_premium_cost(
                    &constants,
                    &healthcare_context,
                    computed_tax.magi,
                    computed_irmaa_tier,
                );
                hsa_offset_for_year = constants.hsa_strategy.offset_for_year(
                    hsa_balance,
                    computed_tax.magi,
                    healthcare_premium_cost,
                    ltc_cost_for_year,
                );
                spending = spending_before_healthcare + healthcare_premium_cost + ltc_cost_for_year
                    - hsa_offset_for_year;
                if hsa_offset_for_year > 0.0 {
                    let applied_offset = hsa_offset_for_year
                        .min(hsa_balance)
                        .min(balances.pretax.max(0.0));
                    hsa_balance = (hsa_balance - applied_offset).max(0.0);
                    subtract_capped(&mut balances.pretax, applied_offset);
                }
                (computed_tax.federal_tax, attempt.remaining)
            } else {
                #[cfg(feature = "tax-counters")]
                record_tax_counter(|counters| counters.fallback_base_tax += 1);

                let base_tax = federal_tax_exact(&TaxInput {
                    tax_constants: constants.tax_constants,
                    wages: salary,
                    social_security: ss_income,
                    ira_withdrawals: 0.0,
                    taxable_interest: 0.0,
                    qualified_dividends: 0.0,
                    ordinary_dividends: 0.0,
                    realized_ltcg: 0.0,
                    realized_stcg: 0.0,
                    other_ordinary_income: 0.0,
                    tax_exempt_interest: 0.0,
                    standard_deduction: standard_deduction_for_year,
                    additional_medicare_tax: additional_medicare_tax_for_year,
                })
                .federal_tax;
                let mut need = (spending + base_tax - income).max(0.0);
                let (mut spendable_balances, protected_hsa) =
                    remove_protected_hsa_from_pretax(balances, hsa_balance);
                cash_withdrawn_for_year += withdraw_from(&mut spendable_balances.cash, &mut need);
                withdraw_from(&mut spendable_balances.taxable, &mut need);
                let pretax_withdrawal = withdraw_from(&mut spendable_balances.pretax, &mut need);
                withdraw_from(&mut spendable_balances.roth, &mut need);
                #[cfg(feature = "tax-counters")]
                record_tax_counter(|counters| counters.fallback_final_tax += 1);

                let final_tax = federal_tax_exact(&TaxInput {
                    tax_constants: constants.tax_constants,
                    wages: salary,
                    social_security: ss_income,
                    ira_withdrawals: pretax_withdrawal,
                    taxable_interest: 0.0,
                    qualified_dividends: 0.0,
                    ordinary_dividends: 0.0,
                    realized_ltcg: 0.0,
                    realized_stcg: 0.0,
                    other_ordinary_income: 0.0,
                    tax_exempt_interest: 0.0,
                    standard_deduction: standard_deduction_for_year,
                    additional_medicare_tax: additional_medicare_tax_for_year,
                })
                .federal_tax;
                let mut extra_tax_need = (final_tax - base_tax).max(0.0);
                if extra_tax_need > 0.0 {
                    cash_withdrawn_for_year +=
                        withdraw_from(&mut spendable_balances.cash, &mut extra_tax_need);
                    withdraw_from(&mut spendable_balances.taxable, &mut extra_tax_need);
                    withdraw_from(&mut spendable_balances.pretax, &mut extra_tax_need);
                    withdraw_from(&mut spendable_balances.roth, &mut extra_tax_need);
                    need += extra_tax_need;
                }
                balances = restore_protected_hsa_to_pretax(spendable_balances, protected_hsa);
                (final_tax, need)
            };
            let unresolved_need = if need >= MIN_FAILURE_SHORTFALL_DOLLARS {
                need
            } else {
                0.0
            };
            let windfall_used_for_spending = windfall_cash.min(cash_withdrawn_for_year);
            let windfall_deployed_to_taxable = (windfall_cash - windfall_used_for_spending)
                .max(0.0)
                .min(balances.cash.max(0.0));
            if windfall_deployed_to_taxable > 0.0 {
                let deployment_exposure =
                    current_invested_exposure(data, balances, taxable_exposure);
                taxable_exposure = blend_exposure(
                    taxable_exposure,
                    balances.taxable,
                    deployment_exposure,
                    windfall_deployed_to_taxable,
                );
                taxable_exposure_dynamic = true;
                balances.cash -= windfall_deployed_to_taxable;
                balances.taxable += windfall_deployed_to_taxable;
            }

            if offset >= yearly_years.len() {
                yearly_years.push(year);
                yearly_taxes.push(Vec::with_capacity(trial_count_hint));
                if !summary_only {
                    yearly_assets.push(Vec::with_capacity(trial_count_hint));
                    yearly_spending.push(Vec::with_capacity(trial_count_hint));
                }
            } else if yearly_years[offset] == 0 {
                yearly_years[offset] = year;
            }
            if !summary_only {
                yearly_assets[offset].push(total_assets_with_hsa(balances, hsa_balance));
                yearly_spending[offset].push(spending);
            }
            yearly_taxes[offset].push(final_tax);
            if let Some(yearly) = diagnostic_yearly.as_mut() {
                yearly.push(json!({
                    "year": year,
                    "totalAssets": total_assets_with_hsa(balances, hsa_balance).round(),
                    "pretaxBalanceEnd": balances.pretax.round(),
                    "taxableBalanceEnd": balances.taxable.round(),
                    "rothBalanceEnd": balances.roth.round(),
                    "cashBalanceEnd": balances.cash.round(),
                    "spending": spending.round(),
                    "income": income.round(),
                    "federalTax": final_tax.round(),
                    "debugAdjustedWages": contribution_result.adjusted_wages,
                    "debugEmployee401kContribution": contribution_result.employee_401k_contribution,
                    "debugEmployerMatchContribution": contribution_result.employer_match_contribution,
                    "debugHsaContribution": contribution_result.hsa_contribution,
                    "debugRothContributionFlow": contribution_result.roth_contribution_flow,
                    "debugRemainingWithdrawalNeed": unresolved_need,
                    "debugWithdrawalCash": debug_withdrawals.cash,
                    "debugWithdrawalTaxable": debug_withdrawals.taxable,
                    "debugWithdrawalPretax": debug_withdrawals.pretax,
                    "debugWithdrawalRoth": debug_withdrawals.roth,
                    "debugWindfallDeployedToTaxable": windfall_deployed_to_taxable,
                }));
            }

            if balances.total().abs() < 1.0 {
                balances.pretax = 0.0;
                balances.roth = 0.0;
                balances.taxable = 0.0;
                balances.cash = 0.0;
            }

            if roth_was_positive && balances.roth <= 1.0 && rob_age < 75 {
                roth_depleted_early = true;
            }
            roth_was_positive = balances.roth > 1.0;

            if unresolved_need > 0.0 || total_assets_with_hsa(balances, hsa_balance) <= 1.0 {
                failure_year = Some(year);
                break;
            }
            inflation_index *= 1.0 + replay_year.inflation();
            medical_index *= 1.055;
        }

        if irmaa_triggered {
            irmaa_triggered_count += 1;
        }
        if spending_cuts_triggered > 0 {
            spending_cut_count += 1;
        }
        if home_sale_dependent {
            home_sale_dependent_count += 1;
        }
        if inheritance_dependent {
            inheritance_dependent_count += 1;
        }
        if roth_depleted_early {
            roth_depleted_count += 1;
        }
        let ending_wealth = total_assets_with_hsa(balances, hsa_balance);
        let trial_success = failure_year.is_none();
        if let Some(year) = failure_year {
            failure_years.push(year);
        }
        if let Some(yearly) = diagnostic_yearly {
            diagnostic_trials.push(json!({
                "trialIndex": trial_index,
                "success": trial_success,
                "failureYear": failure_year,
                "endingWealth": ending_wealth,
                "yearly": yearly,
            }));
        }
        let trial_outcome = (ending_wealth, trial_success, failure_year);
        if worst_outcome
            .map(|outcome| {
                ending_wealth
                    .partial_cmp(&outcome.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    == std::cmp::Ordering::Less
            })
            .unwrap_or(true)
        {
            worst_outcome = Some(trial_outcome);
        }
        if best_outcome
            .map(|outcome| {
                ending_wealth
                    .partial_cmp(&outcome.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    == std::cmp::Ordering::Greater
            })
            .unwrap_or(true)
        {
            best_outcome = Some(trial_outcome);
        }
        ending_wealths.push(ending_wealth);
    }

    let trial_count = ending_wealths.len().max(1);
    let success_count = trial_count - failure_years.len();
    let success_rate = success_count as f64 / trial_count as f64;
    let [p10, p25, p50, p75, p90] =
        percentile_values(&mut ending_wealths, [0.1, 0.25, 0.5, 0.75, 0.9]);

    let yearly_tax_medians: Vec<(i64, f64)> = yearly_taxes
        .iter_mut()
        .enumerate()
        .map(|(index, values)| {
            (
                yearly_years.get(index).copied().unwrap_or(0),
                median(values),
            )
        })
        .collect();
    let yearly_spending_medians: Vec<(i64, f64)> = if summary_only {
        Vec::new()
    } else {
        yearly_spending
            .iter_mut()
            .enumerate()
            .map(|(index, values)| {
                (
                    yearly_years.get(index).copied().unwrap_or(0),
                    median(values),
                )
            })
            .collect()
    };
    let annual_tax = if yearly_tax_medians.is_empty() {
        0.0
    } else {
        yearly_tax_medians.iter().map(|(_, tax)| *tax).sum::<f64>()
            / yearly_tax_medians.len() as f64
    };
    let yearly_series: Vec<Value> = if summary_only {
        Vec::new()
    } else {
        yearly_assets
            .into_iter()
            .enumerate()
            .map(|(index, mut assets)| {
                let year = yearly_years.get(index).copied().unwrap_or(0);
                let median_spending = yearly_spending_medians
                    .get(index)
                    .map(|(_, spending)| *spending)
                    .unwrap_or_default();
                let median_tax = yearly_tax_medians
                    .get(index)
                    .map(|(_, tax)| *tax)
                    .unwrap_or_default();
                json!({
                    "year": year,
                    "medianAssets": median(&mut assets),
                    "medianSpending": median_spending,
                    "medianFederalTax": median_tax,
                })
            })
            .collect()
    };

    let worst_outcome = worst_outcome.unwrap_or((0.0, false, None));
    let best_outcome = best_outcome.unwrap_or((0.0, false, None));
    let median_failure_year = if failure_years.is_empty() {
        Value::Null
    } else {
        let mut years: Vec<f64> = failure_years.iter().map(|y| *y as f64).collect();
        json!(median(&mut years))
    };
    let mut failure_year_counts: BTreeMap<i64, usize> = BTreeMap::new();
    for year in &failure_years {
        *failure_year_counts.entry(*year).or_insert(0) += 1;
    }
    let failure_year_distribution: Vec<Value> = failure_year_counts
        .into_iter()
        .map(|(year, count)| {
            json!({
                "year": year,
                "count": count,
                "rate": count as f64 / trial_count as f64,
            })
        })
        .collect();
    let ending_wealth_percentiles = json!({
        "p10": p10,
        "p25": p25,
        "p50": p50,
        "p75": p75,
        "p90": p90
    });
    let monte_carlo_metadata = json!({
        "seed": replay_tape.seed(),
        "trialCount": trial_count,
        "assumptionsVersion": assumptions.get("assumptionsVersion").and_then(Value::as_str).unwrap_or("v1"),
        "planningHorizonYears": replay_tape.planning_horizon_years()
    });
    let worst_outcome_json = json!({
        "endingWealth": worst_outcome.0,
        "success": worst_outcome.1,
        "failureYear": worst_outcome.2
    });
    let best_outcome_json = json!({
        "endingWealth": best_outcome.0,
        "success": best_outcome.1,
        "failureYear": best_outcome.2
    });
    let summary = json!({
        "contractVersion": "policy-mining-summary-v1",
        "outputLevel": "policy_mining_summary",
        "sourcePathId": "selected-path",
        "simulationMode": mode,
        "plannerLogicActive": planner_logic_active,
        "successRate": success_rate,
        "yearsFunded": if base_spend > 0.0 { (total_assets_with_hsa(start_balances, constants.hsa_balance) / base_spend).round() } else { 0.0 },
        "medianEndingWealth": p50,
        "endingWealthPercentiles": ending_wealth_percentiles.clone(),
        "annualFederalTaxEstimate": annual_tax,
        "irmaaExposureRate": irmaa_triggered_count as f64 / trial_count as f64,
        "spendingCutRate": spending_cut_count as f64 / trial_count as f64,
        "rothDepletionRate": roth_depleted_count as f64 / trial_count as f64,
        "failureYearDistribution": failure_year_distribution.clone(),
        "worstOutcome": worst_outcome_json.clone(),
        "bestOutcome": best_outcome_json.clone(),
        "monteCarloMetadata": monte_carlo_metadata.clone(),
        "modelCompleteness": {
            "indicator": "unknown",
            "inferredAssumptions": [],
            "assumptionsVersion": assumptions.get("assumptionsVersion").and_then(Value::as_str).unwrap_or("v1")
        }
    });
    #[cfg_attr(
        not(any(feature = "tax-counters", feature = "module-timers")),
        allow(unused_mut)
    )]
    let mut diagnostics = if output_level == "policy_mining_summary" {
        json!({
            "coverage": "tape replay with Rust-owned income, contributions, taxes, healthcare, guardrails, RMD, LTC, withdrawal source selection, proactive Roth conversion, and summaries",
            "trialsConsumed": trial_count
        })
    } else {
        json!({
            "coverage": "tape replay with Rust-owned income, contributions, taxes, healthcare, guardrails, RMD, LTC, withdrawal source selection, proactive Roth conversion, and summaries",
            "trialsConsumed": trial_count,
            "trials": diagnostic_trials
        })
    };
    #[cfg(feature = "tax-counters")]
    if let Some(counters) = take_tax_call_counters() {
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert("taxCallCounts".to_string(), counters.to_json());
        }
    }
    #[cfg(feature = "module-timers")]
    if let Some(counters) = take_module_timer_counters() {
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert("moduleTimings".to_string(), counters.to_json());
        }
    }

    let mut response = json!({
        "schemaVersion": "engine-candidate-response-v1",
        "runtime": "rust-replay-candidate",
        "diagnostics": diagnostics,
        "summary": summary
    });
    if !summary_only {
        let path = json!({
            "id": "selected-path",
            "label": "Selected Path",
            "simulationMode": mode,
            "plannerLogicActive": planner_logic_active,
            "successRate": success_rate,
            "medianEndingWealth": p50,
            "tenthPercentileEndingWealth": p10,
            "yearsFunded": if base_spend > 0.0 { (total_assets_with_hsa(start_balances, constants.hsa_balance) / base_spend).round() } else { 0.0 },
            "medianFailureYear": median_failure_year,
            "spendingCutRate": spending_cut_count as f64 / trial_count as f64,
            "irmaaExposureRate": irmaa_triggered_count as f64 / trial_count as f64,
            "homeSaleDependenceRate": home_sale_dependent_count as f64 / trial_count as f64,
            "inheritanceDependenceRate": inheritance_dependent_count as f64 / trial_count as f64,
            "flexibilityScore": 0,
            "cornerRiskScore": 0,
            "rothDepletionRate": roth_depleted_count as f64 / trial_count as f64,
            "annualFederalTaxEstimate": annual_tax,
            "irmaaExposure": "Low",
            "cornerRisk": "Low",
            "failureMode": "rust skeleton does not yet model full failure mode",
            "notes": "Rust candidate skeleton; expected to fail parity until model logic is ported.",
            "stressors": [],
            "responses": [],
            "endingWealthPercentiles": ending_wealth_percentiles,
            "failureYearDistribution": failure_year_distribution,
            "worstOutcome": worst_outcome_json,
            "bestOutcome": best_outcome_json,
            "monteCarloMetadata": monte_carlo_metadata,
            "yearlySeries": yearly_series
        });
        response["path"] = path;
    }
    Ok(response)
}
