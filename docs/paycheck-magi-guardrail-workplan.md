# Paycheck Contributions + MAGI Guardrail Workplan

Last updated: 2026-04-20
Owner: Codex + Rob
Status: Planned

## Objective
Make paycheck deferrals part of the flight path so ACA subsidy guardrail fixes include payroll moves, not only portfolio trades.

Example target behavior for calendar year 2027:
- If projected MAGI is above the ACA-friendly ceiling and salary is still active, recommend increasing pre-tax 401(k) and/or HSA first (up to limits) before forcing additional cash-shift trades.
- Distinguish clearly between pre-tax 401(k) and Roth 401(k): Roth 401(k) does not reduce MAGI.

## Scope Rules
- Deterministic and seeded behavior only.
- All inferred assumptions surfaced with `modelCompleteness`.
- Structured outputs first; no hidden assumptions in logic.
- Keep existing simulation/test parity paths aligned (`autopilot-timeline` and `utils`).

## Timeboxed Steps (10 minutes each)
1. **0-10 min: Baseline + acceptance criteria**
   - Confirm exact MAGI target year behavior (2027 bridge risk path).
   - Define acceptance checks for red/yellow/green guardrail transitions.

2. **10-20 min: Data contract extension**
   - Extend `PreRetirementContributionSettings` for explicit split:
     - `employee401kPreTaxAnnualAmount` / `%`
     - `employee401kRothAnnualAmount` / `%`
     - retain HSA + match fields
   - Backward compatibility: map legacy `employee401kAnnualAmount` to pre-tax if present.

3. **20-30 min: Seed + store plumbing**
   - Update seed defaults and store update actions so new fields are editable/persisted.
   - Add pending-change tracking for contribution setting edits.

4. **30-40 min: Contribution engine split logic**
   - Enforce shared 401(k) employee cap across pre-tax + Roth deferrals.
   - Wage/MAGI reduction only from pre-tax employee 401(k) + HSA.
   - Employer match based on total employee deferral (pre-tax + Roth), added to pre-tax balance path unless explicitly modeled otherwise.

5. **40-50 min: Autopilot integration**
   - Feed split contribution output into yearly route engine.
   - Ensure MAGI uses adjusted wages from pre-tax + HSA only.
   - Add intermediates for transparency (`employee401kPretax`, `employee401kRoth`, `hsaContribution`, `taxableWageReduction`).

6. **50-60 min: Monte Carlo parity integration**
   - Mirror same contribution split behavior in `utils.ts` simulation path.
   - Keep deterministic parity with autopilot path logic.

7. **60-70 min: Guardrail leverage calculation**
   - New helper to compute payroll-based MAGI reduction capacity for upcoming salary years:
     - remaining pre-tax 401(k) room
     - remaining HSA room
   - Return explicit “max MAGI reducible via payroll” amount.

8. **70-80 min: Flight-path action generation**
   - Add a payroll action candidate when ACA guardrail is yellow/red and salary exists:
     - Example: “Increase pre-tax 401(k) by $X for 2027 payroll to reduce MAGI.”
   - Rank this action above trade-based moves when payroll fix capacity can close all/most of gap.

9. **80-90 min: Apply wiring (real task execution)**
   - Add apply behavior for payroll action (updates contribution settings, not holdings).
   - Re-run flow should reflect reduced MAGI gap immediately.

10. **90-100 min: UI controls + explainability**
    - Add “Paycheck Contributions” controls in Base Inputs:
      - pre-tax 401(k), Roth 401(k), HSA, employer match
    - Add layman explanation block for payroll actions (what/why/limits).

11. **100-110 min: Test suite expansion**
    - `contribution-engine.test.ts`: split cap math, MAGI effects, catch-up boundaries.
    - `autopilot-timeline.test.ts`: higher pre-tax lowers MAGI in salary year and can clear ACA overage.
    - `flight-path-action-playbook.test.ts`: payroll action appears and ranks correctly in guardrail recovery.

12. **110-120 min: QA + docs**
    - Build + focused tests.
    - Add notes on assumptions/model completeness when payroll details are incomplete.
    - Final walkthrough with before/after MAGI numbers.

## Definition of Done
- When subsidy guardrail is over limit and salary is active, flight path auto-surfaces payroll deferral action first (if capacity exists).
- Applying payroll action changes contribution settings and materially reduces projected MAGI in the targeted year.
- Roth 401(k) remains available and explicit, but does not count as MAGI-reducing.
- Intermediate calculations and inferred assumptions are visible in structured outputs.
