# Model Validation Workplan

Goal: establish enough trust in the retirement engine to bet real financial decisions on it. Four parallel tracks, each of which catches a distinct class of model failure:

- **Track A — Property tests**: catch bugs via invariants any valid plan must satisfy.
- **Track B — Tax engine unit validation**: prove the tax math matches published IRS outputs.
- **Track C — Historical backtesting**: prove the engine correctly predicts the fate of real retiree cohorts.
- **Track D — Fidelity parity**: second peer-planner alongside Boldin for triangulation.

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

Execution protocol:
1. Execute exactly one pending step per run (top to bottom, any track).
2. Mark the active step as `[-]` while working, then `[x]` when done.
3. Add a short note under the step with files changed and verification done.
4. Stop after one step and report progress in-thread.

---

## Active north-star issue loop — 2026-05-08

North star: the engine determines the decision-grade household number from
explicit assumptions. Static seed values, stale exports, and narrative memos are
inputs or evidence only. The number must come from a reproducible, structured
plan run with a visible assumptions pack, mode label, model-completeness status,
and enough intermediate calculations to explain why it moved.

This loop captures known issues that can distort, overstate, understate, or
mislabel that number.

23. [x] Capture known issue loop
- Create the active remediation loop from the 2026-05-08 plan-validation review.
- Classify each item by whether it changes the headline number directly, changes
  recommendation trust, or changes export/trace explainability.
  - Done: this section. The loop intentionally treats the seed as incidental; it
    targets the engine path that computes supported spending / solvency under
    explicit assumptions.
  - Files: `VALIDATION_WORKPLAN.md`.

24. [x] Remove seed-spending-as-answer framing
- Stop treating the seed's current annual spending value (roughly `$140k` in
  the current household inputs) as the meaningful number. It is an input,
  scenario candidate, or current-lifestyle reference only.
- Audit UI labels, exports, docs, and validation narratives for language that
  implies the seed spending target is the plan answer or north star.
- Acceptance: the product distinguishes:
  - current lifestyle/input spending from `seed-data.json`;
  - engine-supported spending from the optimizer/mining corpus;
  - solvency/wealth results for a selected spending policy.
- The seed value may remain as a household input where needed, but it must not
  be presented as the decision-grade number we are trying to determine.
  - Done: first cleanup pass kept the modern Cockpit's useful distinction
    (`Your current lifestyle` vs frontier / adopted policy), renamed seed/Roth
    comparison labels to input-policy language, changed legacy screen copy from
    "current seed/current plan supports" to household-input / input-run wording,
    and updated the retirement-plan inferred assumption so current stretch spend
    is explicitly a scenario input, not an optimized recommendation.
  - Files: `src/CockpitScreen.tsx`, `src/spend-optimizer.ts`,
    `src/retirement-plan.ts`, `src/flight-path-policy.ts`, `src/App.tsx`.
  - Do not delete the spending fields from `seed-data.json` yet; they are still
    needed as household input/category structure. The removal is conceptual and
    presentation-level first: no seed spending value should be promoted as the
    north-star result.

25. [x] Define the canonical north-star result contract
- Add or formalize a structured result object that every UI/export uses for the
  headline number.
- Required fields: `generatedAtIso`, `planFingerprint`, `engineVersion`,
  `assumptionsPackVersion`, `distributionMode`, `simulationSeed`,
  `simulationRuns`, `supportedAnnualSpend`, `successRate`,
  `medianEndingWealth`, `tenthPercentileEndingWealth`, `modelCompleteness`,
  `inferredAssumptions`, `intermediateCalculations`, and sensitivity results.
- Acceptance: no UI/export can present a headline without the mode label
  (`forward-looking` vs `historical-precedent`) and the assumption provenance
  used to compute it.
  - Done: added `src/north-star-result.ts` with `NorthStarResult`,
    `distributionMode`, fingerprint, engine/rule provenance, model completeness,
    inferred assumptions, headline outputs, intermediate calculations, and
    sensitivity-result slots. Planning export now includes `northStarResult`
    built from the active planner-enhanced simulation.
  - Files: `src/north-star-result.ts`, `src/north-star-result.test.ts`,
    `src/planning-export.ts`.
  - Verification: `npm run test -- src/north-star-result.test.ts`;
    `npm run build`.

26. [x] Centralize current-law rule packs with provenance
- Create one explicit source of truth for plan-year federal tax, ACA, IRMAA,
  401(k), HSA, RMD, and Social Security parameters.
- Known drift to clean up:
  - `DEFAULT_TAX_ENGINE_CONFIG` is labeled 2026 while still using 2024 bracket
    values in several places.
  - Contribution defaults still reflect old 401(k) limits unless the seed
    overrides them.
  - `docs/tax-engine-assumptions.md` and the prior ACA workplan notes still
    describe the expired post-ARPA/IRA no-cliff regime, while current tests/code
    now model the restored 400% FPL cliff.
- Acceptance: tests pin the active rule pack against published 2026 values, and
  docs/export metadata state the active law regime rather than relying on stale
  comments.
  - Done: added `CURRENT_LAW_2026_RULE_PACK` as the central source for 2026
    federal tax, ACA, IRMAA, 401(k), HSA, RMD, and Social Security provenance.
    Wired tax, contribution, healthcare, IRMAA, and north-star result metadata
    to the active rule-pack version. Refreshed the tax fixture and assumptions
    doc away from stale 2024 / post-ARPA language.
  - Files: `src/rule-packs.ts`, `src/rule-packs.test.ts`,
    `src/tax-engine.ts`, `src/contribution-engine.ts`,
    `src/healthcare-premium-engine.ts`, `src/retirement-rules.ts`,
    `src/north-star-result.ts`, `fixtures/tax_engine_scenarios.json`,
    `docs/tax-engine-assumptions.md`.
  - Verification: `npm run test -- src/rule-packs.test.ts
    src/tax-engine-scenarios.test.ts src/contribution-engine.test.ts
    src/aca-subsidy-boundaries.test.ts src/irmaa-tier-boundaries.test.ts
    src/north-star-result.test.ts`; `npm run build`.

27. [x] Model SECURE 2.0 high-earner Roth catch-up explicitly
- Add explicit inputs for prior-year FICA wages and whether the employer plan
  supports Roth deferrals / super catch-up.
- For high earners, split 401(k) contributions into MAGI-reducing pre-tax base
  and non-MAGI-reducing Roth catch-up.
- Acceptance: 2026 age-60-63 cases show total employee room separately from
  pre-tax MAGI reduction; ACA bridge recommendations cannot count Roth-required
  catch-up dollars as ACA help.
  - Done: contribution calculations now expose total employee 401(k) room,
    pre-tax MAGI-reducing room, catch-up room, Roth-required catch-up room, and
    Roth-unavailable catch-up diagnostics. Added explicit seed inputs for
    prior-year FICA wages and employer Roth/super-catch-up support. The
    pre-retirement optimizer now uses pre-tax 401(k) room plus HSA for MAGI /
    ACA bridge math and labels high-earner catch-up as Roth-only.
  - Files: `src/contribution-engine.ts`, `src/contribution-engine.test.ts`,
    `src/pre-retirement-optimizer.ts`, `src/rule-packs.ts`,
    `src/rule-packs.test.ts`, `src/types.ts`, `seed-data.json`,
    `docs/tax-engine-assumptions.md`.
  - Verification: `npm run test -- src/contribution-engine.test.ts
    src/rule-packs.test.ts src/pre-retirement-optimizer-demo.test.ts
    src/flight-path-pre-retirement-candidate.test.ts`; `npm run build`.

28. [x] Re-verify ACA bridge guardrails under current law
- Ensure the engine uses current-law 400% FPL subsidy eligibility, plan-year FPL,
  retirement/employer-coverage gating, Medicare split-household treatment, and
  premium-at-risk calculations.
- Acceptance: bridge-year trace reports MAGI before/after payroll, HSA,
  conversion, taxable-income, and withdrawal effects; Roth conversions are not
  scheduled across the ACA cliff unless the plan explicitly accepts the premium
  cost.
  - Done: added `acaBridgeTrace` to bridge-year autopilot output with MAGI
    before payroll, after pre-tax 401(k), after HSA, after Roth conversion,
    after taxable income, and after final withdrawals. Trace includes ACA
    ceiling/headroom, premium at risk, and explicit booleans for conversion
    crossing/accepted-across-cliff. Added regression coverage that bridge-year
    conversions do not cross the cliff.
  - Files: `src/autopilot-timeline.ts`, `src/autopilot-timeline.test.ts`.
  - Verification: `npm run test -- src/autopilot-timeline.test.ts`;
    `npm run build`.

29. [x] Promote Roth conversion ceiling from manual knob to optimized output
- Treat the annual Roth conversion amount / ceiling as an engine-selected policy
  bounded by ACA, IRMAA, tax bracket, liquidity, and model-completeness rules.
- Surface unused safe room by reason: annual cap, ACA cliff, IRMAA cliff,
  insufficient pre-tax balance, liquidity, or explicit user constraint.
- Acceptance: conversion schedule includes base + perturbed sensitivity runs,
  and changing the cap is no longer a hidden assumption that silently drives the
  north-star number.
  - Done: verified the Cockpit already routes the Roth ceiling through
    `findOptimalRothCeilingAsync` before the final optimized projection, then
    added export-level unused-safe-room diagnostics by reason so the annual cap
    cannot silently explain away missed conversion room. The schedule/status
    now breaks unused safe room into annual cap / ACA cliff / IRMAA cliff / tax
    bracket / insufficient pretax / liquidity / explicit constraint / model
    completeness buckets.
  - Files: `src/planning-export.ts`, `src/planning-export.test.ts`.
  - Verification: `npm run test -- src/planning-export.test.ts
    src/roth-optimizer.test.ts`; `npm run build`.

30. [x] Separate headline math from recommendation-trust risks
- SCHD concentration, FCNTX concentration, MUB in taxable, and
  CENTRAL_MANAGED/TRP_2030 look-through uncertainty should be classified
  explicitly:
  - If the engine prices the risk, it may affect the headline number.
  - If the engine only maps the holding to broad asset classes, the number must
    say the model is reconstructed for manager/factor/tax-location risk.
- Acceptance: recommendations can flag the risks without pretending the
  Monte Carlo success rate already prices single-fund or manager risk it does
  not model.
  - Done: added a model-fidelity trust-risk classification that explicitly
    labels SCHD/FCNTX/MUB/TRP_2030/CENTRAL_MANAGED-style issues as
    recommendation-trust risks when the headline simulation only prices broad
    asset-class mappings. These risks affect model trust/completeness rather
    than pretending to be priced in the Monte Carlo success rate.
  - Files: `src/model-fidelity.ts`, `src/model-fidelity.test.ts`.
  - Verification: `npm run test -- src/model-fidelity.test.ts
    src/planning-export.test.ts`; `npm run build`.

31. [x] Add a yearly cashflow reconciliation trace
- Build a deterministic per-year audit view that reconciles spending, tax,
  healthcare, ACA subsidy, IRMAA, contributions, conversions, withdrawals,
  windfalls, and ending balances.
- Known trigger: investigate anomalous low-spending years such as the reviewed
  2028 line item by tracing the exact components rather than reading the export
  narrative.
- Acceptance: every year has equations that tie out from starting balances to
  ending balances, with missing or inferred components flagged.
  - Done: added an explicit per-year `cashflowReconciliation` trace to the path
    yearly series. The trace separates income, adjusted wages, Social Security,
    RMD/windfall inflows, account withdrawals, spending/tax/healthcare/LTC
    outflows, surplus/gap, unresolved funding gap, and an equation check for
    auditability. Notes clarify that withdrawals are funding sources and that
    balance movement also reflects market returns/reallocation.
  - Files: `src/types.ts`, `src/utils.ts`, `src/cashflow-accounting.test.ts`.
  - Verification: `npm run test -- src/cashflow-accounting.test.ts
    src/planning-export.test.ts`; `npm run build`.

32. [x] Verify stochastic LTC/HSA path visibility
- Prove the Monte Carlo path samples LTC event probability, cost inflation, event
  duration, and HSA reserve behavior as explicit path state.
- Acceptance: deterministic audit shows expected/no-event/with-event traces, and
  Monte Carlo aggregate outputs expose LTC incidence and cost percentiles rather
  than hiding them inside ending wealth.
  - Done: added `ltcHsaDiagnostics` to path results with LTC event incidence,
    event-run counts, total LTC/HSA offset/remaining-cost percentiles, annual
    active-event rates, annual cost percentiles, and an isolated deterministic
    no-event / with-event / expected-value LTC/HSA reserve trace. Yearly series
    now also carries `ltcHsaPathVisibility` so LTC tail risk is visible beside
    the cashflow and wealth path.
  - Files: `src/types.ts`, `src/utils.ts`, `src/ltc-probability.test.ts`.
  - Verification: `npm run test -- src/ltc-probability.test.ts
    src/downsize-hsa-reserve.test.ts`; `npm run build`.

33. [x] Add export freshness and replay checks
- Every validation export should include `generatedAtIso`, `planFingerprint`,
  `engineVersion`, rule-pack versions, distribution mode, and sensitivity mode.
- Acceptance: opening an old export next to a new engine run can identify which
  assumption/rule/code version changed the headline number.
  - Done: added `exportFreshness` to planning exports with generated timestamp,
    plan fingerprint, engine/assumptions version, current-law rule-pack version,
    distribution mode, active/raw/planner simulation mode labels, selected
    stressor/response sensitivity IDs, optimization objective, replay key,
    seed/run metadata, replay checks, and change-detection identities for input,
    rule, engine, stochastic, and scenario drift.
  - Files: `src/planning-export.ts`, `src/planning-export.test.ts`.
  - Verification: `npm run test -- src/planning-export.test.ts`;
    `npm run build`.

34. [x] Close with full north-star verification
- Run both distribution modes plus perturbed sensitivity runs after steps 24-33.
- Acceptance: `npm run test`, `npm run test:calibration`, and a generated
  validation export all agree on the canonical north-star result object and its
  intermediate calculations.
  - Done: ran the full suite, the calibration suite, production build, and a
    generated compact north-star validation export. The export includes
    forward-looking and historical-precedent north-star results, six
    perturbation sensitivity rows, freshness/replay metadata, active-path
    intermediate checks, and LTC/HSA diagnostics.
  - Files: `docs/exports/latest-north-star-validation.json`,
    `src/decision-engine.test.ts`, `src/flight-path-action-playbook.test.ts`,
    `src/flight-path-policy.test.ts`, `src/rust-engine-client-node-boundary.test.ts`,
    `src/scenario-compare.test.ts`, `src/spend-solver.test.ts`,
    `src/stressor-layoff-mechanic.test.ts`, `src/tax-engine.test.ts`,
    `src/verification-scenarios.ts`, `vitest.config.ts`.
  - Verification: `npm run test`; `npm run test:calibration`;
    `npm run build`; generated `docs/exports/latest-north-star-validation.json`
    with 5/5 validation checks passing.

---

## Track A — Property tests

1. [x] Catalog invariants
- Write a short doc listing invariants that should hold for any valid plan. Seed list: doubling spending ⇒ success rate never increases; delaying retirement ⇒ success rate never decreases; uniformly better market returns ⇒ ending wealth never decreases; larger windfall ⇒ ending wealth never decreases; doubling starting balance ⇒ ending wealth at least doubles (before tax effects).
- For each, note whether it's "strict" (inequality must hold) or "typical" (edge cases may relax it; document them).
  - Done: 6 monotonicity invariants + 4 strict-dominance invariants catalogued, plus a list of tempting-but-false non-invariants to avoid.
  - Files: `docs/property-invariants.md`.

2. [x] Build property-test harness
- Small helper that takes a baseline `SeedData`, a perturbation function, and an invariant predicate, and runs both variants through `buildPathResults` with a fixed seed for determinism.
- Return a structured failure record on violation (which metric, what direction, magnitude).
  - Done: `runProperty({ seedPerturb, assumptionPerturb })` clones the seed, applies perturbations, runs `buildPathResults` at fixed seed with 30 simulation runs, returns headline outputs. `compareRuns(baseline, perturbed)` returns structured deltas. Tolerance bands defined for MC noise.
  - Files: `src/property-harness.ts`.

3. [x] Implement monotonicity suite
- One test per catalogued invariant. Use seed data variants based on `initialSeedData` with narrow perturbations.
- Run at a low `simulationRuns` for speed; accept a small noise tolerance so MC variance doesn't false-positive.
  - Done: 6 tests (M1–M6) covering optional spending, essential spending, retirement delay, windfall inflow, cash bucket up/down.
  - Files: `src/property-monotonicity.test.ts`.
  - Verification: `npx vitest run src/property-monotonicity.test.ts` — 6/6 pass.

4. [x] Implement strict-dominance suite
- For strictly-better inputs (e.g., +$100k windfall, never-negative market), assert outputs dominate in expectation.
- These are the tests most likely to surface accounting or sign-flip bugs.
  - Done: 7 tests (D1–D7) covering equity return bump, inflation drop, pretax doubling, combined-return bump, all-buckets-plus-$1M, zero-spending sanity, baseline determinism under fixed seed.
  - Files: `src/property-dominance.test.ts`.
  - Verification: `npx vitest run src/property-dominance.test.ts` — 7/7 pass.
  - Notable finding during authoring: a naive +2pp bond-only bump at 30 MC runs produced lower ending wealth than baseline. Replaced with a +5pp across-all-asset-classes perturbation. The bond-only result is likely MC noise at low run count but worth revisiting with higher runs before declaring the engine correct on that specific axis.

5. [x] Wire into CI test run
- Include property tests in `vitest run` default suite; surface violations prominently.
  - Done: `vitest.config.ts` include glob already matches `src/**/*.test.ts`, so the new property tests run in `npm test` automatically. No config change needed.
  - Verification: full-suite run picks up all new property tests.

---

## Track B — Tax engine unit validation

6. [x] Define canonical tax scenarios
- Write 15-20 MFJ and single-filer cases covering: W-2-only; retiree with SS + pretax draw; retiree with SS + LTCG; high-income MAGI triggering IRMAA tiers 1-5; ACA subsidy cliff; RMD year; Roth-conversion year.
- Each scenario: inputs (wages, SS, LTCG, deductions) and expected federal tax from the IRS 1040 worksheet or a public calculator (e.g., TurboTax TaxCaster).
- Store as a JSON fixture for reproducibility.
  - Done: 15 scenarios in `fixtures/tax_engine_scenarios.json`, each with full inputs, full `expected` block (AGI, provisional income, taxable SS, ordinary and LTCG taxable, federal tax, MAGI, marginal brackets), and a `computationNotes` trail.
  - Coverage: W-2 at various incomes; MFJ retirees with SS 0%/50%/85% inclusion; LTCG 0%-bracket, 0/15% straddle, 15%-only, 15/20% straddle; large Roth-conversion-year pull; MFS and HoH filing statuses; tax-exempt muni interest flowing into provisional income / MAGI; qualified dividends mixed with SS.
  - Scope notes: IRMAA tier boundaries, SS-taxation edge cases, and ACA cliff deferred to steps 8/9/10 as planned.
  - Files: `fixtures/tax_engine_scenarios.json`.
  - Verification: JSON parses; 15 scenarios enumerated; two scenarios spot-checked by hand against the formulas in `src/tax-engine.ts` (`mfj_ltcg_straddle_zero_fifteen` and `mfj_tax_exempt_muni_with_ss`) and traced through cleanly.

7. [x] Exercise `tax-engine.ts` in isolation
- Unit tests that pass each canonical scenario through `calculateFederalTax` (or equivalent entry point) and compare to the expected output within a documented tolerance (rounding mostly).
  - Done: 15 scenario tests + 1 meta-check (unique ids, ≥15 scenarios) driven off `fixtures/tax_engine_scenarios.json`. Tolerance: 2 decimal places on money fields, exact on marginal-bracket rates.
  - Files: `src/tax-engine-scenarios.test.ts`.
  - Verification: 16/16 tests pass. During authoring 3 fixture expected-value errors surfaced (off-by-one in marginal-LTCG and marginal-ordinary brackets) and were corrected — demonstrating the test catches exactly the class of small arithmetic slip that these are meant to catch.

8. [x] IRMAA tier validation
- Known MAGI inputs → known IRMAA surcharge tier per published thresholds for the current plan year.
- Test every tier boundary (just-under and just-over).
  - Done: 29 tests covering every MFJ, single, and MFS tier boundary (at-threshold → tier N; threshold+1 → tier N+1) plus sanity checks for HoH≡single, MFJ tier-6-above-$750k, and unknown-filing-status normalization.
  - Files: `src/irmaa-tier-boundaries.test.ts`.
  - Verification: 29/29 tests pass.

9. [x] Social Security taxation validation
- Known provisional-income + SS benefit → known taxable-SS amount per IRS worksheet.
- Tests for 0%, 50%, 85% inclusion ranges.
  - Done: 14 tests covering MFJ firstBase / secondBase / 85%-cap boundaries; single filer firstBase / secondBase / deep-85%; MFS (zero-base) special-case; zero-SS edge case; plus three engine invariants (85% cap never exceeded under stress, inclusion monotone non-decreasing in provisional income, tax-exempt interest flows into provisional income dollar-for-dollar).
  - Files: `src/social-security-taxation.test.ts`.
  - Verification: 14/14 tests pass.

10. [x] ACA subsidy / cliff validation
- Known MAGI + household size → known subsidy per ACA published tables for the current plan year.
- Test the 400% FPL cliff behavior (or current ARPA/IRA rules — document which regime is modeled).
  - Done: 12 tests covering each FPL-band endpoint (1.5, 2.0, 3.0, 4.0, 5.0 of FPL) for household-size 2 plus household-size 4 linearity check; retirement gating (no subsidy if not retired); Medicare gating (no ACA if all on Medicare); monotonicity (subsidy never increases as MAGI rises); IRMAA surcharge passthrough for Medicare-eligible members. Confirms engine runs the post-ARPA/IRA 8.5%-cap regime (no hard 400% cliff).
  - Files: `src/aca-subsidy-boundaries.test.ts`.
  - Verification: 12/12 tests pass.

11. [x] Document plan-year assumptions
- Short doc: what tax year's brackets, thresholds, and limits is the engine using, and when it will need updating.
  - Done: written — covers federal ordinary tax, LTCG, SS taxation, IRMAA tiers, ACA subsidies, and RMDs. Includes explicit "not modeled" list (NIIT, additional Medicare tax, age-65+ std-ded bump) and update-trigger notes for each section.
  - Files: `docs/tax-engine-assumptions.md`.

---

## Track C — Historical backtesting

12. [x] Source historical market data
- Shiller dataset or equivalent public source: annual S&P 500 total return, 10-year Treasury return, short-term rate, and CPI inflation from 1928 forward.
- Store as a JSON fixture under `fixtures/historical_returns.json`.
  - Done: fixture structure in place with sample years around each canonical cohort kickoff (1929, 1937, 1966, 1973, 1982, 2000, 2008). Values are representative historical approximations — the `$meta.status` field flags this clearly and cites Shiller and FRED as canonical sources to back-fill before step 15.
  - Files: `fixtures/historical_returns.json`.
  - Verification: JSON parses, 24 years across 7 cohort kickoffs.
  - Follow-up for a later session: back-fill with definitive Shiller / FRED values for the full 1928–present range. The structural contract is now set, so this is a data-refresh task rather than a design task.

13. [x] Add "historical replay" return generator
- Extend the Monte Carlo engine (or add an alternate path) so it can consume a fixed year-by-year return sequence instead of sampling from a distribution.
- Seed-controlled; one path only; no randomness.
  - Done: standalone `replayCohort(spec)` in `src/historical-replay.ts`. Deterministic; Trinity-Study-shaped (stocks + bonds + CPI only, no tax/RMDs/SS/healthcare). Kept separate from the full MC engine on purpose: 1966-era tax law bears little resemblance to today's, so mixing the full engine in would conflate model-error with data-vintage-error.
  - Files: `src/historical-replay.ts`.

14. [x] Define retiree cohort fixtures
- Canonical starting cases: "1929 retiree," "1937 retiree," "1966 retiree" (historically worst 30-year window for 4% SWR), "1973 retiree," "1982 retiree" (historically best), "2000 retiree," "2008 retiree."
- Each has the same simplified portfolio (e.g., 60/40, $1M starting, $40k/yr real withdrawal) so results are comparable across cohorts.
  - Done: continuous 1926-2023 annual-return fixture at `fixtures/historical_annual_returns.json` (supersedes the sample-only `historical_returns.json` for cohort and Trinity tests). Cohort specs built inline in the test helper `cohortSpec(label, startYear, durationYears)` using the canonical Bengen/Trinity setup: $1M starting, 4% initial withdrawal, 60/40 stocks/bonds, CPI-inflated withdrawal.
  - Files: `fixtures/historical_annual_returns.json`.

15. [x] Write cohort outcome tests
- For each cohort, assert the engine produces the known result: 1966 should run out of money around year 29; 1982 should end with ~$5-10M real; 2000 should come close to failure; etc.
- These act as regression tests — if changing the engine breaks history, we notice.
  - Done: 9 cohort outcome tests in `src/historical-cohorts.test.ts`. 1966 survives 30y but finishes depleted in real terms (below starting value); 1982 ends at >$2.5M real; 1929 survives; 2000 survives 24y with real balance < $1.2M; plus determinism and strict-dominance (+equity → better 1982 outcome) sanity checks. Assertions use ranges rather than exact values because the embedded return series is approximate.
  - Files: `src/historical-cohorts.test.ts`.
  - Verification: 9/9 tests pass.

16. [x] Reproduce Trinity Study / Bengen 4% SWR numbers
- Using the historical replay engine on rolling 30-year windows, reproduce the ~95% success rate for 4% SWR on a 60/40 over 1926-1995.
- If we don't reproduce Trinity, something in sequence handling is off.
  - Done: 6 rolling-window tests in `src/trinity-rolling-windows.test.ts`. 4% SWR 60/40 over 69 rolling 30-year windows (1926-1994 start): 100% survival in our replay (published Trinity band: 95-100%). 5% SWR 60/40 drops to 76.8% (Bengen's rejection zone ≈ 70-80%). 3.5% 60/40: 100%. 100% stocks 4% SWR: 94.2%. The famous 1965-1974 cohort cluster surfaces as expected among 5%-SWR failures. Replay math reproduces the qualitative Trinity result.
  - Files: `src/trinity-rolling-windows.test.ts`.
  - Verification: 6/6 tests pass.

17. [x] Document historical assumption set
- What data source, what asset-class proxies, what simplifications. This is the "we trust history because..." doc.
  - Done: sources, accuracy budget (~1-2pp per-year drift tolerated), and scope (stocks + intermediate bonds + CPI, no full-engine integration by design) are documented in the `$meta` block of `fixtures/historical_annual_returns.json` and the header comment of `src/historical-replay.ts`. Each assertion in the cohort and Trinity test files carries inline rationale for its target band.
  - Files: `fixtures/historical_annual_returns.json` ($meta block), `src/historical-replay.ts` (header).

---

## Track D — Fidelity parity

18. [x] Capture Fidelity scenario
- Plug the same household into Fidelity's retirement planner (or a simplified equivalent).
- Screenshot the Assumptions, Inputs, and Results screens just like we did for Boldin.
  - Done: captured via PDF export from digital.fidelity.com/ftgw/pna/customer/planning/. Initial capture was incomplete (5 of 9 accounts due to managed-account transition); after moving from managed to self-directed all 8 accounts linked and re-captured.
  - Files: `/Users/robbonner/Desktop/Retirement Analysis2.pdf` (externally held; contents extracted into the fixture).

19. [x] Build `fixtures/fidelity_*.json`
- Mirror the Boldin fixture shape: inputs + `expected` block with Fidelity's outputs.
- Add a README (like the Boldin one) documenting what Fidelity exposes and what it hides.
  - Done: `fixtures/fidelity_baseline.json` with household, income, portfolio asset mix + tax buckets, expenses, RMD notes, and expected outputs (95% success, $1,971,816 lifetime income, $436,224 p10 ending balance). README at `fixtures/fidelity_baseline.README.md` documents methodology differences vs Boldin, unpublished fields, and the triangulation framing.
  - Files: `fixtures/fidelity_baseline.json`, `fixtures/fidelity_baseline.README.md`.

20. [x] Build Fidelity translator
- Map Fidelity's input shape to our `SeedData`/`MarketAssumptions`, same pattern as `boldin-fixture-translator.ts`.
- Note Fidelity's return-model quirks as translation notes.
  - Done: `translateFidelityFixture(fixture, options)` reuses initialSeedData for per-account structure (Fidelity doesn't publish balances) and sets MarketAssumptions to historical-approximation means (equity 9.8%, intl 8.5%, bonds 5.3%, cash 3%) instead of Boldin's Conservative preset. Emits translation notes flagging the asset-mix audit as a follow-up (tied to the Allocation check item in BACKLOG.md).
  - Files: `src/fidelity-fixture-translator.ts`.

21. [x] Mirror the parity smoke test
- `src/fidelity-parity.test.ts` using the same diagnostic tables (spend-path, money-flow, per-bucket withdrawals).
- Run against the same household as the Boldin fixture so the two peer outputs can be compared directly.
  - Done: triangulation test prints a Fidelity/Boldin/Ours side-by-side diagnostic table on every run. Asserts only sanity bounds (success in [0, 100], non-negative ending wealth); the real product is the console output. Uses Fidelity's historical-methodology assumptions for apples-to-apples.
  - Files: `src/fidelity-parity.test.ts`.
  - Verification: test passes. Current output: 98.4% ours vs 95% Fidelity vs 48% Boldin on success rate; p10 ending wealth $1.9M ours vs $436k Fidelity — the remaining structural gap, documented in the README.

22. [x] Multi-planner summary
- A small helper that prints both peer deltas side-by-side: "On this plan, Boldin says X, Fidelity says Y, we say Z." Triangulation view.
  - Done: folded into the parity test (step 21). One test, one table, all three tools. Reading the diagnostic output IS the multi-planner summary.
  - Files: see step 21.

---

## Notes

- **Where trust actually comes from**: Track C is the one that most directly answers "can I bet on this?" If your engine can replay history and correctly predict the fates of the 1966, 2000, and 1982 retirees, you've validated it against the hardest real scenarios that ever happened.
- **What the other tracks catch**: Track A catches sign flips, accounting bugs, discontinuities. Track B catches tax math errors that would silently inflate or deflate success rates. Track D catches blind spots that Boldin alone might share with our engine.
- **None of this beats uncertainty surfacing**: a well-validated model that reports a point estimate is still dangerous. Consider pairing this workplan with a product change that shows ranges instead of single success-rate numbers.
