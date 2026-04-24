import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { evaluatePlan, type Plan } from './plan-evaluation';
import {
  buildPlanningStateExport,
  buildPlanningStateExportWithResolvedContext,
} from './planning-export';
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
  simulationRuns: 500,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260416,
  assumptionsVersion: 'test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

describe('buildPlanningStateExport', () => {
  it('includes a flight-path recommendation ledger with actionable amounts', () => {
    const payload = buildPlanningStateExport({
      data: cloneSeedData(initialSeedData),
      assumptions: { ...TEST_ASSUMPTIONS },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    expect(payload.version.schema).toBe('retirement-planner-export.v2');
    expect(payload.version.generatedAt).toEqual(expect.any(String));
    expect(payload.flightPath.phasePlaybook.phases.length).toBeGreaterThan(0);
    expect(payload.flightPath.recommendationLedger.phaseActions.length).toBeGreaterThan(0);
    expect(payload.flightPath.executiveSummary.actionCards.length).toBeGreaterThan(0);
    expect(payload.probeChecklist.items.length).toBeGreaterThan(0);
    expect(payload.modelFidelity.inputs.length).toBeGreaterThan(0);
    expect(payload.modelFidelity.score).toBeGreaterThan(0);
    expect(payload.modelFidelity.softAssumptions).toContain('inferred_rmd_start_timing');
    expect(payload.modelTrust).toEqual(
      expect.objectContaining({
        modelTrustLevel: expect.any(String),
        modelFidelityScore: expect.any(Number),
        faithfulUpgradeChecklist: expect.any(Array),
      }),
    );
    expect(payload.modelTrust.inputFidelityBreakdown.length).toBeGreaterThan(0);
    expect(payload.runwayRiskModel).toEqual(
      expect.objectContaining({
        responseId: 'increase_cash_buffer',
        runwayRiskReductionScore: expect.any(Number),
        provenBenefit: expect.any(Boolean),
      }),
    );
    expect(payload.planScorecard).toEqual(
      expect.objectContaining({
        canonical: expect.objectContaining({
          successRate: payload.simulationOutcomes.plannerEnhancedSimulation.successRate,
          modelCompleteness: payload.modelFidelity.modelCompleteness,
        }),
        consistency: expect.objectContaining({
          executiveSummarySuccessRateAligned: true,
          modelCompletenessAligned: true,
          dependenceRatesAligned: true,
        }),
      }),
    );
    expect(payload.simulationOutcomes.rawSimulation.simulationMode).toBe('raw_simulation');
    expect(payload.simulationOutcomes.plannerEnhancedSimulation.simulationMode).toBe(
      'planner_enhanced',
    );
    expect(payload.activeSimulationProfile).toBe('plannerEnhancedSimulation');
    expect(payload.activeSimulationOutcome).toBe(
      payload.simulationOutcomes[payload.activeSimulationProfile],
    );
    const firstExecutedActiveConversion =
      payload.activeSimulationOutcome.simulationDiagnostics.rothConversionTracePath.find(
        (entry) => entry.conversionExecuted,
      ) ?? null;
    expect(payload.activeSimulationSummary).toEqual({
      activeSimulationProfile: payload.activeSimulationProfile,
      firstConversionYear: firstExecutedActiveConversion?.year ?? null,
      firstConversionAmount: firstExecutedActiveConversion?.amount ?? null,
      firstConversionMode:
        firstExecutedActiveConversion?.simulationModeUsedForConversion ?? null,
      plannerConversionsExecuted:
        payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
          .rothConversionDecisionSummary.executedYearCount > 0,
    });
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .closedLoopConvergenceSummary,
    ).toEqual(
      expect.objectContaining({
        converged: expect.any(Boolean),
        passesUsed: expect.any(Number),
        stopReason: expect.any(String),
        finalMagiDelta: expect.any(Number),
        finalFederalTaxDelta: expect.any(Number),
        finalHealthcarePremiumDelta: expect.any(Number),
      }),
    );
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .closedLoopRunSummary,
    ).toEqual(
      expect.objectContaining({
        runCount: expect.any(Number),
        convergedRunCount: expect.any(Number),
        nonConvergedRunCount: expect.any(Number),
      }),
    );
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .closedLoopRunConvergence.length,
    ).toBe(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationConfiguration.simulationSettings
        .runCount,
    );
    const validateNoChangeConvergenceSemantics = (
      path: typeof payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics.closedLoopConvergencePath,
      thresholds: typeof payload.simulationOutcomes.plannerEnhancedSimulation.simulationConfiguration.withdrawalPolicy.closedLoopConvergenceThresholds,
    ) => {
      path.forEach((point) => {
        if (point.stopReason !== 'no_change' || !point.converged) {
          return;
        }
        expect(point.finalMagiDelta).toBeLessThanOrEqual(thresholds.magiDeltaDollars);
        expect(point.finalFederalTaxDelta).toBeLessThanOrEqual(thresholds.federalTaxDeltaDollars);
        expect(point.finalHealthcarePremiumDelta).toBeLessThanOrEqual(
          thresholds.healthcarePremiumDeltaDollars,
        );
      });
    };
    validateNoChangeConvergenceSemantics(
      payload.simulationOutcomes.rawSimulation.simulationDiagnostics.closedLoopConvergencePath,
      payload.simulationOutcomes.rawSimulation.simulationConfiguration.withdrawalPolicy
        .closedLoopConvergenceThresholds,
    );
    validateNoChangeConvergenceSemantics(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .closedLoopConvergencePath,
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationConfiguration.withdrawalPolicy
        .closedLoopConvergenceThresholds,
    );
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionDecisionSummary,
    ).toEqual(
      expect.objectContaining({
        executedYearCount: expect.any(Number),
        blockedYearCount: expect.any(Number),
        reasons: expect.any(Array),
      }),
    );
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionEligibilityPath.length,
    ).toBeGreaterThan(0);
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionEligibilityPath.every((entry) =>
          entry.simulationModeUsedForConversion === 'planner_enhanced' &&
          entry.plannerLogicActiveAtConversion === true &&
          entry.conversionEngineInvoked === true &&
          Array.isArray(entry.evaluatedCandidateAmounts) &&
          typeof entry.bestCandidateAmount === 'number' &&
          typeof entry.bestScore === 'number' &&
          typeof entry.conversionExecuted === 'boolean' &&
          typeof entry.rawMAGI === 'number' &&
          (entry.irmaaThreshold === null || typeof entry.irmaaThreshold === 'number') &&
          typeof entry.computedHeadroom === 'number' &&
          typeof entry.magiBuffer === 'number' &&
          typeof entry.headroomComputed === 'boolean' &&
          typeof entry.candidateAmountsGenerated === 'boolean' &&
          typeof entry.conversionScore === 'number' &&
          typeof entry.conversionOpportunityScore === 'number' &&
          typeof entry.futureTaxReduction === 'number' &&
          typeof entry.futureTaxBurdenReduction === 'number' &&
          typeof entry.irmaaAvoidanceValue === 'number' &&
          typeof entry.rmdReductionValue === 'number' &&
          typeof entry.rothOptionalityValue === 'number' &&
          typeof entry.future_tax_reduction_value === 'number',
        ),
    ).toBe(true);
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionEligibilityPath.every((entry) => typeof entry.currentTaxCost === 'number'),
    ).toBe(true);
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionEligibilityPath.every((entry) =>
          entry.conversionSuppressedReason === null ||
          ['no_headroom', 'negative_score', 'already_optimal'].includes(
            entry.conversionSuppressedReason,
          ),
        ),
    ).toBe(true);
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionTracePath.every((entry) => typeof entry.conversionExecuted === 'boolean'),
    ).toBe(true);
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionTracePath.every((entry) =>
          entry.simulationModeUsedForConversion === 'planner_enhanced' &&
          entry.plannerLogicActiveAtConversion === true &&
          entry.conversionEngineInvoked === true &&
          Array.isArray(entry.evaluatedCandidateAmounts) &&
          typeof entry.bestCandidateAmount === 'number' &&
          typeof entry.bestScore === 'number' &&
          typeof entry.rawMAGI === 'number' &&
          (entry.irmaaThreshold === null || typeof entry.irmaaThreshold === 'number') &&
          typeof entry.computedHeadroom === 'number' &&
          typeof entry.magiBuffer === 'number' &&
          typeof entry.headroomComputed === 'boolean' &&
          typeof entry.candidateAmountsGenerated === 'boolean' &&
          typeof entry.conversionScore === 'number' &&
          typeof entry.currentTaxCost === 'number' &&
          typeof entry.futureTaxReduction === 'number' &&
          typeof entry.irmaaAvoidanceValue === 'number' &&
          typeof entry.rmdReductionValue === 'number' &&
          typeof entry.rothOptionalityValue === 'number',
        ),
    ).toBe(true);
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionTracePath.every((entry) => entry.conversionReason === entry.reason),
    ).toBe(true);
    expect(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .conversionPath.length,
    ).toBe(
      payload.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
        .rothConversionTracePath.length,
    );
    expect(payload.inheritanceDependenceHeadline).toEqual(
      expect.objectContaining({
        inheritanceDependent: expect.any(Boolean),
        inheritanceRobustnessScore: expect.any(Number),
        fragilityPenalty: expect.any(Number),
      }),
    );
    expect(
      payload.flightPath.recommendationLedger.phaseActions.some(
        (entry) => entry.action.fullGoalDollars >= 0,
      ),
    ).toBe(true);
    expect(payload.flightPath.recommendationEvidenceSummary).toEqual(
      expect.objectContaining({
        candidatesConsidered: expect.any(Number),
        acceptedAfterEvidenceGate: expect.any(Number),
        suppressedBeforeEvaluation: expect.any(Number),
        suppressedByHardConstraints: expect.any(Number),
        suppressedByEvidenceGate: expect.any(Number),
        suppressedByRanking: expect.any(Number),
      }),
    );
  });

  it('flags model completeness when unified plan evaluation context is unavailable', () => {
    const payload = buildPlanningStateExport({
      data: cloneSeedData(initialSeedData),
      assumptions: { ...TEST_ASSUMPTIONS },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    expect(payload.flightPath.evaluationContext.available).toBe(false);
    expect(payload.flightPath.evaluationContext.source).toBe('none');
    expect(payload.flightPath.evaluationContext.modelCompleteness).toBe('reconstructed');
    expect(payload.flightPath.evaluationContext.inferredAssumptions.length).toBeGreaterThan(0);
    expect(payload.flightPath.evaluationContext.playbookInferredAssumptions.length).toBeGreaterThan(0);
  });

  it('reconciles explicit core inputs with playbook-level inferred assumptions', () => {
    const data = cloneSeedData(initialSeedData);
    data.rules.rmdPolicy = {
      startAgeOverride: 73,
      source: 'explicit_override',
    };
    data.rules.assetClassMappingAssumptions = {
      TRP_2030: {
        US_EQUITY: 0.45,
        INTL_EQUITY: 0.15,
        BONDS: 0.35,
        CASH: 0.05,
      },
      CENTRAL_MANAGED: {
        US_EQUITY: 0.5,
        INTL_EQUITY: 0.15,
        BONDS: 0.25,
        CASH: 0.1,
      },
    };
    data.rules.assetClassMappingEvidence = {
      TRP_2030: 'exact_lookthrough',
      CENTRAL_MANAGED: 'exact_lookthrough',
    };
    data.rules.payrollModel = {
      takeHomeFactor: 0.69,
      salaryProrationRule: 'daily',
      salaryProrationSource: 'explicit_payroll_calendar',
    };
    data.income.windfalls = data.income.windfalls.map((windfall) =>
      windfall.name === 'inheritance'
        ? {
            ...windfall,
            taxTreatment: 'cash_non_taxable',
            certainty: 'certain',
            timingUncertaintyYears: 0,
            amountUncertaintyPercent: 0,
          }
        : windfall.name === 'home_sale'
          ? {
              ...windfall,
              taxTreatment: 'primary_home_sale',
              certainty: 'certain',
              timingUncertaintyYears: 0,
              amountUncertaintyPercent: 0,
              costBasis: 250_000,
              liquidityAmount: 460_000,
              exclusionAmount: 500_000,
              sellingCostPercent: 0.08,
            }
          : windfall,
    );

    const payload = buildPlanningStateExport({
      data,
      assumptions: { ...TEST_ASSUMPTIONS, assumptionsVersion: 'faithful-test' },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    expect(payload.modelFidelity.modelCompleteness).toBe('reconstructed');
    expect(payload.modelFidelity.softAssumptions.length).toBeGreaterThan(0);
    expect(payload.modelTrust.modelTrustLevel).toBe('planning_grade');
    expect(payload.modelTrust.modelFidelityScore).toBeGreaterThanOrEqual(85);
    expect(payload.modelTrust.faithfulUpgradeChecklist.length).toBeGreaterThan(0);
    expect(payload.constraints.rmdPolicy?.startAgeOverride).toBe(73);
    expect(payload.constraints.payrollModel?.salaryProrationRule).toBe('daily');
    expect(payload.constraints.assetClassMappingEvidence).toEqual({
      TRP_2030: 'exact_lookthrough',
      CENTRAL_MANAGED: 'exact_lookthrough',
    });
  });

  it('exports probe-era fields for tax treatment and healthcare/HSA/LTC assumptions', () => {
    const data = cloneSeedData(initialSeedData);
    data.income.windfalls = data.income.windfalls.map((windfall) =>
      windfall.name === 'home_sale'
        ? {
            ...windfall,
            taxTreatment: 'primary_home_sale',
            costBasis: 200_000,
            exclusionAmount: 500_000,
          }
        : windfall.name === 'inheritance'
          ? {
              ...windfall,
              taxTreatment: 'inherited_ira_10y',
              distributionYears: 10,
            }
          : windfall,
    );
    data.rules.healthcarePremiums = {
      ...(data.rules.healthcarePremiums ?? {
        baselineAcaPremiumAnnual: 14_400,
        baselineMedicarePremiumAnnual: 2_220,
      }),
      medicalInflationAnnual: 0.055,
    };
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
    };

    const payload = buildPlanningStateExport({
      data,
      assumptions: { ...TEST_ASSUMPTIONS },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    expect(payload.constraints.healthcarePremiums.medicalInflationAnnual).toBe(0.055);
    expect(payload.constraints.hsaStrategy?.enabled).toBe(true);
    expect(payload.constraints.ltcAssumptions?.enabled).toBe(true);
    expect(
      payload.income.windfalls.find((item) => item.name === 'home_sale')?.taxTreatment,
    ).toBe('primary_home_sale');
    expect(
      payload.income.windfalls.find((item) => item.name === 'inheritance')?.taxTreatment,
    ).toBe('inherited_ira_10y');
    expect(payload.probeChecklist.items.length).toBeGreaterThan(0);
    expect(payload.exportQualityGate.checks.length).toBeGreaterThan(0);
    expect(
      payload.exportQualityGate.checks.map((check) => check.id),
    ).toEqual(
      expect.arrayContaining([
        'recommendation_evidence_transparency',
        'model_fidelity_layer',
        'model_fidelity_blockers',
        'model_trust_section',
        'inheritance_fragility_disclosed',
        'dependence_metric_definitions',
        'runway_risk_model',
        'runway_recommendation_evidence_alignment',
        'closed_loop_convergence_diagnostics',
        'closed_loop_run_level_convergence_proof',
        'roth_conversion_decision_trace',
      ]),
    );
  });

  it('includes inheritance scenario matrix with on-time, delayed, reduced, and removed paths', () => {
    const payload = buildPlanningStateExport({
      data: cloneSeedData(initialSeedData),
      assumptions: { ...TEST_ASSUMPTIONS },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    const matrix = payload.scenarioSensitivity.inheritanceMatrix;
    const scenarioIds = matrix.scenarios.map((item) => item.id);

    expect(matrix.simulationMode).toBe('planner_enhanced');
    expect(matrix.simulationRuns).toBeGreaterThan(0);
    expect(scenarioIds).toEqual(
      expect.arrayContaining(['on_time', 'delayed_5y', 'reduced_50pct', 'removed']),
    );
    expect(payload.scenarioSensitivity.objectiveCalibration.scenarios).toHaveLength(2);
    expect(
      payload.scenarioSensitivity.objectiveCalibration.scenarios.map((item) => item.id),
    ).toEqual(expect.arrayContaining(['flat_spend', 'phased_spend']));
    expect(payload.scenarioSensitivity.dependenceMetricsMetadata.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'inheritanceDependenceRate' }),
        expect.objectContaining({ name: 'homeSaleDependenceRate' }),
      ]),
    );
  });

  it('includes trust panel when unified plan evaluation is provided', async () => {
    const data = cloneSeedData(initialSeedData);
    const assumptions = {
      ...TEST_ASSUMPTIONS,
      simulationRuns: 40,
      assumptionsVersion: 'trust-panel-export',
    };
    const plan: Plan = {
      data,
      assumptions,
      controls: {
        selectedStressorIds: [],
        selectedResponseIds: [],
      },
    };
    const unifiedPlanEvaluation = await evaluatePlan(plan);

    const payload = buildPlanningStateExport({
      data,
      assumptions,
      selectedStressorIds: [],
      selectedResponseIds: [],
      unifiedPlanEvaluation,
      unifiedPlanEvaluationCapturedAtIso: '2026-04-21T12:00:00.000Z',
    });

    expect(payload.flightPath.evaluationContext.available).toBe(true);
    expect(payload.flightPath.evaluationContext.source).toBe('unified_plan');
    expect(payload.flightPath.evaluationContext.capturedAtIso).toBe('2026-04-21T12:00:00.000Z');
    expect(payload.flightPath.trustPanel).not.toBeNull();
    expect(payload.flightPath.trustPanel?.checks.length).toBeGreaterThan(0);
    const inheritanceDefinition = payload.scenarioSensitivity.dependenceMetricsMetadata.definitions.find(
      (definition) => definition.name === 'inheritanceDependenceRate',
    );
    const homeSaleDefinition = payload.scenarioSensitivity.dependenceMetricsMetadata.definitions.find(
      (definition) => definition.name === 'homeSaleDependenceRate',
    );
    expect(inheritanceDefinition).toBeDefined();
    expect(homeSaleDefinition).toBeDefined();
    expect(payload.flightPath.trustPanel?.metrics.inheritanceDependenceRate).toBeCloseTo(
      inheritanceDefinition!.sensitivityValidation.reconciledDependenceRate,
      4,
    );
    expect(payload.flightPath.trustPanel?.metrics.homeSaleDependenceRate).toBeCloseTo(
      homeSaleDefinition!.sensitivityValidation.reconciledDependenceRate,
      4,
    );
  }, 20_000);

  it('derives unified plan context when missing and upgrades fidelity inputs for export readiness', async () => {
    const payload = await buildPlanningStateExportWithResolvedContext({
      data: cloneSeedData(initialSeedData),
      assumptions: { ...TEST_ASSUMPTIONS, simulationRuns: 40, assumptionsVersion: 'derived-context' },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    expect(payload.flightPath.evaluationContext.available).toBe(true);
    expect(payload.flightPath.evaluationContext.source).toBe('derived_plan');
    expect(payload.flightPath.evaluationContext.modelCompleteness).toBe('reconstructed');
    expect(payload.flightPath.evaluationContext.inferredAssumptions.length).toBeGreaterThan(0);
    expect(payload.flightPath.evaluationContext.playbookInferredAssumptions.length).toBeGreaterThan(0);
    expect(payload.flightPath.trustPanel).not.toBeNull();
    expect(payload.flightPath.recommendationEvidenceSummary.suppressedBeforeEvaluation).toBe(0);
    expect(payload.flightPath.recommendationEvidenceSummary.suppressedByEvidenceGate).toBeLessThanOrEqual(
      payload.flightPath.recommendationEvidenceSummary.candidatesEvaluated,
    );
    expect(payload.flightPath.recommendationAvailabilityHeadline).toEqual(
      expect.objectContaining({
        status: expect.any(String),
        suppressedBy: expect.any(String),
        primaryReason: expect.any(String),
        canActNow: expect.any(Boolean),
      }),
    );
    expect(payload.modelTrust.modelTrustLevel).toBe('planning_grade');
    expect(payload.modelFidelity.softAssumptions.length).toBeGreaterThan(0);
  }, 20_000);
});
