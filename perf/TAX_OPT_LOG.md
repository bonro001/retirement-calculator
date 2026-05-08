# Federal Tax Optimization Log

## Ratchet

Date established: 2026-05-08
Host: Mac-Mini-Upstairs.local
Commit: `26e7489bf959cde8ba008af3b7d19eed44948ffd` with dirty worktree
Workload: `5,000 policies x 5,000 trials`, parametric, `rust-native-compact`
Quiet ratchet: **173.83 s**, **34.76 ms/policy**
Current ratchet candidate: **125.68 s**, **25.14 ms/policy**

Source: `perf/CPU_BASELINE_QUIET.md`

## Sub-pass 4a: JSON Pointer And Tax Call Investigation

Date: 2026-05-08
Files touched: `flight-engine-rs/Cargo.toml`,
`flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Quiet baseline before: 173.83 s
Quiet baseline after: not measured; instrumentation only
Decision: keep feature-gated counters; no optimization yet

### JSON Pointer Classification

Static inspection found no evidence that `federal_tax_exact` does JSON pointer
work directly. The `.pointer(...)` calls are mostly setup/cold-path values
loaded into typed Rust structs before the trial loop:

- household dates, filing status, salary, spending, RMD, LTC, HSA strategy,
  Roth conversion policy, contribution limits, social security, windfalls, and
  housing policy are setup/cold-path.
- dynamic account allocation pointers remain in helpers such as
  `bucket_return_from_parts`, `defense_score`, and `ReturnWeights::from_bucket`.
  The current compact path uses precomputed bucket returns for pretax, roth,
  taxable, and cash; HSA was already precomputed in the prior hot-path cleanup.

Finding: sub-pass 4a is not tax-specific. JSON pointer work is not the main
federal tax hot path for the compact representative workload.

### Tax Call Counter Probe

Instrumentation was added behind the `tax-counters` Cargo feature and only
activates when the request contains:

```json
{ "instrumentation": { "taxCallCounts": true } }
```

Probe command shape:

```bash
node - <<'NODE' | cargo run --release --features tax-counters \
  --manifest-path flight-engine-rs/Cargo.toml \
  --bin engine_candidate > /tmp/tax-counter-response.json
const fs = require('fs');
const request = JSON.parse(fs.readFileSync('perf/cpu-baseline-request.json', 'utf8'));
request.instrumentation = { taxCallCounts: true };
process.stdout.write(JSON.stringify(request));
NODE
```

Representative request result, one policy x 5,000 trials:

| Counter | Count |
|---|---:|
| `federalTaxExact` | 680,000 |
| `taxForWithdrawals` | 680,000 |
| `withdrawalAttempt` | 340,000 |
| `closedLoopPass` | 340,000 |
| `proactiveRothConversion` | 170,000 |
| `proactiveRothCandidate` | 0 |
| `taxForConversion` | 0 |
| `fallbackBaseTax` | 0 |
| `fallbackFinalTax` | 0 |

Interpretation:

- The representative workload performs exactly **2 federal tax calculations per
  withdrawal attempt**.
- The closed-loop withdrawal pass is the real tax-call driver.
- `proactive_roth_conversion` is invoked once per trial-year, but this request
  exits before evaluating any conversion candidates; Roth recomputation is not
  currently hot for the representative policy.
- The fallback non-planner tax path is not active for this workload.

### Next Decision

Do not start with Roth recomputation. For the representative workload, sub-pass
4c would likely be a zero-win pass.

Next optimization candidate should be **closed-loop withdrawal tax work
elimination**:

1. Inspect why the closed loop converges in exactly two passes per trial-year.
2. Determine whether the first tax calculation in `withdrawal_attempt` can be
   reused, skipped, or replaced with a cheaper MAGI estimate when no pretax or
   taxable withdrawals have occurred beyond RMD.
3. Separately inspect `standard_deduction` and bracket calculations as 4b/4d
   micro-targets, but only after the two-tax-calls-per-attempt pattern is
   understood.

## Sub-pass 4b: Closed-Loop Withdrawal Final-Tax Reuse

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Quiet baseline before: 173.83 s
Directional timing after: 169.01 s
Delta: **-4.82 s**, **-2.77%**
Decision: kept; needs full three-repeat quiet confirmation before ratcheting

### Change

`withdrawal_attempt` previously computed tax once for steering withdrawal
limits, recomputed it after taxable/pretax withdrawals, and then always
computed final tax again before returning. In the normal planner withdrawal
path, the local `tax` value is already current:

- initial tax includes any RMD already applied to `withdrawals.pretax`
- taxable and pretax bucket withdrawals immediately refresh `tax`
- cash and Roth withdrawals do not change taxable income

The change returns that current `tax` value instead of unconditionally calling
`tax_for_withdrawals` at the end. The proportional branch still computes tax
once after its withdrawals because it does not maintain a live tax value while
walking buckets.

### Counter Confirmation

Representative request, one policy x 5,000 trials:

| Counter | Before | After |
|---|---:|---:|
| `federalTaxExact` | 680,000 | 340,000 |
| `taxForWithdrawals` | 680,000 | 340,000 |
| `withdrawalAttempt` | 340,000 | 340,000 |
| `closedLoopPass` | 340,000 | 340,000 |
| `taxForConversion` | 0 | 0 |

### Timing

Directional timing was run after rebuilding the normal NAPI addon:

| Workload | Baseline | After | Delta |
|---|---:|---:|---:|
| 1,000 x 5,000 warm ratchet | 35.44 s | 33.18 s | -6.38% |
| 5,000 x 5,000 quiet ratchet | 173.83 s | 169.01 s | -2.77% |

The 5K result is a single repeat rather than the full quiet protocol, so the
new ratchet is not yet updated. The result is directionally positive and clears
the keep threshold because it removes provably redundant tax work without
changing calibration.

### Next Decision

Continue within closed-loop tax work before touching Roth conversion:

1. Count closed-loop passes per trial-year to understand why the representative
   policy averages two passes.
2. Inspect whether the closed-loop convergence check can reuse the final
   attempt without one extra loop pass.
3. Then inspect `standard_deduction` and bracket math as smaller 4b/4d targets.

## Sub-pass 4c: Closed-Loop Pass Histogram

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Quiet baseline before: 173.83 s
Quiet baseline after: not measured; instrumentation only
Decision: no loop-pass removal; pass 2 is structurally needed

The tax counters were extended with closed-loop pass histograms and break
reasons. Representative request, one policy x 5,000 trials:

| Counter | Count |
|---|---:|
| `closedLoopYear` | 170,000 |
| `closedLoopPass` | 340,000 |
| `closedLoopOnePass` | 0 |
| `closedLoopTwoPass` | 170,000 |
| `closedLoopThreePlusPass` | 0 |
| `closedLoopBreakStateConverged` | 170,000 |
| `closedLoopBreakNeededDelta` | 0 |
| `closedLoopBreakOscillation` | 0 |
| `closedLoopBreakPassLimit` | 0 |

Interpretation:

- Every trial-year takes exactly two closed-loop passes.
- Pass 1 discovers tax/healthcare-loaded need from the initial shortfall.
- Pass 2 withdraws against that larger need and then breaks by stable
  MAGI/tax/healthcare state.
- The average remaining `next_needed - closed_loop_needed` at the state break
  is not near zero, so the second pass is not simply convergence noise. It is
  the final withdrawal pass.

Decision: do not try to remove pass 2. Further loop-level changes would need a
behavior-sensitive redesign and are not appropriate for this medium-depth pass.

## Sub-pass 4d: Per-Year Tax Invariants

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Quiet baseline before: 173.83 s
Directional timing after: 168.38 s
Delta: **-5.45 s**, **-3.14%** versus quiet ratchet
Decision: kept; small but positive directional result

### Change

Precomputed tax values already known at the trial-year level and passed them
through `WithdrawalContext` / `TaxInput`:

- standard deduction for Rob/Debbie's ages in the year
- additional Medicare tax for the adjusted wages in the year

This removes repeated per-call age/wage invariant work from
`federal_tax_exact`.

### Timing

| Workload | Baseline | After | Delta |
|---|---:|---:|---:|
| 1,000 x 5,000 warm ratchet | 35.44 s | 34.04 s | -3.95% |
| 5,000 x 5,000 quiet ratchet | 173.83 s | 168.38 s | -3.14% |

The 5K result is a single repeat, not a new quiet ratchet.

## Sub-pass 4e: Ordinary Bracket Math Simplification

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Quiet baseline before: 173.83 s
Directional timing after: 168.60 s
Delta: **-5.23 s**, **-3.01%** versus quiet ratchet
Decision: kept; neutral versus 4d but simpler code

### Change

Simplified `calculate_ordinary_tax` to return as soon as the taxable income's
bracket is found, instead of maintaining a remaining-income accumulator through
the loop. The bracket table and rates are unchanged.

### Timing

| Workload | Baseline | After | Delta |
|---|---:|---:|---:|
| 1,000 x 5,000 warm ratchet | 35.44 s | 33.49 s | -5.50% |
| 5,000 x 5,000 quiet ratchet | 173.83 s | 168.60 s | -3.01% |

This is effectively neutral against 4d's `168.38 s`, but the implementation is
clearer and remains below the ratchet.

## Current Tax-Pass Read

Best directional 5K result in this pass: **168.38 s**. Latest result after all
kept changes: **168.60 s**.

Directionally, the tax pass has moved the representative workload by about
**3%** against the quiet ratchet while preserving calibration. The remaining tax
work is likely real model work rather than obvious duplicate calls.

Recommended next target: move to compact tape row access/layout, unless a full
three-repeat quiet confirmation is desired before changing areas.

## Compact Tape Experiment: Year Data Flattening

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Quiet baseline before: 173.83 s
Directional timing after: 169.66 s
Decision: reverted

### Change Tried

Flattened `ReplayYearView` into a resolved year-data struct so the inner loop
would do one materialized-vs-compact dispatch per year instead of calling
several small methods that each match on the enum.

### Timing

| Workload | Before compact experiment | After |
|---|---:|---:|
| 1,000 x 5,000 | 33.49 s | 34.01 s |
| 5,000 x 5,000 | 168.60 s | 169.66 s |

The change was directionally slower and made the code more involved, so it was
reverted. The next compact tape attempt should target data layout or index math
directly, not enum-method dispatch.

## Roth Conversion Candidate Buffer Cleanup

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Quiet baseline before: 173.83 s
Quiet confirmation median after: 158.34 s
Delta: **-15.49 s**, **-8.91%** versus quiet ratchet
Decision: kept; new ratchet candidate is 158.34 s / 31.67 ms per policy

### Trigger

The `1000 x 5000` proof probe showed that the current representative policy
set exercises Roth conversion heavily:

| Counter | Count |
|---|---:|
| `federalTaxExact` | 1,020,058,631 |
| `taxForConversion` | 331,464,280 |
| `proactiveRothCandidate` | 331,464,280 |
| `proactiveRothConversion` | 168,521,962 |

The first cheap target was not tax math. It was candidate-list construction:
`proactive_roth_conversion` allocated and sorted a tiny `Vec` once per
trial-year even though the candidate list has at most five entries.

### Change

Replaced the per-call `Vec` allocation with a fixed stack array and insertion
sort over the active slots. The candidate set, sort-before-cap behavior,
cent-rounding, minimum annual filter, and duplicate suppression are unchanged.

### Timing

| Workload | Before | After | Delta |
|---|---:|---:|---:|
| 1,000 x 5,000 warm ratchet | 35.44 s | 31.92 s | -9.93% |
| 5,000 x 5,000 directional | 173.83 s | 155.87 s | -10.33% |
| 5,000 x 5,000 quiet confirmation median | 173.83 s | 158.34 s | -8.91% |
| Previous kept directional 5K | 168.60 s | 155.87 s | -7.55% |

Quiet confirmation repeats:

| Repeat | Time |
|---|---:|
| 1 | 152.89 s |
| 2 | 159.87 s |
| 3 | 158.34 s |

Spread: **4.41%** of median. This is wider than ideal 2-3%, but below the 5%
rerun threshold and all repeats remain far ahead of the old ratchet.

## Healthcare ACA Work Gate

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Ratchet before: 158.34 s
Quiet confirmation median after: 138.91 s
Delta: **-19.43 s**, **-12.27%** versus prior ratchet candidate
Decision: kept; new ratchet candidate is 138.91 s / 27.78 ms per policy

### Trigger

The post-Roth proof probe still showed `healthcarePremium` as a material nested
module with a full-removal upper bound of about `11.17s` on the `1000 x 5000`
instrumented workload.

### Change

`compute_healthcare_premium_cost` previously computed FPL ratio and ACA
interpolation even when ACA could not apply. The subsidy condition already
required retirement status and at least one non-Medicare household member, so
the FPL/interpolation work now runs only inside that same gate.

The Medicare premium and IRMAA calculations are unchanged.

### Timing

| Workload | Before | After | Delta |
|---|---:|---:|---:|
| 1,000 x 5,000 post-Roth | 31.92 s | 28.13 s | -11.87% |
| 5,000 x 5,000 directional | 158.34 s | 137.17 s | -13.37% |
| 5,000 x 5,000 quiet confirmation median | 158.34 s | 138.91 s | -12.27% |

Quiet confirmation repeats:

| Repeat | Time |
|---|---:|
| 1 | 133.51 s |
| 2 | 139.25 s |
| 3 | 138.91 s |

Spread: **4.13%** of median. This is wider than ideal 2-3%, but below the 5%
rerun threshold and all repeats remain far ahead of the prior ratchet
candidate.

### Follow-up Gate

Added an early return for the case where the household is not retired and no
one is Medicare-eligible. In that case ACA, Medicare, and IRMAA premiums are all
zero, so the function can return before premium arithmetic.

Calibration remained 12/12 green. The `1,000 x 5,000` proof rung was flat:
`28.25 s` versus `28.13 s` after the ACA gate, so no 5K run was taken for this
micro-change.

## Roth Strategy Shape Probe

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Normal NAPI rebuilt after instrumentation: yes
Workload: `1,000 x 5,000`, instrumented, parametric
Report: `out/cpu-baseline/2026-05-08T19-32-02-057Z-rust-native-compact-parametric-r1.json`

### Counters

| Counter | Count |
|---|---:|
| `proactiveRothEligible` | 83,520,016 |
| `proactiveRothNoHeadroom` | 901,006 |
| `proactiveRothCandidate` | 331,464,280 |
| `taxForConversion` | 331,464,280 |
| `proactiveRothSurvivor` | 328,466,091 |
| `proactiveRothCeilingReject` | 2,998,189 |
| `proactiveRothConversionKept` | 81,222,054 |
| `proactiveRothNegativeScore` | 1,396,951 |
| `proactiveRothAlreadyOptimal` | 0 |

Evaluation count histogram:

| Evaluated candidates | Eligible years |
|---|---:|
| 0 | 5 |
| 1 | 237 |
| 2 | 252 |
| 3 | 126 |
| 4 | 81,628,789 |
| 5+ | 989,601 |

Best-candidate position among kept conversions:

| Best position | Count |
|---|---:|
| 1 | 1,533,447 |
| 2 | 4,142,388 |
| 3 | 5,520,867 |
| 4 | 69,041,465 |
| 5+ | 983,887 |

### Interpretation

- Average tax evaluations per eligible Roth year: **3.97**.
- Conversion is kept for **97.25%** of eligible Roth years.
- Ceiling rejection is low: **0.90%** of evaluated candidates.
- The fourth candidate wins **85.00%** of kept conversions.

The next material win is likely not another local cleanup. It is changing how
Roth candidates are searched or scored: largest-candidate-first pruning,
memoization of equivalent marginal-tax shapes, or closed-form marginal tax
scoring. Those are behavior-sensitive and should be handled as a high-depth
strategy pass before implementation.

## Roth Largest-Survivor Shadow Probe

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Normal NAPI rebuilt after instrumentation: yes
Calibration: 12/12 green (`npm run test:calibration`)
Workload: `1,000 x 5,000`, instrumented, parametric
Report: `out/cpu-baseline/2026-05-08T19-39-39-903Z-rust-native-compact-parametric-r1.json`

### Counters

| Counter | Count |
|---|---:|
| `proactiveRothShadowLargestSurvivor` | 81,222,054 |
| `proactiveRothShadowLargestPositive` | 77,828,719 |
| `proactiveRothShadowLargestMatchesBest` | 70,058,126 |
| `proactiveRothShadowLargestDiffers` | 11,163,928 |
| `proactiveRothShadowMonotonicScores` | 69,785,211 |
| `proactiveRothShadowNonMonotonicScores` | 11,436,843 |

Derived:

| Metric | Value |
|---|---:|
| Largest survivor matches current best | 86.26% |
| Largest survivor differs from current best | 13.74% |
| Scores monotonic by amount | 85.92% |
| Avg score gap when different | 1,577 |
| Avg tax delta when different | 6,992 |
| Avg MAGI delta when different | 35,924 |

### Decision

Do **not** implement a direct largest-survivor shortcut. It is common, but not
safe: it differs in about 13.7% of kept conversions, and the average tax/MAGI
delta in those differing cases is too large to treat as harmless.

The next viable strategy is closed-form or incremental marginal-tax scoring
that preserves the full candidate decision while reducing repeated exact tax
work. That should be designed before implementation.

## Roth Fast Tax Shadow Probe

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Normal NAPI rebuilt after instrumentation: yes
Calibration: 12/12 green (`npm run test:calibration`)
Workload: `1,000 x 5,000`, instrumented, parametric
Report: `out/cpu-baseline/2026-05-08T19-46-32-431Z-rust-native-compact-parametric-r1.json`

### Change

Added a shadow-only `ConversionTaxContext` that hoists invariant tax inputs for
Roth conversion candidate evaluation. The current behavior still uses exact
`federal_tax_exact`; the shadow evaluator computes the same candidate tax and
records whether it matches.

### Result

| Metric | Value |
|---|---:|
| Candidate comparisons | 331,464,280 |
| Fast-tax matches | 331,464,280 |
| Fast-tax differs | 0 |
| Tax delta total | 0 |
| MAGI delta total | 0 |

### Decision

The hoisted conversion-tax evaluator is exact for the representative probe. The
next implementation step is to switch Roth conversion candidate evaluation from
`tax_for_conversion` to `ConversionTaxContext::tax_for_conversion`, then run
calibration and the proof ladder. This preserves the full candidate scan and
only removes repeated invariant tax setup.

## Roth Fast Tax Implementation

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Ratchet before: 138.91 s
Quiet confirmation median after: 125.68 s
Delta: **-13.24 s**, **-9.53%** versus prior ratchet candidate
Decision: kept; new ratchet candidate is 125.68 s / 25.14 ms per policy

### Change

Switched Roth conversion candidate tax evaluation from full `federal_tax_exact`
calls to `ConversionTaxContext::tax_for_conversion`. The full candidate scan,
ceiling checks, scoring formula, and selected candidate behavior are unchanged.

The exact-tax shadow probe compared **331,464,280** candidate evaluations with
zero tax or MAGI deltas before this switch.

Under `tax-counters`, the exact evaluator is still called as a shadow check so
future probes can detect drift.

### Timing

| Workload | Before | After | Delta |
|---|---:|---:|---:|
| 1,000 x 5,000 post-healthcare | 28.13 s | 25.23 s | -10.31% |
| 5,000 x 5,000 directional | 138.91 s | 132.31 s | -4.75% |
| 5,000 x 5,000 quiet confirmation median | 138.91 s | 125.68 s | -9.53% |

Quiet confirmation repeats:

| Repeat | Time |
|---|---:|
| 1 | 124.80 s |
| 2 | 125.68 s |
| 3 | 126.07 s |

Spread: **1.02%** of median. This is decision-quality and becomes the current
ratchet candidate for the representative workload.

## Healthcare Premium Context Hoist

Date: 2026-05-08
Files touched: `flight-engine-rs/src/candidate_engine.rs`
Calibration: 12/12 green (`npm run test:calibration`)
Ratchet before: 125.68 s
Quiet baseline after: not measured
Decision: kept as a small invariant-hoist/clarity win; no ratchet update

### Change

Hoisted per-year healthcare inputs into `HealthcarePremiumContext` before the
closed-loop withdrawal pass:

- Medicare eligibility count
- non-Medicare household count
- retirement status
- indexed ACA and Medicare baseline premiums
- household FPL value

The healthcare calculation still receives the current pass MAGI and IRMAA tier,
so the behavior-sensitive values remain per-pass.

### Timing

| Workload | Before | After | Delta |
|---|---:|---:|---:|
| 1,000 x 5,000 post-fast-tax | 25.23 s | 24.96 s | -1.07% |

This clears the calibration gate and is directionally positive, but the
expected 5K impact is below the quiet-ratchet threshold. No full quiet run was
taken.
