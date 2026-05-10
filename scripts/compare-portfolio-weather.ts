import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PortfolioQuoteSnapshot } from '../src/portfolio-weather';
import { buildPortfolioWeatherSnapshot } from '../src/portfolio-weather';
import type { SeedData } from '../src/types';

interface Args {
  csv?: string;
  repo: string;
  seed: string;
  quotes: string;
}

interface ActualHolding {
  symbol: string;
  name: string;
  value: number;
}

interface SymbolComparison {
  symbol: string;
  predictedValue: number;
  actualValue: number;
  actualMinusPredicted: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: '.',
    seed: 'seed-data.json',
    quotes: 'public/local/portfolio-quotes.json',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      args.repo = argv[++index];
    } else if (arg === '--seed') {
      args.seed = argv[++index];
    } else if (arg === '--quotes') {
      args.quotes = argv[++index];
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

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
  return String(description ?? '').trim().replace(/\s+/g, ' ');
}

async function readActualHoldings(csvPath: string): Promise<ActualHolding[]> {
  const text = (await readFile(csvPath, 'utf8')).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((item) => item.trim());
  const holdings: ActualHolding[] = [];
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
    const value = round2(numberValue(raw['Current Value']) ?? 0);
    if (value <= 0) continue;
    const symbol = cleanSymbol(raw.Symbol, raw.Description);
    holdings.push({
      symbol,
      name: cleanDescription(raw.Description, symbol),
      value,
    });
  }
  return holdings;
}

function aggregateBySymbol(rows: Array<{ symbol: string; value: number }>): Map<string, number> {
  const values = new Map<string, number>();
  rows.forEach((row) => {
    values.set(row.symbol, round2((values.get(row.symbol) ?? 0) + row.value));
  });
  return values;
}

function buildSymbolComparisons(input: {
  predictedBySymbol: Map<string, number>;
  actualBySymbol: Map<string, number>;
}): SymbolComparison[] {
  const symbols = new Set([...input.predictedBySymbol.keys(), ...input.actualBySymbol.keys()]);
  return [...symbols]
    .map((symbol) => {
      const predictedValue = input.predictedBySymbol.get(symbol) ?? 0;
      const actualValue = input.actualBySymbol.get(symbol) ?? 0;
      return {
        symbol,
        predictedValue,
        actualValue,
        actualMinusPredicted: round2(actualValue - predictedValue),
      };
    })
    .sort((left, right) => Math.abs(right.actualMinusPredicted) - Math.abs(left.actualMinusPredicted));
}

const args = parseArgs(process.argv);
const repo = path.resolve(args.repo);
const seedPath = path.resolve(repo, args.seed);
const quotesPath = path.resolve(repo, args.quotes);
const csvPath = path.resolve(args.csv);
const seed = JSON.parse(await readFile(seedPath, 'utf8')) as SeedData;
const quoteSnapshot = JSON.parse(await readFile(quotesPath, 'utf8')) as PortfolioQuoteSnapshot;
const weather = buildPortfolioWeatherSnapshot({
  data: seed,
  quoteSnapshot,
  asOfIso: quoteSnapshot.asOfIso,
});
const actualHoldings = await readActualHoldings(csvPath);
const actualFidelitySubtotal = round2(
  actualHoldings.reduce((total, holding) => total + holding.value, 0),
);
const predictedBySymbol = aggregateBySymbol(
  weather.holdings.map((holding) => ({
    symbol: holding.symbol,
    value: holding.estimatedValue,
  })),
);
const actualBySymbol = aggregateBySymbol(actualHoldings);
const symbolComparisons = buildSymbolComparisons({ predictedBySymbol, actualBySymbol });
const externalModelCash = round2(seed.accounts.cash.balance);
const actualMinusPredicted = round2(actualFidelitySubtotal - weather.estimatedValue);

console.log(JSON.stringify(
  {
    csvPath,
    seedPath,
    quotesPath,
    note: 'Comparison only. seed-data.json is not modified.',
    summary: {
      quoteSnapshotAsOfIso: quoteSnapshot.asOfIso,
      lastImportAsOfDate: weather.importAsOfDate,
      predictedFidelitySubtotal: weather.estimatedValue,
      actualFidelitySubtotal,
      actualMinusPredicted,
      errorPercentOfActual:
        actualFidelitySubtotal > 0
          ? round2((actualMinusPredicted / actualFidelitySubtotal) * 100)
          : 0,
      externalModelCashNotInFidelityExport: externalModelCash,
      predictedModelTotalWithExternalCash: round2(weather.estimatedValue + externalModelCash),
      actualModelTotalWithExternalCash: round2(actualFidelitySubtotal + externalModelCash),
      quoteCoveragePercent: weather.quoteCoveragePercent,
      heldAtImportValue: weather.heldAtImportValue,
      cashValueHeldAtImport: weather.cashValueHeldAtImport,
      missingQuoteValueHeldAtImport: weather.missingQuoteValueHeldAtImport,
      missingShareValueHeldAtImport: weather.missingShareValueHeldAtImport,
      missingQuoteSymbols: weather.missingQuoteSymbols,
      missingShareSymbols: weather.missingShareSymbols,
    },
    largestSymbolDrivers: symbolComparisons.slice(0, 12),
  },
  null,
  2,
));
