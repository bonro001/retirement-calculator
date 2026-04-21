# Probe List Workplan

Updated: April 21, 2026

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

## Execution Order

1. [x] Extend explicit model inputs (windfall tax treatment, medical inflation)
- Added explicit windfall tax treatment fields and medical inflation input.
- Files: `src/types.ts`, `seed-data.json`

2. [x] Wire windfall tax treatment into both simulation paths
- Windfalls now flow through explicit tax realization logic (cash, ordinary income, LTCG, home-sale exclusion, inherited-IRA schedule).
- Files: `src/utils.ts`, `src/autopilot-timeline.ts`

3. [x] Add healthcare trend handling in both simulation paths
- Added dedicated medical inflation path for ACA/Medicare premium baselines.
- Files: `src/utils.ts`, `src/autopilot-timeline.ts`

4. [x] Add structured probe checklist output
- Added deterministic probe checklist for Roth sizing, inheritance/home-sale treatment, SS tax modeling, healthcare trend, runway, HSA strategy, LTC.
- Files: `src/probe-checklist.ts`

5. [x] Surface probe checklist in plan UI
- Added “Advisor Probe Checklist” to top-of-plan summary.
- Files: `src/UnifiedPlanScreen.tsx`

6. [x] Include probe checklist in export payload
- Export now carries probe checklist with statuses/summaries.
- Files: `src/planning-export.ts`

7. [x] Add explicit HSA policy behavior in yearly funding logic
- Added deterministic HSA offset logic (optional high-MAGI prioritization + annual cap) and wired yearly HSA offset tracking.
- Files: `src/utils.ts`, `src/autopilot-timeline.ts`

8. [x] Add LTC-cost scenario behavior in yearly spending logic
- Added deterministic LTC cost phase (start age, duration, cost, inflation) into yearly spending needs.
- Files: `src/utils.ts`, `src/autopilot-timeline.ts`

9. [x] Add focused tests for windfall tax treatment and probe checklist
- Added deterministic tests for home-sale/inherited-IRA tax treatment and checklist status transitions.
- Files: `src/windfall-tax-treatment.test.ts`, `src/probe-checklist.test.ts`, `src/simulation-parity.test.ts`

10. [x] Final regression pass
- Verification complete:
  - `npm test -- src/windfall-tax-treatment.test.ts src/probe-checklist.test.ts src/planning-export.test.ts src/simulation-parity.test.ts`
  - `npm run build`

## Export Check Remediation Sequence (April 21, 2026)

1. [x] Runway math consistency fix
- Unified probe-checklist and flight-path runway gap calculations via shared helper (`essential + fixed monthly`, 18-month target, sleeve-cash included).
- Files: `src/runway-utils.ts`, `src/flight-path-action-playbook.ts`, `src/probe-checklist.ts`

2. [x] Home sale liquidity assumption surfaced
- Added explicit probe item for whether full home-sale proceeds are assumed liquid.
- Files: `src/probe-checklist.ts`

3. [x] Home sale reinvestment modeling support
- Added `windfall.liquidityAmount` to separate gross sale amount/tax treatment from net portfolio liquidity.
- Wired through simulation + autopilot windfall realization logic.
- Files: `src/types.ts`, `src/utils.ts`, `src/autopilot-timeline.ts`

4. [x] HSA/LTC defaults made explicit in baseline data
- Added baseline configured HSA and LTC assumptions to seed data so checklist no longer reports missing by default.
- Files: `seed-data.json`

5. [x] UI inputs for home-sale tax/liquidity details
- Added Income Timing controls for home-sale `cost basis`, `capital-gains exclusion`, and `net liquidity`.
- Files: `src/UnifiedPlanScreen.tsx`, `src/store.ts`

6. [x] Export verification hardening
- Extended export tests for probe-era fields and reran focused regression + build.
- Files: `src/planning-export.test.ts`
- Verification:
  - `npm test -- src/probe-checklist.test.ts src/windfall-tax-treatment.test.ts src/planning-export.test.ts src/flight-path-action-playbook.test.ts src/simulation-parity.test.ts src/store.test.ts`
  - `npm run build`
