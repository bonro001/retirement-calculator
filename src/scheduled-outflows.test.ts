import { describe, expect, it } from 'vitest';
import seedFixture from '../seed-data.json';
import type { MarketAssumptions, ScheduledOutflow, SeedData } from './types';
import { buildPathResults } from './utils';

const ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.07,
  internationalEquityVolatility: 0.17,
  bondMean: 0.04,
  bondVolatility: 0.06,
  cashMean: 0.025,
  cashVolatility: 0.005,
  inflation: 0.025,
  inflationVolatility: 0.01,
  simulationRuns: 120,
  irmaaThreshold: 212_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 25,
  guardrailCutPercent: 0.1,
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260511,
  assumptionsVersion: 'scheduled-outflows-test',
};

function gift(
  year: number,
  amount: number,
  sourceAccount: ScheduledOutflow['sourceAccount'],
): ScheduledOutflow {
  return {
    name: `gift_${year}_${sourceAccount}`,
    year,
    amount,
    sourceAccount,
    recipient: 'test',
    vehicle: 'annual_exclusion_cash',
    label: 'Test gift',
    taxTreatment: 'gift_no_tax_consequence',
  };
}

function runWithOutflows(outflows: ScheduledOutflow[] | undefined) {
  const seed = {
    ...(seedFixture as SeedData),
    scheduledOutflows: outflows,
  };
  const paths = buildPathResults(seed, ASSUMPTIONS, [], [], {
    pathMode: 'selected_only',
  });
  return paths[0]!;
}

describe('scheduled outflow engine handling', () => {
  it('empty scheduled outflows preserve the baseline result', { timeout: 30_000 }, () => {
    const absent = runWithOutflows(undefined);
    const empty = runWithOutflows([]);
    expect(empty.successRate).toBe(absent.successRate);
    expect(empty.medianEndingWealth).toBe(absent.medianEndingWealth);
  });

  it('cash gifts reduce ending wealth without a direct tax event', { timeout: 30_000 }, () => {
    const baseline = runWithOutflows(undefined);
    const withGift = runWithOutflows([gift(2028, 20_000, 'cash')]);
    expect(withGift.medianEndingWealth).toBeLessThan(baseline.medianEndingWealth);
    // Cash gifts have no direct tax treatment, but the lower cash runway can
    // slightly change later withdrawal timing and therefore lifetime tax.
    expect(
      Math.abs(withGift.annualFederalTaxEstimate - baseline.annualFederalTaxEstimate),
    ).toBeLessThan(500);
  });
});
