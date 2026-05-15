import {
  buildSpendingModelSchedule,
  type SpendingModelPresetId,
} from './jpmorgan-spending-surprises';
import { calculateProratedSalary } from './contribution-engine';
import {
  buildLifeModelAudit,
  type LifeModelAudit,
} from './life-model-audit';
import type {
  PolicyEvaluation,
  PolicySpendingScheduleBasis,
} from './policy-miner-types';
import type {
  PolicyCertificationPack,
  PolicyCertificationVerdict,
} from './policy-certification';
import { clearsPolicyGates, rankPolicies } from './policy-ranker';
import { calculateRunwayGapMetrics } from './runway-utils';
import type { MarketAssumptions, SeedData } from './types';
import { calculateCurrentAges } from './utils';

export type MonthlyReviewStrategyId = 'current_faithful';

export type MonthlyReviewStatus =
  | 'green'
  | 'blocked'
  | 'diagnostic'
  | 'running'
  | 'failed';

export type MonthlyReviewTaskSeverity = 'critical' | 'warning' | 'info';
export type MonthlyReviewTaskStatus = 'open' | 'resolved' | 'waived';
export type MonthlyReviewQaSignalStatus = 'ok' | 'watch' | 'act_now';
export type MonthlyReviewIssueDisposition =
  | 'known_intentional_tradeoff'
  | 'known_accepted_risk'
  | 'accepted_tradeoff_candidate'
  | 'needs_action'
  | 'possible_model_bug'
  | 'monitor'
  | 'spending_headroom';

export type MonthlyReviewModelTaskCode =
  | 'missing_required_input'
  | 'uncertified_strategy_gap'
  | 'engine_mode_conflict'
  | 'seed_instability'
  | 'unbounded_search'
  | 'strategy_instability'
  | 'ai_insufficient_evidence'
  | 'excess_cash_windfall_artifact'
  | 'assumption_provenance';

export interface MonthlyReviewModelTask {
  id: string;
  code: MonthlyReviewModelTaskCode;
  severity: MonthlyReviewTaskSeverity;
  status: MonthlyReviewTaskStatus;
  title: string;
  detail: string;
  evidence: string[];
  suggestedFix: string;
  blocksApproval: boolean;
  createdAtIso: string;
}

export interface MonthlyReviewQaSignal {
  id:
    | 'aca_bridge_breach'
    | 'cash_runway_gap'
    | 'holding_concentration'
    | 'legacy_headroom';
  status: MonthlyReviewQaSignalStatus;
  title: string;
  headline: string;
  detail: string;
  evidence: string[];
  recommendation: string;
  knownDecision?: {
    disposition: string;
    title: string;
    rationale: string;
    decision: string;
    evidence: string[];
    reviewedAtIso?: string;
    source?: string;
  };
  clarity: {
    disposition: MonthlyReviewIssueDisposition;
    whyItMatters: string;
    whyItMayBeOk: string;
    modelBugCheck: string;
    decisionPrompt: string;
  };
}

export interface MonthlyReviewStrategyDefinition {
  id: MonthlyReviewStrategyId;
  label: string;
  presetId: SpendingModelPresetId;
  spendingScheduleBasis: PolicySpendingScheduleBasis | null;
  modelCompleteness: 'faithful' | 'reconstructed';
  inferredAssumptions: string[];
}

export interface MonthlyReviewCertification {
  strategyId: MonthlyReviewStrategyId;
  evaluation: PolicyEvaluation;
  pack: PolicyCertificationPack;
  verdict: PolicyCertificationVerdict;
  certifiedAtIso: string;
}

export interface MonthlyReviewStrategyResult {
  strategy: MonthlyReviewStrategyDefinition;
  corpusEvaluationCount: number;
  spendBoundary: {
    highestSpendTestedTodayDollars: number | null;
    highestGreenSpendTodayDollars: number | null;
    higherSpendLevelsTested: number[];
    boundaryProven: boolean;
  };
  rankedCandidates: PolicyEvaluation[];
  evidenceCandidates: PolicyEvaluation[];
  certifications: MonthlyReviewCertification[];
  selectedCertification: MonthlyReviewCertification | null;
  errors: string[];
}

export type MonthlyReviewAiVerdict =
  | 'aligned'
  | 'watch'
  | 'misaligned'
  | 'insufficient_data';

export interface MonthlyReviewAiFinding {
  id: string;
  status: 'pass' | 'watch' | 'fail';
  title: string;
  detail: string;
  evidence: string[];
  recommendation?: string;
}

export interface MonthlyReviewAiApproval {
  verdict: MonthlyReviewAiVerdict;
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  findings: MonthlyReviewAiFinding[];
  actionItems: string[];
  model: string;
  generatedAtIso: string;
  rawResponseText?: string;
  auditTrail?: {
    auditId: string;
    auditDir: string;
    files: Record<string, string>;
  };
}

export interface MonthlyReviewRecommendation {
  status: MonthlyReviewStatus;
  strategyId: MonthlyReviewStrategyId | null;
  annualSpendTodayDollars: number | null;
  monthlySpendTodayDollars: number | null;
  policyId: string | null;
  certificationVerdict: PolicyCertificationVerdict | null;
  aiVerdict: MonthlyReviewAiVerdict | null;
  blockingTaskIds: string[];
  summary: string;
}

export interface MonthlyReviewSpendingPathRow {
  year: number;
  householdAge: number | null;
  multiplier: number;
  annualSpendTodayDollars: number;
}

export interface MonthlyReviewSpendingPathMetrics {
  valueBasis: 'today_dollars';
  scalarMeaning: 'flat_annual_spend' | 'curve_anchor' | 'spending_path_anchor';
  policySpendScalarTodayDollars: number;
  firstScheduleYear: number | null;
  retirementYear: number | null;
  firstModeledYearAnnualSpendTodayDollars: number | null;
  firstRetirementYearAnnualSpendTodayDollars: number | null;
  peakGoGoAnnualSpendTodayDollars: number | null;
  peakGoGoYear: number | null;
  age75AnnualSpendTodayDollars: number | null;
  age80AnnualSpendTodayDollars: number | null;
  age85AnnualSpendTodayDollars: number | null;
  lifetimeAverageAnnualSpendTodayDollars: number | null;
  scheduleLifetimeSpendTodayDollars: number | null;
  medianLifetimeSpendTodayDollars: number | null;
  annualSpendRows: MonthlyReviewSpendingPathRow[];
}

export interface MonthlyReviewRawExportEvidence {
  source: 'monthly_review_compact_export_excerpt_v1';
  planFingerprint: string;
  evidenceLimits: {
    topCandidateRows: number;
    higherSpendRows: number;
    yearlyPathRows: number;
  };
  household: SeedData['household'];
  balancesTodayDollars: {
    pretax: number;
    roth: number;
    taxable: number;
    cash: number;
    hsa: number;
    liquidTotal: number;
  };
  spending: {
    essentialMonthly: number;
    optionalMonthly: number;
    annualTaxesInsurance: number;
    travelEarlyRetirementAnnual: number;
    annualCoreSpend: number;
    annualWithTravelSpend: number;
  };
  income: {
    salaryAnnual: number;
    salaryEndDate: string;
    socialSecurity: SeedData['income']['socialSecurity'];
    windfalls: SeedData['income']['windfalls'];
    preRetirementContributions: SeedData['income']['preRetirementContributions'];
  };
  assumptions: Pick<
    MarketAssumptions,
    | 'equityMean'
    | 'equityVolatility'
    | 'internationalEquityMean'
    | 'internationalEquityVolatility'
    | 'bondMean'
    | 'bondVolatility'
    | 'cashMean'
    | 'cashVolatility'
    | 'inflation'
    | 'inflationVolatility'
    | 'simulationRuns'
    | 'simulationSeed'
    | 'assumptionsVersion'
    | 'useHistoricalBootstrap'
    | 'historicalBootstrapBlockLength'
    | 'samplingStrategy'
    | 'equityTailMode'
    | 'guardrailFloorYears'
    | 'guardrailCeilingYears'
    | 'guardrailCutPercent'
    | 'robPlanningEndAge'
    | 'debbiePlanningEndAge'
    | 'travelPhaseYears'
    | 'irmaaThreshold'
  >;
  rules: Pick<
    SeedData['rules'],
    | 'withdrawalStyle'
    | 'irmaaAware'
    | 'replaceModeImports'
    | 'monthlyReviewIssueAnnotations'
    | 'rothConversionPolicy'
    | 'rmdPolicy'
    | 'payrollModel'
    | 'contributionLimits'
    | 'housingAfterDownsizePolicy'
    | 'windfallDeploymentPolicy'
    | 'healthcarePremiums'
    | 'hsaStrategy'
    | 'ltcAssumptions'
  >;
  selectedPolicy: {
    strategyId: MonthlyReviewStrategyId;
    strategyLabel: string;
    policyId: string;
    annualSpendTodayDollars: number;
    monthlySpendTodayDollars: number;
    primarySocialSecurityClaimAge: number;
    spouseSocialSecurityClaimAge: number | null;
    rothConversionAnnualCeiling: number;
    withdrawalRule: string | null;
    spendingPath: MonthlyReviewSpendingPathMetrics;
    outcome: PolicyEvaluation['outcome'];
    certificationVerdict: PolicyCertificationVerdict;
  } | null;
  proofRows: {
    topCandidates: Array<{
      strategyId: MonthlyReviewStrategyId;
      policyId: string;
      annualSpendTodayDollars: number;
      solventSuccessRate: number;
      bequestAttainmentRate: number;
      p10EndingWealthTodayDollars: number;
      p25EndingWealthTodayDollars: number;
      p50EndingWealthTodayDollars: number;
      p75EndingWealthTodayDollars: number;
      p90EndingWealthTodayDollars: number;
      irmaaExposureRate: number;
      medianLifetimeFederalTaxTodayDollars: number;
      withdrawalRule: string | null;
      rothConversionAnnualCeiling: number;
    }>;
    higherSpendRowsTested: Array<{
      strategyId: MonthlyReviewStrategyId;
      policyId: string;
      annualSpendTodayDollars: number;
      solventSuccessRate: number;
      bequestAttainmentRate: number;
      p10EndingWealthTodayDollars: number;
      p25EndingWealthTodayDollars: number;
      p50EndingWealthTodayDollars: number;
      p75EndingWealthTodayDollars: number;
      p90EndingWealthTodayDollars: number;
      irmaaExposureRate: number;
      medianLifetimeFederalTaxTodayDollars: number;
      withdrawalRule: string | null;
      rothConversionAnnualCeiling: number;
    }>;
    certificationRows: MonthlyReviewValidationPacket['certificationSummary'];
  };
  yearlyPathEvidence: Array<{
    year: number;
    p10Assets: number;
    p25AssetsEstimate: number;
    medianAssets: number;
  }>;
}

export interface MonthlyReviewRun {
  id: string;
  generatedAtIso: string;
  baselineFingerprint: string;
  engineVersion: string;
  legacyTargetTodayDollars: number;
  strategies: MonthlyReviewStrategyResult[];
  aiApproval: MonthlyReviewAiApproval | null;
  modelTasks: MonthlyReviewModelTask[];
  recommendation: MonthlyReviewRecommendation;
  apiCallCount: number;
}

export interface MonthlyReviewCashDiagnostic {
  maxCashBalanceTodayDollars: number;
  maxCashMonths: number;
  yearsAbovePolicy: number;
  policyMaxMonths: number;
  source: string;
}

export interface MonthlyReviewStructuralTaskInput {
  strategies: MonthlyReviewStrategyResult[];
  aiApproval?: MonthlyReviewAiApproval | null;
  cashDiagnostic?: MonthlyReviewCashDiagnostic | null;
  generatedAtIso?: string;
}

export interface MonthlyReviewValidationPacket {
  version: 'monthly_review_validation_packet_v1';
  generatedAtIso: string;
  northStar: {
    legacyTargetTodayDollars: number;
    objective: 'maximize_monthly_spend_subject_to_sleep_at_night_gates';
    approvalStandard: 'green_only';
    advisorStandard: {
      role: 'advisor_like_decision_support';
      posture:
        'explain_model_facts_unknowns_household_decisions_and_ai_suggestions_separately';
      limits: 'do_not_invent_facts_or_treat_suggestions_as_household_decisions';
    };
  };
  recommendation: MonthlyReviewRecommendation;
  strategies: Array<{
    id: MonthlyReviewStrategyId;
    label: string;
    corpusEvaluationCount: number;
    selectedPolicyId: string | null;
    selectedAnnualSpendTodayDollars: number | null;
    certificationVerdict: PolicyCertificationVerdict | null;
    spendBoundary: MonthlyReviewStrategyResult['spendBoundary'];
  }>;
  certificationSummary: Array<{
    strategyId: MonthlyReviewStrategyId;
    policyId: string;
    verdict: PolicyCertificationVerdict;
    reasons: string[];
  }>;
  structuralTasks: MonthlyReviewModelTask[];
  householdSignals?: MonthlyReviewQaSignal[];
  lifeModelAudit: LifeModelAudit;
  rawExportEvidence: MonthlyReviewRawExportEvidence;
}

export interface MonthlyReviewRunnerPorts {
  mineStrategy: (
    strategy: MonthlyReviewStrategyDefinition,
  ) => Promise<{
    evaluations: PolicyEvaluation[];
    spendBoundary?: Partial<MonthlyReviewStrategyResult['spendBoundary']>;
  }>;
  certifyCandidate: (
    strategy: MonthlyReviewStrategyDefinition,
    evaluation: PolicyEvaluation,
  ) => Promise<MonthlyReviewCertification>;
  aiReview: (
    packet: MonthlyReviewValidationPacket,
  ) => Promise<MonthlyReviewAiApproval>;
}

export interface RunMonthlyReviewInput {
  id: string;
  baselineFingerprint: string;
  engineVersion: string;
  legacyTargetTodayDollars: number;
  data: SeedData;
  assumptions: MarketAssumptions;
  ports: MonthlyReviewRunnerPorts;
  strategyIds?: MonthlyReviewStrategyId[];
  generatedAtIso?: string;
  cashDiagnostic?: MonthlyReviewCashDiagnostic | null;
  certificationMaxConcurrency?: number;
}

export interface RunMonthlyReviewIterationInput
  extends RunMonthlyReviewInput {
  maxIterations: number;
  apiCallLimit?: number;
  fixTask?: (task: MonthlyReviewModelTask) => Promise<'fixed' | 'blocked'>;
}

export interface MonthlyReviewIterationResult {
  finalRun: MonthlyReviewRun;
  iterations: MonthlyReviewRun[];
  stoppedBecause: 'green' | 'max_iterations' | 'task_blocked' | 'api_call_limit';
}

export const MONTHLY_REVIEW_AI_DEFAULT_MODEL = 'gpt-5.5';
export const MONTHLY_REVIEW_AI_DEFAULT_REASONING_EFFORT = 'high';

function makeTask(input: Omit<MonthlyReviewModelTask, 'createdAtIso' | 'status'> & {
  createdAtIso: string;
}): MonthlyReviewModelTask {
  return {
    ...input,
    status: 'open',
  };
}

function spendingBasisFingerprint(basis: PolicySpendingScheduleBasis | null): string {
  if (!basis) return 'current_faithful';
  return JSON.stringify({
    id: basis.id,
    multipliersByYear: basis.multipliersByYear,
  });
}

export function buildMonthlyReviewMiningFingerprint(input: {
  baselineFingerprint: string;
  trialCount: number;
  strategy: MonthlyReviewStrategyDefinition;
}): string {
  return `${input.baselineFingerprint}|trials=${input.trialCount}|basis=${spendingBasisFingerprint(
    input.strategy.spendingScheduleBasis,
  )}|fpv2`;
}

const CURRENT_FAITHFUL_SPENDING_BASIS_ID = 'current_faithful_spending_path';

function scheduleToBasis(
  id: string,
  label: string,
  schedule: ReturnType<typeof buildSpendingModelSchedule>,
): PolicySpendingScheduleBasis | null {
  const firstYear = schedule.yearlySchedule[0];
  if (!firstYear || firstYear.finalAnnualSpend <= 0) return null;
  return {
    id,
    label,
    multipliersByYear: Object.fromEntries(
      schedule.yearlySchedule.map((year) => [
        year.year,
        year.finalAnnualSpend / firstYear.finalAnnualSpend,
      ]),
    ),
  };
}

function scalarMeaningForBasis(
  basis: PolicySpendingScheduleBasis | null,
): MonthlyReviewSpendingPathMetrics['scalarMeaning'] {
  if (!basis) return 'flat_annual_spend';
  return basis.id.startsWith('jpmorgan') || basis.id === 'magic_average'
    ? 'curve_anchor'
    : 'spending_path_anchor';
}

export function buildMonthlyReviewStrategies(input?: {
  data: SeedData;
  assumptions: MarketAssumptions;
}): MonthlyReviewStrategyDefinition[] {
  const currentFaithfulSchedule = input
    ? buildSpendingModelSchedule(input.data, input.assumptions, {
        presetId: 'current_faithful',
      })
    : null;
  const currentFaithfulBasis =
    currentFaithfulSchedule?.status === 'complete'
      ? scheduleToBasis(
          CURRENT_FAITHFUL_SPENDING_BASIS_ID,
          'Current Faithful spending path',
          currentFaithfulSchedule,
        )
      : null;
  return [
    {
      id: 'current_faithful',
      label: 'Current Faithful',
      presetId: 'current_faithful',
      spendingScheduleBasis: currentFaithfulBasis,
      modelCompleteness: currentFaithfulSchedule?.modelCompleteness ?? 'faithful',
      inferredAssumptions: currentFaithfulSchedule?.inferredAssumptions ?? [],
    },
  ];
}

export function isGatePassingEvaluation(e: PolicyEvaluation): boolean {
  return clearsPolicyGates(e);
}

export function rankMonthlyReviewCandidates(
  evaluations: PolicyEvaluation[],
): PolicyEvaluation[] {
  return rankPolicies([...evaluations]);
}

export function selectCertificationCandidatesBySpend(
  rankedCandidates: PolicyEvaluation[],
): PolicyEvaluation[] {
  const seenSpendLevels = new Set<number>();
  const representatives: PolicyEvaluation[] = [];
  for (const candidate of rankedCandidates) {
    const spend = candidate.policy.annualSpendTodayDollars;
    if (seenSpendLevels.has(spend)) continue;
    seenSpendLevels.add(spend);
    representatives.push(candidate);
  }
  return representatives;
}

export async function certifyAllInParallel(input: {
  strategy: MonthlyReviewStrategyDefinition;
  candidates: PolicyEvaluation[];
  certifyCandidate: MonthlyReviewRunnerPorts['certifyCandidate'];
  maxConcurrency?: number;
}): Promise<MonthlyReviewCertification[]> {
  const uniqueCandidates = selectCertificationCandidatesBySpend(input.candidates);
  const maxConcurrency = Math.max(1, Math.floor(input.maxConcurrency ?? 1));
  const settled: Array<PromiseSettledResult<MonthlyReviewCertification>> = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < uniqueCandidates.length) {
      const candidate = uniqueCandidates[nextIndex];
      nextIndex += 1;
      if (!candidate) continue;
      try {
        const value = await input.certifyCandidate(input.strategy, candidate);
        settled.push({ status: 'fulfilled', value });
      } catch (reason) {
        settled.push({ status: 'rejected', reason });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrency, uniqueCandidates.length) },
      () => worker(),
    ),
  );

  return settled
    .filter(
      (r): r is PromiseFulfilledResult<MonthlyReviewCertification> =>
        r.status === 'fulfilled',
    )
    .map((r) => r.value)
    .sort(
      (a, b) =>
        b.evaluation.policy.annualSpendTodayDollars -
        a.evaluation.policy.annualSpendTodayDollars,
    );
}

function buildStrategyResult(input: {
  strategy: MonthlyReviewStrategyDefinition;
  evaluations: PolicyEvaluation[];
  certifications: MonthlyReviewCertification[];
  overrideBoundary?: Partial<MonthlyReviewStrategyResult['spendBoundary']>;
  errors?: string[];
}): MonthlyReviewStrategyResult {
  const rankedCandidates = rankMonthlyReviewCandidates(input.evaluations);
  const evidenceCandidates = [...input.evaluations].sort((a, b) => {
    const spendDiff =
      b.policy.annualSpendTodayDollars - a.policy.annualSpendTodayDollars;
    if (spendDiff !== 0) return spendDiff;
    const solvencyDiff =
      b.outcome.solventSuccessRate - a.outcome.solventSuccessRate;
    if (solvencyDiff !== 0) return solvencyDiff;
    return (
      b.outcome.bequestAttainmentRate - a.outcome.bequestAttainmentRate ||
      a.id.localeCompare(b.id)
    );
  });
  const selectedCertification =
    input.certifications.find((cert) => cert.verdict === 'green') ?? null;
  const selectedSpend =
    selectedCertification?.evaluation.policy.annualSpendTodayDollars ?? null;
  const spendLevels = Array.from(
    new Set(input.evaluations.map((e) => e.policy.annualSpendTodayDollars)),
  ).sort((a, b) => a - b);
  const higherSpendLevels =
    selectedSpend === null ? [] : spendLevels.filter((s) => s > selectedSpend);
  const defaultBoundary = {
    highestSpendTestedTodayDollars: spendLevels.at(-1) ?? null,
    highestGreenSpendTodayDollars: selectedSpend,
    higherSpendLevelsTested: higherSpendLevels,
    boundaryProven: selectedSpend !== null && higherSpendLevels.length > 0,
  };
  return {
    strategy: input.strategy,
    corpusEvaluationCount: input.evaluations.length,
    spendBoundary: {
      ...defaultBoundary,
      ...input.overrideBoundary,
    },
    rankedCandidates,
    evidenceCandidates,
    certifications: input.certifications,
    selectedCertification,
    errors: input.errors ?? [],
  };
}

export function aiApprovalPasses(ai: MonthlyReviewAiApproval | null): boolean {
  if (!ai) return false;
  if (ai.verdict !== 'aligned' && ai.verdict !== 'watch') return false;
  return !ai.findings.some((finding) => finding.status === 'fail');
}

export function classifyMonthlyReviewModelTasks(
  input: MonthlyReviewStructuralTaskInput,
): MonthlyReviewModelTask[] {
  const createdAtIso = input.generatedAtIso ?? new Date().toISOString();
  const tasks: MonthlyReviewModelTask[] = [];
  const greenStrategies = input.strategies.filter((s) => s.selectedCertification);

  if (greenStrategies.length === 0) {
    tasks.push(
      makeTask({
        id: 'uncertified-strategy-gap',
        code: 'uncertified_strategy_gap',
        severity: 'critical',
        title: 'No green certified strategy',
        detail:
          'The monthly review could not find a strategy with a green deterministic certification.',
        evidence: [`strategies=${input.strategies.length}`],
        suggestedFix:
          'Inspect failed certification rows, then adjust model policy artifacts or mine lower spend candidates without changing approval thresholds.',
        blocksApproval: true,
        createdAtIso,
      }),
    );
  }

  for (const strategy of input.strategies) {
    if (
      strategy.selectedCertification &&
      !strategy.spendBoundary.boundaryProven
    ) {
      tasks.push(
        makeTask({
          id: `unbounded-search-${strategy.strategy.id}`,
          code: 'unbounded_search',
          severity: 'critical',
          title: `${strategy.strategy.label} spend boundary is unproven`,
          detail:
            'The selected candidate is not bounded by tested higher spend levels that failed the approval gates.',
          evidence: [
            `highestGreenSpend=${strategy.spendBoundary.highestGreenSpendTodayDollars ?? 'none'}`,
            `highestTestedSpend=${strategy.spendBoundary.highestSpendTestedTodayDollars ?? 'none'}`,
          ],
          suggestedFix:
            'Widen the spend axis upward or run a refined mine until higher spend levels fail certification gates.',
          blocksApproval: true,
          createdAtIso,
        }),
      );
    }

    if (strategy.strategy.inferredAssumptions.length > 0) {
      tasks.push(
        makeTask({
          id: `assumption-provenance-${strategy.strategy.id}`,
          code: 'assumption_provenance',
          severity: 'warning',
          title: `${strategy.strategy.label} has inferred assumptions`,
          detail:
            'The strategy uses reconstructed/defaulted assumptions that should be reviewed before relying on the recommendation narrative.',
          evidence: strategy.strategy.inferredAssumptions.slice(0, 5),
          suggestedFix:
            'Convert inferred assumptions to explicit seed inputs or document why the default is acceptable.',
          blocksApproval: false,
          createdAtIso,
        }),
      );
    }
  }

  if (greenStrategies.length > 1) {
    const spends = greenStrategies
      .map((s) => s.selectedCertification?.evaluation.policy.annualSpendTodayDollars)
      .filter((v): v is number => typeof v === 'number');
    const minSpend = Math.min(...spends);
    const maxSpend = Math.max(...spends);
    if (maxSpend - minSpend >= 20_000) {
      tasks.push(
        makeTask({
          id: 'strategy-instability',
          code: 'strategy_instability',
          severity: 'critical',
          title: 'Strategy bases imply materially different monthly maxes',
          detail:
            'Multiple certified strategy bases diverge enough that the review needs an explicit winner rationale.',
          evidence: [`minGreenSpend=${minSpend}`, `maxGreenSpend=${maxSpend}`],
          suggestedFix:
            'Require the final recommendation to include strategy-basis rationale and confirm both bases have passed certification.',
          blocksApproval: true,
          createdAtIso,
        }),
      );
    }
  }

  if (input.aiApproval) {
    if (
      input.aiApproval.verdict === 'insufficient_data' ||
      input.aiApproval.verdict === 'misaligned' ||
      input.aiApproval.findings.some((finding) => finding.status === 'fail')
    ) {
      tasks.push(
        makeTask({
          id: 'ai-insufficient-evidence',
          code: 'ai_insufficient_evidence',
          severity: 'critical',
          title: 'AI co-review did not find enough evidence',
          detail:
            'The co-equal AI reviewer found missing evidence or fail-level findings in the monthly review packet.',
          evidence: [
            `aiVerdict=${input.aiApproval.verdict}`,
            ...input.aiApproval.findings
              .filter((finding) => finding.status === 'fail')
              .map((finding) => finding.title),
          ],
          suggestedFix:
            'Add the missing structured evidence or fix the flagged model failure, then rerun review.',
          blocksApproval: true,
          createdAtIso,
        }),
      );
    }
  }

  const cash = input.cashDiagnostic;
  if (
    cash &&
    cash.maxCashMonths > cash.policyMaxMonths &&
    cash.yearsAbovePolicy >= 3
  ) {
    tasks.push(
      makeTask({
        id: 'excess-cash-windfall-artifact',
        code: 'excess_cash_windfall_artifact',
        severity: 'critical',
        title: 'Windfall cash remains above policy for years',
        detail:
          'The plan appears to leave excess cash idle after a windfall instead of applying an explicit reserve, spend, or deployment rule.',
        evidence: [
          `source=${cash.source}`,
          `maxCashBalance=${Math.round(cash.maxCashBalanceTodayDollars)}`,
          `maxCashMonths=${Math.round(cash.maxCashMonths)}`,
          `policyMaxMonths=${cash.policyMaxMonths}`,
          `yearsAbovePolicy=${cash.yearsAbovePolicy}`,
        ],
        suggestedFix:
          'Model a windfall deployment policy: keep explicit cash reserve and invest or allocate excess according to the selected strategy.',
        blocksApproval: true,
        createdAtIso,
      }),
    );
  }

  return tasks;
}

export function buildMonthlyReviewRecommendation(input: {
  strategies: MonthlyReviewStrategyResult[];
  tasks: MonthlyReviewModelTask[];
  aiApproval: MonthlyReviewAiApproval | null;
}): MonthlyReviewRecommendation {
  const blockingTasks = input.tasks.filter(
    (task) => task.blocksApproval && task.status === 'open',
  );
  const aiPasses = aiApprovalPasses(input.aiApproval);
  const eligible = input.strategies
    .map((strategy) => strategy.selectedCertification)
    .filter((cert): cert is MonthlyReviewCertification => !!cert)
    .sort((a, b) => {
      const spendDiff =
        b.evaluation.policy.annualSpendTodayDollars -
        a.evaluation.policy.annualSpendTodayDollars;
      if (spendDiff !== 0) return spendDiff;
      const aRows = a.pack.rows;
      const bRows = b.pack.rows;
      const minAFirst10 = Math.max(...aRows.map((r) => r.first10YearFailureRisk));
      const minBFirst10 = Math.max(...bRows.map((r) => r.first10YearFailureRisk));
      if (minAFirst10 !== minBFirst10) return minAFirst10 - minBFirst10;
      return a.evaluation.id.localeCompare(b.evaluation.id);
    });
  const best = eligible[0] ?? null;

  if (!best) {
    return {
      status: 'blocked',
      strategyId: null,
      annualSpendTodayDollars: null,
      monthlySpendTodayDollars: null,
      policyId: null,
      certificationVerdict: null,
      aiVerdict: input.aiApproval?.verdict ?? null,
      blockingTaskIds: blockingTasks.map((task) => task.id),
      summary: 'No green certified monthly spend candidate is available.',
    };
  }

  if (blockingTasks.length > 0) {
    return {
      status: 'blocked',
      strategyId: best.strategyId,
      annualSpendTodayDollars: best.evaluation.policy.annualSpendTodayDollars,
      monthlySpendTodayDollars:
        best.evaluation.policy.annualSpendTodayDollars / 12,
      policyId: best.evaluation.id,
      certificationVerdict: best.verdict,
      aiVerdict: input.aiApproval?.verdict ?? null,
      blockingTaskIds: blockingTasks.map((task) => task.id),
      summary:
        'A green deterministic candidate exists, but monthly approval is blocked by model-quality tasks or AI co-review.',
    };
  }

  if (!input.aiApproval) {
    return {
      status: 'diagnostic',
      strategyId: best.strategyId,
      annualSpendTodayDollars: best.evaluation.policy.annualSpendTodayDollars,
      monthlySpendTodayDollars:
        best.evaluation.policy.annualSpendTodayDollars / 12,
      policyId: best.evaluation.id,
      certificationVerdict: best.verdict,
      aiVerdict: null,
      blockingTaskIds: [],
      summary:
        'A green deterministic candidate exists; AI co-review is pending.',
    };
  }

  if (!aiPasses) {
    return {
      status: 'blocked',
      strategyId: best.strategyId,
      annualSpendTodayDollars: best.evaluation.policy.annualSpendTodayDollars,
      monthlySpendTodayDollars:
        best.evaluation.policy.annualSpendTodayDollars / 12,
      policyId: best.evaluation.id,
      certificationVerdict: best.verdict,
      aiVerdict: input.aiApproval.verdict,
      blockingTaskIds: blockingTasks.map((task) => task.id),
      summary:
        'A green deterministic candidate exists, but monthly approval is blocked by AI co-review.',
    };
  }

  return {
    status: 'green',
    strategyId: best.strategyId,
    annualSpendTodayDollars: best.evaluation.policy.annualSpendTodayDollars,
    monthlySpendTodayDollars: best.evaluation.policy.annualSpendTodayDollars / 12,
    policyId: best.evaluation.id,
    certificationVerdict: best.verdict,
    aiVerdict: input.aiApproval?.verdict ?? null,
    blockingTaskIds: [],
    summary: 'Monthly review approved a green sleep-at-night spend target.',
  };
}

function accountBalance(data: SeedData, bucket: keyof SeedData['accounts']): number {
  const value = data.accounts[bucket]?.balance ?? 0;
  return Number.isFinite(value) ? value : 0;
}

function compactPlanHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return `mr-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function parseYearFromIso(value: string | undefined): number | null {
  if (!value) return null;
  const isoYear = /^(\d{4})-\d{2}-\d{2}/.exec(value)?.[1];
  if (isoYear) return Number(isoYear);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
}

function averageHouseholdAge(data: SeedData): number | null {
  try {
    const ages = calculateCurrentAges(data);
    return (ages.rob + ages.debbie) / 2;
  } catch {
    return null;
  }
}

function nearestSpendAtOrAfterAge(
  rows: MonthlyReviewSpendingPathRow[],
  age: number,
): number | null {
  return rows.find((row) => row.householdAge !== null && row.householdAge >= age)
    ?.annualSpendTodayDollars ?? null;
}

function buildMonthlyReviewSpendingPathMetrics(input: {
  data: SeedData;
  strategy: MonthlyReviewStrategyDefinition;
  evaluation: PolicyEvaluation;
  medianLifetimeSpendTodayDollars?: number | null;
}): MonthlyReviewSpendingPathMetrics {
  const scalar = input.evaluation.policy.annualSpendTodayDollars;
  const basis = input.strategy.spendingScheduleBasis;
  const years = basis
    ? Object.keys(basis.multipliersByYear)
        .map((year) => Number(year))
        .filter((year) => Number.isFinite(year))
        .sort((a, b) => a - b)
    : [];
  const firstScheduleYear = years[0] ?? parseYearFromIso(input.data.income.salaryEndDate);
  const lastScheduleYear =
    years[years.length - 1] ??
    (firstScheduleYear === null ? null : firstScheduleYear + 34);
  const averageAge = averageHouseholdAge(input.data);
  const annualSpendRows: MonthlyReviewSpendingPathRow[] =
    firstScheduleYear === null || lastScheduleYear === null
      ? []
      : Array.from(
          { length: Math.max(0, lastScheduleYear - firstScheduleYear + 1) },
          (_, index) => {
            const year = firstScheduleYear + index;
            const multiplier = basis?.multipliersByYear[year] ?? 1;
            return {
              year,
              householdAge:
                averageAge === null ? null : averageAge + (year - firstScheduleYear),
              multiplier,
              annualSpendTodayDollars: scalar * multiplier,
            };
          },
        );
  const retirementYear = parseYearFromIso(input.data.income.salaryEndDate);
  const firstModeledYearAnnualSpendTodayDollars =
    annualSpendRows[0]?.annualSpendTodayDollars ?? null;
  const firstRetirementYearAnnualSpendTodayDollars =
    annualSpendRows.find(
      (row) => retirementYear === null || row.year >= retirementYear,
    )?.annualSpendTodayDollars ?? null;
  const goGoRows = annualSpendRows.filter((row) => {
    const afterRetirement = retirementYear === null || row.year >= retirementYear;
    const beforeSlowGo =
      row.householdAge === null
        ? retirementYear === null || row.year < retirementYear + 10
        : row.householdAge < 75;
    return afterRetirement && beforeSlowGo;
  });
  const peakGoGo =
    goGoRows.reduce<MonthlyReviewSpendingPathRow | null>(
      (best, row) =>
        !best || row.annualSpendTodayDollars > best.annualSpendTodayDollars
          ? row
          : best,
      null,
    );
  const scheduleLifetimeSpendTodayDollars = annualSpendRows.length
    ? annualSpendRows.reduce((total, row) => total + row.annualSpendTodayDollars, 0)
    : null;
  const lifetimeAverageAnnualSpendTodayDollars =
    scheduleLifetimeSpendTodayDollars === null
      ? null
      : scheduleLifetimeSpendTodayDollars / annualSpendRows.length;

  return {
    valueBasis: 'today_dollars',
    scalarMeaning: scalarMeaningForBasis(basis),
    policySpendScalarTodayDollars: scalar,
    firstScheduleYear,
    retirementYear,
    firstModeledYearAnnualSpendTodayDollars,
    firstRetirementYearAnnualSpendTodayDollars,
    peakGoGoAnnualSpendTodayDollars:
      peakGoGo?.annualSpendTodayDollars ?? firstRetirementYearAnnualSpendTodayDollars,
    peakGoGoYear: peakGoGo?.year ?? null,
    age75AnnualSpendTodayDollars: nearestSpendAtOrAfterAge(annualSpendRows, 75),
    age80AnnualSpendTodayDollars: nearestSpendAtOrAfterAge(annualSpendRows, 80),
    age85AnnualSpendTodayDollars: nearestSpendAtOrAfterAge(annualSpendRows, 85),
    lifetimeAverageAnnualSpendTodayDollars,
    scheduleLifetimeSpendTodayDollars,
    medianLifetimeSpendTodayDollars: input.medianLifetimeSpendTodayDollars ?? null,
    annualSpendRows: annualSpendRows.slice(0, 15),
  };
}

function selectedMonthlyReviewCertification(
  strategies: MonthlyReviewStrategyResult[],
): MonthlyReviewCertification | null {
  return (
    strategies
      .map((strategy) => strategy.selectedCertification)
      .filter((cert): cert is MonthlyReviewCertification => !!cert)
      .sort(
        (a, b) =>
          b.evaluation.policy.annualSpendTodayDollars -
          a.evaluation.policy.annualSpendTodayDollars,
      )[0] ?? null
  );
}

const MONTHLY_REVIEW_ACA_FRIENDLY_MAGI_BUFFER = 2_000;
const MONTHLY_REVIEW_ACA_FPL_BY_HOUSEHOLD_SIZE: Record<number, number> = {
  1: 15_650,
  2: 21_150,
};
const MONTHLY_REVIEW_RUNWAY_TARGET_MONTHS = 18;

function moneyLabel(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function signalPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function ageInCalendarYear(birthDate: string, year: number): number {
  const parsed = new Date(birthDate);
  if (Number.isNaN(parsed.getTime())) return 0;
  return Math.max(0, year - parsed.getUTCFullYear());
}

function acaFriendlyMagiCeiling(input: {
  filingStatus: string;
  firstEvidenceYear: number;
  year: number;
  inflation: number;
}): number {
  const householdSize = input.filingStatus === 'married_filing_jointly' ? 2 : 1;
  const baselineFpl =
    MONTHLY_REVIEW_ACA_FPL_BY_HOUSEHOLD_SIZE[householdSize] ??
    MONTHLY_REVIEW_ACA_FPL_BY_HOUSEHOLD_SIZE[1];
  const years = Math.max(0, input.year - input.firstEvidenceYear);
  const inflationIndex = Math.pow(1 + Math.max(-0.99, input.inflation), years);
  return Math.max(
    0,
    baselineFpl * 4 * inflationIndex -
      MONTHLY_REVIEW_ACA_FRIENDLY_MAGI_BUFFER,
  );
}

function monthlyReviewKnownDecision(input: {
  data: SeedData;
  signalId: MonthlyReviewQaSignal['id'];
  year?: number;
}): MonthlyReviewQaSignal['knownDecision'] | undefined {
  const annotation = input.data.rules.monthlyReviewIssueAnnotations?.find(
    (item) =>
      item.signalId === input.signalId &&
      (!input.year || !item.years || item.years.includes(input.year)),
  );
  if (!annotation) return undefined;
  return {
    disposition: annotation.disposition,
    title: annotation.title,
    rationale: annotation.rationale,
    decision: annotation.decision,
    evidence: annotation.evidence ?? [],
    ...(annotation.reviewedAtIso
      ? { reviewedAtIso: annotation.reviewedAtIso }
      : {}),
    ...(annotation.source ? { source: annotation.source } : {}),
  };
}

function knownDecisionEvidence(
  knownDecision: MonthlyReviewQaSignal['knownDecision'],
): string[] {
  if (!knownDecision) return [];
  return [
    `knownDecisionDisposition=${knownDecision.disposition}`,
    `knownDecisionTitle=${knownDecision.title}`,
    `knownDecisionRationale=${knownDecision.rationale}`,
    `knownDecision=${knownDecision.decision}`,
    ...(knownDecision.source ? [`knownDecisionSource=${knownDecision.source}`] : []),
    ...(knownDecision.reviewedAtIso
      ? [`knownDecisionReviewedAtIso=${knownDecision.reviewedAtIso}`]
      : []),
    ...knownDecision.evidence.map((item) => `knownDecisionEvidence=${item}`),
  ];
}

function knownDecisionDisposition(
  knownDecision: MonthlyReviewQaSignal['knownDecision'],
): MonthlyReviewIssueDisposition | null {
  if (!knownDecision) return null;
  if (knownDecision.disposition === 'intentional_tradeoff') {
    return 'known_intentional_tradeoff';
  }
  if (knownDecision.disposition === 'accepted_risk') {
    return 'known_accepted_risk';
  }
  return null;
}

function buildAcaBridgeSignal(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selected: MonthlyReviewCertification | null;
}): MonthlyReviewQaSignal {
  const yearlyRows = input.selected?.pack.selectedPathEvidence?.yearlyRows ?? [];
  if (yearlyRows.length === 0) {
    return {
      id: 'aca_bridge_breach',
      status: 'watch',
      title: 'ACA bridge breach',
      headline: 'No selected yearly MAGI path attached',
      detail:
        'The QA packet cannot confirm ACA bridge headroom without selected-policy yearly MAGI rows from certification.',
      evidence: ['selectedPathEvidence.yearlyRows=0'],
      recommendation:
        'Run real certification so the AI review sees bridge-year MAGI, ACA premium, subsidy, and net-cost evidence.',
      clarity: {
        disposition: 'possible_model_bug',
        whyItMatters:
          'ACA bridge checks are only useful when the selected path exposes yearly MAGI, premium, subsidy, and net-cost rows.',
        whyItMayBeOk:
          'A missing row can be acceptable only during a dry run or when certification has not produced healthcare evidence yet.',
        modelBugCheck:
          'Treat this as a model evidence bug if real certification ran but selectedPathEvidence.yearlyRows is still empty.',
        decisionPrompt:
          'Rerun real certification and confirm the 2027 bridge-year MAGI row is present before judging the ACA tradeoff.',
      },
    };
  }

  const firstEvidenceYear = yearlyRows[0]?.year ?? new Date().getUTCFullYear();
  const salaryEndYear = new Date(input.data.income.salaryEndDate).getUTCFullYear();
  const salaryProrationRule =
    input.data.rules.payrollModel?.salaryProrationRule ?? 'month_fraction';
  const acaRows = yearlyRows
    .map((row) => {
      const robAge = ageInCalendarYear(input.data.household.robBirthDate, row.year);
      const debbieAge = ageInCalendarYear(
        input.data.household.debbieBirthDate,
        row.year,
      );
      const hasNonMedicareMember = robAge < 65 || debbieAge < 65;
      const ceiling = acaFriendlyMagiCeiling({
        filingStatus: input.data.household.filingStatus,
        firstEvidenceYear,
        year: row.year,
        inflation: input.assumptions.inflation ?? 0.028,
      });
      const modeledSalaryThisYear = calculateProratedSalary({
        salaryAnnual: input.data.income.salaryAnnual,
        retirementDate: input.data.income.salaryEndDate,
        projectionYear: row.year,
        rule: salaryProrationRule,
      });
      const headroom = ceiling - row.medianMagi;
      return {
        row,
        robAge,
        debbieAge,
        ceiling,
        headroom,
        overage: Math.max(0, -headroom),
        hasNonMedicareMember,
        modeledSalaryThisYear,
        hasModeledPayrollIncome: modeledSalaryThisYear > 1,
      };
    })
    .filter(
      (row) =>
        row.hasNonMedicareMember &&
        (!Number.isFinite(salaryEndYear) || row.row.year >= salaryEndYear),
    );
  const payrollTransitionRows = acaRows.filter((row) => row.hasModeledPayrollIncome);
  const bridgeRows = acaRows.filter((row) => !row.hasModeledPayrollIncome);

  if (bridgeRows.length === 0) {
    const transitionRow = payrollTransitionRows.reduce<
      (typeof payrollTransitionRows)[number] | null
    >((best, row) => (!best || row.headroom < best.headroom ? row : best), null);
    if (transitionRow) {
      const knownDecision = monthlyReviewKnownDecision({
        data: input.data,
        signalId: 'aca_bridge_breach',
        year: transitionRow.row.year,
      });
      return {
        id: 'aca_bridge_breach',
        status: 'ok',
        title: 'ACA bridge breach',
        headline: `${transitionRow.row.year}: payroll transition year, not ACA bridge`,
        detail: `Modeled MAGI is ${moneyLabel(
          transitionRow.row.medianMagi,
        )}, but ${moneyLabel(
          transitionRow.modeledSalaryThisYear,
        )} of modeled salary remains in that year. ACA subsidy preservation is not treated as an actionable bridge-year constraint until salary income has ended.`,
        evidence: [
          `year=${transitionRow.row.year}`,
          `medianMagi=${Math.round(transitionRow.row.medianMagi)}`,
          `acaFriendlyMagiCeiling=${Math.round(transitionRow.ceiling)}`,
          `headroom=${Math.round(transitionRow.headroom)}`,
          `modeledSalaryThisYear=${Math.round(transitionRow.modeledSalaryThisYear)}`,
          `salaryEndDate=${input.data.income.salaryEndDate}`,
          `payrollTransitionYear=true`,
          ...knownDecisionEvidence(knownDecision),
        ],
        recommendation:
          knownDecision?.disposition === 'intentional_tradeoff'
            ? `Known planning decision: ${knownDecision.decision}`
            : 'Do not treat the payroll transition year as act-now ACA work; verify the first full post-payroll pre-Medicare year instead.',
        ...(knownDecision ? { knownDecision } : {}),
        clarity: {
          disposition: knownDecisionDisposition(knownDecision) ?? 'monitor',
          whyItMatters:
            'ACA subsidy planning is meaningful in years when the household can control MAGI after salary income has ended.',
          whyItMayBeOk:
            knownDecision
              ? `This is already labeled in the model: ${knownDecision.rationale}`
              : 'Payroll income makes subsidy preservation structurally unavailable in the transition year, so the breach is not a failure to act.',
          modelBugCheck:
            'Check for a bug if this row is supposed to be post-payroll but modeledSalaryThisYear is still positive, or if the first full post-payroll pre-Medicare year is missing from selected evidence.',
          decisionPrompt:
            'Review the first full post-payroll ACA bridge row before making a subsidy-preservation decision.',
        },
      };
    }
    return {
      id: 'aca_bridge_breach',
      status: 'ok',
      title: 'ACA bridge breach',
      headline: 'No ACA bridge year in selected evidence',
      detail:
        'The selected yearly rows do not include a post-salary, pre-Medicare bridge year with a household member still ACA-eligible.',
      evidence: [`yearlyRows=${yearlyRows.length}`, `salaryEndYear=${salaryEndYear}`],
      recommendation:
        'Keep bridge-year MAGI evidence in the packet when certification covers the retirement transition.',
      clarity: {
        disposition: 'monitor',
        whyItMatters:
          'The ACA gate only applies while at least one household member is pre-Medicare after salary income ends.',
        whyItMayBeOk:
          'No bridge row means the selected evidence does not show an ACA subsidy decision point for the checked years.',
        modelBugCheck:
          'Investigate if household ages, salaryEndDate, or evidence-row years should have produced a pre-Medicare bridge year.',
        decisionPrompt:
          'Confirm the salary-end year and Medicare transition years before treating the ACA gate as irrelevant.',
      },
    };
  }

  const mostConstrained = bridgeRows.reduce((best, row) =>
    row.headroom < best.headroom ? row : best,
  );
  const status: MonthlyReviewQaSignalStatus =
    mostConstrained.overage > 0
      ? 'act_now'
      : mostConstrained.headroom <= 5_000
        ? 'watch'
        : 'ok';
  const knownDecision = monthlyReviewKnownDecision({
    data: input.data,
    signalId: 'aca_bridge_breach',
    year: mostConstrained.row.year,
  });
  const disposition = knownDecisionDisposition(knownDecision);
  const signalStatus: MonthlyReviewQaSignalStatus =
    status === 'act_now' && disposition ? 'watch' : status;

  return {
    id: 'aca_bridge_breach',
    status: signalStatus,
    title: 'ACA bridge breach',
    headline:
      mostConstrained.overage > 0
        ? `${mostConstrained.row.year}: MAGI ${moneyLabel(
            mostConstrained.overage,
          )} over ACA-friendly ceiling`
        : `${mostConstrained.row.year}: ${moneyLabel(
            mostConstrained.headroom,
          )} ACA MAGI cushion`,
    detail:
      mostConstrained.overage > 0
        ? `Modeled MAGI is ${moneyLabel(
            mostConstrained.row.medianMagi,
          )} against an ACA-friendly ceiling near ${moneyLabel(
            mostConstrained.ceiling,
          )}, so subsidy eligibility is breached in the bridge year.`
        : `Modeled MAGI is ${moneyLabel(
            mostConstrained.row.medianMagi,
          )} against an ACA-friendly ceiling near ${moneyLabel(
            mostConstrained.ceiling,
          )}.`,
    evidence: [
      `year=${mostConstrained.row.year}`,
      `medianMagi=${Math.round(mostConstrained.row.medianMagi)}`,
      `acaFriendlyMagiCeiling=${Math.round(mostConstrained.ceiling)}`,
      `headroom=${Math.round(mostConstrained.headroom)}`,
      `modeledSalaryThisYear=${Math.round(mostConstrained.modeledSalaryThisYear)}`,
      `payrollTransitionYear=false`,
      `medianAcaPremiumEstimate=${Math.round(
        mostConstrained.row.medianAcaPremiumEstimate,
      )}`,
      `medianAcaSubsidyEstimate=${Math.round(
        mostConstrained.row.medianAcaSubsidyEstimate,
      )}`,
      `medianNetAcaCost=${Math.round(mostConstrained.row.medianNetAcaCost)}`,
      ...knownDecisionEvidence(knownDecision),
    ],
    recommendation:
      knownDecision?.disposition === 'intentional_tradeoff'
        ? `Known planning decision: ${knownDecision.decision}`
        : mostConstrained.overage > 0
        ? 'Treat this as act-now MAGI work: reduce bridge-year taxable income, payroll taxable income, or conversion pressure before relying on subsidy assumptions.'
        : 'Keep the ACA bridge row visible and monitor the cushion before approving extra Roth conversions or taxable gains.',
    ...(knownDecision ? { knownDecision } : {}),
    clarity: {
      disposition:
        disposition ?? (mostConstrained.overage > 0 ? 'needs_action' : 'monitor'),
      whyItMatters:
        'Crossing the ACA-friendly MAGI ceiling can reduce or eliminate premium subsidies in the bridge year.',
      whyItMayBeOk:
        knownDecision
          ? `This is not a surprise in the current model: ${knownDecision.rationale}`
          : mostConstrained.overage > 0
          ? 'This is not OK by default. It becomes acceptable only if the household explicitly accepts the subsidy loss for a named tradeoff and the selected policy still passes after net ACA cost is included.'
          : 'A cushion means the current policy is not spending ACA subsidy headroom, but the cushion can disappear if conversions or taxable gains increase.',
      modelBugCheck:
        'Check for a bug if MAGI excludes conversions, dividends, interest, realized gains, payroll income, or Social Security; if ACA FPL thresholds are stale; or if gross premiums, subsidies, and net ACA costs are not flowing into the selected path.',
      decisionPrompt:
        knownDecision?.disposition === 'intentional_tradeoff'
          ? `Confirm the known decision still stands: ${knownDecision.decision}`
          : mostConstrained.overage > 0
          ? 'Decide whether to accept the subsidy loss as an intentional 2027 tradeoff or rerun a MAGI-constrained variant to price the subsidy-preserving alternative.'
          : 'Keep the bridge-year MAGI row in the review and avoid using the cushion accidentally.',
    },
  };
}

function buildRunwaySignal(data: SeedData): MonthlyReviewQaSignal {
  const runway = calculateRunwayGapMetrics({
    data,
    targetMonths: MONTHLY_REVIEW_RUNWAY_TARGET_MONTHS,
  });
  const knownDecision = monthlyReviewKnownDecision({
    data,
    signalId: 'cash_runway_gap',
  });
  const annualCoreSpend =
    data.spending.essentialMonthly * 12 +
    data.spending.optionalMonthly * 12 +
    data.spending.annualTaxesInsurance;
  const directCashYears =
    annualCoreSpend > 0 ? runway.directCashBalance / annualCoreSpend : 0;
  const status: MonthlyReviewQaSignalStatus =
    runway.cashGap > 0
      ? runway.runwayGapMonths >= 3
        ? 'act_now'
        : 'watch'
      : 'ok';

  return {
    id: 'cash_runway_gap',
    status,
    title: 'Cash runway gap',
    headline:
      runway.cashGap > 0
        ? `${moneyLabel(runway.cashGap)} short of ${MONTHLY_REVIEW_RUNWAY_TARGET_MONTHS}-month target`
        : `${MONTHLY_REVIEW_RUNWAY_TARGET_MONTHS}-month target covered`,
    detail:
      runway.cashGap > 0
        ? `Direct cash is about ${directCashYears.toFixed(
            2,
          )} years of core spending and ${(
            runway.directCashBalance / Math.max(1, runway.essentialWithFixedMonthly)
          ).toFixed(1)} months of essential-plus-fixed spending. The target is ${moneyLabel(
            runway.targetCashRunway,
          )}.`
        : `Direct cash covers the ${MONTHLY_REVIEW_RUNWAY_TARGET_MONTHS}-month essential-plus-fixed target.`,
    evidence: [
      `directCashBalance=${Math.round(runway.directCashBalance)}`,
      `essentialWithFixedMonthly=${Math.round(runway.essentialWithFixedMonthly)}`,
      `targetCashRunway=${Math.round(runway.targetCashRunway)}`,
      `cashGap=${Math.round(runway.cashGap)}`,
      `runwayGapMonths=${runway.runwayGapMonths.toFixed(2)}`,
      `directCashYearsOfCoreSpend=${directCashYears.toFixed(2)}`,
      ...knownDecisionEvidence(knownDecision),
    ],
    recommendation:
      knownDecision
        ? `Known planning decision: ${knownDecision.decision}`
        : runway.cashGap > 0
        ? 'Surface as a checkpoint item before Fidelity refresh: identify whether the gap should be filled from cash, taxable, or reduced payroll deferrals.'
        : 'Keep the runway calculation attached to the monthly review packet.',
    ...(knownDecision ? { knownDecision } : {}),
    clarity: {
      disposition:
        knownDecisionDisposition(knownDecision) ??
        (runway.cashGap > 0 ? 'needs_action' : 'monitor'),
      whyItMatters:
        'Cash runway is an operational resilience gate, not a Monte Carlo solvency gate; it protects spending while transfers, payroll changes, or market sales are being handled.',
      whyItMayBeOk:
        knownDecision
          ? `This is OK only because there is a recorded decision: ${knownDecision.rationale}`
          : runway.cashGap > 0
          ? 'This is a problem until a funding source, transfer plan, or explicit waiver is recorded.'
          : 'Covered runway means this checkpoint is satisfied unless spending or fixed costs change.',
      modelBugCheck:
        'Check for a bug if bank/cash balances are stale, cash held inside brokerage accounts is double-counted or excluded, or the essential-plus-fixed monthly target is not tied to current seed spending.',
      decisionPrompt:
        runway.cashGap > 0
          ? 'Choose whether to fill the cash bucket, document the source of backup liquidity, or intentionally waive the 18-month target.'
          : 'Keep refreshing bank and cash balances before comparing the next Fidelity update.',
    },
  };
}

function buildHoldingConcentrationSignal(data: SeedData): MonthlyReviewQaSignal {
  const knownDecision = monthlyReviewKnownDecision({
    data,
    signalId: 'holding_concentration',
  });
  const buckets = ['pretax', 'roth', 'taxable', 'cash', 'hsa'] as const;
  const totalPortfolio = buckets.reduce(
    (sum, bucket) => sum + Math.max(0, data.accounts[bucket]?.balance ?? 0),
    0,
  );
  const bySymbol = new Map<
    string,
    {
      symbol: string;
      name: string | null;
      value: number;
      largestAccountShare: number;
      largestAccountName: string | null;
    }
  >();

  for (const bucket of buckets) {
    for (const account of data.accounts[bucket]?.sourceAccounts ?? []) {
      for (const holding of account.holdings ?? []) {
        const symbol = holding.symbol.trim().toUpperCase();
        if (!symbol || symbol === 'CASH') continue;
        const existing =
          bySymbol.get(symbol) ??
          {
            symbol,
            name: holding.name ?? null,
            value: 0,
            largestAccountShare: 0,
            largestAccountName: null,
          };
        existing.value += holding.value;
        const accountShare =
          account.balance > 0 ? Math.max(0, holding.value / account.balance) : 0;
        if (accountShare > existing.largestAccountShare) {
          existing.largestAccountShare = accountShare;
          existing.largestAccountName = account.name;
        }
        if (!existing.name && holding.name) existing.name = holding.name;
        bySymbol.set(symbol, existing);
      }
    }
  }

  const largest =
    [...bySymbol.values()]
      .map((holding) => ({
        ...holding,
        portfolioShare: totalPortfolio > 0 ? holding.value / totalPortfolio : 0,
      }))
      .sort((left, right) => right.portfolioShare - left.portfolioShare)[0] ?? null;

  if (!largest) {
    return {
      id: 'holding_concentration',
      status: 'watch',
      title: 'Holding concentration',
      headline: 'No holdings detail attached',
      detail:
        'The QA packet cannot confirm single-holding concentration without source-account holdings.',
      evidence: ['holdingCount=0'],
      recommendation:
        'Refresh holdings detail before relying on portfolio concentration checks.',
      clarity: {
        disposition: 'possible_model_bug',
        whyItMatters:
          'Concentration checks need source-account holdings; account totals alone cannot show single-manager or single-security exposure.',
        whyItMayBeOk:
          'This is acceptable only before a holdings refresh or when the review is intentionally running from balance-only data.',
        modelBugCheck:
          'Treat as an import/model bug if Fidelity holdings were provided but sourceAccounts.holdings is empty.',
        decisionPrompt:
          'Refresh Fidelity holdings and rerun before deciding whether concentration is a true risk.',
      },
    };
  }

  const status: MonthlyReviewQaSignalStatus =
    largest.portfolioShare >= 0.15 || largest.largestAccountShare >= 0.5
      ? 'act_now'
      : largest.portfolioShare >= 0.1
        ? 'watch'
        : 'ok';

  return {
    id: 'holding_concentration',
    status,
    title: 'Holding concentration',
    headline: `${largest.symbol} is ${signalPercent(
      largest.portfolioShare,
    )} of portfolio`,
    detail: `${largest.name ?? largest.symbol} is ${moneyLabel(
      largest.value,
    )}, or ${signalPercent(largest.portfolioShare)} of the total portfolio, and ${signalPercent(
      largest.largestAccountShare,
    )} of ${largest.largestAccountName ?? 'one source account'}.`,
    evidence: [
      `largestHoldingSymbol=${largest.symbol}`,
      `largestHoldingValue=${Math.round(largest.value)}`,
      `largestHoldingPortfolioShare=${largest.portfolioShare.toFixed(4)}`,
      `largestHoldingAccountShare=${largest.largestAccountShare.toFixed(4)}`,
      `largestAccountName=${largest.largestAccountName ?? 'unknown'}`,
      `totalPortfolio=${Math.round(totalPortfolio)}`,
      ...knownDecisionEvidence(knownDecision),
    ],
    recommendation:
      knownDecision
        ? `Known planning decision: ${knownDecision.decision}`
        : status === 'act_now'
        ? 'Show this as a concentration item: rebalance or reduce single-manager exposure inside tax-advantaged accounts where possible.'
        : 'Keep monitoring single-holding and single-account concentration after each Fidelity refresh.',
    ...(knownDecision ? { knownDecision } : {}),
    clarity: {
      disposition:
        knownDecisionDisposition(knownDecision) ??
        (status === 'act_now' ? 'needs_action' : 'monitor'),
      whyItMatters:
        'A large single holding can dominate plan outcomes in ways the broad asset-class Monte Carlo model may not fully capture.',
      whyItMayBeOk:
        knownDecision
          ? `This is OK only because there is a recorded decision: ${knownDecision.rationale}`
          : status === 'act_now'
            ? 'This is a problem until the household records a rebalance plan, staged rebalance, or explicit acceptance of concentration risk.'
            : 'This is monitor-only while concentration stays below the action threshold.',
      modelBugCheck:
        'Check for a bug if duplicate holdings were merged incorrectly, account balances do not match holding totals, or fund tickers were imported into the wrong source account.',
      decisionPrompt:
        status === 'act_now'
          ? 'Decide whether to rebalance, stage the rebalance, or explicitly accept the single-holding exposure until the next review.'
          : 'Keep monitoring the largest holding after each holdings refresh.',
    },
  };
}

function buildLegacyHeadroomSignal(input: {
  data: SeedData;
  legacyTargetTodayDollars: number;
  selected: MonthlyReviewCertification | null;
}): MonthlyReviewQaSignal {
  const knownDecision = monthlyReviewKnownDecision({
    data: input.data,
    signalId: 'legacy_headroom',
  });
  const outcome =
    input.selected?.pack.selectedPathEvidence?.outcome ??
    input.selected?.evaluation.outcome ??
    null;
  const medianEnding = outcome?.p50EndingWealthTodayDollars ?? null;
  const ratio =
    medianEnding !== null && input.legacyTargetTodayDollars > 0
      ? medianEnding / input.legacyTargetTodayDollars
      : null;

  if (medianEnding === null || ratio === null) {
    return {
      id: 'legacy_headroom',
      status: 'watch',
      title: 'Legacy headroom',
      headline: 'Median legacy ratio unavailable',
      detail:
        'The selected policy outcome does not include median ending wealth relative to the stated legacy target.',
      evidence: [
        `legacyTargetTodayDollars=${input.legacyTargetTodayDollars}`,
        `p50EndingWealthTodayDollars=missing`,
        ...knownDecisionEvidence(knownDecision),
      ],
      recommendation:
        knownDecision
          ? `Known planning decision: ${knownDecision.decision}`
          : 'Attach selected policy outcome percentiles before approving the spend recommendation.',
      ...(knownDecision ? { knownDecision } : {}),
      clarity: {
        disposition:
          knownDecisionDisposition(knownDecision) ?? 'possible_model_bug',
        whyItMatters:
          'Legacy headroom can only be interpreted when the selected policy has ending-wealth percentiles.',
        whyItMayBeOk:
          'Missing ending-wealth data is acceptable only in an incomplete diagnostic packet.',
        modelBugCheck:
          'Treat as a model evidence bug if the selected policy has certification but no p50 ending wealth outcome.',
        decisionPrompt:
          'Attach selected outcome percentiles and rerun before interpreting legacy headroom.',
      },
    };
  }

  const medianEndingValue = medianEnding;
  const status: MonthlyReviewQaSignalStatus =
    ratio < 1 ? 'act_now' : ratio >= 2.5 ? 'watch' : 'ok';

  return {
    id: 'legacy_headroom',
    status,
    title: 'Legacy headroom',
    headline: `Median EW is ${ratio.toFixed(1)}x legacy target`,
    detail:
      ratio >= 2.5
        ? `Median ending wealth is ${moneyLabel(
            medianEndingValue,
          )} against a ${moneyLabel(
            input.legacyTargetTodayDollars,
          )} target. This is spending-headroom evidence, not a depletion-risk warning.`
        : `Median ending wealth is ${moneyLabel(
            medianEndingValue,
          )} against a ${moneyLabel(input.legacyTargetTodayDollars)} target.`,
    evidence: [
      `legacyTargetTodayDollars=${Math.round(input.legacyTargetTodayDollars)}`,
      `p50EndingWealthTodayDollars=${Math.round(medianEndingValue)}`,
      `medianLegacyToTargetRatio=${ratio.toFixed(3)}`,
      `bequestAttainmentRate=${outcome?.bequestAttainmentRate ?? 'missing'}`,
      ...knownDecisionEvidence(knownDecision),
    ],
    recommendation:
      knownDecision
        ? `Known planning decision: ${knownDecision.decision}`
        : ratio < 1
        ? 'Do not approve a higher spend until the selected candidate is back above the stated legacy target.'
        : ratio >= 2.5
          ? 'Surface as a “could spend more” flag; it is the opposite of a homelessness/depletion-risk item.'
          : 'Legacy target is within the review band; keep monitoring with every rerun.',
    ...(knownDecision ? { knownDecision } : {}),
    clarity: {
      disposition:
        knownDecisionDisposition(knownDecision) ??
        (ratio < 1
          ? 'needs_action'
          : ratio >= 2.5
            ? 'spending_headroom'
            : 'monitor'),
      whyItMatters:
        'Legacy headroom shows whether the selected spend path is consuming the household goal or leaving a large margin unused.',
      whyItMayBeOk:
        knownDecision
          ? `This is OK because there is a recorded decision: ${knownDecision.rationale}`
          : ratio >= 2.5
          ? 'High headroom is acceptable if the household deliberately prefers a larger legacy, optionality, or lower stress over more current spending.'
          : 'A moderate ratio is acceptable when it reflects the stated legacy target and sleep-at-night preference.',
      modelBugCheck:
        'Check for a bug if the legacy target is stale, ending wealth is nominal instead of today-dollar, or the selected strategy is not the one being reviewed.',
      decisionPrompt:
        ratio >= 2.5
          ? 'Decide whether this surplus is intentional or whether the monthly spend target should be raised and re-certified.'
          : 'Keep comparing p50 and downside ending wealth against the stated legacy target.',
    },
  };
}

export function buildMonthlyReviewQaSignals(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  legacyTargetTodayDollars: number;
  strategies: MonthlyReviewStrategyResult[];
}): MonthlyReviewQaSignal[] {
  const selected = selectedMonthlyReviewCertification(input.strategies);
  return [
    buildAcaBridgeSignal({
      data: input.data,
      assumptions: input.assumptions,
      selected,
    }),
    buildRunwaySignal(input.data),
    buildHoldingConcentrationSignal(input.data),
    buildLegacyHeadroomSignal({
      data: input.data,
      legacyTargetTodayDollars: input.legacyTargetTodayDollars,
      selected,
    }),
  ];
}

function buildCertificationSummary(
  strategies: MonthlyReviewStrategyResult[],
): MonthlyReviewValidationPacket['certificationSummary'] {
  return strategies.flatMap((strategy) =>
    strategy.certifications.map((cert) => ({
      strategyId: strategy.strategy.id,
      policyId: cert.evaluation.id,
      verdict: cert.verdict,
      reasons: cert.pack.reasons.map((reason) => reason.message),
    })),
  );
}

export function buildMonthlyReviewRawExportEvidence(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  strategies: MonthlyReviewStrategyResult[];
  certificationSummary: MonthlyReviewValidationPacket['certificationSummary'];
}): MonthlyReviewRawExportEvidence {
  const selected = selectedMonthlyReviewCertification(input.strategies);
  const selectedStrategy = selected
    ? input.strategies.find((strategy) => strategy.strategy.id === selected.strategyId)
    : null;
  const certifiedOutcomeByPolicyId = new Map(
    input.strategies.flatMap((strategy) =>
      strategy.certifications
        .filter((cert) => cert.pack.selectedPathEvidence)
        .map((cert) => [
          cert.evaluation.id,
          cert.pack.selectedPathEvidence?.outcome ?? cert.evaluation.outcome,
        ] as const),
    ),
  );
  const outcomeFor = (evaluation: PolicyEvaluation) =>
    certifiedOutcomeByPolicyId.get(evaluation.id) ?? evaluation.outcome;
  const topCandidateRows = input.strategies.flatMap((strategy) =>
    strategy.rankedCandidates.slice(0, 8).map((evaluation) => {
      const outcome = outcomeFor(evaluation);
      return {
        strategyId: strategy.strategy.id,
        policyId: evaluation.id,
        annualSpendTodayDollars: evaluation.policy.annualSpendTodayDollars,
        solventSuccessRate: outcome.solventSuccessRate,
        bequestAttainmentRate: outcome.bequestAttainmentRate,
        p10EndingWealthTodayDollars: outcome.p10EndingWealthTodayDollars,
        p25EndingWealthTodayDollars: outcome.p25EndingWealthTodayDollars,
        p50EndingWealthTodayDollars: outcome.p50EndingWealthTodayDollars,
        p75EndingWealthTodayDollars: outcome.p75EndingWealthTodayDollars,
        p90EndingWealthTodayDollars: outcome.p90EndingWealthTodayDollars,
        irmaaExposureRate: outcome.irmaaExposureRate,
        medianLifetimeFederalTaxTodayDollars:
          outcome.medianLifetimeFederalTaxTodayDollars,
        withdrawalRule: evaluation.policy.withdrawalRule ?? null,
        rothConversionAnnualCeiling: evaluation.policy.rothConversionAnnualCeiling,
      };
    }),
  );
  const selectedOutcome =
    selected && selectedStrategy ? outcomeFor(selected.evaluation) : null;
  const selectedSpendingPath =
    selected && selectedStrategy
      ? buildMonthlyReviewSpendingPathMetrics({
          data: input.data,
          strategy: selectedStrategy.strategy,
          evaluation: selected.evaluation,
          medianLifetimeSpendTodayDollars:
            selectedOutcome?.medianLifetimeSpendTodayDollars ?? null,
        })
      : null;
  const higherSpendRowsTested = input.strategies.flatMap((strategy) => {
    const selectedSpend =
      strategy.selectedCertification?.evaluation.policy.annualSpendTodayDollars ??
      null;
    if (selectedSpend === null) return [];
    return strategy.evidenceCandidates
      .filter(
        (evaluation) =>
          evaluation.policy.annualSpendTodayDollars > selectedSpend,
      )
      .slice(0, 12)
      .map((evaluation) => {
        const outcome = outcomeFor(evaluation);
        return {
          strategyId: strategy.strategy.id,
          policyId: evaluation.id,
          annualSpendTodayDollars: evaluation.policy.annualSpendTodayDollars,
          solventSuccessRate: outcome.solventSuccessRate,
          bequestAttainmentRate: outcome.bequestAttainmentRate,
          p10EndingWealthTodayDollars:
            outcome.p10EndingWealthTodayDollars,
          p25EndingWealthTodayDollars:
            outcome.p25EndingWealthTodayDollars,
          p50EndingWealthTodayDollars: outcome.p50EndingWealthTodayDollars,
          p75EndingWealthTodayDollars:
            outcome.p75EndingWealthTodayDollars,
          p90EndingWealthTodayDollars:
            outcome.p90EndingWealthTodayDollars,
          irmaaExposureRate: outcome.irmaaExposureRate,
          medianLifetimeFederalTaxTodayDollars:
            outcome.medianLifetimeFederalTaxTodayDollars,
          withdrawalRule: evaluation.policy.withdrawalRule ?? null,
          rothConversionAnnualCeiling:
            evaluation.policy.rothConversionAnnualCeiling,
        };
      });
  });
  const annualCoreSpend =
    input.data.spending.essentialMonthly * 12 +
    input.data.spending.optionalMonthly * 12 +
    input.data.spending.annualTaxesInsurance;
  const annualWithTravelSpend =
    annualCoreSpend + input.data.spending.travelEarlyRetirementAnnual;
  const balancesTodayDollars = {
    pretax: accountBalance(input.data, 'pretax'),
    roth: accountBalance(input.data, 'roth'),
    taxable: accountBalance(input.data, 'taxable'),
    cash: accountBalance(input.data, 'cash'),
    hsa: accountBalance(input.data, 'hsa'),
    liquidTotal: 0,
  };
  balancesTodayDollars.liquidTotal =
    balancesTodayDollars.pretax +
    balancesTodayDollars.roth +
    balancesTodayDollars.taxable +
    balancesTodayDollars.cash +
    balancesTodayDollars.hsa;

  return {
    source: 'monthly_review_compact_export_excerpt_v1',
    planFingerprint: compactPlanHash({
      baselineFingerprint: input.baselineFingerprint,
      engineVersion: input.engineVersion,
      household: input.data.household,
      accounts: input.data.accounts,
      income: input.data.income,
      spending: input.data.spending,
      assumptions: input.assumptions,
    }),
    evidenceLimits: {
      topCandidateRows: 8,
      higherSpendRows: 12,
      yearlyPathRows: 12,
    },
    household: input.data.household,
    balancesTodayDollars,
    spending: {
      essentialMonthly: input.data.spending.essentialMonthly,
      optionalMonthly: input.data.spending.optionalMonthly,
      annualTaxesInsurance: input.data.spending.annualTaxesInsurance,
      travelEarlyRetirementAnnual:
        input.data.spending.travelEarlyRetirementAnnual,
      annualCoreSpend,
      annualWithTravelSpend,
    },
    income: {
      salaryAnnual: input.data.income.salaryAnnual,
      salaryEndDate: input.data.income.salaryEndDate,
      socialSecurity: input.data.income.socialSecurity,
      windfalls: input.data.income.windfalls,
      preRetirementContributions:
        input.data.income.preRetirementContributions,
    },
    assumptions: {
      equityMean: input.assumptions.equityMean,
      equityVolatility: input.assumptions.equityVolatility,
      internationalEquityMean: input.assumptions.internationalEquityMean,
      internationalEquityVolatility:
        input.assumptions.internationalEquityVolatility,
      bondMean: input.assumptions.bondMean,
      bondVolatility: input.assumptions.bondVolatility,
      cashMean: input.assumptions.cashMean,
      cashVolatility: input.assumptions.cashVolatility,
      inflation: input.assumptions.inflation,
      inflationVolatility: input.assumptions.inflationVolatility,
      simulationRuns: input.assumptions.simulationRuns,
      simulationSeed: input.assumptions.simulationSeed,
      assumptionsVersion: input.assumptions.assumptionsVersion,
      useHistoricalBootstrap: input.assumptions.useHistoricalBootstrap,
      historicalBootstrapBlockLength:
        input.assumptions.historicalBootstrapBlockLength,
      samplingStrategy: input.assumptions.samplingStrategy,
      equityTailMode: input.assumptions.equityTailMode,
      guardrailFloorYears: input.assumptions.guardrailFloorYears,
      guardrailCeilingYears: input.assumptions.guardrailCeilingYears,
      guardrailCutPercent: input.assumptions.guardrailCutPercent,
      robPlanningEndAge: input.assumptions.robPlanningEndAge,
      debbiePlanningEndAge: input.assumptions.debbiePlanningEndAge,
      travelPhaseYears: input.assumptions.travelPhaseYears,
      irmaaThreshold: input.assumptions.irmaaThreshold,
    },
    rules: {
      withdrawalStyle: input.data.rules.withdrawalStyle,
      irmaaAware: input.data.rules.irmaaAware,
      replaceModeImports: input.data.rules.replaceModeImports,
      monthlyReviewIssueAnnotations:
        input.data.rules.monthlyReviewIssueAnnotations,
      rothConversionPolicy: input.data.rules.rothConversionPolicy,
      rmdPolicy: input.data.rules.rmdPolicy,
      payrollModel: input.data.rules.payrollModel,
      contributionLimits: input.data.rules.contributionLimits,
      housingAfterDownsizePolicy: input.data.rules.housingAfterDownsizePolicy,
      windfallDeploymentPolicy: input.data.rules.windfallDeploymentPolicy,
      healthcarePremiums: input.data.rules.healthcarePremiums,
      hsaStrategy: input.data.rules.hsaStrategy,
      ltcAssumptions: input.data.rules.ltcAssumptions,
    },
    selectedPolicy:
      selected && selectedStrategy && selectedSpendingPath
        ? {
            strategyId: selected.strategyId,
            strategyLabel: selectedStrategy.strategy.label,
            policyId: selected.evaluation.id,
            annualSpendTodayDollars:
              selected.evaluation.policy.annualSpendTodayDollars,
            monthlySpendTodayDollars:
              selected.evaluation.policy.annualSpendTodayDollars / 12,
            primarySocialSecurityClaimAge:
              selected.evaluation.policy.primarySocialSecurityClaimAge,
            spouseSocialSecurityClaimAge:
              selected.evaluation.policy.spouseSocialSecurityClaimAge,
            rothConversionAnnualCeiling:
              selected.evaluation.policy.rothConversionAnnualCeiling,
            withdrawalRule: selected.evaluation.policy.withdrawalRule ?? null,
            spendingPath: selectedSpendingPath,
            outcome: selectedOutcome ?? outcomeFor(selected.evaluation),
            certificationVerdict: selected.verdict,
          }
        : null,
    proofRows: {
      topCandidates: topCandidateRows,
      higherSpendRowsTested,
      certificationRows: input.certificationSummary,
    },
    yearlyPathEvidence:
      selected?.pack.guardrail.modeledAssetPath.slice(0, 12) ?? [],
  };
}

export function buildMonthlyReviewValidationPacket(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  generatedAtIso: string;
  legacyTargetTodayDollars: number;
  recommendation: MonthlyReviewRecommendation;
  strategies: MonthlyReviewStrategyResult[];
  tasks: MonthlyReviewModelTask[];
}): MonthlyReviewValidationPacket {
  const certificationSummary = buildCertificationSummary(input.strategies);
  return {
    version: 'monthly_review_validation_packet_v1',
    generatedAtIso: input.generatedAtIso,
    northStar: {
      legacyTargetTodayDollars: input.legacyTargetTodayDollars,
      objective: 'maximize_monthly_spend_subject_to_sleep_at_night_gates',
      approvalStandard: 'green_only',
      advisorStandard: {
        role: 'advisor_like_decision_support',
        posture:
          'explain_model_facts_unknowns_household_decisions_and_ai_suggestions_separately',
        limits: 'do_not_invent_facts_or_treat_suggestions_as_household_decisions',
      },
    },
    recommendation: input.recommendation,
    strategies: input.strategies.map((strategy) => ({
      id: strategy.strategy.id,
      label: strategy.strategy.label,
      corpusEvaluationCount: strategy.corpusEvaluationCount,
      selectedPolicyId: strategy.selectedCertification?.evaluation.id ?? null,
      selectedAnnualSpendTodayDollars:
        strategy.selectedCertification?.evaluation.policy
          .annualSpendTodayDollars ?? null,
      certificationVerdict: strategy.selectedCertification?.verdict ?? null,
      spendBoundary: strategy.spendBoundary,
    })),
    certificationSummary,
    structuralTasks: input.tasks,
    householdSignals: buildMonthlyReviewQaSignals({
      data: input.data,
      assumptions: input.assumptions,
      legacyTargetTodayDollars: input.legacyTargetTodayDollars,
      strategies: input.strategies,
    }),
    lifeModelAudit: buildLifeModelAudit({
      data: input.data,
      assumptions: input.assumptions,
      generatedAtIso: input.generatedAtIso,
    }),
    rawExportEvidence: buildMonthlyReviewRawExportEvidence({
      data: input.data,
      assumptions: input.assumptions,
      baselineFingerprint: input.baselineFingerprint,
      engineVersion: input.engineVersion,
      strategies: input.strategies,
      certificationSummary,
    }),
  };
}

export async function runMonthlyReview(
  input: RunMonthlyReviewInput,
): Promise<MonthlyReviewRun> {
  const generatedAtIso = input.generatedAtIso ?? new Date().toISOString();
  const strategyIdSet = input.strategyIds ? new Set(input.strategyIds) : null;
  const strategies = buildMonthlyReviewStrategies({
    data: input.data,
    assumptions: input.assumptions,
  }).filter(
    (strategy) => !strategyIdSet || strategyIdSet.has(strategy.id),
  );
  const strategyResults: MonthlyReviewStrategyResult[] = [];

  for (const strategy of strategies) {
    try {
      const mined = await input.ports.mineStrategy(strategy);
      const candidates = rankMonthlyReviewCandidates(mined.evaluations);
      const certifications = await certifyAllInParallel({
        strategy,
        candidates,
        certifyCandidate: input.ports.certifyCandidate,
        maxConcurrency: input.certificationMaxConcurrency,
      });
      strategyResults.push(
        buildStrategyResult({
          strategy,
          evaluations: mined.evaluations,
          certifications,
          overrideBoundary: mined.spendBoundary,
        }),
      );
    } catch (error) {
      strategyResults.push(
        buildStrategyResult({
          strategy,
          evaluations: [],
          certifications: [],
          errors: [error instanceof Error ? error.message : String(error)],
        }),
      );
    }
  }

  const preAiTasks = classifyMonthlyReviewModelTasks({
    strategies: strategyResults,
    cashDiagnostic: input.cashDiagnostic,
    generatedAtIso,
  });
  const preAiRecommendation = buildMonthlyReviewRecommendation({
    strategies: strategyResults,
    tasks: preAiTasks,
    aiApproval: null,
  });
  const packet = buildMonthlyReviewValidationPacket({
    data: input.data,
    assumptions: input.assumptions,
    baselineFingerprint: input.baselineFingerprint,
    engineVersion: input.engineVersion,
    generatedAtIso,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    recommendation: preAiRecommendation,
    strategies: strategyResults,
    tasks: preAiTasks,
  });
  const aiApproval = await input.ports.aiReview(packet);
  const modelTasks = classifyMonthlyReviewModelTasks({
    strategies: strategyResults,
    aiApproval,
    cashDiagnostic: input.cashDiagnostic,
    generatedAtIso,
  });
  const recommendation = buildMonthlyReviewRecommendation({
    strategies: strategyResults,
    tasks: modelTasks,
    aiApproval,
  });

  return {
    id: input.id,
    generatedAtIso,
    baselineFingerprint: input.baselineFingerprint,
    engineVersion: input.engineVersion,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    strategies: strategyResults,
    aiApproval,
    modelTasks,
    recommendation,
    apiCallCount: 1,
  };
}

export async function runMonthlyReviewIterationLoop(
  input: RunMonthlyReviewIterationInput,
): Promise<MonthlyReviewIterationResult> {
  const iterations: MonthlyReviewRun[] = [];
  const maxIterations = Math.max(1, Math.floor(input.maxIterations));
  const apiCallLimit = Math.max(1, Math.floor(input.apiCallLimit ?? 5));
  let apiCallCount = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    const run = await runMonthlyReview({
      ...input,
      id: `${input.id}-iter-${i + 1}`,
    });
    iterations.push(run);
    apiCallCount += run.apiCallCount;
    if (run.recommendation.status === 'green') {
      return { finalRun: run, iterations, stoppedBecause: 'green' };
    }
    if (apiCallCount >= apiCallLimit) {
      return { finalRun: run, iterations, stoppedBecause: 'api_call_limit' };
    }
    const nextTask = run.modelTasks.find(
      (task) => task.blocksApproval && task.status === 'open',
    );
    if (!nextTask || !input.fixTask) {
      return {
        finalRun: run,
        iterations,
        stoppedBecause: i + 1 >= maxIterations ? 'max_iterations' : 'task_blocked',
      };
    }
    const fixed = await input.fixTask(nextTask);
    if (fixed !== 'fixed') {
      return { finalRun: run, iterations, stoppedBecause: 'task_blocked' };
    }
  }
  return {
    finalRun: iterations[iterations.length - 1]!,
    iterations,
    stoppedBecause: 'max_iterations',
  };
}
