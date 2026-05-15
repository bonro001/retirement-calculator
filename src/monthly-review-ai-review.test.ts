import { describe, expect, it } from 'vitest';
import { sanitizeMonthlyReviewAiApproval } from '../cluster/monthly-review-ai-review';
import type { MonthlyReviewValidationPacket } from './monthly-review';

const generatedAtIso = '2026-05-13T12:00:00.000Z';

function reviewPacket(
  overrides: Partial<MonthlyReviewValidationPacket> = {},
): MonthlyReviewValidationPacket {
  const packet = {
    version: 'monthly_review_validation_packet_v1',
    generatedAtIso,
    northStar: {
      legacyTargetTodayDollars: 1_000_000,
      objective: 'maximize_monthly_spend_subject_to_sleep_at_night_gates',
      approvalStandard: 'green_only',
      advisorStandard: {
        role: 'advisor_like_decision_support',
        posture:
          'explain_model_facts_unknowns_household_decisions_and_ai_suggestions_separately',
        limits: 'do_not_invent_facts_or_treat_suggestions_as_household_decisions',
      },
    },
    recommendation: {
      status: 'diagnostic',
      strategyId: 'jpmorgan_curve_travel_included',
      annualSpendTodayDollars: 115_000,
      monthlySpendTodayDollars: 115_000 / 12,
      policyId: 'policy-a',
      certificationVerdict: 'green',
      aiVerdict: null,
      blockingTaskIds: [],
      summary: 'A green deterministic candidate exists; AI co-review is pending.',
    },
    strategies: [
      {
        id: 'jpmorgan_curve_travel_included',
        label: 'J.P. Morgan travel-included',
        corpusEvaluationCount: 12_362,
        selectedPolicyId: 'policy-a',
        selectedAnnualSpendTodayDollars: 115_000,
        certificationVerdict: 'green',
        spendBoundary: {
          highestSpendTestedTodayDollars: 160_000,
          highestGreenSpendTodayDollars: 115_000,
          higherSpendLevelsTested: [116_000, 117_000, 120_000, 160_000],
          boundaryProven: true,
        },
      },
    ],
    certificationSummary: [
      {
        strategyId: 'jpmorgan_curve_travel_included',
        policyId: 'policy-a',
        verdict: 'green',
        reasons: [
          'Flow-debug mode: real certification was intentionally skipped while the monthly review UI is being tested.',
        ],
      },
    ],
    structuralTasks: [
      {
        id: 'assumption-provenance-jpmorgan_curve_travel_included',
        code: 'assumption_provenance',
        severity: 'warning',
        status: 'open',
        title: 'J.P. Morgan travel-included has inferred assumptions',
        detail:
          'The strategy uses reconstructed/defaulted assumptions that should be reviewed before relying on the recommendation narrative.',
        evidence: ['Uses a reconstructed spending curve.'],
        suggestedFix:
          'Convert inferred assumptions to explicit seed inputs or document why the default is acceptable.',
        blocksApproval: false,
        createdAtIso: generatedAtIso,
      },
    ],
    lifeModelAudit: {
      version: 'life_model_audit_v1',
      generatedAtIso,
      modelCompleteness: 'faithful',
      unresolvedEventCount: 0,
      materialUnresolvedEventCount: 0,
      events: [
        {
          id: 'cash_in_inheritance',
          kind: 'windfall',
          title: 'Cash-in event: inheritance',
          year: 2028,
          amountTodayDollars: 500_000,
          materiality: 'high',
          reviewStatus: 'pass',
          reviewerQuestion:
            'Does this cash-in have an explicit source, timing, tax treatment, spend/use rule, destination account, and future investment policy?',
          steps: [
            {
              id: 'destination',
              status: 'explicit',
              detail:
                'Unspent cash-in is swept to taxable and invested using the current portfolio mix.',
              evidence: [
                'destinationAccount=taxable',
                'investmentPolicy=current_portfolio_mix',
              ],
            },
          ],
        },
      ],
      reviewerChecklist: [
        'Trace each major inflow from source to destination account.',
      ],
    },
    rawExportEvidence: {
      source: 'monthly_review_compact_export_excerpt_v1',
      planFingerprint: 'mr-test',
      evidenceLimits: {
        topCandidateRows: 8,
        higherSpendRows: 12,
        yearlyPathRows: 12,
      },
      household: {} as MonthlyReviewValidationPacket['rawExportEvidence']['household'],
      balancesTodayDollars: {
        pretax: 380_000,
        roth: 300_000,
        taxable: 90_000,
        cash: 40_000,
        hsa: 20_000,
        liquidTotal: 830_000,
      },
      spending: {
        essentialMonthly: 5_000,
        optionalMonthly: 3_000,
        annualTaxesInsurance: 20_000,
        travelEarlyRetirementAnnual: 13_000,
        annualCoreSpend: 116_000,
        annualWithTravelSpend: 129_000,
      },
      income: {
        salaryAnnual: 150_000,
        salaryEndDate: '2027-06-30',
        socialSecurity: {} as MonthlyReviewValidationPacket['rawExportEvidence']['income']['socialSecurity'],
        windfalls: [],
        preRetirementContributions:
          {} as MonthlyReviewValidationPacket['rawExportEvidence']['income']['preRetirementContributions'],
      },
      assumptions: {} as MonthlyReviewValidationPacket['rawExportEvidence']['assumptions'],
      rules: {} as MonthlyReviewValidationPacket['rawExportEvidence']['rules'],
      selectedPolicy: {
        strategyId: 'jpmorgan_curve_travel_included',
        strategyLabel: 'J.P. Morgan travel-included',
        policyId: 'policy-a',
        annualSpendTodayDollars: 115_000,
        monthlySpendTodayDollars: 115_000 / 12,
        primarySocialSecurityClaimAge: 70,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 80_000,
        withdrawalRule: 'tax_bracket_waterfall',
        certificationVerdict: 'green',
        spendingPath: {
          valueBasis: 'today_dollars',
          scalarMeaning: 'curve_anchor',
          policySpendScalarTodayDollars: 115_000,
          firstScheduleYear: 2026,
          retirementYear: 2027,
          firstModeledYearAnnualSpendTodayDollars: 120_000,
          firstRetirementYearAnnualSpendTodayDollars: 125_000,
          peakGoGoAnnualSpendTodayDollars: 130_000,
          peakGoGoYear: 2028,
          age75AnnualSpendTodayDollars: 110_000,
          age80AnnualSpendTodayDollars: 95_000,
          age85AnnualSpendTodayDollars: 90_000,
          lifetimeAverageAnnualSpendTodayDollars: 112_000,
          scheduleLifetimeSpendTodayDollars: 3_808_000,
          medianLifetimeSpendTodayDollars: 3_400_000,
          annualSpendRows: [],
        },
        outcome: {
          solventSuccessRate: 1,
          bequestAttainmentRate: 0.875,
          p10EndingWealthTodayDollars: 923_880,
          p25EndingWealthTodayDollars: 1_386_078,
          p50EndingWealthTodayDollars: 2_401_194,
          p75EndingWealthTodayDollars: 3_813_257,
          p90EndingWealthTodayDollars: 6_243_906,
          medianLifetimeSpendTodayDollars: 3_400_000,
          medianSpendVolatility: 0,
          medianLifetimeFederalTaxTodayDollars: 3_463,
          irmaaExposureRate: 0,
        },
      },
      proofRows: {
        topCandidates: [],
        higherSpendRowsTested: [],
        certificationRows: [],
      },
      yearlyPathEvidence: [],
    },
  } satisfies MonthlyReviewValidationPacket;

  return {
    ...packet,
    ...overrides,
  };
}

describe('monthly review AI review sanitizer', () => {
  it('keeps aligned when only nonblocking warning tasks remain', () => {
    const base = reviewPacket();
    const packet = reviewPacket({
      certificationSummary: [
        {
          strategyId: 'jpmorgan_curve_travel_included',
          policyId: 'policy-a',
          verdict: 'green',
          reasons: [
            'All baseline, stress, and seed-stability gates cleared the sleep-well thresholds.',
          ],
        },
      ],
      rawExportEvidence: {
        ...base.rawExportEvidence,
        selectedPolicy: {
          ...base.rawExportEvidence.selectedPolicy!,
          outcome: {
            ...base.rawExportEvidence.selectedPolicy!.outcome,
            p10EndingWealthTodayDollars: 1_483_542,
            p25EndingWealthTodayDollars: 2_119_858,
            p50EndingWealthTodayDollars: 3_255_272,
            p75EndingWealthTodayDollars: 4_990_850,
            p90EndingWealthTodayDollars: 7_537_103,
            bequestAttainmentRate: 0.99,
            medianLifetimeFederalTaxTodayDollars: 80_138,
            irmaaExposureRate: 0.0024,
          },
        },
        yearlyPathEvidence: [
          {
            year: 2026,
            p10Assets: 950_000,
            p25AssetsEstimate: 1_000_000,
            medianAssets: 1_095_000,
          },
        ],
      },
    });

    const approval = sanitizeMonthlyReviewAiApproval(
      {
        verdict: 'aligned',
        confidence: 'high',
        summary: 'The selected candidate is aligned.',
        findings: [
          'selected_candidate_metrics',
          'north_star_legacy_alignment',
          'corpus_search_evidence',
          'spend_boundary_evidence',
          'certification_evidence',
          'assumption_provenance',
          'life_model_trace',
          'yearly_path_evidence',
          'withdrawal_tax_healthcare_evidence',
          'household_signal_checklist',
          'model_tasks',
        ].map((id) => ({
          id,
          status: 'pass',
          title: `${id} passed`,
          detail: `${id} passed from the packet evidence.`,
          evidence: [`${id}=pass`],
        })),
        actionItems: ['Document the nonblocking JPM assumption provenance.'],
        modelImprovementTodos: [
          {
            id: 'expose_payroll_transition_context',
            priority: 'high',
            category: 'model_evidence',
            title: 'Expose payroll transition context',
            detail:
              'ACA bridge review is easier to audit when the packet states whether MAGI includes final payroll.',
            evidence: ['salaryEndDate=2027-07-01'],
            suggestedNextStep:
              'Add modeled salary for each ACA bridge row in selected-path evidence.',
          },
        ],
      },
      {
        model: 'gpt-5.5',
        generatedAtIso,
        packet,
      },
    );

    expect(approval.verdict).toBe('aligned');
    expect(
      approval.findings.find((finding) => finding.id === 'assumption_provenance'),
    ).toMatchObject({ status: 'pass' });
    expect(
      approval.findings.find((finding) => finding.id === 'model_tasks'),
    ).toMatchObject({ status: 'pass' });
    expect(approval.modelImprovementTodos).toEqual([
      expect.objectContaining({
        id: 'expose_payroll_transition_context',
        priority: 'high',
        category: 'model_evidence',
      }),
    ]);
  });

  it('turns skipped certification into a substantive watch instead of insufficient data', () => {
    const approval = sanitizeMonthlyReviewAiApproval(
      {
        verdict: 'insufficient_data',
        confidence: 'high',
        summary: 'The packet is present, but certification was skipped.',
        findings: [],
        actionItems: [],
      },
      {
        model: 'gpt-5.5',
        generatedAtIso,
        packet: reviewPacket(),
      },
    );

    expect(approval.verdict).toBe('watch');
    expect(approval.findings.map((finding) => finding.id)).toEqual([
      'selected_candidate_metrics',
      'north_star_legacy_alignment',
      'corpus_search_evidence',
      'spend_boundary_evidence',
      'certification_evidence',
      'assumption_provenance',
      'life_model_trace',
      'yearly_path_evidence',
      'withdrawal_tax_healthcare_evidence',
      'household_signal_checklist',
      'model_tasks',
    ]);
    expect(
      approval.findings.find((finding) => finding.id === 'certification_evidence'),
    ).toMatchObject({
      status: 'fail',
    });
    expect(
      approval.findings.find((finding) => finding.id === 'north_star_legacy_alignment'),
    ).toMatchObject({
      status: 'watch',
    });
  });

  it('adds a failing life-model finding when cash-in destination is incomplete', () => {
    const packet = reviewPacket({
      lifeModelAudit: {
        version: 'life_model_audit_v1',
        generatedAtIso,
        modelCompleteness: 'reconstructed',
        unresolvedEventCount: 1,
        materialUnresolvedEventCount: 1,
        events: [
          {
            id: 'cash_in_home_sale',
            kind: 'home_sale',
            title: 'Home sale proceeds',
            year: 2037,
            amountTodayDollars: 500_000,
            materiality: 'high',
            reviewStatus: 'fail',
            reviewerQuestion:
              'Does this cash-in have source, timing, tax, destination, and investment treatment?',
            steps: [
              {
                id: 'destination',
                status: 'missing',
                detail: 'The model does not say where the home-sale cash goes.',
                evidence: ['destinationAccount=missing'],
              },
              {
                id: 'investment_policy',
                status: 'missing',
                detail:
                  'The model does not say whether leftover cash is invested or held.',
                evidence: ['investmentPolicy=missing'],
              },
            ],
          },
        ],
        reviewerChecklist: [
          'Trace each major inflow from source to destination account.',
        ],
      },
    });

    const approval = sanitizeMonthlyReviewAiApproval(
      {
        verdict: 'aligned',
        confidence: 'high',
        summary: 'The selected candidate is aligned.',
        findings: [],
      },
      {
        model: 'gpt-5.5',
        generatedAtIso,
        packet,
      },
    );

    expect(approval.verdict).toBe('watch');
    expect(
      approval.findings.find((finding) => finding.id === 'life_model_trace'),
    ).toMatchObject({
      status: 'fail',
    });
  });

  it('keeps truly missing selected-policy evidence as insufficient data', () => {
    const packet = reviewPacket({
      recommendation: {
        ...reviewPacket().recommendation,
        annualSpendTodayDollars: null,
        monthlySpendTodayDollars: null,
        policyId: null,
      },
      strategies: [
        {
          ...reviewPacket().strategies[0],
          corpusEvaluationCount: 0,
          selectedPolicyId: null,
          selectedAnnualSpendTodayDollars: null,
        },
      ],
      certificationSummary: [],
      rawExportEvidence: {
        ...reviewPacket().rawExportEvidence,
        selectedPolicy: null,
      },
    });

    const approval = sanitizeMonthlyReviewAiApproval(
      {
        verdict: 'watch',
        confidence: 'medium',
        summary: 'No selected policy was supplied.',
        findings: [],
      },
      {
        model: 'gpt-5.5',
        generatedAtIso,
        packet,
      },
    );

    expect(approval.verdict).toBe('insufficient_data');
    expect(
      approval.findings.find((finding) => finding.id === 'selected_candidate_metrics'),
    ).toMatchObject({
      status: 'fail',
    });
  });

  it('preserves household-signal clarity for AI triage', () => {
    const approval = sanitizeMonthlyReviewAiApproval(
      {
        verdict: 'watch',
        confidence: 'high',
        summary: 'The ACA gate needs a tradeoff decision.',
        findings: [],
      },
      {
        model: 'gpt-5.5',
        generatedAtIso,
        packet: reviewPacket({
          householdSignals: [
            {
              id: 'aca_bridge_breach',
              status: 'act_now',
              title: 'ACA bridge breach',
              headline: '2027: MAGI $52,096 over ACA-friendly ceiling',
              detail:
                'Modeled MAGI breaches the ACA-friendly ceiling in the bridge year.',
              evidence: ['year=2027', 'medianMagi=135246'],
              recommendation:
                'Decide whether to accept the subsidy loss or rerun a MAGI-constrained variant.',
              knownDecision: {
                disposition: 'intentional_tradeoff',
                title: 'Known 2027 ACA transition tradeoff',
                rationale: 'The 2027 breach is expected from final payroll income.',
                decision:
                  'Accept the subsidy loss unless a MAGI-constrained rerun is requested.',
                evidence: ['final paycheck transition year'],
                source: 'user_confirmed_monthly_review_context',
              },
              clarity: {
                disposition: 'known_intentional_tradeoff',
                whyItMatters: 'Subsidy loss can raise bridge-year healthcare cost.',
                whyItMayBeOk:
                  'It may buy higher certified spending or intentional Roth conversion.',
                modelBugCheck:
                  'Check MAGI components, ACA thresholds, and net ACA cost evidence.',
                decisionPrompt:
                  'Accept the subsidy loss as intentional or price the alternative.',
              },
            },
          ],
        }),
      },
    );

    const finding = approval.findings.find(
      (item) => item.id === 'household_signal_checklist',
    );
    expect(finding).toMatchObject({ status: 'watch' });
    expect(finding?.detail).toContain('known_intentional_tradeoff');
    expect(finding?.evidence.join(' ')).toContain('knownDecision=intentional_tradeoff');
    expect(finding?.evidence.join(' ')).toContain('bugCheck=');
    expect(finding?.recommendation).toContain('tradeoff');
  });
});
