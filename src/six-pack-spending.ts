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
} from './spending-ledger';
import {
  annualEscrowBudgetFromPlan,
  annualEscrowSpendFromCategories,
  enhanceBudgetPlanWithOperatingBuckets,
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
  transactionCount: number;
  ledgerStatus: 'loaded' | 'missing' | 'error' | 'demo';
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
    transactionCount: input.transactions.length,
    ledgerStatus: input.ledgerStatus ?? (input.transactions.length ? 'loaded' : 'missing'),
  };
}
