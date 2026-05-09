import type {
  SpendingClassificationMethod,
  SpendingTransaction,
} from './spending-ledger';

export interface ChaseCsvImportSource {
  fileName: string;
  accountId?: string;
  importedAtIso?: string;
}

export interface ChaseCsvImportIssue {
  rowNumber: number;
  code: 'missing_required_field' | 'invalid_amount' | 'invalid_date';
  message: string;
}

export interface ChaseCsvImportResult {
  schemaVersion: 'spending-ledger-import-v1';
  importedAtIso: string;
  parserVersion: 'chase-activity-csv-v1';
  source: {
    kind: 'chase_activity_csv';
    fileName: string;
    accountId?: string;
  };
  rowCount: number;
  transactions: SpendingTransaction[];
  issues: ChaseCsvImportIssue[];
}

interface ChaseCsvRow {
  transactionDate: string;
  postDate: string;
  description: string;
  category: string;
  type: string;
  amount: string;
  memo: string;
  rowNumber: number;
}

const REQUIRED_HEADERS = [
  'Transaction Date',
  'Post Date',
  'Description',
  'Category',
  'Type',
  'Amount',
  'Memo',
] as const;

const AMAZON_DESCRIPTION_RE = /\b(?:amazon|amzn)\b|amazon\.com/i;
const PAYMENT_RE = /\bpayment\b|thank you/i;

const CHASE_CATEGORY_MAP: Record<
  string,
  { categoryId: string; method: SpendingClassificationMethod; confidence: number }
> = {
  'Bills & Utilities': { categoryId: 'essential', method: 'rule', confidence: 0.88 },
  Groceries: { categoryId: 'essential', method: 'rule', confidence: 0.9 },
  Gas: { categoryId: 'essential', method: 'rule', confidence: 0.82 },
  Automotive: { categoryId: 'essential', method: 'rule', confidence: 0.75 },
  'Health & Wellness': { categoryId: 'health', method: 'rule', confidence: 0.9 },
  Travel: { categoryId: 'travel', method: 'rule', confidence: 0.88 },
  Shopping: { categoryId: 'optional', method: 'rule', confidence: 0.62 },
  'Food & Drink': { categoryId: 'optional', method: 'rule', confidence: 0.72 },
  Home: { categoryId: 'optional', method: 'rule', confidence: 0.66 },
  Personal: { categoryId: 'optional', method: 'rule', confidence: 0.62 },
  Entertainment: { categoryId: 'optional', method: 'rule', confidence: 0.72 },
  'Gifts & Donations': { categoryId: 'optional', method: 'rule', confidence: 0.58 },
  Education: { categoryId: 'optional', method: 'rule', confidence: 0.58 },
  'Professional Services': { categoryId: 'optional', method: 'rule', confidence: 0.58 },
  'Fees & Adjustments': { categoryId: 'optional', method: 'rule', confidence: 0.58 },
};

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

function parseChaseDate(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function classifyChaseRow(row: ChaseCsvRow): {
  categoryId: string;
  classificationMethod: SpendingClassificationMethod;
  categoryConfidence: number;
  ignored: boolean;
  tags: string[];
} {
  const type = row.type.trim();
  const description = row.description.trim();
  if (type === 'Payment' || PAYMENT_RE.test(description)) {
    return {
      categoryId: 'ignored',
      classificationMethod: 'explicit',
      categoryConfidence: 1,
      ignored: true,
      tags: ['payment', 'ignored'],
    };
  }

  if (AMAZON_DESCRIPTION_RE.test(description)) {
    return {
      categoryId: 'amazon_uncategorized',
      classificationMethod: 'inferred',
      categoryConfidence: 0.45,
      ignored: false,
      tags: ['amazon', 'needs_item_data'],
    };
  }

  const mapped = CHASE_CATEGORY_MAP[row.category.trim()];
  if (mapped) {
    return {
      categoryId: mapped.categoryId,
      classificationMethod: mapped.method,
      categoryConfidence: mapped.confidence,
      ignored: false,
      tags: [],
    };
  }

  return {
    categoryId: 'uncategorized',
    classificationMethod: 'uncategorized',
    categoryConfidence: 0,
    ignored: false,
    tags: ['needs_review'],
  };
}

function toChaseRows(csvText: string): { rows: ChaseCsvRow[]; issues: ChaseCsvImportIssue[] } {
  const parsedRows = parseCsvRows(csvText);
  const header = parsedRows[0] ?? [];
  const headerIndex = new Map(header.map((value, index) => [value, index]));
  const issues: ChaseCsvImportIssue[] = [];

  REQUIRED_HEADERS.forEach((requiredHeader) => {
    if (!headerIndex.has(requiredHeader)) {
      issues.push({
        rowNumber: 1,
        code: 'missing_required_field',
        message: `Missing required Chase CSV header "${requiredHeader}".`,
      });
    }
  });
  if (issues.length) {
    return { rows: [], issues };
  }

  const rows = parsedRows.slice(1).map((values, index): ChaseCsvRow => {
    const read = (headerName: (typeof REQUIRED_HEADERS)[number]) =>
      values[headerIndex.get(headerName) ?? -1]?.trim() ?? '';
    return {
      transactionDate: read('Transaction Date'),
      postDate: read('Post Date'),
      description: read('Description'),
      category: read('Category'),
      type: read('Type'),
      amount: read('Amount'),
      memo: read('Memo'),
      rowNumber: index + 2,
    };
  });

  return { rows, issues };
}

export function importChaseActivityCsv(
  csvText: string,
  source: ChaseCsvImportSource,
): ChaseCsvImportResult {
  const importedAtIso = source.importedAtIso ?? new Date().toISOString();
  const { rows, issues } = toChaseRows(csvText);
  const transactions: SpendingTransaction[] = [];

  rows.forEach((row) => {
    if (!row.description || !row.postDate || !row.amount) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'missing_required_field',
        message: 'Row is missing description, post date, or amount.',
      });
      return;
    }

    const postDate = parseChaseDate(row.postDate);
    const transactionDate = parseChaseDate(row.transactionDate);
    if (!postDate || !transactionDate) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'invalid_date',
        message: `Invalid Chase date on row ${row.rowNumber}.`,
      });
      return;
    }

    const chaseAmount = Number(row.amount);
    if (!Number.isFinite(chaseAmount)) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'invalid_amount',
        message: `Invalid Chase amount "${row.amount}" on row ${row.rowNumber}.`,
      });
      return;
    }

    const classification = classifyChaseRow(row);
    const ledgerAmount = Math.round(-chaseAmount * 100) / 100;
    const hashInput = [
      source.accountId ?? 'chase',
      source.fileName,
      row.rowNumber,
      transactionDate,
      postDate,
      row.description,
      row.amount,
    ].join('|');

    transactions.push({
      id: `chase-${source.accountId ?? 'unknown'}-${postDate}-${stableHash(hashInput)}`,
      postedDate: postDate,
      transactionDate,
      merchant: row.description,
      description: row.memo || row.description,
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
        source: 'credit_card_csv',
        sourceId: `${source.fileName}:row-${row.rowNumber}`,
        parserVersion: 'chase-activity-csv-v1',
        receivedAtIso: importedAtIso,
        confidence: 0.98,
      },
      rawEvidence: {
        chaseCategory: row.category,
        chaseType: row.type,
        chaseAmount,
        memo: row.memo,
      },
    });
  });

  return {
    schemaVersion: 'spending-ledger-import-v1',
    importedAtIso,
    parserVersion: 'chase-activity-csv-v1',
    source: {
      kind: 'chase_activity_csv',
      fileName: source.fileName,
      accountId: source.accountId,
    },
    rowCount: rows.length,
    transactions,
    issues,
  };
}

export function mergeSpendingImportTransactions(
  imports: ChaseCsvImportResult[],
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
