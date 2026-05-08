# CPU Optimization Baseline

This is the measurement and validation gate for the CPU optimization work. The
current goal is not to find more optimizations; it is to validate that the
Mac-Mini-Upstairs win carries to M2 and DESKTOP, then stop unless the
cross-machine results reveal a real anomaly.

## Current Ratchet

| Host | Workload | Median | ms/policy | Status |
|---|---:|---:|---:|---|
| Mac-Mini-Upstairs.local | 5,000 policies x 5,000 trials | 125.68 s | 25.14 ms | Validated |
| Robs-Mac-mini.local | 5,000 policies x 5,000 trials | 176.27 s | 35.25 ms | Validated |
| DESKTOP-LT718F9 | 5,000 policies x 5,000 trials | 213.37 s | 42.67 ms | Validated |

Original clean Mac ratchet was `173.83 s`, so the validated Mac improvement is
`-48.15 s` / `-27.70%`.

## Validation Rule

Each machine gets one clean three-repeat run:

- Same repo state or same committed branch.
- Normal NAPI build, not an instrumented build.
- AC power.
- Browsers, chat, media, and indexing-heavy apps closed.
- No optimization work during validation.
- If repeat spread is less than 5% of median, accept the machine ratchet.
- If spread is more than 5%, document interference and rerun once.

## Mac Reference Command

Already completed on Mac-Mini-Upstairs:

```bash
npm run engine:rust:build:napi
npm run perf:cpu-baseline -- \
  --policies 5000 \
  --trials 5000 \
  --repeats 3 \
  --mode parametric \
  --label roth-fast-tax-quiet-confirm
```

Accepted repeats:

| Repeat | Time |
|---|---:|
| 1 | 124.80 s |
| 2 | 125.68 s |
| 3 | 126.07 s |

Median: `125.68 s`
Spread: `1.02%`

## M2 Command

Run locally on M2 from the repo root:

```bash
git status --short
git rev-parse HEAD
hostname
npm run engine:rust:build:napi
npm run test:calibration
npm run perf:cpu-baseline -- \
  --policies 5000 \
  --trials 5000 \
  --repeats 3 \
  --mode parametric \
  --label m2-cross-machine-5000x5000
```

Expected artifacts:

- JSON reports: `out/cpu-baseline/`
- CSV history: `perf/cpu-baseline-history.csv`

## DESKTOP Command

Run locally on DESKTOP from PowerShell in the repo root:

```powershell
git status --short
git rev-parse HEAD
hostname
npm run engine:rust:build:napi
npm run test:calibration
npm run perf:cpu-baseline -- `
  --policies 5000 `
  --trials 5000 `
  --repeats 3 `
  --mode parametric `
  --label desktop-cross-machine-5000x5000
```

DESKTOP needs Cargo and the native build toolchain available locally. ATH is not
a valid Rust source-of-truth host because Cargo is not available there.

## Optional Remote Access Setup For DESKTOP

OpenSSH Server installation requires an elevated PowerShell session on DESKTOP:

```powershell
Start-Process powershell -Verb RunAs
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
Get-NetIPAddress -AddressFamily IPv4
```

If the capability install reports that elevation is required, reopen PowerShell
with "Run as administrator" and retry.

## Result Table To Fill

| Host | Commit | Repeat 1 | Repeat 2 | Repeat 3 | Median | Spread | Decision |
|---|---|---:|---:|---:|---:|---:|---|
| Mac-Mini-Upstairs.local | `26e7489+dirty` | 124.80 s | 125.68 s | 126.07 s | 125.68 s | 1.02% | accepted |
| Robs-Mac-mini.local | optimized tree copied over SSH, Node 24.15.0 | 176.27 s | 176.73 s | 176.15 s | 176.27 s | 0.33% | accepted |
| DESKTOP-LT718F9 | optimized tree copied over SSH | 213.58 s | 213.37 s | 213.26 s | 213.37 s | 0.15% | accepted |

## Rejected Runs

| Host | Label | Repeat 1 | Repeat 2 | Repeat 3 | Median | Spread | Decision |
|---|---|---:|---:|---:|---:|---:|---|
| Mac-Mini-Upstairs.local over SSH | `m2-cross-machine-5000x5000` | 117.62 s | 123.88 s | 132.04 s | 123.88 s | 11.64% | rejected: noisy machine |
| Robs-Mac-mini.local | `m2-cross-machine-5000x5000` | 226.78 s | 479.64 s | stopped | n/a | n/a | rejected: repeat 2 outlier |

This run used the optimized `26e7489+dirty` tree, but it is not a validation
ratchet. Active competing processes included Chrome, video services,
WindowServer, Codex, and Mail. Rerun only after those are closed and the machine
has settled.

The Robs-Mac-mini run used the optimized copied tree, but the environment still
needs cleanup before validation: Node was `v20.20.2` even though the package
requires Node 23+, and `airportd` showed elevated CPU during/after the run.

Final Robs-Mac-mini validation used Node `v24.15.0` and `caffeinate`; it is the
accepted M2 ratchet.

## Stop Decision

After M2 and DESKTOP validate directionally:

1. Record their medians and spreads in this doc.
2. Keep the CPU optimization infrastructure.
3. Stop active CPU optimization.

Only reopen optimization if a future representative workload invalidates the
profile, or if cross-machine validation shows a regression that does not
reproduce on Mac-Mini-Upstairs.

## Historical Notes

The first CPU baseline on Mac-Mini-Upstairs was `167.95 s`, but it was later
superseded by a cleaner quiet baseline of `173.83 s`. Use `173.83 s` as the
original clean comparison point and `125.68 s` as the current Mac ratchet.

The original baseline findings and profiler notes remain in
`perf/CPU_BASELINE_FINDINGS.md`. The detailed optimization log is
`perf/TAX_OPT_LOG.md`.
