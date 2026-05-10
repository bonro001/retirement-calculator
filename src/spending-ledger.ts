import type { SpendingData } from './types';

export type SpendingModelCompletenessIndicator = 'faithful' | 'reconstructed';

export type SpendingLedgerSourceKind =
  | 'bank_csv'
  | 'credit_card_csv'
  | 'credit_card_email'
  | 'amazon_order_email'
  | 'amazon_refund_email'
  | 'refund_email'
  | 'home_assistant'
  | 'manual'
  | 'import';

export type SpendingClassificationMethod =
  | 'explicit'
  | 'rule'
  | 'manual'
  | 'inferred'
  | 'uncategorized';

export type SpendingBudgetBasis =
  | 'manual'
  | 'home_assistant'
  | 'retirement_seed'
  | 'trailing_average'
  | 'inferred';

export type SpendingBudgetCategoryKind =
  | 'essential'
  | 'flexible'
  | 'travel'
  | 'health'
  | 'taxes_insurance'
  | 'refund'
  | 'ignore'
  | 'other';

export interface SpendingSourceEvidence {
  source: SpendingLedgerSourceKind;
  sourceId: string;
  parserVersion?: string;
  receivedAtIso?: string;
  confidence: number;
}

export interface SpendingTransaction {
  id: string;
  postedDate: string;
  transactionDate?: string;
  displayTitle?: string;
  merchant: string;
  description?: string;
  /**
   * Signed USD amount. Positive values are spending outflows; negative values
   * are refunds, credits, or reversals that reduce spend.
   */
  amount: number;
  currency: 'USD';
  accountId?: string;
  categoryId?: string;
  categoryConfidence?: number;
  classificationMethod?: SpendingClassificationMethod;
  ignored?: boolean;
  tags?: string[];
  linkedTransactionIds?: string[];
  source?: SpendingSourceEvidence;
  rawEvidence?: Record<string, unknown>;
}

export interface SpendingBudgetCategory {
  id: string;
  name: string;
  kind: SpendingBudgetCategoryKind;
  monthlyBudget: number;
  basis: SpendingBudgetBasis;
  includeInBudget?: boolean;
  assumptionSource?: string;
}

export interface SpendingBudgetPlan {
  month: string;
  monthlyBudget: number;
  categories: SpendingBudgetCategory[];
  basis: SpendingBudgetBasis;
  createdAtIso?: string;
  assumptionSource?: string;
}

export interface SpendingModelCompleteness {
  indicator: SpendingModelCompletenessIndicator;
  missingInputs: string[];
  inferredAssumptions: string[];
  explicitInputCount: number;
  reconstructedInputCount: number;
}

export interface SpendingCategorySummary {
  categoryId: string;
  name: string;
  kind: SpendingBudgetCategoryKind;
  budget: number;
  spent: number;
  refunds: number;
  netSpend: number;
  ignoredSpend: number;
  transactionCount: number;
  includedTransactionCount: number;
  ignoredTransactionCount: number;
  expectedByToday: number;
  projectedMonthEnd: number;
  budgetRemaining: number;
  paceDelta: number;
  status: SpendingPaceStatus;
}

export type SpendingPaceStatus = 'under' | 'on_track' | 'watch' | 'over' | 'unbudgeted';

export interface SpendingMonthSummary {
  month: string;
  asOfIso: string;
  dayOfMonth: number;
  daysInMonth: number;
  percentMonthElapsed: number;
  monthlyBudget: number;
  expectedByToday: number;
  grossSpend: number;
  refunds: number;
  ignoredSpend: number;
  netSpend: number;
  projectedMonthEnd: number;
  budgetRemaining: number;
  paceDelta: number;
  status: SpendingPaceStatus;
  categories: SpendingCategorySummary[];
  transactionCount: number;
  includedTransactionCount: number;
  ignoredTransactionCount: number;
  modelCompleteness: SpendingModelCompleteness;
  intermediateCalculations: {
    elapsedShare: number;
    categoryBudgetTotal: number;
    categoryBudgetGap: number;
    grossIncludedDebits: number;
    includedCredits: number;
    ignoredDebits: number;
  };
}

export interface BuildSpendingMonthSummaryInput {
  transactions: SpendingTransaction[];
  budgetPlan: SpendingBudgetPlan;
  month?: string;
  asOfIso?: string;
}

const UNCATEGORIZED_CATEGORY_ID = 'uncategorized';
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function parseIsoDateParts(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE_RE.exec(value);
  if (!match) {
    throw new Error(`Expected ISO date string, received "${value}"`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function monthKeyFromIsoDate(value: string): string {
  const { year, month } = parseIsoDateParts(value);
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function spendingTransactionBudgetDate(
  transaction: SpendingTransaction,
): string {
  return transaction.transactionDate ?? transaction.postedDate;
}

export function spendingTransactionMonthKey(
  transaction: SpendingTransaction,
): string {
  return monthKeyFromIsoDate(spendingTransactionBudgetDate(transaction));
}

export function daysInMonthKey(monthKey: string): number {
  const { year, month } = parseIsoDateParts(`${monthKey}-01`);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function compareMonthKeys(left: string, right: string): number {
  const leftParts = parseIsoDateParts(`${left}-01`);
  const rightParts = parseIsoDateParts(`${right}-01`);
  return leftParts.year * 12 + leftParts.month - (rightParts.year * 12 + rightParts.month);
}

function monthProgressDay(month: string, asOfIso: string): number {
  const daysInMonth = daysInMonthKey(month);
  const asOfMonth = monthKeyFromIsoDate(asOfIso);
  const comparison = compareMonthKeys(asOfMonth, month);
  if (comparison < 0) return 0;
  if (comparison > 0) return daysInMonth;
  return clamp(parseIsoDateParts(asOfIso).day, 0, daysInMonth);
}

function statusFromPace(input: {
  netSpend: number;
  budget: number;
  expectedByToday: number;
  projectedMonthEnd: number;
}): SpendingPaceStatus {
  if (input.budget <= 0) {
    return input.netSpend > 0 ? 'unbudgeted' : 'on_track';
  }
  if (input.projectedMonthEnd > input.budget * 1.1) return 'over';
  if (input.projectedMonthEnd > input.budget * 1.03) return 'watch';
  if (input.netSpend < input.expectedByToday * 0.85) return 'under';
  return 'on_track';
}

function emptyCategorySummary(
  category: SpendingBudgetCategory | undefined,
  categoryId: string,
): SpendingCategorySummary {
  return {
    categoryId,
    name: category?.name ?? categoryId,
    kind: category?.kind ?? 'other',
    budget: roundMoney(category?.monthlyBudget ?? 0),
    spent: 0,
    refunds: 0,
    netSpend: 0,
    ignoredSpend: 0,
    transactionCount: 0,
    includedTransactionCount: 0,
    ignoredTransactionCount: 0,
    expectedByToday: 0,
    projectedMonthEnd: 0,
    budgetRemaining: roundMoney(category?.monthlyBudget ?? 0),
    paceDelta: 0,
    status: 'on_track',
  };
}

function finalizeCategorySummary(
  summary: SpendingCategorySummary,
  elapsedShare: number,
): SpendingCategorySummary {
  const netSpend = roundMoney(summary.spent - summary.refunds);
  const expectedByToday = roundMoney(summary.budget * elapsedShare);
  const projectedMonthEnd =
    elapsedShare > 0 ? roundMoney(netSpend / elapsedShare) : roundMoney(netSpend);
  const paceDelta = roundMoney(netSpend - expectedByToday);
  return {
    ...summary,
    spent: roundMoney(summary.spent),
    refunds: roundMoney(summary.refunds),
    ignoredSpend: roundMoney(summary.ignoredSpend),
    netSpend,
    expectedByToday,
    projectedMonthEnd,
    budgetRemaining: roundMoney(summary.budget - netSpend),
    paceDelta,
    status: statusFromPace({
      netSpend,
      budget: summary.budget,
      expectedByToday,
      projectedMonthEnd,
    }),
  };
}

function addCompletenessFinding(
  target: string[],
  finding: string,
): void {
  if (!target.includes(finding)) {
    target.push(finding);
  }
}

export function buildRetirementSpendingBudgetPlan(
  spending: SpendingData,
  options: {
    month: string;
    createdAtIso?: string;
  },
): SpendingBudgetPlan {
  const categories = [
    {
      id: 'essential',
      name: 'Essential',
      kind: 'essential',
      monthlyBudget: spending.essentialMonthly,
      basis: 'retirement_seed',
      assumptionSource: 'SeedData.spending.essentialMonthly',
    },
    {
      id: 'optional',
      name: 'Optional',
      kind: 'flexible',
      monthlyBudget: spending.optionalMonthly,
      basis: 'retirement_seed',
      assumptionSource: 'SeedData.spending.optionalMonthly',
    },
    {
      id: 'taxes_insurance',
      name: 'Taxes + insurance',
      kind: 'taxes_insurance',
      monthlyBudget: spending.annualTaxesInsurance / 12,
      basis: 'retirement_seed',
      assumptionSource: 'SeedData.spending.annualTaxesInsurance / 12',
    },
    {
      id: 'travel',
      name: 'Travel',
      kind: 'travel',
      monthlyBudget: spending.travelEarlyRetirementAnnual / 12,
      basis: 'retirement_seed',
      assumptionSource: 'SeedData.spending.travelEarlyRetirementAnnual / 12',
    },
  ] satisfies SpendingBudgetCategory[];
  const roundedCategories: SpendingBudgetCategory[] = categories.map((category) => ({
    ...category,
    monthlyBudget: roundMoney(category.monthlyBudget),
  }));

  return {
    month: options.month,
    createdAtIso: options.createdAtIso,
    categories: roundedCategories,
    monthlyBudget: roundMoney(
      roundedCategories.reduce((total, category) => total + category.monthlyBudget, 0),
    ),
    basis: 'retirement_seed',
    assumptionSource: 'Current retirement spending seed categories',
  };
}

export function buildSpendingMonthSummary(
  input: BuildSpendingMonthSummaryInput,
): SpendingMonthSummary {
  const asOfIso = input.asOfIso ?? new Date().toISOString();
  const month = input.month ?? input.budgetPlan.month ?? monthKeyFromIsoDate(asOfIso);
  const daysInMonth = daysInMonthKey(month);
  const dayOfMonth = monthProgressDay(month, asOfIso);
  const elapsedShare = daysInMonth > 0 ? dayOfMonth / daysInMonth : 0;
  const categoryBudgetTotal = roundMoney(
    input.budgetPlan.categories.reduce((total, category) => total + category.monthlyBudget, 0),
  );
  const monthlyBudget = roundMoney(input.budgetPlan.monthlyBudget);
  const categoryBudgetGap = roundMoney(monthlyBudget - categoryBudgetTotal);

  const missingInputs: string[] = [];
  const inferredAssumptions: string[] = [];
  let explicitInputCount = 0;
  let reconstructedInputCount = 0;

  if (input.budgetPlan.basis === 'inferred' || input.budgetPlan.basis === 'trailing_average') {
    addCompletenessFinding(
      inferredAssumptions,
      `budgetPlan.monthlyBudget(${input.budgetPlan.basis})`,
    );
    reconstructedInputCount += 1;
  } else {
    explicitInputCount += 1;
  }

  if (Math.abs(categoryBudgetGap) >= 0.01) {
    addCompletenessFinding(
      inferredAssumptions,
      `budgetPlan.monthlyBudget differs from category total by ${categoryBudgetGap.toFixed(2)}`,
    );
    reconstructedInputCount += 1;
  }

  const categoryById = new Map(
    input.budgetPlan.categories.map((category) => [category.id, category]),
  );
  const summaries = new Map<string, SpendingCategorySummary>();
  input.budgetPlan.categories.forEach((category) => {
    explicitInputCount += 1;
    if (category.basis === 'inferred' || category.basis === 'trailing_average') {
      addCompletenessFinding(
        inferredAssumptions,
        `budgetPlan.categories.${category.id}.monthlyBudget(${category.basis})`,
      );
      reconstructedInputCount += 1;
    }
    summaries.set(category.id, emptyCategorySummary(category, category.id));
  });

  let grossSpend = 0;
  let refunds = 0;
  let ignoredSpend = 0;
  let transactionCount = 0;
  let includedTransactionCount = 0;
  let ignoredTransactionCount = 0;

  input.transactions
    .filter((transaction) => spendingTransactionMonthKey(transaction) === month)
    .forEach((transaction) => {
      transactionCount += 1;
      explicitInputCount += 1;

      if (!transaction.source?.sourceId) {
        addCompletenessFinding(missingInputs, `transactions.${transaction.id}.source.sourceId`);
        reconstructedInputCount += 1;
      }

      const classificationMethod =
        transaction.classificationMethod ??
        (transaction.categoryId ? 'explicit' : 'uncategorized');
      if (!transaction.classificationMethod) {
        addCompletenessFinding(
          inferredAssumptions,
          `transactions.${transaction.id}.classificationMethod(defaulted)`,
        );
        reconstructedInputCount += 1;
      }
      if (classificationMethod === 'inferred' || classificationMethod === 'uncategorized') {
        addCompletenessFinding(
          inferredAssumptions,
          `transactions.${transaction.id}.category(${classificationMethod})`,
        );
        reconstructedInputCount += 1;
      }

      const categoryId = transaction.categoryId ?? UNCATEGORIZED_CATEGORY_ID;
      const category = categoryById.get(categoryId);
      if (!transaction.categoryId) {
        addCompletenessFinding(missingInputs, `transactions.${transaction.id}.categoryId`);
      }
      if (!category && categoryId !== UNCATEGORIZED_CATEGORY_ID) {
        addCompletenessFinding(
          inferredAssumptions,
          `budgetPlan.categories.${categoryId}(missing; budget=0)`,
        );
        reconstructedInputCount += 1;
      }

      if (!summaries.has(categoryId)) {
        summaries.set(categoryId, emptyCategorySummary(category, categoryId));
      }
      const summary = summaries.get(categoryId);
      if (!summary) return;

      const categoryExcluded = category?.includeInBudget === false || category?.kind === 'ignore';
      const transactionIgnored =
        transaction.ignored === true || categoryExcluded || categoryId === 'ignored';

      summary.transactionCount += 1;
      if (transactionIgnored) {
        ignoredTransactionCount += 1;
        summary.ignoredTransactionCount += 1;
        if (transaction.amount > 0) {
          ignoredSpend += transaction.amount;
          summary.ignoredSpend += transaction.amount;
        }
        return;
      }

      includedTransactionCount += 1;
      summary.includedTransactionCount += 1;
      if (transaction.amount >= 0) {
        grossSpend += transaction.amount;
        summary.spent += transaction.amount;
      } else {
        const credit = Math.abs(transaction.amount);
        refunds += credit;
        summary.refunds += credit;
      }
    });

  const categories = Array.from(summaries.values())
    .map((summary) => finalizeCategorySummary(summary, elapsedShare))
    .sort((left, right) => {
      const leftIndex = input.budgetPlan.categories.findIndex((category) => category.id === left.categoryId);
      const rightIndex = input.budgetPlan.categories.findIndex((category) => category.id === right.categoryId);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
          (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
      }
      return left.name.localeCompare(right.name);
    });

  const netSpend = roundMoney(grossSpend - refunds);
  const expectedByToday = roundMoney(monthlyBudget * elapsedShare);
  const projectedMonthEnd =
    elapsedShare > 0 ? roundMoney(netSpend / elapsedShare) : roundMoney(netSpend);
  const paceDelta = roundMoney(netSpend - expectedByToday);
  const modelCompleteness: SpendingModelCompleteness = {
    indicator: missingInputs.length || inferredAssumptions.length ? 'reconstructed' : 'faithful',
    missingInputs: unique(missingInputs),
    inferredAssumptions: unique(inferredAssumptions),
    explicitInputCount,
    reconstructedInputCount,
  };

  return {
    month,
    asOfIso,
    dayOfMonth,
    daysInMonth,
    percentMonthElapsed: roundRatio(elapsedShare * 100),
    monthlyBudget,
    expectedByToday,
    grossSpend: roundMoney(grossSpend),
    refunds: roundMoney(refunds),
    ignoredSpend: roundMoney(ignoredSpend),
    netSpend,
    projectedMonthEnd,
    budgetRemaining: roundMoney(monthlyBudget - netSpend),
    paceDelta,
    status: statusFromPace({
      netSpend,
      budget: monthlyBudget,
      expectedByToday,
      projectedMonthEnd,
    }),
    categories,
    transactionCount,
    includedTransactionCount,
    ignoredTransactionCount,
    modelCompleteness,
    intermediateCalculations: {
      elapsedShare: roundRatio(elapsedShare),
      categoryBudgetTotal,
      categoryBudgetGap,
      grossIncludedDebits: roundMoney(grossSpend),
      includedCredits: roundMoney(refunds),
      ignoredDebits: roundMoney(ignoredSpend),
    },
  };
}
