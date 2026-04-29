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
//!     their landing year. Tax treatment NOT yet modeled — they're
//!     all treated as cash inflows for now.
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
pub fn run_trial(
    plan: &PlanInput,
    assumptions: &AssumptionsInput,
    seed: u64,
) -> TrialResult {
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

        // Annual spend (pre-guardrail). Grows with cumulative inflation.
        let baseline_nominal_spend = plan.annual_spend_today_dollars * inflation_index;

        // ── Guardrail evaluation (start-of-year, before drawing) ──
        // Funded years = totalAssets / annual_spend. If below floor,
        // activate the optional+travel cut. If above ceiling, release.
        // Hysteresis avoids thrashing when assets bobble around the
        // floor across consecutive years.
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
        let nominal_spend = if optional_cut_active {
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

        // 401k contributions during salary years.
        let employee_401k_contrib = if salary_gross > 0.0 {
            (salary_gross * plan.employee_401k_pretax_percent).min(23_500.0)
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

        // Salary that actually arrives in the household (post-401k).
        let salary = salary_gross - employee_401k_contrib;
        // Total cash income (windfalls land in cash regardless of taxability).
        let total_income = salary + ss_income + windfalls.cash_inflow;

        // ── Roth conversion (low-income bridge years) ────────────
        // Only count TAXABLE income for the conversion target — cash
        // inheritance doesn't push MAGI, so we should still convert
        // even in inheritance years. Salary + SS + ordinary windfalls
        // are the MAGI base.
        let medicare_eligible_for_conv = count_medicare_eligible(plan, year);
        let taxable_income_pre_conv = salary + ss_income + windfalls.ordinary;
        let conv_target = if medicare_eligible_for_conv > 0 {
            // Stay within IRMAA Tier 1 by a $2k buffer.
            (tax::IRMAA_TIERS_MFJ[0].magi_ceiling - 2_000.0 - taxable_income_pre_conv).max(0.0)
        } else {
            // Pre-Medicare: target the ACA cliff (~$80k inflation-adjusted).
            (80_000.0 * inflation_index - taxable_income_pre_conv).max(0.0)
        };
        // Don't convert during salary years (income already high).
        // Don't convert if pretax balance is small.
        let roth_conversion = if salary > 0.0 || balances.pretax < 5_000.0 {
            0.0
        } else {
            conv_target.min(balances.pretax)
        };
        balances.pretax -= roth_conversion;
        balances.roth += roth_conversion;

        // ── Tax & IRMAA ───────────────────────────────────────────
        // Ordinary income for tax: salary + SS + ordinary windfalls + Roth conversion.
        // Cash inheritance does NOT count.
        let ordinary_income_pre_withdrawal =
            salary + ss_income + windfalls.ordinary + roth_conversion;
        let pre_withdrawal_tax = tax::calculate_federal_tax(
            ordinary_income_pre_withdrawal,
            windfalls.ltcg,
        );

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
        // the LTC age window for either spouse. Approximation: trigger
        // for whichever spouse hits start_age first.
        let ltc_cost = if ltc_will_occur {
            let rob_age = plan.rob_birth_year.map(|by| year - by).unwrap_or(0);
            let debbie_age = plan.debbie_birth_year.map(|by| year - by).unwrap_or(0);
            let in_ltc_window = (rob_age >= plan.ltc_start_age as i32
                && rob_age < (plan.ltc_start_age + plan.ltc_duration_years) as i32)
                || (debbie_age >= plan.ltc_start_age as i32
                    && debbie_age < (plan.ltc_start_age + plan.ltc_duration_years) as i32);
            if in_ltc_window {
                plan.ltc_annual_cost_today * medical_inflation_index
            } else {
                0.0
            }
        } else {
            0.0
        };

        let healthcare_total = aca_premium + medicare_premium + ltc_cost;

        // Net cash need: nominal spend + healthcare + tax + IRMAA − income.
        let net_need = nominal_spend + healthcare_total + pre_withdrawal_tax + irmaa - total_income;

        let (withdraw_cash, withdraw_taxable, withdraw_pretax, withdraw_roth);
        if net_need <= 0.0 {
            // Surplus year — banking leftover income into taxable.
            balances.taxable += -net_need;
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
            let pretax_cap = compute_pretax_cap(
                magi,
                medicare_eligible,
                magi < 80_000.0 * inflation_index,
            );
            let pretax_first = pretax_cap.min(needed).min(balances.pretax);
            balances.pretax -= pretax_first;
            needed -= pretax_first;

            let roth_taken = take_from(&mut balances.roth, &mut needed);

            // If still short, fall through to remaining pretax even
            // though it crosses an IRMAA tier — better to pay the
            // surcharge than to deplete.
            let pretax_overflow = take_from(&mut balances.pretax, &mut needed);

            withdraw_cash = cash_taken;
            withdraw_taxable = taxable_taken;
            withdraw_pretax = pretax_first + pretax_overflow;
            withdraw_roth = roth_taken;

            if needed > 0.001 && success {
                success = false;
                failure_year = Some(year);
            }
        }

        yearly.push(TraceRow {
            year,
            total_assets: balances.total(),
            // Engine's "spending" trace is the realized full nominal spend
            // (post-income, what actually went out the door). Match that.
            spending: nominal_spend.min(total_income + withdraw_cash + withdraw_taxable + withdraw_pretax + withdraw_roth),
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
    /// Net cash arriving in the household this year (always added to
    /// the cash bucket regardless of tax treatment).
    pub cash_inflow: f64,
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
        let treatment = w.tax_treatment.as_deref()
            .or_else(|| match w.name.as_str() {
                "inheritance" => Some("cash_non_taxable"),
                "home_sale" => Some("primary_home_sale"),
                _ => Some("cash_non_taxable"),
            });
        match treatment {
            Some("cash_non_taxable") => {
                totals.cash_inflow += amount;
            }
            Some("ordinary_income") => {
                totals.cash_inflow += amount;
                totals.ordinary += amount;
            }
            Some("ltcg") => {
                totals.cash_inflow += amount;
                totals.ltcg += amount;
            }
            Some("primary_home_sale") => {
                // MFJ exclusion: first $500k of gain is tax-free.
                // We approximate gain = full sale amount (no cost basis
                // tracked yet). Anything above the exclusion lands as LTCG.
                totals.cash_inflow += amount;
                let taxable_gain = (amount - 500_000.0).max(0.0);
                totals.ltcg += taxable_gain;
            }
            _ => {
                totals.cash_inflow += amount;
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
