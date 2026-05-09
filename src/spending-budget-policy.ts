import type {
  SpendingBudgetCategory,
  SpendingBudgetPlan,
  SpendingCategorySummary,
} from './spending-ledger';

export const HEALTH_BUDGET_FROM_OPTIONAL = 650;
export const AMAZON_UNKNOWN_CATEGORY_ID = 'amazon_uncategorized';
export const LONG_TERM_ITEMS_CATEGORY_ID = 'long_term_items';
export const GENEROSITY_CATEGORY_ID = 'generosity';
export const YEARLY_SPENDING_CATEGORY_IDS = new Set(['travel', 'taxes_insurance']);

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export function isYearlySpendingCategoryId(categoryId: string): boolean {
  return YEARLY_SPENDING_CATEGORY_IDS.has(categoryId);
}

export function enhanceBudgetPlanWithOperatingBuckets(
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
        monthlyBudget: Math.max(0, category.monthlyBudget - HEALTH_BUDGET_FROM_OPTIONAL),
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

export function monthlyOperatingBudgetFromPlan(
  budgetPlan: SpendingBudgetPlan,
): number {
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

export function monthlyOperatingSpendFromCategories(
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

export function annualEscrowBudgetFromPlan(budgetPlan: SpendingBudgetPlan): number {
  return roundMoney(
    budgetPlan.categories
      .filter((category) => isYearlySpendingCategoryId(category.id))
      .reduce((total, category) => total + category.monthlyBudget * 12, 0),
  );
}

export function annualTargetFromPlan(budgetPlan: SpendingBudgetPlan): number {
  return roundMoney(budgetPlan.monthlyBudget * 12);
}

export function annualEscrowSpendFromCategories(
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

export function monthlyOperatingBudgetAfterAnnualEscrow(input: {
  budgetPlan: SpendingBudgetPlan;
  annualEscrowBudget: number;
}): number {
  const annualOperatingBudget =
    annualTargetFromPlan(input.budgetPlan) - input.annualEscrowBudget;
  return roundMoney(Math.max(0, annualOperatingBudget / 12));
}
