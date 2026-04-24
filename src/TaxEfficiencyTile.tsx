import { useMemo } from 'react';
import type { PathResult } from './types';
import { computeTaxEfficiencyReport } from './tax-efficiency';

// UI tile: surfaces the engine's lifetime tax footprint, heat years,
// and IRMAA cliff exposure. Targets the stated user priority ("hate
// paying taxes") by making the same info that drives Roth-conversion
// and withdrawal-order decisions visible at the dashboard level.
//
// IMPORTANT: untested in a real browser by the author. Styling matches
// the existing UnifiedPlanScreen palette; adoption needs browser eyes.

export interface TaxEfficiencyTileProps {
  path: PathResult;
  title?: string;
  precomputed?: ReturnType<typeof computeTaxEfficiencyReport>;
}

function fmtCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${Math.round(value).toLocaleString()}`;
}

function fmtPct(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

const DRIVER_LABEL: Record<string, string> = {
  rmd: 'RMD',
  roth_conversion: 'Roth conversion',
  windfall: 'Windfall',
  ordinary: 'Ordinary retirement income',
};

export function TaxEfficiencyTile({
  path,
  title = 'Tax efficiency',
  precomputed,
}: TaxEfficiencyTileProps) {
  const report = useMemo(
    () => precomputed ?? computeTaxEfficiencyReport(path),
    [precomputed, path],
  );

  const topHeatYear = report.heatYears[0];
  const cliffCount = report.irmaaCliffYears.length;

  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <header className="flex items-center justify-between">
        <p className="text-sm font-medium text-stone-500">{title}</p>
      </header>

      <div className="mt-3 text-2xl font-semibold text-stone-900">
        {fmtCurrencyCompact(report.lifetimeFederalTax)}
      </div>
      <p className="mt-1 text-sm text-stone-600">
        Lifetime federal tax — effective rate{' '}
        {fmtPct(report.effectiveLifetimeFederalRate)}.
      </p>

      <dl className="mt-4 space-y-1 text-xs text-stone-600">
        <div className="flex justify-between">
          <dt>IRMAA surcharge (lifetime):</dt>
          <dd className="tabular-nums">
            {fmtCurrencyCompact(report.lifetimeIrmaaSurcharge)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Years in IRMAA tier 3+:</dt>
          <dd className="tabular-nums">{cliffCount}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Roth conversion years:</dt>
          <dd className="tabular-nums">
            {report.rothConversionYearsCount}{' '}
            {report.rothConversionYearsCount > 0
              ? `(${fmtCurrencyCompact(report.lifetimeRothConversionAmount)} total)`
              : ''}
          </dd>
        </div>
      </dl>

      {topHeatYear ? (
        <div className="mt-4 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-xs text-stone-700">
          <p className="font-medium text-stone-800">
            Heaviest tax year: {topHeatYear.year}{' '}
            <span className="text-stone-500">
              ({fmtCurrencyCompact(topHeatYear.totalTaxBurden)})
            </span>
          </p>
          <p className="mt-1 text-stone-600">
            {DRIVER_LABEL[topHeatYear.primaryDriver] ?? topHeatYear.primaryDriver}:{' '}
            {topHeatYear.driverDetail}
          </p>
        </div>
      ) : null}

      <details className="mt-3 text-xs text-stone-600">
        <summary className="cursor-pointer font-medium text-stone-700">
          Top 5 heat years
        </summary>
        <ul className="mt-2 space-y-1">
          {report.heatYears.map((heatYear) => (
            <li key={heatYear.year} className="flex justify-between gap-3">
              <span className="tabular-nums">{heatYear.year}</span>
              <span className="text-stone-500">
                {DRIVER_LABEL[heatYear.primaryDriver] ?? heatYear.primaryDriver}
              </span>
              <span className="tabular-nums">
                {fmtCurrencyCompact(heatYear.totalTaxBurden)}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {cliffCount > 0 ? (
        <details className="mt-2 text-xs text-stone-600">
          <summary className="cursor-pointer font-medium text-stone-700">
            IRMAA tier-3+ years
          </summary>
          <ul className="mt-2 space-y-1">
            {report.irmaaCliffYears.map((cliff) => (
              <li key={cliff.year} className="flex justify-between gap-3">
                <span className="tabular-nums">{cliff.year}</span>
                <span className="text-stone-500">{cliff.tier}</span>
                <span className="tabular-nums">
                  {fmtCurrencyCompact(cliff.surcharge)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
