# flight-engine-rs

**Status: dormant. Not wired into the application.**

Experimental Rust port of the Monte Carlo retirement engine that lives in
`src/utils.ts`. Was reachable through a Cockpit debug card during a parity
exploration; that UI surface was removed once we decided the TS engine
would remain the single source of truth.

## Why it exists

Two original motivations:
1. Performance — Rust+WASM ran ~5× faster on hot-loop simulations than the
   TS engine in browser benchmarks.
2. Cluster mining throughput — friends running the calculator on weak
   hardware were the slowest link.

## Why it's not in use

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

The project doesn't currently need the speedup enough to justify the
maintenance cost.

## What's worth keeping

- The crate compiles and the WASM bridge worked.
- The bug-finding from the parity session uncovered real semantic
  questions about TS's modeling choices (HSA fold-into-pretax,
  inheritance-as-income, LTC inflation timing, freezeline behavior).
  Those are captured in `BACKLOG.md`.
- This source is a useful reference if anyone wants to revisit Rust
  acceleration, GPU offload, or a native cluster host implementation.

## Reviving it

If you decide to wire it back in:

1. Add `wasm:build` and `wasm:build:node` scripts to root `package.json`.
2. Restore `src/wasm-engine.ts` (the TS↔WASM adapter — lost in the revert).
3. Add a per-account allocation pass-through, multi-pass tax recalc, and
   the multi-objective withdrawal optimizer port.
4. Build a calibration test suite covering 5+ canonical retirement scenarios
   before exposing any UI surface.
5. Don't expose a "trust me, it's close" button.
