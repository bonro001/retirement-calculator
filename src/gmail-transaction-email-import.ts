import type {
  SpendingClassificationMethod,
  SpendingLedgerSourceKind,
  SpendingTransaction,
} from './spending-ledger';

export interface GmailTransactionEmail {
  uid: number;
  date: string | null;
  from: string | null;
  subject: string | null;
  messageId: string | null;
  bodyText?: string;
  size?: number | null;
}

export interface GmailTransactionEmailImportIssue {
  uid: number;
  code: 'missing_amount' | 'missing_date' | 'unsupported_email';
  message: string;
}

export interface GmailTransactionEmailImportResult {
  schemaVersion: 'spending-ledger-import-v1';
  importedAtIso: string;
  parserVersion: 'gmail-transaction-email-v1';
  source: {
    kind: 'gmail_imap';
    accountId?: string;
    mailbox?: string;
  };
  messageCount: number;
  transactions: SpendingTransaction[];
  issues: GmailTransactionEmailImportIssue[];
}

interface ParsedEmailTransaction {
  amount: number;
  merchant: string;
  categoryId: string;
  classificationMethod: SpendingClassificationMethod;
  categoryConfidence: number;
  ignored: boolean;
  tags: string[];
  sourceKind: SpendingLedgerSourceKind;
}

const CHASE_TRANSACTION_SUBJECT_RE =
  /^You made a \$(\d[\d,]*(?:\.\d{2})?) transaction with (.+?)\.?$/i;
const AMAZON_ORDER_RE = /\b(?:ordered:|amazon(?:\.com)? order\b|your amazon(?:\.com)? order\b)/i;
const AMAZON_RE = /\b(?:amazon|amzn)\b|amazon\.com/i;
const REFUND_RE = /\b(?:refund|refunded|credit|reversal)\b/i;
const SECURITY_OR_ACCOUNT_RE =
  /\b(?:security alert|verification code|password|statement|payment due|autopay|available credit|balance alert)\b/i;
const AMOUNT_RE = /\$\s*(\d[\d,]*(?:\.\d{2})?)/g;
const HAS_AMOUNT_RE = /\$\s*\d[\d,]*(?:\.\d{2})?/;
const LABELED_AMOUNT_RE =
  /\b(?:amount|transaction amount|purchase amount|order total|refund amount|total)\b[:\s$]*(\d[\d,]*(?:\.\d{2})?)/i;
const RFC_2822_DATE_RE = /^(?:[A-Z][a-z]{2},\s*)?(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\b/;
const MONTH_INDEX: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseDollarAmount(value: string): number {
  return Number(value.replace(/,/g, ''));
}

function parseEmailDate(value: string | null): string | null {
  if (!value) return null;
  const rfcDate = RFC_2822_DATE_RE.exec(value.trim());
  if (rfcDate && MONTH_INDEX[rfcDate[2]]) {
    return `${rfcDate[3]}-${MONTH_INDEX[rfcDate[2]]}-${rfcDate[1].padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function cleanMerchant(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[.。]+$/, '')
    .trim();
}

function extractFirstAmount(text: string): number | null {
  const labeled = LABELED_AMOUNT_RE.exec(text);
  if (labeled) return parseDollarAmount(labeled[1]);

  const amounts = Array.from(text.matchAll(AMOUNT_RE))
    .map((match) => parseDollarAmount(match[1]))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  return amounts[0] ?? null;
}

function extractMerchantFromText(text: string): string | null {
  const merchantPatterns = [
    /\bmerchant\s*:\s*([^\n\r]+)/i,
    /\btransaction with\s+([^\n\r.]+)/i,
    /\bwith\s+([A-Z0-9][A-Z0-9 '&*/.,#-]{2,}?)(?:\s+on\b|[.\n\r]|$)/i,
    /\bat\s+([A-Z0-9][A-Z0-9 '&*/.,#-]{2,}?)(?:\s+on\b|[.\n\r]|$)/i,
  ];

  for (const pattern of merchantPatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return cleanMerchant(match[1]);
  }

  return null;
}

function parseEmailTransaction(email: GmailTransactionEmail): ParsedEmailTransaction | null {
  const subject = email.subject ?? '';
  const body = email.bodyText ?? '';
  const combined = `${subject}\n${body}`;

  const chaseSubject = CHASE_TRANSACTION_SUBJECT_RE.exec(subject);
  if (chaseSubject) {
    const amount = parseDollarAmount(chaseSubject[1]);
    const merchant = cleanMerchant(chaseSubject[2]);
    const isAmazon = AMAZON_RE.test(merchant);
    return {
      amount,
      merchant,
      categoryId: isAmazon ? 'amazon_uncategorized' : 'uncategorized',
      classificationMethod: isAmazon ? 'inferred' : 'uncategorized',
      categoryConfidence: isAmazon ? 0.45 : 0,
      ignored: false,
      tags: isAmazon ? ['amazon', 'needs_item_data'] : ['needs_review', 'credit_card_email'],
      sourceKind: 'credit_card_email',
    };
  }

  if (SECURITY_OR_ACCOUNT_RE.test(subject) && !HAS_AMOUNT_RE.test(combined)) {
    return null;
  }

  const isAmazonOrder = AMAZON_ORDER_RE.test(combined);
  const isAmazon = isAmazonOrder || AMAZON_RE.test(combined);
  const isRefund = REFUND_RE.test(combined);
  const amount = extractFirstAmount(combined);
  if (!amount) return null;

  const merchant = isAmazon ? 'Amazon' : extractMerchantFromText(combined);
  if (!merchant && !isRefund) return null;

  return {
    amount: roundMoney(isRefund ? -amount : amount),
    merchant: merchant ?? 'Refund',
    categoryId: isAmazon ? 'amazon_uncategorized' : isRefund ? 'refund' : 'uncategorized',
    classificationMethod: isAmazon || isRefund ? 'inferred' : 'uncategorized',
    categoryConfidence: isAmazon ? 0.45 : isRefund ? 0.6 : 0,
    ignored: false,
    tags: [
      ...(isAmazon ? ['amazon', 'needs_item_data'] : []),
      ...(isRefund ? ['refund', 'needs_match'] : []),
      ...(!isAmazon && !isRefund ? ['needs_review', 'credit_card_email'] : []),
    ],
    sourceKind: isAmazon
      ? isRefund
        ? 'amazon_refund_email'
        : 'amazon_order_email'
      : isRefund
        ? 'refund_email'
        : 'credit_card_email',
  };
}

export function importGmailTransactionEmails(
  emails: GmailTransactionEmail[],
  options?: {
    accountId?: string;
    mailbox?: string;
    importedAtIso?: string;
  },
): GmailTransactionEmailImportResult {
  const importedAtIso = options?.importedAtIso ?? new Date().toISOString();
  const transactions: SpendingTransaction[] = [];
  const issues: GmailTransactionEmailImportIssue[] = [];

  emails.forEach((email) => {
    const postedDate = parseEmailDate(email.date);
    if (!postedDate) {
      issues.push({
        uid: email.uid,
        code: 'missing_date',
        message: 'Email is missing a parseable Date header.',
      });
      return;
    }

    const parsed = parseEmailTransaction(email);
    if (!parsed) {
      issues.push({
        uid: email.uid,
        code: HAS_AMOUNT_RE.test(`${email.subject ?? ''}\n${email.bodyText ?? ''}`)
          ? 'unsupported_email'
          : 'missing_amount',
        message: 'Email does not match a supported transaction format yet.',
      });
      return;
    }

    const sourceId = email.messageId ?? `gmail-uid-${email.uid}`;
    const hashInput = [
      options?.accountId ?? 'gmail',
      email.uid,
      sourceId,
      postedDate,
      parsed.merchant,
      parsed.amount,
    ].join('|');

    transactions.push({
      id: `gmail-${postedDate}-${stableHash(hashInput)}`,
      postedDate,
      merchant: parsed.merchant,
      description: email.subject ?? parsed.merchant,
      amount: roundMoney(parsed.amount),
      currency: 'USD',
      accountId: options?.accountId,
      categoryId: parsed.categoryId,
      categoryConfidence: parsed.categoryConfidence,
      classificationMethod: parsed.classificationMethod,
      ignored: parsed.ignored,
      tags: parsed.tags,
      linkedTransactionIds: [],
      source: {
        source: parsed.sourceKind,
        sourceId,
        parserVersion: 'gmail-transaction-email-v1',
        receivedAtIso: importedAtIso,
        confidence: CHASE_TRANSACTION_SUBJECT_RE.test(email.subject ?? '') ? 0.92 : 0.68,
      },
      rawEvidence: {
        gmailUid: email.uid,
        from: email.from,
        subject: email.subject,
        messageId: email.messageId,
        size: email.size ?? null,
      },
    });
  });

  return {
    schemaVersion: 'spending-ledger-import-v1',
    importedAtIso,
    parserVersion: 'gmail-transaction-email-v1',
    source: {
      kind: 'gmail_imap',
      accountId: options?.accountId,
      mailbox: options?.mailbox,
    },
    messageCount: emails.length,
    transactions: transactions.sort((left, right) => {
      const dateCompare = right.postedDate.localeCompare(left.postedDate);
      if (dateCompare !== 0) return dateCompare;
      return left.id.localeCompare(right.id);
    }),
    issues,
  };
}
