#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--quick') ? 'quick' : 'full';
const strict = process.argv.includes('--strict');
const reportPath = resolve(
  repoRoot,
  mode === 'quick'
    ? 'artifacts/model-verification-quick-report.json'
    : 'artifacts/model-verification-report.json',
);
const uiReportPath = resolve(
  repoRoot,
  mode === 'quick'
    ? 'public/local/model-verification-quick-report.json'
    : 'public/local/model-verification-report.json',
);

const fullChecks = [
  {
    name: 'external anchors',
    command: 'npx',
    args: [
      'vitest',
      'run',
      'src/model-negative.test.ts',
      'src/external-model-benchmark-corpus.test.ts',
      'src/ficalc-source-parity.test.ts',
      'src/cfiresim-export-parity.test.ts',
      'src/model-replay-packets.test.ts',
    ],
  },
  {
    name: 'statutory and north-star contracts',
    command: 'npx',
    args: [
      'vitest',
      'run',
      'src/tax-engine.test.ts',
      'src/retirement-rules.test.ts',
      'src/irmaa-tier-boundaries.test.ts',
      'src/aca-subsidy-boundaries.test.ts',
      'src/model-contract-propagation.test.ts',
      'src/north-star-budget.test.ts',
      'src/north-star-golden.test.ts',
      'src/north-star-metamorphic.test.ts',
      'src/protected-reserve-scenarios.test.ts',
      'src/protected-reserve.test.ts',
    ],
  },
  {
    name: 'model parity tier',
    command: 'node',
    args: ['scripts/run-model-tests.mjs', 'parity'],
  },
  {
    name: 'production build',
    command: 'npm',
    args: ['run', 'build'],
  },
];

const quickChecks = [
  fullChecks[0],
  fullChecks[1],
  {
    name: 'golden scenario snapshots',
    command: 'npx',
    args: ['vitest', 'run', 'src/verification-harness.test.ts'],
  },
];

const checks = mode === 'quick' ? quickChecks : fullChecks;

function runCaptured(command, args) {
  const startedAt = new Date();
  const startNs = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 1024 * 1024 * 40,
  });
  const durationMs = Number((process.hrtime.bigint() - startNs) / 1_000_000n);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}\n${stderr}`;
  const warnings = [];

  if (combined.includes('[vitest-worker]: Timeout calling "onTaskUpdate"')) {
    warnings.push({
      code: 'vitest-worker-onTaskUpdate-timeout',
      message:
        'Vitest reported a worker onTaskUpdate timeout. Test command exited successfully, but the warning can mask false positives.',
    });
  }
  if (combined.includes('Some chunks are larger than 500 kB')) {
    warnings.push({
      code: 'vite-large-chunk',
      message: 'Vite reported large production chunks.',
    });
  }

  return {
    command: [command, ...args].join(' '),
    startedAt: startedAt.toISOString(),
    durationMs,
    exitCode: result.status ?? 1,
    signal: result.signal,
    passed: (result.status ?? 1) === 0,
    warnings,
    stdoutTail: stdout.slice(-12000),
    stderrTail: stderr.slice(-12000),
    error: result.error
      ? {
          name: result.error.name,
          message: result.error.message,
        }
      : null,
  };
}

function runText(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function summarizeCompleteness() {
  const records = [];

  const corpus = readJson('fixtures/external_model_benchmarks.json');
  for (const benchmark of corpus.benchmarks ?? []) {
    records.push({
      id: benchmark.id,
      source: benchmark.source?.modelName ?? 'unknown',
      modelCompleteness: benchmark.modelCompleteness,
      inferredAssumptionCount: benchmark.inferredAssumptions?.length ?? 0,
    });
  }

  const ficalc = readJson('fixtures/ficalc_historical_annual_returns.json');
  records.push({
    id: 'ficalc_source_fixture',
    source: 'FI Calc bundled assets',
    modelCompleteness: ficalc.$meta?.modelCompleteness,
    inferredAssumptionCount: ficalc.$meta?.inferredAssumptions?.length ?? 0,
  });

  const cfiresim = readJson(
    'fixtures/cfiresim_400k_20k_30yr_60_40_export.json',
  );
  records.push({
    id: 'cfiresim_export_fixture',
    source: 'cFIREsim hosted CSV export',
    modelCompleteness: cfiresim.$meta?.modelCompleteness,
    inferredAssumptionCount:
      cfiresim.$meta?.inferredAssumptions?.length ?? 0,
  });

  return {
    faithful: records.filter((record) => record.modelCompleteness === 'faithful')
      .length,
    reconstructed: records.filter(
      (record) => record.modelCompleteness === 'reconstructed',
    ).length,
    records,
  };
}

function summarizeExternalBenchmarks() {
  const corpus = readJson('fixtures/external_model_benchmarks.json');
  const cfiresim = readJson(
    'fixtures/cfiresim_400k_20k_30yr_60_40_export.json',
  );
  return (corpus.benchmarks ?? []).map((benchmark) => {
    if (benchmark.kind === 'historical_rolling_window_survival') {
      const genericLocal = {
        successRate: benchmark.expectedLocal.successRate,
        cohortCount: benchmark.expectedLocal.cohortCount,
        successfulCohorts: benchmark.expectedLocal.successfulCohorts,
        failedCohorts: benchmark.expectedLocal.failedCohorts,
        label: 'generic 1926+ local fixture',
      };
      const sourceNative =
        benchmark.id === 'ficalc_live_400k_20k_30yr_60_40'
          ? {
              successRate: benchmark.externalObservation.successRate,
              cohortCount: benchmark.externalObservation.cohortCount,
              successfulCohorts:
                benchmark.externalObservation.successfulCohorts,
              failedCohorts: benchmark.externalObservation.failedCohorts,
              label: 'FI Calc source replay',
              evidence: 'src/ficalc-source-parity.test.ts',
            }
          : benchmark.id === 'cfiresim_live_400k_20k_30yr_60_40'
            ? {
                successRate: cfiresim.externalSummary.successRate,
                cohortCount: cfiresim.externalSummary.cohortCount,
                successfulCohorts: cfiresim.externalSummary.successfulCohorts,
                failedCohorts: cfiresim.externalSummary.failedCohorts,
                label: 'cFIREsim export replay',
                evidence: 'src/cfiresim-export-parity.test.ts',
              }
            : null;
      return {
        id: benchmark.id,
        kind: benchmark.kind,
        modelName: benchmark.source.modelName,
        modelCompleteness: benchmark.modelCompleteness,
        comparisonMode: sourceNative
          ? 'source_native_replay'
          : 'generic_local_fixture',
        externalSuccessRate: benchmark.externalObservation.successRate,
        localSuccessRate: sourceNative?.successRate ?? genericLocal.successRate,
        localLabel: sourceNative?.label ?? genericLocal.label,
        localCohortCount:
          sourceNative?.cohortCount ?? genericLocal.cohortCount,
        genericLocal,
        sourceNative,
        expectedLocalSuccessRate: genericLocal.successRate,
        successRateTolerance: benchmark.tolerance.successRateAbs,
      };
    }
    return {
      id: benchmark.id,
      kind: benchmark.kind,
      modelName: benchmark.source.modelName,
      modelCompleteness: benchmark.modelCompleteness,
      comparisonMode: 'faithful_tax_snapshot',
      toleranceDollars: benchmark.tolerance.dollarsAbs,
    };
  });
}

function collectModelSnapshots() {
  const result = runText('node', [
    '--import',
    'tsx',
    'scripts/collect-model-verification-snapshots.ts',
  ]);
  if (result.exitCode !== 0) {
    return {
      error: result.stderr || result.stdout || 'snapshot collection failed',
      goldenScenarios: [],
      replayPackets: [],
    };
  }
  return JSON.parse(result.stdout);
}

function summarizeMetricById(rows, idKey, metricPath) {
  return Object.fromEntries(
    (rows ?? []).map((row) => {
      let value = row;
      for (const part of metricPath) {
        value = value?.[part];
      }
      return [row[idKey], value ?? null];
    }),
  );
}

function summarizeGoldenMetric(report, metricPath) {
  return summarizeMetricById(
    report.modelSnapshots?.goldenScenarios,
    'scenarioId',
    metricPath,
  );
}

function buildMetricDeltas(previous, next, metricPath) {
  const previousMetrics = summarizeGoldenMetric(previous, metricPath);
  return Object.fromEntries(
    Object.entries(summarizeGoldenMetric(next, metricPath)).map(([id, value]) => [
      id,
      typeof value === 'number'
        ? value - (previousMetrics[id] ?? value)
        : null,
    ]),
  );
}

function safeReadPreviousReport() {
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
}

function flattenCheckDurations(report) {
  return Object.fromEntries(
    (report?.checks ?? []).map((check) => [check.name, check.durationMs]),
  );
}

function buildDriftSummary(previous, next) {
  if (!previous) {
    return {
      comparedToPrevious: false,
      statusChanged: false,
      warningCountDelta: null,
      checkDurationDeltasMs: {},
      modelCompletenessDelta: null,
    };
  }

  const previousDurations = flattenCheckDurations(previous);
  const nextDurations = flattenCheckDurations(next);
  const checkDurationDeltasMs = {};
  for (const [name, durationMs] of Object.entries(nextDurations)) {
    checkDurationDeltasMs[name] =
      durationMs - (previousDurations[name] ?? durationMs);
  }

  return {
    comparedToPrevious: true,
    previousGeneratedAt: previous.generatedAt ?? null,
    statusChanged: previous.status !== next.status,
    warningCountDelta:
      (next.warnings?.length ?? 0) - (previous.warnings?.length ?? 0),
    checkDurationDeltasMs,
    modelCompletenessDelta: {
      faithful:
        (next.modelCompleteness?.faithful ?? 0) -
        (previous.modelCompleteness?.faithful ?? 0),
      reconstructed:
        (next.modelCompleteness?.reconstructed ?? 0) -
        (previous.modelCompleteness?.reconstructed ?? 0),
    },
    goldenScenarioDeltas: {
      successRate: buildMetricDeltas(previous, next, ['summary', 'successRate']),
      medianEndingWealth: buildMetricDeltas(previous, next, [
        'summary',
        'medianEndingWealth',
      ]),
      tenthPercentileEndingWealth: buildMetricDeltas(previous, next, [
        'summary',
        'tenthPercentileEndingWealth',
      ]),
      firstYearTotalCashOutflow: buildMetricDeltas(previous, next, [
        'summary',
        'firstYearTotalCashOutflow',
      ]),
    },
    northStarBudget: previous.modelSnapshots?.northStarBudget
      ? {
          totalMonthlyBudgetDelta:
            (next.modelSnapshots?.northStarBudget?.totalMonthlyBudget ?? 0) -
            (previous.modelSnapshots?.northStarBudget?.totalMonthlyBudget ?? 0),
          totalAnnualBudgetDelta:
            (next.modelSnapshots?.northStarBudget?.totalAnnualBudget ?? 0) -
            (previous.modelSnapshots?.northStarBudget?.totalAnnualBudget ?? 0),
          protectedReserveTargetChanged:
            (next.modelSnapshots?.northStarBudget?.protectedReserve?.targetTodayDollars ?? null) !==
            (previous.modelSnapshots?.northStarBudget?.protectedReserve?.targetTodayDollars ?? null),
          protectedReservePurposeChanged:
            (next.modelSnapshots?.northStarBudget?.protectedReserve?.purpose ?? null) !==
            (previous.modelSnapshots?.northStarBudget?.protectedReserve?.purpose ?? null),
          protectedReserveAvailableForChanged:
            (next.modelSnapshots?.northStarBudget?.protectedReserve?.availableFor ?? null) !==
            (previous.modelSnapshots?.northStarBudget?.protectedReserve?.availableFor ?? null),
        }
      : null,
    replayFixture: previous.modelSnapshots?.replayFixture
      ? {
          packetCountDelta:
            (next.modelSnapshots?.replayFixture?.packetCount ?? 0) -
            (previous.modelSnapshots?.replayFixture?.packetCount ?? 0),
          currentHouseholdPacketChanged:
            (next.modelSnapshots?.replayFixture?.currentHouseholdPacketId ?? null) !==
            (previous.modelSnapshots?.replayFixture?.currentHouseholdPacketId ?? null),
          currentHouseholdFinalYearChanged:
            previous.modelSnapshots?.replayFixture?.currentHouseholdPacket
              ? (next.modelSnapshots?.replayFixture?.currentHouseholdPacket?.finalYear ?? null) !==
                (previous.modelSnapshots?.replayFixture?.currentHouseholdPacket?.finalYear ?? null)
              : false,
          currentHouseholdProtectedReserveTargetChanged:
            previous.modelSnapshots?.replayFixture?.currentHouseholdPacket
              ? (next.modelSnapshots?.replayFixture?.currentHouseholdPacket?.protectedReserve?.targetTodayDollars ?? null) !==
                (previous.modelSnapshots?.replayFixture?.currentHouseholdPacket?.protectedReserve?.targetTodayDollars ?? null)
              : false,
          currentHouseholdProtectedReservePurposeChanged:
            previous.modelSnapshots?.replayFixture?.currentHouseholdPacket
              ? (next.modelSnapshots?.replayFixture?.currentHouseholdPacket?.protectedReserve?.purpose ?? null) !==
                (previous.modelSnapshots?.replayFixture?.currentHouseholdPacket?.protectedReserve?.purpose ?? null)
              : false,
        }
      : null,
  };
}

function buildStrictFailures(report) {
  if (!strict) return [];
  const failures = [];
  for (const warning of report.warnings ?? []) {
    failures.push({
      code: `warning:${warning.code}`,
      message: `${warning.check}: ${warning.message}`,
    });
  }

  const drift = report.drift;
  if (drift?.comparedToPrevious) {
    const reconstructedDelta = drift.modelCompletenessDelta?.reconstructed ?? 0;
    if (reconstructedDelta > 0) {
      failures.push({
        code: 'model-completeness-regression',
        message: `Reconstructed model count increased by ${reconstructedDelta}.`,
      });
    }

    for (const [scenarioId, delta] of Object.entries(
      drift.goldenScenarioDeltas?.successRate ?? {},
    )) {
      if (Math.abs(delta) > 0.02) {
        failures.push({
          code: 'golden-success-rate-drift',
          message: `${scenarioId} success-rate drift ${delta.toFixed(4)} exceeds 0.02.`,
        });
      }
    }

    for (const [scenarioId, delta] of Object.entries(
      drift.goldenScenarioDeltas?.medianEndingWealth ?? {},
    )) {
      if (Math.abs(delta) > 300_000) {
        failures.push({
          code: 'golden-median-ending-wealth-drift',
          message: `${scenarioId} median-ending-wealth drift ${Math.round(delta)} exceeds $300,000.`,
        });
      }
    }

    for (const [scenarioId, delta] of Object.entries(
      drift.goldenScenarioDeltas?.tenthPercentileEndingWealth ?? {},
    )) {
      if (typeof delta === 'number' && Math.abs(delta) > 150_000) {
        failures.push({
          code: 'golden-p10-ending-wealth-drift',
          message: `${scenarioId} p10-ending-wealth drift ${Math.round(delta)} exceeds $150,000.`,
        });
      }
    }

    for (const [scenarioId, delta] of Object.entries(
      drift.goldenScenarioDeltas?.firstYearTotalCashOutflow ?? {},
    )) {
      if (typeof delta === 'number' && Math.abs(delta) > 1_000) {
        failures.push({
          code: 'golden-first-year-cash-outflow-drift',
          message: `${scenarioId} first-year cash outflow drift ${Math.round(delta)} exceeds $1,000.`,
        });
      }
    }

    if (
      typeof drift.northStarBudget?.totalMonthlyBudgetDelta === 'number' &&
      Math.abs(drift.northStarBudget.totalMonthlyBudgetDelta) > 50
    ) {
      failures.push({
        code: 'north-star-monthly-budget-drift',
        message: `North-star monthly budget drift ${Math.round(drift.northStarBudget.totalMonthlyBudgetDelta)} exceeds $50/mo.`,
      });
    }
    if (drift.northStarBudget?.protectedReserveTargetChanged) {
      failures.push({
        code: 'north-star-protected-reserve-target-drift',
        message: 'North-star protected reserve target changed.',
      });
    }
    if (
      drift.northStarBudget?.protectedReservePurposeChanged ||
      drift.northStarBudget?.protectedReserveAvailableForChanged
    ) {
      failures.push({
        code: 'north-star-protected-reserve-purpose-drift',
        message: 'North-star protected reserve purpose or availability changed.',
      });
    }

    if ((drift.replayFixture?.packetCountDelta ?? 0) !== 0) {
      failures.push({
        code: 'replay-packet-count-drift',
        message: `Replay packet count changed by ${drift.replayFixture.packetCountDelta}.`,
      });
    }
    if (drift.replayFixture?.currentHouseholdPacketChanged) {
      failures.push({
        code: 'current-replay-packet-id-drift',
        message: 'Current household replay packet id changed.',
      });
    }
    if (drift.replayFixture?.currentHouseholdFinalYearChanged) {
      failures.push({
        code: 'current-replay-modeled-final-year-drift',
        message: 'Current household replay packet modeled final year changed.',
      });
    }
    if (drift.replayFixture?.currentHouseholdProtectedReserveTargetChanged) {
      failures.push({
        code: 'current-replay-protected-reserve-target-drift',
        message: 'Current household replay packet protected reserve target changed.',
      });
    }
    if (drift.replayFixture?.currentHouseholdProtectedReservePurposeChanged) {
      failures.push({
        code: 'current-replay-protected-reserve-purpose-drift',
        message: 'Current household replay packet protected reserve purpose changed.',
      });
    }
  }

  return failures;
}

function main() {
  const startedAt = new Date();
  const previousReport = safeReadPreviousReport();
  const branch = runText('git', ['branch', '--show-current']).stdout;
  const commit = runText('git', ['rev-parse', 'HEAD']).stdout;
  const statusShort = runText('git', ['status', '--short']).stdout
    .split('\n')
    .filter(Boolean);

  const results = [];
  for (const check of checks) {
    console.log(`\n=== verify:model: ${check.name} ===`);
    const result = runCaptured(check.command, check.args);
    process.stdout.write(result.stdoutTail);
    process.stderr.write(result.stderrTail);
    results.push({
      name: check.name,
      ...result,
    });
    if (!result.passed) {
      break;
    }
  }

  const warnings = results.flatMap((result) =>
    result.warnings.map((warning) => ({
      check: result.name,
      ...warning,
    })),
  );
  const passed = results.every((result) => result.passed);
  const report = {
    $schemaVersion: 1,
    kind: 'model-verification-report',
    mode,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    status: passed ? 'passed' : 'failed',
    repository: {
      branch,
      commit,
      dirty: statusShort.length > 0,
      dirtyEntryCount: statusShort.length,
    },
    checks: results,
    warnings,
    modelCompleteness: summarizeCompleteness(),
    externalBenchmarks: summarizeExternalBenchmarks(),
    modelSnapshots: collectModelSnapshots(),
  };
  report.drift = buildDriftSummary(previousReport, report);
  report.strict = {
    enabled: strict,
    failures: buildStrictFailures(report),
  };
  if (report.strict.failures.length > 0) {
    report.status = 'failed';
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, reportJson);
  mkdirSync(dirname(uiReportPath), { recursive: true });
  writeFileSync(uiReportPath, reportJson);

  console.log(`\n=== verify:model ${mode} summary ===`);
  console.log(`status: ${report.status}`);
  console.log(`report: ${reportPath}`);
  console.log(`ui-report: ${uiReportPath}`);
  console.log(`warnings: ${warnings.length}`);
  if (strict) {
    console.log(`strict-failures: ${report.strict.failures.length}`);
    for (const failure of report.strict.failures) {
      console.log(`  - ${failure.code}: ${failure.message}`);
    }
  }
  console.log(
    `previous-report: ${report.drift.comparedToPrevious ? 'compared' : 'none'}`,
  );

  process.exit(passed && report.strict.failures.length === 0 ? 0 : 1);
}

main();
