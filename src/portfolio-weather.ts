import type { Holding, SeedData } from './types';

export interface PortfolioQuote {
  symbol: string;
  price: number;
  asOfIso: string;
  source: string;
}

export interface PortfolioPricePoint {
  date: string;
  close: number;
}

export interface PortfolioPriceHistory {
  symbol: string;
  source: string;
  asOfIso: string;
  points: PortfolioPricePoint[];
}

export interface PortfolioQuoteSnapshot {
  asOfIso: string;
  source: string;
  quotes: PortfolioQuote[];
  histories?: PortfolioPriceHistory[];
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
  oneYearLookbackDate: string | null;
  oneYearLookbackValue: number | null;
  oneYearCurrentValue: number | null;
  oneYearChangePercent: number | null;
  oneYearLookbackDays: number | null;
  oneYearHistoryCoveragePercent: number;
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

function historyBySymbol(
  snapshot: PortfolioQuoteSnapshot | null,
): Map<string, PortfolioPriceHistory> {
  const bySymbol = new Map<string, PortfolioPriceHistory>();
  (snapshot?.histories ?? []).forEach((history) => {
    const points = history.points.filter(
      (point) =>
        Number.isFinite(point.close) &&
        point.close > 0 &&
        Number.isFinite(new Date(point.date).getTime()),
    );
    if (points.length) {
      bySymbol.set(history.symbol.toUpperCase(), { ...history, points });
    }
  });
  return bySymbol;
}

function oneYearAgoIso(asOfIso: string): string | null {
  const asOf = new Date(asOfIso);
  if (!Number.isFinite(asOf.getTime())) return null;
  const target = new Date(asOf);
  target.setUTCFullYear(target.getUTCFullYear() - 1);
  return target.toISOString().slice(0, 10);
}

function pointAtOrBefore(
  points: PortfolioPricePoint[],
  targetDate: string,
): PortfolioPricePoint | null {
  const sorted = [...points].sort((left, right) => left.date.localeCompare(right.date));
  let selected: PortfolioPricePoint | null = null;
  for (const point of sorted) {
    if (point.date <= targetDate) {
      selected = point;
    } else {
      break;
    }
  }
  return selected ?? sorted[0] ?? null;
}

function daysBetweenDates(leftDate: string, rightIso: string): number | null {
  const left = new Date(`${leftDate}T12:00:00.000Z`).getTime();
  const right = new Date(rightIso).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.max(0, Math.round((right - left) / 86_400_000));
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
  const histories = historyBySymbol(input.quoteSnapshot);
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
  let oneYearLookbackValue = 0;
  let oneYearCurrentValue = 0;
  let oneYearEligibleValue = 0;
  let oneYearCoveredValue = 0;
  let oneYearLookbackDate: string | null = null;
  let oneYearLookbackDays: number | null = null;
  const importDates: string[] = [];
  const oneYearTargetDate = oneYearAgoIso(input.asOfIso);

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
        oneYearEligibleValue += importValue;
        if (oneYearTargetDate) {
          const point = pointAtOrBefore(histories.get(symbol)?.points ?? [], oneYearTargetDate);
          if (point) {
            oneYearCoveredValue += importValue;
            oneYearLookbackValue = roundMoney(oneYearLookbackValue + shares * point.close);
            oneYearCurrentValue = roundMoney(oneYearCurrentValue + estimatedValue);
            const days = daysBetweenDates(point.date, quote.asOfIso);
            oneYearLookbackDays =
              days === null
                ? oneYearLookbackDays
                : oneYearLookbackDays === null
                  ? days
                  : Math.max(oneYearLookbackDays, days);
            oneYearLookbackDate =
              oneYearLookbackDate === null || point.date < oneYearLookbackDate
                ? point.date
                : oneYearLookbackDate;
          }
        }
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
  const oneYearHistoryCoveragePercent =
    oneYearEligibleValue > 0 ? roundPercent(oneYearCoveredValue / oneYearEligibleValue) : 0;
  const oneYearChangePercent =
    oneYearLookbackValue > 0
      ? roundPercent((oneYearCurrentValue - oneYearLookbackValue) / oneYearLookbackValue)
      : null;

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
    oneYearLookbackDate,
    oneYearLookbackValue: oneYearLookbackValue > 0 ? roundMoney(oneYearLookbackValue) : null,
    oneYearCurrentValue: oneYearCurrentValue > 0 ? roundMoney(oneYearCurrentValue) : null,
    oneYearChangePercent,
    oneYearLookbackDays,
    oneYearHistoryCoveragePercent,
    missingQuoteSymbols: [...missingQuoteSymbols].sort(),
    missingShareSymbols: [...missingShareSymbols].sort(),
    holdings,
  };
}
