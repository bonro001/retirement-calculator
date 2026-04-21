import type { MarketAssumptions, SeedData } from './types';

export function buildEvaluationFingerprint(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
  return JSON.stringify({
    data: input.data,
    assumptions: input.assumptions,
    selectedStressors: [...input.selectedStressors].sort(),
    selectedResponses: [...input.selectedResponses].sort(),
  });
}
