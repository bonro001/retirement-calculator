# Rust Promotion Audit

Snapshot date: 2026-05-07

## Current Runtime Decision

Rust is promoted for cluster policy-mining execution.

- Default Node host runtime: `rust-native-compact`
- Explicit rollback/reference runtime: `ENGINE_RUNTIME=ts`
- Shadow/diagnostic runtimes retained: `rust-shadow`, `rust-dry-run`,
  `rust-native-shadow`, `rust-native-compact-shadow`

The TypeScript engine is no longer the implicit cluster source of truth. It is
kept as a calibrated reference, browser fallback, and replay comparison layer.

## Promoted Paths

- `npm run cluster:host` defaults to `ENGINE_RUNTIME_DEFAULT=rust-native-compact`
- `cluster/engine-runtime.ts` resolves unknown or unset runtime config to
  `rust-native-compact`
- `cluster/host-worker.ts` routes `rust-native-compact` directly through the
  native compact Rust summary path and builds policy evaluations from Rust
  summaries
- Rust compact telemetry is surfaced through host shadow stats for runtime
  confirmation and performance guards

## TypeScript Paths Still Retained

- Browser-side interactive app simulations still call `buildPathResults` in
  TypeScript
- Calibration, verification, and replay tests still use TypeScript as the
  literature-validated reference
- Export/sensitivity builders still use TypeScript `buildPathResults` because
  they need full `PathResult` diagnostics, yearly series, and model-fidelity
  metadata
- `ENGINE_RUNTIME=ts` remains an explicit rollback path for cluster hosts
- Shadow/dry-run modes intentionally run TypeScript beside Rust for mismatch
  diagnosis

## Source-Of-Truth Boundary

For policy mining at cluster scale, Rust is authoritative.

For product planner/export diagnostics, TypeScript is still authoritative until
Rust exposes full-path outputs beyond compact policy-mining summaries.

This is intentional, not two silent sources of truth: the remaining TypeScript
paths are either reference gates, browser-local execution, or diagnostic shapes
Rust does not yet emit.

## Retirement Candidates

1. Add a Rust full-path output contract for `PathResult` parity.
2. Move export replay and scenario sensitivity to Rust once the full-path
   contract exists.
3. Move browser workers to Rust/WASM or server-side Rust execution once the
   product no longer needs local TypeScript simulation fallback.
4. Keep `ENGINE_RUNTIME=ts` only as a test/reference command after full-path
   Rust parity is locked.

## Required Gates Before Removing More TypeScript

- `npm run engine:rust-parity:matrix -- --policies 120 --trials 160 --workers 2`
- `npm run cluster:host-smoke:rust-guard`
- `npm run cluster:host-smoke:rust-guard:historical`
- `npm run engine:rust-runtime:guard`
- `npm run test:calibration`
- Full-path Rust parity tests once a full `PathResult` contract exists
