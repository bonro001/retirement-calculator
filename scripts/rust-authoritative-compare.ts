import { initialSeedData } from '../src/data';
import { DEFAULT_ENGINE_COMPARE_ASSUMPTIONS } from '../src/engine-compare';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
} from '../src/policy-axis-enumerator';
import {
  buildPolicyMiningReplayInput,
  evaluatePolicyWithSummary,
} from '../src/policy-miner-eval';
import { POLICY_MINER_ENGINE_VERSION } from '../src/policy-miner-types';
import { comparePolicyMiningSummaries } from '../src/policy-mining-summary-contract';
import type { MarketAssumptions, SeedData } from '../src/types';
import { NativeRustEngineClient } from '../cluster/rust-engine-native-client';
import type { EngineCandidateRequest } from '../src/engine-compare';

interface CliOptions {
  policies: number;
  trials: number;
  historical: boolean;
  json: boolean;
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    policies: 4,
    trials: 40,
    historical: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--policies' && next) {
      options.policies = Math.max(1, Math.floor(Number(next)));
      index += 1;
    } else if (arg === '--trials' && next) {
      options.trials = Math.max(1, Math.floor(Number(next)));
      index += 1;
    } else if (arg === '--historical') {
      options.historical = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  node --import tsx scripts/rust-authoritative-compare.ts
  node --import tsx scripts/rust-authoritative-compare.ts -- --policies 20 --trials 100 --historical --json`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return options;
}

function cloneSeedData(seed: SeedData): SeedData {
  return structuredClone(seed);
}

function formatMs(value: number) {
  return `${(value / 1000).toFixed(2)}s`;
}

function formatMb(value: number) {
  return `${(value / 1_000_000).toFixed(1)}MB`;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const assumptions: MarketAssumptions = {
    ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
    simulationRuns: options.trials,
    useHistoricalBootstrap: options.historical,
    assumptionsVersion: options.historical
      ? 'rust-authoritative-compare-historical'
      : 'rust-authoritative-compare-parametric',
  };
  const policies = Array.from(enumeratePolicies(buildDefaultPolicyAxes(initialSeedData))).slice(
    0,
    options.policies,
  );
  const client = new NativeRustEngineClient();
  const startedAt = Date.now();
  const results = [];

  for (const policy of policies) {
    const tsStartedAt = Date.now();
    const tsRun = await evaluatePolicyWithSummary(
      policy,
      initialSeedData,
      assumptions,
      'rust-authoritative-compare-baseline',
      POLICY_MINER_ENGINE_VERSION,
      'rust-authoritative-compare',
      cloneSeedData,
      1_000_000,
    );
    const tsEvaluationDurationMs = Date.now() - tsStartedAt;
    const replayStartedAt = Date.now();
    const replayInput = buildPolicyMiningReplayInput(
      policy,
      initialSeedData,
      assumptions,
      'rust-authoritative-compare-baseline',
      POLICY_MINER_ENGINE_VERSION,
      cloneSeedData,
    );
    const replayBuildDurationMs = Date.now() - replayStartedAt;
    const request: EngineCandidateRequest = {
      schemaVersion: 'engine-candidate-request-v1',
      data: replayInput.candidateData,
      assumptions: replayInput.candidateAssumptions,
      mode: replayInput.simulationMode,
      tape: replayInput.tape,
      annualSpendTarget: replayInput.annualSpendTarget,
      outputLevel: 'policy_mining_summary',
    };
    const rustStartedAt = Date.now();
    const { summary: rustSummary, timings } =
      client.runPolicyMiningSummaryCompactWithTiming(request);
    const rustWallDurationMs = Date.now() - rustStartedAt;
    const compareStartedAt = Date.now();
    const comparison = comparePolicyMiningSummaries(tsRun.summary, rustSummary);
    const compareDurationMs = Date.now() - compareStartedAt;
    results.push({
      policy,
      pass: comparison.pass,
      firstDifference: comparison.firstDifference,
      tsEvaluationDurationMs,
      replayBuildDurationMs,
      rustWallDurationMs,
      rustTotalDurationMs: timings.totalDurationMs,
      compareDurationMs,
      requestBytes: timings.requestBytes,
    });
  }

  const report = {
    pass: results.every((result) => result.pass),
    mode: options.historical ? 'historical' : 'parametric',
    policies: policies.length,
    trials: options.trials,
    durationMs: Date.now() - startedAt,
    mismatches: results.filter((result) => !result.pass).length,
    firstMismatch: results.find((result) => !result.pass) ?? null,
    tsEvaluationDurationMs: results.reduce(
      (sum, result) => sum + result.tsEvaluationDurationMs,
      0,
    ),
    replayBuildDurationMs: results.reduce(
      (sum, result) => sum + result.replayBuildDurationMs,
      0,
    ),
    rustWallDurationMs: results.reduce(
      (sum, result) => sum + result.rustWallDurationMs,
      0,
    ),
    rustTotalDurationMs: results.reduce(
      (sum, result) => sum + result.rustTotalDurationMs,
      0,
    ),
    compareDurationMs: results.reduce((sum, result) => sum + result.compareDurationMs, 0),
    requestBytes: results.reduce((sum, result) => sum + result.requestBytes, 0),
  };

  if (options.json) {
    console.log(JSON.stringify({ ...report, results }, null, 2));
  } else {
    console.log(
      `rust-authoritative:compare pass=${report.pass} mode=${report.mode} policies=${report.policies} trials=${report.trials} mismatches=${report.mismatches} ts=${formatMs(report.tsEvaluationDurationMs)} replay=${formatMs(report.replayBuildDurationMs)} rust=${formatMs(report.rustTotalDurationMs)} compare=${formatMs(report.compareDurationMs)} request=${formatMb(report.requestBytes)}`,
    );
    if (report.firstMismatch) {
      console.log(JSON.stringify(report.firstMismatch, null, 2));
    }
  }
  process.exit(report.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
