import type { SpendingTransaction } from './spending-ledger';
import {
  AMAZON_UNKNOWN_CATEGORY_ID,
  LONG_TERM_ITEMS_CATEGORY_ID,
} from './spending-budget-policy';

export const AMAZON_REQUIRED_SHARE = 0.3;
export const LARGE_TRANSACTION_THRESHOLD = 1_000;

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

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

export function splitAmazonCreditCardTransactionsForBudget(
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

export function applySpendingCategoryInferences(
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
      categoryConfidence: Math.max(transaction.categoryConfidence ?? 0, inference.confidence),
      classificationMethod:
        transaction.classificationMethod === 'manual' ? 'manual' : 'inferred',
      tags: Array.from(new Set([...(transaction.tags ?? []), inference.tag])),
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
