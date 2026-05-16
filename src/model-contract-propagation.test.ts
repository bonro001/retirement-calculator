import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { defaultAssumptions } from './default-assumptions';
import { buildMonthlyReviewRecommendation, buildMonthlyReviewValidationPacket } from './monthly-review';
import { buildNorthStarBudgetFromPath } from './north-star-budget';
import { buildPlanningStateExport } from './planning-export';
import { auditProtectedReserveContract, resolveProtectedReserveGoal } from './protected-reserve';
import { getRetirementHorizonYears } from './utils';

function monthlyReviewStrategyResult() {
  const generatedAtIso = '2026-05-16T00:00:00.000Z';
  const evaluation = {
    evaluatedByNodeId: 'contract-test',
    id: 'contract-test-policy',
    baselineFingerprint: 'contract-baseline',
    engineVersion: 'contract-engine',
    evaluatedAtIso: generatedAtIso,
    policy: {
      annualSpendTodayDollars: 140_000,
      primarySocialSecurityClaimAge: 70,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 70_000,
      withdrawalRule: 'tax_bracket_waterfall',
    },
    outcome: {
      solventSuccessRate: 0.95,
      bequestAttainmentRate: 0.9,
      p10EndingWealthTodayDollars: 900_000,
      p25EndingWealthTodayDollars: 1_100_000,
      p50EndingWealthTodayDollars: 1_600_000,
      p75EndingWealthTodayDollars: 2_200_000,
      p90EndingWealthTodayDollars: 2_800_000,
      medianLifetimeSpendTodayDollars: 4_200_000,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 240_000,
      irmaaExposureRate: 0.05,
    },
    evaluationDurationMs: 1,
  };
  const certification = {
    strategyId: 'current_faithful',
    evaluation,
    verdict: 'green',
    certifiedAtIso: generatedAtIso,
    pack: {
      verdict: 'green',
      reasons: [{ level: 'green', code: 'contract', message: 'Contract test.' }],
      metadata: {
        policyId: evaluation.id,
        baselineFingerprint: evaluation.baselineFingerprint,
        engineVersion: evaluation.engineVersion,
        spendTarget: evaluation.policy.annualSpendTodayDollars,
        selectedSpendingBasisId: null,
        selectedSpendingBasisLabel: null,
        spendingBasisFingerprint: 'current_faithful',
        baseSeed: 1,
        auditSeeds: [1],
        trialCount: 40,
        generatedAtIso,
      },
      rows: [],
      seedAudits: [],
      guardrail: {
        authorizedAnnualSpend: evaluation.policy.annualSpendTodayDollars,
        discretionaryThrottleAnnual: 0,
        yellowTrigger: 'yellow',
        redTrigger: 'red',
        yellowResponse: 'freeze',
        redResponse: 'cut',
        modeledAssetPath: [
          { year: 2027, p10Assets: 900_000, p25AssetsEstimate: 1_100_000, medianAssets: 1_600_000 },
        ],
        inferredAssumptions: [],
      },
      selectedPathEvidence: {
        basisId: 'current_faithful',
        basisLabel: 'Current Faithful',
        mode: 'forward_parametric',
        modeLabel: 'Forward-looking',
        seed: 20260416,
        outcome: evaluation.outcome,
        annualFederalTaxEstimate: 20_000,
        medianLifetimeSpendTodayDollars: 4_200_000,
        medianLifetimeFederalTaxTodayDollars: 240_000,
        yearlyRows: [
          {
            year: 2027,
            medianSpending: 154_000,
            medianFederalTax: 20_000,
            medianMagi: 135_000,
            medianAcaPremiumEstimate: 18_000,
            medianAcaSubsidyEstimate: 0,
            medianNetAcaCost: 18_000,
            medianAssets: 1_600_000,
            tenthPercentileAssets: 900_000,
          },
        ],
      },
    },
  };
  return {
    strategy: {
      id: 'current_faithful',
      label: 'Current Faithful',
      presetId: 'current_faithful',
      spendingScheduleBasis: null,
      modelCompleteness: 'faithful',
      inferredAssumptions: [],
    },
    corpusEvaluationCount: 1,
    spendBoundary: {
      highestSpendTestedTodayDollars: 140_000,
      highestGreenSpendTodayDollars: 140_000,
      higherSpendLevelsTested: [],
      boundaryProven: true,
    },
    rankedCandidates: [evaluation],
    evidenceCandidates: [evaluation],
    certifications: [certification],
    selectedCertification: certification,
    errors: [],
  };
}

describe('household model contract propagation', { timeout: 30_000 }, () => {
  it('carries the 88/91 horizon and care-first reserve into export evidence', () => {
    const assumptions = {
      ...defaultAssumptions,
      simulationRuns: 12,
      simulationSeed: 20260516,
      assumptionsVersion: 'model-contract-propagation',
    };
    const payload = buildPlanningStateExport({
      data: initialSeedData,
      assumptions,
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    expect(assumptions.robPlanningEndAge).toBe(88);
    expect(assumptions.debbiePlanningEndAge).toBe(91);
    expect(getRetirementHorizonYears(initialSeedData, assumptions)).toBe(29);
    expect(payload.assumptions.horizon).toMatchObject({
      robPlanningEndAge: 88,
      debbiePlanningEndAge: 91,
    });
    expect(payload.activeSimulationOutcome.monteCarloMetadata.planningHorizonYears).toBe(30);
    expect(payload.activeSimulationOutcome.yearlySeries.at(-1)?.year).toBe(2055);
    expect(payload.goals.protectedReserve).toMatchObject({
      targetTodayDollars: 1_000_000,
      purpose: 'care_first_legacy_if_unused',
      availableFor: 'late_life_care_or_health_shocks',
      normalLifestyleSpendable: false,
      modelCompleteness: 'faithful',
    });
    expect(payload.baseInputs.goals.protectedReserve).toEqual(
      payload.goals.protectedReserve,
    );
    expect(payload.effectiveInputs.goals.protectedReserve).toEqual(
      payload.goals.protectedReserve,
    );
  });

  it('keeps reserve and horizon aligned across north-star, monthly review, and export', () => {
    const assumptions = {
      ...defaultAssumptions,
      simulationRuns: 12,
      simulationSeed: 20260517,
      assumptionsVersion: 'cross-surface-contract',
    };
    const exportPayload = buildPlanningStateExport({
      data: initialSeedData,
      assumptions,
      selectedStressorIds: [],
      selectedResponseIds: [],
    });
    const reserve = resolveProtectedReserveGoal(initialSeedData.goals);
    const northStarBudget = buildNorthStarBudgetFromPath({
      path: exportPayload.activeSimulationOutcome,
      year: 2027,
      spendingPath: null,
      fallbackCoreAnnual:
        initialSeedData.spending.essentialMonthly * 12 +
        initialSeedData.spending.optionalMonthly * 12 +
        initialSeedData.spending.annualTaxesInsurance,
      fallbackTravelAnnual: initialSeedData.spending.travelEarlyRetirementAnnual,
      inflation: assumptions.inflation,
      legacyTarget: reserve.targetTodayDollars,
      protectedReserve: reserve,
    });
    const strategies = [monthlyReviewStrategyResult()] as never;
    const packet = buildMonthlyReviewValidationPacket({
      data: initialSeedData,
      assumptions,
      baselineFingerprint: 'cross-surface-baseline',
      engineVersion: 'cross-surface-engine',
      generatedAtIso: '2026-05-16T00:00:00.000Z',
      legacyTargetTodayDollars: reserve.targetTodayDollars,
      recommendation: buildMonthlyReviewRecommendation({
        strategies,
        tasks: [],
        aiApproval: null,
      }),
      strategies,
      tasks: [],
      currentPlanPath: exportPayload.activeSimulationOutcome,
    });

    expect(
      auditProtectedReserveContract({
        legacyTargetTodayDollars: reserve.targetTodayDollars,
        protectedReserve: reserve,
        claimedModelCompleteness: 'faithful',
        northStarLegacyTarget: northStarBudget.legacyTarget,
        surfaces: [
          {
            name: 'monthly_review',
            targetTodayDollars: packet.northStar.protectedReserve.targetTodayDollars,
            purpose: packet.northStar.protectedReserve.purpose,
          },
          {
            name: 'planning_export',
            targetTodayDollars: exportPayload.goals.protectedReserve.targetTodayDollars,
            purpose: exportPayload.goals.protectedReserve.purpose,
          },
        ],
      }),
    ).toEqual([]);
    expect(packet.rawExportEvidence.assumptions).toMatchObject({
      robPlanningEndAge: 88,
      debbiePlanningEndAge: 91,
    });
    expect(exportPayload.assumptions.horizon).toMatchObject({
      robPlanningEndAge: 88,
      debbiePlanningEndAge: 91,
    });
    expect(exportPayload.activeSimulationOutcome.yearlySeries.at(-1)?.year).toBe(2055);
    expect(packet.rawExportEvidence.yearlyPathEvidence.at(-1)?.year).toBe(2027);
  });
});
