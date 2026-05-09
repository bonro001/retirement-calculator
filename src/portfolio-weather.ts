import type { Holding, SeedData } from './types';

export interface PortfolioQuote {
  symbol: string;
  price: number;
  asOfIso: string;
  source: string;
}

export interface PortfolioQuoteSnapshot {
  asOfIso: string;
  source: string;
  quotes: PortfolioQuote[];
  unavailableSymbols: string[];
}

export interface PortfolioWeatherHoldingEstimate {
  accountBucket: string;
  accountName: string;
  symbol: string;
  name?: string;
  importValue: number;
  estimatedValue: number;
  shares: number | null;
  importPrice: number | null;
  currentPrice: number | null;
  quoteAsOfIso: string | null;
  status: 'quoted' | 'cash' | 'missing_shares' | 'missing_quote';
}

export interface PortfolioWeatherSnapshot {
  available: boolean;
  asOfIso: string;
  importAsOfDate: string | null;
  quoteAsOfIso: string | null;
  importValue: number;
  estimatedValue: number;
  changeDollars: number;
  changePercent: number;
  quoteCoveragePercent: number;
  quotedImportValue: number;
  quotedEstimatedValue: number;
  cashValueHeldAtImport: number;
  missingQuoteValueHeldAtImport: number;
  missingShareValueHeldAtImport: number;
  heldAtImportValue: number;
  missingQuoteSymbols: string[];
  missingShareSymbols: string[];
  holdings: PortfolioWeatherHoldingEstimate[];
}

const CASH_SYMBOLS = new Set(['CASH']);

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const roundPercent = (value: number) =>
  Math.round((value + Number.EPSILON) * 10000) / 100;

function isQuotedHolding(holding: Holding): boolean {
  return !CASH_SYMBOLS.has(holding.symbol.toUpperCase()) && holding.value > 0;
}

function quoteBySymbol(snapshot: PortfolioQuoteSnapshot | null): Map<string, PortfolioQuote> {
  const bySymbol = new Map<string, PortfolioQuote>();
  (snapshot?.quotes ?? []).forEach((quote) => {
    if (Number.isFinite(quote.price) && quote.price > 0) {
      bySymbol.set(quote.symbol.toUpperCase(), quote);
    }
  });
  return bySymbol;
}

export function portfolioQuoteSymbols(data: SeedData): string[] {
  const symbols = new Set<string>();
  (['pretax', 'roth', 'taxable', 'hsa'] as const).forEach((bucket) => {
    data.accounts[bucket]?.sourceAccounts?.forEach((account) => {
      account.holdings?.forEach((holding) => {
        const symbol = holding.symbol.toUpperCase();
        if (isQuotedHolding(holding)) {
          symbols.add(symbol);
        }
      });
    });
  });
  return [...symbols].sort();
}

export function buildPortfolioWeatherSnapshot(input: {
  data: SeedData;
  quoteSnapshot: PortfolioQuoteSnapshot | null;
  asOfIso: string;
}): PortfolioWeatherSnapshot {
  const quotes = quoteBySymbol(input.quoteSnapshot);
  const holdings: PortfolioWeatherHoldingEstimate[] = [];
  const missingQuoteSymbols = new Set<string>();
  const missingShareSymbols = new Set<string>();
  let quotedImportValue = 0;
  let quotedEstimatedValue = 0;
  let quotedEligibleValue = 0;
  let cashValueHeldAtImport = 0;
  let missingQuoteValueHeldAtImport = 0;
  let missingShareValueHeldAtImport = 0;
  let quoteAsOfIso: string | null = input.quoteSnapshot?.asOfIso ?? null;
  const importDates: string[] = [];

  (['pretax', 'roth', 'taxable', 'hsa'] as const).forEach((bucket) => {
    input.data.accounts[bucket]?.sourceAccounts?.forEach((account) => {
      account.holdings?.forEach((holding) => {
        const symbol = holding.symbol.toUpperCase();
        const importValue = roundMoney(holding.value);
        const shares = typeof holding.shares === 'number' ? holding.shares : null;
        const importPrice =
          typeof holding.lastPrice === 'number' ? holding.lastPrice : null;
        if (holding.asOfDate) importDates.push(holding.asOfDate);

        if (CASH_SYMBOLS.has(symbol)) {
          cashValueHeldAtImport = roundMoney(cashValueHeldAtImport + importValue);
          holdings.push({
            accountBucket: bucket,
            accountName: account.name,
            symbol,
            name: holding.name,
            importValue,
            estimatedValue: importValue,
            shares,
            importPrice,
            currentPrice: null,
            quoteAsOfIso: null,
            status: 'cash',
          });
          return;
        }

        quotedEligibleValue += importValue;
        const quote = quotes.get(symbol);
        if (quoteAsOfIso === null && quote?.asOfIso) quoteAsOfIso = quote.asOfIso;
        if (!shares || shares <= 0) {
          missingShareSymbols.add(symbol);
          missingShareValueHeldAtImport = roundMoney(
            missingShareValueHeldAtImport + importValue,
          );
          holdings.push({
            accountBucket: bucket,
            accountName: account.name,
            symbol,
            name: holding.name,
            importValue,
            estimatedValue: importValue,
            shares,
            importPrice,
            currentPrice: quote?.price ?? null,
            quoteAsOfIso: quote?.asOfIso ?? null,
            status: 'missing_shares',
          });
          return;
        }
        if (!quote) {
          missingQuoteSymbols.add(symbol);
          missingQuoteValueHeldAtImport = roundMoney(
            missingQuoteValueHeldAtImport + importValue,
          );
          holdings.push({
            accountBucket: bucket,
            accountName: account.name,
            symbol,
            name: holding.name,
            importValue,
            estimatedValue: importValue,
            shares,
            importPrice,
            currentPrice: null,
            quoteAsOfIso: null,
            status: 'missing_quote',
          });
          return;
        }
        const estimatedValue = roundMoney(shares * quote.price);
        quotedImportValue += importValue;
        quotedEstimatedValue += estimatedValue;
        holdings.push({
          accountBucket: bucket,
          accountName: account.name,
          symbol,
          name: holding.name,
          importValue,
          estimatedValue,
          shares,
          importPrice,
          currentPrice: quote.price,
          quoteAsOfIso: quote.asOfIso,
          status: 'quoted',
        });
      });
    });
  });

  const importValue = roundMoney(
    holdings.reduce((total, holding) => total + holding.importValue, 0),
  );
  const estimatedValue = roundMoney(
    holdings.reduce((total, holding) => total + holding.estimatedValue, 0),
  );
  const changeDollars = roundMoney(estimatedValue - importValue);
  const changePercent = importValue > 0 ? roundPercent(changeDollars / importValue) : 0;
  const quoteCoveragePercent =
    quotedEligibleValue > 0 ? roundPercent(quotedImportValue / quotedEligibleValue) : 0;
  const heldAtImportValue = roundMoney(
    cashValueHeldAtImport + missingQuoteValueHeldAtImport + missingShareValueHeldAtImport,
  );

  return {
    available: holdings.some((holding) => holding.status === 'quoted'),
    asOfIso: input.asOfIso,
    importAsOfDate: importDates.sort().at(-1) ?? null,
    quoteAsOfIso,
    importValue,
    estimatedValue,
    changeDollars,
    changePercent,
    quoteCoveragePercent,
    quotedImportValue: roundMoney(quotedImportValue),
    quotedEstimatedValue: roundMoney(quotedEstimatedValue),
    cashValueHeldAtImport,
    missingQuoteValueHeldAtImport,
    missingShareValueHeldAtImport,
    heldAtImportValue,
    missingQuoteSymbols: [...missingQuoteSymbols].sort(),
    missingShareSymbols: [...missingShareSymbols].sort(),
    holdings,
  };
}
