import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadClusterModelHealthJob,
  startClusterModelHealthJob,
  type ClusterModelHealthJobPayload,
} from '../policy-mining-cluster';
import { Panel } from '../ui-primitives';
import { useClusterSession } from '../useClusterSession';
import { formatCurrency } from '../utils';

type ReportLoadState =
  | { status: 'loading'; reports: VerificationReport[]; error: null }
  | { status: 'ready'; reports: VerificationReport[]; error: null }
  | { status: 'error'; reports: VerificationReport[]; error: string };

type RerunState =
  | { kind: 'idle'; message: string | null }
  | { kind: 'running'; message: string }
  | { kind: 'failed'; message: string };

interface VerificationReport {
  $schemaVersion: number;
  kind: string;
  mode: 'quick' | 'full';
  generatedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  repository: {
    branch: string;
    commit: string;
    dirty: boolean;
    dirtyEntryCount: number;
  };
  checks: VerificationCheck[];
  warnings: VerificationWarning[];
  modelCompleteness: {
    faithful: number;
    reconstructed: number;
    records: Array<{
      id: string;
      source: string;
      modelCompleteness: 'faithful' | 'reconstructed';
      inferredAssumptionCount: number;
    }>;
  };
  externalBenchmarks: ExternalBenchmark[];
  modelSnapshots?: {
    goldenScenarios?: GoldenScenarioSnapshot[];
    northStarBudget?: NorthStarBudgetSnapshot;
    replayFixture?: ReplayFixtureSnapshot;
  };
  drift?: DriftSummary;
  strict?: {
    enabled: boolean;
    failures: Array<{ code: string; message: string }>;
  };
}

interface VerificationCheck {
  name: string;
  command: string;
  durationMs: number;
  exitCode: number;
  passed: boolean;
  warnings: VerificationWarning[];
  stdoutTail?: string;
  stderrTail?: string;
}

interface VerificationWarning {
  code: string;
  message: string;
  check?: string;
}

interface ExternalBenchmark {
  id: string;
  kind: string;
  modelName: string;
  modelCompleteness: 'faithful' | 'reconstructed';
  comparisonMode?:
    | 'source_native_replay'
    | 'generic_local_fixture'
    | 'faithful_tax_snapshot';
  externalSuccessRate?: number;
  localSuccessRate?: number;
  localLabel?: string;
  localCohortCount?: number;
  expectedLocalSuccessRate?: number;
  genericLocal?: {
    successRate: number;
    cohortCount: number;
    successfulCohorts: number;
    failedCohorts: number;
    label: string;
  };
  sourceNative?: {
    successRate: number;
    cohortCount?: number;
    successfulCohorts?: number;
    failedCohorts?: number;
    label: string;
    evidence: string;
  } | null;
  successRateTolerance?: number;
  toleranceDollars?: number;
}

interface GoldenScenarioSnapshot {
  scenarioId: string;
  scenarioName: string;
  pass: boolean;
  summary: {
    successRate: number;
    medianEndingWealth: number;
    tenthPercentileEndingWealth: number;
    firstYearTotalCashOutflow: number;
    medianLegacySurplus: number;
  };
}

interface NorthStarBudgetSnapshot {
  source: string;
  year: number | null;
  totalAnnualBudget: number;
  totalMonthlyBudget: number;
  spendAndHealthAnnual: number;
  federalTaxAnnual: number;
  lifestyleAnnual: number | null;
  protectedReserve: {
    targetTodayDollars: number;
    purpose: string;
    availableFor: string;
    normalLifestyleSpendable: boolean;
    modelCompleteness: 'faithful' | 'reconstructed';
  };
  medianEndingWealth: number | null;
}

interface ReplayFixtureSnapshot {
  packetCount: number;
  currentHouseholdPacketId: string;
  compatibilityPacketIds: string[];
  currentHouseholdPacket?: {
    robPlanningEndAge: number;
    debbiePlanningEndAge: number;
    ledgerYearCount: number;
    finalYear: number;
    protectedReserve: {
      targetTodayDollars: number;
      purpose: string;
      availableFor: string;
    };
  };
}

interface DriftSummary {
  comparedToPrevious: boolean;
  previousGeneratedAt?: string;
  statusChanged: boolean;
  warningCountDelta: number | null;
  checkDurationDeltasMs: Record<string, number>;
  modelCompletenessDelta?: {
    faithful: number;
    reconstructed: number;
  } | null;
  northStarBudget?: {
    totalMonthlyBudgetDelta: number;
    totalAnnualBudgetDelta: number;
    protectedReserveTargetChanged: boolean;
    protectedReservePurposeChanged: boolean;
    protectedReserveAvailableForChanged: boolean;
  } | null;
  replayFixture?: {
    packetCountDelta: number;
    currentHouseholdPacketChanged: boolean;
    currentHouseholdFinalYearChanged: boolean;
    currentHouseholdProtectedReserveTargetChanged: boolean;
    currentHouseholdProtectedReservePurposeChanged: boolean;
  } | null;
}

const REPORT_PATHS = [
  '/local/model-verification-report.json',
  '/local/model-verification-quick-report.json',
] as const;

async function fetchReport(path: string): Promise<VerificationReport | null> {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  const raw = await response.text();
  const trimmed = raw.trimStart();
  if (!trimmed || trimmed.startsWith('<')) return null;
  return JSON.parse(trimmed) as VerificationReport;
}

async function loadLocalReports(): Promise<VerificationReport[]> {
  const reports = await Promise.all(REPORT_PATHS.map((path) => fetchReport(path)));
  return reports
    .filter((report): report is VerificationReport => report !== null)
    .sort((a, b) => reportSortKey(b) - reportSortKey(a));
}

function reportSortKey(report: VerificationReport): number {
  return Date.parse(report.generatedAt) || 0;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function formatMonthly(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${formatCurrency(Math.round(value))}/mo`;
}

function shortCommit(commit: string): string {
  return commit ? commit.slice(0, 8) : '-';
}

function humanize(value: string | null | undefined): string {
  if (!value) return '-';
  return value.replaceAll('_', ' ');
}

function driftLabel(report: VerificationReport): string {
  const drift = report.drift;
  if (!drift?.comparedToPrevious) return 'No prior report';
  if (report.strict?.failures.length) return `${report.strict.failures.length} strict failure(s)`;
  if (drift.statusChanged) return 'Status changed';
  const northStarDelta = drift.northStarBudget?.totalMonthlyBudgetDelta ?? 0;
  if (Math.abs(northStarDelta) >= 0.5) {
    const sign = northStarDelta > 0 ? '+' : '';
    return `${sign}${Math.round(northStarDelta)}/mo north-star drift`;
  }
  return 'No strict drift';
}

function statusClasses(status: VerificationReport['status']) {
  return status === 'passed'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
    : 'border-rose-200 bg-rose-50 text-rose-950';
}

function badgeClasses(pass: boolean) {
  return pass
    ? 'bg-emerald-100 text-emerald-800'
    : 'bg-rose-100 text-rose-800';
}

function nextCommandForCheck(checkName: string): string {
  if (checkName.includes('external')) {
    return 'npx vitest run src/model-negative.test.ts src/external-model-benchmark-corpus.test.ts src/ficalc-source-parity.test.ts src/cfiresim-export-parity.test.ts src/model-replay-packets.test.ts';
  }
  if (checkName.includes('statutory') || checkName.includes('north-star')) {
    return 'npx vitest run src/model-contract-propagation.test.ts src/north-star-budget.test.ts src/protected-reserve.test.ts';
  }
  if (checkName.includes('parity')) return 'npm run test:model:parity';
  if (checkName.includes('golden')) return 'npx vitest run src/verification-harness.test.ts';
  if (checkName.includes('build')) return 'npm run build';
  return 'npm run verify:model:quick:strict';
}

function cleanOutput(value: string | undefined): string {
  if (!value?.trim()) return '';
  return value.trim().slice(-2400);
}

function externalAnchorText(benchmark: ExternalBenchmark): string {
  if (typeof benchmark.externalSuccessRate === 'number') {
    return `${formatPercent(benchmark.localSuccessRate)} ${benchmark.localLabel ?? 'local'} vs ${formatPercent(
      benchmark.externalSuccessRate,
    )} external`;
  }
  return `tax tolerance ${formatCurrency(benchmark.toleranceDollars ?? 0)}`;
}

function externalAnchorDetail(benchmark: ExternalBenchmark): string {
  if (benchmark.comparisonMode === 'source_native_replay') {
    const generic = benchmark.genericLocal;
    return generic
      ? `generic local fixture: ${formatPercent(generic.successRate)}`
      : 'source-native replay';
  }
  if (benchmark.comparisonMode === 'generic_local_fixture') {
    return 'source data unavailable; using generic local fixture';
  }
  return 'faithful external tax snapshot';
}

function rerunMessage(payload: ClusterModelHealthJobPayload): string {
  const lastLog = payload.job?.logTail.at(-1);
  if (lastLog) return lastLog;
  if (payload.job?.status === 'running') return 'Model Health check is running.';
  return 'Starting quick strict Model Health check.';
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function ModelHealthScreen() {
  const cluster = useClusterSession();
  const dispatcherUrl = cluster.snapshot.dispatcherUrl ?? null;
  const [state, setState] = useState<ReportLoadState>({
    status: 'loading',
    reports: [],
    error: null,
  });
  const [rerunState, setRerunState] = useState<RerunState>({
    kind: 'idle',
    message: null,
  });

  const refreshReports = useCallback(async () => {
    const reports = await loadLocalReports();
    setState({ status: 'ready', reports, error: null });
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadLocalReports()
      .then((reports) => {
        if (cancelled) return;
        setState({ status: 'ready', reports, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: 'error',
          reports: [],
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rerunQuickCheck = useCallback(async () => {
    if (!dispatcherUrl || rerunState.kind === 'running') return;
    setRerunState({
      kind: 'running',
      message: 'Starting quick strict Model Health check.',
    });
    try {
      const started = await startClusterModelHealthJob(dispatcherUrl, {
        force: true,
      });
      setRerunState({ kind: 'running', message: rerunMessage(started) });
      for (;;) {
        const latest = await loadClusterModelHealthJob(dispatcherUrl);
        setRerunState({ kind: 'running', message: rerunMessage(latest) });
        if (latest.job?.status === 'complete' || latest.job?.status === 'failed') {
          await refreshReports();
          if (latest.job.status === 'failed') {
            setRerunState({
              kind: 'failed',
              message:
                latest.job.error ??
                latest.report?.strict?.failures?.[0]?.message ??
                'Model Health check failed.',
            });
          } else {
            setRerunState({
              kind: 'idle',
              message: `Updated ${formatDate(latest.report?.generatedAt)}`,
            });
          }
          return;
        }
        await waitMs(1_000);
      }
    } catch (error) {
      setRerunState({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dispatcherUrl, refreshReports, rerunState.kind]);

  const report = state.reports[0] ?? null;
  const alternateReports = useMemo(
    () => state.reports.slice(1),
    [state.reports],
  );

  if (state.status === 'loading') {
    return (
      <Panel
        title="Model Health"
        subtitle="Last background verification report."
      >
        <RerunControl
          dispatcherUrl={dispatcherUrl}
          rerunState={rerunState}
          onRerun={rerunQuickCheck}
        />
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5 text-sm font-semibold text-blue-950">
          Loading verifier report...
        </div>
      </Panel>
    );
  }

  if (state.status === 'error') {
    return (
      <Panel
        title="Model Health"
        subtitle="Last background verification report."
      >
        <RerunControl
          dispatcherUrl={dispatcherUrl}
          rerunState={rerunState}
          onRerun={rerunQuickCheck}
        />
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-950">
          <p className="font-semibold">Could not read the verifier report.</p>
          <p className="mt-1">{state.error}</p>
        </div>
      </Panel>
    );
  }

  if (!report) {
    return (
      <Panel
        title="Model Health"
        subtitle="Last background verification report."
      >
        <RerunControl
          dispatcherUrl={dispatcherUrl}
          rerunState={rerunState}
          onRerun={rerunQuickCheck}
        />
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
          <p className="font-semibold">No local verification report is available yet.</p>
          <p className="mt-1">
            Run `npm run verify:model:quick:strict` or `npm run verify:model:strict`
            from the repo; the verifier will write the UI report under `public/local`.
          </p>
        </div>
      </Panel>
    );
  }

  const northStar = report.modelSnapshots?.northStarBudget ?? null;
  const replay = report.modelSnapshots?.replayFixture ?? null;
  const currentReplay = replay?.currentHouseholdPacket ?? null;
  const strictFailureCount = report.strict?.failures.length ?? 0;
  const warningCount = report.warnings.length;
  const allChecksPassed = report.checks.every((check) => check.passed);
  const failedChecks = report.checks.filter((check) => !check.passed);
  const hasAttention =
    failedChecks.length > 0 || strictFailureCount > 0 || warningCount > 0;

  return (
    <Panel
      title="Model Health"
      subtitle="Last background verifier output; the browser only reports what the CLI produced."
    >
      <RerunControl
        dispatcherUrl={dispatcherUrl}
        rerunState={rerunState}
        onRerun={rerunQuickCheck}
      />

      <div className={`rounded-2xl border p-5 ${statusClasses(report.status)}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em]">
              {report.mode} verification
            </p>
            <p className="mt-2 text-3xl font-semibold capitalize">
              {report.status}
            </p>
            <p className="mt-1 text-sm">
              {formatDate(report.generatedAt)} · {formatDuration(report.durationMs)}
            </p>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2 lg:min-w-[420px]">
            <Fact label="Branch" value={report.repository.branch} />
            <Fact label="Commit" value={shortCommit(report.repository.commit)} />
            <Fact
              label="Working tree"
              value={
                report.repository.dirty
                  ? `${report.repository.dirtyEntryCount} local change(s)`
                  : 'clean'
              }
            />
            <Fact label="Drift" value={driftLabel(report)} />
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <HealthMetric
          label="Checks"
          value={`${report.checks.filter((check) => check.passed).length}/${report.checks.length}`}
          detail={allChecksPassed ? 'all passed' : 'review failures'}
          pass={allChecksPassed}
        />
        <HealthMetric
          label="Strict gates"
          value={strictFailureCount === 0 ? 'Clear' : String(strictFailureCount)}
          detail={report.strict?.enabled ? 'strict enabled' : 'strict off'}
          pass={strictFailureCount === 0}
        />
        <HealthMetric
          label="Warnings"
          value={String(warningCount)}
          detail={warningCount === 0 ? 'none' : 'needs review'}
          pass={warningCount === 0}
        />
        <HealthMetric
          label="Completeness"
          value={`${report.modelCompleteness.faithful}F / ${report.modelCompleteness.reconstructed}R`}
          detail="external anchors"
          pass
        />
      </div>

      {hasAttention ? (
        <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em]">
                What Needs Attention
              </p>
              <h3 className="mt-2 text-xl font-semibold">
                {failedChecks.length > 0
                  ? `${failedChecks.length} check(s) failed`
                  : strictFailureCount > 0
                    ? `${strictFailureCount} strict gate(s) failed`
                    : `${warningCount} warning(s) to review`}
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-6">
                Start with the first item below. The command is the smallest useful
                rerun; the full verifier can wait until the focused check is green.
              </p>
            </div>
            <span className="rounded-full bg-white/70 px-3 py-1 text-xs font-semibold">
              latest report: {formatDate(report.generatedAt)}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {failedChecks.map((check) => (
              <AttentionItem
                key={check.name}
                title={check.name}
                detail={`Exited ${check.exitCode} after ${formatDuration(check.durationMs)}.`}
                command={nextCommandForCheck(check.name)}
                output={cleanOutput(check.stderrTail) || cleanOutput(check.stdoutTail)}
              />
            ))}
            {(report.strict?.failures ?? []).map((failure) => (
              <AttentionItem
                key={failure.code}
                title={failure.code}
                detail={failure.message}
                command="npm run verify:model:quick:strict"
              />
            ))}
            {report.warnings.map((warning) => (
              <AttentionItem
                key={`${warning.check ?? 'report'}-${warning.code}`}
                title={warning.check ? `${warning.check}: ${warning.code}` : warning.code}
                detail={warning.message}
                command="npm run verify:model:quick:strict"
              />
            ))}
          </div>
        </section>
      ) : null}

      {northStar ? (
        <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-700">
                North Star Budget
              </p>
              <p className="mt-2 text-2xl font-semibold text-stone-900">
                {formatMonthly(northStar.totalMonthlyBudget)}
              </p>
              <p className="mt-1 text-sm text-stone-500">
                {formatCurrency(Math.round(northStar.totalAnnualBudget))}/yr total budget · year{' '}
                {northStar.year ?? '-'}
              </p>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:min-w-[460px]">
              <Fact
                label="Protected reserve"
                value={formatCurrency(northStar.protectedReserve.targetTodayDollars)}
              />
              <Fact
                label="Available for"
                value={humanize(northStar.protectedReserve.availableFor)}
              />
              <Fact
                label="Lifestyle spend"
                value={
                  northStar.protectedReserve.normalLifestyleSpendable
                    ? 'reserve spendable'
                    : 'reserve protected'
                }
              />
              <Fact
                label="Median ending wealth"
                value={
                  northStar.medianEndingWealth === null
                    ? '-'
                    : formatCurrency(Math.round(northStar.medianEndingWealth))
                }
              />
            </div>
          </div>
        </section>
      ) : null}

      {replay ? (
        <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">
                Replay Fixture
              </p>
              <p className="mt-2 text-lg font-semibold text-stone-900">
                {replay.currentHouseholdPacketId}
              </p>
              <p className="mt-1 text-sm text-stone-500">
                {replay.packetCount} packet(s), {replay.compatibilityPacketIds.length} compatibility
              </p>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:min-w-[460px]">
              <Fact
                label="End ages"
                value={
                  currentReplay
                    ? `Rob ${currentReplay.robPlanningEndAge}, Debbie ${currentReplay.debbiePlanningEndAge}`
                    : '-'
                }
              />
              <Fact
                label="Final year"
                value={currentReplay ? String(currentReplay.finalYear) : '-'}
              />
              <Fact
                label="Ledger years"
                value={currentReplay ? String(currentReplay.ledgerYearCount) : '-'}
              />
              <Fact
                label="Reserve target"
                value={
                  currentReplay
                    ? formatCurrency(currentReplay.protectedReserve.targetTodayDollars)
                    : '-'
                }
              />
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-stone-500">
            Verification Checks
          </h3>
          {alternateReports.length > 0 ? (
            <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
              also has {alternateReports.map((item) => item.mode).join(', ')} report
            </span>
          ) : null}
        </div>
        <div className="overflow-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[760px] text-left text-xs tabular-nums">
            <thead className="bg-stone-100 text-stone-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Check</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 text-right font-semibold">Duration</th>
                <th className="px-3 py-2 text-right font-semibold">Warnings</th>
                <th className="px-3 py-2 text-right font-semibold">Exit</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.name} className="border-t border-stone-100">
                  <td className="px-3 py-2 font-medium text-stone-900">
                    {check.name}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-1 font-semibold ${badgeClasses(
                        check.passed,
                      )}`}
                    >
                      {check.passed ? 'passed' : 'failed'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-stone-600">
                    {formatDuration(check.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-600">
                    {check.warnings.length}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-600">
                    {check.exitCode}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-stone-200 bg-white p-5">
          <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-stone-500">
            External Anchors
          </h3>
          <div className="mt-3 space-y-2">
            {report.externalBenchmarks.map((benchmark) => (
              <div
                key={benchmark.id}
                className="grid gap-2 rounded-xl bg-stone-50 p-3 text-sm text-stone-700 sm:grid-cols-[1fr_auto]"
              >
                <div>
                  <p className="font-medium text-stone-900">{benchmark.modelName}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    {benchmark.modelCompleteness} · {externalAnchorDetail(benchmark)}
                  </p>
                </div>
                <span className="tabular-nums">{externalAnchorText(benchmark)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-stone-200 bg-white p-5">
          <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-stone-500">
            Golden Scenarios
          </h3>
          <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-stone-200">
            <table className="w-full min-w-[520px] text-left text-xs tabular-nums">
              <thead className="sticky top-0 bg-stone-100 text-stone-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Scenario</th>
                  <th className="px-3 py-2 text-right font-semibold">Success</th>
                  <th className="px-3 py-2 text-right font-semibold">Median</th>
                </tr>
              </thead>
              <tbody>
                {(report.modelSnapshots?.goldenScenarios ?? []).map((scenario) => (
                  <tr key={scenario.scenarioId} className="border-t border-stone-100">
                    <td className="px-3 py-2 font-medium text-stone-900">
                      {scenario.scenarioName}
                    </td>
                    <td className="px-3 py-2 text-right text-stone-600">
                      {formatPercent(scenario.summary.successRate)}
                    </td>
                    <td className="px-3 py-2 text-right text-stone-600">
                      {formatCurrency(Math.round(scenario.summary.medianEndingWealth))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/70 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase text-stone-400">{label}</p>
      <p className="mt-1 break-words font-semibold text-stone-900">{value}</p>
    </div>
  );
}

function RerunControl({
  dispatcherUrl,
  rerunState,
  onRerun,
}: {
  dispatcherUrl: string | null;
  rerunState: RerunState;
  onRerun: () => void;
}) {
  const running = rerunState.kind === 'running';
  const disabled = !dispatcherUrl || running;
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-stone-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-stone-900">Refresh Model Health</p>
        <p
          className={`mt-1 text-xs ${
            rerunState.kind === 'failed' ? 'text-rose-700' : 'text-stone-500'
          }`}
        >
          {rerunState.message ??
            (dispatcherUrl
              ? 'Runs the quick strict verifier through the dispatcher.'
              : 'Start the dispatcher to rerun from the UI.')}
        </p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onRerun}
        className="rounded-full bg-stone-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
      >
        {running ? 'Running...' : 'Rerun'}
      </button>
    </div>
  );
}

function HealthMetric({
  label,
  value,
  detail,
  pass,
}: {
  label: string;
  value: string;
  detail: string;
  pass: boolean;
}) {
  return (
    <div className="rounded-2xl bg-stone-100/85 p-4">
      <p className="text-xs font-semibold uppercase text-stone-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-stone-900">{value}</p>
      <p className={pass ? 'mt-1 text-xs text-emerald-700' : 'mt-1 text-xs text-rose-700'}>
        {detail}
      </p>
    </div>
  );
}

function AttentionItem({
  title,
  detail,
  command,
  output,
}: {
  title: string;
  detail: string;
  command: string;
  output?: string;
}) {
  return (
    <details className="rounded-xl border border-amber-200 bg-white/80 p-4">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-semibold text-stone-900">{title}</p>
            <p className="mt-1 text-sm leading-6 text-stone-600">{detail}</p>
          </div>
          <code className="rounded-lg bg-stone-900 px-3 py-2 text-xs text-white">
            {command}
          </code>
        </div>
      </summary>
      {output ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-950 p-3 text-xs leading-5 text-stone-100">
          {output}
        </pre>
      ) : null}
    </details>
  );
}
