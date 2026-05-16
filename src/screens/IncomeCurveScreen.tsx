import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MonthlyReviewValidationPacket } from '../monthly-review';
import type { Policy } from '../policy-miner-types';
import { evaluatePolicyFullTrace } from '../policy-miner-eval';
import { useAppStore } from '../store';
import type { PathResult, SeedData, WithdrawalRule } from '../types';
import { Panel } from '../ui-primitives';
import { useClusterSession } from '../useClusterSession';
import { useRecommendedPolicy } from '../use-recommended-policy';
import { calculateCurrentAges, formatCurrency } from '../utils';
import {
  buildNorthStarBudgetSeriesFromPath,
  deflateNominalYearValue,
  type NorthStarBudget,
} from '../north-star-budget';

type SelectedSpendingPath = NonNullable<
  MonthlyReviewValidationPacket['rawExportEvidence']['selectedPolicy']
>['spendingPath'];

interface SpendingCurvePoint extends NorthStarBudget {
  year: number | null;
  age: number;
  medianAssetsAnnual: number;
}

type ProjectionState =
  | { status: 'idle'; path: null; error: null }
  | { status: 'computing'; path: null; error: null }
  | { status: 'ready'; path: PathResult; error: null }
  | { status: 'error'; path: null; error: string };

const LAST_MONTHLY_REVIEW_PACKET_KEY =
  'monthly-review:v2:last-ai-validation-packet';

function readLastMonthlyReviewPacket(): MonthlyReviewValidationPacket | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(LAST_MONTHLY_REVIEW_PACKET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MonthlyReviewValidationPacket;
    return parsed?.version === 'monthly_review_validation_packet_v1' ? parsed : null;
  } catch {
    return null;
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function policyFromMonthlyReviewPick(
  pick: MonthlyReviewValidationPacket['rawExportEvidence']['selectedPolicy'] | null,
): Policy | null {
  if (!pick) return null;
  return {
    annualSpendTodayDollars: pick.annualSpendTodayDollars,
    primarySocialSecurityClaimAge: pick.primarySocialSecurityClaimAge,
    spouseSocialSecurityClaimAge: pick.spouseSocialSecurityClaimAge,
    rothConversionAnnualCeiling: pick.rothConversionAnnualCeiling,
    withdrawalRule: (pick.withdrawalRule ?? undefined) as WithdrawalRule | undefined,
  };
}

function policyKey(policy: Policy | null): string {
  if (!policy) return 'none';
  return JSON.stringify({
    spend: policy.annualSpendTodayDollars,
    primarySs: policy.primarySocialSecurityClaimAge,
    spouseSs: policy.spouseSocialSecurityClaimAge,
    roth: policy.rothConversionAnnualCeiling,
    withdrawalRule: policy.withdrawalRule ?? null,
  });
}

function buildSpendingCurve(input: {
  data: SeedData;
  path: PathResult;
  selectedSpendingPath: SelectedSpendingPath | null;
  inflation: number;
  legacyTarget: number;
  medianEndingWealth: number | null;
}): SpendingCurvePoint[] {
  const currentYear = new Date().getFullYear();
  const ages = calculateCurrentAges(input.data);
  const averageAgeNow = Math.round((ages.rob + ages.debbie) / 2);
  const baseYear = input.path.yearlySeries[0]?.year ?? currentYear;
  const rowsByYear = new Map(input.path.yearlySeries.map((row) => [row.year, row]));
  return buildNorthStarBudgetSeriesFromPath({
    path: input.path,
    spendingPath: input.selectedSpendingPath,
    inflation: input.inflation,
    legacyTarget: input.legacyTarget,
    medianEndingWealth: input.medianEndingWealth,
  }).map((budget) => {
    const row = budget.year === null ? null : rowsByYear.get(budget.year) ?? null;
    const medianAssetsAnnual = deflateNominalYearValue(
      row?.medianAssets ?? 0,
      budget.year ?? baseYear,
      baseYear,
      input.inflation,
    );
    return {
      ...budget,
      year: budget.year,
      age: averageAgeNow + ((budget.year ?? currentYear) - currentYear),
      medianAssetsAnnual,
    };
  });
}

function kFormatter(value: number) {
  return `$${Math.round(value / 1000)}k`;
}

function formatMonthly(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '-';
  return `$${Math.round(amount / 12).toLocaleString()}/mo`;
}

function formatMaybeCurrency(amount: number | null): string {
  return amount === null || !Number.isFinite(amount) ? '-' : formatCurrency(amount);
}

function rowForYear(rows: SpendingCurvePoint[], year: number): SpendingCurvePoint | null {
  return rows.find((row) => row.year === year) ?? null;
}

export function IncomeCurveScreen() {
  const data = useAppStore((state) => state.appliedData);
  const assumptions = useAppStore((state) => state.appliedAssumptions);
  const selectedStressors = useAppStore((state) => state.appliedSelectedStressors);
  const selectedResponses = useAppStore((state) => state.appliedSelectedResponses);
  const lastPolicyAdoption = useAppStore((state) => state.lastPolicyAdoption);
  const setCurrentScreen = useAppStore((state) => state.setCurrentScreen);
  const cluster = useClusterSession();
  const recommendation = useRecommendedPolicy(
    data,
    assumptions,
    selectedStressors,
    selectedResponses,
    cluster.snapshot.dispatcherUrl ?? null,
    lastPolicyAdoption,
  );
  const lastMonthlyReviewPacket = useMemo(readLastMonthlyReviewPacket, []);
  const selectedMonthlyReviewPolicy =
    lastMonthlyReviewPacket?.rawExportEvidence.selectedPolicy ?? null;
  const monthlyReviewPolicy = useMemo(
    () => policyFromMonthlyReviewPick(selectedMonthlyReviewPolicy),
    [selectedMonthlyReviewPolicy],
  );
  const selectedPolicy =
    monthlyReviewPolicy ??
    lastPolicyAdoption?.policy ??
    recommendation.policy?.policy ??
    null;
  const selectedSpendingPath =
    selectedMonthlyReviewPolicy?.spendingPath ?? null;
  const sourceLabel = monthlyReviewPolicy
    ? 'Monthly Review pick'
    : lastPolicyAdoption
      ? 'Adopted mine'
      : recommendation.policy
        ? 'Current best mine'
        : 'No mine selected';
  const projectionKey = useMemo(
    () =>
      JSON.stringify({
        policy: policyKey(selectedPolicy),
        selectedStressors,
        selectedResponses,
        assumptionsVersion: assumptions.assumptionsVersion,
        simulationSeed: assumptions.simulationSeed,
      }),
    [
      assumptions.assumptionsVersion,
      assumptions.simulationSeed,
      selectedPolicy,
      selectedResponses,
      selectedStressors,
    ],
  );
  const [projection, setProjection] = useState<ProjectionState>({
    status: 'idle',
    path: null,
    error: null,
  });

  useEffect(() => {
    if (!selectedPolicy) {
      setProjection({ status: 'idle', path: null, error: null });
      return undefined;
    }
    let cancelled = false;
    setProjection({ status: 'computing', path: null, error: null });
    const handle = window.setTimeout(() => {
      try {
        const path = evaluatePolicyFullTrace(
          selectedPolicy,
          data,
          assumptions,
          structuredCloneSafe,
          {
            selectedStressors,
            selectedResponses,
            useHistoricalBootstrap: false,
          },
        );
        if (!cancelled) {
          setProjection({ status: 'ready', path, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setProjection({
            status: 'error',
            path: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [assumptions, data, projectionKey, selectedPolicy, selectedResponses, selectedStressors]);

  if (!selectedPolicy) {
    return (
      <Panel
        title="Spending Curve"
        subtitle="Selected yearly spending target and engine cashflow."
      >
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
          <p className="font-semibold">
            {recommendation.state === 'loading'
              ? 'Looking for the selected mine.'
              : 'No selected mine is available yet.'}
          </p>
          <button
            type="button"
            onClick={() => setCurrentScreen('mining')}
            className="mt-4 rounded-xl bg-amber-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-800"
          >
            Open Re-run Model
          </button>
        </div>
      </Panel>
    );
  }

  if (projection.status === 'computing' || projection.status === 'idle') {
    return (
      <Panel
        title="Spending Curve"
        subtitle="Selected yearly spending target and engine cashflow."
      >
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5 text-sm leading-6 text-blue-950">
          <p className="font-semibold">Building the selected-policy spending projection...</p>
        </div>
      </Panel>
    );
  }

  if (projection.status === 'error') {
    return (
      <Panel
        title="Spending Curve"
        subtitle="Selected yearly spending target and engine cashflow."
      >
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm leading-6 text-rose-950">
          <p className="font-semibold">Spending projection failed.</p>
          <p className="mt-1">{projection.error}</p>
        </div>
      </Panel>
    );
  }

  const curve = buildSpendingCurve({
    data,
    path: projection.path,
    selectedSpendingPath,
    inflation:
      lastMonthlyReviewPacket?.rawExportEvidence.assumptions.inflation ??
      assumptions.inflation,
    legacyTarget:
      lastMonthlyReviewPacket?.northStar.legacyTargetTodayDollars ??
      data.goals?.legacyTargetTodayDollars ??
      1_000_000,
    medianEndingWealth:
      selectedMonthlyReviewPolicy?.outcome.p50EndingWealthTodayDollars ?? null,
  });
  const currentYear = new Date().getFullYear();
  const nextYear = rowForYear(curve, currentYear + 1) ?? curve[0] ?? null;
  const firstTarget = curve.find((row) => row.lifestyleAnnual !== null) ?? null;
  const legacyTarget =
    lastMonthlyReviewPacket?.northStar.legacyTargetTodayDollars ??
    data.goals?.legacyTargetTodayDollars ??
    1_000_000;
  const selectedOutcome = selectedMonthlyReviewPolicy?.outcome ?? null;
  const values = curve.flatMap((row) =>
    [row.totalAnnualBudget, row.spendAndHealthAnnual, row.lifestyleAnnual].filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value > 0,
    ),
  );
  const maxValue = Math.max(...values, 1);
  const yCeiling = Math.ceil(maxValue / 25_000) * 25_000 + 25_000;
  const visibleRows = curve.filter((_, index) => index < 8 || index % 5 === 0);

  return (
    <Panel
      title="Spending Curve"
      subtitle="How much the selected plan supports spending through time."
    >
      <div className="mb-4 flex flex-wrap gap-2 text-xs font-semibold text-stone-600">
        <span className="rounded-full bg-blue-50 px-3 py-1 text-blue-700">
          {sourceLabel}
        </span>
        <span className="rounded-full bg-stone-100 px-3 py-1">
          care/legacy reserve {formatCurrency(legacyTarget)}
        </span>
        <span className="rounded-full bg-stone-100 px-3 py-1">
          core target {formatCurrency(selectedPolicy.annualSpendTodayDollars)}/yr
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Metric
          label="Next-year total budget"
          value={nextYear ? formatMonthly(nextYear.totalAnnualBudget) : '-'}
          detail={nextYear ? `${formatMaybeCurrency(nextYear.totalAnnualBudget)}/yr` : ''}
        />
        <Metric
          label="Next-year lifestyle target"
          value={
            nextYear?.lifestyleAnnual
              ? formatMonthly(nextYear.lifestyleAnnual)
              : firstTarget?.lifestyleAnnual
                ? formatMonthly(firstTarget.lifestyleAnnual)
                : '-'
          }
          detail={
            nextYear?.lifestyleAnnual
              ? `${formatCurrency(nextYear.lifestyleAnnual)}/yr`
              : firstTarget?.lifestyleAnnual
                ? `${firstTarget.year}: ${formatCurrency(firstTarget.lifestyleAnnual)}/yr`
                : ''
          }
        />
        <Metric
          label="Health/tax pressure"
          value={
            nextYear
              ? formatMonthly(
                  (nextYear.totalAnnualBudget ?? 0) -
                    (nextYear.lifestyleAnnual ?? nextYear.spendAndHealthAnnual ?? 0),
                )
              : '-'
          }
          detail={nextYear ? `${nextYear.year}` : ''}
        />
        <Metric
          label="Median reserve"
          value={
            selectedOutcome
              ? formatCurrency(selectedOutcome.p50EndingWealthTodayDollars)
              : '-'
          }
          detail={`care/legacy reserve ${formatCurrency(legacyTarget)}`}
        />
      </div>

      <div className="mt-5 h-[420px] rounded-2xl border border-stone-200 bg-white p-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={curve}
            margin={{ left: 12, right: 24, top: 16, bottom: 12 }}
          >
            <CartesianGrid stroke="#e7e5e4" strokeDasharray="3 3" />
            <XAxis
              dataKey="year"
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#78716c', fontSize: 12 }}
            />
            <YAxis
              domain={[0, yCeiling]}
              tickFormatter={kFormatter}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#78716c', fontSize: 12 }}
              width={64}
            />
            <Tooltip
              formatter={(value: number, name: string) => [
                formatCurrency(value),
                name,
              ]}
              labelFormatter={(year) => `Year ${year}`}
              contentStyle={{
                borderRadius: 12,
                border: '1px solid #e7e5e4',
                boxShadow: '0 12px 30px rgba(41, 37, 36, 0.12)',
              }}
            />
            <Line
              type="monotone"
              dataKey="totalAnnualBudget"
              name="Total budget"
              stroke="#0f766e"
              strokeWidth={4}
              dot={false}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="spendAndHealthAnnual"
              name="Spend plus healthcare"
              stroke="#2563eb"
              strokeWidth={2.5}
              dot={false}
            />
            <Line
              type="stepAfter"
              dataKey="lifestyleAnnual"
              name="Lifestyle target"
              stroke="#a16207"
              strokeWidth={2}
              strokeDasharray="6 6"
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <details className="mt-5 rounded-2xl border border-stone-200 bg-stone-50 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-stone-700">
          Year values
        </summary>
        <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full min-w-[760px] text-left text-xs tabular-nums">
            <thead className="sticky top-0 bg-stone-100 text-stone-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Year</th>
                <th className="px-3 py-2 font-semibold">Age</th>
                <th className="px-3 py-2 text-right font-semibold">Lifestyle target</th>
                <th className="px-3 py-2 text-right font-semibold">Spend + health</th>
                <th className="px-3 py-2 text-right font-semibold">Federal tax</th>
                <th className="px-3 py-2 text-right font-semibold">Total budget</th>
                <th className="px-3 py-2 text-right font-semibold">Median assets</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.year} className="border-t border-stone-100">
                  <td className="px-3 py-2 text-stone-700">{row.year}</td>
                  <td className="px-3 py-2 text-stone-500">{row.age}</td>
                  <td className="px-3 py-2 text-right text-stone-600">
                    {formatMaybeCurrency(row.lifestyleAnnual)}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-600">
                    {formatMaybeCurrency(row.spendAndHealthAnnual)}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-600">
                    {formatMaybeCurrency(row.federalTaxAnnual)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-stone-900">
                    {formatMaybeCurrency(row.totalAnnualBudget)}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-600">
                    {formatCurrency(row.medianAssetsAnnual)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl bg-stone-100/85 p-4">
      <p className="text-xs font-semibold uppercase text-stone-400">{label}</p>
      <p className="mt-2 text-xl font-semibold text-stone-900">{value}</p>
      {detail ? <p className="mt-1 text-xs text-stone-500">{detail}</p> : null}
    </div>
  );
}
