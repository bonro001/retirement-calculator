# Model Testing And Audit Plan

Last updated: 2026-05-16

## Goal

Keep the retirement model decision-grade after the horizon and north-star
changes:

- Planning horizon is Rob age 88 / Debbie age 91.
- The $1M target is a protected care/legacy reserve, not routine lifestyle
  spending money.
- North-star, monthly review, export, replay packets, UI language, and strict
  verification all agree on that contract.

## Current Status

- [x] Set active default horizon to Rob 88 / Debbie 91.
- [x] Rebaseline golden scenarios for the 88/91 horizon.
- [x] Add explicit protected reserve model contract.
- [x] Mark the $1M reserve as care-first, legacy-if-unused.
- [x] Carry protected reserve through north-star budgets.
- [x] Carry protected reserve through monthly review validation packets.
- [x] Carry protected reserve through planning export evidence.
- [x] Add propagation test for 88/91 horizon and care-first reserve.
- [x] Add current 88/91 replay packet.
- [x] Add quick strict verification gate.
- [x] Run `npm run verify:model:quick:strict`.
- [x] Run `npm run verify:model`.

## Remaining Work

### 1. Make Full Strict Verification Release-Grade

- [x] Remove or intentionally budget the Vite large chunk warning.
- [x] Confirm `npm run verify:model:strict` passes with zero strict failures.
- [x] Decide whether future warnings always fail strict mode or whether specific
  warnings can be allowlisted with explicit rationale.

Acceptance:

- [x] `npm run verify:model:strict` exits 0.
- [x] Full verification report has `strict.enabled=true` and no failures.

### 2. Refresh Monthly Review Packet

- [x] Generate a fresh monthly review packet after the reserve/horizon changes.
- [x] Confirm `packet.northStar.protectedReserve` is present.
- [x] Confirm reserve `modelCompleteness` is `faithful`.
- [x] Confirm packet assumptions use Rob 88 / Debbie 91.
- [x] Confirm current-plan north-star budget carries the reserve.
- [x] Confirm selected-policy north-star budget carries the reserve.
- [x] Confirm packet language no longer treats the $1M as legacy-only.

Acceptance:

- [x] Fresh packet can be used by the UI without stale “engine trace missing”
  or legacy-only wording.

Artifact:

- `artifacts/monthly-review-packet-refresh/packet.json`

### 3. Add Negative Reserve Tests

- [x] Fail packet validation when `legacyTargetTodayDollars` exists but
  `protectedReserve` is missing.
- [x] Fail or flag when protected reserve purpose is not
  `care_first_legacy_if_unused`.
- [x] Fail or flag when `normalLifestyleSpendable` is `true`.
- [x] Fail when north-star budget target differs from protected reserve target.
- [x] Fail when monthly review and export disagree on reserve target or purpose.
- [x] Fail when reserve is reconstructed but the packet claims faithful model
  completeness.

Acceptance:

- [x] Negative tests prove bad reserve contracts cannot pass as decision-grade.

### 4. Cross-Surface Contract Audit

- [x] Add test comparing north-star budget, monthly review packet, and planning
  export for reserve target.
- [x] Add test comparing reserve purpose across the same surfaces.
- [x] Add test comparing reserve model completeness across the same surfaces.
- [x] Add test comparing Rob/Debbie horizon across default assumptions,
  monthly review, export, and replay packet.
- [x] Add test comparing modeled final year across path results and export.

Acceptance:

- [x] A single test failure points to the exact surface that drifted.

### 5. Replay Packet Audit

- [x] Keep older 90/95 packets replayable as compatibility anchors.
- [x] Label old packets as legacy compatibility, not current household truth.
- [x] Require the current 88/91 packet in replay fixture tests.
- [x] Add replay fixture metadata showing current packet count and current
  household packet id.
- [x] Add replay drift gate for packet count and current packet id.

Acceptance:

- [x] Old packets protect backward compatibility.
- [x] Current packet protects the live household contract.

### 6. UI Language Audit

- [x] Monthly Review: use “care/legacy reserve” for the household target.
- [x] Spending Curve: use “care/legacy reserve” for the household target.
- [x] Cockpit: replace legacy-only target wording where it describes the $1M
  reserve.
- [x] Export screen: show reserve purpose and availability for care shocks.
- [x] Unified Plan: separate true bequest metrics from care/legacy reserve
  target.
- [x] Keep “legacy” only where it means bequest/attainment metric rather than
  the household reserve target.

Acceptance:

- [x] User-facing copy does not imply the $1M is untouchable inheritance money.

### 7. AI Review Prompt Audit

- [x] Update monthly-review AI instructions to define protected reserve.
- [x] Tell AI review that the reserve is not routine lifestyle spending.
- [x] Tell AI review that the reserve can be used for late-life care or health
  shocks.
- [x] Tell AI review that passing money on is secondary if care does not consume
  it.
- [x] Add test asserting AI prompt includes the reserve purpose and availability.

Acceptance:

- [x] AI review cannot approve or critique the plan using legacy-only framing.

### 8. Expand Strict Drift Gates

- [x] Fail strict mode on north-star monthly budget drift beyond threshold.
- [x] Fail strict mode on protected reserve target drift.
- [x] Fail strict mode on protected reserve purpose drift.
- [x] Fail strict mode on first-year cash outflow drift.
- [x] Fail strict mode on p10 ending wealth drift.
- [x] Fail strict mode on modeled final year drift.
- [x] Fail strict mode on replay packet count/current packet id drift.

Acceptance:

- [x] Verification fails when the model silently changes the household contract.

### 9. Add Reserve-Specific Scenarios

- [x] No-care case: reserve remains and can pass on.
- [x] Partial-care case: reserve is used partly for care but plan remains
  solvent.
- [x] Full-care case: reserve is consumed by care and plan remains interpretable.
- [x] Market-stress plus care-shock case.
- [x] Longer-life audit-only sensitivity, such as Debbie 95.
- [x] Lower-life audit-only sensitivity, matching Rob 88 / Debbie 91 baseline
  for comparison.

Acceptance:

- [x] The model distinguishes “reserve available for care” from “routine spend.”

### 10. Documentation

- [x] Document protected reserve semantics.
- [x] Document relationship between `legacyTargetTodayDollars` and
  `protectedReserve`.
- [x] Document why external calculators validate mechanics but not the full
  household reserve contract.
- [x] Document the 88/91 horizon and modeled final year.
- [x] Document strict verification commands.

Acceptance:

- [x] A future maintainer can explain what the north-star number means without
  reading code.

Artifact:

- `docs/protected-reserve-model.md`

## Final Proof Target

Run and keep green:

```bash
npm run verify:model:quick:strict
npm run verify:model:strict
npm run test:model:all
npm run build
```

Known current blocker:

- None.
