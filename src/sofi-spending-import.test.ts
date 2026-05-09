import { describe, expect, it } from 'vitest';
import {
  importSofiBankCsv,
  mergeSofiImportTransactions,
} from './sofi-spending-import';

const SAMPLE = `Date,Description,Type,Amount,Current balance,Status
2026-05-06,ATHENA,DIRECT_DEPOSIT,4176.69,51614.88,Posted
2026-05-04,CITI AUTOPAY,DIRECT_PAY,-35.51,47438.19,Posted
2026-05-01,To Escrow Vault,WITHDRAWAL,-1200.00,47473.7,Posted
2026-04-28,ONE GAS TEXAS PR,DIRECT_PAY,-56.96,52252.61,Posted
2026-04-21,City of Austin T,DIRECT_PAY,-277.61,48024.81,Posted
2026-04-09,DEPT EDUCATION,DIRECT_PAY,-292.29,48619.71,Posted
2026-04-28,Zelle® Payment to Michael Lipiner,ZELLE,-1100.00,0,Posted
2026-01-29,WINCO FOODS #138 231 NE,DEBIT_CARD,-25.32,-10.65,Posted
2026-01-15,SPECS #77,DEBIT_CARD,-8.54,145.65,Posted
2026-02-05,Check Paid,CHECK,-11950.6,549.44,Posted
`;

describe('SoFi bank import', () => {
  it('keeps cashflow evidence while excluding payroll, transfers, and CC payments from spend', () => {
    const result = importSofiBankCsv(SAMPLE, {
      fileName: 'SOFI-JointSavings.csv',
      accountId: 'sofi-9220',
      importedAtIso: '2026-05-08T12:00:00Z',
    });

    expect(result.issues).toEqual([]);
    expect(result.transactions).toHaveLength(10);

    const payroll = result.transactions.find((transaction) =>
      transaction.merchant.includes('ATHENA'),
    );
    expect(payroll?.amount).toBe(-4176.69);
    expect(payroll?.ignored).toBe(true);

    const cardPayment = result.transactions.find((transaction) =>
      transaction.merchant.includes('CITI'),
    );
    expect(cardPayment?.amount).toBe(35.51);
    expect(cardPayment?.ignored).toBe(true);
    expect(cardPayment?.tags).toContain('credit_card_payment');

    const vault = result.transactions.find((transaction) =>
      transaction.merchant.includes('Escrow'),
    );
    expect(vault?.ignored).toBe(true);

    const gas = result.transactions.find((transaction) =>
      transaction.merchant.includes('ONE GAS'),
    );
    expect(gas?.amount).toBe(56.96);
    expect(gas?.categoryId).toBe('essential');

    const education = result.transactions.find((transaction) =>
      transaction.merchant.includes('DEPT'),
    );
    expect(education?.categoryId).toBe('essential');
    expect(education?.tags).toContain('education_debt');

    const family = result.transactions.find((transaction) =>
      transaction.merchant.includes('Michael'),
    );
    expect(family?.categoryId).toBe('family_transfers');
    expect(family?.ignored).toBe(false);

    const grocery = result.transactions.find((transaction) =>
      transaction.merchant.includes('WINCO'),
    );
    expect(grocery?.categoryId).toBe('essential');

    const specs = result.transactions.find((transaction) =>
      transaction.merchant.includes('SPECS'),
    );
    expect(specs?.categoryId).toBe('optional');

    const check = result.transactions.find((transaction) =>
      transaction.merchant.includes('Check Paid'),
    );
    expect(check?.categoryId).toBe('uncategorized');
    expect(check?.classificationMethod).toBe('uncategorized');
  });

  it('merges imports in reverse-post-date order', () => {
    const first = importSofiBankCsv(SAMPLE, {
      fileName: 'savings.csv',
      accountId: 'sofi-9220',
      importedAtIso: '2026-05-08T12:00:00Z',
    });
    const second = importSofiBankCsv(
      `Date,Description,Type,Amount,Current balance,Status
2026-05-08,ATT,DIRECT_PAY,-147.13,100,Posted
`,
      {
        fileName: 'checking.csv',
        accountId: 'sofi-1882',
        importedAtIso: '2026-05-08T12:00:00Z',
      },
    );

    const merged = mergeSofiImportTransactions([first, second]);
    expect(merged).toHaveLength(11);
    expect(merged[0].postedDate).toBe('2026-05-08');
  });
});
