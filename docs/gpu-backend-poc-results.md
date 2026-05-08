# GPU Backend POC Results

Status: stopped at AMD/Apple decision gate
Date: 2026-05-08
Machines tested: Apple M4 via `wgpu` Metal backend; AMD Radeon RX 9060 XT via `wgpu` Vulkan backend
Production baseline to beat: `rust-native-compact`

## What Was Built

An isolated Rust POC binary was added at:

```sh
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- <stage>
```

It does not route production simulations through GPU. It contains:

- Stage 0: synthetic arithmetic shader vs Rust + `rayon`
- Stage 1: simplified 30-year Monte Carlo skeleton, one return factor per trial/year, flat tax, ending wealth per policy/trial
- Stage 2: Stage 1 plus MFJ progressive federal tax brackets
- CPU-generated replay tape uploaded as a read-only storage buffer
- CPU-side summary reductions after GPU readback
- Per-output and per-summary parity checks
- GPU phase timing split into upload/setup, dispatch/copy, and readback
- Workgroup-size override for 64/128/256 experiments

## Model Completeness

```json
{
  "modelCompleteness": "reconstructed",
  "reason": "This is a GPU feasibility model, not the production retirement model.",
  "explicitAssumptions": [
    "30-year horizon",
    "single asset return factor per trial/year",
    "constant nominal spending per policy",
    "Stage 1 flat tax rate of 12%",
    "Stage 2 MFJ ordinary federal tax brackets with standard deduction",
    "no IRMAA, ACA, RMD, Roth conversion, guardrails, mortality, Social Security, LTC, or account-bucket routing",
    "GPU math uses WGSL f32 because Apple M4 Metal adapter reports SHADER_F64 unsupported"
  ],
  "missingInputs": [
    "AMD RX 9060 XT benchmark numbers",
    "vendor profiler divergence metrics",
    "production-engine parity against rust-native-compact"
  ]
}
```

## Commands Run

```sh
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage0 --items 1000000 --inner-iters 1000 --workgroup-size 256
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage1 --policies 1000 --trials 1000 --workgroup-size 256
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage1 --policies 5000 --trials 5000 --workgroup-size 256
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage2 --policies 1000 --trials 1000 --workgroup-size 256
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage2 --policies 5000 --trials 5000 --workgroup-size 256
```

## Hardware / Backend

```text
adapter name="Apple M4" vendor=0 device=0 backend=Metal
max_buffer=9534832640
max_storage_binding=4294967295
shader_f64_supported=false
```

## Results

### Apple M4 / Metal

| Stage | Workload | CPU ms | GPU ms | Upload ms | Dispatch/copy ms | Readback ms | Speedup | Parity |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Stage 0 arithmetic | 1,000,000 items x 1,000 loop iters | 735.326 | 19.058 | n/a | n/a | n/a | 38.58x | pass, exact within 1e-6 |
| Stage 1 simplified | 1,000 x 1,000 | 5.594 | 3.891 | 0.393 | 3.044 | 0.454 | 1.44x | fail strict; max abs $28 |
| Stage 1 simplified | 5,000 x 5,000 | 131.596 | 52.812 | 0.270 | 40.836 | 11.706 | 2.49x | fail strict; max abs $88 |
| Stage 2 bracketed tax | 5,000 x 5,000 | 147.126 | 65.352 | 0.260 | 52.235 | 12.857 | 2.25x | fail strict; max abs $96 |

Stage 2 degradation at 5,000 x 5,000:

```text
2.49x -> 2.25x = 9.6% speedup degradation
```

The branch degradation itself is not the major issue. The absolute Stage 1/2 speedup is the issue.

### AMD Radeon RX 9060 XT / Vulkan

| Stage | Workload | CPU ms | GPU ms | Upload ms | Dispatch/copy ms | Readback ms | Speedup | Parity |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Stage 0 arithmetic | 1,000,000 items x 1,000 loop iters | 270.011 | 12.022 | 4.262 | 7.336 | 0.424 | 22.46x | pass, exact within 1e-6 |
| Stage 1 simplified | 5,000 x 5,000, wg256 | 75.026 | 46.559 | 10.768 | 25.334 | 10.456 | 1.61x | fail strict; max abs $88 |
| Stage 2 bracketed tax | 5,000 x 5,000, wg256 | 72.895 | 48.857 | 12.426 | 26.958 | 9.474 | 1.49x | fail strict; max abs $96 |
| Stage 1 simplified | 5,000 x 5,000, wg64 | 83.259 | 46.734 | 11.917 | 25.329 | 9.488 | 1.78x | fail strict; max abs $88 |
| Stage 1 simplified | 5,000 x 5,000, wg128 | 77.359 | 49.181 | 13.222 | 26.781 | 9.178 | 1.57x | fail strict; max abs $88 |

The first DX12-labeled run still reported `backend=Vulkan`, so it was not a real DX12 comparison. The harness was patched afterward to force `WGPU_BACKEND=dx12` at instance creation time.

## Interpretation

Stage 0 proves `wgpu` can extract meaningful compute throughput from both tested GPUs for pure arithmetic.

Stage 1 fails the Apple pass gate. The required Apple speedup was at least 3x at 1K x 1K and 4x at 5K x 5K. With phase timing added and pipeline compilation excluded, the measured speedups were 1.44x and 2.49x. The likely cause is that this simplified retirement kernel has too little arithmetic per byte of output/readback, while the Rust + `rayon` CPU baseline is already very fast.

Stage 2 adds branch-heavy tax logic and degrades speedup by about 10%, which is within the planned degradation threshold. That is encouraging in isolation, but it does not overcome the low absolute speedup.

AMD also fails the 5K x 5K gate. The best observed Vulkan Stage 1 speedup was 1.78x. Even the dispatch-only ceiling is roughly 3x before upload/readback, so the result is not only a PCIe transfer problem. The retirement kernel shape is too low-intensity relative to the already-fast Rust CPU baseline.

Strict output parity also fails under WGSL f32. The drift is small in planning terms, usually tens of dollars on million-dollar ending wealth, but it misses the proposed 1e-6 relative tolerance. Near-failure trials amplify relative error because tiny ending balances are branch-sensitive. Apple reports no shader f64 support through this `wgpu` adapter, so exact f64 parity is not available on this path.

## Decision

Recommendation: Path C overall. Do not commit to a full `wgpu` port for this workload.

Both Apple and AMD show strong Stage 0 arithmetic throughput and weak Stage 1/2 retirement-kernel throughput. That points to workload shape rather than a single platform issue. Redirect effort to CPU-side optimization: SIMD/layout audit, reducing per-policy overhead, keeping replay tape/session data resident, and improving `rayon` partitioning.

## Next Useful AMD Command

On Windows, after building the Rust crate:

```powershell
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage0 --items 1000000 --inner-iters 1000 --workgroup-size 256
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage1 --policies 5000 --trials 5000 --workgroup-size 256
cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage2 --policies 5000 --trials 5000 --workgroup-size 256
```

Record the active backend and phase timings. The original POC preferred Vulkan on AMD, but DX12 is worth testing too:

```powershell
$env:WGPU_BACKEND="vulkan"; cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage1 --policies 5000 --trials 5000 --workgroup-size 256
$env:WGPU_BACKEND="dx12"; cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage1 --policies 5000 --trials 5000 --workgroup-size 256
```

If the faster backend is not obvious, run workgroup-size probes:

```powershell
foreach ($wg in 64,128,256) {
  cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage1 --policies 5000 --trials 5000 --workgroup-size $wg
}
```

Interpretation thresholds for AMD:

- `>= 6x` at Stage 1/2 5K x 5K: continue as an AMD-focused GPU path.
- `4x-6x`: project remains alive with reduced expectations and transfer-residency optimization work.
- `< 3x`, especially if dispatch dominates rather than readback: stop and return to CPU-side optimization.
