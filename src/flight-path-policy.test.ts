import { describe, expect, it, vi } from 'vitest';
import { initialSeedData } from './data';
import {
  buildFlightPathStrategicPrepRecommendations,
  buildStrategicPrepCandidates,
  FLIGHT_PATH_POLICY_VERSION,
  type FlightPathPolicyInput,
} from './flight-path-policy';
import type { PlanEvaluation } from './plan-evaluation';
import type { MarketAssumptions, PathResult, SeedData } from './types';

vi.mock('./utils', async () => {
  const actual = await vi.importActual<typeof import('./utils')>('./utils');

  const makeMockPath = (data: SeedData): PathResult => {
    const optionalMonthly = data.spending.optionalMonthly;
    const totalMonthly =
      data.spending.essentialMonthly +
      data.spending.optionalMonthly +
      data.spending.annualTaxesInsurance / 12;
    const annualSpend = totalMonthly * 12 + data.spending.travelEarlyRetirementAnnual;
    const successRate = Math.max(0, Math.min(1, 0.93 + (2_200 - optionalMonthly) / 30_000));
    const medianEndingWealth = 1_000_000 + (2_000 - optionalMonthly) * 2_000;
    const annualFederalTaxEstimate = 30_000 + optionalMonthly * 12 * 0.08;
    const yearsFunded = 31 + (2_000 - optionalMonthly) / 1_000;

    return {
      successRate,
      medianEndingWealth,
      annualFederalTaxEstimate,
      yearsFunded,
      yearlySeries: [{ medianSpending: annualSpend }],
    } as unknown as PathResult;
  };

  return {
    ...actual,
    buildPathResults: vi.fn((data: SeedData) => [makeMockPath(data)]),
  };
});

const POLICY_TEST_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 120,
  irmaaThreshold: 200_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260420,
  assumptionsVersion: 'flight-path-policy-test',
};

function buildPolicyInput(): FlightPathPolicyInput {
  const data = structuredClone(initialSeedData);
  data.spending.optionalMonthly = 2_200;
  data.spending.travelEarlyRetirementAnnual = 12_000;
  const essentialWithFixed =
    data.spending.essentialMonthly + data.spending.annualTaxesInsurance / 12;
  data.accounts.cash.balance = essentialWithFixed * 18;

  const evaluation = {
    summary: {
      activeOptimizationObjective: 'maximize_time_weighted_spending',
    },
    calibration: {
      userTargetMonthlySpendNow: 7_000,
      supportedMonthlySpendNow: 6_200,
      minimumSuccessRateTarget: 0.92,
      projectedLegacyTodayDollars: 1_050_000,
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
              robAge: 60,
              debbieAge: 59,
              irmaaStatus: 'none',
              irmaaHeadroom: 30_000,
              estimatedMAGI: 110_000,
              regime: 'retirement',
              acaFriendlyMagiCeiling: 120_000,
              suggestedRothConversion: 0,
              withdrawalCash: 12_000,
              withdrawalTaxable: 12_000,
              withdrawalIra401k: 12_000,
              withdrawalRoth: 12_000,
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
    assumptions: POLICY_TEST_ASSUMPTIONS,
    selectedStressors: [],
    selectedResponses: [],
    nowYear: 2026,
    maxRecommendations: 5,
  };
}

describe('flight-path-policy', () => {
  it('generates expected spend-gap trigger candidate', () => {
    const candidates = buildStrategicPrepCandidates(buildPolicyInput());
    const spendGapCandidate = candidates.find((candidate) => candidate.id === 'spend-gap-reduce');

    expect(spendGapCandidate).toBeDefined();
    expect(spendGapCandidate?.triggerReason).toContain('Target spending currently exceeds');
  });

  it('returns seeded counterfactual recommendation diagnostics', () => {
    const result = buildFlightPathStrategicPrepRecommendations(buildPolicyInput());

    expect(result.policyVersion).toBe(FLIGHT_PATH_POLICY_VERSION);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].estimatedImpact?.modeledBy).toBe('seeded_path_counterfactual');
    expect(result.recommendations[0].evidence.baseline).not.toBeNull();
    expect(result.recommendations[0].evidence.counterfactual).not.toBeNull();

    expect(result.diagnostics.policyVersion).toBe(FLIGHT_PATH_POLICY_VERSION);
    expect(result.diagnostics.counterfactualSimulationRuns).toBe(72);
    expect(result.diagnostics.counterfactualSimulationSeed).toBe(20260420);
    expect(result.diagnostics.candidatesConsidered).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.hardConstraintFiltered).toHaveLength(0);
    expect(result.diagnostics.acceptedRecommendationIds).toContain(result.recommendations[0].id);
  });

  it('is stable for repeated runs with identical seeded inputs', () => {
    const first = buildFlightPathStrategicPrepRecommendations(buildPolicyInput());
    const second = buildFlightPathStrategicPrepRecommendations(buildPolicyInput());

    expect(second.recommendations.map((item) => item.id)).toEqual(
      first.recommendations.map((item) => item.id),
    );
    expect(second.diagnostics.rankedCandidates).toEqual(first.diagnostics.rankedCandidates);
    expect(second.diagnostics.impactDeltaSummaryReturnedRecommendations).toEqual(
      first.diagnostics.impactDeltaSummaryReturnedRecommendations,
    );
  });
});
