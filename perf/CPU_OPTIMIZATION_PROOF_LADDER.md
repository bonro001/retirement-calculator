# CPU Optimization Proof Ladder

Original quiet ratchet: `173.83s` for `5000 x 5000` on Mac-Mini-Upstairs.
Current ratchet candidate: `125.68s`, `25.14 ms/policy`.

Use this ladder before committing to a full quiet rerun. Counters prove shape, but
timers prove whether the shape is expensive enough to matter.

## Instrumented Build

```bash
FLIGHT_ENGINE_RUST_FEATURES=tax-counters,module-timers npm run engine:rust:build:napi
```

Return to the normal build after any proof run:

```bash
npm run engine:rust:build:napi
```

## Probe Command

```bash
npm run perf:cpu-baseline -- \
  --policies 1000 \
  --trials 5000 \
  --repeats 1 \
  --mode parametric \
  --label proof-probe \
  --instrument tax-counters,module-timers
```

The JSON report includes:

- `instrumentation.taxCallCounts`
- `instrumentation.moduleTimings`
- `instrumentation.proofLadder`

The human output prints the top module timers and the decision recommendation.

## Decision Math

For a proposed counter reduction:

```text
estimated_saved_ms = call_reduction * per_call_us / 1000
```

Use the timer's `perCallUs` from the same workload shape when possible.

## Thresholds

- `< 50ms` estimated saved: skip.
- `50-500ms`: accept only tiny, obvious simplifications.
- `500-1000ms`: usually still simplify-only unless the patch is almost free.
- `> 1000ms`: run a quick `1000 x 5000` A/B.
- `> 3000ms`: if the `1000 x 5000` A/B confirms direction, run the full quiet `5000 x 5000`.

If the module timer says full removal is below threshold, a partial reduction is
not worth measuring.

## Calibration Gate

Every kept engine change passes:

```bash
npm run test:calibration
```

This applies regardless of ladder tier. Counter wins, timing wins, and
clarity-only changes all pass through the same calibration gate.

A change that breaks calibration is reverted regardless of speed wins. Faster
but drifted tax, IRMAA, ACA, withdrawal, or solvency behavior is not a kept
optimization.

## Module Stop Conditions

Stop investigating a module when any of these are true:

- Three consecutive proof-ladder probes return `skip`.
- The module timer drops below 5% of total wall time after recent changes.
- Best-case full-removal estimate is below `1000ms`.
- Two attempts at the module produced reverts.

When a module stops, record the reason in `perf/TAX_OPT_LOG.md` or the relevant
optimization log before moving to the next target.

## Current Use

The timer modules are deliberately coarse:

- `compactYearAt`
- `federalTaxExact`
- `healthcarePremium`
- `ordinaryTax`
- `withdrawalAttempt`
- `percentile`

Add a new module timer only when a flamegraph or counter result names a module
that is not covered by the existing set.

## Module Status

| Module | Status | Last touched | Notes |
|---|---|---:|---|
| `federalTaxExact` | done | 2026-05-08 | Tax skip, per-year invariants, and bracket simplification kept. |
| `ordinaryTax` | done | 2026-05-08 | Covered by the federal tax pass. |
| `withdrawalAttempt` | done | 2026-05-08 | Closed-loop pass 2 proved structurally needed. |
| `compactYearAt` | tried, no win | 2026-05-08 | Flattening attempt regressed and was reverted. |
| `proactiveRothConversion` | kept | 2026-05-08 | Stack buffer plus fast tax evaluator: quiet median `125.68s`, `25.14 ms/policy`. |
| `healthcarePremium` | kept | 2026-05-08 | ACA work gate quiet median `138.91s`; later context hoist 1K rung `24.96s`, no quiet ratchet. |
| `percentile` | not investigated | - | Flamegraph showed summary sort/selection frames; verify materiality first. |

## Latest Probe

2026-05-08 `1000 x 5000` module-timer-only probe after healthcare context hoist:

- Report: `out/cpu-baseline/2026-05-08T20-10-14-979Z-rust-native-compact-parametric-r1.json`
- Instrumented wall time: `118.63s`
- Top module upper bounds:
  - `withdrawalAttempt`: `60.26s`
  - `federalTaxExact`: `36.39s`
  - `ordinaryTax`: `15.87s`
  - `healthcarePremium`: `10.28s`
  - `compactYearAt`: `2.91s`
  - `percentile`: `0.21s`

Interpretation: timers are nested, so upper bounds are not additive. The
largest remaining signal is still the closed-loop withdrawal wrapper. The
module-timer-only probe is more representative of production than the
`tax-counters,module-timers` probe, because `tax-counters` intentionally keeps
the exact Roth conversion tax evaluator alive as a shadow check and inflates
`federalTaxExact`.

Next target should be closed-loop withdrawal/healthcare interaction, but that
is behavior-sensitive. Do not remove loop passes without a shadow probe showing
the final tax, MAGI, healthcare premium, and selected withdrawals are unchanged.

## Refreshing the Module Set

Refresh the flamegraph when several major passes have landed, when a suspected
hot path is not in the timer list, or when proof probes no longer explain wall
time.

Use the baseline flamegraph procedure from `perf/CPU_BASELINE_FINDINGS.md`, then
compare named hot leaves to the current module timer list.

Add timers for leaves that are more than 2% of total time and not already
covered. Remove or merge timers for modules that stay below 1% of total time
after recent probes.
