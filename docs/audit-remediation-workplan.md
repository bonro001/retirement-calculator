# Audit Remediation Workplan

Updated: April 21, 2026

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

## Sequential Execution

1. [x] Baseline run fingerprinting
- Added deterministic fingerprint utility for run/evaluation context consistency.
- Files: `src/evaluation-fingerprint.ts`, `src/store.ts`, `src/App.tsx`

2. [x] Reconcile success-rate source of truth in export summary layer
- Prevent stale Unified Plan context from populating executive summary in export flow.
- Files: `src/App.tsx`

3. [x] Stale-context guard in export pipeline
- Export now excludes Unified Plan context when fingerprints do not match current draft inputs.
- Files: `src/App.tsx`, `src/store.ts`

4. [x] Recommendation evidence gate
- Require measured baseline/counterfactual deltas for actionable top recommendations.
- File target: `src/flight-path-policy.ts`

5. [x] ACA-aware planner-enhanced withdrawal logic
- Wire ACA ceiling-aware sourcing into planner simulation, not only narrative layers.
- File target: `src/utils.ts`

6. [x] Fully integrated Roth conversion ladder in simulation
- Move conversion from recommendation-only to yearly modeled route behavior.
- File target: `src/utils.ts`

7. [x] Home sale modeling completeness (liquidity separation + UI inputs)
- Added `liquidityAmount` and home sale edit fields (`costBasis`, exclusion, net liquidity).
- Files: `src/types.ts`, `src/utils.ts`, `src/autopilot-timeline.ts`, `src/UnifiedPlanScreen.tsx`, `src/store.ts`

8. [x] Inheritance scenario matrix in export
- Add on-time / delayed / reduced / removed inheritance scenario deltas to export payload.
- File target: `src/planning-export.ts`

9. [x] Holdings fidelity improvement for reconstructed sleeves
- Reduce reliance on ambiguous defaults for `CENTRAL_MANAGED` and `TRP_2030`.
- File targets: `src/asset-class-mapper.ts`, related input plumbing

10. [x] Runway math consistency
- Unified runway calculations with shared helper across checklist and playbook.
- Files: `src/runway-utils.ts`, `src/probe-checklist.ts`, `src/flight-path-action-playbook.ts`

11. [x] Stress-suite expansion for ranking robustness
- Incorporate additional stress scenarios into ranking confidence/stability evaluation.
- File targets: `src/flight-path-policy.ts`, scenario sources

12. [x] Objective calibration cross-check
- Compare flat-spend vs phased objective impacts in export diagnostics.
- File targets: `src/planning-export.ts`, related summary modules

13. [x] Export QA gate
- Add explicit pass/fail diagnostics for consistency and evidence requirements.
- File targets: `src/planning-export.ts`, tests

14. [x] Final regression + audit pack output
- Ran targeted regression suites and full build; produced execution-readiness verification summary.

15. [x] Vitest worker-timeout stabilization
- Eliminated `onTaskUpdate` worker timeout failures by defaulting Vitest to sequential single-worker mode and reducing noisy long-run test output.
- Files: `vitest.config.ts`, `src/monte-carlo-parity-convergence.test.ts`
