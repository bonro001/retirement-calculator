import { useMemo } from 'react';
import type { ActualsLogStore } from './actuals-log';
import {
  detectBehaviorChanges,
  type BehaviorChangeDiff,
} from './behavior-change-detector';
import type { PredictionLogStore } from './prediction-log';
import {
  reconcileActualsVsPredictions,
  summarizeReconciliation,
  type ReconciliationRow,
} from './reconciliation';

// CALIBRATION_WORKPLAN step 7: read-only dashboard of predictions vs
// actuals plus the behavior-change log.
//
// Composes src/reconciliation.ts and src/behavior-change-detector.ts
// into a single tile. Two sections:
//   1. "Prediction vs realized" — table of matched reconciliation rows
//      with absolute + percentage delta, colored by direction. Summary
//      chip shows mean deltaPct per metric.
//   2. "Plan changes over time" — chronological list of behavior-change
//      diffs so the user can see what moved between snapshots (plan
//      drift vs model error attribution).
//
// IMPORTANT: untested in a real browser by the author. No render test.

export interface DeltaDashboardTileProps {
  predictionStore: PredictionLogStore;
  actualsStore: ActualsLogStore;
  title?: string;
  // Limit how many recent reconciliation rows and plan-change rows are
  // rendered at once. Prevents dashboard bloat when logs accumulate.
  maxRows?: number;
}

function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

function fmtMetric(row: ReconciliationRow): string {
  if (row.metric === 'monthly_spending') return 'Monthly spend';
  if (row.metric === 'annual_federal_tax') return 'Annual federal tax';
  if (row.metric === 'total_balance') return 'Total balance';
  if (row.metric === 'life_event') return 'Life event';
  return row.metric;
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.valueOf()) ? iso : d.toISOString().slice(0, 10);
}

function deltaColor(deltaPct: number | null): string {
  if (deltaPct === null) return 'text-stone-500';
  if (Math.abs(deltaPct) < 2) return 'text-stone-700';
  if (deltaPct > 0) return 'text-emerald-700';
  return 'text-red-700';
}

const CATEGORY_LABEL: Record<BehaviorChangeDiff['changes'][number]['category'], string> = {
  retirement_timing: 'Retirement timing',
  spending: 'Spending',
  accounts: 'Accounts',
  income: 'Income',
  stressors_responses: 'Stress/response picks',
  assumptions: 'Assumptions',
  other: 'Other',
};

export function DeltaDashboardTile({
  predictionStore,
  actualsStore,
  title = 'Prediction vs actuals',
  maxRows = 10,
}: DeltaDashboardTileProps) {
  const { rows, summary, diffs } = useMemo(() => {
    const rows = reconcileActualsVsPredictions(predictionStore, actualsStore);
    const summary = summarizeReconciliation(rows);
    const diffs = detectBehaviorChanges(predictionStore);
    return { rows, summary, diffs };
  }, [predictionStore, actualsStore]);

  const recentRows = [...rows]
    .sort(
      (left, right) =>
        new Date(right.actualsTimestamp).valueOf() -
        new Date(left.actualsTimestamp).valueOf(),
    )
    .slice(0, maxRows);
  const recentDiffs = [...diffs]
    .sort(
      (left, right) =>
        new Date(right.toTimestamp).valueOf() -
        new Date(left.toTimestamp).valueOf(),
    )
    .slice(0, maxRows);

  const hasAnyData = rows.length > 0 || diffs.length > 0;

  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <header className="flex items-center justify-between">
        <p className="text-sm font-medium text-stone-500">{title}</p>
        <p className="text-xs text-stone-500">
          {summary.totalRows} reconciliation{' '}
          {summary.totalRows === 1 ? 'row' : 'rows'} ·{' '}
          {diffs.length} plan change{diffs.length === 1 ? '' : 's'}
        </p>
      </header>

      {!hasAnyData ? (
        <p className="mt-3 text-sm text-stone-600">
          No reconciliation rows or plan changes yet. As you log actual
          balances / spending / tax and as the plan evolves, this tile
          will show the predicted-vs-actual deltas and a changelog of
          what moved.
        </p>
      ) : null}

      {summary.metricSummaries.length > 0 ? (
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs text-stone-700">
          {summary.metricSummaries.map((metric) => (
            <div
              key={metric.metric}
              className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-2"
            >
              <dt className="font-medium text-stone-800">
                {fmtMetric({ metric: metric.metric } as ReconciliationRow)}
              </dt>
              <dd className="mt-0.5">
                {metric.count} sample{metric.count === 1 ? '' : 's'}
              </dd>
              <dd className={`mt-0.5 tabular-nums ${deltaColor(metric.meanDeltaPct)}`}>
                mean Δ {metric.meanDeltaPct !== null ? fmtPct(metric.meanDeltaPct) : '—'}
              </dd>
              <dd className="mt-0.5 text-stone-500 tabular-nums">
                median Δ{' '}
                {metric.medianDeltaPct !== null ? fmtPct(metric.medianDeltaPct) : '—'}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {recentRows.length > 0 ? (
        <section className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">
            Recent reconciliations
          </h3>
          <ul className="mt-2 divide-y divide-stone-200 text-xs text-stone-700">
            {recentRows.map((row, idx) => (
              <li
                key={`${row.actualsTimestamp}-${row.metric}-${idx}`}
                className="flex items-start justify-between gap-3 py-2"
              >
                <div>
                  <p className="font-medium text-stone-800">
                    {fmtMetric(row)} · {row.year}
                  </p>
                  <p className="text-stone-500">
                    {fmtDate(row.actualsTimestamp)} · horizon{' '}
                    {row.horizonDays}d · fingerprint{' '}
                    {row.planFingerprintMatch ? 'match' : (
                      <span className="text-amber-700">drift</span>
                    )}
                  </p>
                  {row.notes.length > 0 ? (
                    <p className="mt-0.5 text-stone-500">{row.notes.join(' ; ')}</p>
                  ) : null}
                </div>
                <div className="text-right tabular-nums">
                  <p className="text-stone-800">
                    actual {fmtCurrency(row.actual)}
                  </p>
                  <p className="text-stone-500">
                    predicted{' '}
                    {row.predicted !== null ? fmtCurrency(row.predicted) : '—'}
                  </p>
                  <p className={deltaColor(row.deltaPct)}>
                    {row.deltaPct !== null ? fmtPct(row.deltaPct) : '—'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {recentDiffs.length > 0 ? (
        <section className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">
            Plan changes
          </h3>
          <ul className="mt-2 space-y-2 text-xs text-stone-700">
            {recentDiffs.map((diff) => (
              <li
                key={`${diff.fromTimestamp}->${diff.toTimestamp}`}
                className="rounded-lg border border-stone-200 bg-white/60 px-3 py-2"
              >
                <p className="font-medium text-stone-800">
                  {fmtDate(diff.fromTimestamp)} → {fmtDate(diff.toTimestamp)}
                </p>
                <p className="text-stone-500">{diff.summary}</p>
                <ul className="mt-1 space-y-0.5">
                  {diff.changes.slice(0, 5).map((change, idx) => (
                    <li key={`${change.field}-${idx}`}>
                      <span className="text-stone-500">
                        [{CATEGORY_LABEL[change.category]}]
                      </span>{' '}
                      {change.description}
                    </li>
                  ))}
                  {diff.changes.length > 5 ? (
                    <li className="text-stone-500">
                      …and {diff.changes.length - 5} more.
                    </li>
                  ) : null}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
