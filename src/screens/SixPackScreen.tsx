import { useEffect, useMemo, useState } from 'react';
import {
  applySpendingMerchantCategoryRules,
  applySpendingTransactionOverrides,
  readSpendingMerchantCategoryRules,
  readSpendingTransactionOverrides,
} from '../spending-overrides';
import type { SpendingTransaction } from '../spending-ledger';
import type { SeedData } from '../types';
import {
  applySpendingCategoryInferences,
  splitAmazonCreditCardTransactionsForBudget,
} from '../spending-classification';
import { dedupeOverlappingLiveFeedTransactions } from '../spending-live-feed-dedupe';
import { buildSixPackSpendingContext } from '../six-pack-spending';
import { buildSixPackSnapshot } from '../six-pack-rules';
import {
  buildPortfolioWeatherSnapshot,
  type PortfolioQuoteSnapshot,
} from '../portfolio-weather';
import type { SixPackInstrument, SixPackSnapshot, SixPackStatus } from '../six-pack-types';
import { useAppStore } from '../store';
import { Panel } from '../ui-primitives';
import { formatCurrency } from '../utils';

const LOCAL_SPENDING_LEDGER_URLS = [
  '/local/spending-ledger.chase4582.json',
  '/local/spending-ledger.amex.json',
  '/local/spending-ledger.sofi.json',
  '/local/spending-ledger.gmail.json',
] as const;
const PORTFOLIO_QUOTES_URL = '/local/portfolio-quotes.json';
const LOCAL_SIX_PACK_API_URL = 'http://127.0.0.1:8787/api/six-pack';

interface LocalSpendingLedgerPayload {
  importedAtIso?: string;
  fetchedAtIso?: string;
  source?: {
    kind?: string;
  };
  transactions?: SpendingTransaction[];
}

const statusStyles: Record<SixPackStatus, string> = {
  green: 'border-emerald-200 bg-emerald-50 text-emerald-950',
  amber: 'border-amber-200 bg-amber-50 text-amber-950',
  red: 'border-rose-200 bg-rose-50 text-rose-950',
  unknown: 'border-stone-200 bg-stone-100 text-stone-800',
};

const statusDots: Record<SixPackStatus, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  unknown: 'bg-stone-400',
};

function statusCopy(status: SixPackStatus): string {
  if (status === 'green') return 'green';
  if (status === 'amber') return 'watch';
  if (status === 'red') return 'action';
  return 'unknown';
}

function displayHeadline(instrument: SixPackInstrument): string {
  return instrument.headline;
}

function compactCurrency(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return formatCurrency(Math.round(value));
}

function planIntegrityPercentLabel(instrument: SixPackInstrument): string | null {
  if (instrument.id !== 'plan_integrity') return null;
  const successRate = numberDiagnostic(instrument, 'successRate');
  if (successRate === null) return instrument.frontMetric ?? null;
  const normalized = successRate <= 1 ? successRate * 100 : successRate;
  return `${Math.round(normalized)}%`;
}

function planIntegritySummaryLabel(instrument: SixPackInstrument): string {
  if (instrument.status === 'green') return 'Plan works in latest run.';
  if (instrument.status === 'amber') return 'Plan needs a closer look.';
  if (instrument.status === 'red') return 'Plan is below guardrail.';
  return 'Run the plan to update.';
}

function weatherMetricLabel(instrument: SixPackInstrument): string | null {
  if (instrument.id !== 'portfolio_weather') return null;
  if (instrument.frontMetric) return instrument.frontMetric;

  const estimatedValue = numberDiagnostic(instrument, 'estimatedValue');
  const changePercent = numberDiagnostic(instrument, 'changePercent');
  if (estimatedValue === null || changePercent === null) return null;

  const direction = changePercent > 1 ? 'up' : changePercent < -1 ? 'down' : 'flat';
  return `${compactCurrency(estimatedValue)} · ${direction} ${Math.abs(changePercent).toFixed(1)}%`;
}

function taxMetricLabel(instrument: SixPackInstrument): string | null {
  if (instrument.id !== 'tax_cliffs') return null;
  const expectedTax = numberDiagnostic(instrument, 'expectedFederalTax');
  const expectedTaxYear = numberDiagnostic(instrument, 'expectedFederalTaxYear');
  if (expectedTax !== null) {
    return `Tax: ${expectedTaxYear === null ? '' : `${Math.round(expectedTaxYear)} `}federal tax projected at ${compactCurrency(expectedTax)}.`;
  }
  if (instrument.frontMetric) return instrument.frontMetric;
  return 'Tax needs update';
}

function yearlyBucketMetricLabel(instrument: SixPackInstrument): string | null {
  if (instrument.id !== 'watch_items') return null;
  return instrument.frontMetric ?? null;
}

function displayFrontMetric(instrument: SixPackInstrument): string | null {
  return (
    weatherMetricLabel(instrument) ??
    taxMetricLabel(instrument) ??
    yearlyBucketMetricLabel(instrument) ??
    instrument.frontMetric ??
    null
  );
}

function snapshotHasOneYearPortfolioHistory(snapshot: SixPackSnapshot): boolean {
  const weather = snapshot.instruments.find(
    (instrument) => instrument.id === 'portfolio_weather',
  );
  return typeof weather?.diagnostics.oneYearChangePercent === 'number';
}

function withFreshPortfolioWeather(
  snapshot: SixPackSnapshot | null,
  localSnapshot: SixPackSnapshot,
): SixPackSnapshot | null {
  if (!snapshot) return null;
  if (
    snapshotHasOneYearPortfolioHistory(snapshot) ||
    !snapshotHasOneYearPortfolioHistory(localSnapshot)
  ) {
    return snapshot;
  }
  const localWeather = localSnapshot.instruments.find(
    (instrument) => instrument.id === 'portfolio_weather',
  );
  if (!localWeather) return snapshot;
  return {
    ...snapshot,
    instruments: snapshot.instruments.map((instrument) =>
      instrument.id === 'portfolio_weather' ? localWeather : instrument,
    ),
  };
}

function withClientPuckDetails(
  snapshot: SixPackSnapshot | null,
  localSnapshot: SixPackSnapshot,
): SixPackSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    instruments: snapshot.instruments.map((instrument) => {
      const localInstrument = localSnapshot.instruments.find(
        (candidate) => candidate.id === instrument.id,
      );
      if (
        instrument.id === 'cash_runway' &&
        !instrument.frontMetric &&
        localInstrument?.frontMetric
      ) {
        return { ...instrument, frontMetric: localInstrument.frontMetric };
      }
      return instrument;
    }),
  };
}

function portfolioProjectionLabel(instrument: SixPackInstrument): string | null {
  if (instrument.id !== 'portfolio_weather') return null;
  const oneYearChangePercent = numberDiagnostic(instrument, 'oneYearChangePercent');
  const oneYearLookbackDays = numberDiagnostic(instrument, 'oneYearLookbackDays');
  if (oneYearChangePercent !== null && oneYearLookbackDays !== null) {
    const sign = oneYearChangePercent >= 0 ? '+' : '-';
    return `1y basket ${sign}${Math.abs(oneYearChangePercent).toFixed(1)}% over ${Math.round(oneYearLookbackDays)}d`;
  }
  const projectedAnnualChangePercent = numberDiagnostic(
    instrument,
    'projectedAnnualChangePercent',
  );
  const projectionWindowDays = numberDiagnostic(instrument, 'projectionWindowDays');
  if (projectedAnnualChangePercent === null || projectionWindowDays === null) return null;
  const sign = projectedAnnualChangePercent >= 0 ? '+' : '-';
  return `Proj ${sign}${Math.abs(projectedAnnualChangePercent).toFixed(1)}%/yr from ${Math.round(projectionWindowDays)}d`;
}

function taxContextLines(instrument: SixPackInstrument): string[] {
  if (instrument.id !== 'tax_cliffs') return [];
  const acaMargin = numberDiagnostic(instrument, 'acaMargin');
  const acaAppliesThisYear = instrument.diagnostics.acaAppliesThisYear === true;
  const acaGuardrailYear = numberDiagnostic(instrument, 'acaGuardrailYear');
  const irmaaMargin = numberDiagnostic(instrument, 'irmaaMargin');
  const irmaaLookbackTaxYear = numberDiagnostic(instrument, 'irmaaLookbackTaxYear');
  const expectedTaxYear = numberDiagnostic(instrument, 'expectedFederalTaxYear');
  const yearLabel =
    expectedTaxYear === null ? 'this year' : `${Math.round(expectedTaxYear)}`;

  const acaLine =
    acaAppliesThisYear && acaMargin !== null
      ? `ACA: projected MAGI is ${compactCurrency(Math.abs(acaMargin))} ${
          acaMargin >= 0 ? 'below' : 'above'
        } the ACA threshold.`
      : acaGuardrailYear !== null
        ? `ACA: not a ${yearLabel} guardrail; bridge starts around ${Math.round(acaGuardrailYear)}.`
        : `ACA: timing needs an update.`;

  const irmaaLine =
    irmaaMargin !== null && irmaaLookbackTaxYear !== null
      ? `IRMAA: projected ${Math.round(irmaaLookbackTaxYear)} MAGI is about ${compactCurrency(
          Math.abs(irmaaMargin),
        )} ${irmaaMargin >= 0 ? 'below' : 'above'} the first IRMAA threshold.`
      : `IRMAA: margin needs an update.`;

  return [acaLine, irmaaLine];
}

function frontMetricClass(instrument: SixPackInstrument): string {
  if (instrument.id === 'tax_cliffs') {
    return 'text-[12px] font-medium leading-4 tracking-normal';
  }
  if (instrument.id === 'portfolio_weather') {
    return 'text-sm font-semibold leading-5 tracking-normal tabular-nums';
  }
  if (instrument.id === 'watch_items') {
    return 'text-sm font-semibold leading-5 tracking-normal tabular-nums';
  }
  return 'text-base font-semibold leading-5 tracking-normal';
}

function progressWidth(value: number): string {
  return `${Math.min(100, Math.max(0, value)).toFixed(2)}%`;
}

function monthProgressPercent(asOfIso: string): number {
  const asOf = new Date(asOfIso);
  if (!Number.isFinite(asOf.getTime())) return 0;
  const daysInMonth = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 0).getDate();
  return ((asOf.getDate() - 1 + asOf.getHours() / 24) / daysInMonth) * 100;
}

function numberDiagnostic(
  instrument: SixPackInstrument,
  key: string,
): number | null {
  const value = instrument.diagnostics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringDiagnostic(
  instrument: SixPackInstrument,
  key: string,
): string | null {
  const value = instrument.diagnostics[key];
  return typeof value === 'string' ? value : null;
}

function toDateInputValue(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function yearFromDate(value: string): number | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.getFullYear();
}

function firstMedicareYear(data: SeedData): number | null {
  const years = [data.household.robBirthDate, data.household.debbieBirthDate]
    .map((value) => {
      const year = yearFromDate(value);
      return year === null ? null : year + 65;
    })
    .filter((value): value is number => value !== null);
  return years.length ? Math.min(...years) : null;
}

function enrichTaxGuardrailTiming(
  snapshot: SixPackSnapshot | null,
  data: SeedData,
  asOfIso: string,
): SixPackSnapshot | null {
  if (!snapshot) return null;
  const asOfYear = new Date(asOfIso).getFullYear();
  const acaGuardrailYear = yearFromDate(data.income.salaryEndDate);
  const acaAppliesThisYear =
    acaGuardrailYear !== null && acaGuardrailYear <= asOfYear;
  const medicareYear = firstMedicareYear(data);
  const irmaaLookbackTaxYear = medicareYear === null ? null : medicareYear - 2;
  const irmaaGuardrailTiming =
    irmaaLookbackTaxYear === null
      ? 'unknown'
      : asOfYear === irmaaLookbackTaxYear
        ? 'current_tax_year'
        : asOfYear < irmaaLookbackTaxYear
          ? 'future_tax_year'
          : 'active_or_ongoing';

  return {
    ...snapshot,
    instruments: snapshot.instruments.map((instrument) =>
      instrument.id !== 'tax_cliffs'
        ? instrument
        : (() => {
            const expectedTax = numberDiagnostic(instrument, 'expectedFederalTax');
            const projectedMagi = numberDiagnostic(instrument, 'projectedMagi');
            const acaThreshold = numberDiagnostic(instrument, 'acaIncomeThreshold');
            const irmaaThreshold = numberDiagnostic(instrument, 'irmaaIncomeThreshold');
            const irmaaMargin = numberDiagnostic(instrument, 'irmaaMargin');
            const timingDetail =
              `ACA is ${acaAppliesThisYear ? 'a current-year guardrail' : `not a ${asOfYear} guardrail`}${
                acaGuardrailYear === null ? '' : `; modeled ACA bridge starts around ${acaGuardrailYear}`
              }. IRMAA ${
                irmaaGuardrailTiming === 'current_tax_year'
                  ? `is active in tax year ${asOfYear}`
                  : irmaaGuardrailTiming === 'future_tax_year'
                    ? `starts in tax year ${irmaaLookbackTaxYear}`
                    : 'is active or ongoing'
              }${medicareYear === null ? '' : ` for ${medicareYear} Medicare premiums`}.`;
            const rebuiltDetail =
              expectedTax === null && projectedMagi === null
                ? timingDetail
                : [
                    expectedTax === null
                      ? null
                      : `Expected ${asOfYear} federal tax is ${formatCurrency(expectedTax)}.`,
                    projectedMagi === null
                      ? null
                      : `Projected ${asOfYear} MAGI is ${formatCurrency(projectedMagi)}.`,
                    acaThreshold === null
                      ? null
                      : acaAppliesThisYear
                        ? `ACA threshold is ${formatCurrency(acaThreshold)}.`
                        : `ACA threshold ${formatCurrency(acaThreshold)} is planning context, not a ${asOfYear} guardrail.`,
                    irmaaThreshold === null
                      ? null
                      : `IRMAA threshold is ${formatCurrency(irmaaThreshold)}${
                          irmaaMargin === null ? '' : ` with ${formatCurrency(irmaaMargin)} margin`
                        }.`,
                    timingDetail,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' ');

            return {
              ...instrument,
              detail: rebuiltDetail,
              diagnostics: {
                ...instrument.diagnostics,
                acaAppliesThisYear:
                  instrument.diagnostics.acaAppliesThisYear ?? acaAppliesThisYear,
                acaGuardrailYear:
                  instrument.diagnostics.acaGuardrailYear ?? acaGuardrailYear,
                acaTiming:
                  instrument.diagnostics.acaTiming ??
                  (acaAppliesThisYear ? 'current_year_guardrail' : 'future_guardrail'),
                irmaaFirstMedicareYear:
                  instrument.diagnostics.irmaaFirstMedicareYear ?? medicareYear,
                irmaaLookbackTaxYear:
                  instrument.diagnostics.irmaaLookbackTaxYear ?? irmaaLookbackTaxYear,
                irmaaGuardrailTiming:
                  instrument.diagnostics.irmaaGuardrailTiming ?? irmaaGuardrailTiming,
              },
            };
          })(),
    ),
  };
}

function isDateInputValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(value).getTime());
}

function formatDateInputLabel(value: string): string {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (!year || !month || !day) return 'Invalid date';
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function retirementDateDeltaLabel(appliedValue: string, draftValue: string): string | null {
  const applied = new Date(appliedValue);
  const draft = new Date(draftValue);
  if (!Number.isFinite(applied.getTime()) || !Number.isFinite(draft.getTime())) return null;
  const appliedMonth = applied.getFullYear() * 12 + applied.getMonth();
  const draftMonth = draft.getFullYear() * 12 + draft.getMonth();
  const delta = draftMonth - appliedMonth;
  if (delta === 0) return 'same month as current plan';
  const direction = delta > 0 ? 'later' : 'earlier';
  const abs = Math.abs(delta);
  const years = Math.floor(abs / 12);
  const months = abs % 12;
  const parts = [
    years ? `${years} yr${years === 1 ? '' : 's'}` : null,
    months ? `${months} mo` : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join(' ')} ${direction}`;
}

function LifestylePaceMiniBar({
  instrument,
  asOfIso,
}: {
  instrument: SixPackInstrument;
  asOfIso: string;
}) {
  const spent = numberDiagnostic(instrument, 'monthlyOperatingSpent');
  const budget = numberDiagnostic(instrument, 'monthlyOperatingBudget');
  const elapsedPercent =
    numberDiagnostic(instrument, 'monthElapsedPercent') ?? monthProgressPercent(asOfIso);

  if (spent === null || budget === null || budget <= 0) return null;

  const spentPercent = (spent / budget) * 100;
  const overBudget = spentPercent > 100;

  return (
    <div className="mt-2">
      <div
        className="relative h-2.5 overflow-visible rounded-full bg-white/80 shadow-inner ring-1 ring-black/5"
        title={`${formatCurrency(spent)} spent against ${formatCurrency(budget)} monthly lane`}
      >
        <div
          className={`absolute left-0 top-0 h-2.5 rounded-full ${
            overBudget ? 'bg-rose-500' : 'bg-[#0071E3]'
          }`}
          style={{ width: progressWidth(spentPercent) }}
        />
        <div
          className="absolute top-[-5px] z-10 h-5 w-1 -translate-x-1/2 rounded-full bg-stone-950 shadow-[0_0_0_2px_rgba(255,255,255,0.9)]"
          style={{ left: progressWidth(elapsedPercent) }}
          title={`${Math.round(elapsedPercent)}% of month elapsed`}
        />
      </div>
    </div>
  );
}

function YearlyBucketsMiniBar({ instrument }: { instrument: SixPackInstrument }) {
  const actualSpend = numberDiagnostic(instrument, 'annualEscrowActualSpend');
  const adaptiveBudget = numberDiagnostic(instrument, 'annualEscrowAdaptiveBudget');
  const plannedBudget = numberDiagnostic(instrument, 'annualEscrowPlannedBudget');

  if (actualSpend === null) return null;

  const denominator = Math.max(
    adaptiveBudget ?? 0,
    plannedBudget ?? 0,
    actualSpend,
    1,
  );
  const usedPercent = (actualSpend / denominator) * 100;

  return (
    <div className="mt-2">
      <div
        className="relative h-2.5 overflow-visible rounded-full bg-white/80 shadow-inner ring-1 ring-black/5"
        title={`${formatCurrency(actualSpend)} used against ${formatCurrency(denominator)} adaptive yearly lane`}
      >
        <div
          className="absolute left-0 top-0 h-2.5 rounded-full bg-[#0071E3]"
          style={{ width: progressWidth(usedPercent) }}
        />
      </div>
    </div>
  );
}

function TaxCliffReadout({ instrument }: { instrument: SixPackInstrument }) {
  if (instrument.id !== 'tax_cliffs') return null;

  const expectedTax = numberDiagnostic(instrument, 'expectedFederalTax');
  const expectedTaxYear = numberDiagnostic(instrument, 'expectedFederalTaxYear');
  const projectedMagi = numberDiagnostic(instrument, 'projectedMagi');
  const acaThreshold = numberDiagnostic(instrument, 'acaIncomeThreshold');
  const acaMargin = numberDiagnostic(instrument, 'acaMargin');
  const acaGuardrailYear = numberDiagnostic(instrument, 'acaGuardrailYear');
  const acaAppliesThisYear = instrument.diagnostics.acaAppliesThisYear === true;
  const acaTiming = stringDiagnostic(instrument, 'acaTiming');
  const irmaaThreshold = numberDiagnostic(instrument, 'irmaaIncomeThreshold');
  const irmaaMargin = numberDiagnostic(instrument, 'irmaaMargin');
  const irmaaLookbackTaxYear = numberDiagnostic(instrument, 'irmaaLookbackTaxYear');
  const irmaaFirstMedicareYear = numberDiagnostic(instrument, 'irmaaFirstMedicareYear');
  const irmaaGuardrailTiming = stringDiagnostic(instrument, 'irmaaGuardrailTiming');

  if (
    expectedTax === null &&
    projectedMagi === null &&
    acaThreshold === null &&
    irmaaThreshold === null
  ) {
    return null;
  }

  const rows = [
    expectedTax !== null
      ? {
          label: `Expected tax ${expectedTaxYear ? Math.round(expectedTaxYear) : ''}`.trim(),
          value: formatCurrency(expectedTax),
        }
      : null,
    projectedMagi !== null
      ? { label: 'Projected MAGI', value: formatCurrency(projectedMagi) }
      : null,
    acaThreshold !== null && acaAppliesThisYear
      ? {
          label: 'ACA threshold',
          value: `${formatCurrency(acaThreshold)} · margin ${
            acaMargin === null ? 'n/a' : formatCurrency(acaMargin)
          }`,
        }
      : null,
    acaThreshold !== null && !acaAppliesThisYear
      ? {
          label: 'ACA guardrail',
          value: `Not active now${
            acaGuardrailYear === null ? '' : ` · bridge ${Math.round(acaGuardrailYear)}`
          }`,
        }
      : null,
    irmaaThreshold !== null
      ? {
          label:
            irmaaLookbackTaxYear === null
              ? 'IRMAA threshold'
              : `IRMAA tax year ${Math.round(irmaaLookbackTaxYear)}`,
          value: `${formatCurrency(irmaaThreshold)} · margin ${
            irmaaMargin === null ? 'n/a' : formatCurrency(irmaaMargin)
          }`,
        }
      : null,
  ].filter((row): row is { label: string; value: string } => row !== null);
  const plainEnglishLines = taxContextLines(instrument);

  return (
    <div className="mt-4 rounded-xl bg-stone-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">
        Current Tax Read
      </p>
      <dl className="mt-2 space-y-1 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-3">
            <dt className="text-stone-500">{row.label}</dt>
            <dd className="font-semibold text-stone-900">{row.value}</dd>
          </div>
        ))}
      </dl>
      {plainEnglishLines.length ? (
        <div className="mt-2 space-y-1 text-[11px] leading-4 text-stone-500">
          {plainEnglishLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {irmaaGuardrailTiming === 'current_tax_year' && irmaaFirstMedicareYear !== null ? (
            <p>
              {Math.round(irmaaLookbackTaxYear ?? expectedTaxYear ?? 0)} income affects{' '}
              {Math.round(irmaaFirstMedicareYear)} Medicare premiums.
            </p>
          ) : null}
          {acaTiming === 'future_guardrail' ? (
            <p>ACA threshold is planning context here, not a current-year guardrail.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RetirementDateControl({
  value,
  appliedValue,
  pending,
  onChange,
  onApplyAndRerun,
  onReset,
}: {
  value: string;
  appliedValue: string;
  pending: boolean;
  onChange: (value: string) => void;
  onApplyAndRerun: () => void;
  onReset: () => void;
}) {
  const valueForInput = toDateInputValue(value);
  const appliedForInput = toDateInputValue(appliedValue);
  const deltaLabel = retirementDateDeltaLabel(appliedValue, value);
  const currentLabel = valueForInput ? formatDateInputLabel(valueForInput) : 'Invalid date';
  const [textValue, setTextValue] = useState(valueForInput);

  useEffect(() => {
    setTextValue(valueForInput);
  }, [valueForInput]);

  const applyTextValue = () => {
    if (isDateInputValue(textValue)) {
      onChange(textValue);
      return;
    }
    setTextValue(valueForInput);
  };

  return (
    <div className="mt-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Simulation Retirement Date
          </p>
          <p className="mt-1 text-sm text-stone-700">
            Salary ends {currentLabel}
            {deltaLabel ? ` · ${deltaLabel}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={valueForInput}
            onChange={(event) => {
              const next = event.target.value;
              if (isDateInputValue(next)) onChange(next);
            }}
            className="h-9 rounded-lg border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800"
          />
          <input
            type="text"
            inputMode="numeric"
            value={textValue}
            placeholder="YYYY-MM-DD"
            onChange={(event) => setTextValue(event.target.value)}
            onBlur={applyTextValue}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyTextValue();
            }}
            className="h-9 w-28 rounded-lg border border-stone-300 bg-white px-3 font-mono text-xs font-semibold tracking-[0.06em] text-stone-800"
          />
          {pending ? (
            <button
              type="button"
              onClick={onReset}
              className="h-9 rounded-lg bg-stone-100 px-3 text-xs font-semibold text-stone-700 transition hover:bg-stone-200"
            >
              Reset
            </button>
          ) : null}
          <button
            type="button"
            onClick={onApplyAndRerun}
            disabled={!pending || !valueForInput || valueForInput === appliedForInput}
            className="h-9 rounded-lg bg-[#0071E3] px-3 text-xs font-semibold text-white transition hover:bg-[#0066CC] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply &amp; rerun
          </button>
        </div>
      </div>
      {pending ? (
        <p className="mt-2 text-xs font-medium text-blue-800">
          Retirement date is staged. Apply to rerun plan integrity, tax, ACA, and IRMAA.
        </p>
      ) : null}
    </div>
  );
}

function SixPackPuck({
  instrument,
  asOfIso,
  selected,
  onSelect,
}: {
  instrument: SixPackInstrument;
  asOfIso: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const showLifestyleBar = instrument.id === 'lifestyle_pace';
  const showYearlyBar = instrument.id === 'watch_items';
  const planIntegrityPercent = planIntegrityPercentLabel(instrument);
  const headline = planIntegrityPercent ?? displayHeadline(instrument);
  const displayHeadlineText =
    instrument.id === 'tax_cliffs' && headline === 'NO RUN' ? 'UPDATE' : headline;
  const frontMetric = displayFrontMetric(instrument);
  const projectionLabel = portfolioProjectionLabel(instrument);
  const taxLines = taxContextLines(instrument);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`min-h-20 rounded-xl border px-3 py-2.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${statusStyles[instrument.status]} ${
        selected ? 'ring-2 ring-blue-500 ring-offset-2' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
          {instrument.label}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] opacity-70">
            {statusCopy(instrument.status)}
          </span>
          <span className={`h-2 w-2 rounded-full ${statusDots[instrument.status]}`} />
        </div>
      </div>
      <div className="mt-2 min-w-0">
        <h3
          className={`truncate font-semibold tracking-normal ${
            planIntegrityPercent ? 'text-2xl leading-7 tabular-nums' : 'text-lg leading-6'
          }`}
        >
          {displayHeadlineText}
        </h3>
        {planIntegrityPercent ? (
          <p className="mt-0.5 truncate text-xs font-medium leading-4 opacity-75">
            {planIntegritySummaryLabel(instrument)}
          </p>
        ) : frontMetric ? (
          <p
            className={`mt-1 ${
              instrument.id === 'tax_cliffs' ? '' : 'truncate'
            } ${frontMetricClass(instrument)}`}
          >
            {frontMetric}
          </p>
        ) : null}
        {showLifestyleBar ? (
          <LifestylePaceMiniBar instrument={instrument} asOfIso={asOfIso} />
        ) : null}
        {showYearlyBar ? <YearlyBucketsMiniBar instrument={instrument} /> : null}
        {projectionLabel ? (
          <p className="mt-1 truncate text-xs font-semibold leading-4 opacity-75">
            {projectionLabel}
          </p>
        ) : null}
        {taxLines.length ? (
          <div className="mt-1 space-y-0.5 text-[11px] font-medium leading-4 opacity-75">
            {taxLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function SixPackDetail({ instrument }: { instrument: SixPackInstrument }) {
  return (
    <aside className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">
            {instrument.question}
          </p>
          <h3 className="mt-2 text-xl font-semibold text-stone-950">
            {instrument.label}
          </h3>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${statusStyles[instrument.status]}`}
        >
          {statusCopy(instrument.status)}
        </span>
      </div>

      <TaxCliffReadout instrument={instrument} />

      <div className="mt-4 space-y-3 text-sm leading-6 text-stone-700">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">
            Why
          </p>
          <p className="mt-1">{instrument.reason}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">
            Detail
          </p>
          <p className="mt-1">{instrument.detail}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">
            Rule
          </p>
          <p className="mt-1">{instrument.rule}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">
            Source
          </p>
          <p className="mt-1">
            {instrument.sourceFreshness.label}
            {instrument.sourceFreshness.stale ? ' · stale' : ''}
          </p>
        </div>
      </div>

      {Object.keys(instrument.diagnostics).length ? (
        <dl className="mt-4 grid gap-2 border-t border-stone-200 pt-4 text-xs">
          {Object.entries(instrument.diagnostics).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3">
              <dt className="text-stone-500">{key}</dt>
              <dd className="font-semibold text-stone-900">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </aside>
  );
}

export function SixPackScreen() {
  const data = useAppStore((state) => state.data);
  const appliedData = useAppStore((state) => state.appliedData);
  const hasPendingSimulationChanges = useAppStore(
    (state) => state.hasPendingSimulationChanges,
  );
  const updateIncome = useAppStore((state) => state.updateIncome);
  const commitDraftToApplied = useAppStore((state) => state.commitDraftToApplied);
  const resetDraftToApplied = useAppStore((state) => state.resetDraftToApplied);
  const requestUnifiedPlanRerun = useAppStore((state) => state.requestUnifiedPlanRerun);
  const clearLatestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.clearLatestUnifiedPlanEvaluationContext,
  );
  const latestEvaluationContext = useAppStore(
    (state) => state.latestUnifiedPlanEvaluationContext,
  );
  const [localLedgers, setLocalLedgers] = useState<LocalSpendingLedgerPayload[]>([]);
  const [quoteSnapshot, setQuoteSnapshot] = useState<PortfolioQuoteSnapshot | null>(null);
  const [apiSnapshot, setApiSnapshot] = useState<SixPackSnapshot | null>(null);
  const [ledgerStatus, setLedgerStatus] = useState<'loading' | 'loaded' | 'missing' | 'error'>(
    'loading',
  );
  const [selectedId, setSelectedId] = useState<SixPackInstrument['id']>('lifestyle_pace');
  const [asOfIso] = useState(() => new Date().toISOString());

  const applyRetirementDateAndRerun = () => {
    commitDraftToApplied();
    clearLatestUnifiedPlanEvaluationContext();
    setApiSnapshot(null);
    requestUnifiedPlanRerun();
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      LOCAL_SPENDING_LEDGER_URLS.map((url) =>
        fetch(url, { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) return null;
            return (await response.json()) as LocalSpendingLedgerPayload;
          })
          .catch(() => null),
      ),
    )
      .then((payloads) => {
        if (cancelled) return;
        const ledgers = payloads.filter(
          (payload): payload is LocalSpendingLedgerPayload =>
            Boolean(payload && Array.isArray(payload.transactions)),
        );
        setLocalLedgers(ledgers);
        setLedgerStatus(ledgers.length ? 'loaded' : 'missing');
      })
      .catch(() => {
        if (cancelled) return;
        setLocalLedgers([]);
        setLedgerStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(PORTFOLIO_QUOTES_URL, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as PortfolioQuoteSnapshot;
      })
      .then((payload) => {
        if (cancelled) return;
        setQuoteSnapshot(payload);
      })
      .catch(() => {
        if (cancelled) return;
        setQuoteSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (latestEvaluationContext || hasPendingSimulationChanges) {
      setApiSnapshot(null);
      return;
    }
    let cancelled = false;
    fetch(LOCAL_SIX_PACK_API_URL, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as SixPackSnapshot;
      })
      .then((payload) => {
        if (cancelled) return;
        setApiSnapshot(payload?.version === 'six_pack_v1' ? payload : null);
      })
      .catch(() => {
        if (cancelled) return;
        setApiSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasPendingSimulationChanges, latestEvaluationContext]);

  const transactions = useMemo(() => {
    const loadedTransactions = localLedgers.flatMap((ledger) => ledger.transactions ?? []);
    if (!loadedTransactions.length) return [];
    const deduped = dedupeOverlappingLiveFeedTransactions(loadedTransactions);
    if (typeof window === 'undefined' || !window.localStorage) {
      return splitAmazonCreditCardTransactionsForBudget(
        applySpendingCategoryInferences(deduped),
      );
    }
    const overrides = readSpendingTransactionOverrides(window.localStorage);
    const merchantRules = readSpendingMerchantCategoryRules(window.localStorage);
    return splitAmazonCreditCardTransactionsForBudget(
      applySpendingTransactionOverrides(
        applySpendingMerchantCategoryRules(
          applySpendingCategoryInferences(deduped),
          merchantRules,
        ),
        overrides,
      ),
    );
  }, [localLedgers]);

  const spending = useMemo(
    () =>
      ledgerStatus === 'loaded'
        ? buildSixPackSpendingContext({
            data,
            transactions,
            asOfIso,
            ledgerStatus: 'loaded',
          })
        : null,
    [asOfIso, data, ledgerStatus, transactions],
  );

  const localSnapshot = useMemo(
    () => {
      const portfolioWeather = buildPortfolioWeatherSnapshot({
        data,
        quoteSnapshot,
        asOfIso,
      });
      return buildSixPackSnapshot({
        data,
        spending,
        portfolioWeather,
        evaluation: hasPendingSimulationChanges
          ? null
          : latestEvaluationContext?.evaluation ?? null,
        evaluationCapturedAtIso: hasPendingSimulationChanges
          ? null
          : latestEvaluationContext?.capturedAtIso ?? null,
        asOfIso,
      });
    },
    [asOfIso, data, hasPendingSimulationChanges, latestEvaluationContext, quoteSnapshot, spending],
  );

  const enrichedApiSnapshot = useMemo(
    () =>
      withClientPuckDetails(
        withFreshPortfolioWeather(
          enrichTaxGuardrailTiming(apiSnapshot, data, asOfIso),
          localSnapshot,
        ),
        localSnapshot,
      ),
    [apiSnapshot, asOfIso, data, localSnapshot],
  );

  const snapshot =
    !hasPendingSimulationChanges &&
    !latestEvaluationContext &&
    enrichedApiSnapshot &&
    enrichedApiSnapshot.counts.unknown < localSnapshot.counts.unknown
      ? enrichedApiSnapshot
      : localSnapshot;

  const selectedInstrument =
    snapshot.instruments.find((instrument) => instrument.id === selectedId) ??
    snapshot.instruments[0];

  return (
    <Panel
      title="6 Pack"
      subtitle="Monthly sweep status across lifestyle pace, runway, market weather, plan integrity, tax cliffs, and yearly buckets."
    >
      <div className={`rounded-xl border px-4 py-3 ${statusStyles[snapshot.overallStatus]}`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-70">
              Sweep
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-normal">
              {snapshot.summary}
            </h2>
          </div>
          <p className="text-sm font-semibold opacity-80">
            {snapshot.counts.green} green · {snapshot.counts.amber} watch ·{' '}
            {snapshot.counts.red} action · {snapshot.counts.unknown} unknown
          </p>
        </div>
      </div>

      {ledgerStatus === 'loading' ? (
        <p className="mt-3 text-sm text-stone-500">Loading local spending ledger...</p>
      ) : null}
      {snapshot === apiSnapshot ? (
        <p className="mt-3 text-xs font-medium text-stone-500">
          Using the local 6 Pack API plan read for plan and tax pucks.
        </p>
      ) : null}

      <RetirementDateControl
        value={data.income.salaryEndDate}
        appliedValue={appliedData.income.salaryEndDate}
        pending={hasPendingSimulationChanges}
        onChange={(nextDate) => updateIncome('salaryEndDate', nextDate)}
        onApplyAndRerun={applyRetirementDateAndRerun}
        onReset={resetDraftToApplied}
      />

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {snapshot.instruments.map((instrument) => (
            <SixPackPuck
              key={instrument.id}
              instrument={instrument}
              asOfIso={snapshot.asOfIso}
              selected={selectedInstrument.id === instrument.id}
              onSelect={() => setSelectedId(instrument.id)}
            />
          ))}
        </div>
        <SixPackDetail instrument={selectedInstrument} />
      </div>
    </Panel>
  );
}
