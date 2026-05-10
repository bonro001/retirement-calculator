import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Holding, SeedData, SourceAccount } from '../src/types';

interface Args {
  csv?: string;
  repo: string;
  seed: string;
  apply: boolean;
}

interface PositionRow {
  accountNumber: string;
  accountName: string;
  sleeveName: string;
  symbol: string;
  name: string;
  value: number;
  shares?: number;
  lastPrice?: number;
  costBasis?: number;
}

interface GroupedAccount {
  accountNumber: string;
  accountName: string;
  sleeveName: string;
  bucket: keyof SeedData['accounts'] | null;
  value: number;
  holdings: Holding[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repo: '.', seed: 'seed-data.json', apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--repo') {
      args.repo = argv[++index];
    } else if (arg === '--seed') {
      args.seed = argv[++index];
    } else if (arg === '--csv') {
      args.csv = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.csv) throw new Error('Missing --csv <path>');
  return args;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '"') {
      if (inQ && line[index + 1] === '"') {
        cur += '"';
        index += 1;
      } else {
        inQ = !inQ;
      }
    } else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function numberValue(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  const negative = trimmed.startsWith('-');
  const parsed = Number(trimmed.replace(/[$,+%*]/g, '').replace(/^-/, ''));
  if (!Number.isFinite(parsed)) return undefined;
  return negative ? -parsed : parsed;
}

function money(value: unknown): number {
  return round2(numberValue(value) ?? 0);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function cleanSymbol(symbol: string, description: string): string {
  const stripped = String(symbol ?? '').replace(/\*+$/g, '').trim();
  const desc = String(description ?? '').toUpperCase();
  if (!stripped || stripped === 'SPAXX' || stripped === 'FDRXX' || desc.includes('HELD IN MONEY MARKET')) {
    return 'CASH';
  }
  if (stripped === '872799606' || desc.includes('TRP RETIRE 2030')) {
    return 'TRP_2030';
  }
  return stripped.toUpperCase();
}

function cleanDescription(description: string, symbol: string): string {
  if (symbol === 'CASH') return 'Held in money market';
  if (symbol === 'TRP_2030') return 'T. Rowe Price Retirement 2030 Fund';
  return String(description ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function asOfDateFromPath(csvPath: string): string {
  const basename = path.basename(csvPath);
  const match = /([A-Z][a-z]{2})-(\d{2})-(\d{4})/.exec(basename);
  if (!match) return new Date().toISOString().slice(0, 10);
  const month = new Date(`${match[1]} 1, 2000`).getMonth() + 1;
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[2]}`;
}

async function readPositions(csvPath: string): Promise<PositionRow[]> {
  const text = (await readFile(csvPath, 'utf8')).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((item) => item.trim());
  const rows: PositionRow[] = [];
  for (const line of lines.slice(1)) {
    if (
      line.startsWith('"The data') ||
      line.startsWith('"Brokerage') ||
      line.startsWith('Date downloaded')
    ) {
      break;
    }
    const cols = parseCsvLine(line);
    if (cols.length < header.length) continue;
    const raw = Object.fromEntries(header.map((item, index) => [item, cols[index] ?? '']));
    const value = money(raw['Current Value']);
    if (value <= 0) continue;
    const symbol = cleanSymbol(raw.Symbol, raw.Description);
    rows.push({
      accountNumber: raw['Account Number'],
      accountName: raw['Account Name'],
      sleeveName: raw['Sleeve Name'],
      symbol,
      name: cleanDescription(raw.Description, symbol),
      value,
      shares: numberValue(raw.Quantity),
      lastPrice: numberValue(raw['Last Price']),
      costBasis: numberValue(raw['Cost Basis Total']),
    });
  }
  return rows;
}

function bucketFor(row: PositionRow): keyof SeedData['accounts'] | null {
  const name = row.accountName.toLowerCase();
  if (name.includes('health savings')) return 'hsa';
  if (name.includes('roth ira')) return 'roth';
  if (name.includes('rollover ira') || name.includes('athenahealth')) return 'pretax';
  if (name.includes('joint wros')) return 'taxable';
  return null;
}

function groupHoldings(rows: PositionRow[], asOfDate: string): GroupedAccount[] {
  const grouped = new Map<string, GroupedAccount & { holdingMap: Map<string, Holding> }>();
  rows.forEach((row) => {
    const bucket = bucketFor(row);
    const key = `${row.accountNumber}|${row.accountName}|${row.sleeveName}|${bucket ?? 'UNMAPPED'}`;
    const account =
      grouped.get(key) ??
      {
        accountNumber: row.accountNumber,
        accountName: row.accountName,
        sleeveName: row.sleeveName,
        bucket,
        value: 0,
        holdings: [],
        holdingMap: new Map<string, Holding>(),
      };
    account.value = round2(account.value + row.value);
    const current =
      account.holdingMap.get(row.symbol) ??
      ({
        symbol: row.symbol,
        name: row.name,
        value: 0,
        asOfDate,
      } satisfies Holding);
    current.value = round2(current.value + row.value);
    current.name = current.name ?? row.name;
    current.asOfDate = asOfDate;
    if (row.shares != null) current.shares = round6((current.shares ?? 0) + row.shares);
    if (row.lastPrice != null) current.lastPrice = row.lastPrice;
    if (row.costBasis != null) current.costBasis = round2((current.costBasis ?? 0) + row.costBasis);
    account.holdingMap.set(row.symbol, current);
    grouped.set(key, account);
  });

  return [...grouped.values()].map((account) => ({
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    sleeveName: account.sleeveName,
    bucket: account.bucket,
    value: round2(account.value),
    holdings: [...account.holdingMap.values()].sort((left, right) =>
      left.symbol === 'CASH' ? -1 : right.symbol === 'CASH' ? 1 : left.symbol.localeCompare(right.symbol),
    ),
  }));
}

function visibleDigits(accountNumber: string): string {
  return accountNumber.replace(/\D/g, '');
}

function sourceNameFor(account: GroupedAccount, existing?: SourceAccount): string {
  if (existing?.name) return existing.name;
  if (account.bucket === 'taxable' && account.sleeveName) return 'Joint WROS - TOD (Managed)';
  if (account.accountName.toLowerCase().includes('athenahealth')) return 'ATHENAHEALTH 401(k)';
  return account.accountName;
}

function findExistingSource(seed: SeedData, account: GroupedAccount): SourceAccount | undefined {
  if (!account.bucket) return undefined;
  const sources = seed.accounts[account.bucket]?.sourceAccounts ?? [];
  const digits = visibleDigits(account.accountNumber);
  if (digits) {
    const match = sources.find((source) => String(source.id ?? '').replace(/\D/g, '').endsWith(digits));
    if (match) return match;
  }
  const managed =
    account.bucket === 'taxable' &&
    account.sleeveName &&
    account.sleeveName.toLowerCase().includes('central investment');
  return sources.find(
    (source) => Boolean(source.managed) === Boolean(managed) && source.name === sourceNameFor(account),
  );
}

function buildSourceAccount(seed: SeedData, account: GroupedAccount): SourceAccount {
  const existing = findExistingSource(seed, account);
  const managed =
    account.bucket === 'taxable' &&
    account.sleeveName &&
    account.sleeveName.toLowerCase().includes('central investment');
  return {
    id: existing?.id ?? (visibleDigits(account.accountNumber) || account.accountNumber),
    name: sourceNameFor(account, existing),
    owner: existing?.owner,
    balance: round2(account.value),
    ...(managed ? { managed: true } : {}),
    holdings: account.holdings,
  };
}

function sumAccounts(accounts: SourceAccount[]): number {
  return round2(accounts.reduce((sum, account) => sum + account.balance, 0));
}

function allocationFromAccounts(accounts: SourceAccount[]): Record<string, number> {
  const total = sumAccounts(accounts);
  const values: Record<string, number> = {};
  accounts.forEach((account) => {
    if (account.managed) {
      values.CENTRAL_MANAGED = (values.CENTRAL_MANAGED ?? 0) + account.balance;
      return;
    }
    account.holdings?.forEach((holding) => {
      values[holding.symbol] = (values[holding.symbol] ?? 0) + holding.value;
    });
  });
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => Number.isFinite(value) && value > 0 && total > 0)
      .sort(([left], [right]) => (left === 'CASH' ? -1 : right === 'CASH' ? 1 : left.localeCompare(right)))
      .map(([symbol, value]) => [symbol, Math.round((value / total) * 10000) / 10000]),
  );
}

function totals(seed: SeedData) {
  const accounts = seed.accounts;
  const fidelitySubtotal =
    accounts.pretax.balance +
    accounts.roth.balance +
    accounts.taxable.balance +
    (accounts.hsa?.balance ?? 0);
  return {
    pretax: round2(accounts.pretax.balance),
    roth: round2(accounts.roth.balance),
    taxable: round2(accounts.taxable.balance),
    hsa: round2(accounts.hsa?.balance ?? 0),
    cash: round2(accounts.cash.balance),
    fidelitySubtotal: round2(fidelitySubtotal),
    modelTotal: round2(fidelitySubtotal + accounts.cash.balance),
  };
}

const args = parseArgs(process.argv);
const repo = path.resolve(args.repo);
const seedPath = path.resolve(repo, args.seed);
const csvPath = path.resolve(args.csv);
const asOfDate = asOfDateFromPath(csvPath);
const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupsDir = path.join(repo, 'backups');
const backupPath = path.join(backupsDir, `seed-data-before-fidelity-enrich-${timestamp}.json`);
const reportPath = path.join(backupsDir, `fidelity-enrich-report-${timestamp}.json`);

const seed = JSON.parse(await readFile(seedPath, 'utf8')) as SeedData;
const before = totals(seed);
const groupedAccounts = groupHoldings(await readPositions(csvPath), asOfDate);
const unmapped = groupedAccounts.filter((account) => account.bucket === null);
if (unmapped.length > 0) {
  console.error(JSON.stringify({ error: 'Unmapped Fidelity accounts', unmapped }, null, 2));
  process.exit(2);
}

(['pretax', 'roth', 'taxable', 'hsa'] as const).forEach((bucket) => {
  const sourceAccounts = groupedAccounts
    .filter((account) => account.bucket === bucket)
    .map((account) => buildSourceAccount(seed, account))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (sourceAccounts.length === 0 || !seed.accounts[bucket]) return;
  seed.accounts[bucket].balance = sumAccounts(sourceAccounts);
  seed.accounts[bucket].sourceAccounts = sourceAccounts;
  seed.accounts[bucket].targetAllocation = allocationFromAccounts(sourceAccounts);
});

const after = totals(seed);
const report = {
  mode: args.apply ? 'apply' : 'dry-run',
  seedPath,
  csvPath,
  asOfDate,
  backupPath: args.apply ? backupPath : null,
  reportPath: args.apply ? reportPath : null,
  before,
  after,
  delta: Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, round2(value - before[key as keyof typeof before])]),
  ),
  accounts: groupedAccounts.map((account) => ({
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    sleeveName: account.sleeveName,
    bucket: account.bucket,
    value: account.value,
    holdingCount: account.holdings.length,
  })),
};

if (Object.values(after).some((value) => !Number.isFinite(value))) {
  console.error(JSON.stringify({ error: 'Import produced non-finite totals', report }, null, 2));
  process.exit(3);
}

if (args.apply) {
  await mkdir(backupsDir, { recursive: true });
  await copyFile(seedPath, backupPath);
  await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
