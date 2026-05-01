use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const MIN_FAILURE_SHORTFALL_DOLLARS: f64 = 0.01;
pub const COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT: usize = 11;

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
    roth_annual_target: f64,
    match_rate: f64,
    match_cap_percent: f64,
    hsa_annual_target: f64,
    hsa_self_coverage: bool,
}

#[derive(Clone, Copy)]
struct HsaStrategy {
    enabled: bool,
    prioritize_high_magi: bool,
    high_magi_threshold: f64,
    annual_cap: f64,
}

#[derive(Clone, Copy)]
struct RothConversionPolicy {
    enabled: bool,
    min_annual: f64,
    max_pretax_balance_percent: f64,
    magi_buffer: f64,
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
}

#[derive(Clone)]
struct WindfallSchedule {
    entries: Vec<WindfallEntry>,
    default_home_sale_exclusion: f64,
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

struct SimulationConstants {
    start_balances: Balances,
    hsa_balance: f64,
    annual_spending: f64,
    essential_annual: f64,
    optional_annual: f64,
    taxes_insurance_annual: f64,
    travel_annual: f64,
    rob_current_age: i64,
    debbie_current_age: i64,
    rob_rmd_start_age: i64,
    debbie_rmd_start_age: i64,
    salary_annual: f64,
    salary_end_year: i64,
    salary_end_month_for_proration: i64,
    retirement_year: i64,
    travel_phase_years: i64,
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

impl SimulationConstants {
    fn from(data: &Value, assumptions: &Value, planner_logic_active: bool) -> Self {
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
        let mut salary_end_year = year_from_iso(salary_end_date);
        let mut salary_end_month_for_proration = month_from_iso(salary_end_date);
        let salary_end_day = salary_end_date
            .get(8..10)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(1);
        if salary_end_day == 1 {
            salary_end_month_for_proration -= 1;
            if salary_end_month_for_proration <= 0 {
                salary_end_month_for_proration = 12;
                salary_end_year -= 1;
            }
        }
        let (essential_annual, optional_annual, taxes_insurance_annual, travel_annual) =
            spending_parts(data);
        let withdrawal_rule = assumptions
            .get("withdrawalRule")
            .and_then(Value::as_str)
            .unwrap_or("tax_bracket_waterfall");
        Self {
            start_balances: starting_balances(data),
            hsa_balance: bucket_balance(data, "hsa"),
            annual_spending: annual_spending(data),
            essential_annual,
            optional_annual,
            taxes_insurance_annual,
            travel_annual,
            rob_current_age: current_age_at_2026_04_16(rob_birth_date),
            debbie_current_age: current_age_at_2026_04_16(debbie_birth_date),
            rob_rmd_start_age: rmd_policy_override
                .unwrap_or_else(|| rmd_start_age_for_birth_year(year_from_iso(rob_birth_date))),
            debbie_rmd_start_age: rmd_policy_override
                .unwrap_or_else(|| rmd_start_age_for_birth_year(year_from_iso(debbie_birth_date))),
            salary_annual: as_f64(data.pointer("/income/salaryAnnual")).max(0.0),
            salary_end_year,
            salary_end_month_for_proration,
            retirement_year: year_from_iso(salary_end_date),
            travel_phase_years: as_i64(assumptions.get("travelPhaseYears")).max(0),
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
            self.salary_annual * ((self.salary_end_month_for_proration - 1).max(0) as f64 / 12.0)
        }
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
            (self.rob_age(year_offset), self.rob_rmd_start_age),
            (self.debbie_age(year_offset), self.debbie_rmd_start_age),
        ];
        members.iter().fold(0.0, |total, (age, start_age)| {
            if age < start_age {
                total
            } else {
                total + (pretax_balance.max(0.0) * 0.5) / uniform_lifetime_divisor(*age)
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

    fn offset_for_year(self, hsa_balance: f64, magi: f64, healthcare_and_ltc: f64) -> f64 {
        if !self.enabled || hsa_balance <= 0.0 || healthcare_and_ltc <= 0.0 {
            return 0.0;
        }
        if self.prioritize_high_magi && magi < self.high_magi_threshold {
            return 0.0;
        }
        let capped_need = if self.annual_cap.is_finite() {
            healthcare_and_ltc.min(self.annual_cap)
        } else {
            healthcare_and_ltc
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
    fn annual_target(
        settings: Option<&Value>,
        amount_key: &str,
        percent_key: &str,
        fallback_amount_key: Option<&str>,
        fallback_percent_key: Option<&str>,
        salary_annual: f64,
    ) -> f64 {
        let amount = settings
            .and_then(|v| v.get(amount_key))
            .and_then(Value::as_f64)
            .or_else(|| {
                fallback_amount_key
                    .and_then(|key| settings.and_then(|v| v.get(key)).and_then(Value::as_f64))
            });
        if let Some(amount) = amount {
            if amount > 0.0 {
                return amount;
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
                return salary_annual * percent;
            }
        }
        0.0
    }

    fn from(settings: Option<&Value>, salary_annual: f64) -> Self {
        Self {
            pretax_annual_target: Self::annual_target(
                settings,
                "employee401kPreTaxAnnualAmount",
                "employee401kPreTaxPercentOfSalary",
                Some("employee401kAnnualAmount"),
                Some("employee401kPercentOfSalary"),
                salary_annual,
            ),
            roth_annual_target: Self::annual_target(
                settings,
                "employee401kRothAnnualAmount",
                "employee401kRothPercentOfSalary",
                None,
                None,
                salary_annual,
            ),
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
            hsa_annual_target: Self::annual_target(
                settings,
                "hsaAnnualAmount",
                "hsaPercentOfSalary",
                None,
                None,
                salary_annual,
            ),
            hsa_self_coverage: settings
                .and_then(|v| v.get("hsaCoverageType"))
                .and_then(Value::as_str)
                == Some("self"),
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

fn starting_balances(data: &Value) -> Balances {
    Balances {
        pretax: bucket_balance(data, "pretax") + bucket_balance(data, "hsa"),
        roth: bucket_balance(data, "roth"),
        taxable: bucket_balance(data, "taxable"),
        cash: bucket_balance(data, "cash"),
    }
}

fn annual_spending(data: &Value) -> f64 {
    as_f64(data.pointer("/spending/essentialMonthly")) * 12.0
        + as_f64(data.pointer("/spending/optionalMonthly")) * 12.0
        + as_f64(data.pointer("/spending/annualTaxesInsurance"))
        + as_f64(data.pointer("/spending/travelEarlyRetirementAnnual"))
}

fn spending_parts(data: &Value) -> (f64, f64, f64, f64) {
    (
        as_f64(data.pointer("/spending/essentialMonthly")) * 12.0,
        as_f64(data.pointer("/spending/optionalMonthly")) * 12.0,
        as_f64(data.pointer("/spending/annualTaxesInsurance")),
        as_f64(data.pointer("/spending/travelEarlyRetirementAnnual")),
    )
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
    salary_this_year: f64,
) -> ContributionResult {
    let settings = &constants.contribution_settings;
    let salary_fraction = if constants.salary_annual > 0.0 {
        clamp(salary_this_year / constants.salary_annual, 0.0, 1.0)
    } else {
        0.0
    };

    let annual_401k_limit = 24_000.0 + if rob_age >= 50 { 7_500.0 } else { 0.0 };
    let requested_pretax = clamp(
        settings.pretax_annual_target * salary_fraction,
        0.0,
        salary_this_year,
    );
    let requested_roth = clamp(
        settings.roth_annual_target * salary_fraction,
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

    let hsa_base_limit = if settings.hsa_self_coverage {
        4_300.0
    } else {
        8_550.0
    };
    let hsa_limit = hsa_base_limit + if rob_age >= 55 { 1_000.0 } else { 0.0 };
    let hsa_contribution = clamp(
        (settings.hsa_annual_target * salary_fraction)
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
        let modeled_selling_cost = if entry.name == "home_sale" {
            entry.amount * entry.selling_cost_percent
        } else {
            0.0
        };
        let default_liquidity = (entry.amount - modeled_selling_cost).max(0.0);
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
    let mut remaining = taxable_income.max(0.0);
    let mut previous_top = 0.0;
    let mut tax = 0.0;
    for (up_to, rate) in brackets {
        if remaining <= 0.0 {
            break;
        }
        let taxable = remaining.min(up_to - previous_top);
        if taxable > 0.0 {
            tax += taxable * rate;
            remaining -= taxable;
        }
        previous_top = *up_to;
    }
    tax
}

fn interpolate_aca_rate(fpl_ratio: f64) -> f64 {
    let bands = [
        (1.5, 0.0, 0.0),
        (2.0, 0.0, 0.02),
        (2.5, 0.02, 0.04),
        (3.0, 0.04, 0.06),
        (4.0, 0.06, 0.085),
        (f64::INFINITY, 0.085, 0.085),
    ];
    let mut previous_max = 0.0;
    let mut previous_rate = bands[0].1;
    for (max_fpl, min_rate, max_rate) in bands {
        if fpl_ratio <= max_fpl {
            if !max_fpl.is_finite() || max_fpl <= previous_max {
                return clamp(max_rate, 0.0, 1.0);
            }
            let relative = clamp(
                (fpl_ratio - previous_max) / (max_fpl - previous_max),
                0.0,
                1.0,
            );
            return clamp(previous_rate + (max_rate - min_rate) * relative, 0.0, 1.0);
        }
        previous_max = max_fpl;
        previous_rate = max_rate;
    }
    clamp(previous_rate, 0.0, 1.0)
}

fn compute_healthcare_premium_cost(
    constants: &SimulationConstants,
    year: i64,
    year_offset: usize,
    magi: f64,
    irmaa_tier_for_year: i64,
    medical_index: f64,
) -> f64 {
    let medicare_count = constants.medicare_eligible_count(year_offset);
    let non_medicare_count = 2 - medicare_count;
    let retirement_status = year >= constants.retirement_year;
    let baseline_aca = constants.baseline_aca_premium_annual * medical_index;
    let baseline_medicare = constants.baseline_medicare_premium_annual * medical_index;
    let aca_premium = if retirement_status {
        baseline_aca * non_medicare_count as f64
    } else {
        0.0
    };
    let medicare_premium = baseline_medicare * medicare_count as f64;
    let household_size = 2.0;
    let fpl = 21_150.0 + (household_size - 2.0_f64).max(0.0) * 5_500.0;
    let fpl_ratio = if fpl > 0.0 {
        magi.max(0.0) / fpl
    } else {
        f64::INFINITY
    };
    let expected_aca_contribution = interpolate_aca_rate(fpl_ratio) * magi.max(0.0);
    let aca_subsidy = if retirement_status && non_medicare_count > 0 {
        clamp(aca_premium - expected_aca_contribution, 0.0, aca_premium)
    } else {
        0.0
    };
    let net_aca = (aca_premium - aca_subsidy).max(0.0);
    let irmaa = constants
        .tax_constants
        .irmaa_surcharge_annual(irmaa_tier_for_year)
        * medicare_count as f64;
    to_currency(net_aca) + to_currency(medicare_premium) + to_currency(irmaa)
}

fn federal_tax_exact(input: &TaxInput) -> TaxOutput {
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
        (input.social_security * 0.85).min((provisional_income - second_base) * 0.85 + base_half)
    };
    let agi = ordinary_income_excluding_ss + taxable_ss + preferential_income;
    let magi = agi + input.tax_exempt_interest.max(0.0);
    let total_taxable_income =
        (agi - tax_constants.standard_deduction(input.rob_age, input.debbie_age)).max(0.0);
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
        federal_tax: ordinary_tax
            + ltcg_tax
            + niit
            + tax_constants.additional_medicare_tax(input.wages),
        magi,
    }
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
    rob_age: i64,
    debbie_age: i64,
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
    rob_age: i64,
    debbie_age: i64,
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
        rob_age: input.rob_age,
        debbie_age: input.debbie_age,
    })
}

fn tax_for_conversion(
    input: &WithdrawalContext,
    withdrawals: &WithdrawalAmounts,
    conversion_amount: f64,
) -> TaxOutput {
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
        rob_age: input.rob_age,
        debbie_age: input.debbie_age,
    })
}

fn proactive_roth_conversion(
    input: &WithdrawalContext,
    strategy: &WithdrawalStrategy<'_>,
    balances: &Balances,
    withdrawals: &WithdrawalAmounts,
    tax_before: TaxOutput,
    required_rmd_amount: f64,
    years_until_rmd: i64,
    is_retired: bool,
) -> (f64, TaxOutput) {
    if !strategy.planner_logic_active
        || !is_retired
        || !input.roth_conversion_policy.enabled
        || balances.pretax <= 0.0
    {
        return (0.0, tax_before);
    }

    let irmaa_threshold = strategy.irmaa_threshold;
    let magi_buffer = input.roth_conversion_policy.magi_buffer;
    let target_magi_ceiling = (irmaa_threshold - magi_buffer).max(0.0);
    let magi_before = tax_before.magi;
    let federal_tax_before = tax_before.federal_tax;
    let already_above_irmaa_threshold = magi_before > irmaa_threshold;
    let mut effective_balance_cap =
        balances.pretax.max(0.0) * input.roth_conversion_policy.max_pretax_balance_percent;
    if years_until_rmd <= 8 {
        let target_depletion_years = (years_until_rmd + 3).max(2) as f64;
        let smooth_depletion_cap = balances.pretax.max(0.0) / target_depletion_years;
        if !already_above_irmaa_threshold || years_until_rmd <= 3 {
            effective_balance_cap = effective_balance_cap.max(smooth_depletion_cap);
        }
    }
    effective_balance_cap = effective_balance_cap.min(balances.pretax.max(0.0));
    let available_headroom = (irmaa_threshold - magi_before - magi_buffer)
        .max(0.0)
        .min(effective_balance_cap)
        .min(balances.pretax.max(0.0));
    if available_headroom <= 0.0 {
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

    let mut best_amount = 0.0;
    let mut best_tax = tax_before;
    let mut best_score = 0.0;
    let mut best_projected_irmaa_exposure = 0.0;
    let mut saw_candidate = false;

    let mut previous_candidate = 0.0;
    for fraction in [0.25, 0.5, 0.75, 1.0] {
        let mut amount = available_headroom * fraction;
        amount = amount
            .min(effective_balance_cap)
            .min(balances.pretax.max(0.0));
        amount = (amount * 100.0).round() / 100.0;
        if amount <= 0.0 || amount == previous_candidate {
            continue;
        }
        previous_candidate = amount;
        if amount < input.roth_conversion_policy.min_annual {
            continue;
        }
        let tax_after = tax_for_conversion(input, withdrawals, amount);
        if !already_above_irmaa_threshold && tax_after.magi > target_magi_ceiling + 0.01 {
            continue;
        }
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
        if best_amount == 0.0 || conversion_score > best_score {
            best_amount = amount;
            best_tax = tax_after;
            best_score = conversion_score;
            best_projected_irmaa_exposure = projected_irmaa_exposure;
        }
    }

    let already_optimal = pretax_balance <= 25_000.0
        && best_projected_irmaa_exposure <= 1.0
        && rmd_proximity < 0.1
        && roth_share_before >= 0.65;
    if already_optimal || !saw_candidate || best_score <= 0.0 {
        (0.0, tax_before)
    } else {
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

    if strategy.withdrawal_rule == "proportional" && remaining > 0.0 {
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
    }

    let tax = tax_for_withdrawals(input, &withdrawals);

    WithdrawalAttempt {
        balances,
        withdrawals,
        remaining,
        rmd_surplus_to_cash,
        tax,
    }
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

fn bucket_return_from_parts(data: &Value, bucket: &str, asset_returns: AssetReturns) -> f64 {
    let Some(allocation) = data
        .pointer(&format!("/accounts/{bucket}/targetAllocation"))
        .and_then(Value::as_object)
    else {
        return 0.0;
    };
    allocation.iter().fold(0.0, |total, (symbol, weight)| {
        let weight = weight.as_f64().unwrap_or(0.0);
        let (us_w, intl_w, bonds_w, cash_w) = symbol_exposure(symbol.as_str());
        total
            + weight
                * (us_w * asset_returns.us_equity
                    + intl_w * asset_returns.intl_equity
                    + bonds_w * asset_returns.bonds
                    + cash_w * asset_returns.cash)
    })
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

fn subtract_capped(balance: &mut f64, amount: f64) -> f64 {
    let applied = balance.max(0.0).min(amount.max(0.0));
    *balance -= applied;
    if balance.abs() < 0.005 {
        *balance = 0.0;
    }
    applied
}

fn percentile(values: &mut [f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    percentile_sorted(values, fraction)
}

fn percentile_sorted(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let index = ((values.len() - 1) as f64 * fraction).floor() as usize;
    values[index]
}

fn median(values: &mut [f64]) -> f64 {
    percentile(values, 0.5)
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
    let constants = SimulationConstants::from(data, assumptions, planner_logic_active);
    let baseline_annual_spend = constants.annual_spending;
    let base_spend = request
        .get("annualSpendTarget")
        .and_then(Value::as_f64)
        .unwrap_or(baseline_annual_spend);
    let spend_multiplier = if base_spend > 0.0 && baseline_annual_spend > 0.0 {
        base_spend / baseline_annual_spend
    } else {
        1.0
    };
    let scaled_essential_annual = constants.essential_annual * spend_multiplier;
    let scaled_optional_annual = constants.optional_annual * spend_multiplier;
    let scaled_taxes_insurance_annual = constants.taxes_insurance_annual * spend_multiplier;
    let scaled_travel_annual = constants.travel_annual * spend_multiplier;
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

    for trial_offset in 0..replay_tape.trial_count() {
        let trial = replay_tape.trial_at(trial_offset);
        let mut balances = start_balances;
        let mut hsa_balance = constants.hsa_balance;
        let mut inflation_index = 1.0;
        let mut medical_index = 1.0;
        let mut failure_year: Option<i64> = None;
        let trial_index = trial.trial_index();
        let mut diagnostic_yearly: Option<Vec<Value>> = if summary_only {
            None
        } else {
            Some(Vec::with_capacity(trial.year_count()))
        };
        let mut irmaa_triggered = false;
        let mut magi_history = vec![f64::NAN; trial.year_count()];
        let mut spending_cuts_triggered = 0i64;
        let mut optional_cut_active = false;
        let mut home_sale_dependent = false;
        let mut inheritance_dependent = false;
        let mut roth_depleted_early = false;
        let mut roth_was_positive = balances.roth > 0.0;
        let ltc_event_occurs = trial.ltc_event_occurs();

        for offset in 0..trial.year_count() {
            let replay_year = trial.year_at(offset);
            let year = replay_year.year();
            let total_assets_at_start = balances.total();
            let pretax_balance_for_rmd = balances.pretax;
            let rob_age = constants.rob_age(offset);
            let debbie_age = constants.debbie_age(offset);
            let salary_this_year = constants.salary_for_year(year);
            let contribution_result = calculate_contributions(
                &constants,
                &mut balances,
                hsa_balance,
                rob_age,
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
            let cash_return = bucket_returns
                .as_ref()
                .map(|returns| returns.cash)
                .unwrap_or_else(|| bucket_return_from_parts(data, "cash", asset_returns));
            balances.pretax *= 1.0 + pretax_return;
            balances.roth *= 1.0 + roth_return;
            balances.taxable *= 1.0 + taxable_return;
            balances.cash *= 1.0 + cash_return;

            let salary = contribution_result.adjusted_wages;
            let ss_income =
                constants
                    .social_security_schedule
                    .income(rob_age, debbie_age, inflation_index);
            let windfall_cash = constants.windfall_schedule.cash_for_year(year);
            balances.cash += windfall_cash;

            let in_travel_phase = year - constants.retirement_year < constants.travel_phase_years;
            let baseline_discretionary = scaled_optional_annual
                + if in_travel_phase {
                    scaled_travel_annual
                } else {
                    0.0
                };
            let base_spending_for_guardrail =
                scaled_essential_annual + scaled_taxes_insurance_annual + baseline_discretionary;
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
            let spending_before_healthcare = (scaled_essential_annual
                + scaled_taxes_insurance_annual
                + scaled_optional_annual * cut_multiplier
                + if in_travel_phase {
                    scaled_travel_annual * cut_multiplier
                } else {
                    0.0
                })
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
            let base_income = salary + ss_income + windfall_cash;
            let income = base_income + rmd_amount;
            let shortfall_before_healthcare = (spending_before_healthcare - base_income).max(0.0);
            let balances_before_withdrawal = balances;
            let (windfall_ordinary_income, windfall_ltcg_income) =
                constants.windfall_schedule.taxable_for_year(year);
            let mut debug_withdrawals = WithdrawalAmounts {
                cash: 0.0,
                taxable: 0.0,
                pretax: 0.0,
                roth: 0.0,
            };
            let (final_tax, need) = if replay_year.cashflow_present() || !planner_logic_active {
                let market_state = replay_year.market_state();
                let medicare_count = constants.medicare_eligible_count(offset);
                let is_retired = year >= constants.retirement_year;
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

                for pass in 1..=10 {
                    let withdrawal_context = WithdrawalContext {
                        tax_constants: constants.tax_constants,
                        roth_conversion_policy: constants.roth_conversion_policy,
                        starting_balances: balances_before_withdrawal,
                        needed: closed_loop_needed,
                        rmd_amount,
                        wages: salary,
                        social_security: ss_income,
                        windfall_ordinary_income,
                        windfall_ltcg_income,
                        rob_age,
                        debbie_age,
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
                        year,
                        offset,
                        magi,
                        pass_irmaa_tier,
                        medical_index,
                    );
                    let hsa_offset_for_pass = constants.hsa_strategy.offset_for_year(
                        hsa_balance,
                        magi,
                        healthcare_for_pass + ltc_cost_for_year,
                    );
                    let next_needed =
                        (shortfall_before_healthcare + healthcare_for_pass + ltc_cost_for_year
                            - hsa_offset_for_pass)
                            .max(0.0);

                    final_attempt = Some(attempt);

                    if let Some((previous_magi, previous_tax, previous_healthcare)) = previous_state
                    {
                        let magi_delta = (magi - previous_magi).abs();
                        let tax_delta = (attempt.tax.federal_tax - previous_tax).abs();
                        let healthcare_delta = (healthcare_for_pass - previous_healthcare).abs();
                        if magi_delta <= 50.0 && tax_delta <= 50.0 && healthcare_delta <= 50.0 {
                            break;
                        }
                        if (next_needed - closed_loop_needed).abs() <= 1.0 {
                            break;
                        }
                    }

                    if pass == 10 {
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
                        break;
                    }
                    let damping_factor = if oscillation_flips >= 1 { 0.3 } else { 0.5 };
                    closed_loop_needed += damping_factor * needed_diff;
                }

                let attempt = final_attempt.expect("raw withdrawal loop should run at least once");
                let _rmd_surplus_to_cash = attempt.rmd_surplus_to_cash;
                debug_withdrawals = attempt.withdrawals;
                balances = attempt.balances;
                let years_until_rmd = constants.years_until_rmd_start(rob_age, debbie_age);
                let (roth_conversion, computed_tax) = proactive_roth_conversion(
                    &WithdrawalContext {
                        tax_constants: constants.tax_constants,
                        roth_conversion_policy: constants.roth_conversion_policy,
                        starting_balances: balances_before_withdrawal,
                        needed: closed_loop_needed,
                        rmd_amount,
                        wages: salary,
                        social_security: ss_income,
                        windfall_ordinary_income,
                        windfall_ltcg_income,
                        rob_age,
                        debbie_age,
                    },
                    &withdrawal_strategy,
                    &balances,
                    &attempt.withdrawals,
                    attempt.tax,
                    rmd_amount,
                    years_until_rmd,
                    is_retired,
                );
                if roth_conversion > 0.0 {
                    subtract_capped(&mut balances.pretax, roth_conversion);
                    balances.roth += roth_conversion;
                }
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
                    year,
                    offset,
                    computed_tax.magi,
                    computed_irmaa_tier,
                    medical_index,
                );
                hsa_offset_for_year = constants.hsa_strategy.offset_for_year(
                    hsa_balance,
                    computed_tax.magi,
                    healthcare_premium_cost + ltc_cost_for_year,
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
                    rob_age,
                    debbie_age,
                })
                .federal_tax;
                let mut need = (spending + base_tax - income).max(0.0);
                withdraw_from(&mut balances.cash, &mut need);
                withdraw_from(&mut balances.taxable, &mut need);
                let pretax_withdrawal = withdraw_from(&mut balances.pretax, &mut need);
                withdraw_from(&mut balances.roth, &mut need);
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
                    rob_age,
                    debbie_age,
                })
                .federal_tax;
                let mut extra_tax_need = (final_tax - base_tax).max(0.0);
                if extra_tax_need > 0.0 {
                    withdraw_from(&mut balances.cash, &mut extra_tax_need);
                    withdraw_from(&mut balances.taxable, &mut extra_tax_need);
                    withdraw_from(&mut balances.pretax, &mut extra_tax_need);
                    withdraw_from(&mut balances.roth, &mut extra_tax_need);
                    need += extra_tax_need;
                }
                (final_tax, need)
            };
            let unresolved_need = if need >= MIN_FAILURE_SHORTFALL_DOLLARS {
                need
            } else {
                0.0
            };

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
                yearly_assets[offset].push(balances.total());
                yearly_spending[offset].push(spending);
            }
            yearly_taxes[offset].push(final_tax);
            if let Some(yearly) = diagnostic_yearly.as_mut() {
                yearly.push(json!({
                    "year": year,
                    "totalAssets": balances.total().round(),
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

            if unresolved_need > 0.0 || balances.total() <= 1.0 {
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
        let ending_wealth = balances.total();
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
    ending_wealths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p10 = percentile_sorted(&ending_wealths, 0.1);
    let p25 = percentile_sorted(&ending_wealths, 0.25);
    let p50 = percentile_sorted(&ending_wealths, 0.5);
    let p75 = percentile_sorted(&ending_wealths, 0.75);
    let p90 = percentile_sorted(&ending_wealths, 0.9);

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
        "yearsFunded": if base_spend > 0.0 { (start_balances.total() / base_spend).round() } else { 0.0 },
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
    let diagnostics = if output_level == "policy_mining_summary" {
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
            "yearsFunded": if base_spend > 0.0 { (start_balances.total() / base_spend).round() } else { 0.0 },
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
