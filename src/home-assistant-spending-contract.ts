import type {
  SpendingMonthSummary,
  SpendingModelCompletenessIndicator,
  SpendingPaceStatus,
} from './spending-ledger';

export interface HomeAssistantSpendingCategoryPayload {
  id: string;
  name: string;
  budget: number;
  spent: number;
  refunds: number;
  netSpend: number;
  projected: number;
  percentSpent: number;
  status: SpendingPaceStatus;
}

export interface HomeAssistantMonthlyBudgetPayload {
  month: string;
  asOf: string;
  monthlyBudget: number;
  spent: number;
  refunds: number;
  ignoredSpend: number;
  expectedByToday: number;
  projectedMonthEnd: number;
  percentSpent: number;
  percentMonthElapsed: number;
  budgetRemaining: number;
  paceDelta: number;
  status: SpendingPaceStatus;
  modelCompleteness: SpendingModelCompletenessIndicator;
  missingInputs: string[];
  inferredAssumptions: string[];
  transactionCount: number;
  categories: HomeAssistantSpendingCategoryPayload[];
}

export interface HomeAssistantTransactionClassificationRequest {
  transactionId: string;
  categoryId: string;
  source: 'home_assistant';
  ignored?: boolean;
  note?: string;
}

function percentOf(value: number, total: number): number {
  if (total <= 0) return value > 0 ? 100 : 0;
  return Math.round((value / total) * 10000) / 100;
}

export function buildHomeAssistantMonthlyBudgetPayload(
  summary: SpendingMonthSummary,
): HomeAssistantMonthlyBudgetPayload {
  return {
    month: summary.month,
    asOf: summary.asOfIso,
    monthlyBudget: summary.monthlyBudget,
    spent: summary.netSpend,
    refunds: summary.refunds,
    ignoredSpend: summary.ignoredSpend,
    expectedByToday: summary.expectedByToday,
    projectedMonthEnd: summary.projectedMonthEnd,
    percentSpent: percentOf(summary.netSpend, summary.monthlyBudget),
    percentMonthElapsed: summary.percentMonthElapsed,
    budgetRemaining: summary.budgetRemaining,
    paceDelta: summary.paceDelta,
    status: summary.status,
    modelCompleteness: summary.modelCompleteness.indicator,
    missingInputs: summary.modelCompleteness.missingInputs,
    inferredAssumptions: summary.modelCompleteness.inferredAssumptions,
    transactionCount: summary.transactionCount,
    categories: summary.categories.map((category) => ({
      id: category.categoryId,
      name: category.name,
      budget: category.budget,
      spent: category.spent,
      refunds: category.refunds,
      netSpend: category.netSpend,
      projected: category.projectedMonthEnd,
      percentSpent: percentOf(category.netSpend, category.budget),
      status: category.status,
    })),
  };
}
