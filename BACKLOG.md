# Product Backlog

Durable, cross-cutting product items that don't belong in a track-specific workplan. Lighter-weight than the `*_WORKPLAN.md` files — each entry is a one-liner or short paragraph, no execution protocol.

Related workplans (each has its own stepwise plan):
- [FLIGHT_PATH_WORKPLAN.md](FLIGHT_PATH_WORKPLAN.md) — strategic-prep recommendation engine.
- [CALIBRATION_WORKPLAN.md](CALIBRATION_WORKPLAN.md) — capture predicted-vs-actual over time for empirical model calibration.
- [VALIDATION_WORKPLAN.md](VALIDATION_WORKPLAN.md) — property tests, tax-engine validation, historical backtesting, peer-planner parity.

## Open

- [ ] **Add authentication**. Currently local-first, no auth. Decide between:
  - Keep local-only (per [product-spec.md](product-spec.md) V1 scope) and never add.
  - Lightweight local passcode / device-bound encryption for the plan store.
  - Full account system with cloud sync — requires server, privacy posture rework, and probably an opt-in cloud-sync product decision before any calibration-aggregation work (see CALIBRATION_WORKPLAN step 12's privacy note).
  - **Open questions**: who is the plan shared with (spouse, advisor)? Is the data ever off-device? Does this need to happen before the calibration dataset grows large enough that one-way hashing alone is sufficient anonymization?

- [ ] **Surface tax efficiency in the model**. Make the lifetime tax cost (and the year-by-year tax drag) a first-class output visible to the user, with plain-English signals about where taxes are heaviest and what would shrink them.
  - **Why it matters**: user values tax minimization highly ("hate paying taxes") and the engine already models Roth conversions, NIIT, IRMAA tiers, LTCG stacking, and SS taxation — but most of those signals live in diagnostics fields that aren't surfaced in the UI. A user who sees "lifetime taxes $287k" with no decomposition can't tell whether Roth conversions are helping or whether IRMAA tier-hops are bleeding money.
  - **First cuts**: (a) dashboard tile for lifetime federal tax + effective rate over the plan; (b) a year-by-year "tax heat map" showing high-tax years and why (Roth conversion / RMD / SS claim / capital-gains realization); (c) lever recommendations that quantify tax impact alongside success-rate impact (e.g., "converting $X in 2028 saves $Y lifetime tax but costs $Z now"); (d) compare to a "no optimization" baseline so the user sees what the engine's automatic optimizations are saving them.
  - **Open question**: scope creep vs. the flight-path policy system — some of this could be absorbed into `flight-path-policy.ts` recommendations rather than a separate surface.

- [ ] **Allocation check**. Validate how our engine consumes and applies the user's asset allocation across the simulation.
  - **Why it matters**: Fidelity's methodology samples returns from "domestic stocks, foreign stocks, bonds, short-term investments" using the user's actual asset mix (65/9/17/7 in the current plan). Boldin uses per-account rate-of-return overrides that bypass allocation. Our engine mixes both approaches — each bucket has a `targetAllocation` keyed to symbols (VTI/BND/SCHD/etc.) which get mapped to asset classes via `asset-class-mapper.ts`. Worth confirming end-to-end: does our reported "asset mix" match what Fidelity sees, does the simulation actually use that mix to sample returns per year, and are the per-symbol → asset-class mappings (TRP_2030, CENTRAL_MANAGED proxies especially) doing what we think?
  - **First cuts**: (a) write a property test that asserts engine-computed aggregate asset mix equals Fidelity-reported mix within a few pp when fed the same seed data; (b) inspect the `assetClassMappingAssumptions` output in a live run to confirm TRP_2030 and CENTRAL_MANAGED proxies behave sensibly; (c) surface aggregate asset mix as a UI field so drift from intent is visible.

## Completed

_Nothing yet._
