import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import {
  buildStrategicPrepCandidates,
  type FlightPathPolicyInput,
} from './flight-path-policy';
import { getDefaultVerificationAssumptions } from './verification-harness';

// Validates that the pre-retirement-accumulation candidate surfaces in
// flight-path-policy output when the user is still working with
// material pre-tax contribution shortfalls.

function makeInput(overrides: Partial<FlightPathPolicyInput> = {}): FlightPathPolicyInput {
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: 30,
  };
  return {
    evaluation: null,
    data: JSON.parse(JSON.stringify(initialSeedData)) as SeedData,
    assumptions,
    selectedStressors: [],
    selectedResponses: [],
    nowYear: 2026,
    ...overrides,
  };
}

describe('flight-path pre-retirement-accumulation candidate', () => {
  it('surfaces for the current seed (HSA shortfall present)', () => {
    const candidates = buildStrategicPrepCandidates(makeInput());
    const preRetirement = candidates.find(
      (candidate) => candidate.id === 'pre-retirement-accumulation',
    );
    expect(preRetirement).toBeDefined();
    expect(preRetirement!.priority).toBe('now');
    expect(preRetirement!.title).toBe('Pre-retirement contribution optimization');
    // Primary action should name the HSA (seed has HSA at 1.59% of salary,
    // well below the ~4.5% needed to hit the limit).
    expect(preRetirement!.action).toMatch(/HSA/i);
    expect(preRetirement!.amountHint).toMatch(/federal tax savings/);
  });

  it('candidate carries a tradeoffs list', () => {
    const candidates = buildStrategicPrepCandidates(makeInput());
    const preRetirement = candidates.find(
      (candidate) => candidate.id === 'pre-retirement-accumulation',
    );
    expect(preRetirement).toBeDefined();
    expect(preRetirement!.tradeoffs.length).toBeGreaterThan(0);
  });

  it('does NOT surface for an already-retired household', () => {
    const data = JSON.parse(JSON.stringify(initialSeedData)) as SeedData;
    data.income.salaryAnnual = 0;
    data.income.salaryEndDate = '2020-01-01';
    const candidates = buildStrategicPrepCandidates(makeInput({ data }));
    const preRetirement = candidates.find(
      (candidate) => candidate.id === 'pre-retirement-accumulation',
    );
    expect(preRetirement).toBeUndefined();
  });

  it('policyFlags allow tax-only signal (since recommendation is advisory)', () => {
    const candidates = buildStrategicPrepCandidates(makeInput());
    const preRetirement = candidates.find(
      (candidate) => candidate.id === 'pre-retirement-accumulation',
    );
    expect(preRetirement).toBeDefined();
    expect(preRetirement!.policyFlags?.allowTaxOnlySignal).toBe(true);
  });
});
