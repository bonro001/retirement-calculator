import benchmarkFixture from '../fixtures/external_model_benchmarks.json';
import annualReturns from '../fixtures/historical_annual_returns.json';
import { replayCohort, type CohortSpec } from './historical-replay';
import { calculateFederalTax, type YearTaxInputs } from './tax-engine';

export type ModelCompleteness = 'faithful' | 'reconstructed';

interface BenchmarkSource {
  modelName: string;
  sourceType: string;
  url: string;
  docsUrl?: string;
  capturedOn: string;
  sourceNotes: string;
}

interface Allocation {
  stocks: number;
  bonds: number;
}

interface RollingWindowScenario {
  returnsFixture: string;
  firstStartYear: number;
  lastStartYear: number;
  durationYears: number;
  startingBalance: number;
  initialAnnualWithdrawal: number;
  allocation: Allocation;
}

interface RollingWindowExternalObservation {
  successRate: number;
  startingBalance: number;
  initialAnnualWithdrawal: number;
  durationYears: number;
  allocation: Allocation;
  withdrawalTiming: string;
  cohortCount?: number;
  successfulCohorts?: number;
  failedCohorts?: number;
  averageEndingPortfolio?: number;
  medianEndingPortfolio?: number;
}

interface ExpectedLocalRollingWindow {
  cohortCount: number;
  successfulCohorts: number;
  failedCohorts: number;
  successRate: number;
  failureStartYears: number[];
}

interface RollingWindowBenchmark {
  id: string;
  kind: 'historical_rolling_window_survival';
  modelCompleteness: ModelCompleteness;
  source: BenchmarkSource;
  inferredAssumptions: string[];
  externalObservation: RollingWindowExternalObservation;
  localScenario: RollingWindowScenario;
  expectedLocal: ExpectedLocalRollingWindow;
  tolerance: {
    successRateAbs: number;
  };
}

interface PolicyEngineTaxObservation {
  taxYear: number;
  filingStatus: string;
  state: string;
  wages: number;
  adjustedGrossIncome: number;
  taxableIncome: number;
  federalIncomeTax: number;
}

interface PolicyEngineTaxBenchmark {
  id: string;
  kind: 'policyengine_tax_snapshot';
  modelCompleteness: ModelCompleteness;
  source: BenchmarkSource;
  inferredAssumptions: string[];
  externalObservation: PolicyEngineTaxObservation;
  localScenario: YearTaxInputs;
  tolerance: {
    dollarsAbs: number;
  };
}

export type ExternalModelBenchmark =
  | RollingWindowBenchmark
  | PolicyEngineTaxBenchmark;

export interface ExternalModelBenchmarkCorpus {
  $schemaVersion: number;
  $meta: {
    purpose: string;
    capturedOn: string;
    modelingScope: string;
    refreshPolicy: string;
    localHistoricalDataWindow: string;
  };
  benchmarks: ExternalModelBenchmark[];
}

interface AnnualReturnRow {
  year: number;
  stocks: number;
  bonds: number;
  inflation: number;
}

export interface RollingWindowBenchmarkResult {
  benchmarkId: string;
  kind: 'historical_rolling_window_survival';
  sourceModel: string;
  modelCompleteness: ModelCompleteness;
  inferredAssumptions: string[];
  externalSuccessRate: number;
  localSuccessRate: number;
  successRateDelta: number;
  tolerance: number;
  passed: boolean;
  local: {
    cohortCount: number;
    successfulCohorts: number;
    failedCohorts: number;
    failureStartYears: number[];
    averageFinalRealBalance: number;
    medianFinalRealBalance: number;
  };
}

export interface PolicyEngineTaxBenchmarkResult {
  benchmarkId: string;
  kind: 'policyengine_tax_snapshot';
  sourceModel: string;
  modelCompleteness: ModelCompleteness;
  inferredAssumptions: string[];
  passed: boolean;
  deltas: {
    adjustedGrossIncome: number;
    taxableIncome: number;
    federalIncomeTax: number;
  };
  tolerance: number;
  local: {
    adjustedGrossIncome: number;
    taxableIncome: number;
    federalIncomeTax: number;
  };
}

export type ExternalModelBenchmarkResult =
  | RollingWindowBenchmarkResult
  | PolicyEngineTaxBenchmarkResult;

const rows = (annualReturns as { annual: AnnualReturnRow[] }).annual;
const returnsByYearFixture = new Map(rows.map((row) => [row.year, row]));

export const externalModelBenchmarkCorpus =
  benchmarkFixture as ExternalModelBenchmarkCorpus;

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint];
  }
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildCohortSpec(
  scenario: RollingWindowScenario,
  startYear: number,
): CohortSpec {
  if (scenario.returnsFixture !== 'fixtures/historical_annual_returns.json') {
    throw new Error(
      `Unsupported returns fixture for external benchmark: ${scenario.returnsFixture}`,
    );
  }

  const returnsByYear: CohortSpec['returnsByYear'] = {};
  for (let offset = 0; offset < scenario.durationYears; offset += 1) {
    const year = startYear + offset;
    const row = returnsByYearFixture.get(year);
    if (!row) {
      throw new Error(
        `External benchmark scenario is missing historical return data for ${year}`,
      );
    }
    returnsByYear[year] = {
      stocks: row.stocks,
      bonds: row.bonds,
      inflation: row.inflation,
    };
  }

  return {
    label: `${startYear} retiree external benchmark ${scenario.allocation.stocks * 100}/${scenario.allocation.bonds * 100}`,
    startYear,
    durationYears: scenario.durationYears,
    startingBalance: scenario.startingBalance,
    initialAnnualWithdrawal: scenario.initialAnnualWithdrawal,
    allocation: scenario.allocation,
    returnsByYear,
  };
}

export function runRollingWindowExternalBenchmark(
  benchmark: RollingWindowBenchmark,
): RollingWindowBenchmarkResult {
  let successfulCohorts = 0;
  const failureStartYears: number[] = [];
  const finalRealBalances: number[] = [];

  for (
    let startYear = benchmark.localScenario.firstStartYear;
    startYear <= benchmark.localScenario.lastStartYear;
    startYear += 1
  ) {
    const result = replayCohort(
      buildCohortSpec(benchmark.localScenario, startYear),
    );
    finalRealBalances.push(result.finalRealBalance);

    if (result.survived) {
      successfulCohorts += 1;
    } else {
      failureStartYears.push(startYear);
    }
  }

  const cohortCount =
    benchmark.localScenario.lastStartYear -
    benchmark.localScenario.firstStartYear +
    1;
  const failedCohorts = cohortCount - successfulCohorts;
  const localSuccessRate = cohortCount > 0 ? successfulCohorts / cohortCount : 0;
  const successRateDelta =
    localSuccessRate - benchmark.externalObservation.successRate;
  const passed =
    Math.abs(successRateDelta) <= benchmark.tolerance.successRateAbs;

  return {
    benchmarkId: benchmark.id,
    kind: benchmark.kind,
    sourceModel: benchmark.source.modelName,
    modelCompleteness: benchmark.modelCompleteness,
    inferredAssumptions: benchmark.inferredAssumptions,
    externalSuccessRate: benchmark.externalObservation.successRate,
    localSuccessRate,
    successRateDelta,
    tolerance: benchmark.tolerance.successRateAbs,
    passed,
    local: {
      cohortCount,
      successfulCohorts,
      failedCohorts,
      failureStartYears,
      averageFinalRealBalance: average(finalRealBalances),
      medianFinalRealBalance: median(finalRealBalances),
    },
  };
}

export function runPolicyEngineTaxBenchmark(
  benchmark: PolicyEngineTaxBenchmark,
): PolicyEngineTaxBenchmarkResult {
  const local = calculateFederalTax(benchmark.localScenario);
  const deltas = {
    adjustedGrossIncome:
      local.AGI - benchmark.externalObservation.adjustedGrossIncome,
    taxableIncome:
      local.totalTaxableIncome - benchmark.externalObservation.taxableIncome,
    federalIncomeTax:
      local.federalTax - benchmark.externalObservation.federalIncomeTax,
  };
  const tolerance = benchmark.tolerance.dollarsAbs;
  const passed = Object.values(deltas).every(
    (delta) => Math.abs(delta) <= tolerance,
  );

  return {
    benchmarkId: benchmark.id,
    kind: benchmark.kind,
    sourceModel: benchmark.source.modelName,
    modelCompleteness: benchmark.modelCompleteness,
    inferredAssumptions: benchmark.inferredAssumptions,
    passed,
    deltas,
    tolerance,
    local: {
      adjustedGrossIncome: local.AGI,
      taxableIncome: local.totalTaxableIncome,
      federalIncomeTax: local.federalTax,
    },
  };
}

export function runExternalModelBenchmark(
  benchmark: ExternalModelBenchmark,
): ExternalModelBenchmarkResult {
  if (benchmark.kind === 'historical_rolling_window_survival') {
    return runRollingWindowExternalBenchmark(benchmark);
  }
  return runPolicyEngineTaxBenchmark(benchmark);
}

export function runExternalModelBenchmarkCorpus(
  corpus = externalModelBenchmarkCorpus,
) {
  return corpus.benchmarks.map((benchmark) =>
    runExternalModelBenchmark(benchmark),
  );
}
