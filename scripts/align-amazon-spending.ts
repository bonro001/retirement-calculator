import fs from 'node:fs/promises';
import path from 'node:path';
import type { SpendingTransaction } from '../src/spending-ledger';

interface SpendingLedgerPayload {
  transactions?: SpendingTransaction[];
}

interface MatchCandidate {
  card: SpendingTransaction;
  email: SpendingTransaction;
  order: AmazonOrderEvidence;
  dateDeltaDays: number;
  score: number;
  confidence: number;
  notes: string[];
}

interface AmazonOrderEvidence {
  key: string;
  orderId?: string;
  items: string[];
  itemDetails: AmazonItemDetail[];
  emailKinds: string[];
  subjects: string[];
  orderedAmount?: number;
  shippedAmount?: number;
  primaryAmount?: number;
  itemSubtotal?: number;
  emails: SpendingTransaction[];
}

interface AmazonItemDetail {
  name: string;
  quantity?: number;
  price?: number;
}

const CARD_LEDGER_FILES = [
  'public/local/spending-ledger.chase4582.json',
  'public/local/spending-ledger.amex.json',
];

const EMAIL_LEDGER_FILES = [
  'public/local/spending-ledger.gmail.json',
];

const OUT_FILE = 'public/local/spending-amazon-card-email-alignment.json';
const SINCE = '2025-01-01';

async function readLedger(filePath: string): Promise<SpendingLedgerPayload | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as SpendingLedgerPayload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function dayNumber(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function minDateDeltaDays(card: SpendingTransaction, email: SpendingTransaction): number {
  const emailDay = dayNumber(email.postedDate);
  return Math.min(
    Math.abs(dayNumber(card.postedDate) - emailDay),
    card.transactionDate ? Math.abs(dayNumber(card.transactionDate) - emailDay) : Number.POSITIVE_INFINITY,
  );
}

function isAmazonCardTransaction(transaction: SpendingTransaction): boolean {
  const merchant = transaction.merchant.toLowerCase();
  return (
    transaction.postedDate >= SINCE &&
    transaction.source?.source === 'credit_card_csv' &&
    transaction.categoryId === 'amazon_uncategorized' &&
    transaction.amount !== 0 &&
    (merchant.includes('amazon') || merchant.includes('amzn'))
  );
}

function isAmazonEmailTransaction(transaction: SpendingTransaction): boolean {
  return (
    transaction.postedDate >= SINCE &&
    transaction.amount > 0 &&
    transaction.source?.source === 'amazon_order_email' &&
    (amazonEmailKindOf(transaction) === 'ordered' ||
      amazonEmailKindOf(transaction) === 'shipped')
  );
}

function subjectOf(transaction: SpendingTransaction): string {
  const metadataLine = /^(?:message-id|content-type|mime-version):/i;
  const value = transaction.rawEvidence?.subject;
  if (typeof value === 'string' && !metadataLine.test(value.trim())) {
    return value;
  }
  if (transaction.description && !metadataLine.test(transaction.description.trim())) {
    return transaction.description;
  }
  return '';
}

function amazonOrderIdOf(transaction: SpendingTransaction): string | undefined {
  const value = transaction.rawEvidence?.amazonOrderId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function amazonItemsOf(transaction: SpendingTransaction): string[] {
  const value = transaction.rawEvidence?.amazonItems;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function amazonItemDetailsOf(transaction: SpendingTransaction): AmazonItemDetail[] {
  const value = transaction.rawEvidence?.amazonItemDetails;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
      return {
        name: candidate.name.trim(),
        quantity: typeof candidate.quantity === 'number' ? candidate.quantity : undefined,
        price: typeof candidate.price === 'number' ? candidate.price : undefined,
      };
    })
    .filter((item): item is AmazonItemDetail => Boolean(item));
}

function amazonEmailKindOf(transaction: SpendingTransaction): string | undefined {
  const value = transaction.rawEvidence?.amazonEmailKind;
  return typeof value === 'string' ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  });
  return result;
}

function uniqueItemDetails(values: AmazonItemDetail[]): AmazonItemDetail[] {
  const byName = new Map<string, AmazonItemDetail>();
  values.forEach((value) => {
    const key = value.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || (existing.price === undefined && value.price !== undefined)) {
      byName.set(key, value);
    }
  });
  return Array.from(byName.values());
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function itemSubtotal(itemDetails: AmazonItemDetail[]): number | undefined {
  const prices = itemDetails
    .map((item) => item.price)
    .filter((price): price is number => typeof price === 'number' && price > 0);
  if (!prices.length) return undefined;
  return roundMoney(prices.reduce((total, price) => total + price, 0));
}

function primaryOrderAmount(emails: SpendingTransaction[]): number | undefined {
  const orderedAmount = orderedPaymentAmount(emails);
  if (orderedAmount !== undefined) return orderedAmount;
  const maxAmount = Math.max(0, ...emails.map((email) => email.amount));
  return maxAmount > 0 ? roundMoney(maxAmount) : undefined;
}

function orderedPaymentAmount(emails: SpendingTransaction[]): number | undefined {
  const orderedAmounts = emails
    .filter((email) => amazonEmailKindOf(email) === 'ordered')
    .map((email) => email.amount)
    .filter((amount) => amount > 0);
  if (!orderedAmounts.length) return undefined;
  return roundMoney(Math.max(...orderedAmounts));
}

function shippedShipmentAmount(emails: SpendingTransaction[]): number | undefined {
  const shippedAmounts = emails
    .filter((email) => amazonEmailKindOf(email) === 'shipped')
    .map((email) => email.amount)
    .filter((amount) => amount > 0);
  if (!shippedAmounts.length) return undefined;
  return roundMoney(Math.max(...shippedAmounts));
}

function buildAmazonOrderEvidence(emails: SpendingTransaction[]): Map<string, AmazonOrderEvidence> {
  const grouped = new Map<string, SpendingTransaction[]>();
  emails.forEach((email) => {
    const key = amazonOrderIdOf(email) ?? `email:${email.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), email]);
  });

  const evidenceByEmailId = new Map<string, AmazonOrderEvidence>();
  grouped.forEach((groupEmails, key) => {
    const shippedEmails = groupEmails.filter((email) => amazonEmailKindOf(email) === 'shipped');
    const itemEvidenceEmails = shippedEmails.length ? shippedEmails : groupEmails;
    const itemDetails = uniqueItemDetails(itemEvidenceEmails.flatMap(amazonItemDetailsOf));
    const order: AmazonOrderEvidence = {
      key,
      orderId: key.startsWith('email:') ? undefined : key,
      items: uniqueStrings([
        ...itemDetails.map((item) => item.name),
        ...itemEvidenceEmails.flatMap(amazonItemsOf),
      ]),
      itemDetails,
      emailKinds: uniqueStrings(groupEmails.map(amazonEmailKindOf).filter((value): value is string => Boolean(value))),
      subjects: uniqueStrings(groupEmails.map(subjectOf)),
      orderedAmount: orderedPaymentAmount(groupEmails),
      shippedAmount: shippedShipmentAmount(groupEmails),
      primaryAmount: primaryOrderAmount(groupEmails),
      itemSubtotal: itemSubtotal(itemDetails),
      emails: groupEmails,
    };
    groupEmails.forEach((email) => {
      evidenceByEmailId.set(email.id, order);
    });
  });

  return evidenceByEmailId;
}

function evidencePreference(transaction: SpendingTransaction): number {
  const subject = subjectOf(transaction).toLowerCase();
  if (transaction.amount < 0) {
    if (/\b(refund|return|dropoff|credit)\b/.test(subject)) return 8;
    return 4;
  }
  if (/\bordered\b/.test(subject)) return 9;
  if (/\bshipped\b/.test(subject)) return 7;
  if (/\bdelivered\b/.test(subject)) return 1;
  return 2;
}

function scoreCandidate(
  card: SpendingTransaction,
  email: SpendingTransaction,
  order: AmazonOrderEvidence,
): MatchCandidate | null {
  if (cents(card.amount) !== cents(email.amount)) return null;
  if (Math.sign(card.amount) !== Math.sign(email.amount)) return null;

  const dateDeltaDays = minDateDeltaDays(card, email);
  const allowedDelta = card.amount < 0 ? 21 : 10;
  if (dateDeltaDays > allowedDelta) return null;

  const isPartialOrSplitCharge =
    card.amount > 0 &&
    order.primaryAmount !== undefined &&
    cents(card.amount) !== cents(order.primaryAmount);
  const notes = [
    isPartialOrSplitCharge ? 'matched_ordered_amount' : 'exact_amount',
    dateDeltaDays === 0 ? 'same_day' : `within_${dateDeltaDays}_days`,
  ];
  const preference = evidencePreference(email);
  if (amazonEmailKindOf(email) === 'ordered') notes.push('ordered_payment_evidence');
  if (amazonEmailKindOf(email) === 'shipped') notes.push('shipment_item_evidence');
  if (isPartialOrSplitCharge) notes.push('partial_or_split_card_charge');

  const score = 1_000 - dateDeltaDays * 20 + preference - (isPartialOrSplitCharge ? 120 : 0);
  const confidence = Math.min(
    0.99,
    0.72 +
      Math.max(0, 10 - dateDeltaDays) * 0.02 +
      preference / 100 -
      (isPartialOrSplitCharge ? 0.18 : 0),
  );
  return {
    card,
    email,
    order,
    dateDeltaDays,
    score,
    confidence: Math.round(confidence * 100) / 100,
    notes,
  };
}

function sortedTransactions(transactions: SpendingTransaction[]): SpendingTransaction[] {
  return [...transactions].sort((left, right) => {
    const dateCompare = right.postedDate.localeCompare(left.postedDate);
    if (dateCompare !== 0) return dateCompare;
    return Math.abs(right.amount) - Math.abs(left.amount);
  });
}

async function main() {
  const cardLedgers = await Promise.all(CARD_LEDGER_FILES.map(readLedger));
  const emailLedgers = await Promise.all(EMAIL_LEDGER_FILES.map(readLedger));
  const cards = sortedTransactions(
    cardLedgers.flatMap((ledger) => ledger?.transactions ?? []).filter(isAmazonCardTransaction),
  );
  const emails = sortedTransactions(
    emailLedgers.flatMap((ledger) => ledger?.transactions ?? []).filter(isAmazonEmailTransaction),
  );
  const orderEvidenceByEmailId = buildAmazonOrderEvidence(emails);

  const candidates = cards
    .flatMap((card) =>
      emails.map((email) =>
        scoreCandidate(
          card,
          email,
          orderEvidenceByEmailId.get(email.id) ?? {
            key: `email:${email.id}`,
            items: amazonItemsOf(email),
            itemDetails: amazonItemDetailsOf(email),
            emailKinds: [amazonEmailKindOf(email)].filter((value): value is string => Boolean(value)),
            subjects: [subjectOf(email)],
            primaryAmount: email.amount > 0 ? email.amount : undefined,
            orderedAmount: amazonEmailKindOf(email) === 'ordered' ? email.amount : undefined,
            shippedAmount: amazonEmailKindOf(email) === 'shipped' ? email.amount : undefined,
            itemSubtotal: itemSubtotal(amazonItemDetailsOf(email)),
            emails: [email],
          },
        ),
      ),
    )
    .filter((candidate): candidate is MatchCandidate => Boolean(candidate))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.dateDeltaDays !== right.dateDeltaDays) return left.dateDeltaDays - right.dateDeltaDays;
      return right.confidence - left.confidence;
    });

  const usedCardIds = new Set<string>();
  const usedEmailIds = new Set<string>();
  const matches: MatchCandidate[] = [];

  candidates.forEach((candidate) => {
    if (usedCardIds.has(candidate.card.id) || usedEmailIds.has(candidate.email.id)) return;
    usedCardIds.add(candidate.card.id);
    usedEmailIds.add(candidate.email.id);
    matches.push(candidate);
  });

  const unmatchedCards = cards.filter((card) => !usedCardIds.has(card.id));
  const unmatchedEmails = emails.filter((email) => !usedEmailIds.has(email.id));
  const nowIso = new Date().toISOString();
  const payload = {
    schemaVersion: 'amazon-card-email-alignment-v1',
    generatedAtIso: nowIso,
    since: SINCE,
    sourceFiles: {
      cards: CARD_LEDGER_FILES,
      emails: EMAIL_LEDGER_FILES,
    },
    summary: {
      cardTransactionCount: cards.length,
      emailEvidenceCount: emails.length,
      matchedCount: matches.length,
      unmatchedCardCount: unmatchedCards.length,
      unmatchedEmailCount: unmatchedEmails.length,
      matchedCardSpend: Math.round(matches.reduce((total, match) => total + match.card.amount, 0) * 100) / 100,
      unmatchedCardSpend: Math.round(unmatchedCards.reduce((total, card) => total + card.amount, 0) * 100) / 100,
    },
    matches: matches.map((match) => ({
      cardTransactionId: match.card.id,
      emailTransactionId: match.email.id,
      confidence: match.confidence,
      dateDeltaDays: match.dateDeltaDays,
      notes: match.notes,
      card: {
        id: match.card.id,
        postedDate: match.card.postedDate,
        transactionDate: match.card.transactionDate,
        merchant: match.card.merchant,
        amount: match.card.amount,
        sourceId: match.card.source?.sourceId,
      },
      email: {
        id: match.email.id,
        postedDate: match.email.postedDate,
        amount: match.email.amount,
        source: match.email.source?.source,
        subject: subjectOf(match.email),
        from: match.email.rawEvidence?.from,
        gmailUid: match.email.rawEvidence?.gmailUid,
      },
      order: {
        orderId: match.order.orderId,
        items: match.order.items,
        itemDetails: match.order.itemDetails,
        emailKinds: match.order.emailKinds,
        subjects: match.order.subjects,
        orderedAmount: match.order.orderedAmount,
        shippedAmount: match.order.shippedAmount,
        primaryAmount: match.order.primaryAmount,
        itemSubtotal: match.order.itemSubtotal,
        evidenceEmailCount: match.order.emails.length,
      },
    })),
    unmatchedCards: unmatchedCards.map((card) => ({
      id: card.id,
      postedDate: card.postedDate,
      transactionDate: card.transactionDate,
      merchant: card.merchant,
      amount: card.amount,
      sourceId: card.source?.sourceId,
    })),
    unmatchedEmails: unmatchedEmails.slice(0, 200).map((email) => ({
      id: email.id,
      postedDate: email.postedDate,
      amount: email.amount,
      source: email.source?.source,
      subject: subjectOf(email),
      orderId: amazonOrderIdOf(email),
      items: amazonItemsOf(email),
      itemDetails: amazonItemDetailsOf(email),
      emailKind: amazonEmailKindOf(email),
      gmailUid: email.rawEvidence?.gmailUid,
    })),
  };

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        outFile: OUT_FILE,
        ...payload.summary,
        sampleMatches: payload.matches.slice(0, 8).map((match) => ({
          cardDate: match.card.postedDate,
          cardAmount: match.card.amount,
          cardMerchant: match.card.merchant,
          emailDate: match.email.postedDate,
          emailSubject: match.email.subject,
          confidence: match.confidence,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
