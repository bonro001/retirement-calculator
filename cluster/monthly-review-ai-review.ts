import OpenAI from 'openai';
import {
  MONTHLY_REVIEW_AI_DEFAULT_MODEL,
  MONTHLY_REVIEW_AI_DEFAULT_REASONING_EFFORT,
  type MonthlyReviewAiApproval,
  type MonthlyReviewAiFinding,
  type MonthlyReviewAiVerdict,
  type MonthlyReviewValidationPacket,
} from '../src/monthly-review';

export class MonthlyReviewAiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'MonthlyReviewAiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RunMonthlyReviewAiApprovalArgs {
  packet: MonthlyReviewValidationPacket;
  apiKey?: string;
  model?: string;
  reasoningEffort?: string;
}

const VALID_VERDICTS = new Set<MonthlyReviewAiVerdict>([
  'aligned',
  'watch',
  'misaligned',
  'insufficient_data',
]);
const VALID_FINDING_STATUSES = new Set(['pass', 'watch', 'fail']);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);
const LEGACY_ATTAINMENT_GATE = 0.85;
const SOLVENCY_GATE = 0.8;

const REQUIRED_FINDING_IDS = [
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
] as const;

type RequiredFindingId = (typeof REQUIRED_FINDING_IDS)[number];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function money(value: unknown): string {
  return finiteNumber(value) ? `$${Math.round(value).toLocaleString()}` : 'missing';
}

function percent(value: unknown): string {
  return finiteNumber(value) ? `${(value * 100).toFixed(1)}%` : 'missing';
}

function signalClarityEvidence(
  signal: NonNullable<MonthlyReviewValidationPacket['householdSignals']>[number],
): string {
  return [
    signal.id,
    signal.status,
    signal.headline,
    signal.knownDecision
      ? `knownDecision=${signal.knownDecision.disposition}; rationale=${signal.knownDecision.rationale}; decision=${signal.knownDecision.decision}`
      : 'knownDecision=none',
    signal.clarity
      ? `disposition=${signal.clarity.disposition}; okContext=${signal.clarity.whyItMayBeOk}; bugCheck=${signal.clarity.modelBugCheck}; decision=${signal.clarity.decisionPrompt}`
      : 'clarity=missing',
  ].join(':');
}

function selectedStrategy(
  packet: MonthlyReviewValidationPacket,
): MonthlyReviewValidationPacket['strategies'][number] | null {
  const selectedPolicyId = packet.rawExportEvidence.selectedPolicy?.policyId ?? null;
  return (
    packet.strategies.find((strategy) => strategy.selectedPolicyId === selectedPolicyId) ??
    packet.strategies.find((strategy) => strategy.id === packet.recommendation.strategyId) ??
    null
  );
}

function selectedCertificationRow(
  packet: MonthlyReviewValidationPacket,
): MonthlyReviewValidationPacket['certificationSummary'][number] | null {
  const selectedPolicyId = packet.rawExportEvidence.selectedPolicy?.policyId ?? null;
  if (!selectedPolicyId) return null;
  return (
    packet.certificationSummary.find((row) => row.policyId === selectedPolicyId) ??
    null
  );
}

function certificationWasSkipped(packet: MonthlyReviewValidationPacket): boolean {
  const row = selectedCertificationRow(packet);
  const reasonText = row?.reasons.join(' ').toLowerCase() ?? '';
  const guardrailText =
    packet.rawExportEvidence.selectedPolicy?.outcome &&
    packet.rawExportEvidence.yearlyPathEvidence.length === 0
      ? packet.certificationSummary
          .flatMap((cert) => cert.reasons)
          .join(' ')
          .toLowerCase()
      : '';
  return (
    reasonText.includes('flow-debug') ||
    reasonText.includes('debug') ||
    reasonText.includes('skipped') ||
    guardrailText.includes('flow-debug') ||
    guardrailText.includes('skipped')
  );
}

function hasCoreSubstantiveEvidence(packet: MonthlyReviewValidationPacket): boolean {
  const selected = packet.rawExportEvidence.selectedPolicy;
  const strategy = selectedStrategy(packet);
  const outcome = selected?.outcome;
  const spendingPath = selected?.spendingPath;
  return !!(
    selected &&
    outcome &&
    strategy &&
    strategy.corpusEvaluationCount > 0 &&
    finiteNumber(outcome.solventSuccessRate) &&
    finiteNumber(outcome.bequestAttainmentRate) &&
    finiteNumber(outcome.p10EndingWealthTodayDollars) &&
    finiteNumber(outcome.p50EndingWealthTodayDollars)
  );
}

function requiredFinding(input: {
  id: RequiredFindingId;
  status: MonthlyReviewAiFinding['status'];
  title: string;
  detail: string;
  evidence: string[];
  recommendation?: string;
}): MonthlyReviewAiFinding {
  return {
    id: input.id,
    status: input.status,
    title: input.title,
    detail: input.detail,
    evidence: input.evidence,
    ...(input.recommendation ? { recommendation: input.recommendation } : {}),
  };
}

function buildRequiredFindings(
  packet: MonthlyReviewValidationPacket,
): MonthlyReviewAiFinding[] {
  const selected = packet.rawExportEvidence.selectedPolicy;
  const outcome = selected?.outcome;
  const spendingPath = selected?.spendingPath;
  const strategy = selectedStrategy(packet);
  const certification = selectedCertificationRow(packet);
  const legacyTarget = packet.northStar.legacyTargetTodayDollars;
  const openTasks = packet.structuralTasks.filter((task) => task.status === 'open');
  const criticalTasks = openTasks.filter((task) => task.blocksApproval);
  const warningTasks = openTasks.filter((task) => !task.blocksApproval);
  const inferredTask = openTasks.find((task) => task.code === 'assumption_provenance');
  const lifeAudit = packet.lifeModelAudit;
  const lifeAuditFailEvents =
    lifeAudit?.events.filter((event) => event.reviewStatus === 'fail') ?? [];
  const lifeAuditWatchEvents =
    lifeAudit?.events.filter((event) => event.reviewStatus === 'watch') ?? [];
  const hasSelectedOutcome = !!selected && !!outcome;
  const skippedCertification = certificationWasSkipped(packet);
  const p10BelowTarget =
    finiteNumber(outcome?.p10EndingWealthTodayDollars) &&
    outcome.p10EndingWealthTodayDollars < legacyTarget;
  const p50BelowTarget =
    finiteNumber(outcome?.p50EndingWealthTodayDollars) &&
    outcome.p50EndingWealthTodayDollars < legacyTarget;
  const bequestBelowGate =
    finiteNumber(outcome?.bequestAttainmentRate) &&
    outcome.bequestAttainmentRate < LEGACY_ATTAINMENT_GATE;
  const solvencyBelowGate =
    finiteNumber(outcome?.solventSuccessRate) &&
    outcome.solventSuccessRate < SOLVENCY_GATE;
  const boundary = strategy?.spendBoundary;
  const yearlyPathCount = packet.rawExportEvidence.yearlyPathEvidence.length;
  const householdSignals = packet.householdSignals ?? [];
  const actionSignals = householdSignals.filter(
    (signal) => signal.status === 'act_now',
  );
  const watchSignals = householdSignals.filter(
    (signal) => signal.status === 'watch',
  );

  return [
    requiredFinding({
      id: 'selected_candidate_metrics',
      status: !hasSelectedOutcome ? 'fail' : p10BelowTarget ? 'watch' : 'pass',
      title: 'Selected candidate metrics',
      detail: !hasSelectedOutcome
        ? 'The packet does not include a selected policy with outcome metrics.'
        : `The selected candidate is ${money(selected.annualSpendTodayDollars)}/yr (${money(
            selected.monthlySpendTodayDollars,
          )}/mo) as a ${
            spendingPath?.scalarMeaning === 'curve_anchor'
              ? 'curve anchor'
              : 'flat annual spend'
          }, with ${percent(outcome.solventSuccessRate)} solvency, ${percent(
            outcome.bequestAttainmentRate,
          )} legacy attainment, and p10/p25/p50/p75/p90 ending wealth of ${money(
            outcome.p10EndingWealthTodayDollars,
          )} / ${money(outcome.p25EndingWealthTodayDollars)} / ${money(
            outcome.p50EndingWealthTodayDollars,
          )} / ${money(outcome.p75EndingWealthTodayDollars)} / ${money(
            outcome.p90EndingWealthTodayDollars,
          )}.`,
      evidence: selected
        ? [
            `policyId=${selected.policyId}`,
            `annualSpendTodayDollars=${selected.annualSpendTodayDollars}`,
            `monthlySpendTodayDollars=${selected.monthlySpendTodayDollars}`,
            `solventSuccessRate=${outcome?.solventSuccessRate ?? 'missing'}`,
            `bequestAttainmentRate=${outcome?.bequestAttainmentRate ?? 'missing'}`,
            `p10EndingWealthTodayDollars=${outcome?.p10EndingWealthTodayDollars ?? 'missing'}`,
            `p25EndingWealthTodayDollars=${outcome?.p25EndingWealthTodayDollars ?? 'missing'}`,
            `p50EndingWealthTodayDollars=${outcome?.p50EndingWealthTodayDollars ?? 'missing'}`,
            `p75EndingWealthTodayDollars=${outcome?.p75EndingWealthTodayDollars ?? 'missing'}`,
            `p90EndingWealthTodayDollars=${outcome?.p90EndingWealthTodayDollars ?? 'missing'}`,
            `spendingPath.scalarMeaning=${spendingPath?.scalarMeaning ?? 'missing'}`,
            `spendingPath.firstRetirementYearAnnualSpendTodayDollars=${spendingPath?.firstRetirementYearAnnualSpendTodayDollars ?? 'missing'}`,
            `spendingPath.peakGoGoAnnualSpendTodayDollars=${spendingPath?.peakGoGoAnnualSpendTodayDollars ?? 'missing'}`,
            `spendingPath.age80AnnualSpendTodayDollars=${spendingPath?.age80AnnualSpendTodayDollars ?? 'missing'}`,
            `spendingPath.lifetimeAverageAnnualSpendTodayDollars=${spendingPath?.lifetimeAverageAnnualSpendTodayDollars ?? 'missing'}`,
          ]
        : ['selectedPolicy=null'],
      recommendation: p10BelowTarget
        ? 'Keep this as a downside-watch item: the candidate can pass the attainment gate while p10 still falls below the legacy target.'
        : undefined,
    }),
    requiredFinding({
      id: 'north_star_legacy_alignment',
      status: !hasSelectedOutcome || bequestBelowGate || solvencyBelowGate || p50BelowTarget
        ? 'fail'
        : p10BelowTarget
          ? 'watch'
          : 'pass',
      title: 'North-star legacy alignment',
      detail: !hasSelectedOutcome
        ? 'Legacy alignment cannot be checked without selected policy outcome metrics.'
        : `The north star is ${money(legacyTarget)} legacy while maximizing spend. The candidate has ${percent(
            outcome.bequestAttainmentRate,
          )} legacy attainment and median ending wealth of ${money(
            outcome.p50EndingWealthTodayDollars,
          )}; p10 ending wealth is ${money(outcome.p10EndingWealthTodayDollars)}.`,
      evidence: [
        `legacyTargetTodayDollars=${legacyTarget}`,
        `legacyGate=${LEGACY_ATTAINMENT_GATE}`,
        `solvencyGate=${SOLVENCY_GATE}`,
        `bequestAttainmentRate=${outcome?.bequestAttainmentRate ?? 'missing'}`,
        `solventSuccessRate=${outcome?.solventSuccessRate ?? 'missing'}`,
        `p10EndingWealthTodayDollars=${outcome?.p10EndingWealthTodayDollars ?? 'missing'}`,
        `p50EndingWealthTodayDollars=${outcome?.p50EndingWealthTodayDollars ?? 'missing'}`,
      ],
      recommendation:
        bequestBelowGate || solvencyBelowGate || p50BelowTarget
          ? 'Do not approve this candidate; mine or select a lower spend candidate without changing the green thresholds.'
          : p10BelowTarget
            ? 'Surface the p10 shortfall as a watch item, not as proof that the green attainment gate failed.'
            : undefined,
    }),
    requiredFinding({
      id: 'corpus_search_evidence',
      status: !strategy || strategy.corpusEvaluationCount <= 0 ? 'fail' : 'pass',
      title: 'Mined corpus evidence',
      detail: strategy
        ? `${strategy.label} has ${strategy.corpusEvaluationCount.toLocaleString()} mined evaluations attached to the review packet.`
        : 'The packet does not identify a selected strategy corpus.',
      evidence: strategy
        ? [
            `strategyId=${strategy.id}`,
            `corpusEvaluationCount=${strategy.corpusEvaluationCount}`,
            `selectedPolicyId=${strategy.selectedPolicyId ?? 'none'}`,
          ]
        : ['selectedStrategy=null'],
    }),
    requiredFinding({
      id: 'spend_boundary_evidence',
      status: !boundary || !boundary.boundaryProven ? 'fail' : 'pass',
      title: 'Spend boundary evidence',
      detail: boundary
        ? `The packet reports highest green spend of ${money(
            boundary.highestGreenSpendTodayDollars,
          )}/yr and highest tested spend of ${money(
            boundary.highestSpendTestedTodayDollars,
          )}/yr, with ${boundary.higherSpendLevelsTested.length} higher spend levels tested.`
        : 'The packet does not include spend-boundary evidence for the selected strategy.',
      evidence: boundary
        ? [
            `boundaryProven=${boundary.boundaryProven}`,
            `highestGreenSpendTodayDollars=${boundary.highestGreenSpendTodayDollars ?? 'missing'}`,
            `highestSpendTestedTodayDollars=${boundary.highestSpendTestedTodayDollars ?? 'missing'}`,
            `higherSpendLevelsTested=${boundary.higherSpendLevelsTested.join(', ') || 'none'}`,
          ]
        : ['spendBoundary=null'],
      recommendation:
        !boundary || !boundary.boundaryProven
          ? 'Run refinement high enough to prove that higher spend levels fail the approval gates.'
          : undefined,
    }),
    requiredFinding({
      id: 'certification_evidence',
      status:
        !certification ||
        certification.verdict !== 'green' ||
        skippedCertification
          ? 'fail'
          : 'pass',
      title: 'Deterministic certification evidence',
      detail: !certification
        ? 'No deterministic certification row is attached for the selected policy.'
        : skippedCertification
          ? 'The selected policy is labeled green, but the certification evidence says real certification was intentionally skipped in flow-debug mode.'
          : `The selected policy has deterministic certification verdict ${certification.verdict}.`,
      evidence: certification
        ? [
            `policyId=${certification.policyId}`,
            `certificationVerdict=${certification.verdict}`,
            ...certification.reasons.slice(0, 3).map((reason) => `reason=${reason}`),
          ]
        : ['certificationSummary=missing'],
      recommendation:
        !certification || certification.verdict !== 'green' || skippedCertification
          ? 'Rerun real deterministic certification for the same selected policy before approval.'
          : undefined,
    }),
    requiredFinding({
      id: 'assumption_provenance',
      status: inferredTask ? 'watch' : 'pass',
      title: 'Assumption provenance',
      detail: inferredTask
        ? inferredTask.detail
        : 'The packet does not report open inferred-assumption tasks for the selected review.',
      evidence: inferredTask
        ? [`taskId=${inferredTask.id}`, ...inferredTask.evidence.slice(0, 5)]
        : ['assumptionProvenanceTasks=0'],
      recommendation: inferredTask?.suggestedFix,
    }),
    requiredFinding({
      id: 'life_model_trace',
      status: !lifeAudit
        ? 'fail'
        : lifeAuditFailEvents.length > 0
          ? 'fail'
          : lifeAuditWatchEvents.length > 0
            ? 'watch'
            : 'pass',
      title: 'Life-to-model money movement trace',
      detail: !lifeAudit
        ? 'The packet does not include a household life-event trace, so the reviewer can inspect model mechanics but not whether the money story is complete.'
        : lifeAuditFailEvents.length > 0
          ? `${lifeAuditFailEvents.length} life-event trace item(s) have missing material source, timing, tax, destination, spending-use, or investment-policy assumptions.`
          : lifeAuditWatchEvents.length > 0
            ? `${lifeAuditWatchEvents.length} life-event trace item(s) rely on inferred or estimated household assumptions.`
            : 'The packet traces major household inflows, outflows, taxes, destinations, and investment treatment with no unresolved life-model gaps.',
      evidence: lifeAudit
        ? [
            `modelCompleteness=${lifeAudit.modelCompleteness}`,
            `unresolvedEventCount=${lifeAudit.unresolvedEventCount}`,
            `materialUnresolvedEventCount=${lifeAudit.materialUnresolvedEventCount}`,
            ...lifeAudit.events
              .filter((event) => event.reviewStatus !== 'pass')
              .slice(0, 8)
              .map(
                (event) =>
                  `${event.id}:${event.reviewStatus}:${event.steps
                    .filter((step) => step.status !== 'explicit')
                    .map((step) => `${step.id}=${step.status}`)
                    .join('|')}`,
              ),
          ]
        : ['lifeModelAudit=missing'],
      recommendation:
        !lifeAudit || lifeAuditFailEvents.length > 0
          ? 'Do not rely on the monthly recommendation until material life events have explicit source, timing, tax treatment, destination, spending-use, and investment-policy fields.'
          : lifeAuditWatchEvents.length > 0
            ? 'Review inferred or estimated life-event assumptions and either confirm them as household decisions or convert them to explicit seed/rule inputs.'
            : undefined,
    }),
    requiredFinding({
      id: 'yearly_path_evidence',
      status: yearlyPathCount > 0 ? 'pass' : 'watch',
      title: 'Yearly path evidence',
      detail:
        yearlyPathCount > 0
          ? `The packet includes ${yearlyPathCount} yearly path rows for asset-path inspection.`
          : 'The packet does not include yearly path rows, so the reviewer can check summary metrics but not the year-by-year path.',
      evidence: [`yearlyPathRows=${yearlyPathCount}`],
      recommendation:
        yearlyPathCount > 0
          ? undefined
          : 'Attach a compact yearly path excerpt from the real certification pack.',
    }),
    requiredFinding({
      id: 'withdrawal_tax_healthcare_evidence',
      status:
        selected &&
        selected.withdrawalRule &&
        finiteNumber(outcome?.medianLifetimeFederalTaxTodayDollars) &&
        finiteNumber(outcome?.irmaaExposureRate)
          ? 'pass'
          : 'watch',
      title: 'Withdrawal, tax, and healthcare evidence',
      detail: selected
        ? `The packet reports withdrawal rule ${selected.withdrawalRule ?? 'missing'}, Roth conversion cap ${money(
            selected.rothConversionAnnualCeiling,
          )}, median lifetime federal tax ${money(
            outcome?.medianLifetimeFederalTaxTodayDollars,
          )}, and IRMAA exposure ${percent(outcome?.irmaaExposureRate)}.`
        : 'Withdrawal, tax, and healthcare fields cannot be checked without a selected policy.',
      evidence: selected
        ? [
            `withdrawalRule=${selected.withdrawalRule ?? 'missing'}`,
            `rothConversionAnnualCeiling=${selected.rothConversionAnnualCeiling}`,
            `medianLifetimeFederalTaxTodayDollars=${outcome?.medianLifetimeFederalTaxTodayDollars ?? 'missing'}`,
            `irmaaExposureRate=${outcome?.irmaaExposureRate ?? 'missing'}`,
          ]
        : ['selectedPolicy=null'],
      recommendation:
        selected?.withdrawalRule &&
        finiteNumber(outcome?.medianLifetimeFederalTaxTodayDollars) &&
        finiteNumber(outcome?.irmaaExposureRate)
          ? undefined
              : 'Include withdrawal rule, conversion cap, tax, and IRMAA fields in every selected-candidate packet.',
    }),
    requiredFinding({
      id: 'household_signal_checklist',
      status:
        actionSignals.length > 0
          ? 'watch'
          : householdSignals.length === 0
            ? 'watch'
            : 'pass',
      title: 'Household signal checklist',
      detail:
        householdSignals.length > 0
          ? `The packet includes ${householdSignals.length} household QA signal(s): ${householdSignals
              .map((signal) =>
                `${signal.title}=${signal.status}${
                  signal.clarity ? `/${signal.clarity.disposition}` : ''
                }`,
              )
              .join('; ')}. For every act-now/watch signal, the review must explain whether this is a real remediation item, an accepted tradeoff candidate, a known planning decision, a data gap, or a possible model bug.`
          : 'The packet does not include deterministic household QA signals such as ACA bridge, cash runway, concentration, and legacy headroom.',
      evidence:
        householdSignals.length > 0
          ? householdSignals.map(signalClarityEvidence)
          : ['householdSignals=missing'],
      recommendation:
        actionSignals.length > 0
          ? `Surface and triage act-now household signals before approval: ${actionSignals
              .map((signal) => signal.title)
              .join(', ')}. If a signal has a knownDecision, say it is expected and restate the rationale; if it is merely acceptable, say what tradeoff justifies accepting it and what evidence would make it a model bug instead.`
          : watchSignals.length > 0
            ? `Surface watch household signals: ${watchSignals
                .map((signal) => signal.title)
                .join(', ')}.`
            : undefined,
    }),
    requiredFinding({
      id: 'model_tasks',
      status: criticalTasks.length > 0 ? 'fail' : warningTasks.length > 0 ? 'watch' : 'pass',
      title: 'Open model tasks',
      detail:
        criticalTasks.length > 0
          ? `${criticalTasks.length} critical open model task(s) block approval.`
          : warningTasks.length > 0
            ? `${warningTasks.length} warning model task(s) should be reviewed but do not block approval.`
            : 'There are no open model tasks in the validation packet.',
      evidence:
        openTasks.length > 0
          ? openTasks.map((task) => `${task.id}:${task.severity}:${task.blocksApproval}`)
          : ['openModelTasks=0'],
      recommendation:
        criticalTasks.length > 0
          ? 'Resolve critical model tasks before adopting the recommendation.'
          : undefined,
    }),
  ];
}

function mergeChecklistFindings(input: {
  packet: MonthlyReviewValidationPacket;
  parsedFindings: MonthlyReviewAiFinding[];
}): MonthlyReviewAiFinding[] {
  const parsedById = new Map(
    input.parsedFindings.map((finding) => [finding.id, finding]),
  );
  const required = buildRequiredFindings(input.packet).map((finding) => {
    const aiFinding = parsedById.get(finding.id);
    if (!aiFinding) return finding;
    return {
      ...finding,
      status: finding.status === 'fail' ? 'fail' : aiFinding.status,
      title: aiFinding.title || finding.title,
      detail: aiFinding.detail || finding.detail,
      evidence: Array.from(new Set([...finding.evidence, ...aiFinding.evidence])),
      recommendation: aiFinding.recommendation || finding.recommendation,
    };
  });
  const requiredIds = new Set<string>(REQUIRED_FINDING_IDS);
  const extras = input.parsedFindings.filter(
    (finding) => !requiredIds.has(finding.id),
  );
  return [...required, ...extras];
}

function normalizeVerdict(input: {
  packet?: MonthlyReviewValidationPacket;
  requestedVerdict: MonthlyReviewAiVerdict;
  findings: MonthlyReviewAiFinding[];
}): MonthlyReviewAiVerdict {
  if (!input.packet) return input.requestedVerdict;
  const packet = input.packet;
  const selected = packet.rawExportEvidence.selectedPolicy;
  const strategy = selectedStrategy(packet);
  const outcome = selected?.outcome;
  const certification = selectedCertificationRow(packet);
  const skippedCertification = certificationWasSkipped(packet);
  const coreEvidencePresent = hasCoreSubstantiveEvidence(packet);
  const hasCriticalTask = packet.structuralTasks.some(
    (task) => task.status === 'open' && task.blocksApproval,
  );
  if (!selected || !strategy || strategy.corpusEvaluationCount <= 0 || !outcome) {
    return 'insufficient_data';
  }
  if (!coreEvidencePresent) return 'insufficient_data';
  const selectedFailsNorthStar =
    (finiteNumber(outcome.solventSuccessRate) &&
      outcome.solventSuccessRate < SOLVENCY_GATE) ||
    (finiteNumber(outcome.bequestAttainmentRate) &&
      outcome.bequestAttainmentRate < LEGACY_ATTAINMENT_GATE) ||
    (finiteNumber(outcome.p50EndingWealthTodayDollars) &&
      outcome.p50EndingWealthTodayDollars <
        packet.northStar.legacyTargetTodayDollars) ||
    (!!certification && certification.verdict !== 'green');
  if (selectedFailsNorthStar) return 'misaligned';
  if (
    skippedCertification ||
    hasCriticalTask ||
    input.findings.some((finding) => finding.status === 'fail')
  ) {
    return 'watch';
  }
  return input.requestedVerdict === 'aligned' || input.requestedVerdict === 'watch'
    ? input.requestedVerdict
    : 'aligned';
}

export function parseMonthlyReviewAiJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new MonthlyReviewAiError(
      'OpenAI returned an empty response',
      'empty_ai_response',
      502,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new MonthlyReviewAiError(
      'OpenAI response was not valid JSON',
      'bad_ai_json',
      502,
    );
  }
}

function sanitizeFinding(value: unknown, fallbackId: string): MonthlyReviewAiFinding | null {
  const r = asRecord(value);
  const title = asString(r.title);
  const detail = asString(r.detail);
  if (!title || !detail) return null;
  const statusRaw = asString(r.status, 'watch');
  const status = VALID_FINDING_STATUSES.has(statusRaw)
    ? (statusRaw as MonthlyReviewAiFinding['status'])
    : 'watch';
  const recommendation = asString(r.recommendation);
  return {
    id: asString(r.id, fallbackId),
    status,
    title,
    detail,
    evidence: asStringArray(r.evidence),
    ...(recommendation ? { recommendation } : {}),
  };
}

export function sanitizeMonthlyReviewAiApproval(
  payload: unknown,
  context: {
    model: string;
    generatedAtIso: string;
    rawResponseText?: string;
    packet?: MonthlyReviewValidationPacket;
  },
): MonthlyReviewAiApproval {
  const r = asRecord(payload);
  const verdictRaw = asString(r.verdict, 'insufficient_data') as MonthlyReviewAiVerdict;
  const requestedVerdict = VALID_VERDICTS.has(verdictRaw)
    ? verdictRaw
    : 'insufficient_data';
  const confidenceRaw = asString(r.confidence, 'low');
  const confidence = VALID_CONFIDENCE.has(confidenceRaw)
    ? (confidenceRaw as MonthlyReviewAiApproval['confidence'])
    : 'low';
  const parsedFindings = Array.isArray(r.findings)
    ? r.findings
        .map((finding, index) => sanitizeFinding(finding, `finding_${index + 1}`))
        .filter((finding): finding is MonthlyReviewAiFinding => !!finding)
    : [];
  const summary =
    asString(r.summary) ||
    'AI review completed but did not include a summary.';
  const fallbackFindings =
    parsedFindings.length > 0
      ? parsedFindings
      : context.packet
        ? []
        : [
          {
            id: 'ai_summary_only',
            status: requestedVerdict === 'misaligned' || requestedVerdict === 'insufficient_data'
              ? 'fail'
              : 'watch',
            title: 'AI returned summary without detailed findings',
            detail: summary,
            evidence: ['findings=[]'],
            recommendation:
              'Rerun the review; the packet and raw response are available in the Monthly Review panel for debugging.',
          } satisfies MonthlyReviewAiFinding,
        ];
  const findings = context.packet
    ? mergeChecklistFindings({
        packet: context.packet,
        parsedFindings: fallbackFindings,
      })
    : fallbackFindings;
  const verdict = normalizeVerdict({
    packet: context.packet,
    requestedVerdict,
    findings,
  });
  const actionItems = asStringArray(r.actionItems);
  const fallbackActionItems = findings
    .filter((finding) => finding.status !== 'pass' && finding.recommendation)
    .map((finding) => finding.recommendation as string);

  return {
    verdict,
    confidence,
    summary,
    findings,
    actionItems: actionItems.length > 0 ? actionItems : fallbackActionItems,
    model: context.model,
    generatedAtIso: context.generatedAtIso,
    ...(context.rawResponseText ? { rawResponseText: context.rawResponseText } : {}),
  };
}

function buildPrompt(packet: MonthlyReviewValidationPacket): string {
  return `You are the co-equal AI reviewer for a household monthly retirement review.

North star: mimic a careful financial advisor to the best of your ability while staying inside the evidence. Prioritize issues, explain tradeoffs, identify what is known vs unknown, suggest concrete next actions, and make the household decision points explicit. Do not invent facts, do not treat your suggestions as household decisions, and do not imply professional authority beyond model-backed decision support.

Use only the structured validation packet. Do not approve if deterministic certification failed, critical model tasks remain, the spend boundary is unproven, or evidence is insufficient. Do not change the household goals, assumptions, or thresholds.

Always complete the fixed checklist below. Use these exact finding ids once each, in this order:
1. selected_candidate_metrics
2. north_star_legacy_alignment
3. corpus_search_evidence
4. spend_boundary_evidence
5. certification_evidence
6. assumption_provenance
7. life_model_trace
8. yearly_path_evidence
9. withdrawal_tax_healthcare_evidence
10. household_signal_checklist
11. model_tasks

After the fixed checklist, add one additional finding per act_now or watch signal in packet.householdSignals using id "signal_<signal_id>" (e.g. "signal_aca_bridge_breach"). For each such signal, write a substantive standalone analysis — not a restatement of the headline. Cover: (a) why the household is in this situation given the plan specifics (the backstory), (b) how this connects to the selected spending level and portfolio decisions, (c) what resolves it — the concrete next step or decision the household needs to make, and (d) what would indicate this is a model/data bug rather than a real issue. If knownDecision is present, explain what would have to change for that decision to become wrong or a surprise. If it is absent, say the household has not yet stated their intent and offer two or three likely resolution paths. ok signals do not need a dedicated finding.

Verdict rules:
- "aligned" means every required check passes, the selected candidate is green-certified by real deterministic certification, the spend boundary is proven, and no critical model tasks are open.
- "watch" means the packet is substantively reviewable and the candidate may be directionally plausible, but one or more non-approval caveats remain. Flow-debug/skipped certification belongs here when selected policy, corpus, outcome metrics, and boundary evidence are otherwise present. It still blocks approval through the certification finding.
- "insufficient_data" means selected policy, mined corpus, selected outcome metrics, certification row, or spend-boundary evidence is absent enough that a substantive review cannot be performed.
- "misaligned" means the evidence shows the selected candidate fails the north-star legacy/solvency gates or materially conflicts with the objective.

For every run, explicitly report p10, p25, p50, p75, and p90 ending wealth when present, and compare p10 and p50 to northStar.legacyTargetTodayDollars. A p10 value below the legacy target is a watch item when the deterministic legacy-attainment gate still passes; it is not by itself proof of failure.

For every run, inspect packet.householdSignals. The household_signal_checklist finding should give a brief roll-up: list each signal, its status, and one sentence on disposition. Full per-signal analysis belongs in the dedicated signal_<id> findings that follow the fixed checklist — do not repeat that depth here. Do not treat every breached gate as automatic plan failure.

Advisor-like review means each material issue should read as one of: "known/accepted", "real problem needing a decision", "model/data bug risk", "monitor", or "AI suggestion". Make the category plain in the finding detail.

Life-to-model review is mandatory, not optional. Inspect packet.lifeModelAudit as the household financial story the model claims to represent. Trace each major money movement from source to timing to tax treatment to destination account to spending use to investment/future-return treatment. For windfalls and home-sale proceeds, explicitly state whether the model knows what happens after the cash arrives: spent, held as reserve, deployed to taxable, invested using the current portfolio mix, or left to an inferred/default policy. If a life event is internally consistent but its destination or household intent is inferred, call that out as a life-model gap rather than a code bug. If packet.lifeModelAudit is missing or any high/medium material event has missing source, timing, tax, destination, spending-use, or investment policy, do not approve.

For the ACA bridge signal specifically, distinguish "subsidy loss is an intentional tradeoff" from "the model is wrong." It may be okay if the extra MAGI buys something explicit, such as higher certified spending, Roth conversion/tax positioning, capital-gain harvesting, or simpler liquidity, and if the selected path includes net ACA cost. It is a model-bug concern if MAGI components are missing or double-counted, ACA/FPL thresholds are stale, ages/salary-end dates are wrong, or premium/subsidy/net ACA cost is missing from selected path evidence.

Excess legacy headroom means the household may be leaving too much on the table; do not describe it as depletion or homelessness risk.

For shaped spending strategies such as J.P. Morgan, do not compare the policy scalar directly to a flat-spend strategy as if both numbers meant annual household spending. Use rawExportEvidence.selectedPolicy.spendingPath: report scalarMeaning, first-retirement-year spend, peak go-go spend, age-75/80/85 spend, and lifetime average spend. Treat the scalar as a curve anchor when scalarMeaning is "curve_anchor"; judge whether the actual early-retirement spend path supports the north-star objective.

Write the summary and finding details like a human reviewer explaining what they see: name the candidate spend, whether the mined corpus is present, what proof is missing, and the next concrete step. Avoid terse boilerplate.

Return only valid JSON with this shape:
{
  "verdict": "aligned" | "watch" | "misaligned" | "insufficient_data",
  "confidence": "low" | "medium" | "high",
  "summary": "2-4 sentence human-readable review summary",
  "findings": [
    {
      "id": "snake_case",
      "status": "pass" | "watch" | "fail",
      "title": "short title",
      "detail": "evidence-grounded explanation in plain English",
      "evidence": ["specific values from packet"],
      "recommendation": "optional next action"
    }
  ],
  "actionItems": ["short concrete task"]
}

Validation packet:
${JSON.stringify(packet, null, 2)}`;
}

export async function runMonthlyReviewAiApproval({
  packet,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.MONTHLY_REVIEW_AI_MODEL ||
    process.env.MINING_NORTH_STAR_AI_MODEL ||
    MONTHLY_REVIEW_AI_DEFAULT_MODEL,
  reasoningEffort = process.env.MONTHLY_REVIEW_AI_REASONING_EFFORT ||
    process.env.MINING_NORTH_STAR_AI_REASONING_EFFORT ||
    MONTHLY_REVIEW_AI_DEFAULT_REASONING_EFFORT,
}: RunMonthlyReviewAiApprovalArgs): Promise<MonthlyReviewAiApproval> {
  if (!apiKey) {
    throw new MonthlyReviewAiError(
      'OPENAI_API_KEY is not set for the dispatcher process',
      'missing_openai_api_key',
      503,
    );
  }

  const generatedAtIso = new Date().toISOString();
  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model,
    reasoning: {
      effort: reasoningEffort as 'low' | 'medium' | 'high',
    },
    input: buildPrompt(packet),
  });
  return sanitizeMonthlyReviewAiApproval(parseMonthlyReviewAiJson(response.output_text), {
    model,
    generatedAtIso,
    rawResponseText: response.output_text,
    packet,
  });
}
