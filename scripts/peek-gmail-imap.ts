import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ImapConnection,
  parseFetchHeaderResponse,
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
  gmailQuery?: string;
}

const DEFAULT_USER = 'bonnertransactions@gmail.com';

function parseArgs(argv: string[]): CliOptions {
  let mailbox = 'INBOX';
  let since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  let limit = 50;
  let outFile = 'public/local/gmail-imap-peek.json';
  let gmailQuery: string | undefined;

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
    } else if (arg === '--gmail-query') {
      const query = argv[index + 1];
      if (query) {
        gmailQuery = query;
      }
      index += 1;
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
    throw new Error('--limit must be a number from 1 to 500');
  }

  return { mailbox, since, limit, outFile, gmailQuery };
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
        'Create a local .env.local with:',
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
    const search = await connection.command(
      options.gmailQuery
        ? `UID SEARCH X-GM-RAW ${quoteImapString(options.gmailQuery)}`
        : `UID SEARCH SINCE ${toImapDate(options.since)}`,
    );
    const uids = parseSearchResponse(search).slice(-options.limit);
    const headers = uids.length
      ? parseFetchHeaderResponse(
          await connection.command(
            `UID FETCH ${uids.join(',')} (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT MESSAGE-ID)])`,
          ),
        )
      : [];
    await connection.command('LOGOUT').catch(() => undefined);

    const payload = {
      schemaVersion: 'gmail-imap-peek-v1',
      fetchedAtIso: new Date().toISOString(),
      account: user,
      mailbox: options.mailbox,
      since: options.since,
      limit: options.limit,
      gmailQuery: options.gmailQuery,
      messageCount: headers.length,
      messages: headers,
    };

    await fs.mkdir(path.dirname(options.outFile), { recursive: true });
    await fs.writeFile(options.outFile, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          outFile: options.outFile,
          account: user,
          mailbox: options.mailbox,
          messageCount: headers.length,
          firstSubjects: headers.slice(0, 10).map((message) => message.subject),
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
