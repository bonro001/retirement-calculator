# CPU Baseline Findings

**Date:** 2026-05-08
**Host measured here:** Mac-Mini-Upstairs.local, arm64, Node v23.11.0, Cargo 1.95.0
**Git:** `26e7489` with a dirty worktree
**Primary workload:** 5,000 policies x 5,000 trials, parametric mode, `rust-native-compact`

This is the CPU optimization baseline before PGO/allocation/SIMD/Rayon work.
It is local to Mac-Mini-Upstairs; DESKTOP and M2 still need to run the same
commands on their own hardware to complete the cross-machine table.

## Baseline Numbers

Command:

```bash
npm run perf:cpu-baseline -- \
  --policies 5000 \
  --trials 5000 \
  --repeats 1 \
  --mode parametric \
  --label Mac-Mini-Upstairs-5000x5000 \
  --write-request perf/cpu-baseline-request.json
```

Artifacts:

- JSON report: `out/cpu-baseline/2026-05-08T13-25-53-562Z-rust-native-compact-parametric-r1.json`
- CSV history: `perf/cpu-baseline-history.csv`
- representative request: `perf/cpu-baseline-request.json` (61 MB)
- Node/NAPI profile sample: `perf/cpu-baseline-node-sample.txt`
- CLI allocation probe: `/tmp/engine-candidate-baseline-response.json` plus stderr counter output

| Metric | Value |
|---|---:|
| Wall time | 167.95 s |
| Mean ms/policy | 33.59 ms |
| Median ms/policy | 32.08 ms |
| p95 ms/policy | 45.74 ms |
| p99 ms/policy | 47.11 ms |
| Throughput | 1,786 policies/min |
| Projected full universe, 12,342 policies | 6.91 min |

## Phase Split

| Phase | Total | Share |
|---|---:|---:|
| Native Rust response wait | 166.84 s | 99.34% |
| Seed prep | 0.370 s | 0.22% |
| Native request serialize/pack | 0.213 s | 0.13% |
| Tape generation | 0.108 s | 0.06% |
| Response parse | 0.082 s | 0.05% |
| Evaluation object build | 0.083 s | 0.05% |
| Enumeration | 0.004 s | ~0% |
| Ranking | 0.002 s | ~0% |

Conclusion: the next wins must be inside Rust simulation logic. JS-side
enumeration, ranking, request construction, tape generation, and output are
already noise at this scale.

## Cache And Payload

| Metric | Value |
|---|---:|
| Replay tape cache | 4,999 hits / 5,000 |
| Compact native tape cache | 4,999 hits / 5,000 |
| Request bytes total | 68.5 MB |
| Average request bytes | 13.7 KB |
| Tape bytes sent | 15.4 MB |
| Tape bytes saved by compact session cache | 76.8 GB |
| Response bytes total | 7.5 MB |
| RSS delta | +197 MB |
| V8 heap delta | +136 MB |

The compact tape/session cache is doing real work. Without it, the run would
try to move roughly 77 GB of tape data through the host boundary.

## Allocation Probe

Command:

```bash
cargo run --release --features allocation-counters \
  --manifest-path flight-engine-rs/Cargo.toml \
  --bin engine_candidate -- \
  --allocation-report < perf/cpu-baseline-request.json \
  > /tmp/engine-candidate-baseline-response.json
```

Output:

```text
allocation_report allocations=1370559 deallocations=1370497 net_allocations=62 allocated_bytes=46360728 deallocated_bytes=46353449 net_bytes=7279
```

Caveat: this allocation probe exercises the CLI JSON request path, not the
NAPI compact-session path used by the primary baseline. It is still useful for
the request artifact, but do not treat it as the NAPI hot-loop allocation
truth. If allocation count becomes the next gate, add an exported NAPI
allocation counter or run Instruments Allocations against the Node/NAPI path.

## Profile Evidence

`cargo flamegraph` installed successfully, but the macOS `xctrace` export path
failed to collapse the recorded trace:

```text
Error: unable to collapse generated profile data
Read xml event failed: IllFormed(MismatchedEndTag { expected: "frame", found: "backtrace" })
```

Fallback used:

```bash
npm run perf:cpu-baseline -- \
  --policies 2000 \
  --trials 5000 \
  --repeats 1 \
  --mode parametric \
  --label Mac-Mini-Upstairs-profile-2000x5000

sample <node-pid> 15 -file perf/cpu-baseline-node-sample.txt
```

The profile run was consistent with the primary baseline:

| Metric | Value |
|---|---:|
| Wall time | 69.88 s |
| Mean ms/policy | 34.93 ms |
| p95 ms/policy | 47.55 ms |
| Throughput | 1,717 policies/min |
| Native response wait | 69.34 s |

Readable hot clusters in `perf/cpu-baseline-node-sample.txt`:

| Hot area | Evidence |
|---|---|
| Main simulation loop | `flight_engine::candidate_engine::handle_request_with_replay_tape` dominates the `flight_engine_napi.node` frames. |
| Federal tax | Repeated large branches under `federal_tax_exact`. This is the clearest named leaf hot spot. |
| Compact tape year access | `CompactSummaryTapeInput::year_at` appears in the NAPI compact path. |
| Percentiles/sorting | `core::slice::sort::stable::driftsort_main` and quicksort frames show up under summary construction. |
| Healthcare premiums | `compute_healthcare_premium_cost` appears repeatedly, smaller than federal tax. |
| Withdrawals | `take_from_bucket` appears, smaller but visible. |
| JSON/value pointer access | A few `serde_json::Value::pointer` frames remain inside the Rust candidate engine. These are likely low-hanging allocation/string-lookup targets if they occur inside per-year/per-trial paths. |

## PGO Gate

Manual PGO was tested locally because `cargo pgo` was not installed. The
instrumented training run used `1,000 policies x 5,000 trials`; the PGO-use
comparison used the representative `5,000 x 5,000` workload.

| Run | Wall | Mean ms/policy | Read |
|---|---:|---:|---|
| Clean baseline, `5,000 x 5,000` | 167.95 s | 33.59 ms | Source of truth |
| PGO training, `1,000 x 5,000` | 108.76 s | 108.71 ms | Instrumented, expected slow |
| PGO-use, `5,000 x 5,000` | 347.12 s | 69.42 ms | Rejected |

Decision: reject PGO for now. It was materially slower on this machine and
requires careful artifact hygiene; an incremental rebuild after PGO remained
slow until the release target was cleaned. Revisit only after the workload is
stable and the build can isolate PGO artifacts cleanly.

## First Hot-Path Audit

Applied a small Rust hot-path cleanup after rejecting PGO:

- precompute HSA return weights once in `SimulationConstants`, avoiding
  per-trial-year JSON pointer lookup and string formatting for HSA returns
- reuse the MAGI history buffer across trials instead of allocating one vector
  per trial
- replace full sorting for median/percentile summaries with
  `select_nth_unstable`

Validation:

```bash
cargo check --manifest-path flight-engine-rs/Cargo.toml --bin engine_candidate
cargo check --features allocation-counters --manifest-path flight-engine-rs/Cargo.toml --bin engine_candidate
npm run test:calibration
```

Result: all checks passed; calibration was 12/12.

Performance note: the Mac was noisy during this pass, with Chrome/WindowServer
and Codex consuming substantial CPU. The post-patch `1,000 x 5,000` run
returned to the healthy range (`38.53 s`, `38.49 ms/policy`) after slow cleanup
runs around `86-88 ms/policy`. The post-patch representative run was
`180.61 s`, `36.12 ms/policy`, which is not a clean win against the original
`167.95 s` baseline and should be rerun under quiet-machine conditions before
claiming speedup.

## Cross-Machine Status

| Machine | Status |
|---|---|
| Mac-Mini-Upstairs | Measured in this doc. |
| M2 | Not reachable from this shell; run the same `perf:cpu-baseline` command there. |
| DESKTOP | Not reachable from this shell; run the same `perf:cpu-baseline` command there. |
| ATH | No Cargo; use TS-only baseline or committed native prebuilt only. |

## Immediate Read

This is a good CPU optimization target: the time is concentrated almost
entirely in Rust native simulation, not in JS orchestration. The highest-signal
next pass is not GPU, IPC, or cache work. It is Rust hot-loop work:

1. Federal tax path audit.
2. Repeat representative benchmark under quiet-machine conditions.
3. If the hot-path cleanup remains neutral or positive, keep it; otherwise
   split-test HSA precompute, MAGI reuse, and percentile selection separately.
4. Compact tape row access/layout audit.
5. Rayon/cache partitioning after the scalar hot spots are understood.
