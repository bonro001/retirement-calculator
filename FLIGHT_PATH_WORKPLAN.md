# Flight Path Recommendation Trust Plan

Status legend:
- `[ ]` pending
- `[-]` in progress
- `[x]` complete

Execution protocol:
1. Execute exactly one pending step per run (top to bottom).
2. Mark the active step as `[-]` while working, then `[x]` when done.
3. Add a short note under the step with files changed and verification done.
4. Stop after one step and report progress in-thread.

## Steps

1. [x] Extract policy engine from UI
- Move strategic prep rule logic out of `src/UnifiedPlanScreen.tsx` into `src/flight-path-policy.ts`.
- Define typed inputs/outputs and a version field.
  - Done: moved recommendation generation into `buildFlightPathStrategicPrepRecommendations` with typed `FlightPathPolicyInput`/`FlightPathPolicyResult` and `FLIGHT_PATH_POLICY_VERSION`.
  - Files: `src/flight-path-policy.ts`, `src/UnifiedPlanScreen.tsx`.
  - Verification: `npm run build` passed.

2. [x] Define recommendation schema
- Add structured fields for action, triggerReason, estimatedImpact, tradeoffs, confidence, evidence.
- Keep output deterministic and machine-readable.
  - Done: expanded `StrategicPrepRecommendation` with `triggerReason`, `estimatedImpact`, `tradeoffs`, `confidence`, and `evidence`.
  - Files: `src/flight-path-policy.ts`, `src/UnifiedPlanScreen.tsx`.
  - Verification: `npm run build` passed.

3. [x] Build candidate generator
- Generate recommendation candidates from plan state (spending, MAGI, conversions, liquidity, withdrawal mix).
- No render/UI concerns in candidate generation.
  - Done: added `buildStrategicPrepCandidates(input)` in policy module, isolated from rendering concerns.
  - Files: `src/flight-path-policy.ts`.
  - Verification: `npm run build` passed.

4. [x] Add counterfactual evaluator
- For each candidate, run seeded before/after evaluation.
- Record metric deltas: supported spending, success, legacy, IRMAA/ACA exposure.
  - Done: added seeded counterfactual path evaluation per candidate via `buildPathResults` with fixed seed/runs and before/after deltas (`supportedMonthlyDelta`, `successRateDelta`, `medianEndingWealthDelta`, `annualFederalTaxDelta`, `yearsFundedDelta`).
  - Files: `src/flight-path-policy.ts`, `src/UnifiedPlanScreen.tsx`.
  - Verification: `npm run build` passed.

5. [x] Enforce hard-constraint gating
- Reject candidates that violate success floor, legacy floor/band, spending minima, or explicit user constraints.
  - Done: added hard-constraint gate to policy output filtering for success floor, legacy floor/target-band floor, spending minima, and explicit user constraints (`doNotRetireLater`, `doNotSellHouse`).
  - Files: `src/flight-path-policy.ts`.
  - Verification: `npm run build` passed.

6. [x] Add confidence scoring
- Score confidence from effect size, stability across sensitivity runs, and model completeness.
- Provide confidence labels with rationale.
  - Done: confidence now combines effect signal, sensitivity stability (adverse/benign perturbed seeded scenarios), and model completeness assessment.
  - Files: `src/flight-path-policy.ts`.
  - Verification: `npm run build` passed.

7. [x] Rank and filter recommendations
- Rank by net benefit and user-goal alignment.
- Keep top distinct recommendations to avoid noisy duplicates.
  - Done: added net-benefit ranking that combines objective alignment (`activeOptimizationObjective`), binding-constraint alignment, priority boost, and confidence score.
  - Done: added distinct filtering by recommendation category to prevent duplicate/noisy actions in the final top set.
  - Files: `src/flight-path-policy.ts`.
  - Verification: `npm run build` passed.

8. [x] Wire UI to evidence-backed output
- Update `UnifiedPlanScreen` to consume policy output.
- Display action, impact, tradeoff, confidence, and supporting evidence.
  - Done: enhanced recommendation cards with explicit supporting evidence block showing baseline/counterfactual metrics, simulation runs/seed, and evidence notes from the policy engine.
  - Files: `src/UnifiedPlanScreen.tsx`.
  - Verification: `npm run build` passed.

9. [x] Add diagnostics and transparency
- Add diagnostics payload: policy version, candidates considered, filter reasons, accepted recommendations, metric deltas.
  - Done: added `diagnostics` payload to policy output with policy/version objective context, candidate/evaluation counts, hard-constraint filter reasons, ranking filters/scores, accepted recommendation IDs, and impact-delta summaries for accepted vs returned recommendations.
  - Files: `src/flight-path-policy.ts`.
  - Verification: `npm run build` passed.

10. [x] Add deterministic tests
- Unit tests for policy triggers.
- Integration tests for seeded counterfactual recommendations.
- Regression tests for recommendation stability.
  - Done: added deterministic `flight-path-policy` test coverage for trigger generation, seeded counterfactual recommendation diagnostics, and repeat-run stability with a mocked deterministic path engine.
  - Files: `src/flight-path-policy.test.ts`.
  - Verification: `npm run test -- src/flight-path-policy.test.ts`; `npm run build` passed.

11. [x] Calibrate thresholds
- Tune thresholds using scenario suite outcomes.
- Document threshold rationale and review date.
  - Done: extracted trigger/scoring thresholds into `FLIGHT_PATH_POLICY_THRESHOLDS`, tuned values against a deterministic scenario suite, and surfaced threshold profile version/review date in policy diagnostics.
  - Done: added threshold calibration documentation with rationale, active values, and review date.
  - Files: `src/flight-path-policy.ts`, `src/flight-path-policy-thresholds.test.ts`, `docs/flight-path-threshold-calibration.md`.
  - Verification: `npm run test -- src/flight-path-policy.test.ts src/flight-path-policy-thresholds.test.ts`; `npm run build` passed.

12. [ ] Rollout and cleanup
- Run in shadow mode first, compare with current panel.
- Switch default once validated and remove obsolete heuristic path.
