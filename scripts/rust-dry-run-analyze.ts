import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SummaryShape {
  successRate?: number;
  medianEndingWealth?: number;
  annualFederalTaxEstimate?: number;
  irmaaExposureRate?: number;
  spendingCutRate?: number;
  rothDepletionRate?: number;
  endingWealthPercentiles?: {
    p10?: number;
    p50?: number;
    p90?: number;
  };
}

interface DryRunEvent {
  timestampIso?: string;
  event?: string;
  policyId?: string;
  policy?: unknown;
  mode?: string;
  trialCount?: number;
  comparison?: {
    pass?: boolean;
    firstDifference?: {
      field?: string;
      expected?: number;
      actual?: number;
      delta?: number;
      tolerance?: number;
    } | null;
  };
  timings?: {
    tsEvaluationDurationMs?: number;
    rustSummaryDurationMs?: number;
  };
  tsSummary?: SummaryShape;
  rustSummary?: SummaryShape;
  message?: string;
  reason?: string;
}

interface CliOptions {
  logPath: string;
  top: number;
  json: boolean;
  failOnMismatch: boolean;
}

const DEFAULT_LOG_PATH = 'out/rust-dry-run-smoke.jsonl';

function printHelp() {
  console.log(`Usage:
  npm run engine:rust-dry-run:analyze
  npm run engine:rust-dry-run:analyze -- --log out/rust-dry-run-parametric-160x80.jsonl --top 10

Options:
  --log <path>         Dry-run JSONL path. Defaults to out/rust-dry-run-smoke.jsonl.
  --top <n>            Number of largest-delta policies to print. Defaults to 8.
  --fail-on-mismatch   Exit nonzero if mismatches or errors are present.
  --json               Print machine-readable JSON.`);
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    logPath: DEFAULT_LOG_PATH,
    top: 8,
    json: false,
    failOnMismatch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--log' && next) {
      options.logPath = next;
      index += 1;
    } else if (arg === '--top' && next) {
      options.top = Number(next);
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
  options.top = Math.max(1, Math.floor(options.top));
  return options;
}

function readEvents(path: string): DryRunEvent[] {
  const content = readFileSync(resolve(path), 'utf8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DryRunEvent);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function delta(expected: unknown, actual: unknown) {
  if (!finite(expected) || !finite(actual)) return null;
  return {
    expected,
    actual,
    delta: actual - expected,
    absDelta: Math.abs(actual - expected),
  };
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: number[]) {
  if (values.length === 0) return null;
  return Math.max(...values);
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.floor((sorted.length - 1) * fraction);
  return sorted[index];
}

function summarizeDeltas(
  resultEvents: DryRunEvent[],
  field: string,
  read: (summary: SummaryShape | undefined) => unknown,
) {
  const deltas = resultEvents
    .map((event) => delta(read(event.tsSummary), read(event.rustSummary)))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const absDeltas = deltas.map((item) => item.absDelta);
  const signedDeltas = deltas.map((item) => item.delta);
  return {
    field,
    count: deltas.length,
    meanDelta: average(signedDeltas),
    meanAbsDelta: average(absDeltas),
    p90AbsDelta: percentile(absDeltas, 0.9),
    maxAbsDelta: max(absDeltas),
  };
}

function policyDivergence(event: DryRunEvent) {
  const fields = [
    ['successRate', (summary: SummaryShape | undefined) => summary?.successRate],
    [
      'medianEndingWealth',
      (summary: SummaryShape | undefined) => summary?.medianEndingWealth,
    ],
    [
      'endingWealthPercentiles.p50',
      (summary: SummaryShape | undefined) => summary?.endingWealthPercentiles?.p50,
    ],
    [
      'endingWealthPercentiles.p90',
      (summary: SummaryShape | undefined) => summary?.endingWealthPercentiles?.p90,
    ],
    [
      'annualFederalTaxEstimate',
      (summary: SummaryShape | undefined) => summary?.annualFederalTaxEstimate,
    ],
    [
      'irmaaExposureRate',
      (summary: SummaryShape | undefined) => summary?.irmaaExposureRate,
    ],
    [
      'spendingCutRate',
      (summary: SummaryShape | undefined) => summary?.spendingCutRate,
    ],
    [
      'rothDepletionRate',
      (summary: SummaryShape | undefined) => summary?.rothDepletionRate,
    ],
  ] as const;
  const deltas = fields
    .map(([field, read]) => {
      const item = delta(read(event.tsSummary), read(event.rustSummary));
      return item ? { field, ...item } : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const largest = deltas.reduce<
    | {
        field: string;
        expected: number;
        actual: number;
        delta: number;
        absDelta: number;
      }
    | null
  >(
    (best, item) => (!best || item.absDelta > best.absDelta ? item : best),
    null,
  );
  return {
    policyId: event.policyId,
    policy: event.policy,
    pass: event.comparison?.pass,
    firstDifference: event.comparison?.firstDifference ?? null,
    largestDelta: largest,
  };
}

function main() {
  const options = readArgs(process.argv.slice(2));
  const logPath = resolve(options.logPath);
  const events = readEvents(logPath);
  const resultEvents = events.filter(
    (event) => event.event === 'rust_dry_run_result',
  );
  const mismatches = resultEvents.filter(
    (event) => event.comparison?.pass === false,
  );
  const errors = events.filter((event) => event.event === 'rust_dry_run_error');
  const skipped = events.filter((event) => event.event === 'rust_dry_run_skipped');
  const timestamps = events
    .map((event) =>
      event.timestampIso ? new Date(event.timestampIso).getTime() : NaN,
    )
    .filter((value) => Number.isFinite(value));
  const timestampSpanMs =
    timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const tsDurations = resultEvents
    .map((event) => event.timings?.tsEvaluationDurationMs)
    .filter(finite);
  const rustDurations = resultEvents
    .map((event) => event.timings?.rustSummaryDurationMs)
    .filter(finite);
  const modes = Array.from(
    new Set(resultEvents.map((event) => event.mode).filter(Boolean)),
  );
  const trialCounts = Array.from(
    new Set(resultEvents.map((event) => event.trialCount).filter(finite)),
  ).sort((left, right) => left - right);
  const topDivergentPolicies = resultEvents
    .map(policyDivergence)
    .filter((item) => item.largestDelta)
    .sort(
      (left, right) =>
        (right.largestDelta?.absDelta ?? 0) - (left.largestDelta?.absDelta ?? 0),
    )
    .slice(0, options.top);
  const deltaSummaries = [
    summarizeDeltas(
      resultEvents,
      'successRate',
      (summary) => summary?.successRate,
    ),
    summarizeDeltas(
      resultEvents,
      'medianEndingWealth',
      (summary) => summary?.medianEndingWealth,
    ),
    summarizeDeltas(
      resultEvents,
      'endingWealthPercentiles.p50',
      (summary) => summary?.endingWealthPercentiles?.p50,
    ),
    summarizeDeltas(
      resultEvents,
      'endingWealthPercentiles.p90',
      (summary) => summary?.endingWealthPercentiles?.p90,
    ),
    summarizeDeltas(
      resultEvents,
      'annualFederalTaxEstimate',
      (summary) => summary?.annualFederalTaxEstimate,
    ),
    summarizeDeltas(
      resultEvents,
      'irmaaExposureRate',
      (summary) => summary?.irmaaExposureRate,
    ),
  ];
  const report = {
    pass:
      errors.length === 0 &&
      skipped.length === 0 &&
      (!options.failOnMismatch || mismatches.length === 0),
    logPath,
    events: events.length,
    resultEvents: resultEvents.length,
    matched: resultEvents.length - mismatches.length,
    mismatches: mismatches.length,
    errors: errors.length,
    skipped: skipped.length,
    modes,
    trialCounts,
    timestampSpanMs,
    timings: {
      tsEvaluationDurationMs: {
        count: tsDurations.length,
        average: average(tsDurations),
        p90: percentile(tsDurations, 0.9),
        max: max(tsDurations),
      },
      rustSummaryDurationMs: {
        count: rustDurations.length,
        average: average(rustDurations),
        p90: percentile(rustDurations, 0.9),
        max: max(rustDurations),
      },
    },
    deltaSummaries,
    topDivergentPolicies,
    errorMessages: errors.map((event) => ({
      policyId: event.policyId,
      message: event.message,
    })),
    skippedReasons: skipped.map((event) => ({
      policyId: event.policyId,
      reason: event.reason,
    })),
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `rust-dry-run:analyze pass=${report.pass} results=${report.resultEvents} matched=${report.matched} mismatches=${report.mismatches} errors=${report.errors} skipped=${report.skipped}`,
    );
    console.log(
      `modes=${report.modes.join(',') || 'unknown'} trials=${report.trialCounts.join(',') || 'unknown'} spanMs=${report.timestampSpanMs}`,
    );
    console.log(`log=${report.logPath}`);
    console.log(
      `timings tsAvg=${report.timings.tsEvaluationDurationMs.average ?? 'n/a'} rustAvg=${report.timings.rustSummaryDurationMs.average ?? 'n/a'}`,
    );
    for (const item of report.deltaSummaries) {
      console.log(
        `${item.field}: meanAbs=${item.meanAbsDelta ?? 'n/a'} p90Abs=${item.p90AbsDelta ?? 'n/a'} maxAbs=${item.maxAbsDelta ?? 'n/a'}`,
      );
    }
    if (report.topDivergentPolicies.length > 0) {
      console.log('top divergent policies:');
      for (const item of report.topDivergentPolicies) {
        console.log(
          `${item.policyId ?? 'unknown'} pass=${String(item.pass)} field=${item.largestDelta?.field} absDelta=${item.largestDelta?.absDelta}`,
        );
      }
    }
  }

  process.exit(report.pass ? 0 : 1);
}

main();
