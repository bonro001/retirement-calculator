import { describe, expect, it } from 'vitest';
import {
  aiApprovalPasses,
  buildMonthlyReviewMiningFingerprint,
  buildMonthlyReviewRecommendation,
  buildMonthlyReviewStrategies,
  classifyMonthlyReviewModelTasks,
  buildMonthlyReviewQaSignals,
  certifyAllInParallel,
  isGatePassingEvaluation,
  rankMonthlyReviewCandidates,
  runMonthlyReview,
  runMonthlyReviewIterationLoop,
  type MonthlyReviewAiApproval,
  type MonthlyReviewCertification,
  type MonthlyReviewStrategyDefinition,
  type MonthlyReviewStrategyResult,
  type MonthlyReviewValidationPacket,
} from './monthly-review';
import {
  chooseMonthlyReviewPass2TrialCount,
  makeMonthlyReviewMiningSeed,
  mergeMonthlyReviewMiningPasses,
} from './monthly-review-cluster-miner';
import { initialSeedData } from './data';
import { defaultAssumptions } from './default-assumptions';
import type { PolicyEvaluation } from './policy-miner-types';
import type {
  PolicyCertificationMetricRow,
  PolicyCertificationPack,
  PolicyCertificationVerdict,
} from './policy-certification';

const generatedAtIso = '2026-05-13T00:00:00.000Z';

function evalRow(input: {
  id: string;
  spend: number;
  legacy?: number;
  solvency?: number;
}): PolicyEvaluation {
  return {
    evaluatedByNodeId: 'test',
    id: input.id,
    baselineFingerprint: 'baseline-a',
    engineVersion: 'engine-a',
    evaluatedAtIso: generatedAtIso,
    policy: {
      annualSpendTodayDollars: input.spend,
      primarySocialSecurityClaimAge: 70,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 70_000,
      withdrawalRule: 'tax_bracket_waterfall',
    },
    outcome: {
      solventSuccessRate: input.solvency ?? 0.98,
      bequestAttainmentRate: input.legacy ?? 0.9,
      p10EndingWealthTodayDollars: 900_000,
      p25EndingWealthTodayDollars: 1_000_000,
      p50EndingWealthTodayDollars: 1_300_000,
      p75EndingWealthTodayDollars: 1_800_000,
      p90EndingWealthTodayDollars: 2_200_000,
      medianLifetimeSpendTodayDollars: input.spend * 30,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 250_000,
      irmaaExposureRate: 0.1,
    },
    evaluationDurationMs: 1,
  };
}

function metricRow(overrides: Partial<PolicyCertificationMetricRow> = {}): PolicyCertificationMetricRow {
  return {
    id: 'row',
    basisId: 'current_faithful',
    basisLabel: 'Current Faithful',
    mode: 'forward_parametric',
    modeLabel: 'Forward-looking',
    scenarioId: 'baseline',
    scenarioName: 'Baseline',
    scenarioKind: 'baseline',
    seed: 1,
    solvencyRate: 0.97,
    legacyAttainmentRate: 0.9,
    first10YearFailureRisk: 0,
    spendingCutRate: 0.02,
    p10EndingWealthTodayDollars: 900_000,
    p50EndingWealthTodayDollars: 1_300_000,
    worstFailureYear: null,
    mostLikelyFailureYear: null,
    failureConcentrationRate: 0,
    appliedStressors: [],
    durationMs: 1,
    ...overrides,
  };
}

function pack(verdict: PolicyCertificationVerdict): PolicyCertificationPack {
  return {
    verdict,
    reasons: [
      {
        level: verdict,
        code: `${verdict}_test`,
        message: `${verdict} test reason`,
      },
    ],
    metadata: {
      policyId: 'policy-a',
      baselineFingerprint: 'baseline-a',
      engineVersion: 'engine-a',
      spendTarget: 140_000,
      selectedSpendingBasisId: null,
      selectedSpendingBasisLabel: null,
      spendingBasisFingerprint: 'current_faithful',
      baseSeed: 1,
      auditSeeds: [1, 102, 203],
      trialCount: 5_000,
      generatedAtIso,
    },
    rows: [metricRow()],
    seedAudits: [
      {
        basisId: 'current_faithful',
        basisLabel: 'Current Faithful',
        mode: 'forward_parametric',
        modeLabel: 'Forward-looking',
        seeds: [1, 102, 203],
        worstSolvencyRate: 0.95,
        worstLegacyAttainmentRate: 0.86,
      },
    ],
    guardrail: {
      authorizedAnnualSpend: 140_000,
      discretionaryThrottleAnnual: 7_000,
      yellowTrigger: 'yellow',
      redTrigger: 'red',
      yellowResponse: 'freeze',
      redResponse: 'cut',
      modeledAssetPath: [],
      inferredAssumptions: [],
    },
    selectedPathEvidence: null,
  };
}

function strategy(id: MonthlyReviewStrategyDefinition['id']): MonthlyReviewStrategyDefinition {
  return {
    id,
    label: id === 'current_faithful' ? 'Current Faithful' : 'J.P. Morgan travel-included',
    presetId: id,
    spendingScheduleBasis: null,
    modelCompleteness: 'faithful',
    inferredAssumptions: [],
  };
}

function certification(
  strategyId: MonthlyReviewStrategyDefinition['id'],
  evaluation: PolicyEvaluation,
  verdict: PolicyCertificationVerdict,
): MonthlyReviewCertification {
  return {
    strategyId,
    evaluation,
    pack: pack(verdict),
    verdict,
    certifiedAtIso: generatedAtIso,
  };
}

function strategyResult(input: {
  id: MonthlyReviewStrategyDefinition['id'];
  selected?: MonthlyReviewCertification | null;
  boundaryProven?: boolean;
  evaluations?: PolicyEvaluation[];
}): MonthlyReviewStrategyResult {
  return {
    strategy: strategy(input.id),
    corpusEvaluationCount: input.evaluations?.length ?? 1,
    spendBoundary: {
      highestSpendTestedTodayDollars: 150_000,
      highestGreenSpendTodayDollars:
        input.selected?.evaluation.policy.annualSpendTodayDollars ?? null,
      higherSpendLevelsTested: input.boundaryProven === false ? [] : [150_000],
      boundaryProven: input.boundaryProven ?? true,
    },
    rankedCandidates: input.evaluations ?? [],
    evidenceCandidates: input.evaluations ?? [],
    certifications: input.selected ? [input.selected] : [],
    selectedCertification: input.selected ?? null,
    errors: [],
  };
}

const alignedAi: MonthlyReviewAiApproval = {
  verdict: 'aligned',
  confidence: 'high',
  summary: 'Aligned.',
  findings: [],
  actionItems: [],
  model: 'gpt-5.5',
  generatedAtIso,
};

describe('monthly review gates', () => {
  it('raises pass-2 trials for a tight spend cliff and leaves broad windows alone', () => {
    expect(
      chooseMonthlyReviewPass2TrialCount(2_000, true, [
        140_000,
        141_000,
        142_000,
      ]),
    ).toBeGreaterThan(2_000);
    expect(
      chooseMonthlyReviewPass2TrialCount(
        2_000,
        true,
        Array.from({ length: 31 }, (_, i) => 100_000 + i * 1_000),
      ),
    ).toBe(2_000);
    expect(
      chooseMonthlyReviewPass2TrialCount(2_000, false, [
        140_000,
        141_000,
      ]),
    ).toBe(2_000);
  });

  it('keeps pass-1 corpus evidence when pass 2 only refines a small capped slice', () => {
    const pass1Green = evalRow({ id: 'green-pass1', spend: 140_000 });
    const pass1Refined = evalRow({ id: 'refined', spend: 150_000 });
    const pass2RefinedFailure = evalRow({
      id: 'refined',
      spend: 150_000,
      solvency: 0.5,
    });

    const merged = mergeMonthlyReviewMiningPasses(
      [pass1Green, pass1Refined],
      [pass2RefinedFailure],
    );

    expect(merged).toHaveLength(2);
    expect(merged.find((row) => row.id === 'green-pass1')).toBe(pass1Green);
    expect(merged.find((row) => row.id === 'refined')).toBe(
      pass2RefinedFailure,
    );
    expect(rankMonthlyReviewCandidates(merged).map((row) => row.id)).toEqual([
      'green-pass1',
    ]);
  });

  it('uses a stable monthly-review mining seed for the same strategy fingerprint', () => {
    const seedA = makeMonthlyReviewMiningSeed('baseline-a|strategy-current');
    const seedB = makeMonthlyReviewMiningSeed('baseline-a|strategy-current');
    const seedC = makeMonthlyReviewMiningSeed('baseline-a|strategy-jpm');

    expect(seedA).toBe(seedB);
    expect(seedA).toBeGreaterThan(0);
    expect(seedA).toBeLessThanOrEqual(2_147_483_647);
    expect(seedC).not.toBe(seedA);
  });

  it('ranks gate-passing candidates by highest spend', () => {
    const ranked = rankMonthlyReviewCandidates([
      evalRow({ id: 'low', spend: 120_000 }),
      evalRow({ id: 'high-fails', spend: 170_000, solvency: 0.6 }),
      evalRow({ id: 'high', spend: 150_000 }),
    ]);

    expect(ranked.map((row) => row.id)).toEqual(['high', 'low']);
  });

  it('keeps legacy-failing candidates out of certification ranking', () => {
    const legacyFail = evalRow({
      id: 'legacy-fails',
      spend: 150_000,
      legacy: 0.64,
      solvency: 0.99,
    });
    const green = evalRow({
      id: 'green',
      spend: 125_000,
      legacy: 0.87,
      solvency: 0.95,
    });

    expect(isGatePassingEvaluation(legacyFail)).toBe(false);
    expect(rankMonthlyReviewCandidates([legacyFail, green]).map((row) => row.id)).toEqual([
      'green',
    ]);
  });

  it('certifies all spend-level representatives', async () => {
    const candidates = [
      evalRow({ id: 'best-115', spend: 115_000, legacy: 0.9, solvency: 1 }),
      evalRow({ id: 'next-115', spend: 115_000, legacy: 0.89, solvency: 0.99 }),
      evalRow({ id: 'best-114', spend: 114_000, legacy: 0.9, solvency: 1 }),
    ];
    const calls: string[] = [];
    const certs = await certifyAllInParallel({
      strategy: strategy('current_faithful'),
      candidates,
      certifyCandidate: async (reviewStrategy, evaluation) => {
        calls.push(evaluation.id);
        return certification(
          reviewStrategy.id,
          evaluation,
          evaluation.id === 'best-114' ? 'green' : 'yellow',
        );
      },
    });

    expect(calls).toEqual(expect.arrayContaining(['best-115', 'best-114']));
    expect(calls).toHaveLength(2);
    // results sorted spend-desc regardless of completion order
    expect(certs.map((cert) => cert.evaluation.id)).toEqual([
      'best-115',
      'best-114',
    ]);
  });

  it('limits certification concurrency to keep local host work bounded', async () => {
    const candidates = [
      evalRow({ id: 'a', spend: 130_000, legacy: 0.9 }),
      evalRow({ id: 'b', spend: 125_000, legacy: 0.9 }),
      evalRow({ id: 'c', spend: 120_000, legacy: 0.9 }),
      evalRow({ id: 'd', spend: 115_000, legacy: 0.9 }),
    ];
    let active = 0;
    let maxActive = 0;
    const certs = await certifyAllInParallel({
      strategy: strategy('current_faithful'),
      candidates,
      maxConcurrency: 2,
      certifyCandidate: async (reviewStrategy, evaluation) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return certification(reviewStrategy.id, evaluation, 'green');
      },
    });

    expect(certs).toHaveLength(4);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('blocks approval when critical structural tasks are open', () => {
    const selected = certification('current_faithful', evalRow({ id: 'green', spend: 140_000 }), 'green');
    const strategies = [
      strategyResult({
        id: 'current_faithful',
        selected,
        boundaryProven: false,
      }),
    ];
    const tasks = classifyMonthlyReviewModelTasks({
      strategies,
      aiApproval: alignedAi,
      generatedAtIso,
    });
    const recommendation = buildMonthlyReviewRecommendation({
      strategies,
      tasks,
      aiApproval: alignedAi,
    });

    expect(tasks.some((task) => task.code === 'unbounded_search')).toBe(true);
    expect(recommendation.status).toBe('blocked');
    expect(recommendation.blockingTaskIds).toContain(
      'unbounded-search-current_faithful',
    );
  });

  it('keeps pre-AI recommendations diagnostic instead of blocked with no reason', () => {
    const selected = certification(
      'current_faithful',
      evalRow({ id: 'green', spend: 140_000 }),
      'green',
    );
    const strategies = [
      strategyResult({
        id: 'current_faithful',
        selected,
      }),
    ];
    const tasks = classifyMonthlyReviewModelTasks({
      strategies,
      aiApproval: null,
      generatedAtIso,
    });
    const recommendation = buildMonthlyReviewRecommendation({
      strategies,
      tasks,
      aiApproval: null,
    });

    expect(recommendation.status).toBe('diagnostic');
    expect(recommendation.blockingTaskIds).toEqual([]);
  });

  it('allows a green recommendation when deterministic and AI gates pass', () => {
    const selected = certification('current_faithful', evalRow({ id: 'green', spend: 140_000 }), 'green');
    const strategies = [
      strategyResult({
        id: 'current_faithful',
        selected,
      }),
    ];
    const tasks = classifyMonthlyReviewModelTasks({
      strategies,
      aiApproval: alignedAi,
      generatedAtIso,
    });
    const recommendation = buildMonthlyReviewRecommendation({
      strategies,
      tasks,
      aiApproval: alignedAi,
    });

    expect(recommendation.status).toBe('green');
    expect(recommendation.monthlySpendTodayDollars).toBeCloseTo(140_000 / 12);
  });

  it('treats fail-level AI findings as blockers', () => {
    expect(
      aiApprovalPasses({
        ...alignedAi,
        verdict: 'watch',
        findings: [
          {
            id: 'missing',
            status: 'fail',
            title: 'Missing boundary evidence',
            detail: 'No higher spend rows.',
            evidence: [],
          },
        ],
      }),
    ).toBe(false);
  });

  it('creates a critical cash-windfall task for idle excess cash', () => {
    const tasks = classifyMonthlyReviewModelTasks({
      strategies: [
        strategyResult({
          id: 'current_faithful',
          selected: certification(
            'current_faithful',
            evalRow({ id: 'green', spend: 140_000 }),
            'green',
          ),
        }),
      ],
      cashDiagnostic: {
        maxCashBalanceTodayDollars: 1_100_000,
        maxCashMonths: 110,
        yearsAbovePolicy: 15,
        policyMaxMonths: 24,
        source: 'inheritance',
      },
      generatedAtIso,
    });

    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'excess_cash_windfall_artifact',
          blocksApproval: true,
        }),
      ]),
    );
  });
});

describe('monthly review strategy and orchestration', () => {
  it('builds the Current Faithful strategy', () => {
    const strategies = buildMonthlyReviewStrategies();
    const fingerprints = strategies.map((s) =>
      buildMonthlyReviewMiningFingerprint({
        baselineFingerprint: 'baseline-a',
        trialCount: 1_000,
        strategy: s,
      }),
    );

    expect(strategies.map((s) => s.id)).toEqual(['current_faithful']);
    expect(new Set(fingerprints).size).toBe(1);
  });

  it('builds compact QA signals for ACA, runway, concentration, and legacy headroom', () => {
    const evaluation = evalRow({ id: 'green', spend: 145_000, legacy: 0.99 });
    evaluation.outcome.p50EndingWealthTodayDollars = 3_100_000;
    const selected = certification('current_faithful', evaluation, 'green');
    selected.pack.selectedPathEvidence = {
      basisId: 'current_faithful',
      basisLabel: 'Current Faithful',
      mode: 'forward_parametric',
      modeLabel: 'Forward-looking',
      seed: 20260416,
      outcome: evaluation.outcome,
      annualFederalTaxEstimate: 20_000,
      medianLifetimeSpendTodayDollars: 4_350_000,
      medianLifetimeFederalTaxTodayDollars: 250_000,
      yearlyRows: [
        {
          year: 2027,
          medianSpending: 145_000,
          medianFederalTax: 20_000,
          medianMagi: 135_850,
          medianAcaPremiumEstimate: 18_000,
          medianAcaSubsidyEstimate: 0,
          medianNetAcaCost: 18_000,
          medianAssets: 1_000_000,
          tenthPercentileAssets: 850_000,
        },
      ],
    };

    const signals = buildMonthlyReviewQaSignals({
      data: initialSeedData,
      assumptions: defaultAssumptions,
      legacyTargetTodayDollars: 1_000_000,
      strategies: [strategyResult({ id: 'current_faithful', selected })],
    });

    expect(signals.map((signal) => signal.id)).toEqual([
      'aca_bridge_breach',
      'cash_runway_gap',
      'holding_concentration',
      'legacy_headroom',
    ]);
    expect(signals.find((signal) => signal.id === 'aca_bridge_breach')).toMatchObject({
      status: 'act_now',
      title: 'ACA bridge breach',
      knownDecision: {
        disposition: 'intentional_tradeoff',
      },
      clarity: {
        disposition: 'known_intentional_tradeoff',
      },
    });
    expect(signals.find((signal) => signal.id === 'cash_runway_gap')).toMatchObject({
      status: 'act_now',
    });
    expect(
      signals.find((signal) => signal.id === 'holding_concentration'),
    ).toMatchObject({
      status: 'act_now',
    });
    expect(signals.find((signal) => signal.id === 'legacy_headroom')).toMatchObject({
      status: 'watch',
    });
  });

  it('runs every strategy and picks the highest green approved candidate', async () => {
    let packet: MonthlyReviewValidationPacket | null = null;
    const result = await runMonthlyReview({
      id: 'review-a',
      baselineFingerprint: 'baseline-a',
      engineVersion: 'engine-a',
      legacyTargetTodayDollars: 1_000_000,
      data: initialSeedData,
      assumptions: defaultAssumptions,
      generatedAtIso,
      ports: {
        mineStrategy: async (s) => ({
          evaluations: [
            evalRow({ id: `${s.id}-green`, spend: 140_000 }),
            evalRow({ id: `${s.id}-fails`, spend: 155_000, solvency: 0.5 }),
          ],
        }),
        certifyCandidate: async (s, evaluation) =>
          certification(s.id, evaluation, 'green'),
        aiReview: async (p) => {
          packet = p;
          return alignedAi;
        },
      },
    });

    expect(result.recommendation.status).toBe('green');
    expect(result.recommendation.strategyId).toBe('current_faithful');
    expect(result.recommendation.annualSpendTodayDollars).toBe(140_000);
    expect(packet?.rawExportEvidence.selectedPolicy).toEqual(
      expect.objectContaining({
        strategyId: 'current_faithful',
        annualSpendTodayDollars: 140_000,
        certificationVerdict: 'green',
        spendingPath: expect.objectContaining({
          scalarMeaning: 'flat_annual_spend',
          policySpendScalarTodayDollars: 140_000,
          firstRetirementYearAnnualSpendTodayDollars: expect.any(Number),
          peakGoGoAnnualSpendTodayDollars: expect.any(Number),
          age80AnnualSpendTodayDollars: expect.any(Number),
          lifetimeAverageAnnualSpendTodayDollars: expect.any(Number),
        }),
      }),
    );
    expect(packet?.northStar.advisorStandard).toEqual({
      role: 'advisor_like_decision_support',
      posture:
        'explain_model_facts_unknowns_household_decisions_and_ai_suggestions_separately',
      limits: 'do_not_invent_facts_or_treat_suggestions_as_household_decisions',
    });
    expect(packet?.rawExportEvidence.balancesTodayDollars.liquidTotal).toBeGreaterThan(0);
    expect(packet?.rawExportEvidence.proofRows.topCandidates.length).toBeGreaterThan(0);
    expect(packet?.householdSignals?.map((signal) => signal.id)).toEqual([
      'aca_bridge_breach',
      'cash_runway_gap',
      'holding_concentration',
      'legacy_headroom',
    ]);
    expect(
      packet?.householdSignals?.find((signal) => signal.id === 'cash_runway_gap'),
    ).toMatchObject({ status: 'act_now' });
    expect(
      packet?.householdSignals?.find(
        (signal) => signal.id === 'holding_concentration',
      ),
    ).toMatchObject({ status: 'act_now' });
    expect(
      packet?.rawExportEvidence.proofRows.higherSpendRowsTested,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyId: 'current_faithful-fails',
          annualSpendTodayDollars: 155_000,
          solventSuccessRate: 0.5,
        }),
      ]),
    );
  });

  it('stops the autonomous loop when a green result appears', async () => {
    let attempts = 0;
    const result = await runMonthlyReviewIterationLoop({
      id: 'loop',
      baselineFingerprint: 'baseline-a',
      engineVersion: 'engine-a',
      legacyTargetTodayDollars: 1_000_000,
      data: initialSeedData,
      assumptions: defaultAssumptions,
      generatedAtIso,
      strategyIds: ['current_faithful'],
      maxIterations: 5,
      fixTask: async () => 'fixed',
      ports: {
        mineStrategy: async (s) => {
          attempts += 1;
          const green = attempts > 1;
          return {
            evaluations: green
              ? [
                  evalRow({ id: `${s.id}-green`, spend: 140_000 }),
                  evalRow({ id: `${s.id}-fails`, spend: 150_000, solvency: 0.5 }),
                ]
              : [evalRow({ id: `${s.id}-fail`, spend: 140_000, solvency: 0.5 })],
          };
        },
        certifyCandidate: async (s, evaluation) =>
          certification(s.id, evaluation, 'green'),
        aiReview: async () => alignedAi,
      },
    });

    expect(result.stoppedBecause).toBe('green');
    expect(result.iterations.length).toBe(2);
  });

  it('stops the autonomous loop at the max iteration count', async () => {
    const result = await runMonthlyReviewIterationLoop({
      id: 'loop-max',
      baselineFingerprint: 'baseline-a',
      engineVersion: 'engine-a',
      legacyTargetTodayDollars: 1_000_000,
      data: initialSeedData,
      assumptions: defaultAssumptions,
      generatedAtIso,
      maxIterations: 2,
      fixTask: async () => 'fixed',
      ports: {
        mineStrategy: async () => ({
          evaluations: [evalRow({ id: 'fail', spend: 140_000, solvency: 0.5 })],
        }),
        certifyCandidate: async (s, evaluation) =>
          certification(s.id, evaluation, 'green'),
        aiReview: async () => alignedAi,
      },
    });

    expect(result.stoppedBecause).toBe('max_iterations');
    expect(result.iterations.length).toBe(2);
  });

  it('stops the autonomous loop at the API call limit', async () => {
    const result = await runMonthlyReviewIterationLoop({
      id: 'loop-api-limit',
      baselineFingerprint: 'baseline-a',
      engineVersion: 'engine-a',
      legacyTargetTodayDollars: 1_000_000,
      data: initialSeedData,
      assumptions: defaultAssumptions,
      generatedAtIso,
      maxIterations: 5,
      apiCallLimit: 1,
      fixTask: async () => 'fixed',
      ports: {
        mineStrategy: async () => ({
          evaluations: [evalRow({ id: 'fail', spend: 140_000, solvency: 0.5 })],
        }),
        certifyCandidate: async (s, evaluation) =>
          certification(s.id, evaluation, 'green'),
        aiReview: async () => alignedAi,
      },
    });

    expect(result.stoppedBecause).toBe('api_call_limit');
    expect(result.iterations.length).toBe(1);
  });
});
