import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

type Runtime =
  | 'ts'
  | 'rust-shadow'
  | 'rust-native-shadow'
  | 'rust-native-compact-shadow'
  | 'rust-native-compact';
type Mode = 'parametric' | 'historical';

interface CliOptions {
  policies: number;
  trials: number;
  workers: number;
  logDir: string;
  json: boolean;
  historicalOnly: boolean;
  parametricOnly: boolean;
  disableTapeCache: boolean;
  minCompactSpeedup: number | null;
  minTapeCacheHitRate: number | null;
  minPackCacheHitRate: number | null;
}

interface SmokeReport {
  pass: boolean;
  runtimeError: string | null;
  mode: Mode;
  runtime: Runtime;
  policiesEvaluated: number;
  trials: number;
  durationMs: number;
  mismatches: number;
  errors: number;
  workerShadowStats?: {
    timings?: {
      tsEvaluationDurationMsTotal?: number;
      rustTotalDurationMsTotal?: number;
      rustIpcWriteDurationMsTotal?: number;
      candidateRequestBytesTotal?: number;
      candidateRequestDataBytesTotal?: number;
      candidateRequestAssumptionsBytesTotal?: number;
      candidateRequestTapeBytesTotal?: number;
      candidateRequestTapeBytesSavedTotal?: number;
      candidateRequestEnvelopeBytesTotal?: number;
      rustResponseBytesTotal?: number;
      tapeCacheHitRate?: number;
      compactTapeCacheHitRate?: number;
    };
  };
}

interface CompactResultSummary {
  mode: Mode;
  wallMs: number;
  speedupVsTs: number | null;
  requestBytes: number | null;
  tapeBytes: number | null;
  tapeBytesSaved: number | null;
  tapeShare: number | null;
  tapeCacheHitRate: number | null;
  compactTapeCacheHitRate: number | null;
  mismatches: number | null;
}

const DEFAULT_LOG_DIR = 'out/rust-runtime-benchmark';

function printHelp() {
  console.log(`Usage:
  npm run engine:rust-runtime:benchmark
  npm run engine:rust-runtime:benchmark -- --policies 50 --trials 200 --workers 1

Options:
  --policies <n>       Number of representative policies per cell. Defaults to 50.
  --trials <n>         Trial count per policy. Defaults to 200.
  --workers <n>        Node worker thread count. Defaults to 1.
  --historical         Run historical mode only.
  --parametric         Run parametric mode only.
  --disable-tape-cache Disable authoritative replay tape caching.
  --min-compact-speedup <n>
                       Fail unless rust-native-compact is at least n× faster than ts.
  --min-tape-cache-hit-rate <n>
                       Fail unless rust-native-compact tape cache hit rate is at least n.
                       Accepts fractions (0.8) or percents (80).
  --min-pack-cache-hit-rate <n>
                       Fail unless rust-native-compact packed tape cache hit rate is at least n.
                       Accepts fractions (0.8) or percents (80).
  --log-dir <path>     Directory for retained JSONL logs and report JSON.
  --json               Print machine-readable report.`);
}

function parseRate(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid rate ${raw}`);
  }
  return value > 1 ? value / 100 : value;
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    policies: 50,
    trials: 200,
    workers: 1,
    logDir: DEFAULT_LOG_DIR,
    json: false,
    historicalOnly: false,
    parametricOnly: false,
    disableTapeCache: false,
    minCompactSpeedup: null,
    minTapeCacheHitRate: null,
    minPackCacheHitRate: null,
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
      options.historicalOnly = true;
    } else if (arg === '--parametric') {
      options.parametricOnly = true;
    } else if (arg === '--disable-tape-cache') {
      options.disableTapeCache = true;
    } else if (arg === '--min-compact-speedup' && next) {
      options.minCompactSpeedup = Number(next);
      index += 1;
    } else if (arg === '--min-tape-cache-hit-rate' && next) {
      options.minTapeCacheHitRate = parseRate(next);
      index += 1;
    } else if (arg === '--min-pack-cache-hit-rate' && next) {
      options.minPackCacheHitRate = parseRate(next);
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
  if (options.historicalOnly && options.parametricOnly) {
    throw new Error('Choose at most one of --historical or --parametric');
  }
  options.policies = Math.max(1, Math.floor(options.policies));
  options.trials = Math.max(1, Math.floor(options.trials));
  options.workers = Math.max(1, Math.floor(options.workers));
  if (
    options.minCompactSpeedup !== null &&
    (!Number.isFinite(options.minCompactSpeedup) || options.minCompactSpeedup <= 0)
  ) {
    throw new Error('--min-compact-speedup must be greater than zero');
  }
  for (const [name, value] of [
    ['--min-tape-cache-hit-rate', options.minTapeCacheHitRate],
    ['--min-pack-cache-hit-rate', options.minPackCacheHitRate],
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`${name} must be between 0 and 1, or between 0 and 100`);
    }
  }
  return options;
}

function benchmarkId() {
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
      // Continue until the complete pretty-printed JSON object is included.
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
    env: {
      ...process.env,
      ...(input.options.disableTapeCache
        ? { ENGINE_REPLAY_TAPE_CACHE: '0' }
        : {}),
    },
  });
  const stdout = child.stdout ?? '';
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
    stderr: child.stderr ?? '',
  };
}

function formatMs(value: number | undefined) {
  return typeof value === 'number' ? `${(value / 1000).toFixed(2)}s` : 'n/a';
}

function formatMb(value: number | undefined) {
  return typeof value === 'number' ? `${(value / 1_000_000).toFixed(1)}MB` : 'n/a';
}

function formatSpeedup(value: number | undefined) {
  if (!Number.isFinite(value) || typeof value !== 'number' || value <= 0) return 'n/a';
  return `${value.toFixed(2)}x`;
}

function formatSpeedupDelta(value: number | undefined) {
  if (!Number.isFinite(value) || typeof value !== 'number') return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}x`;
}

function formatPercent(value: number | undefined) {
  if (!Number.isFinite(value) || typeof value !== 'number') return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function largestRequestSection(timings: NonNullable<SmokeReport['workerShadowStats']>['timings']) {
  if (!timings) return 'n/a';
  const sections = [
    ['data', timings.candidateRequestDataBytesTotal],
    ['assumptions', timings.candidateRequestAssumptionsBytesTotal],
    ['tape', timings.candidateRequestTapeBytesTotal],
    ['envelope', timings.candidateRequestEnvelopeBytesTotal],
  ] as const;
  const present = sections.flatMap(([name, bytes]) =>
    typeof bytes === 'number' ? [{ name, bytes }] : [],
  );
  if (present.length === 0) return 'n/a';
  const { name, bytes } = present.reduce((largest, section) =>
    section.bytes > largest.bytes ? section : largest,
  );
  const total = timings.candidateRequestBytesTotal ?? 0;
  const share = total > 0 ? ` ${(bytes / total * 100).toFixed(1)}%` : '';
  return `${name} ${formatMb(bytes)}${share}`;
}

function resultWallMs(result: ReturnType<typeof runCell>) {
  return result.report?.durationMs ?? result.durationMs;
}

function speedupVsTs(input: {
  result: ReturnType<typeof runCell>;
  tsWallByMode: Map<Mode, number>;
}) {
  const wallMs = resultWallMs(input.result);
  const tsWallMs = input.tsWallByMode.get(input.result.mode);
  return typeof tsWallMs === 'number' && wallMs > 0 ? tsWallMs / wallMs : null;
}

function buildTsWallByMode(results: Array<ReturnType<typeof runCell>>) {
  const tsWallByMode = new Map<Mode, number>();
  for (const result of results) {
    if (result.runtime === 'ts') {
      tsWallByMode.set(result.mode, resultWallMs(result));
    }
  }
  return tsWallByMode;
}

function buildGuardFailures(input: {
  results: Array<ReturnType<typeof runCell>>;
  options: CliOptions;
  tsWallByMode: Map<Mode, number>;
}) {
  const failures: string[] = [];
  for (const result of input.results) {
    if (result.runtime !== 'rust-native-compact') continue;
    const timings = result.report?.workerShadowStats?.timings;
    const speedup = speedupVsTs({ result, tsWallByMode: input.tsWallByMode });
    if (
      input.options.minCompactSpeedup !== null &&
      (speedup === null || speedup < input.options.minCompactSpeedup)
    ) {
      failures.push(
        `${result.mode}/rust-native-compact speedup ${formatSpeedup(speedup ?? undefined)} is below ${input.options.minCompactSpeedup.toFixed(2)}x`,
      );
    }
    if (
      input.options.minTapeCacheHitRate !== null &&
      ((timings?.tapeCacheHitRate ?? -1) < input.options.minTapeCacheHitRate)
    ) {
      failures.push(
        `${result.mode}/rust-native-compact tape cache hit rate ${formatPercent(timings?.tapeCacheHitRate)} is below ${formatPercent(input.options.minTapeCacheHitRate)}`,
      );
    }
    if (
      input.options.minPackCacheHitRate !== null &&
      ((timings?.compactTapeCacheHitRate ?? -1) < input.options.minPackCacheHitRate)
    ) {
      failures.push(
        `${result.mode}/rust-native-compact packed tape cache hit rate ${formatPercent(timings?.compactTapeCacheHitRate)} is below ${formatPercent(input.options.minPackCacheHitRate)}`,
      );
    }
  }
  return failures;
}

function compactResultSummaries(input: {
  results: Array<ReturnType<typeof runCell>>;
  tsWallByMode: Map<Mode, number>;
}): CompactResultSummary[] {
  return input.results.flatMap((result) => {
    if (result.runtime !== 'rust-native-compact') return [];
    const timings = result.report?.workerShadowStats?.timings;
    const requestBytes = timings?.candidateRequestBytesTotal ?? null;
    const tapeBytes = timings?.candidateRequestTapeBytesTotal ?? null;
    const tapeBytesSaved = timings?.candidateRequestTapeBytesSavedTotal ?? null;
    return [{
      mode: result.mode,
      wallMs: resultWallMs(result),
      speedupVsTs: speedupVsTs({ result, tsWallByMode: input.tsWallByMode }),
      requestBytes,
      tapeBytes,
      tapeBytesSaved,
      tapeShare:
        typeof requestBytes === 'number' && requestBytes > 0 &&
        typeof tapeBytes === 'number'
          ? tapeBytes / requestBytes
          : null,
      tapeCacheHitRate: timings?.tapeCacheHitRate ?? null,
      compactTapeCacheHitRate: timings?.compactTapeCacheHitRate ?? null,
      mismatches: result.report?.mismatches ?? null,
    }];
  });
}

function readPreviousCompactSummary(input: {
  logDir: string;
  policies: number;
  trials: number;
  workers: number;
  replayTapeCache: string;
}) {
  try {
    const reports = readdirSync(input.logDir)
      .filter((name) => name.endsWith('-report.json'))
      .sort();
    for (let index = reports.length - 1; index >= 0; index -= 1) {
      const path = resolve(input.logDir, reports[index]);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        policies?: number;
        trials?: number;
        workers?: number;
        replayTapeCache?: string;
        summary?: { compactResults?: CompactResultSummary[] };
      };
      if (
        parsed.policies === input.policies &&
        parsed.trials === input.trials &&
        parsed.workers === input.workers &&
        parsed.replayTapeCache === input.replayTapeCache &&
        Array.isArray(parsed.summary?.compactResults)
      ) {
        return {
          reportPath: path,
          compactResults: parsed.summary.compactResults,
        };
      }
    }
  } catch {
    // Previous summaries are convenience telemetry, not a correctness gate.
  }
  return null;
}

function compactTrend(input: {
  compactResults: CompactResultSummary[];
  previous: ReturnType<typeof readPreviousCompactSummary>;
}) {
  if (!input.previous) return [];
  return input.compactResults.flatMap((current) => {
    const previous = input.previous?.compactResults.find(
      (item) => item.mode === current.mode,
    );
    if (!previous) return [];
    return [{
      mode: current.mode,
      previousSpeedupVsTs: previous.speedupVsTs,
      currentSpeedupVsTs: current.speedupVsTs,
      speedupDelta:
        current.speedupVsTs !== null && previous.speedupVsTs !== null
          ? current.speedupVsTs - previous.speedupVsTs
          : null,
      previousTapeShare: previous.tapeShare,
      currentTapeShare: current.tapeShare,
      tapeShareDelta:
        current.tapeShare !== null && previous.tapeShare !== null
          ? current.tapeShare - previous.tapeShare
          : null,
    }];
  });
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const logDir = resolve(options.logDir);
  mkdirSync(logDir, { recursive: true });
  options.logDir = logDir;
  const id = benchmarkId();
  const modes: Mode[] = options.historicalOnly
    ? ['historical']
    : options.parametricOnly
      ? ['parametric']
      : ['parametric', 'historical'];
  const runtimes: Runtime[] = [
    'ts',
    'rust-shadow',
    'rust-native-shadow',
    'rust-native-compact-shadow',
    'rust-native-compact',
  ];
  const startedAt = Date.now();
  const results = modes.flatMap((mode) =>
    runtimes.map((runtime) => runCell({ runtime, mode, options, id })),
  );
  const tsWallByMode = buildTsWallByMode(results);
  const guardFailures = buildGuardFailures({ results, options, tsWallByMode });
  const compactResults = compactResultSummaries({ results, tsWallByMode });
  const replayTapeCache = options.disableTapeCache ? 'disabled' : 'enabled';
  const previousCompactSummary = readPreviousCompactSummary({
    logDir,
    policies: options.policies,
    trials: options.trials,
    workers: options.workers,
    replayTapeCache,
  });
  const trend = compactTrend({
    compactResults,
    previous: previousCompactSummary,
  });
  const report = {
    pass: results.every((result) => result.pass) && guardFailures.length === 0,
    benchmarkId: id,
    policies: options.policies,
    trials: options.trials,
    workers: options.workers,
    replayTapeCache,
    guards: {
      minCompactSpeedup: options.minCompactSpeedup,
      minTapeCacheHitRate: options.minTapeCacheHitRate,
      minPackCacheHitRate: options.minPackCacheHitRate,
      failures: guardFailures,
    },
    summary: {
      compactResults,
      previousReportPath: previousCompactSummary?.reportPath ?? null,
      trend,
    },
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
      `rust-runtime:benchmark pass=${report.pass} policies=${report.policies} trials=${report.trials} workers=${report.workers} replayTapeCache=${report.replayTapeCache}`,
    );
    console.log('| mode | runtime | wall | vs ts | ts eval | rust total | tape cache | pack cache | ipc write | request | tape saved | largest section | mismatches |');
    console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|');
    for (const result of results) {
      const timings = result.report?.workerShadowStats?.timings;
      const wallMs = resultWallMs(result);
      const speedup = speedupVsTs({ result, tsWallByMode }) ?? undefined;
      console.log(
        `| ${result.mode} | ${result.runtime} | ${formatMs(wallMs)} | ${formatSpeedup(speedup)} | ${formatMs(timings?.tsEvaluationDurationMsTotal)} | ${formatMs(timings?.rustTotalDurationMsTotal)} | ${formatPercent(timings?.tapeCacheHitRate)} | ${formatPercent(timings?.compactTapeCacheHitRate)} | ${formatMs(timings?.rustIpcWriteDurationMsTotal)} | ${formatMb(timings?.candidateRequestBytesTotal)} | ${formatMb(timings?.candidateRequestTapeBytesSavedTotal)} | ${largestRequestSection(timings)} | ${result.report?.mismatches ?? 'n/a'} |`,
      );
      if (!result.pass && result.stderr.trim()) {
        console.log(result.stderr.trim());
      }
    }
    for (const failure of guardFailures) {
      console.log(`guard failure: ${failure}`);
    }
    for (const item of compactResults) {
      console.log(
        `summary ${item.mode}: compact=${formatSpeedup(item.speedupVsTs ?? undefined)} request=${formatMb(item.requestBytes ?? undefined)} tapeShare=${formatPercent(item.tapeShare ?? undefined)} tapeSaved=${formatMb(item.tapeBytesSaved ?? undefined)}`,
      );
    }
    for (const item of trend) {
      console.log(
        `trend ${item.mode}: speedupDelta=${formatSpeedupDelta(item.speedupDelta ?? undefined)} tapeShareDelta=${formatPercent(item.tapeShareDelta ?? undefined)}`,
      );
    }
    console.log(`report=${reportPath}`);
  }
  process.exit(report.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
