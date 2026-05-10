import { useEffect, useMemo, useState } from 'react';
import {
  applySpendingMerchantCategoryRules,
  applySpendingTransactionOverrides,
  readSpendingMerchantCategoryRules,
  readSpendingTransactionOverrides,
} from '../spending-overrides';
import type { SpendingTransaction } from '../spending-ledger';
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
  if (instrument.id === 'plan_integrity' && instrument.headline === 'CLOSES') {
    return 'FUNDED';
  }
  return instrument.headline;
}

function planIntegrityPercentLabel(instrument: SixPackInstrument): string | null {
  if (instrument.id !== 'plan_integrity') return null;
  const successRate = numberDiagnostic(instrument, 'successRate');
  if (successRate === null) return instrument.frontMetric ?? null;
  const normalized = successRate <= 1 ? successRate * 100 : successRate;
  return `${Math.round(normalized)}%`;
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
  const planIntegrityPercent = planIntegrityPercentLabel(instrument);
  const headline = planIntegrityPercent ?? displayHeadline(instrument);

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
          {headline}
        </h3>
        {planIntegrityPercent ? (
          <p className="mt-0.5 truncate text-xs font-semibold uppercase tracking-[0.12em] opacity-75">
            {displayHeadline(instrument)}
          </p>
        ) : instrument.frontMetric ? (
          <p className="mt-1 truncate text-base font-semibold leading-5 tracking-normal">
            {instrument.frontMetric}
          </p>
        ) : null}
        {showLifestyleBar ? (
          <LifestylePaceMiniBar instrument={instrument} asOfIso={asOfIso} />
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
  const data = useAppStore((state) => state.appliedData);
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
    if (latestEvaluationContext) {
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
  }, [latestEvaluationContext]);

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
        evaluation: latestEvaluationContext?.evaluation ?? null,
        evaluationCapturedAtIso: latestEvaluationContext?.capturedAtIso ?? null,
        asOfIso,
      });
    },
    [asOfIso, data, latestEvaluationContext, quoteSnapshot, spending],
  );

  const snapshot =
    !latestEvaluationContext &&
    apiSnapshot &&
    apiSnapshot.counts.unknown < localSnapshot.counts.unknown
      ? apiSnapshot
      : localSnapshot;

  const selectedInstrument =
    snapshot.instruments.find((instrument) => instrument.id === selectedId) ??
    snapshot.instruments[0];

  return (
    <Panel
      title="6 Pack"
      subtitle="Monthly sweep status across lifestyle pace, runway, market weather, plan integrity, tax cliffs, and watch items."
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
