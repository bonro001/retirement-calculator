import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

// Validation: "apply delayed_inheritance stressor with knob=N" should produce the
// same simulation results as "move inheritance.year forward by N and run clean".
// If they diverge, applyStressors is doing something other than a pure year shift.

const ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 120,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'stressor-delay-mechanic',
};

function cloneSeed(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function withInheritance(
  base: SeedData,
  year: number,
  amount = 400000,
): SeedData {
  const next = cloneSeed(base);
  // Replace any existing inheritance entry so both test paths see exactly one.
  next.income.windfalls = [
    ...(next.income.windfalls ?? []).filter((w) => w.name !== 'inheritance'),
    {
      name: 'inheritance',
      year,
      amount,
      taxTreatment: 'tax_free',
      certainty: 'estimated',
    },
  ];
  return next;
}

function successOfSelectedPath(
  data: SeedData,
  stressors: string[],
  responses: string[],
  delayedInheritanceYears?: number,
) {
  const results = buildPathResults(data, ASSUMPTIONS, stressors, responses, {
    pathMode: 'selected_only',
    stressorKnobs:
      delayedInheritanceYears !== undefined
        ? { delayedInheritanceYears }
        : undefined,
  });
  return results[0].successRate;
}

describe('delayed_inheritance stressor mechanic', () => {
  const BASE_INHERITANCE_YEAR = 2030;

  for (const delay of [1, 3, 5, 7, 10]) {
    it(`knob=${delay} matches base-year shift of +${delay} years`, () => {
      const seed = withInheritance(initialSeedData, BASE_INHERITANCE_YEAR);
      const shifted = withInheritance(
        initialSeedData,
        BASE_INHERITANCE_YEAR + delay,
      );

      const stressorResult = successOfSelectedPath(
        seed,
        ['delayed_inheritance'],
        [],
        delay,
      );
      const shiftedResult = successOfSelectedPath(shifted, [], []);

      // Same seed + same plan modulo year → should be tight. Allow 1pt for any
      // internal non-determinism we haven't isolated.
      expect(Math.abs(stressorResult - shiftedResult)).toBeLessThan(0.01);
    });
  }

  it('sensitivity curve is monotonic decreasing in delay years', () => {
    const seed = withInheritance(initialSeedData, BASE_INHERITANCE_YEAR);
    const points = [1, 3, 5, 7, 10].map((delay) => ({
      delay,
      success: successOfSelectedPath(
        seed,
        ['delayed_inheritance'],
        [],
        delay,
      ),
    }));

    // Allow up to ~5pp of MC/path-distribution wobble between adjacent
    // points — the end-to-end trend must be downward, but individual
    // delay years can improve if the inherited cash lands after a weak
    // withdrawal sequence rather than before it.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].success).toBeLessThanOrEqual(points[i - 1].success + 0.05);
    }
    // End-to-end: delay=10 must be strictly worse than delay=1.
    expect(points[points.length - 1].success).toBeLessThan(points[0].success);
  });
});
