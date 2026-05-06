import { useEffect, useState } from 'react';
import type { MarketAssumptions, SeedData } from './types';
import { buildUncertaintySurface } from './uncertainty-surface';

// UI tile: replaces the misleading single-point success rate with an
// "honest headline" range computed by perturbing key assumptions
// (equity ±2pp, inflation +1pp, spending ±10%). Surfacing ranges instead
// of point estimates is the highest-leverage trust lever called out
// throughout the validation work.
//
// IMPORTANT: untested in a real browser by the author. Build / styling
// validation needed before adoption. Component is written to match the
// existing UnifiedPlanScreen stone/emerald palette.

export interface UncertaintyRangeTileProps {
  seedData: SeedData;
  assumptions: MarketAssumptions;
  // Optional: title override. Default reads "Success rate (range)".
  title?: string;
  // Optional: if the caller already holds an uncertainty surface (e.g.
  // computed once and cached alongside other dashboard tiles), pass it
  // directly to skip the recomputation. Otherwise we compute here.
  precomputed?: ReturnType<typeof buildUncertaintySurface>;
}

function formatPct(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

function formatCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${Math.round(value).toLocaleString()}`;
}

export function UncertaintyRangeTile({
  seedData,
  assumptions,
  title = 'Success rate (range)',
  precomputed,
}: UncertaintyRangeTileProps) {
  const [surface, setSurface] = useState<ReturnType<typeof buildUncertaintySurface> | null>(
    precomputed ?? null,
  );
  const [computing, setComputing] = useState(false);

  useEffect(() => {
    setSurface(precomputed ?? null);
    setComputing(false);
  }, [precomputed, seedData, assumptions]);

  const runSurface = () => {
    setComputing(true);
    window.setTimeout(() => {
      try {
        setSurface(buildUncertaintySurface(seedData, assumptions));
      } finally {
        setComputing(false);
      }
    }, 0);
  };

  if (!surface) {
    return (
      <article className="rounded-[24px] bg-stone-100/80 p-5">
        <header className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-stone-500">{title}</p>
          <button
            type="button"
            onClick={runSurface}
            disabled={computing}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {computing ? 'Computing…' : 'Run range'}
          </button>
        </header>
        <p className="mt-3 text-sm text-stone-600">
          Runs a sensitivity surface across returns, inflation, and spending.
        </p>
      </article>
    );
  }

  const baseline = surface.scenarios.find((s) => s.id === 'baseline');
  const baselinePct = baseline ? Math.round(baseline.successRate * 100) : null;
  const { successRateMinPct, successRateMaxPct } = surface.honestHeadline;

  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <header className="flex items-center justify-between">
        <p className="text-sm font-medium text-stone-500">{title}</p>
        {baselinePct !== null ? (
          <p className="text-xs text-stone-500">point estimate: {baselinePct}%</p>
        ) : null}
      </header>

      <div className="mt-3 text-2xl font-semibold text-stone-900">
        {successRateMinPct === successRateMaxPct
          ? `~${successRateMaxPct}%`
          : `${successRateMinPct}% – ${successRateMaxPct}%`}
      </div>
      <p className="mt-1 text-sm text-stone-600">{surface.honestHeadline.summary}</p>

      <dl className="mt-4 space-y-1 text-xs text-stone-600">
        <div className="flex justify-between">
          <dt>Median ending wealth range:</dt>
          <dd>
            {formatCurrencyCompact(surface.medianEndingWealthRange.min)}
            {' – '}
            {formatCurrencyCompact(surface.medianEndingWealthRange.max)}
          </dd>
        </div>
      </dl>

      <details className="mt-4 text-xs text-stone-600">
        <summary className="cursor-pointer font-medium text-stone-700">
          Which variations were tested
        </summary>
        <ul className="mt-2 space-y-1">
          {surface.scenarios.map((scenario) => (
            <li key={scenario.id} className="flex justify-between gap-3">
              <span>{scenario.label}</span>
              <span className="tabular-nums text-stone-500">
                {formatPct(scenario.successRate)} /{' '}
                {formatCurrencyCompact(scenario.medianEndingWealth)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
