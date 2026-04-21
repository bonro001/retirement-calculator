import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { evaluatePlan, type Plan } from './plan-evaluation';
import type { MarketAssumptions, SeedData } from './types';

const TEST_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 40,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260418,
  assumptionsVersion: 'trust-panel-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

describe('plan trust panel', () => {
  it('attaches decision trust panel with expected checks and metrics', async () => {
    const plan: Plan = {
      data: cloneSeedData(initialSeedData),
      assumptions: TEST_ASSUMPTIONS,
      controls: {
        selectedStressorIds: [],
        selectedResponseIds: [],
      },
    };

    const evaluation = await evaluatePlan(plan);
    const trustPanel = evaluation.trustPanel;

    expect(trustPanel).toBeDefined();
    expect(trustPanel?.version).toBe('decision_trust_v1');
    expect(trustPanel?.checks.length).toBeGreaterThanOrEqual(8);
    expect(trustPanel?.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'data_fidelity',
        'home_sale_modeling',
        'inheritance_modeling',
        'recommendation_evidence',
        'roth_policy',
        'closed_loop_withdrawal',
        'inheritance_dependency',
        'home_sale_dependency',
        'phased_spending_realism',
      ]),
    );
    expect(
      (trustPanel?.metrics.passCount ?? 0) +
        (trustPanel?.metrics.warnCount ?? 0) +
        (trustPanel?.metrics.failCount ?? 0),
    ).toBe(trustPanel?.checks.length);
  }, 40000);
});
