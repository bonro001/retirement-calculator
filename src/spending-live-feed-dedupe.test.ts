import { describe, expect, it } from 'vitest';
import type { SpendingTransaction } from './spending-ledger';
import { dedupeOverlappingLiveFeedTransactions } from './spending-live-feed-dedupe';

function tx(
  input: Partial<SpendingTransaction> & Pick<SpendingTransaction, 'id' | 'postedDate' | 'merchant' | 'amount'>,
): SpendingTransaction {
  return {
    currency: 'USD',
    ignored: false,
    tags: [],
    linkedTransactionIds: [],
    ...input,
  };
}

describe('dedupeOverlappingLiveFeedTransactions', () => {
  it('suppresses a live card alert when it matches a CSV transaction date', () => {
    const transactions = dedupeOverlappingLiveFeedTransactions([
      tx({
        id: 'csv-whole-foods',
        postedDate: '2026-05-07',
        transactionDate: '2026-05-06',
        merchant: 'WHOLEFDS DOM # 10316',
        amount: 60.76,
        source: { source: 'credit_card_csv', sourceId: 'csv:1', confidence: 0.98 },
      }),
      tx({
        id: 'email-whole-foods',
        postedDate: '2026-05-06',
        merchant: 'WHOLEFDS DOM # 10316',
        amount: 60.76,
        source: { source: 'credit_card_email', sourceId: 'email:1', confidence: 0.92 },
      }),
    ]);

    expect(transactions.map((transaction) => transaction.id)).toEqual([
      'csv-whole-foods',
    ]);
  });

  it('keeps a same-day live alert when no matching CSV transaction exists', () => {
    const transactions = dedupeOverlappingLiveFeedTransactions([
      tx({
        id: 'csv-amazon',
        postedDate: '2026-05-07',
        transactionDate: '2026-05-07',
        merchant: 'AMAZON MKTPL*BF5NY60H2',
        amount: 12.42,
        source: { source: 'credit_card_csv', sourceId: 'csv:1', confidence: 0.98 },
      }),
      tx({
        id: 'email-hp',
        postedDate: '2026-05-07',
        merchant: 'HP *INSTANT INK',
        amount: 5.94,
        source: { source: 'credit_card_email', sourceId: 'email:1', confidence: 0.92 },
      }),
      tx({
        id: 'email-disney',
        postedDate: '2026-05-07',
        merchant: 'Disney Plus',
        amount: 35.63,
        source: { source: 'credit_card_email', sourceId: 'email:2', confidence: 0.92 },
      }),
    ]);

    expect(transactions.map((transaction) => transaction.id)).toEqual([
      'csv-amazon',
      'email-hp',
      'email-disney',
    ]);
  });

  it('does not collapse unrelated merchants with the same amount', () => {
    const transactions = dedupeOverlappingLiveFeedTransactions([
      tx({
        id: 'csv-amazon',
        postedDate: '2026-05-06',
        transactionDate: '2026-05-05',
        merchant: 'AMAZON MKTPL*BV7SA84B1',
        amount: 97.41,
        source: { source: 'credit_card_csv', sourceId: 'csv:1', confidence: 0.98 },
      }),
      tx({
        id: 'email-dsw',
        postedDate: '2026-05-08',
        merchant: 'DSW',
        amount: 97.41,
        source: { source: 'credit_card_email', sourceId: 'email:1', confidence: 0.92 },
      }),
    ]);

    expect(transactions.map((transaction) => transaction.id)).toEqual([
      'csv-amazon',
      'email-dsw',
    ]);
  });

  it('suppresses matched Chase alerts that are one date off from CSV posting', () => {
    const transactions = dedupeOverlappingLiveFeedTransactions([
      tx({
        id: 'csv-amazon',
        postedDate: '2026-05-03',
        transactionDate: '2026-05-02',
        merchant: 'AMAZON MKTPL*BJ0NT35F1',
        amount: 411.34,
        source: { source: 'credit_card_csv', sourceId: 'csv:1', confidence: 0.98 },
      }),
      tx({
        id: 'email-amazon',
        postedDate: '2026-05-01',
        merchant: 'AMAZON MKTPLACE PMTS',
        amount: 411.34,
        source: { source: 'credit_card_email', sourceId: 'email:1', confidence: 0.92 },
      }),
    ]);

    expect(transactions.map((transaction) => transaction.id)).toEqual([
      'csv-amazon',
    ]);
  });

  it('uses the merchant field instead of full alert prose for merchant matches', () => {
    const transactions = dedupeOverlappingLiveFeedTransactions([
      tx({
        id: 'csv-foreflight',
        postedDate: '2026-05-03',
        transactionDate: '2026-05-03',
        merchant: 'FOREFLIGHT LLC',
        amount: 138.58,
        source: { source: 'credit_card_csv', sourceId: 'csv:1', confidence: 0.98 },
      }),
      tx({
        id: 'email-foreflight',
        postedDate: '2026-05-03',
        merchant: 'FOREFLIGHT LLC',
        description: 'You made a $138.58 transaction with FOREFLIGHT LLC.',
        amount: 138.58,
        source: { source: 'credit_card_email', sourceId: 'email:1', confidence: 0.92 },
      }),
    ]);

    expect(transactions.map((transaction) => transaction.id)).toEqual([
      'csv-foreflight',
    ]);
  });
});
