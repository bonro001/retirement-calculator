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

1. [ ] Prediction log writer
- Append-only `predictions.jsonl` (or equivalent local store) written on every plan evaluation.
- Capture: timestamp, plan fingerprint, assumptions pack, engine version, key outputs (success rate, net worth trajectory by year, lifetime tax estimate).
- Must not rewrite history — each evaluation is a new row.

2. [ ] Monthly spending capture (UI)
- Add a lightweight "log actual spending" form: month, essential, optional, travel, healthcare.
- Persist to `actuals.jsonl` with timestamp.
- Do not overwrite prior months on edit — store a correction row instead.

3. [ ] Annual tax capture (UI)
- One-field-per-year entry from the user's 1040 (total federal tax paid).
- Distinguish actual-paid from engine-estimated in all downstream dashboards.

4. [ ] Balance snapshot log
- Extend the existing PDF import flow to append a timestamped row to `actuals.jsonl` rather than just overwriting current balances.
- Preserves the trajectory, not just the latest number.

5. [ ] Plan-version stamp on every actuals row
- Every actuals row references the plan fingerprint that was current at the time of the observation.
- Lets the reconciliation layer distinguish "model error" from "plan changed."

6. [ ] Reconciliation layer
- For each actuals row, find the prediction(s) made N months ago for that same time horizon.
- Compute delta (actual minus predicted) for each tracked metric.
- Persist to `reconciliations.jsonl` as a third append-only table.

7. [ ] Delta dashboard (read-only UI)
- Chart: predicted net worth trajectory vs realized balance points, overlaid.
- Table: horizon (1y, 3y, 5y) × metric (net worth, spending, tax) × delta percentile.
- Goal is visual at first; no statistical tests yet.

8. [ ] Market benchmark capture
- Pull or enter annual realized S&P 500, total bond index, and short-term cash rates.
- Lets reconciliation decompose portfolio delta into "market regime vs plan" and "model vs reality."

9. [ ] Life-events journal
- Freeform one-line entries with date + category (unplanned medical, gift, property repair, windfall, other).
- Surfaced alongside reconciliation rows so unexplained deltas can be tagged to real events.

10. [ ] Peer-tool snapshot refresh cadence
- Formalize a periodic refresh of [fixtures/boldin_lower_returns.json](fixtures/boldin_lower_returns.json) (and any other peer-planner fixtures).
- Each refresh is one row in the dataset: "on date D, Boldin said X, we said Y, our assumptions were A."

11. [ ] Behavior-change detector
- Diff each new plan snapshot against the prior one; flag changes in retirement date, target spend, stressors selected, or withdrawal order.
- Annotate affected predictions so reconciliation can separate "user changed the plan" from "model was wrong."

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
