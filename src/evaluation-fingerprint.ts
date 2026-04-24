import type { MarketAssumptions, SeedData } from './types';

// Duplicated rather than imported from ./store to avoid a circular import.
type StressorKnobsLike = {
  delayedInheritanceYears: number;
  cutSpendingPercent: number;
  layoffRetireDate: string;
  layoffSeverance: number;
};

// Hot path: this fingerprint is recomputed from multiple hooks (planning export,
// Plan 2.0, UnifiedPlanScreen, …) whenever stressor/response toggles change.
// Stringifying the full SeedData graph is expensive (tens of KB) and was pinning
// the main thread for several seconds on every checkbox click when combined
// across subscribers. We cache the heavy data+assumptions hash by object
// reference — every store mutation creates new references, so reference equality
// is a sound equality signal here — and only recompute the cheap toggle hash
// per-call.

const dataHashCache = new WeakMap<SeedData, Map<MarketAssumptions, string>>();

function getDataHash(data: SeedData, assumptions: MarketAssumptions): string {
  let innerMap = dataHashCache.get(data);
  if (!innerMap) {
    innerMap = new Map();
    dataHashCache.set(data, innerMap);
  }
  const existing = innerMap.get(assumptions);
  if (existing !== undefined) return existing;
  const next = JSON.stringify({ data, assumptions });
  innerMap.set(assumptions, next);
  return next;
}

export function buildEvaluationFingerprint(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  stressorKnobs?: StressorKnobsLike;
}) {
  const dataHash = getDataHash(input.data, input.assumptions);
  // Sort copies so insertion order doesn't bust cache equality.
  const stressors = [...input.selectedStressors].sort().join(',');
  const responses = [...input.selectedResponses].sort().join(',');
  const knobs = input.stressorKnobs
    ? `di=${input.stressorKnobs.delayedInheritanceYears};cs=${input.stressorKnobs.cutSpendingPercent};lo=${input.stressorKnobs.layoffRetireDate};ls=${input.stressorKnobs.layoffSeverance}`
    : '';
  return `${dataHash}::${stressors}|${responses}|${knobs}`;
}
