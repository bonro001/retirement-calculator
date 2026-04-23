# Tax-engine plan-year assumptions

What the current engine encodes and when it needs to be updated. Source of truth is [src/tax-engine.ts](../src/tax-engine.ts), [src/retirement-rules.ts](../src/retirement-rules.ts), and [src/healthcare-premium-engine.ts](../src/healthcare-premium-engine.ts).

## Federal ordinary income tax

- **Label**: `taxYear: 2026` in `DEFAULT_TAX_ENGINE_CONFIG`.
- **Values**: 2024 IRS brackets (the 2024 TCJA bracket schedule still in effect as of writing; 2025 and 2026 inflation-adjusted values will differ).
- **Standard deductions**: 2024 values — $14,600 single / MFS, $29,200 MFJ, $21,900 HoH. **Age-65+ bump is modeled** as of the current engine version: +$1,550 per qualifying spouse for MFJ/MFS, +$1,950 for single/HoH (IRC §63(f), 2024 amounts). Applied when `YearTaxInputs.headAge` / `spouseAge` is ≥ 65. Blindness exemption still out of scope. Simulation path passes `robAge` and `debbieAge` through automatically.
- **Brackets**: 2024 MFJ breakpoints 23,200 / 94,300 / 201,050 / 383,900 / 487,450 / 731,200; single halves most of these as usual.
- **Update trigger**: when 2025 and 2026 inflation-adjusted IRS numbers are published (Rev. Proc. releases), update `profiles.<status>.standardDeduction` and `ordinaryBrackets[].upTo`. Also update all `expected` values in [fixtures/tax_engine_scenarios.json](../fixtures/tax_engine_scenarios.json).

## Long-term capital gains

- **Thresholds** (MFJ): 0%-rate top $94,050, 15%-rate top $583,750. Values are 2024.
- **Stacking**: LTCG stacks on top of ordinary taxable income for bracket lookup; the engine implements this correctly in `calculateLTCGTax`.
- **NIIT is modeled**: 3.8% on the lesser of net investment income or MAGI excess over threshold (IRC §1411). Thresholds are statutory ($250k MFJ, $125k MFS, $200k single/HoH) and not indexed. NII includes taxable interest, qualified + ordinary dividends, realized LTCG and STCG; muni interest is correctly excluded. Result is included in `federalTax` and also surfaced as a separate `netInvestmentIncomeTax` output field.
- **Update trigger**: new LTCG thresholds each year.

## Social Security taxation

- **Provisional income**: `ordinaryExcludingSS + preferentialIncome + taxExemptInterest + 0.5 × SS`. Matches Pub 915 worksheet.
- **Inclusion bands (MFJ)**: 0% below $32k, 50% band $32k–$44k, 85% above.
- **85% cap**: never tax more than 85% of benefits.
- **MFS living-with-spouse**: all thresholds 0 → all SS immediately in 85% tier. Matches Pub 915 special rule for MFS living with spouse.
- **Provisional-income thresholds are NOT indexed**. These values are set in statute and do not inflate. No update needed for plan-year rollovers.

## IRMAA tiers

- **Source file**: [src/retirement-rules.ts](../src/retirement-rules.ts) `DEFAULT_IRMAA_CONFIG`.
- **Values**: 2025-era thresholds (tax year label 2026, two-year look-back). MFJ: $218k / $274k / $342k / $410k / $750k. Six tiers total. Surcharges are 2025 published Part B + Part D IRMAA amounts.
- **Filing-status coverage**: single, MFJ, HoH, MFS. HoH is treated as single (same thresholds). MFS has a collapsed three-tier schedule.
- **Two-year lookback** is configured (`lookbackYears: 2`) but reported tier uses whatever MAGI is passed in; the lookback is a product-level concern, not modeled inside `calculateIrmaaTier`.
- **Update trigger**: every November when CMS publishes next-year Part B / Part D IRMAA brackets. Update `DEFAULT_IRMAA_CONFIG.brackets[*]` and the surcharge literals in [src/irmaa-tier-boundaries.test.ts](../src/irmaa-tier-boundaries.test.ts).

## ACA subsidy

- **Source file**: [src/healthcare-premium-engine.ts](../src/healthcare-premium-engine.ts) `DEFAULT_HEALTHCARE_PREMIUM_CONFIG`.
- **Regime**: **post-ARPA/IRA**. Continuous 8.5% cap above 400% FPL, **no hard cliff**. This regime is scheduled to sunset at the end of 2025 unless extended by legislation — if it reverts to the pre-ARPA 400% cliff, the engine will silently over-subsidize MAGI > 4.0 FPL households.
- **FPL values**: 2025 contiguous US figures — $15,650 (hh1), $21,150 (hh2), $26,650 (hh3), $32,150 (hh4). Extra people +$5,500 linear (hardcoded, not IRS official which is +$5,530 for 2025 — small gap).
- **Contribution bands**: ≤1.5 FPL → 0%; 1.5–2.0 → 0–2% linear; 2.0–2.5 → 2–4%; 2.5–3.0 → 4–6%; 3.0–4.0 → 6–8.5%; >4.0 → 8.5% flat.
- **Subsidy formula**: `max(premiumEstimate − expectedContribution, 0)`. Subsidy is zero if either retired is false or all members are on Medicare.
- **Update trigger**: HHS publishes FPL each January; re-check ACA regime status when ARPA/IRA extensions are debated in Congress (currently set to expire Dec 2025).

## RMDs

- **Source**: `DEFAULT_RMD_CONFIG` in [src/retirement-rules.ts](../src/retirement-rules.ts).
- **Uniform Lifetime Table**: 2022 IRS table embedded verbatim (ages 72–120). This matches the current table; last update was November 2020.
- **Start age**: SECURE 2.0 logic encoded: age 73 for those born 1951–1959, age 75 for those born 1960+. Pre-1950 birth returns age 72 (consistent with earlier SECURE 1.0 rule, but this cohort is mostly past their start date anyway).
- **Update trigger**: if IRS republishes Uniform Lifetime Table (unlikely soon) or Congress shifts the start age again.

## Not modeled

Known gaps that silently bias outputs:

- **Additional Medicare tax** (0.9% on wages above $250k MFJ). Under-taxes high-wage earners. Not yet in scope because the target household no longer has high-wage income post-retirement.
- **State income tax**. User is in TX (no state income tax) so current plan unaffected, but a move would matter.
- **QBI deduction** (pass-through business income). Not applicable here.
- **Social Security wage base cap and WEP/GPO** for specific pension interactions. Not typical for this household.
- **Blindness exemption** (additional standard deduction if legally blind). Mirrors the age-65 bump structurally but not implemented.

## Testing coverage

- [src/tax-engine-scenarios.test.ts](../src/tax-engine-scenarios.test.ts) — 20 canonical cases from [fixtures/tax_engine_scenarios.json](../fixtures/tax_engine_scenarios.json), covering W-2, SS inclusion bands, LTCG stacking, MFS, HoH, tax-exempt muni interest, age-65+ std-ded bump, and NIIT (below threshold, excess-binds, NII-binds).
- [src/irmaa-tier-boundaries.test.ts](../src/irmaa-tier-boundaries.test.ts) — every tier boundary just-under / just-over for MFJ, single, MFS; sanity checks for HoH.
- [src/social-security-taxation.test.ts](../src/social-security-taxation.test.ts) — band boundaries for MFJ and single; MFS special case; 85%-cap enforcement; monotonicity invariant over stress inputs.
- [src/aca-subsidy-boundaries.test.ts](../src/aca-subsidy-boundaries.test.ts) — each FPL band endpoint for household 2 and 4; retirement/medicare gating; IRMAA passthrough; monotonicity of subsidy vs MAGI.
