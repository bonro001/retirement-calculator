# Die-With-Zero Workplan: Generosity Side-Car

Goal: Add a standalone Die-With-Zero analyzer that lets the household decide how much of their projected ~$1M terminal value should be redeployed as gifts to the next generation while they're still young, without disturbing the existing engine, miner, ranker, or cockpit. The side-car runs as its own module, calls the engine as a library, and produces a tournament view of three terminal-value targets (Conservative $500K / Moderate $200K / Aggressive $0). If the household adopts a strategy, the side-car outputs a `scheduledGenerosity` payload that gets pasted into `seed-data.json`; the existing miner then re-mines naturally on the boulder change. Until adoption, nothing about the current system changes.

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

Execution protocol:
1. Execute exactly one pending step per run (top to bottom).
2. Mark the active step as `[-]` while working, then `[x]` when done.
3. Add a short note under the step with files changed and verification done.
4. Stop after one step and report progress in-thread.

## Decisions locked in

These were settled during design discussion on 2026-05-10 and should not be re-litigated mid-implementation. Revisit only if a step uncovers a fact that contradicts them.

### Architecture: side-car, zero edits to existing system

- All new code lives under `src/dwz/` (analyzer modules) and `src/DwZScreen.tsx` (UI).
- No edits to: `src/utils.ts` (engine), `src/policy-miner-eval.ts`, `src/policy-ranker.ts`, `src/CockpitScreen.tsx`, `src/MiningScreen.tsx`, `src/types.ts`, or the seed-data schema (until adoption).
- The engine is called as a library from the side-car (`evaluatePolicy`, `buildPathResults`, `buildEvaluationFingerprint`).
- `POLICY_MINER_ENGINE_VERSION` is **not** bumped. The existing corpus stays valid.
- A new top-level navigation route to `DwZScreen` is the only change visible outside `src/dwz/`.

Rationale: this is exploratory work. The household wants to see what DwZ would look like before committing engine resources to it. Isolation lets the analyzer evolve quickly, lets the household abandon cheaply if it doesn't pan out, and protects the V1 ship.

### Tournament shape: three terminal-value targets

| Target name | Terminal value at age 90 (25th pctile) | Total deployed to recipients (estimate) |
|---|---|---|
| Conservative | $500,000 | ~$500K |
| **Moderate** (primary) | $200,000 | ~$800K |
| Aggressive | $0 | ~$1M+ |

The household picks after seeing all three side-by-side. Moderate is the default focus but the tournament runs all three every time.

### Recipient model: asymmetric

Two recipient profiles, structurally different optimization targets:

- **Ethan** (b. 1993, US, Grants Pass OR, stable housing, married, 1 child under 2): cash gifts directly to him. Vehicle = annual exclusion ($19K from Rob + $19K from Debbie = $38K/yr 2026 limit). Utility weighted toward the "young-family squeeze" stage (~ages 30-42).
- **Mavue** (b. 2025, US citizen via CRBA, granddaughter via Reese; Reese's family is US Air Force SOFA-protected in Germany, treated as US-domiciled): 529 + UTMA to Mavue directly, not to Reese. Two superfund drops planned (2028 and 2033, ~$95K each). Utility weighted toward earliest-possible 529 funding for maximum compounding to college.

The asymmetry is structural and must be preserved in the schedule builder: Ethan gets cash, Mavue gets vehicles that compound.

### Confidence gate: 25th percentile

The gift schedule is sized so that the 25th-percentile terminal value (across Monte Carlo trials) hits the target. This is the "painless" threshold — even in a poor sequence of returns, the plan still leaves the targeted estate. This matches the household's stated comfort level.

### Planning horizon: 90 (optimization), 95 (stress check)

The gift schedule solves against age 90. The 25th-percentile terminal value at age 95 is computed and reported as a stress signal but not used as a gating constraint. If the 95-stress number ever drops below a configurable safety floor (default $0), the side-car flags it and recommends pulling back gift aggressiveness.

### Spending stays unchanged

Per household preference: monthly spending stays as-is in the base plan. The DwZ analyzer does NOT recommend cuts to monthly spending. Gifts come exclusively from the projected terminal-value gap. This is enforced by holding `annualSpendTodayDollars` constant at the corpus-recommended value while solving for the gift schedule.

### Adoption is manual

When the household picks a strategy, the side-car outputs a JSON payload:

```jsonc
{
  "scheduledGenerosity": [
    {
      "name": "mavue_529_superfund_1",
      "year": 2028,
      "amount": 95000,
      "sourceAccount": "taxable",
      "recipient": "mavue",
      "vehicle": "529_superfund",
      "label": "Mavue 529 superfund #1 (5-yr annual exclusion election)",
      "taxTreatment": "gift_no_tax_consequence"
    },
    {
      "name": "ethan_annual_2029",
      "year": 2029,
      "amount": 20000,
      "sourceAccount": "cash",
      "recipient": "ethan",
      "vehicle": "annual_exclusion_cash",
      "label": "Ethan cash gift — annual exclusion",
      "taxTreatment": "gift_no_tax_consequence"
    }
  ]
}
```

The household pastes this into `seed-data.json` as a new top-level field (or under `income.scheduledGenerosity` — TBD in step 8 once we look at the schema). The existing miner sees a fingerprint change, re-mines once (~3 min), and the cockpit reflects the new reality. This intentional manual step keeps the adoption decision out of code.

### What this work does NOT do

- Does NOT modify the engine projection loop. Gifts are scheduled outflows in specific years, simulated by the engine via its existing event-handling path.
- Does NOT bump `POLICY_MINER_ENGINE_VERSION`. The existing corpus remains valid.
- Does NOT add a mining axis. The tournament runs as a side-car analysis, not as part of the policy enumeration grid.
- Does NOT change the ranking rule. `LEGACY_FIRST_LEXICOGRAPHIC` and the $1M GATE 1 stay locked in until/unless the household adopts a strategy and chooses to lower the gate.
- Does NOT replace cockpit content. The DwZ tournament lives on its own screen.
- Does NOT model LTC strategy or term life as side-car features. Those remain plan-level boulders that the household configures externally (LTC broker quotes, Term4Sale, etc.) and adds to `seed-data.json` separately.

## Steps

### Phase 1: Foundation (types, utility model, schedule template)

1. [ ] **Define DwZ types**
   - New file `src/dwz/types.ts`.
   - Export: `GiftEvent`, `GiftSchedule`, `RecipientProfile`, `RecipientStage`, `UtilityCurve`, `TerminalValueTarget`, `PhasePlan`, `DwZStrategy`, `DwZOutcome`, `TournamentResult`, `AdoptionPayload`.
   - Document each interface inline.
   - `GiftEvent` mirrors the shape of `income.windfalls[]` entries plus a `recipient` and `vehicle` field, so the adoption payload is a structural cousin of existing scheduled flows.
   - `RecipientStage` enum: `'launch' | 'squeeze' | 'established' | 'late_career' | 'compounding_child'`.
   - `UtilityCurve` is a per-age table of utility multipliers (e.g., `{ 30: 1.4, 35: 1.3, 45: 1.0, 60: 0.7 }`) with linear interpolation between points.
   - Verification: `npx tsc --noEmit` passes.

2. [ ] **Build utility-model module**
   - New file `src/dwz/utility-model.ts`.
   - Export `computeRecipientUtility(recipient: RecipientProfile, year: number, vehicle: GiftEvent['vehicle']): number`.
   - Implement built-in curves for the two locked recipient profiles:
     - **Ethan cash curve**: peaks at ages 30-42 (the "young-family squeeze" — toddler, building career, sleep-deprived). Default values: age 30 = 1.4, age 35 = 1.35, age 42 = 1.2, age 50 = 1.0, age 60 = 0.85.
     - **Mavue 529 curve**: peaks at ages 0-5 (maximum compounding runway to college), declines steeply after age 14. Default values: age 1 = 1.5, age 5 = 1.4, age 10 = 1.2, age 15 = 0.9, age 18 = 0.6.
   - Each curve is exported as a named constant so users can override per-recipient via config.
   - Verification: new test file `src/dwz/utility-model.test.ts` (5 tests): each curve monotonic where expected, curves peak at documented ages, interpolation correct at midpoints, unknown ages clamp to nearest endpoint, custom curve override works.

3. [ ] **Build gift-schedule-builder module**
   - New file `src/dwz/gift-schedule-builder.ts`.
   - Export `buildGiftScheduleTemplate(plan: SeedData, profiles: RecipientProfile[], phasePlan: PhasePlan): GiftEvent[]`.
   - Implements the five-phase plan locked in design:
     - Phase 0 (pre-retire, now → 2027-07-01): symbolic only ($1K Mavue 529 seed)
     - Phase 1 (sequence danger, 2027 → mid-2028): $5K Ethan, $5K Mavue
     - Phase 2 (ramp post-inheritance, mid-2028 → SS turn-on ~2031): $15K Ethan, $15K Mavue, plus $95K Mavue 529 superfund #1 in 2028
     - Phase 3 (full gifting, ~2031 → 2034): up to $19K Ethan, up to $19K Mavue, plus $95K Mavue 529 superfund #2 in 2033
     - Phase 4 (event-driven surplus, 2037+): home-sale liquidity available, scale up if 25th-pct holds
   - Output is the **template** — a per-year list of `GiftEvent`s with their **face amounts**. The bequest-solver (step 4) scales this template by a single scalar.
   - Verification: new test file `src/dwz/gift-schedule-builder.test.ts` (8 tests): each phase boundary produces expected events, vehicle assignments correct (Ethan=cash, Mavue=529/UTMA), superfund drops appear in 2028 and 2033, sourceAccount distribution follows tax-efficient ordering, total face amount sums match documented phase budgets.

### Phase 2: Bequest solver and tournament runner

4. [ ] **Build bequest-solver module**
   - New file `src/dwz/bequest-solver.ts`.
   - Export `solveScheduleScale(plan: SeedData, basePolicy: Policy, template: GiftEvent[], target: TerminalValueTarget, opts?: { confidencePctile?: 25, maxIterations?: 15, tolerance?: 0.02 }): { scale: number, schedule: GiftEvent[], outcome: DwZOutcome }`.
   - Internally calls `evaluatePolicy` from `policy-miner-eval` as a library with the gift events injected as scheduled outflows.
   - Bisects on a scalar multiplier in [0, 2.0]:
     - At scale=0: terminal value = baseline (~$1M at 25th-pctile)
     - At scale=1.0: full template applied
     - At scale=2.0: double the template (test ceiling for aggressive targets)
   - Convergence criterion: 25th-pctile terminal value within `tolerance` (default 2%) of target, or `maxIterations` (default 15) hit.
   - Returns the converged scale, the scaled `GiftEvent[]`, and the resulting outcome (terminal value at 25/50/75 pctile, total deployed, plan success probability, 95-stress).
   - Verification: new test file `src/dwz/bequest-solver.test.ts` (6 tests): converges to $200K target within tolerance, converges to $500K target, converges to $0 target, handles infeasible target (target > baseline → returns scale=0), respects max iterations, deterministic with seed.

5. [ ] **Build tournament-runner module**
   - New file `src/dwz/tournament-runner.ts`.
   - Export `runTournament(plan: SeedData, corpus: Corpus, profiles: RecipientProfile[], targets: TerminalValueTarget[] = [500_000, 200_000, 0]): TournamentResult`.
   - Reads the existing corpus, selects the top policy under `LEGACY_FIRST_LEXICOGRAPHIC` via `bestPolicy` from `policy-ranker.ts`.
   - For each target, calls `solveScheduleScale` and collects results.
   - Computes cost-of-waiting deltas: for each gift in each strategy, how much would the gift "cost" the terminal value if delayed by 1, 5, or 10 years.
   - Output: `TournamentResult` with one `DwZStrategy` per target, each containing the schedule, outcome, total deployed, per-recipient totals, cost-of-waiting matrix.
   - Verification: new test file `src/dwz/tournament-runner.test.ts` (4 tests): three strategies returned, Conservative has highest terminal / lowest total deployed, Aggressive has lowest terminal / highest total, snapshot test on the locked household plan.

### Phase 3: Adoption payload

6. [ ] **Build adoption-payload module**
   - New file `src/dwz/adoption-payload.ts`.
   - Export `buildAdoptionPayload(tournament: TournamentResult, chosenTarget: TerminalValueTarget): AdoptionPayload`.
   - Converts the chosen strategy into the JSON shape documented in "Decisions locked in".
   - Includes a `meta` field: `{ generatedAt, dwzVersion, sourceCorpusFingerprint, chosenTarget, totalDeployed, expectedTerminalValue }` so a pasted payload can be audited later.
   - Export `validateAdoptionPayload(payload: unknown): { valid: boolean, errors: string[] }` — runtime schema check the household can run before pasting.
   - Verification: new test file `src/dwz/adoption-payload.test.ts` (5 tests): round-trip via JSON.stringify/parse preserves shape, validator catches missing fields, validator catches negative amounts, validator catches unknown source accounts, meta fields populated.

### Phase 4: UI

7. [ ] **Build DwZScreen**
   - New file `src/DwZScreen.tsx`.
   - Layout: three columns (Conservative / Moderate / Aggressive), each showing:
     - Target terminal value at age 90 (25th pctile)
     - Total deployed across the plan
     - Per-recipient breakdown (Ethan total / Mavue total)
     - Per-year gift schedule table (year, recipient, amount, vehicle)
     - 25th-pctile terminal value at age 95 (stress signal)
     - Plan success probability
   - Below the columns:
     - Cost-of-waiting chart: each gift plotted by "now vs. delay" cost
     - "Copy adoption payload" button per column → writes JSON to clipboard via `navigator.clipboard.writeText`
   - Empty state: if corpus doesn't exist, show "DwZ analysis requires a mined corpus. Run a mine first →" with CTA routing to Mining screen.
   - Stale state: if corpus fingerprint doesn't match current plan, show "Corpus is stale — recommendations may be outdated. Re-mine →".
   - Verification: manual browser check on the locked household plan; capture a screenshot.

8. [ ] **Wire DwZ navigation**
   - Edit `src/App.tsx` (or wherever screen routing lives — single screen-name addition).
   - Add a route or screen state for `'dwz'`.
   - Add a nav entry (header or sidebar — match existing pattern).
   - Verification: clicking the nav entry loads `DwZScreen`; back-navigation works; no regression on existing screens (manual smoke test of Cockpit, Mining, AssumptionPanel).

### Phase 5: Survivor scenario stress check (optional within side-car)

9. [ ] **Build survivor-scenarios module**
   - New file `src/dwz/survivor-scenarios.ts`.
   - Export `runSurvivorScenarios(plan: SeedData, chosenStrategy: DwZStrategy, deathYears: number[] = [2027, 2030, 2034, 2040]): SurvivorReport`.
   - For each death year, run the engine with the death modeled (income changes, filing status → single, survivor SS strategy = "own at 62 then switch to survivor at FRA", spending → 72% of joint).
   - Output per scenario: survivor 25th-pctile terminal value at age 90, plan success probability, required additional term life to close any gap.
   - Verification: new test file `src/dwz/survivor-scenarios.test.ts` (4 tests): each death year produces a coherent outcome, earlier deaths produce worse survivor outcomes (monotonicity), term-life sizing recommendation is positive when survivor success drops below 90%, deterministic with seed.

10. [ ] **Add survivor view to DwZScreen**
    - Add a collapsible "Survivor stress check" panel below the tournament.
    - Shows a 2×4 matrix: (Rob dies, Debbie dies) × (2027, 2030, 2034, 2040), each cell containing survivor terminal value and success probability.
    - Highlights cells where success < 90% and shows the recommended term-life closing amount.
    - Verification: manual browser check; screenshot.

### Phase 6: Verification + docs

11. [ ] **Calibration regression check**
    - Run `npm run test:calibration` and confirm Trinity ±3pp / FICalc ±10pp bands still pass.
    - This should be a no-op since the engine was not edited, but verifying closes the loop.
    - Verification: test report attached to the step's `Done:` block.

12. [ ] **Update README, AGENTS.md, BACKLOG.md**
    - README: add `DIE_WITH_ZERO_WORKPLAN.md` to the Workplans section. One-paragraph description of the DwZ side-car and its isolation principle.
    - AGENTS.md: add a short section noting that `src/dwz/` is a side-car analyzer; it calls the engine as a library but does not modify it. Future agent work in `src/dwz/` should preserve this isolation.
    - BACKLOG.md: open follow-up items:
      - "DwZ Phase 2: integrate terminal-value as mining axis (once side-car proves the concept)"
      - "DwZ Phase 3: LTC and term life as mining axes (once household has real quotes)"
      - "Lower GATE 1 in `LEGACY_FIRST_LEXICOGRAPHIC` to match adopted target (deferred until household adopts)"
    - Verification: docs reviewed in PR.

13. [ ] **End-to-end verification scenario**
    - With a fresh corpus on the locked household plan:
      - Open DwZScreen → tournament renders three strategies.
      - Click "Copy adoption payload" on Moderate → JSON copied.
      - Paste payload into a copy of `seed-data.json` (do not edit the real one in this step).
      - Run `validateAdoptionPayload` on the pasted JSON → valid.
      - Run a small mine against the modified seed → corpus produces new top-1 reflecting the gift schedule.
      - Compare new top-1 vs. baseline top-1 → terminal value lower, total gifts deployed equals chosen target gap.
    - Document the round-trip in this step's `Done:` block.
    - Verification: documented as a one-page e2e test report.

## Risks and open questions

- **Bequest solver convergence under thin paths.** The 25th-percentile terminal value can be noisy with 2000 trials. If solves don't converge cleanly to ±2% tolerance within 15 iterations, options are: increase to 5000 trials per solve (slower), widen tolerance to ±5% (less precise), or switch from bisection to a coarse-then-fine grid (different convergence profile). Plan for it but don't pre-solve.

- **Utility model is opinionated.** The stage multipliers represent judgment calls about when money matters most to recipients. The defaults capture the household's discussion but should be exposed as configurable so they can be adjusted as life situations change (e.g., if Ethan's child reaches school age and the squeeze stage shifts).

- **Mavue's CRBA / SSN status.** Strongly believed to be a US citizen with SSN given USAF father, but blocking for 529 funding until confirmed. Side-car models assuming yes, but flags the assumption in the UI so the household can confirm with Reese before any adoption.

- **`scheduledGenerosity` schema placement.** Step 6 will pick between a new top-level field in `seed-data.json` and nesting under `income.windfalls` (treating gifts as negative-amount windfalls). Decision depends on how the engine's existing event-handling code distinguishes inflows from outflows. Investigate in step 6; document the choice.

- **Engine "as library" coupling.** Importing `evaluatePolicy` and `buildPathResults` couples the side-car to those signatures. If the miner refactor changes them, the side-car needs to follow. Acceptable — the alternative (duplicating the engine path) is worse.

- **Adoption payload pasting is manual.** Risk the household pastes into the wrong place or forgets to re-mine. Mitigations: validator function (step 6), clear UI instructions on the "Copy payload" button, README note describing the adoption flow.

- **Side-car bypasses the ranker.** The DwZ tournament shows three terminal-value targets — but the existing ranker still ranks the corpus under GATE 1 = $1M. After adoption, the ranker's GATE 1 may need to drop to match the chosen target, or the household sees a "stale" cockpit recommendation. Tracked as a follow-up in step 12's BACKLOG update.

- **LTC and term life remain external.** These interact with gift capacity but are not modeled in the side-car. The household configures them via separate decisions (broker quotes, Term4Sale) and updates `seed-data.json` separately. The side-car re-runs naturally against the updated plan.

- **Tournament runtime.** Each `solveScheduleScale` is ~15 MC runs × 2000 trials = 30K trials. Three strategies × 30K = 90K trials per tournament. At engine speed this is ~30-60 seconds. Acceptable but noticeable — show a loading state in DwZScreen.

## Ready to start

Step 1 (define DwZ types) is the right entry point — pure types, no logic, no engine coupling, unblocks every subsequent step. Begin there.
