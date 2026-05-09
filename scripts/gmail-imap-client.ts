import tls from 'node:tls';

export interface ImapHeaderPeek {
  uid: number;
  size: number | null;
  date: string | null;
  from: string | null;
  subject: string | null;
  messageId: string | null;
}

export interface ImapRawMessage {
  uid: number;
  size: number | null;
  raw: string;
}

export interface ParsedRawEmail {
  date: string | null;
  from: string | null;
  subject: string | null;
  messageId: string | null;
  bodyText: string;
}

export function quoteImapString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function toImapDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${date.getUTCDate()}-${date.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  })}-${date.getUTCFullYear()}`;
}

function decodeMimeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([QB])\?([^?]+)\?=/gi,
    (_match, charset: string, encoding: string, encoded: string) => {
      try {
        const normalizedCharset = charset.toLowerCase();
        if (normalizedCharset !== 'utf-8' && normalizedCharset !== 'us-ascii') {
          return encoded;
        }
        const bytes =
          encoding.toUpperCase() === 'B'
            ? Buffer.from(encoded, 'base64')
            : Buffer.from(
                encoded
                  .replaceAll('_', ' ')
                  .replace(/=([0-9A-F]{2})/gi, (_hexMatch, hex: string) =>
                    String.fromCharCode(Number.parseInt(hex, 16)),
                  ),
                'binary',
              );
        return bytes.toString('utf8');
      } catch {
        return encoded;
      }
    },
  );
}

function parseHeaderBlock(headerBlock: string): Omit<ImapHeaderPeek, 'uid' | 'size'> {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const read = (name: string) => {
    const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
    return match?.[1]?.trim() || null;
  };
  return {
    date: read('Date'),
    from: read('From'),
    subject: read('Subject') ? decodeMimeWords(read('Subject') ?? '') : null,
    messageId: read('Message-ID') ?? read('Message-Id'),
  };
}

export function parseSearchResponse(response: string): number[] {
  const match = /^\* SEARCH(?: (.*))?$/m.exec(response);
  if (!match?.[1]) return [];
  return match[1]
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function parseFetchHeaderResponse(response: string): ImapHeaderPeek[] {
  const results: ImapHeaderPeek[] = [];
  const fetchRe =
    /\* \d+ FETCH \((?:.*? )?UID (\d+)(?: .*?RFC822\.SIZE (\d+))?[\s\S]*?\{(\d+)\}\r\n([\s\S]*?)\r\n\)/g;
  let match: RegExpExecArray | null;
  while ((match = fetchRe.exec(response))) {
    const headerLength = Number(match[3]);
    const headerBlock = match[4].slice(0, headerLength);
    results.push({
      uid: Number(match[1]),
      size: match[2] ? Number(match[2]) : null,
      ...parseHeaderBlock(headerBlock),
    });
  }
  return results.sort((left, right) => right.uid - left.uid);
}

export function parseFetchRawMessages(response: string): ImapRawMessage[] {
  const results: ImapRawMessage[] = [];
  const fetchRe =
    /\* \d+ FETCH \((?=[\s\S]*?UID (\d+))(?=[\s\S]*?(?:RFC822\.SIZE (\d+))?)[\s\S]*?\{(\d+)\}\r\n/g;
  let match: RegExpExecArray | null;
  while ((match = fetchRe.exec(response))) {
    const bodyLength = Number(match[3]);
    const bodyStart = match.index + match[0].length;
    const raw = response.slice(bodyStart, bodyStart + bodyLength);
    results.push({
      uid: Number(match[1]),
      size: match[2] ? Number(match[2]) : null,
      raw,
    });
    fetchRe.lastIndex = bodyStart + bodyLength;
  }
  return results.sort((left, right) => right.uid - left.uid);
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function decodeTransfer(value: string, encoding: string | null): string {
  const normalized = encoding?.toLowerCase() ?? '';
  if (normalized === 'base64') {
    try {
      return Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return value;
    }
  }
  if (normalized === 'quoted-printable') {
    return decodeQuotedPrintable(value);
  }
  return value;
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function readHeader(headers: string, name: string): string | null {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
  return match?.[1]?.trim() ?? null;
}

function extractBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2] ?? null;
}

function splitRawEmail(raw: string): { headers: string; body: string } {
  const separator = raw.search(/\r?\n\r?\n/);
  if (separator === -1) return { headers: raw, body: '' };
  const separatorMatch = /\r?\n\r?\n/.exec(raw.slice(separator));
  const separatorLength = separatorMatch?.[0].length ?? 2;
  return {
    headers: raw.slice(0, separator),
    body: raw.slice(separator + separatorLength),
  };
}

function extractBodyText(raw: string): string {
  const { headers, body } = splitRawEmail(raw);
  const contentType = readHeader(headers, 'Content-Type');
  const transferEncoding = readHeader(headers, 'Content-Transfer-Encoding');
  const boundary = extractBoundary(contentType);

  if (!boundary) {
    const decoded = decodeTransfer(body, transferEncoding);
    return /text\/html/i.test(contentType ?? '') ? stripHtml(decoded) : decoded.trim();
  }

  const parts = body.split(`--${boundary}`);
  const decodedParts = parts
    .map((part) => splitRawEmail(part.trim()))
    .map((part) => {
      const partType = readHeader(part.headers, 'Content-Type') ?? '';
      const partEncoding = readHeader(part.headers, 'Content-Transfer-Encoding');
      const decoded = decodeTransfer(part.body, partEncoding);
      return {
        type: partType,
        text: /text\/html/i.test(partType) ? stripHtml(decoded) : decoded.trim(),
      };
    })
    .filter((part) => part.text.length > 0);

  const plain = decodedParts.filter((part) => /text\/plain/i.test(part.type));
  if (plain.length) return plain.map((part) => part.text).join('\n\n').trim();
  const html = decodedParts.filter((part) => /text\/html/i.test(part.type));
  if (html.length) return html.map((part) => part.text).join('\n\n').trim();
  return decodedParts.map((part) => part.text).join('\n\n').trim();
}

export function parseRawEmail(raw: string): ParsedRawEmail {
  const { headers } = splitRawEmail(raw);
  return {
    ...parseHeaderBlock(headers),
    bodyText: extractBodyText(raw),
  };
}

export class ImapConnection {
  private socket: tls.TLSSocket;
  private buffer = '';
  private tagIndex = 1;

  private constructor(socket: tls.TLSSocket) {
    this.socket = socket;
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
    });
  }

  static async connect(input: { host: string; port: number }): Promise<ImapConnection> {
    const socket = tls.connect({
      host: input.host,
      port: input.port,
      servername: input.host,
    });
    const connection = new ImapConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to IMAP')), 15000);
      socket.once('secureConnect', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once('error', reject);
    });
    await connection.waitForGreeting();
    return connection;
  }

  private async waitForGreeting(): Promise<void> {
    await this.waitUntil((buffer) => /^\* OK/m.test(buffer), 15000);
    this.buffer = '';
  }

  private nextTag(): string {
    return `A${String(this.tagIndex++).padStart(4, '0')}`;
  }

  private async waitUntil(
    predicate: (buffer: string) => boolean,
    timeoutMs: number,
  ): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate(this.buffer)) {
        return this.buffer;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for IMAP response');
  }

  async command(command: string, options?: { redactLog?: boolean }): Promise<string> {
    const tag = this.nextTag();
    this.buffer = '';
    this.socket.write(`${tag} ${command}\r\n`);
    const response = await this.waitUntil(
      (buffer) => new RegExp(`^${tag} (?:OK|NO|BAD)`, 'm').test(buffer),
      30000,
    );
    if (new RegExp(`^${tag} (?:NO|BAD)`, 'm').test(response)) {
      const safeCommand = options?.redactLog ? '[redacted]' : command;
      throw new Error(`IMAP command failed: ${safeCommand}\n${response}`);
    }
    return response;
  }

  close(): void {
    this.socket.end();
  }
}
