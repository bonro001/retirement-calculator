import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { buildModelFidelityAssessment } from './model-fidelity';
import type { MarketAssumptions } from './types';

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
  simulationRuns: 50,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260416,
  assumptionsVersion: 'model-fidelity-test',
};

describe('model fidelity recommendation-trust risks', () => {
  it('classifies concentration and opaque-manager risks separately from headline math', () => {
    const assessment = buildModelFidelityAssessment({
      data: structuredClone(initialSeedData),
      assumptions: ASSUMPTIONS,
    });
    const item = assessment.inputs.find(
      (input) => input.id === 'recommendation_trust_risk_classification',
    );

    expect(item).toBeDefined();
    expect(item?.status).toBe('estimated');
    expect(item?.blocking).toBe(false);
    expect(item?.detail).toContain('Headline math uses broad asset-class mappings');
    expect(item?.detail).toContain('recommendation trust');
    expect(item?.detail).toContain('FCNTX');
    expect(item?.detail).toContain('MUB');
  });
});
