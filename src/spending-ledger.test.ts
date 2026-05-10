import { describe, expect, it } from 'vitest';
import { buildHomeAssistantMonthlyBudgetPayload } from './home-assistant-spending-contract';
import {
  buildRetirementSpendingBudgetPlan,
  buildSpendingMonthSummary,
  type SpendingBudgetPlan,
  type SpendingTransaction,
} from './spending-ledger';

const source = {
  source: 'credit_card_email',
  sourceId: 'email-1',
  confidence: 0.99,
} as const;

function transaction(input: Partial<SpendingTransaction> & Pick<SpendingTransaction, 'id' | 'postedDate' | 'amount'>): SpendingTransaction {
  return {
    merchant: 'Test Merchant',
    currency: 'USD',
    categoryId: 'optional',
    classificationMethod: 'manual',
    source,
    ...input,
  };
}

describe('spending ledger month summary', () => {
  it('tracks spending pace with refunds and ignored transactions separated', () => {
    const budgetPlan: SpendingBudgetPlan = {
      month: '2026-05',
      monthlyBudget: 1_550,
      basis: 'manual',
      categories: [
        {
          id: 'essential',
          name: 'Essential',
          kind: 'essential',
          monthlyBudget: 900,
          basis: 'manual',
        },
        {
          id: 'optional',
          name: 'Optional',
          kind: 'flexible',
          monthlyBudget: 400,
          basis: 'manual',
        },
        {
          id: 'travel',
          name: 'Travel',
          kind: 'travel',
          monthlyBudget: 250,
          basis: 'manual',
        },
      ],
    };

    const summary = buildSpendingMonthSummary({
      budgetPlan,
      asOfIso: '2026-05-08T12:00:00-05:00',
      transactions: [
        transaction({ id: 't1', postedDate: '2026-05-02', amount: 100 }),
        transaction({ id: 't2', postedDate: '2026-05-03', amount: -25 }),
        transaction({
          id: 't3',
          postedDate: '2026-05-04',
          amount: 250,
          categoryId: 'travel',
        }),
        transaction({ id: 't4', postedDate: '2026-05-05', amount: 30, ignored: true }),
        transaction({ id: 'outside', postedDate: '2026-04-30', amount: 900 }),
      ],
    });

    expect(summary.transactionCount).toBe(4);
    expect(summary.includedTransactionCount).toBe(3);
    expect(summary.ignoredTransactionCount).toBe(1);
    expect(summary.grossSpend).toBe(350);
    expect(summary.refunds).toBe(25);
    expect(summary.ignoredSpend).toBe(30);
    expect(summary.netSpend).toBe(325);
    expect(summary.dayOfMonth).toBe(8);
    expect(summary.daysInMonth).toBe(31);
    expect(summary.expectedByToday).toBe(400);
    expect(summary.projectedMonthEnd).toBe(1259.38);
    expect(summary.modelCompleteness.indicator).toBe('faithful');

    const optional = summary.categories.find((category) => category.categoryId === 'optional');
    expect(optional?.spent).toBe(100);
    expect(optional?.refunds).toBe(25);
    expect(optional?.netSpend).toBe(75);
  });

  it('marks the model reconstructed when category or source evidence is missing', () => {
    const budgetPlan = buildRetirementSpendingBudgetPlan(
      {
        essentialMonthly: 4_800,
        optionalMonthly: 3_200,
        annualTaxesInsurance: 12_000,
        travelEarlyRetirementAnnual: 6_000,
      },
      { month: '2026-05' },
    );

    const summary = buildSpendingMonthSummary({
      budgetPlan,
      asOfIso: '2026-05-08T12:00:00-05:00',
      transactions: [
        {
          id: 'missing-category',
          postedDate: '2026-05-07',
          merchant: 'Mystery Charge',
          amount: 42,
          currency: 'USD',
        },
      ],
    });

    expect(summary.modelCompleteness.indicator).toBe('reconstructed');
    expect(summary.modelCompleteness.missingInputs).toContain(
      'transactions.missing-category.categoryId',
    );
    expect(summary.modelCompleteness.missingInputs).toContain(
      'transactions.missing-category.source.sourceId',
    );
    expect(summary.modelCompleteness.inferredAssumptions).toContain(
      'transactions.missing-category.category(uncategorized)',
    );
    expect(summary.categories.some((category) => category.categoryId === 'uncategorized')).toBe(
      true,
    );
  });

  it('uses transactionDate for month membership when CSV posted later', () => {
    const budgetPlan: SpendingBudgetPlan = {
      month: '2026-05',
      monthlyBudget: 1_000,
      basis: 'manual',
      categories: [
        {
          id: 'optional',
          name: 'Optional',
          kind: 'flexible',
          monthlyBudget: 1_000,
          basis: 'manual',
        },
      ],
    };

    const summary = buildSpendingMonthSummary({
      budgetPlan,
      asOfIso: '2026-05-10T12:00:00-05:00',
      transactions: [
        transaction({
          id: 'may-transaction',
          postedDate: '2026-06-01',
          transactionDate: '2026-05-31',
          amount: 42,
        }),
        transaction({
          id: 'april-transaction',
          postedDate: '2026-05-01',
          transactionDate: '2026-04-30',
          amount: 900,
        }),
      ],
    });

    expect(summary.transactionCount).toBe(1);
    expect(summary.grossSpend).toBe(42);
  });

  it('emits the compact Home Assistant monthly payload', () => {
    const budgetPlan = buildRetirementSpendingBudgetPlan(
      {
        essentialMonthly: 1_000,
        optionalMonthly: 500,
        annualTaxesInsurance: 1_200,
        travelEarlyRetirementAnnual: 2_400,
      },
      { month: '2026-05' },
    );
    const summary = buildSpendingMonthSummary({
      budgetPlan,
      asOfIso: '2026-05-10T08:00:00-05:00',
      transactions: [
        transaction({ id: 'grocery', postedDate: '2026-05-01', amount: 250, categoryId: 'essential' }),
        transaction({ id: 'refund', postedDate: '2026-05-02', amount: -50, categoryId: 'essential' }),
      ],
    });

    const payload = buildHomeAssistantMonthlyBudgetPayload(summary);

    expect(payload.monthlyBudget).toBe(1_800);
    expect(payload.spent).toBe(200);
    expect(payload.percentSpent).toBe(11.11);
    expect(payload.percentMonthElapsed).toBe(32.2581);
    expect(payload.modelCompleteness).toBe('faithful');
    expect(payload.categories.find((category) => category.id === 'essential')?.projected).toBe(
      620,
    );
  });
});
