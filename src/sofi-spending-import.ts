import type {
  SpendingClassificationMethod,
  SpendingTransaction,
} from './spending-ledger';

export interface SofiCsvImportSource {
  fileName: string;
  accountId?: string;
  importedAtIso?: string;
}

export interface SofiCsvImportIssue {
  rowNumber: number;
  code: 'missing_required_field' | 'invalid_amount' | 'invalid_date';
  message: string;
}

export interface SofiCsvImportResult {
  schemaVersion: 'spending-ledger-import-v1';
  importedAtIso: string;
  parserVersion: 'sofi-bank-csv-v1';
  source: {
    kind: 'sofi_bank_csv';
    fileName: string;
    accountId?: string;
  };
  rowCount: number;
  transactions: SpendingTransaction[];
  issues: SofiCsvImportIssue[];
}

interface SofiCsvRow {
  date: string;
  description: string;
  type: string;
  amount: string;
  currentBalance: string;
  status: string;
  rowNumber: number;
}

const REQUIRED_HEADERS = [
  'Date',
  'Description',
  'Type',
  'Amount',
  'Current balance',
  'Status',
] as const;

const CREDIT_CARD_PAYMENT_RE =
  /\b(?:CHASE CREDIT CRD|CITI AUTOPAY|APPLECARD GSBANK|AMEX EPAYMENT|BK OF AMER VISA)\b/i;
const INTERNAL_TRANSFER_RE =
  /^(?:To|From) (?:Checking|Savings|Escrow Vault)\b|^(?:To|From) Escrow Vault\b/i;
const PAYROLL_RE = /\bATHENA\b/i;
const UTILITY_RE =
  /\b(?:ONE GAS|City of Austin|ATT|LUPTON BACKFLOW|PEDERNALES|ELECTRIC|WATER|UTILITY)\b/i;
const EDUCATION_RE = /\bDEPT EDUCATION\b/i;
const GROCERY_RE = /\bWINCO FOODS\b/i;
const OPTIONAL_RE = /\b(?:SPECS|WALT DISNEY)\b/i;

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ''));
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function classifySofiRow(row: SofiCsvRow, bankAmount: number): {
  categoryId: string;
  classificationMethod: SpendingClassificationMethod;
  categoryConfidence: number;
  ignored: boolean;
  tags: string[];
} {
  const description = row.description.trim();
  const type = row.type.trim();
  const isOutflow = bankAmount < 0;

  if (
    !isOutflow ||
    type === 'DIRECT_DEPOSIT' ||
    type === 'INTEREST_EARNED' ||
    type === 'CHECK_DEPOSIT' ||
    INTERNAL_TRANSFER_RE.test(description)
  ) {
    return {
      categoryId: 'ignored',
      classificationMethod: 'explicit',
      categoryConfidence: 1,
      ignored: true,
      tags: ['cashflow', 'ignored'],
    };
  }

  if (CREDIT_CARD_PAYMENT_RE.test(description)) {
    return {
      categoryId: 'ignored',
      classificationMethod: 'explicit',
      categoryConfidence: 1,
      ignored: true,
      tags: ['credit_card_payment', 'ignored'],
    };
  }

  if ((type === 'P2P' || type === 'ZELLE') && isOutflow) {
    return {
      categoryId: 'family_transfers',
      classificationMethod: 'rule',
      categoryConfidence: 0.72,
      ignored: false,
      tags: ['family_transfer', type.toLowerCase()],
    };
  }

  if (UTILITY_RE.test(description)) {
    return {
      categoryId: 'essential',
      classificationMethod: 'rule',
      categoryConfidence: 0.86,
      ignored: false,
      tags: ['utility'],
    };
  }

  if (EDUCATION_RE.test(description)) {
    return {
      categoryId: 'essential',
      classificationMethod: 'rule',
      categoryConfidence: 0.72,
      ignored: false,
      tags: ['education_debt'],
    };
  }

  if (GROCERY_RE.test(description)) {
    return {
      categoryId: 'essential',
      classificationMethod: 'rule',
      categoryConfidence: 0.9,
      ignored: false,
      tags: ['groceries'],
    };
  }

  if (OPTIONAL_RE.test(description)) {
    return {
      categoryId: 'optional',
      classificationMethod: 'rule',
      categoryConfidence: 0.72,
      ignored: false,
      tags: [],
    };
  }

  return {
    categoryId: 'uncategorized',
    classificationMethod: 'uncategorized',
    categoryConfidence: 0,
    ignored: false,
    tags: ['needs_review', type.toLowerCase()],
  };
}

function toSofiRows(csvText: string): { rows: SofiCsvRow[]; issues: SofiCsvImportIssue[] } {
  const parsedRows = parseCsvRows(csvText);
  const header = parsedRows[0] ?? [];
  const headerIndex = new Map(header.map((value, index) => [value, index]));
  const issues: SofiCsvImportIssue[] = [];

  REQUIRED_HEADERS.forEach((requiredHeader) => {
    if (!headerIndex.has(requiredHeader)) {
      issues.push({
        rowNumber: 1,
        code: 'missing_required_field',
        message: `Missing required SoFi CSV header "${requiredHeader}".`,
      });
    }
  });
  if (issues.length) {
    return { rows: [], issues };
  }

  const rows = parsedRows.slice(1).map((values, index): SofiCsvRow => {
    const read = (headerName: (typeof REQUIRED_HEADERS)[number]) =>
      values[headerIndex.get(headerName) ?? -1]?.trim() ?? '';
    return {
      date: read('Date'),
      description: read('Description'),
      type: read('Type'),
      amount: read('Amount'),
      currentBalance: read('Current balance'),
      status: read('Status'),
      rowNumber: index + 2,
    };
  });

  return { rows, issues };
}

export function importSofiBankCsv(
  csvText: string,
  source: SofiCsvImportSource,
): SofiCsvImportResult {
  const importedAtIso = source.importedAtIso ?? new Date().toISOString();
  const { rows, issues } = toSofiRows(csvText);
  const transactions: SpendingTransaction[] = [];

  rows.forEach((row) => {
    if (!row.date || !row.description || !row.amount) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'missing_required_field',
        message: 'Row is missing date, description, or amount.',
      });
      return;
    }

    if (!isIsoDate(row.date)) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'invalid_date',
        message: `Invalid SoFi date on row ${row.rowNumber}.`,
      });
      return;
    }

    const bankAmount = Number(row.amount);
    if (!Number.isFinite(bankAmount)) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'invalid_amount',
        message: `Invalid SoFi amount "${row.amount}" on row ${row.rowNumber}.`,
      });
      return;
    }

    const classification = classifySofiRow(row, bankAmount);
    const ledgerAmount = Math.round(-bankAmount * 100) / 100;
    const hashInput = [
      source.accountId ?? 'sofi',
      source.fileName,
      row.rowNumber,
      row.date,
      row.description,
      row.type,
      row.amount,
      row.currentBalance,
    ].join('|');

    transactions.push({
      id: `sofi-${source.accountId ?? 'unknown'}-${row.date}-${stableHash(hashInput)}`,
      postedDate: row.date,
      transactionDate: row.date,
      merchant: row.description,
      description: row.description,
      amount: ledgerAmount,
      currency: 'USD',
      accountId: source.accountId,
      categoryId: classification.categoryId,
      categoryConfidence: classification.categoryConfidence,
      classificationMethod: classification.classificationMethod,
      ignored: classification.ignored,
      tags: classification.tags,
      linkedTransactionIds: [],
      source: {
        source: 'bank_csv',
        sourceId: `${source.fileName}:row-${row.rowNumber}`,
        parserVersion: 'sofi-bank-csv-v1',
        receivedAtIso: importedAtIso,
        confidence: 0.98,
      },
      rawEvidence: {
        sofiType: row.type,
        sofiAmount: bankAmount,
        currentBalance: row.currentBalance,
        status: row.status,
      },
    });
  });

  return {
    schemaVersion: 'spending-ledger-import-v1',
    importedAtIso,
    parserVersion: 'sofi-bank-csv-v1',
    source: {
      kind: 'sofi_bank_csv',
      fileName: source.fileName,
      accountId: source.accountId,
    },
    rowCount: rows.length,
    transactions,
    issues,
  };
}

export function mergeSofiImportTransactions(
  imports: SofiCsvImportResult[],
): SpendingTransaction[] {
  const byId = new Map<string, SpendingTransaction>();
  imports.forEach((result) => {
    result.transactions.forEach((transaction) => {
      if (!byId.has(transaction.id)) {
        byId.set(transaction.id, transaction);
      }
    });
  });
  return Array.from(byId.values()).sort((left, right) => {
    const dateCompare = right.postedDate.localeCompare(left.postedDate);
    if (dateCompare !== 0) return dateCompare;
    return left.id.localeCompare(right.id);
  });
}
