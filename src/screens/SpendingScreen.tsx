import { useEffect, useMemo, useState } from 'react';
import { buildHomeAssistantMonthlyBudgetPayload } from '../home-assistant-spending-contract';
import {
  applySpendingTransactionOverrides,
  buildSpendingTransactionOverride,
  readSpendingTransactionOverrides,
  writeSpendingTransactionOverrides,
  type SpendingTransactionOverrideMap,
} from '../spending-overrides';
import {
  buildRetirementSpendingBudgetPlan,
  buildSpendingMonthSummary,
  daysInMonthKey,
  type SpendingBudgetCategory,
  type SpendingBudgetPlan,
  type SpendingCategorySummary,
  type SpendingLedgerSourceKind,
  type SpendingPaceStatus,
  type SpendingTransaction,
} from '../spending-ledger';
import { useAppStore } from '../store';
import { MetricTile, Panel } from '../ui-primitives';
import { formatCurrency, formatDate } from '../utils';

const HEALTH_BUDGET_FROM_OPTIONAL = 650;
const AMAZON_BUDGET_FROM_OPTIONAL = 900;
const LOCAL_SPENDING_LEDGER_URLS = [
  '/local/spending-ledger.chase4582.json',
  '/local/spending-ledger.amex.json',
  '/local/spending-ledger.sofi.json',
  '/local/spending-ledger.gmail.json',
] as const;

const STATUS_LABELS: Record<SpendingPaceStatus, string> = {
  under: 'Under pace',
  on_track: 'On track',
  watch: 'Watch',
  over: 'Over pace',
  unbudgeted: 'Unbudgeted',
};

const STATUS_STYLES: Record<SpendingPaceStatus, string> = {
  under: 'bg-cyan-50 text-cyan-800 ring-cyan-100',
  on_track: 'bg-emerald-50 text-emerald-800 ring-emerald-100',
  watch: 'bg-amber-50 text-amber-800 ring-amber-100',
  over: 'bg-rose-50 text-rose-800 ring-rose-100',
  unbudgeted: 'bg-stone-100 text-stone-700 ring-stone-200',
};

const CATEGORY_HELP: Record<string, string> = {
  essential:
    'Core household spend: groceries, utilities, transportation basics, insurance-like debits, and education debt.',
  optional:
    'Flexible lifestyle spend: dining, entertainment, home goods, personal purchases, and other card charges that can move if needed.',
  amazon_uncategorized:
    'Amazon charges where the card amount is known, but item-level detail is unavailable. These need review once Amazon order data arrives.',
  health:
    'Medical, pharmacy, healthcare systems, and wellness transactions.',
  travel:
    'Airlines, lodging, travel agencies, rides, and other trip-related transactions.',
  taxes_insurance:
    'Annual tax and insurance budget from the retirement seed. Bank/card transaction mapping is intentionally conservative here.',
  family_transfers:
    'P2P and Zelle outflows to family or known people. These are tracked separately until you decide whether they belong in ordinary spending.',
  ignored:
    'Cashflow movements excluded from spending totals: credit-card payments, payroll, internal transfers, vault moves, and other non-spend items.',
  uncategorized:
    'Transactions the rules did not confidently classify yet.',
};

function localMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dateForMonthDay(month: string, day: number): string {
  const maxDay = daysInMonthKey(month);
  const clampedDay = Math.min(maxDay, Math.max(1, day));
  return `${month}-${String(clampedDay).padStart(2, '0')}`;
}

function enhanceBudgetPlanWithOperatingBuckets(
  basePlan: SpendingBudgetPlan,
): SpendingBudgetPlan {
  const categories: SpendingBudgetCategory[] = [];

  basePlan.categories.forEach((category) => {
    if (category.id === 'optional') {
      categories.push({
        ...category,
        monthlyBudget: Math.max(
          0,
          category.monthlyBudget -
            HEALTH_BUDGET_FROM_OPTIONAL -
            AMAZON_BUDGET_FROM_OPTIONAL,
        ),
        assumptionSource:
          'SeedData.spending.optionalMonthly less inferred health and Amazon unknown allocations',
      });
      categories.push({
        id: 'amazon_uncategorized',
        name: 'Amazon unknown',
        kind: 'other',
        monthlyBudget: AMAZON_BUDGET_FROM_OPTIONAL,
        basis: 'inferred',
        assumptionSource:
          'Temporary Amazon budget until item-level order data arrives',
      });
      categories.push({
        id: 'health',
        name: 'Health',
        kind: 'health',
        monthlyBudget: HEALTH_BUDGET_FROM_OPTIONAL,
        basis: 'inferred',
        assumptionSource:
          'Demo split from optional spending until real category rules land',
      });
      return;
    }
    categories.push(category);
  });

  categories.push({
    id: 'family_transfers',
    name: 'Family transfers',
    kind: 'other',
    monthlyBudget: 0,
    basis: 'inferred',
    assumptionSource:
      'SoFi P2P/Zelle outflows; budget target pending household review',
  });

  categories.push({
    id: 'ignored',
    name: 'Ignored',
    kind: 'ignore',
    monthlyBudget: 0,
    basis: 'manual',
    includeInBudget: false,
    assumptionSource: 'Transactions marked outside household spend',
  });

  return {
    ...basePlan,
    categories,
    assumptionSource:
      'Retirement seed budget with demo health and ignored operating buckets',
  };
}

function demoTransaction(input: {
  id: string;
  month: string;
  day: number;
  merchant: string;
  amount: number;
  categoryId: string;
  source: SpendingLedgerSourceKind;
  ignored?: boolean;
  description?: string;
  linkedTransactionIds?: string[];
}): SpendingTransaction {
  const postedDate = dateForMonthDay(input.month, input.day);
  return {
    id: `demo-${input.month}-${input.id}`,
    postedDate,
    transactionDate: postedDate,
    merchant: input.merchant,
    description: input.description,
    amount: input.amount,
    currency: 'USD',
    categoryId: input.categoryId,
    categoryConfidence: 1,
    classificationMethod: input.ignored ? 'manual' : 'rule',
    ignored: input.ignored,
    tags: input.ignored ? ['ignored'] : [],
    linkedTransactionIds: input.linkedTransactionIds,
    source: {
      source: input.source,
      sourceId: `${input.source}:${input.id}`,
      parserVersion: 'demo-ledger-v1',
      receivedAtIso: `${postedDate}T12:00:00-05:00`,
      confidence: 1,
    },
  };
}

function buildDemoTransactions(month: string, asOfDay: number): SpendingTransaction[] {
  const day = (value: number) => Math.min(Math.max(1, asOfDay), value);
  return [
    demoTransaction({
      id: 'grocery-1',
      month,
      day: day(2),
      merchant: 'H-E-B',
      amount: 382.47,
      categoryId: 'essential',
      source: 'credit_card_email',
    }),
    demoTransaction({
      id: 'utilities-1',
      month,
      day: day(4),
      merchant: 'Austin Energy',
      amount: 216.12,
      categoryId: 'essential',
      source: 'credit_card_email',
    }),
    demoTransaction({
      id: 'amazon-household',
      month,
      day: day(5),
      merchant: 'Amazon',
      amount: 184.39,
      categoryId: 'amazon_uncategorized',
      source: 'amazon_order_email',
      description: 'Household order',
    }),
    demoTransaction({
      id: 'dining-1',
      month,
      day: day(6),
      merchant: 'Local Restaurant',
      amount: 142.33,
      categoryId: 'optional',
      source: 'credit_card_email',
    }),
    demoTransaction({
      id: 'pharmacy-1',
      month,
      day: day(7),
      merchant: 'CVS Pharmacy',
      amount: 68.45,
      categoryId: 'health',
      source: 'credit_card_email',
    }),
    demoTransaction({
      id: 'travel-1',
      month,
      day: day(7),
      merchant: 'Southwest',
      amount: 310.12,
      categoryId: 'travel',
      source: 'credit_card_email',
    }),
    demoTransaction({
      id: 'amazon-refund-1',
      month,
      day: day(8),
      merchant: 'Amazon',
      amount: -42.18,
      categoryId: 'amazon_uncategorized',
      source: 'amazon_refund_email',
      description: 'Returned item credit',
      linkedTransactionIds: [`demo-${month}-amazon-household`],
    }),
    demoTransaction({
      id: 'transfer-1',
      month,
      day: day(8),
      merchant: 'Payment Transfer',
      amount: 124.92,
      categoryId: 'ignored',
      source: 'home_assistant',
      ignored: true,
      description: 'Marked outside budget',
    }),
  ];
}

interface LocalSpendingLedgerPayload {
  importedAtIso?: string;
  source?: {
    kind?: string;
    files?: Array<{
      fileName: string;
      rowCount?: number;
      transactionCount?: number;
      issueCount?: number;
    }>;
  };
  transactions?: SpendingTransaction[];
  issues?: unknown[];
  summary?: {
    transactionCount?: number;
    amazonTransactionCount?: number;
    ignoredCount?: number;
  };
}

function progressWidth(value: number): string {
  return `${Math.min(100, Math.max(0, value)).toFixed(2)}%`;
}

function transactionMonth(transaction: SpendingTransaction): string {
  return transaction.postedDate.slice(0, 7);
}

function amountDedupKey(transaction: SpendingTransaction): string {
  return [
    transaction.postedDate,
    Math.sign(transaction.amount),
    Math.abs(transaction.amount).toFixed(2),
  ].join('|');
}

function isCsvCardTransaction(transaction: SpendingTransaction): boolean {
  return transaction.source?.source === 'credit_card_csv';
}

function isLiveEmailTransaction(transaction: SpendingTransaction): boolean {
  return (
    transaction.source?.source === 'credit_card_email' ||
    transaction.source?.source === 'amazon_order_email' ||
    transaction.source?.source === 'amazon_refund_email' ||
    transaction.source?.source === 'refund_email'
  );
}

function dedupeOverlappingLiveFeedTransactions(
  transactions: SpendingTransaction[],
): SpendingTransaction[] {
  const cardCsvTransactions = transactions
    .filter(isCsvCardTransaction)
    .filter((transaction) => !transaction.ignored);
  const latestCardCsvDate = cardCsvTransactions
    .map((transaction) => transaction.postedDate)
    .sort()
    .at(-1);
  const cardCsvKeys = new Set(cardCsvTransactions.map(amountDedupKey));
  const byId = new Map<string, SpendingTransaction>();

  transactions.forEach((transaction) => {
    if (
      isLiveEmailTransaction(transaction) &&
      latestCardCsvDate &&
      transaction.postedDate <= latestCardCsvDate
    ) {
      return;
    }
    if (
      isLiveEmailTransaction(transaction) &&
      cardCsvKeys.has(amountDedupKey(transaction))
    ) {
      return;
    }
    if (!byId.has(transaction.id)) {
      byId.set(transaction.id, transaction);
    }
  });

  return Array.from(byId.values());
}

function sourceLabel(transaction: SpendingTransaction): string {
  const source = transaction.source?.source ?? 'unknown';
  if (source === 'credit_card_csv') return 'card CSV';
  if (source === 'bank_csv') return 'bank CSV';
  if (source === 'credit_card_email') return 'card email';
  if (source === 'amazon_order_email') return 'Amazon email';
  if (source === 'amazon_refund_email') return 'Amazon refund';
  return source.replaceAll('_', ' ');
}

function formatSignedAmount(value: number): string {
  if (value < 0) return `-${formatCurrency(Math.abs(value))}`;
  return formatCurrency(value);
}

function StatusPill({ status }: { status: SpendingPaceStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function CategoryRow({
  category,
  expanded,
  transactions,
  categoryOptions,
  onToggle,
  onMoveTransaction,
}: {
  category: SpendingCategorySummary;
  expanded: boolean;
  transactions: SpendingTransaction[];
  categoryOptions: SpendingBudgetCategory[];
  onToggle: () => void;
  onMoveTransaction: (transactionId: string, categoryId: string) => void;
}) {
  const spendPercent =
    category.budget > 0 ? Math.min(100, (category.netSpend / category.budget) * 100) : 0;

  return (
    <div className="border-t border-stone-200 py-4 first:border-t-0">
      <div className="grid gap-3 md:grid-cols-[1fr_110px_110px_120px_88px] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-stone-900">{category.name}</p>
            <StatusPill status={category.status} />
          </div>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            {CATEGORY_HELP[category.categoryId] ?? 'Imported transactions in this bucket.'}
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200">
            <div
              className="h-full rounded-full bg-[#0071E3]"
              style={{ width: progressWidth(spendPercent) }}
            />
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-stone-400">Spent</p>
          <p className="font-semibold text-stone-900">{formatCurrency(category.netSpend)}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-stone-400">Budget</p>
          <p className="font-semibold text-stone-900">{formatCurrency(category.budget)}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-stone-400">Projected</p>
          <p className="font-semibold text-stone-900">
            {formatCurrency(category.projectedMonthEnd)}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="rounded-full border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-700 hover:border-blue-300 hover:text-blue-700"
        >
          {expanded ? 'Hide' : 'Details'}
        </button>
      </div>

      {expanded ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
          {transactions.length ? (
            <div className="max-h-[360px] overflow-auto">
              <table className="min-w-full divide-y divide-stone-200 text-sm">
                <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase text-stone-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Date</th>
                    <th className="px-3 py-2 font-semibold">Merchant</th>
                    <th className="px-3 py-2 text-right font-semibold">Amount</th>
                    <th className="px-3 py-2 font-semibold">Evidence</th>
                    <th className="px-3 py-2 font-semibold">Bucket</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {transactions.map((transaction) => (
                    <tr key={transaction.id} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2 text-stone-600">
                        {transaction.postedDate}
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium text-stone-900">{transaction.merchant}</p>
                        <p className="mt-0.5 text-xs text-stone-500">
                          {transaction.description ?? transaction.source?.sourceId ?? transaction.id}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-stone-900">
                        {formatSignedAmount(transaction.amount)}
                      </td>
                      <td className="px-3 py-2 text-xs leading-5 text-stone-500">
                        <p>{sourceLabel(transaction)}</p>
                        <p>
                          {transaction.classificationMethod ?? 'uncategorized'}
                          {transaction.categoryConfidence !== undefined
                            ? ` · ${(transaction.categoryConfidence * 100).toFixed(0)}%`
                            : ''}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={transaction.categoryId ?? 'uncategorized'}
                          onChange={(event) =>
                            onMoveTransaction(transaction.id, event.target.value)
                          }
                          className="w-full min-w-[150px] rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                        >
                          {categoryOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                          <option value="uncategorized">Uncategorized</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-4 text-sm text-stone-500">
              No transactions landed in this bucket for the current month.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SpendingScreen({
  annualCoreSpend,
  annualStretchSpend,
  retirementDate,
}: {
  annualCoreSpend: number;
  annualStretchSpend: number;
  retirementDate: string;
}) {
  const data = useAppStore((state) => state.data);
  const now = useMemo(() => new Date(), []);
  const month = localMonthKey(now);
  const asOfIso = now.toISOString();
  const [localLedgers, setLocalLedgers] = useState<LocalSpendingLedgerPayload[]>([]);
  const [localLedgerStatus, setLocalLedgerStatus] = useState<
    'loading' | 'loaded' | 'missing' | 'error'
  >('loading');
  const [categoryOverrides, setCategoryOverrides] =
    useState<SpendingTransactionOverrideMap>({});
  const [expandedCategoryId, setExpandedCategoryId] = useState<string | null>(
    'amazon_uncategorized',
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      LOCAL_SPENDING_LEDGER_URLS.map((url) =>
        fetch(url, { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) {
              return null;
            }
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
        setLocalLedgerStatus(ledgers.length ? 'loaded' : 'missing');
      })
      .catch(() => {
        if (cancelled) return;
        setLocalLedgers([]);
        setLocalLedgerStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    setCategoryOverrides(readSpendingTransactionOverrides(window.localStorage));
  }, []);

  const budgetPlan = useMemo(
    () =>
      enhanceBudgetPlanWithOperatingBuckets(
        buildRetirementSpendingBudgetPlan(data.spending, {
          month,
          createdAtIso: asOfIso,
        }),
      ),
    [asOfIso, data.spending, month],
  );
  const rawTransactions = useMemo(() => {
    const loadedTransactions = localLedgers.flatMap(
      (ledger) => ledger.transactions ?? [],
    );
    return loadedTransactions.length
      ? dedupeOverlappingLiveFeedTransactions(loadedTransactions)
      : buildDemoTransactions(month, now.getDate());
  }, [localLedgers, month, now]);
  const transactions = useMemo(
    () => applySpendingTransactionOverrides(rawTransactions, categoryOverrides),
    [categoryOverrides, rawTransactions],
  );
  const summary = useMemo(() => {
    return buildSpendingMonthSummary({
      budgetPlan,
      transactions,
      month,
      asOfIso,
    });
  }, [asOfIso, budgetPlan, month, transactions]);
  const homeAssistantPayload = useMemo(
    () => buildHomeAssistantMonthlyBudgetPayload(summary),
    [summary],
  );
  const categoryOptions = useMemo(
    () => budgetPlan.categories.filter((category) => category.id !== 'uncategorized'),
    [budgetPlan.categories],
  );
  const monthlyTransactionsByCategory = useMemo(() => {
    const buckets = new Map<string, SpendingTransaction[]>();
    transactions
      .filter((transaction) => transactionMonth(transaction) === month)
      .forEach((transaction) => {
        const categoryId = transaction.categoryId ?? 'uncategorized';
        const existing = buckets.get(categoryId) ?? [];
        existing.push(transaction);
        buckets.set(categoryId, existing);
      });
    return buckets;
  }, [month, transactions]);

  const moveTransaction = (transactionId: string, categoryId: string) => {
    setCategoryOverrides((current) => {
      const next = {
        ...current,
        [transactionId]: buildSpendingTransactionOverride({
          transactionId,
          categoryId,
        }),
      };
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          writeSpendingTransactionOverrides(window.localStorage, next);
        } catch {
          // localStorage is a convenience layer; the in-memory override still applies.
        }
      }
      return next;
    });
  };

  const modelCompletenessText =
    summary.modelCompleteness.indicator === 'faithful'
      ? 'Faithful'
      : 'Reconstructed';
  const dataSourceText =
    localLedgerStatus === 'loaded'
      ? localLedgers.some((ledger) => ledger.source?.kind === 'gmail_imap')
        ? 'CSV + Gmail'
        : localLedgers.length === 1
          ? 'CSV backfill'
          : 'CSV backfills'
      : localLedgerStatus === 'loading'
        ? 'Checking local ledger'
        : 'Demo ledger';
  const loadedTransactionCount = localLedgers.reduce(
    (total, ledger) => total + (ledger.transactions?.length ?? 0),
    0,
  );
  const suppressedTransactionCount =
    loadedTransactionCount > 0 ? loadedTransactionCount - rawTransactions.length : 0;
  const importedAtIso = localLedgers
    .map((ledger) => ledger.importedAtIso)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const importedAtLabel = importedAtIso
    ? new Date(importedAtIso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;
  const currentMonthLabel = now.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  const asOfLabel = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });

  return (
    <Panel
      title="Spending"
      subtitle="Current-month pace, category drift, refunds, ignored transactions, and the bridge from household spending into the retirement model."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Spent MTD" value={formatCurrency(summary.netSpend)} />
        <MetricTile
          label="Expected by today"
          value={formatCurrency(summary.expectedByToday)}
        />
        <MetricTile
          label="Projected month-end"
          value={formatCurrency(summary.projectedMonthEnd)}
        />
        <MetricTile label="Data source" value={dataSourceText} />
      </div>

      <section className="mt-6 rounded-[28px] bg-stone-100/85 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-stone-500">{currentMonthLabel}</p>
            <h3 className="mt-1 text-2xl font-semibold text-stone-900">
              {formatCurrency(homeAssistantPayload.spent)} of{' '}
              {formatCurrency(homeAssistantPayload.monthlyBudget)}
            </h3>
            <p className="mt-2 text-sm text-stone-600">
              {homeAssistantPayload.percentSpent.toFixed(1)}% spent,{' '}
              {homeAssistantPayload.percentMonthElapsed.toFixed(1)}% of month elapsed.{' '}
              {modelCompletenessText}.
            </p>
          </div>
          <StatusPill status={summary.status} />
        </div>

        <div className="mt-6">
          <div className="relative h-4 overflow-visible rounded-full bg-white shadow-inner">
            <div
              className="absolute left-0 top-0 h-4 rounded-full bg-[#0071E3]"
              style={{ width: progressWidth(homeAssistantPayload.percentSpent) }}
            />
            <div
              className="absolute top-[-6px] h-7 w-0.5 rounded-full bg-stone-900"
              style={{ left: progressWidth(homeAssistantPayload.percentMonthElapsed) }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-xs font-medium text-stone-500">
            <span>{formatCurrency(0)}</span>
            <span>Today: {asOfLabel}</span>
            <span>{formatCurrency(summary.monthlyBudget)}</span>
          </div>
        </div>
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-[28px] bg-stone-100/85 p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold text-stone-900">Buckets</h3>
            <p className="text-sm text-stone-500">
              Refunds {formatCurrency(summary.refunds)} · Ignored{' '}
              {formatCurrency(summary.ignoredSpend)}
            </p>
          </div>
          <div>
            {summary.categories.map((category) => (
              <CategoryRow
                key={category.categoryId}
                category={category}
                expanded={expandedCategoryId === category.categoryId}
                transactions={monthlyTransactionsByCategory.get(category.categoryId) ?? []}
                categoryOptions={categoryOptions}
                onToggle={() =>
                  setExpandedCategoryId((current) =>
                    current === category.categoryId ? null : category.categoryId,
                  )
                }
                onMoveTransaction={moveTransaction}
              />
            ))}
          </div>
        </section>

        <section className="rounded-[28px] bg-stone-100/85 p-5">
          <h3 className="text-xl font-semibold text-stone-900">Retirenment Link</h3>
          <div className="mt-4 grid gap-3">
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">Core seed</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(annualCoreSpend)}/yr
              </p>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">Stretch seed</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(annualStretchSpend)}/yr
              </p>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">Travel phase</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                Begins {formatDate(retirementDate)}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            <p className="font-semibold">Reconstructed month</p>
            <p className="mt-1">
              {localLedgerStatus === 'loaded'
                ? `Loaded ${rawTransactions.length} local transactions${importedAtLabel ? ` at ${importedAtLabel}` : ''}${suppressedTransactionCount ? `; suppressed ${suppressedTransactionCount} overlapping email items` : ''}.`
                : 'Demo transactions are standing in for the Mac mini ledger.'}{' '}
              First inferred item:{' '}
              {summary.modelCompleteness.inferredAssumptions[0] ?? 'none'}.
            </p>
            {localLedgers.some((ledger) => ledger.source?.files?.length) ? (
              <p className="mt-2 text-xs text-amber-900">
                Source files:{' '}
                {localLedgers
                  .flatMap((ledger) => ledger.source?.files ?? [])
                  .map((file) => file.fileName)
                  .join(', ')}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </Panel>
  );
}
