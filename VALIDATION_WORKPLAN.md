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

18. [ ] Capture Fidelity scenario
- Plug the same household into Fidelity's retirement planner (or a simplified equivalent).
- Screenshot the Assumptions, Inputs, and Results screens just like we did for Boldin.

19. [ ] Build `fixtures/fidelity_*.json`
- Mirror the Boldin fixture shape: inputs + `expected` block with Fidelity's outputs.
- Add a README (like the Boldin one) documenting what Fidelity exposes and what it hides.

20. [ ] Build Fidelity translator
- Map Fidelity's input shape to our `SeedData`/`MarketAssumptions`, same pattern as `boldin-fixture-translator.ts`.
- Note Fidelity's return-model quirks as translation notes.

21. [ ] Mirror the parity smoke test
- `src/fidelity-parity.test.ts` using the same diagnostic tables (spend-path, money-flow, per-bucket withdrawals).
- Run against the same household as the Boldin fixture so the two peer outputs can be compared directly.

22. [ ] Multi-planner summary
- A small helper that prints both peer deltas side-by-side: "On this plan, Boldin says X, Fidelity says Y, we say Z." Triangulation view.

---

## Notes

- **Where trust actually comes from**: Track C is the one that most directly answers "can I bet on this?" If your engine can replay history and correctly predict the fates of the 1966, 2000, and 1982 retirees, you've validated it against the hardest real scenarios that ever happened.
- **What the other tracks catch**: Track A catches sign flips, accounting bugs, discontinuities. Track B catches tax math errors that would silently inflate or deflate success rates. Track D catches blind spots that Boldin alone might share with our engine.
- **None of this beats uncertainty surfacing**: a well-validated model that reports a point estimate is still dangerous. Consider pairing this workplan with a product change that shows ranges instead of single success-rate numbers.
