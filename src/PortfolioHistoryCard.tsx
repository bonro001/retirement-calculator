import { useMemo } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAppStore } from './store';
import { formatCurrency, formatPercent } from './utils';

interface ChartPoint {
  t: number;
  label: string;
  capturedAt: string;
  totalBalance: number;
  successRate: number | null;
}

export function PortfolioHistoryCard() {
  const snapshots = useAppStore((state) => state.planSnapshots);

  const points = useMemo<ChartPoint[]>(
    () =>
      [...snapshots]
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
        .map((snapshot) => ({
          t: new Date(snapshot.capturedAt).getTime(),
          label: snapshot.label,
          capturedAt: snapshot.capturedAt.slice(0, 10),
          totalBalance: snapshot.totalBalance,
          successRate: snapshot.successRate,
        })),
    [snapshots],
  );

  const latest = points[points.length - 1];
  const earliest = points[0];
  const hasSuccess = points.some((point) => typeof point.successRate === 'number');

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-stone-900">Portfolio history</p>
          <p className="text-xs text-stone-600">
            Snapshots captured at each import. Each point is a frozen view of plan quality on that date.
          </p>
        </div>
        <div className="text-right text-xs text-stone-500">
          {points.length} snapshot{points.length === 1 ? '' : 's'}
          {earliest && latest && earliest !== latest ? (
            <span className="ml-2">
              {earliest.capturedAt} → {latest.capturedAt}
            </span>
          ) : null}
        </div>
      </div>

      {points.length < 2 ? (
        <p className="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
          Only {points.length} snapshot on file. The chart will populate as portfolio imports accumulate.
          {latest ? (
            <>
              {' '}
              Current: {formatCurrency(latest.totalBalance)}
              {typeof latest.successRate === 'number'
                ? ` · success ${formatPercent(latest.successRate)}`
                : ''}
              .
            </>
          ) : null}
        </p>
      ) : (
        <div className="mt-3 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#e7e5e4" strokeDasharray="3 3" />
              <XAxis
                dataKey="capturedAt"
                tick={{ fontSize: 11, fill: '#78716c' }}
                tickMargin={8}
              />
              <YAxis
                yAxisId="balance"
                tick={{ fontSize: 11, fill: '#78716c' }}
                tickFormatter={(value: number) => `$${Math.round(value / 1000)}k`}
                width={56}
              />
              {hasSuccess ? (
                <YAxis
                  yAxisId="success"
                  orientation="right"
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: '#0f766e' }}
                  tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
                  width={44}
                />
              ) : null}
              <Tooltip
                formatter={(value: number | string, name: string) => {
                  if (name === 'Total balance') return formatCurrency(Number(value));
                  if (name === 'Success rate') return formatPercent(Number(value));
                  return value;
                }}
                labelStyle={{ color: '#57534e' }}
              />
              <Line
                yAxisId="balance"
                name="Total balance"
                type="monotone"
                dataKey="totalBalance"
                stroke="#1e3a8a"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              {hasSuccess ? (
                <Line
                  yAxisId="success"
                  name="Success rate"
                  type="monotone"
                  dataKey="successRate"
                  stroke="#0f766e"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={{ r: 3 }}
                  connectNulls
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
