# Boldin "Lower Returns" — parity safety check

This folder holds a captured snapshot of a real Boldin plan and a test harness that runs our engine against it. It exists to surface the *direction and size of disagreement* between our engine and a well-known consumer planner on an identical household. It is a **safety check**, not a parity gate — the test [src/boldin-parity.test.ts](../src/boldin-parity.test.ts) logs deltas but does not fail on them.

## What's captured

[boldin_lower_returns.json](./boldin_lower_returns.json) is a flat, Boldin-shaped fixture (accounts, income, expenses, rates, money flows, real estate, plus an `expected` block of Boldin's output numbers). It is deliberately *not* shaped like our [seed-data.json](../seed-data.json) — the translator in [src/boldin-fixture-translator.ts](../src/boldin-fixture-translator.ts) maps Boldin's per-account view into our pretax/roth/taxable/cash/hsa buckets at test time, so the fixture stays readable as "what Boldin displays."

## Current state

Snapshot after the user:
- Removed the primary residence and all future real-estate events from the plan.
- Switched all equity-side accounts (401k, IRA, HSA, Roth, Joint WROS-TOD) to Boldin's **Conservative** preset: 5.92% mean, 11.05% stdev per Boldin's Rate Inspector.
- Left Savings-9220 at 3% Custom and 401(k)-family Custom 2/7 spread (avg 4.5%, stdev 9.53%) on some accounts.

Boldin outputs for that state (target):
- Chance of success: **48%**
- Net worth at longevity: **$42,624** (near-depletion median)
- Lifetime income taxes: **$156,032**
- Current savings balance: $921,173

## What the harness reports

For each run the test prints:
1. **Headline diff** — success %, starting balance, net worth at longevity, lifetime taxes, peak projected NW.
2. **Spend-path diagnostic** — year-by-year implied Boldin spend vs. our `medianSpending`, confirming that the two sides agree on what the plan needs to fund. Lifetime spend currently tracks Boldin within 6% on the calibrated run.
3. **Money-flow diagnostic** — our `medianIncome` vs Boldin's visible inflows (salary + SS + windfall), revealing the +20% "extra income" our engine surfaces (likely investment yield accounted as income).
4. **Per-bucket withdrawal trajectory** — which bucket the engine draws from by year. Confirms we do eventually touch taxable.
5. **Windfall spot-check** — that the $500k 2028 inheritance lands as expected.

## Known structural gaps (not calibration bugs)

After moving every tunable knob we had, three things still separate our output from Boldin:

1. **Yield-as-income accounting**. Our engine reports investment yield on the taxable bucket as `medianIncome` (and taxes it), which reduces how much we need to draw from the portfolio. Boldin rolls the same yield silently into asset growth. Over 33 years this accounts for ~$700k of "extra resources" on our side and explains most of the residual wealth gap.
2. **Distribution shape**. We sample returns normally around mean + stdev; Boldin may use a non-normal or sequence-correlated model that produces fatter left tails. Even after matching 11.05% stdev our failure rate maxes out around 9%, while Boldin gets to 52% failure on the same numbers.
3. **Withdrawal-policy smoothing**. Our guardrails + closed-loop-healthcare-tax iteration preserves wealth in adverse years; Boldin's "spend what's needed" withdraws regardless.

## Important framing

When we say "our engine runs optimistic," read it as *optimistic relative to Boldin*. We don't have a third reference point validating that Boldin's 48% is "correct." What is clear:

- On identical inputs, the two tools disagree by ~40 percentage points on success and ~2× on ending wealth.
- The disagreement is large enough to flip decision thresholds ("am I safe to retire?") and therefore worth documenting whenever we present success-rate outputs.

## Refreshing the fixture

When the user's Boldin plan changes, re-capture:
1. The `expected` block in the JSON (success %, NW at longevity, lifetime taxes).
2. Any account that changed preset — the rate, stdev, and preset label in `$meta.notes`.
3. Run the test; it will re-print the diff against the new target.

The translator options (`matchBoldinConservativeDistribution`, `healthcareOverlayFromBoldin`, `disableRothConversions`, `nearZeroVolatility`, `excludeHome`) can be composed for different calibration experiments.

## Long-term calibration idea (why this fixture is worth keeping)

A single Boldin snapshot is a point-in-time data point. Kept over time — alongside actual realized portfolio/retirement outcomes — the set of (our-prediction, Boldin-prediction, eventual-reality) tuples becomes a calibration dataset: we can tell whether our optimism bias is a real modeling gap or whether Boldin is overly pessimistic. Each refresh of this fixture contributes one row.
