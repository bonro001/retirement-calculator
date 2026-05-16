import ficalcFixture from '../fixtures/ficalc_historical_annual_returns.json';

export interface FicalcAnnualReturnRow {
  year: number;
  startCpi: number;
  endCpi: number;
  inflation: number;
  stocks: number;
  stockPriceReturn: number;
  stockDividendReturn: number;
  bonds: number;
  cape: number | null;
  trCape: number | null;
}

export interface FicalcHistoricalFixture {
  $schemaVersion: number;
  $meta: {
    purpose: string;
    source: string;
    vendorAsset: string;
    workerAsset: string;
    capturedOn: string;
    modelCompleteness: 'faithful' | 'reconstructed';
    vendorSha256: string;
    workerSha256: string;
    rowCount: number;
    firstYear: number;
    lastYear: number;
    notes: string[];
    inferredAssumptions: string[];
  };
  annual: FicalcAnnualReturnRow[];
}

export interface FicalcConstantDollarScenario {
  durationYears: number;
  startingBalance: number;
  initialAnnualWithdrawal: number;
  allocation: {
    stocks: number;
    bonds: number;
    cash: number;
  };
}

interface FicalcInvestmentState {
  type: 'stocks' | 'bonds' | 'cash';
  percentage: number;
  endValue: number;
  endValueInFirstYearDollars: number;
}

export interface FicalcSourceCohortResult {
  startYear: number;
  endYear: number;
  survived: boolean;
  finalBalance: number;
  finalBalanceInFirstYearDollars: number;
}

export interface FicalcSourceReplaySummary {
  modelCompleteness: 'faithful' | 'reconstructed';
  inferredAssumptions: string[];
  cohortCount: number;
  successfulCohorts: number;
  failedCohorts: number;
  successRate: number;
  firstStartYear: number;
  lastStartYear: number;
  failureStartYears: number[];
  averageEndingPortfolioFirstYearDollars: number;
  medianEndingPortfolioFirstYearDollars: number;
  zeroEndingPortfolios: number;
  cohorts: FicalcSourceCohortResult[];
}

export const ficalcHistoricalFixture =
  ficalcFixture as FicalcHistoricalFixture;

function round2(value: number) {
  return Number(value.toFixed(2));
}

function inflationRateFromCpi(startCpi: number, endCpi: number) {
  return endCpi / startCpi - 1;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildFicalcRowsWithSentinel(fixture: FicalcHistoricalFixture) {
  const last = fixture.annual[fixture.annual.length - 1];
  if (!last) {
    throw new Error('FI Calc fixture is empty.');
  }
  return [
    ...fixture.annual,
    {
      year: last.year + 1,
      startCpi: last.endCpi,
      endCpi: 0,
      inflation: 0,
      stocks: 0,
      stockPriceReturn: 0,
      stockDividendReturn: 0,
      bonds: 0,
      cape: null,
      trCape: null,
    },
  ];
}

function runFicalcCohort(
  rowsByYear: Map<number, FicalcAnnualReturnRow>,
  startYear: number,
  scenario: FicalcConstantDollarScenario,
): FicalcSourceCohortResult {
  const firstRow = rowsByYear.get(startYear);
  if (!firstRow) {
    throw new Error(`FI Calc source replay missing start year ${startYear}.`);
  }

  let investments: FicalcInvestmentState[] = [
    {
      type: 'stocks',
      percentage: scenario.allocation.stocks,
      endValue: round2(scenario.startingBalance * scenario.allocation.stocks),
      endValueInFirstYearDollars: round2(
        scenario.startingBalance * scenario.allocation.stocks,
      ),
    },
    {
      type: 'bonds',
      percentage: scenario.allocation.bonds,
      endValue: round2(scenario.startingBalance * scenario.allocation.bonds),
      endValueInFirstYearDollars: round2(
        scenario.startingBalance * scenario.allocation.bonds,
      ),
    },
    {
      type: 'cash',
      percentage: scenario.allocation.cash,
      endValue: round2(scenario.startingBalance * scenario.allocation.cash),
      endValueInFirstYearDollars: round2(
        scenario.startingBalance * scenario.allocation.cash,
      ),
    },
  ];

  let previousPortfolioEndValue = scenario.startingBalance;
  let previousPortfolioEndValueReal = scenario.startingBalance;
  let couldNotSustainWithdrawals = false;
  let endYear = startYear + scenario.durationYears - 1;

  for (let offset = 0; offset < scenario.durationYears; offset += 1) {
    const year = startYear + offset;
    const row = rowsByYear.get(year);
    if (!row) {
      throw new Error(`FI Calc source replay missing return data for ${year}.`);
    }
    endYear = year;

    const isFirstYear = offset === 0;
    const startValue = isFirstYear
      ? scenario.startingBalance
      : previousPortfolioEndValue;
    const cumulativeInflationSinceFirstYear =
      inflationRateFromCpi(firstRow.startCpi, row.startCpi) + 1;
    const endCumulativeInflationSinceFirstYear =
      inflationRateFromCpi(firstRow.startCpi, row.endCpi) + 1;
    const requestedWithdrawal =
      scenario.initialAnnualWithdrawal * cumulativeInflationSinceFirstYear;
    const fundedWithdrawal = Math.min(requestedWithdrawal, startValue);
    const portfolioValueBeforeMarketChanges = startValue - fundedWithdrawal;
    const isOutOfMoneyAtEnd = portfolioValueBeforeMarketChanges === 0;

    if (requestedWithdrawal > startValue) {
      couldNotSustainWithdrawals = true;
    }

    const grownInvestments = investments.map((investment) => {
      const startInvestmentValue = investment.endValue;
      const startingPercentage =
        startValue > 0 ? startInvestmentValue / startValue : 0;

      if (isOutOfMoneyAtEnd) {
        return {
          ...investment,
          endValue: 0,
          endValueInFirstYearDollars: 0,
        };
      }

      const valueAfterWithdrawal =
        portfolioValueBeforeMarketChanges * startingPercentage;
      const annualReturn =
        investment.type === 'stocks'
          ? row.stocks
          : investment.type === 'bonds'
            ? row.bonds
            : 0;
      const growthAmount = round2(valueAfterWithdrawal * annualReturn);
      const valueWithGrowth = round2(valueAfterWithdrawal + growthAmount);
      const endValue = round2(valueWithGrowth);

      return {
        ...investment,
        endValue,
        endValueInFirstYearDollars: round2(
          endValue / endCumulativeInflationSinceFirstYear,
        ),
      };
    });

    const endValue = round2(
      grownInvestments.reduce((sum, investment) => sum + investment.endValue, 0),
    );

    investments = grownInvestments.map((investment) => {
      const rebalancedValue = round2(endValue * investment.percentage);
      return {
        ...investment,
        endValue: rebalancedValue,
        endValueInFirstYearDollars: round2(
          rebalancedValue / endCumulativeInflationSinceFirstYear,
        ),
      };
    });
    previousPortfolioEndValue = endValue;
    previousPortfolioEndValueReal = round2(
      endValue / endCumulativeInflationSinceFirstYear,
    );
  }

  return {
    startYear,
    endYear,
    survived: !couldNotSustainWithdrawals,
    finalBalance: previousPortfolioEndValue,
    finalBalanceInFirstYearDollars: previousPortfolioEndValueReal,
  };
}

export function runFicalcSourceConstantDollarReplay(
  scenario: FicalcConstantDollarScenario,
  fixture = ficalcHistoricalFixture,
): FicalcSourceReplaySummary {
  const rowsWithSentinel = buildFicalcRowsWithSentinel(fixture);
  const rowsByYear = new Map(rowsWithSentinel.map((row) => [row.year, row]));
  const startYears = rowsWithSentinel
    .map((row) => row.year)
    .slice(0, Math.max(rowsWithSentinel.length - scenario.durationYears, 0))
    .reverse();

  const cohorts = startYears.map((startYear) =>
    runFicalcCohort(rowsByYear, startYear, scenario),
  );
  const successfulCohorts = cohorts.filter((cohort) => cohort.survived).length;
  const failedCohorts = cohorts.length - successfulCohorts;
  const finalBalancesReal = cohorts.map(
    (cohort) => cohort.finalBalanceInFirstYearDollars,
  );

  return {
    modelCompleteness: fixture.$meta.modelCompleteness,
    inferredAssumptions: fixture.$meta.inferredAssumptions,
    cohortCount: cohorts.length,
    successfulCohorts,
    failedCohorts,
    successRate: cohorts.length > 0 ? successfulCohorts / cohorts.length : 0,
    firstStartYear: startYears[startYears.length - 1] ?? 0,
    lastStartYear: startYears[0] ?? 0,
    failureStartYears: cohorts
      .filter((cohort) => !cohort.survived)
      .map((cohort) => cohort.startYear),
    averageEndingPortfolioFirstYearDollars: average(finalBalancesReal),
    medianEndingPortfolioFirstYearDollars: median(finalBalancesReal),
    zeroEndingPortfolios: finalBalancesReal.filter((value) => value === 0).length,
    cohorts,
  };
}

export const FICALC_CAPTURED_400K_20K_30YR_60_40: FicalcConstantDollarScenario =
  {
    durationYears: 30,
    startingBalance: 400000,
    initialAnnualWithdrawal: 20000,
    allocation: {
      stocks: 0.6,
      bonds: 0.4,
      cash: 0,
    },
  };
