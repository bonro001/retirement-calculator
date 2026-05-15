import type { SeedData } from './types';
import type {
  SpendingBudgetPlan,
  SpendingMonthSummary,
  SpendingTransaction,
} from './spending-ledger';
import {
  buildRetirementSpendingBudgetPlan,
  buildSpendingMonthSummary,
  monthKeyFromIsoDate,
  spendingTransactionMonthKey,
} from './spending-ledger';
import {
  annualEscrowBudgetFromPlan,
  annualEscrowSpendFromCategories,
  enhanceBudgetPlanWithOperatingBuckets,
  isYearlySpendingCategoryId,
  monthlyOperatingBudgetAfterAnnualEscrow,
  monthlyOperatingSpendFromCategories,
} from './spending-budget-policy';

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

function monthKeysThrough(date: Date): string[] {
  const year = date.getFullYear();
  const currentMonth = date.getMonth() + 1;
  return Array.from({ length: currentMonth }, (_, index) => {
    const month = index + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  });
}

export interface SixPackSpendingContext {
  budgetPlan: SpendingBudgetPlan;
  summary: SpendingMonthSummary;
  monthlyOperatingBudget: number;
  monthlyOperatingSpent: number;
  monthlyOperatingProjected: number;
  annualEscrowPlannedBudget: number;
  annualEscrowActualSpend: number;
  annualEscrowAdaptiveBudget: number;
  annualRequiredBudget: number;
  annualRequiredSpend: number;
  annualOptionalBudget: number;
  annualOptionalSpend: number;
  annualTotalBudget: number;
  annualTotalSpend: number;
  annualTravelBudget: number;
  annualTravelSpend: number;
  annualOtherSpend: number;
  transactionCount: number;
  ledgerStatus: 'loaded' | 'missing' | 'error' | 'demo';
}

const REQUIRED_CATEGORY_IDS = new Set(['essential']);
const OPTIONAL_CATEGORY_IDS = new Set(['optional']);
const EXCLUDED_ANNUAL_CATEGORY_IDS = new Set(['ignored', 'long_term_items']);

function transactionBudgetCategoryId(transaction: SpendingTransaction): string {
  return transaction.categoryId ?? 'uncategorized';
}

function isIncludedAnnualTransaction(
  transaction: SpendingTransaction,
  budgetPlan: SpendingBudgetPlan,
): boolean {
  if (transaction.ignored === true) return false;
  const categoryId = transactionBudgetCategoryId(transaction);
  if (EXCLUDED_ANNUAL_CATEGORY_IDS.has(categoryId)) return false;
  const category = budgetPlan.categories.find((candidate) => candidate.id === categoryId);
  return category?.kind !== 'ignore' && category?.includeInBudget !== false;
}

function annualTransactionSpend(input: {
  transactions: SpendingTransaction[];
  budgetPlan: SpendingBudgetPlan;
  asOf: Date;
  includeCategoryId: (categoryId: string) => boolean;
}): number {
  const ytdMonthKeySet = new Set(monthKeysThrough(input.asOf));
  return roundMoney(
    input.transactions
      .filter((transaction) => ytdMonthKeySet.has(spendingTransactionMonthKey(transaction)))
      .filter((transaction) => isIncludedAnnualTransaction(transaction, input.budgetPlan))
      .filter((transaction) => input.includeCategoryId(transactionBudgetCategoryId(transaction)))
      .reduce((total, transaction) => total + transaction.amount, 0),
  );
}

export function buildSixPackSpendingContext(input: {
  data: SeedData;
  transactions: SpendingTransaction[];
  asOfIso: string;
  ledgerStatus?: SixPackSpendingContext['ledgerStatus'];
}): SixPackSpendingContext {
  const asOf = new Date(input.asOfIso);
  const month = monthKeyFromIsoDate(input.asOfIso);
  const budgetPlan = enhanceBudgetPlanWithOperatingBuckets(
    buildRetirementSpendingBudgetPlan(input.data.spending, {
      month,
      createdAtIso: input.asOfIso,
    }),
  );
  const summary = buildSpendingMonthSummary({
    budgetPlan,
    transactions: input.transactions,
    month,
    asOfIso: input.asOfIso,
  });

  const ytdSummaries = monthKeysThrough(asOf).map((monthKey) =>
    buildSpendingMonthSummary({
      budgetPlan,
      transactions: input.transactions,
      month: monthKey,
      asOfIso: input.asOfIso,
    }),
  );
  const annualEscrowPlannedBudget = annualEscrowBudgetFromPlan(budgetPlan);
  const annualEscrowActualSpend = roundMoney(
    ytdSummaries.reduce(
      (total, monthSummary) =>
        total + annualEscrowSpendFromCategories(monthSummary.categories),
      0,
    ),
  );
  const annualRequiredBudget = roundMoney(input.data.spending.essentialMonthly * 12);
  const annualOptionalBudget = roundMoney(input.data.spending.optionalMonthly * 12);
  const annualTotalBudget = roundMoney(annualRequiredBudget + annualOptionalBudget);
  const annualTravelBudget = roundMoney(
    budgetPlan.categories
      .filter((category) => category.id === 'travel')
      .reduce((total, category) => total + category.monthlyBudget * 12, 0),
  );
  const annualRequiredSpend = annualTransactionSpend({
    transactions: input.transactions,
    budgetPlan,
    asOf,
    includeCategoryId: (categoryId) => REQUIRED_CATEGORY_IDS.has(categoryId),
  });
  const annualTotalSpend = annualTransactionSpend({
    transactions: input.transactions,
    budgetPlan,
    asOf,
    includeCategoryId: (categoryId) =>
      REQUIRED_CATEGORY_IDS.has(categoryId) || OPTIONAL_CATEGORY_IDS.has(categoryId),
  });
  const annualTravelSpend = annualTransactionSpend({
    transactions: input.transactions,
    budgetPlan,
    asOf,
    includeCategoryId: (categoryId) => categoryId === 'travel',
  });
  const annualOptionalSpend = annualTransactionSpend({
    transactions: input.transactions,
    budgetPlan,
    asOf,
    includeCategoryId: (categoryId) => OPTIONAL_CATEGORY_IDS.has(categoryId),
  });
  const annualOtherSpend = roundMoney(
    annualTransactionSpend({
      transactions: input.transactions,
      budgetPlan,
      asOf,
      includeCategoryId: () => true,
    }) -
      annualRequiredSpend -
      annualOptionalSpend,
  );
  const annualEscrowAdaptiveBudget = Math.max(
    annualEscrowPlannedBudget,
    annualEscrowActualSpend,
  );
  const monthlyOperatingBudget = monthlyOperatingBudgetAfterAnnualEscrow({
    budgetPlan,
    annualEscrowBudget: annualEscrowAdaptiveBudget,
  });
  const monthlyOperatingSpent = monthlyOperatingSpendFromCategories(summary.categories);
  const elapsedShare = Math.max(summary.intermediateCalculations.elapsedShare, 1 / summary.daysInMonth);
  const monthlyOperatingProjected = roundMoney(monthlyOperatingSpent / elapsedShare);

  return {
    budgetPlan,
    summary,
    monthlyOperatingBudget,
    monthlyOperatingSpent,
    monthlyOperatingProjected,
    annualEscrowPlannedBudget,
    annualEscrowActualSpend,
    annualEscrowAdaptiveBudget,
    annualRequiredBudget,
    annualRequiredSpend,
    annualOptionalBudget,
    annualOptionalSpend,
    annualTotalBudget,
    annualTotalSpend,
    annualTravelBudget,
    annualTravelSpend,
    annualOtherSpend,
    transactionCount: input.transactions.length,
    ledgerStatus: input.ledgerStatus ?? (input.transactions.length ? 'loaded' : 'missing'),
  };
}
