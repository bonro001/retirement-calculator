# Working Set Commit Plan

Last updated: 2026-05-16

## Purpose

This branch has several useful efforts in one dirty working tree. Do not reset
or clean it. Use this map to stage the work intentionally.

Final proof already run:

- `npm run verify:model:quick:strict` passed
- `npm run verify:model:strict` passed
- `npm run test:model:all` passed
- `npm run build` passed

## Commit 1: Protected Reserve Contract And Horizon

Why: lock the household truth that the active horizon is Rob 88 / Debbie 91 and
the $1M target is a care-first protected reserve, legacy-if-unused.

Stage:

- `seed-data.json`
- `src/default-assumptions.ts`
- `src/types.ts`
- `src/protected-reserve.ts`
- `src/protected-reserve.test.ts`
- `src/protected-reserve-scenarios.test.ts`
- `src/store.ts`
- `src/legacy-target-cache.ts`
- `src/north-star-budget.ts`
- `src/north-star-budget.test.ts`
- `src/north-star-golden.test.ts`
- `src/north-star-metamorphic.test.ts`
- `src/model-contract-propagation.test.ts`
- `docs/protected-reserve-model.md`

Review before staging:

- `src/types.ts` also adds the `income_curve` screen id. If the Spending Curve
  screen ships in a separate UI commit, stage that line with the UI commit
  instead.

## Commit 2: Monthly Review, Export, Replay Propagation

Why: carry the same protected reserve and 88/91 horizon through machine-readable
evidence, monthly review packets, planning export, and replay fixtures.

Stage:

- `src/monthly-review.ts`
- `src/monthly-review.test.ts`
- `src/planning-export.ts`
- `src/model-replay-packets.ts`
- `src/model-replay-packets.test.ts`
- `fixtures/model_replay_packets.json`
- `scripts/monthly-review-loop.ts`
- `artifacts/monthly-review-packet-refresh/packet.json` only if we want a
  checked-in sample packet. Otherwise leave all `artifacts/` untracked.

Review before staging:

- `src/monthly-review.ts` also contains candidate selection ordering changes.
  Keep them here only if they are part of the monthly-review evidence fix.

## Commit 3: Verification Harness And External Anchors

Why: make the model proof repeatable and fail loudly on household-contract
drift.

Stage:

- `package.json`
- `package-lock.json`
- `scripts/run-model-tests.mjs`
- `scripts/verify-model.mjs`
- `scripts/collect-model-verification-snapshots.ts`
- `src/model-negative.test.ts`
- `src/external-model-benchmark-corpus.ts`
- `src/external-model-benchmark-corpus.test.ts`
- `src/ficalc-source-parity.ts`
- `src/ficalc-source-parity.test.ts`
- `src/cfiresim-export-parity.ts`
- `src/cfiresim-export-parity.test.ts`
- `fixtures/external_model_benchmarks.README.md`
- `fixtures/external_model_benchmarks.json`
- `fixtures/ficalc_historical_annual_returns.json`
- `fixtures/cfiresim_400k_20k_30yr_60_40_export.json`
- `src/verification-harness.ts`
- `src/verification-harness.test.ts`
- `src/verification-scenarios.ts`
- `src/calibration.test.ts`
- `src/monte-carlo-parity.ts`
- `src/monte-carlo-parity-convergence.test.ts`
- `vite.config.ts`
- `vite.config.js`
- `vitest.config.ts`
- `docs/model-testing-audit-plan.md`

Review before staging:

- `artifacts/model-verification-report.json` and
  `artifacts/model-verification-quick-report.json` are generated reports. Prefer
  leaving them untracked unless we decide to keep current proof reports as
  release artifacts.

## Commit 4: UI And AI Reserve Language

Why: prevent user-facing and AI-review copy from treating the $1M as
untouchable inheritance.

Stage:

- `cluster/monthly-review-ai-review.ts`
- `src/monthly-review-ai-review.test.ts`
- `src/App.tsx`
- `src/ExportScreen.tsx`
- `src/MonthlyReviewPanel.tsx`
- `src/UnifiedPlanScreen.tsx`
- `src/screens/IncomeCurveScreen.tsx`

Review before staging:

- `src/App.tsx` includes both care/legacy wording and the new Spending Curve
  route. If we want smaller commits, split the Spending Curve navigation into
  its own UI commit.
- `src/MonthlyReviewPanel.tsx` has large monthly-review UI changes beyond
  wording. Review it carefully before staging as one commit.

## Commit 5: Test Runtime Stabilization

Why: keep the full model tier green without false Vitest worker heartbeat
failures.

Stage:

- `src/policy-miner.ranking-stability.test.ts`
- `src/spend-optimizer.test.ts`
- `scripts/run-model-tests.mjs` if not already staged in Commit 3

Notes:

- The spend optimizer directional test is now explicit that it is a solvency
  capacity check and should not inherit the live household reserve target.
- The ranking stability test keeps the same proof shape with a smaller fixture
  so it finishes below the worker heartbeat threshold.

## Commit 6: Adjacent Miner / Host Work

Why: these files appear to be useful but are not core to the reserve-validation
effort. Keep them separate so the model proof is easy to review.

Stage only after separate review:

- `cluster/dispatcher.ts`
- `scripts/start-dispatcher-git-daemon.sh`
- `scripts/start-host.sh`
- `scripts/bazite-miner-prereq.sh`
- `scripts/bazite-miner-run.sh`
- `scripts/serve-bazite-miner.sh`
- `src/MiningScreen.tsx`
- `src/policy-mining-cluster.ts`

## Commit 7: Existing Engine/Test Fixes To Review Separately

Why: these modified tracked files are model-adjacent but not obviously part of
the protected-reserve thread from filenames alone.

Review diffs before assigning:

- `src/aca-subsidy-boundaries.test.ts`
- `src/model-fidelity.ts`
- `src/retirement-rules.ts`
- `src/retirement-rules.test.ts`
- `src/scheduled-outflows.test.ts`
- `src/spend-optimizer.ts`
- `src/spend-solver.ts`
- `src/spend-solver.test.ts`
- `src/tax-engine.test.ts`
- `src/utils.ts`

## Do Not Stage By Default

Generated or local-debug output:

- `.playwright-mcp/`
- `artifacts/monthly-review-server/`
- `network-all.txt`
- `recent-review-network.txt`
- `monthly-review-ai-requests.txt`
- `docs/working-set-commit-plan.md` unless we want this exact staging map in
  the branch history

Research/source material:

- `docs/research/jpmorgan-three-new-spending-surprises-2025.pdf`

Keep the PDF only if the repository is meant to store source research
documents. Otherwise cite it from docs and leave it out of the commit.

## Suggested Stage Order

1. Stage Commit 1 and run `npm run verify:model:quick:strict`.
2. Stage Commit 2 and run `npm run verify:model:quick:strict`.
3. Stage Commit 3 and run `npm run verify:model:strict`.
4. Stage Commit 4 and run `npm run build`.
5. Stage Commit 5 and run `npm run test:model:all`.
6. Review Commit 6 and Commit 7 only after the model-validation set is safely
   committed.
