# Flight Path

A retirement planning engine and Cockpit UI. Runs seeded Monte Carlo
simulations against a household plan and tells you whether the plan
holds up across thousands of stochastic futures.

The headline view is the **Cockpit** — a single-page surface with the
TRUST number ("how often do I stay solvent?"), median ending wealth,
year-by-year projections, sensitivity sweeps, and a stress-testing
sandbox. Underneath is a TypeScript Monte Carlo engine that models
taxes (federal + IRMAA + LTCG), Social Security, RMDs, ACA premiums,
HSA tax-free medical withdrawals, LTC events, Roth conversions,
windfalls (inheritance, home sale), and Guyton-Klinger guardrails.

## Quickstart

```bash
npm install
npm run dev          # open http://localhost:5173
npm run test         # full test suite (~80 files)
npm run test:calibration   # external-validation tests only (~16s)
```

## Engine modes

The Cockpit shows two solvency numbers side-by-side:

| Mode | What it embodies | When to look |
|---|---|---|
| **Forward-looking (parametric)** | Independent normal samples per asset class. Conservative future-returns thesis. equityMean ~7.4% (real ~4.6% after inflation). | Headline / planning under "future returns lower than past." |
| **Historical-precedent (bootstrap)** | iid sampling from 1926–2023 historical year tuples. Preserves joint distribution; 1929-32, 1973-74, 2008 are real options. Effective equityMean ~12.2% nominal. | Validation / "what would this plan have done?" |

The forward-looking number is the headline. The historical-precedent
number is shown alongside as grounding. Tagline in the Cockpit:
*plan with the lower number; sleep with the higher.*

## Validation status

The engine is externally validated against retirement-finance literature
under matched assumptions:

- **Trinity Study** (Cooley/Hubbard/Walz 1998): engine in historical-
  bootstrap mode produces 93.2% on 4%/60-40/30y vs Trinity's published
  ~95%. Within ±3pp.
- **FICalc.app** (independent OSS retirement Monte Carlo): engine
  matches within ±10pp on 4% and 5% scenarios.

See [`CALIBRATION_WORKPLAN.md`](./CALIBRATION_WORKPLAN.md) "External
validation" section for the full results table, methodology, and
known gaps (the parametric mode is more conservative than published
parametric estimates by design — that conservatism is documented).

CI runs `npm run test:calibration` on every change; engine drift
beyond tolerance bands fails the build.

## Architecture

- **Engine**: `src/utils.ts` (~8000 lines). Per-trial year-by-year loop:
  contributions → returns → RMDs → Roth conversions → withdrawals →
  tax/IRMAA → guardrail checks. Aggregated medians + percentiles across
  5000 trials.
- **Cluster**: `cluster/` — distributes policy mining across multiple
  hosts (laptop, mini, work mac) over WebSocket. Each host runs Node
  worker_threads. The Cockpit can also self-host browser Web Workers.
- **State**: `src/store.ts` (Zustand). Plan + assumptions live here;
  the Cockpit reads from this single source of truth.
- **Persistence**: local-first. Plans persist to localStorage. Snapshots
  for over-time tracking go to IndexedDB via `src/history-store.ts`.

## Key docs

- [`AGENTS.md`](./AGENTS.md) — system overview for agents working in this repo
- [`product-spec.md`](./product-spec.md) — what we're building and why
- [`CALIBRATION_WORKPLAN.md`](./CALIBRATION_WORKPLAN.md) — over-time
  calibration loop + external validation results
- [`BACKLOG.md`](./BACKLOG.md) — durable cross-cutting items
- [`FLIGHT_PATH_WORKPLAN.md`](./FLIGHT_PATH_WORKPLAN.md) — phase-specific work
- [`VALIDATION_WORKPLAN.md`](./VALIDATION_WORKPLAN.md) — engine validation track
- [`MINER_REFACTOR_WORKPLAN.md`](./MINER_REFACTOR_WORKPLAN.md) —
  single-source-of-truth refactor (cockpit reads from corpus, one ranker)
- [`build-notes.md`](./build-notes.md) — operational notes
- [`flight-engine-rs/README.md`](./flight-engine-rs/README.md) —
  experimental Rust port (dormant; not wired into the application)

## License

Private project. Do not redistribute without explicit permission.
