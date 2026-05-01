import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildEngineCandidateRequest,
  comparePathResults,
  runEngineReference,
} from '../src/engine-compare';
import {
  comparePolicyMiningSummaries,
  pathToPolicyMiningSummary,
} from '../src/policy-mining-summary-contract';
import type { SeedData, SimulationStrategyMode, WithdrawalRule } from '../src/types';
import {
  DEFAULT_RUST_ENGINE_COMMAND,
  RustEngineClient,
} from '../cluster/rust-engine-client';

interface CliOptions {
  trials?: number;
  mode?: SimulationStrategyMode;
  iterations?: number;
  candidateCommand?: string;
  historical?: boolean;
  withdrawalRule?: WithdrawalRule;
  dataPath?: string;
  json?: boolean;
  compareOutputLevels?: boolean;
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--trials' && next) {
      options.trials = Number(next);
      index += 1;
    } else if (arg === '--mode' && next) {
      if (next !== 'planner_enhanced' && next !== 'raw_simulation') {
        throw new Error(`Unsupported --mode ${next}`);
      }
      options.mode = next;
      index += 1;
    } else if (arg === '--iterations' && next) {
      options.iterations = Number(next);
      index += 1;
    } else if (arg === '--candidate-command' && next) {
      options.candidateCommand = next;
      index += 1;
    } else if (arg === '--historical') {
      options.historical = true;
    } else if (arg === '--withdrawal-rule' && next) {
      if (
        next !== 'tax_bracket_waterfall' &&
        next !== 'reverse_waterfall' &&
        next !== 'proportional' &&
        next !== 'guyton_klinger'
      ) {
        throw new Error(`Unsupported --withdrawal-rule ${next}`);
      }
      options.withdrawalRule = next;
      index += 1;
    } else if (arg === '--data' && next) {
      options.dataPath = next;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--compare-output-levels') {
      options.compareOutputLevels = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run engine:benchmark -- --trials 1000 --mode planner_enhanced --iterations 5

Options:
  --trials <n>                  Simulation trial count. Defaults to 1000.
  --mode <planner_enhanced|raw_simulation>
  --iterations <n>              Warm-process candidate iterations. Defaults to 5.
  --candidate-command <command> Persistent command. Defaults to release Rust --stdio-loop.
  --historical                  Use historical bootstrap mode.
  --withdrawal-rule <rule>      tax_bracket_waterfall, reverse_waterfall, proportional, or guyton_klinger.
  --data <path>                 Read SeedData JSON from a file.
  --compare-output-levels       Benchmark Rust full_trace and policy_mining_summary responses.
  --json                        Print machine-readable report JSON.`);
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.floor((sorted.length - 1) * fraction);
  return sorted[index] ?? 0;
}

function timingReport(times: number[]) {
  return {
    average: average(times),
    min: Math.min(...times),
    p50: percentile(times, 0.5),
    max: Math.max(...times),
    samples: times,
  };
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const data = options.dataPath
    ? JSON.parse(readFileSync(resolve(options.dataPath), 'utf8')) as SeedData
    : undefined;
  const reference = runEngineReference({
    data,
    trials: options.trials ?? 1000,
    mode: options.mode ?? 'planner_enhanced',
    assumptions: options.withdrawalRule
      ? { withdrawalRule: options.withdrawalRule }
      : undefined,
    useHistoricalBootstrap: options.historical,
    recordTape: true,
  });
  const request = buildEngineCandidateRequest(reference);
  const command = options.candidateCommand ?? DEFAULT_RUST_ENGINE_COMMAND;
  const client = new RustEngineClient({ command });

  const iterations = Math.max(1, Math.floor(options.iterations ?? 5));
  const fullTraceTimes: number[] = [];
  const summaryOnlyTimes: number[] = [];
  const fullTraceBytes: number[] = [];
  const summaryOnlyBytes: number[] = [];
  let checkedFields = 0;
  const referenceSummary = pathToPolicyMiningSummary(reference.path);
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    const parsed = await client.runCandidateRequest(request);
    const elapsed = performance.now() - start;
    if (!parsed.path) {
      throw new Error('engine:benchmark requires a full_trace candidate path');
    }
    const comparison = comparePathResults(reference.path, parsed.path);
    if (!comparison.pass) {
      throw new Error(`candidate parity failed: ${JSON.stringify(comparison.firstDifference)}`);
    }
    checkedFields = comparison.checkedFields;
    fullTraceTimes.push(elapsed);
    fullTraceBytes.push(JSON.stringify(parsed).length);

    if (options.compareOutputLevels) {
      const summaryStart = performance.now();
      const summaryResponse = await client.runCandidateRequest({
        ...request,
        outputLevel: 'policy_mining_summary',
      });
      const summaryElapsed = performance.now() - summaryStart;
      if (!summaryResponse.summary) {
        throw new Error('summary-only benchmark response is missing summary');
      }
      const summaryComparison = comparePolicyMiningSummaries(
        referenceSummary,
        summaryResponse.summary,
      );
      if (!summaryComparison.pass) {
        throw new Error(
          `summary-only parity failed: ${JSON.stringify(summaryComparison.firstDifference)}`,
        );
      }
      summaryOnlyTimes.push(summaryElapsed);
      summaryOnlyBytes.push(JSON.stringify(summaryResponse).length);
    }
  }

  await client.close();

  const report = {
    pass: true,
    command,
    mode: reference.mode,
    trials: reference.assumptions.simulationRuns,
    historical: Boolean(options.historical),
    withdrawalRule: options.withdrawalRule ?? 'tax_bracket_waterfall',
    iterations,
    checkedFields,
    referenceRuntimeMs: reference.runtimeMs,
    candidateWarmMs: timingReport(fullTraceTimes),
    fullTraceResponseBytes: timingReport(fullTraceBytes),
    summaryOnlyWarmMs: options.compareOutputLevels
      ? timingReport(summaryOnlyTimes)
      : null,
    summaryOnlyResponseBytes: options.compareOutputLevels
      ? timingReport(summaryOnlyBytes)
      : null,
    summaryOnlySpeedup:
      options.compareOutputLevels && summaryOnlyTimes.length > 0
        ? average(fullTraceTimes) / average(summaryOnlyTimes)
        : null,
    summaryOnlyByteReduction:
      options.compareOutputLevels && summaryOnlyBytes.length > 0
        ? 1 - average(summaryOnlyBytes) / average(fullTraceBytes)
        : null,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('engine:benchmark pass=true');
    console.log(
      `mode=${report.mode} trials=${report.trials} iterations=${iterations} historical=${report.historical}`,
    );
    console.log(`candidate=${command}`);
    console.log(
      `reference=${report.referenceRuntimeMs.toFixed(1)}ms warmCandidateAvg=${report.candidateWarmMs.average.toFixed(1)}ms min=${report.candidateWarmMs.min.toFixed(1)}ms max=${report.candidateWarmMs.max.toFixed(1)}ms checked=${checkedFields}`,
    );
    console.log(
      `fullTraceBytesAvg=${Math.round(report.fullTraceResponseBytes.average).toLocaleString()}`,
    );
    if (report.summaryOnlyWarmMs && report.summaryOnlyResponseBytes) {
      console.log(
        `summaryOnlyAvg=${report.summaryOnlyWarmMs.average.toFixed(1)}ms min=${report.summaryOnlyWarmMs.min.toFixed(1)}ms max=${report.summaryOnlyWarmMs.max.toFixed(1)}ms bytesAvg=${Math.round(report.summaryOnlyResponseBytes.average).toLocaleString()} speedup=${report.summaryOnlySpeedup?.toFixed(2)}x byteReduction=${((report.summaryOnlyByteReduction ?? 0) * 100).toFixed(1)}%`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
