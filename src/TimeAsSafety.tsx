import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketAssumptions, SeedData } from './types';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import {
  loadTimeAsSafetyFromCache,
  saveTimeAsSafetyToCache,
} from './time-as-safety-cache';
import type { SweepPointInput, SweepWorkerResponse } from './sweep-worker-types';
import { runSweepBatch, type SweepPoolHandle } from './sweep-worker-pool';

type StrategyMode = 'raw_simulation' | 'planner_enhanced';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const DEFAULT_OFFSETS = [-3, 0, 3, 6, 9, 12];

export interface TimeAsSafetyPoint {
  monthsShift: number;
  shiftedSalaryEndDate: string;
  successRate: number;
  successRatePct: number;
  medianEndingWealth: number;
}

function cloneSeedData<T>(value: T): T {
  return structuredClone(value);
}

function shiftSalaryEndDate(iso: string, months: number): string {
  const base = new Date(iso);
  base.setMonth(base.getMonth() + months);
  return base.toISOString().slice(0, 10);
}

interface HookArgs {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  strategyMode: StrategyMode;
}

interface HookResult {
  points: TimeAsSafetyPoint[];
  loadState: LoadState;
  progress: number;
  error: string | null;
  isStale: boolean;
  calculate: () => void;
}

export function useTimeAsSafetyScenarios(args: HookArgs): HookResult {
  const { data, assumptions, selectedStressors, selectedResponses, strategyMode } = args;
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [points, setPoints] = useState<TimeAsSafetyPoint[]>([]);
  const [cachedFingerprint, setCachedFingerprint] = useState<string | null>(null);

  const fingerprint = useMemo(
    () =>
      `tas|${strategyMode}|${buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
      })}`,
    [assumptions, data, selectedResponses, selectedStressors, strategyMode],
  );

  const runTokenRef = useRef(0);
  const inFlightRef = useRef<SweepPoolHandle | null>(null);

  useEffect(() => {
    return () => {
      if (inFlightRef.current) {
        inFlightRef.current.cancel();
        inFlightRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await loadTimeAsSafetyFromCache<TimeAsSafetyPoint>(fingerprint);
      if (cancelled) return;
      if (cached) {
        setPoints(cached);
        setCachedFingerprint(fingerprint);
        setProgress(1);
        setLoadState('ready');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fingerprint]);

  const calculate = useCallback(() => {
    const token = ++runTokenRef.current;
    setLoadState('loading');
    setError(null);
    setProgress(0);

    // Cancel any in-flight batch before starting a new one.
    if (inFlightRef.current) {
      inFlightRef.current.cancel();
      inFlightRef.current = null;
    }

    const offsets = DEFAULT_OFFSETS;
    const batchId = `tas-${token}-${Date.now()}`;

    const sweepPoints: SweepPointInput[] = offsets.map((months) => {
      const scenario = cloneSeedData(data);
      scenario.income.salaryEndDate = shiftSalaryEndDate(data.income.salaryEndDate, months);
      return {
        pointId: `m${months}`,
        data: scenario,
        assumptions,
        selectedStressors,
        selectedResponses,
        strategyMode,
      };
    });

    const collected: Map<string, TimeAsSafetyPoint> = new Map();

    const onEvent = (msg: SweepWorkerResponse) => {
      if (msg.batchId !== batchId) return;
      if (runTokenRef.current !== token) return;

      if (msg.type === 'progress') {
        const perPoint = 1 / msg.total;
        const completedFraction = msg.index * perPoint;
        setProgress(Math.min(0.99, completedFraction + msg.pointProgress * perPoint));
      } else if (msg.type === 'point') {
        const months = Number(msg.pointId.replace('m', ''));
        const scenario = sweepPoints[msg.index];
        collected.set(msg.pointId, {
          monthsShift: months,
          shiftedSalaryEndDate: scenario.data.income.salaryEndDate,
          successRate: msg.path.successRate,
          successRatePct: msg.path.successRate * 100,
          medianEndingWealth: msg.path.medianEndingWealth,
        });
        setProgress((collected.size) / msg.total);
      } else if (msg.type === 'done') {
        const next = Array.from(collected.values()).sort((a, b) => a.monthsShift - b.monthsShift);
        setPoints(next);
        setCachedFingerprint(fingerprint);
        setLoadState('ready');
        setProgress(1);
        void saveTimeAsSafetyToCache(fingerprint, next);
        if (inFlightRef.current?.batchId === batchId) inFlightRef.current = null;
      } else if (msg.type === 'cancelled') {
        if (inFlightRef.current?.batchId === batchId) inFlightRef.current = null;
      } else if (msg.type === 'error') {
        setError(msg.error || 'Time-as-safety scenarios failed.');
        setLoadState('error');
        if (inFlightRef.current?.batchId === batchId) inFlightRef.current = null;
      }
    };

    inFlightRef.current = runSweepBatch(batchId, sweepPoints, onEvent);
  }, [assumptions, data, fingerprint, selectedResponses, selectedStressors, strategyMode]);

  const isStale = points.length > 0 && cachedFingerprint !== null && cachedFingerprint !== fingerprint;

  return { points, loadState, progress, error, isStale, calculate };
}

function formatMonthsLabel(months: number): string {
  if (months === 0) return 'today';
  const sign = months > 0 ? '+' : '−';
  const abs = Math.abs(months);
  return `${sign}${abs} mo`;
}

function slopePerMonth(points: TimeAsSafetyPoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const span = last.monthsShift - first.monthsShift;
  if (span <= 0) return null;
  return ((last.successRate - first.successRate) * 100) / span;
}

function TimeAsSafetyDivergingBar(props: {
  points: TimeAsSafetyPoint[];
  current: TimeAsSafetyPoint;
}) {
  const { points, current } = props;

  // Max absolute delta (pts) to scale bar widths. Floor at 1 to avoid divide-by-zero.
  const maxAbsDelta = Math.max(
    1,
    ...points.map((p) => Math.abs((p.successRate - current.successRate) * 100)),
  );

  const earlier = points.filter((p) => p.monthsShift < 0).sort((a, b) => a.monthsShift - b.monthsShift);
  const later = points.filter((p) => p.monthsShift > 0).sort((a, b) => a.monthsShift - b.monthsShift);

  const row = (p: TimeAsSafetyPoint, side: 'left' | 'right') => {
    const deltaPts = (p.successRate - current.successRate) * 100;
    const widthPct = Math.min(100, (Math.abs(deltaPts) / maxAbsDelta) * 100);
    const isGain = deltaPts > 0;
    const color = isGain ? 'bg-emerald-500' : deltaPts < 0 ? 'bg-rose-500' : 'bg-stone-300';
    const sign = deltaPts > 0 ? '+' : deltaPts < 0 ? '−' : '';
    const label = formatMonthsLabel(p.monthsShift);
    return (
      <div key={p.monthsShift} className="grid grid-cols-[4rem_1fr_1fr_4.5rem] items-center gap-2 text-xs">
        <span className="text-right font-medium text-stone-600">{label}</span>
        {/* Left track */}
        <div className="relative h-5 rounded-l-full bg-stone-100">
          {side === 'left' ? (
            <div
              className={`absolute right-0 top-0 h-full rounded-l-full ${color}`}
              style={{ width: `${widthPct}%` }}
            />
          ) : null}
        </div>
        {/* Right track */}
        <div className="relative h-5 rounded-r-full bg-stone-100">
          {side === 'right' ? (
            <div
              className={`absolute left-0 top-0 h-full rounded-r-full ${color}`}
              style={{ width: `${widthPct}%` }}
            />
          ) : null}
        </div>
        <span className="text-right tabular-nums text-stone-700">
          <span className="font-semibold">{p.successRatePct.toFixed(0)}%</span>
          <span className="ml-1 text-[11px] text-stone-500">
            {deltaPts === 0 ? '—' : `${sign}${Math.abs(deltaPts).toFixed(1)}`}
          </span>
        </span>
      </div>
    );
  };

  return (
    <div className="mt-4 rounded-2xl bg-white/80 p-4 ring-1 ring-stone-200">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
          Shift vs. current plan
        </p>
        <p className="text-[11px] text-stone-500">
          center = your planned retirement date
        </p>
      </div>
      <div className="mt-3 space-y-1.5">
        {/* Earlier rows (red, left of center) */}
        {earlier.map((p) => row(p, 'left'))}
        {/* Center row — current plan anchor */}
        <div className="grid grid-cols-[4rem_1fr_1fr_4.5rem] items-center gap-2 text-xs">
          <span className="text-right font-semibold text-blue-700">planned</span>
          <div className="relative h-5 rounded-l-full bg-blue-50" />
          <div className="relative h-5 rounded-r-full bg-blue-50">
            <div className="absolute left-0 top-0 h-full w-px bg-blue-700" />
          </div>
          <span className="text-right tabular-nums font-semibold text-blue-700">
            {current.successRatePct.toFixed(0)}%
          </span>
        </div>
        {/* Later rows (green, right of center) */}
        {later.map((p) => row(p, 'right'))}
      </div>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-stone-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-full bg-rose-500" />
          Leaving earlier (lose pts)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-full bg-emerald-500" />
          Working longer (gain pts)
        </span>
      </div>
    </div>
  );
}

export function TimeAsSafetyStrip(props: {
  points: TimeAsSafetyPoint[];
  loadState: LoadState;
  progress: number;
  error: string | null;
  isStale: boolean;
  onCalculate: () => void;
}) {
  const { points, loadState, progress, error, isStale, onCalculate } = props;
  const isLoading = loadState === 'loading';
  const hasData = points.length > 0;

  const current = useMemo(() => points.find((p) => p.monthsShift === 0) ?? null, [points]);
  const slope = useMemo(() => slopePerMonth(points), [points]);
  const anchorMonths = [3, 6, 12];
  const anchors = useMemo(
    () => anchorMonths.map((m) => points.find((p) => p.monthsShift === m) ?? null),
    [points],
  );

  return (
    <section className="rounded-[28px] border border-stone-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(248,250,252,0.98))] p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.18em] text-blue-700">Time as safety</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            How each extra month of work shifts your odds of success.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
          {hasData && isStale ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 font-semibold text-amber-800">
              Out of date
            </span>
          ) : null}
          {hasData && !isStale && loadState === 'ready' ? (
            <span className="rounded-full bg-emerald-50 px-3 py-1 font-semibold text-emerald-800">
              Fresh
            </span>
          ) : null}
          <button
            type="button"
            onClick={onCalculate}
            disabled={isLoading || (hasData && !isStale)}
            title={hasData && !isStale ? 'Inputs unchanged — recalculation not needed.' : undefined}
            className="rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-stone-400"
          >
            {isLoading ? 'Calculating…' : hasData ? 'Recalculate' : 'Calculate'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4">
          <div className="h-2.5 overflow-hidden rounded-full bg-stone-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all"
              style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-stone-600">
            Re-running the Monte Carlo engine across a handful of retirement-date shifts.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {hasData && current ? (
        <>
        <TimeAsSafetyDivergingBar points={points} current={current} />
        <div className="mt-4 grid gap-3 md:grid-cols-[1.1fr_0.9fr_1fr]">
          <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-stone-200">
            <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
              Today's retirement date
            </p>
            <p className="mt-2 text-3xl font-semibold text-stone-900">
              {current.successRatePct.toFixed(0)}%
            </p>
            <p className="mt-1 text-xs text-stone-600">
              Success at the current plan.
            </p>
          </div>
          <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-stone-200">
            <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
              Each extra month
            </p>
            <p className="mt-2 text-3xl font-semibold text-blue-700">
              {slope === null
                ? '—'
                : `${slope >= 0 ? '+' : ''}${slope.toFixed(1)} pts`}
            </p>
            <p className="mt-1 text-xs text-stone-600">
              Average across the {points[0].monthsShift} mo to +{points[points.length - 1].monthsShift} mo range.
            </p>
          </div>
          <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-stone-200">
            <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
              Anchor shifts
            </p>
            <ul className="mt-2 space-y-1 text-sm text-stone-700">
              {anchors.map((anchor, idx) =>
                anchor ? (
                  <li key={anchor.monthsShift} className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-stone-500">{formatMonthsLabel(anchor.monthsShift)}</span>
                    <span className="font-semibold text-stone-900">
                      {anchor.successRatePct.toFixed(0)}%
                    </span>
                    <span className="text-xs text-stone-500">
                      {current
                        ? `${anchor.successRate >= current.successRate ? '+' : ''}${(
                            (anchor.successRate - current.successRate) *
                            100
                          ).toFixed(1)} pts`
                        : ''}
                    </span>
                  </li>
                ) : (
                  <li key={`missing-${anchorMonths[idx]}`} className="text-xs text-stone-400">
                    {formatMonthsLabel(anchorMonths[idx])}: —
                  </li>
                ),
              )}
            </ul>
          </div>
        </div>
        </>
      ) : !isLoading ? (
        <div className="mt-4 rounded-2xl border border-dashed border-stone-300 bg-white/50 p-4 text-sm text-stone-600">
          Calculate once to see how many success points each extra month at work is worth for this plan.
        </div>
      ) : null}
    </section>
  );
}

export function TimeAsSafetyPanel(props: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  strategyMode: StrategyMode;
}) {
  const scenarios = useTimeAsSafetyScenarios(props);
  return (
    <TimeAsSafetyStrip
      points={scenarios.points}
      loadState={scenarios.loadState}
      progress={scenarios.progress}
      error={scenarios.error}
      isStale={scenarios.isStale}
      onCalculate={scenarios.calculate}
    />
  );
}
