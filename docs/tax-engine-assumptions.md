# Tax-engine plan-year assumptions

What the current engine encodes and when it needs to be updated. Source of truth is [src/rule-packs.ts](../src/rule-packs.ts), which feeds [src/tax-engine.ts](../src/tax-engine.ts), [src/retirement-rules.ts](../src/retirement-rules.ts), [src/contribution-engine.ts](../src/contribution-engine.ts), and [src/healthcare-premium-engine.ts](../src/healthcare-premium-engine.ts).

## Active rule pack

- **Version**: `current-law-2026-v1`.
- **Scope**: 2026 federal income tax, 2026 Medicare IRMAA, 2026 employee contribution limits, HSA 2026 limits, 2026 ACA premium-tax-credit current-law cliff using 2025 FPL values for the 2026 marketplace year, statutory Social Security provisional-income thresholds, and SECURE 2.0 RMD start ages.
- **Provenance**: each rule-family in `CURRENT_LAW_2026_RULE_PACK` carries a source label and URL; tests pin the headline published values in [src/rule-packs.test.ts](../src/rule-packs.test.ts).

## Federal ordinary income tax

- **Label**: `taxYear: 2026` in `DEFAULT_TAX_ENGINE_CONFIG`.
- **Values**: 2026 IRS values from Rev. Proc. 2025-32 via `CURRENT_LAW_2026_RULE_PACK`.
- **Standard deductions**: $16,100 single / MFS, $32,200 MFJ, $24,150 HoH. **Age-65+ bump is modeled**: +$1,650 per qualifying spouse for MFJ/MFS, +$2,050 for single/HoH. Applied when `YearTaxInputs.headAge` / `spouseAge` is ≥ 65. Blindness exemption still out of scope. Simulation path passes `robAge` and `debbieAge` through automatically.
- **Brackets**: 2026 MFJ breakpoints 24,800 / 100,800 / 211,400 / 403,550 / 512,450 / 768,700; single breakpoints 12,400 / 50,400 / 105,700 / 201,775 / 256,225 / 640,600.
- **Update trigger**: when IRS publishes the next Rev. Proc. inflation adjustments, update `CURRENT_LAW_2026_RULE_PACK.federalTax` and refresh [fixtures/tax_engine_scenarios.json](../fixtures/tax_engine_scenarios.json).

## Long-term capital gains

- **Thresholds** (MFJ): 0%-rate top $98,900, 15%-rate top $613,700. Values are 2026.
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

- **Source file**: [src/rule-packs.ts](../src/rule-packs.ts) `CURRENT_LAW_2026_RULE_PACK.irmaa`, wired into `DEFAULT_IRMAA_CONFIG`.
- **Values**: 2026 CMS thresholds and surcharges. MFJ: $218k / $274k / $342k / $410k / $750k. Six tiers total. Surcharges match CMS 2026 Part B + Part D IRMAA amounts.
- **Filing-status coverage**: single, MFJ, HoH, MFS. HoH is treated as single (same thresholds). MFS has a collapsed three-tier schedule.
- **Two-year lookback** is configured (`lookbackYears: 2`) but reported tier uses whatever MAGI is passed in; the lookback is a product-level concern, not modeled inside `calculateIrmaaTier`.
- **Update trigger**: every November when CMS publishes next-year Part B / Part D IRMAA brackets. Update `DEFAULT_IRMAA_CONFIG.brackets[*]` and the surcharge literals in [src/irmaa-tier-boundaries.test.ts](../src/irmaa-tier-boundaries.test.ts).

## ACA subsidy

- **Source file**: [src/rule-packs.ts](../src/rule-packs.ts) `CURRENT_LAW_2026_RULE_PACK.aca`, wired into `DEFAULT_HEALTHCARE_PREMIUM_CONFIG`.
- **Regime**: **current-law 2026 restored 400% FPL cliff**. Enhanced ARPA/IRA subsidies are treated as expired after 2025 unless law changes; MAGI above 4.0 FPL receives no subsidy.
- **FPL values**: 2025 contiguous US figures used for the 2026 marketplace year — $15,650 (hh1), $21,150 (hh2), $26,650 (hh3), $32,150 (hh4). Extra people +$5,500 linear.
- **Contribution bands**: ≤1.33 FPL → 2.10%; 1.33–1.5 → 3.14–4.19%; 1.5–2.0 → 4.19–6.60%; 2.0–2.5 → 6.60–8.44%; 2.5–3.0 → 8.44–9.96%; 3.0–4.0 → 9.96%; >4.0 → no subsidy.
- **Subsidy formula**: `max(premiumEstimate − expectedContribution, 0)`. Subsidy is zero if either retired is false or all members are on Medicare.
- **Update trigger**: HHS publishes FPL each January; re-check ACA regime status when ARPA/IRA extensions are debated in Congress (currently set to expire Dec 2025).

## Contributions

- **Source file**: [src/rule-packs.ts](../src/rule-packs.ts) `CURRENT_LAW_2026_RULE_PACK.contributions`, wired into `DEFAULT_LIMITS`.
- **401(k) employee elective deferral**: $24,500 base limit plus $8,000 age-50 catch-up for 2026.
- **SECURE 2.0 super catch-up**: age 60-63 uses the $11,250 catch-up limit when the employer plan supports super catch-up.
- **SECURE 2.0 high-earner Roth catch-up**: if prior-year FICA wages from the sponsoring employer exceed the 2026 threshold ($150,000 for 2025 wages used in 2026), catch-up dollars are modeled as Roth-only. If the plan does not support Roth deferrals, the catch-up room is treated as unavailable rather than counted as MAGI-reducing pre-tax room.
- **HSA**: $4,400 self-only, $8,750 family, $1,000 age-55 catch-up.
- **Update trigger**: IRS retirement plan COLA notice and HSA Rev. Proc. updates.

## RMDs

- **Source**: `DEFAULT_RMD_CONFIG` in [src/retirement-rules.ts](../src/retirement-rules.ts).
- **Uniform Lifetime Table**: 2022 IRS table embedded verbatim (ages 72–120). This matches the current table; last update was November 2020.
- **Start age**: SECURE 2.0 logic encoded: age 73 for those born 1951–1959, age 75 for those born 1960+. Pre-1950 birth returns age 72 (consistent with earlier SECURE 1.0 rule, but this cohort is mostly past their start date anyway).
- **Update trigger**: if IRS republishes Uniform Lifetime Table (unlikely soon) or Congress shifts the start age again.

## Additional Medicare tax

- **IRC §1401(b)**, 0.9% on wages above filing-status threshold. Statutory thresholds, not indexed.
- MFJ: $250,000 / Single / HoH: $200,000 / MFS: $125,000.
- Applies ONLY to wages (Medicare wages on W-2), not to retirement distributions, SS, LTCG, dividends, or interest.
- Zero impact on the target household post-retirement (no wages). Non-zero for still-working high-wage households.
- Result is included in `federalTax` and also surfaced as a separate `additionalMedicareTax` output field.

## Not modeled

Known gaps that silently bias outputs:
- **State income tax**. User is in TX (no state income tax) so current plan unaffected, but a move would matter.
- **QBI deduction** (pass-through business income). Not applicable here.
- **Social Security wage base cap and WEP/GPO** for specific pension interactions. Not typical for this household.
- **Blindness exemption** (additional standard deduction if legally blind). Mirrors the age-65 bump structurally but not implemented.

## Testing coverage

- [src/rule-packs.test.ts](../src/rule-packs.test.ts) — published 2026 values and default-config wiring.
- [src/tax-engine-scenarios.test.ts](../src/tax-engine-scenarios.test.ts) — 20 canonical cases from [fixtures/tax_engine_scenarios.json](../fixtures/tax_engine_scenarios.json), covering W-2, SS inclusion bands, LTCG stacking, MFS, HoH, tax-exempt muni interest, age-65+ std-ded bump, and NIIT (below threshold, excess-binds, NII-binds).
- [src/irmaa-tier-boundaries.test.ts](../src/irmaa-tier-boundaries.test.ts) — every tier boundary just-under / just-over for MFJ, single, MFS; sanity checks for HoH.
- [src/social-security-taxation.test.ts](../src/social-security-taxation.test.ts) — band boundaries for MFJ and single; MFS special case; 85%-cap enforcement; monotonicity invariant over stress inputs.
- [src/aca-subsidy-boundaries.test.ts](../src/aca-subsidy-boundaries.test.ts) — each FPL band endpoint for household 2 and 4; retirement/medicare gating; IRMAA passthrough; monotonicity of subsidy vs MAGI.
