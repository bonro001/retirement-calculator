import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import {
  buildFlightPathStrategicPrepRecommendations,
  buildStrategicPrepCandidates,
  FLIGHT_PATH_POLICY_THRESHOLDS,
  FLIGHT_PATH_THRESHOLD_PROFILE_REVIEW_DATE,
  FLIGHT_PATH_THRESHOLD_PROFILE_VERSION,
  type FlightPathPolicyInput,
} from './flight-path-policy';
import type { PlanEvaluation } from './plan-evaluation';
import type { MarketAssumptions } from './types';

const THRESHOLD_TEST_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.07,
  equityVolatility: 0.16,
  internationalEquityMean: 0.07,
  internationalEquityVolatility: 0.18,
  bondMean: 0.035,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 32,
  irmaaThreshold: 200_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260420,
  assumptionsVersion: 'flight-path-threshold-calibration-test',
};

type ThresholdScenarioInput = {
  spendGapMonthly?: number;
  cashRatioToTarget?: number;
  irmaaHeadroom?: number;
  suggestedRothConversion?: number;
  withdrawalShare?: number;
};

function buildPolicyInput(overrides: ThresholdScenarioInput = {}): FlightPathPolicyInput {
  const data = structuredClone(initialSeedData);
  const essentialWithFixed =
    data.spending.essentialMonthly + data.spending.annualTaxesInsurance / 12;
  const cashRatio = overrides.cashRatioToTarget ?? 1;
  data.accounts.cash.balance =
    essentialWithFixed *
    FLIGHT_PATH_POLICY_THRESHOLDS.recommendedCashBufferMonths *
    cashRatio;

  const spendGapMonthly = overrides.spendGapMonthly ?? 0;
  const supportedMonthly = 6_000;
  const userTargetMonthly = supportedMonthly + spendGapMonthly;
  const withdrawalShare = overrides.withdrawalShare ?? 0.25;
  const firstYearWithdrawals = 48_000;
  const dominantWithdrawal = firstYearWithdrawals * withdrawalShare;
  const remaining = firstYearWithdrawals - dominantWithdrawal;

  const evaluation = {
    summary: {
      activeOptimizationObjective: 'maximize_time_weighted_spending',
    },
    calibration: {
      userTargetMonthlySpendNow: userTargetMonthly,
      supportedMonthlySpendNow: supportedMonthly,
      minimumSuccessRateTarget: 0.92,
      projectedLegacyTodayDollars: 1_200_000,
      legacyFloorTodayDollars: 850_000,
      legacyTargetBandLowerTodayDollars: 1_000_000,
      bindingConstraint: 'success floor',
      nextUnlock: null,
      nextUnlockImpactMonthly: 0,
      successConstraintBinding: true,
      successFloorRelaxationTradeoff: null,
    },
    raw: {
      run: {
        autopilot: {
          years: [
            {
              year: 2026,
              robAge: 66,
              debbieAge: 64,
              irmaaStatus: 'none',
              irmaaHeadroom: overrides.irmaaHeadroom ?? 15_000,
              estimatedMAGI: 130_000,
              regime: 'retirement',
              acaFriendlyMagiCeiling: 120_000,
              suggestedRothConversion: overrides.suggestedRothConversion ?? 0,
              withdrawalCash: dominantWithdrawal,
              withdrawalTaxable: remaining / 3,
              withdrawalIra401k: remaining / 3,
              withdrawalRoth: remaining / 3,
            },
          ],
        },
        plan: {
          constraints: {
            doNotRetireLater: false,
            doNotSellHouse: false,
          },
        },
      },
    },
  } as unknown as PlanEvaluation;

  return {
    evaluation,
    data,
    assumptions: THRESHOLD_TEST_ASSUMPTIONS,
    selectedStressors: [],
    selectedResponses: [],
    nowYear: 2026,
    maxRecommendations: 6,
  };
}

function candidateIds(input: FlightPathPolicyInput) {
  return buildStrategicPrepCandidates(input).map((candidate) => candidate.id);
}

describe('flight-path-policy threshold calibration suite', () => {
  it('suppresses spend-gap recommendation below threshold and enables it above threshold', () => {
    const below = candidateIds(
      buildPolicyInput({
        spendGapMonthly: FLIGHT_PATH_POLICY_THRESHOLDS.spendGapTriggerMonthly - 10,
      }),
    );
    const above = candidateIds(
      buildPolicyInput({
        spendGapMonthly: FLIGHT_PATH_POLICY_THRESHOLDS.spendGapTriggerMonthly + 10,
      }),
    );

    expect(below).not.toContain('spend-gap-reduce');
    expect(above).toContain('spend-gap-reduce');
  });

  it('fires cash-buffer top-up and redeploy only outside calibrated runway band', () => {
    const lowCash = candidateIds(
      buildPolicyInput({
        cashRatioToTarget: FLIGHT_PATH_POLICY_THRESHOLDS.cashBufferLowerBoundRatio - 0.05,
      }),
    );
    const inBandCash = candidateIds(
      buildPolicyInput({
        cashRatioToTarget: 1,
      }),
    );
    const highCash = candidateIds(
      buildPolicyInput({
        cashRatioToTarget: FLIGHT_PATH_POLICY_THRESHOLDS.cashBufferUpperBoundRatio + 0.1,
      }),
    );

    expect(lowCash).toContain('cash-buffer-top-up');
    expect(inBandCash).not.toContain('cash-buffer-top-up');
    expect(inBandCash).not.toContain('cash-buffer-redeploy');
    expect(highCash).toContain('cash-buffer-redeploy');
  });

  it('fires IRMAA and conversion recommendations near calibrated pressure points', () => {
    const irmaaSafe = candidateIds(
      buildPolicyInput({
        irmaaHeadroom: FLIGHT_PATH_POLICY_THRESHOLDS.irmaaHeadroomPressureDollars + 500,
      }),
    );
    const irmaaPressure = candidateIds(
      buildPolicyInput({
        irmaaHeadroom: FLIGHT_PATH_POLICY_THRESHOLDS.irmaaHeadroomPressureDollars - 500,
      }),
    );
    const conversionLow = candidateIds(
      buildPolicyInput({
        suggestedRothConversion:
          FLIGHT_PATH_POLICY_THRESHOLDS.plannedConversionSuggestionMinimumAnnual - 100,
      }),
    );
    const conversionHigh = candidateIds(
      buildPolicyInput({
        suggestedRothConversion:
          FLIGHT_PATH_POLICY_THRESHOLDS.plannedConversionSuggestionMinimumAnnual + 2_000,
      }),
    );

    expect(irmaaSafe).not.toContain('irmaa-cap');
    expect(irmaaPressure).toContain('irmaa-cap');
    expect(conversionLow).not.toContain('roth-conversion-program');
    expect(conversionHigh).toContain('roth-conversion-program');
  });

  it('gates withdrawal-concentration recommendation at calibrated dominance threshold', () => {
    const notDominant = candidateIds(
      buildPolicyInput({
        withdrawalShare: FLIGHT_PATH_POLICY_THRESHOLDS.withdrawalConcentrationRatio - 0.03,
      }),
    );
    const dominant = candidateIds(
      buildPolicyInput({
        withdrawalShare: FLIGHT_PATH_POLICY_THRESHOLDS.withdrawalConcentrationRatio + 0.03,
      }),
    );

    expect(notDominant).not.toContain('withdrawal-concentration');
    expect(dominant).toContain('withdrawal-concentration');
  });

  it('surfaces threshold profile metadata in diagnostics', () => {
    const result = buildFlightPathStrategicPrepRecommendations(buildPolicyInput());
    expect(result.diagnostics.thresholdProfileVersion).toBe(
      FLIGHT_PATH_THRESHOLD_PROFILE_VERSION,
    );
    expect(result.diagnostics.thresholdProfileReviewDate).toBe(
      FLIGHT_PATH_THRESHOLD_PROFILE_REVIEW_DATE,
    );
  });
});
