import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SeedData } from '../src/types';
import {
  portfolioQuoteSymbols,
  type PortfolioPriceHistory,
  type PortfolioQuote,
  type PortfolioQuoteSnapshot,
} from '../src/portfolio-weather';

interface Args {
  repo: string;
  seed: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: '.',
    seed: 'seed-data.json',
    out: 'public/local/portfolio-quotes.json',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      args.repo = argv[++index];
    } else if (arg === '--seed') {
      args.seed = argv[++index];
    } else if (arg === '--out') {
      args.out = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

interface YahooChartData {
  quote: PortfolioQuote;
  history: PortfolioPriceHistory | null;
}

async function fetchYahooChartData(symbol: string): Promise<YahooChartData | null> {
  if (symbol.includes('_')) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=1y&interval=1d`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'retirement-calculator-six-pack/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        meta?: {
          symbol?: string;
          regularMarketPrice?: number;
          previousClose?: number;
          regularMarketTime?: number;
        };
        indicators?: {
          quote?: Array<{
            close?: Array<number | null>;
          }>;
          adjclose?: Array<{
            adjclose?: Array<number | null>;
          }>;
        };
      }>;
    };
  };
  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  const price = meta?.regularMarketPrice ?? meta?.previousClose;
  if (!Number.isFinite(price) || !price || price <= 0) return null;
  const asOfIso =
    typeof meta?.regularMarketTime === 'number'
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString();
  const resolvedSymbol = (meta?.symbol ?? symbol).toUpperCase();
  const quote: PortfolioQuote = {
    symbol: resolvedSymbol,
    price,
    asOfIso,
    source: 'yahoo_chart',
  };
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close ?? [];
  const points = timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: closes[index],
    }))
    .filter(
      (point): point is { date: string; close: number } =>
        typeof point.close === 'number' &&
        Number.isFinite(point.close) &&
        point.close > 0,
    );
  const history: PortfolioPriceHistory | null = points.length
    ? {
        symbol: resolvedSymbol,
        source: 'yahoo_chart',
        asOfIso,
        points,
      }
    : null;

  return { quote, history };
}

const args = parseArgs(process.argv);
const repo = path.resolve(args.repo);
const seedPath = path.resolve(repo, args.seed);
const outPath = path.resolve(repo, args.out);
const seed = JSON.parse(await readFile(seedPath, 'utf8')) as SeedData;
const symbols = portfolioQuoteSymbols(seed);
const quotes: PortfolioQuote[] = [];
const histories: PortfolioPriceHistory[] = [];
const unavailableSymbols: string[] = [];

for (const symbol of symbols) {
  try {
    const data = await fetchYahooChartData(symbol);
    if (data) {
      quotes.push(data.quote);
      if (data.history) histories.push(data.history);
    } else {
      unavailableSymbols.push(symbol);
    }
  } catch {
    unavailableSymbols.push(symbol);
  }
}

const snapshot: PortfolioQuoteSnapshot = {
  asOfIso: new Date().toISOString(),
  source: 'yahoo_chart',
  quotes: quotes.sort((left, right) => left.symbol.localeCompare(right.symbol)),
  histories: histories.sort((left, right) => left.symbol.localeCompare(right.symbol)),
  unavailableSymbols: unavailableSymbols.sort(),
};

await mkdir(path.dirname(outPath), { recursive: true });
const tmpPath = `${outPath}.tmp`;
await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
await rename(tmpPath, outPath);

console.log(JSON.stringify({
  outPath,
  requested: symbols.length,
  quoted: quotes.length,
  histories: histories.length,
  unavailable: unavailableSymbols,
}, null, 2));
