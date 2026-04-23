# Product Backlog

Durable, cross-cutting product items that don't belong in a track-specific workplan. Lighter-weight than the `*_WORKPLAN.md` files — each entry is a one-liner or short paragraph, no execution protocol.

Related workplans (each has its own stepwise plan):
- [FLIGHT_PATH_WORKPLAN.md](FLIGHT_PATH_WORKPLAN.md) — strategic-prep recommendation engine.
- [CALIBRATION_WORKPLAN.md](CALIBRATION_WORKPLAN.md) — capture predicted-vs-actual over time for empirical model calibration.
- [VALIDATION_WORKPLAN.md](VALIDATION_WORKPLAN.md) — property tests, tax-engine validation, historical backtesting, peer-planner parity.

## Next priority (ranked)

Filter used: *"fix what changes decisions (tail risk, calibration); everything else can wait."* Lifted from a reviewer critique, sharpened against what we actually shipped.

1. ~~**Fat-tail return distribution + clip removal**~~ ✅ **Done this sprint.** Added `useHistoricalBootstrap` opt-in that samples per-year (stocks, bonds, cash, inflation) tuples from [historical_annual_returns.json](fixtures/historical_annual_returns.json). Fidelity translator now uses it by default. Closed p10 gap from 4.4x → 2.2x of Fidelity. Remaining 2x likely block/autocorrelation (multi-year bad-follows-bad dynamics) + withdrawal-policy smoothing; tracked as follow-up if decision-critical.
2. **Actuals log + reconciliation layer** (CALIBRATION steps 2, 4, 6) — pairs with the already-shipped prediction log. Write the companion `actuals.jsonl` capture for balances / monthly spend / annual tax, plus the reconciliation that diffs prediction vs actuals. Implementable now, doesn't need calendar time to code — only to populate.
3. **UI: uncertainty range tile** — surfaces `src/uncertainty-surface.ts` as a dashboard card showing the success-rate range ("85-94%") instead of a single point. Replaces the most dangerous single-number headline.
4. **UI: tax efficiency tile** — surfaces `src/tax-efficiency.ts` as a dashboard card showing lifetime federal tax, effective rate, top heat year with driver, and IRMAA cliff count. Tax minimization is stated user priority ("hate paying taxes").
5. **CENTRAL_MANAGED / TRP_2030 proxy tightening** (Allocation check remediation) — engine's 72.1% US-equity drift vs Fidelity's 65.0% is from the ambiguous-holding proxies in `asset-class-mapper.ts`. Either add user-configurable per-account override or derive proxies from lookthrough data. Lets the allocation-check tolerance drop below 8pp.
6. **Shiller back-fill for historical_annual_returns.json** — current values are ~±1-2pp approximate. Replace with definitive pull from Shiller ie_data.xls. Tightens Trinity reproduction from "in the right band" to "exact published numbers."
7. **Monte Carlo convergence test** — per-metric drift test across 100 → 500 → 2000 → 5000 runs, asserting stabilization. Catches the case where we report 92% when the real MC answer is still noisy at whatever our default run count is.
8. **Third peer planner** — triangulation beyond Boldin + Fidelity. Projection Lab / NewRetirement / FICalc. Mostly a capture exercise now that the parity-harness shape is proven.
9. **Additional Medicare tax** (0.9% on wages >$250k MFJ) — zero impact on target household (no post-retirement wages), kept here for completeness not urgency.
10. **Authentication decision** — product-level, separate from calibration/tail work. Still open per earlier entry.

Guiding principle (reviewer's, and it's correct): *fix what changes decisions — tail risk and calibration are the two real levers remaining. Polish is optional.*

## Open

- [ ] **Close the Fidelity p10 tail gap**. Even with asset-class correlation added (this sprint), our `tenthPercentileEndingWealth` lands ~3.6x richer than Fidelity's published p10. Remaining likely driver is distribution shape: our bounded-normal sampler is symmetric, but historical equity returns are left-skewed and kurtotic. Candidate fixes: (a) swap bounded-normal for a lognormal/t-distribution sampler, (b) tighten the downside clip bound on equity below -0.45, (c) splice actual historical worst-case sequences into the bounded-normal draws at some sampling rate. Track with a dedicated workplan when it becomes urgent.

- [ ] **Add authentication**. Currently local-first, no auth. Decide between:
  - Keep local-only (per [product-spec.md](product-spec.md) V1 scope) and never add.
  - Lightweight local passcode / device-bound encryption for the plan store.
  - Full account system with cloud sync — requires server, privacy posture rework, and probably an opt-in cloud-sync product decision before any calibration-aggregation work (see CALIBRATION_WORKPLAN step 12's privacy note).
  - **Open questions**: who is the plan shared with (spouse, advisor)? Is the data ever off-device? Does this need to happen before the calibration dataset grows large enough that one-way hashing alone is sufficient anonymization?

- [ ] **Surface tax efficiency in the UI (component built; adoption pending)**. Engine-side computation shipped in `src/tax-efficiency.ts`. Dashboard tile shipped in `src/TaxEfficiencyTile.tsx` — shows lifetime federal tax, effective rate, IRMAA surcharge, IRMAA tier-3+ count, Roth conversion count/total, top heat year with driver, and expandable top-5 + cliff lists. Styled to match the existing `UnifiedPlanScreen` palette but **not yet tested in a browser and not wired into any layout**. Adoption step: insert `<TaxEfficiencyTile path={baseline} />` into the relevant dashboard section of `UnifiedPlanScreen.tsx`.

- [ ] **Allocation check (investigation complete; remediation open)**. Property test in `src/allocation-check.test.ts` asserts engine aggregate mix is within 8pp of Fidelity's published mix per class; currently passes but with a real directional drift: engine is 72.1% US-equity vs Fidelity's 65.0%, likely because CENTRAL_MANAGED / TRP_2030 proxies in `asset-class-mapper.ts` lean more US-equity than actual lookthrough. **Remaining**: tighten the proxy assumptions (either user-configurable per-account overrides or better defaults), then the test tolerance can drop below 8pp.
  - **Why it matters**: Fidelity's methodology samples returns from "domestic stocks, foreign stocks, bonds, short-term investments" using the user's actual asset mix (65/9/17/7 in the current plan). Boldin uses per-account rate-of-return overrides that bypass allocation. Our engine mixes both approaches — each bucket has a `targetAllocation` keyed to symbols (VTI/BND/SCHD/etc.) which get mapped to asset classes via `asset-class-mapper.ts`. Worth confirming end-to-end: does our reported "asset mix" match what Fidelity sees, does the simulation actually use that mix to sample returns per year, and are the per-symbol → asset-class mappings (TRP_2030, CENTRAL_MANAGED proxies especially) doing what we think?
  - **First cuts**: (a) write a property test that asserts engine-computed aggregate asset mix equals Fidelity-reported mix within a few pp when fed the same seed data; (b) inspect the `assetClassMappingAssumptions` output in a live run to confirm TRP_2030 and CENTRAL_MANAGED proxies behave sensibly; (c) surface aggregate asset mix as a UI field so drift from intent is visible.

## Completed

_Nothing yet._
