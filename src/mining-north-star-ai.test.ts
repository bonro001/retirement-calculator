import { describe, expect, it } from 'vitest';
import {
  buildMiningNorthStarAiReviewInput,
} from './mining-north-star-ai';
import type {
  PolicyEvaluation,
  PolicyMiningSessionConfig,
} from './policy-miner-types';
import type { WithdrawalRule } from './types';

function makeEval(args: {
  id: string;
  spend: number;
  legacy: number;
  solvency: number;
  p50: number;
  withdrawalRule?: WithdrawalRule;
}): PolicyEvaluation {
  return {
    evaluatedByNodeId: 'test',
    id: args.id,
    baselineFingerprint: 'baseline-a',
    engineVersion: 'engine-a',
    evaluatedAtIso: '2026-05-13T00:00:00.000Z',
    policy: {
      annualSpendTodayDollars: args.spend,
      primarySocialSecurityClaimAge: 70,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 70_000,
      withdrawalRule: args.withdrawalRule,
    },
    outcome: {
      solventSuccessRate: args.solvency,
      bequestAttainmentRate: args.legacy,
      p10EndingWealthTodayDollars: args.p50 * 0.6,
      p25EndingWealthTodayDollars: args.p50 * 0.8,
      p50EndingWealthTodayDollars: args.p50,
      p75EndingWealthTodayDollars: args.p50 * 1.2,
      p90EndingWealthTodayDollars: args.p50 * 1.4,
      medianLifetimeSpendTodayDollars: args.spend * 30,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 250_000,
      irmaaExposureRate: 0.2,
    },
    evaluationDurationMs: 10,
  };
}

function makeConfig(
  overrides: Partial<PolicyMiningSessionConfig> = {},
): PolicyMiningSessionConfig {
  return {
    baselineFingerprint: 'baseline-a',
    engineVersion: 'engine-a',
    axes: {
      annualSpendTodayDollars: [120_000, 140_000, 160_000],
      primarySocialSecurityClaimAge: [70],
      spouseSocialSecurityClaimAge: [67],
      rothConversionAnnualCeiling: [70_000],
      withdrawalRule: ['tax_bracket_waterfall', 'proportional'],
    },
    feasibilityThreshold: 0.85,
    maxPoliciesPerSession: 3,
    ...overrides,
  };
}

describe('buildMiningNorthStarAiReviewInput', () => {
  it('selects the highest-spend gate-passing candidate and summarizes the boundary', () => {
    const input = buildMiningNorthStarAiReviewInput({
      sessionId: 'session-a',
      config: makeConfig({
        spendingScheduleBasis: {
          id: 'go-go',
          label: 'Go-go / slow-go',
          multipliersByYear: {
            2028: 1.2,
            2029: 1.2,
            2030: 1.2,
            2031: 1.2,
            2032: 1.2,
            2033: 1.2,
            2034: 1.2,
            2035: 1.2,
            2036: 1.2,
            2037: 1.2,
            2038: 0.8,
            2039: 0.8,
            2040: 0.8,
            2041: 0.8,
            2042: 0.8,
            2043: 0.8,
            2044: 0.8,
            2045: 0.8,
            2046: 0.8,
            2047: 0.8,
          },
        },
      }),
      evaluations: [
        makeEval({
          id: 'spend-120',
          spend: 120_000,
          legacy: 0.99,
          solvency: 1,
          p50: 2_500_000,
          withdrawalRule: 'tax_bracket_waterfall',
        }),
        makeEval({
          id: 'spend-140',
          spend: 140_000,
          legacy: 0.9,
          solvency: 0.98,
          p50: 1_200_000,
          withdrawalRule: 'proportional',
        }),
        makeEval({
          id: 'spend-160',
          spend: 160_000,
          legacy: 0.7,
          solvency: 0.95,
          p50: 700_000,
          withdrawalRule: 'proportional',
        }),
      ],
      legacyTargetTodayDollars: 1_000_000,
      generatedAtIso: '2026-05-13T00:00:00.000Z',
    });

    expect(input.corpus.selectedPolicyId).toBe('spend-140');
    expect(input.corpus.selectedPolicySource).toBe('best_gate_passing');
    expect(input.corpus.highestFeasibleSpendTodayDollars).toBe(140_000);
    expect(input.higherSpendAttempts.count).toBe(1);
    expect(input.higherSpendAttempts.closestByLegacyGate?.id).toBe('spend-160');
    expect(input.spendingSchedule.earlyToLateRatio).toBeGreaterThan(1.08);
    expect(input.deterministicFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'front_loaded_schedule',
          status: 'pass',
        }),
        expect.objectContaining({
          id: 'withdrawal_order_swept',
          status: 'pass',
        }),
      ]),
    );
  });

  it('flags missing front-loaded schedule and withdrawal-order sweep', () => {
    const input = buildMiningNorthStarAiReviewInput({
      sessionId: 'session-b',
      config: makeConfig({
        axes: {
          annualSpendTodayDollars: [140_000],
          primarySocialSecurityClaimAge: [70],
          spouseSocialSecurityClaimAge: [67],
          rothConversionAnnualCeiling: [70_000],
          withdrawalRule: ['tax_bracket_waterfall'],
        },
      }),
      evaluations: [
        makeEval({
          id: 'spend-140',
          spend: 140_000,
          legacy: 0.93,
          solvency: 0.99,
          p50: 1_400_000,
          withdrawalRule: 'tax_bracket_waterfall',
        }),
      ],
      legacyTargetTodayDollars: 1_000_000,
      generatedAtIso: '2026-05-13T00:00:00.000Z',
    });

    expect(input.higherSpendAttempts.count).toBe(0);
    expect(input.deterministicFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'constant_spend_shape',
          status: 'watch',
        }),
        expect.objectContaining({
          id: 'withdrawal_order_not_swept',
          status: 'watch',
        }),
      ]),
    );
  });
});
