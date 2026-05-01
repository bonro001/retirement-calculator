import { describe, expect, it } from 'vitest';
import {
  candidateReplayPackageToRequest,
} from './candidate-replay-package';
import {
  compactSummaryRandomTapeByteLength,
  packSummaryRandomTape,
  unpackSummaryRandomTape,
} from './compact-random-tape';
import { initialSeedData } from './data';
import { DEFAULT_ENGINE_COMPARE_ASSUMPTIONS } from './engine-compare';
import { evaluatePolicyWithSummary } from './policy-miner-eval';
import type { Policy } from './policy-miner-types';
import type { SeedData } from './types';

const POLICY: Policy = {
  annualSpendTodayDollars: 120_000,
  primarySocialSecurityClaimAge: 67,
  spouseSocialSecurityClaimAge: 67,
  rothConversionAnnualCeiling: 80_000,
  withdrawalRule: 'tax_bracket_waterfall',
};

function cloneSeedData(seed: SeedData): SeedData {
  return structuredClone(seed);
}

describe('compact random tape', () => {
  it('packs summary replay tape into typed arrays and round-trips the compact JSON shape', { timeout: 20_000 }, async () => {
    const replayPackage = await evaluatePolicyWithSummary(
      POLICY,
      initialSeedData,
      {
        ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
        simulationRuns: 8,
        assumptionsVersion: 'compact-random-tape-test',
      },
      'test-baseline',
      'test-engine',
      'test-node',
      cloneSeedData,
      1_000_000,
      { recordTape: true },
    );
    const request = candidateReplayPackageToRequest(
      replayPackage,
      'policy_mining_summary',
    );

    const compact = packSummaryRandomTape(request.tape);
    const unpacked = unpackSummaryRandomTape(compact);
    const jsonBytes = Buffer.byteLength(JSON.stringify(request.tape), 'utf8');
    const binaryBytes = compactSummaryRandomTapeByteLength(compact);

    expect(unpacked).toEqual(request.tape);
    expect(compact.trialIndex.length).toBe(request.tape.trialCount);
    expect(compact.marketYears.length).toBe(
      request.tape.trialCount *
        request.tape.planningHorizonYears *
        compact.yearFieldCount,
    );
    expect(binaryBytes).toBeLessThan(jsonBytes);
  });
});
