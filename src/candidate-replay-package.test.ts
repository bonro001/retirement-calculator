import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { DEFAULT_ENGINE_COMPARE_ASSUMPTIONS } from './engine-compare';
import { candidateReplayPackageToRequest } from './candidate-replay-package';
import {
  buildPolicyAnnualSpendScheduleByYear,
  evaluatePolicyFullTrace,
  evaluatePolicyWithSummary,
} from './policy-miner-eval';
import {
  comparePolicyMiningSummaries,
  pathToPolicyMiningSummary,
} from './policy-mining-summary-contract';
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

describe('candidate replay package', () => {
  it('packages TS authoritative policy output into a replayable Rust request', { timeout: 20_000 }, async () => {
    const replayPackage = await evaluatePolicyWithSummary(
      POLICY,
      initialSeedData,
      {
        ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
        simulationRuns: 8,
        assumptionsVersion: 'candidate-replay-package-test',
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

    expect(replayPackage.packageVersion).toBe('candidate-replay-package-v1');
    expect(replayPackage.evaluation.policy).toEqual(POLICY);
    expect(replayPackage.summary.outputLevel).toBe('policy_mining_summary');
    expect(request.schemaVersion).toBe('engine-candidate-request-v1');
    expect(request.outputLevel).toBe('policy_mining_summary');
    expect(request.annualSpendTarget).toBe(POLICY.annualSpendTodayDollars);
    expect(request.assumptions.withdrawalRule).toBe(POLICY.withdrawalRule);
    expect(request.tape.trialCount).toBe(8);
    expect(request.tape.trials[0].reference).toBeUndefined();
    expect(request.tape.trials[0].marketPath[0].cashflow).toEqual({});
  });

  it('shapes mined policy spend targets through a selected schedule basis', { timeout: 20_000 }, async () => {
    const spendingScheduleBasis = {
      id: 'jpmorgan_curve_travel_included',
      label: 'J.P. Morgan Curve, Travel Included',
      multipliersByYear: {
        2026: 1,
        2027: 0.97,
        2028: 0.94,
      },
    };
    const schedule = buildPolicyAnnualSpendScheduleByYear(
      POLICY,
      spendingScheduleBasis,
    );
    expect(schedule).toEqual({
      2026: 120_000,
      2027: 116_400,
      2028: 112_800,
    });

    const replayPackage = await evaluatePolicyWithSummary(
      POLICY,
      initialSeedData,
      {
        ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
        simulationRuns: 8,
        assumptionsVersion: 'candidate-replay-schedule-basis-test',
      },
      'test-baseline-jpmorgan',
      'test-engine',
      'test-node',
      cloneSeedData,
      1_000_000,
      { recordTape: true, spendingScheduleBasis },
    );

    const request = candidateReplayPackageToRequest(
      replayPackage,
      'policy_mining_summary',
    );

    expect(replayPackage.annualSpendScheduleByYear).toEqual(schedule);
    expect(request.annualSpendScheduleByYear).toEqual(schedule);
  });

  it('reruns a mined policy with a full trace that matches the summary contract', { timeout: 20_000 }, async () => {
    const assumptions = {
      ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
      simulationRuns: 8,
      assumptionsVersion: 'candidate-full-trace-rerun-test',
    };
    const replayPackage = await evaluatePolicyWithSummary(
      POLICY,
      initialSeedData,
      assumptions,
      'test-baseline',
      'test-engine',
      'test-node',
      cloneSeedData,
      1_000_000,
    );
    const fullTracePath = evaluatePolicyFullTrace(
      POLICY,
      initialSeedData,
      assumptions,
      cloneSeedData,
    );

    const comparison = comparePolicyMiningSummaries(
      replayPackage.summary,
      pathToPolicyMiningSummary(fullTracePath),
    );

    expect(comparison.pass).toBe(true);
    expect(fullTracePath.yearlySeries.length).toBeGreaterThan(0);
    expect(fullTracePath.simulationDiagnostics.withdrawalPath.length).toBeGreaterThan(0);
  });
});
