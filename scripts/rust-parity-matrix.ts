import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

type Runtime =
  | 'rust-shadow'
  | 'rust-dry-run'
  | 'rust-native-shadow'
  | 'rust-native-compact-shadow';
type Mode = 'parametric' | 'historical';

interface CliOptions {
  policies: number;
  trials: number;
  workers: number;
  logDir: string;
  json: boolean;
}

interface SmokeReport {
  pass: boolean;
  runtimeError: string | null;
  mode: Mode;
  runtime: Runtime;
  policiesRequested: number;
  policiesEvaluated: number;
  trials: number;
  workers: number;
  durationMs: number;
  eventLogPath: string;
  shadowEvents: number;
  resultEvents: number;
  mismatches: number;
  errors: number;
  skipped: number;
  workerShadowStats?: unknown;
}

const DEFAULT_LOG_DIR = 'out/rust-parity-matrix';

function printHelp() {
  console.log(`Usage:
  npm run engine:rust-parity:matrix
  npm run engine:rust-parity:matrix -- --policies 160 --trials 80 --workers 2

Options:
  --policies <n>       Number of representative policies per cell. Defaults to 8.
  --trials <n>         Trial count per policy. Defaults to 40.
  --workers <n>        Node worker thread count. Defaults to 1.
  --log-dir <path>     Directory for retained JSONL logs and report JSON.
  --json               Print machine-readable matrix report.`);
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    policies: 8,
    trials: 40,
    workers: 1,
    logDir: DEFAULT_LOG_DIR,
    json: false,
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
    } else if (arg === '--log-dir' && next) {
      options.logDir = next;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
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

function matrixId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseSmokeReport(stdout: string): SmokeReport {
  const lines = stdout.trimEnd().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate) as SmokeReport;
    } catch {
      // Keep scanning upward until the pretty-printed JSON object is whole.
    }
  }
  throw new Error(`unable to parse smoke report from stdout:\n${stdout}`);
}

function runCell(input: {
  runtime: Runtime;
  mode: Mode;
  options: CliOptions;
  id: string;
}) {
  const logPath = resolve(
    input.options.logDir,
    `${input.id}-${input.runtime}-${input.mode}-${input.options.policies}x${input.options.trials}.jsonl`,
  );
  const args = [
    '--import',
    'tsx',
    'scripts/rust-shadow-smoke.ts',
    '--runtime',
    input.runtime,
    '--policies',
    String(input.options.policies),
    '--trials',
    String(input.options.trials),
    '--workers',
    String(input.options.workers),
    '--log',
    logPath,
    '--json',
    '--fail-on-mismatch',
  ];
  if (input.mode === 'historical') {
    args.push('--historical');
  }
  const startedAt = Date.now();
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';
  const report = child.status === 0 ? parseSmokeReport(stdout) : null;
  return {
    pass: child.status === 0 && report?.pass === true,
    runtime: input.runtime,
    mode: input.mode,
    status: child.status,
    signal: child.signal,
    durationMs: Date.now() - startedAt,
    logPath,
    report,
    stdout,
    stderr,
  };
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const logDir = resolve(options.logDir);
  mkdirSync(logDir, { recursive: true });
  options.logDir = logDir;
  const id = matrixId();
  const cells: Array<{ runtime: Runtime; mode: Mode }> = [
    { runtime: 'rust-shadow', mode: 'parametric' },
    { runtime: 'rust-shadow', mode: 'historical' },
    { runtime: 'rust-native-shadow', mode: 'parametric' },
    { runtime: 'rust-native-shadow', mode: 'historical' },
    { runtime: 'rust-native-compact-shadow', mode: 'parametric' },
    { runtime: 'rust-native-compact-shadow', mode: 'historical' },
    { runtime: 'rust-dry-run', mode: 'parametric' },
    { runtime: 'rust-dry-run', mode: 'historical' },
  ];
  const startedAt = Date.now();
  const results = cells.map((cell) => runCell({ ...cell, options, id }));
  const report = {
    pass: results.every((result) => result.pass),
    matrixId: id,
    policies: options.policies,
    trials: options.trials,
    workers: options.workers,
    durationMs: Date.now() - startedAt,
    logDir,
    results,
  };
  const reportPath = resolve(logDir, `${id}-report.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (options.json) {
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  } else {
    console.log(
      `rust-parity:matrix pass=${report.pass} policies=${report.policies} trials=${report.trials} workers=${report.workers}`,
    );
    for (const result of results) {
      console.log(
        `${result.runtime}/${result.mode}: pass=${result.pass} mismatches=${result.report?.mismatches ?? 'n/a'} errors=${result.report?.errors ?? 'n/a'} skipped=${result.report?.skipped ?? 'n/a'} log=${result.logPath}`,
      );
      if (!result.pass && result.stderr.trim()) {
        console.log(result.stderr.trim());
      }
    }
    console.log(`report=${reportPath}`);
  }

  process.exit(report.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
