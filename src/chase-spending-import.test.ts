import { describe, expect, it } from 'vitest';
import {
  importChaseActivityCsv,
  mergeSpendingImportTransactions,
} from './chase-spending-import';

const SAMPLE = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
05/07/2026,05/07/2026,AMAZON MKTPL*BF5NY60H2,Shopping,Sale,-12.42,
05/06/2026,05/07/2026,WHOLEFDS DOM # 10316,Groceries,Sale,-60.76,
05/05/2026,05/06/2026,BSWHEALTH 2401,Health & Wellness,Return,125.47,
05/01/2026,05/02/2026,Payment Thank You Bill Pa,,Payment,500.00,
05/01/2026,05/02/2026,MYSTERY SHOP,,Sale,-9.99,
`;

describe('Chase spending import', () => {
  it('normalizes Chase signs and categories into spending ledger transactions', () => {
    const result = importChaseActivityCsv(SAMPLE, {
      fileName: 'Chase4582_Activity.csv',
      accountId: 'chase-4582',
      importedAtIso: '2026-05-08T12:00:00Z',
    });

    expect(result.issues).toEqual([]);
    expect(result.transactions).toHaveLength(5);

    const amazon = result.transactions.find((transaction) =>
      transaction.merchant.includes('AMAZON'),
    );
    expect(amazon?.amount).toBe(12.42);
    expect(amazon?.categoryId).toBe('amazon_uncategorized');
    expect(amazon?.classificationMethod).toBe('inferred');
    expect(amazon?.tags).toContain('needs_item_data');

    const grocery = result.transactions.find((transaction) =>
      transaction.merchant.includes('WHOLEFDS'),
    );
    expect(grocery?.amount).toBe(60.76);
    expect(grocery?.categoryId).toBe('essential');

    const refund = result.transactions.find((transaction) =>
      transaction.merchant.includes('BSWHEALTH'),
    );
    expect(refund?.amount).toBe(-125.47);
    expect(refund?.categoryId).toBe('health');

    const payment = result.transactions.find((transaction) =>
      transaction.merchant.includes('Payment'),
    );
    expect(payment?.ignored).toBe(true);
    expect(payment?.categoryId).toBe('ignored');

    const mystery = result.transactions.find((transaction) =>
      transaction.merchant.includes('MYSTERY'),
    );
    expect(mystery?.categoryId).toBe('uncategorized');
    expect(mystery?.classificationMethod).toBe('uncategorized');
  });

  it('merges multiple imports into reverse-post-date order', () => {
    const first = importChaseActivityCsv(SAMPLE, {
      fileName: 'first.csv',
      accountId: 'chase-4582',
      importedAtIso: '2026-05-08T12:00:00Z',
    });
    const second = importChaseActivityCsv(
      `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
04/01/2026,04/02/2026,H-E-B #024,Groceries,Sale,-30.00,
`,
      {
        fileName: 'second.csv',
        accountId: 'chase-4582',
        importedAtIso: '2026-05-08T12:00:00Z',
      },
    );

    const merged = mergeSpendingImportTransactions([second, first]);
    expect(merged).toHaveLength(6);
    expect(merged[0].postedDate).toBe('2026-05-07');
    expect(merged[merged.length - 1].postedDate).toBe('2026-04-02');
  });
});
