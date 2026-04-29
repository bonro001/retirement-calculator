# Retirement Autopilot System

## Goal
Build a retirement planning engine that:
- runs Monte Carlo simulations
- models taxes, IRMAA, ACA
- supports scenario sensitivity analysis
- distinguishes between faithful and reconstructed models

## Core Concepts
- Scenario = assumptions + results
- Model completeness = whether all inputs are explicitly defined
- Sensitivity analysis = multiple runs with perturbed assumptions

## Model Fidelity
- **Faithful** = all required inputs explicitly provided, no inferred assumptions
- **Reconstructed** = one or more inputs inferred or approximated
- All missing or inferred assumptions must be explicitly tracked and surfaced

## Simulation Requirements
- Monte Carlo simulations must be deterministic (seeded)
- All assumptions must be explicit or flagged as inferred
- Scenario sensitivity analysis is required (base + perturbed runs)
- Simulation outputs must include intermediate calculations where possible

## Priorities
1. Structured data over narrative
2. Deterministic reproducibility (seeded simulations)
3. Transparency of assumptions
4. Explainability of results

## Development Rules
- Never rely on inferred assumptions without flagging them
- Always store simulation outputs in structured form
- Always include a `modelCompleteness` indicator
- Always expose intermediate calculations (not just final results)
- Never hide assumptions inside logic
- Prefer TypeScript interfaces for all data structures

## Engine Modes (Phase 3 dual view, 2026-04-29)

The engine runs in two distribution modes. Both are valid; they answer
different questions.

- **Forward-looking (parametric)** — `useHistoricalBootstrap: false` (default).
  Independent bounded-normal samples per asset class with conservative
  defaults (`equityMean: 0.074`, `bondMean: 0.038`, `inflation: 0.028`).
  This is the conservative "future returns lower than past" mode and
  drives the Cockpit headline number.

- **Historical-precedent (bootstrap)** — `useHistoricalBootstrap: true`.
  iid sampling from 1926-2023 historical year tuples in
  `fixtures/historical_annual_returns.json`. Preserves joint
  distribution (asset-class correlation, inflation co-movement, real
  crisis sequences). Effective equity mean ~12.2% nominal. Shown in
  the Cockpit as the secondary "historical-precedent reading" line.

The Cockpit's `AssumptionPanel` exposes both modes' inputs side-by-side
so users understand what each headline number embodies.

When implementing engine changes, run BOTH modes through
`npm run test:calibration` and verify both pass. A change that drifts
historical mode outside ±3pp of Trinity, or shifts parametric mode
outside its current band, indicates either a real bug or an
unintentional assumption shift.

## External Validation (Phase 4, 2026-04-29)

Engine in historical mode validates within tolerance bands locked in
Phase 0.5:

- Trinity Study scenarios: ±3pp solvency
- FICalc.app cross-check: ±10pp solvency

Both pass on canonical 4% and 5% rule scenarios at 60-40 / 30-year
horizon. Full results in `CALIBRATION_WORKPLAN.md` "External validation"
section.

The parametric mode is documented to underperform published parametric
literature by ~15-25pp on these scenarios — this is a deliberate
forward-looking conservatism choice, NOT a bug. Tracked as the "Phase
2.1 ROOT CAUSE" regression test in `src/calibration.test.ts`. If a
future change closes this gap (e.g., raising `equityMean` to 0.10), the
test will catch it; the conservatism stance can be revisited but
shouldn't be silently changed.

## Headline Numbers (snapshot 2026-04-29)

User's actual plan (default seed):
- Cockpit forward-looking: **85.2% solvent / $2.48M median EW**
- Cockpit historical-precedent: **~96% solvent / ~$15.4M median EW**

Both numbers are correct under their respective assumptions. The
delta (~11pp solvency, ~$13M EW) is the conservatism premium baked
into the default forward-looking mode. Future engine changes that
move these numbers should be diagnosed (which assumption changed?
which feature shifted?) before being accepted.
