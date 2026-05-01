import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  computeParetoFront,
  projectEvaluations,
  thinForOverplot,
  type FrontierPoint,
} from './policy-frontier';
import type { Policy, PolicyEvaluation } from './policy-miner-types';

/**
 * E.4 — Frontier scatter.
 *
 * The corpus is large (often thousands of evaluations). The ranked
 * table makes individual policies legible; this chart makes the
 * SHAPE of the decision space legible. The household sees, at a
 * glance:
 *
 *   - Where the kink is (the spend at which extra spend stops costing
 *     much bequest, or vice versa). This is usually the most informative
 *     single number a household gets out of the miner.
 *   - How many candidates cluster around the picked winner. A wide
 *     cluster means the household has flexibility; a tight one means
 *     the choice is brittle.
 *   - Where the current plan sits relative to the frontier. Above-and-
 *     to-the-right of the current plan = strictly better; below-and-to-
 *     the-left = strictly worse; off-axis = a different tradeoff.
 *
 * Why not show ALL points: 8000+ low-alpha dots overplot in a way that
 * hides density. We thin to one representative per (spend bin, feasibility
 * band) when the corpus is dense, and overlay the Pareto front in green
 * with a line connecting points for visual continuity.
 *
 * Why feasibility-filtered: an "infeasible Pareto front" misleads — it
 * shows the best dominated policies. The threshold defaults to the same
 * 0.7 the rest of the mining surface uses, with a slider override below
 * the chart so the household can explore stricter / looser bequest
 * targets without re-mining.
 */

interface Props {
  evaluations: PolicyEvaluation[];
  /** Current plan reference, if any — drawn as a grey ring on the plot. */
  currentPlan?: {
    annualSpendTodayDollars: number | null;
    p50EndingWealthTodayDollars: number | null;
  };
  /** Adopted policy reference, if any — drawn as an emerald star. */
  adoptedPolicy?: Policy | null;
  /** Default feasibility threshold (0..1). Defaults to 0.70. */
  defaultFeasibilityThreshold?: number;
  /** Click handler — called when the household clicks a point on the chart. */
  onAdoptPolicy?: (policy: Policy) => void;
}

// Above this corpus size, we thin the background cloud to keep the SVG
// manageable. The Pareto front is never thinned — those points are the
// whole reason the chart exists.
const THIN_THRESHOLD = 1_000;

function formatSpend(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function formatBequest(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function formatPolicyAxes(p: Policy): string {
  const parts: string[] = [
    `spend ${formatSpend(p.annualSpendTodayDollars)}`,
    `SS ${p.primarySocialSecurityClaimAge}`,
  ];
  if (p.spouseSocialSecurityClaimAge !== null) {
    parts.push(`spouse SS ${p.spouseSocialSecurityClaimAge}`);
  }
  if (p.rothConversionAnnualCeiling > 0) {
    parts.push(`Roth ≤ ${formatSpend(p.rothConversionAnnualCeiling)}`);
  } else {
    parts.push('no Roth');
  }
  return parts.join(' · ');
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: FrontierPoint }>;
}

function FrontierTooltip({ active, payload }: CustomTooltipProps): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  if (!point.evaluation?.policy) return null;
  return (
    <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-[11px] text-stone-700 shadow-md">
      <p className="font-semibold text-stone-900">
        {formatPolicyAxes(point.evaluation.policy)}
      </p>
      <p className="mt-1">
        Bequest P50: <span className="tabular-nums">{formatBequest(point.bequest)}</span>
      </p>
      <p>
        Feasibility:{' '}
        <span className="tabular-nums">{Math.round(point.feasibility * 100)}%</span>
      </p>
      <p className="mt-1 text-stone-500">Click to adopt this policy</p>
    </div>
  );
}

export function PolicyFrontierChart({
  evaluations,
  currentPlan,
  adoptedPolicy,
  defaultFeasibilityThreshold = 0.7,
  onAdoptPolicy,
}: Props): JSX.Element {
  const [feasibilityFloor, setFeasibilityFloor] = useState(defaultFeasibilityThreshold);
  const [showDominated, setShowDominated] = useState(true);

  const projected = useMemo(
    () => projectEvaluations(evaluations, feasibilityFloor),
    [evaluations, feasibilityFloor],
  );
  const front = useMemo(() => computeParetoFront(projected), [projected]);
  const frontIds = useMemo(() => {
    const set = new Set<PolicyEvaluation>();
    for (const p of front) set.add(p.evaluation);
    return set;
  }, [front]);

  // Background cloud: everything not on the front, thinned if dense.
  const cloud = useMemo(() => {
    const offFront = projected.filter((p) => !frontIds.has(p.evaluation));
    if (offFront.length > THIN_THRESHOLD) {
      return thinForOverplot(offFront);
    }
    return offFront;
  }, [projected, frontIds]);

  // Explicit x-axis ticks at every distinct spend value present in the
  // corpus. Without this Recharts auto-picks "round" ticks (every $5k or
  // $10k) and hides the cliff-refinement $1k inserts visually — the
  // household reads the axis labels as the data resolution. We cap the
  // tick density so wide ranges with many fine inserts don't render an
  // unreadable axis.
  const spendTicks = useMemo<number[]>(() => {
    const distinct = new Set<number>();
    for (const p of projected) {
      distinct.add(p.evaluation.policy.annualSpendTodayDollars);
    }
    const sorted = Array.from(distinct).sort((a, b) => a - b);
    if (sorted.length <= 25) return sorted;
    // Density fallback: keep $5k grid + the $1k inserts, drop denser
    // accidental duplicates. Should rarely fire on the V2 hybrid axes
    // (~21 values), but defensively prevents a dense $1k full-range
    // axis from rendering 80+ ticks.
    return sorted.filter(
      (v, i) =>
        v % 5_000 === 0 ||
        i === 0 ||
        i === sorted.length - 1 ||
        Math.abs(v - sorted[i - 1]) >= 1_000,
    );
  }, [projected]);

  // Adopted point — synthesize a FrontierPoint for chart highlighting.
  const adoptedPoint = useMemo<FrontierPoint | null>(() => {
    if (!adoptedPolicy) return null;
    const match = projected.find(
      (p) =>
        p.evaluation.policy.annualSpendTodayDollars ===
          adoptedPolicy.annualSpendTodayDollars &&
        p.evaluation.policy.primarySocialSecurityClaimAge ===
          adoptedPolicy.primarySocialSecurityClaimAge &&
        p.evaluation.policy.spouseSocialSecurityClaimAge ===
          adoptedPolicy.spouseSocialSecurityClaimAge &&
        p.evaluation.policy.rothConversionAnnualCeiling ===
          adoptedPolicy.rothConversionAnnualCeiling,
    );
    return match ?? null;
  }, [adoptedPolicy, projected]);

  const handleScatterClick = (data: { payload?: FrontierPoint }) => {
    if (!onAdoptPolicy) return;
    const point = data.payload;
    if (!point?.evaluation?.policy) return;
    onAdoptPolicy(point.evaluation.policy);
  };

  if (projected.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center text-[13px] text-stone-500">
        No feasible policies at the current threshold. Lower the
        feasibility floor or run a wider mine.
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-stone-200 bg-white/80 p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
            Frontier · spend vs bequest
          </p>
          <p className="mt-0.5 text-[12px] text-stone-500">
            {projected.length.toLocaleString()} feasible candidates ·{' '}
            {front.length} on the Pareto front
            {cloud.length < projected.length - front.length &&
              ` · cloud thinned to ${cloud.length.toLocaleString()} for legibility`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-stone-600">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showDominated}
              onChange={(e) => setShowDominated(e.target.checked)}
              className="h-3 w-3"
            />
            show dominated cloud
          </label>
          <label className="flex items-center gap-1">
            feasibility ≥{' '}
            <span className="tabular-nums font-semibold text-stone-700">
              {Math.round(feasibilityFloor * 100)}%
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(feasibilityFloor * 100)}
              onChange={(e) => setFeasibilityFloor(Number(e.target.value) / 100)}
              className="ml-1 h-1 w-24"
            />
          </label>
        </div>
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 8, right: 16, bottom: 28, left: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
            <XAxis
              type="number"
              dataKey="spend"
              name="Annual spend"
              tickFormatter={formatSpend}
              tick={{ fill: '#78716c', fontSize: 11 }}
              label={{
                value: 'Annual spend',
                position: 'insideBottom',
                offset: -10,
                style: { fill: '#78716c', fontSize: 11 },
              }}
              domain={['dataMin - 1000', 'dataMax + 1000']}
              ticks={spendTicks}
            />
            <YAxis
              type="number"
              dataKey="bequest"
              name="Bequest P50"
              tickFormatter={formatBequest}
              tick={{ fill: '#78716c', fontSize: 11 }}
              label={{
                value: 'Bequest P50',
                angle: -90,
                position: 'insideLeft',
                style: { fill: '#78716c', fontSize: 11 },
              }}
              domain={['dataMin', 'dataMax']}
            />
            <Tooltip
              content={<FrontierTooltip />}
              cursor={{ stroke: '#a8a29e', strokeDasharray: '3 3' }}
            />
            {showDominated && (
              <Scatter
                name="Dominated cloud"
                data={cloud}
                fill="#a8a29e"
                fillOpacity={0.35}
                shape="circle"
                isAnimationActive={false}
                onClick={onAdoptPolicy ? handleScatterClick : undefined}
              />
            )}
            <Line
              data={front}
              dataKey="bequest"
              stroke="#059669"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              type="monotone"
              legendType="none"
            />
            <Scatter
              name="Pareto front"
              data={front}
              fill="#059669"
              shape="circle"
              isAnimationActive={false}
              onClick={onAdoptPolicy ? handleScatterClick : undefined}
            />
            {currentPlan?.annualSpendTodayDollars != null &&
              currentPlan?.p50EndingWealthTodayDollars != null && (
                <ReferenceDot
                  x={currentPlan.annualSpendTodayDollars}
                  y={currentPlan.p50EndingWealthTodayDollars}
                  r={6}
                  fill="white"
                  stroke="#1c1917"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                  label={{
                    value: 'current',
                    position: 'top',
                    style: { fill: '#1c1917', fontSize: 10, fontWeight: 600 },
                  }}
                />
              )}
            {adoptedPoint && (
              <ReferenceDot
                x={adoptedPoint.spend}
                y={adoptedPoint.bequest}
                r={8}
                fill="#fbbf24"
                stroke="#92400e"
                strokeWidth={2}
                ifOverflow="extendDomain"
                label={{
                  value: 'adopted',
                  position: 'top',
                  style: { fill: '#92400e', fontSize: 10, fontWeight: 700 },
                }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-stone-500">
        Each dot is one mined policy. Green dots are Pareto-optimal —
        no other policy gives you both more spend AND more bequest.
        {currentPlan?.annualSpendTodayDollars != null && (
          <>
            {' '}
            The black ring marks where your current plan sits; anything
            up-and-to-the-right of it is a strict improvement.
          </>
        )}
        {onAdoptPolicy && ' Click any green dot to adopt that policy.'}
      </p>
    </div>
  );
}
