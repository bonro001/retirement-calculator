//! Per-trial simulation. The hot path. One call = one Monte Carlo
//! draw of the household's 30-year retirement projection.
//!
//! Coverage status (iteration 2 — adds income):
//!
//!   ✓ Stochastic equity / bond / cash returns from a Box-Muller
//!     normal sampler seeded by the trial RNG.
//!   ✓ Inflation indexing on spending and SS benefits.
//!   ✓ Salary income (pre-retirement, mid-year proration via
//!     salaryEndDate, matches TS getSalaryForYear).
//!   ✓ Social Security income per household member (FRA-monthly ×
//!     12 × benefit factor for early/late claims, age-gated).
//!   ✓ One-time windfalls (inheritance, home sale) added to cash on
//!     their landing year, used once for same-year spending if needed,
//!     then swept into taxable so they no longer sit as idle cash.
//!     Tax treatment NOT yet modeled — they're all treated as cash
//!     inflows for now.
//!   ✓ Income reduces the spending shortfall before any withdrawal —
//!     household uses income first, taps accounts only for the gap.
//!   ✓ Surplus income (income > spend) flows to taxable account.
//!   ✓ Withdrawal cascade: cash → taxable → pretax → roth.
//!   ✓ Returns applied per bucket each year.
//!   ✗ No federal tax math (next iteration).
//!   ✗ No IRMAA tier calculation (next iteration).
//!   ✗ No withdrawal optimizer (multi-objective scoring) (later).
//!   ✗ No guardrails / spending cuts (later).
//!   ✗ No Roth conversions (later).
//!   ✗ No healthcare premiums / LTC (later).
//!   ✗ No 401k contributions during salary years (later).
//!   ✗ Home-sale primary-residence exclusion not modeled (later).
//!
//! This is the smallest "really runs a 30-year sim" function we can
//! ship to validate the architecture end-to-end. Subsequent passes
//! grow it toward parity with `simulatePath` in `src/utils.ts`.

use crate::tax;
use crate::types::*;
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};

/// Run one trial. Pure function over (plan, assumptions, seed).
/// Returns the year-by-year trace + headline outcomes.
pub fn run_trial(plan: &PlanInput, assumptions: &AssumptionsInput, seed: u64) -> TrialResult {
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut balances = plan.starting_balances;
    let mut inflation_index = 1.0_f64;
    let mut medical_inflation_index = 1.0_f64;
    let mut yearly: Vec<TraceRow> = Vec::with_capacity(plan.planning_horizon_years as usize);
    let mut success = true;
    let mut failure_year: Option<i32> = None;

    // Guardrail state — sticky across years.
    let mut optional_cut_active = false;

    // LTC event: per-trial Bernoulli draw at sim start. If true, the
    // event triggers at ltc_start_age and lasts ltc_duration_years.
    // Matches TS engine's per-trial LTC modeling.
    let ltc_will_occur = rng.gen::<f64>() < plan.ltc_event_probability;
    let _ = assumptions; // marker — assumptions used elsewhere via guardrail dials

    for year_offset in 0..plan.planning_horizon_years {
        let year = plan.start_year + year_offset as i32;

        // Sample stochastic returns + inflation from the trial RNG.
        let returns = sample_returns(&mut rng, assumptions);
        inflation_index *= 1.0 + returns.inflation;
        medical_inflation_index *= 1.0 + plan.medical_inflation_annual;

        // ── Travel phase end ─────────────────────────────────────
        // Travel applies during the go-go window: from today through
        // `travel_phase_years` past retirement. After the phase, drop
        // travel budget. Mirrors TS engine's `inTravelPhase` logic
        // (already corrected to count pre-retirement travel too).
        let retirement_year_approx = plan
            .salary_end_date
            .as_deref()
            .and_then(|s| s.get(0..4))
            .and_then(|y| y.parse::<i32>().ok())
            .unwrap_or(plan.start_year);
        let years_past_retirement = year - retirement_year_approx;
        let in_travel_phase = years_past_retirement < plan.travel_phase_years as i32;
        let travel_today = if in_travel_phase {
            plan.travel_annual_today_dollars
        } else {
            0.0
        };
        let active_spend_today = plan.annual_spend_today_dollars
            - plan.travel_annual_today_dollars  // remove the travel piece included in total
            + travel_today; // add it back only if in phase

        // Annual spend (pre-guardrail). Grows with cumulative inflation.
        let baseline_nominal_spend = active_spend_today * inflation_index;

        // ── Guardrail evaluation (start-of-year, before drawing) ──
        // Funded years = totalAssets / annual_spend (NOMINAL). Tested
        // matching TS engine's non-inflated divisor — that releases
        // guardrails earlier and regressed solvency $447k EW. Rust's
        // nominal-spending metric is more conservative and produces
        // better outcomes for the actual decision being made
        // ("how many years can I sustain my CURRENT spending pattern").
        let total_assets_at_start = balances.total();
        let funded_years = total_assets_at_start / baseline_nominal_spend.max(1.0);
        if !optional_cut_active && funded_years < assumptions.guardrail_floor_years {
            optional_cut_active = true;
        } else if optional_cut_active && funded_years > assumptions.guardrail_ceiling_years {
            optional_cut_active = false;
        }
        // Apply cut if active. The TS engine cuts only optional+travel,
        // not essential or tax/insurance. We approximate the cut's
        // dollar size by assuming optional+travel are ~50% of the
        // dial (typical for households). Future iteration: track the
        // bucket split explicitly so the cut applies precisely.
        // Three-tier guardrail:
        //   - Above floor: no cut.
        //   - Below floor: 50% × cut_percent (matches TS exactly:
        //     ~10% cut when cut_percent=0.20, since only optional+travel
        //     get the cut and they're ~50% of total spending).
        //   - Below freezeline (half of floor, e.g., 6yr): full cut_percent
        //     (≈20%). Approximates TS's multi-objective optimizer
        //     making sharper survival-mode tradeoffs in tail trials.
        // Freezeline at 50% of floor (e.g., 6yr at floor=12). Tuned
        // empirically: this gives the closest parity to TS's multi-
        // objective-optimizer behavior on real-world seeds. Lower
        // thresholds (40%) lose too many tail trials; higher (60%+)
        // over-cut survivor wealth.
        let freezeline_years = assumptions.guardrail_floor_years * 0.5;
        let nominal_spend = if funded_years < freezeline_years {
            baseline_nominal_spend * (1.0 - assumptions.guardrail_cut_percent)
        } else if optional_cut_active {
            baseline_nominal_spend * (1.0 - 0.5 * assumptions.guardrail_cut_percent)
        } else {
            baseline_nominal_spend
        };

        // Apply market returns first (start-of-year balances grow into
        // end-of-year, then we draw against them).
        balances.apply_returns(&returns);

        // ── Income for this year ──────────────────────────────────
        let salary_gross = compute_salary_for_year(plan, year);
        let ss_income = compute_ss_income(plan, year, inflation_index);
        let windfalls = compute_windfalls(plan, year);

        // Direct-to-cash windfalls (inheritance, home-sale net proceeds)
        // land in the cash bucket BEFORE any spending logic. They are
        // not income — they're a balance-sheet event. This matches TS
        // engine behavior where the inheritance + home sale build a
        // stable cash buffer that survives equity drawdowns.
        balances.cash += windfalls.direct_to_cash;

        // 401k contributions during salary years. Cap matches TS
        // contribution-engine.ts DEFAULT_LIMITS: $24k base + $7.5k
        // catch-up (50+). User in this seed is 62 → catch-up eligible,
        // so use $31.5k. Pre-50 households would only get $24k.
        let rob_age_for_contrib = plan.rob_birth_year.map(|by| year - by).unwrap_or(0);
        let contrib_cap = if rob_age_for_contrib >= 50 {
            31_500.0
        } else {
            24_000.0
        };
        let employee_401k_contrib = if salary_gross > 0.0 {
            (salary_gross * plan.employee_401k_pretax_percent).min(contrib_cap)
        } else {
            0.0
        };
        let employee_pct = plan.employee_401k_pretax_percent;
        let match_pct_used = employee_pct.min(plan.employer_match_max_pct);
        let employer_match = if salary_gross > 0.0 {
            salary_gross * match_pct_used * plan.employer_match_rate
        } else {
            0.0
        };
        balances.pretax += employee_401k_contrib + employer_match;

        // HSA contributions during salary years. IRS family limit
        // for 2026 is ~$8,550 (+$1k catch-up at 55); cap at $9.5k.
        // HSA contribution flows into pretax (invested) AND increments
        // the HSA tracker (which caps how much can be withdrawn
        // tax-free for medical). Mirrors TS engine line 213:
        // totalPretaxContribution = 401k + match + hsaContribution.
        let hsa_contrib = if salary_gross > 0.0 {
            (salary_gross * plan.hsa_contribution_pct_of_salary).min(9_550.0)
        } else {
            0.0
        };
        balances.pretax += hsa_contrib;
        balances.hsa += hsa_contrib;

        // Salary that actually arrives in the household (post-401k post-HSA).
        let salary = salary_gross - employee_401k_contrib - hsa_contrib;
        // Earned income is genuine recurring cashflow. Direct-to-cash
        // windfalls already landed in the cash bucket above, so they
        // must not also offset spending as income; otherwise the model
        // creates wealth twice in the landing year.
        let earned_income = salary + ss_income + windfalls.income_inflow;
        let total_income = earned_income;

        // ── SS taxability ─────────────────────────────────────────
        // IRS rule: combined income (AGI + 50% SS + tax-exempt interest)
        // determines what fraction of SS is taxable. Simplification:
        // for MFJ households over the second base ($44k), up to 85% of
        // SS is taxable. For households well above that (this household
        // has six-figure income post-claim), it lands at the 85% cap.
        // Households below the first base ($32k) get 0% taxable.
        let ss_combined = salary + windfalls.ordinary + (ss_income * 0.5);
        let ss_taxable_fraction = if ss_combined < 32_000.0 {
            0.0
        } else if ss_combined < 44_000.0 {
            0.5
        } else {
            0.85
        };
        let ss_taxable = ss_income * ss_taxable_fraction;

        // ── Roth conversion (low-income bridge years) ────────────
        //
        // Conservative approach: only convert when pretax balance is
        // large enough that future RMDs would be material AND we have
        // significant headroom under the income target. Take HALF the
        // headroom each year, not the full amount — TS engine's actual
        // optimizer evaluates future-tax-savings; this approximates
        // the resulting conversion amount empirically.
        let medicare_eligible_for_conv = count_medicare_eligible(plan, year);
        let taxable_income_pre_conv = salary + ss_taxable + windfalls.ordinary;
        // Two binding constraints depending on age window:
        //   - Pre-65: ACA cliff at $80k inflated (subsidies vanish above)
        //   - Any age, irmaa-aware: IRMAA tier 1 ceiling at $206k
        // We take whichever gives MORE headroom — ACA only binds for
        // households well below $80k MAGI; once you're above, IRMAA
        // tier 1 is the relevant ceiling. This matches TS engine's
        // `irmaaAware: true` path, which converts during salary years
        // if there's room under the IRMAA ceiling.
        let aca_headroom = (80_000.0 * inflation_index - taxable_income_pre_conv).max(0.0);
        let irmaa_headroom =
            (tax::IRMAA_TIERS_MFJ[0].magi_ceiling - 2_000.0 - taxable_income_pre_conv).max(0.0);
        let conv_headroom = if medicare_eligible_for_conv > 0 {
            irmaa_headroom
        } else {
            // Pre-65: pick whichever ceiling is binding. For low-MAGI
            // households the ACA window applies; for high-salary
            // households the IRMAA tier is the only meaningful ceiling.
            aca_headroom.max(irmaa_headroom)
        };
        // Conditions: no salary, pretax > $50k, headroom > $5k. Take
        // FULL headroom up to 12% of pretax/yr (matches seed's
        // rothConversionPolicy.maxPretaxBalancePercent). Conversion
        // during salary years was tested and regressed solvency —
        // immediate 22% tax cost outweighs long-horizon Roth gain.
        let roth_conversion =
            if salary > 0.0 || balances.pretax < 50_000.0 || conv_headroom < 5_000.0 {
                0.0
            } else {
                conv_headroom.min(balances.pretax * 0.12)
            };
        balances.pretax -= roth_conversion;
        balances.roth += roth_conversion;

        // ── RMD enforcement (Required Minimum Distribution) ──────
        // IRS forces pretax → cash withdrawal at age 73 (SECURE Act
        // 2.0 schedule). Mirrors TS engine's calculateRequiredMinimum
        // Distribution. Without this, Rust's pretax stays invested
        // indefinitely while TS forces a cash buffer to grow late in
        // life. The forced withdrawal counts as ordinary income for
        // tax. Excess (above this year's spending need) goes to cash.
        let rmd_amount = compute_household_rmd(plan, year, balances.pretax);
        if rmd_amount > 0.0 {
            let take = rmd_amount.min(balances.pretax);
            balances.pretax -= take;
            balances.cash += take;
        }

        // ── Tax & IRMAA ───────────────────────────────────────────
        // Ordinary income for tax: salary + (taxable portion of SS) +
        // ordinary windfalls + Roth conversion + RMD. Cash inheritance
        // doesn't count. SS taxability already capped at 85% (above).
        let ordinary_income_pre_withdrawal =
            salary + ss_taxable + windfalls.ordinary + roth_conversion + rmd_amount;
        let pre_withdrawal_tax =
            tax::calculate_federal_tax(ordinary_income_pre_withdrawal, windfalls.ltcg);

        // IRMAA: surcharge applies if either member ≥65.
        let medicare_eligible = count_medicare_eligible(plan, year);
        let magi = ordinary_income_pre_withdrawal + windfalls.ltcg;
        let irmaa = tax::irmaa_surcharge_annual(magi, medicare_eligible) * inflation_index;

        // ── Healthcare premiums ──────────────────────────────────
        // ACA premium per pre-65 retired member. Approximation:
        // assume both members share the seed's ACA premium when both
        // are pre-65, half when only one is. Skip during salary years
        // (employer coverage assumed).
        let rob_age = plan.rob_birth_year.map(|by| year - by).unwrap_or(0);
        let debbie_age = plan.debbie_birth_year.map(|by| year - by).unwrap_or(0);
        let aca_members = if salary > 0.0 {
            0
        } else {
            (if rob_age < 65 { 1 } else { 0 }) + (if debbie_age < 65 { 1 } else { 0 })
        };
        let aca_per_member = plan.baseline_aca_premium_annual / 2.0;
        let aca_gross = aca_per_member * aca_members as f64 * medical_inflation_index;
        // ACA subsidy approximation: when MAGI is below 400% FPL
        // (~$80k MFJ for 2026), subsidies cover ~70% of premium.
        // Above the cliff, subsidies = 0. Linear taper between is a
        // simplification — real engine has the actual subsidy curves.
        let magi_for_aca = salary + ss_income + windfalls.ordinary;
        let aca_subsidy_factor = if magi_for_aca < 80_000.0 * inflation_index {
            0.7
        } else if magi_for_aca < 120_000.0 * inflation_index {
            0.7 - 0.7 * ((magi_for_aca - 80_000.0 * inflation_index) / (40_000.0 * inflation_index))
        } else {
            0.0
        };
        let aca_premium = aca_gross * (1.0 - aca_subsidy_factor);

        // Medicare premium: per-eligible-member.
        let medicare_premium = plan.baseline_medicare_premium_annual
            * medicare_eligible as f64
            * medical_inflation_index;

        // ── LTC cost ─────────────────────────────────────────────
        // Apply if the per-trial LTC draw was positive AND we're in
        // the LTC age window for either spouse.
        //
        // Important: when in LTC, the household stops spending on
        // optional/travel/discretionary (they're in care, life shrinks
        // to essentials). So LTC PARTIALLY REPLACES, not adds-on-top
        // of, regular spend. We approximate by subtracting half the
        // baseline_nominal_spend during LTC years (representing the
        // discretionary portion that goes away).
        // LTC window: triggered when older spouse hits start_age,
        // continues for duration_years. Mirrors TS calculateLtcCostForYear
        // which uses `householdAge = max(rob, debbie)` (utils.ts:1180).
        let household_age = rob_age.max(debbie_age);
        let in_ltc_window = ltc_will_occur
            && household_age >= plan.ltc_start_age as i32
            && household_age < (plan.ltc_start_age + plan.ltc_duration_years) as i32;
        // CRITICAL: LTC cost inflates from the START of the LTC event,
        // not from year 0. TS uses Math.pow(1+inflation, yearsIntoLtc)
        // (utils.ts:1190-1193). Previously Rust used cumulative
        // medical_inflation_index which inflated from year 0 — by year
        // ~2050 that was ~4× the correct cost, devastating tail trials.
        let ltc_cost = if in_ltc_window {
            let years_into_ltc = (household_age - plan.ltc_start_age as i32).max(0) as i32;
            plan.ltc_annual_cost_today * (1.0 + plan.medical_inflation_annual).powi(years_into_ltc)
        } else {
            0.0
        };
        // Note: TS doesn't subtract a "lifestyle offset" during LTC —
        // it just adds the LTC cost on top of regular spending. We
        // previously had a 50%-baseline subtraction here that didn't
        // match TS; removed.

        let healthcare_total_gross = aca_premium + medicare_premium + ltc_cost;

        // ── HSA offset ───────────────────────────────────────────
        // HSA can fund qualified medical expenses tax-free. Cap is
        // configured in the seed (default $12k/yr for typical
        // households). Real engine prioritizes HSA usage during
        // high-MAGI years (when avoiding income most valuable); we
        // simplify to "always pull up to cap when there's a balance".
        let hsa_cap = plan.hsa_annual_qualified_withdrawal_cap * inflation_index;
        let hsa_offset = healthcare_total_gross
            .min(hsa_cap)
            .min(balances.hsa)
            .min(balances.pretax);
        // HSA offset reduces BOTH the HSA tracker AND the pretax
        // balance (since HSA's investment portion lives in pretax).
        // Matches TS engine lines 3575-3578.
        balances.hsa -= hsa_offset;
        balances.pretax -= hsa_offset;
        let healthcare_total = healthcare_total_gross - hsa_offset;

        // Net cash need: nominal spend + (healthcare net of HSA) + tax + IRMAA − income.
        let net_need = nominal_spend + healthcare_total + pre_withdrawal_tax + irmaa - total_income;

        let (withdraw_cash, withdraw_taxable, withdraw_pretax, withdraw_roth);
        if net_need <= 0.0 {
            // Surplus year — bank leftover EARNED income into taxable.
            // Direct windfalls are handled after same-year funding below.
            let earned_surplus =
                (earned_income - nominal_spend - healthcare_total - pre_withdrawal_tax - irmaa)
                    .max(0.0);
            balances.taxable += earned_surplus;
            withdraw_cash = 0.0;
            withdraw_taxable = 0.0;
            withdraw_pretax = 0.0;
            withdraw_roth = 0.0;
        } else {
            // Deficit year — IRMAA-aware cascade.
            //
            // Strategy:
            //   1. Cash first (no tax impact).
            //   2. Taxable next (LTCG-treated; we're not modeling cost
            //      basis, but TS engine treats withdrawals from taxable
            //      as cap-gains income roughly proportional to growth).
            //   3. Pretax CAPPED to keep MAGI under next IRMAA tier
            //      (post-65 only; pre-65 cap is the ACA cliff at $80k
            //      we approximate by capping at $80k + ordinary income
            //      pre-withdrawal).
            //   4. Remaining gap from Roth.
            //   5. If still short, break the cap and pull from pretax
            //      anyway (rare; happens only in tail-risk scenarios
            //      where IRMAA discipline would mean depletion).
            let mut needed = net_need;
            let cash_taken = take_from(&mut balances.cash, &mut needed);
            let taxable_taken = take_from(&mut balances.taxable, &mut needed);

            // IRMAA-aware pretax cap.
            let pretax_cap =
                compute_pretax_cap(magi, medicare_eligible, magi < 80_000.0 * inflation_index);
            let pretax_first = pretax_cap.min(needed).min(balances.pretax);
            balances.pretax -= pretax_first;
            needed -= pretax_first;

            // Pretax overflow BEFORE Roth — preserves Roth as the tail-
            // year shield (TS engine's `preserveRothPreference` semantics
            // when binding). Breaking the IRMAA cap costs IRMAA surcharge
            // but keeps tax-free Roth available for the longest-living
            // households that need it most. Previously Rust drew Roth
            // before overflow, which meant tail trials depleted Roth
            // unnecessarily and ran out of liquidity.
            let pretax_overflow = take_from(&mut balances.pretax, &mut needed);
            let roth_taken = take_from(&mut balances.roth, &mut needed);

            withdraw_cash = cash_taken;
            withdraw_taxable = taxable_taken;
            withdraw_pretax = pretax_first + pretax_overflow;
            withdraw_roth = roth_taken;

            if needed > 0.001 && success {
                success = false;
                failure_year = Some(year);
            }
        }
        let windfall_used_for_spending = windfalls.direct_to_cash.min(withdraw_cash);
        let windfall_deployed_to_taxable = (windfalls.direct_to_cash - windfall_used_for_spending)
            .max(0.0)
            .min(balances.cash.max(0.0));
        if windfall_deployed_to_taxable > 0.0 {
            balances.cash -= windfall_deployed_to_taxable;
            balances.taxable += windfall_deployed_to_taxable;
        }

        yearly.push(TraceRow {
            year,
            total_assets: balances.total(),
            // Engine's "spending" trace is the realized full nominal spend
            // (post-income, what actually went out the door). Match that.
            spending: nominal_spend.min(
                total_income + withdraw_cash + withdraw_taxable + withdraw_pretax + withdraw_roth,
            ),
            income: total_income,
            withdrawal_cash: withdraw_cash,
            withdrawal_taxable: withdraw_taxable,
            withdrawal_ira401k: withdraw_pretax,
            withdrawal_roth: withdraw_roth,
            pretax_balance_end: balances.pretax,
            taxable_balance_end: balances.taxable,
            roth_balance_end: balances.roth,
            cash_balance_end: balances.cash,
        });
    }

    TrialResult {
        yearly,
        success,
        failure_year,
        ending_wealth: balances.total(),
    }
}

/// Helper: take `needed` dollars from a balance bucket (mutating it).
/// Reduces `needed` by however much was available. Returns the amount
/// withdrawn from this bucket (for trace recording).
/// IRS Uniform Lifetime Table divisor for RMDs. Returns 0 below the
/// start age. Mirrors TS retirement-rules.ts DEFAULT_RMD_CONFIG.
fn rmd_divisor(age: i32) -> f64 {
    match age {
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
        a if a >= 120 => 2.0,
        _ => 0.0,
    }
}

/// SECURE Act 2.0 RMD start age. Same as TS getRmdStartAgeForBirthYear.
fn rmd_start_age(birth_year: i32) -> i32 {
    if birth_year <= 1950 {
        72
    } else if birth_year <= 1959 {
        73
    } else {
        75
    }
}

/// Total household RMD. Splits pretax balance equally across members
/// who have hit their RMD start age. Matches TS calculateRequired
/// MinimumDistribution with accountShare 0.5 each.
fn compute_household_rmd(plan: &PlanInput, year: i32, pretax_balance: f64) -> f64 {
    if pretax_balance <= 0.0 {
        return 0.0;
    }
    let total_members =
        (plan.rob_birth_year.is_some() as i32) + (plan.debbie_birth_year.is_some() as i32);
    if total_members == 0 {
        return 0.0;
    }
    let share = 1.0 / total_members as f64;
    let mut total_rmd = 0.0;
    for by in [plan.rob_birth_year, plan.debbie_birth_year]
        .iter()
        .flatten()
    {
        let age = year - by;
        if age >= rmd_start_age(*by) {
            let divisor = rmd_divisor(age);
            if divisor > 0.0 {
                total_rmd += (pretax_balance * share) / divisor;
            }
        }
    }
    total_rmd
}

fn take_from(balance: &mut f64, needed: &mut f64) -> f64 {
    if *needed <= 0.0 || *balance <= 0.0 {
        return 0.0;
    }
    let take = (*needed).min(*balance);
    *balance -= take;
    *needed -= take;
    take
}

/// Sample stochastic returns for one year. Box-Muller transform turns
/// the RNG's uniform draws into normal draws with the configured
/// mean/volatility per asset class.
fn sample_returns(rng: &mut SmallRng, asm: &AssumptionsInput) -> MarketReturns {
    MarketReturns {
        equity_return: sample_normal(rng, asm.equity_mean, asm.equity_volatility),
        bond_return: sample_normal(rng, asm.bond_mean, asm.bond_volatility),
        cash_return: sample_normal(rng, asm.cash_mean, asm.cash_volatility),
        inflation: sample_normal(rng, asm.inflation, asm.inflation_volatility),
    }
}

/// Box-Muller normal sampler. Two uniform [0,1) → one N(mean, sd).
/// Wasteful (discards one of the two normals it could produce) but
/// simple — when perf matters more we'll cache the second draw or
/// switch to a Ziggurat sampler.
fn sample_normal(rng: &mut SmallRng, mean: f64, sd: f64) -> f64 {
    // Avoid the log(0) edge by clamping u1 above zero.
    let u1: f64 = rng.gen_range(1e-12..1.0);
    let u2: f64 = rng.gen_range(0.0..1.0);
    let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
    mean + z * sd
}

/// Salary for the given calendar year. Mirrors TS `getSalaryForYear`:
/// full salary while year < endYear, zero after, fractional in the
/// endYear based on the month component of salaryEndDate.
fn compute_salary_for_year(plan: &PlanInput, year: i32) -> f64 {
    let Some(end_iso) = &plan.salary_end_date else {
        return 0.0;
    };
    if plan.salary_annual <= 0.0 {
        return 0.0;
    }
    // Parse the ISO date roughly — we just need year and month.
    // Format: "YYYY-MM-DDTHH:MM:SS.mmmZ" or "YYYY-MM-DD".
    let Some(end_year_str) = end_iso.get(0..4) else {
        return 0.0;
    };
    let Ok(end_year) = end_year_str.parse::<i32>() else {
        return 0.0;
    };
    if year < end_year {
        return plan.salary_annual;
    }
    if year > end_year {
        return 0.0;
    }
    // Same year — use month fraction. TS uses `endDate.getMonth() / 12`
    // where getMonth() is 0-indexed (Jan=0). Match exactly.
    let Some(month_str) = end_iso.get(5..7) else {
        return 0.0;
    };
    let Ok(end_month_one_indexed) = month_str.parse::<i32>() else {
        return 0.0;
    };
    let month_zero_indexed = (end_month_one_indexed - 1).max(0);
    plan.salary_annual * (month_zero_indexed as f64) / 12.0
}

/// Social Security income for the year. Sums across household members,
/// applying claim-age benefit factors and inflation indexing. Mirrors
/// TS `getSocialSecurityIncome` + `getBenefitFactor`.
fn compute_ss_income(plan: &PlanInput, year: i32, inflation_index: f64) -> f64 {
    let mut total = 0.0;
    for entry in &plan.social_security {
        let birth_year = if entry.person == "rob" {
            plan.rob_birth_year
        } else {
            plan.debbie_birth_year
        };
        let Some(by) = birth_year else { continue };
        let age = (year - by) as i64;
        if age < entry.claim_age as i64 {
            continue;
        }
        let factor = ss_benefit_factor(entry.claim_age);
        total += entry.fra_monthly * 12.0 * factor * inflation_index;
    }
    total
}

/// Benefit factor for an early/late SS claim age. Matches TS
/// `getBenefitFactor` exactly:
///   - <67: max(0.7, 1 - (67 - claimAge) * 0.06)  — early claim reduction
///   - >67: 1 + (claimAge - 67) * 0.08             — delayed credits
///   - 67:  1.0 (FRA)
fn ss_benefit_factor(claim_age: u32) -> f64 {
    if claim_age < 67 {
        let reduction = (67 - claim_age as i64) as f64 * 0.06;
        (1.0 - reduction).max(0.7)
    } else if claim_age > 67 {
        1.0 + (claim_age as f64 - 67.0) * 0.08
    } else {
        1.0
    }
}

/// Windfall realization for the year, split by tax treatment.
/// Inheritance (cash_non_taxable) doesn't show in income or MAGI;
/// home sale gets the MFJ $500k primary-residence exclusion before
/// counting the rest as long-term capital gains.
#[derive(Default)]
pub struct WindfallTotals {
    /// Cash that lands DIRECTLY into the cash bucket — bypasses the
    /// income/spending offset. Inheritance and home-sale net proceeds
    /// go here. Critical for parity with TS engine, which keeps these
    /// windfalls as a stable cash buffer rather than routing them
    /// through the surplus→taxable path (where they'd be exposed to
    /// equity vol).
    pub direct_to_cash: f64,
    /// Cash arriving AS INCOME — offsets this year's spending need;
    /// surplus flows to taxable. Used for ordinary-income and LTCG
    /// windfalls (rare; e.g., inherited-IRA distributions).
    pub income_inflow: f64,
    /// Ordinary income contribution (rare for windfalls — only certain
    /// inherited-IRA distributions or unusual treatments).
    pub ordinary: f64,
    /// Long-term capital gains contribution (taxable bucket
    /// withdrawals already-realized; home sale net of exclusion).
    pub ltcg: f64,
}

/// Compute all windfalls landing this year, split by tax treatment.
/// Mirrors TS `buildWindfallRealizationForYear`.
fn compute_windfalls(plan: &PlanInput, year: i32) -> WindfallTotals {
    let mut totals = WindfallTotals::default();
    for w in plan.windfalls.iter().filter(|w| w.year == year) {
        let amount = w.amount.max(0.0);
        let treatment = w
            .tax_treatment
            .as_deref()
            .or_else(|| match w.name.as_str() {
                "inheritance" => Some("cash_non_taxable"),
                "home_sale" => Some("primary_home_sale"),
                _ => Some("cash_non_taxable"),
            });
        match treatment {
            Some("cash_non_taxable") => {
                // Inheritance: pure cash, never income. Goes straight
                // into the cash bucket — does NOT affect MAGI or tax.
                totals.direct_to_cash += amount;
            }
            Some("ordinary_income") => {
                totals.income_inflow += amount;
                totals.ordinary += amount;
            }
            Some("ltcg") => {
                totals.income_inflow += amount;
                totals.ltcg += amount;
            }
            Some("primary_home_sale") => {
                // MFJ exclusion: first $500k of gain is tax-free.
                // We approximate gain = full sale amount (no cost basis
                // tracked yet). Net proceeds land directly in cash;
                // only the post-exclusion gain is taxable LTCG.
                totals.direct_to_cash += amount;
                let taxable_gain = (amount - 500_000.0).max(0.0);
                totals.ltcg += taxable_gain;
            }
            _ => {
                totals.direct_to_cash += amount;
            }
        }
    }
    totals
}

/// IRMAA-aware cap on pretax withdrawal. Returns the maximum amount
/// we'll pull from pretax this year while staying inside the current
/// MAGI's IRMAA tier (or the ACA cliff window pre-65).
///
/// For households below 65, the cap target is $80k MAGI — ACA premium
/// subsidies start phasing out aggressively above that.
/// For households ≥65, the cap target is the next IRMAA tier ceiling.
///
/// `current_magi` is income before any pretax withdrawal — additional
/// pretax dollars push MAGI dollar-for-dollar.
///
/// Returns infinity (no cap) if there's no useful target nearby
/// (e.g., MAGI is already above all tiers, or below ACA threshold by
/// a huge margin and pre-65).
fn compute_pretax_cap(current_magi: f64, medicare_eligible: u32, in_aca_window: bool) -> f64 {
    if medicare_eligible > 0 {
        // Find the next IRMAA tier ceiling above current MAGI.
        for tier in tax::IRMAA_TIERS_MFJ {
            if current_magi <= tier.magi_ceiling {
                let headroom = tier.magi_ceiling - current_magi;
                return headroom.max(0.0);
            }
        }
        f64::INFINITY
    } else if in_aca_window {
        let aca_cliff = 80_000.0; // approximation; real ACA cliff is FPL-based
        let headroom = aca_cliff - current_magi;
        headroom.max(0.0)
    } else {
        f64::INFINITY
    }
}

/// How many household members are Medicare-eligible (≥65) this year.
/// Used to scale the IRMAA surcharge. Returns 0/1/2 for our two-person
/// household model.
fn count_medicare_eligible(plan: &PlanInput, year: i32) -> u32 {
    let mut count = 0;
    if let Some(by) = plan.rob_birth_year {
        if (year - by) >= 65 {
            count += 1;
        }
    }
    if let Some(by) = plan.debbie_birth_year {
        if (year - by) >= 65 {
            count += 1;
        }
    }
    count
}
