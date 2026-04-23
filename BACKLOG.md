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

## Completed

_Nothing yet._
