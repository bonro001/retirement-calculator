# Decision-Grade Upgrade Plan

Updated: April 21, 2026

## Goal
Upgrade the planner from a strong rule-based engine to a more trustworthy decision engine without changing the integrated plan/autopilot architecture.

## Code-Path Audit
- Simulation loop and closed-loop withdrawal/tax/healthcare iteration:
  - `src/utils.ts` (`simulatePath`, `withdrawForNeed`, `applyProactiveRothConversion`, simulation diagnostics builders)
- Withdrawal engine:
  - `src/utils.ts` (`buildWithdrawalOrder`, `withdrawForNeed`)
- Roth conversion logic:
  - `src/utils.ts` (`applyProactiveRothConversion`)
- Recommendation/evidence gate:
  - `src/flight-path-policy.ts` (counterfactual evidence gate + confidence scoring)
- Export schema and quality gate:
  - `src/planning-export.ts`
  - `src/types.ts`

## Phase 1 (implemented)
- Convergence-based closed-loop iteration (kept max passes = 3):
  - Replaced fixed 2-3 pass behavior with threshold-based convergence checks for:
    - MAGI delta
    - federal tax delta
    - healthcare premium delta
  - Stop reason is explicit (`converged_thresholds_met` or `max_pass_limit_reached`).
- Convergence diagnostics export:
  - Added per-year diagnostics for:
    - converged (rate + dominant state)
    - passes used
    - last deltas (MAGI, federal tax, healthcare premium)
    - stop reason
- First-class fidelity layer:
  - Added input-level fidelity status: `exact`, `estimated`, `inferred`, `missing`
  - Added fidelity score, blocking assumptions, soft assumptions, and reliability effect summary.
  - Explicitly flags:
    - inferred RMD start timing
    - opaque holdings mappings
    - payroll/take-home estimate
    - uncertain inheritance
    - simplified home-sale assumptions
- Richer downside-risk outputs:
  - early-failure probability
  - median failure shortfall dollars
  - median downside spending-cut requirement
  - worst-decile ending wealth (explicit risk metric)
- Export quality gate extensions:
  - fidelity layer presence check
  - blocking-assumption visibility check

## Phase 2 (next)
- Default objective to `maximize_time_weighted_spending` throughout export and scenario-compare defaults.
- Explicit phased spending controls (higher early-retirement discretionary spend, lower later spend) as first-class policy.
- Inheritance robustness in core score:
  - base plan excluding uncertain inheritance
  - upside plan including inheritance
  - robustness penalty for inheritance dependence
- Runway bridge-risk model:
  - prove deltas on early-failure risk, worst-decile outcomes, and forced equity sales before recommending runway actions.

## Phase 3 (next)
- Forward-looking Roth optimizer (multi-year objective-aware) with full annual trace export.
- Objective-driven withdrawal source scoring by year (tax/MAGI/ACA/IRMAA/optionality/sequence defense).
- Richer Monte Carlo models:
  - fat tails
  - regime switching
  - correlated assets
  - inflation-return regime linkage
  - baseline bounded-normal retained for parity comparison.

## Success Criteria
- Exact vs inferred inputs are explicit in exported diagnostics.
- Closed-loop solver reports true convergence behavior, not fixed-pass assumptions.
- Core outputs include richer downside risk, not just success rate.
- Recommendations remain evidence-gated and fidelity-aware.
