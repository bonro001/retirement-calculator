//! Federal tax + IRMAA tier math.
//!
//! Simplified port of the TS `tax-engine.ts`. Captures the dominant
//! effects (standard deduction, ordinary brackets, LTCG brackets,
//! IRMAA tier surcharge) while skipping the long tail (SS taxation
//! rules, additional Medicare tax, NIIT) that affects fewer households.
//!
//! Accuracy note: tax brackets here are MFJ 2026; head-of-household,
//! single, and MFS would need their own tables in a future iteration.
//! All values from `DEFAULT_TAX_ENGINE_CONFIG` in tax-engine.ts so
//! parity with TS is achievable as we ramp accuracy.

const ORDINARY_INF: f64 = f64::INFINITY;

/// Tax bracket: applies `rate` to taxable income up to `upTo` (cumulative).
#[derive(Debug, Clone, Copy)]
pub struct Bracket {
    pub up_to: f64,
    pub rate: f64,
}

/// MFJ 2026 ordinary income brackets. Mirror of TS DEFAULT_TAX_ENGINE_CONFIG.
pub const MFJ_ORDINARY_BRACKETS: &[Bracket] = &[
    Bracket {
        up_to: 23_200.0,
        rate: 0.10,
    },
    Bracket {
        up_to: 94_300.0,
        rate: 0.12,
    },
    Bracket {
        up_to: 201_050.0,
        rate: 0.22,
    },
    Bracket {
        up_to: 383_900.0,
        rate: 0.24,
    },
    Bracket {
        up_to: 487_450.0,
        rate: 0.32,
    },
    Bracket {
        up_to: 731_200.0,
        rate: 0.35,
    },
    Bracket {
        up_to: ORDINARY_INF,
        rate: 0.37,
    },
];

pub const MFJ_STANDARD_DEDUCTION: f64 = 29_200.0;

/// MFJ LTCG thresholds: 0% rate up to first, 15% up to second, 20% above.
pub const MFJ_LTCG_ZERO_TOP: f64 = 94_050.0;
pub const MFJ_LTCG_FIFTEEN_TOP: f64 = 583_750.0;

/// IRMAA Medicare premium surcharge tiers (MFJ 2026, monthly per-person).
/// Source: same constants used in CockpitScreen.tsx hard-stops radar.
/// Households cross a tier when their AGI from 2 years prior exceeds
/// the ceiling; we use current-year AGI as approximation.
#[derive(Debug, Clone, Copy)]
pub struct IrmaaTier {
    pub name: &'static str,
    pub magi_ceiling: f64,
    /// Per-person monthly surcharge.
    pub surcharge_per_person_monthly: f64,
}

pub const IRMAA_TIERS_MFJ: &[IrmaaTier] = &[
    IrmaaTier {
        name: "Tier 0 (no surcharge)",
        magi_ceiling: 206_000.0,
        surcharge_per_person_monthly: 0.0,
    },
    IrmaaTier {
        name: "Tier 1",
        magi_ceiling: 258_000.0,
        surcharge_per_person_monthly: 74.0,
    },
    IrmaaTier {
        name: "Tier 2",
        magi_ceiling: 322_000.0,
        surcharge_per_person_monthly: 184.0,
    },
    IrmaaTier {
        name: "Tier 3",
        magi_ceiling: 386_000.0,
        surcharge_per_person_monthly: 295.0,
    },
    IrmaaTier {
        name: "Tier 4",
        magi_ceiling: 750_000.0,
        surcharge_per_person_monthly: 405.0,
    },
    IrmaaTier {
        name: "Tier 5",
        magi_ceiling: f64::INFINITY,
        surcharge_per_person_monthly: 444.0,
    },
];

/// Apply progressive brackets. Returns total tax owed.
fn apply_brackets(taxable: f64, brackets: &[Bracket]) -> f64 {
    if taxable <= 0.0 {
        return 0.0;
    }
    let mut tax = 0.0;
    let mut prev_top = 0.0;
    for b in brackets {
        if taxable <= prev_top {
            break;
        }
        let segment = taxable.min(b.up_to) - prev_top;
        if segment > 0.0 {
            tax += segment * b.rate;
        }
        prev_top = b.up_to;
    }
    tax
}

/// Federal tax for one year. Inputs:
///   ordinary_income: salary + SS + ordinary withdrawal income + ordinary windfalls
///   ltcg_income: long-term capital gains (taxable account withdrawals, etc.)
///
/// Returns total federal tax. Does NOT model:
///   - Social Security taxability rules (we treat full SS as ordinary)
///   - Additional Medicare tax (0.9% over $250k MFJ)
///   - Net Investment Income Tax (3.8%)
///   - State income tax (TX household → no state tax anyway)
pub fn calculate_federal_tax(ordinary_income: f64, ltcg_income: f64) -> f64 {
    // Standard deduction is applied to the taxable side first.
    let taxable_ordinary = (ordinary_income - MFJ_STANDARD_DEDUCTION).max(0.0);
    let ord_tax = apply_brackets(taxable_ordinary, MFJ_ORDINARY_BRACKETS);

    // LTCG stacks on top of ordinary income for bracket determination.
    // 0% rate applies to LTCG falling in the 0-bracket window (between
    // taxable_ordinary and MFJ_LTCG_ZERO_TOP); 15% to LTCG in the next
    // window; 20% above. Standard deduction was already used by ordinary.
    let ltcg = ltcg_income.max(0.0);
    let zero_window = (MFJ_LTCG_ZERO_TOP - taxable_ordinary).max(0.0);
    let zero_portion = ltcg.min(zero_window);
    let after_zero = ltcg - zero_portion;
    let fifteen_window = (MFJ_LTCG_FIFTEEN_TOP - (taxable_ordinary + zero_portion)).max(0.0);
    let fifteen_portion = after_zero.min(fifteen_window);
    let twenty_portion = after_zero - fifteen_portion;

    let ltcg_tax = fifteen_portion * 0.15 + twenty_portion * 0.20;

    ord_tax + ltcg_tax
}

/// Look up the IRMAA tier for a given MAGI. Returns the tier struct.
pub fn irmaa_tier_for_magi(magi: f64) -> &'static IrmaaTier {
    for tier in IRMAA_TIERS_MFJ {
        if magi <= tier.magi_ceiling {
            return tier;
        }
    }
    // Should never reach here since the last tier is INFINITY.
    &IRMAA_TIERS_MFJ[IRMAA_TIERS_MFJ.len() - 1]
}

/// IRMAA surcharge dollar amount for one year, given MAGI and how
/// many household members are Medicare-eligible (≥65).
pub fn irmaa_surcharge_annual(magi: f64, medicare_eligible_count: u32) -> f64 {
    let tier = irmaa_tier_for_magi(magi);
    tier.surcharge_per_person_monthly * 12.0 * medicare_eligible_count as f64
}
