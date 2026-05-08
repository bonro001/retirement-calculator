# GPU Backend POC Results

Status: stopped at local Apple decision gate
Date: 2026-05-08
Machine tested: Apple M4 via `wgpu` Metal backend
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

## Interpretation

Stage 0 proves `wgpu` can extract meaningful compute throughput from the Apple M4 GPU for pure arithmetic.

Stage 1 fails the Apple pass gate. The required Apple speedup was at least 3x at 1K x 1K and 4x at 5K x 5K. With phase timing added and pipeline compilation excluded, the measured speedups were 1.44x and 2.49x. The likely cause is that this simplified retirement kernel has too little arithmetic per byte of output/readback, while the Rust + `rayon` CPU baseline is already very fast.

Stage 2 adds branch-heavy tax logic and degrades speedup by about 10%, which is within the planned degradation threshold. That is encouraging in isolation, but it does not overcome the low absolute speedup.

Strict output parity also fails under WGSL f32. The drift is small in planning terms, usually tens of dollars on million-dollar ending wealth, but it misses the proposed 1e-6 relative tolerance. Near-failure trials amplify relative error because tiny ending balances are branch-sensitive. Apple reports no shader f64 support through this `wgpu` adapter, so exact f64 parity is not available on this path.

## Decision

Recommendation for Apple Silicon: Path C for now. Do not commit to a full `wgpu` port based on this Mac result.

Recommendation for the overall POC: run the same binary on the AMD RX 9060 XT before making a final cross-machine decision. If AMD Stage 1/2 clears the gate by a wide margin, the project could continue as an AMD-focused acceleration path. If AMD is similarly below target, stop the GPU port and redirect effort to CPU-side optimizations.

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
