import { initialSeedData } from './data';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults } from './utils';

export interface GoldenScenarioSummary {
  successRate: number;
  medianEndingWealth: number;
  medianFailureYear: number | null;
  annualTaxEstimate: number;
  maxIrmaaTier: number;
  averageHealthcarePremiumCost: number;
}

export interface GoldenScenarioExpected {
  successRate: number;
  medianEndingWealth: number;
  annualTaxEstimate: number;
  medianFailureYearRange?: {
    min: number;
    max: number;
  };
  maxIrmaaTier?: number;
  averageHealthcarePremiumCost?: number;
}

export interface GoldenScenarioTolerance {
  successRate: number;
  medianEndingWealth: number;
  annualTaxEstimate: number;
}

export type GoldenScenarioPathKind = 'baseline' | 'stressed' | 'response';

export interface GoldenScenarioDefinition {
  id: string;
  name: string;
  selectedStressors: string[];
  selectedResponses: string[];
  pathKind: GoldenScenarioPathKind;
  mutateData?: (data: SeedData) => void;
  assumptionsOverride?: Partial<MarketAssumptions>;
  expected: GoldenScenarioExpected;
  tolerance: GoldenScenarioTolerance;
}

export interface GoldenScenarioComparisonRow {
  metric: 'success_rate' | 'median_ending_wealth' | 'annual_tax_estimate';
  expected: number;
  actual: number;
  delta: number;
  tolerance: number;
  pass: boolean;
}

export interface GoldenScenarioReport {
  scenarioId: string;
  scenarioName: string;
  pass: boolean;
  summary: GoldenScenarioSummary;
  comparisons: GoldenScenarioComparisonRow[];
  notes: string[];
}

const DEFAULT_VERIFICATION_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.074,
  internationalEquityVolatility: 0.18,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 200,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 424242,
  assumptionsVersion: 'v1-test',
};

function cloneData<T>(value: T): T {
  return structuredClone(value) as T;
}

function toPathIndex(pathKind: GoldenScenarioPathKind) {
  if (pathKind === 'stressed') {
    return 1;
  }
  if (pathKind === 'response') {
    return 2;
  }
  return 0;
}

function parseTierLabel(label: string) {
  const match = label.match(/Tier\s+(\d+)/i);
  return match ? Number(match[1]) : 1;
}

export function summarizePathForVerification(path: PathResult): GoldenScenarioSummary {
  const maxIrmaaTier = path.yearlySeries.length
    ? Math.max(...path.yearlySeries.map((year) => parseTierLabel(year.dominantIrmaaTier)))
    : 1;
  const averageHealthcarePremiumCost =
    path.yearlySeries.reduce(
      (total, year) => total + year.medianTotalHealthcarePremiumCost,
      0,
    ) / Math.max(1, path.yearlySeries.length);

  return {
    successRate: path.successRate,
    medianEndingWealth: path.medianEndingWealth,
    medianFailureYear: path.medianFailureYear,
    annualTaxEstimate: path.annualFederalTaxEstimate,
    maxIrmaaTier,
    averageHealthcarePremiumCost,
  };
}

export function runGoldenScenario(
  scenario: GoldenScenarioDefinition,
  baseData: SeedData = initialSeedData,
): GoldenScenarioReport {
  const data = cloneData(baseData);
  scenario.mutateData?.(data);

  const assumptions: MarketAssumptions = {
    ...DEFAULT_VERIFICATION_ASSUMPTIONS,
    ...scenario.assumptionsOverride,
  };

  const pathResults = buildPathResults(
    data,
    assumptions,
    scenario.selectedStressors,
    scenario.selectedResponses,
  );
  const selectedPath = pathResults[toPathIndex(scenario.pathKind)] ?? pathResults[0];
  const summary = summarizePathForVerification(selectedPath);

  const comparisons: GoldenScenarioComparisonRow[] = [
    {
      metric: 'success_rate',
      expected: scenario.expected.successRate,
      actual: summary.successRate,
      delta: summary.successRate - scenario.expected.successRate,
      tolerance: scenario.tolerance.successRate,
      pass: Math.abs(summary.successRate - scenario.expected.successRate) <=
        scenario.tolerance.successRate,
    },
    {
      metric: 'median_ending_wealth',
      expected: scenario.expected.medianEndingWealth,
      actual: summary.medianEndingWealth,
      delta: summary.medianEndingWealth - scenario.expected.medianEndingWealth,
      tolerance: scenario.tolerance.medianEndingWealth,
      pass: Math.abs(summary.medianEndingWealth - scenario.expected.medianEndingWealth) <=
        scenario.tolerance.medianEndingWealth,
    },
    {
      metric: 'annual_tax_estimate',
      expected: scenario.expected.annualTaxEstimate,
      actual: summary.annualTaxEstimate,
      delta: summary.annualTaxEstimate - scenario.expected.annualTaxEstimate,
      tolerance: scenario.tolerance.annualTaxEstimate,
      pass: Math.abs(summary.annualTaxEstimate - scenario.expected.annualTaxEstimate) <=
        scenario.tolerance.annualTaxEstimate,
    },
  ];

  const notes: string[] = [];
  if (scenario.expected.medianFailureYearRange) {
    const actualYear = summary.medianFailureYear;
    const { min, max } = scenario.expected.medianFailureYearRange;
    const inRange = typeof actualYear === 'number' && actualYear >= min && actualYear <= max;
    notes.push(
      inRange
        ? `failure-year-range:pass (${actualYear})`
        : `failure-year-range:fail (actual=${actualYear}, expected=${min}-${max})`,
    );
  }

  if (typeof scenario.expected.maxIrmaaTier === 'number') {
    const pass = summary.maxIrmaaTier === scenario.expected.maxIrmaaTier;
    notes.push(
      pass
        ? `irmaa-tier:pass (${summary.maxIrmaaTier})`
        : `irmaa-tier:fail (actual=${summary.maxIrmaaTier}, expected=${scenario.expected.maxIrmaaTier})`,
    );
  }

  if (typeof scenario.expected.averageHealthcarePremiumCost === 'number') {
    const delta = Math.abs(
      summary.averageHealthcarePremiumCost - scenario.expected.averageHealthcarePremiumCost,
    );
    const tolerance = Math.max(1, scenario.tolerance.annualTaxEstimate * 0.5);
    notes.push(
      delta <= tolerance
        ? `healthcare-cost:pass (delta=${delta.toFixed(2)})`
        : `healthcare-cost:fail (delta=${delta.toFixed(2)})`,
    );
  }

  const pass = comparisons.every((item) => item.pass) && notes.every((note) => !note.includes(':fail'));

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    pass,
    summary,
    comparisons,
    notes,
  };
}

export function runGoldenScenarios(
  scenarios: GoldenScenarioDefinition[],
  baseData: SeedData = initialSeedData,
) {
  return scenarios.map((scenario) => runGoldenScenario(scenario, baseData));
}

export function getDefaultVerificationAssumptions(): MarketAssumptions {
  return { ...DEFAULT_VERIFICATION_ASSUMPTIONS };
}
