# Engine Compare Loop

Local-only parity workflow for comparing the calibrated TypeScript engine
against an external candidate runtime.

## Tape Replay

Record a transformed stochastic tape and replay it through TypeScript:

```bash
npm run engine:compare -- --trials 200 --mode raw_simulation --record-tape out/tape.json
npm run engine:compare -- --trials 200 --mode raw_simulation --replay-tape out/tape.json
```

Compare TypeScript reference against the TypeScript out-of-process candidate:

```bash
npm run engine:compare -- \
  --trials 200 \
  --mode raw_simulation \
  --candidate-command "node --import tsx scripts/engine-candidate-ts.ts"
```

Compare TypeScript reference against the Rust CLI candidate:

```bash
npm run engine:rust:build:cli
npm run engine:compare -- \
  --trials 200 \
  --mode raw_simulation \
  --candidate-command "flight-engine-rs/target/debug/engine_candidate"
```

Release-mode Rust candidate:

```bash
npm run engine:rust:build:cli:release
npm run engine:compare -- \
  --trials 200 \
  --mode raw_simulation \
  --candidate-command "flight-engine-rs/target/release/engine_candidate"
```

Local checkpoint timing on this machine for `planner_enhanced` / 1,000 trials:

- TypeScript reference inside `engine:compare`: ~1.13s
- Rust debug candidate process: ~7.30s
- Rust release candidate process: ~1.76s

The CLI candidate still pays JSON serialization and process-spawn overhead.
Treat these as replay-harness timings, not final N-API/native-host throughput.

Warm-process benchmark mode keeps the Rust process alive and sends repeated
newline-delimited candidate requests:

```bash
npm run engine:benchmark -- \
  --trials 1000 \
  --mode planner_enhanced \
  --iterations 5
```

The default benchmark command is
`flight-engine-rs/target/release/engine_candidate --stdio-loop`.

Local warm-process checkpoint on this machine:

- `planner_enhanced` / 200 trials / 3 iterations:
  - TypeScript reference: ~223ms
  - Rust release warm candidate avg: ~251ms
- `planner_enhanced` / 1,000 trials / 5 iterations:
  - TypeScript reference: ~1.33s
  - Rust release warm candidate avg: ~1.48s, best sample ~1.23s

This confirms process startup is mostly gone in warm mode; the remaining
overhead is dominated by JSON request/response shape and summary diagnostics.

Summary-only benchmark mode compares Rust `full_trace` responses against
`policy_mining_summary` responses:

```bash
npm run engine:benchmark -- \
  --trials 1000 \
  --mode planner_enhanced \
  --iterations 3 \
  --compare-output-levels \
  --json
```

Local checkpoint after pruning summary-mode trace construction:

- `planner_enhanced` / 1,000 trials / 3 iterations:
  - full trace Rust avg: ~1.37s
  - summary-only Rust avg: ~1.17s
  - response bytes: ~17.08MB -> ~1.6KB
  - summary-only speedup: ~1.17x
- `planner_enhanced` / 5,000 trials / 3 iterations:
  - full trace Rust avg: ~8.39s
  - summary-only Rust avg: ~6.05s
  - response bytes: ~85.33MB -> ~1.7KB
  - summary-only speedup: ~1.39x

Historical bootstrap uses the same loop:

```bash
npm run engine:compare -- \
  --trials 200 \
  --mode raw_simulation \
  --historical \
  --candidate-command "flight-engine-rs/target/debug/engine_candidate"
```

Run the four replay gates before trusting a candidate change:

```bash
npm run engine:compare -- --trials 200 --mode raw_simulation --candidate-command "flight-engine-rs/target/debug/engine_candidate"
npm run engine:compare -- --trials 200 --mode planner_enhanced --candidate-command "flight-engine-rs/target/debug/engine_candidate"
npm run engine:compare -- --trials 200 --mode raw_simulation --historical --candidate-command "flight-engine-rs/target/debug/engine_candidate"
npm run engine:compare -- --trials 200 --mode planner_enhanced --historical --candidate-command "flight-engine-rs/target/debug/engine_candidate"
```

Policy-axis replay can be checked with `--withdrawal-rule`:

```bash
npm run engine:compare -- \
  --trials 50 \
  --mode planner_enhanced \
  --withdrawal-rule proportional \
  --candidate-command "flight-engine-rs/target/debug/engine_candidate"
```

Supported rules are `tax_bracket_waterfall`, `reverse_waterfall`,
`proportional`, and `guyton_klinger`.

## Cluster Shadow And Dry-Run Modes

Node hosts understand three engine runtimes:

- `ENGINE_RUNTIME=ts`: TypeScript-only authoritative evaluation.
- `ENGINE_RUNTIME=rust-shadow`: TypeScript remains authoritative; Rust summary
  runs beside it and only mismatches/errors/skips are logged.
- `ENGINE_RUNTIME=rust-dry-run`: TypeScript remains authoritative; every policy
  writes a JSONL event containing the TS summary, Rust summary, comparison
  result, tape metadata, and timing telemetry.

Shadow and dry-run stats include per-batch timing totals and averages:

```ts
{
  timings: {
    tsEvaluationDurationMsTotal: number,
    rustSummaryDurationMsTotal: number,
    tsEvaluationDurationMsAverage: number,
    rustSummaryDurationMsAverage: number
  }
}
```

Run a focused shadow smoke:

```bash
npm run engine:rust-shadow:smoke -- \
  --runtime rust-shadow \
  --policies 8 \
  --trials 40 \
  --fail-on-mismatch \
  --json
```

Run a focused dry-run smoke with retained summary records:

```bash
npm run engine:rust-shadow:smoke -- \
  --runtime rust-dry-run \
  --policies 8 \
  --trials 40 \
  --log out/rust-dry-run-parametric.jsonl \
  --fail-on-mismatch \
  --json
```

Analyze a dry-run JSONL:

```bash
npm run engine:rust-dry-run:analyze -- \
  --log out/rust-dry-run-parametric.jsonl \
  --fail-on-mismatch
```

When `RUST_DRY_RUN_OUTPUT_PATH` is not set, dry-run records are written under
`out/rust-dry-run/` with host/session/runtime/engine/pid in the filename. This
keeps multi-host scratch logs from colliding. Passing `--log` to the smoke
command or setting `RUST_DRY_RUN_OUTPUT_PATH` still uses the explicit path.

Run the strict four-cell matrix in one command:

```bash
npm run engine:rust-parity:matrix -- \
  --policies 160 \
  --trials 80 \
  --workers 1
```

The matrix runs:

- `rust-shadow` / parametric
- `rust-shadow` / historical
- `rust-dry-run` / parametric
- `rust-dry-run` / historical

It always uses `--fail-on-mismatch`, retains one JSONL log per cell under
`out/rust-parity-matrix/`, and writes a machine-readable matrix report JSON.

## Native Compact Runtime Gates

`rust-native-compact` is the authoritative Node-host accelerator path. It uses
the Rust N-API addon, compact typed-array replay tapes, and a native tape-session
cache so a worker registers the stochastic tape once and then reuses it by id.

Build the native addon after Rust-side changes:

```bash
npm run engine:rust:build:napi
```

Fast local guard, both forward-looking and historical:

```bash
npm run engine:rust-runtime:guard
```

Expected gate:

- `pass=true`
- `rust-native-compact` speedup at least `5x` vs `ts`
- tape and packed-tape cache hit rates at least `80%`
- `mismatches=0`
- `npm run test:calibration` still passes

Worker-pool smoke guards:

```bash
npm run cluster:host-smoke:rust-guard
npm run cluster:host-smoke:rust-guard:historical
```

Expected gate:

- runtime is `rust-native-compact`
- `mismatches/errors/skipped = 0/0/0`
- cache hit rates at least `80%`
- no more than `25ms/policy`

Production-shaped authoritative soak:

```bash
npm run cluster:host-soak:rust
npm run cluster:host-soak:rust:historical
```

Broaden the policy-axis slice with an offset stride:

```bash
npm run cluster:host-soak:rust:offset
npm run cluster:host-soak:rust:historical:offset
```

Expected gate:

- `500` policies x `1000` trials x `4` workers
- runtime is `rust-native-compact`
- `mismatches/errors/skipped = 0/0/0`
- cache hit rates at least `95%`
- no more than `25ms/policy`
- tape payload avoided should be materially larger than payload sent

Default-runtime threshold:

Do not make Rust the default cluster runtime until all of these are boring:

1. `npm run engine:rust-parity:matrix -- --policies 120 --trials 160 --workers 2`
   passes with zero mismatches/errors/skips.
2. Both `cluster:host-smoke:rust-guard` scripts pass.
3. Both `cluster:host-soak:rust` scripts pass.
4. `npm run engine:rust-runtime:guard` passes.
5. `npm run test:calibration` passes.

Rollback path is intentionally simple: set `ENGINE_RUNTIME=ts` on cluster hosts.
The TypeScript engine remains the calibrated fallback and the replay/shadow
tools remain available for diagnosis.

Default-runtime switch:

Hosts still default to TypeScript when no runtime is configured. After the
gate above has stayed green, set `ENGINE_RUNTIME_DEFAULT=rust-native-compact`
on cluster hosts to opt the fleet into Rust without removing the emergency
override. `ENGINE_RUNTIME=ts` wins over the default and remains the immediate
rollback.

Real dispatcher smoke:

Run these in three terminals on the dispatcher machine. The first command binds
localhost only; omit `:local` when running on the LAN and you want remote hosts
to connect.

```bash
npm run cluster:dispatcher:local
npm run cluster:host:rust
npm run cluster:start-session:rust-local
```

Equivalent explicit commands:

```bash
DISPATCHER_HOST=127.0.0.1 node --import tsx cluster/dispatcher.ts
ENGINE_RUNTIME_DEFAULT=rust-native-compact HOST_WORKERS=4 node --import tsx cluster/host.ts
DISPATCHER_URL=ws://127.0.0.1:8765 SESSION_TRIAL_COUNT=1000 SESSION_MAX_POLICIES=500 node --import tsx cluster/start-session.ts
```

Expected gate:

- controller reaches `session ended, closing`
- host telemetry reports `runtime=rust-native-compact`
- dispatcher writes the session corpus without dropped or errored batches
- rollback remains `ENGINE_RUNTIME=ts npm run cluster:host`

Shadow-mode decision:

Keep `rust-shadow`, `rust-native-shadow`, and `rust-native-compact-shadow` as
diagnostic modes rather than optimizing them with native tape sessions. Their
job is to preserve per-policy replay artifacts and make mismatches easy to
inspect. The native tape-session cache is reserved for
`ENGINE_RUNTIME=rust-native-compact`, where Rust is authoritative and repeated
tape transfer is pure overhead.

Synthetic or exported seeds can be checked with `--data`:

```bash
npm run engine:compare -- \
  --data out/synthetic-seed.json \
  --trials 50 \
  --mode planner_enhanced \
  --candidate-command "flight-engine-rs/target/debug/engine_candidate"
```

## Debug Artifacts

Write the exact candidate stdin, TypeScript reference path, and candidate
response:

```bash
npm run engine:compare -- \
  --trials 50 \
  --mode raw_simulation \
  --candidate-command "flight-engine-rs/target/debug/engine_candidate" \
  --write-request out/request.json \
  --write-reference out/reference.json \
  --write-candidate out/candidate.json
```

## Candidate Protocol

Candidate command reads one JSON object from stdin:

```ts
{
  schemaVersion: 'engine-candidate-request-v1',
  data: SeedData,
  assumptions: MarketAssumptions,
  mode: 'planner_enhanced' | 'raw_simulation',
  tape: SimulationRandomTapeV1
}
```

Candidate command writes one JSON object to stdout:

```ts
{
  schemaVersion: 'engine-candidate-response-v1',
  runtime: string,
  path: PathResult,
  diagnostics?: Record<string, unknown>
}
```

The tape contains already-transformed stochastic and replay-debug values:
per-trial seed, LTC event boolean, per-year inflation, per-year asset-class
returns, bucket returns, market state, yearly cashflow, RMD surplus-to-cash,
and guardrail spending-cut signals. Candidate runtimes must not call RNG for
modeled randomness while replaying a tape.

## Current Rust Coverage

`flight-engine-rs/target/debug/engine_candidate` currently models:

- replayed market returns from the tape
- bucket-level return application, preferably from tape bucket returns
- salary cutoff and pre-retirement contribution logic, including TS-compatible
  contribution rounding
- Social Security household income, including spousal floor and deterministic
  survivor switch inputs
- cash windfalls and taxable windfall income for non-taxable cash, ordinary
  income, LTCG, inherited-IRA annual distributions, and primary-home-sale
  exclusion / selling-cost cases
- guardrail spending-cut state and base spending before healthcare
- LTC event cost using the dedicated LTC inflation assumption
- RMD calculation and income assembly
- federal tax calculation for wages, Social Security taxation, pretax
  withdrawals/conversions, taxable-account realized gains, windfall ordinary
  income / LTCG, age-65 standard deduction bump, NIIT, and additional Medicare
  tax
- IRMAA tier/exposure classification from Rust-computed MAGI history
- healthcare premium cost and HSA offset
- withdrawal source selection across the current withdrawal-rule axis
- proactive Roth conversion candidate scoring and amount selection
- Rust-computed yearly balances, trial success/failure, ending wealth,
  failure-year distribution, worst/best outcomes, IRMAA exposure, home-sale /
  inheritance dependence, Roth depletion, and guardrail spending-cut rate
- shared sub-cent shortfall handling: remaining withdrawal need below `$0.01`
  is treated as zero, which avoids false failures from floating-point dust

Still missing for parity:

- full `PathResult` / yearly trace fields
