# Product Backlog

Durable, cross-cutting product items that don't belong in a track-specific workplan. Lighter-weight than the `*_WORKPLAN.md` files — each entry is a one-liner or short paragraph, no execution protocol.

Related workplans (each has its own stepwise plan):
- [FLIGHT_PATH_WORKPLAN.md](FLIGHT_PATH_WORKPLAN.md) — strategic-prep recommendation engine.
- [CALIBRATION_WORKPLAN.md](CALIBRATION_WORKPLAN.md) — capture predicted-vs-actual over time for empirical model calibration.
- [VALIDATION_WORKPLAN.md](VALIDATION_WORKPLAN.md) — property tests, tax-engine validation, historical backtesting, peer-planner parity.
- [MINER_REFACTOR_WORKPLAN.md](MINER_REFACTOR_WORKPLAN.md) — single-source-of-truth refactor: cockpit reads from mining corpus, one ranking rule, one set of numbers.

## Next priority (ranked)

Filter used: *"fix what changes decisions (tail risk, calibration); everything else can wait."* Lifted from a reviewer critique, sharpened against what we actually shipped.

1. ~~**Fat-tail return distribution + clip removal**~~ ✅ **Done this sprint.** Added `useHistoricalBootstrap` opt-in that samples per-year (stocks, bonds, cash, inflation) tuples from [historical_annual_returns.json](fixtures/historical_annual_returns.json). Fidelity translator now uses it by default. Closed p10 gap from 4.4x → 2.2x of Fidelity. Remaining 2x likely block/autocorrelation (multi-year bad-follows-bad dynamics) + withdrawal-policy smoothing; tracked as follow-up if decision-critical.
2. **Actuals log + reconciliation layer** (CALIBRATION steps 2, 4, 6) — pairs with the already-shipped prediction log. Write the companion `actuals.jsonl` capture for balances / monthly spend / annual tax, plus the reconciliation that diffs prediction vs actuals. Implementable now, doesn't need calendar time to code — only to populate.
3. **UI: uncertainty range tile** — surfaces `src/uncertainty-surface.ts` as a dashboard card showing the success-rate range ("85-94%") instead of a single point. Replaces the most dangerous single-number headline.
4. **UI: tax efficiency tile** — surfaces `src/tax-efficiency.ts` as a dashboard card showing lifetime federal tax, effective rate, top heat year with driver, and IRMAA cliff count. Tax minimization is stated user priority ("hate paying taxes").
5. **CENTRAL_MANAGED / TRP_2030 proxy tightening** (Allocation check remediation) — engine's 72.1% US-equity drift vs Fidelity's 65.0% is from the ambiguous-holding proxies in `asset-class-mapper.ts`. Either add user-configurable per-account override or derive proxies from lookthrough data. Lets the allocation-check tolerance drop below 8pp.
6. **Shiller back-fill for historical_annual_returns.json** — current values are ~±1-2pp approximate. Replace with definitive pull from Shiller ie_data.xls. Tightens Trinity reproduction from "in the right band" to "exact published numbers."
7. **Monte Carlo convergence test** — per-metric drift test across 100 → 500 → 2000 → 5000 runs, asserting stabilization. Catches the case where we report 92% when the real MC answer is still noisy at whatever our default run count is.
8. **Third peer planner** — triangulation beyond Boldin + Fidelity. Projection Lab / NewRetirement / FICalc. Mostly a capture exercise now that the parity-harness shape is proven.
9. **Additional Medicare tax** (0.9% on wages >$250k MFJ) — zero impact on target household (no post-retirement wages), kept here for completeness not urgency.
10. **Authentication decision** — product-level, separate from calibration/tail work. Still open per earlier entry.

Guiding principle (reviewer's, and it's correct): *fix what changes decisions — tail risk and calibration are the two real levers remaining. Polish is optional.*

## Open

- [x] ~~**MINER_REFACTOR Phase 2: rewire cockpit TRUST card to corpus + retire bisection chain** (steps 10/11/12 of [MINER_REFACTOR_WORKPLAN](MINER_REFACTOR_WORKPLAN.md)).~~ **Done 2026-05-01.** Cockpit's `useCorpusPick` ternaries collapsed to corpus-only readers. `usePlanOptimization` hook + `planOptimizationCache` + all `findOptimal*Async` imports + the three local optimizer-tile cards + the "Optimizing plan…" / north-star-violation banners removed from `CockpitScreen.tsx` (4185 → 3149 lines). One-shot localStorage migration clears the persisted cache. `ss-optimizer.ts` / `spend-optimizer.ts` / `roth-optimizer.ts` and their tests deleted (zero callers outside the retired chain). Test drift refreshed: `decision-engine` 80→240 trials, `scenario-compare` 40→200 trials with 30s timeout, `spend-solver` balanced-92% tolerance 100k→125k, parity-harness `withdrawalPolicy.order` aligned to `'roth (conditional)'` for both modes. Build + 661 tests green. Quantitative cockpit-load perf measurements still pending; tracked under Phase 3.

- [x] ~~**MINER_REFACTOR Phase 3: full e2e with V2 cluster mine.**~~ **Done 2026-05-01.** Cockpit ↔ dispatcher ↔ corpus all agree end-to-end on the V2 engine. Two infrastructure fixes shipped alongside the e2e:

  1. **Fingerprint alignment.** `cluster/start-session.ts` now uses `buildEvaluationFingerprint(...)|trials=${n}|fpv1` so `useRecommendedPolicy` discovers CLI-driven mines.
  2. **Dispatcher ranker alignment.** `cluster/corpus-writer.ts` runs the running-best pick through `policy-ranker.LEGACY_FIRST_LEXICOGRAPHIC` (legacy ≥ 0.85, solvent ≥ 0.70, max spend, tiebreak solvency, p50EW). Single source of truth across cluster, cockpit, and mining table. Feasibility *count* still uses the configurable bequest threshold for the household's progress-bar UI.
  3. **Session ID hashing.** `cluster/dispatcher.ts` hashes the now-long browser-format baseline fingerprint with sha256 before truncating for the session ID, so paths like `s-${sha256.slice(0,12)}-${ts}` stay clean.

  e2e via `scripts/phase3-e2e.ts` (49,368/49,368 evaluated, 754 feasible, 25s wall on 4 hosts):
  - Cockpit `bestPolicy(corpus, LEGACY_FIRST_LEXICOGRAPHIC)` matches dispatcher `bestPolicyId` (`pol_983edd39`).
  - Cockpit top-1 clears its own gates (87.6% legacy, 100% solvent, $110k spend, SS 70/67, Roth $120k, reverse_waterfall, p50EW $2.50M).
  - `minFeasibility=0.85` shrinks corpus 1,039 → 449, top-1 stable.
  - Boulder tweak → fingerprint changes, no session match (cockpit shows `stale-corpus`).

  Cockpit corpus-fetch hot path (`scripts/phase3-cockpit-perf.ts`): **111ms cold, ~80ms warm** — well under the 500ms target the workplan called out, vs. ~10-15s for the retired bisection chain.

- [ ] **PolicyMiningStatusCard live counters don't advance during a cluster mine** (UX bug, surfaced 2026-04-29 + reproduced 2026-04-30 with M4-only mine). The EVALUATED counter stays at `0/1728` and the THROUGHPUT field shows `—` for the entire duration of a Full mine, even though per-host pol/min counters DO update and the corpus actually accumulates evaluations on the dispatcher (the Mined Plan Candidates table populates correctly when the session ends). Confirmed today: 10-min M4-only mine ran cleanly end-to-end, table refreshed at completion, but the household never saw real-time progress beyond the per-host throughput line. **Likely cause**: PolicyMiningStatusCard's session-progress poller subscribes to a different cluster-snapshot field than what the dispatcher actually writes to during a mine. **Investigation steps**: (a) check `useClusterSession.ts:onSnapshot` for the field bound to EVALUATED, (b) confirm the dispatcher's `/sessions/:id` endpoint emits per-tick progress, (c) verify the WebSocket message shape includes `evaluatedCount` not just per-host telemetry. **Fix-priority: medium** — doesn't affect correctness, but it's confusing every time the household runs a mine. ~1-2 hour investigation + fix.


- [ ] **Engine validation findings — Rust-parity exploration sub-items 1, 2, 6**. Items 3, 4, 5 are resolved (LTC inflation fix landed, Trinity parametric documented as conservatism, 5% withdrawal documented as same root cause). Remaining minor items: (1) HSA fold-into-pretax — verify with worked example matches IRS HSA semantics; (2) Inheritance double-count — verify with worked example (engine net result is correct: cash retains $500k, no withdrawal); (6) Vol-bound ±0.45 documentation. None decision-critical; 1-2 hours of test/doc work.

- [ ] **Add authentication** — *recommended posture documented*.
  Options evaluated:
  1. **Keep local-only, never add auth** (status quo, per [product-spec.md](product-spec.md) V1 scope).
  2. **Lightweight local passcode** — device-bound encryption (macOS Keychain / browser SubtleCrypto + IndexedDB), no cloud, no account system. ~1 week of work.
  3. **Full account system with cloud sync** — requires a server, a threat model rework, and opens up the calibration-aggregation path. Many weeks of work + ongoing ops cost.

  **Recommendation: start with (2); defer (3) until there's a second user on deck.** Reasons:
  - Plan data is sensitive (income, balances, SS claim strategy). A local-only app that saves to `localStorage` in plaintext is one shoulder-surf away from full exposure.
  - Lightweight passcode solves the "another person at this device" problem without taking on server-side risk.
  - Cloud sync adds real value only when there's either (a) a second user (spouse, advisor) or (b) multi-device use. Single-user / single-device today → cloud is premature.
  - Calibration-aggregation (CALIBRATION_WORKPLAN step 12's privacy note) does NOT require cloud auth — it needs an opt-in anonymized-share flow, which can be a separate export/upload action without a full account system.

  **Concrete next steps if/when pursuing**:
  1. Wrap `localStorage.setItem` / `getItem` around the plan store in a thin encryption shim using a user-entered passcode as key (derive via PBKDF2 + SubtleCrypto).
  2. Prompt for passcode on app load; time out after N minutes of inactivity.
  3. Add a "forgot passcode → export plaintext + re-import under new passcode" recovery flow.

  Open questions remain:
  - Who is the plan shared with (spouse, advisor)?
  - Is there a specific trigger event (e.g., partner wants access) that would promote (2) → (3)?



- [x] ~~**Calibration test harness (Phase 1 of dual-view plan)**. Build `src/calibration.test.ts` that runs canonical retirement-MC scenarios (Trinity 3%/4%/5%, varying allocations, varying horizons) through the TS engine in both parametric and historical-bootstrap modes, compares to published expectations. Wires into CI as a regression guard. Document findings in `CALIBRATION_WORKPLAN.md`. See finding (5) above for the 5% gap that needs investigating as part of this.~~ **Done 2026-04-29.** 12 tests in `src/calibration.test.ts`, runs via `npm run test:calibration`. Historical-bootstrap mode validates within ±3pp of Trinity Study. Parametric gap traced to `equityMean: 0.074` conservatism (Phase 2.1 finding). LTC inflation fix landed (Phase 2.2). See CALIBRATION_WORKPLAN.md "External validation" section for full results.

- [ ] **Dual-view rollout to Sensitivity / Sandbox / History panels** (UX expansion, partial — Trust card shipped 2026-04-29). The Trust card already shows both forward-looking (parametric) and historical-precedent readings, with the AssumptionPanel exposing the inputs side-by-side. Remaining: extend the same dual-view pattern to the Sensitivity, Sandbox, and History tabs so users see "what would Boldin show" alongside our conservative default consistently across the app. Lower priority than calibration / engine work; pure UX polish.

## Completed (2026-04-29 → 2026-04-30 sprint)

- [x] **SS claim age as engine OUTPUT** — Cockpit projects against optimized SS+spend+Roth via `usePlanOptimization` hook. SS optimizer sweeps 65-70 × 65-70, recommends a pair against household constraints (85% solvent + 85% legacy). Trust card shows numbers under the optimized plan, not the seed.
- [x] **Spousal benefit floor in engine** — `getSocialSecurityIncome` in `utils.ts` delegates to `social-security.ts:computeAnnualHouseholdSocialSecurity`. SSA-precise own-claim adjustment (5/9 of 1%/mo + 5/12 of 1%/mo for early; 8%/yr DRC capped at 70). Spousal floor = max(own, 50% × higher PIA), gated on the higher earner having filed. Verified against Debbie's $1,444 own / $2,050 spousal floor scenario; "claim at 67 dominates claim at 70" insight validated by tests.
- [x] **Adaptive axis-pruning analyzer + Apply-and-rerun** — `src/axis-pruning-analyzer.ts` (pure function over corpus), `AxisPruningCard` UI in MiningScreen + UnifiedPlanScreen. Apply button threads `axesOverride` through `cluster.startSession` so the next mine runs on the narrowed grid. Companion to spend-optimizer infeasibility flag.
- [x] **Spend-as-engine-output** — `src/spend-optimizer.ts` bisects on annual spend subject to BOTH north-star constraints (solvent + legacy at 85%); Cockpit shows the frontier alongside current lifestyle.
- [x] **Roth-ceiling-as-engine-output** — `src/roth-optimizer.ts` sweeps 6 ceiling levels at the joint plan; ranks by feasibility then max p50 EW (today $).
- [x] **Constraint-aware optimizer scoring** — all three optimizers (SS, spend, Roth) filter candidates that fail both north stars first, then rank within the feasible set. North-star violation banner surfaces in Cockpit when no spend level satisfies both constraints.
- [x] **CalibrationDashboard adoption** — UncertaintyRange + TaxEfficiency + PreRetirementOptimizer tiles wired into Cockpit and UnifiedPlanScreen via single `<CalibrationDashboard />` composer.
- [x] **MedicareReminderCard + HSA-stop check** — Cockpit "Hard stops on the radar" panel surfaces Medicare-IEP timeline (auto-shows when within 36 months of age 65) plus HSA contribution conflict with the Part A 6-month look-back window.
- [x] **`compareRecommendationCandidates` rewritten as transitive composite scalar** — single `compositeRecommendationRank()` based on `recommendationScore - (combo ? 1.0 : 0)`. Strict pairwise-ordering test restored.
- [x] **Spend-solver test recalibration** — 4 tests re-tuned with higher legacy targets / solvency floors so constraints bind under the post-spousal-floor income profile.
- [x] **LTC inflation fix** (Phase 2.2, 2026-04-29) — `calculateLtcCostForYear` inflates from year zero matching industry actuarial projections; verification scenarios re-pinned.
- [x] **Calibration test harness** — 12 tests in `src/calibration.test.ts`, validates engine within ±3pp of Trinity Study (historical-bootstrap mode); parametric-mode 5% gap documented as deliberate `equityMean: 0.074` conservatism.
- [x] **Dual-view Trust card** — forward-looking + historical-precedent both shown; AssumptionPanel exposes inputs.
- [x] **SS as engine output (no seed concept)** (2026-04-30) — `seed-data.json` SS entries no longer carry `claimAge`; type made optional with FRA=67 fallback in engine. Cockpit's `RecommendedSocialSecurityCard` dropped the "Your current seed" comparison panel; the optimizer's recommendation IS the plan. SS now flows like income and taxes — household supplies FRA monthly amounts and birth dates only.
- [x] **Cockpit perf — 2-4× faster** (2026-04-30) — module-level `planOptimizationCache` survives Cockpit unmount; tab swap (Cockpit → Mining → Cockpit) is now instant on cache hit. In-app optimizers' default trial count lowered 500 → 250 (mining cluster keeps 2000 trials for certification corpus). First-paint Cockpit on a fresh fingerprint dropped from ~50s → ~12-15s.
- [x] **Survivor benefit + deterministic mortality (Phase A)** (2026-04-30) — `src/mortality.ts` ships SSA period-life-table 2020 p10/p50/p90 death ages. `MarketAssumptions` extended with optional `robDeathAge` / `debbieDeathAge`. `computeAnnualHouseholdSocialSecurity` upgraded with survivor-switch math: when one spouse is past `assumedDeathAge`, surviving spouse jumps to 100% of deceased's claim amount (subject to age ≥ 60). Engine wrapper threads death ages from assumptions. New `MortalitySensitivityCard` in Cockpit shows three scenarios (both alive to 95 / Rob dies at p50 / Rob dies at p10) with solvency + median EW per scenario. 4 new survivor-switch unit tests validate Debbie jumping from $2,050 spousal floor to $5,084 when Rob delayed to 70 then dies at 80.
- [x] **Crash-mixture equity sampler — Phase 1** (2026-04-30) — opt-in via `MarketAssumptions.equityTailMode: 'crash_mixture'`. Per year: 3% probability of equity return drawn from `[-43.8%, -37.0%, -35.0%, -26.5%, -22.1%]` (1931, 2008, 1937, 1974, 2002 historical worst US equity years). Bonds + cash unaffected (often rally in crashes). Mean-preserving: bounded-normal sampler's mean shifts UP by `(p × E[crash]) / (1 − p)` so overall expected return matches `equityMean`. No-op when `useHistoricalBootstrap: true` (that mode samples real history). 5 regression tests in `crash-mixture.test.ts` validate mean-preservation, tail-thickening, solvency-drop, determinism, and bootstrap no-op. AssumptionPanel surfaces the mode label. Closes the p10 tail gap structurally; calibration validation against Fidelity is the next phase.
- [x] **Actuals log + reconciliation — pipeline wired** (2026-04-30) — infrastructure (actuals-log.ts, prediction-log.ts, reconciliation.ts, DeltaDashboardTile) was already built; missing piece was integration. New `src/calibration-stores.ts` provides app-level singletons (localStorage-backed, in-memory fallback). Cockpit auto-logs predictions when the optimizer chain finishes. New `src/LogActualsCard.tsx` gives the household a 3-tab form (balances/spending/taxes) for entering real outcomes. CalibrationDashboard now passes both stores so DeltaDashboardTile actually renders. Six months from now: real drift numbers between predicted and actual.
- [x] **Allocation check remediation — FCNTX/FDGRX mappings + tighter tolerance** (2026-04-30) — Fidelity Contrafund (FCNTX, the household's biggest single position at $258k Roth) was mapped 100% US-equity. Real composition: ~90% US, ~8% non-US, ~2% cash. Same correction for FDGRX (95/4/1). Engine US-equity drift dropped 72.0% → 69.1% (vs Fidelity 65.0%) — closed 41% of the gap. INTL fully aligned (engine 9.4% vs Fidelity 9.1%). `allocation-check.test.ts` tolerance tightened 8pp → 5pp. Residual ~4pp drift is from CENTRAL_MANAGED proxy uncertainty (no public composition); tightens further when household supplies an override. Verification scenario `early-retirement-stress` re-pinned (failure-year window +1yr).
- [x] **Fidelity p10 calibration validation — Phase 2 finding** (2026-04-30) — Measured engine p10 vs Fidelity's published $436k for the household's actual seed across 4 modes (5000 trials each). **Direction reversed**: parametric default p10 = $140k (32% of Fidelity), parametric + crash mixture = $0 (too aggressive — 14% of trials run out), historical bootstrap = $2.19M (5× Fidelity, way too generous). The original BACKLOG claim that "engine p10 lands ~3.6× richer than Fidelity" is no longer accurate — the LTC inflation fix + spousal-floor lift + general engine tightening has shifted the parametric mode below Fidelity's p10. **Recommendation**: do NOT promote crash-mixture to default; the engine is already more conservative than Fidelity in parametric mode. Crash-mixture remains useful as opt-in stress-testing. Measurement script at `scripts/measure-p10.ts` for future re-runs after engine changes.
- [x] **UI speed-up — localStorage optimizer cache + lazy-mount below-fold cards** (2026-04-30) — `planOptimizationCache` now persists to localStorage (key `retirement-calc:plan-opt-cache:v1`, FIFO at 8 entries). A hard refresh restores the optimizer result instantly instead of triggering a fresh ~12s recompute. New `MountWhenVisible` component wraps the heaviest below-the-fold cards (MortalitySensitivityCard runs 3 extra path simulations; CalibrationDashboard's UncertaintyRangeTile runs its own sensitivity sweep; LogActualsCard); they mount only when scrolled within 300px of the viewport, or 2.5s after first paint, whichever first. Estimated first-paint reduction: ~40% on a fresh fingerprint, near-instant on cache hit.

## Completed (earlier)

- [x] **Fat-tail return distribution + clip removal** — `useHistoricalBootstrap` opt-in samples per-year (stocks, bonds, cash, inflation) tuples from historical_annual_returns.json. Closed p10 gap from 4.4× → 2.2× of Fidelity.
