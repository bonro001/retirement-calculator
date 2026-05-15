import { useMemo, useState } from 'react';
import {
  classifyFeasibilityDelta,
  DEFAULT_STRESS_SCENARIOS,
  formatBequestDelta,
  formatFeasibilityDelta,
  runPolicyStressTest,
  worstCaseSummary,
  type StressTestReport,
  type StressTestResult,
} from './policy-stress-test';
import type { Policy } from './policy-miner-types';
import type { MarketAssumptions, SeedData } from './types';

/**
 * E.6 — Stress-test panel.
 *
 * Sits below the Sensitivity panel (which sits below the Adopt banner)
 * inside the Mining results card. Answers the household's question
 * after they've adopted a policy and seen it's stable on the central
 * case: "and what if things go badly?"
 *
 * Implementation choice: runs INLINE on the main thread. Each
 * scenario is one `buildPathResults` call (one MC run) on the adopted
 * policy. Total is 5 runs (baseline + 4 scenarios). On M-series
 * silicon that's roughly 3-10 sec wall-clock at the engine's default
 * trial count — short enough that the UI just shows a progress bar
 * and yields between runs.
 *
 * Why not the cluster: serializing baseline + assumptions to the
 * dispatcher, queueing as a session, and polling for results would
 * add more latency than the 4-extra-runs save. The stress runs are
 * also small enough to comfortably finish before the user gets bored.
 *
 * Why not a Web Worker pool: the policy-miner pool is busy when a
 * mine is in progress; a separate stress-test pool would be more
 * infrastructure than the use case warrants. If the engine ever gets
 * meaningfully slower (e.g. 30 sec per run), revisit.
 */

interface Props {
  adoptedPolicy: Policy;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  legacyTargetTodayDollars: number;
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; completed: number; total: number; startedAtMs: number }
  | { kind: 'complete'; report: StressTestReport; finishedAtMs: number; startedAtMs: number }
  | { kind: 'failed'; reason: string };

function cloneSeedData(value: SeedData): SeedData {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as SeedData;
}

function formatCompactDollars(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  if (amount > 0) return `$${Math.round(amount)}`;
  if (amount === 0) return '$0';
  // Negative end-of-life wealth shouldn't happen at the percentile level
  // but the engine clips somewhere; render symmetrically just in case.
  if (amount <= -1_000_000) return `−$${(Math.abs(amount) / 1_000_000).toFixed(2)}M`;
  if (amount <= -1_000) return `−$${Math.round(Math.abs(amount) / 1_000)}k`;
  return `−$${Math.round(Math.abs(amount))}`;
}

function formatMonthlyDollars(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return `$${Math.round(Math.max(0, amount)).toLocaleString()}/mo`;
}

function formatAnnualDollars(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return `$${Math.round(Math.max(0, amount)).toLocaleString()}/yr`;
}

function deltaTone(deltaRate: number): string {
  switch (classifyFeasibilityDelta(deltaRate)) {
    case 'severe':
      return 'text-rose-700 font-semibold';
    case 'notable':
      return 'text-amber-700';
    case 'positive':
      return 'text-emerald-700';
    default:
      return 'text-stone-500';
    }
}

function spendingReadForScenario(input: {
  result: StressTestResult;
  baselineP50: number;
  adoptedAnnualSpend: number;
}): {
  headline: string;
  detail: string;
  toneClass: string;
} {
  const adoptedMonthlySpend = input.adoptedAnnualSpend / 12;
  if (input.result.scenario.id === 'baseline') {
    return {
      headline: `Keep ${formatMonthlyDollars(adoptedMonthlySpend)}`,
      detail: `${formatAnnualDollars(input.adoptedAnnualSpend)} adopted spend`,
      toneClass: 'text-stone-700',
    };
  }

  const bequestLoss = Math.max(
    0,
    input.baselineP50 - input.result.outcome.p50EndingWealthTodayDollars,
  );
  const horizonYears = Math.max(1, input.result.outcome.horizonYears || 30);
  const monthlyHeadroomEquivalent = bequestLoss / (horizonYears * 12);
  const feasibility = input.result.outcome.bequestAttainmentRate;
  const headline =
    feasibility >= 0.95
      ? 'No cut implied'
      : feasibility >= 0.85
        ? 'Still feasible'
        : 'Spending review';
  const toneClass =
    feasibility >= 0.95
      ? 'text-emerald-700'
      : feasibility >= 0.85
        ? 'text-amber-700'
        : 'text-rose-700 font-semibold';
  const detail =
    bequestLoss <= 0
      ? `tested at ${formatMonthlyDollars(adoptedMonthlySpend)}`
      : `${formatMonthlyDollars(
          monthlyHeadroomEquivalent,
        )} of monthly headroom lost at P50`;
  return { headline, detail, toneClass };
}

export function StressTestPanel({
  adoptedPolicy,
  baseline,
  assumptions,
  legacyTargetTodayDollars,
}: Props): JSX.Element {
  const [runState, setRunState] = useState<RunState>({ kind: 'idle' });

  // Memoize the cloner so React doesn't pass a new reference each render.
  // (Doesn't affect correctness, but keeps the StressTest contract clean.)
  const cloner = useMemo(() => cloneSeedData, []);

  const launch = async () => {
    const startedAtMs = Date.now();
    const total = DEFAULT_STRESS_SCENARIOS.length + 1; // +1 for baseline
    setRunState({ kind: 'running', completed: 0, total, startedAtMs });
    try {
      const report = await runPolicyStressTest(
        adoptedPolicy,
        baseline,
        assumptions,
        legacyTargetTodayDollars,
        cloner,
        {
          // Yield 16ms between scenarios so the UI repaints the
          // progress bar; without this React would batch all the
          // setState calls and only repaint once at the end.
          yieldEveryMs: 16,
          onProgress: (completed) => {
            setRunState((prev) =>
              prev.kind === 'running'
                ? { ...prev, completed }
                : prev,
            );
          },
        },
      );
      setRunState({
        kind: 'complete',
        report,
        finishedAtMs: Date.now(),
        startedAtMs,
      });
    } catch (e) {
      setRunState({
        kind: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const reset = () => setRunState({ kind: 'idle' });

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  const subtitle = (
    <p className="text-[12px] text-stone-500">
      Re-runs the adopted policy under {DEFAULT_STRESS_SCENARIOS.length} adverse
      scenarios so you can see whether your bequest target survives them.
    </p>
  );

  const renderControls = () => {
    if (runState.kind === 'idle') {
      return (
        <button
          type="button"
          onClick={launch}
          className="whitespace-nowrap rounded-lg bg-[#0066CC] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0071E3]"
        >
          Run stress test
        </button>
      );
    }
    if (runState.kind === 'complete' || runState.kind === 'failed') {
      return (
        <button
          type="button"
          onClick={reset}
          className="whitespace-nowrap rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-700 ring-1 ring-stone-200 transition hover:bg-stone-50"
        >
          Re-run
        </button>
      );
    }
    return null;
  };

  // -------------------------------------------------------------------------
  // Render the report table once complete
  // -------------------------------------------------------------------------

  const renderResultRow = (
    result: StressTestResult,
    baselineRate: number,
    baselineP50: number,
  ) => {
    const feasibilityDelta = result.outcome.bequestAttainmentRate - baselineRate;
    const bequestDelta =
      result.outcome.p50EndingWealthTodayDollars - baselineP50;
    const noStressorsApplied =
      result.scenario.stressorIds.length > 0 &&
      result.appliedStressors.length === 0;
    const spendingRead = spendingReadForScenario({
      result,
      baselineP50,
      adoptedAnnualSpend: adoptedPolicy.annualSpendTodayDollars,
    });
    return (
      <tr
        key={result.scenario.id}
        className="border-t border-stone-100 hover:bg-stone-50/60"
      >
        <td className="py-1.5 pr-2">
          <div className="font-medium text-stone-800">
            {result.scenario.name}
          </div>
          <div className="text-[11px] text-stone-500">
            {result.scenario.description}
          </div>
          {noStressorsApplied && (
            <div className="mt-0.5 text-[10px] text-amber-700">
              this baseline doesn&apos;t define the required stressor — no-op
            </div>
          )}
        </td>
        <td className="py-1.5 pr-2">
          <div className={`text-right text-[12px] font-semibold ${spendingRead.toneClass}`}>
            {spendingRead.headline}
          </div>
          <div className="text-right text-[10px] leading-4 text-stone-500">
            {spendingRead.detail}
          </div>
        </td>
        <td className="py-1.5 pr-2 text-right tabular-nums text-stone-700">
          {Math.round(result.outcome.bequestAttainmentRate * 100)}%
        </td>
        <td
          className={`py-1.5 pr-2 text-right tabular-nums ${deltaTone(feasibilityDelta)}`}
        >
          {formatFeasibilityDelta(feasibilityDelta)}
        </td>
        <td className="py-1.5 pr-2 text-right tabular-nums text-stone-700">
          {formatCompactDollars(result.outcome.p50EndingWealthTodayDollars)}
        </td>
        <td
          className={`py-1.5 pr-2 text-right tabular-nums ${
            bequestDelta < 0 ? 'text-rose-700' : bequestDelta > 0 ? 'text-emerald-700' : 'text-stone-500'
          }`}
        >
          {formatBequestDelta(bequestDelta)}
        </td>
        <td className="py-1.5 text-right tabular-nums text-stone-500">
          {formatCompactDollars(result.outcome.p10EndingWealthTodayDollars)}
        </td>
      </tr>
    );
  };

  const renderReport = (report: StressTestReport) => {
    const baselineRate = report.baseline.outcome.bequestAttainmentRate;
    const baselineP50 = report.baseline.outcome.p50EndingWealthTodayDollars;
    const baselineSpendingRead = spendingReadForScenario({
      result: report.baseline,
      baselineP50,
      adoptedAnnualSpend: adoptedPolicy.annualSpendTodayDollars,
    });
    const worst = worstCaseSummary(report);
    return (
      <div className="mt-3 rounded-lg border border-stone-200 bg-white px-3 py-2">
        {worst && (
          <p className="mb-2 text-[12px] text-stone-600">
            Worst case:{' '}
            <span className="font-semibold text-stone-800">
              {worst.scenarioName}
            </span>{' '}
            ·{' '}
            <span className={deltaTone(worst.feasibilityDeltaRate)}>
              {formatFeasibilityDelta(worst.feasibilityDeltaRate)} feasibility
            </span>{' '}
            ·{' '}
            <span
              className={
                worst.bequestDeltaDollars < 0
                  ? 'text-rose-700'
                  : 'text-emerald-700'
              }
            >
              {formatBequestDelta(worst.bequestDeltaDollars)} bequest
            </span>
          </p>
        )}
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="text-[10px] font-medium uppercase tracking-wider text-stone-400">
              <th className="py-1 pr-2">Scenario</th>
              <th className="py-1 pr-2 text-right">Spending read</th>
              <th className="py-1 pr-2 text-right">Feasibility</th>
              <th className="py-1 pr-2 text-right">Δ vs base</th>
              <th className="py-1 pr-2 text-right">Bequest P50</th>
              <th className="py-1 pr-2 text-right">Δ vs base</th>
              <th className="py-1 text-right">Bequest P10</th>
            </tr>
          </thead>
          <tbody>
            {/* Baseline first — no deltas, but useful as a reference row. */}
            <tr className="border-t border-stone-100 bg-stone-50/60">
              <td className="py-1.5 pr-2">
                <div className="font-medium text-stone-800">Baseline</div>
                <div className="text-[11px] text-stone-500">
                  {report.baseline.scenario.description}
                </div>
              </td>
              <td className="py-1.5 pr-2">
                <div
                  className={`text-right text-[12px] font-semibold ${baselineSpendingRead.toneClass}`}
                >
                  {baselineSpendingRead.headline}
                </div>
                <div className="text-right text-[10px] leading-4 text-stone-500">
                  {baselineSpendingRead.detail}
                </div>
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums font-semibold text-emerald-700">
                {Math.round(baselineRate * 100)}%
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-stone-400">
                —
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-stone-700">
                {formatCompactDollars(baselineP50)}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-stone-400">
                —
              </td>
              <td className="py-1.5 text-right tabular-nums text-stone-500">
                {formatCompactDollars(
                  report.baseline.outcome.p10EndingWealthTodayDollars,
                )}
              </td>
            </tr>
            {report.scenarios.map((r) =>
              renderResultRow(r, baselineRate, baselineP50),
            )}
          </tbody>
        </table>
      </div>
    );
  };

  // -------------------------------------------------------------------------
  // Top-level
  // -------------------------------------------------------------------------

  return (
    <div className="mt-3 rounded-2xl border border-stone-200 bg-stone-50/60 p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
            Stress test
          </p>
          {subtitle}
        </div>
        <div className="flex items-center gap-2">{renderControls()}</div>
      </div>

      {runState.kind === 'running' && (
        <div className="mt-3 text-[12px] text-stone-600">
          Running scenario {runState.completed} of {runState.total}…
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
            <div
              className="h-full bg-stone-700 transition-all"
              style={{
                width: `${Math.round((runState.completed / runState.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {runState.kind === 'failed' && (
        <p className="mt-3 text-[12px] text-rose-700">
          Couldn&apos;t run the stress test: {runState.reason}
        </p>
      )}

      {runState.kind === 'complete' && (
        <>
          <p className="mt-3 text-[12px] text-stone-500">
            Completed in{' '}
            {Math.max(
              1,
              Math.round((runState.finishedAtMs - runState.startedAtMs) / 1000),
            )}{' '}
            sec · {runState.report.scenarios.length + 1} runs
          </p>
          {renderReport(runState.report)}
        </>
      )}
    </div>
  );
}
