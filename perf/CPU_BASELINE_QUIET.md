# Clean CPU Baseline

**Date:** 2026-05-08
**Host:** Mac-Mini-Upstairs.local
**Git commit:** `26e7489bf959cde8ba008af3b7d19eed44948ffd`
**Git state:** dirty worktree
**Runtime:** `rust-native-compact`, parametric mode, Node v23.11.0
**Native build:** `npm run engine:rust:build:napi`

## Pre-Run State

- Power: AC power confirmed with `pmset -g batt`.
- Spotlight: could not disable indexing because `sudo mdutil -a -i off`
  requires an interactive password. Indexing remained enabled.
- Cooldown: waited 5 minutes after setup before timing.
- Repeat spacing: each repeat was run as a separate `--repeats 1` command with
  a 2-minute cooldown between repeats.
- Caveat: Codex remained active because this run was executed from Codex.
  Chrome helper processes were visible but low before the benchmark began.

## 5,000 Policies x 5,000 Trials

Label: `quiet-baseline-5000x5000`

| Repeat | Wall time | Mean ms/policy | Report |
|---:|---:|---:|---|
| 1 | 176.12 s | 35.21 ms | `out/cpu-baseline/2026-05-08T15-49-47-110Z-rust-native-compact-parametric-r1.json` |
| 2 | 173.83 s | 34.76 ms | `out/cpu-baseline/2026-05-08T15-54-51-369Z-rust-native-compact-parametric-r1.json` |
| 3 | 172.65 s | 34.53 ms | `out/cpu-baseline/2026-05-08T15-59-51-646Z-rust-native-compact-parametric-r1.json` |

Median wall time: **173.83 s**
Median mean time: **34.76 ms/policy**
Spread: **2.00%** of median
Validation status: **clean / decision-quality**

Comparison to prior baseline:

| Baseline | Wall time | Delta |
|---|---:|---:|
| Prior noisy/pre-patch reference | 167.95 s | baseline |
| Quiet current-code median | 173.83 s | +3.50% |

The prior `167.95 s` run was collected under less controlled conditions and is
not a reliable control for judging the hot-path patch. The quiet current-code
median is the better ratchet line going forward.

## 1,000 Policies x 5,000 Trials

Label: `quiet-baseline-1000x5000`

| Repeat | Wall time | Mean ms/policy | Report |
|---:|---:|---:|---|
| 1 | 33.99 s | 33.98 ms | `out/cpu-baseline/2026-05-08T16-04-57-571Z-rust-native-compact-parametric-r1.json` |
| 2 | 35.28 s | 35.27 ms | `out/cpu-baseline/2026-05-08T16-07-46-007Z-rust-native-compact-parametric-r1.json` |
| 3 | 35.61 s | 35.60 ms | `out/cpu-baseline/2026-05-08T16-10-30-488Z-rust-native-compact-parametric-r1.json` |

Median wall time: **35.28 s**
Median mean time: **35.27 ms/policy**
Full spread: **4.58%** of median
Warm-repeat median, repeats 2-3: **35.44 s**
Warm-repeat spread, repeats 2-3: **0.92%**
Validation status: **clean with first-repeat low outlier; use warm repeats 2-3**

This confirms the earlier `86-88 s` 1K runs were environmental noise, not a
stable engine performance band.

## Decision Output

Is the new clean baseline trustworthy? **Yes.** The 5K representative workload
has a 2.00% spread across three separated repeats. The 1K sanity workload has a
first-repeat low outlier, but repeats 2 and 3 agree within 0.92%.

New ratchet line for future optimization:

| Workload | Ratchet wall time | Ratchet ms/policy |
|---|---:|---:|
| 5,000 x 5,000 | **173.83 s** | **34.76 ms/policy** |
| 1,000 x 5,000 warm repeats | **35.44 s** | **35.44 ms/policy** |

Hot-path cleanup decision: **keep for now; classify as neutral/pending rather
than proven positive.** The patch set is still in the tree. Because there is no
clean pre-patch control run under the same quiet conditions, the quiet baseline
does not prove the patch is negative. Future changes should beat `173.83 s` on
the representative workload; if this cleanup is questioned later, split-test
HSA return precompute, MAGI buffer reuse, and `select_nth_unstable`
individually under the same protocol.
