import type { MarketAssumptions, PathResult, SeedData } from './types';
import { computePlanFingerprint } from './prediction-log';
import { CURRENT_RULE_PACK_VERSION } from './rule-packs';

export type NorthStarDistributionMode = 'forward-looking' | 'historical-precedent';
export type NorthStarModelCompleteness = 'faithful' | 'reconstructed';

export interface NorthStarSensitivityResult {
  id: string;
  label: string;
  distributionMode: NorthStarDistributionMode;
  successRate: number;
  supportedAnnualSpend: number | null;
  medianEndingWealth: number;
  tenthPercentileEndingWealth: number;
  simulationSeed: number;
  simulationRuns: number;
}

export interface NorthStarResult {
  version: 'north_star_result_v1';
  generatedAtIso: string;
  planFingerprint: string;
  engineVersion: string;
  assumptionsPackVersion: string;
  distributionMode: NorthStarDistributionMode;
  simulationSeed: number;
  simulationRuns: number;
  supportedAnnualSpend: number | null;
  successRate: number;
  medianEndingWealth: number;
  tenthPercentileEndingWealth: number;
  modelCompleteness: NorthStarModelCompleteness;
  inferredAssumptions: string[];
  intermediateCalculations: {
    activeSimulationProfile: string;
    simulationMode: string;
    plannerLogicActive: boolean;
    annualFederalTaxEstimate: number;
    yearsFunded: number;
    irmaaExposureRate: number;
    inheritanceDependenceRate: number;
    homeSaleDependenceRate: number;
    endingWealthPercentiles: PathResult['endingWealthPercentiles'];
  };
  sensitivityResults: NorthStarSensitivityResult[];
}

export function getNorthStarDistributionMode(
  assumptions: Pick<MarketAssumptions, 'useHistoricalBootstrap'>,
): NorthStarDistributionMode {
  return assumptions.useHistoricalBootstrap ? 'historical-precedent' : 'forward-looking';
}

export function buildNorthStarResult(input: {
  seedData: SeedData;
  assumptions: MarketAssumptions;
  path: PathResult;
  modelCompleteness: NorthStarModelCompleteness;
  inferredAssumptions?: string[];
  supportedAnnualSpend?: number | null;
  activeSimulationProfile?: string;
  sensitivityResults?: NorthStarSensitivityResult[];
  generatedAtIso?: string;
}): NorthStarResult {
  const engineVersion =
    input.assumptions.assumptionsVersion ??
    input.path.monteCarloMetadata.assumptionsVersion ??
    'unversioned';

  return {
    version: 'north_star_result_v1',
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    planFingerprint: computePlanFingerprint(input.seedData, input.assumptions),
    engineVersion,
    assumptionsPackVersion: CURRENT_RULE_PACK_VERSION,
    distributionMode: getNorthStarDistributionMode(input.assumptions),
    simulationSeed: input.path.monteCarloMetadata.seed,
    simulationRuns: input.path.monteCarloMetadata.trialCount,
    supportedAnnualSpend: input.supportedAnnualSpend ?? null,
    successRate: input.path.successRate,
    medianEndingWealth: input.path.medianEndingWealth,
    tenthPercentileEndingWealth: input.path.tenthPercentileEndingWealth,
    modelCompleteness: input.modelCompleteness,
    inferredAssumptions: [...(input.inferredAssumptions ?? [])],
    intermediateCalculations: {
      activeSimulationProfile: input.activeSimulationProfile ?? input.path.simulationMode,
      simulationMode: input.path.simulationMode,
      plannerLogicActive: input.path.plannerLogicActive,
      annualFederalTaxEstimate: input.path.annualFederalTaxEstimate,
      yearsFunded: input.path.yearsFunded,
      irmaaExposureRate: input.path.irmaaExposureRate,
      inheritanceDependenceRate: input.path.inheritanceDependenceRate,
      homeSaleDependenceRate: input.path.homeSaleDependenceRate,
      endingWealthPercentiles: { ...input.path.endingWealthPercentiles },
    },
    sensitivityResults: [...(input.sensitivityResults ?? [])],
  };
}
