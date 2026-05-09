import type {
  SpendingClassificationMethod,
  SpendingTransaction,
} from './spending-ledger';

export interface AmexCsvImportSource {
  fileName: string;
  accountId?: string;
  importedAtIso?: string;
}

export interface AmexCsvImportIssue {
  rowNumber: number;
  code: 'missing_required_field' | 'invalid_amount' | 'invalid_date';
  message: string;
}

export interface AmexCsvImportResult {
  schemaVersion: 'spending-ledger-import-v1';
  importedAtIso: string;
  parserVersion: 'amex-activity-csv-v1';
  source: {
    kind: 'amex_activity_csv';
    fileName: string;
    accountId?: string;
  };
  rowCount: number;
  transactions: SpendingTransaction[];
  issues: AmexCsvImportIssue[];
}

interface AmexCsvRow {
  date: string;
  description: string;
  cardMember: string;
  accountNumber: string;
  amount: string;
  extendedDetails: string;
  appearsOnStatementAs: string;
  address: string;
  cityState: string;
  zipCode: string;
  country: string;
  reference: string;
  category: string;
  rowNumber: number;
}

const REQUIRED_HEADERS = [
  'Date',
  'Description',
  'Card Member',
  'Account #',
  'Amount',
  'Extended Details',
  'Appears On Your Statement As',
  'Address',
  'City/State',
  'Zip Code',
  'Country',
  'Reference',
  'Category',
] as const;

const AMAZON_DESCRIPTION_RE = /\b(?:amazon|amzn)\b|amazon\.com/i;
const PAYMENT_RE = /\bmobile payment\b|\bpayment\b.*\bthank you\b/i;

const AMEX_CATEGORY_MAP: Array<{
  pattern: RegExp;
  categoryId: string;
  method: SpendingClassificationMethod;
  confidence: number;
  tags?: string[];
}> = [
  {
    pattern: /^Travel-/,
    categoryId: 'travel',
    method: 'rule',
    confidence: 0.92,
  },
  {
    pattern: /^Transportation-/,
    categoryId: 'travel',
    method: 'rule',
    confidence: 0.78,
    tags: ['transportation'],
  },
  {
    pattern: /^Merchandise & Supplies-Groceries$/,
    categoryId: 'essential',
    method: 'rule',
    confidence: 0.9,
  },
  {
    pattern: /^Merchandise & Supplies-Wholesale Stores$/,
    categoryId: 'essential',
    method: 'rule',
    confidence: 0.78,
  },
  {
    pattern: /^Business Services-Insurance Services$/,
    categoryId: 'essential',
    method: 'rule',
    confidence: 0.82,
  },
  {
    pattern: /^Restaurant-/,
    categoryId: 'optional',
    method: 'rule',
    confidence: 0.78,
  },
  {
    pattern: /^Entertainment-/,
    categoryId: 'optional',
    method: 'rule',
    confidence: 0.78,
  },
  {
    pattern: /^Merchandise & Supplies-/,
    categoryId: 'optional',
    method: 'rule',
    confidence: 0.6,
  },
  {
    pattern: /^Other-/,
    categoryId: 'optional',
    method: 'rule',
    confidence: 0.5,
  },
];

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

function parseAmexDate(value: string): string | null {
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

function cleanReference(reference: string): string {
  return reference.replace(/^'/, '').trim();
}

function classifyAmexRow(row: AmexCsvRow): {
  categoryId: string;
  classificationMethod: SpendingClassificationMethod;
  categoryConfidence: number;
  ignored: boolean;
  tags: string[];
} {
  const description = row.description.trim();
  const details = `${row.description} ${row.extendedDetails} ${row.appearsOnStatementAs}`;

  if (PAYMENT_RE.test(description)) {
    return {
      categoryId: 'ignored',
      classificationMethod: 'explicit',
      categoryConfidence: 1,
      ignored: true,
      tags: ['payment', 'ignored'],
    };
  }

  if (AMAZON_DESCRIPTION_RE.test(details)) {
    return {
      categoryId: 'amazon_uncategorized',
      classificationMethod: 'inferred',
      categoryConfidence: 0.45,
      ignored: false,
      tags: ['amazon', 'needs_item_data'],
    };
  }

  const category = row.category.trim();
  const mapped = AMEX_CATEGORY_MAP.find((candidate) =>
    candidate.pattern.test(category),
  );
  if (mapped) {
    return {
      categoryId: mapped.categoryId,
      classificationMethod: mapped.method,
      categoryConfidence: mapped.confidence,
      ignored: false,
      tags: mapped.tags ?? [],
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

function toAmexRows(csvText: string): { rows: AmexCsvRow[]; issues: AmexCsvImportIssue[] } {
  const parsedRows = parseCsvRows(csvText);
  const header = parsedRows[0] ?? [];
  const headerIndex = new Map(header.map((value, index) => [value, index]));
  const issues: AmexCsvImportIssue[] = [];

  REQUIRED_HEADERS.forEach((requiredHeader) => {
    if (!headerIndex.has(requiredHeader)) {
      issues.push({
        rowNumber: 1,
        code: 'missing_required_field',
        message: `Missing required Amex CSV header "${requiredHeader}".`,
      });
    }
  });
  if (issues.length) {
    return { rows: [], issues };
  }

  const rows = parsedRows.slice(1).map((values, index): AmexCsvRow => {
    const read = (headerName: (typeof REQUIRED_HEADERS)[number]) =>
      values[headerIndex.get(headerName) ?? -1]?.trim() ?? '';
    return {
      date: read('Date'),
      description: read('Description'),
      cardMember: read('Card Member'),
      accountNumber: read('Account #'),
      amount: read('Amount'),
      extendedDetails: read('Extended Details'),
      appearsOnStatementAs: read('Appears On Your Statement As'),
      address: read('Address'),
      cityState: read('City/State'),
      zipCode: read('Zip Code'),
      country: read('Country'),
      reference: read('Reference'),
      category: read('Category'),
      rowNumber: index + 2,
    };
  });

  return { rows, issues };
}

export function importAmexActivityCsv(
  csvText: string,
  source: AmexCsvImportSource,
): AmexCsvImportResult {
  const importedAtIso = source.importedAtIso ?? new Date().toISOString();
  const { rows, issues } = toAmexRows(csvText);
  const transactions: SpendingTransaction[] = [];

  rows.forEach((row) => {
    if (!row.description || !row.date || !row.amount) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'missing_required_field',
        message: 'Row is missing description, date, or amount.',
      });
      return;
    }

    const postedDate = parseAmexDate(row.date);
    if (!postedDate) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'invalid_date',
        message: `Invalid Amex date on row ${row.rowNumber}.`,
      });
      return;
    }

    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'invalid_amount',
        message: `Invalid Amex amount "${row.amount}" on row ${row.rowNumber}.`,
      });
      return;
    }

    const classification = classifyAmexRow(row);
    const reference = cleanReference(row.reference);
    const fallbackId = stableHash(
      [
        source.accountId ?? row.accountNumber,
        postedDate,
        row.description,
        row.amount,
        row.category,
      ].join('|'),
    );
    const transactionId = `amex-${source.accountId ?? row.accountNumber ?? 'unknown'}-${postedDate}-${reference || fallbackId}`;

    transactions.push({
      id: transactionId,
      postedDate,
      transactionDate: postedDate,
      merchant: row.description,
      description: row.appearsOnStatementAs || row.description,
      amount: Math.round(amount * 100) / 100,
      currency: 'USD',
      accountId: source.accountId ?? row.accountNumber,
      categoryId: classification.categoryId,
      categoryConfidence: classification.categoryConfidence,
      classificationMethod: classification.classificationMethod,
      ignored: classification.ignored,
      tags: classification.tags,
      linkedTransactionIds: [],
      source: {
        source: 'credit_card_csv',
        sourceId: `${source.fileName}:row-${row.rowNumber}`,
        parserVersion: 'amex-activity-csv-v1',
        receivedAtIso: importedAtIso,
        confidence: 0.98,
      },
      rawEvidence: {
        amexCategory: row.category,
        amexReference: reference,
        cardMember: row.cardMember,
        accountNumber: row.accountNumber,
        extendedDetails: row.extendedDetails,
        address: row.address,
        cityState: row.cityState,
        zipCode: row.zipCode,
        country: row.country,
      },
    });
  });

  return {
    schemaVersion: 'spending-ledger-import-v1',
    importedAtIso,
    parserVersion: 'amex-activity-csv-v1',
    source: {
      kind: 'amex_activity_csv',
      fileName: source.fileName,
      accountId: source.accountId,
    },
    rowCount: rows.length,
    transactions,
    issues,
  };
}

export function mergeAmexImportTransactions(
  imports: AmexCsvImportResult[],
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
