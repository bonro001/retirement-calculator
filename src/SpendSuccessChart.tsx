import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MarketAssumptions, SeedData } from './types';
import { formatCurrency, getAnnualStretchSpend } from './utils';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { loadSpendSafetyFromCache, saveSpendSafetyToCache } from './spend-safety-cache';
import type {
  SweepPointInput,
  SweepWorkerRequest,
  SweepWorkerResponse,
} from './sweep-worker-types';

export interface SpendScenarioPoint {
  id: string;
  spendDeltaPercent: number;
  monthlySpend: number;
  successRate: number;
  successRatePct: number;
  medianEndingWealth: number;
  irmaaExposureRate: number;
  spendingCutRate: number;
  irmaaTone: 'low' | 'medium' | 'high';
  guardrailDependent: boolean;
  isCurrent: boolean;
}

type StrategyMode = 'raw_simulation' | 'planner_enhanced';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function cloneSeedData<T>(value: T): T {
  return structuredClone(value);
}

function roundMoney(value: number) {
  return Math.round(value);
}

export function getIrmaaTone(rate: number): SpendScenarioPoint['irmaaTone'] {
  if (rate >= 0.4) return 'high';
  if (rate >= 0.18) return 'medium';
  return 'low';
}

function getIrmaaColor(tone: SpendScenarioPoint['irmaaTone']) {
  if (tone === 'high') return '#dc2626';
  if (tone === 'medium') return '#d97706';
  return '#0f766e';
}

function buildSpendScenarioData(data: SeedData, spendDeltaPercent: number) {
  const next = cloneSeedData(data);
  const currentAnnualSpend = getAnnualStretchSpend(data);
  const targetAnnualSpend = currentAnnualSpend * (1 + spendDeltaPercent);
  const fixedAnnual = data.spending.essentialMonthly * 12 + data.spending.annualTaxesInsurance;
  const flexibleAnnual = data.spending.optionalMonthly * 12 + data.spending.travelEarlyRetirementAnnual;
  const targetFlexibleAnnual = Math.max(0, targetAnnualSpend - fixedAnnual);
  const flexibleScale = flexibleAnnual > 0 ? targetFlexibleAnnual / flexibleAnnual : 0;

  next.spending.optionalMonthly = roundMoney(data.spending.optionalMonthly * flexibleScale * 100) / 100;
  next.spending.travelEarlyRetirementAnnual = roundMoney(
    data.spending.travelEarlyRetirementAnnual * flexibleScale,
  );

  return {
    data: next,
    monthlySpend: (fixedAnnual + targetFlexibleAnnual) / 12,
  };
}

function buildSpendGrid() {
  return [-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1];
}

export function SpendSuccessPointShape(props: {
  cx?: number;
  cy?: number;
  payload?: SpendScenarioPoint;
}) {
  const { cx = 0, cy = 0, payload } = props;
  if (!payload) return null;
  const fill = getIrmaaColor(payload.irmaaTone);
  const radius = payload.isCurrent ? 8 : 6;
  const stroke = payload.guardrailDependent ? '#111827' : '#ffffff';
  const strokeWidth = payload.guardrailDependent ? 2.5 : 1.5;
  return (
    <g>
      <circle cx={cx} cy={cy} r={radius} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
      {payload.isCurrent ? (
        <circle cx={cx} cy={cy} r={radius + 4} fill="none" stroke="#2563eb" strokeWidth={2} />
      ) : null}
    </g>
  );
}

interface HookArgs {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  strategyMode: StrategyMode;
}

interface HookResult {
  points: SpendScenarioPoint[];
  loadState: LoadState;
  progress: number;
  error: string | null;
  isStale: boolean;
  calculate: () => void;
}

export function useSpendSuccessScenarios(args: HookArgs): HookResult {
  const { data, assumptions, selectedStressors, selectedResponses, strategyMode } = args;
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [points, setPoints] = useState<SpendScenarioPoint[]>([]);
  const [cachedFingerprint, setCachedFingerprint] = useState<string | null>(null);

  const fingerprint = useMemo(
    () =>
      `${strategyMode}|${buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
      })}`,
    [assumptions, data, selectedResponses, selectedStressors, strategyMode],
  );

  const runTokenRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const currentBatchIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        if (currentBatchIdRef.current) {
          const cancelMsg: SweepWorkerRequest = {
            type: 'cancel',
            batchId: currentBatchIdRef.current,
          };
          workerRef.current.postMessage(cancelMsg);
        }
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  // Try cache on mount and whenever fingerprint changes
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await loadSpendSafetyFromCache<SpendScenarioPoint>(fingerprint);
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
    if (workerRef.current && currentBatchIdRef.current) {
      const cancelMsg: SweepWorkerRequest = {
        type: 'cancel',
        batchId: currentBatchIdRef.current,
      };
      workerRef.current.postMessage(cancelMsg);
    }

    // Lazily create a worker on first calculate.
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('./sweep.worker.ts', import.meta.url), {
        type: 'module',
      });
    }
    const worker = workerRef.current;

    const deltas = buildSpendGrid();
    const batchId = `spend-${token}-${Date.now()}`;
    currentBatchIdRef.current = batchId;

    // Precompute per-point scenario inputs so the main thread keeps the
    // monthly-spend metadata we need to annotate each PathResult later.
    const scenarios = deltas.map((spendDeltaPercent) => {
      const built = buildSpendScenarioData(data, spendDeltaPercent);
      return { spendDeltaPercent, monthlySpend: built.monthlySpend, data: built.data };
    });

    const sweepPoints: SweepPointInput[] = scenarios.map((s) => ({
      pointId: `${s.spendDeltaPercent}`,
      data: s.data,
      assumptions,
      selectedStressors,
      selectedResponses,
      strategyMode,
    }));

    const collected: SpendScenarioPoint[] = [];

    const onMessage = (event: MessageEvent<SweepWorkerResponse>) => {
      const msg = event.data;
      if (msg.batchId !== batchId) return;
      if (runTokenRef.current !== token) return;

      if (msg.type === 'progress') {
        const perPoint = 1 / msg.total;
        const completedFraction = msg.index * perPoint;
        setProgress(Math.min(0.99, completedFraction + msg.pointProgress * perPoint));
      } else if (msg.type === 'point') {
        const scenario = scenarios[msg.index];
        const path = msg.path;
        collected.push({
          id: msg.pointId,
          spendDeltaPercent: scenario.spendDeltaPercent,
          monthlySpend: scenario.monthlySpend,
          successRate: path.successRate,
          successRatePct: path.successRate * 100,
          medianEndingWealth: path.medianEndingWealth,
          irmaaExposureRate: path.irmaaExposureRate,
          spendingCutRate: path.spendingCutRate,
          irmaaTone: getIrmaaTone(path.irmaaExposureRate),
          guardrailDependent: path.spendingCutRate > 0.4,
          isCurrent: scenario.spendDeltaPercent === 0,
        });
        setProgress((msg.index + 1) / msg.total);
      } else if (msg.type === 'done') {
        collected.sort((a, b) => a.monthlySpend - b.monthlySpend);
        setPoints(collected);
        setCachedFingerprint(fingerprint);
        setLoadState('ready');
        setProgress(1);
        void saveSpendSafetyToCache(fingerprint, collected);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (currentBatchIdRef.current === batchId) currentBatchIdRef.current = null;
      } else if (msg.type === 'cancelled') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (currentBatchIdRef.current === batchId) currentBatchIdRef.current = null;
      } else if (msg.type === 'error') {
        setError(msg.error || 'Spend scenarios failed to run.');
        setLoadState('error');
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (currentBatchIdRef.current === batchId) currentBatchIdRef.current = null;
      }
    };

    const onError = (event: ErrorEvent) => {
      if (runTokenRef.current !== token) return;
      setError(event.message || 'Spend scenarios worker crashed.');
      setLoadState('error');
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (currentBatchIdRef.current === batchId) currentBatchIdRef.current = null;
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    const runMsg: SweepWorkerRequest = {
      type: 'run',
      payload: { batchId, points: sweepPoints },
    };
    worker.postMessage(runMsg);
  }, [assumptions, data, fingerprint, selectedResponses, selectedStressors, strategyMode]);

  const isStale = points.length > 0 && cachedFingerprint !== null && cachedFingerprint !== fingerprint;

  return { points, loadState, progress, error, isStale, calculate };
}

export function SpendSuccessChartCard(props: {
  points: SpendScenarioPoint[];
  loadState: LoadState;
  progress: number;
  error: string | null;
  isStale: boolean;
  onCalculate: () => void;
  title?: string;
  subtitle?: string;
  comparePoints?: SpendScenarioPoint[];
  primaryLabel?: string;
  compareLabel?: string;
}) {
  const {
    points,
    loadState,
    progress,
    error,
    isStale,
    onCalculate,
    title,
    subtitle,
    comparePoints,
    primaryLabel = 'Success rate',
    compareLabel = 'Hands off',
  } = props;
  const hasCompare = !!comparePoints && comparePoints.length > 0;
  const mergedPoints = useMemo(() => {
    if (!hasCompare) return points;
    const byDelta = new Map<number, SpendScenarioPoint & { compareSuccessRatePct?: number }>();
    for (const p of points) byDelta.set(p.spendDeltaPercent, { ...p });
    for (const c of comparePoints!) {
      const existing = byDelta.get(c.spendDeltaPercent);
      if (existing) existing.compareSuccessRatePct = c.successRatePct;
      else byDelta.set(c.spendDeltaPercent, { ...c, compareSuccessRatePct: c.successRatePct });
    }
    return Array.from(byDelta.values()).sort((a, b) => a.monthlySpend - b.monthlySpend);
  }, [points, comparePoints, hasCompare]);

  const optimalRange = useMemo(() => {
    const zone = points.filter(
      (p) => p.successRate >= 0.85 && p.spendingCutRate <= 0.25 && p.irmaaExposureRate <= 0.2,
    );
    if (!zone.length) return null;
    return {
      min: Math.min(...zone.map((p) => p.monthlySpend)),
      max: Math.max(...zone.map((p) => p.monthlySpend)),
    };
  }, [points]);

  const hasData = points.length > 0;
  const isLoading = loadState === 'loading';

  return (
    <article className="rounded-[30px] border border-stone-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(248,250,252,0.98))] p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-stone-900">
            {title ?? 'Monthly spending versus success'}
          </p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            {subtitle ??
              'Dots are colored by IRMAA pressure. Dark outlines mean the plan leans heavily on guardrail cuts.'}
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
            className="rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-stone-400"
            title={hasData && !isStale ? 'Inputs unchanged — recalculation not needed.' : undefined}
          >
            {isLoading ? 'Calculating…' : hasData ? 'Recalculate' : 'Calculate'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="mb-4">
          <div className="h-3 overflow-hidden rounded-full bg-stone-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all"
              style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-stone-600">
            Running the current Monte Carlo engine across a small spending range.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {hasData ? (
        <>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={mergedPoints}>
              <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
              {optimalRange ? (
                <ReferenceArea
                  x1={optimalRange.min}
                  x2={optimalRange.max}
                  fill="#dcfce7"
                  fillOpacity={0.7}
                />
              ) : null}
              <XAxis
                type="number"
                dataKey="monthlySpend"
                domain={['dataMin - 250', 'dataMax + 250']}
                tickFormatter={(value) => `${Math.round(value / 1000)}k`}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="number"
                dataKey="successRatePct"
                domain={[0, 100]}
                tickFormatter={(value) => `${Math.round(value)}%`}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                formatter={(value: number, name: string) =>
                  name === 'Success rate' || name === 'Flex' || name === 'Hands off'
                    ? `${value.toFixed(1)}%`
                    : formatCurrency(value)
                }
                labelFormatter={(value) => `Spend ${formatCurrency(Number(value))}/mo`}
              />
              <Line
                type="monotone"
                dataKey="successRatePct"
                name={primaryLabel}
                stroke="#1d4ed8"
                strokeWidth={3}
                dot={false}
                isAnimationActive={false}
              />
              {hasCompare ? (
                <Line
                  type="monotone"
                  dataKey="compareSuccessRatePct"
                  name={compareLabel}
                  stroke="#94a3b8"
                  strokeDasharray="6 4"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ) : null}
              <Scatter data={points} shape={<SpendSuccessPointShape />} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
          <span className="font-semibold uppercase tracking-[0.12em] text-stone-500">IRMAA pressure</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#0f766e' }} />
            Low (&lt;18%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#d97706' }} />
            Medium (18–40%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#dc2626' }} />
            High (≥40%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-stone-900 bg-white" />
            Dark outline = leans on guardrail cuts
          </span>
        </div>
        </>
      ) : !isLoading ? (
        <div className="flex min-h-[12rem] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-stone-300 bg-white/50 p-6 text-center">
          <p className="text-sm text-stone-600">
            No cached spending-vs-success data yet. Calculating takes a few seconds and stays saved for next time.
          </p>
        </div>
      ) : null}
    </article>
  );
}

export function SpendSuccessChartPanel(props: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  strategyMode: StrategyMode;
  title?: string;
  subtitle?: string;
}) {
  const scenarios = useSpendSuccessScenarios({
    data: props.data,
    assumptions: props.assumptions,
    selectedStressors: props.selectedStressors,
    selectedResponses: props.selectedResponses,
    strategyMode: props.strategyMode,
  });
  return (
    <SpendSuccessChartCard
      points={scenarios.points}
      loadState={scenarios.loadState}
      progress={scenarios.progress}
      error={scenarios.error}
      isStale={scenarios.isStale}
      onCalculate={scenarios.calculate}
      title={props.title}
      subtitle={props.subtitle}
    />
  );
}
