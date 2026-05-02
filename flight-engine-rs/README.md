# flight-engine-rs

**Status: active native-engine experiments.**

Experimental Rust port of the Monte Carlo retirement engine that lives in
`src/utils.ts`, plus native host binaries for cluster mining.

## Why it exists

Two original motivations:
1. Performance — Rust+WASM ran ~5× faster on hot-loop simulations than the
   TS engine in browser benchmarks.
2. Cluster mining throughput — friends running the calculator on weak
   hardware were the slowest link.

## Fidelity caveats

A parity calibration session against the TS engine got Rust to within
~1pp on the user's actual seed. But:

- The freezeline guardrail used to close the last gap was tuned
  empirically to one seed. Other households were untested.
- Several behaviors in TS (multi-objective withdrawal optimizer, closed-loop
  tax recalc, per-symbol asset allocation with class mapping, historical
  bootstrap mode) are missing from the Rust port. Faithfully porting them
  is roughly 2–3 weeks of focused work plus ongoing dual-maintenance.
- The TS engine is externally validated against the Trinity Study within
  ~2-3pp when run in `useHistoricalBootstrap` mode. The Rust engine is not.

Treat new Rust runtime surfaces as operational experiments until they have
their own full calibration matrix.

## What's worth keeping

- The crate compiles, the WASM bridge worked, and the Rust replay engine is
  reachable through both the Node N-API addon and native Rust CLIs.
- The bug-finding from the parity session uncovered real semantic
  questions about TS's modeling choices (HSA fold-into-pretax,
  inheritance-as-income, LTC inflation timing, freezeline behavior).
  Those are captured in `BACKLOG.md`.
- `src/bin/retirement_worker.rs` is a native WebSocket host. It connects
  directly to the TypeScript dispatcher, advertises `rust-native-worker`,
  receives `batch_assign` messages, generates deterministic Rust-side
  replay tapes, calls the Rust candidate engine directly, and returns
  `batch_result` records without Node/tsx/npm on the worker machine.

## Native worker

Build on this Mac:

```bash
npm run cluster:rust-worker:build
```

The binary is written to:

```text
flight-engine-rs/target/release/retirement_worker
```

Run it locally against the default dispatcher:

```bash
DISPATCHER_URL=ws://127.0.0.1:8765 ./flight-engine-rs/target/release/retirement_worker
```

Useful environment variables:

- `DISPATCHER_URL`: dispatcher WebSocket URL, default `ws://localhost:8765`
- `HOST_DISPLAY_NAME`: friendly host name shown in cluster status
- `HOST_WORKERS`: concurrent batch slots, default `min(12, cpus - 2)`
- `HOST_PERF_CLASS`: `apple-silicon-perf`, `x86-modern`, etc.
- `HOST_BUILD_INFO_JSON`: optional build identity override for packaged
  binaries that are copied outside the git checkout

Current fidelity note: the worker reuses the Rust replay candidate engine,
but generates replay tapes natively rather than recording them from the
TypeScript engine. It supports the parametric and historical-bootstrap
return modes used by the cluster, but QMC/Sobol sampling is not implemented
in the native tape generator yet.

## Reviving it

If you decide to wire it back in:

1. Add `wasm:build` and `wasm:build:node` scripts to root `package.json`.
2. Restore `src/wasm-engine.ts` (the TS↔WASM adapter — lost in the revert).
3. Add a per-account allocation pass-through, multi-pass tax recalc, and
   the multi-objective withdrawal optimizer port.
4. Build a calibration test suite covering 5+ canonical retirement scenarios
   before exposing any UI surface.
5. Don't expose a "trust me, it's close" button.
