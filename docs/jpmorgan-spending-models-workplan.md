# J.P. Morgan Spending Models Workplan

Updated: May 12, 2026

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

## Goal

Turn J.P. Morgan's retiree-spending research into a first-class spending-model
comparison workflow without silently changing the Cockpit headline.

The product idea:

```text
Population spending curve
  + household modifiers
  -> deterministic yearly spending schedules
  -> side-by-side Monte Carlo comparison
  -> optional later Mine robustness pass
```

The model should answer: "If the generic retiree spending curve is true enough,
how does our plan change once we apply our real-life modifiers?"

## Source Material

- Local research PDF:
  `docs/research/jpmorgan-three-new-spending-surprises-2025.pdf`
- Local application note:
  `docs/research/jpmorgan-spending-surprises-application.md`
- Public landing page:
  `https://am.jpmorgan.com/us/en/asset-management/adv/insights/retirement-insights/three-spending-surprises/`
- Current Guide to Retirement spending curve:
  `https://am.jpmorgan.com/content/dam/jpm-am-aem/global/en/insights/retirement-insights/guide-to-retirement-us.pdf`

The public data is aggregate, so J.P. Morgan-derived models are
`reconstructed` unless every modifier and coefficient is explicitly supplied by
the user.

## Product Decisions

1. Spending models live as modifiers inside the existing Re-run Model workflow,
   not as a new tab.
- Reason: this is an assumption-modeling layer that should sit beside Mine,
  not become a separate destination.

2. Mine remains unchanged by default.
- Reason: running every policy across every spending model can multiply
  compute. The first release should only run these models when the household
  explicitly clicks `Run Spending Models`.

3. Mine robustness comes later as an optional finalist pass.
- Full Mine finds candidates on the selected spending model.
- A later robust mode re-runs only top policies across selected spending
  models.
- Target runtime impact for robust mode: roughly +15-40%, not 4-5x.

4. Travel must not be double-counted.
- Current faithful mode keeps `travelEarlyRetirementAnnual` for
  `travelPhaseYears`.
- J.P. Morgan replacement mode treats normal go-go travel as already captured
  in the population curve, so current travel is part of the age-65 curve anchor
  rather than a separate overlay.
- Extra travel overlay mode is only for known trips above the population curve.

5. Housing, healthcare, and LTC stay explicit.
- Paid-off-home costs do not fade with age by default.
- ACA, Medicare, HSA, and LTC remain in the engine's dedicated models rather
  than being buried in generic spending.

6. The J.P. Morgan curve is age-based, not retirement-year-based.
- Default curve onset: household average age 65.
- Years before age 65 keep the current real spending baseline unless another
  explicit modifier applies.
- Default age basis: average of the two adults. Advanced settings can switch to
  older adult, younger adult, Rob, or Debbie.

7. Extra travel overlay requires an explicit user amount.
- Do not default it to today's `travelEarlyRetirementAnnual`.
- Show the current 10-year travel value as a reference, but require a deliberate
  amount and year count before adding it on top of the J.P. Morgan curve.

8. Early and age-75 volatility are separate result rows.
- J.P. Morgan identifies volatility around retirement and continuing volatility
  among retirees age 75-80.
- These answer different risks: early sequence risk vs. later-life liquidity
  risk.
- The UI can group them under one `Volatility` control, but the model outputs
  should remain separate.

9. The comparison runs both engine distribution modes.
- Forward-looking parametric remains the primary reading.
- Historical-precedent bootstrap appears as the secondary reading, matching the
  Cockpit dual-view pattern.
- This doubles the spending-model panel runtime, but only after the user clicks
  `Run Spending Models`; Mine remains unchanged by default.

10. The retirement surge is a conditional stress, not a default household model.
- The 2025 J.P. Morgan update says the surge is concentrated in partially
  retired and lower-income cohorts, and disappears above $150,000 of
  pre-retirement income.
- For this household, keep `J.P. Morgan + Early Surge` available as a stress
  row, but do not select it by default unless a partial-retirement modifier is
  turned on or the user explicitly chooses it.

11. Phase 1 always runs both simulation modes.
- `simulationModes` is not a household modifier in phase 1.
- The runner always executes forward-looking parametric and
  historical-precedent bootstrap for every selected preset.
- A later performance setting can reduce modes, but that belongs in runner
  options, not in the household spending model.

12. Baseline modifiers and preset adjustments are separate.
- Baseline modifiers describe the household: age basis, curve start age,
  protected fixed costs, healthcare separation, partial retirement, and any
  explicit extra-travel amount.
- Presets describe the comparison row: current faithful plan, J.P. Morgan
  curve, early surge, early volatility, age-75 volatility.
- A selected volatility preset owns exactly one shock. Selecting both early and
  age-75 volatility produces two result rows, not one modifier with two shocks.

13. Warnings live in the model result.
- Adapter and runner outputs include advisory/blocking warnings.
- Double-counting travel is a blocking warning when a J.P. Morgan curve model
  tries to keep the current explicit travel overlay without marking it as extra
  travel.
- The UI disables invalid actions where possible and still displays warnings
  from the result object.
- Runner warning merge order: schedule/adapter warnings first, then mode-level
  runner warnings such as `mode_failed`.
- The runner never filters adapter warnings. Blocking adapter warnings skip
  simulation for that preset row; non-blocking warnings travel through.

14. Assumption provenance is field-level.
- The flat `inferredAssumptions` list remains for readable UI.
- The result also carries `assumptionSources` so each defaulted, user-supplied,
  or inferred field can be audited.
- Provenance lives only in `assumptionSources`; adjustment objects do not carry
  their own source/origin fields.

15. Saved results must be self-describing.
- Store source version, source paths, plan fingerprint, assumptions version,
  simulation seed, engine version, generated timestamp, currency, and value
  basis with every run result.
- This lets saved comparisons become stale gracefully after a model or engine
  update.

16. Model completeness remains binary for phase 1.
- `faithful` means the model uses only explicitly supplied household inputs and
  existing engine behavior.
- `reconstructed` means any population curve, inferred default, or J.P. Morgan
  coefficient is used.
- User-supplied extra travel can be faithful as a modifier, but the surrounding
  J.P. Morgan curve row is still reconstructed; field-level provenance explains
  the nuance.

## Core Vocabulary

```ts
type SpendingModelPresetId =
  | 'current_faithful'
  | 'jpmorgan_curve_travel_included'
  | 'jpmorgan_curve_extra_travel_overlay'
  | 'jpmorgan_curve_early_surge'
  | 'jpmorgan_curve_early_volatility'
  | 'jpmorgan_curve_age75_volatility';

type TravelTreatment =
  | 'current_explicit_overlay'
  | 'included_in_jpmorgan_curve'
  | 'extra_overlay_above_curve';

type SpendingModelSimulationMode =
  | 'forward_parametric'
  | 'historical_precedent';

const SPENDING_MODEL_SIMULATION_MODES: SpendingModelSimulationMode[] = [
  'forward_parametric',
  'historical_precedent',
];

type HouseholdAgeBasis =
  | 'average_adult'
  | 'older_adult'
  | 'younger_adult'
  | 'rob'
  | 'debbie';

type AssumptionSourceKind =
  | 'user'
  | 'seed'
  | 'default'
  | 'inferred'
  | 'source_research';

interface AssumptionSource {
  source: AssumptionSourceKind;
  explanation: string;
  evidence?: string;
}

interface HouseholdSpendingModifiers {
  travelTreatment: TravelTreatment;
  householdAgeBasis: HouseholdAgeBasis;
  curveStartAge: number;
  preCurveSpendingBehavior: 'source_age_curve' | 'current_real_baseline';
  extraTravelOverlayAnnual?: number;
  extraTravelOverlayYears?: number;
  protectHousingFixedCosts: boolean;
  keepHealthcareSeparate: boolean;
  partialRetirementTransition: boolean;
}

type SpendingModelAssumptionKey =
  | keyof HouseholdSpendingModifiers
  | 'nonHealthcareInflationGap'
  | 'preset'
  | 'spendingCurveControlPoints'
  | 'spendingSmileEquation'
  | 'extraTravelOverlay'
  | 'transitionSurge'
  | 'temporarySpendingShock';

type SpendingModelAssumptionSources = Partial<
  Record<SpendingModelAssumptionKey, AssumptionSource>
>;

type SpendingModelAdjustment =
  | {
      kind: 'extra_travel_overlay';
      annualAmount: number;
      years: number;
    }
  | {
      kind: 'transition_surge';
      percent: number;
      years: number;
      start: 'retirement';
      enabledBecause: 'user_selected' | 'partial_retirement_transition';
    }
  | {
      kind: 'temporary_spending_shock';
      shockId: 'early_volatility' | 'age75_volatility';
      percent: number;
      years: number;
      start: 'retirement' | 'age75';
    };

interface SpendingModelPresetDefinition {
  id: SpendingModelPresetId;
  label: string;
  travelTreatment: TravelTreatment;
  adjustments: SpendingModelAdjustment[];
  defaultSelected: boolean;
}

function resolveHouseholdSpendingModifiers(
  partial?: Partial<HouseholdSpendingModifiers>,
): {
  modifiers: HouseholdSpendingModifiers;
  assumptionSources: SpendingModelAssumptionSources;
};

function buildSpendingModelPresetDefinition(
  presetId: SpendingModelPresetId,
  modifiers: HouseholdSpendingModifiers,
): SpendingModelPresetDefinition;
```

## Initial Model Set

1. **Current Plan**
- Uses the current seed exactly.
- Keeps explicit 10-year travel.
- `modelCompleteness: faithful`.

2. **J.P. Morgan Curve, Travel Included**
- Moves normal `travelEarlyRetirementAnnual` into the curve-subject age-65
  anchor.
- Applies the age-shaped curve to non-fixed lifestyle spending.
- Keeps taxes/insurance protected.
- `modelCompleteness: reconstructed`.

3. **J.P. Morgan Curve + Extra Travel Overlay**
- Uses the J.P. Morgan curve as baseline.
- Adds explicit extra travel for known above-normal travel intent.
- The extra overlay is a faithful user modifier if the user supplies amount and
  years.

4. **J.P. Morgan Curve + Early Surge**
- Adds a temporary retirement-transition spending bump.
- Default stress: +30% for 3 years unless overridden.
- Default selection: off for this household unless partial retirement is
  explicitly modeled.
- Mark default as inferred/reconstructed.

5. **J.P. Morgan Curve + Early Volatility**
- Adds deterministic +20% spending shock for 1-2 years near retirement.
- Focus: sequence-of-return risk from unexpectedly high early withdrawals.
- Mark default as inferred/reconstructed.

6. **J.P. Morgan Curve + Age-75 Volatility**
- Adds deterministic +20% spending shock for 1-2 years starting at age 75.
- Focus: later-life liquidity needs before most modeled LTC events begin.
- Mark default as inferred/reconstructed.

## Data Contract

Each model run should store structured input, output, and intermediate
calculation data.

```ts
interface SpendingModelRunResult {
  id: SpendingModelPresetId;
  label: string;
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  modelCompleteness: 'faithful' | 'reconstructed';
  inferredAssumptions: string[];
  assumptionSources: SpendingModelAssumptionSources;
  warnings: Array<{
    code:
      | 'travel_double_count'
      | 'extra_travel_missing'
      | 'surge_not_applicable'
      | 'mode_failed'
      | 'stale_source';
    severity: 'info' | 'warning' | 'blocking';
    message: string;
    relatedFields: string[];
  }>;
  provenance: {
    generatedAtIso: string;
    sourceVersion: 'jpmorgan-2026-guide-plus-blanchett-smile-2025-spending-surprises';
    curveSourceVersion: 'jpmorgan-2026-guide-to-retirement-changes-in-spending';
    smileSourceVersion: 'blanchett-2014-retirement-spending-smile';
    sourceUrl: string;
    secondarySourceUrl: string;
    smileSourceUrl: string;
    localSourcePath: string;
    planFingerprint: string;
    assumptionsVersion: string;
    engineVersion: string;
    simulationSeed: number;
    currency: 'USD';
    valueBasis: 'today_dollars';
  };
  modifiers: HouseholdSpendingModifiers;
  preset: SpendingModelPresetDefinition;
  annualSpendScheduleByYear: Record<number, number>;
  yearlySchedule: Array<{
    year: number;
    householdAge: number;
    currentPlanBaselineAnnualSpend: number;
    modelBaselineAnnualSpend: number;
    jpmorganCurveAnnualSpend: number;
    finalAnnualSpend: number;
    curveMultiplier: number;
    protectedFixedCosts: number;
    travelOverlay: number;
    surgeAdjustment: number;
    volatilityAdjustment: number;
  }>;
  simulation: {
    byMode: Record<SpendingModelSimulationMode, {
      status: 'complete' | 'failed';
      errorMessage?: string;
      successRate: number | null;
      medianEndingWealth: number | null;
      p10EndingWealth: number | null;
      p90EndingWealth: number | null;
      first10YearFailureRisk: number | null;
      age80AnnualSpend: number | null;
      age95AnnualSpend: number | null;
    }>;
  };
}
```

Field notes:

- `currentPlanBaselineAnnualSpend` is the existing plan's yearly spend before
  J.P. Morgan changes.
- `modelBaselineAnnualSpend` is the selected model's pre-shock baseline after
  travel treatment and protected fixed-cost rules.
- `jpmorganCurveAnnualSpend` is the curve-shaped amount before preset-specific
  surge or volatility adjustments.
- `finalAnnualSpend` is the value passed into `annualSpendScheduleByYear`.
- `first10YearFailureRisk` is the share of Monte Carlo trials that fail within
  years 1-10 of the simulation horizon.
- `age80AnnualSpend` / `age95AnnualSpend` are `null` when the modeled timeline
  has no year at or after that household age.

## Implementation Plan

1. [x] Capture research source locally
- Saved the 2025 J.P. Morgan PDF under `docs/research/`.
- Added the initial application note.

2. [x] Add first deterministic schedule adapter
- File: `src/jpmorgan-spending-surprises.ts`
- Produces `annualSpendScheduleByYear`, model-completeness metadata, inferred
  assumptions, and yearly intermediate calculations.

3. [x] Add adapter tests
- File: `src/jpmorgan-spending-surprises.test.ts`
- Covers schedule construction, surge sensitivity, scenario set generation, and
  existing Monte Carlo `annualSpendScheduleByYear` wiring.

4. [x] Tighten travel-treatment semantics
- Add explicit `travelTreatment`.
- Ensure `included_in_jpmorgan_curve` removes the separate 10-year travel
  overlay rather than layering it into the curve.
- Ensure `extra_overlay_above_curve` adds only the user-specified extra travel
  amount.
- Disable the `J.P. Morgan + Extra Travel` checkbox until
  `extraTravelOverlayAnnual > 0` and `extraTravelOverlayYears > 0`.
- Return a blocking `travel_double_count` warning if a caller tries to run a
  J.P. Morgan curve row with `current_explicit_overlay`.
- Return a blocking `extra_travel_missing` warning if the extra-travel preset is
  selected without an explicit amount and year count.

5. [x] Add spending-model runner
- File: `src/spending-model-runner.ts`
- Input: seed data, assumptions, selected preset definitions, baseline
  modifiers.
- Output: `SpendingModelRunResult[]`.
- Run each model through both distribution modes:
  - forward-looking parametric: existing assumptions, `useHistoricalBootstrap:
    false`
  - historical-precedent: same assumptions with `useHistoricalBootstrap: true`
- Call `buildPathResults(..., { pathMode: 'selected_only',
  annualSpendScheduleByYear })` for each mode.
- Keep deterministic seeds unchanged.
- Partial failure behavior:
  - if one mode fails, preserve the other mode's result and mark the preset
    `partial`
  - if both modes fail, return the preset row as `failed`
  - if validation warnings are blocking, skip simulation and mark the row
    `skipped`
- Failure isolation:
  - wrap each preset row independently so later presets still run after one row
    fails
  - wrap each mode independently so forward/historical failures are isolated
- Execution shape:
  - implement the runner as a pure, serializable function with no UI closures
  - step 5 can run in-process for tests and scripts
  - UI delivery should call the same function through a worker if local default
    panel runtime approaches the 60-second budget

6. [ ] Add cache/fingerprint support
- New cache candidate: `src/spending-model-cache.ts`
- Fingerprint should include seed data, assumptions, preset id, modifiers,
  selected stressors/responses if used, engine version, and simulation seed.
- Browser storage: IndexedDB, consistent with the existing plan/spend caches.
- Scope: current household/workspace only.
- Eviction: keep the 50 most recent successful fingerprints, plus a 7-day TTL.
- Fallback: in-memory cache if IndexedDB is unavailable.
- Cache misses must be silent and safe; stale hits must surface a `stale_source`
  warning if source version or engine version changed.

7. [x] Add UI controls in Re-run Model
- Added a compact panel titled `Run spending models` to `src/MiningScreen.tsx`.
- Controls:
  - preset checkboxes
  - current faithful and J.P. Morgan travel-included rows always selected
  - extra travel amount/years when overlay is selected
  - partial-retirement toggle for surge relevance
  - early and age-75 volatility toggles for stress models
- The panel runs both forward-looking and historical-precedent modes.
- Keep the main Cockpit headline unchanged.

8. [x] Add comparison table
- Columns:
  - Model
  - Completeness
  - Forward solvency
  - Historical solvency
  - Forward median EW
  - Historical median EW
  - P10 EW
  - First 10-year failure risk
  - Age 80 spend
  - Key assumption
- Rows should show deltas against Current Plan.
- Each reconstructed row should expose inferred assumptions.

8a. [x] Add Mine basis bridge
- Add a `Mine basis` selector after `Run spending models`.
- Current faithful keeps the existing constant-real policy spend behavior.
- J.P. Morgan-derived choices become per-policy schedule multipliers, so each
  mined candidate's `annualSpendTodayDollars` is shaped year by year by the
  selected curve.
- Include the selected basis in the mining corpus fingerprint so current and
  J.P. Morgan mines cannot mix.
- Thread the selected basis through browser/cluster miner session config,
  worker priming, determinism checks, and policy evaluation.

9. [ ] Add "Adopt As Active Spending Model" later, not first
- First release is comparison-only.
- Later adoption should update an explicit plan setting, not mutate raw spending
  buckets silently.
- Adoption must create a snapshot/prediction record so behavior changes are
  auditable.
- Future adoption snapshot shape:
  - adopted preset id and label
  - baseline modifiers
  - annual spend schedule by year
  - assumption sources
  - model completeness
  - provenance fields
  - before/after headline metrics

10. [ ] Mine integration, phase 2
- Add optional toggle: `Stress finalist policies across spending models`.
- Default off.
- Only evaluate top finalist policies, not the full policy search space.
- Output robustness metrics:
  - minimum solvency across selected spending models
  - worst-case median ending wealth
  - policy rank stability
  - models where the policy fails household guardrails
- New type candidate: `SpendingModelRobustnessReport`, stored with Mine output
  rather than embedded inside `SpendingModelRunResult`.
- Phase 1 runner should expose enough structured data for this report but does
  not need to reserve Mine-specific fields.

## UI Sketch

```text
Run Spending Models

[x] Current Plan
[x] J.P. Morgan Curve, Travel Included
[ ] J.P. Morgan + Extra Travel
[ ] J.P. Morgan + Early Surge
[x] J.P. Morgan + Early Volatility
[x] J.P. Morgan + Age-75 Volatility

Travel treatment:
[ Current explicit 10-year travel ] [ Included in J.P. Morgan curve ] [ Extra overlay ]

Extra travel overlay:
Amount: [ $0 ]  Years: [ 0 ]  Reference: current 10-year travel budget

Surge:
[ ] Partial retirement / income overlap applies

[ Run Spending Models ]

Model                                Fwd Solv.   Hist Solv.   Fwd EW    Hist EW   Age 80 Spend
Current Plan                         85.2%       ~96%         $2.48M    ...
J.P. Morgan Curve                    ...
J.P. Morgan + Extra Travel           ...
J.P. Morgan + Early Surge            ...
J.P. Morgan + Early Volatility       ...
J.P. Morgan + Age-75 Volatility      ...
```

## Testing Plan

Focused tests:

- Adapter schedule math:
  - flat current model is faithful
  - J.P. Morgan model is reconstructed
  - travel-included mode removes explicit travel overlay
  - extra-overlay mode adds only the overlay
  - fixed housing costs remain protected
  - surge and volatility are explicit adjustments
  - curve multipliers at ages 65, 70, 80, and 90 match the documented
    one-percentage-point lower retiree-spending inflation rule
  - early volatility starts in the retirement year
  - age-75 volatility starts in the first modeled year where household age is
    at least 75, under each supported household age basis
  - double-count travel validation returns a blocking warning
  - extra-travel preset with zero amount or zero years returns a blocking
    warning and does not run

- Runner tests:
  - deterministic outputs for same seed
  - all presets return structured intermediate calculations
  - no selected presets returns an empty result safely
  - current faithful run matches baseline engine result within rounding
  - forward-looking and historical-precedent modes both run from the same
    schedule
  - forward-looking and historical mode calls receive the exact same
    `annualSpendScheduleByYear` object contents
  - a one-mode failure returns a partial result instead of dropping the whole
    preset
  - both-mode failure returns a failed row with errors preserved
  - `current_faithful` produces the same metrics as the existing engine path
    within rounding

- UI/store tests:
  - clicking run sets loading state and stores results
  - changing modifiers invalidates stale results
  - inferred assumptions are visible for reconstructed rows
  - field-level assumption sources are visible in the assumption drilldown
  - extra-travel checkbox is disabled until amount and years are positive

Cache tests:

- identical inputs generate stable fingerprints
- changing any modifier, preset id, source version, assumptions version, engine
  version, or simulation seed changes the fingerprint
- stale source or engine version invalidates persisted results safely

Regression:

```sh
npm test -- src/jpmorgan-spending-surprises.test.ts
npm test -- src/spending-model-runner.test.ts
npx tsc -p tsconfig.app.json --noEmit
npm run test:calibration
```

For UI work, also run the local app and verify the panel in Browser with a
desktop-width screenshot.

## Acceptance Criteria

- The Cockpit headline remains based on the current faithful plan.
- The spending-model panel runs only on explicit user action.
- Travel is not double-counted.
- Every model output has `modelCompleteness`.
- Every inferred/default J.P. Morgan assumption is surfaced in both the result
  object and UI assumption drilldown.
- Every defaulted or user-supplied modifier has a field-level
  `assumptionSources` entry.
- Outputs include yearly schedules and intermediate calculations.
- Results are deterministic under the same engine simulation seed.
- Forward-looking and historical-precedent readings both use
  `assumptions.simulationSeed`; the only distribution-mode difference is
  `useHistoricalBootstrap`.
- Results include forward-looking and historical-precedent readings.
- Zero selected presets returns an empty successful runner result with no
  simulation calls.
- Partial mode failures preserve successful mode outputs and surface errors.
- Blocking validation warnings skip only the invalid preset row.
- Calibration tests still pass in both parametric and historical modes.
- Default selected panel run should complete within an agreed local budget
  target of 60 seconds on the current Mac, or move execution to a worker before
  UI delivery.
- Later Mine robustness mode should stay within the +15-40% runtime target by
  evaluating finalists only.

## Resolved Questions

- The default J.P. Morgan curve starts at household average age 65. It is not
  anchored to retirement year.
- The default J.P. Morgan curve uses current Guide to Retirement age-bucket
  values normalized to age 65 rather than an exponential one-point inflation
  gap. The one-point lower non-healthcare inflation assumption remains an
  explicit sensitivity layer.
- Extra travel overlay requires an explicit user amount and year count. Today's
  `travelEarlyRetirementAnnual` is displayed as a reference only.
- Age-75 volatility is separate from early-retirement volatility in results,
  even if the UI groups them under one `Volatility` control.
- The panel runs both forward-looking and historical-precedent modes after the
  user clicks `Run Spending Models`.
- Early surge is available as a stress row, but it is not selected by default
  for this household unless partial retirement or income overlap is explicitly
  modeled.
- `simulationModes` is fixed for phase 1 and does not live in
  `HouseholdSpendingModifiers`.
- Multiple volatility shocks do not coexist in one modifier set; each volatility
  preset produces its own row with one shock.
- Warnings live on `SpendingModelRunResult` with `info`, `warning`, or
  `blocking` severity.
- Extra-travel preset selection is disabled until amount and years are positive;
  programmatic invalid calls return a blocking warning and a skipped row.
- `transitionSurgePercent` is ignored unless the early-surge preset is selected;
  `partialRetirementTransition` controls default selection/relevance, not the
  math by itself.

## Implementation Notes

- Avoid editing current seed spending values in-place for comparison runs.
- Prefer schedule overrides through `annualSpendScheduleByYear`.
- Keep all values in today's dollars before the engine applies inflation.
- Store the yearly schedule beside simulation results for explainability.
- Do not add spending-model variants to Mine's full search loop until the
  finalist-only robust pass exists.
- Export defaults/constants from the implementation rather than hiding them in
  component logic:
  - `JPMORGAN_SPENDING_SOURCE_VERSION`
  - `JPMORGAN_SPENDING_CURVE_SOURCE_VERSION`
  - `JPMORGAN_SPENDING_CURVE_POINTS`
  - `JPMORGAN_DEFAULT_CURVE_START_AGE`
  - `JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP`
  - `SPENDING_MODEL_SIMULATION_MODES`
- Store money as USD today's dollars in the contract until/unless the app adds
  multi-currency support.
