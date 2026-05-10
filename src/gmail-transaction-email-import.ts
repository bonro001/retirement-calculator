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
  amazonEvidence?: AmazonEmailEvidence;
}

interface ExtractedAmount {
  amount: number;
  tags: string[];
  confidence: number | null;
  ignored: boolean;
}

interface AmazonEmailEvidence {
  orderId?: string;
  emailKind: 'ordered' | 'shipped' | 'delivered' | 'refund' | 'other';
  items: string[];
  itemDetails: AmazonItemDetail[];
}

interface AmazonItemDetail {
  name: string;
  quantity?: number;
  price?: number;
}

const CHASE_TRANSACTION_SUBJECT_RE =
  /^You made a \$(\d[\d,]*(?:\.\d{2})?) transaction with (.+?)\.?$/i;
const AMAZON_ORDER_RE = /\b(?:ordered:|amazon(?:\.com)? order\b|your amazon(?:\.com)? order\b)/i;
const AMAZON_DELIVERY_NOTICE_RE =
  /\b(?:delivered(?::|\b)|out for delivery|arriving(?: today| tomorrow)?\b|package (?:was )?delivered\b)/i;
const AMAZON_RE = /\b(?:amazon|amzn)\b|amazon\.com/i;
const REFUND_RE = /\b(?:refund|refunded|return request|dropoff confirmed|credit pending|credit issued|reversal)\b/i;
const SECURITY_OR_ACCOUNT_RE =
  /\b(?:security alert|verification code|password|statement|payment due|autopay|available credit|balance alert)\b/i;
const AMOUNT_RE = /\$\s*(\d[\d,]*(?:\.\d{2})?)/g;
const HAS_AMOUNT_RE = /\$\s*\d[\d,]*(?:\.\d{2})?/;
const LABELED_AMOUNT_RE =
  /\b(?:amount|transaction amount|purchase amount|order total|refund amount|total)\b[:\s$]*(\d[\d,]*(?:\.\d{2})?)/i;
const AMAZON_PAYMENT_TOTAL_RE =
  /\b(?:grand total|order total|total charged|order value|total)\b[:\s$]*(\d[\d,]*(?:\.\d{2})?)/i;
const AMAZON_ORDER_VALUE_RE =
  /\b(?:items? subtotal|item subtotal|subtotal|merchandise total|order subtotal)\b[:\s$]*(\d[\d,]*(?:\.\d{2})?)/i;
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

function parseLooseMoney(value: string): number | undefined {
  const match = /^(?:\$?\s*)?(\d[\d,]*(?:\.\d{2})?)(?:\s+USD)?$/i.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const amount = parseDollarAmount(match[1]);
  return Number.isFinite(amount) ? roundMoney(amount) : undefined;
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

function stripForwardedQuotePrefix(value: string): string {
  return value.replace(/^(?:>+\s*)+/, '').trim();
}

function extractAmazonOrderId(text: string): string | undefined {
  const normalized = text.replace(/[\u202A-\u202E]/g, ' ');
  const decoded = normalized.replace(/%3D/gi, '=').replace(/%2D/gi, '-');
  const patterns = [
    /\border\s*#\s*[^\d]*(\d{3}-\d{7}-\d{7})/i,
    /\borderId=(\d{3}-\d{7}-\d{7})/i,
    /\borderID=(\d{3}-\d{7}-\d{7})/i,
    /\border-id=(\d{3}-\d{7}-\d{7})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(decoded);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function inferAmazonEmailKind(
  subject: string,
  isRefund: boolean,
  isAmazonDeliveryNotice: boolean,
): AmazonEmailEvidence['emailKind'] {
  if (isRefund) return 'refund';
  if (isAmazonDeliveryNotice) return 'delivered';
  if (/\bshipped(?::|\b)/i.test(subject)) return 'shipped';
  if (/\bordered(?::|\b)/i.test(subject)) return 'ordered';
  return 'other';
}

function cleanAmazonItemLine(value: string): string {
  return stripForwardedQuotePrefix(value)
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/<https?:\/\/[^>]+>/gi, '')
    .replace(/^Item:\s*/i, '')
    .replace(/^\*\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAmazonItemLine(value: string): boolean {
  if (value.length < 8) return false;
  if (value.length > 220) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (/\$\s*\d/.test(value)) return false;
  if (/^(?:from|to|subject|date|reply-to|message-id|content-type|mime-version):/i.test(value)) return false;
  if (
    /^(?:fwd:|begin forwarded message|thanks for your order|your orders|ordered|shipped|delivered|order #|view or edit order|track package|quantity:|grand total|order total|item subtotal|gift card|return or replace|more items to consider|the payment for your invoice|by placing your order|have questions|reason for refund|we'll apply your refund|this refund is for the following item)/i.test(
      value,
    )
  ) {
    return false;
  }
  return /[A-Za-z]/.test(value);
}

function extractAmazonItemDetails(text: string): AmazonItemDetail[] {
  const items: AmazonItemDetail[] = [];
  const seen = new Set<string>();
  const lines = text
    .split(/\r?\n/)
    .map((raw) => ({
      raw: stripForwardedQuotePrefix(raw).trim(),
      clean: cleanAmazonItemLine(raw),
    }))
    .filter((line) => Boolean(line.clean));

  lines.forEach((line, index) => {
    const nextLine = lines[index + 1]?.clean ?? '';
    const priceLine = lines[index + 2]?.clean ?? '';
    const isExplicitRefundItem = /^Item:\s*/i.test(line.raw);
    const quantityMatch = /^Quantity:\s*(\d+)/i.exec(nextLine);
    const isOrderItemWithQuantity = Boolean(quantityMatch);
    if (!isExplicitRefundItem && !isOrderItemWithQuantity) return;
    if (!isAmazonItemLine(line.clean)) return;
    const normalized = line.clean.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    items.push({
      name: line.clean,
      quantity: quantityMatch ? Number(quantityMatch[1]) : undefined,
      price: parseLooseMoney(priceLine),
    });
  });

  return items.slice(0, 10);
}

function extractAmazonItems(text: string): string[] {
  return extractAmazonItemDetails(text).map((item) => item.name);
}

function extractAmazonEmailEvidence(input: {
  subject: string;
  combined: string;
  isRefund: boolean;
  isAmazonDeliveryNotice: boolean;
}): AmazonEmailEvidence {
  return {
    orderId: extractAmazonOrderId(input.combined),
    emailKind: inferAmazonEmailKind(
      input.subject,
      input.isRefund,
      input.isAmazonDeliveryNotice,
    ),
    itemDetails: extractAmazonItemDetails(input.combined),
    items: extractAmazonItems(input.combined),
  };
}

function extractFirstAmount(text: string): number | null {
  const labeled = LABELED_AMOUNT_RE.exec(text);
  if (labeled) return parseDollarAmount(labeled[1]);

  const amounts = Array.from(text.matchAll(AMOUNT_RE))
    .map((match) => parseDollarAmount(match[1]))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  return amounts[0] ?? null;
}

function extractAmazonOrderAmount(text: string): ExtractedAmount | null {
  const paymentTotal = AMAZON_PAYMENT_TOTAL_RE.exec(text);
  const paymentAmount = paymentTotal ? parseDollarAmount(paymentTotal[1]) : null;
  if (paymentAmount !== null && paymentAmount > 0) {
    return {
      amount: paymentAmount,
      tags: [],
      confidence: null,
      ignored: false,
    };
  }

  const orderValue = AMAZON_ORDER_VALUE_RE.exec(text);
  if (orderValue) {
    const orderValueAmount = parseDollarAmount(orderValue[1]);
    if (orderValueAmount > 0) {
      return {
        amount: orderValueAmount,
        tags:
          paymentAmount === 0
            ? ['amazon_credit_spend', 'zero_payment_total']
            : ['amazon_order_value_inferred'],
        confidence: paymentAmount === 0 ? 0.72 : 0.6,
        ignored: false,
      };
    }
  }

  if (paymentAmount === 0) {
    return {
      amount: 0,
      tags: ['zero_total', 'needs_order_value', 'ignored'],
      confidence: 0.9,
      ignored: true,
    };
  }

  const amount = extractFirstAmount(text);
  if (amount === null) return null;
  return {
    amount,
    tags: [],
    confidence: null,
    ignored: amount === 0,
  };
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
  const combined = `${email.from ?? ''}\n${subject}\n${body}`;

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
  const isAmazonDeliveryNotice = isAmazon && AMAZON_DELIVERY_NOTICE_RE.test(subject);
  const amazonEvidence = isAmazon
    ? extractAmazonEmailEvidence({
        subject,
        combined,
        isRefund,
        isAmazonDeliveryNotice,
      })
    : undefined;

  if (isAmazonDeliveryNotice && !isRefund) {
    return {
      amount: 0,
      merchant: 'Amazon',
      categoryId: 'ignored',
      classificationMethod: 'inferred',
      categoryConfidence: 0.9,
      ignored: true,
      tags: ['amazon', 'needs_item_data', 'delivery_notice', 'ignored'],
      sourceKind: 'amazon_order_email',
      amazonEvidence,
    };
  }

  const amountInfo = isAmazon && !isRefund
    ? extractAmazonOrderAmount(combined)
    : (() => {
        const amount = extractFirstAmount(combined);
        if (amount === null) return null;
        return {
          amount,
          tags: amount === 0 ? ['zero_total', 'ignored'] : [],
          confidence: amount === 0 ? 0.9 : null,
          ignored: amount === 0,
        };
      })();
  if (amountInfo === null) return null;
  const amount = amountInfo.amount;

  const merchant = isAmazon ? 'Amazon' : extractMerchantFromText(combined);
  if (!merchant && !isRefund) return null;
  const isAmazonEmailEvidence = isAmazon;
  const isZeroTotal = amount === 0 && amountInfo.ignored;

  return {
    amount: roundMoney(isRefund ? -amount : amount),
    merchant: merchant ?? 'Refund',
    categoryId: isAmazonEmailEvidence
      ? 'ignored'
      : isZeroTotal
        ? 'ignored'
        : isRefund
          ? 'refund'
          : 'uncategorized',
    classificationMethod: isAmazon || isRefund ? 'inferred' : 'uncategorized',
    categoryConfidence: amountInfo.confidence ?? (isAmazon ? 0.45 : isRefund ? 0.6 : 0),
    ignored: isAmazonEmailEvidence || amountInfo.ignored,
    tags: [
      ...(isAmazon ? ['amazon', 'needs_item_data'] : []),
      ...(isRefund ? ['refund', 'needs_match'] : []),
      ...(isAmazonEmailEvidence ? ['amazon_evidence_only', 'ignored'] : []),
      ...amountInfo.tags,
      ...(!isAmazon && !isRefund ? ['needs_review', 'credit_card_email'] : []),
    ],
    sourceKind: isAmazon
      ? isRefund
        ? 'amazon_refund_email'
        : 'amazon_order_email'
      : isRefund
        ? 'refund_email'
        : 'credit_card_email',
    amazonEvidence,
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
        ...(parsed.amazonEvidence
          ? {
              amazonOrderId: parsed.amazonEvidence.orderId,
              amazonEmailKind: parsed.amazonEvidence.emailKind,
              amazonItems: parsed.amazonEvidence.items,
              amazonItemDetails: parsed.amazonEvidence.itemDetails,
            }
          : {}),
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
