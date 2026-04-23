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

1. [ ] Catalog invariants
- Write a short doc listing invariants that should hold for any valid plan. Seed list: doubling spending ⇒ success rate never increases; delaying retirement ⇒ success rate never decreases; uniformly better market returns ⇒ ending wealth never decreases; larger windfall ⇒ ending wealth never decreases; doubling starting balance ⇒ ending wealth at least doubles (before tax effects).
- For each, note whether it's "strict" (inequality must hold) or "typical" (edge cases may relax it; document them).

2. [ ] Build property-test harness
- Small helper that takes a baseline `SeedData`, a perturbation function, and an invariant predicate, and runs both variants through `buildPathResults` with a fixed seed for determinism.
- Return a structured failure record on violation (which metric, what direction, magnitude).

3. [ ] Implement monotonicity suite
- One test per catalogued invariant. Use seed data variants based on `initialSeedData` with narrow perturbations.
- Run at a low `simulationRuns` for speed; accept a small noise tolerance so MC variance doesn't false-positive.

4. [ ] Implement strict-dominance suite
- For strictly-better inputs (e.g., +$100k windfall, never-negative market), assert outputs dominate in expectation.
- These are the tests most likely to surface accounting or sign-flip bugs.

5. [ ] Wire into CI test run
- Include property tests in `vitest run` default suite; surface violations prominently.

---

## Track B — Tax engine unit validation

6. [ ] Define canonical tax scenarios
- Write 15-20 MFJ and single-filer cases covering: W-2-only; retiree with SS + pretax draw; retiree with SS + LTCG; high-income MAGI triggering IRMAA tiers 1-5; ACA subsidy cliff; RMD year; Roth-conversion year.
- Each scenario: inputs (wages, SS, LTCG, deductions) and expected federal tax from the IRS 1040 worksheet or a public calculator (e.g., TurboTax TaxCaster).
- Store as a JSON fixture for reproducibility.

7. [ ] Exercise `tax-engine.ts` in isolation
- Unit tests that pass each canonical scenario through `calculateFederalTax` (or equivalent entry point) and compare to the expected output within a documented tolerance (rounding mostly).

8. [ ] IRMAA tier validation
- Known MAGI inputs → known IRMAA surcharge tier per published thresholds for the current plan year.
- Test every tier boundary (just-under and just-over).

9. [ ] Social Security taxation validation
- Known provisional-income + SS benefit → known taxable-SS amount per IRS worksheet.
- Tests for 0%, 50%, 85% inclusion ranges.

10. [ ] ACA subsidy / cliff validation
- Known MAGI + household size → known subsidy per ACA published tables for the current plan year.
- Test the 400% FPL cliff behavior (or current ARPA/IRA rules — document which regime is modeled).

11. [ ] Document plan-year assumptions
- Short doc: what tax year's brackets, thresholds, and limits is the engine using, and when it will need updating.

---

## Track C — Historical backtesting

12. [ ] Source historical market data
- Shiller dataset or equivalent public source: annual S&P 500 total return, 10-year Treasury return, short-term rate, and CPI inflation from 1928 forward.
- Store as a JSON fixture under `fixtures/historical_returns.json`.

13. [ ] Add "historical replay" return generator
- Extend the Monte Carlo engine (or add an alternate path) so it can consume a fixed year-by-year return sequence instead of sampling from a distribution.
- Seed-controlled; one path only; no randomness.

14. [ ] Define retiree cohort fixtures
- Canonical starting cases: "1929 retiree," "1937 retiree," "1966 retiree" (historically worst 30-year window for 4% SWR), "1973 retiree," "1982 retiree" (historically best), "2000 retiree," "2008 retiree."
- Each has the same simplified portfolio (e.g., 60/40, $1M starting, $40k/yr real withdrawal) so results are comparable across cohorts.

15. [ ] Write cohort outcome tests
- For each cohort, assert the engine produces the known result: 1966 should run out of money around year 29; 1982 should end with ~$5-10M real; 2000 should come close to failure; etc.
- These act as regression tests — if changing the engine breaks history, we notice.

16. [ ] Reproduce Trinity Study / Bengen 4% SWR numbers
- Using the historical replay engine on rolling 30-year windows, reproduce the ~95% success rate for 4% SWR on a 60/40 over 1926-1995.
- If we don't reproduce Trinity, something in sequence handling is off.

17. [ ] Document historical assumption set
- What data source, what asset-class proxies, what simplifications. This is the "we trust history because..." doc.

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
