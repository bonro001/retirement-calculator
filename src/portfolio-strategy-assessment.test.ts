import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import {
  buildPortfolioStrategyAssessment,
  type PortfolioStrategyCheck,
} from './portfolio-strategy-assessment';
import type { MarketAssumptions, PathResult, SeedData, WithdrawalRule } from './types';

const ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.07,
  internationalEquityVolatility: 0.17,
  bondMean: 0.038,
  bondVolatility: 0.06,
  cashMean: 0.02,
  cashVolatility: 0.005,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 500,
  irmaaThreshold: 200_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260512,
  assumptionsVersion: 'portfolio-strategy-assessment-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function makePath(rule: WithdrawalRule = 'tax_bracket_waterfall') {
  return {
    medianEndingWealth: 7_880_000,
    monteCarloMetadata: {
      planningHorizonYears: 33,
      seed: 20260512,
      trialCount: 500,
      assumptionsVersion: 'portfolio-strategy-assessment-test',
    },
    yearlySeries: [
      {
        year: 2027,
        medianSpending: 118_000,
        medianCashBalance: 43_000,
        medianWithdrawalCash: 0,
        medianWithdrawalTaxable: 0,
        medianWithdrawalIra401k: 0,
        medianWithdrawalRoth: 0,
        medianAcaPremiumEstimate: 30_384,
        medianAcaSubsidyEstimate: 0,
        medianNetAcaCost: 30_384,
      },
      {
        year: 2028,
        medianSpending: 118_000,
        medianCashBalance: 928_000,
        medianWithdrawalCash: 16_000,
        medianWithdrawalTaxable: 20_000,
        medianWithdrawalIra401k: 40_000,
        medianWithdrawalRoth: 0,
        medianAcaPremiumEstimate: 30_000,
        medianAcaSubsidyEstimate: 29_000,
        medianNetAcaCost: 1_000,
      },
      {
        year: 2036,
        medianSpending: 103_000,
        medianCashBalance: 1_100_000,
        medianWithdrawalCash: 50_000,
        medianWithdrawalTaxable: 0,
        medianWithdrawalIra401k: 30_000,
        medianWithdrawalRoth: 0,
        medianAcaPremiumEstimate: 0,
        medianAcaSubsidyEstimate: 0,
        medianNetAcaCost: 0,
      },
      {
        year: 2048,
        medianSpending: 200_000,
        medianCashBalance: 1_050_000,
        medianWithdrawalCash: 0,
        medianWithdrawalTaxable: 0,
        medianWithdrawalIra401k: 24_000,
        medianWithdrawalRoth: 0,
        medianAcaPremiumEstimate: 0,
        medianAcaSubsidyEstimate: 0,
        medianNetAcaCost: 0,
      },
    ],
    simulationDiagnostics: {
      rothConversionEligibilityPath: [
        {
          year: 2028,
          annualPolicyMaxBinding: true,
          safeRoomUnusedDueToAnnualPolicyMax: 30_000,
        },
      ],
    },
    simulationConfiguration: {
      withdrawalPolicy: {
        withdrawalRule: rule,
      },
    },
  } as unknown as PathResult;
}

function byId(checks: PortfolioStrategyCheck[], id: string) {
  const check = checks.find((item) => item.id === id);
  expect(check).toBeDefined();
  return check!;
}

describe('portfolio strategy assessment', () => {
  it('surfaces north-star mismatches as structured checks', () => {
    const data = cloneSeedData(initialSeedData);
    data.goals = { legacyTargetTodayDollars: 1_000_000 };
    data.rules.rothConversionPolicy = {
      ...data.rules.rothConversionPolicy,
      enabled: true,
      maxAnnualDollars: 40_000,
      lowIncomeBracketFill: {
        enabled: true,
        startYear: 2028,
        endYear: 2030,
        annualTargetDollars: 70_000,
        requireNoWageIncome: true,
      },
    };

    const assessment = buildPortfolioStrategyAssessment({
      data,
      assumptions: ASSUMPTIONS,
      path: makePath(),
      generatedAtIso: '2026-05-12T12:00:00.000Z',
      supportedAnnualSpendTodayDollars: 152_000,
    });

    expect(assessment.version).toBe('portfolio_strategy_assessment_v1');
    expect(assessment.status).toBe('fail');
    expect(byId(assessment.checks, 'legacy_target_alignment').status).toBe('fail');
    expect(byId(assessment.checks, 'aca_bridge_integrity').status).toBe('fail');
    expect(byId(assessment.checks, 'cash_runway').status).toBe('fail');
    expect(byId(assessment.checks, 'roth_conversion_headroom').status).toBe('watch');
    expect(byId(assessment.checks, 'spending_phase_shape').status).toBe('watch');
    expect(assessment.metrics.supportedSpendGapAnnual).toBe(11_988);
    expect(assessment.metrics.medianLegacyToTargetRatio).toBeGreaterThan(3);
    expect(assessment.withdrawalOrdering.conversionAnnualCapBindingYears).toEqual([2028]);
    expect(assessment.actionItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'front_load_to_legacy_target',
        'repair_aca_bridge',
        'use_low_income_conversion_room',
        'sweep_excess_cash',
      ]),
    );
  });

  it('treats withdrawal ordering as a first-class policy axis', () => {
    const data = cloneSeedData(initialSeedData);
    data.goals = { legacyTargetTodayDollars: 1_000_000 };
    const assessment = buildPortfolioStrategyAssessment({
      data,
      assumptions: { ...ASSUMPTIONS, withdrawalRule: 'reverse_waterfall' },
      path: makePath('reverse_waterfall'),
      generatedAtIso: '2026-05-12T12:00:00.000Z',
    });

    const withdrawalCheck = byId(assessment.checks, 'withdrawal_rule_alignment');
    expect(withdrawalCheck.status).toBe('watch');
    expect(withdrawalCheck.detail).toContain('Reverse waterfall');
    expect(assessment.withdrawalOrdering.recommendedStages.map((stage) => stage.id)).toEqual(
      expect.arrayContaining([
        'aca_bridge',
        'low_income_conversion_window',
        'medicare_pre_rmd',
        'rmd_years',
        'roth_reserve',
      ]),
    );
  });

  it('flags real holding concentration separately from broad asset allocation', () => {
    const data = cloneSeedData(initialSeedData);
    data.goals = { legacyTargetTodayDollars: 1_000_000 };

    const assessment = buildPortfolioStrategyAssessment({
      data,
      assumptions: ASSUMPTIONS,
      path: makePath(),
      generatedAtIso: '2026-05-12T12:00:00.000Z',
    });

    expect(assessment.metrics.allocation.totalEquity).toBeGreaterThan(0.5);
    expect(assessment.metrics.concentration.largestHolding?.symbol).toBe('FCNTX');
    expect(
      assessment.metrics.concentration.holdingsOverAccountLimit.map(
        (holding) => holding.symbol,
      ),
    ).toContain('FCNTX');
    expect(byId(assessment.checks, 'holding_concentration').status).toBe('fail');
  });
});
