import fs from 'node:fs/promises';
import path from 'node:path';
import {
  importSofiBankCsv,
  mergeSofiImportTransactions,
} from '../src/sofi-spending-import';

interface CliOptions {
  inputFiles: string[];
  outFile: string;
}

function parseArgs(argv: string[]): CliOptions {
  const inputFiles: string[] = [];
  let outFile = 'public/local/spending-ledger.sofi.json';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      outFile = argv[index + 1] ?? outFile;
      index += 1;
    } else {
      inputFiles.push(arg);
    }
  }

  if (inputFiles.length === 0) {
    throw new Error(
      'Usage: node --import tsx scripts/import-sofi-spending.ts [--out public/local/spending-ledger.sofi.json] <csv...>',
    );
  }

  return { inputFiles, outFile };
}

function accountIdFromFile(filePath: string): string | undefined {
  const match = /•(\d+)-/.exec(path.basename(filePath));
  return match ? `sofi-${match[1]}` : undefined;
}

function summarizeByMonth(
  transactions: ReturnType<typeof mergeSofiImportTransactions>,
) {
  const byMonth = new Map<
    string,
    {
      transactionCount: number;
      spend: number;
      credits: number;
      ignoredCount: number;
      creditCardPaymentCount: number;
      payrollCount: number;
      familyTransferSpend: number;
      utilitySpend: number;
    }
  >();

  transactions.forEach((transaction) => {
    const month = transaction.postedDate.slice(0, 7);
    const summary =
      byMonth.get(month) ??
      {
        transactionCount: 0,
        spend: 0,
        credits: 0,
        ignoredCount: 0,
        creditCardPaymentCount: 0,
        payrollCount: 0,
        familyTransferSpend: 0,
        utilitySpend: 0,
      };
    summary.transactionCount += 1;
    if (transaction.tags?.includes('credit_card_payment')) {
      summary.creditCardPaymentCount += 1;
    }
    if (transaction.merchant === 'ATHENA') {
      summary.payrollCount += 1;
    }
    if (transaction.ignored) {
      summary.ignoredCount += 1;
    } else if (transaction.amount >= 0) {
      summary.spend += transaction.amount;
      if (transaction.categoryId === 'family_transfers') {
        summary.familyTransferSpend += transaction.amount;
      }
      if (transaction.tags?.includes('utility')) {
        summary.utilitySpend += transaction.amount;
      }
    } else {
      summary.credits += Math.abs(transaction.amount);
    }
    byMonth.set(month, summary);
  });

  return Object.fromEntries(
    Array.from(byMonth.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([month, summary]) => [
        month,
        {
          transactionCount: summary.transactionCount,
          spend: Math.round(summary.spend * 100) / 100,
          credits: Math.round(summary.credits * 100) / 100,
          ignoredCount: summary.ignoredCount,
          creditCardPaymentCount: summary.creditCardPaymentCount,
          payrollCount: summary.payrollCount,
          familyTransferSpend: Math.round(summary.familyTransferSpend * 100) / 100,
          utilitySpend: Math.round(summary.utilitySpend * 100) / 100,
        },
      ]),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const importedAtIso = new Date().toISOString();
  const imports = [];

  for (const filePath of options.inputFiles) {
    const csvText = await fs.readFile(filePath, 'utf8');
    imports.push(
      importSofiBankCsv(csvText, {
        fileName: path.basename(filePath),
        accountId: accountIdFromFile(filePath),
        importedAtIso,
      }),
    );
  }

  const transactions = mergeSofiImportTransactions(imports);
  const issues = imports.flatMap((result) =>
    result.issues.map((issue) => ({
      ...issue,
      fileName: result.source.fileName,
    })),
  );
  const payload = {
    schemaVersion: 'spending-ledger-local-v1',
    importedAtIso,
    source: {
      kind: 'sofi_bank_csv',
      files: imports.map((result) => ({
        fileName: result.source.fileName,
        accountId: result.source.accountId,
        rowCount: result.rowCount,
        transactionCount: result.transactions.length,
        issueCount: result.issues.length,
      })),
    },
    transactions,
    issues,
    summary: {
      transactionCount: transactions.length,
      ignoredCount: transactions.filter((transaction) => transaction.ignored).length,
      creditCardPaymentCount: transactions.filter((transaction) =>
        transaction.tags?.includes('credit_card_payment'),
      ).length,
      payrollCount: transactions.filter((transaction) => transaction.merchant === 'ATHENA')
        .length,
      familyTransferTransactionCount: transactions.filter(
        (transaction) => transaction.categoryId === 'family_transfers',
      ).length,
      uncategorizedTransactionCount: transactions.filter(
        (transaction) => transaction.categoryId === 'uncategorized',
      ).length,
      byMonth: summarizeByMonth(transactions),
    },
  };

  await fs.mkdir(path.dirname(options.outFile), { recursive: true });
  await fs.writeFile(options.outFile, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        outFile: options.outFile,
        transactionCount: payload.summary.transactionCount,
        ignoredCount: payload.summary.ignoredCount,
        creditCardPaymentCount: payload.summary.creditCardPaymentCount,
        payrollCount: payload.summary.payrollCount,
        familyTransferTransactionCount: payload.summary.familyTransferTransactionCount,
        uncategorizedTransactionCount: payload.summary.uncategorizedTransactionCount,
        issueCount: issues.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
