import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importGmailTransactionEmails } from '../src/gmail-transaction-email-import';
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
  accountId: string;
}

const DEFAULT_USER = 'bonnertransactions@gmail.com';

function parseArgs(argv: string[]): CliOptions {
  let mailbox = 'INBOX';
  let since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let limit = 50;
  let outFile = 'public/local/spending-ledger.gmail.json';
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
    } else if (arg === '--account') {
      accountId = argv[index + 1] ?? accountId;
      index += 1;
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 250) {
    throw new Error('--limit must be a number from 1 to 250');
  }

  return { mailbox, since, limit, outFile, accountId };
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

  const connection = await ImapConnection.connect({ host, port });
  try {
    await connection.command(
      `LOGIN ${quoteImapString(user)} ${quoteImapString(password)}`,
      { redactLog: true },
    );
    await connection.command(`SELECT ${quoteImapString(options.mailbox)}`);
    const search = await connection.command(`UID SEARCH SINCE ${toImapDate(options.since)}`);
    const uids = parseSearchResponse(search).slice(-options.limit);
    const rawMessages = uids.length
      ? parseFetchRawMessages(
          await connection.command(`UID FETCH ${uids.join(',')} (UID RFC822.SIZE BODY.PEEK[])`),
        )
      : [];
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

    const result = importGmailTransactionEmails(emails, {
      accountId: options.accountId,
      mailbox: options.mailbox,
    });
    const payload = {
      ...result,
      fetchedAtIso: new Date().toISOString(),
      account: user,
      mailbox: options.mailbox,
      since: options.since,
      limit: options.limit,
    };

    await fs.mkdir(path.dirname(options.outFile), { recursive: true });
    await fs.writeFile(options.outFile, `${JSON.stringify(payload, null, 2)}\n`);

    const issueCounts = result.issues.reduce<Record<string, number>>((counts, issue) => {
      counts[issue.code] = (counts[issue.code] ?? 0) + 1;
      return counts;
    }, {});
    console.log(
      JSON.stringify(
        {
          outFile: options.outFile,
          account: user,
          mailbox: options.mailbox,
          messageCount: result.messageCount,
          transactionCount: result.transactions.length,
          issueCounts,
          sampleTransactions: result.transactions.slice(0, 8).map((transaction) => ({
            postedDate: transaction.postedDate,
            merchant: transaction.merchant,
            amount: transaction.amount,
            categoryId: transaction.categoryId,
            source: transaction.source?.source,
          })),
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
