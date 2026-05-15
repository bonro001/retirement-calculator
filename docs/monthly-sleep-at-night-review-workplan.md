# Monthly Sleep-At-Night Review Workplan

## Goal

Create a one-click monthly review that mines the Current Faithful and J.P.
Morgan travel-included spending strategies, certifies the maximum supported
household spend, runs an AI co-review, and produces either a green monthly max
or a blocking model-improvement backlog.

## Advisor-Like North Star

The system should mimic a careful financial advisor to the best of its ability
while staying inside the evidence. It should prioritize issues, explain
tradeoffs, distinguish model facts from household decisions, admit what it does
not know, and offer concrete next-step suggestions.

For every material issue, especially red household QA signals, the review should
classify the item as one of:

- Known or accepted household decision.
- Real problem needing a decision.
- Model/data bug risk.
- Monitor-only item.
- AI suggestion or possible resolution path.

The AI may suggest likely fixes or tradeoffs, but it must not invent household
intent or treat a suggestion as an accepted decision.

## Certification Standard

A monthly recommendation is green only when all approval gates pass:

- Baseline certification is green.
- Stress certification is green.
- Seed stability passes.
- Forward-looking and historical-precedent modes both pass.
- The spend boundary is proven by tested higher spend levels.
- No critical model-quality task remains open.
- AI co-review passes as a co-equal reviewer.
- Adoption still requires explicit user approval.

Green certification thresholds:

- Baseline solvency >= 95%.
- Baseline legacy attainment >= 85%.
- Baseline first-10-year failure risk <= 1%.
- Baseline spending cut rate <= 10%.
- Stress solvency >= 85%.
- Stress legacy attainment >= 70%.
- Stress first-10-year failure risk <= 5%.
- Stress spending cut rate <= 25%.
- Worst audit seed solvency >= 93%.
- Worst audit seed legacy attainment >= 83%.

## Monthly Pipeline

1. Snapshot the applied plan, assumptions, selected stressors/responses, legacy
   target, and engine versions.
2. Build the strategy set:
   - Current Faithful.
   - J.P. Morgan travel-included.
3. For each strategy, run pass-1 mining and automatic pass-2 refinement:
   spend cliff plus withdrawal-rule sweep.
4. Rank mined candidates by maximum total household spend after legacy and
   solvency gates.
5. Certify descending spend candidates until the first green candidate is found.
6. Build a structured AI validation packet containing the recommendation,
   spend-boundary evidence, certification summary, assumptions, and structural
   tasks.
7. Run AI co-review with `gpt-5.5` and high reasoning.
8. Produce the final result:
   - Green recommendation with annual/monthly total household spend.
   - Or blocked result with model-improvement tasks.

## Structural Failure Feedback Loop

Critical model-quality tasks block green approval. Deterministic rules create
tasks and own severity; AI may enrich wording but cannot invent or waive
blockers.

Critical task families:

- Missing required input or material inferred assumption.
- No green certified candidate.
- Forward-looking / historical-precedent approval conflict.
- Seed instability.
- Unbounded search, including highest mined spend still green.
- Strategy instability between Current Faithful and JP without a certified
  winner.
- AI insufficient evidence or fail-level finding.
- Excess cash / windfall deployment artifact, such as large inheritance cash
  balances sitting outside an explicit reserve or investment policy.

## Agent Iteration Mode

Default command shape:

```text
Run monthly sleep-at-night review. Iterate up to 5 times or until green.
Do not change assumptions, goals, household facts, or certification thresholds
without asking. Create and fix model-quality tasks if structural failures block
approval.
```

Loop:

1. Run monthly review.
2. Stop if green.
3. Classify blockers and create structural tasks.
4. Fix the highest-priority critical task that is a code/model-policy artifact.
5. Add or update focused tests.
6. Rerun.
7. Stop at green or iteration limit.

External OpenAI calls are capped at 5 total per implementation loop and should
be avoided in automated tests.

## Implementation Phases

1. Standards lock and markdown workplan.
2. Monthly review artifact types.
3. Structural failure task classifier.
4. Strategy registry.
5. Reusable mining orchestrator abstraction.
6. Certification candidate gate.
7. AI validation packet.
8. AI co-review integration.
9. Monthly review orchestrator.
10. Monthly review UI.
11. Autonomous iteration harness.

## Acceptance Criteria

- The monthly review can store all evidence in structured form.
- Current Faithful and JP results remain isolated by mining fingerprint.
- Yellow or red certified candidates never become green recommendations.
- Critical structural tasks block approval.
- Deterministic and AI reviews are co-equal; either can block.
- The UI presents one monthly review surface and requires manual adoption.
