import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  importGmailTransactionEmails,
  type GmailTransactionEmailImportIssue,
} from '../src/gmail-transaction-email-import';
import type { SpendingTransaction } from '../src/spending-ledger';
import {
  ImapConnection,
  parseFetchRawMessages,
  parseRawEmail,
  parseSearchResponse,
  quoteImapString,
  toImapDate,
} from './gmail-imap-client';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });

interface CliOptions {
  mailbox: string;
  since: string;
  limit: number;
  outFile: string;
  stateFile: string;
  accountId: string;
}

interface GmailSpendingLedgerPayload {
  schemaVersion: 'spending-ledger-local-v1';
  importedAtIso: string;
  fetchedAtIso: string;
  account: string;
  mailbox: string;
  source: {
    kind: 'gmail_imap';
    accountId: string;
    lastSyncedUid: number;
  };
  transactions: SpendingTransaction[];
  issues: GmailTransactionEmailImportIssue[];
  summary: {
    transactionCount: number;
    issueCount: number;
    lastSyncedUid: number;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
  };
}

interface GmailSyncState {
  schemaVersion: 'spending-mail-sync-state-v1';
  account: string;
  mailbox: string;
  lastSeenUid: number;
  updatedAtIso: string;
}

const DEFAULT_USER = 'bonnertransactions@gmail.com';

function parseArgs(argv: string[]): CliOptions {
  let mailbox = 'INBOX';
  let since = '2026-01-01';
  let limit = 250;
  let outFile = 'public/local/spending-ledger.gmail.json';
  let stateFile = 'public/local/spending-mail-sync-state.json';
  let accountId = 'gmail-transactions';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mailbox') {
      mailbox = argv[index + 1] ?? mailbox;
      index += 1;
    } else if (arg === '--since') {
      since = argv[index + 1] ?? since;
      index += 1;
    } else if (arg === '--limit') {
      limit = Number(argv[index + 1] ?? limit);
      index += 1;
    } else if (arg === '--out') {
      outFile = argv[index + 1] ?? outFile;
      index += 1;
    } else if (arg === '--state') {
      stateFile = argv[index + 1] ?? stateFile;
      index += 1;
    } else if (arg === '--account') {
      accountId = argv[index + 1] ?? accountId;
      index += 1;
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    throw new Error('--limit must be a number from 1 to 1000');
  }

  return { mailbox, since, limit, outFile, stateFile, accountId };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function uidFromTransaction(transaction: SpendingTransaction): number {
  const uid = transaction.rawEvidence?.gmailUid;
  return typeof uid === 'number' && Number.isInteger(uid) ? uid : 0;
}

function maxSeenUidFromPayload(payload: GmailSpendingLedgerPayload | null): number {
  if (!payload) return 0;
  const transactionMax = Math.max(0, ...payload.transactions.map(uidFromTransaction));
  const issueMax = Math.max(0, ...payload.issues.map((issue) => issue.uid));
  return Math.max(payload.source?.lastSyncedUid ?? 0, payload.summary?.lastSyncedUid ?? 0, transactionMax, issueMax);
}

function transactionMergeKey(transaction: SpendingTransaction): string {
  const sourceId = transaction.source?.sourceId;
  if (sourceId) {
    return [
      transaction.accountId ?? 'unknown-account',
      transaction.rawEvidence?.gmailUid ?? 'unknown-uid',
      sourceId,
    ].join('|');
  }
  return transaction.id;
}

function mergeById(transactions: SpendingTransaction[]): SpendingTransaction[] {
  const byId = new Map<string, SpendingTransaction>();
  transactions.forEach((transaction) => {
    byId.set(transactionMergeKey(transaction), transaction);
  });
  return Array.from(byId.values()).sort((left, right) => {
    const dateCompare = right.postedDate.localeCompare(left.postedDate);
    if (dateCompare !== 0) return dateCompare;
    return left.id.localeCompare(right.id);
  });
}

function mergeIssues(
  issues: GmailTransactionEmailImportIssue[],
): GmailTransactionEmailImportIssue[] {
  const byUid = new Map<number, GmailTransactionEmailImportIssue>();
  issues.forEach((issue) => {
    byUid.set(issue.uid, issue);
  });
  return Array.from(byUid.values()).sort((left, right) => right.uid - left.uid);
}

function countBy<T>(values: T[], readKey: (value: T) => string | undefined): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = readKey(value) ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function uniqueUids(uids: number[]): number[] {
  return Array.from(new Set(uids.filter((uid) => Number.isInteger(uid) && uid > 0)));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempFile, filePath);
}

async function fetchRawMessages(input: {
  connection: ImapConnection;
  uids: number[];
}): Promise<ReturnType<typeof parseFetchRawMessages>> {
  if (!input.uids.length) return [];
  return parseFetchRawMessages(
    await input.connection.command(
      `UID FETCH ${input.uids.join(',')} (UID RFC822.SIZE BODY.PEEK[])`,
    ),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const user = process.env.GMAIL_IMAP_USER ?? DEFAULT_USER;
  const password = process.env.GMAIL_IMAP_APP_PASSWORD;
  const host = process.env.GMAIL_IMAP_HOST ?? 'imap.gmail.com';
  const port = Number(process.env.GMAIL_IMAP_PORT ?? 993);

  if (!password) {
    throw new Error(
      [
        'Missing GMAIL_IMAP_APP_PASSWORD.',
        'Create .env.local in /Users/robbonner/retirement-calculator with:',
        `GMAIL_IMAP_USER=${user}`,
        'GMAIL_IMAP_APP_PASSWORD=<gmail app password>',
        '',
        'Do not commit or paste the app password into chat.',
      ].join('\n'),
    );
  }

  const existingPayload = await readJsonFile<GmailSpendingLedgerPayload>(options.outFile);
  const existingState = await readJsonFile<GmailSyncState>(options.stateFile);
  const lastSeenUid = Math.max(
    existingState?.lastSeenUid ?? 0,
    maxSeenUidFromPayload(existingPayload),
  );

  const connection = await ImapConnection.connect({ host, port });
  try {
    await connection.command(
      `LOGIN ${quoteImapString(user)} ${quoteImapString(password)}`,
      { redactLog: true },
    );
    await connection.command(`SELECT ${quoteImapString(options.mailbox)}`);

    const searchCommand =
      lastSeenUid > 0
        ? `UID SEARCH UID ${lastSeenUid + 1}:*`
        : `UID SEARCH SINCE ${toImapDate(options.since)}`;
    const candidateUids = parseSearchResponse(await connection.command(searchCommand));
    const newUids = candidateUids
      .filter((uid) => uid > lastSeenUid)
      .slice(-options.limit);
    const retryIssueUids = uniqueUids((existingPayload?.issues ?? []).map((issue) => issue.uid));
    const fetchUids = uniqueUids([...retryIssueUids, ...newUids]).slice(-options.limit);
    const rawMessages = await fetchRawMessages({ connection, uids: fetchUids });
    await connection.command('LOGOUT').catch(() => undefined);

    const emails = rawMessages.map((message) => {
      const parsed = parseRawEmail(message.raw);
      return {
        uid: message.uid,
        size: message.size,
        date: parsed.date,
        from: parsed.from,
        subject: parsed.subject,
        messageId: parsed.messageId,
        bodyText: parsed.bodyText,
      };
    });
    const imported = importGmailTransactionEmails(emails, {
      accountId: options.accountId,
      mailbox: options.mailbox,
    });

    const transactions = mergeById([
      ...(existingPayload?.transactions ?? []),
      ...imported.transactions,
    ]);
    const resolvedIssueUids = new Set(imported.transactions.map(uidFromTransaction));
    const unresolvedExistingIssues = (existingPayload?.issues ?? []).filter(
      (issue) => !resolvedIssueUids.has(issue.uid),
    );
    const issues = mergeIssues([...unresolvedExistingIssues, ...imported.issues]);
    const maxFetchedUid = Math.max(0, ...newUids);
    const nextLastSeenUid = Math.max(lastSeenUid, maxFetchedUid);
    const nowIso = new Date().toISOString();
    const payload: GmailSpendingLedgerPayload = {
      schemaVersion: 'spending-ledger-local-v1',
      importedAtIso: nowIso,
      fetchedAtIso: nowIso,
      account: user,
      mailbox: options.mailbox,
      source: {
        kind: 'gmail_imap',
        accountId: options.accountId,
        lastSyncedUid: nextLastSeenUid,
      },
      transactions,
      issues,
      summary: {
        transactionCount: transactions.length,
        issueCount: issues.length,
        lastSyncedUid: nextLastSeenUid,
        bySource: countBy(transactions, (transaction) => transaction.source?.source),
        byCategory: countBy(transactions, (transaction) => transaction.categoryId),
      },
    };
    const state: GmailSyncState = {
      schemaVersion: 'spending-mail-sync-state-v1',
      account: user,
      mailbox: options.mailbox,
      lastSeenUid: nextLastSeenUid,
      updatedAtIso: nowIso,
    };

    await writeJsonAtomic(options.outFile, payload);
    await writeJsonAtomic(options.stateFile, state);

    console.log(
      JSON.stringify(
        {
          outFile: options.outFile,
          stateFile: options.stateFile,
          mailbox: options.mailbox,
          previousLastSeenUid: lastSeenUid,
          lastSeenUid: nextLastSeenUid,
          checkedUidCount: candidateUids.length,
          fetchedUidCount: fetchUids.length,
          retriedIssueCount: retryIssueUids.length,
          newTransactionCount: imported.transactions.length,
          newIssueCount: imported.issues.length,
          totalTransactionCount: transactions.length,
          totalIssueCount: issues.length,
        },
        null,
        2,
      ),
    );
  } finally {
    connection.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
