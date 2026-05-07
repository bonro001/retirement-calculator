# Change Grouping

Snapshot date: 2026-05-07

## Commit 1: Rust Runtime Promotion

Purpose: make Rust the default cluster policy-mining runtime while retaining
TypeScript as explicit rollback/reference.

Files:

- `cluster/engine-runtime.ts`
- `src/engine-runtime-config.test.ts`
- `cluster/host-worker.ts`
- `cluster/host.ts`
- `package.json`
- `docs/engine-compare-loop.md`
- `docs/rust-promotion-audit.md`
- `flight-engine-rs/src/candidate_engine.rs`
- `src/random-tape.ts`

Suggested message:

`Promote Rust compact runtime for cluster policy mining`

## Commit 2: Planning Model Updates

Purpose: reconcile ACA, runway, Athena match, downsize housing, HSA/LTC reserve,
and contribution-limit behavior in the core model.

Files:

- `seed-data.json`
- `src/types.ts`
- `src/store.ts`
- `src/utils.ts`
- `src/contribution-engine.ts`
- `src/contribution-engine.test.ts`
- `src/flight-path-action-playbook.ts`
- `src/flight-path-action-playbook.test.ts`
- `src/flight-path-summary.ts`
- `src/flight-path-summary.test.ts`
- `src/runway-utils.ts`
- `src/model-fidelity.ts`
- `src/probe-checklist.ts`
- `src/screens/WindfallEditor.tsx`
- `src/downsize-hsa-reserve.test.ts`

Suggested message:

`Model ACA controls, Athena match, and downsize housing assumptions`

## Commit 3: Roth Conversion Execution And Export

Purpose: separate safe-room conversions from optional strategic extra
conversions, expose structured conversion diagnostics, and keep export/replay
in sync.

Files:

- `src/planning-export.ts`
- `src/planning-export.test.ts`
- `src/roth-conversion-behavior.test.ts`
- `src/monte-carlo-parity.ts`
- `src/App.tsx`
- `src/UnifiedPlanScreen.tsx`

Suggested message:

`Expose Roth conversion schedule and execution status`

## Commit 4: Optimizer And Scenario Cleanup

Purpose: keep optimizer, rule sweep, stressor, and verification fixtures aligned
with the updated model contracts.

Files:

- `src/autopilot-timeline.ts`
- `src/plan-evaluation.ts`
- `src/pre-retirement-optimizer.ts`
- `src/rule-sweep-analyzer.ts`
- `src/stressor-delay-mechanic.test.ts`
- `src/verification-scenarios.ts`

Suggested message:

`Align optimizers and verification scenarios with planner model updates`

## Do Not Commit

Generated/local artifacts:

- `.claude/worktrees/`
- `backups/`
- `out/`

These should stay out of the task commits unless a specific backup or log is
intentionally being preserved.
