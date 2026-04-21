# Phase Action Playbook Workplan

Updated: April 20, 2026

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

## 10-Minute Execution Blocks

1. [x] Define phase-action data contracts
- Added typed phase/action/trade/sensitivity/model-completeness interfaces.
- Files: `src/flight-path-action-playbook.ts`

2. [x] Build phase segmentation and holdings math
- Added timeline phase boundaries and fund/account rollups for exact trade instructions.
- Files: `src/flight-path-action-playbook.ts`

3. [x] Add deterministic impact + sensitivity evaluation
- Added seeded base/adverse/benign evaluation and consistency scoring.
- Files: `src/flight-path-action-playbook.ts`

4. [x] Integrate dropdown UI in flight path
- Added “Phase Action Playbook (MVP)” dropdowns to timeline section.
- Files: `src/UnifiedPlanScreen.tsx`

5. [x] Add deterministic tests + build verification
- Added focused test suite for playbook generation and determinism.
- Files: `src/flight-path-action-playbook.test.ts`
- Verification: `npm test -- flight-path-action-playbook.test.ts`, `npm run build`

6. [x] Add ranked alternatives per phase
- Generate multiple action variants per phase and score/rank top recommendation vs backups.
- Files in progress: `src/flight-path-action-playbook.ts`, `src/UnifiedPlanScreen.tsx`, `src/flight-path-action-playbook.test.ts`

7. [x] Add “top recommendation” + “alternative” UI labels
- Surface rank score and ordering in each phase dropdown.

8. [x] Expand tests for ranking determinism
- Validate stable rank ordering for same seed/input.

9. [x] Polish copy and reduce noisy inferred-assumption repetition
- Keep assumption transparency while improving readability.

10. [x] Final regression/build pass
- Run targeted tests and build, then summarize.

11. [x] Add apply-trade-set workflow
- Added per-action `Apply Trade Set To Draft` button in phase dropdown cards.
- Wired to store-level draft allocation/holding updates and stale-analysis notice.
- Files: `src/UnifiedPlanScreen.tsx`, `src/store.ts`, `src/store.test.ts`
- Verification: `npm test -- store.test.ts flight-path-action-playbook.test.ts`, `npm run build`

12. [x] Add auto-refresh, undo, and saved scenario compare
- Auto-runs plan analysis after apply/undo once updated draft data is observed.
- Added `Undo Last Applied Trade Set` with exact draft snapshot restore.
- Saves each applied action as a named scenario and shows side-by-side metric table.
- Files: `src/UnifiedPlanScreen.tsx`, `src/store.ts`, `src/store.test.ts`
- Verification: `npm test -- store.test.ts flight-path-action-playbook.test.ts`, `npm run build`

13. [x] Add layman walkthrough expansion per action
- Added deterministic plain-English expansion fields to each playbook action (`storyHook`, task, why, walkthrough, watch-outs).
- Added expandable UI section on each recommendation card for guided “what to do and why.”
- Included deterministic `cacheKey` for optional future API-backed narration caching.
- Files: `src/flight-path-action-playbook.ts`, `src/UnifiedPlanScreen.tsx`, `src/flight-path-action-playbook.test.ts`
- Verification: `npm test -- flight-path-action-playbook.test.ts store.test.ts`, `npm run build`

14. [x] Add top-header trade activity button + list
- Added sticky-header `Trades` button with running count and expandable activity list.
- Logs each apply/undo trade-set action with timestamp and fund-level move legs.
- Files: `src/App.tsx`, `src/UnifiedPlanScreen.tsx`, `src/store.ts`, `src/store.test.ts`
- Verification: `npm test -- store.test.ts flight-path-action-playbook.test.ts`, `npm run build`

15. [x] Switch trade apply flow to full-goal execution
- Added per-action `fullGoalDollars` and changed apply behavior to scale the trade set to full goal.
- Updated UI button to `Apply Full Goal To Draft` with `Goal reached` state and goal-vs-shown amount display.
- Files: `src/flight-path-action-playbook.ts`, `src/UnifiedPlanScreen.tsx`, `src/flight-path-action-playbook.test.ts`
- Verification: `npm test -- store.test.ts flight-path-action-playbook.test.ts`, `npm run build`

## ACA Back-To-Back Execution (No Delay)

16. [x] Define ACA flight-phase contract
- Add explicit ACA metrics to playbook output (projected MAGI, ceiling, headroom, risk band, completeness).
- Added `acaMetrics` contract per phase and ACA-specific risk-band typing.
- Files: `src/flight-path-action-playbook.ts`, `src/UnifiedPlanScreen.tsx`

17. [x] Add ACA ceiling/headroom + guardrail engine
- Deterministic computation with explicit assumptions and surfaced inferred inputs.
- Added ACA bridge metrics builder with guardrail bands (`green/yellow/red/unknown`) and inferred-assumption surfacing.

18. [x] Integrate ACA guardrail into timeline + phase cards
- Add watch-zone messaging with exact years and household context.
- Added ACA bridge metrics block directly inside ACA phase card and inference details.

19. [x] Add ACA subsidy risk panel + warning banner
- Green/yellow/red state with threshold buffer and plain-English explanation.
- Added top-level ACA subsidy guardrail banner in Current Flight Path.

20. [x] Connect ACA action apply/re-run loop
- Ensure apply updates headroom and recommendation state in same workflow.
- Existing apply/re-run loop already updates draft inputs and re-evaluates playbook; ACA metrics now recompute from same refreshed evaluation.

21. [x] Add tests + final verification
- `npm test -- store.test.ts flight-path-action-playbook.test.ts`
- `npm run build`

## Retirement Flow Execution (Wave 1)

22. [x] Define retirement flow output contract
- Added `retirementFlowYears` to playbook output with typed yearly fields for account flows, total income, MAGI, and completeness.
- Files: `src/flight-path-action-playbook.ts`

23. [x] Map data sources for yearly retirement flows
- Mapped deterministic flow inputs from autopilot year diagnostics (`withdrawalTaxable`, `withdrawalRoth`, `withdrawalIra401k`, `withdrawalCash`, `estimatedMAGI`, `rmdAmount`, regime, ages) plus seed salary/social security/windfalls.
- Files: `src/flight-path-action-playbook.ts`

24. [x] Build deterministic yearly flow engine
- Implemented yearly flow row builder with partial first-year retirement months, account-source totals, expected MAGI, and inferred-assumption surfacing.
- Added test assertions for `retirementFlowYears`.
- Files: `src/flight-path-action-playbook.ts`, `src/flight-path-action-playbook.test.ts`
- Verification: `npm test -- flight-path-action-playbook.test.ts store.test.ts`, `npm run build`

## Retirement Flow Execution (Wave 2)

25. [x] Integrate flow table UI in Unified Plan
- Add a dedicated “Retirement Account Flows by Year” section with the exact row format requested.
- Added on-screen yearly table with retirement-month handling, account-source flows, total income, and expected MAGI.

26. [x] Add ACA/IRMAA context columns to yearly table
- Bridge-year ACA headroom and Medicare lookback context inline by year.
- Added ACA ceiling/headroom and IRMAA status + lookback tax year context per row.

27. [x] Add reconstruction badges + assumptions drilldown
- Surface faithful vs reconstructed per row and assumptions details.
- Added per-row completeness badge and inferred-assumption detail row.

28. [x] Final polish + verification
- Validate readability and run regression (`npm test`, `npm run build`).
- Verification complete: `npm test -- flight-path-action-playbook.test.ts store.test.ts`, `npm run build`.
