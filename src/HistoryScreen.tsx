/**
 * History screen — the household's plan-state archive over time.
 *
 * Each snapshot captures key trust metrics + the projection trajectory
 * at a moment in time. The screen renders:
 *   1. A line chart showing the most-tracked metrics over time
 *      (solvency rate, total assets, this-year spend) so trends are
 *      visible at a glance.
 *   2. A table of every snapshot with deltas vs the previous one —
 *      "your portfolio grew $40k since March; solvency unchanged."
 *   3. Per-row delete + rename so the household can curate.
 *
 * What's intentionally NOT here yet:
 *   - Side-by-side compare ("snapshot A vs snapshot B in detail") —
 *     could come if the trends chart proves insufficient.
 *   - Cloud sync — local-only by design; archival is via CSV export.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  deleteSnapshot,
  loadSnapshots,
  renameSnapshot,
  type PlanSnapshot,
  type SnapshotHoldingAggregate,
} from './history-store';

function formatDollars(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function formatPct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fileUrlForPath(path: string): string {
  if (path.startsWith('file://')) return path;
  return `file://${path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function deltaCell(
  current: number | null | undefined,
  previous: number | null | undefined,
  fmt: (n: number) => string,
): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (current == null || previous == null) return { text: '—', tone: 'flat' };
  const delta = current - previous;
  if (Math.abs(delta) < 1) return { text: 'unchanged', tone: 'flat' };
  return {
    text: `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}`,
    tone: delta > 0 ? 'up' : 'down',
  };
}

function formatSignedDollars(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1) return 'unchanged';
  return `${value > 0 ? '+' : '−'}${formatDollars(Math.abs(value))}`;
}

function formatSignedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < 0.0001) return 'unchanged';
  return `${value > 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}%`;
}

function bankCashValue(snapshot: PlanSnapshot): number {
  return snapshot.portfolioState?.bankCashValue ?? snapshot.accountBalances.cash;
}

function investmentValue(snapshot: PlanSnapshot): number {
  return (
    snapshot.portfolioState?.investmentValue ??
    snapshot.metrics.totalAssetsToday - snapshot.accountBalances.cash
  );
}

function holdingMap(snapshot: PlanSnapshot): Map<string, SnapshotHoldingAggregate> {
  return new Map(
    (snapshot.portfolioState?.holdingsBySymbol ?? []).map((holding) => [
      holding.symbol,
      holding,
    ]),
  );
}

interface HoldingComparisonRow {
  symbol: string;
  name?: string;
  currentValue: number;
  previousValue: number;
  valueDelta: number;
  currentShares: number | null;
  previousShares: number | null;
  valueDeltaPercent: number | null;
  accounts: string[];
}

function compareHoldings(
  current: PlanSnapshot,
  previous: PlanSnapshot | null,
): HoldingComparisonRow[] {
  if (!previous) return [];
  const currentMap = holdingMap(current);
  const previousMap = holdingMap(previous);
  const symbols = new Set([...currentMap.keys(), ...previousMap.keys()]);
  const rows: HoldingComparisonRow[] = [];
  for (const symbol of symbols) {
    if (symbol === 'CASH') continue;
    const currentHolding = currentMap.get(symbol);
    const previousHolding = previousMap.get(symbol);
    const currentValue = currentHolding?.value ?? 0;
    const previousValue = previousHolding?.value ?? 0;
    const valueDelta = currentValue - previousValue;
    rows.push({
      symbol,
      name: currentHolding?.name ?? previousHolding?.name,
      currentValue,
      previousValue,
      valueDelta,
      currentShares: currentHolding?.shares ?? null,
      previousShares: previousHolding?.shares ?? null,
      valueDeltaPercent:
        previousValue > 0 ? valueDelta / previousValue : currentValue > 0 ? 1 : null,
      accounts: currentHolding?.accounts ?? previousHolding?.accounts ?? [],
    });
  }
  return rows.sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta));
}

function downloadHistoryCsv(snapshots: PlanSnapshot[]): void {
  const escape = (s: string): string =>
    /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const round = (n: number | null | undefined): string =>
    n == null || !Number.isFinite(n) ? '' : Math.round(n).toString();
  const header = [
    'Captured at',
    'Label',
    'Solvent rate',
    'Median ending wealth',
    'Total assets (today)',
    'Adopted spend',
    'This year projected spend',
    'This year projected MAGI',
    'IRMAA tier',
    'Legacy target',
    'Pretax balance',
    'Roth balance',
    'Taxable balance',
    'Cash balance',
    'Investment value',
    'Bank/cash value',
    'Holding count',
    'Holdings as of',
    'Recommendation status',
    'Recommendation annual spend',
    'AI verdict',
    'Proof bundle',
    'Engine version',
    'Simulation runs',
  ]
    .map(escape)
    .join(',');
  const rows = snapshots.map((s) =>
    [
      escape(s.capturedAtIso),
      escape(s.label),
      s.metrics.solventSuccessRate.toFixed(4),
      round(s.metrics.medianEndingWealth),
      round(s.metrics.totalAssetsToday),
      round(s.metrics.adoptedAnnualSpend),
      round(s.metrics.thisYearProjectedSpend),
      round(s.metrics.thisYearProjectedMagi),
      escape(s.metrics.thisYearIrmaaTier ?? ''),
      round(s.metrics.legacyTargetTodayDollars),
      round(s.accountBalances.pretax),
      round(s.accountBalances.roth),
      round(s.accountBalances.taxable),
      round(s.accountBalances.cash),
      round(investmentValue(s)),
      round(bankCashValue(s)),
      (s.portfolioState?.holdingCount ?? '').toString(),
      escape(s.portfolioState?.holdingsAsOfDate ?? ''),
      escape(s.planHighlights?.recommendationStatus ?? ''),
      round(s.planHighlights?.annualSpendTodayDollars),
      escape(s.planHighlights?.aiVerdict ?? ''),
      escape(s.planHighlights?.proofBundlePath ?? ''),
      escape(s.engineVersion),
      s.simulationRuns.toString(),
    ].join(','),
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flight-path-history-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function HistoryScreen() {
  const [snapshots, setSnapshots] = useState<PlanSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const all = await loadSnapshots();
      setSnapshots(all);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[history] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Time-series chart points: oldest first so the line goes left→right.
  const chartData = useMemo(() => {
    return [...snapshots]
      .reverse()
      .map((s) => ({
        capturedAt: new Date(s.capturedAtIso).getTime(),
        label: formatDate(s.capturedAtIso),
        totalAssets: s.metrics.totalAssetsToday,
        medianEndingWealth: s.metrics.medianEndingWealth,
        solventPct: Math.round(s.metrics.solventSuccessRate * 100),
        thisYearSpend: s.metrics.thisYearProjectedSpend ?? 0,
      }));
  }, [snapshots]);

  const latestSnapshot = snapshots[0] ?? null;
  const previousSnapshot = snapshots[1] ?? null;
  const holdingComparisons = useMemo(
    () =>
      latestSnapshot
        ? compareHoldings(latestSnapshot, previousSnapshot).slice(0, 10)
        : [],
    [latestSnapshot, previousSnapshot],
  );

  const handleDelete = async (id: string) => {
    if (
      !window.confirm(
        'Delete this snapshot? This cannot be undone — the snapshot is removed from your local history.',
      )
    ) {
      return;
    }
    try {
      await deleteSnapshot(id);
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[history] delete failed:', err);
    }
  };

  const startRename = (snap: PlanSnapshot) => {
    setRenamingId(snap.snapshotId);
    setRenameDraft(snap.label);
  };
  const commitRename = async () => {
    if (!renamingId) return;
    try {
      await renameSnapshot(renamingId, renameDraft.trim() || 'Untitled');
      setRenamingId(null);
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[history] rename failed:', err);
    }
  };

  return (
    <div className="space-y-6 py-2">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0066CC]">
            Over time
          </p>
          <h1 className="mt-2 text-4xl font-semibold leading-tight tracking-tight text-stone-900">
            Plan history
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => downloadHistoryCsv(snapshots)}
            disabled={snapshots.length === 0}
            className="whitespace-nowrap rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-700 ring-1 ring-stone-200 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="whitespace-nowrap rounded-lg bg-stone-100 px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-200"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && (
        <p className="text-sm text-stone-500">Loading snapshots…</p>
      )}

      {!loading && snapshots.length === 0 && (
        <div className="rounded-3xl bg-white p-8 text-center shadow-[0_2px_24px_rgba(15,40,80,0.05)]">
          <p className="text-base font-medium text-stone-700">
            No snapshots yet.
          </p>
          <p className="mt-2 text-sm text-stone-500">
            Save your first snapshot from the Cockpit footer after running a
            mine. The household's monthly check-in is a natural cadence — you'll
            be able to compare assets, solvency, and spend over time.
          </p>
        </div>
      )}

      {!loading && snapshots.length > 0 && (
        <>
          {latestSnapshot && (
            <div className="rounded-3xl bg-white p-6 shadow-[0_2px_24px_rgba(15,40,80,0.05)]">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-stone-400">
                    Latest checkpoint
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-stone-900">
                    Investments, bank/cash, and monthly recommendation
                  </h2>
                  <p className="mt-1 text-sm text-stone-500">
                    {formatDate(latestSnapshot.capturedAtIso)}
                    {latestSnapshot.portfolioState?.holdingsAsOfDate
                      ? ` · holdings as of ${latestSnapshot.portfolioState.holdingsAsOfDate}`
                      : ''}
                  </p>
                </div>
                {latestSnapshot.planHighlights?.proofBundlePath ? (
                  <a
                    href={fileUrlForPath(latestSnapshot.planHighlights.proofBundlePath)}
                    className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-800"
                  >
                    Open proof bundle
                  </a>
                ) : null}
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
                    Investments
                  </p>
                  <p className="mt-1 text-lg font-semibold text-stone-900">
                    {formatDollars(investmentValue(latestSnapshot))}
                  </p>
                  {previousSnapshot ? (
                    <p className="text-[11px] text-stone-500">
                      {formatSignedDollars(
                        investmentValue(latestSnapshot) -
                          investmentValue(previousSnapshot),
                      )}{' '}
                      vs previous
                    </p>
                  ) : null}
                </div>
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
                    Bank/cash
                  </p>
                  <p className="mt-1 text-lg font-semibold text-stone-900">
                    {formatDollars(bankCashValue(latestSnapshot))}
                  </p>
                  {previousSnapshot ? (
                    <p className="text-[11px] text-stone-500">
                      {formatSignedDollars(
                        bankCashValue(latestSnapshot) -
                          bankCashValue(previousSnapshot),
                      )}{' '}
                      vs previous
                    </p>
                  ) : null}
                </div>
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
                    Holdings
                  </p>
                  <p className="mt-1 text-lg font-semibold text-stone-900">
                    {latestSnapshot.portfolioState?.holdingCount ?? 0}
                  </p>
                  <p className="text-[11px] text-stone-500">
                    {latestSnapshot.portfolioState?.sourceAccountCount ?? 0} source accounts
                  </p>
                </div>
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
                    Monthly recommendation
                  </p>
                  <p className="mt-1 text-lg font-semibold text-stone-900">
                    {formatDollars(
                      latestSnapshot.planHighlights?.annualSpendTodayDollars,
                    )}
                    /yr
                  </p>
                  <p className="text-[11px] text-stone-500">
                    {latestSnapshot.planHighlights?.aiVerdict ?? 'no AI review'} ·{' '}
                    {latestSnapshot.planHighlights?.recommendationStatus ?? 'no status'}
                  </p>
                </div>
              </div>
              {latestSnapshot.planHighlights?.summary ? (
                <p className="mt-3 rounded-xl bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  {latestSnapshot.planHighlights.summary}
                </p>
              ) : null}
            </div>
          )}

          {latestSnapshot && previousSnapshot && holdingComparisons.length > 0 && (
            <div className="rounded-3xl bg-white p-6 shadow-[0_2px_24px_rgba(15,40,80,0.05)]">
              <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-stone-400">
                Since previous checkpoint
              </p>
              <p className="mt-2 text-sm text-stone-500">
                Largest holding changes by value. This is the quick read after a
                Fidelity refresh: what grew, what shrank, and where cash moved.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-[12px] tabular-nums">
                  <thead>
                    <tr className="border-b border-stone-200 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                      <th className="py-2 pr-3">Holding</th>
                      <th className="py-2 pr-3 text-right">Current</th>
                      <th className="py-2 pr-3 text-right">Previous</th>
                      <th className="py-2 pr-3 text-right">Δ value</th>
                      <th className="py-2 pr-3 text-right">Δ %</th>
                      <th className="py-2 pr-3">Accounts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdingComparisons.map((row) => (
                      <tr
                        key={row.symbol}
                        className="border-b border-stone-100 last:border-b-0"
                      >
                        <td className="py-2 pr-3">
                          <p className="font-semibold text-stone-900">{row.symbol}</p>
                          <p className="max-w-[260px] truncate text-[11px] text-stone-500">
                            {row.name}
                          </p>
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {formatDollars(row.currentValue)}
                        </td>
                        <td className="py-2 pr-3 text-right text-stone-500">
                          {formatDollars(row.previousValue)}
                        </td>
                        <td
                          className={`py-2 pr-3 text-right font-medium ${
                            row.valueDelta >= 0 ? 'text-emerald-700' : 'text-rose-600'
                          }`}
                        >
                          {formatSignedDollars(row.valueDelta)}
                        </td>
                        <td
                          className={`py-2 pr-3 text-right ${
                            row.valueDelta >= 0 ? 'text-emerald-700' : 'text-rose-600'
                          }`}
                        >
                          {formatSignedPct(row.valueDeltaPercent)}
                        </td>
                        <td className="py-2 pr-3 text-[11px] text-stone-500">
                          {row.accounts.slice(0, 2).join(', ')}
                          {row.accounts.length > 2 ? ` +${row.accounts.length - 2}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="rounded-3xl bg-white p-6 shadow-[0_2px_24px_rgba(15,40,80,0.05)]">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-stone-400">
              Trends
            </p>
            <p className="mt-2 text-sm text-stone-500">
              Total assets and this-year projected spend over time.
              Hover any point for the snapshot's exact values.
            </p>
            <div className="mt-4" style={{ width: '100%', height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                >
                  <CartesianGrid stroke="#f0ede7" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#a8a29e' }}
                    stroke="#d6d3d1"
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11, fill: '#a8a29e' }}
                    stroke="#d6d3d1"
                    tickFormatter={(v) => formatDollars(v)}
                    width={56}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: '#a8a29e' }}
                    stroke="#d6d3d1"
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}%`}
                    width={36}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 12,
                      border: 'none',
                      boxShadow: '0 4px 24px rgba(60,70,40,0.12)',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="totalAssets"
                    name="Total assets"
                    stroke="#0071E3"
                    strokeWidth={2.5}
                    dot
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="thisYearSpend"
                    name="This-year spend"
                    stroke="#78716c"
                    strokeWidth={1.5}
                    dot
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="solventPct"
                    name="Solvent %"
                    stroke="#3B9DEB"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    dot
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-3xl bg-white p-6 shadow-[0_2px_24px_rgba(15,40,80,0.05)]">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-stone-400">
              Snapshots
            </p>
            <p className="mt-2 text-sm text-stone-500">
              {snapshots.length} captured · most recent first. Δ shows
              change from the next-older snapshot.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-[12px] tabular-nums">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Label</th>
                    <th className="py-2 pr-3 text-right">Total assets</th>
                    <th className="py-2 pr-3 text-right">Δ</th>
                    <th className="py-2 pr-3 text-right">Solvent</th>
                    <th className="py-2 pr-3 text-right">Δ</th>
                    <th className="py-2 pr-3 text-right">Adopted spend</th>
                    <th className="py-2 pr-3 text-right">Engine</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((snap, idx) => {
                    const prev = snapshots[idx + 1] ?? null;
                    const assetDelta = deltaCell(
                      snap.metrics.totalAssetsToday,
                      prev?.metrics.totalAssetsToday,
                      formatDollars,
                    );
                    const solventDelta = deltaCell(
                      Math.round(snap.metrics.solventSuccessRate * 100),
                      prev
                        ? Math.round(prev.metrics.solventSuccessRate * 100)
                        : null,
                      (n) => `${Math.round(n)}pp`,
                    );
                    const isRenaming = renamingId === snap.snapshotId;
                    return (
                      <tr
                        key={snap.snapshotId}
                        className="border-b border-stone-100 last:border-b-0 hover:bg-stone-50/40"
                      >
                        <td className="py-2 pr-3 text-stone-700">
                          {formatDate(snap.capturedAtIso)}
                        </td>
                        <td className="py-2 pr-3">
                          {isRenaming ? (
                            <input
                              type="text"
                              value={renameDraft}
                              autoFocus
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onBlur={() => void commitRename()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter')
                                  void commitRename();
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                              className="rounded border border-stone-300 px-2 py-1 text-[12px]"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => startRename(snap)}
                              className="text-stone-800 hover:text-[#0066CC]"
                              title="Click to rename"
                            >
                              {snap.label}
                            </button>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right font-medium text-stone-800">
                          {formatDollars(snap.metrics.totalAssetsToday)}
                        </td>
                        <td
                          className={`py-2 pr-3 text-right text-[11px] ${
                            assetDelta.tone === 'up'
                              ? 'text-emerald-700'
                              : assetDelta.tone === 'down'
                              ? 'text-rose-600'
                              : 'text-stone-400'
                          }`}
                        >
                          {assetDelta.text}
                        </td>
                        <td className="py-2 pr-3 text-right font-medium text-stone-800">
                          {formatPct(snap.metrics.solventSuccessRate)}
                        </td>
                        <td
                          className={`py-2 pr-3 text-right text-[11px] ${
                            solventDelta.tone === 'up'
                              ? 'text-emerald-700'
                              : solventDelta.tone === 'down'
                              ? 'text-rose-600'
                              : 'text-stone-400'
                          }`}
                        >
                          {solventDelta.text}
                        </td>
                        <td className="py-2 pr-3 text-right text-stone-700">
                          {formatDollars(snap.metrics.adoptedAnnualSpend)}
                        </td>
                        <td className="py-2 pr-3 text-right text-[11px] text-stone-400">
                          {snap.engineVersion}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void handleDelete(snap.snapshotId)}
                            className="rounded-md px-2 py-1 text-[11px] text-stone-400 transition hover:bg-rose-50 hover:text-rose-600"
                            title="Delete snapshot"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
