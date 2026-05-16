import cfiresimFixture from '../fixtures/cfiresim_400k_20k_30yr_60_40_export.json';

export type CfiresimModelCompleteness = 'faithful' | 'reconstructed';

export interface CfiresimExportCycleSummary {
  startYear: number;
  finalYear: number;
  years: number;
  survived: boolean;
  finalPortfolio: number;
  finalPortfolioReal: number;
  minPortfolio: number;
  minPortfolioReal: number;
  totalNominalSpending: number;
}

export interface CfiresimExportFixture {
  $schemaVersion: number;
  $meta: {
    purpose: string;
    source: string;
    exportUrl: string;
    openSourceReference: string;
    capturedOn: string;
    modelCompleteness: CfiresimModelCompleteness;
    inferredAssumptions: string[];
    sourceNotes: string[];
    rawSourceCsvSha256: string;
    normalizedSourceCsvSha256: string;
    rawLineCount: number;
    repeatedHeaderCount: number;
    blankSeparatorCount: number;
    dataRowCount: number;
  };
  scenario: {
    startingBalance: number;
    initialAnnualWithdrawal: number;
    durationYears: number;
    firstStartYear: number;
    lastStartYear: number;
    allocation: {
      stocks: number;
      bonds: number;
      cash: number;
      gold: number;
    };
    spending: {
      method: string;
      inflationIndex: string;
      withdrawalTiming: string;
    };
    fees: number;
    rebalance: string;
  };
  externalSummary: {
    cohortCount: number;
    rowCount: number;
    successfulCohorts: number;
    failedCohorts: number;
    successRate: number;
    averageEndingPortfolioReal: number;
    medianEndingPortfolioReal: number;
    averageEndingPortfolioNominal: number;
    medianEndingPortfolioNominal: number;
    zeroEndingPortfolios: number;
    failureStartYears: number[];
  };
  cycleSummaries: CfiresimExportCycleSummary[];
}

export interface CfiresimExportReplaySummary {
  modelCompleteness: CfiresimModelCompleteness;
  inferredAssumptions: string[];
  cohortCount: number;
  rowCount: number;
  successfulCohorts: number;
  failedCohorts: number;
  successRate: number;
  firstStartYear: number;
  lastStartYear: number;
  failureStartYears: number[];
  averageEndingPortfolioReal: number;
  medianEndingPortfolioReal: number;
  averageEndingPortfolioNominal: number;
  medianEndingPortfolioNominal: number;
  zeroEndingPortfolios: number;
}

export const cfiresimExportFixture =
  cfiresimFixture as CfiresimExportFixture;

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

export function summarizeCfiresimExportFixture(
  fixture = cfiresimExportFixture,
): CfiresimExportReplaySummary {
  const finalRealBalances = fixture.cycleSummaries.map(
    (cycle) => cycle.finalPortfolioReal,
  );
  const finalNominalBalances = fixture.cycleSummaries.map(
    (cycle) => cycle.finalPortfolio,
  );
  const successfulCohorts = fixture.cycleSummaries.filter(
    (cycle) => cycle.survived,
  ).length;
  const failedCohorts = fixture.cycleSummaries.length - successfulCohorts;
  const failureStartYears = fixture.cycleSummaries
    .filter((cycle) => !cycle.survived)
    .map((cycle) => cycle.startYear);

  return {
    modelCompleteness: fixture.$meta.modelCompleteness,
    inferredAssumptions: fixture.$meta.inferredAssumptions,
    cohortCount: fixture.cycleSummaries.length,
    rowCount: fixture.cycleSummaries.reduce(
      (sum, cycle) => sum + cycle.years,
      0,
    ),
    successfulCohorts,
    failedCohorts,
    successRate:
      fixture.cycleSummaries.length > 0
        ? successfulCohorts / fixture.cycleSummaries.length
        : 0,
    firstStartYear: fixture.cycleSummaries[0]?.startYear ?? 0,
    lastStartYear: fixture.cycleSummaries.at(-1)?.startYear ?? 0,
    failureStartYears,
    averageEndingPortfolioReal: average(finalRealBalances),
    medianEndingPortfolioReal: median(finalRealBalances),
    averageEndingPortfolioNominal: average(finalNominalBalances),
    medianEndingPortfolioNominal: median(finalNominalBalances),
    zeroEndingPortfolios: fixture.cycleSummaries.filter(
      (cycle) => cycle.finalPortfolio === 0,
    ).length,
  };
}

export const CFIRESIM_CAPTURED_400K_20K_30YR_60_40 = {
  durationYears: 30,
  startingBalance: 400000,
  initialAnnualWithdrawal: 20000,
  allocation: {
    stocks: 0.6,
    bonds: 0.4,
    cash: 0,
    gold: 0,
  },
} as const;
