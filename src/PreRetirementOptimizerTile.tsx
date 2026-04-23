import { useMemo } from 'react';
import type { MarketAssumptions, SeedData } from './types';
import { buildPreRetirementOptimizerRecommendation } from './pre-retirement-optimizer';

// UI tile: replaces the generic "Max 401k / Fund HSA / Pre-build taxable
// bridge" strategic-prep card with a plan-specific, numbers-first
// recommendation — concrete shortfalls, tax-savings estimates, and a
// bridge-coverage projection that already credits in-window windfalls.
//
// IMPORTANT: untested in a real browser by the author. Styling matches
// the existing UnifiedPlanScreen stone/emerald palette. Adoption step
// is a single <PreRetirementOptimizerTile /> insert in UnifiedPlanScreen
// once the user confirms placement in-browser.

export interface PreRetirementOptimizerTileProps {
  seedData: SeedData;
  assumptions?: MarketAssumptions;
  title?: string;
  marginalFederalRate?: number;
  precomputed?: ReturnType<typeof buildPreRetirementOptimizerRecommendation>;
}

function fmtCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${Math.round(value).toLocaleString()}`;
}

function fmtPct(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

function fillStatusClass(shortfallPct: number): string {
  if (shortfallPct >= 0.95) return 'text-emerald-700';
  if (shortfallPct >= 0.6) return 'text-amber-700';
  return 'text-red-700';
}

export function PreRetirementOptimizerTile({
  seedData,
  assumptions,
  title = 'Pre-retirement accumulation',
  marginalFederalRate = 0.22,
  precomputed,
}: PreRetirementOptimizerTileProps) {
  const rec = useMemo(
    () =>
      precomputed ??
      buildPreRetirementOptimizerRecommendation({
        seedData,
        assumptions,
        marginalFederalRate,
      }),
    [precomputed, seedData, assumptions, marginalFederalRate],
  );

  if (!rec.applicable) {
    return (
      <article className="rounded-[24px] bg-stone-100/80 p-5">
        <p className="text-sm font-medium text-stone-500">{title}</p>
        <p className="mt-2 text-sm text-stone-700">
          {rec.reason ?? 'Not applicable for this plan.'}
        </p>
      </article>
    );
  }

  const totalTaxSavings = rec.shortfalls.reduce(
    (sum, s) => sum + s.estimatedMarginalFederalTaxSavedPerYear,
    0,
  );

  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <header className="flex items-center justify-between">
        <p className="text-sm font-medium text-stone-500">{title}</p>
        <p className="text-xs text-stone-500">
          {rec.bothRecommendationsCompatible
            ? 'No tradeoff'
            : 'Tradeoff required'}
        </p>
      </header>

      <div className="mt-3 text-2xl font-semibold text-stone-900">
        {fmtCurrencyCompact(totalTaxSavings)}
        <span className="ml-1 text-sm font-normal text-stone-600">
          / yr in current-year tax at {Math.round(marginalFederalRate * 100)}%
          marginal
        </span>
      </div>
      <p className="mt-1 text-sm text-stone-600">{rec.headline}</p>

      <dl className="mt-4 space-y-2 text-xs text-stone-700">
        {rec.shortfalls.map((shortfall) => (
          <div key={shortfall.bucket} className="flex items-start justify-between gap-3">
            <div>
              <dt className="font-medium text-stone-800">{shortfall.label}</dt>
              <dd className="text-stone-600">
                {fmtCurrencyCompact(shortfall.currentAnnualContribution)} /{' '}
                {fmtCurrencyCompact(shortfall.annualLimit)}
              </dd>
            </div>
            <div
              className={`text-right tabular-nums ${fillStatusClass(shortfall.shortfallPct)}`}
            >
              <div>{fmtPct(shortfall.shortfallPct)} funded</div>
              {shortfall.shortfallAnnual > 0 ? (
                <div className="text-stone-500">
                  +{fmtCurrencyCompact(shortfall.shortfallAnnual)} / yr
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </dl>

      <div className="mt-4 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-xs text-stone-700">
        <p className="font-medium text-stone-800">Bridge coverage</p>
        <dl className="mt-1 space-y-0.5">
          <div className="flex justify-between">
            <dt>Years pre-Medicare:</dt>
            <dd className="tabular-nums">
              {rec.bridge.bridgeYearsCovered.toFixed(1)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Target reserves:</dt>
            <dd className="tabular-nums">
              {fmtCurrencyCompact(rec.bridge.bridgeTargetBalance)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Projected taxable at retirement:</dt>
            <dd className="tabular-nums">
              {fmtCurrencyCompact(rec.bridge.projectedTaxableAtRetirement)}
            </dd>
          </div>
          {rec.bridge.bridgeWindowWindfallTotal > 0 ? (
            <div className="flex justify-between">
              <dt>
                + Windfalls (
                {rec.bridge.bridgeWindowWindfallNames.join(', ')}):
              </dt>
              <dd className="tabular-nums">
                {fmtCurrencyCompact(rec.bridge.bridgeWindowWindfallTotal)}
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between font-medium">
            <dt>Coverage gap:</dt>
            <dd
              className={`tabular-nums ${
                rec.bridge.bridgeCoverageGap > 0 ? 'text-red-700' : 'text-emerald-700'
              }`}
            >
              {rec.bridge.bridgeCoverageGap > 0
                ? fmtCurrencyCompact(rec.bridge.bridgeCoverageGap)
                : 'None — fully funded'}
            </dd>
          </div>
        </dl>
      </div>

      {rec.actionSteps.length > 0 ? (
        <details className="mt-3 text-xs text-stone-600">
          <summary className="cursor-pointer font-medium text-stone-700">
            Action steps ({rec.actionSteps.length})
          </summary>
          <ol className="mt-2 space-y-2">
            {rec.actionSteps.map((step) => (
              <li key={step.priority} className="space-y-0.5">
                <p className="font-medium text-stone-800">
                  {step.priority}. {step.action}
                </p>
                <p className="text-stone-600">{step.impact}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}
