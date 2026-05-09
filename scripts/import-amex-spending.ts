import fs from 'node:fs/promises';
import path from 'node:path';
import {
  importAmexActivityCsv,
  mergeAmexImportTransactions,
} from '../src/amex-spending-import';

interface CliOptions {
  inputFiles: string[];
  outFile: string;
  accountId?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const inputFiles: string[] = [];
  let outFile = 'public/local/spending-ledger.amex.json';
  let accountId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      outFile = argv[index + 1] ?? outFile;
      index += 1;
    } else if (arg === '--account') {
      accountId = argv[index + 1] ?? accountId;
      index += 1;
    } else {
      inputFiles.push(arg);
    }
  }

  if (inputFiles.length === 0) {
    throw new Error(
      'Usage: node --import tsx scripts/import-amex-spending.ts [--account amex-11000] [--out public/local/spending-ledger.amex.json] <csv...>',
    );
  }

  return { inputFiles, outFile, accountId };
}

function summarizeByMonth(
  transactions: ReturnType<typeof mergeAmexImportTransactions>,
) {
  const byMonth = new Map<
    string,
    {
      transactionCount: number;
      spend: number;
      credits: number;
      ignoredCount: number;
      travelSpend: number;
      amazonSpend: number;
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
        travelSpend: 0,
        amazonSpend: 0,
      };
    summary.transactionCount += 1;
    if (transaction.ignored) {
      summary.ignoredCount += 1;
    } else if (transaction.amount >= 0) {
      summary.spend += transaction.amount;
      if (transaction.categoryId === 'travel') {
        summary.travelSpend += transaction.amount;
      }
      if (transaction.categoryId === 'amazon_uncategorized') {
        summary.amazonSpend += transaction.amount;
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
          travelSpend: Math.round(summary.travelSpend * 100) / 100,
          amazonSpend: Math.round(summary.amazonSpend * 100) / 100,
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
      importAmexActivityCsv(csvText, {
        fileName: path.basename(filePath),
        accountId: options.accountId,
        importedAtIso,
      }),
    );
  }

  const transactions = mergeAmexImportTransactions(imports);
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
      kind: 'amex_activity_csv',
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
      amazonTransactionCount: transactions.filter(
        (transaction) => transaction.categoryId === 'amazon_uncategorized',
      ).length,
      travelTransactionCount: transactions.filter(
        (transaction) => transaction.categoryId === 'travel',
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
        amazonTransactionCount: payload.summary.amazonTransactionCount,
        travelTransactionCount: payload.summary.travelTransactionCount,
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
