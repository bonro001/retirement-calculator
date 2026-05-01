import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { initialSeedData } from '../src/data';
import { DEFAULT_ENGINE_COMPARE_ASSUMPTIONS } from '../src/engine-compare';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
} from '../src/policy-axis-enumerator';
import {
  POLICY_MINER_ENGINE_VERSION,
  type Policy,
  type PolicyMinerShadowStats,
} from '../src/policy-miner-types';
import type { MarketAssumptions, WithdrawalRule } from '../src/types';

interface CliOptions {
  policies: number;
  trials: number;
  workers: number;
  historical: boolean;
  runtime:
    | 'ts'
    | 'rust-shadow'
    | 'rust-dry-run'
    | 'rust-native-shadow'
    | 'rust-native-compact-shadow'
    | 'rust-native-compact';
  logPath: string;
  json: boolean;
  failOnMismatch: boolean;
}

interface ShadowEvent {
  event?: string;
  policyId?: string;
  firstDifference?: {
    field?: string;
  };
  comparison?: {
    pass?: boolean;
    firstDifference?: {
      field?: string;
    } | null;
  };
}

const DEFAULT_LOG_PATH = 'out/rust-shadow-smoke.jsonl';

function printHelp() {
  console.log(`Usage:
  npm run engine:rust-shadow:smoke
  npm run engine:rust-shadow:smoke -- --policies 48 --trials 80 --historical --log out/rust-shadow-historical.jsonl

Options:
  --policies <n>       Number of representative policies. Defaults to 4.
  --trials <n>         Trial count per policy. Defaults to 40.
  --workers <n>        Node worker thread count. Defaults to 1.
  --historical         Use historical bootstrap mode.
  --runtime <name>     ts, rust-shadow, rust-dry-run, rust-native-shadow, rust-native-compact-shadow, or rust-native-compact. Defaults to rust-shadow.
  --log <path>         JSONL shadow-event log. Defaults to out/rust-shadow-smoke.jsonl.
  --fail-on-mismatch   Exit nonzero if Rust shadow mismatches TS.
  --json               Print machine-readable summary JSON.`);
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    policies: 4,
    trials: 40,
    workers: 1,
    historical: false,
    runtime: 'rust-shadow',
    logPath: DEFAULT_LOG_PATH,
    json: false,
    failOnMismatch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--policies' && next) {
      options.policies = Number(next);
      index += 1;
    } else if (arg === '--trials' && next) {
      options.trials = Number(next);
      index += 1;
    } else if (arg === '--workers' && next) {
      options.workers = Number(next);
      index += 1;
    } else if (arg === '--historical') {
      options.historical = true;
    } else if (arg === '--runtime' && next) {
      if (
        next !== 'ts' &&
        next !== 'rust-shadow' &&
        next !== 'rust-dry-run' &&
        next !== 'rust-native-shadow' &&
        next !== 'rust-native-compact-shadow' &&
        next !== 'rust-native-compact'
      ) {
        throw new Error(`Unsupported runtime ${next}`);
      }
      options.runtime = next;
      if (options.logPath === DEFAULT_LOG_PATH && next === 'rust-dry-run') {
        options.logPath = 'out/rust-dry-run-smoke.jsonl';
      } else if (
        options.logPath === DEFAULT_LOG_PATH &&
        next === 'rust-native-shadow'
      ) {
        options.logPath = 'out/rust-native-shadow-smoke.jsonl';
      } else if (
        options.logPath === DEFAULT_LOG_PATH &&
        next === 'rust-native-compact-shadow'
      ) {
        options.logPath = 'out/rust-native-compact-shadow-smoke.jsonl';
      } else if (
        options.logPath === DEFAULT_LOG_PATH &&
        next === 'rust-native-compact'
      ) {
        options.logPath = 'out/rust-native-compact-smoke.jsonl';
      }
      index += 1;
    } else if (arg === '--log' && next) {
      options.logPath = next;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--fail-on-mismatch') {
      options.failOnMismatch = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  options.policies = Math.max(1, Math.floor(options.policies));
  options.trials = Math.max(1, Math.floor(options.trials));
  options.workers = Math.max(1, Math.floor(options.workers));
  return options;
}

function nearest(values: number[], target: number) {
  return values.reduce((best, value) =>
    Math.abs(value - target) < Math.abs(best - target) ? value : best,
  );
}

function uniqueNumbers(values: number[]) {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function representativePolicies(limit: number): Policy[] {
  const axes = buildDefaultPolicyAxes(initialSeedData);
  const spends = uniqueNumbers([
    Math.min(...axes.annualSpendTodayDollars),
    nearest(axes.annualSpendTodayDollars, 120_000),
    Math.max(...axes.annualSpendTodayDollars),
  ]);
  const primaryAges = uniqueNumbers([
    Math.min(...axes.primarySocialSecurityClaimAge),
    nearest(axes.primarySocialSecurityClaimAge, 67.5),
    Math.max(...axes.primarySocialSecurityClaimAge),
  ]);
  const spouseAxis = axes.spouseSocialSecurityClaimAge ?? [null];
  const spouseAges = spouseAxis === null
    ? [null]
    : [
        Math.min(...spouseAxis),
        nearest(spouseAxis, 67.5),
        Math.max(...spouseAxis),
      ];
  const rothCaps = uniqueNumbers([
    Math.min(...axes.rothConversionAnnualCeiling),
    nearest(axes.rothConversionAnnualCeiling, 120_000),
    Math.max(...axes.rothConversionAnnualCeiling),
  ]);
  const withdrawalRules =
    axes.withdrawalRule ?? (['tax_bracket_waterfall'] satisfies WithdrawalRule[]);

  const grid: Policy[] = [];
  for (const rule of withdrawalRules) {
    for (const spend of spends) {
      for (const roth of rothCaps) {
        for (const primary of primaryAges) {
          for (const spouse of spouseAges) {
            grid.push({
              annualSpendTodayDollars: spend,
              primarySocialSecurityClaimAge: primary,
              spouseSocialSecurityClaimAge: spouse,
              rothConversionAnnualCeiling: roth,
              withdrawalRule: rule,
            });
          }
        }
      }
    }
  }

  if (limit >= grid.length) {
    return grid;
  }
  const selected = new Map<string, Policy>();
  for (let index = 0; index < limit; index += 1) {
    const gridIndex = Math.floor((index * grid.length) / limit);
    const policy = grid[Math.min(grid.length - 1, gridIndex)];
    selected.set(JSON.stringify(policy), policy);
  }

  if (selected.size < limit) {
    for (const policy of enumeratePolicies(axes)) {
      selected.set(JSON.stringify(policy), policy);
      if (selected.size >= limit) break;
    }
  }
  return Array.from(selected.values()).slice(0, limit);
}

function summarizePolicies(policies: Policy[]) {
  return {
    spendLevels: new Set(policies.map((policy) => policy.annualSpendTodayDollars))
      .size,
    primaryClaimAges: new Set(
      policies.map((policy) => policy.primarySocialSecurityClaimAge),
    ).size,
    spouseClaimAges: new Set(
      policies.map((policy) => policy.spouseSocialSecurityClaimAge),
    ).size,
    rothCaps: new Set(
      policies.map((policy) => policy.rothConversionAnnualCeiling),
    ).size,
    withdrawalRules: new Set(
      policies.map((policy) => policy.withdrawalRule ?? 'tax_bracket_waterfall'),
    ).size,
  };
}

function readShadowEvents(path: string): ShadowEvent[] {
  try {
    const content = readFileSync(resolve(path), 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line) as ShadowEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function isMismatchEvent(event: ShadowEvent) {
  return (
    event.event === 'rust_shadow_summary_mismatch' ||
    (event.event === 'rust_dry_run_result' && event.comparison?.pass === false)
  );
}

function mismatchField(event: ShadowEvent) {
  return (
    event.firstDifference?.field ??
    event.comparison?.firstDifference?.field ??
    'unknown'
  );
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const logPath = resolve(options.logPath);
  mkdirSync(dirname(logPath), { recursive: true });
  rmSync(logPath, { force: true });

  process.env.ENGINE_RUNTIME = options.runtime;
  if (options.runtime === 'rust-dry-run') {
    process.env.RUST_DRY_RUN_OUTPUT_PATH = logPath;
    delete process.env.RUST_SHADOW_LOG_PATH;
  } else if (
    options.runtime === 'rust-shadow' ||
    options.runtime === 'rust-native-shadow' ||
    options.runtime === 'rust-native-compact-shadow'
  ) {
    process.env.RUST_SHADOW_LOG_PATH = logPath;
    delete process.env.RUST_DRY_RUN_OUTPUT_PATH;
  } else {
    delete process.env.RUST_SHADOW_LOG_PATH;
    delete process.env.RUST_DRY_RUN_OUTPUT_PATH;
  }
  process.env.HOST_WORKERS = String(options.workers);

  const {
    HOST_WORKER_COUNT,
    freeSlotCount,
    primeAllSlotsForSession,
    runBatchOnPool,
    shutdownPool,
    spawnPool,
  } = await import('../cluster/host');

  const assumptions: MarketAssumptions = {
    ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
    simulationRuns: options.trials,
    useHistoricalBootstrap: options.historical,
    assumptionsVersion: options.historical
      ? 'rust-shadow-smoke-historical'
      : 'rust-shadow-smoke-parametric',
  };
  const policies = representativePolicies(options.policies);
  const startMs = Date.now();
  let runtimeError: string | null = null;
  let evaluations = 0;
  let workerShadowStats: PolicyMinerShadowStats | undefined;

  try {
    spawnPool();
    primeAllSlotsForSession(
      'rust-shadow-smoke',
      initialSeedData,
      assumptions,
      'rust-shadow-smoke-baseline',
      POLICY_MINER_ENGINE_VERSION,
      'rust-shadow-smoke',
      1_000_000,
    );
    const run = await runBatchOnPool(
      'rust-shadow-smoke',
      'rust-shadow-smoke-batch',
      policies,
    );
    const results = run.evaluations;
    workerShadowStats = run.shadowStats;
    evaluations = results.length;
    if (results.length !== policies.length) {
      throw new Error(
        `evaluation count mismatch: got ${results.length}, expected ${policies.length}`,
      );
    }
    for (const result of results) {
      if (
        result.outcome.solventSuccessRate < 0 ||
        result.outcome.solventSuccessRate > 1 ||
        !Number.isFinite(result.outcome.p50EndingWealthTodayDollars)
      ) {
        throw new Error(`invalid policy evaluation shape: ${result.id}`);
      }
    }
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  } finally {
    await shutdownPool();
  }

  const events = readShadowEvents(logPath);
  const mismatches = events.filter(isMismatchEvent);
  const errors = events.filter(
    (event) =>
      event.event === 'rust_shadow_error' ||
      event.event === 'rust_dry_run_error',
  );
  const skipped = events.filter(
    (event) =>
      event.event === 'rust_shadow_skipped' ||
      event.event === 'rust_dry_run_skipped',
  );
  const mismatchFields = countBy(mismatches.map((event) => mismatchField(event)));
  const resultEvents = events.filter(
    (event) => event.event === 'rust_dry_run_result',
  );
  const report = {
    pass:
      runtimeError === null &&
      errors.length === 0 &&
      (!options.failOnMismatch || mismatches.length === 0),
    runtimeError,
    mode: options.historical ? 'historical' : 'parametric',
    runtime: options.runtime,
    policiesRequested: options.policies,
    policiesEvaluated: evaluations,
    trials: options.trials,
    workers: HOST_WORKER_COUNT,
    freeSlots: freeSlotCount(),
    durationMs: Date.now() - startMs,
    shadowLogPath: logPath,
    eventLogPath: logPath,
    shadowEvents: events.length,
    resultEvents: resultEvents.length,
    mismatches: mismatches.length,
    errors: errors.length,
    skipped: skipped.length,
    mismatchFields,
    policyCoverage: summarizePolicies(policies),
    workerShadowStats,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `rust-shadow:smoke pass=${report.pass} runtime=${report.runtime} mode=${report.mode} policies=${report.policiesEvaluated}/${report.policiesRequested} trials=${report.trials}`,
    );
    console.log(
      `events=${report.shadowEvents} results=${report.resultEvents} mismatches=${report.mismatches} errors=${report.errors} skipped=${report.skipped}`,
    );
    console.log(`coverage=${JSON.stringify(report.policyCoverage)}`);
    console.log(`log=${report.shadowLogPath}`);
    if (Object.keys(report.mismatchFields).length > 0) {
      console.log(`mismatchFields=${JSON.stringify(report.mismatchFields)}`);
    }
    if (runtimeError) {
      console.log(`runtimeError=${runtimeError}`);
    }
  }
  process.exit(report.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
