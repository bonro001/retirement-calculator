import { useCallback, useMemo } from 'react';
import { useAppStore } from './store';
import type { SeedData } from './types';
import { formatCurrency, formatPercent } from './utils';
import {
  SpendSuccessChartCard,
  useSpendSuccessScenarios,
  type SpendScenarioPoint,
} from './SpendSuccessChart';

function formatMonthlyRange(points: SpendScenarioPoint[]) {
  if (!points.length) {
    return 'No clear range';
  }
  const values = points.map((point) => point.monthlySpend);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (Math.abs(max - min) < 50) {
    return `${formatCurrency(min)}/mo`;
  }
  return `${formatCurrency(min)}-${formatCurrency(max)}/mo`;
}

function getCurrentScenario(points: SpendScenarioPoint[]) {
  return points.find((point) => point.isCurrent) ?? points[Math.floor(points.length / 2)] ?? null;
}

function getBalancedZone(points: SpendScenarioPoint[]) {
  return points.filter(
    (point) =>
      point.successRate >= 0.85 &&
      point.spendingCutRate <= 0.25 &&
      point.irmaaExposureRate <= 0.2,
  );
}

function getStretchZone(points: SpendScenarioPoint[]) {
  return points.filter(
    (point) =>
      point.successRate >= 0.75 &&
      point.spendingCutRate <= 0.4 &&
      point.monthlySpend >= (getBalancedZone(points).slice(-1)[0]?.monthlySpend ?? 0),
  );
}

function getFivePointGainMessage(points: SpendScenarioPoint[]) {
  const current = getCurrentScenario(points);
  if (!current) {
    return 'Current spend point is not available yet.';
  }
  const targetSuccess = Math.min(1, current.successRate + 0.05);
  const candidate = points
    .filter((point) => point.monthlySpend < current.monthlySpend && point.successRate >= targetSuccess)
    .sort((left, right) => right.monthlySpend - left.monthlySpend)[0];

  if (!candidate) {
    return 'A +5% success bump does not appear inside the tested spend range.';
  }

  return `If you want about +5% success, reduce spending by ${formatCurrency(current.monthlySpend - candidate.monthlySpend)}/mo.`;
}

function buildEconomizeSuggestions(input: { data: SeedData; points: SpendScenarioPoint[] }) {
  const current = getCurrentScenario(input.points);
  const balancedZone = getBalancedZone(input.points);
  const targetSpend = balancedZone.length
    ? Math.min(...balancedZone.map((point) => point.monthlySpend))
    : current?.monthlySpend ?? 0;
  const reductionNeeded = Math.max(0, (current?.monthlySpend ?? 0) - targetSpend);
  const travelMonthly = input.data.spending.travelEarlyRetirementAnnual / 12;
  const optionalMonthly = input.data.spending.optionalMonthly;
  const optionalTrim = Math.min(optionalMonthly, reductionNeeded);
  const remainingAfterOptional = Math.max(0, reductionNeeded - optionalTrim);
  const travelTrim = Math.min(travelMonthly, remainingAfterOptional);
  const discretionaryTrim = Math.max(0, reductionNeeded - optionalTrim - travelTrim);

  return [
    optionalTrim > 0
      ? `Optional spending could carry about ${formatCurrency(optionalTrim)}/mo of the first trim.`
      : 'Optional spending is already fairly lean at the current plan level.',
    travelTrim > 0
      ? `Travel could absorb about ${formatCurrency(travelTrim)}/mo without touching core bills.`
      : 'Travel is not the main place to look for savings in this range.',
    discretionaryTrim > 0
      ? `The remaining ${formatCurrency(discretionaryTrim)}/mo would need to come from other discretionary choices.`
      : 'You can likely stay inside the better safety zone without touching core essentials.',
  ];
}

function SpendSafetySection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[32px] border border-white/70 bg-white/80 p-6 shadow-lg shadow-amber-950/5 backdrop-blur">
      <div className="mb-5">
        <h2 className="font-serif text-3xl tracking-tight text-stone-900">{title}</h2>
        {subtitle ? (
          <p className="mt-2 max-w-[72ch] text-sm leading-6 text-stone-600">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function SpendVsSafetyScreen() {
  const data = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.draftAssumptions);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);

  const flexScenarios = useSpendSuccessScenarios({
    data,
    assumptions,
    selectedStressors,
    selectedResponses,
    strategyMode: 'planner_enhanced',
  });
  const handsOffScenarios = useSpendSuccessScenarios({
    data,
    assumptions,
    selectedStressors,
    selectedResponses,
    strategyMode: 'raw_simulation',
  });

  const points = flexScenarios.points;
  const loadState =
    flexScenarios.loadState === 'loading' || handsOffScenarios.loadState === 'loading'
      ? 'loading'
      : flexScenarios.loadState === 'error' || handsOffScenarios.loadState === 'error'
        ? 'error'
        : flexScenarios.loadState === 'ready' && handsOffScenarios.loadState === 'ready'
          ? 'ready'
          : 'idle';
  const progress = (flexScenarios.progress + handsOffScenarios.progress) / 2;
  const error = flexScenarios.error ?? handsOffScenarios.error;
  const isStale = flexScenarios.isStale || handsOffScenarios.isStale;
  const calculate = useCallback(() => {
    flexScenarios.calculate();
    handsOffScenarios.calculate();
  }, [flexScenarios, handsOffScenarios]);

  const currentPoint = useMemo(() => getCurrentScenario(points), [points]);
  const balancedZone = useMemo(() => getBalancedZone(points), [points]);
  const stretchZone = useMemo(() => getStretchZone(points), [points]);
  const fivePointMessage = useMemo(() => getFivePointGainMessage(points), [points]);
  const economizeSuggestions = useMemo(
    () => buildEconomizeSuggestions({ data, points }),
    [data, points],
  );

  const hasData = points.length > 0;

  return (
    <SpendSafetySection
      title="Spend vs Safety"
      subtitle="A compact view of how monthly spending changes the odds of success, future wealth, and how hard the plan may need to flex."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-6 rounded-full bg-blue-700" />
            <span className="font-semibold text-stone-800">Flex</span>
            <span className="text-stone-500">— cuts temporarily when markets drop</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-6 rounded-full border-t-2 border-dashed border-stone-400" />
            <span className="font-semibold text-stone-800">Hands off</span>
            <span className="text-stone-500">— keeps spending the target no matter what</span>
          </span>
        </div>
        <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <SpendSuccessChartCard
            points={points}
            comparePoints={handsOffScenarios.points}
            primaryLabel="Flex"
            compareLabel="Hands off"
            loadState={loadState}
            progress={progress}
            error={error}
            isStale={isStale}
            onCalculate={calculate}
          />

          <div className="space-y-4">
            {hasData && currentPoint ? (
              <>
                <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
                  <p className="text-sm font-medium text-stone-500">Current point</p>
                  <p className="mt-3 text-3xl font-semibold text-stone-900">
                    {formatCurrency(currentPoint.monthlySpend)}/mo
                  </p>
                  <p className="mt-3 text-sm leading-6 text-stone-600">
                    Success {formatPercent(currentPoint.successRate)} · Median wealth {formatCurrency(currentPoint.medianEndingWealth)}
                  </p>
                </article>
                <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
                  <p className="text-sm font-medium text-stone-500">+5% success move</p>
                  <p className="mt-3 text-lg font-semibold text-stone-900">{fivePointMessage}</p>
                </article>
                <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
                  <p className="text-sm font-medium text-stone-500">Recommendation bands</p>
                  <div className="mt-4 space-y-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.14em] text-emerald-700">Balanced zone</p>
                      <p className="mt-2 text-2xl font-semibold text-stone-900">
                        {formatMonthlyRange(balancedZone)}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-stone-600">
                        Higher safety with lighter guardrail dependence and modest IRMAA pressure.
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.14em] text-amber-700">Stretch zone</p>
                      <p className="mt-2 text-2xl font-semibold text-stone-900">
                        {formatMonthlyRange(stretchZone)}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-stone-600">
                        More spending, but the plan starts asking for more flexibility or taking more risk.
                      </p>
                    </div>
                  </div>
                </article>
              </>
            ) : (
              <article className="rounded-[28px] border border-dashed border-stone-300 bg-white/60 p-5 text-sm text-stone-600 shadow-sm">
                Recommendation bands, +5% move, and current-point details will appear once the spending-vs-success scenarios are calculated.
              </article>
            )}
          </div>
        </div>

        {hasData && currentPoint ? (
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.9fr]">
            <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
              <p className="text-sm font-medium text-stone-500">Safety cues</p>
              <div className="mt-4 space-y-3 text-sm leading-6 text-stone-700">
                <p>Lower spending points generally raise success and reduce guardrail reliance.</p>
                <p>
                  IRMAA pressure is lowest on the cooler-colored points and rises as spending pushes withdrawals and income higher.
                </p>
                <p>Dark-outlined points are the ones where success depends more heavily on later spending cuts.</p>
              </div>
            </article>

            <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
              <p className="text-sm font-medium text-stone-500">Economize suggestions</p>
              <div className="mt-4 space-y-3">
                {economizeSuggestions.map((suggestion) => (
                  <p
                    key={suggestion}
                    className="rounded-[18px] bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700"
                  >
                    {suggestion}
                  </p>
                ))}
              </div>
            </article>

            <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
              <p className="text-sm font-medium text-stone-500">Current tradeoff</p>
              <div className="mt-4 space-y-3 text-sm leading-6 text-stone-700">
                <p>
                  Current success rate: <span className="font-semibold">{formatPercent(currentPoint.successRate)}</span>
                </p>
                <p>
                  IRMAA exposure: <span className="font-semibold">{formatPercent(currentPoint.irmaaExposureRate)}</span>
                </p>
                <p>
                  Guardrail dependence: <span className="font-semibold">{formatPercent(currentPoint.spendingCutRate)}</span>
                </p>
              </div>
            </article>
          </div>
        ) : null}
      </div>
    </SpendSafetySection>
  );
}
