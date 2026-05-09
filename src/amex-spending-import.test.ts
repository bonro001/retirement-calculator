import { describe, expect, it } from 'vitest';
import {
  importAmexActivityCsv,
  mergeAmexImportTransactions,
} from './amex-spending-import';

const SAMPLE = `Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
03/26/2026,MOBILE PAYMENT - THANK YOU,ROB BONNER,-11000,-73.85,MOBILE PAYMENT - THANK YOU,MOBILE PAYMENT - THANK YOU,,,,,'320260850350164930',
03/06/2026,AMAZON MARKEPLACE NA PA,ROB BONNER,-11000,26.89,"5WVNVHYF4KZ MERCHANDISE
AMAZON MARKETPLACE NA PA
AMZN.COM/BILL",AMAZON MARKETPLACE NAMZN.COM/BILL       WA,410 TERRY AVE N,"SEATTLE
WA",98109,UNITED STATES,'320260660819889280',Merchandise & Supplies-Internet Purchase
02/25/2026,DELTA AIR LINES,ROB BONNER,-11000,410.00,DELTA AIR LINES,DELTA AIR LINES ATLANTA GA,,,,,'320260560000000000',Travel-Airline
02/14/2026,COSTCO,ROB BONNER,-11000,120.11,COSTCO,COSTCO WHOLESALE AUSTIN TX,,,,,'320260450000000000',Merchandise & Supplies-Wholesale Stores
02/12/2026,UNKNOWN,ROB BONNER,-11000,11.00,UNKNOWN,UNKNOWN,,,,,'320260430000000000',
`;

describe('Amex spending import', () => {
  it('normalizes Amex activity rows into spending ledger transactions', () => {
    const result = importAmexActivityCsv(SAMPLE, {
      fileName: 'activity.csv',
      accountId: 'amex-11000',
      importedAtIso: '2026-05-08T12:00:00Z',
    });

    expect(result.issues).toEqual([]);
    expect(result.transactions).toHaveLength(5);

    const payment = result.transactions.find((transaction) =>
      transaction.merchant.includes('PAYMENT'),
    );
    expect(payment?.amount).toBe(-73.85);
    expect(payment?.ignored).toBe(true);
    expect(payment?.categoryId).toBe('ignored');

    const amazon = result.transactions.find((transaction) =>
      transaction.merchant.includes('AMAZON'),
    );
    expect(amazon?.amount).toBe(26.89);
    expect(amazon?.categoryId).toBe('amazon_uncategorized');
    expect(amazon?.classificationMethod).toBe('inferred');

    const travel = result.transactions.find((transaction) =>
      transaction.merchant.includes('DELTA'),
    );
    expect(travel?.categoryId).toBe('travel');

    const wholesale = result.transactions.find((transaction) =>
      transaction.merchant.includes('COSTCO'),
    );
    expect(wholesale?.categoryId).toBe('essential');

    const unknown = result.transactions.find((transaction) =>
      transaction.merchant.includes('UNKNOWN'),
    );
    expect(unknown?.categoryId).toBe('uncategorized');
    expect(unknown?.classificationMethod).toBe('uncategorized');
  });

  it('dedupes overlapping exports by Amex reference number', () => {
    const first = importAmexActivityCsv(SAMPLE, {
      fileName: 'activity-1.csv',
      accountId: 'amex-11000',
      importedAtIso: '2026-05-08T12:00:00Z',
    });
    const second = importAmexActivityCsv(SAMPLE, {
      fileName: 'activity-2.csv',
      accountId: 'amex-11000',
      importedAtIso: '2026-05-08T12:00:00Z',
    });

    const merged = mergeAmexImportTransactions([first, second]);
    expect(merged).toHaveLength(5);
    expect(merged[0].postedDate).toBe('2026-03-26');
  });
});
