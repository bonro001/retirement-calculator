import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { buildProbeChecklist } from './probe-checklist';
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
  simulationRuns: 200,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260421,
  assumptionsVersion: 'probe-checklist-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function getStatus(result: ReturnType<typeof buildProbeChecklist>, id: string) {
  return result.items.find((item) => item.id === id)?.status;
}

describe('buildProbeChecklist', () => {
  it('flags missing HSA/LTC strategy when not configured', () => {
    const data = cloneSeedData(initialSeedData);
    delete data.rules.hsaStrategy;
    delete data.rules.ltcAssumptions;

    const result = buildProbeChecklist({
      data,
      assumptions: TEST_ASSUMPTIONS,
      evaluation: null,
    });

    expect(getStatus(result, 'hsa-strategy')).toBe('missing');
    expect(getStatus(result, 'ltc-tail-risk')).toBe('missing');
  });

  it('marks modeled statuses when HSA/LTC and inheritance tax treatment are explicit', () => {
    const data = cloneSeedData(initialSeedData);
    data.rules.hsaStrategy = {
      enabled: true,
      annualQualifiedExpenseWithdrawalCap: 8_000,
      prioritizeHighMagiYears: true,
      highMagiThreshold: 190_000,
    };
    data.rules.ltcAssumptions = {
      enabled: true,
      startAge: 82,
      annualCostToday: 60_000,
      durationYears: 4,
      inflationAnnual: 0.055,
      eventProbability: 0.45,
    };
    data.income.windfalls = data.income.windfalls.map((windfall) =>
      windfall.name === 'inheritance'
        ? {
            ...windfall,
            taxTreatment: 'inherited_ira_10y',
            distributionYears: 10,
          }
        : windfall,
    );

    const result = buildProbeChecklist({
      data,
      assumptions: TEST_ASSUMPTIONS,
      evaluation: null,
    });

    expect(getStatus(result, 'inheritance-treatment')).toBe('modeled');
    expect(getStatus(result, 'hsa-strategy')).toBe('modeled');
    expect(getStatus(result, 'ltc-tail-risk')).toBe('modeled');
  });
});
