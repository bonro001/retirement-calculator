import { hostname } from 'node:os';
import { initialSeedData } from '../src/data';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
} from '../src/policy-axis-enumerator';
import {
  evaluatePolicyFullTrace,
  evaluatePolicyWithSummary,
} from '../src/policy-miner-eval';
import {
  comparePolicyMiningSummaries,
  pathToPolicyMiningSummary,
} from '../src/policy-mining-summary-contract';
import type { MarketAssumptions, SeedData } from '../src/types';

interface CliArgs {
  policyCount: number;
  trialCount: number;
  json: boolean;
  historical: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    policyCount: 20,
    trialCount: 200,
    json: false,
    historical: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--policies' && next) {
      args.policyCount = Number(next);
      index += 1;
    } else if (arg === '--trials' && next) {
      args.trialCount = Number(next);
      index += 1;
    } else if (arg === '--historical') {
      args.historical = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node --import tsx scripts/policy-miner-corpus-benchmark.ts [--policies N] [--trials N] [--historical] [--json]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  args.policyCount = Math.max(1, Math.floor(args.policyCount));
  args.trialCount = Math.max(1, Math.floor(args.trialCount));
  return args;
}

function cloneSeedData(seed: SeedData): SeedData {
  return structuredClone(seed);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function timingReport(samples: number[]) {
  return {
    averageMs: average(samples),
    minMs: Math.min(...samples),
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
    samples,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const assumptions: MarketAssumptions = {
    equityMean: 0.074,
    equityVolatility: 0.16,
    internationalEquityMean: 0.074,
    internationalEquityVolatility: 0.18,
    bondMean: 0.038,
    bondVolatility: 0.07,
    cashMean: 0.02,
    cashVolatility: 0.01,
    inflation: 0.028,
    inflationVolatility: 0.01,
    simulationRuns: args.trialCount,
    irmaaThreshold: 200000,
    guardrailFloorYears: 12,
    guardrailCeilingYears: 18,
    guardrailCutPercent: 0.2,
    robPlanningEndAge: 90,
    debbiePlanningEndAge: 95,
    travelPhaseYears: 10,
    simulationSeed: 20260417,
    assumptionsVersion: 'policy-miner-corpus-benchmark-v1',
    useHistoricalBootstrap: args.historical,
  };

  const axes = buildDefaultPolicyAxes(initialSeedData);
  const allPolicies = enumeratePolicies(axes);
  const stride = Math.max(1, Math.floor(allPolicies.length / args.policyCount));
  const policies = [];
  for (
    let index = 0;
    policies.length < args.policyCount && index < allPolicies.length;
    index += stride
  ) {
    policies.push(allPolicies[index]);
  }

  const summaryOnlyMs: number[] = [];
  const fullTraceMs: number[] = [];
  const WARMUP = Math.min(2, Math.max(1, Math.floor(policies.length / 10)));
  const wallStart = performance.now();

  for (let index = 0; index < policies.length; index += 1) {
    const policy = policies[index];

    const summaryStart = performance.now();
    const summaryPackage = await evaluatePolicyWithSummary(
      policy,
      initialSeedData,
      assumptions,
      'policy-miner-corpus-benchmark',
      'policy-miner-corpus-benchmark-engine',
      'benchmark-host',
      cloneSeedData,
      initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000,
    );
    const summaryElapsed = performance.now() - summaryStart;

    const fullTraceStart = performance.now();
    const fullTracePath = evaluatePolicyFullTrace(
      policy,
      initialSeedData,
      assumptions,
      cloneSeedData,
    );
    const fullTraceElapsed = performance.now() - fullTraceStart;

    const comparison = comparePolicyMiningSummaries(
      pathToPolicyMiningSummary(fullTracePath),
      summaryPackage.summary,
    );
    if (!comparison.pass) {
      throw new Error(
        `summary-only/full-trace mismatch for policy ${index}: ${JSON.stringify(
          comparison.firstDifference,
        )}`,
      );
    }

    if (index >= WARMUP) {
      summaryOnlyMs.push(summaryElapsed);
      fullTraceMs.push(fullTraceElapsed);
    }
  }

  const measuredPolicies = summaryOnlyMs.length;
  const summaryAverage = average(summaryOnlyMs);
  const fullAverage = average(fullTraceMs);
  const corpusSize = allPolicies.length;
  const report = {
    pass: true,
    host: hostname(),
    nodeVersion: process.version,
    historical: args.historical,
    corpusSize,
    measuredPolicies,
    warmupPolicies: WARMUP,
    trials: args.trialCount,
    wallMs: performance.now() - wallStart,
    summaryOnly: timingReport(summaryOnlyMs),
    fullTraceRerun: timingReport(fullTraceMs),
    speedupVsFullTrace: fullAverage > 0 ? fullAverage / summaryAverage : 0,
    projectedCorpusMinutes: {
      summaryOnlySingleThread: (corpusSize * summaryAverage) / 1000 / 60,
      fullTraceSingleThread: (corpusSize * fullAverage) / 1000 / 60,
      summaryOnlyEightWorkers: (corpusSize * summaryAverage) / 1000 / 60 / 8,
      fullTraceEightWorkers: (corpusSize * fullAverage) / 1000 / 60 / 8,
    },
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      'policy-miner corpus benchmark pass=true',
      `host=${report.host} node=${report.nodeVersion} policies=${measuredPolicies} trials=${args.trialCount} historical=${args.historical}`,
      `summaryOnlyAvg=${summaryAverage.toFixed(1)}ms p95=${report.summaryOnly.p95Ms.toFixed(1)}ms`,
      `fullTraceAvg=${fullAverage.toFixed(1)}ms p95=${report.fullTraceRerun.p95Ms.toFixed(1)}ms`,
      `speedupVsFullTrace=${report.speedupVsFullTrace.toFixed(2)}x`,
      `projectedCorpusSingleThread=${report.projectedCorpusMinutes.summaryOnlySingleThread.toFixed(1)}min summary-only vs ${report.projectedCorpusMinutes.fullTraceSingleThread.toFixed(1)}min full-trace`,
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
