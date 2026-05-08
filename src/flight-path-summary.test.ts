import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { buildExecutiveFlightSummary } from './flight-path-summary';
import type { StrategicPrepRecommendation } from './flight-path-policy';
import type { PlanEvaluation } from './plan-evaluation';
import type { FlightPathPhasePlaybook } from './flight-path-action-playbook';
import type { SeedData } from './types';

function cloneData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function buildMockPlaybook(): FlightPathPhasePlaybook {
  return {
    diagnostics: {
      scenarioRuns: 48,
      simulationSeed: 20260416,
      inferredAssumptions: [],
      acaGuardrailAdjustment: {
        mode: 'recovery',
        active: true,
        subsidyRiskBand: 'red',
        requiredMagiReduction: 2622,
        prioritizedPhaseIds: ['aca_bridge', 'pre_retirement', 'medicare_irmaa', 'pre_rmd', 'rmd_phase'],
        acaBridgeScoreBoost: 0.45,
        priorityDriver: 'aca_bridge_first',
        runwayGapMonths: 6.1,
        yearsUntilBridge: 1,
      },
    },
    retirementFlowYears: [],
    phases: [
      {
        id: 'pre_retirement',
        label: 'Pre-Retirement',
        windowStartYear: 2026,
        windowEndYear: 2027,
        status: 'active',
        objective: 'Build runway.',
        actions: [
          {
            id: 'pre-retirement-payroll-runway-2',
            phaseId: 'pre_retirement',
            title: 'Balanced payroll runway cash builder',
            priority: 'now',
            rankWithinPhase: 1,
            rankScore: 1.2,
            isTopRecommendation: true,
            objective: 'Build runway.',
            whyNow: 'Runway below target.',
            tradeInstructions: [],
            contributionSettingsPatch: {
              employee401kPreTaxAnnualAmount: 30000,
            },
            fullGoalDollars: 56000,
            estimatedImpact: {
              supportedMonthlyDelta: 0,
              successRateDelta: 0,
              medianEndingWealthDelta: 0,
              annualFederalTaxDelta: 0,
              yearsFundedDelta: 0,
              earlyFailureProbabilityDelta: 0,
              worstDecileEndingWealthDelta: 0,
              spendingCutRateDelta: 0,
              equitySalesInAdverseEarlyYearsRateDelta: 0,
            },
            sensitivity: {
              baseSeed: 20260416,
              simulationRunsPerScenario: 48,
              directionConsistencyScore: 1,
              scenarios: [],
            },
            laymanExpansion: {
              templateVersion: 'layman_v1',
              cacheKey: 'k',
              storyHook: 'hook',
              plainEnglishTask: 'task',
              whyImportant: 'why',
              walkthroughSteps: [],
              watchOuts: [],
            },
            modelCompleteness: 'faithful',
            inferredAssumptions: [],
            intermediateCalculations: {},
          },
        ],
      },
      {
        id: 'aca_bridge',
        label: 'ACA Bridge',
        windowStartYear: 2027,
        windowEndYear: 2029,
        status: 'upcoming',
        objective: 'Keep MAGI in range.',
        acaMetrics: {
          bridgeYear: 2027,
          projectedMagi: 87591,
          acaFriendlyMagiCeiling: 84969,
          headroomToCeiling: -2622,
          requiredMagiReduction: 2622,
          unmitigatedProjectedMagi: 87591,
          unmitigatedRequiredMagiReduction: 2622,
          acaMitigationDelta: 0,
          acaStatus: 'breach',
          guardrailBufferDollars: 5000,
          targetMagiCeilingWithBuffer: 79969,
          requiredMagiReductionWithBuffer: 7622,
          estimatedAcaPremiumAtRisk: 25000,
          subsidyRiskBand: 'red',
          modelCompleteness: 'faithful',
          inferredAssumptions: [],
          intermediateCalculations: {},
        },
        actions: [
          {
            id: 'aca-bridge-payroll-magi-reducer-1',
            phaseId: 'aca_bridge',
            title: 'ACA bridge payroll MAGI reducer',
            priority: 'now',
            rankWithinPhase: 1,
            rankScore: 1.6,
            isTopRecommendation: true,
            objective: 'Reduce MAGI.',
            whyNow: 'Above ceiling.',
            tradeInstructions: [],
            contributionSettingsPatch: {
              employee401kPreTaxAnnualAmount: 32500,
            },
            fullGoalDollars: 2622,
            estimatedImpact: {
              supportedMonthlyDelta: 50,
              successRateDelta: 0.01,
              medianEndingWealthDelta: 10000,
              annualFederalTaxDelta: -500,
              yearsFundedDelta: 0.2,
              earlyFailureProbabilityDelta: -0.01,
              worstDecileEndingWealthDelta: 5000,
              spendingCutRateDelta: -0.01,
              equitySalesInAdverseEarlyYearsRateDelta: -0.01,
            },
            sensitivity: {
              baseSeed: 20260416,
              simulationRunsPerScenario: 48,
              directionConsistencyScore: 1,
              scenarios: [],
            },
            laymanExpansion: {
              templateVersion: 'layman_v1',
              cacheKey: 'k2',
              storyHook: 'hook',
              plainEnglishTask: 'task',
              whyImportant: 'why',
              walkthroughSteps: [],
              watchOuts: [],
            },
            modelCompleteness: 'faithful',
            inferredAssumptions: [],
            intermediateCalculations: {},
          },
        ],
      },
      {
        id: 'medicare_irmaa',
        label: 'Medicare + IRMAA',
        windowStartYear: 2030,
        windowEndYear: 2034,
        status: 'upcoming',
        objective: 'IRMAA shaping.',
        actions: [],
      },
      {
        id: 'pre_rmd',
        label: 'Pre-RMD',
        windowStartYear: 2035,
        windowEndYear: 2037,
        status: 'upcoming',
        objective: 'Tax shaping.',
        actions: [],
      },
      {
        id: 'rmd_phase',
        label: 'RMD',
        windowStartYear: 2038,
        windowEndYear: 2050,
        status: 'upcoming',
        objective: 'RMD logistics.',
        actions: [],
      },
    ],
  };
}

function buildMockRecommendations(): StrategicPrepRecommendation[] {
  return [
    {
      id: 'spend-gap-reduce',
      priority: 'now',
      title: 'Align spending to supported level',
      action: 'Trim about $833/month.',
      triggerReason: 'Spending target exceeds supported.',
      amountHint: '$833/mo',
      tradeoffs: [],
      confidence: { label: 'high', score: 0.9, rationale: 'strong signal' },
      sensitivityConsistency: {
        score: 0.82,
        consistentScenarioCount: 4,
        totalScenarioCount: 5,
        rationale: '4/5 scenarios keep direction.',
      },
      evidence: {
        baseline: null,
        counterfactual: null,
        simulationRunsUsed: 72,
        simulationSeedUsed: 20260416,
        notes: [],
      },
      estimatedImpact: {
        modeledBy: 'seeded_path_counterfactual',
        supportedMonthlyDelta: 621,
        successRateDelta: 0.07,
        medianEndingWealthDelta: 621000,
        annualFederalTaxDelta: 0,
        yearsFundedDelta: 2.1,
        medianFailureYearDelta: 1.2,
        magiDelta: -3200,
        downsideRiskDelta: {
          earlyFailureProbabilityDelta: -0.03,
          worstDecileEndingWealthDelta: 22000,
          spendingCutRateDelta: -0.02,
          equitySalesInAdverseEarlyYearsRateDelta: -0.04,
          medianFailureShortfallDollarsDelta: -7500,
          medianDownsideSpendingCutRequiredDelta: -0.02,
        },
      },
    },
    {
      id: 'cash-buffer-top-up',
      priority: 'now',
      title: 'Top up cash buffer runway',
      action: 'Move about $56,000 into cash to reach target runway.',
      triggerReason: 'Runway is below target for early sequence defense.',
      amountHint: '$56K',
      tradeoffs: [],
      confidence: { label: 'high', score: 0.78, rationale: 'downside benefit proven' },
      sensitivityConsistency: {
        score: 0.92,
        consistentScenarioCount: 5,
        totalScenarioCount: 5,
        rationale: '5/5 scenarios keep direction.',
      },
      evidence: {
        baseline: null,
        counterfactual: null,
        simulationRunsUsed: 72,
        simulationSeedUsed: 20260416,
        notes: [],
      },
      estimatedImpact: {
        modeledBy: 'seeded_path_counterfactual',
        supportedMonthlyDelta: -50,
        successRateDelta: 0,
        medianEndingWealthDelta: -15000,
        annualFederalTaxDelta: 0,
        yearsFundedDelta: 0,
        medianFailureYearDelta: 0,
        magiDelta: 0,
        downsideRiskDelta: {
          earlyFailureProbabilityDelta: -0.01,
          worstDecileEndingWealthDelta: 6000,
          spendingCutRateDelta: -0.01,
          equitySalesInAdverseEarlyYearsRateDelta: -0.02,
          medianFailureShortfallDollarsDelta: -2500,
          medianDownsideSpendingCutRequiredDelta: -0.01,
        },
      },
    },
    {
      id: 'roth-conversion-program',
      priority: 'soon',
      title: 'Run annual Roth conversions',
      action: 'Plan about $90K/year.',
      triggerReason: 'Pre-RMD window available.',
      amountHint: '$90K/yr',
      tradeoffs: [],
      confidence: { label: 'low', score: 0.3, rationale: 'not fully stress-tested' },
      sensitivityConsistency: {
        score: 0.4,
        consistentScenarioCount: 2,
        totalScenarioCount: 5,
        rationale: '2/5 scenarios keep direction.',
      },
      evidence: {
        baseline: null,
        counterfactual: null,
        simulationRunsUsed: 72,
        simulationSeedUsed: 20260416,
        notes: [],
      },
      estimatedImpact: null,
    },
  ];
}

function buildMockEvaluation(): PlanEvaluation {
  return {
    summary: {
      planSupportsAnnual: 148800,
      planSupportsMonthly: 12400,
      successRate: 0.9,
      planVerdict: 'Moderate',
      biggestDriver: 'Spending',
      biggestRisk: 'Sequence risk',
      bestAction: 'Reduce optional spending',
      activeOptimizationObjective: 'maximize_time_weighted_spending',
      irmaaOutlook: 'Watch',
      legacyOutlook: 'On track',
    },
    calibration: {
      userTargetMonthlySpendNow: 13233,
      userTargetAnnualSpendNow: 158796,
      supportedMonthlySpendNow: 12400,
      supportedAnnualSpendNow: 148800,
      supportedSpend60s: 0,
      supportedSpend70s: 0,
      supportedSpend80Plus: 0,
      spendGapNowMonthly: -833,
      spendGapNowAnnual: -9996,
      flexibleSpendingMinimum: 0,
      overReservedAmount: 0,
      supportedAnnualSpend: 148800,
      supportedMonthlySpend: 12400,
      safeBandAnnual: { lower: 0, target: 0, upper: 0 },
      targetLegacyTodayDollars: 1000000,
      effectiveLegacyTargetTodayDollars: 1000000,
      legacyFloorTodayDollars: 800000,
      legacyTargetBandLowerTodayDollars: 900000,
      legacyTargetBandUpperTodayDollars: 1200000,
      legacyWithinTargetBand: true,
      legacyPriority: 'important',
      successFloorMode: 'balanced',
      minimumSuccessRateTarget: 0.92,
      achievedSuccessRate: 0.9,
      successConstraintBinding: false,
      supportedSpendAtCurrentSuccessFloor: 0,
      supportedSpendIfSuccessFloorRelaxed: 0,
      successFloorRelaxationTarget: null,
      successFloorRelaxationDeltaAnnual: 0,
      successFloorRelaxationDeltaMonthly: 0,
      nextUnlockImpactMonthly: 0,
      successFloorNextUnlock: null,
      successFloorRelaxationTradeoff: null,
      nextUnlock: null,
      supportedSpendingSchedule: [],
      projectedLegacyTodayDollars: 1000000,
      endingWealthOneSigmaApproxTodayDollars: 0,
      endingWealthOneSigmaLowerTodayDollars: 0,
      endingWealthOneSigmaUpperTodayDollars: 0,
      distanceFromTarget: 0,
      overTargetPenalty: 0,
      isTargetBinding: false,
      modeledSuccessRate: 0.9,
      bindingGuardrail: 'none',
      bindingGuardrailExplanation: 'none',
      bindingConstraint: 'spending',
      primaryTradeoff: 'none',
      whySupportedSpendIsNotHigher: 'none',
    },
    responsePolicy: {
      posture: 'balanced',
      routeSummary: 'Balanced route',
      tradeoffSummary: 'Tradeoff',
      primaryBindingConstraint: 'spending',
    },
    timePreference: {
      profile: { ages60to69: 'high', ages70to79: 'medium', ages80plus: 'low' },
      assessment: 'balanced_path',
      overConservingLateLife: false,
      earlySpendingCanIncreaseSafely: false,
      estimatedSafeEarlyAnnualShift: 0,
      explanation: 'explanation',
      recommendation: 'recommendation',
      indicators: {
        successBuffer: 0,
        legacyBuffer: 0,
        earlyFailureRate: 0,
        preSocialSecurityFailureRate: 0,
        p10EndingWealth: 0,
        p50EndingWealth: 0,
      },
    },
    irmaa: {
      posture: 'balanced',
      exposureLevel: 'Medium',
      likelyYearsAtRisk: [],
      mainDrivers: [],
      whatWouldLowerExposure: [],
      explanation: 'irmaa',
    },
    recommendations: { summary: 'summary', top: [] },
    whatChangedFromLastRun: null,
    sensitivities: { biggestDownside: null, worst: [] },
    excludedOptions: {
      activeFilters: { noDelayRetirement: false, noSellHouse: false },
      highImpact: [],
    },
    decisionImpact: null,
    raw: {} as PlanEvaluation['raw'],
  };
}

describe('buildExecutiveFlightSummary', () => {
  it('prioritizes top-three actions around spending, ACA, and runway', () => {
    const data = cloneData(initialSeedData);
    const result = buildExecutiveFlightSummary({
      data,
      evaluation: buildMockEvaluation(),
      phasePlaybook: buildMockPlaybook(),
      strategicPrepRecommendations: buildMockRecommendations(),
    });

    expect(result.actionCards).toHaveLength(3);
    expect(result.actionCards[0]?.category).toBe('spending');
    expect(result.actionCards.some((card) => card.category === 'aca')).toBe(true);
    expect(result.actionCards.some((card) => card.category === 'runway')).toBe(true);
    expect(result.narrative.whereThingsStand.length).toBeGreaterThan(30);
  });

  it('falls back gracefully when evaluation is unavailable', () => {
    const data = cloneData(initialSeedData);
    const result = buildExecutiveFlightSummary({
      data,
      evaluation: null,
      phasePlaybook: buildMockPlaybook(),
      strategicPrepRecommendations: buildMockRecommendations(),
    });

    expect(result.planHealth.successRate).toBeNull();
    expect(result.actionCards.length).toBe(3);
    expect(result.narrative.whereThingsStand).toContain('pending');
  });

  it('suppresses runway action card when no evidence-backed runway recommendation is returned', () => {
    const data = cloneData(initialSeedData);
    const recommendationsWithoutRunway = buildMockRecommendations().filter(
      (recommendation) => !recommendation.id.includes('cash-buffer'),
    );
    const result = buildExecutiveFlightSummary({
      data,
      evaluation: buildMockEvaluation(),
      phasePlaybook: buildMockPlaybook(),
      strategicPrepRecommendations: recommendationsWithoutRunway,
    });

    expect(result.actionCards.some((card) => card.category === 'runway')).toBe(false);
  });

  it('labels ACA as mitigated when the executed path is under the cliff but baseline risk remains', () => {
    const data = cloneData(initialSeedData);
    const evaluation = buildMockEvaluation();
    evaluation.calibration.supportedMonthlySpendNow = 11387;
    evaluation.calibration.userTargetMonthlySpendNow = 9667;
    evaluation.calibration.spendGapNowMonthly = 1720;

    const playbook = buildMockPlaybook();
    const acaPhase = playbook.phases.find((phase) => phase.id === 'aca_bridge');
    if (!acaPhase?.acaMetrics) {
      throw new Error('Mock ACA phase missing');
    }
    acaPhase.acaMetrics = {
      ...acaPhase.acaMetrics,
      projectedMagi: 72993,
      headroomToCeiling: 11976,
      requiredMagiReduction: 0,
      unmitigatedProjectedMagi: 87591,
      unmitigatedRequiredMagiReduction: 2622,
      acaMitigationDelta: 14598,
      acaStatus: 'mitigated',
      subsidyRiskBand: 'green',
    };

    const result = buildExecutiveFlightSummary({
      data,
      evaluation,
      phasePlaybook: playbook,
      strategicPrepRecommendations: buildMockRecommendations(),
    });

    expect(result.planHealth.acaProjectedMagi).toBe(72993);
    expect(result.planHealth.acaUnmitigatedProjectedMagi).toBe(87591);
    expect(result.planHealth.acaUnmitigatedRequiredReduction).toBe(2622);
    expect(result.planHealth.acaStatus).toBe('mitigated');
    expect(result.planHealth.acaMitigationActionIds).toEqual(
      expect.arrayContaining(['planner-roth-conversion-cap']),
    );

    const acaCard = result.actionCards.find((card) => card.category === 'aca');
    expect(acaCard).toBeDefined();
    expect(acaCard?.urgency).not.toBe('act_now');
    expect(acaCard?.detail).toContain('executed planner path');
    expect(result.actionCards[0]?.category).toBe('runway');
    expect(result.actionCards.some((card) => card.category === 'spending')).toBe(false);
  });
});
