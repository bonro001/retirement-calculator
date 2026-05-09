import type { SpendingTransaction } from './spending-ledger';

function normalizeMerchantForDedupe(value: string): string {
  const compact = value
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/\bpmts?\b/g, '')
    .replace(/\bmktpl(?:ace)?\b/g, '')
    .replace(/\bdom\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

  if (compact.includes('amazon')) return 'amazon';
  if (compact.includes('samsclub')) return 'samsclub';
  if (compact.includes('heb')) return 'heb';
  return compact;
}

function amountMatches(left: SpendingTransaction, right: SpendingTransaction): boolean {
  return (
    Math.sign(left.amount) === Math.sign(right.amount) &&
    Math.abs(Math.abs(left.amount) - Math.abs(right.amount)) < 0.005
  );
}

function transactionDateCandidates(transaction: SpendingTransaction): Set<string> {
  return new Set(
    [transaction.postedDate, transaction.transactionDate].filter(
      (value): value is string => Boolean(value),
    ),
  );
}

function isoDayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
      86_400_000,
  );
}

function dateMatches(left: SpendingTransaction, right: SpendingTransaction): boolean {
  const leftDates = transactionDateCandidates(left);
  const rightDates = transactionDateCandidates(right);
  for (const date of leftDates) {
    if (rightDates.has(date)) return true;
    const leftDay = isoDayNumber(date);
    if (leftDay === null) continue;
    for (const rightDate of rightDates) {
      const rightDay = isoDayNumber(rightDate);
      if (rightDay !== null && Math.abs(leftDay - rightDay) <= 1) {
        return true;
      }
    }
  }
  return false;
}

function merchantMatches(left: SpendingTransaction, right: SpendingTransaction): boolean {
  const leftMerchant = normalizeMerchantForDedupe(left.merchant);
  const rightMerchant = normalizeMerchantForDedupe(right.merchant);
  if (!leftMerchant || !rightMerchant) return true;
  return (
    leftMerchant === rightMerchant ||
    leftMerchant.includes(rightMerchant) ||
    rightMerchant.includes(leftMerchant)
  );
}

function matchesCsvCardTransaction(
  transaction: SpendingTransaction,
  cardCsvTransactions: SpendingTransaction[],
): boolean {
  return cardCsvTransactions.some(
    (cardTransaction) =>
      amountMatches(transaction, cardTransaction) &&
      dateMatches(transaction, cardTransaction) &&
      merchantMatches(transaction, cardTransaction),
  );
}

function isCsvCardTransaction(transaction: SpendingTransaction): boolean {
  return transaction.source?.source === 'credit_card_csv';
}

function isAmazonEmailEvidenceTransaction(
  transaction: SpendingTransaction,
): boolean {
  return (
    transaction.source?.source === 'amazon_order_email' ||
    transaction.source?.source === 'amazon_refund_email'
  );
}

function isLiveCardFeedTransaction(transaction: SpendingTransaction): boolean {
  return (
    transaction.source?.source === 'credit_card_email' ||
    transaction.source?.source === 'refund_email'
  );
}

export function dedupeOverlappingLiveFeedTransactions(
  transactions: SpendingTransaction[],
): SpendingTransaction[] {
  const cardCsvTransactions = transactions
    .filter(isCsvCardTransaction)
    .filter((transaction) => !transaction.ignored);
  const byId = new Map<string, SpendingTransaction>();

  transactions.forEach((transaction) => {
    if (
      cardCsvTransactions.length > 0 &&
      isAmazonEmailEvidenceTransaction(transaction)
    ) {
      return;
    }
    if (
      isLiveCardFeedTransaction(transaction) &&
      matchesCsvCardTransaction(transaction, cardCsvTransactions)
    ) {
      return;
    }
    if (!byId.has(transaction.id)) {
      byId.set(transaction.id, transaction);
    }
  });

  return Array.from(byId.values());
}
