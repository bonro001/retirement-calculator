# CPU Optimization Stop Report

Date: 2026-05-08
Primary host: Mac-Mini-Upstairs.local
Primary workload: 5,000 policies x 5,000 trials, parametric,
`rust-native-compact`

## Decision

Pause active CPU optimization after cross-machine validation on M2 and DESKTOP.
Do not start the closed-loop withdrawal redesign unless validation exposes a
platform-specific regression or a future representative workload changes the
profile.

## Outcome

| Milestone | Median | ms/policy | Delta vs previous | Delta vs original |
|---|---:|---:|---:|---:|
| Original quiet baseline | 173.83 s | 34.76 ms | - | - |
| Roth stack-buffer cleanup | 158.34 s | 31.67 ms | -8.91% | -8.91% |
| Healthcare ACA work gate | 138.91 s | 27.78 ms | -12.27% | -20.09% |
| Roth fast-tax evaluator | 125.68 s | 25.14 ms | -9.53% | -27.70% |

Total validated Mac speedup: `48.15 s`, `27.70%`.

## What Worked

The key win was not GPU offload. It was CPU observability:

- clean quiet baseline
- tax counters
- module timers
- proof ladder thresholds
- calibration gate after every kept engine change
- three-repeat quiet confirmation before ratcheting

That instrumentation identified unexpected hot work in Roth conversion
candidate evaluation and healthcare premium calculation.

## Kept Infrastructure

- `scripts/cpu-baseline.ts`
- `perf/cpu-baseline-history.csv`
- `perf/CPU_OPTIMIZATION_PROOF_LADDER.md`
- feature-gated Rust counters/timers:
  - `tax-counters`
  - `module-timers`
  - `allocation-counters`
- `FLIGHT_ENGINE_RUST_FEATURES` support in `scripts/build-rust-napi.mjs`

These remain useful for future regressions and future workload changes.

## Remaining Hot Path

Latest module-timer-only probe after the kept changes:

| Module | Upper bound in 1K x 5K instrumented probe |
|---|---:|
| `withdrawalAttempt` | 60.26 s |
| `federalTaxExact` | 36.39 s |
| `ordinaryTax` | 15.87 s |
| `healthcarePremium` | 10.28 s |
| `compactYearAt` | 2.91 s |
| `percentile` | 0.21 s |

The largest remaining target is the closed-loop withdrawal wrapper. It is
behavior-sensitive because any change may affect withdrawals, MAGI, taxes,
healthcare premiums, HSA offsets, and downstream solvency. It should require a
shadow probe before implementation.

## Stop Rationale

The easy work-elimination wins have been taken. Remaining candidates are likely
to be smaller, noisier, and more correctness-sensitive:

- `compactYearAt` already had one attempted layout simplification regress.
- `percentile` is below measurement-worthy threshold.
- healthcare has remaining upper bound, but the obvious ACA gate and per-year
  context hoist are already done.
- closed-loop withdrawal is real model logic, not obvious duplicate work.

The optimization infrastructure can keep finding 1-3% candidates, but the
effort/risk profile is now worse than during the 28% win.

## Cross-Machine Gate

Before stopping, validate on M2 and DESKTOP using
`docs/cpu-optimization-baseline.md`.

Current status:

| Host | Status | Median | Spread | Notes |
|---|---|---:|---:|---|
| M2 / Mac-Mini-Upstairs.local over SSH | rerun needed | 123.88 s | 11.64% | rejected because Chrome/video/Codex/Mail activity made the run noisy |
| M2 / Robs-Mac-mini.local | accepted | 176.27 s | 0.33% | optimized copied tree, Node v24.15.0, `caffeinate`; prior Node 20 run rejected |
| DESKTOP-LT718F9 | accepted | 213.37 s | 0.15% | optimized tree copied over SSH; calibration passed |

Acceptance:

- calibration passes on each machine
- three-repeat spread is less than 5%
- performance is directionally consistent with Mac after accounting for machine
  speed

Both cross-machine validation runs have now passed. Stop active optimization and
treat `125.68 s` as the Mac-Mini-Upstairs ratchet, `176.27 s` as the M2 ratchet,
and `213.37 s` as the DESKTOP ratchet.

If either machine fails calibration, fix correctness before measuring speed.

If either machine shows a material platform-specific regression, investigate
that regression only; do not reopen general CPU optimization.
