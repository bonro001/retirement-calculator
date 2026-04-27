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

## Phase 2 priorities (re-ranked after Phase 1 wins)

The remaining V8 profile hotspots from Phase 0 should be re-measured —
Phase 1.5 likely shifted the std::pair share dramatically. Before
committing to algorithmic Phase 2 work (QMC, two-stage screening,
racing), re-profile to confirm where the current hot leaves are.

If the post-Phase-1 profile still shows >10% in any single built-in,
prefer one more round of structural fixes; if it's flatter, jump to
Phase 2.

## Phase 1.2 update (2026-04-27): generator hunt parked

Hunt outcome: **no actionable target found.**

- Comprehensive grep for `function\s*\*` and `\byield\s` across `src/` returned **zero generator definitions and zero yield statements** in production code (only matches were comments and test code).
- No `Map`/`Set` iteration via `for...of`/spread/`Array.from(...)` inside the per-trial-year hot path (`simulatePath` runTrial body, lines ~2944–3650). The Map iterations that exist (`yearlyBuckets.entries()` at line 3653, `reasons.entries()` at line 2266, `rothDecisionReasonCounts.entries()` at line 2419) are all OUTSIDE the per-trial loop and run once per `simulatePath` call.
- No `async function` (or `async function*`) in `utils.ts` that could trigger generator polyfills.
- Notable: `_Builtins_GeneratorPrototypeNext` does NOT appear as a leaf in the bottom-up profile, despite 2045 self-ticks (15.9%) in the C++-entry-points list. This suggests the cost is being attributed to deeper functions in the bottom-up tree (likely the std::pair allocations and ObjectEntries calls already on the Phase 1 list). It may be a V8-internal accounting category that aggregates iterator-protocol overhead from `Object.entries(...).reduce(...)` patterns, not a separate fixable hotspot.

Action: park 1.2. Re-run V8 profile after Phase 1.3 (Object.entries flatten) and 1.4 (sort hoist) land — if GeneratorPrototypeNext stays high after the bigger leaves shrink, revisit with `--trace-deopt` for finer attribution.
