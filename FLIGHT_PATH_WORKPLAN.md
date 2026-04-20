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

1. [ ] Extract policy engine from UI
- Move strategic prep rule logic out of `src/UnifiedPlanScreen.tsx` into `src/flight-path-policy.ts`.
- Define typed inputs/outputs and a version field.

2. [ ] Define recommendation schema
- Add structured fields for action, triggerReason, estimatedImpact, tradeoffs, confidence, evidence.
- Keep output deterministic and machine-readable.

3. [ ] Build candidate generator
- Generate recommendation candidates from plan state (spending, MAGI, conversions, liquidity, withdrawal mix).
- No render/UI concerns in candidate generation.

4. [ ] Add counterfactual evaluator
- For each candidate, run seeded before/after evaluation.
- Record metric deltas: supported spending, success, legacy, IRMAA/ACA exposure.

5. [ ] Enforce hard-constraint gating
- Reject candidates that violate success floor, legacy floor/band, spending minima, or explicit user constraints.

6. [ ] Add confidence scoring
- Score confidence from effect size, stability across sensitivity runs, and model completeness.
- Provide confidence labels with rationale.

7. [ ] Rank and filter recommendations
- Rank by net benefit and user-goal alignment.
- Keep top distinct recommendations to avoid noisy duplicates.

8. [ ] Wire UI to evidence-backed output
- Update `UnifiedPlanScreen` to consume policy output.
- Display action, impact, tradeoff, confidence, and supporting evidence.

9. [ ] Add diagnostics and transparency
- Add diagnostics payload: policy version, candidates considered, filter reasons, accepted recommendations, metric deltas.

10. [ ] Add deterministic tests
- Unit tests for policy triggers.
- Integration tests for seeded counterfactual recommendations.
- Regression tests for recommendation stability.

11. [ ] Calibrate thresholds
- Tune thresholds using scenario suite outcomes.
- Document threshold rationale and review date.

12. [ ] Rollout and cleanup
- Run in shadow mode first, compare with current panel.
- Switch default once validated and remove obsolete heuristic path.
