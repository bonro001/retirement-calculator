# Product Backlog

Durable, cross-cutting product items that don't belong in a track-specific workplan. Lighter-weight than the `*_WORKPLAN.md` files — each entry is a one-liner or short paragraph, no execution protocol.

Related workplans (each has its own stepwise plan):
- [FLIGHT_PATH_WORKPLAN.md](FLIGHT_PATH_WORKPLAN.md) — strategic-prep recommendation engine.
- [CALIBRATION_WORKPLAN.md](CALIBRATION_WORKPLAN.md) — capture predicted-vs-actual over time for empirical model calibration.
- [VALIDATION_WORKPLAN.md](VALIDATION_WORKPLAN.md) — property tests, tax-engine validation, historical backtesting, peer-planner parity.

## Open

- [ ] **Close the Fidelity p10 tail gap**. Even with asset-class correlation added (this sprint), our `tenthPercentileEndingWealth` lands ~3.6x richer than Fidelity's published p10. Remaining likely driver is distribution shape: our bounded-normal sampler is symmetric, but historical equity returns are left-skewed and kurtotic. Candidate fixes: (a) swap bounded-normal for a lognormal/t-distribution sampler, (b) tighten the downside clip bound on equity below -0.45, (c) splice actual historical worst-case sequences into the bounded-normal draws at some sampling rate. Track with a dedicated workplan when it becomes urgent.

- [ ] **Add authentication**. Currently local-first, no auth. Decide between:
  - Keep local-only (per [product-spec.md](product-spec.md) V1 scope) and never add.
  - Lightweight local passcode / device-bound encryption for the plan store.
  - Full account system with cloud sync — requires server, privacy posture rework, and probably an opt-in cloud-sync product decision before any calibration-aggregation work (see CALIBRATION_WORKPLAN step 12's privacy note).
  - **Open questions**: who is the plan shared with (spouse, advisor)? Is the data ever off-device? Does this need to happen before the calibration dataset grows large enough that one-way hashing alone is sufficient anonymization?

- [ ] **Surface tax efficiency in the UI (engine side done)**. Engine-side computation added in `src/tax-efficiency.ts` — `computeTaxEfficiencyReport(path)` produces lifetime totals, category contributions (federal / IRMAA / Medicare baseline), top-5 heat years with primary driver classification, IRMAA-tier-3+ cliff years, and Roth-conversion totals. 7 tests in `src/tax-efficiency.test.ts`. **Remaining**: wire into a UI tile. Suggested: dashboard summary card showing `effectiveLifetimeFederalRate`, `lifetimeIrmaaSurcharge`, and the top heat year; click-through to a detail view listing all heat years + cliff years with driver explanations. Needs browser verification once wired.

- [ ] **Allocation check (investigation complete; remediation open)**. Property test in `src/allocation-check.test.ts` asserts engine aggregate mix is within 8pp of Fidelity's published mix per class; currently passes but with a real directional drift: engine is 72.1% US-equity vs Fidelity's 65.0%, likely because CENTRAL_MANAGED / TRP_2030 proxies in `asset-class-mapper.ts` lean more US-equity than actual lookthrough. **Remaining**: tighten the proxy assumptions (either user-configurable per-account overrides or better defaults), then the test tolerance can drop below 8pp.
  - **Why it matters**: Fidelity's methodology samples returns from "domestic stocks, foreign stocks, bonds, short-term investments" using the user's actual asset mix (65/9/17/7 in the current plan). Boldin uses per-account rate-of-return overrides that bypass allocation. Our engine mixes both approaches — each bucket has a `targetAllocation` keyed to symbols (VTI/BND/SCHD/etc.) which get mapped to asset classes via `asset-class-mapper.ts`. Worth confirming end-to-end: does our reported "asset mix" match what Fidelity sees, does the simulation actually use that mix to sample returns per year, and are the per-symbol → asset-class mappings (TRP_2030, CENTRAL_MANAGED proxies especially) doing what we think?
  - **First cuts**: (a) write a property test that asserts engine-computed aggregate asset mix equals Fidelity-reported mix within a few pp when fed the same seed data; (b) inspect the `assetClassMappingAssumptions` output in a live run to confirm TRP_2030 and CENTRAL_MANAGED proxies behave sensibly; (c) surface aggregate asset mix as a UI field so drift from intent is visible.

## Completed

_Nothing yet._
