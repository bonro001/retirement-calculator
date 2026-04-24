import { initialSeedData } from './data';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';

// Shared harness for property-based invariant tests. All runs use a fixed
// seed and a low simulation-run count so small perturbations produce
// deterministic, comparable deltas. The point is to expose sign flips and
// accounting errors — not to tune accuracy — so speed matters more than
// statistical power here.

export const PROPERTY_TEST_SIMULATION_RUNS = 30;

export function baseAssumptions(): MarketAssumptions {
  return {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: PROPERTY_TEST_SIMULATION_RUNS,
  };
}

export function cloneSeed(seed: SeedData = initialSeedData): SeedData {
  return JSON.parse(JSON.stringify(seed)) as SeedData;
}

export type SeedPerturbation = (seed: SeedData) => void;
export type AssumptionPerturbation = (
  assumptions: MarketAssumptions,
) => void;

export interface PropertyRunInput {
  seedPerturb?: SeedPerturbation;
  assumptionPerturb?: AssumptionPerturbation;
  stressors?: string[];
  responses?: string[];
}

export interface PropertyRunOutputs {
  successRate: number;
  medianEndingWealth: number;
  tenthPercentileEndingWealth: number;
  annualFederalTaxEstimate: number;
  path: PathResult;
}

export function runProperty(input: PropertyRunInput = {}): PropertyRunOutputs {
  const seed = cloneSeed();
  input.seedPerturb?.(seed);

  const assumptions = baseAssumptions();
  input.assumptionPerturb?.(assumptions);

  const paths = buildPathResults(
    seed,
    assumptions,
    input.stressors ?? [],
    input.responses ?? [],
  );
  const baseline = paths[0];
  return {
    successRate: baseline.successRate,
    medianEndingWealth: baseline.medianEndingWealth,
    tenthPercentileEndingWealth: baseline.tenthPercentileEndingWealth,
    annualFederalTaxEstimate: baseline.annualFederalTaxEstimate,
    path: baseline,
  };
}

export function compareRuns(
  baseline: PropertyRunOutputs,
  perturbed: PropertyRunOutputs,
) {
  return {
    successRateDelta: perturbed.successRate - baseline.successRate,
    medianEndingWealthDelta:
      perturbed.medianEndingWealth - baseline.medianEndingWealth,
    tenthPctDelta:
      perturbed.tenthPercentileEndingWealth -
      baseline.tenthPercentileEndingWealth,
    annualTaxDelta:
      perturbed.annualFederalTaxEstimate - baseline.annualFederalTaxEstimate,
  };
}
