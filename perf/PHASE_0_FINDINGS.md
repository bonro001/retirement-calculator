# Phase 0 — Perf Baseline Findings

**Date:** 2026-04-27
**Host:** Mac-Mini-Upstairs.local (arm64, node v23.11.0, single thread)
**Workload:** 50 policies × 500 trials, deterministic seed (`scripts/perf-baseline.ts`)
**Profile log:** `perf/profile-baseline-2026-04-27.txt`

## Baseline numbers

| Metric                   | Value           |
|--------------------------|-----------------|
| Per-policy mean          | **504 ms**      |
| Per-policy median        | 506 ms          |
| Per-policy p95           | 660 ms          |
| Throughput (1 thread)    | **119 pol/min** |
| Full corpus (7,776), 1 thread | **65 min** |
| Full corpus, 8-worker pool    | **8.2 min** |
| Full corpus, 24-worker pool   | **2.7 min** ← M4 mini territory |

## Phase breakdown inside `evaluatePolicy`

| Phase            | Mean ms | % of policy |
|------------------|---------|-------------|
| structuredClone  | 0.1     | 0.0%        |
| applyPolicyToSeed| 0.0     | 0.0%        |
| **engine (buildPathResults)** | **504.2** | **100.0%** |
| post-process     | 0.0     | 0.0%        |

**Conclusion:** Cluster batch caching, payload trimming, and clone optimization
ideas from earlier perf brainstorming are mathematically incapable of moving
throughput. **All real wins live inside the engine call.**

## V8 profile category breakdown

| Category              | % of nonlib |
|-----------------------|-------------|
| JavaScript (compiled) | 14.3%       |
| **C++ (built-ins)**   | **80.1%**   |
| GC                    | 4.1%        |
| (shared libs)         | 17.2% total — most is `libsystem_malloc.dylib` (15.7%) |

The engine spends 80% of its CPU inside V8 built-ins (string/object/array
operations). That means the JS code is *triggering* expensive built-in
behavior — every call to `Object.entries()`, every object literal allocation,
every implicit string-keyed Map operation accrues cost in the C++ layer
without showing up as a JS hotspot.

## Top V8 built-in hotspots (the actual offenders)

| Built-in                                  | % nonlib | Likely source |
|-------------------------------------------|----------|---------------|
| `std::pair<string,string>` copy ctor      | **24.9%**| Object literals returned from hot functions (`calculateFederalTax` returns 12+ field object every call), or string-keyed Maps |
| `GeneratorPrototypeNext`                  | **15.9%**| Generator (`function*`) iteration in hot path — need to find caller |
| `Array.prototype.sort`                    | **9.5%** | `.sort()` in year loop (utils.ts has 7 sort sites; some likely per-year) |
| `Object.entries`                          | **8.5%** | `Object.entries(allocation).reduce/map(...)` per year (utils.ts:586, 595, 606, 916, 918, 932) |
| `Date.prototype.getFullYear`              | **2.2%** | `new Date(data.household.{rob,debbie}BirthDate).getFullYear()` called **per year per trial** at utils.ts:2952, 2955 |
| `Array.reduce` / `Array.map`              | ~4%      | Functional iteration over allocation pairs |

## Top JS hotspots (hand-written code)

These show direct CPU, but most of their cost is hidden in the C++ built-ins
they invoke (above table). Rank by ticks:

1. utils.ts anonymous at byte 68024 (1.7%) — wraps `simulatePath` per-year body
2. monte-carlo-engine.ts anonymous at byte 1990 (1.6%) — trial loop in `executeDeterministicMonteCarlo`
3. utils.ts at byte 13296 (1.3%)
4. **`calculateFederalTax`** in tax-engine.ts (1.0% direct + ~22% of std::pair cost)
5. `calculateHealthcarePremiums` (0.6%)
6. `applyProactiveRothConversion` (0.6%)

## Audit results (Phase 0.3)

| Suspected issue | Status | Notes |
|---|---|---|
| Within-trial ruin termination | ✅ **Already done** | `simulatePath` breaks at line 3603 when failureYear assigned. Skip from Phase 1. |
| JSON.clone overhead | ✅ **Not a hot path** | `structuredClone(SeedData)` is 0.1 ms / 0.02% of per-policy time. The MEMORY note about JSON cloning must apply elsewhere (analysis-result-cache, export pipeline). |
| Date in hot path | ❌ **CONFIRMED HOT** | `new Date(birthDate).getFullYear()` called per year per trial at simulatePath:2952, 2955. ~233M allocations per Full mine. **One-line fix per site.** |
| Lookup tables (tax brackets, RMD divisors) | ⚠️ **Partial** | Tax brackets are in `config.profiles[filingStatus]` — looked up by string key per call to calculateFederalTax. Could be cached as direct refs. |
| Object literal allocation in hot loop | ❌ **CONFIRMED MAJOR** | `calculateFederalTax` returns fresh 12+ field object every call (~117M/Full mine). Object pooling or output-arg pattern would help. |
| `Object.entries(allocation)` in year loop | ❌ **CONFIRMED HOT** | 8.5% of CPU. The `allocation` object is constant per session — can be flattened to parallel arrays once. |
| Array.sort in year loop | ❌ **PROBABLE** | 9.5% of CPU. Need to identify which sort sites are per-year vs per-session. |
| Generator (`function*`) usage | ❌ **CONFIRMED HOT** | 15.9% of CPU in `GeneratorPrototypeNext`. Not visible in `monte-carlo-engine.ts` — probably in `utils.ts` (4248 lines). Need a wider grep. |

## Phase 1 priority list (free / cheap wins, ranked by ROI)

| # | Fix | Estimated win | Effort |
|---|---|---|---|
| 1 | Hoist `new Date(birthDate).getFullYear()` out of trial loop (utils.ts:2952, 2955) | 5-10% | **15 min** |
| 2 | Cache `config.profiles[filingStatus]` reference once per session, not per call | 2-3% | 30 min |
| 3 | Find & remove generator usage in hot path (`grep -n 'function\*\|yield ' src/utils.ts src/decision-engine/*`) | **15%+** | 2-4 hrs depending on what we find |
| 4 | Pre-flatten `allocation` object to parallel arrays at session start, replace `Object.entries(allocation).reduce(...)` patterns with indexed `for` loops | **8%** | 4-6 hrs |
| 5 | Identify Array.sort sites in per-year code, hoist or pre-sort | **5-9%** | 2-3 hrs |
| 6 | Object pooling for `calculateFederalTax` return value (output-arg pattern or freelist) | **3-6%** | 4-6 hrs |
| 7 | Audit `applyProactiveRothConversion` for similar patterns (it's the second-most-called hot function) | depends | 2-3 hrs |

**Combined Phase 1 estimate:** ~40-60% throughput improvement (1.4-1.6× speedup),
1-2 days of focused work, no architectural changes, no risk to correctness if
done with golden-output regression tests.

## Phase 2 still in scope (separate work item)

The Phase 1 wins multiply with the Phase 2 algorithmic wins (QMC, two-stage
screening, racing). Combined estimate from earlier brainstorming holds:
**10-30× total speedup** if all phases land. That moves Full mine on a 24-worker
M4 mini from 2.7 min → ~10 seconds.

## Where the perf project does NOT need to go

Things explored that are **not worth pursuing for throughput**:

- ❌ Cluster batch payload trimming (only helps network, not speed)
- ❌ JSON serialization (not a hot path; structuredClone is 0.1 ms)
- ❌ Cluster pipelining / RTT reduction (network is <2% of cycle time anyway)
- ❌ Language port to Python (would be 10-50× *slower*; engine is V8's wheelhouse)
- ❌ Buying bigger cloud instances (proven today: M-series beats c7i x86 1.8×/worker)

## Reproduce these numbers

```bash
# Baseline
npx tsx scripts/perf-baseline.ts --policies 50 --trials 500

# JSON output for tooling
npx tsx scripts/perf-baseline.ts --policies 50 --trials 500 --json > perf/baseline.json

# V8 profile (after each Phase 1 fix, re-run to see hotspots shift)
node --import tsx --prof scripts/perf-baseline.ts --policies 30 --trials 500
node --prof-process isolate-*.log > perf/profile-<date>.txt
rm isolate-*.log
```

## Phase 1 results (cumulative through 2026-04-27)

| Phase                                                     | ms/pol | pol/min | Δ vs prior | 8w Full mine |
|-----------------------------------------------------------|--------|---------|------------|--------------|
| Phase 0 baseline                                          | 504    | 119     | —          | 8.2 min      |
| Phase 1.1 (Date.getFullYear hoist)                        | 480    | 125     | −4.8%      | 7.8 min      |
| Phase 1.3 (allocation pre-flatten, WeakMap-cached)        | 393    | 153     | −18.1%     | 6.1 min      |
| Phase 1.4 (factor-label hoist + Float64Array median)      | 393    | 152     | ~0         | 6.1 min      |
| **Phase 1.5 (drop normalizeMoney from calculateFederalTax)** | **290** | **207** | **−26.4%** | **4.7 min** |
| **Phase 1.6 (in-place loops in applyProactiveRothConversion)** | **266** | **226** | **−8.3%**  | **4.3 min** |

**Cumulative Phase 1 result: −47.3% per-policy time, +89.7% throughput.**
Full corpus on 8-worker pool: 8.2 min → 4.3 min (1.9× speedup).
Full corpus on 24-worker M-series mini: 2.7 min → 1.4 min.

### Phase 1.5 surprise

Phase 0 estimated 3-6% from object pooling for `calculateFederalTax`.
Actual win was 26.4% from a different attack: dropping the per-field
`normalizeMoney(value) = Number(value.toFixed(2))` wrapper from the 12 of
14 returned numeric fields. Each call was doing 12 string allocs +
12 string→number parses for display-time cent rounding that no internal
caller needed. ~117M calls per Full mine × 12 fields = ~1.4B short-string
ops, attributed to `std::pair<string,string>` in the V8 profile because
SmallString allocation routes through the same allocator. Currency
rounding now belongs at the display layer; tests that assumed cent-rounded
internals were updated to assert full-precision math (one assertion
changed: `additional-medicare-tax.test.ts:43`, which itself documented the
dependency it was testing).

### Phase 1.6 outcome

Three local-only allocation patterns in `applyProactiveRothConversion`
collapsed to in-place loops:

1. The `{...input.withdrawalResult.taxInputs, ira401kWithdrawals: ...}`
   spread on every candidate (4 candidates × ~117M calls = ~470M
   14-field copies) → hoisted scratch object mutated per call.
2. `[0.25,0.5,0.75,1].map(...).filter(...) → new Set(...) → [...].sort()`
   for ≤4 candidate amounts → fixed-size in-place build with insertion
   sort. String-free 2dp rounding via `Math.round(x*100)/100`.
3. `.filter().map() → .reduce()` candidate evaluation pipeline → single
   for-loop with inline best-candidate tracking.

All three are local computations that never escape — mutation is safe.

## Multi-machine measurement (post-Phase-1, 2026-04-27)

Same `scripts/perf-baseline.ts --policies 50 --trials 500` run on each
host, deterministic seed → identical workload. Single-thread numbers:

| Machine                  | Node     | ms/policy mean | pol/min/thread | 8w Full mine |
|--------------------------|----------|----------------|----------------|--------------|
| M4 mini (Mac-Mini-Upstairs) | 23.11.0 | 266            | **226**        | 4.3 min      |
| M2 mini (Robs-Mac-mini)     | **23.11.1** | **281**     | **213**        | 4.6 min      |
| M2 mini (same machine)      | 20.20.2  | 380            | 158            | 6.1 min      |

**Two findings that change the hardware story:**

1. **Node version dominates the gap.** The M2 went from 158 → 213
   pol/min/thread by upgrading Node 20.20.2 → 23.11.1 with zero code
   changes (+35% throughput, −26% per-policy time). V8's TurboFan codegen
   in Node 23 is meaningfully better at the kind of tight allocation-light
   hot loops Phase 1 produced.
2. **M2 ≈ M4 per thread on equal Node.** 213 vs 226 pol/min/thread is a
   5.6% difference — within run-to-run noise. Apple Silicon M2→M4 silicon
   generation is essentially invisible to this workload. M4's only
   advantage is core count (10 vs 8 → 8 vs 6 worker threads).

### 2-mac cluster math (Node 23 on both)

| Config              | Workers | pol/min  | Full mine wall (no overhead) |
|---------------------|---------|----------|------------------------------|
| M4 alone            | 8       | 1,808    | 4.3 min                      |
| M2 alone            | 6       | 1,278    | 6.1 min                      |
| **M4 + M2 cluster** | **14**  | **3,086**| **2.5 min**                  |

The M2 contributes ~41% of cluster throughput on Node 23 (was 34% on
Node 20). It's a fully-paying member, not a laggard.

### Hardware decision (recorded for later reference)

- No new hardware needed. M4 + M2 deliver Full mine in ~2.5 min — that's
  interactive territory for the policy-mining workflow.
- Pin Node 23 across all hosts (`engines` field added to `package.json`,
  setup note added to `cluster/README.md`).
- Ryzen 7800X3D status: untested post-Phase-1. Historic data showed Ryzen
  ≈ M2 per-thread @ 2000 trials pre-Phase-1 (both ~16 pol/min/thread). If
  the same Phase-1 + Node-23 multipliers apply, Ryzen should land near
  the M-series per-thread numbers; worth a confirming run before deciding
  whether to keep it as a third cluster node.

## Phase 2 priorities (re-ranked after Phase 1 wins)

### Post-Phase-1 V8 profile (2026-04-27)

**Source:** `perf/profile-postphase1-2026-04-27.txt` (30 policies × 500 trials)
**Summary categories:** JavaScript 14.1% / **C++ 79.8%** / GC 5.4% nonlib

| Built-in                              | Pre-1 % nonlib | Post-1 % nonlib | Verdict           |
|---------------------------------------|----------------|-----------------|-------------------|
| `std::pair<string,string>` ctor       | 24.9%          | **27.4%**       | shifted up rel.   |
| `_Builtins_GeneratorPrototypeNext`    | 15.9%          | **16.9%**       | UNEXPLAINED       |
| `_Builtins_TypedArrayPrototypeSort`   | —              | **6.0%**        | NEW (1.4 cost)    |
| `_Builtins_NumberConstructor`         | —              | **3.1%**        | newly visible     |
| `_Builtins_ArrayMap`                  | —              | **2.3%**        | newly visible     |
| `_Builtins_DatePrototypeGetFullYear`  | 2.2%           | **2.3%**        | partial 1.1 win   |
| `_Builtins_ArrayPrototypeSort`        | **9.5%**       | 0.9%            | ✅ 1.4 confirmed  |
| `Object.entries`                      | **8.5%**       | not in top 25   | ✅ 1.3 confirmed  |

**Absolute time, not just shares:** per-policy time fell 504 → 266 ms,
so a built-in keeping its ~25% share actually dropped from 125 → 73 ms
in absolute terms. The proportional bumps (e.g. std::pair 24.9 → 27.4%)
mean that built-in shrunk less than everything else, not that it grew.

**Diffuse JS hotspots:** `calculateHealthcarePremiums` 1.2%,
`calculateFederalTax` 1.1%, `applyProactiveRothConversion` 0.5%,
`buildWithdrawalDecisionTrace` 0.4%. No single function dominates;
the structural-fix era is over.

### Phase 2 plan

| # | Track                                         | Estimated win  | Effort  | Risk |
|---|-----------------------------------------------|----------------|---------|------|
| ~~A~~ | ~~Hunt `GeneratorPrototypeNext` source~~  | ~~up to 15%~~ | DONE: 0 | —    |
| ~~B~~ | ~~Quasi-Monte Carlo (Sobol/Halton draws)~~| ~~2-4×~~       | DONE: parked | high |
| C | Two-stage screening (coarse → fine cascade)   | 3-5× per Full  | 1-2 day | med  |
| D | Racing / successive halving                   | ~2×            | 1 day   | med  |
| E | Hunt residual Date / NumberConstructor sites  | 2-4%           | 2 hrs   | low  |

**Recommended order:** C (two-stage screening) first — comparable expected
win to QMC's optimistic ceiling, but well-understood and low-risk.

### Phase 2.C: shipped (two-stage screening for the policy miner)

Implemented and measured 2026-04-27. Opt-in via
`PolicyMiningSessionConfig.coarseStage = { trialCount, feasibilityBuffer }`.
Default behavior (no `coarseStage`) is bit-identical to pre-Phase-2.C
miner — no regression risk.

How it works: when enabled, `runMiningSession` runs every policy
through a cheap coarse-pass first (e.g. N=200 trials), drops policies
whose coarse `bequestAttainmentRate` is below
`feasibilityThreshold - feasibilityBuffer`, and re-evaluates only the
survivors at the configured full N. The corpus only stores fine-pass
results — no coarse pollution.

Realistic measured speedups (60 policies, fine N=2000, 1 thread):

| Feasibility threshold | Single-pass | Two-stage  | Screen-out | Speedup |
|-----------------------|-------------|------------|------------|---------|
| 0.50 (current default)| 68.8 s      | 61.0 s     | 27%        | 1.13×   |
| 0.85 (tight)          | 69.6 s      | **38.9 s** | 55%        | **1.79×**|

Both configs identified the SAME top survivor as the single-pass
baseline — correctness preserved. The 1.8× win at tight feasibility
extrapolates to the Full mine: 7,776 × 2,000 = 15.5M trial-evals
single-pass becomes ≈ 8.6M trial-evals two-stage at 55% screen-out,
or roughly 4.3 min → 2.4 min on an 8-worker cluster.

Caveat: the "3-5×" headline I quoted in the original Phase 2 plan was
overoptimistic. At the current default 0.50 feasibility threshold the
win is only 1.13× because too many policies survive the coarse cut. To
realize the bigger speedup, either tighten the threshold (operational
choice for the household — willing to filter out marginal survivors
sooner?) or accept a smaller win at the loose default. Both are honest
options; the implementation is correct either way.

The miner pool path (`runMiningSessionWithPool`, used by the cluster
host workers) does NOT yet support two-stage screening. The dispatcher
would need to coordinate stages across hosts; non-trivial follow-up
work. The serial path (`runMiningSession`, used by the browser-as-host
and CLI) has the support today.

### Phase 2.B: parked (structural QMC bias on path-dependent integrand)

Investigation 2026-04-27, ~2 hours. Conclusion: **hybrid QMC (Sobol asset
returns + Mulberry32 everything else) produces a structurally biased
estimate, not just lower variance.** Bias is ~13% absolute on success
rate and persists at any N — no amount of trials will close it.

Evidence:
- MC@4000 success rate: 82.2%. QMC@4000 success rate: 95.6%. Gap = 13.4%.
- MC@1000 success rate: 83.0%. QMC@1000 success rate: 96.0%. Same gap,
  same direction. QMC is converging to the wrong answer.
- p10 ending wealth: MC = $0 (substantial failure mass), QMC = $597K
  (no failure mass). QMC is systematically optimistic.

Root cause: low-discrepancy sequences are TOO uniform — they
systematically undersample distribution tails relative to true random
sampling. Our integrand depends on extreme drawdown sequences (failure
is triggered by tail events), so Sobol shocks clustered near the mean
produce optimistically-biased outcomes. This is a known QMC pathology
for path-dependent integrands.

Fix would require: (a) Cranley-Patterson randomization (per-trial
random shifts of the Sobol point modulo 1) to inject true randomness
while preserving stratification, AND (b) Brownian-bridge construction
(reorder dimensions by impact so high-impact shocks come from low Sobol
indices), AND (c) ≥120-dim Sobol (Joe-Kuo direction tables go to ~21K
dims, but per-call cost scales) to actually do path-dependent QMC right.
Estimated 4-6 more hours, with literature-published payoff of 1.5-3×
speedup (comparable to Phase 2.C at much lower implementation risk).

Also discovered: per-trial Sobol+inverse-CDF is 20-86% SLOWER than
Box-Muller in our hot path. The microbench (Float64Array.from vs
indexed copy) didn't catch this because it tested allocator throughput,
not the closure overhead of feeding the engine 4 normals at a time.

**Status:** primitives + engine wiring kept (default `samplingStrategy:
'mc'` is bit-identical to pre-Phase-2 behavior). QMC parity test marked
`describe.skip` with the parked status. Future work can revisit if the
underlying math requirements get worked out.

### Phase 2.A: closed (no actionable finding)

Investigation 2026-04-27, ~75 min. Conclusion: **GeneratorPrototypeNext
is largely a V8 profiler-attribution artifact, not real fixable
production cost.** Recorded so future profiling sessions don't re-chase.

Evidence trail:
1. Bottom-up tree shows only 2 ticks of GeneratorPrototypeNext as a leaf
   with callers ≥1% (and those 2 ticks come from module loading via
   `AsyncFunctionAwaitResolveClosure`). The other 1153 ticks have NO
   caller ≥1% — meaning hundreds of distributed callers, each running
   too few times to pass the bottom-up threshold.
2. TypeScript target is ES2022, no downlevel-iteration polyfills emitted.
   `for...of` over arrays in src/ resolves to V8's fast indexed-iter path.
3. Only async function in the engine call graph is `evaluatePolicy`
   itself (zero awaits in its body) — 30-50 calls in a perf run can't
   account for 1155 sample ticks of generator dispatch.
4. Microbenchmark of `Float64Array.from(regularArray)` vs indexed copy:
   only 1.04× difference. Iterator-protocol cost on the hot percentile
   path is negligible — refutes the "TypedArray.from iter-walk" theory.
5. **Decisive test:** stripped-down harness running `evaluatePolicy` 50×
   directly (same engine workload, no perf-baseline instrumentation)
   shows GeneratorPrototypeNext **NOT in the top-25 C++ builtins**, while
   wall-clock per-policy matches the perf-baseline within noise (309 vs
   290 ms). Same real CPU, totally different attribution — proof that
   the 17% share is a sampling-attribution artifact of V8's
   ResumeGenerator bytecode handler, which is shared across many
   internal trampolines.

The Phase 1.2 hypothesis ("Object.entries patterns") was also wrong:
Phase 1.3 removed those patterns and the absolute GeneratorPrototypeNext
ticks dropped 43% (2045 → 1155), but the share grew 15.9 → 16.9% only
because everything else dropped faster. There is no single-leaf fix.

**Practical takeaway:** the actual production-realistic per-policy time
is essentially what the perf-baseline reports. The "missing 17%" isn't a
hidden production cost waiting to be reclaimed — it's V8 measurement
overhead that doesn't manifest in wall-clock. Cluster numbers stand.

## Phase 1.2 update (2026-04-27): generator hunt parked

Hunt outcome: **no actionable target found.**

- Comprehensive grep for `function\s*\*` and `\byield\s` across `src/` returned **zero generator definitions and zero yield statements** in production code (only matches were comments and test code).
- No `Map`/`Set` iteration via `for...of`/spread/`Array.from(...)` inside the per-trial-year hot path (`simulatePath` runTrial body, lines ~2944–3650). The Map iterations that exist (`yearlyBuckets.entries()` at line 3653, `reasons.entries()` at line 2266, `rothDecisionReasonCounts.entries()` at line 2419) are all OUTSIDE the per-trial loop and run once per `simulatePath` call.
- No `async function` (or `async function*`) in `utils.ts` that could trigger generator polyfills.
- Notable: `_Builtins_GeneratorPrototypeNext` does NOT appear as a leaf in the bottom-up profile, despite 2045 self-ticks (15.9%) in the C++-entry-points list. This suggests the cost is being attributed to deeper functions in the bottom-up tree (likely the std::pair allocations and ObjectEntries calls already on the Phase 1 list). It may be a V8-internal accounting category that aggregates iterator-protocol overhead from `Object.entries(...).reduce(...)` patterns, not a separate fixable hotspot.

Action: park 1.2. Re-run V8 profile after Phase 1.3 (Object.entries flatten) and 1.4 (sort hoist) land — if GeneratorPrototypeNext stays high after the bigger leaves shrink, revisit with `--trace-deopt` for finer attribution.
