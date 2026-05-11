# Die-With-Zero Workplan: Generosity Side-Car

Goal: Add a Die-With-Zero analyzer that lets the household decide how much of their projected ~$1M terminal value should be redeployed as gifts to the next generation while they're still young. The analyzer is a side-car module that calls the engine as a library and produces a tournament view of three terminal-value targets (Conservative $500K / Moderate $200K / Aggressive $0, all in today dollars). The engine grows one new additive capability — a `scheduledOutflows` event type — so it can simulate gift events. No other engine behavior, ranker logic, miner orchestration, or cockpit content changes during this work. If the household adopts a strategy, the analyzer outputs a two-part payload (gift events + lowered legacy target) that gets pasted into `seed-data.json`; the existing miner then re-mines naturally on the boulder change. Until adoption, the cockpit's headline is unchanged.

**Revision history**:
- 2026-05-10 v1: initial draft, assumed gifts could ride on `income.windfalls[]` as negative amounts.
- 2026-05-10 v2: code review found windfalls are clamped nonnegative ([src/utils.ts:1445](src/utils.ts:1445)); adoption can't lower the $1M legacy gate without an explicit patch ([src/legacy-target-cache.ts:17](src/legacy-target-cache.ts:17)); `evaluatePolicy` is async with 8 inputs ([src/policy-miner-eval.ts:277](src/policy-miner-eval.ts:277)); ScreenId edit was forbidden but required. Added Phase 0 engine spike, loosened "no edits" locks to "additive only", made adoption payload two-part, fixed solver signatures and convergence math.
- 2026-05-10 v3: second code review found Phase 0 placed outflows after the closed-loop tax/healthcare pass (breaking AGI/ACA/IRMAA flow-through); the Mavue schedule still scheduled annual gifts inside the 529 5-year cooldown window; `formatPayloadForClipboard` emitted comment-prefixed JSON which would break `import seedData from '../seed-data.json'` at [src/data.ts:1](src/data.ts:1); HSA was incorrectly modeled as a tax-free gift source (IRS Pub 969: non-qualified-medical distributions are ordinary income plus 20% penalty pre-65); `runTournament` referenced a corpus payload that `useRecommendedPolicy` doesn't expose (correct loader is `loadCorpusEvaluations` at [src/policy-mining-corpus-source.ts:31](src/policy-mining-corpus-source.ts:31)); leftover `GiftEvent` reference after v2 deleted the type; Phase 6 still claimed the engine wasn't edited. Fixed all seven.
- 2026-05-10 v4: cadence reframe. v3's headline output was a multi-year gift schedule pasted at adoption time, which implicitly commits the household to a future they don't yet know. v4 makes the headline output **"this year, what can we give?"** — paralleling the existing "spend this month" pattern in the cockpit. The multi-year schedule template still exists internally as the bequest-solver's trajectory math, but the user sees and adopts one year at a time. The 529 superfund (inherently a 5-year IRS commitment) remains a discrete multi-year decision the user opts into explicitly. Goals patch (legacy target) happens once at first adoption; subsequent years just append to `scheduledOutflows`. No engine work changes; the changes are in DwZScreen output framing, adoption-payload module (now produces single-year payloads by default), and tournament-runner output (adds `thisYearRecommendation` per strategy).

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

### Architecture: side-car with one additive engine capability

- The DwZ analyzer modules live under `src/dwz/` (analyzer logic) and `src/DwZScreen.tsx` (UI).
- The engine gets exactly one additive capability: a new `scheduledOutflows` event type handled in the per-year projection loop ([src/utils.ts](src/utils.ts) around line 4879 where windfall cash inflow is currently summed into `balances.cash`). The new path subtracts from named accounts in matching years. No existing logic is modified; no existing assumption breaks.
- Allowed additive edits:
  - `src/types.ts`: add `ScheduledOutflow` interface (Phase 0); extend `ScreenId` to include `'dwz'` (Phase 4).
  - `src/utils.ts`: add outflow-handling branch in projection loop (Phase 0).
  - `src/App.tsx`: extend `REACHABLE_SCREENS` array to include `'dwz'` (Phase 4, single line at [src/App.tsx:744](src/App.tsx:744)).
  - Seed-data schema: add top-level `scheduledOutflows[]` array; allow `goals.legacyTargetTodayDollars` to be lower than the current $1M default (Phase 0 + adoption).
- **Forbidden** edits (these stay locked):
  - `src/policy-ranker.ts` — ranking rule stays at `LEGACY_FIRST_LEXICOGRAPHIC`; only the gate's *target value* changes via the seed-data `goals` patch.
  - `src/policy-miner-eval.ts` — the evaluator is called as a library; its signature and behavior are not modified.
  - `src/CockpitScreen.tsx`, `src/MiningScreen.tsx` — cockpit and mining screens render the (updated) corpus exactly as they do today.
  - `src/legacy-target-cache.ts` — `DEFAULT_LEGACY_TARGET_TODAY_DOLLARS` constant stays at $1M; the household's chosen target lives in seed-data, not in the default.
- `POLICY_MINER_ENGINE_VERSION` is bumped **once** in Phase 0 (engine outflow support). This invalidates the existing corpus once; the household re-mines (~3 min) to pick up the new engine capability. Subsequent DwZ work doesn't bump again.

Rationale: the v1 "zero engine edits" framing was incompatible with the engine's actual cashflow model (windfalls clamp to nonnegative, so gifts can't be modeled as negative windfalls). The minimum honest path is one additive engine capability — a new event type — that the side-car drives. Everything outside that capability remains untouched.

### Tournament shape: three terminal-value targets

All target values are stated in **today dollars** (matching the convention used by existing policy summaries such as `annualSpendTodayDollars` and `p50EndingWealthTodayDollars`). The bequest solver compares the 25th-pctile terminal value, deflated to today dollars, against the configured target.

| Target name | Terminal value @ age 90, 25th pctile (today $) | Total deployed to recipients (estimate, today $) |
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

### Cadence: annual-primary, multi-year as background math

The DwZ analyzer's **headline output** is a "this year, what can we give?" recommendation — analogous to the existing "spend this month" output that already drives the household's financial decisions. The multi-year schedule template still exists internally (the bequest solver needs it to verify the long-horizon target is achievable), but the user does not commit to it in bulk.

Each year, the household:

1. Opens the DwZ screen.
2. Sees: *"This year (2026), your gift capacity at the Moderate target is $X total — recommended split $A to Ethan, $B to Mavue."*
3. Sees a trajectory forecast: *"If you continue at this pace, terminal value at 90 lands at $200K. You're on track."*
4. Decides: adopt this year's recommendation (paste a single-year payload into `scheduledOutflows`), modify it, or skip the year.
5. Repeats next year.

This eliminates the v3 problem of overcommitting to a 10-year plan that life will inevitably reshape. It also mirrors how every other recommendation in the app already works — the cockpit's "spend this month" output is dynamic, not a multi-decade contract.

**Three exceptions** to the strictly-annual cadence, each handled as a discrete user-initiated decision:

- **529 superfund** — the IRS Form 709 election spreads one big gift over 5 years of annual exclusion, so committing to it is inherently multi-year. DwZScreen surfaces this as a separate "long-horizon commitment" with its own opt-in button. Adopting a superfund adds the single future-year `ScheduledOutflow` (e.g., year=2028, amount=$190K) AND records the 5-year cooldown so subsequent annual recommendations to that recipient automatically suppress until cooldown expires.
- **First-time adoption** — the very first year, the household chooses a terminal-value target. This sets `goals.legacyTargetTodayDollars` in seed-data. Subsequent years inherit this until/unless the household revisits the choice. The first-time payload includes both the goals patch AND the year's gift events; subsequent payloads include only the year's events.
- **Pre-committed milestones** — the household can optionally pre-commit specific future events (e.g., "every 5 years, do a Mavue superfund") at first adoption. These get serialized as future-year `ScheduledOutflow` entries and the engine simulates them. The household can always remove them later by editing seed-data.

### Planning horizon: 90 (optimization), 95 (stress check) — implemented via assumption overrides

The seed-data's `household.planningAge` is 95, and the engine reads horizon from `robPlanningEndAge` / `debbiePlanningEndAge` (or the seed `planningAge` as fallback — see [src/utils.ts:687](src/utils.ts:687)). The DwZ analyzer implements the dual horizon explicitly by passing two distinct engine runs:

- **Solve run** — clone the assumptions with `robPlanningEndAge: 90` and `debbiePlanningEndAge: 90` overrides. The bequest solver bisects against the 25th-pctile terminal value from this run.
- **Stress run** — same policy + scaled schedule, but assumptions cloned with horizon = 95 (or the seed default). The 25th-pctile terminal value at 95 is reported as a stress signal.

If the 95-stress number ever drops below a configurable safety floor (default $0 today dollars), the side-car flags it and recommends pulling back gift aggressiveness. Both runs are part of every solve; cost is ~2x a single evaluation per target.

### Spending stays unchanged

Per household preference: monthly spending stays as-is in the base plan. The DwZ analyzer does NOT recommend cuts to monthly spending. Gifts come exclusively from the projected terminal-value gap. This is enforced by holding `annualSpendTodayDollars` constant at the corpus-recommended value while solving for the gift schedule.

### Adoption is manual, annual-primary, and incremental

Three distinct adoption flows, each producing its own payload variant from `buildAdoptionPayload`:

#### A. First-time adoption (sets the target)

The first year the household commits to a DwZ strategy, the payload includes the goals patch AND that year's gift events. Without the goals patch, the ranker's `LEGACY_FIRST_LEXICOGRAPHIC` gate still requires the corpus to clear $1M @ 85% confidence, which is incompatible with a lower target. The corpus would fail GATE 1 and the cockpit would show the "no feasible policy" empty state.

```jsonc
// First-time payload — paste once, when picking a strategy
{
  "goals": {
    "legacyTargetTodayDollars": 200000     // ← lowered from $1M default; persists across years
  },
  "scheduledOutflows": [
    {
      "name": "mavue_529_seed_2026",
      "year": 2026,
      "amount": 1000,
      "sourceAccount": "cash",
      "recipient": "mavue",
      "vehicle": "529_superfund",
      "label": "Mavue 529 seed funding (Phase A symbolic)",
      "taxTreatment": "gift_no_tax_consequence"
    }
  ]
}
```

#### B. Annual recurring adoption (the common case)

Each subsequent year, the household opens DwZScreen, reviews the "this year" recommendation, and pastes only that year's events. No goals patch needed — it carries over from first-time adoption.

```jsonc
// Annual payload — paste each year
{
  "scheduledOutflows": [
    {
      "name": "ethan_annual_2027",
      "year": 2027,
      "amount": 5000,
      "sourceAccount": "cash",
      "recipient": "ethan",
      "vehicle": "annual_exclusion_cash",
      "label": "Ethan cash gift — symbolic (Phase B)",
      "taxTreatment": "gift_no_tax_consequence"
    },
    {
      "name": "mavue_529_annual_2027",
      "year": 2027,
      "amount": 5000,
      "sourceAccount": "cash",
      "recipient": "mavue",
      "vehicle": "529_superfund",
      "label": "Mavue 529 annual contribution",
      "taxTreatment": "gift_no_tax_consequence"
    }
  ]
}
```

The household **appends** these entries to the existing `scheduledOutflows` array (paste-and-merge). Past years stay as a historical record; the engine simulates them in the projection just like any other scheduled flow.

#### C. Long-horizon commitment (superfund opt-in, occasional)

The 529 superfund is inherently a 5-year IRS election, so DwZScreen surfaces it as its own button: *"Commit to 2028 Mavue 529 superfund ($190K joint, blocks Mavue annual exclusion 2028-2032)."* When the household clicks adopt, the payload contains the single future-year event AND a note that the schedule builder must enforce the cooldown going forward.

```jsonc
// Long-horizon commitment payload — opt-in, occasional
{
  "scheduledOutflows": [
    {
      "name": "mavue_529_superfund_1",
      "year": 2028,
      "amount": 190000,
      "sourceAccount": "taxable",
      "recipient": "mavue",
      "vehicle": "529_superfund",
      "label": "Mavue 529 superfund #1 (5-yr annual exclusion election, joint Rob+Debbie)",
      "taxTreatment": "gift_no_tax_consequence"
    }
  ]
}
```

In all three flows: the household pastes the payload into `seed-data.json`, the existing miner sees a fingerprint change, re-mines once (~3 min), and the cockpit reflects the new reality. Past adopted gifts accumulate in `scheduledOutflows` over time, forming a historical record.

### Gift-tax limits enforced in the schedule builder

Per IRS 2026 rules (annual exclusion = $19K per donor per donee, $38K joint from two spouses), the gift-schedule-builder caps face amounts at:

| Vehicle | Per-recipient-per-year cap | Notes |
|---|---|---|
| `annual_exclusion_cash` | $38,000 | Combined Rob + Debbie. Exceeds → split across years or use Form 709. |
| `529_superfund` (5-yr election) | $190,000 per superfund event | $95K × 2 spouses, blocks subsequent annual exclusion to that donee for 5 years. |
| `direct_pay_tuition_medical` | unlimited | Doesn't touch exclusion. Reserved for grandkid education years; not used pre-college. |

When the bequest solver's scalar would push a gift above its vehicle cap, the schedule builder either (a) shifts the surplus to the next year (preferred) or (b) re-tags the excess portion with `taxTreatment: 'requires_form_709'` (factually accurate — annual gifts above $19K per donor require filing Form 709 even when no tax is due, because lifetime exemption usage is tracked). The default behavior is (a); (b) is opt-in via a builder config flag.

### What this work does NOT do

- Does NOT modify existing engine projection logic. The engine gets one new additive branch (scheduled outflows in Phase 0); existing withdrawal, tax, RMD, ACA, IRMAA, and Roth-conversion logic all remain unchanged.
- Does NOT add a mining axis. The tournament runs as a side-car analysis, not as part of the policy enumeration grid.
- Does NOT change the ranking rule. `LEGACY_FIRST_LEXICOGRAPHIC` and the structure of GATE 1 stay locked. The gate's *target value* is read from `goals.legacyTargetTodayDollars`, which the household lowers via the adoption payload.
- Does NOT modify `src/policy-miner-eval.ts`, `src/policy-ranker.ts`, `src/CockpitScreen.tsx`, `src/MiningScreen.tsx`, or `src/legacy-target-cache.ts`.
- Does NOT replace cockpit content. The DwZ tournament lives on its own screen.
- Does NOT model LTC strategy or term life as side-car features. Those remain plan-level boulders that the household configures externally (LTC broker quotes, Term4Sale, etc.) and adds to `seed-data.json` separately.
- Does NOT add survivor scenarios as a mining axis. Survivor stress checks (Phase 5) are side-car-only — additional engine calls with modified plan inputs.

## Steps

### Phase 0: Engine outflow capability (additive)

This phase exists because v1's "gifts as negative windfalls" approach is incompatible with the engine — windfalls are clamped to nonnegative at [src/utils.ts:1445](src/utils.ts:1445) and added to `balances.cash` as positive inflows around [src/utils.ts:4879](src/utils.ts:4879). The cleanest fix is a new event type that the projection loop subtracts from named accounts. This is the only step that touches the engine.

0a. [ ] **Define `ScheduledOutflow` schema and seed-data integration point**
   - Edit `src/types.ts` — add a new exported interface:
     ```ts
     export interface ScheduledOutflow {
       name: string;
       year: number;
       amount: number;                              // today dollars, deflated inside the engine
       sourceAccount: 'cash' | 'taxable' | 'pretax' | 'roth';
       // NOTE: 'hsa' is intentionally excluded as a gift source. Non-qualified-medical
       // HSA distributions are ordinary income + 20% additional tax pre-65 (IRS Pub 969).
       // The HSA's tax-advantaged status is best preserved for late-life medical / LTC.
       recipient: string;                           // free text for reporting (e.g., 'ethan', 'mavue')
       vehicle: 'annual_exclusion_cash' | '529_superfund' | 'direct_pay_tuition_medical' | 'utma' | 'other';
       label: string;
       taxTreatment: 'gift_no_tax_consequence' | 'requires_form_709';
     }
     ```
   - Extend `SeedData` to include an optional `scheduledOutflows?: ScheduledOutflow[]` top-level field. Optional so existing seed-data files validate without modification.
   - Verification: `npx tsc --noEmit` passes; existing seed-data files still parse.

0b. [ ] **Implement scheduled-outflow handling INSIDE the closed-loop pass**
   - Edit `src/utils.ts` — outflows must inject at the same point where existing windfalls inject (immediately before the closed-loop pass at [src/utils.ts:4882](src/utils.ts:4882)), not after withdrawals are computed. Otherwise the tax/IRMAA/ACA closed-loop iteration at [src/utils.ts:4979](src/utils.ts:4979) and the spending recomputation at [src/utils.ts:5198](src/utils.ts:5198) won't see the gift-driven income, and AGI/MAGI/healthcare subsidies will be wrong.
   - Specifically, for each current-year entry in `data.scheduledOutflows`:
     - Compute `outflowNominal = amount * inflationFactor(year)` (today-dollars → nominal).
     - **Add to `baseTaxInputs` BEFORE the closed loop runs**, paralleling the existing windfall pattern:
       - `sourceAccount === 'pretax'`: forced distribution. Add `outflowNominal` to `baseTaxInputs.otherOrdinaryIncome` (same handling as `windfallOrdinaryIncome` already does today).
       - `sourceAccount === 'taxable'`: realize cost-basis-aware LTCG. Add the gain portion (`outflowNominal * (1 - costBasisRatio)`) to `baseTaxInputs.realizedLTCG` (same handling as `windfallLtcgIncome` already does today).
       - `sourceAccount === 'roth'` or `'cash'`: no tax-input addition. Pure balance decrement.
     - **Add `sum(outflowNominal)` to the year's required cash need** so the closed-loop withdrawal solver pulls enough to cover spending + gift outflows in the same iteration. Tax/MAGI/IRMAA/ACA effects of these withdrawals then flow through the existing closed-loop logic correctly.
     - **After the closed loop converges**, decrement `balances[sourceAccount]` by the per-entry `outflowNominal` (the loop has already covered tax effects; this is the bookkeeping decrement). The decrement uses the same cost-basis tracking that existing withdrawals use for taxable.
     - Track per-year outflow totals in a new `outflowsForYear` field on the projection row for reporting.
     - If a `sourceAccount` balance goes negative after decrement, cascade the shortfall to `cash` then `taxable` then `pretax` and emit a warning in the projection row.
   - **Do not** modify the windfall handling block — outflows are a sibling concept that uses the same `baseTaxInputs` injection point but is otherwise independent.
   - Verification: new test file `src/scheduled-outflows.test.ts` (10 tests):
     - Cash outflow decrements cash and emits no tax event.
     - Roth outflow is tax-free, decrements Roth.
     - Pretax outflow adds ordinary income to that year's AGI (verify via tax-result `MAGI` increase relative to no-outflow baseline).
     - **Pretax outflow correctly affects ACA subsidy** in pre-Medicare years (subsidy in outflow year is materially lower than baseline year).
     - **Pretax outflow correctly affects IRMAA tier** in 65+ years (IRMAA tier may bump up).
     - Taxable outflow realizes LTCG proportional to `(1 - costBasisRatio)` and adds to `realizedLTCG`.
     - Multi-outflow year correctly aggregates tax effects (one pretax + one taxable both flow through).
     - Multi-year outflows accumulate balance changes correctly.
     - Outflow exceeding source balance cascades to fallback account with warning.
     - Outflow scheduled before currentYear is ignored; after currentYear has no current effect.

0c. [ ] **Bump engine version and document the invalidation**
   - Update `POLICY_MINER_ENGINE_VERSION` in the same module that currently defines it (search for `policy-miner-v2-2026-05-01`). Bump to `policy-miner-v3-2026-05-dwz` or similar.
   - Document in this step's `Done:` block that all existing corpora are now invalidated. The household must re-mine once (~3 min) to pick up the new engine.
   - Verification: existing test suite still passes (the new outflow path is opt-in; default behavior unchanged because `scheduledOutflows` is optional/empty in current seed-data); `npm run test:calibration` still passes (Trinity ±3pp, FICalc ±10pp).

### Phase 1: Foundation (types, utility model, schedule template)

1. [ ] **Define DwZ analyzer types**
   - New file `src/dwz/types.ts`.
   - Export: `RecipientProfile`, `RecipientStage`, `UtilityCurve`, `TerminalValueTarget` (number, today dollars), `PhasePlan`, `DwZStrategy`, `DwZOutcome`, `TournamentResult`, `AdoptionPayload`, `EvalContext`.
   - **Reuse** (do not redefine) `ScheduledOutflow` from `src/types.ts` (added in Phase 0). The DwZ analyzer's "gift events" ARE `ScheduledOutflow`s — there's no separate `GiftEvent` type.
   - Document each interface inline.
   - `RecipientStage` enum: `'launch' | 'squeeze' | 'established' | 'late_career' | 'compounding_child'`.
   - `UtilityCurve` is a per-age table of utility multipliers (e.g., `{ 30: 1.4, 35: 1.3, 45: 1.0, 60: 0.7 }`) with linear interpolation between points.
   - `EvalContext` bundles the inputs `evaluatePolicy` requires (see [src/policy-miner-eval.ts:277](src/policy-miner-eval.ts:277)): `{ assumptions: MarketAssumptions, baselineFingerprint: string, engineVersion: string, evaluatedByNodeId: string, cloner: SeedDataCloner, legacyTargetTodayDollars: number }`.
   - Verification: `npx tsc --noEmit` passes.

2. [ ] **Build utility-model module**
   - New file `src/dwz/utility-model.ts`.
   - Export `computeRecipientUtility(recipient: RecipientProfile, year: number, vehicle: ScheduledOutflow['vehicle']): number`.
   - Implement built-in curves for the two locked recipient profiles:
     - **Ethan cash curve**: peaks at ages 30-42 (the "young-family squeeze" — toddler, building career, sleep-deprived). Default values: age 30 = 1.4, age 35 = 1.35, age 42 = 1.2, age 50 = 1.0, age 60 = 0.85.
     - **Mavue 529 curve**: peaks at ages 0-5 (maximum compounding runway to college), declines steeply after age 14. Default values: age 1 = 1.5, age 5 = 1.4, age 10 = 1.2, age 15 = 0.9, age 18 = 0.6.
   - Each curve is exported as a named constant so users can override per-recipient via config.
   - Verification: new test file `src/dwz/utility-model.test.ts` (5 tests): each curve monotonic where expected, curves peak at documented ages, interpolation correct at midpoints, unknown ages clamp to nearest endpoint, custom curve override works.

3. [ ] **Build gift-schedule-builder module**
   - New file `src/dwz/gift-schedule-builder.ts`.
   - Export `buildGiftScheduleTemplate(plan: SeedData, profiles: RecipientProfile[], phasePlan: PhasePlan): ScheduledOutflow[]`.
   - **529 superfund cooldown** (critical): a `529_superfund` event in year Y elects to use 5 years of annual exclusion ratably across years Y through Y+4 (IRS Form 709 instructions, 2026). During this 5-year window, the donee cannot receive any additional `annual_exclusion_cash` gifts from the same donor without filing Form 709 and consuming lifetime exemption. The builder enforces this: after scheduling a $190K superfund (Rob + Debbie joint), no further `annual_exclusion_cash` entries to that recipient are emitted for the next 5 years. (`direct_pay_tuition_medical` does not count against the exclusion and can still be used during cooldown.)
   - Phase plan (amounts use $38K joint annual exclusion for cash, $190K joint for 529 superfunds):
     - Phase A (pre-retire, now → 2027-07-01): symbolic only ($1K Mavue 529 seed)
     - Phase B (sequence danger, 2027 → mid-2028): $5K Ethan cash; $5K Mavue 529
     - Phase C (ramp post-inheritance, mid-2028 → Debbie SS ~2030): $20K Ethan cash annual; **$190K Mavue 529 superfund #1 in 2028** — no Mavue annual gifts 2028-2032 (cooldown)
     - Phase D (full gifting, ~2031 → ~2037): up to $38K Ethan annual exclusion; **$190K Mavue 529 superfund #2 in 2033** (timed exactly when cooldown #1 expires) — no Mavue annual gifts 2033-2037 (cooldown); `direct_pay_tuition_medical` available for Mavue once she's in school (~2030+) and is unaffected by cooldown
     - Phase E (event-driven surplus, 2037+): home-sale liquidity available; Mavue cooldown #2 expires 2038 → annual exclusion resumes
   - **Limit enforcement**: builder caps face amounts at `annual_exclusion_cash`=$38K/yr/recipient and `529_superfund`=$190K/event/recipient (2026 IRS rules). When the bequest-solver's scalar would push a year above its cap, the builder either (a) shifts the surplus to a future year up to cap, or (b) tags the excess with `taxTreatment: 'requires_form_709'`. Default is (a). Shifts must respect superfund cooldown windows.
   - Output is the **template** — a per-year list of `ScheduledOutflow`s with face amounts. The bequest-solver (step 4) scales this template by a single scalar, re-applying caps and cooldowns after scaling.
   - Verification: new test file `src/dwz/gift-schedule-builder.test.ts` (12 tests):
     - Each phase boundary produces expected events.
     - Vehicle assignments correct (Ethan=cash, Mavue=529/UTMA).
     - Superfund drops appear in 2028 and 2033.
     - sourceAccount distribution follows tax-efficient ordering.
     - Total face amount sums match documented phase budgets.
     - **No `annual_exclusion_cash` events for Mavue in 2028-2032** (5-yr cooldown after superfund #1).
     - **No `annual_exclusion_cash` events for Mavue in 2033-2037** (5-yr cooldown after superfund #2).
     - `direct_pay_tuition_medical` events for Mavue are allowed during cooldown.
     - Scaling up past $38K annual exclusion either shifts to next year (default) or tags excess as `requires_form_709` (opt-in flag).
     - Scaling up past $190K superfund shifts to next available year (post-cooldown).
     - Scaling down zeroes out events cleanly.
     - Two adjacent superfunds with overlapping cooldown windows are rejected (or properly serialized to non-overlapping years).

### Phase 2: Bequest solver and tournament runner

4. [ ] **Build bequest-solver module**
   - New file `src/dwz/bequest-solver.ts`.
   - Export:
     ```ts
     async function solveScheduleScale(
       basePolicy: Policy,
       baseline: SeedData,
       template: ScheduledOutflow[],
       target: TerminalValueTarget,            // today dollars
       ctx: EvalContext,                       // see types.ts; carries assumptions, fingerprint, engineVersion, evaluatedByNodeId, cloner, legacyTargetTodayDollars
       opts?: {
         confidencePctile?: number;            // default 25
         maxIterations?: number;               // default 15
         relativeTolerance?: number;           // default 0.02
         absoluteDollarTolerance?: number;     // default 10_000 (today $); needed because relative*0 = 0 for aggressive target
         optimizationHorizonAge?: number;      // default 90 — overrides robPlanningEndAge / debbiePlanningEndAge on a cloned assumptions
         stressHorizonAge?: number;            // default 95 — runs a second eval at this horizon for stress reporting
         scaleSearchRange?: [number, number];  // default [0, 2.0]
       }
     ): Promise<{ scale: number; schedule: ScheduledOutflow[]; outcome: DwZOutcome }>
     ```
   - Bisects on a scalar multiplier in `scaleSearchRange`:
     - At scale=0: terminal value = baseline (~$1M at 25th-pctile, no gifts applied).
     - At scale=1.0: full template applied at face.
     - At scale=2.0: double the template (gift-schedule-builder re-applies vehicle caps after scaling, so practical ceiling depends on cap headroom).
   - Each iteration runs **two** `evaluatePolicy` calls: one with `assumptions` cloned to set `robPlanningEndAge = debbiePlanningEndAge = optimizationHorizonAge` (the solve run), and one at `stressHorizonAge` (the stress run). The solve run's 25th-pctile terminal value drives bisection; the stress run's value is recorded in the outcome.
   - Convergence: `Math.abs(terminal25th - target) < Math.max(relativeTolerance * target, absoluteDollarTolerance)`. The absolute floor is required because the aggressive target is $0 and any positive relative tolerance reduces to zero there.
   - Returns the converged scale, the scaled `ScheduledOutflow[]`, and the `DwZOutcome` (25/50/75 pctile terminal values at horizon 90, 25th-pctile terminal at horizon 95, total deployed in today dollars, plan success probability, per-recipient totals).
   - Verification: new test file `src/dwz/bequest-solver.test.ts` (8 tests): converges to $500K target, converges to $200K target, converges to $0 target (using absolute tolerance), handles infeasible target (target > baseline → returns scale=0), respects maxIterations, deterministic with seed, dual-horizon runs produce different terminal values (90 > 95 generally), assumptions cloner doesn't mutate input.

5. [ ] **Build tournament-runner module**
   - New file `src/dwz/tournament-runner.ts`.
   - Export:
     ```ts
     async function runTournament(
       baseline: SeedData,
       basePolicy: PolicyEvaluation,          // caller picks via bestPolicy(corpus, LEGACY_FIRST_LEXICOGRAPHIC)
       profiles: RecipientProfile[],
       ctx: EvalContext,
       targets?: TerminalValueTarget[]        // default [500_000, 200_000, 0]
     ): Promise<TournamentResult>
     ```
   - Takes the top policy directly — the caller (DwZScreen) is responsible for fetching the corpus via `loadCorpusEvaluations` from [src/policy-mining-corpus-source.ts:31](src/policy-mining-corpus-source.ts:31) and resolving the top entry via `bestPolicy` from `policy-ranker.ts`. The `useRecommendedPolicy` hook ([src/use-recommended-policy.ts:42](src/use-recommended-policy.ts:42)) returns the resolved top policy only, not the corpus array, so it is NOT suitable as a source if the caller needs the full corpus for any other purpose (it is fine if the caller only needs the top policy, which is the case here).
   - For each target, awaits `solveScheduleScale` in **parallel** via `Promise.all` (engine calls are I/O-bound when distributed; if local, parallelism still helps via async scheduling).
   - Computes cost-of-waiting deltas: for each gift in each strategy, how much would the gift "cost" the terminal value if delayed by 1, 5, or 10 years (uses real-return assumption from `ctx.assumptions` for the compounding rate).
   - Output: `TournamentResult` with one `DwZStrategy` per target, each containing:
     - `fullScheduleTemplate: ScheduledOutflow[]` — the multi-year template used as the trajectory forecast.
     - `thisYearRecommendation: { events: ScheduledOutflow[]; totalTodayDollars: number; recipientBreakdown: Record<recipient, number>; commentary: string }` — the annual-primary headline output. `events` is the per-year slice of the template filtered to `currentYear` (or 0-events if the schedule shows a skip year). `commentary` is human-readable text like *"Phase B: symbolic gifts only — sequence-danger window. Capacity rises in 2028 after inheritance + LTC policy purchase."*
     - `longHorizonCommitments: { name: string; year: number; event: ScheduledOutflow; rationale: string }[]` — discrete multi-year items the household can opt into (currently: the two 529 superfunds). Each is its own opt-in adoption.
     - `outcome` — with both horizon-90 and horizon-95 terminal values, total deployed in today dollars, per-recipient totals, cost-of-waiting matrix.
   - Verification: new test file `src/dwz/tournament-runner.test.ts` (7 tests): three strategies returned, Conservative has highest terminal-90 / lowest total deployed, Aggressive has lowest terminal-90 / highest total, horizon-95 stress values reported for each strategy, **`thisYearRecommendation` populated with events that match the schedule template's current-year slice**, **`longHorizonCommitments` lists at least the two Mavue superfunds**, snapshot test on the locked household plan.

### Phase 3: Adoption payload

6. [ ] **Build adoption-payload module**
   - New file `src/dwz/adoption-payload.ts`.
   - Three exported builders, one per adoption flow (see "Adoption is manual, annual-primary, and incremental" in Decisions):
     ```ts
     // First-time: sets the target AND this year's gifts
     function buildFirstTimeAdoptionPayload(
       tournament: TournamentResult,
       chosenTarget: TerminalValueTarget,
       currentYear: number,
     ): AdoptionPayload;

     // Annual: just this year's gifts (no goals patch — already set)
     function buildAnnualAdoptionPayload(
       tournament: TournamentResult,
       chosenTarget: TerminalValueTarget,
       currentYear: number,
     ): AdoptionPayload;

     // Long-horizon commitment: a single future-year event (e.g., superfund)
     function buildCommitmentPayload(
       commitment: { name: string; year: number; event: ScheduledOutflow; rationale: string },
     ): AdoptionPayload;
     ```
   - Common payload shape:
     ```ts
     interface AdoptionPayload {
       meta: {
         generatedAt: string;                      // ISO timestamp
         dwzVersion: string;                       // e.g. 'dwz-v1'
         flow: 'first_time' | 'annual' | 'commitment';
         sourceCorpusFingerprint: string;
         currentYear: number;
         chosenTargetTodayDollars: number;
         payloadDescription: string;               // human-readable summary, used by DwZScreen UI text, NOT inside JSON
       };
       goals?: {                                   // only present on first_time flow
         legacyTargetTodayDollars: number;
       };
       scheduledOutflows: ScheduledOutflow[];      // events to append to existing array
     }
     ```
   - Export `validateAdoptionPayload(payload: unknown): { valid: boolean, errors: string[] }` — runtime schema check the household runs before pasting. Errors include:
     - **first_time** flow: missing `goals.legacyTargetTodayDollars` (the most common mistake on first-time adoption), missing `scheduledOutflows`.
     - **annual** flow: presence of `goals` (should be absent — goals were set at first-time adoption; re-setting silently overrides which is confusing). Empty `scheduledOutflows` for the current year. Events with `year !== currentYear` (annual flow shouldn't include past or far-future events; long-horizon commitments use the `commitment` flow).
     - **commitment** flow: exactly one `ScheduledOutflow`. Event year strictly in the future.
     - Per-event validation: negative amount, unknown sourceAccount (HSA explicitly excluded), gift-exclusion overflow (cash > $38K/yr without `requires_form_709` tag), superfund stacking inside an active cooldown window.
   - Export `formatPayloadForClipboard(payload: AdoptionPayload): string` — pretty-printed **valid JSON** ready for the household to paste into `seed-data.json`. **No comments** — `seed-data.json` is imported as JSON at [src/data.ts:1](src/data.ts:1) (`import seedData from '../seed-data.json'`) and any non-JSON syntax breaks the build. Paste-target instructions (`goals.legacyTargetTodayDollars` merges into existing `goals` object; `scheduledOutflows` events append to the existing top-level `scheduledOutflows` array) live in the DwZScreen UI text adjacent to the "Copy" button, not in the payload.
   - Verification: new test file `src/dwz/adoption-payload.test.ts` (12 tests):
     - first_time builder: includes goals + this year's events; `meta.flow === 'first_time'`.
     - annual builder: no goals; only currentYear events; `meta.flow === 'annual'`.
     - commitment builder: exactly one event, future year; `meta.flow === 'commitment'`.
     - Round-trip via JSON.stringify/parse preserves shape.
     - Validator catches first-time payload missing goals.
     - Validator catches annual payload that includes goals (should be flagged).
     - Validator catches annual payload with non-currentYear events.
     - Validator catches commitment payload with past-year event.
     - Validator catches negative amounts.
     - Validator catches unknown source accounts (incl. 'hsa').
     - Validator catches $38K cash overflow without form-709 tag.
     - Validator catches superfund stacked inside an active cooldown window.

### Phase 4: UI

7. [ ] **Build DwZScreen**
   - New file `src/DwZScreen.tsx`.
   - The screen has **three sections**, in descending order of prominence on the page (annual-primary cadence — see Decisions):

   **Section 1: "This Year" (headline tile — annual recommendation)**
   - Big number at the top: *"This year (2026), your gift capacity is $X"* under the Moderate target (or whichever target is selected).
   - Recipient breakdown: *"$A → Ethan (cash) / $B → Mavue (529)"* with brief commentary explaining the phase (*"Phase A: pre-retirement, symbolic only — capacity rises in 2028 after inheritance + LTC policy"*).
   - Strategy selector: tabs or pills for Conservative / Moderate / Aggressive — switching updates the "this year" number.
   - Action: **"Copy this year's gift payload"** button → writes the `annual` (or `first_time`, if this is the first adoption) payload to clipboard via `navigator.clipboard.writeText`. Adjacent UI text gives paste-target instructions (which top-level field in `seed-data.json` receives each section).
   - "Skip this year" affordance: explicit, with a "your trajectory drifts by $X" estimate if skipped.

   **Section 2: "Long-horizon commitments" (multi-year opt-ins)**
   - For each `longHorizonCommitments` entry from the tournament (currently: Mavue 529 superfund #1 in 2028, Mavue 529 superfund #2 in 2033):
     - Show name, year, amount, rationale, and the implied cooldown (*"Blocks Mavue annual exclusion 2028-2032 per IRS Form 709 election"*).
     - **"Commit to this milestone"** button → writes the `commitment` payload to clipboard.
   - These commitments are visible regardless of strategy and are presented as discrete opt-in decisions, not automatic.

   **Section 3: "Trajectory" (multi-year forecast, secondary)**
   - Three columns (Conservative / Moderate / Aggressive), each showing:
     - Target terminal value at age 90 (25th pctile, today $)
     - Total deployed across the full plan (today $)
     - 25th-pctile terminal value at age 95 (stress signal)
     - Plan success probability
     - Per-recipient totals (Ethan / Mavue)
     - Collapsible per-year schedule table
   - Cost-of-waiting chart below: each gift plotted by "now vs. delay" cost (compounding cost per year of delay).
   - This section is the forecast — what the trajectory looks like if the household continues at the recommended pace. It is **not** a commitment.

   - Empty state: if corpus doesn't exist, show "DwZ analysis requires a mined corpus. Run a mine first →" with CTA routing to Mining screen.
   - Stale state: if corpus fingerprint doesn't match current plan, show "Corpus is stale — recommendations may be outdated. Re-mine →".
   - Verification: manual browser check on the locked household plan; capture screenshots of all three sections.

8. [ ] **Wire DwZ navigation**
   - Edit `src/types.ts`: extend `ScreenId` union to include `'dwz'`. This is the second additive types edit (first was `ScheduledOutflow` in Phase 0).
   - Edit `src/App.tsx` at [src/App.tsx:744](src/App.tsx:744): add `'dwz'` to the `REACHABLE_SCREENS` array. Without this, the existing redirect-to-cockpit effect at [src/App.tsx:752](src/App.tsx:752) bounces any user who lands on the DwZ screen straight back.
   - Add a screen case to the main screen-switch logic that renders `DwZScreen`.
   - Add a nav entry to the existing sidebar/header navigation, matching the pattern for `mining` or `cockpit`.
   - Verification: clicking the nav entry loads `DwZScreen`; the redirect effect does NOT bounce; back-navigation works; no regression on existing screens (manual smoke test of Cockpit, Mining, AssumptionPanel).

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
    - The engine WAS edited in Phase 0 (additive `scheduledOutflows` handling and version bump), so this check is genuinely meaningful: it verifies that the default code path — exercised when `data.scheduledOutflows` is absent or empty, which is the case for the calibration scenarios — is byte-equivalent to pre-Phase-0 behavior. A drift here would indicate the additive branch accidentally changed shared state (e.g., mutating `baseTaxInputs` even when no outflows exist).
    - Also run the existing engine regression tests (`spend-solver`, `decision-engine`, `planning-export`, etc.) and confirm no value drift beyond noise. If the 6 known-drifting tests from `MINER_REFACTOR_WORKPLAN.md` step 3 are still drifting, that's pre-existing carryover; if any new tests start drifting, that points to a Phase 0 regression.
    - Verification: test report attached to the step's `Done:` block with before/after numbers for Trinity, FICalc, and the engine regression set.

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

### Resolved during v2 review (2026-05-10)

- ~~`scheduledGenerosity` schema placement~~ → **Resolved.** Top-level `scheduledOutflows` field on `SeedData`. Cannot nest under `income.windfalls` because the engine clamps windfall amounts to nonnegative at [src/utils.ts:1445](src/utils.ts:1445).
- ~~Side-car bypasses the ranker~~ → **Resolved.** Adoption payload now includes a `goals.legacyTargetTodayDollars` patch that lowers the ranker's gate to the chosen target. Without this, the corpus would fail GATE 1 after adoption.
- ~~$0 target tolerance~~ → **Resolved.** Convergence criterion uses `max(relativeTolerance × target, absoluteDollarTolerance)`. Defaults: 2% relative, $10K absolute. The absolute floor lets the bisection terminate cleanly for the aggressive target.
- ~~Solver async signatures~~ → **Resolved.** `solveScheduleScale` and `runTournament` are `async`, take an `EvalContext` carrying the six inputs `evaluatePolicy` requires.
- ~~Age-90 / age-95 dual horizon~~ → **Resolved.** Solve run clones `assumptions` with `robPlanningEndAge = debbiePlanningEndAge = 90` override. Stress run uses default (95). Two evaluations per bisection iteration.
- ~~Navigation breaks the "no types.ts edits" lock~~ → **Resolved.** The lock was relaxed to "additive types edits only": `ScheduledOutflow` (Phase 0) and `ScreenId += 'dwz'` (Phase 4). `App.tsx:744` REACHABLE_SCREENS gets a one-line addition for the same reason.
- ~~Today vs nominal dollars~~ → **Resolved.** All terminal-value targets and dollar amounts in this workplan are **today dollars**. Matches existing policy summary convention (`annualSpendTodayDollars`, `p50EndingWealthTodayDollars`).
- ~~Gift-tax limit mis-handling~~ → **Resolved.** Schedule builder enforces $38K joint annual exclusion and $190K joint superfund caps per IRS 2026. Scaled gifts above caps either shift to subsequent years (default) or tag as `requires_form_709` (opt-in). Adoption-payload validator catches violations.

### Still open

- **Bequest solver convergence under thin paths.** The 25th-percentile terminal value can be noisy with 2000 trials. If solves don't converge cleanly within 15 iterations, options are: increase to 5000 trials per solve (slower), widen relative tolerance to 5% (less precise), increase absolute dollar tolerance to $25K (looser bound on $0 target), or switch from bisection to a coarse-then-fine grid (different convergence profile). Defer to Phase 2 implementation; profile during step 4 verification.

- **Utility model is opinionated.** The stage multipliers represent judgment calls about when money matters most to recipients. The defaults capture the household's discussion but should be exposed as configurable so they can be adjusted as life situations change (e.g., if Ethan's child reaches school age and the squeeze stage shifts).

- **Mavue's CRBA / SSN status.** Strongly believed to be a US citizen with SSN given USAF father, but blocking for 529 funding until confirmed. Side-car models assuming yes, but flags the assumption in the UI so the household can confirm with Reese before any adoption.

- **Engine "as library" coupling.** Importing `evaluatePolicy` and `buildPathResults` couples the side-car to those signatures. If the miner refactor changes them, the side-car needs to follow. Acceptable — the alternative (duplicating the engine path) is worse.

- **Adoption payload pasting is manual.** Risk the household pastes the `scheduledOutflows` portion but forgets the `goals.legacyTargetTodayDollars` patch — corpus then fails GATE 1 and cockpit shows the "no feasible policy" state. Mitigations: validator function explicitly requires both sections (step 6), DwZScreen instructions name both paste targets, clipboard formatter prefixes JSON with a comment listing the two targets.

- **LTC and term life remain external.** These interact with gift capacity but are not modeled in the side-car. The household configures them via separate decisions (broker quotes, Term4Sale) and updates `seed-data.json` separately. The side-car re-runs naturally against the updated plan.

- **Tournament runtime.** Each `solveScheduleScale` requires up to 15 bisection iterations × 2 horizon runs × 2000 trials = 60K trials per target. Three targets × 60K = 180K trials per tournament. At engine speed this is ~1-2 minutes total. Acceptable but noticeable — show a loading state in DwZScreen with the per-target progress.

- **Phase 0 engine version bump invalidates the existing corpus.** The household will see a re-mine prompt on the cockpit immediately after Phase 0 ships, even before any DwZ analysis runs. Acceptable per the "hard gate" decision in `MINER_REFACTOR_WORKPLAN.md`, but worth communicating in the release note.

- **Annual-cadence review can be forgotten.** Under v4's annual-primary model, gifts don't happen unless the household opens DwZScreen and adopts each year's recommendation. If they forget a year, the trajectory slips below the chosen pace and the terminal target may overshoot. Mitigations: (a) the cockpit shows a small "DwZ recommendation pending for $YEAR" tile each calendar year as a passive nudge; (b) the DwZScreen "this year" payload includes the schedule template's default amount, so confirming is one click; (c) past-year drift is reported on DwZScreen as a "you're $X behind pace" line so the household sees the gap and can make it up in subsequent years (subject to annual exclusion caps).

- **First-time vs. annual payload confusion.** The household needs to know whether they're on a first-time adoption (include goals) or annual (don't). Mitigations: DwZScreen detects whether `seed-data.json` already has a non-default `goals.legacyTargetTodayDollars` and routes the "Copy" button to the correct builder automatically. The validator also catches mistakes — pasting an annual payload as first-time will fail the missing-goals check; pasting a first-time payload as annual will fail the extra-goals check.

## Ready to start

Phase 0 (engine outflow capability) is the right entry point. The DwZ analyzer modules in Phase 1+ depend on the new `ScheduledOutflow` type and the engine being able to simulate it. Inside Phase 0, step 0a (schema definition) is read-only against the engine and unblocks 0b. Begin at 0a.
