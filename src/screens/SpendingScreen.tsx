import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applySpendingMerchantCategoryRules,
  applySpendingTransactionOverrides,
  buildSpendingMerchantCategoryRule,
  buildSpendingTransactionOverride,
  readSpendingMerchantCategoryRules,
  readSpendingTransactionOverrides,
  writeSpendingMerchantCategoryRules,
  writeSpendingTransactionOverrides,
  type SpendingMerchantCategoryRuleMap,
  type SpendingTransactionOverrideMap,
} from '../spending-overrides';
import {
  buildRetirementSpendingBudgetPlan,
  buildSpendingMonthSummary,
  daysInMonthKey,
  spendingTransactionMonthKey,
  type SpendingBudgetCategory,
  type SpendingBudgetPlan,
  type SpendingCategorySummary,
  type SpendingLedgerSourceKind,
  type SpendingPaceStatus,
  type SpendingTransaction,
} from '../spending-ledger';
import { dedupeOverlappingLiveFeedTransactions } from '../spending-live-feed-dedupe';
import { useAppStore } from '../store';
import { Panel } from '../ui-primitives';
import { formatCurrency, formatDate } from '../utils';
import { applyAnnualSpendTargetToOptionalSpending } from '../policy-adoption';
import { useClusterSession } from '../useClusterSession';
import { useRecommendedPolicy } from '../use-recommended-policy';
import { initialSeedData } from '../data';

const HEALTH_BUDGET_FROM_OPTIONAL = 650;
const AMAZON_UNKNOWN_CATEGORY_ID = 'amazon_uncategorized';
const AMAZON_REQUIRED_SHARE = 0.3;
const LONG_TERM_ITEMS_CATEGORY_ID = 'long_term_items';
const GENEROSITY_CATEGORY_ID = 'generosity';
const LARGE_TRANSACTION_THRESHOLD = 1_000;
const YEARLY_SPENDING_CATEGORY_IDS = new Set(['travel', 'taxes_insurance']);
const amazonEvidenceCurrencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const LOCAL_SPENDING_LEDGER_URLS = [
  '/local/spending-ledger.chase4582.json',
  '/local/spending-ledger.amex.json',
  '/local/spending-ledger.sofi.json',
  '/local/spending-ledger.gmail.json',
] as const;
const AMAZON_ALIGNMENT_URL = '/local/spending-amazon-card-email-alignment.json';

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
    'Required monthly spend: groceries, utilities, transportation basics, recurring bills, and other ordinary household necessities.',
  optional:
    'Flexible lifestyle spend: dining, entertainment, home goods, personal purchases, and other card charges that can move if needed.',
  amazon_uncategorized:
    'Amazon card charges are automatically allocated 30% required monthly and 70% optional for budget tracking.',
  health:
    'Medical, pharmacy, healthcare systems, and wellness transactions.',
  travel:
    'Yearly travel budget: airlines, lodging, travel agencies, rides, and other trip-related transactions. Tracked against the annual plan instead of monthly operating pace.',
  taxes_insurance:
    'Required yearly spend: annual or semiannual insurance, tax, and large required checks tracked against the yearly budget instead of ordinary monthly pace.',
  long_term_items:
    'Long-term capital items: paint, AC, roof, and other big household projects tracked outside monthly and yearly operating budgets.',
  generosity:
    'Giving, gifts, donations, and intentional help for other people. Counts as spending unless you later move it outside budget.',
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
    const displayCategory =
      category.id === 'essential'
        ? {
            ...category,
            name: 'Required monthly',
            assumptionSource:
              'SeedData.spending.essentialMonthly; displayed as monthly required spend',
          }
        : category.id === 'taxes_insurance'
          ? {
              ...category,
              name: 'Required yearly',
              assumptionSource:
                'SeedData.spending.annualTaxesInsurance / 12; displayed as yearly required spend',
            }
          : category;

    if (category.id === 'optional') {
      categories.push({
        ...displayCategory,
        monthlyBudget: Math.max(
          0,
          category.monthlyBudget -
            HEALTH_BUDGET_FROM_OPTIONAL,
        ),
        assumptionSource:
          'SeedData.spending.optionalMonthly less inferred health allocation; Amazon card charges use a 30/70 required/optional split',
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
    categories.push(displayCategory);
  });

  categories.push({
    id: GENEROSITY_CATEGORY_ID,
    name: 'Generosity',
    kind: 'other',
    monthlyBudget: 0,
    basis: 'manual',
    assumptionSource:
      'Manual bucket for giving, gifts, donations, and intentional support',
  });

  categories.push({
    id: LONG_TERM_ITEMS_CATEGORY_ID,
    name: 'Long-term items',
    kind: 'other',
    monthlyBudget: 0,
    basis: 'manual',
    includeInBudget: false,
    assumptionSource:
      'Manual capital item bucket excluded from monthly and yearly operating budgets',
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
  fetchedAtIso?: string;
  account?: string;
  mailbox?: string;
  source?: {
    kind?: string;
    accountId?: string;
    lastSyncedUid?: number;
    files?: Array<{
      fileName: string;
      rowCount?: number;
      transactionCount?: number;
      issueCount?: number;
    }>;
  };
  transactions?: SpendingTransaction[];
  issues?: Array<{
    uid?: number;
    code?: string;
    message?: string;
  }>;
  summary?: {
    transactionCount?: number;
    amazonTransactionCount?: number;
    ignoredCount?: number;
    issueCount?: number;
    lastSyncedUid?: number;
  };
}

interface AmazonEmailAlignmentMatch {
  cardTransactionId: string;
  emailTransactionId: string;
  confidence: number;
  dateDeltaDays: number;
  notes?: string[];
  email: {
    postedDate: string;
    amount: number;
    source?: string;
    subject?: string;
  };
  order?: {
    orderId?: string;
    items?: string[];
    itemDetails?: Array<{
      name: string;
      quantity?: number;
      price?: number;
    }>;
    emailKinds?: string[];
    subjects?: string[];
    orderedAmount?: number;
    shippedAmount?: number;
    primaryAmount?: number;
    itemSubtotal?: number;
    evidenceEmailCount?: number;
  };
}

interface AmazonEmailAlignmentPayload {
  generatedAtIso?: string;
  summary?: {
    matchedCount?: number;
    cardTransactionCount?: number;
    unmatchedCardCount?: number;
  };
  matches?: AmazonEmailAlignmentMatch[];
}

interface AmazonBucketSuggestion {
  transaction: SpendingTransaction;
  evidence: AmazonEmailAlignmentMatch | undefined;
  suggestedCategoryId: string;
  suggestedCategoryName: string;
  confidence: number;
  reason: string;
  review: boolean;
}

interface SpendingProgressSnapshot {
  label: string;
  spent: number;
  budget: number;
  expected: number;
  projected: number;
  percentSpent: number;
  percentElapsed: number;
  status: SpendingPaceStatus;
  markerLabel: string;
  projectionLabel: string;
  bucketBreakdown: SpendingBucketBreakdown[];
  barSegments?: SpendingProgressSegment[];
  amazonHoldingPen?: SpendingAmazonHoldingPen;
}

interface SpendingProgressSegment {
  categoryId: string;
  name: string;
  value: number;
  color: string;
}

interface SpendingBucketBreakdown {
  categoryId: string;
  name: string;
  spent: number;
  budget: number;
  percentSpent: number;
  status: SpendingPaceStatus;
  purchaseGroups: SpendingPurchaseGroup[];
}

interface SpendingPurchaseGroup {
  label: string;
  total: number;
  count: number;
  latestDate: string;
  sampleDescription?: string;
}

interface SpendingAmazonHoldingPen {
  total: number;
  matched: number;
  unmatched: number;
  totalCount: number;
  matchedCount: number;
  unmatchedCount: number;
}

interface HistoricalSpendingCategoryComparison {
  categoryId: string;
  name: string;
  modeledMonthlyBudget: number;
  historicalMonthlyAverage: number;
  deltaMonthly: number;
  percentOfModeled: number;
}

interface HistoricalSpendingComparison {
  monthCount: number;
  firstMonth: string | null;
  lastMonth: string | null;
  modeledMonthlyBudget: number;
  modeledAnnualBudget: number;
  historicalMonthlyAverage: number;
  historicalAnnualized: number;
  deltaMonthly: number;
  deltaAnnual: number;
  percentOfModeled: number;
  refundMonthlyAverage: number;
  categories: HistoricalSpendingCategoryComparison[];
}

interface SpendingCategoryApplyOptions {
  applyToMerchant?: boolean;
  title?: string;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function progressWidth(value: number): string {
  return `${Math.min(100, Math.max(0, value)).toFixed(2)}%`;
}

function transactionMonth(transaction: SpendingTransaction): string {
  return spendingTransactionMonthKey(transaction);
}

function isYearlySpendingCategoryId(categoryId: string): boolean {
  return YEARLY_SPENDING_CATEGORY_IDS.has(categoryId);
}

function monthlyOperatingBudgetFromPlan(budgetPlan: SpendingBudgetPlan): number {
  return roundMoney(
    budgetPlan.categories
      .filter(
        (category) =>
          !isYearlySpendingCategoryId(category.id) &&
          category.kind !== 'ignore' &&
          category.includeInBudget !== false,
      )
      .reduce((total, category) => total + category.monthlyBudget, 0),
  );
}

function monthlyOperatingSpendFromCategories(
  categories: SpendingCategorySummary[],
): number {
  return roundMoney(
    categories
      .filter(
        (category) =>
          !isYearlySpendingCategoryId(category.categoryId) &&
          category.kind !== 'ignore' &&
          category.categoryId !== 'ignored',
      )
      .reduce((total, category) => total + category.spent, 0),
  );
}

function annualEscrowBudgetFromPlan(budgetPlan: SpendingBudgetPlan): number {
  return roundMoney(
    budgetPlan.categories
      .filter((category) => isYearlySpendingCategoryId(category.id))
      .reduce((total, category) => total + category.monthlyBudget * 12, 0),
  );
}

function annualTargetFromPlan(budgetPlan: SpendingBudgetPlan): number {
  return roundMoney(budgetPlan.monthlyBudget * 12);
}

function annualEscrowSpendFromCategories(
  categories: SpendingCategorySummary[],
): number {
  return roundMoney(
    categories
      .filter(
        (category) =>
          isYearlySpendingCategoryId(category.categoryId) &&
          category.kind !== 'ignore' &&
          category.categoryId !== 'ignored' &&
          category.categoryId !== AMAZON_UNKNOWN_CATEGORY_ID,
      )
      .reduce((total, category) => total + category.spent, 0),
  );
}

function spendingStatusFromProjection(input: {
  netSpend: number;
  budget: number;
  expected: number;
  projected: number;
}): SpendingPaceStatus {
  if (input.budget <= 0) {
    return input.netSpend > 0 ? 'unbudgeted' : 'on_track';
  }
  if (input.projected > input.budget * 1.1) return 'over';
  if (input.projected > input.budget * 1.03) return 'watch';
  if (input.netSpend < input.expected * 0.85) return 'under';
  return 'on_track';
}

function monthKeysThrough(date: Date): string[] {
  const year = date.getFullYear();
  return Array.from({ length: date.getMonth() + 1 }, (_, index) =>
    `${year}-${String(index + 1).padStart(2, '0')}`,
  );
}

function monthKeyIndex(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number);
  return year * 12 + month;
}

function compareMonthKeys(left: string, right: string): number {
  return monthKeyIndex(left) - monthKeyIndex(right);
}

function historicalMonthAsOfIso(monthKey: string): string {
  return `${monthKey}-${String(daysInMonthKey(monthKey)).padStart(2, '0')}T12:00:00-05:00`;
}

function formatMonthRange(firstMonth: string | null, lastMonth: string | null): string {
  if (!firstMonth || !lastMonth) return 'No closed ledger months yet';
  const format = (monthKey: string) => {
    const [year, month] = monthKey.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
  };
  return firstMonth === lastMonth
    ? format(firstMonth)
    : `${format(firstMonth)} - ${format(lastMonth)}`;
}

function annualEscrowStatus(spent: number, budget: number): SpendingPaceStatus {
  if (budget <= 0) return spent > 0 ? 'unbudgeted' : 'on_track';
  if (spent > budget * 1.1) return 'over';
  if (spent > budget) return 'watch';
  return 'on_track';
}

function annualEscrowLabel(spent: number, budget: number): string {
  const delta = roundMoney(budget - spent);
  if (Math.abs(delta) < 1) return 'Annual escrow exactly used';
  if (delta < 0) return `Over annual escrow by ${formatCurrency(Math.abs(delta))}`;
  return `${formatCurrency(delta)} remaining in annual escrow`;
}

function adaptiveAnnualEscrowBuckets(
  buckets: SpendingBucketBreakdown[],
): SpendingBucketBreakdown[] {
  return buckets.map((bucket) => {
    const budget = Math.max(bucket.budget, bucket.spent);
    return {
      ...bucket,
      budget,
      percentSpent: budget > 0 ? (bucket.spent / budget) * 100 : 0,
      status: annualEscrowStatus(bucket.spent, budget),
    };
  });
}

function adaptiveAnnualEscrowBudgetFromBuckets(
  buckets: SpendingBucketBreakdown[],
): number {
  return roundMoney(
    buckets.reduce((total, bucket) => total + Math.max(bucket.budget, bucket.spent), 0),
  );
}

function monthlyOperatingBudgetAfterAnnualEscrow(input: {
  budgetPlan: SpendingBudgetPlan;
  annualEscrowBudget: number;
}): number {
  const annualOperatingBudget = annualTargetFromPlan(input.budgetPlan) - input.annualEscrowBudget;
  return roundMoney(Math.max(0, annualOperatingBudget / 12));
}

function compactMerchantName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function purchaseGroupFamily(transaction: SpendingTransaction): { key: string; label: string } {
  if (transaction.displayTitle) {
    return {
      key: `title:${transaction.displayTitle.trim().toLowerCase()}`,
      label: transaction.displayTitle,
    };
  }

  const merchant = compactMerchantName(transaction.merchant);
  const evidenceText = [
    transaction.merchant,
    transaction.description,
    transaction.source?.sourceId,
    transaction.rawEvidence ? JSON.stringify(transaction.rawEvidence) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const familyRules: Array<{ key: string; label: string; pattern: RegExp }> = [
    { key: 'amazon', label: 'Amazon', pattern: /\b(amazon|amzn|mktplace)\b|amazon\.com/ },
    { key: 'heb', label: 'H-E-B', pattern: /\b(h-?e-?b|heb)\b/ },
    { key: 'state_farm', label: 'State Farm', pattern: /\bstate farm\b/ },
    { key: 'apple', label: 'Apple', pattern: /\bapple(?:\.com| store| services)?\b/ },
    { key: 'costco', label: 'Costco', pattern: /\bcostco\b/ },
    { key: 'walmart', label: 'Walmart', pattern: /\bwalmart\b/ },
    { key: 'target', label: 'Target', pattern: /\btarget\b/ },
    { key: 'home_depot', label: 'Home Depot', pattern: /\bhome depot\b/ },
    { key: 'lowes', label: "Lowe's", pattern: /\blowe'?s\b/ },
    { key: 'southwest', label: 'Southwest', pattern: /\bsouthwest\b/ },
    { key: 'uber', label: 'Uber', pattern: /\buber\b/ },
    { key: 'lyft', label: 'Lyft', pattern: /\blyft\b/ },
  ];

  const matchedFamily = familyRules.find((rule) => rule.pattern.test(evidenceText));
  if (matchedFamily) return { key: matchedFamily.key, label: matchedFamily.label };

  const fallbackLabel = merchant || 'Unknown merchant';
  return {
    key: fallbackLabel.toLowerCase(),
    label: fallbackLabel,
  };
}

function transactionDisplayTitle(transaction: SpendingTransaction): string {
  return transaction.displayTitle ?? transaction.merchant;
}

function spendingBucketColor(categoryId: string): string {
  const colors: Record<string, string> = {
    essential: '#0071E3',
    optional: '#2563EB',
    health: '#0891B2',
    travel: '#38BDF8',
    taxes_insurance: '#1D4ED8',
    long_term_items: '#64748B',
    generosity: '#0EA5E9',
    family_transfers: '#0284C7',
    uncategorized: '#94A3B8',
  };
  return colors[categoryId] ?? '#475569';
}

function annualEscrowBucketName(category: SpendingBudgetCategory): string {
  if (category.id === 'travel') return 'Travel yearly';
  if (category.id === 'taxes_insurance') return 'Required yearly';
  return category.name;
}

function topPurchaseGroupsByCategory(
  transactions: SpendingTransaction[],
  limit = 5,
): Map<string, SpendingPurchaseGroup[]> {
  const groupsByCategory = new Map<
    string,
    Map<string, SpendingPurchaseGroup>
  >();

  transactions.forEach((transaction) => {
    const categoryId = transaction.categoryId ?? 'uncategorized';
    if (
      transaction.amount <= 0 ||
      transaction.ignored === true ||
      categoryId === 'ignored' ||
      categoryId === AMAZON_UNKNOWN_CATEGORY_ID
    ) {
      return;
    }

    const groups = groupsByCategory.get(categoryId) ?? new Map<string, SpendingPurchaseGroup>();
    const family = purchaseGroupFamily(transaction);
    const key = family.key;
    const existing = groups.get(key);
    if (existing) {
      existing.total = roundMoney(existing.total + transaction.amount);
      existing.count += 1;
      if (transaction.postedDate > existing.latestDate) {
        existing.latestDate = transaction.postedDate;
        existing.sampleDescription = transaction.description;
      }
    } else {
      groups.set(key, {
        label: family.label,
        total: roundMoney(transaction.amount),
        count: 1,
        latestDate: transaction.postedDate,
        sampleDescription: transaction.description,
      });
    }
    groupsByCategory.set(categoryId, groups);
  });

  return new Map(
    Array.from(groupsByCategory.entries()).map(([categoryId, groups]) => [
      categoryId,
      Array.from(groups.values())
        .sort((left, right) => {
          if (right.total !== left.total) return right.total - left.total;
          return right.latestDate.localeCompare(left.latestDate);
        })
        .slice(0, limit),
    ]),
  );
}

function bucketBreakdownFromCategorySummaries(
  categories: SpendingCategorySummary[],
  purchaseGroupsByCategory: Map<string, SpendingPurchaseGroup[]> = new Map(),
): SpendingBucketBreakdown[] {
  return categories
    .filter(
      (category) =>
        category.kind !== 'ignore' &&
        category.categoryId !== 'ignored' &&
        category.categoryId !== AMAZON_UNKNOWN_CATEGORY_ID &&
        !isYearlySpendingCategoryId(category.categoryId) &&
        (category.budget > 0 || Math.abs(category.spent) >= 0.01),
    )
    .map((category) => ({
      categoryId: category.categoryId,
      name: category.name,
      spent: category.spent,
      budget: category.budget,
      percentSpent: category.budget > 0 ? (category.spent / category.budget) * 100 : 0,
      purchaseGroups: purchaseGroupsByCategory.get(category.categoryId) ?? [],
      status: spendingStatusFromProjection({
        netSpend: category.spent,
        budget: category.budget,
        expected: category.expectedByToday,
        projected:
          category.budget > 0 && category.expectedByToday > 0
            ? (category.spent / (category.expectedByToday / category.budget))
            : category.spent,
      }),
    }));
}

function yearlyBucketBreakdown(input: {
  budgetPlan: SpendingBudgetPlan;
  summaries: ReturnType<typeof buildSpendingMonthSummary>[];
  transactions: SpendingTransaction[];
}): SpendingBucketBreakdown[] {
  const spentByCategoryId = new Map<string, number>();
  const purchaseGroupsByCategory = topPurchaseGroupsByCategory(input.transactions, 24);
  input.summaries.forEach((summary) => {
    summary.categories.forEach((category) => {
      spentByCategoryId.set(
        category.categoryId,
        (spentByCategoryId.get(category.categoryId) ?? 0) + category.spent,
      );
    });
  });

  return input.budgetPlan.categories
    .filter(
      (category) =>
        isYearlySpendingCategoryId(category.id) &&
        category.kind !== 'ignore' &&
        category.id !== 'ignored' &&
        category.id !== AMAZON_UNKNOWN_CATEGORY_ID,
    )
    .map((category) => {
      const spent = roundMoney(spentByCategoryId.get(category.id) ?? 0);
      const budget = roundMoney(category.monthlyBudget * 12);
      const percentSpent = budget > 0 ? (spent / budget) * 100 : 0;
      return {
        categoryId: category.id,
        name: annualEscrowBucketName(category),
        spent,
        budget,
        percentSpent,
        purchaseGroups: purchaseGroupsByCategory.get(category.id) ?? [],
        status: annualEscrowStatus(spent, budget),
      };
    })
    .filter((category) => category.budget > 0 || Math.abs(category.spent) >= 0.01);
}

function buildHistoricalSpendingComparison(input: {
  budgetPlan: SpendingBudgetPlan;
  transactions: SpendingTransaction[];
  currentMonth: string;
}): HistoricalSpendingComparison {
  const historicalMonthKeys = Array.from(
    new Set(
      input.transactions
        .map((transaction) => transactionMonth(transaction))
        .filter((monthKey) => compareMonthKeys(monthKey, input.currentMonth) < 0),
    ),
  ).sort(compareMonthKeys);

  const summaries = historicalMonthKeys
    .map((monthKey) =>
      buildSpendingMonthSummary({
        budgetPlan: input.budgetPlan,
        transactions: input.transactions,
        month: monthKey,
        asOfIso: historicalMonthAsOfIso(monthKey),
      }),
    )
    .filter((summary) => summary.includedTransactionCount > 0);

  const monthCount = summaries.length;
  const modeledMonthlyBudget = monthlyOperatingBudgetFromPlan(input.budgetPlan);
  const modeledAnnualBudget = roundMoney(modeledMonthlyBudget * 12);

  if (monthCount === 0) {
    return {
      monthCount: 0,
      firstMonth: null,
      lastMonth: null,
      modeledMonthlyBudget,
      modeledAnnualBudget,
      historicalMonthlyAverage: 0,
      historicalAnnualized: 0,
      deltaMonthly: 0,
      deltaAnnual: 0,
      percentOfModeled: 0,
      refundMonthlyAverage: 0,
      categories: [],
    };
  }

  const totalGrossSpend = roundMoney(
    summaries.reduce(
      (total, summary) => total + monthlyOperatingSpendFromCategories(summary.categories),
      0,
    ),
  );
  const totalRefunds = roundMoney(
    summaries.reduce(
      (total, summary) =>
        total +
        summary.categories
          .filter(
            (category) =>
              category.kind !== 'ignore' &&
              category.categoryId !== 'ignored' &&
              !isYearlySpendingCategoryId(category.categoryId),
          )
          .reduce((categoryTotal, category) => categoryTotal + category.refunds, 0),
      0,
    ),
  );
  const historicalMonthlyAverage = roundMoney(totalGrossSpend / monthCount);
  const historicalAnnualized = roundMoney(historicalMonthlyAverage * 12);
  const deltaMonthly = roundMoney(historicalMonthlyAverage - modeledMonthlyBudget);
  const deltaAnnual = roundMoney(historicalAnnualized - modeledAnnualBudget);

  const budgetCategoryById = new Map(
    input.budgetPlan.categories.map((category) => [category.id, category]),
  );
  const categoryOrder = new Map(
    input.budgetPlan.categories.map((category, index) => [category.id, index]),
  );
  const categorySpentById = new Map<string, number>();
  const categoryNameById = new Map<string, string>();

  summaries.forEach((summary) => {
    summary.categories.forEach((category) => {
      categoryNameById.set(category.categoryId, category.name);
      categorySpentById.set(
        category.categoryId,
        (categorySpentById.get(category.categoryId) ?? 0) + category.spent,
      );
    });
  });

  const categoryIds = Array.from(
    new Set([
      ...input.budgetPlan.categories.map((category) => category.id),
      ...Array.from(categorySpentById.keys()),
    ]),
  );

  const categories = categoryIds
    .filter((categoryId) => {
      const category = budgetCategoryById.get(categoryId);
      return (
        category?.kind !== 'ignore' &&
        categoryId !== 'ignored' &&
        categoryId !== AMAZON_UNKNOWN_CATEGORY_ID &&
        !isYearlySpendingCategoryId(categoryId)
      );
    })
    .map((categoryId) => {
      const category = budgetCategoryById.get(categoryId);
      const modeled = roundMoney(category?.monthlyBudget ?? 0);
      const historical = roundMoney((categorySpentById.get(categoryId) ?? 0) / monthCount);
      return {
        categoryId,
        name: category?.name ?? categoryNameById.get(categoryId) ?? categoryId,
        modeledMonthlyBudget: modeled,
        historicalMonthlyAverage: historical,
        deltaMonthly: roundMoney(historical - modeled),
        percentOfModeled: modeled > 0 ? (historical / modeled) * 100 : 0,
      };
    })
    .filter(
      (category) =>
        category.modeledMonthlyBudget > 0 ||
        Math.abs(category.historicalMonthlyAverage) >= 0.01,
    )
    .sort((left, right) => {
      const leftIndex = categoryOrder.get(left.categoryId) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = categoryOrder.get(right.categoryId) ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return right.historicalMonthlyAverage - left.historicalMonthlyAverage;
    });

  return {
    monthCount,
    firstMonth: summaries[0]?.month ?? null,
    lastMonth: summaries.at(-1)?.month ?? null,
    modeledMonthlyBudget,
    modeledAnnualBudget,
    historicalMonthlyAverage,
    historicalAnnualized,
    deltaMonthly,
    deltaAnnual,
    percentOfModeled:
      modeledMonthlyBudget > 0
        ? (historicalMonthlyAverage / modeledMonthlyBudget) * 100
        : 0,
    refundMonthlyAverage: roundMoney(totalRefunds / monthCount),
    categories,
  };
}

function amazonHoldingPenFromTransactions(input: {
  transactions: SpendingTransaction[];
  amazonEvidenceByTransactionId: Map<string, AmazonEmailAlignmentMatch>;
  includeTransaction: (transaction: SpendingTransaction) => boolean;
}): SpendingAmazonHoldingPen | undefined {
  const rows = input.transactions.filter(
    (transaction) =>
      input.includeTransaction(transaction) &&
      transaction.categoryId === AMAZON_UNKNOWN_CATEGORY_ID &&
      transaction.ignored !== true &&
      transaction.amount > 0,
  );
  if (!rows.length) return undefined;
  const matchedRows = rows.filter((transaction) =>
    input.amazonEvidenceByTransactionId.has(transaction.id),
  );
  const total = roundMoney(rows.reduce((sum, transaction) => sum + transaction.amount, 0));
  const matched = roundMoney(matchedRows.reduce((sum, transaction) => sum + transaction.amount, 0));
  return {
    total,
    matched,
    unmatched: roundMoney(total - matched),
    totalCount: rows.length,
    matchedCount: matchedRows.length,
    unmatchedCount: rows.length - matchedRows.length,
  };
}

function isAmazonEmailEvidenceTransaction(
  transaction: SpendingTransaction,
): boolean {
  return (
    transaction.source?.source === 'amazon_order_email' ||
    transaction.source?.source === 'amazon_refund_email'
  );
}

function isAmazonCreditCardSplitCandidate(transaction: SpendingTransaction): boolean {
  if (transaction.ignored === true) return false;
  if (transaction.amount <= 0) return false;
  if (
    transaction.classificationMethod === 'manual' &&
    transaction.categoryId !== AMAZON_UNKNOWN_CATEGORY_ID
  ) {
    return false;
  }
  const isCardCharge =
    transaction.source?.source === 'credit_card_csv' ||
    transaction.source?.source === 'credit_card_email';
  if (!isCardCharge) return false;
  if (transaction.categoryId === AMAZON_UNKNOWN_CATEGORY_ID) return true;

  const merchantText = `${transaction.merchant} ${transaction.description ?? ''}`.toLowerCase();
  const looksLikeAmazon =
    /\b(amazon|amzn|mktplace)\b/.test(merchantText) ||
    merchantText.includes('amazon.com');
  const uncategorized =
    !transaction.categoryId || transaction.categoryId === 'uncategorized';
  return looksLikeAmazon && uncategorized;
}

function splitAmazonCreditCardTransactionsForBudget(
  transactions: SpendingTransaction[],
): SpendingTransaction[] {
  return transactions.flatMap((transaction) => {
    if (!isAmazonCreditCardSplitCandidate(transaction)) return [transaction];

    const requiredAmount = roundMoney(transaction.amount * AMAZON_REQUIRED_SHARE);
    const optionalAmount = roundMoney(transaction.amount - requiredAmount);
    const splitEvidence = {
      ...(transaction.rawEvidence ?? {}),
      amazonBudgetSplit: {
        originalTransactionId: transaction.id,
        originalAmount: transaction.amount,
        requiredShare: AMAZON_REQUIRED_SHARE,
        optionalShare: 1 - AMAZON_REQUIRED_SHARE,
      },
    };
    const linkedTransactionIds = [
      transaction.id,
      ...(transaction.linkedTransactionIds ?? []),
    ];

    return [
      {
        ...transaction,
        id: `${transaction.id}:amazon-required`,
        amount: requiredAmount,
        categoryId: 'essential',
        categoryConfidence: 1,
        classificationMethod: 'inferred',
        description: `${transaction.description ?? transaction.merchant} · Amazon 30% required allocation`,
        tags: [...new Set([...(transaction.tags ?? []), 'amazon_30_70_split'])],
        linkedTransactionIds,
        rawEvidence: splitEvidence,
      },
      {
        ...transaction,
        id: `${transaction.id}:amazon-optional`,
        amount: optionalAmount,
        categoryId: 'optional',
        categoryConfidence: 1,
        classificationMethod: 'inferred',
        description: `${transaction.description ?? transaction.merchant} · Amazon 70% optional allocation`,
        tags: [...new Set([...(transaction.tags ?? []), 'amazon_30_70_split'])],
        linkedTransactionIds,
        rawEvidence: splitEvidence,
      },
    ];
  });
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

function categoryName(categories: SpendingBudgetCategory[], categoryId: string): string {
  return categories.find((category) => category.id === categoryId)?.name ?? categoryId;
}

function requiredYearlyInference(transaction: SpendingTransaction):
  | { reason: string; confidence: number }
  | undefined {
  if (transaction.ignored === true || transaction.categoryId === 'ignored') return undefined;

  const evidenceText = [
    transaction.merchant,
    transaction.description,
    transaction.source?.sourceId,
    transaction.rawEvidence ? JSON.stringify(transaction.rawEvidence) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\bstate farm\b/.test(evidenceText)) {
    return {
      reason: 'State Farm is treated as required yearly insurance.',
      confidence: 0.88,
    };
  }

  if (
    transaction.amount >= LARGE_TRANSACTION_THRESHOLD &&
    /\bcheck paid\b/.test(evidenceText)
  ) {
    return {
      reason: 'Large check payment inferred as required yearly until reviewed.',
      confidence: 0.64,
    };
  }

  return undefined;
}

function longTermItemInference(transaction: SpendingTransaction):
  | { reason: string; confidence: number }
  | undefined {
  if (transaction.ignored === true || transaction.categoryId === 'ignored') return undefined;

  const evidenceText = [
    transaction.merchant,
    transaction.description,
    transaction.source?.sourceId,
    transaction.rawEvidence ? JSON.stringify(transaction.rawEvidence) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    transaction.amount >= LARGE_TRANSACTION_THRESHOLD &&
    /\b(paint|painting|roof|roofing|hvac|air conditioning|a\/c|water heater|fence|deck)\b/.test(
      evidenceText,
    )
  ) {
    return {
      reason: 'Large household project inferred as a long-term capital item.',
      confidence: 0.72,
    };
  }

  return undefined;
}

function applySpendingCategoryInferences(
  transactions: SpendingTransaction[],
): SpendingTransaction[] {
  return transactions.map((transaction) => {
    const longTermInference = longTermItemInference(transaction);
    const yearlyInference = requiredYearlyInference(transaction);
    const inference = longTermInference
      ? {
          categoryId: LONG_TERM_ITEMS_CATEGORY_ID,
          tag: 'long_term_item_inferred',
          evidenceKey: 'longTermItemInference',
          ...longTermInference,
        }
      : yearlyInference
        ? {
            categoryId: 'taxes_insurance',
            tag: 'required_yearly_inferred',
            evidenceKey: 'requiredYearlyInference',
            ...yearlyInference,
          }
        : undefined;
    if (!inference || transaction.categoryId === inference.categoryId) return transaction;

    return {
      ...transaction,
      categoryId: inference.categoryId,
      categoryConfidence: Math.max(
        transaction.categoryConfidence ?? 0,
        inference.confidence,
      ),
      classificationMethod:
        transaction.classificationMethod === 'manual'
          ? 'manual'
          : 'inferred',
      tags: Array.from(
        new Set([...(transaction.tags ?? []), inference.tag]),
      ),
      rawEvidence: {
        ...(transaction.rawEvidence ?? {}),
        [inference.evidenceKey]: {
          previousCategoryId: transaction.categoryId,
          reason: inference.reason,
        },
      },
    };
  });
}

function formatAmazonEvidenceCurrency(value: number): string {
  return amazonEvidenceCurrencyFormatter.format(value);
}

function formatAmazonEvidenceSignedCurrency(value: number): string {
  if (value < 0) return `-${formatAmazonEvidenceCurrency(Math.abs(value))}`;
  return formatAmazonEvidenceCurrency(value);
}

function amazonEvidenceTitle(evidence: AmazonEmailAlignmentMatch | undefined): string {
  const itemDetails = evidence?.order?.itemDetails?.filter((item) => item.name) ?? [];
  if (itemDetails.length) {
    return itemDetails
      .slice(0, 3)
      .map((item) =>
        typeof item.price === 'number'
          ? `${item.name} (${formatAmazonEvidenceCurrency(item.price)})`
          : item.name,
      )
      .join('; ');
  }
  const items = evidence?.order?.items?.filter(Boolean) ?? [];
  if (items.length) return items.slice(0, 3).join('; ');
  return evidence?.email.subject ?? '';
}

function amazonEvidenceDetail(evidence: AmazonEmailAlignmentMatch | undefined): string {
  if (!evidence) return '';
  const orderedAmount = evidence.order?.orderedAmount;
  const shippedAmount = evidence.order?.shippedAmount;
  const itemSubtotal = evidence.order?.itemSubtotal;
  const hasDifferentShippedAmount =
    typeof shippedAmount === 'number' &&
    typeof orderedAmount === 'number' &&
    Math.abs(shippedAmount - orderedAmount) >= 0.01;
  const parts = [
    evidence.order?.orderId ? `Order ${evidence.order.orderId}` : undefined,
    typeof orderedAmount === 'number' ? `Card/order charge ${formatAmazonEvidenceCurrency(orderedAmount)}` : undefined,
    typeof itemSubtotal === 'number' ? `Item price ${formatAmazonEvidenceCurrency(itemSubtotal)}` : undefined,
    hasDifferentShippedAmount ? `Shipped value ${formatAmazonEvidenceCurrency(shippedAmount)}` : undefined,
    evidence.order?.emailKinds?.length ? evidence.order.emailKinds.join(', ') : undefined,
    evidence.order?.evidenceEmailCount ? `${evidence.order.evidenceEmailCount} email evidence` : undefined,
  ].filter(Boolean);
  return parts.join(' · ');
}

function suggestAmazonBucket(
  transaction: SpendingTransaction,
  evidence: AmazonEmailAlignmentMatch | undefined,
  categories: SpendingBudgetCategory[],
): AmazonBucketSuggestion | null {
  if (transaction.categoryId !== 'amazon_uncategorized') return null;
  if (transaction.source?.source !== 'credit_card_csv') return null;
  const subject = amazonEvidenceTitle(evidence) || transaction.description || transaction.merchant;
  const normalized = subject.toLowerCase();
  const amount = transaction.amount;

  if (amount < 0 || /\b(refund|return|dropoff|credit)\b/.test(normalized)) {
    return {
      transaction,
      evidence,
      suggestedCategoryId: 'amazon_uncategorized',
      suggestedCategoryName: categoryName(categories, 'amazon_uncategorized'),
      confidence: 0.92,
      reason: 'Refund or return evidence; keep against Amazon until paired with original spend.',
      review: true,
    };
  }

  const essentialPatterns = [
    { pattern: /\b(baby|gerber|food|coffee|nutrition|protein|vitamin|supplement)\b/, label: 'food or household basics' },
    { pattern: /\b(medical|health|otoscope|adhesive|patch|calibration|solution)\b/, label: 'health or medical supply' },
    { pattern: /\b(filter|cleaning|detergent|hardware|cabinet|dryer vent|poolrx|bottle covers?)\b/, label: 'home maintenance supply' },
  ];
  const optionalPatterns = [
    { pattern: /\b(women|men'?s|shoe|loafer|sandal|tank|top|dress|bra|clothing)\b/, label: 'clothing or personal item' },
    { pattern: /\b(speaker|monitor|calendar|nvme|ssd|tablet|gaming|iphone|carplay|ring)\b/, label: 'electronics or gadget' },
    { pattern: /\b(decor|spotlight|duvet|cover|hobby|trolley)\b/, label: 'home comfort or hobby item' },
  ];
  const matchedEssential = essentialPatterns.find(({ pattern }) => pattern.test(normalized));
  const matchedOptional = optionalPatterns.find(({ pattern }) => pattern.test(normalized));
  const highDollar = amount >= 250;
  const multiItem = /\bmore items?\b/.test(normalized);
  const matchConfidence = evidence?.confidence ?? 0;
  const partialOrSplitCharge =
    evidence?.notes?.includes('partial_or_split_card_charge') ||
    (typeof evidence?.order?.orderedAmount === 'number' &&
      Math.abs(evidence.order.orderedAmount - amount) >= 0.01);

  if (partialOrSplitCharge) {
    return {
      transaction,
      evidence,
      suggestedCategoryId: 'amazon_uncategorized',
      suggestedCategoryName: categoryName(categories, 'amazon_uncategorized'),
      confidence: 0.64,
      reason: `Card charge ${formatAmazonEvidenceCurrency(amount)} differs from Amazon ordered charge evidence ${formatAmazonEvidenceCurrency(
        evidence?.order?.orderedAmount ?? evidence?.email.amount ?? amount,
      )}; review before moving.`,
      review: true,
    };
  }

  if (matchedEssential && !highDollar) {
    return {
      transaction,
      evidence,
      suggestedCategoryId: 'essential',
      suggestedCategoryName: categoryName(categories, 'essential'),
      confidence: 0.86,
      reason: `Amazon evidence looks like ${matchedEssential.label}.`,
      review: false,
    };
  }

  if (matchedOptional && !highDollar) {
    return {
      transaction,
      evidence,
      suggestedCategoryId: 'optional',
      suggestedCategoryName: categoryName(categories, 'optional'),
      confidence: 0.86,
      reason: `Amazon evidence looks like ${matchedOptional.label}.`,
      review: false,
    };
  }

  if (highDollar || (multiItem && amount >= 100) || matchConfidence < 0.85) {
    return {
      transaction,
      evidence,
      suggestedCategoryId: 'amazon_uncategorized',
      suggestedCategoryName: categoryName(categories, 'amazon_uncategorized'),
      confidence: highDollar ? 0.62 : 0.68,
      reason: highDollar
        ? 'High-dollar or mixed Amazon order; review before moving into budget buckets.'
        : 'Matched evidence is ambiguous; review before moving.',
      review: true,
    };
  }

  return {
    transaction,
    evidence,
    suggestedCategoryId: 'optional',
    suggestedCategoryName: categoryName(categories, 'optional'),
    confidence: evidence ? 0.74 : 0.58,
    reason: evidence
      ? 'Defaulting matched Amazon spend to flexible unless it looks necessary.'
      : 'No matched Amazon detail; default review is recommended.',
    review: !evidence,
  };
}

function amazonAssignmentCategories(
  categories: SpendingBudgetCategory[],
): SpendingBudgetCategory[] {
  const preferredIds = [
    'essential',
    'optional',
    GENEROSITY_CATEGORY_ID,
    'health',
    'travel',
    'ignored',
  ];
  const byId = new Map(categories.map((category) => [category.id, category]));
  return preferredIds
    .map((id) => byId.get(id))
    .filter((category): category is SpendingBudgetCategory => Boolean(category));
}

function largeTransactionAssignmentCategories(
  categories: SpendingBudgetCategory[],
): SpendingBudgetCategory[] {
  const preferredIds = [
    'essential',
    'taxes_insurance',
    LONG_TERM_ITEMS_CATEGORY_ID,
    'optional',
    GENEROSITY_CATEGORY_ID,
    'health',
    'travel',
    'ignored',
  ];
  const byId = new Map(categories.map((category) => [category.id, category]));
  const preferredCategories = preferredIds
    .map((id) => byId.get(id))
    .filter((category): category is SpendingBudgetCategory => Boolean(category));
  const remainingCategories = categories.filter(
    (category) =>
      category.id !== AMAZON_UNKNOWN_CATEGORY_ID &&
      category.id !== 'uncategorized' &&
      !preferredIds.includes(category.id),
  );
  return [...preferredCategories, ...remainingCategories];
}

function largeTransactionSearchText(transaction: SpendingTransaction): string {
  return [
    transaction.postedDate,
    transaction.merchant,
    transaction.description,
    transaction.categoryId,
    transaction.amount.toFixed(2),
    Math.round(transaction.amount).toString(),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function largeTransactionMatchesSearch(
  transaction: SpendingTransaction,
  query: string,
): boolean {
  const searchText = largeTransactionSearchText(transaction);
  const tokens = searchText.split(/[^a-z0-9.]+/).filter(Boolean);
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim().toLowerCase().replace(/[^a-z0-9.]/g, ''))
    .filter(Boolean);

  return terms.every((term) => {
    if (term.length <= 3) {
      return tokens.some((token) => token.startsWith(term));
    }
    return searchText.includes(term);
  });
}

function isReviewedLargeTransaction(transaction: SpendingTransaction): boolean {
  return (
    transaction.classificationMethod === 'manual' ||
    transaction.tags?.includes('manual_override') === true ||
    Boolean(transaction.rawEvidence?.categoryOverride)
  );
}

function formatSignedAmount(value: number): string {
  if (value < 0) return `-${formatCurrency(Math.abs(value))}`;
  return formatCurrency(value);
}

function formatLedgerTimestamp(value: string | undefined): string {
  if (!value) return 'Not checked';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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

function SpendingProgressTrack({
  progress,
  activeSegmentId,
  onSegmentClick,
  showMarker = true,
}: {
  progress: SpendingProgressSnapshot;
  activeSegmentId?: string | null;
  onSegmentClick?: (categoryId: string) => void;
  showMarker?: boolean;
}) {
  return (
    <div>
      <div className="relative h-4 overflow-visible rounded-full bg-white shadow-inner">
        {progress.barSegments?.length ? (
          <div
            className="absolute left-0 top-0 flex h-4 overflow-hidden rounded-full"
            style={{ width: progressWidth(progress.percentSpent) }}
          >
            {progress.barSegments.map((segment) => (
              <button
                type="button"
                key={segment.categoryId}
                title={`${segment.name}: ${formatCurrency(segment.value)}`}
                aria-label={`${segment.name} details`}
                aria-pressed={activeSegmentId === segment.categoryId}
                onClick={() => onSegmentClick?.(segment.categoryId)}
                className={`h-4 min-w-[3px] border-0 p-0 transition ${
                  onSegmentClick ? 'cursor-pointer hover:brightness-95' : ''
                } ${
                  activeSegmentId === segment.categoryId
                    ? 'ring-2 ring-inset ring-stone-950'
                    : ''
                }`}
                style={{
                  width:
                    progress.spent > 0
                      ? `${Math.max(1, (segment.value / progress.spent) * 100)}%`
                      : '0%',
                  backgroundColor: segment.color,
                }}
              />
            ))}
          </div>
        ) : (
          <div
            className="absolute left-0 top-0 h-4 rounded-full bg-[#0071E3]"
            style={{ width: progressWidth(progress.percentSpent) }}
          />
        )}
        {showMarker ? (
          <div
            className="absolute top-[-6px] h-7 w-0.5 rounded-full bg-stone-900"
            style={{ left: progressWidth(progress.percentElapsed) }}
          />
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs font-medium text-stone-500">
        <span>{formatCurrency(0)}</span>
        <span>{progress.markerLabel}</span>
        <span>{formatCurrency(progress.budget)}</span>
      </div>
      {progress.barSegments?.length ? (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-stone-600">
          {progress.barSegments.map((segment) => (
            <button
              type="button"
              key={segment.categoryId}
              onClick={() => onSegmentClick?.(segment.categoryId)}
              className={`inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 text-left ${
                onSegmentClick ? 'hover:bg-white' : 'cursor-default'
              } ${
                activeSegmentId === segment.categoryId
                  ? 'bg-white font-semibold text-stone-900'
                  : ''
              }`}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: segment.color }}
              />
              {segment.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SpendingBucketDetail({
  bucket,
  onClose,
}: {
  bucket: SpendingBucketBreakdown;
  onClose: () => void;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-stone-900">{bucket.name}</p>
          <p className="mt-1 text-xs text-stone-500">
            {formatCurrency(bucket.spent)} of {formatCurrency(bucket.budget)} yearly budget
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={bucket.status} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close bucket details"
            className="rounded-full px-2 py-0.5 text-sm font-semibold text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            x
          </button>
        </div>
      </div>
      {bucket.purchaseGroups.length ? (
        <div className="mt-4 max-h-56 space-y-2 overflow-y-auto pr-1">
          {bucket.purchaseGroups.map((group) => (
            <div key={`${bucket.categoryId}-${group.label}`} className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate font-semibold text-stone-800">{group.label}</p>
                <p className="shrink-0 text-xs font-semibold text-stone-900">
                  {formatCurrency(group.total)}
                </p>
              </div>
              <p className="mt-0.5 truncate text-xs text-stone-500">
                {group.count} purchase{group.count === 1 ? '' : 's'} · latest{' '}
                {group.latestDate}
                {group.sampleDescription ? ` · ${group.sampleDescription}` : ''}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-xs leading-5 text-stone-500">
          No purchase groups in this period.
        </p>
      )}
    </div>
  );
}

function SpendingProgressCard({
  progress,
  secondaryProgress,
  onAssignAmazonUnknown,
}: {
  progress: SpendingProgressSnapshot;
  secondaryProgress?: SpendingProgressSnapshot;
  onAssignAmazonUnknown: () => void;
}) {
  const [openBucketId, setOpenBucketId] = useState<string | null>(null);
  const bucketPopoverRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openBucketId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        bucketPopoverRootRef.current?.contains(target)
      ) {
        return;
      }
      setOpenBucketId(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenBucketId(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openBucketId]);

  const hasSecondaryProgress = Boolean(secondaryProgress);
  const selectedBucket = progress.bucketBreakdown.find(
    (bucket) => bucket.categoryId === openBucketId,
  );
  const headerProgress = secondaryProgress ?? progress;

  return (
    <section className="rounded-[28px] bg-stone-100/85 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">{headerProgress.label}</p>
          <h3 className="mt-1 text-2xl font-semibold text-stone-900">
            {formatCurrency(headerProgress.spent)} of {formatCurrency(headerProgress.budget)}
          </h3>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {hasSecondaryProgress
              ? `Monthly operating is the live pace signal. Annual escrow below tracks required yearly and travel allocations without date pacing. ${progress.projectionLabel}.`
              : `${progress.percentSpent.toFixed(1)}% spent, ${progress.percentElapsed.toFixed(1)}% elapsed. Expected ${formatCurrency(progress.expected)} by now. Projected ${formatCurrency(progress.projected)}. ${progress.projectionLabel}.`}
          </p>
        </div>
        <StatusPill status={secondaryProgress?.status ?? progress.status} />
      </div>

      <div className="mt-6">
        {secondaryProgress ? (
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase text-stone-400">
                  Monthly operating pace
                </p>
                <p className="mt-1 text-sm font-semibold text-stone-900">
                  {formatCurrency(secondaryProgress.spent)} of{' '}
                  {formatCurrency(secondaryProgress.budget)}
                </p>
              </div>
              <StatusPill status={secondaryProgress.status} />
            </div>
            <SpendingProgressTrack progress={secondaryProgress} />
            <p className="mt-3 text-xs leading-5 text-stone-600">
              {secondaryProgress.percentSpent.toFixed(1)}% spent,{' '}
              {secondaryProgress.percentElapsed.toFixed(1)}% elapsed. Expected{' '}
              {formatCurrency(secondaryProgress.expected)} by now. Projected{' '}
              {formatCurrency(secondaryProgress.projected)}.{' '}
              {secondaryProgress.projectionLabel}.
            </p>
          </div>
        ) : null}
        <div
          ref={bucketPopoverRootRef}
          className={secondaryProgress ? 'mt-5 rounded-2xl bg-white/70 p-4' : ''}
        >
          <p className="mb-2 text-xs font-semibold uppercase text-stone-400">
            Annual escrow used
          </p>
          <SpendingProgressTrack
            progress={progress}
            activeSegmentId={openBucketId}
            showMarker={false}
            onSegmentClick={(categoryId) =>
              setOpenBucketId((current) =>
                current === categoryId ? null : categoryId,
              )
            }
          />
          {selectedBucket ? (
            <SpendingBucketDetail
              bucket={selectedBucket}
              onClose={() => setOpenBucketId(null)}
            />
          ) : null}
        </div>
      </div>

      {progress.amazonHoldingPen ? (
        <div className="mt-5 border-t border-stone-200 pt-4">
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-3 py-2 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-stone-300 text-xs font-bold text-stone-600">
                i
              </span>
              <p className="min-w-0 text-stone-600">
                Amazon assignment queue: {' '}
                <span className="font-semibold text-stone-900">
                  {formatCurrency(progress.amazonHoldingPen.matched)}
                </span>
                {' '}matched, needs bucket
                {progress.amazonHoldingPen.unmatched > 0 ? (
                  <span>
                    {' '}· {formatCurrency(progress.amazonHoldingPen.unmatched)} unmatched
                  </span>
                ) : null}
              </p>
            </div>
            <button
              type="button"
              onClick={onAssignAmazonUnknown}
              className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-800 hover:border-blue-300 hover:text-blue-700"
            >
              Assign
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ModelHistoryComparisonPanel({
  comparison,
}: {
  comparison: HistoricalSpendingComparison;
}) {
  const hasHistory = comparison.monthCount > 0;
  const deltaIsOver = comparison.deltaMonthly > 0;
  const deltaTone =
    Math.abs(comparison.deltaMonthly) < 1
      ? 'bg-stone-100 text-stone-700 ring-stone-200'
      : deltaIsOver
        ? 'bg-amber-50 text-amber-800 ring-amber-100'
        : 'bg-emerald-50 text-emerald-800 ring-emerald-100';
  const deltaLabel =
    Math.abs(comparison.deltaMonthly) < 1
      ? 'On model'
      : `${formatCurrency(Math.abs(comparison.deltaMonthly))}/mo ${
          deltaIsOver ? 'above' : 'below'
        } model`;

  return (
    <section className="mt-4 rounded-[28px] bg-stone-100/85 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-stone-400">
            Monthly operating vs history
          </p>
          <h3 className="mt-1 text-xl font-semibold text-stone-900">
            {hasHistory
              ? `${formatCurrency(comparison.historicalMonthlyAverage)}/mo historical vs ${formatCurrency(comparison.modeledMonthlyBudget)}/mo modeled`
              : `${formatCurrency(comparison.modeledMonthlyBudget)}/mo modeled`}
          </h3>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {hasHistory
              ? `Closed-month average from ${formatMonthRange(
                  comparison.firstMonth,
                  comparison.lastMonth,
                )}. Required yearly, travel, ignored transfers, and internal movements are excluded; refunds averaged ${formatCurrency(
                  comparison.refundMonthlyAverage,
                )}/mo.`
              : 'No complete historical ledger months are available yet, so this can only show the modeled monthly operating target.'}
          </p>
        </div>
        {hasHistory ? (
          <span
            className={`inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ${deltaTone}`}
          >
            {deltaLabel}
          </span>
        ) : null}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs font-medium uppercase text-stone-400">
            Modeled run-rate
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-900">
            {formatCurrency(comparison.modeledAnnualBudget)}/yr
          </p>
        </div>
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs font-medium uppercase text-stone-400">
            Historical annualized
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-900">
            {hasHistory ? formatCurrency(comparison.historicalAnnualized) : 'Not enough data'}
          </p>
        </div>
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs font-medium uppercase text-stone-400">
            Historical as % of model
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-900">
            {hasHistory ? `${Math.round(comparison.percentOfModeled)}%` : 'Waiting'}
          </p>
        </div>
      </div>

      {hasHistory && comparison.categories.length ? (
        <div className="mt-5 border-t border-stone-200 pt-4">
          <div className="grid gap-3 lg:grid-cols-2">
            {comparison.categories.map((category) => {
              const percent =
                category.modeledMonthlyBudget > 0
                  ? category.percentOfModeled
                  : category.historicalMonthlyAverage > 0
                    ? 100
                    : 0;
              const rowOver = category.deltaMonthly > 0;
              return (
                <div key={category.categoryId} className="min-w-0 rounded-2xl bg-white p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-semibold text-stone-800">
                      {category.name}
                    </p>
                    <p
                      className={`shrink-0 text-xs font-semibold ${
                        Math.abs(category.deltaMonthly) < 1
                          ? 'text-stone-500'
                          : rowOver
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                      }`}
                    >
                      {Math.abs(category.deltaMonthly) < 1
                        ? 'even'
                        : `${rowOver ? '+' : '-'}${formatCurrency(
                            Math.abs(category.deltaMonthly),
                          )}/mo`}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    History {formatCurrency(category.historicalMonthlyAverage)}/mo · Model{' '}
                    {formatCurrency(category.modeledMonthlyBudget)}/mo
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className={`h-1.5 rounded-full ${
                        rowOver ? 'bg-amber-500' : 'bg-[#0071E3]'
                      }`}
                      style={{ width: progressWidth(percent) }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GmailSyncStatusStrip({
  ledger,
  status,
}: {
  ledger: LocalSpendingLedgerPayload | undefined;
  status: 'loading' | 'loaded' | 'missing' | 'error';
}) {
  const issueCount = ledger?.summary?.issueCount ?? ledger?.issues?.length ?? 0;
  const transactionCount = ledger?.summary?.transactionCount ?? ledger?.transactions?.length ?? 0;
  const lastSyncedUid = ledger?.summary?.lastSyncedUid ?? ledger?.source?.lastSyncedUid;
  const openIssueUids = (ledger?.issues ?? [])
    .map((issue) => issue.uid)
    .filter((uid): uid is number => typeof uid === 'number')
    .slice(0, 4);
  const isLoaded = Boolean(ledger);
  const statusText =
    status === 'loading'
      ? 'Checking local ledger'
      : status === 'error'
        ? 'Ledger read error'
        : isLoaded
          ? 'Auto sync active'
          : 'Gmail ledger missing';
  const badgeClass = isLoaded
    ? issueCount > 0
      ? 'bg-amber-50 text-amber-800 ring-amber-200'
      : 'bg-emerald-50 text-emerald-800 ring-emerald-200'
    : status === 'loading'
      ? 'bg-blue-50 text-blue-800 ring-blue-200'
      : 'bg-stone-100 text-stone-700 ring-stone-200';

  return (
    <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-stone-900">Gmail sync</p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${badgeClass}`}
            >
              {statusText}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            {ledger?.account ?? ledger?.source?.accountId ?? 'bonnertransactions@gmail.com'} ·{' '}
            {ledger?.mailbox ?? 'INBOX'}
          </p>
        </div>
        <div className="grid w-full gap-3 text-sm sm:w-auto sm:grid-cols-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase text-stone-400">Last checked</p>
            <p className="mt-1 font-semibold text-stone-900">
              {formatLedgerTimestamp(ledger?.fetchedAtIso ?? ledger?.importedAtIso)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-stone-400">Last UID</p>
            <p className="mt-1 font-semibold text-stone-900">
              {lastSyncedUid ? lastSyncedUid.toLocaleString() : 'None'}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-stone-400">Email txns</p>
            <p className="mt-1 font-semibold text-stone-900">
              {transactionCount.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-stone-400">Issues</p>
            <p className="mt-1 font-semibold text-stone-900">
              {issueCount.toLocaleString()}
              {openIssueUids.length ? (
                <span className="ml-1 text-xs font-medium text-stone-500">
                  UID {openIssueUids.join(', ')}
                </span>
              ) : null}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function AmazonSuggestionTable({
  suggestions,
  assignmentCategories,
  onApply,
  onApplyConfident,
}: {
  suggestions: AmazonBucketSuggestion[];
  assignmentCategories: SpendingBudgetCategory[];
  onApply: (
    transactionId: string,
    categoryId: string,
    options?: SpendingCategoryApplyOptions,
  ) => void;
  onApplyConfident: () => void;
}) {
  const actionableSuggestions = suggestions.filter(
    (suggestion) => !suggestion.review && suggestion.suggestedCategoryId !== suggestion.transaction.categoryId,
  );
  const reviewCount = suggestions.filter((suggestion) => suggestion.review).length;
  const suggestedSpend = suggestions.reduce(
    (total, suggestion) =>
      suggestion.suggestedCategoryId !== 'amazon_uncategorized'
        ? total + Math.max(0, suggestion.transaction.amount)
        : total,
    0,
  );

  return (
    <section id="amazon-bucket-suggestions" className="mt-6 scroll-mt-6 rounded-[28px] bg-stone-100/85 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold text-stone-900">Amazon Bucket Suggestions</h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            {actionableSuggestions.length} ready to move · {reviewCount} need review ·{' '}
            {formatCurrency(suggestedSpend)} suggested out of Amazon unknown.
          </p>
        </div>
        <button
          type="button"
          onClick={onApplyConfident}
          disabled={!actionableSuggestions.length}
          className="rounded-full bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          Apply confident
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
        {suggestions.length ? (
          <div className="max-h-[360px] overflow-auto">
            <table className="min-w-full divide-y divide-stone-200 text-sm">
              <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase text-stone-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Evidence</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                  <th className="px-3 py-2 font-semibold">Suggestion</th>
                  <th className="px-3 py-2 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {suggestions.map((suggestion) => (
                  <tr key={suggestion.transaction.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-stone-600">
                      {suggestion.transaction.postedDate}
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium text-stone-900">
                        {amazonEvidenceTitle(suggestion.evidence) || suggestion.transaction.merchant}
                      </p>
                      {suggestion.evidence ? (
                        <p className="mt-1 text-xs leading-5 text-blue-700">
                          {amazonEvidenceDetail(suggestion.evidence)}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs leading-5 text-stone-500">
                        {suggestion.reason}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-stone-900">
                      {formatAmazonEvidenceSignedCurrency(suggestion.transaction.amount)}
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-semibold text-stone-900">
                        {suggestion.review ? 'Review' : suggestion.suggestedCategoryName}
                      </p>
                      <p className="mt-1 text-xs text-stone-500">
                        {(suggestion.confidence * 100).toFixed(0)}% confidence
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value=""
                        onChange={(event) => {
                          if (event.target.value) {
                            onApply(suggestion.transaction.id, event.target.value);
                          }
                        }}
                        className="w-full min-w-[190px] rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      >
                        <option value="" disabled>
                          Move to bucket...
                        </option>
                        {assignmentCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                            {category.id === suggestion.suggestedCategoryId && !suggestion.review
                              ? ' (suggested)'
                              : ''}
                          </option>
                        ))}
                      </select>
                      {suggestion.review ? (
                        <p className="mt-2 text-xs font-medium text-amber-700">Needs review</p>
                      ) : (
                        <p className="mt-2 text-xs text-stone-500">Suggested: {suggestion.suggestedCategoryName}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4 text-sm text-stone-500">
            No matched Amazon card transactions need bucket suggestions this month.
          </div>
        )}
      </div>
    </section>
  );
}

function LargeTransactionReview({
  transactions,
  categoryOptions,
  amazonEvidenceByTransactionId,
  search,
  onSearchChange,
  onApply,
}: {
  transactions: SpendingTransaction[];
  categoryOptions: SpendingBudgetCategory[];
  amazonEvidenceByTransactionId: Map<string, AmazonEmailAlignmentMatch>;
  search: string;
  onSearchChange: (value: string) => void;
  onApply: (
    transactionId: string,
    categoryId: string,
    options?: SpendingCategoryApplyOptions,
  ) => void;
}) {
  const query = search.trim().toLowerCase();
  const [alwaysForMerchantIds, setAlwaysForMerchantIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingCategoryByTransactionId, setPendingCategoryByTransactionId] =
    useState<Record<string, string>>({});
  const [pendingTitleByTransactionId, setPendingTitleByTransactionId] =
    useState<Record<string, string>>({});
  const actionCategories = largeTransactionAssignmentCategories(categoryOptions);
  const rows = transactions
    .filter((transaction) => transaction.amount > 0)
    .filter((transaction) =>
      query
        ? largeTransactionMatchesSearch(transaction, query)
        : transaction.ignored !== true &&
          !isReviewedLargeTransaction(transaction) &&
          transaction.amount >= LARGE_TRANSACTION_THRESHOLD,
    )
    .sort((left, right) => {
      if (right.amount !== left.amount) return right.amount - left.amount;
      return right.postedDate.localeCompare(left.postedDate);
    })
    .slice(0, query ? 25 : 12);

  return (
    <section className="mt-6 rounded-[28px] bg-stone-100/85 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold text-stone-900">Large Transaction Review</h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Surfacing charges over {formatCurrency(LARGE_TRANSACTION_THRESHOLD)}. Light green is the current suggested bucket; choose a bucket or click Save to mark it updated by user and remove it from this queue.
          </p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search merchant, amount, cruise..."
          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 sm:w-80"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
        {rows.length ? (
          <div className="max-h-[360px] overflow-auto">
            <table className="min-w-full divide-y divide-stone-200 text-sm">
              <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase text-stone-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Transaction</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                  <th className="px-3 py-2 font-semibold">Bucket</th>
                  <th className="px-3 py-2 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((transaction) => {
                  const amazonEvidence = amazonEvidenceByTransactionId.get(transaction.id);
                  const currentCategoryId = transaction.ignored
                    ? 'ignored'
                    : transaction.categoryId ?? 'uncategorized';
                  const reviewedByUser = isReviewedLargeTransaction(transaction);
                  const alwaysForMerchant = alwaysForMerchantIds.has(transaction.id);
                  const selectedCategoryId =
                    pendingCategoryByTransactionId[transaction.id] ?? currentCategoryId;
                  const currentTitle = transaction.displayTitle ?? '';
                  const selectedTitle =
                    pendingTitleByTransactionId[transaction.id] ?? currentTitle;
                  const normalizedTitle = selectedTitle.trim();
                  const hasPendingChange =
                    !reviewedByUser ||
                    selectedCategoryId !== currentCategoryId ||
                    normalizedTitle !== currentTitle ||
                    alwaysForMerchant;
                  const applyRowCategory = () => {
                    if (!hasPendingChange) return;
                    onApply(transaction.id, selectedCategoryId, {
                      applyToMerchant: alwaysForMerchant,
                      title: normalizedTitle,
                    });
                    setPendingCategoryByTransactionId((current) => {
                      const next = { ...current };
                      delete next[transaction.id];
                      return next;
                    });
                    setPendingTitleByTransactionId((current) => {
                      const next = { ...current };
                      delete next[transaction.id];
                      return next;
                    });
                    setAlwaysForMerchantIds((current) => {
                      const next = new Set(current);
                      next.delete(transaction.id);
                      return next;
                    });
                  };
                  return (
                    <tr key={transaction.id} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2 text-stone-600">
                        {transaction.postedDate}
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium text-stone-900">
                          {transactionDisplayTitle(transaction)}
                        </p>
                        <p className="mt-0.5 text-xs leading-5 text-stone-500">
                          {transaction.displayTitle ? `${transaction.merchant} · ` : ''}
                          {transaction.description ?? transaction.source?.sourceId ?? transaction.id}
                        </p>
                        {amazonEvidence ? (
                          <p className="mt-1 text-xs leading-5 text-blue-700">
                            Amazon match: {amazonEvidenceTitle(amazonEvidence)}
                          </p>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-stone-900">
                        {formatSignedAmount(transaction.amount)}
                      </td>
                      <td className="px-3 py-2 text-xs leading-5 text-stone-500">
                        <p>
                          {transaction.ignored
                            ? 'Ignored'
                            : categoryName(
                                categoryOptions,
                                transaction.categoryId ?? 'uncategorized',
                              )}
                        </p>
                        <p className={reviewedByUser ? 'text-emerald-700' : 'text-amber-700'}>
                          {reviewedByUser ? 'Updated by user' : 'Needs user update'}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <div className="min-w-[300px] space-y-2">
                          <input
                            type="text"
                            value={selectedTitle}
                            onChange={(event) => {
                              setPendingTitleByTransactionId((current) => ({
                                ...current,
                                [transaction.id]: event.target.value,
                              }));
                            }}
                            placeholder="Readable title"
                            className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                          />
                          <div className="flex items-center gap-2">
                            <select
                              value={selectedCategoryId}
                              onChange={(event) => {
                                setPendingCategoryByTransactionId((current) => ({
                                  ...current,
                                  [transaction.id]: event.target.value,
                                }));
                              }}
                              className={`min-w-[170px] rounded-xl border px-3 py-2 text-sm font-semibold outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${
                                reviewedByUser || hasPendingChange
                                  ? 'border-emerald-600 bg-emerald-600 text-white'
                                  : 'border-emerald-300 bg-emerald-50 text-emerald-900'
                              }`}
                            >
                              {!actionCategories.some((category) => category.id === currentCategoryId) ? (
                                <option value={currentCategoryId}>
                                  {categoryName(categoryOptions, currentCategoryId)}
                                </option>
                              ) : null}
                              {actionCategories.map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.id === 'ignored' ? 'Ignore' : category.name}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              disabled={!hasPendingChange}
                              onClick={applyRowCategory}
                              className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:border-emerald-500 hover:text-emerald-700 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
                            >
                              Save
                            </button>
                          </div>
                          <label className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-700">
                            <input
                              type="checkbox"
                              checked={alwaysForMerchant}
                              onChange={(event) => {
                                setAlwaysForMerchantIds((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked) {
                                    next.add(transaction.id);
                                  } else {
                                    next.delete(transaction.id);
                                  }
                                  return next;
                                });
                              }}
                              className="h-4 w-4 rounded border-stone-300 text-emerald-600"
                            />
                            Always use this bucket for {transaction.merchant}
                          </label>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4 text-sm text-stone-500">
            {query
              ? 'No matching transactions found.'
              : `No non-ignored transactions over ${formatCurrency(LARGE_TRANSACTION_THRESHOLD)} found.`}
          </div>
        )}
      </div>
    </section>
  );
}

function CategoryRow({
  category,
  expanded,
  transactions,
  categoryOptions,
  amazonEvidenceByTransactionId,
  onToggle,
  onMoveTransaction,
}: {
  category: SpendingCategorySummary;
  expanded: boolean;
  transactions: SpendingTransaction[];
  categoryOptions: SpendingBudgetCategory[];
  amazonEvidenceByTransactionId: Map<string, AmazonEmailAlignmentMatch>;
  onToggle: () => void;
  onMoveTransaction: (
    transactionId: string,
    categoryId: string,
    options?: SpendingCategoryApplyOptions,
  ) => void;
}) {
  const [pendingTitleByTransactionId, setPendingTitleByTransactionId] =
    useState<Record<string, string>>({});
  const trackedOutsideOperatingBudget =
    category.categoryId === LONG_TERM_ITEMS_CATEGORY_ID;
  const trackedYearlyBudget = isYearlySpendingCategoryId(category.categoryId);
  const grossProjectionShare =
    category.budget > 0 ? category.expectedByToday / category.budget : 0;
  const displayedSpend = trackedOutsideOperatingBudget
    ? category.ignoredSpend
    : category.spent;
  const displayedBudget = trackedYearlyBudget
    ? roundMoney(category.budget * 12)
    : category.budget;
  const displayedProjected = trackedOutsideOperatingBudget
    ? category.ignoredSpend
    : trackedYearlyBudget
      ? category.spent
    : grossProjectionShare > 0
      ? roundMoney(category.spent / grossProjectionShare)
      : category.spent;
  const spendPercent =
    displayedBudget > 0 ? Math.min(100, (displayedSpend / displayedBudget) * 100) : 0;

  return (
    <div className="border-t border-stone-200 py-4 first:border-t-0">
      <div className="grid gap-3 md:grid-cols-[1fr_110px_110px_120px_88px] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-stone-900">{category.name}</p>
            {trackedOutsideOperatingBudget ? (
              <span className="inline-flex items-center rounded-full bg-stone-100 px-2.5 py-1 text-xs font-semibold text-stone-700 ring-1 ring-stone-200">
                Outside budget
              </span>
            ) : trackedYearlyBudget ? (
              <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800 ring-1 ring-blue-100">
                Yearly budget
              </span>
            ) : (
              <StatusPill status={category.status} />
            )}
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
          <p className="font-semibold text-stone-900">{formatCurrency(displayedSpend)}</p>
          {!trackedOutsideOperatingBudget && category.refunds > 0 ? (
            <p className="mt-0.5 text-xs text-stone-500">
              Net {formatCurrency(category.netSpend)} after {formatCurrency(category.refunds)} credits
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-stone-400">Budget</p>
          <p className="font-semibold text-stone-900">
            {trackedOutsideOperatingBudget
              ? 'Outside'
              : trackedYearlyBudget
                ? `${formatCurrency(displayedBudget)}/yr`
                : formatCurrency(displayedBudget)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-stone-400">Projected</p>
          <p className="font-semibold text-stone-900">
            {trackedOutsideOperatingBudget
              ? 'N/A'
              : trackedYearlyBudget
                ? 'Annual'
                : formatCurrency(displayedProjected)}
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
                  {transactions.map((transaction) => {
                    const amazonEvidence =
                      amazonEvidenceByTransactionId.get(transaction.id) ??
                      (transaction.linkedTransactionIds ?? [])
                        .map((id) => amazonEvidenceByTransactionId.get(id))
                        .find((evidence): evidence is AmazonEmailAlignmentMatch => Boolean(evidence));
                    const isAmazonSplitAllocation = transaction.tags?.includes('amazon_30_70_split') ?? false;
                      return (
                        <tr key={transaction.id} className="align-top">
                          <td className="whitespace-nowrap px-3 py-2 text-stone-600">
                            {transaction.postedDate}
                          </td>
                          <td className="px-3 py-2">
                            <p className="font-medium text-stone-900">
                              {transactionDisplayTitle(transaction)}
                            </p>
                            <p className="mt-0.5 text-xs text-stone-500">
                              {transaction.displayTitle ? `${transaction.merchant} · ` : ''}
                              {transaction.description ?? transaction.source?.sourceId ?? transaction.id}
                            </p>
                            {amazonEvidence ? (
                              <div className="mt-2 rounded-lg bg-blue-50 px-2 py-1.5 text-xs leading-5 text-blue-900">
                                <p className="font-semibold">Amazon match</p>
                                <p>{amazonEvidenceTitle(amazonEvidence) || amazonEvidence.email.subject}</p>
                                {amazonEvidenceDetail(amazonEvidence) ? (
                                  <p className="mt-1 text-blue-700">
                                    {amazonEvidenceDetail(amazonEvidence)}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
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
                            {amazonEvidence ? (
                              <p className="mt-1 text-blue-700">
                                email match · {(amazonEvidence.confidence * 100).toFixed(0)}% ·{' '}
                                {amazonEvidence.dateDeltaDays}d
                              </p>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            {isAmazonSplitAllocation ? (
                              <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-100">
                                Auto 30/70 split
                              </span>
                            ) : (
                              <div className="min-w-[190px] space-y-2">
                                <select
                                  value={transaction.categoryId ?? 'uncategorized'}
                                  onChange={(event) =>
                                    onMoveTransaction(transaction.id, event.target.value, {
                                      title:
                                        pendingTitleByTransactionId[transaction.id]?.trim() ??
                                        transaction.displayTitle ??
                                        '',
                                    })
                                  }
                                  className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                                >
                                  {categoryOptions.map((option) => (
                                    <option key={option.id} value={option.id}>
                                      {option.name}
                                    </option>
                                  ))}
                                  <option value="uncategorized">Uncategorized</option>
                                </select>
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    value={
                                      pendingTitleByTransactionId[transaction.id] ??
                                      transaction.displayTitle ??
                                      ''
                                    }
                                    onChange={(event) =>
                                      setPendingTitleByTransactionId((current) => ({
                                        ...current,
                                        [transaction.id]: event.target.value,
                                      }))
                                    }
                                    placeholder="Readable title"
                                    className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const title =
                                        pendingTitleByTransactionId[transaction.id]?.trim() ??
                                        transaction.displayTitle ??
                                        '';
                                      onMoveTransaction(
                                        transaction.id,
                                        transaction.categoryId ?? 'uncategorized',
                                        { title },
                                      );
                                      setPendingTitleByTransactionId((current) => {
                                        const next = { ...current };
                                        delete next[transaction.id];
                                        return next;
                                      });
                                    }}
                                    className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:border-blue-300 hover:text-blue-700"
                                  >
                                    Save
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                    );
                  })}
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
  retirementDate,
}: {
  retirementDate: string;
}) {
  const appliedData = useAppStore((state) => state.appliedData);
  const appliedAssumptions = useAppStore((state) => state.appliedAssumptions);
  const selectedStressors = useAppStore((state) => state.appliedSelectedStressors);
  const selectedResponses = useAppStore((state) => state.appliedSelectedResponses);
  const lastPolicyAdoption = useAppStore((state) => state.lastPolicyAdoption);
  const cluster = useClusterSession();
  const recommendedPolicy = useRecommendedPolicy(
    appliedData ?? null,
    appliedAssumptions ?? null,
    selectedStressors ?? [],
    selectedResponses ?? [],
    cluster.snapshot.dispatcherUrl ?? null,
    lastPolicyAdoption,
  );
  const now = useMemo(() => new Date(), []);
  const month = localMonthKey(now);
  const asOfIso = now.toISOString();
  const [localLedgers, setLocalLedgers] = useState<LocalSpendingLedgerPayload[]>([]);
  const [localLedgerStatus, setLocalLedgerStatus] = useState<
    'loading' | 'loaded' | 'missing' | 'error'
  >('loading');
  const [categoryOverrides, setCategoryOverrides] =
    useState<SpendingTransactionOverrideMap>({});
  const [merchantCategoryRules, setMerchantCategoryRules] =
    useState<SpendingMerchantCategoryRuleMap>({});
  const [amazonAlignment, setAmazonAlignment] = useState<AmazonEmailAlignmentPayload | null>(
    null,
  );
  const [largeTransactionSearch, setLargeTransactionSearch] = useState('');
  const [expandedCategoryId, setExpandedCategoryId] = useState<string | null>(
    'amazon_uncategorized',
  );
  const spendingTargetAnnual =
    recommendedPolicy.policy?.policy.annualSpendTodayDollars ??
    lastPolicyAdoption?.policy.annualSpendTodayDollars ??
    null;

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
    let cancelled = false;
    fetch(AMAZON_ALIGNMENT_URL, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as AmazonEmailAlignmentPayload;
      })
      .then((payload) => {
        if (cancelled) return;
        setAmazonAlignment(payload);
      })
      .catch(() => {
        if (cancelled) return;
        setAmazonAlignment(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    setCategoryOverrides(readSpendingTransactionOverrides(window.localStorage));
    setMerchantCategoryRules(readSpendingMerchantCategoryRules(window.localStorage));
  }, []);

  const modeledSpending = useMemo(() => {
    const fixedSpendingBase = {
      ...appliedData.spending,
      essentialMonthly: initialSeedData.spending.essentialMonthly,
      annualTaxesInsurance: initialSeedData.spending.annualTaxesInsurance,
      travelEarlyRetirementAnnual:
        initialSeedData.spending.travelEarlyRetirementAnnual,
    };
    return spendingTargetAnnual != null
      ? applyAnnualSpendTargetToOptionalSpending(
          fixedSpendingBase,
          spendingTargetAnnual,
        )
      : fixedSpendingBase;
  }, [appliedData.spending, spendingTargetAnnual]);
  const budgetPlan = useMemo(
    () =>
      enhanceBudgetPlanWithOperatingBuckets(
        buildRetirementSpendingBudgetPlan(modeledSpending, {
          month,
          createdAtIso: asOfIso,
        }),
      ),
    [asOfIso, modeledSpending, month],
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
    () =>
      applySpendingTransactionOverrides(
        applySpendingMerchantCategoryRules(
          applySpendingCategoryInferences(rawTransactions),
          merchantCategoryRules,
        ),
        categoryOverrides,
      ),
    [categoryOverrides, merchantCategoryRules, rawTransactions],
  );
  const budgetTransactions = useMemo(
    () => splitAmazonCreditCardTransactionsForBudget(transactions),
    [transactions],
  );
  const summary = useMemo(() => {
    return buildSpendingMonthSummary({
      budgetPlan,
      transactions: budgetTransactions,
      month,
      asOfIso,
    });
  }, [asOfIso, budgetPlan, budgetTransactions, month]);
  const categoryOptions = useMemo(
    () => budgetPlan.categories.filter((category) => category.id !== 'uncategorized'),
    [budgetPlan.categories],
  );
  const amazonEvidenceByTransactionId = useMemo(() => {
    const byId = new Map<string, AmazonEmailAlignmentMatch>();
    (amazonAlignment?.matches ?? []).forEach((match) => {
      byId.set(match.cardTransactionId, match);
    });
    return byId;
  }, [amazonAlignment]);
  const yearlyProgress = useMemo<SpendingProgressSnapshot>(() => {
    const year = now.getFullYear();
    const ytdMonthKeys = monthKeysThrough(now);
    const ytdMonthKeySet = new Set(ytdMonthKeys);
    const ytdBudgetTransactions = budgetTransactions.filter((transaction) =>
      ytdMonthKeySet.has(transactionMonth(transaction)),
    );
    const ytdSummaries = ytdMonthKeys.map((monthKey) =>
      buildSpendingMonthSummary({
        budgetPlan,
        transactions: budgetTransactions,
        month: monthKey,
        asOfIso,
      }),
    );
    const plannedBudget = annualEscrowBudgetFromPlan(budgetPlan);
    const spent = roundMoney(
      ytdSummaries.reduce(
        (total, monthSummary) =>
          total + annualEscrowSpendFromCategories(monthSummary.categories),
        0,
      ),
    );
    const bucketBreakdown = adaptiveAnnualEscrowBuckets(
      yearlyBucketBreakdown({
        budgetPlan,
        summaries: ytdSummaries,
        transactions: ytdBudgetTransactions,
      }),
    );
    const budget = adaptiveAnnualEscrowBudgetFromBuckets(bucketBreakdown);
    const escrowAdjustment = roundMoney(budget - plannedBudget);
    const projectionLabel =
      escrowAdjustment > 0
        ? `Escrow actuals are ${formatCurrency(escrowAdjustment)} above estimate; monthly operating is reduced around it`
        : annualEscrowLabel(spent, budget);
    return {
      label: `${year} annual escrow`,
      spent,
      budget,
      expected: budget,
      projected: spent,
      percentSpent: budget > 0 ? (spent / budget) * 100 : 0,
      percentElapsed: 0,
      status: annualEscrowStatus(spent, budget),
      markerLabel: annualEscrowLabel(spent, budget),
      projectionLabel,
      bucketBreakdown,
      barSegments: bucketBreakdown
        .filter((bucket) => bucket.spent > 0)
        .map((bucket) => ({
          categoryId: bucket.categoryId,
          name: bucket.name,
          value: bucket.spent,
          color: spendingBucketColor(bucket.categoryId),
        })),
      amazonHoldingPen: undefined,
    };
  }, [asOfIso, budgetPlan, budgetTransactions, now]);
  const historicalComparison = useMemo(
    () =>
      buildHistoricalSpendingComparison({
        budgetPlan,
        transactions: budgetTransactions,
        currentMonth: month,
      }),
    [budgetPlan, budgetTransactions, month],
  );
  const monthlyTransactionsByCategory = useMemo(() => {
    const buckets = new Map<string, SpendingTransaction[]>();
    budgetTransactions
      .filter((transaction) => transactionMonth(transaction) === month)
      .forEach((transaction) => {
        const categoryId = transaction.categoryId ?? 'uncategorized';
        const existing = buckets.get(categoryId) ?? [];
        existing.push(transaction);
        buckets.set(categoryId, existing);
      });
    return buckets;
  }, [budgetTransactions, month]);

  const applyTransactionCategories = (
    updates: Array<{
      transactionId: string;
      categoryId: string;
      applyToMerchant?: boolean;
      title?: string;
    }>,
  ) => {
    if (!updates.length) return;
    const merchantRuleUpdates = updates
      .filter((update) => update.applyToMerchant)
      .flatMap((update) => {
        const transaction = transactions.find(
          (candidate) => candidate.id === update.transactionId,
        );
        if (!transaction) return [];
        return [
          buildSpendingMerchantCategoryRule({
            merchant: transaction.merchant,
            categoryId: update.categoryId,
          }),
        ];
      });

    if (merchantRuleUpdates.length) {
      setMerchantCategoryRules((current) => {
        const next = { ...current };
        merchantRuleUpdates.forEach((rule) => {
          next[rule.merchantKey] = rule;
        });
        if (typeof window !== 'undefined' && window.localStorage) {
          try {
            writeSpendingMerchantCategoryRules(window.localStorage, next);
          } catch {
            // localStorage is a convenience layer; the in-memory rule still applies.
          }
        }
        return next;
      });
    }

    setCategoryOverrides((current) => {
      const next = { ...current };
      updates.forEach((update) => {
        next[update.transactionId] = buildSpendingTransactionOverride({
          ...update,
          title: update.title ?? current[update.transactionId]?.title,
        });
      });
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
  const moveTransaction = (
    transactionId: string,
    categoryId: string,
    options?: SpendingCategoryApplyOptions,
  ) => {
    applyTransactionCategories([
      {
        transactionId,
        categoryId,
        applyToMerchant: options?.applyToMerchant,
        title: options?.title,
      },
    ]);
  };
  const scrollToAmazonAssignments = () => {
    if (typeof document === 'undefined') return;
    document
      .getElementById('amazon-bucket-suggestions')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const loadedTransactionCount = localLedgers.reduce(
    (total, ledger) => total + (ledger.transactions?.length ?? 0),
    0,
  );
  const suppressedTransactionCount =
    loadedTransactionCount > 0 ? loadedTransactionCount - rawTransactions.length : 0;
  const gmailLedger = localLedgers.find((ledger) => ledger.source?.kind === 'gmail_imap');
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
  const annualBudgetTarget = annualTargetFromPlan(budgetPlan);
  const monthlyOperatingBudget = monthlyOperatingBudgetAfterAnnualEscrow({
    budgetPlan,
    annualEscrowBudget: yearlyProgress.budget,
  });
  const monthlyOperatingSpent = monthlyOperatingSpendFromCategories(summary.categories);
  const monthlyElapsedShare = summary.percentMonthElapsed / 100;
  const monthlyGrossProjected =
    summary.percentMonthElapsed > 0
      ? roundMoney(monthlyOperatingSpent / monthlyElapsedShare)
      : monthlyOperatingSpent;
  const monthlyExpected = roundMoney(monthlyOperatingBudget * monthlyElapsedShare);
  const monthlyProjectionDelta = roundMoney(
    monthlyGrossProjected - monthlyOperatingBudget,
  );
  const monthlyProgress: SpendingProgressSnapshot = {
    label: `${currentMonthLabel} operating`,
    spent: monthlyOperatingSpent,
    budget: monthlyOperatingBudget,
    expected: monthlyExpected,
    projected: monthlyGrossProjected,
    percentSpent:
      monthlyOperatingBudget > 0 ? (monthlyOperatingSpent / monthlyOperatingBudget) * 100 : 0,
    percentElapsed: summary.percentMonthElapsed,
    status: spendingStatusFromProjection({
      netSpend: monthlyOperatingSpent,
      budget: monthlyOperatingBudget,
      expected: monthlyExpected,
      projected: monthlyGrossProjected,
    }),
    markerLabel: `Today: ${asOfLabel}`,
    projectionLabel:
      Math.abs(monthlyProjectionDelta) < 1
        ? 'Trending on monthly budget'
        : `Trending ${formatCurrency(Math.abs(monthlyProjectionDelta))} ${
            monthlyProjectionDelta > 0 ? 'over' : 'under'
          } monthly budget`,
    bucketBreakdown: bucketBreakdownFromCategorySummaries(
      summary.categories,
      topPurchaseGroupsByCategory(
        budgetTransactions.filter((transaction) => transactionMonth(transaction) === month),
      ),
    ),
    amazonHoldingPen: undefined,
  };
  const monthlyCategoryRows = summary.categories.filter(
    (category) => !isYearlySpendingCategoryId(category.categoryId),
  );
  const monthlyRequiredBudget = roundMoney(
    budgetPlan.categories.find((category) => category.id === 'essential')?.monthlyBudget ??
      0,
  );
  const requiredYearlyBudget = roundMoney(
    (budgetPlan.categories.find((category) => category.id === 'taxes_insurance')
      ?.monthlyBudget ?? 0) * 12,
  );
  const travelYearlyBudget = roundMoney(
    (budgetPlan.categories.find((category) => category.id === 'travel')?.monthlyBudget ??
      0) * 12,
  );
  const monthlyFlexibleBudget = roundMoney(
    budgetPlan.categories
      .filter((category) =>
        ['optional', 'health', GENEROSITY_CATEGORY_ID].includes(category.id),
      )
      .reduce((total, category) => total + category.monthlyBudget, 0),
  );
  if (spendingTargetAnnual == null) {
    return (
      <Panel
        title="Spending"
        subtitle="Current-month pace, category drift, refunds, ignored transactions, and the bridge from household spending into the retirement model."
      >
        <div className="rounded-[28px] border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
          <p className="text-base font-semibold">Waiting for mined spending target</p>
          <p className="mt-1">
            Spending is not using the raw seed budget here. Once the mined policy
            recommendation or adopted policy is available, this view will render
            the monthly and yearly budget from that target.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Spending"
      subtitle="Current-month pace, category drift, refunds, ignored transactions, and the bridge from household spending into the retirement model."
    >
      <div className="grid gap-4">
        <SpendingProgressCard
          progress={yearlyProgress}
          secondaryProgress={monthlyProgress}
          onAssignAmazonUnknown={scrollToAmazonAssignments}
        />
      </div>

      <ModelHistoryComparisonPanel comparison={historicalComparison} />
      <GmailSyncStatusStrip ledger={gmailLedger} status={localLedgerStatus} />

      <LargeTransactionReview
        transactions={transactions}
        categoryOptions={categoryOptions}
        amazonEvidenceByTransactionId={amazonEvidenceByTransactionId}
        search={largeTransactionSearch}
        onSearchChange={setLargeTransactionSearch}
        onApply={moveTransaction}
      />

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
            {monthlyCategoryRows.map((category) => (
              <CategoryRow
                key={category.categoryId}
                category={category}
                expanded={expandedCategoryId === category.categoryId}
                transactions={monthlyTransactionsByCategory.get(category.categoryId) ?? []}
                categoryOptions={categoryOptions}
                amazonEvidenceByTransactionId={amazonEvidenceByTransactionId}
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
          <h3 className="text-xl font-semibold text-stone-900">Retirement link</h3>
          <div className="mt-4 grid gap-3">
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">
                Required monthly
              </p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(monthlyRequiredBudget)}/mo
              </p>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">
                Flexible monthly
              </p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(monthlyFlexibleBudget)}/mo
              </p>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">
                Annual budget target
              </p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(annualBudgetTarget)}/yr
              </p>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">
                Required yearly
              </p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(requiredYearlyBudget)}/yr
              </p>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs font-medium uppercase text-stone-400">
                Travel yearly
              </p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {formatCurrency(travelYearlyBudget)}/yr
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
