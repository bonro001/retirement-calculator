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
