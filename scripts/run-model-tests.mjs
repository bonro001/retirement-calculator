#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const tiers = {
  micro: [
    'src/aca-subsidy-boundaries.test.ts',
    'src/additional-medicare-tax.test.ts',
    'src/allocation-check.test.ts',
    'src/asset-class-mapper.test.ts',
    'src/contribution-engine.test.ts',
    'src/healthcare-premium-engine.test.ts',
    'src/irmaa-tier-boundaries.test.ts',
    'src/jpmorgan-spending-surprises.test.ts',
    'src/ltc-probability.test.ts',
    'src/medicare-milestones.test.ts',
    'src/model-contract-propagation.test.ts',
    'src/north-star-budget.test.ts',
    'src/north-star-golden.test.ts',
    'src/north-star-metamorphic.test.ts',
    'src/north-star-result.test.ts',
    'src/plan-evaluation.test.ts',
    'src/protected-reserve-scenarios.test.ts',
    'src/protected-reserve.test.ts',
    'src/retirement-rules.test.ts',
    'src/roth-optimizer.test.ts',
    'src/rule-packs.test.ts',
    'src/scheduled-outflows.test.ts',
    'src/social-security-fractional.audit.test.ts',
    'src/social-security-taxation.test.ts',
    'src/social-security.test.ts',
    'src/spending-ledger.test.ts',
    'src/spending-overrides.test.ts',
    'src/ss-optimizer.test.ts',
    'src/ss-spousal-step-up.audit.test.ts',
    'src/tax-engine-scenarios.test.ts',
    'src/tax-engine.test.ts',
    'src/windfall-deployment.test.ts',
    'src/windfall-growth.test.ts',
    'src/windfall-tax-treatment.test.ts',
    'src/withdrawal-rules.test.ts',
  ],
  trace: [
    'src/block-bootstrap.test.ts',
    'src/cashflow-accounting.test.ts',
    'src/downsize-hsa-reserve.test.ts',
    'src/historical-bootstrap.test.ts',
    'src/historical-cohorts.test.ts',
    'src/monte-carlo-convergence.test.ts',
    'src/monte-carlo-engine.test.ts',
    'src/qmc-engine-parity.test.ts',
    'src/quasi-monte-carlo.test.ts',
    'src/roth-conversion-behavior.test.ts',
    'src/six-pack-rules.test.ts',
    'src/uncertainty-surface.test.ts',
  ],
  contracts: [
    'src/axis-pruning-analyzer.test.ts',
    'src/candidate-replay-package.test.ts',
    'src/cliff-refinement-analyzer.test.ts',
    'src/cluster-dispatcher.two-stage.test.ts',
    'src/cluster-host-partition.test.ts',
    'src/cluster-peer-view.test.ts',
    'src/cluster-work-queue.test.ts',
    'src/combined-pass2-analyzer.test.ts',
    'src/evaluation-fingerprint.test.ts',
    'src/model-negative.test.ts',
    'src/mining-north-star-ai.test.ts',
    'src/monthly-review-ai-review.test.ts',
    'src/monthly-review.test.ts',
    'src/optimization-objective.test.ts',
    'src/policy-axis-enumerator-v2.test.ts',
    'src/policy-certification.test.ts',
    'src/policy-frontier.test.ts',
    'src/policy-miner.pool-two-stage.test.ts',
    'src/policy-miner.ranking-stability.test.ts',
    'src/policy-miner.throughput.test.ts',
    'src/policy-miner.two-stage.test.ts',
    'src/policy-mining-summary-contract.test.ts',
    'src/policy-ranker.test.ts',
    'src/policy-stress-test.test.ts',
    'src/rule-sweep-analyzer.test.ts',
    'src/sensitivity-sweep.test.ts',
    'src/spend-optimizer.test.ts',
    'src/spend-solver.test.ts',
    'src/spending-model-runner.test.ts',
  ],
  parity: [
    'src/binding-guardrail.test.ts',
    'src/boldin-parity.test.ts',
    'src/bond-perturbation-investigation.test.ts',
    'src/calibration.test.ts',
    'src/cfiresim-export-parity.test.ts',
    'src/compact-random-tape.test.ts',
    'src/crash-mixture.test.ts',
    'src/engine-compare.test.ts',
    'src/engine-runtime-config.test.ts',
    'src/external-model-benchmark-corpus.test.ts',
    'src/fidelity-parity.test.ts',
    'src/ficalc-source-parity.test.ts',
    'src/historical-data-plausibility.test.ts',
    'src/model-replay-packets.test.ts',
    'src/model-fidelity.test.ts',
    'src/monte-carlo-parity-convergence.test.ts',
    'src/monte-carlo-parity.test.ts',
    'src/property-dominance.test.ts',
    'src/property-monotonicity.test.ts',
    'src/rust-engine-client-node-boundary.test.ts',
    'src/shard-parity.test.ts',
    'src/simulation-parity.test.ts',
    'src/trinity-rolling-windows.test.ts',
    'src/verification-harness.test.ts',
  ],
};

const tierOrder = ['micro', 'trace', 'contracts', 'parity'];
const command = process.argv[2] ?? 'all';
const extraArgs = process.argv.slice(3);

const batchedTiers = {
  contracts: [
    ['src/policy-miner.ranking-stability.test.ts'],
    ['src/spend-solver.test.ts'],
    ['src/spend-optimizer.test.ts'],
    tiers.contracts.filter(
      (file) =>
        !new Set([
          'src/policy-miner.ranking-stability.test.ts',
          'src/spend-solver.test.ts',
          'src/spend-optimizer.test.ts',
        ]).has(file),
    ),
  ],
  parity: [
    ['src/monte-carlo-parity-convergence.test.ts'],
    ['src/calibration.test.ts'],
    [
      'src/bond-perturbation-investigation.test.ts',
      'src/crash-mixture.test.ts',
      'src/monte-carlo-parity.test.ts',
      'src/simulation-parity.test.ts',
      'src/verification-harness.test.ts',
    ],
    tiers.parity.filter(
      (file) =>
        !new Set([
          'src/monte-carlo-parity-convergence.test.ts',
          'src/calibration.test.ts',
          'src/bond-perturbation-investigation.test.ts',
          'src/crash-mixture.test.ts',
          'src/monte-carlo-parity.test.ts',
          'src/simulation-parity.test.ts',
          'src/verification-harness.test.ts',
        ]).has(file),
    ),
  ],
};

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  return result.status ?? 1;
}

function runVitest(label, files, args = []) {
  console.log(`\n=== model tests: ${label} (${files.length} files) ===`);
  return run('npx', ['vitest', 'run', ...files, ...args]);
}

function runTier(label, files, args = []) {
  const batches = batchedTiers[label];
  if (!batches) {
    return runVitest(label, files, args);
  }

  for (let index = 0; index < batches.length; index += 1) {
    const status = runVitest(
      `${label} ${index + 1}/${batches.length}`,
      batches[index],
      args,
    );
    if (status !== 0) return status;
  }
  return 0;
}

if (command === 'list') {
  for (const tier of tierOrder) {
    console.log(`\n${tier}`);
    for (const file of tiers[tier]) console.log(`  ${file}`);
  }
  process.exit(0);
}

if (command === 'full') {
  process.exit(run('npm', ['test', '--', ...extraArgs]));
}

if (command === 'coverage') {
  const files = tierOrder.flatMap((tier) => tiers[tier]);
  process.exit(runVitest('coverage', files, ['--coverage', ...extraArgs]));
}

if (command === 'all') {
  const failures = [];
  for (const tier of tierOrder) {
    const status = runTier(tier, tiers[tier], extraArgs);
    if (status !== 0) failures.push({ tier, status });
  }
  if (failures.length > 0) {
    console.error('\n=== model test tier failures ===');
    for (const failure of failures) {
      console.error(`${failure.tier}: exit ${failure.status}`);
    }
    process.exit(failures[0].status);
  }
  process.exit(0);
}

if (tiers[command]) {
  process.exit(runTier(command, tiers[command], extraArgs));
}

console.error(
  `Unknown model test tier "${command}". Use one of: ${[
    ...tierOrder,
    'all',
    'coverage',
    'full',
    'list',
  ].join(', ')}.`,
);
process.exit(1);
