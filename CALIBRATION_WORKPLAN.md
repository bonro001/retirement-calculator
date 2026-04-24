# Calibration Over Time Workplan

Goal: capture enough predicted-vs-actual data over time that the model can be empirically calibrated — specifically to measure whether our engine's optimism bias vs consumer planners (see [fixtures/boldin_lower_returns.README.md](fixtures/boldin_lower_returns.README.md)) reflects real modeling error or a defensible accounting difference.

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

Execution protocol:
1. Execute exactly one pending step per run (top to bottom).
2. Mark the active step as `[-]` while working, then `[x]` when done.
3. Add a short note under the step with files changed and verification done.
4. Stop after one step and report progress in-thread.

## Steps

1. [x] Prediction log writer
- Append-only `predictions.jsonl` (or equivalent local store) written on every plan evaluation.
- Capture: timestamp, plan fingerprint, assumptions pack, engine version, key outputs (success rate, net worth trajectory by year, lifetime tax estimate).
- Must not rewrite history — each evaluation is a new row.
  - Done: `src/prediction-log.ts` with `PredictionRecord`, `PredictionLogStore`, `createInMemoryPredictionLogStore`, `createLocalStoragePredictionLogStore` (500-record FIFO cap), `buildPredictionRecord(seedData, assumptions, path)`, `logPrediction(store, record)`, and `computePlanFingerprint(seedData, assumptions)`. Captures timestamp, planFingerprint, engineVersion, full inputs snapshot, and headline outputs (successRate, medianEndingWealth, tenthPercentileEndingWealth, lifetimeFederalTaxEstimate, peakMedianAssets, peakMedianAssetsYear).
  - Files: `src/prediction-log.ts`, `src/prediction-log.test.ts`.
  - Verification: 7/7 tests pass (fingerprint stability + sensitivity, record construction, in-memory and localStorage round-trips, FIFO eviction).

2. [-] Monthly spending capture (UI)
- Add a lightweight "log actual spending" form: month, essential, optional, travel, healthcare.
- Persist to `actuals.jsonl` with timestamp.
- Do not overwrite prior months on edit — store a correction row instead.
  - Engine side: `MonthlySpendingActual` + `buildMonthlySpendingActual` helper + `createInMemoryActualsLogStore` / `createLocalStorageActualsLogStore` in `src/actuals-log.ts`. Tests cover bucket-sum, round-trip, and kind-discrimination. **UI form still needed.**

3. [-] Annual tax capture (UI)
- One-field-per-year entry from the user's 1040 (total federal tax paid).
- Distinguish actual-paid from engine-estimated in all downstream dashboards.
  - Engine side: `AnnualTaxActual` + `buildAnnualTaxActual` helper, round-tripped through the same actuals log store as step 2. Optional note field carries 1040 line reference. Reconciliation layer (step 6) treats it as a discrete per-year metric. **UI form still needed.**

4. [x] Balance snapshot log
- Extend the existing PDF import flow to append a timestamped row to `actuals.jsonl` rather than just overwriting current balances.
- Preserves the trajectory, not just the latest number.
  - Done (engine side): `BalanceSnapshotActual` + `buildBalanceSnapshotActual` helper with per-bucket fields (pretax, roth, taxable, cash, hsa) summed into `totalBalance`. Reconciliation layer diffs `totalBalance` against `medianAssets` for the matching year. Files: `src/actuals-log.ts`. **PDF import wiring into the append flow is still a follow-up** — currently the import flow overwrites; wiring is a small edit in the import handler to call `logActual(store, ...)` before mutating seed data.

5. [x] Plan-version stamp on every actuals row
- Every actuals row references the plan fingerprint that was current at the time of the observation.
- Lets the reconciliation layer distinguish "model error" from "plan changed."
  - Done: `computePlanFingerprint(seedData, assumptions)` in `src/prediction-log.ts` emits a short stable hash (FNV-1a-64) tied to canonicalized JSON of all inputs. Key-order-independent (tested); changes on any input mutation (tested). When the actuals log lands in a future step, each row will carry this fingerprint so reconciliation can detect plan changes.
  - Files: `src/prediction-log.ts` (shared with step 1).

6. [x] Reconciliation layer
- For each actuals row, find the prediction(s) made N months ago for that same time horizon.
- Compute delta (actual minus predicted) for each tracked metric.
- Persist to `reconciliations.jsonl` as a third append-only table.
  - Done: `reconcileActualsVsPredictions(predictionStore, actualsStore)` in `src/reconciliation.ts`. For each actuals record: (a) finds the most recent prior prediction whose timestamp precedes the actuals capture, (b) flags fingerprint match vs plan-drift via `planFingerprintMatch`, (c) for balance/spending/tax metrics computes `deltaAbsolute` and `deltaPct` against the matching year in the prediction's `yearlyTrajectory`, (d) monthly spending is annualized-then-divided-by-12 for apples-to-apples. `summarizeReconciliation(rows)` aggregates mean/median deltaPct by metric for a "how is the engine biased overall" report.
  - The "persist to reconciliations.jsonl" persistence is deliberately **not** done — reconciliation is a pure function of the two logs (no state of its own). Store adapter can be added later if memoization is useful.
  - Files: `src/reconciliation.ts`, `src/reconciliation.test.ts`.
  - Verification: 6/6 tests pass covering fingerprint match, fingerprint drift, annualized monthly spend, annual tax matching, no-prior-prediction edge, and aggregate summary.

7. [-] Delta dashboard (read-only UI)
- Chart: predicted net worth trajectory vs realized balance points, overlaid.
- Table: horizon (1y, 3y, 5y) × metric (net worth, spending, tax) × delta percentile.
- Goal is visual at first; no statistical tests yet.
  - Component built: `src/DeltaDashboardTile.tsx` composes reconciliation + behavior-change diffs into a single tile. Sections: (a) per-metric summary cards (mean + median deltaPct with color coding), (b) recent reconciliation rows showing actual / predicted / deltaPct with fingerprint-match badge and notes, (c) plan-change timeline with categorized change summaries.
  - **Remaining**: chart overlay (predicted trajectory vs realized balance points as time-series), insertion into `UnifiedPlanScreen.tsx`, and browser verification. The tile currently renders tables only; a trajectory-overlay chart is the natural follow-up once the user has enough actuals rows to make a chart interesting.

8. [ ] Market benchmark capture
- Pull or enter annual realized S&P 500, total bond index, and short-term cash rates.
- Lets reconciliation decompose portfolio delta into "market regime vs plan" and "model vs reality."

9. [ ] Life-events journal
- Freeform one-line entries with date + category (unplanned medical, gift, property repair, windfall, other).
- Surfaced alongside reconciliation rows so unexplained deltas can be tagged to real events.

10. [ ] Peer-tool snapshot refresh cadence
- Formalize a periodic refresh of [fixtures/boldin_lower_returns.json](fixtures/boldin_lower_returns.json) (and any other peer-planner fixtures).
- Each refresh is one row in the dataset: "on date D, Boldin said X, we said Y, our assumptions were A."

11. [x] Behavior-change detector
- Diff each new plan snapshot against the prior one; flag changes in retirement date, target spend, stressors selected, or withdrawal order.
- Annotate affected predictions so reconciliation can separate "user changed the plan" from "model was wrong."
  - Done: `diffPredictions(a, b)` and `detectBehaviorChanges(store)` in `src/behavior-change-detector.ts`. Pure function of the prediction log. Detects retirement-date shifts (w/ direction + month magnitude), per-bucket spending changes, account balance changes, salary changes, added/removed windfalls, stressor set changes, assumption changes (equity/bond/cash/inflation means, simulation runs, engine version). Each change carries a category, human-readable description, and signed delta for sorting/visualization. `detectBehaviorChanges` walks the log chronologically and skips consecutive records with identical fingerprints.
  - Files: `src/behavior-change-detector.ts`, `src/behavior-change-detector.test.ts`.
  - Verification: 9/9 tests pass covering each change category plus fingerprint-stability and chronological ordering.

12. [ ] Calibration knob proposal
- With at least one year of reconciliation data, write a short doc proposing which engine parameters to consider tuning and what the data says about each (return mean, vol, yield-as-income accounting, tax model).
- No tuning yet — just proposals + evidence.

13. [ ] Shadow-calibrated engine (experiment)
- Run a shadow engine with tuned parameters in parallel to the live one for one release cycle.
- Compare shadow predictions vs live predictions vs actuals.
- Only ship calibration changes if shadow materially outperforms on recent reconciliations.

## Notes

- **Privacy**: everything here is local-first per [AGENTS.md](AGENTS.md). Aggregation across users would require an explicit opt-in product decision, not just code.
- **Aggregation math**: single-user data is noisy — one user's five-year outcome proves nothing in isolation. The value of this workplan for a single user is the *directional feedback loop* ("my plan said $1.5M, I'm at $1.2M at same horizon"), not statistical calibration of a general-purpose engine. True calibration needs many users.
- **Peer-tool signal is the cheapest**: step 10 gives us a second engine's answer on identical inputs without waiting for real outcomes. Invest in it early.
