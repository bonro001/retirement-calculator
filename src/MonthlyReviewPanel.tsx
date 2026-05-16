import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MonthlyReviewAiFinding,
  type MonthlyReviewCertification,
  type MonthlyReviewModelTask,
  type MonthlyReviewQaSignal,
  type MonthlyReviewRun,
  type MonthlyReviewStrategyId,
  type MonthlyReviewValidationPacket,
} from './monthly-review';
import {
  MONTHLY_REVIEW_POLICY_TRIAL_BUDGET,
  MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION,
} from './monthly-review-flow-debug';
import {
  loadClusterModelHealthJob,
  loadClusterMonthlyReviewJob,
  startClusterModelHealthJob,
  startClusterMonthlyReviewJob,
  type ClusterModelHealthJobPayload,
  type ClusterMonthlyReviewJob,
} from './policy-mining-cluster';
import { setBrowserHostMode } from './cluster-client';
import { PolicyAdoptionModal } from './PolicyAdoptionModal';
import { useAppStore } from './store';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import type { SnapshotPeer } from './cluster-peer-view';
import {
  useClusterSession,
  type UseClusterSession,
} from './useClusterSession';
import {
  buildNorthStarBudgetFromCertification,
  type NorthStarBudget,
} from './north-star-budget';

type MonthlyReviewStage =
  | 'idle'
  | 'connecting'
  | 'mining'
  | 'certifying'
  | 'ai_review'
  | 'complete'
  | 'failed';

type StepStatus = 'waiting' | 'active' | 'done' | 'failed';
type FailedReviewStep = 'mine' | 'certify' | 'ai' | null;
type ModelHealthPreflightState =
  | { kind: 'idle' }
  | { kind: 'running'; message: string }
  | { kind: 'failed'; reason: string; command: string };
type AiReviewProgressStatus = 'waiting' | 'active' | 'done' | 'failed';
type AiReviewProgressStepId =
  | 'packet_prepared'
  | 'sent_to_model'
  | 'model_response'
  | 'checklist_merged'
  | 'verdict_ready';

interface Props {
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string | null;
  engineVersion: string;
  dispatcherUrl: string | null;
  legacyTargetTodayDollars: number;
  baselinePath?: PathResult | null;
  selectedStrategyId?: MonthlyReviewStrategyId;
  onProgressStageChange?: (stage: MonthlyReviewStage) => void;
}

interface ReviewTransactionEvent {
  id: number;
  atIso: string;
  message: string;
}

interface CertificationSlot {
  candidateId: string;
  annualSpendTodayDollars: number;
  status: 'running' | 'done';
  mode: 'node_host' | 'dry_run';
  hostPeerId?: string | null;
  hostDisplayName?: string | null;
  completed: number;
  total: number;
  startedAtIso: string;
  verdict: MonthlyReviewCertification['verdict'] | null;
  reasons: Array<{ code: string; message: string }>;
}

interface MiningSnapshot {
  evaluationCount: number;
  spendMin: number | null;
  spendMax: number | null;
  feasibleCount: number | null;
  source?: 'run';
}

interface AiReviewProgressStep {
  id: AiReviewProgressStepId;
  title: string;
  detail: string;
  status: AiReviewProgressStatus;
  atIso: string | null;
}

const LEGACY_MONTHLY_REVIEW_STORAGE_KEYS = [
  'monthly-review:last-ai-validation-packet',
  'monthly-review:last-ai-response',
  'monthly-review:last-run',
  'monthly-review:last-mining-snapshot',
  'monthly-review:last-transaction-events',
] as const;
const MONTHLY_REVIEW_STORAGE_PREFIX = 'monthly-review:v2';
const LAST_AI_PACKET_KEY = `${MONTHLY_REVIEW_STORAGE_PREFIX}:last-ai-validation-packet`;
const LAST_AI_RESPONSE_KEY = `${MONTHLY_REVIEW_STORAGE_PREFIX}:last-ai-response`;
const LAST_RUN_KEY = `${MONTHLY_REVIEW_STORAGE_PREFIX}:last-run`;
const LAST_MINING_SNAPSHOT_KEY = `${MONTHLY_REVIEW_STORAGE_PREFIX}:last-mining-snapshot`;
const LAST_TRANSACTION_EVENTS_KEY = `${MONTHLY_REVIEW_STORAGE_PREFIX}:last-transaction-events`;
const MODEL_HEALTH_MAX_AGE_HOURS = 72;
let legacyMonthlyReviewStorageCleared = false;

function initialAiReviewProgress(): AiReviewProgressStep[] {
  return [
    {
      id: 'packet_prepared',
      title: 'Validation packet prepared',
      detail: 'Waiting for certification to finish.',
      status: 'waiting',
      atIso: null,
    },
    {
      id: 'sent_to_model',
      title: 'Reviewing the validation packet',
      detail: 'Waiting to send the packet to the model.',
      status: 'waiting',
      atIso: null,
    },
    {
      id: 'model_response',
      title: 'Model response received',
      detail: 'Waiting for the reviewer response.',
      status: 'waiting',
      atIso: null,
    },
    {
      id: 'checklist_merged',
      title: 'Checklist merged',
      detail: 'Waiting to merge AI findings with household signals.',
      status: 'waiting',
      atIso: null,
    },
    {
      id: 'verdict_ready',
      title: 'Verdict ready',
      detail: 'Waiting for final co-review verdict.',
      status: 'waiting',
      atIso: null,
    },
  ];
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatCurrency(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—';
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (Math.abs(amount) >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  return `$${Math.round(amount)}`;
}

function annualSpendWithTravelOverlay(
  annualCoreSpend: number | null,
  annualTravelOverlay: number,
): number | null {
  if (annualCoreSpend === null || !Number.isFinite(annualCoreSpend)) return null;
  return annualCoreSpend + Math.max(0, annualTravelOverlay);
}

function formatMonthly(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—';
  return `$${Math.round(amount).toLocaleString()}/mo`;
}

function formatMonthlyDelta(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—';
  if (Math.abs(amount) < 0.5) return '$0/mo';
  const sign = amount > 0 ? '+' : '-';
  return `${sign}${formatMonthly(Math.abs(amount))}`;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMinutes}m`;
}

function formatShortTime(value: number | string | null | undefined): string {
  if (value == null) return '--:--';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return '--:--';
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function modelHealthReportNeedsRefresh(
  payload: ClusterModelHealthJobPayload | null,
): boolean {
  const report = payload?.report ?? null;
  if (!report) return true;
  if (report.status !== 'passed') return true;
  const generatedAt = report.generatedAt ? Date.parse(report.generatedAt) : NaN;
  if (!Number.isFinite(generatedAt)) return true;
  return Date.now() - generatedAt > MODEL_HEALTH_MAX_AGE_HOURS * 60 * 60 * 1_000;
}

function modelHealthPuckMessage(payload: ClusterModelHealthJobPayload | null): string {
  const jobLine = payload?.job?.logTail.at(-1);
  if (jobLine) return jobLine;
  const report = payload?.report;
  if (report?.status === 'failed') return 'Latest Model Health report failed; rerunning before mining.';
  return 'Validating Model Health before mining.';
}

function parseYearFromIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function deflateNominalYearValue(
  value: number,
  year: number,
  baseYear: number,
  inflation: number,
): number {
  if (!Number.isFinite(value)) return 0;
  const years = Math.max(0, year - baseYear);
  return value / Math.pow(1 + inflation, years);
}

const BOLDIN_PLANNED_MONTHLY_TODAY_DOLLARS = 13_205;
const BOLDIN_SAFE_TARGET_MONTHLY_TODAY_DOLLARS = 14_915;

interface BoldinStyleSpendingComparison {
  currentPlanBudgetMonthly: number;
  currentPlanBudgetAnnual: number;
  currentPlanTraceYear: number | null;
  currentPlanEngineSpendingMonthly: number | null;
  currentPlanFederalTaxMonthly: number | null;
  currentPlanCashOutflowMonthly: number | null;
  selectedTraceYear: number | null;
  selectedEngineSpendingMonthly: number | null;
  selectedFederalTaxMonthly: number | null;
  selectedCashOutflowMonthly: number | null;
}

function buildBoldinStyleSpendingComparison(input: {
  data: SeedData;
  baselinePath: PathResult | null | undefined;
  currentPlanBudget: NorthStarBudget | null | undefined;
  selectedCertification: MonthlyReviewCertification | null;
  selectedSpendingPath: NonNullable<
    MonthlyReviewValidationPacket['rawExportEvidence']['selectedPolicy']
  >['spendingPath'] | null;
  inflation: number;
}): BoldinStyleSpendingComparison {
  const currentPlanBudgetAnnual =
    Math.max(0, input.data.spending.essentialMonthly ?? 0) * 12 +
    Math.max(0, input.data.spending.optionalMonthly ?? 0) * 12 +
    Math.max(0, input.data.spending.annualTaxesInsurance ?? 0) +
    Math.max(0, input.data.spending.travelEarlyRetirementAnnual ?? 0);
  const yearlyRows = input.selectedCertification?.pack.selectedPathEvidence?.yearlyRows ?? [];
  const baseYear = yearlyRows[0]?.year ?? null;
  const retirementYear =
    input.selectedSpendingPath?.retirementYear ??
    parseYearFromIso(input.data.income.salaryEndDate);
  const baselineRows = input.baselinePath?.yearlySeries ?? [];
  const baselineBaseYear = baselineRows[0]?.year ?? null;
  const currentPlanTraceRow =
    baselineRows.find((row) => retirementYear === null || row.year >= retirementYear) ??
    baselineRows[0] ??
    null;
  const packetCurrentPlanBudget =
    input.currentPlanBudget?.totalAnnualBudget !== null &&
    input.currentPlanBudget?.totalAnnualBudget !== undefined
      ? input.currentPlanBudget
      : null;
  const currentPlanEngineSpendingAnnual =
    packetCurrentPlanBudget
      ? packetCurrentPlanBudget.spendAndHealthAnnual
    : currentPlanTraceRow && baselineBaseYear !== null
      ? deflateNominalYearValue(
          currentPlanTraceRow.medianSpending,
          currentPlanTraceRow.year,
          baselineBaseYear,
          input.inflation,
        )
      : null;
  const currentPlanFederalTaxAnnual =
    packetCurrentPlanBudget
      ? packetCurrentPlanBudget.federalTaxAnnual
    : currentPlanTraceRow && baselineBaseYear !== null
      ? deflateNominalYearValue(
          currentPlanTraceRow.medianFederalTax,
          currentPlanTraceRow.year,
          baselineBaseYear,
          input.inflation,
        )
      : null;
  const selectedTraceRow =
    yearlyRows.find((row) => retirementYear === null || row.year >= retirementYear) ??
    yearlyRows[0] ??
    null;
  const selectedEngineSpendingAnnual =
    selectedTraceRow && baseYear !== null
      ? deflateNominalYearValue(
          selectedTraceRow.medianSpending,
          selectedTraceRow.year,
          baseYear,
          input.inflation,
        )
      : null;
  const selectedFederalTaxAnnual =
    selectedTraceRow && baseYear !== null
      ? deflateNominalYearValue(
          selectedTraceRow.medianFederalTax,
          selectedTraceRow.year,
          baseYear,
          input.inflation,
        )
      : null;

  return {
    currentPlanBudgetMonthly: currentPlanBudgetAnnual / 12,
    currentPlanBudgetAnnual,
    currentPlanTraceYear: packetCurrentPlanBudget?.year ?? currentPlanTraceRow?.year ?? null,
    currentPlanEngineSpendingMonthly:
      currentPlanEngineSpendingAnnual === null
        ? null
        : currentPlanEngineSpendingAnnual / 12,
    currentPlanFederalTaxMonthly:
      currentPlanFederalTaxAnnual === null ? null : currentPlanFederalTaxAnnual / 12,
    currentPlanCashOutflowMonthly:
      packetCurrentPlanBudget
        ? packetCurrentPlanBudget.totalMonthlyBudget
        : currentPlanEngineSpendingAnnual === null || currentPlanFederalTaxAnnual === null
          ? null
          : (currentPlanEngineSpendingAnnual + currentPlanFederalTaxAnnual) / 12,
    selectedTraceYear: selectedTraceRow?.year ?? null,
    selectedEngineSpendingMonthly:
      selectedEngineSpendingAnnual === null ? null : selectedEngineSpendingAnnual / 12,
    selectedFederalTaxMonthly:
      selectedFederalTaxAnnual === null ? null : selectedFederalTaxAnnual / 12,
    selectedCashOutflowMonthly:
      selectedEngineSpendingAnnual === null || selectedFederalTaxAnnual === null
        ? null
        : (selectedEngineSpendingAnnual + selectedFederalTaxAnnual) / 12,
  };
}

// ─── Step status helpers ──────────────────────────────────────────────────────

function failedStepForStage(stage: MonthlyReviewStage): FailedReviewStep {
  if (stage === 'certifying') return 'certify';
  if (stage === 'ai_review') return 'ai';
  return 'mine';
}

function stepStatusForMine(
  stage: MonthlyReviewStage,
  failedStep: FailedReviewStep,
): StepStatus {
  if (stage === 'idle') return 'waiting';
  if (stage === 'connecting' || stage === 'mining') return 'active';
  if (stage === 'failed') return failedStep === 'mine' ? 'failed' : 'done';
  return 'done';
}

function stepStatusForCertify(
  stage: MonthlyReviewStage,
  failedStep: FailedReviewStep,
): StepStatus {
  if (stage === 'idle' || stage === 'connecting' || stage === 'mining') return 'waiting';
  if (stage === 'certifying') return 'active';
  if (stage === 'failed') {
    if (failedStep === 'certify') return 'failed';
    return failedStep === 'ai' ? 'done' : 'waiting';
  }
  return 'done';
}

function stepStatusForTradeoffs(
  stage: MonthlyReviewStage,
  failedStep: FailedReviewStep,
): StepStatus {
  if (stage === 'idle' || stage === 'connecting' || stage === 'mining' || stage === 'certifying') {
    return 'waiting';
  }
  if (stage === 'failed') {
    if (failedStep === 'certify') return 'failed';
    return failedStep === 'ai' ? 'done' : 'waiting';
  }
  return 'done';
}

function stepStatusForAi(
  stage: MonthlyReviewStage,
  failedStep: FailedReviewStep,
): StepStatus {
  if (stage === 'idle' || stage === 'connecting' || stage === 'mining' || stage === 'certifying') return 'waiting';
  if (stage === 'ai_review') return 'active';
  if (stage === 'failed') return failedStep === 'ai' ? 'failed' : 'waiting';
  return 'done';
}

function stepStatusForAnswer(stage: MonthlyReviewStage): StepStatus {
  if (stage !== 'complete') return 'waiting';
  return 'done';
}

// ─── Step card shell ──────────────────────────────────────────────────────────

function StepCard({
  n,
  title,
  status,
  collapsible = false,
  collapsed = false,
  collapsedSummary,
  onCollapsedChange,
  children,
}: {
  n: number;
  title: string;
  status: StepStatus;
  collapsible?: boolean;
  collapsed?: boolean;
  collapsedSummary?: React.ReactNode;
  onCollapsedChange?: (collapsed: boolean) => void;
  children?: React.ReactNode;
}): JSX.Element {
  const borderColor =
    status === 'done'
      ? 'border-emerald-200'
      : status === 'active'
        ? 'border-blue-300'
        : status === 'failed'
          ? 'border-rose-200'
          : 'border-stone-200';

  const bgColor =
    status === 'done'
      ? 'bg-emerald-50/60'
      : status === 'active'
        ? 'bg-blue-50/60'
        : status === 'failed'
          ? 'bg-rose-50/60'
          : 'bg-white/50';

  const circleColor =
    status === 'done'
      ? 'bg-emerald-500 text-white'
      : status === 'active'
        ? 'bg-blue-600 text-white'
        : status === 'failed'
          ? 'bg-rose-500 text-white'
          : 'bg-stone-200 text-stone-400';

  const titleColor = status === 'waiting' ? 'text-stone-400' : 'text-stone-900';

  const badgeColor =
    status === 'done'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'active'
        ? 'bg-blue-100 text-blue-700'
        : status === 'failed'
          ? 'bg-rose-100 text-rose-700'
          : 'bg-stone-100 text-stone-400';

  const badgeLabel =
    status === 'done' ? 'done' : status === 'active' ? 'running' : status === 'failed' ? 'failed' : 'waiting';
  const hasBody = status !== 'waiting' && !!children;
  const bodyCollapsed = collapsible && collapsed && hasBody;

  return (
    <div className={`overflow-hidden rounded-xl border ${borderColor} ${bgColor} transition-colors duration-300`}>
      {/* Header row — always present */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${circleColor}`}
        >
          {status === 'done' ? '✓' : status === 'failed' ? '!' : n}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${titleColor}`}>{title}</p>
          {bodyCollapsed && collapsedSummary && (
            <p className="mt-0.5 truncate text-[11px] tabular-nums text-stone-500">
              {collapsedSummary}
            </p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${badgeColor}`}
        >
          {badgeLabel}
        </span>
        {collapsible && hasBody && (
          <button
            type="button"
            aria-expanded={!bodyCollapsed}
            onClick={() => onCollapsedChange?.(!collapsed)}
            className="shrink-0 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-500 transition hover:border-stone-300 hover:bg-stone-50 hover:text-stone-700"
          >
            {bodyCollapsed ? 'Show' : 'Hide'}
          </button>
        )}
      </div>

      {/* Body — only rendered when not waiting */}
      {hasBody && (
        <div
          aria-hidden={bodyCollapsed}
          className={`grid transition-[grid-template-rows,opacity] duration-500 ease-in-out ${
            bodyCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="border-t border-stone-100 px-4 py-3 text-[12px]">
              {children}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SpendingComparisonStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element {
  return (
    <div className="rounded-lg bg-white/80 px-3 py-2 ring-1 ring-amber-100">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-800">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-stone-950">
        {value}
      </p>
      <p className="mt-0.5 text-[11px] leading-4 text-stone-500">
        {detail}
      </p>
    </div>
  );
}

function ModelHealthPreflightPuck({
  state,
}: {
  state: Exclude<ModelHealthPreflightState, { kind: 'idle' }>;
}): JSX.Element {
  const failed = state.kind === 'failed';
  return (
    <div
      className={`rounded-full border px-3 py-2 text-[12px] shadow-sm ${
        failed
          ? 'border-rose-200 bg-rose-50 text-rose-900'
          : 'border-blue-200 bg-blue-50 text-blue-900'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${
            failed ? 'bg-rose-500' : 'animate-pulse bg-blue-500'
          }`}
        />
        <span className="font-semibold">
          {failed ? 'Model validation needs attention' : 'Validating model before mining'}
        </span>
        <span className="min-w-0 flex-1 truncate text-stone-600">
          {failed ? state.reason : state.message}
        </span>
        {failed && (
          <code className="rounded-full bg-white/80 px-2 py-1 text-[11px] text-rose-900">
            {state.command}
          </code>
        )}
      </div>
      {!failed && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-500" />
        </div>
      )}
    </div>
  );
}

// ─── Spend boundary strip ─────────────────────────────────────────────────────

function SpendBoundaryStrip({
  slots,
  recommendedAnnualSpend,
  annualTravelOverlay,
  budgetAnnualByCoreSpend,
}: {
  slots: CertificationSlot[];
  recommendedAnnualSpend: number | null;
  annualTravelOverlay: number;
  budgetAnnualByCoreSpend?: Map<number, number>;
}): JSX.Element | null {
  const groups = groupCertificationSlotsBySpend(slots).sort(
    (a, b) => a.annualSpendTodayDollars - b.annualSpendTodayDollars,
  );
  if (groups.length === 0) return null;

  return (
    <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
      {groups.map((group) => {
        const isRecommended =
          recommendedAnnualSpend !== null &&
          group.annualSpendTodayDollars === recommendedAnnualSpend;
        const fillColor =
          group.status === 'running'
            ? 'bg-blue-500'
            : group.verdict === 'green'
              ? 'bg-emerald-400'
              : group.verdict === 'yellow'
                ? 'bg-amber-400'
                : group.verdict === 'red'
                  ? 'bg-rose-400'
                  : 'bg-stone-300';
        const height = isRecommended ? 34 : 28;
        const progressPct =
          group.status === 'done'
            ? 100
            : group.total > 0
              ? Math.min(100, Math.max(4, (group.completed / group.total) * 100))
              : 0;
        const progressLabel =
          group.status === 'running' && group.total > 0
            ? ` · ${group.completed}/${group.total}`
            : '';
        const lifestyleAnnualSpend = annualSpendWithTravelOverlay(
          group.annualSpendTodayDollars,
          annualTravelOverlay,
        );
        const budgetAnnualSpend =
          budgetAnnualByCoreSpend?.get(group.annualSpendTodayDollars) ?? null;
        const displayAnnualSpend = budgetAnnualSpend ?? lifestyleAnnualSpend;
        const travelDetail =
          annualTravelOverlay > 0
            ? ` · core ${formatCurrency(group.annualSpendTodayDollars)}/yr + travel ${formatCurrency(annualTravelOverlay)}/yr`
            : '';
        const slotSubLabel =
          group.status === 'running'
            ? group.hostDisplayNames[0] ?? 'assigning'
            : group.verdict === 'green'
              ? 'certified'
              : group.reasons[0]
                ? certificationReasonLabel(group.reasons[0].code)
                : group.verdict ?? '-';
        const valueLabel =
          budgetAnnualSpend === null ? 'pending' : formatCurrency(displayAnnualSpend);
        const testLevelLabel = `test ${formatCurrency(lifestyleAnnualSpend)}`;
        return (
          <div key={group.key} className="flex min-w-[112px] flex-col gap-0.5">
            {isRecommended && (
              <span className="self-start text-[9px] font-bold uppercase tracking-wide text-emerald-700">
                Pick
              </span>
            )}
            <div
              className={`relative w-[112px] overflow-hidden rounded border border-stone-200 bg-stone-100 ${isRecommended ? 'ring-2 ring-emerald-600 ring-offset-1' : ''}`}
              style={{ height: `${height}px` }}
              title={
                budgetAnnualSpend === null
                  ? `Total budget pending until certification trace completes · ${testLevelLabel}/yr${travelDetail} · ${group.candidateCount} candidate${group.candidateCount === 1 ? '' : 's'} · ${group.hostDisplayNames.join(', ') || 'unassigned'} · ${group.verdict ?? (group.status === 'running' ? 'certifying...' : '-')}${progressLabel}`
                  : `${formatCurrency(displayAnnualSpend)}/yr next-year total budget · ${testLevelLabel}/yr${travelDetail} · ${group.candidateCount} candidate${group.candidateCount === 1 ? '' : 's'} · ${group.hostDisplayNames.join(', ') || 'unassigned'} · ${group.verdict ?? '-'}${progressLabel}`
              }
            >
              <div
                className={`absolute inset-y-0 left-0 transition-[width] duration-500 ease-out ${fillColor} ${
                  group.status === 'running' ? 'shadow-[6px_0_12px_rgba(59,130,246,0.22)]' : ''
                }`}
                style={{ width: `${progressPct}%` }}
              />
              {group.status === 'running' && progressPct === 0 && (
                <div className="absolute inset-0 animate-pulse bg-blue-100" />
              )}
              <div className="relative flex h-full items-center justify-between px-2 text-[10px] font-semibold tabular-nums text-stone-800">
                <span className={budgetAnnualSpend === null ? 'uppercase tracking-[0.08em]' : ''}>
                  {valueLabel}
                </span>
                <span className="text-stone-600">
                  {group.status === 'running' && group.total > 0
                    ? `${group.completed}/${group.total}`
                    : group.status === 'running'
                      ? '...'
                      : group.verdict ?? '-'}
                </span>
              </div>
            </div>
            <span
              className="truncate text-[8px] font-semibold uppercase text-stone-500"
            >
              {testLevelLabel}
            </span>
            <span
              className={`truncate text-[8px] font-semibold uppercase ${
                group.verdict === 'green'
                  ? 'text-emerald-600'
                  : group.verdict === 'yellow'
                    ? 'text-amber-600'
                    : group.verdict === 'red'
                      ? 'text-rose-600'
                      : 'text-stone-400'
              }`}
            >
              {slotSubLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Validation tradeoff map ─────────────────────────────────────────────────

const CERTIFICATION_REASON_LABELS: Record<string, string> = {
  baseline_solvency_red: 'base solvency',
  baseline_first10_red: 'early failure',
  stress_solvency_red: 'stress solvency',
  stress_first10_red: 'stress early failure',
  baseline_not_green: 'base margin',
  north_star_legacy_watch: 'legacy cushion',
  stress_not_green: 'stress margin',
  seed_stability_yellow: 'seed stability',
  sleep_well_green: 'cleared',
};

function certificationReasonLabel(code: string): string {
  return CERTIFICATION_REASON_LABELS[code] ?? code.replaceAll('_', ' ');
}

function certificationVerdictClasses(
  verdict: MonthlyReviewCertification['verdict'],
): string {
  if (verdict === 'green') return 'bg-emerald-100 text-emerald-800 ring-emerald-200';
  if (verdict === 'yellow') return 'bg-amber-100 text-amber-800 ring-amber-200';
  return 'bg-rose-100 text-rose-800 ring-rose-200';
}

interface CertificationReasonSummary {
  code: string;
  message: string;
  count: number;
}

interface CertificationSlotSpendGroup {
  key: string;
  annualSpendTodayDollars: number;
  slots: CertificationSlot[];
  candidateCount: number;
  status: CertificationSlot['status'];
  completed: number;
  total: number;
  verdict: MonthlyReviewCertification['verdict'] | null;
  reasons: CertificationReasonSummary[];
  hostDisplayNames: string[];
}

interface CertificationSpendGroup {
  key: string;
  annualSpendTodayDollars: number;
  certifications: Array<{
    cert: MonthlyReviewCertification;
    strategyLabel: string;
  }>;
  candidateCount: number;
  verdict: MonthlyReviewCertification['verdict'];
  reasons: CertificationReasonSummary[];
  strategyLabels: string[];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function aggregateCertificationVerdict(
  verdicts: Array<MonthlyReviewCertification['verdict'] | null>,
): MonthlyReviewCertification['verdict'] | null {
  if (verdicts.includes('green')) return 'green';
  if (verdicts.includes('red')) return 'red';
  if (verdicts.includes('yellow')) return 'yellow';
  return null;
}

function summarizeCertificationReasons(
  reasons: Array<{ code: string; message: string }>,
): CertificationReasonSummary[] {
  const summaries = new Map<string, CertificationReasonSummary>();
  for (const reason of reasons) {
    if (reason.code === 'sleep_well_green') continue;
    const existing = summaries.get(reason.code);
    if (existing) {
      existing.count += 1;
    } else {
      summaries.set(reason.code, {
        code: reason.code,
        message: reason.message,
        count: 1,
      });
    }
  }
  return [...summaries.values()];
}

function groupCertificationSlotsBySpend(slots: CertificationSlot[]): CertificationSlotSpendGroup[] {
  const bySpend = new Map<number, CertificationSlot[]>();
  for (const slot of slots) {
    const group = bySpend.get(slot.annualSpendTodayDollars) ?? [];
    group.push(slot);
    bySpend.set(slot.annualSpendTodayDollars, group);
  }

  return [...bySpend.entries()].map(([annualSpendTodayDollars, groupSlots]) => {
    const doneVerdicts = groupSlots
      .filter((slot) => slot.status === 'done')
      .map((slot) => slot.verdict);
    const status = groupSlots.some((slot) => slot.status === 'running') ? 'running' : 'done';
    return {
      key: String(annualSpendTodayDollars),
      annualSpendTodayDollars,
      slots: groupSlots,
      candidateCount: groupSlots.length,
      status,
      completed: groupSlots.reduce((sum, slot) => sum + slot.completed, 0),
      total: groupSlots.reduce((sum, slot) => sum + slot.total, 0),
      verdict: aggregateCertificationVerdict(doneVerdicts),
      reasons: summarizeCertificationReasons(groupSlots.flatMap((slot) => slot.reasons)),
      hostDisplayNames: uniqueStrings(groupSlots.map((slot) => slot.hostDisplayName)),
    };
  });
}

function groupCertificationsBySpend(
  certifications: Array<{ cert: MonthlyReviewCertification; strategyLabel: string }>,
): CertificationSpendGroup[] {
  const bySpend = new Map<number, Array<{ cert: MonthlyReviewCertification; strategyLabel: string }>>();
  for (const item of certifications) {
    const spend = item.cert.evaluation.policy.annualSpendTodayDollars;
    const group = bySpend.get(spend) ?? [];
    group.push(item);
    bySpend.set(spend, group);
  }

  return [...bySpend.entries()].map(([annualSpendTodayDollars, groupCertifications]) => {
    const verdict = aggregateCertificationVerdict(
      groupCertifications.map(({ cert }) => cert.verdict),
    ) ?? 'red';
    return {
      key: String(annualSpendTodayDollars),
      annualSpendTodayDollars,
      certifications: groupCertifications,
      candidateCount: groupCertifications.length,
      verdict,
      reasons: summarizeCertificationReasons(
        groupCertifications.flatMap(({ cert }) => cert.pack.reasons),
      ),
      strategyLabels: uniqueStrings(groupCertifications.map(({ strategyLabel }) => strategyLabel)),
    };
  });
}

function weakestCertificationGroupRows(group: CertificationSpendGroup) {
  return group.certifications
    .flatMap(({ cert }) =>
      cert.pack.rows.map((row) => ({
        row,
        key: `${cert.evaluation.id}-${row.id}`,
      })),
    )
    .sort((a, b) => {
      const score = (row: typeof a.row) =>
        (1 - row.solvencyRate) * 4 +
        row.first10YearFailureRisk * 3 +
        (1 - row.legacyAttainmentRate) * 2 +
        row.spendingCutRate;
      return score(b.row) - score(a.row);
    })
    .slice(0, 3);
}

function certificationMetricSummary(cert: MonthlyReviewCertification): {
  baselineSolvency: number | null;
  stressSolvency: number | null;
  legacy: number | null;
  first10Failure: number | null;
} {
  const rows = cert.pack.rows;
  const baselineRows = rows.filter((row) => row.scenarioKind === 'baseline');
  const stressRows = rows.filter((row) => row.scenarioKind === 'stress');
  const minOf = (values: number[]) => {
    const finiteValues = values.filter((value) => Number.isFinite(value));
    return finiteValues.length > 0 ? Math.min(...finiteValues) : null;
  };
  const maxOf = (values: number[]) => {
    const finiteValues = values.filter((value) => Number.isFinite(value));
    return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
  };
  return {
    baselineSolvency: minOf(baselineRows.map((row) => row.solvencyRate)),
    stressSolvency: minOf(stressRows.map((row) => row.solvencyRate)),
    legacy: minOf(rows.map((row) => row.legacyAttainmentRate)),
    first10Failure: maxOf(rows.map((row) => row.first10YearFailureRisk)),
  };
}

function certificationSpendGroupMetricSummary(group: CertificationSpendGroup): {
  baselineSolvency: number | null;
  stressSolvency: number | null;
  legacy: number | null;
  first10Failure: number | null;
} {
  const summaries = group.certifications.map(({ cert }) => certificationMetricSummary(cert));
  const minOf = (values: Array<number | null>) => {
    const finiteValues = values.filter((value): value is number => Number.isFinite(value));
    return finiteValues.length > 0 ? Math.min(...finiteValues) : null;
  };
  const maxOf = (values: Array<number | null>) => {
    const finiteValues = values.filter((value): value is number => Number.isFinite(value));
    return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
  };
  return {
    baselineSolvency: minOf(summaries.map((summary) => summary.baselineSolvency)),
    stressSolvency: minOf(summaries.map((summary) => summary.stressSolvency)),
    legacy: minOf(summaries.map((summary) => summary.legacy)),
    first10Failure: maxOf(summaries.map((summary) => summary.first10Failure)),
  };
}

function firstRetirementTotalBudgetAnnualForCertification(
  cert: MonthlyReviewCertification,
  retirementYear: number | null,
  inflation: number,
  legacyTarget: number,
  fallbackTravelAnnual: number,
): number | null {
  return buildNorthStarBudgetFromCertification({
    cert,
    spendingPath: null,
    retirementYear,
    inflation,
    legacyTarget,
    fallbackTravelAnnual,
  }).totalAnnualBudget;
}

function firstRetirementTotalBudgetAnnualForGroup(
  group: CertificationSpendGroup,
  retirementYear: number | null,
  inflation: number,
  legacyTarget: number,
  fallbackTravelAnnual: number,
): number | null {
  const values = group.certifications
    .map(({ cert }) =>
      firstRetirementTotalBudgetAnnualForCertification(
        cert,
        retirementYear,
        inflation,
        legacyTarget,
        fallbackTravelAnnual,
      ),
    )
    .filter((value): value is number => Number.isFinite(value));
  if (values.length === 0) return null;
  return Math.max(...values);
}

function buildCertificationBudgetAnnualByCoreSpend(
  run: MonthlyReviewRun | null,
  retirementYear: number | null,
  inflation: number,
  legacyTarget: number,
  fallbackTravelAnnual: number,
): Map<number, number> {
  const budgets = new Map<number, number>();
  if (!run) return budgets;
  for (const cert of run.strategies.flatMap((strategy) => strategy.certifications)) {
    const coreSpend = cert.evaluation.policy.annualSpendTodayDollars;
    const budget = firstRetirementTotalBudgetAnnualForCertification(
      cert,
      retirementYear,
      inflation,
      legacyTarget,
      fallbackTravelAnnual,
    );
    if (budget === null) continue;
    const existing = budgets.get(coreSpend);
    budgets.set(coreSpend, existing === undefined ? budget : Math.max(existing, budget));
  }
  return budgets;
}

function ValidationTradeoffMap({
  run,
  packet,
  certificationSlots,
  annualTravelOverlay,
  retirementYear,
  inflation,
  legacyTarget,
}: {
  run: MonthlyReviewRun | null;
  packet?: MonthlyReviewValidationPacket | null;
  certificationSlots: CertificationSlot[];
  annualTravelOverlay: number;
  retirementYear: number | null;
  inflation: number;
  legacyTarget: number;
}): JSX.Element | null {
  if (!run && packet) {
    const selectedSpend = packet.recommendation.annualSpendTodayDollars;
    const displaySelectedSpend = annualSpendWithTravelOverlay(
      selectedSpend,
      annualTravelOverlay,
    );
    const completedSlots = certificationSlots
      .filter((slot) => slot.status === 'done')
      .sort((a, b) => b.annualSpendTodayDollars - a.annualSpendTodayDollars);
    const higherSlots = completedSlots.filter((slot) =>
      selectedSpend === null
        ? slot.verdict !== 'green'
        : slot.annualSpendTodayDollars > selectedSpend,
    );
    const displaySlots =
      higherSlots.length > 0
        ? higherSlots
        : completedSlots.filter((slot) => slot.verdict !== 'green');
    const completedGroups = groupCertificationSlotsBySpend(completedSlots).sort(
      (a, b) => b.annualSpendTodayDollars - a.annualSpendTodayDollars,
    );
    const higherGroups = completedGroups.filter((group) =>
      selectedSpend === null
        ? group.verdict !== 'green'
        : group.annualSpendTodayDollars > selectedSpend,
    );
    const displayGroups =
      higherGroups.length > 0
        ? higherGroups
        : completedGroups.filter((group) => group.verdict !== 'green');

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-stone-500">
            {selectedSpend !== null
              ? `${higherGroups.length} higher validation level${higherGroups.length === 1 ? '' : 's'} tested above ${formatCurrency(displaySelectedSpend)}/yr; total budget pending (${higherSlots.length} candidate${higherSlots.length === 1 ? '' : 's'})`
              : `${displayGroups.length} non-green spend level${displayGroups.length === 1 ? '' : 's'} tested (${displaySlots.length} candidate${displaySlots.length === 1 ? '' : 's'})`}
          </p>
          {selectedSpend !== null && (
            <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-800 ring-1 ring-emerald-200">
              selected test {formatCurrency(displaySelectedSpend)}
            </span>
          )}
        </div>
        {completedGroups.length > 0 && (
          <div className="grid grid-flow-col auto-cols-[minmax(76px,1fr)] gap-1 overflow-x-auto pb-1">
            {[...completedGroups]
              .sort((a, b) => a.annualSpendTodayDollars - b.annualSpendTodayDollars)
              .map((group) => {
                const isPick =
                  selectedSpend !== null &&
                  group.annualSpendTodayDollars === selectedSpend;
                const displayAnnualSpend = annualSpendWithTravelOverlay(
                  group.annualSpendTodayDollars,
                  annualTravelOverlay,
                );
                return (
                  <div
                    key={group.key}
                    className={`rounded border bg-white p-2 text-center ring-1 ${
                      isPick
                        ? 'border-emerald-300 ring-emerald-400'
                        : group.verdict === 'green'
                          ? 'border-emerald-100 ring-emerald-100'
                          : group.verdict === 'yellow'
                            ? 'border-amber-100 ring-amber-100'
                            : 'border-rose-100 ring-rose-100'
                    }`}
                    title={
                      annualTravelOverlay > 0
                      ? `First year ${formatCurrency(displayAnnualSpend)}/yr · core ${formatCurrency(group.annualSpendTodayDollars)}/yr + travel ${formatCurrency(annualTravelOverlay)}/yr`
                        : undefined
                    }
                  >
                    <p className="text-[11px] font-semibold tabular-nums text-stone-900">
                      pending
                    </p>
                    <p className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.06em] text-stone-400">
                      test {formatCurrency(displayAnnualSpend)}
                    </p>
                    <p
                      className={`mt-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1 ${
                        group.verdict
                          ? certificationVerdictClasses(group.verdict)
                          : 'bg-stone-100 text-stone-600 ring-stone-200'
                      }`}
                    >
                      {isPick ? 'pick' : group.verdict ?? '-'}
                    </p>
                    {group.candidateCount > 1 && (
                      <p className="mt-1 text-[9px] font-semibold tabular-nums text-stone-500">
                        {group.candidateCount} candidates
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        )}
        {displayGroups.length > 0 ? (
          <div className="grid gap-2">
            {displayGroups.slice(0, 5).map((group) => {
              const annualDelta =
                selectedSpend === null
                  ? null
                  : Math.max(0, group.annualSpendTodayDollars - selectedSpend);
              const displayAnnualSpend = annualSpendWithTravelOverlay(
                group.annualSpendTodayDollars,
                annualTravelOverlay,
              );
              return (
                <div
                  key={group.key}
                  className="rounded-lg border border-stone-200 bg-white p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold tabular-nums text-stone-950">
                        test {formatCurrency(displayAnnualSpend)}/yr
                      </span>
                      {group.verdict && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1 ${certificationVerdictClasses(group.verdict)}`}
                        >
                          {group.verdict}
                        </span>
                      )}
                      {group.candidateCount > 1 && (
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-stone-600">
                          {group.candidateCount} candidates
                        </span>
                      )}
                      {annualDelta !== null && annualDelta > 0 && (
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-stone-600">
                          +{formatMonthly(annualDelta / 12)}
                        </span>
                      )}
                    </div>
                    {annualTravelOverlay > 0 && (
                      <p className="mt-1 text-[10px] tabular-nums text-stone-500">
                        core {formatCurrency(group.annualSpendTodayDollars)}/yr + travel {formatCurrency(annualTravelOverlay)}/yr
                      </p>
                    )}
                  </div>
                  {group.reasons.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {group.reasons.slice(0, 4).map((reason) => (
                        <span
                          key={`${group.key}-${reason.code}`}
                          className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-amber-100"
                          title={reason.message}
                        >
                          {certificationReasonLabel(reason.code)}
                          {reason.count > 1 ? ` x${reason.count}` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-[12px] text-stone-500">
            Waiting for certified candidates above the selected spend.
          </p>
        )}
      </div>
    );
  }

  if (!run) return null;

  const selectedSpend = run.recommendation.annualSpendTodayDollars;
  const certifications = run.strategies
    .flatMap((strategy) =>
      strategy.certifications.map((cert) => ({
        cert,
        strategyLabel: strategy.strategy.label,
      })),
    )
    .sort(
      (a, b) =>
        b.cert.evaluation.policy.annualSpendTodayDollars -
        a.cert.evaluation.policy.annualSpendTodayDollars,
  );
  if (certifications.length === 0) return null;
  const certificationGroups = groupCertificationsBySpend(certifications).sort(
    (a, b) => b.annualSpendTodayDollars - a.annualSpendTodayDollars,
  );
  const selectedCertification =
    run.strategies
      .map((strategy) => strategy.selectedCertification)
      .find(
        (cert): cert is MonthlyReviewCertification =>
          !!cert &&
          cert.strategyId === run.recommendation.strategyId &&
          cert.evaluation.id === run.recommendation.policyId,
      ) ?? null;
  const selectedBudgetAnnual =
    selectedCertification === null
      ? null
      : firstRetirementTotalBudgetAnnualForCertification(
          selectedCertification,
          retirementYear,
          inflation,
          legacyTarget,
          annualTravelOverlay,
        );
  const displaySelectedSpend =
    selectedBudgetAnnual ??
    annualSpendWithTravelOverlay(
      selectedSpend,
      annualTravelOverlay,
    );

  const higherGroups = certificationGroups.filter((group) => {
    return selectedSpend === null
      ? group.verdict !== 'green'
      : group.annualSpendTodayDollars > selectedSpend;
  });
  const displayGroups =
    higherGroups.length > 0
      ? higherGroups
      : certificationGroups.filter((group) => group.verdict !== 'green');
  const higherCandidateCount = higherGroups.reduce(
    (sum, group) => sum + group.candidateCount,
    0,
  );
  const displayCandidateCount = displayGroups.reduce(
    (sum, group) => sum + group.candidateCount,
    0,
  );
  const ladder = [...certificationGroups].sort(
    (a, b) => a.annualSpendTodayDollars - b.annualSpendTodayDollars,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-stone-500">
          {selectedSpend !== null
            ? `${higherGroups.length} higher spend level${higherGroups.length === 1 ? '' : 's'} tested above ${formatCurrency(displaySelectedSpend)}/yr total budget (${higherCandidateCount} candidate${higherCandidateCount === 1 ? '' : 's'})`
            : `${displayGroups.length} non-green spend level${displayGroups.length === 1 ? '' : 's'} tested (${displayCandidateCount} candidate${displayCandidateCount === 1 ? '' : 's'})`}
        </p>
        {selectedSpend !== null && (
          <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-800 ring-1 ring-emerald-200">
            pick {formatCurrency(displaySelectedSpend)}
          </span>
        )}
      </div>

      <div className="grid grid-flow-col auto-cols-[minmax(76px,1fr)] gap-1 overflow-x-auto pb-1">
        {ladder.map((group) => {
          const isPick =
            selectedSpend !== null && group.annualSpendTodayDollars === selectedSpend;
          const lifestyleAnnualSpend = annualSpendWithTravelOverlay(
            group.annualSpendTodayDollars,
            annualTravelOverlay,
          );
          const displayAnnualSpend =
            firstRetirementTotalBudgetAnnualForGroup(
              group,
              retirementYear,
              inflation,
              legacyTarget,
              annualTravelOverlay,
            ) ?? lifestyleAnnualSpend;
          return (
            <div
              key={group.key}
              className={`rounded border bg-white p-2 text-center ring-1 ${
                isPick
                  ? 'border-emerald-300 ring-emerald-400'
                  : group.verdict === 'green'
                    ? 'border-emerald-100 ring-emerald-100'
                    : group.verdict === 'yellow'
                      ? 'border-amber-100 ring-amber-100'
                      : 'border-rose-100 ring-rose-100'
              }`}
              title={
                `Next-year total budget ${formatCurrency(displayAnnualSpend)}/yr · validation level ${formatCurrency(lifestyleAnnualSpend)}/yr`
              }
            >
              <p className="text-[11px] font-semibold tabular-nums text-stone-900">
                {formatCurrency(displayAnnualSpend)}
              </p>
              <p className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.06em] text-stone-400">
                budget
              </p>
              <p
                className={`mt-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1 ${certificationVerdictClasses(group.verdict)}`}
              >
                {isPick ? 'pick' : group.verdict}
              </p>
              {group.candidateCount > 1 && (
                <p className="mt-1 text-[9px] font-semibold tabular-nums text-stone-500">
                  {group.candidateCount} candidates
                </p>
              )}
            </div>
          );
        })}
      </div>

      {displayGroups.length > 0 ? (
        <div className="grid gap-2">
          {displayGroups.slice(0, 5).map((group) => {
            const annualDelta =
              selectedSpend === null
                ? null
                : Math.max(
                    0,
                    (firstRetirementTotalBudgetAnnualForGroup(
                      group,
                      retirementYear,
                      inflation,
                      legacyTarget,
                      annualTravelOverlay,
                    ) ??
                      annualSpendWithTravelOverlay(
                        group.annualSpendTodayDollars,
                        annualTravelOverlay,
                      ) ??
                      0) - (displaySelectedSpend ?? 0),
                  );
            const monthlyDelta = annualDelta === null ? null : annualDelta / 12;
            const lifestyleAnnualSpend = annualSpendWithTravelOverlay(
              group.annualSpendTodayDollars,
              annualTravelOverlay,
            );
            const displayAnnualSpend =
              firstRetirementTotalBudgetAnnualForGroup(
                group,
                retirementYear,
                inflation,
                legacyTarget,
                annualTravelOverlay,
              ) ?? lifestyleAnnualSpend;
            const metrics = certificationSpendGroupMetricSummary(group);
            const weakestRows = weakestCertificationGroupRows(group);
            return (
              <div
                key={group.key}
                className="rounded-lg border border-stone-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold tabular-nums text-stone-950">
                        {formatCurrency(displayAnnualSpend)}/yr total budget
                      </p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1 ${certificationVerdictClasses(group.verdict)}`}
                      >
                        {group.verdict}
                      </span>
                      {group.candidateCount > 1 && (
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-stone-600">
                          {group.candidateCount} candidates
                        </span>
                      )}
                      {monthlyDelta !== null && monthlyDelta > 0 && (
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-stone-600">
                          +{formatMonthly(monthlyDelta)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-stone-500">
                      {group.strategyLabels.join(', ')}
                    </p>
                    <p className="mt-1 text-[10px] tabular-nums text-stone-500">
                      validation level {formatCurrency(lifestyleAnnualSpend)}/yr · core {formatCurrency(group.annualSpendTodayDollars)}/yr + travel {formatCurrency(annualTravelOverlay)}/yr
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-right text-[10px] tabular-nums text-stone-500 sm:grid-cols-4">
                    <span>base {formatPercent(metrics.baselineSolvency)}</span>
                    <span>stress {formatPercent(metrics.stressSolvency)}</span>
                    <span>legacy {formatPercent(metrics.legacy)}</span>
                    <span>10y fail {formatPercent(metrics.first10Failure)}</span>
                  </div>
                </div>

                {group.reasons.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {group.reasons.slice(0, 4).map((reason) => (
                      <span
                        key={`${group.key}-${reason.code}`}
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${
                          group.verdict === 'red'
                            ? 'bg-rose-50 text-rose-800 ring-rose-100'
                            : 'bg-amber-50 text-amber-800 ring-amber-100'
                        }`}
                      >
                        {certificationReasonLabel(reason.code)}
                        {reason.count > 1 ? ` x${reason.count}` : ''}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-2 grid gap-1 sm:grid-cols-3">
                  {weakestRows.map(({ row, key }) => (
                    <div
                      key={key}
                      className="rounded border border-stone-100 bg-stone-50 px-2 py-1.5"
                    >
                      <p className="truncate text-[10px] font-semibold text-stone-700">
                        {row.modeLabel} · {row.scenarioName}
                      </p>
                      <p className="mt-0.5 text-[10px] tabular-nums text-stone-500">
                        solv {formatPercent(row.solvencyRate)} · legacy{' '}
                        {formatPercent(row.legacyAttainmentRate)} · 10y{' '}
                        {formatPercent(row.first10YearFailureRisk)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-[12px] text-stone-500">
          No higher certified candidate failed above the selected spend.
        </p>
      )}
    </div>
  );
}

// ─── Right rail cluster status ────────────────────────────────────────────────

function hostCertifyCapacity(peer: SnapshotPeer): number {
  if (typeof peer.certifyCapacity === 'number') return peer.certifyCapacity;
  const advertised = peer.capabilities?.certifyWorkerCount;
  if (typeof advertised === 'number' && Number.isFinite(advertised)) {
    return Math.max(0, Math.floor(advertised));
  }
  return 0;
}

function hostCertifyInFlight(peer: SnapshotPeer): number {
  return Math.max(0, Math.floor(peer.certifyInFlightCount ?? 0));
}

function compactHostName(name: string): string {
  return name
    .replace(/^node-host-/i, '')
    .replace(/\.local$/i, '')
    .replace(/^DESKTOP-/i, 'Win ');
}

function ClusterStatusRail({
  peers,
  session,
  certificationSlots,
  reviewStage,
  annualTravelOverlay,
}: {
  peers: SnapshotPeer[];
  session: UseClusterSession['session'];
  certificationSlots: CertificationSlot[];
  reviewStage: MonthlyReviewStage;
  annualTravelOverlay: number;
}): JSX.Element {
  const hosts = peers.filter((peer) => peer.roles.includes('host'));
  const totalMiningWorkers = hosts.reduce(
    (total, peer) => total + (peer.capabilities?.workerCount ?? 0),
    0,
  );
  const totalCertifyCapacity = hosts.reduce(
    (total, peer) => total + hostCertifyCapacity(peer),
    0,
  );
  const activeCertificationsFromHosts = hosts.reduce(
    (total, peer) => total + hostCertifyInFlight(peer),
    0,
  );
  const activeCertifications = Math.max(
    activeCertificationsFromHosts,
    certificationSlots.filter((slot) => slot.status === 'running').length,
  );
  const assignedSlots = certificationSlots.filter((slot) => slot.hostDisplayName);
  return (
    <aside className="space-y-3 lg:sticky lg:top-3">
      <div className="rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-100 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
            Cluster status
          </p>
          <p className="mt-0.5 text-[12px] font-semibold text-stone-900">
            {hosts.length} hosts · {totalMiningWorkers} mining workers · {totalCertifyCapacity} certify slots
          </p>
        </div>
        <div className="space-y-2 p-3">
          {session ? (
            <div className="rounded border border-blue-100 bg-blue-50 px-2 py-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-blue-700">
                Mining
              </p>
              <p className="mt-0.5 text-[11px] tabular-nums text-blue-950">
                {session.stats.policiesEvaluated.toLocaleString()} / {session.stats.totalPolicies.toLocaleString()} policies
              </p>
            </div>
          ) : (
            <div className="rounded border border-stone-200 bg-stone-50 px-2 py-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-stone-500">
                Mining idle
              </p>
              <p className="mt-0.5 text-[11px] text-stone-500">
                Certify can still use the worker hosts.
              </p>
            </div>
          )}
          <div className="rounded border border-stone-200 bg-stone-50 px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-stone-500">
              Certify
            </p>
            <p className="mt-0.5 text-[11px] tabular-nums text-stone-700">
              {activeCertifications} / {totalCertifyCapacity} slots active
              {reviewStage === 'certifying' ? ' · running' : ''}
            </p>
          </div>
          <div className="space-y-2">
            {hosts.map((peer) => {
              const miningCapacity = peer.capabilities?.workerCount ?? 0;
              const certifyCapacity = hostCertifyCapacity(peer);
              const certifyInFlight = hostCertifyInFlight(peer);
              const miningReservedSlots = Math.min(
                miningCapacity,
                Math.max(
                  0,
                  Math.floor(
                    peer.metrics?.reservedWorkerSlots ?? peer.inFlightBatchCount,
                  ),
                ),
              );
              const miningUtilization =
                session && typeof peer.metrics?.utilizationRate === 'number'
                  ? Math.max(0, Math.min(1, peer.metrics.utilizationRate))
                  : null;
              const certifyPct =
                certifyCapacity > 0
                  ? Math.min(100, (certifyInFlight / certifyCapacity) * 100)
                  : 0;
              const miningPct =
                miningCapacity > 0
                  ? miningUtilization !== null
                    ? miningUtilization * 100
                    : Math.min(100, (miningReservedSlots / miningCapacity) * 100)
                  : 0;
              const targetBatches = peer.metrics?.targetInFlightBatches ?? null;
              const miningLabel = session
                ? miningUtilization !== null
                  ? `${Math.round(miningUtilization * 100)}% util`
                  : `${miningReservedSlots}/${miningCapacity} slots`
                : 'idle';
              const miningTitle = session
                ? `${peer.inFlightBatchCount} dispatcher batch${peer.inFlightBatchCount === 1 ? '' : 'es'} in flight${targetBatches ? ` of ${targetBatches} target` : ''}; ${miningReservedSlots}/${miningCapacity} reserved worker slots. Host batches can fan out across all workers.`
                : 'No mining batch in flight.';
              const lastHeartbeatLabel = formatShortTime(peer.lastHeartbeatTs);
              return (
                <div key={peer.peerId} className="rounded border border-stone-200 bg-white px-2 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[11px] font-semibold text-stone-900">
                      {compactHostName(peer.displayName)}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className="text-[10px] tabular-nums text-stone-400"
                        title={peer.lastHeartbeatTs ? `Last heartbeat ${lastHeartbeatLabel}` : 'No heartbeat yet'}
                      >
                        last {lastHeartbeatLabel}
                      </span>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                          peer.buildStatus === 'match'
                            ? 'bg-emerald-50 text-emerald-700'
                            : peer.buildStatus === 'dirty'
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-stone-100 text-stone-500'
                        }`}
                      >
                        {peer.buildStatus ?? 'unknown'}
                      </span>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <div>
                      <div className="flex justify-between text-[10px] tabular-nums text-stone-500">
                        <span>mine</span>
                        <span title={miningTitle}>{miningLabel}</span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
                        <div className="h-full rounded-full bg-cyan-500" style={{ width: `${miningPct}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] tabular-nums text-stone-500">
                        <span>certify</span>
                        <span>{certifyInFlight}/{certifyCapacity}</span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${certifyPct}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {assignedSlots.length > 0 && (
        <div className="rounded-lg border border-stone-200 bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
            Assigned candidates
          </p>
          <div className="mt-2 space-y-1.5">
            {assignedSlots.slice(0, 8).map((slot) => (
              <div key={slot.candidateId} className="flex items-center justify-between gap-2 text-[10px]">
                <span
                  className="tabular-nums text-stone-800"
                  title={
                    annualTravelOverlay > 0
                      ? `First year ${formatCurrency(annualSpendWithTravelOverlay(slot.annualSpendTodayDollars, annualTravelOverlay))}/yr · core ${formatCurrency(slot.annualSpendTodayDollars)}/yr + travel ${formatCurrency(annualTravelOverlay)}/yr`
                      : undefined
                  }
                >
                  {formatCurrency(annualSpendWithTravelOverlay(slot.annualSpendTodayDollars, annualTravelOverlay))}
                </span>
                <span className="min-w-0 truncate text-stone-500">
                  {slot.hostDisplayName}
                </span>
                <span className="shrink-0 tabular-nums text-stone-400">
                  {formatShortTime(slot.startedAtIso)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

// ─── AI review checklist ─────────────────────────────────────────────────────

type ChecklistStatus = MonthlyReviewAiFinding['status'] | MonthlyReviewQaSignal['status'];

interface ReviewChecklistItem {
  id: string;
  status: ChecklistStatus;
  title: string;
  detail: string;
  evidence?: string[];
  recommendation?: string;
  source: 'AI' | 'Household';
}

function checklistStatusMeta(status: ChecklistStatus): {
  label: string;
  mark: string;
  statusClass: string;
  rowClass: string;
} {
  if (status === 'fail' || status === 'act_now') {
    return {
      label: status === 'act_now' ? 'Act now' : 'Block',
      mark: '!',
      statusClass: 'border-rose-300 bg-rose-50 text-rose-800',
      rowClass: 'border-rose-200 bg-rose-50/70',
    };
  }
  if (status === 'watch') {
    return {
      label: 'Watch',
      mark: '?',
      statusClass: 'border-amber-300 bg-amber-50 text-amber-800',
      rowClass: 'border-amber-200 bg-amber-50/60',
    };
  }
  return {
    label: 'Pass',
    mark: '✓',
    statusClass: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    rowClass: 'border-stone-200 bg-white',
  };
}

function checklistRank(status: ChecklistStatus): number {
  if (status === 'fail' || status === 'act_now') return 0;
  if (status === 'watch') return 1;
  return 2;
}

function ReviewChecklist({ items }: { items: ReviewChecklistItem[] }): JSX.Element | null {
  if (items.length === 0) return null;

  const sorted = [...items].sort((a, b) => {
    const rankDiff = checklistRank(a.status) - checklistRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return a.title.localeCompare(b.title);
  });

  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50">
      <div className="hidden grid-cols-[5.75rem_minmax(9rem,0.9fr)_minmax(14rem,1.4fr)_minmax(10rem,1fr)] gap-3 border-b border-stone-200 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500 md:grid">
        <span>Status</span>
        <span>Check</span>
        <span>Evidence</span>
        <span>Next action</span>
      </div>
      <div className="divide-y divide-stone-200">
        {sorted.map((item) => {
          const meta = checklistStatusMeta(item.status);
          return (
            <div
              key={`${item.source}:${item.id}`}
              className={`grid gap-2 px-3 py-3 text-[12px] md:grid-cols-[5.75rem_minmax(9rem,0.9fr)_minmax(14rem,1.4fr)_minmax(10rem,1fr)] md:gap-3 ${meta.rowClass}`}
            >
              <div>
                <span
                  className={`inline-flex min-w-[4.7rem] items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold ${meta.statusClass}`}
                >
                  <span className="inline-flex size-3 items-center justify-center rounded-sm border border-current text-[9px] leading-none">
                    {meta.mark}
                  </span>
                  {meta.label}
                </span>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-stone-900">{item.title}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-stone-400">
                  {item.source}
                </p>
              </div>
              <div className="min-w-0 text-stone-700">
                <p className="break-words">{item.detail}</p>
                {item.evidence && item.evidence.length > 0 && (
                  <p className="mt-1 break-words font-mono text-[10px] leading-snug text-stone-500">
                    {item.evidence.slice(0, 2).join(' · ')}
                  </p>
                )}
              </div>
              <p className="min-w-0 break-words text-stone-700">
                {item.recommendation || 'No action needed.'}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function aiVerdictMeta(verdict: NonNullable<MonthlyReviewRun['aiApproval']>['verdict'] | null): {
  label: string;
  headline: string;
  meaning: string;
  badgeClass: string;
  panelClass: string;
} {
  if (verdict === 'aligned') {
    return {
      label: 'Use it',
      headline: 'AI review agrees with the model answer.',
      meaning: 'The packet has enough evidence to use this monthly review result.',
      badgeClass: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
      panelClass: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    };
  }
  if (verdict === 'watch') {
    return {
      label: 'Use with watch items',
      headline: 'AI review says the answer is usable, with caveats.',
      meaning: 'Use the result, but keep the watch items visible before adopting or mining again.',
      badgeClass: 'bg-amber-100 text-amber-800 ring-amber-200',
      panelClass: 'border-amber-200 bg-amber-50 text-amber-950',
    };
  }
  if (verdict === 'misaligned') {
    return {
      label: 'Do not use yet',
      headline: 'AI review disagrees with the model answer.',
      meaning: 'Fix the blocking issue before treating this result as decision-grade.',
      badgeClass: 'bg-rose-100 text-rose-800 ring-rose-200',
      panelClass: 'border-rose-200 bg-rose-50 text-rose-950',
    };
  }
  if (verdict === 'insufficient_data') {
    return {
      label: 'Missing evidence',
      headline: 'AI review needs more evidence.',
      meaning: 'Rerun or repair the packet before relying on this result.',
      badgeClass: 'bg-rose-100 text-rose-800 ring-rose-200',
      panelClass: 'border-rose-200 bg-rose-50 text-rose-950',
    };
  }
  return {
    label: 'Pending',
    headline: 'AI review is pending.',
    meaning: 'The answer is waiting for co-review.',
    badgeClass: 'bg-stone-100 text-stone-700 ring-stone-200',
    panelClass: 'border-stone-200 bg-stone-50 text-stone-900',
  };
}

function reviewItemRank(item: ReviewChecklistItem): number {
  if (item.status === 'fail' || item.status === 'act_now') return 0;
  if (item.status === 'watch') return 1;
  return 2;
}

function reviewItemStatusLabel(status: ChecklistStatus): string {
  if (status === 'fail') return 'Block';
  if (status === 'act_now') return 'Act now';
  if (status === 'watch') return 'Watch';
  return 'Pass';
}

function AiReviewDecisionBrief({
  approval,
  items,
}: {
  approval: NonNullable<MonthlyReviewRun['aiApproval']>;
  items: ReviewChecklistItem[];
}): JSX.Element {
  const meta = aiVerdictMeta(approval.verdict);
  const blockers = items.filter((item) => item.status === 'fail' || item.status === 'act_now');
  const watches = items.filter((item) => item.status === 'watch');
  const passes = items.filter((item) => item.status === 'pass');
  const keyItems = [...blockers, ...watches]
    .sort((a, b) => {
      const rankDiff = reviewItemRank(a) - reviewItemRank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.title.localeCompare(b.title);
    })
    .slice(0, 3);
  const actionItems =
    approval.actionItems.length > 0
      ? approval.actionItems.slice(0, 3)
      : keyItems
        .map((item) => item.recommendation)
        .filter((item): item is string => !!item)
        .slice(0, 3);
  const visibleActions =
    actionItems.length > 0
      ? actionItems
      : ['No immediate action needed from the AI review.'];

  return (
    <div className={`rounded-xl border p-4 ${meta.panelClass}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-75">
            AI decision
          </p>
          <h3 className="mt-1 text-lg font-semibold">{meta.headline}</h3>
          <p className="mt-1 text-[12px] leading-5 opacity-90">{meta.meaning}</p>
        </div>
        <span
          className={`w-fit shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ${meta.badgeClass}`}
        >
          {meta.label}
          {approval.confidence ? ` · ${approval.confidence}` : ''}
        </span>
      </div>

      {approval.summary && (
        <p className="mt-3 rounded-lg bg-white/65 px-3 py-2 text-[12px] leading-5 text-stone-700">
          {approval.summary}
        </p>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-70">
            What to do
          </p>
          <ul className="mt-2 space-y-1.5">
            {visibleActions.map((item) => (
              <li
                key={item}
                className="rounded-lg bg-white/75 px-3 py-2 text-[12px] leading-5 text-stone-700"
              >
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-70">
            Main watch items
          </p>
          {keyItems.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {keyItems.map((item) => (
                <li
                  key={`${item.source}:${item.id}`}
                  className="rounded-lg bg-white/75 px-3 py-2 text-[12px] leading-5 text-stone-700"
                >
                  <span className="font-semibold">{reviewItemStatusLabel(item.status)}:</span>{' '}
                  {item.title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-lg bg-white/75 px-3 py-2 text-[12px] leading-5 text-stone-700">
              No blockers or watch items.
            </p>
          )}
        </div>
      </div>

      <p className="mt-3 text-[11px] tabular-nums opacity-75">
        Evidence checks: {passes.length} pass · {watches.length} watch · {blockers.length} block
      </p>
    </div>
  );
}

function AiReviewProgressTimeline({
  steps,
  elapsedMs,
}: {
  steps: AiReviewProgressStep[];
  elapsedMs: number;
}): JSX.Element {
  const visibleSteps = steps.length > 0 ? steps : initialAiReviewProgress();

  return (
    <div className="rounded-xl border border-blue-100 bg-white/70 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700">
          Reviewing the validation packet
        </p>
        {elapsedMs > 0 && (
          <p className="tabular-nums text-[11px] text-stone-500">
            {formatDuration(elapsedMs)}
          </p>
        )}
      </div>
      <ol className="space-y-0">
        {visibleSteps.map((step, index) => {
          const isLast = index === visibleSteps.length - 1;
          const isActive = step.status === 'active';
          const isDone = step.status === 'done';
          const isFailed = step.status === 'failed';
          const circleClass = isFailed
            ? 'border-rose-500 bg-rose-500 text-white'
            : isDone
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : isActive
                ? 'border-blue-500 bg-blue-500 text-white'
                : 'border-stone-300 bg-white text-stone-300';
          const lineClass = isDone
            ? 'bg-emerald-200'
            : isActive
              ? 'bg-blue-200'
              : 'bg-stone-200';
          const titleClass =
            step.status === 'waiting' ? 'text-stone-400' : 'text-stone-900';
          const detailClass =
            step.status === 'waiting' ? 'text-stone-400' : 'text-stone-500';
          return (
            <li key={step.id} className="grid grid-cols-[1.25rem_1fr] gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={`mt-0.5 flex size-5 items-center justify-center rounded-md border text-[10px] font-bold leading-none ${circleClass}`}
                >
                  {isFailed ? '!' : isDone ? '✓' : isActive ? '…' : ''}
                </span>
                {!isLast && <span className={`h-8 w-px ${lineClass}`} />}
              </div>
              <div className={isLast ? 'pb-0' : 'pb-3'}>
                <p className={`text-[12px] font-semibold ${titleClass}`}>
                  {step.title}
                </p>
                <p className={`mt-0.5 text-[11px] ${detailClass}`}>
                  {step.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ─── Proof bundle ─────────────────────────────────────────────────────────────

type MonthlyReviewAuditTrail = NonNullable<
  NonNullable<MonthlyReviewRun['aiApproval']>['auditTrail']
>;

function fileUrlForPath(path: string): string {
  if (!path) return '#';
  if (path.startsWith('file://')) return path;
  return `file://${path.split('/').map((p) => encodeURIComponent(p)).join('/')}`;
}

function auditFileLabel(key: string): string {
  const labels: Record<string, string> = {
    packet: 'Validation packet',
    aiResponse: 'AI response',
    run: 'Full run',
    summary: 'Summary',
    transactionLog: 'Transaction log',
  };
  return labels[key] ?? key;
}

function ProofBundleLinks({ auditTrail }: { auditTrail: MonthlyReviewAuditTrail }) {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
      <p className="text-[11px] font-semibold text-blue-900">Proof bundle saved</p>
      <a
        href={fileUrlForPath(auditTrail.auditDir)}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex rounded-full bg-blue-700 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-blue-800"
      >
        Open proof bundle in Finder
      </a>
      {Object.keys(auditTrail.files).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {Object.entries(auditTrail.files).map(([key, path]) => (
            <a
              key={key}
              href={fileUrlForPath(path)}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-blue-200 bg-white px-2 py-1 text-[10px] font-semibold text-blue-800 transition hover:bg-blue-100"
            >
              {auditFileLabel(key)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Model task list (for backlog) ────────────────────────────────────────────

function ModelTaskList({ tasks }: { tasks: MonthlyReviewModelTask[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200 bg-white">
      {tasks.slice(0, 8).map((task) => (
        <details key={task.id} className="group">
          <summary className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-[11px] marker:hidden hover:bg-stone-50">
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                task.severity === 'critical'
                  ? 'border-rose-200 bg-rose-50 text-rose-900'
                  : task.severity === 'warning'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-stone-200 bg-stone-50 text-stone-600'
              }`}
            >
              {task.severity}
            </span>
            <span className="font-semibold text-stone-900">{task.title}</span>
          </summary>
          <div className="border-t border-stone-100 bg-stone-50 px-3 py-2 text-[11px] text-stone-600">
            <p>{task.detail}</p>
            {task.suggestedFix && (
              <p className="mt-1 font-medium text-stone-800">{task.suggestedFix}</p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function readStoredJson<T>(key: string): T | null {
  clearLegacyMonthlyReviewStorage();
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

function writeStoredJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* best-effort */ }
}

function clearStoredJson(key: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(key); } catch { /* best-effort */ }
}

function clearLegacyMonthlyReviewStorage(): void {
  if (legacyMonthlyReviewStorageCleared || typeof window === 'undefined') return;
  legacyMonthlyReviewStorageCleared = true;
  for (const key of LEGACY_MONTHLY_REVIEW_STORAGE_KEYS) {
    clearStoredJson(key);
  }
}

function compactRunForStorage(run: MonthlyReviewRun): MonthlyReviewRun {
  return {
    ...run,
    strategies: run.strategies.map((strategy) => ({
      ...strategy,
      rankedCandidates: [],
      evidenceCandidates: [],
    })),
  };
}

function readStoredRunForBaseline(
  baselineFingerprint: string | null,
  engineVersion: string,
): MonthlyReviewRun | null {
  if (!baselineFingerprint) return null;
  const run = readStoredJson<MonthlyReviewRun>(LAST_RUN_KEY);
  if (!run) return null;
  if (run.baselineFingerprint !== baselineFingerprint) return null;
  if (run.engineVersion !== engineVersion) return null;
  return run;
}

function readStoredMiningSnapshot(): MiningSnapshot | null {
  const snapshot = readStoredJson<Omit<MiningSnapshot, 'source'> & { source?: string }>(
    LAST_MINING_SNAPSHOT_KEY,
  );
  if (!snapshot) return null;
  if (snapshot.source === 'reused') {
    clearStoredJson(LAST_MINING_SNAPSHOT_KEY);
    return null;
  }
  return {
    evaluationCount: snapshot.evaluationCount,
    spendMin: snapshot.spendMin,
    spendMax: snapshot.spendMax,
    feasibleCount: snapshot.feasibleCount,
    source: snapshot.source === 'run' ? 'run' : undefined,
  };
}

function miningSnapshotFromRun(run: MonthlyReviewRun | null): MiningSnapshot | null {
  if (!run) return null;
  const evaluationCount = run.strategies.reduce(
    (total, strategy) => total + strategy.corpusEvaluationCount,
    0,
  );
  const spendMax =
    run.strategies
      .map((strategy) => strategy.spendBoundary.highestSpendTestedTodayDollars)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((a, b) => b - a)[0] ?? null;
  const greenSpends = run.strategies
    .map((strategy) => strategy.spendBoundary.highestGreenSpendTodayDollars)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return {
    evaluationCount,
    spendMin: greenSpends.length > 0 ? Math.min(...greenSpends) : null,
    spendMax,
    source: 'run',
    feasibleCount: run.strategies.reduce(
      (total, strategy) =>
        total +
        strategy.certifications.filter((cert) => cert.verdict === 'green').length,
      0,
    ),
  };
}

function certificationSlotsFromRun(run: MonthlyReviewRun | null): CertificationSlot[] {
  if (!run) return [];
  return run.strategies
    .flatMap((strategy) =>
      strategy.certifications.map((cert) => ({
        candidateId: cert.evaluation.id,
        annualSpendTodayDollars: cert.evaluation.policy.annualSpendTodayDollars,
        status: 'done' as const,
        mode: 'node_host' as const,
        completed: 1,
        total: 1,
        startedAtIso: cert.certifiedAtIso,
        verdict: cert.verdict,
        reasons: cert.pack.reasons.map((reason) => ({
          code: reason.code,
          message: reason.message,
        })),
      })),
    )
    .sort((a, b) => b.annualSpendTodayDollars - a.annualSpendTodayDollars);
}

function parseCertificationReason(reason: string): { code: string; message: string } {
  const splitAt = reason.indexOf(':');
  if (splitAt <= 0) return { code: 'certification_reason', message: reason };
  return {
    code: reason.slice(0, splitAt).trim(),
    message: reason.slice(splitAt + 1).trim(),
  };
}

function certificationSlotsFromJobLogs(job: ClusterMonthlyReviewJob): CertificationSlot[] {
  const slotsById = new Map<string, CertificationSlot>();
  for (const line of job.logTail) {
    const certifyingMatch = line.match(
      /\bcertifying\s+(pol_[a-z0-9]+)\s+at\s+\$([\d,]+)\/yr\s+\((\d+)\/(\d+)\)/i,
    );
    if (certifyingMatch) {
      const candidateId = certifyingMatch[1];
      const annualSpendTodayDollars = Number(certifyingMatch[2]?.replaceAll(',', ''));
      const completed = Math.max(0, Number(certifyingMatch[3]) - 1);
      const total = Number(certifyingMatch[4]);
      if (candidateId && Number.isFinite(annualSpendTodayDollars)) {
        slotsById.set(candidateId, {
          candidateId,
          annualSpendTodayDollars,
          status: 'running',
          mode: 'node_host',
          completed: Number.isFinite(completed) ? completed : 0,
          total: Number.isFinite(total) ? total : 0,
          startedAtIso: job.startedAtIso,
          verdict: null,
          reasons: [],
        });
      }
      continue;
    }
    const completedMatch = line.match(
      /\b(pol_[a-z0-9]+)\s+certification\s+(green|yellow|red)\b/i,
    );
    if (completedMatch) {
      const candidateId = completedMatch[1];
      const verdict = completedMatch[2] as MonthlyReviewCertification['verdict'];
      const slot = candidateId ? slotsById.get(candidateId) : null;
      if (candidateId && slot) {
        slotsById.set(candidateId, {
          ...slot,
          status: 'done',
          completed: slot.total || 1,
          total: slot.total || 1,
          verdict,
        });
      }
    }
  }
  return [...slotsById.values()];
}

function certificationSlotsFromJob(job: ClusterMonthlyReviewJob): CertificationSlot[] {
  const slotsById = new Map<string, CertificationSlot>();
  for (const slot of certificationSlotsFromJobLogs(job)) {
    slotsById.set(slot.candidateId, slot);
  }
  const attempts = job.certificationAttempts ?? [];
  for (const attempt of attempts) {
    const progress = attempt.progress ?? null;
    const isRunning = attempt.status === 'running';
    const isDone = !isRunning;
    const total =
      progress && Number.isFinite(progress.total)
        ? progress.total
        : isDone
          ? 1
          : 0;
    const completed =
      progress && Number.isFinite(progress.completed)
        ? progress.completed
        : isDone
          ? total
          : 0;
    slotsById.set(attempt.policyId, {
      candidateId: attempt.policyId,
      annualSpendTodayDollars: attempt.annualSpendTodayDollars,
      status: isRunning ? 'running' : 'done',
      mode: 'node_host',
      hostPeerId: attempt.assignedHost?.peerId ?? null,
      hostDisplayName: attempt.assignedHost?.displayName ?? null,
      completed,
      total,
      startedAtIso: attempt.startedAtIso ?? attempt.attemptedAtIso,
      verdict: attempt.verdict,
      reasons: attempt.reasons.map(parseCertificationReason),
    });
  }
  return [...slotsById.values()].sort(
    (a, b) => b.annualSpendTodayDollars - a.annualSpendTodayDollars,
  );
}

function aiProgressFromRun(run: MonthlyReviewRun | null): AiReviewProgressStep[] {
  if (!run?.aiApproval) return initialAiReviewProgress();
  const atIso = run.aiApproval.generatedAtIso;
  return [
    {
      id: 'packet_prepared',
      title: 'Validation packet prepared',
      detail: `${run.strategies.length} strategy row${run.strategies.length === 1 ? '' : 's'} · ${run.strategies.flatMap((strategy) => strategy.certifications).length} certification row${run.strategies.flatMap((strategy) => strategy.certifications).length === 1 ? '' : 's'}`,
      status: 'done',
      atIso,
    },
    {
      id: 'sent_to_model',
      title: 'Reviewing the validation packet',
      detail: `Packet sent to ${run.aiApproval.model}.`,
      status: 'done',
      atIso,
    },
    {
      id: 'model_response',
      title: 'Model response received',
      detail: `${run.aiApproval.verdict} response received with ${run.aiApproval.confidence} confidence.`,
      status: 'done',
      atIso,
    },
    {
      id: 'checklist_merged',
      title: 'Checklist merged',
      detail: `${run.aiApproval.findings.length} AI finding${run.aiApproval.findings.length === 1 ? '' : 's'} merged with packet signals.`,
      status: 'done',
      atIso,
    },
    {
      id: 'verdict_ready',
      title: 'Verdict ready',
      detail: `Final AI co-review verdict: ${run.aiApproval.verdict}.`,
      status: 'done',
      atIso,
    },
  ];
}

function aiProgressFromPacket(
  packet: MonthlyReviewValidationPacket,
  aiReviewRequested: boolean,
): AiReviewProgressStep[] {
  const atIso = packet.generatedAtIso;
  const strategyCount = packet.strategies.length;
  const certificationCount = packet.certificationSummary.length;
  return initialAiReviewProgress().map((step) => {
    if (step.id === 'packet_prepared') {
      return {
        ...step,
        status: 'done',
        detail: `${strategyCount} strategy row${strategyCount === 1 ? '' : 's'} · ${certificationCount} certification row${certificationCount === 1 ? '' : 's'}`,
        atIso,
      };
    }
    if (step.id === 'sent_to_model') {
      return {
        ...step,
        status: aiReviewRequested ? 'active' : 'waiting',
        detail: aiReviewRequested
          ? 'Packet sent to AI reviewer; waiting for response.'
          : 'Preparing reviewer request.',
        atIso: aiReviewRequested ? atIso : null,
      };
    }
    return step;
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export function MonthlyReviewPanel({
  assumptions,
  baselinePath,
  baselineFingerprint,
  engineVersion,
  dispatcherUrl,
  legacyTargetTodayDollars,
  onProgressStageChange,
}: Props): JSX.Element | null {
  const cluster = useClusterSession();
  const clusterRef = useRef(cluster);
  const [restoredRun] = useState<MonthlyReviewRun | null>(() =>
    readStoredRunForBaseline(baselineFingerprint, engineVersion),
  );
  const [runState, setRunState] = useState<
    | { kind: 'idle' }
    | { kind: 'running'; message: string }
    | { kind: 'complete'; run: MonthlyReviewRun }
    | { kind: 'failed'; reason: string }
  >(() => (restoredRun ? { kind: 'complete', run: restoredRun } : { kind: 'idle' }));
  const [modelHealthPreflight, setModelHealthPreflight] =
    useState<ModelHealthPreflightState>({ kind: 'idle' });
  const [reviewStage, setReviewStage] = useState<MonthlyReviewStage>(() =>
    restoredRun ? 'complete' : 'idle',
  );
  const reviewStageRef = useRef<MonthlyReviewStage>(
    restoredRun ? 'complete' : 'idle',
  );
  const serverReviewStartingRef = useRef(false);
  const serverReviewWatcherRef = useRef(false);
  const [failedStep, setFailedStep] = useState<FailedReviewStep>(null);
  const [miningSnapshot, setMiningSnapshot] = useState<MiningSnapshot | null>(() =>
    readStoredMiningSnapshot() ??
    miningSnapshotFromRun(restoredRun),
  );
  // Sticky live mine progress for the Step 1 card. Mirrors cluster.session
  // while a mining session is active, BUT holds its last value when the
  // dispatcher transitions sessions (e.g. pass 1 → pass 2). Without the
  // stickiness the body would flash empty for a beat between passes.
  const [liveMineProgress, setLiveMineProgress] = useState<{
    evaluated: number;
    total: number;
    hosts: number;
    inFlightBatches: number;
    batchesAssigned: number;
    startedAtMs: number | null;
  } | null>(null);
  const [minePanelCollapsed, setMinePanelCollapsed] = useState(false);
  const minePanelAutoCollapsedRef = useRef(false);
  const [adoptingCertification, setAdoptingCertification] =
    useState<MonthlyReviewCertification | null>(null);
  const [certificationSlots, setCertificationSlots] = useState<CertificationSlot[]>(
    () => certificationSlotsFromRun(restoredRun),
  );
  const [aiReviewProgress, setAiReviewProgress] = useState<AiReviewProgressStep[]>(
    () => aiProgressFromRun(restoredRun),
  );
  const aiReviewStartedAtRef = useRef<number | null>(null);
  const [showRawAiResponse, setShowRawAiResponse] = useState(false);
  const [showValidationPacket, setShowValidationPacket] = useState(false);
  const [lastValidationPacket, setLastValidationPacket] =
    useState<MonthlyReviewValidationPacket | null>(() =>
      readStoredJson<MonthlyReviewValidationPacket>(LAST_AI_PACKET_KEY),
    );
  const [lastAiResponse, setLastAiResponse] = useState<MonthlyReviewRun['aiApproval'] | null>(
    () => readStoredJson<MonthlyReviewRun['aiApproval']>(LAST_AI_RESPONSE_KEY) ?? restoredRun?.aiApproval ?? null,
  );
  const [transactionEvents, setTransactionEvents] = useState<ReviewTransactionEvent[]>(
    () => readStoredJson<ReviewTransactionEvent[]>(LAST_TRANSACTION_EVENTS_KEY) ?? [],
  );
  const transactionEventsRef = useRef<ReviewTransactionEvent[]>(transactionEvents);
  const nextTransactionEventIdRef = useRef(
    transactionEvents.reduce((maxId, event) => Math.max(maxId, event.id), 0) + 1,
  );
  const currentData = useAppStore((state) => state.appliedData);
  const adoptMinedPolicy = useAppStore((state) => state.adoptMinedPolicy);
  const undoLastPolicyAdoption = useAppStore((state) => state.undoLastPolicyAdoption);
  const lastPolicyAdoption = useAppStore((state) => state.lastPolicyAdoption);

  useEffect(() => { clusterRef.current = cluster; }, [cluster]);

  // The monthly-review screen is a controller, not a browser compute host.
  // The old mine screen enforced this inside PolicyMiningStatusCard; the
  // simplified one-button screen no longer mounts that card, so keep the
  // protection here before any pass-1/pass-2 session starts. This avoids
  // Chrome renderer OOMs ("Error code 5") from large browser Web Worker pools.
  useEffect(() => {
    setBrowserHostMode('off');
    if (!clusterRef.current.session) {
      clusterRef.current.reconnect();
    }
  }, []);

  // Mirror cluster.session into liveMineProgress so Step 1's card narrates
  // progress in real time.
  //
  // CRITICAL: depend on the actual VALUES (policiesEvaluated, totalPolicies,
  // host count), not the `cluster.session` object reference. The cluster
  // client may reuse the session object and mutate its `stats` field in place
  // when broadcasts arrive — if we depend on the object reference, React's
  // Object.is bail-out fires and the effect never re-runs past the first
  // batch_result. (Symptom: UI stuck at the first small batch forever while the
  // dispatcher actually progresses to completion.)
  //
  // We also skip pass-2 sessions (cliff refinement, typically ≤50 policies)
  // because they would flash a misleading "1/1" right after pass 1's larger
  // run finishes. Holding the pass-1 value through pass-2 keeps the card calm.
  const livePoliciesEvaluated = cluster.session?.stats?.policiesEvaluated ?? null;
  const liveTotalPolicies = cluster.session?.stats?.totalPolicies ?? null;
  const liveHostCount = cluster.peers.filter((p) => p.roles.includes('host')).length;
  const liveInFlightBatches = cluster.session?.metrics?.inFlightBatches ?? null;
  const liveBatchesAssigned = cluster.session?.metrics?.batchesAssigned ?? null;
  const liveSessionStartedIso = cluster.session?.startedAtIso ?? null;
  useEffect(() => {
    if (livePoliciesEvaluated === null || liveTotalPolicies === null) return;
    if (liveTotalPolicies > 0 && liveTotalPolicies < 100) return; // pass-2 refinement
    const startedAtMs = liveSessionStartedIso ? Date.parse(liveSessionStartedIso) : null;
    setLiveMineProgress({
      evaluated: livePoliciesEvaluated,
      total: liveTotalPolicies,
      hosts: liveHostCount,
      inFlightBatches: liveInFlightBatches ?? 0,
      batchesAssigned: liveBatchesAssigned ?? 0,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    });
  }, [
    livePoliciesEvaluated,
    liveTotalPolicies,
    liveHostCount,
    liveInFlightBatches,
    liveBatchesAssigned,
    liveSessionStartedIso,
  ]);

  // Tick once a second while cluster work is active so elapsed-time lines
  // stay alive even between dispatcher broadcasts.
  const [throughputTickMs, setThroughputTickMs] = useState(() => Date.now());
  useEffect(() => {
    if (
      reviewStage !== 'mining' &&
      reviewStage !== 'connecting' &&
      reviewStage !== 'certifying' &&
      reviewStage !== 'ai_review'
    ) {
      return undefined;
    }
    const id = window.setInterval(() => setThroughputTickMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [reviewStage]);

  // Reset live progress when a new run begins so we don't show stale data
  // from the previous review's mining phase.
  useEffect(() => {
    if (reviewStage === 'idle' || reviewStage === 'connecting') {
      setLiveMineProgress(null);
    }
  }, [reviewStage]);

  const minePanelShouldAutoCollapse =
    miningSnapshot !== null &&
    (reviewStage === 'certifying' || reviewStage === 'ai_review' || reviewStage === 'complete');
  useEffect(() => {
    if (!minePanelShouldAutoCollapse || minePanelAutoCollapsedRef.current) return;
    minePanelAutoCollapsedRef.current = true;
    setMinePanelCollapsed(true);
  }, [minePanelShouldAutoCollapse]);

  const canRun = !!baselineFingerprint;
  const appendTransactionEvent = useCallback((message: string) => {
    const id = nextTransactionEventIdRef.current++;
    const event = { id, atIso: new Date().toISOString(), message };
    const nextEvents = [...transactionEventsRef.current, event].slice(-80);
    transactionEventsRef.current = nextEvents;
    setTransactionEvents(nextEvents);
    writeStoredJson(LAST_TRANSACTION_EVENTS_KEY, nextEvents);
  }, []);

  const setStage = useCallback(
    (stage: MonthlyReviewStage) => {
      reviewStageRef.current = stage;
      setReviewStage(stage);
      onProgressStageChange?.(stage);
    },
    [onProgressStageChange],
  );

  const updateAiReviewProgressStep = useCallback((
    id: AiReviewProgressStepId,
    status: AiReviewProgressStatus,
    detail?: string,
  ) => {
    const atIso = new Date().toISOString();
    setAiReviewProgress((steps) =>
      steps.map((step) =>
        step.id === id
          ? {
            ...step,
            status,
            detail: detail ?? step.detail,
            atIso,
          }
          : step,
      ),
    );
  }, []);

  const watchServerOwnedReviewJob = useCallback(async (shouldStop?: () => boolean) => {
    if (!dispatcherUrl) {
      throw new Error('Monthly review needs the dispatcher for mining and AI review.');
    }
    if (serverReviewWatcherRef.current) return;
    serverReviewWatcherRef.current = true;
    try {
      let lastLogLine = '';
      for (;;) {
        if (shouldStop?.()) return;
        const job = await loadClusterMonthlyReviewJob(dispatcherUrl);
        if (!job) {
          throw new Error('Monthly Review server job is no longer running. Start a fresh run.');
        }
        const latestLogLine = job.logTail.at(-1) ?? '';
        if (latestLogLine && latestLogLine !== lastLogLine) {
          lastLogLine = latestLogLine;
          appendTransactionEvent(latestLogLine);
          setRunState({ kind: 'running', message: latestLogLine });
          if (latestLogLine.toLowerCase().includes('certifying')) {
            setStage('certifying');
          }
        }
        const jobCertificationSlots = certificationSlotsFromJob(job);
        if (jobCertificationSlots.length > 0 && !job.run) {
          setCertificationSlots(jobCertificationSlots);
          if (
            !job.packet &&
            jobCertificationSlots.some((slot) => slot.status === 'running')
          ) {
            setStage('certifying');
          }
        }
        const aiReviewRequested = job.logTail.some((line) =>
          line.startsWith('AI co-review:'),
        );
        if (job.packet) {
          setStage('ai_review');
          setLastValidationPacket(job.packet);
          writeStoredJson(LAST_AI_PACKET_KEY, job.packet);
          if (!job.aiApproval) {
            if (aiReviewRequested && aiReviewStartedAtRef.current === null) {
              aiReviewStartedAtRef.current = Date.now();
            }
            setAiReviewProgress(aiProgressFromPacket(job.packet, aiReviewRequested));
          }
        }
        if (job.aiApproval) {
          setLastAiResponse(job.aiApproval);
          writeStoredJson(LAST_AI_RESPONSE_KEY, job.aiApproval);
        }
        if (job.run) {
          const nextMiningSnapshot = miningSnapshotFromRun(job.run);
          setMiningSnapshot(nextMiningSnapshot);
          if (nextMiningSnapshot) {
            writeStoredJson(LAST_MINING_SNAPSHOT_KEY, nextMiningSnapshot);
          }
          setCertificationSlots(certificationSlotsFromRun(job.run));
          setAiReviewProgress(aiProgressFromRun(job.run));
        }
        if (clusterRef.current.session) {
          setStage('mining');
        } else if (job.run?.aiApproval) {
          setStage('ai_review');
        }
        if (job.status === 'complete') {
          if (!job.run) {
            throw new Error('Monthly Review completed, but no run artifact was written.');
          }
          const finalRun = job.run;
          if (job.aiApproval) {
            finalRun.aiApproval = job.aiApproval;
          }
          setStage('complete');
          appendTransactionEvent(`server job complete: ${finalRun.recommendation.status}`);
          writeStoredJson(LAST_RUN_KEY, compactRunForStorage(finalRun));
          writeStoredJson(LAST_TRANSACTION_EVENTS_KEY, transactionEventsRef.current);
          setRunState({ kind: 'complete', run: finalRun });
          return;
        }
        if (job.status === 'failed') {
          throw new Error(job.error ?? 'Server-side Monthly Review failed.');
        }
        await waitMs(1_000);
      }
    } finally {
      serverReviewWatcherRef.current = false;
    }
  }, [appendTransactionEvent, dispatcherUrl, setStage]);

  const runServerOwnedReview = useCallback(async () => {
    if (!dispatcherUrl) {
      throw new Error('Monthly review needs the dispatcher for mining and AI review.');
    }
    serverReviewStartingRef.current = true;
    try {
      setStage('connecting');
      setRunState({ kind: 'running', message: 'Starting server-side Monthly Review…' });
      appendTransactionEvent('server-side review requested');
      const started = await startClusterMonthlyReviewJob(dispatcherUrl, {
        mineMode: 'always',
        maxCertCandidates: 8,
        certificationMaxConcurrency: 4,
      });
      if (!started) {
        throw new Error('Dispatcher did not return a Monthly Review job.');
      }
      appendTransactionEvent(`server job ${started.id} started`);
      await watchServerOwnedReviewJob();
    } finally {
      serverReviewStartingRef.current = false;
    }
  }, [appendTransactionEvent, dispatcherUrl, setStage, watchServerOwnedReviewJob]);

  useEffect(() => {
    if (
      !dispatcherUrl ||
      !baselineFingerprint ||
      (runState.kind !== 'idle' && runState.kind !== 'running')
    ) {
      return;
    }
    let cancelled = false;
    let checking = false;
    const failFromProbe = (reason: string) => {
      const failedAt = failedStepForStage(reviewStageRef.current);
      setFailedStep(failedAt);
      setStage('failed');
      appendTransactionEvent(`server-side review failed: ${reason}`);
      setRunState({ kind: 'failed', reason });
    };
    const probeServerJob = async () => {
      if (
        cancelled ||
        checking ||
        serverReviewStartingRef.current ||
        serverReviewWatcherRef.current
      ) {
        return;
      }
      checking = true;
      try {
        const job = await loadClusterMonthlyReviewJob(dispatcherUrl);
        if (cancelled) return;
        if (!job) {
          if (runState.kind === 'running') {
            failFromProbe('Monthly Review server job is no longer running. Start a fresh run.');
          }
          return;
        }
        if (job.status === 'complete' && job.run) {
          const finalRun = job.run;
          if (job.aiApproval) {
            finalRun.aiApproval = job.aiApproval;
            setLastAiResponse(job.aiApproval);
            writeStoredJson(LAST_AI_RESPONSE_KEY, job.aiApproval);
          }
          if (job.packet) {
            setLastValidationPacket(job.packet);
            writeStoredJson(LAST_AI_PACKET_KEY, job.packet);
          }
          const nextMiningSnapshot = miningSnapshotFromRun(finalRun);
          setMiningSnapshot(nextMiningSnapshot);
          if (nextMiningSnapshot) {
            writeStoredJson(LAST_MINING_SNAPSHOT_KEY, nextMiningSnapshot);
          }
          setCertificationSlots(certificationSlotsFromRun(finalRun));
          setAiReviewProgress(aiProgressFromRun(finalRun));
          setStage('complete');
          writeStoredJson(LAST_RUN_KEY, compactRunForStorage(finalRun));
          setRunState({ kind: 'complete', run: finalRun });
          return;
        }
        if (job.status === 'failed') {
          failFromProbe(job.error ?? 'Server-side Monthly Review failed.');
          return;
        }
        if (job.status !== 'running') return;
        setBrowserHostMode('off');
        setStage('connecting');
        appendTransactionEvent(`reattached to server job ${job.id}`);
        setRunState({
          kind: 'running',
          message: 'Reattached to server-side Monthly Review...',
        });
        await watchServerOwnedReviewJob(() => cancelled);
      } catch (error) {
        if (cancelled) return;
        if (runState.kind === 'running') {
          const reason = error instanceof Error ? error.message : String(error);
          failFromProbe(reason);
        }
      } finally {
        checking = false;
      }
    };
    void probeServerJob();
    const id = window.setInterval(() => {
      void probeServerJob();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    appendTransactionEvent,
    baselineFingerprint,
    dispatcherUrl,
    runState.kind,
    setStage,
    watchServerOwnedReviewJob,
  ]);

  const ensureFreshModelHealth = useCallback(async () => {
    if (!dispatcherUrl) {
      throw new Error('Model Health preflight needs the dispatcher.');
    }
    const existing = await loadClusterModelHealthJob(dispatcherUrl);
    if (!modelHealthReportNeedsRefresh(existing) && existing.job?.status !== 'running') {
      setModelHealthPreflight({ kind: 'idle' });
      return;
    }

    setModelHealthPreflight({
      kind: 'running',
      message: modelHealthPuckMessage(existing),
    });
    appendTransactionEvent('model health preflight started');
    const started =
      existing.job?.status === 'running'
        ? existing
        : await startClusterModelHealthJob(dispatcherUrl, {
            maxAgeHours: MODEL_HEALTH_MAX_AGE_HOURS,
          });
    if (started.skipped || !modelHealthReportNeedsRefresh(started)) {
      setModelHealthPreflight({ kind: 'idle' });
      appendTransactionEvent('model health preflight skipped: fresh passed report');
      return;
    }

    for (;;) {
      const latest = await loadClusterModelHealthJob(dispatcherUrl);
      setModelHealthPreflight({
        kind: 'running',
        message: modelHealthPuckMessage(latest),
      });
      if (latest.job?.status === 'complete') {
        if (latest.report?.status === 'passed') {
          setModelHealthPreflight({ kind: 'idle' });
          appendTransactionEvent('model health preflight passed');
          return;
        }
        const reason = 'Model Health completed but did not produce a passing report.';
        setModelHealthPreflight({
          kind: 'failed',
          reason,
          command: 'npm run verify:model:quick:strict',
        });
        throw new Error(reason);
      }
      if (latest.job?.status === 'failed') {
        const reason =
          latest.job.error ??
          latest.report?.strict?.failures?.[0]?.message ??
          'Model Health preflight failed.';
        setModelHealthPreflight({
          kind: 'failed',
          reason,
          command: 'npm run verify:model:quick:strict',
        });
        throw new Error(reason);
      }
      await waitMs(1_000);
    }
  }, [appendTransactionEvent, dispatcherUrl]);

  const start = async () => {
    if (!baselineFingerprint) return;
    setBrowserHostMode('off');
    setFailedStep(null);
    setMiningSnapshot(null);
    setMinePanelCollapsed(false);
    minePanelAutoCollapsedRef.current = false;
    setLastValidationPacket(null);
    setLastAiResponse(null);
    setAiReviewProgress(initialAiReviewProgress());
    aiReviewStartedAtRef.current = null;
    clearStoredJson(LAST_RUN_KEY);
    clearStoredJson(LAST_MINING_SNAPSHOT_KEY);
    clearStoredJson(LAST_AI_PACKET_KEY);
    clearStoredJson(LAST_AI_RESPONSE_KEY);
    clearStoredJson(LAST_TRANSACTION_EVENTS_KEY);
    setCertificationSlots([]);
    nextTransactionEventIdRef.current = 1;
    transactionEventsRef.current = [];
    setTransactionEvents([]);
    setStage('connecting');
    setRunState({ kind: 'running', message: 'Checking Model Health before mining...' });
    try {
      await ensureFreshModelHealth();
      if (!clusterRef.current.session) {
        clusterRef.current.reconnect();
      }
      appendTransactionEvent('review started');
      setRunState({ kind: 'running', message: 'Starting server-side Monthly Review...' });
      await runServerOwnedReview();
    } catch (serverError) {
      const failedAt = failedStepForStage(reviewStageRef.current);
      const reason = serverError instanceof Error ? serverError.message : String(serverError);
      setFailedStep(failedAt);
      setStage('failed');
      appendTransactionEvent(`server-side review failed: ${reason}`);
      setRunState({ kind: 'failed', reason });
    }
  };

  if (!baselineFingerprint) return null;

  const run = runState.kind === 'complete' ? runState.run : null;
  const isRunning = runState.kind === 'running';
  const selectedSpendingPath =
    lastValidationPacket?.rawExportEvidence.selectedPolicy?.spendingPath ?? null;
  const firstRetirementAnnualSpend =
    selectedSpendingPath?.firstRetirementYearAnnualSpendTodayDollars ?? null;
  const firstTravelAnnualSpend =
    selectedSpendingPath?.annualSpendRows.find((row) =>
      row.year === selectedSpendingPath.retirementYear,
    )?.travelAnnualSpendTodayDollars ??
    selectedSpendingPath?.annualSpendRows[0]?.travelAnnualSpendTodayDollars ??
    null;
  const annualTravelOverlayForCandidateDisplay =
    firstTravelAnnualSpend ??
    Math.max(0, currentData.spending.travelEarlyRetirementAnnual ?? 0);
  const displayAnnualSpendForCandidate = (annualCoreSpend: number | null) =>
    annualSpendWithTravelOverlay(
      annualCoreSpend,
      annualTravelOverlayForCandidateDisplay,
    );
  const recommendedTotalAnnualSpend =
    firstRetirementAnnualSpend ??
    displayAnnualSpendForCandidate(run?.recommendation.annualSpendTodayDollars ?? null);
  const recommendedTotalMonthlySpend =
    recommendedTotalAnnualSpend === null ? null : recommendedTotalAnnualSpend / 12;
  const recommendedLifetimeAverageAnnualSpend =
    selectedSpendingPath?.lifetimeAverageAnnualSpendTodayDollars ?? null;
  const reviewRetirementYear =
    selectedSpendingPath?.retirementYear ??
    parseYearFromIso(currentData.income.salaryEndDate);
  const reviewInflation =
    lastValidationPacket?.rawExportEvidence.assumptions.inflation ??
    assumptions.inflation;
  const packetNorthStarBudgets =
    lastValidationPacket?.rawExportEvidence.northStarBudgets ?? null;
  const packetCurrentPlanBudget = packetNorthStarBudgets?.currentPlan ?? null;
  const packetSelectedNorthStarBudget = packetNorthStarBudgets?.selectedPolicy ?? null;

  const selectedCertification =
    run?.strategies
      .map((s) => s.selectedCertification)
      .find(
        (cert): cert is MonthlyReviewCertification =>
          !!cert &&
          cert.strategyId === run.recommendation.strategyId &&
          cert.evaluation.id === run.recommendation.policyId,
      ) ?? null;
  const boldinStyleComparison = buildBoldinStyleSpendingComparison({
    data: currentData,
    baselinePath,
    currentPlanBudget: packetCurrentPlanBudget,
    selectedCertification,
    selectedSpendingPath,
    inflation: reviewInflation,
  });
  const selectedNorthStarBudget: NorthStarBudget | null =
    packetSelectedNorthStarBudget ??
    (selectedCertification === null
      ? null
      : buildNorthStarBudgetFromCertification({
          cert: selectedCertification,
          spendingPath: selectedSpendingPath,
          retirementYear: reviewRetirementYear,
          inflation: reviewInflation,
          legacyTarget: legacyTargetTodayDollars,
          fallbackTravelAnnual: annualTravelOverlayForCandidateDisplay,
        }));
  const certificationBudgetAnnualByCoreSpend =
    buildCertificationBudgetAnnualByCoreSpend(
      run,
      reviewRetirementYear,
      reviewInflation,
      legacyTargetTodayDollars,
      annualTravelOverlayForCandidateDisplay,
    );
  const northStarMonthlySpend =
    selectedNorthStarBudget?.totalMonthlyBudget ??
    recommendedTotalMonthlySpend;
  const northStarAnnualSpend =
    northStarMonthlySpend === null ? null : northStarMonthlySpend * 12;
  const northStarSpendLabel =
    selectedNorthStarBudget?.totalMonthlyBudget === null ||
    selectedNorthStarBudget?.totalMonthlyBudget === undefined
      ? 'Next-year lifestyle target'
      : 'Next-year total budget';
  const northStarYearLabel =
    selectedNorthStarBudget?.year === null ||
    selectedNorthStarBudget?.year === undefined
      ? 'first retirement year'
      : String(selectedNorthStarBudget.year);

  const alreadyAdopted =
    !!selectedCertification &&
    lastPolicyAdoption?.evaluation?.id === selectedCertification.evaluation.id;

  const aiApproval = run?.aiApproval ?? lastAiResponse;
  const reviewChecklistItems: ReviewChecklistItem[] = [
    ...(aiApproval?.findings ?? []).map((f: MonthlyReviewAiFinding) => ({
      id: f.id,
      status: f.status,
      title: f.title,
      detail: f.detail,
      evidence: f.evidence,
      recommendation: f.recommendation,
      source: 'AI' as const,
    })),
    ...(lastValidationPacket?.householdSignals ?? []).map((s: MonthlyReviewQaSignal) => ({
      id: s.id,
      status: s.status,
      title: s.title,
      detail: s.detail,
      evidence: s.evidence,
      recommendation: s.recommendation,
      source: 'Household' as const,
    })),
  ];

  const certDone = certificationSlots.filter((s) => s.status === 'done').length;
  const certTotal = certificationSlots.length;
  const runningCertSlots = certificationSlots.filter((s) => s.status === 'running');
  const runningCertElapsedMs =
    runningCertSlots.length > 0
      ? Math.max(
        ...runningCertSlots.map((slot) =>
          Math.max(0, throughputTickMs - Date.parse(slot.startedAtIso)),
        ),
      )
      : null;
  const runningCertSpendLine =
    runningCertSlots.length > 0
      ? runningCertSlots
        .map((slot) => `${formatCurrency(displayAnnualSpendForCandidate(slot.annualSpendTodayDollars))}/yr`)
        .join(', ')
      : null;
  const runningCertMode =
    runningCertSlots.some((slot) => slot.mode === 'node_host')
      ? 'worker host'
      : runningCertSlots.some((slot) => slot.mode === 'dry_run')
        ? 'dry-run'
        : null;
  const criticalTasks = run?.modelTasks.filter((t) => t.blocksApproval && t.status === 'open') ?? [];
  const isGreen = run?.recommendation.status === 'green';
  const aiVerdict = aiApproval?.verdict ?? null;
  const aiReviewElapsedMs =
    aiReviewStartedAtRef.current === null
      ? 0
      : Math.max(0, throughputTickMs - aiReviewStartedAtRef.current);
  const minePanelSummary =
    miningSnapshot !== null
      ? `${miningSnapshot.evaluationCount.toLocaleString()} policies · ${formatCurrency(displayAnnualSpendForCandidate(miningSnapshot.spendMin))}-${formatCurrency(displayAnnualSpendForCandidate(miningSnapshot.spendMax))}/yr first-year total · ${(miningSnapshot.feasibleCount ?? 0).toLocaleString()} meet floor`
      : liveMineProgress !== null
        ? `${liveMineProgress.evaluated.toLocaleString()} / ${liveMineProgress.total.toLocaleString()} policies`
        : null;

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div className="space-y-3">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">
            Monthly Review
          </p>
          <h2 className="mt-0.5 text-base font-semibold text-stone-950">
            North-star max spend
          </h2>
          <p className="mt-1 text-[11px] text-stone-500">
            Maximize next-year spending, favor early travel, protect a {formatCurrency(legacyTargetTodayDollars)} care/legacy reserve.
          </p>
        </div>
        <button
          type="button"
          disabled={!canRun || isRunning}
          onClick={() => void start()}
          className="shrink-0 rounded-full bg-blue-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {isRunning ? 'Running…' : run ? 'Re-run' : 'Run monthly review'}
        </button>
      </div>

      {modelHealthPreflight.kind !== 'idle' && (
        <ModelHealthPreflightPuck state={modelHealthPreflight} />
      )}

      {MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          Flow-debug mode: certification is a dry-run, capped at{' '}
          {MONTHLY_REVIEW_POLICY_TRIAL_BUDGET.toLocaleString()} policy-trials.
        </p>
      )}

      {/* ── Step 1: Mine ──────────────────────────────────────────────────────
         Body content priority:
           1. Failed → error message
           2. Active mining → live progress line (replaces summary while
              the session is in flight; sticks across pass-1/pass-2 gap)
           3. Done → evaluation count + spend range summary
           4. Connecting → "Connecting…" placeholder */}
      <StepCard
        n={1}
        title="Mine"
        status={stepStatusForMine(reviewStage, failedStep)}
        collapsible
        collapsed={minePanelCollapsed}
        collapsedSummary={minePanelSummary}
        onCollapsedChange={setMinePanelCollapsed}
      >
        {reviewStage === 'failed' && failedStep === 'mine' ? (
          <p className="text-rose-700">
            {runState.kind === 'failed' ? runState.reason : 'Mining failed.'}
          </p>
        ) : reviewStage === 'connecting' || reviewStage === 'mining' ? (
          (() => {
            const pct =
              liveMineProgress && liveMineProgress.total > 0
                ? Math.min(100, (liveMineProgress.evaluated / liveMineProgress.total) * 100)
                : null;
            const primary = liveMineProgress
              ? liveMineProgress.total > 0
                ? `${liveMineProgress.evaluated.toLocaleString()} / ${liveMineProgress.total.toLocaleString()} policies · ${liveMineProgress.hosts} host${liveMineProgress.hosts === 1 ? '' : 's'}`
                : `${liveMineProgress.evaluated.toLocaleString()} policies · ${liveMineProgress.hosts} host${liveMineProgress.hosts === 1 ? '' : 's'}`
              : reviewStage === 'connecting'
                ? 'Connecting to cluster…'
                : 'Searching policy space…';
            // Sub-line: batches in flight + throughput, like the old
            // performance panel but compact. Throughput is policies/sec
            // since the active session started. Recalculated each tick of
            // throughputTickMs so the number stays current even between
            // dispatcher broadcasts.
            const elapsedSec =
              liveMineProgress?.startedAtMs && liveMineProgress.startedAtMs > 0
                ? Math.max(0.5, (throughputTickMs - liveMineProgress.startedAtMs) / 1_000)
                : null;
            const throughput =
              liveMineProgress && elapsedSec !== null && liveMineProgress.evaluated > 0
                ? Math.round(liveMineProgress.evaluated / elapsedSec)
                : null;
            const batchLine =
              liveMineProgress && liveMineProgress.batchesAssigned > 0
                ? `${liveMineProgress.inFlightBatches.toLocaleString()} of ${liveMineProgress.batchesAssigned.toLocaleString()} batches in flight`
                : null;
            const subParts: string[] = [];
            if (batchLine) subParts.push(batchLine);
            if (throughput !== null) subParts.push(`${throughput.toLocaleString()}/sec`);
            return (
              <div className="space-y-2">
                <p className="tabular-nums text-stone-700">{primary}</p>
                {pct !== null && (
                  <div className="h-1 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-[width] duration-500 ease-out"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                {subParts.length > 0 && (
                  <p className="text-[11px] tabular-nums text-stone-500">
                    {subParts.join(' · ')}
                  </p>
                )}
              </div>
            );
          })()
        ) : miningSnapshot ? (
          <div className="space-y-1 text-stone-700">
            <p>
              <span className="tabular-nums font-semibold">{miningSnapshot.evaluationCount.toLocaleString()}</span>{' '}
              policies evaluated · spend range{' '}
              <span className="tabular-nums font-semibold">{formatCurrency(displayAnnualSpendForCandidate(miningSnapshot.spendMin))}</span>
              {' – '}
              <span className="tabular-nums font-semibold">{formatCurrency(displayAnnualSpendForCandidate(miningSnapshot.spendMax))}</span>/yr first-year total
            </p>
            {annualTravelOverlayForCandidateDisplay > 0 && (
              <p className="text-[11px] tabular-nums text-stone-500">
                Includes {formatCurrency(annualTravelOverlayForCandidateDisplay)}/yr first-year travel overlay.
              </p>
            )}
            <p className="text-stone-500">
              <span className="tabular-nums">{(miningSnapshot.feasibleCount ?? 0).toLocaleString()}</span> meet the ≥85% solvency floor
            </p>
          </div>
        ) : null}
      </StepCard>

      {/* ── Step 2: Model validation ────────────────────────────────────────── */}
      <StepCard n={2} title="Model validation" status={stepStatusForCertify(reviewStage, failedStep)}>
        {certificationSlots.length > 0 ? (
          <div className="space-y-3">
            <p className="text-stone-500">
              {certDone < certTotal
                ? `${certDone} of ${certTotal} candidates certified`
                : `All ${certTotal} candidates certified — pick = highest green`}
            </p>
            {runningCertSpendLine && runningCertElapsedMs !== null && (
              <p className="text-[11px] tabular-nums text-stone-600">
                {runningCertMode ?? 'certification'} active · testing spend levels {runningCertSpendLine} · total budget pending · elapsed{' '}
                {formatDuration(runningCertElapsedMs)}
              </p>
            )}
            <SpendBoundaryStrip
              slots={certificationSlots}
              recommendedAnnualSpend={run?.recommendation.annualSpendTodayDollars ?? null}
              annualTravelOverlay={annualTravelOverlayForCandidateDisplay}
              budgetAnnualByCoreSpend={certificationBudgetAnnualByCoreSpend}
            />
          </div>
        ) : reviewStage === 'certifying' ? (
          <p className="text-stone-500">Starting Node-host certification…</p>
        ) : null}
      </StepCard>

      {/* ── Step 3: Boundary tradeoffs ──────────────────────────────────────── */}
      <StepCard
        n={3}
        title="Boundary tradeoffs"
        status={
          run || lastValidationPacket
            ? stepStatusForTradeoffs(reviewStage, failedStep)
            : 'waiting'
        }
      >
        <ValidationTradeoffMap
          run={run}
          packet={lastValidationPacket}
          certificationSlots={certificationSlots}
          annualTravelOverlay={annualTravelOverlayForCandidateDisplay}
          retirementYear={reviewRetirementYear}
          inflation={reviewInflation}
          legacyTarget={legacyTargetTodayDollars}
        />
      </StepCard>

      {/* ── Step 4: AI co-review ────────────────────────────────────────────── */}
      <StepCard n={4} title="AI co-review" status={stepStatusForAi(reviewStage, failedStep)}>
        {(reviewStage === 'ai_review' || (reviewStage === 'failed' && failedStep === 'ai')) && !aiVerdict ? (
          <AiReviewProgressTimeline
            steps={aiReviewProgress}
            elapsedMs={aiReviewElapsedMs}
          />
        ) : aiApproval ? (
          <div className="space-y-3">
            <AiReviewDecisionBrief approval={aiApproval} items={reviewChecklistItems} />

            <details className="rounded-xl border border-stone-200 bg-white/70">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500 hover:bg-stone-50">
                AI evidence and model follow-ups
              </summary>
              <div className="space-y-3 px-3 pb-3">
                <AiReviewProgressTimeline
                  steps={aiReviewProgress}
                  elapsedMs={aiReviewElapsedMs}
                />
                {reviewChecklistItems.length > 0 && (
                  <ReviewChecklist items={reviewChecklistItems} />
                )}
                {aiApproval.modelImprovementTodos &&
                  aiApproval.modelImprovementTodos.length > 0 && (
                  <div className="space-y-2 rounded-lg border border-blue-100 bg-blue-50/60 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-800">
                      Model follow-ups
                    </p>
                    <ul className="space-y-2">
                      {aiApproval.modelImprovementTodos.map((todo) => (
                        <li key={todo.id} className="text-[11px] text-blue-950">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold">{todo.title}</span>
                            <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-blue-700 ring-1 ring-blue-100">
                              {todo.priority}
                            </span>
                          </div>
                          <p className="mt-1 text-blue-900/80">{todo.suggestedNextStep}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {run?.aiApproval?.auditTrail && (
                  <ProofBundleLinks auditTrail={run.aiApproval.auditTrail} />
                )}
              </div>
            </details>
          </div>
        ) : null}
      </StepCard>

      {/* ── Step 5: Answer ──────────────────────────────────────────────────── */}
      <StepCard n={5} title="North star answer" status={stepStatusForAnswer(reviewStage)}>
        {run ? (
          <div className="space-y-4">
            {/* The number */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
                  {northStarSpendLabel}
                </p>
                <p
                  className={`mt-1 text-5xl font-bold tabular-nums tracking-tight ${
                    isGreen ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {formatMonthly(northStarMonthlySpend)}
                </p>
                <p className="mt-0.5 text-[12px] text-stone-500">
                  {formatCurrency(northStarAnnualSpend)}/yr in {northStarYearLabel}
                </p>
                {selectedNorthStarBudget?.totalMonthlyBudget !== null &&
                  selectedNorthStarBudget?.totalMonthlyBudget !== undefined && (
                  <p className="mt-0.5 text-[12px] tabular-nums text-stone-500">
                    lifestyle target {formatMonthly(recommendedTotalMonthlySpend)} · spend+health{' '}
                    {formatMonthly(
                      selectedNorthStarBudget.spendAndHealthAnnual === null
                        ? null
                        : selectedNorthStarBudget.spendAndHealthAnnual / 12,
                    )} · fed tax{' '}
                    {formatMonthly(
                      selectedNorthStarBudget.federalTaxAnnual === null
                        ? null
                        : selectedNorthStarBudget.federalTaxAnnual / 12,
                    )}
                  </p>
                )}
                {recommendedLifetimeAverageAnnualSpend !== null && (
                  <p className="mt-0.5 text-[12px] text-stone-500">
                    target average {formatCurrency(recommendedLifetimeAverageAnnualSpend)}/yr · care/legacy reserve {formatCurrency(legacyTargetTodayDollars)}
                  </p>
                )}
                {annualTravelOverlayForCandidateDisplay > 0 && (
                  <p className="mt-1 text-[12px] font-medium tabular-nums text-stone-700">
                    core {formatCurrency(run.recommendation.annualSpendTodayDollars)}/yr + first-year travel {formatCurrency(annualTravelOverlayForCandidateDisplay)}/yr
                  </p>
                )}
              </div>
              <div className="flex flex-col items-start gap-2 sm:items-end">
                <div className="flex flex-wrap gap-2">
                  <span
                    className={`rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ${
                      isGreen ? 'bg-emerald-100 text-emerald-800 ring-emerald-200' : 'bg-rose-100 text-rose-800 ring-rose-200'
                    }`}
                  >
                    Model {run.recommendation.status}
                  </span>
                  {aiVerdict && (
                    <span
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ${
                        aiVerdict === 'aligned'
                          ? 'bg-emerald-100 text-emerald-800 ring-emerald-200'
                          : aiVerdict === 'watch'
                            ? 'bg-amber-100 text-amber-800 ring-amber-200'
                            : 'bg-rose-100 text-rose-800 ring-rose-200'
                      }`}
                    >
                      AI {aiVerdict === 'aligned' ? 'confirmed' : aiVerdict === 'watch' ? 'watch' : aiVerdict}
                    </span>
                  )}
                </div>
                {selectedCertification && isGreen && (
                  <button
                    type="button"
                    disabled={alreadyAdopted}
                    onClick={() => setAdoptingCertification(selectedCertification)}
                    className="rounded-full bg-emerald-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-default disabled:bg-stone-400"
                  >
                    {alreadyAdopted ? '✓ Adopted' : 'Adopt this plan'}
                  </button>
                )}
                {alreadyAdopted && (
                  <button
                    type="button"
                    onClick={() => undoLastPolicyAdoption()}
                    className="text-[11px] text-stone-400 underline"
                  >
                    Undo adoption
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-900">
                  Boldin-style spending check
                </p>
                <p className="text-[11px] text-amber-800">
                  Today's dollars · monthly equivalents
                </p>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <SpendingComparisonStat
                  label="Boldin planned"
                  value={formatMonthly(BOLDIN_PLANNED_MONTHLY_TODAY_DOLLARS)}
                  detail="Screenshot benchmark"
                />
                <SpendingComparisonStat
                  label="Boldin safe target"
                  value={formatMonthly(BOLDIN_SAFE_TARGET_MONTHLY_TODAY_DOLLARS)}
                  detail="Screenshot benchmark"
                />
                <SpendingComparisonStat
                  label={
                    boldinStyleComparison.currentPlanCashOutflowMonthly === null
                      ? 'Current plan budget'
                      : 'Current plan engine cashflow'
                  }
                  value={formatMonthly(
                    boldinStyleComparison.currentPlanCashOutflowMonthly ??
                      boldinStyleComparison.currentPlanBudgetMonthly,
                  )}
                  detail={
                    boldinStyleComparison.currentPlanTraceYear === null
                      ? `${formatCurrency(boldinStyleComparison.currentPlanBudgetAnnual)}/yr before health/fed tax`
                      : `${boldinStyleComparison.currentPlanTraceYear}: spend+health ${formatMonthly(boldinStyleComparison.currentPlanEngineSpendingMonthly)} + fed tax ${formatMonthly(boldinStyleComparison.currentPlanFederalTaxMonthly)}`
                  }
                />
                <SpendingComparisonStat
                  label="Selected engine cashflow"
                  value={formatMonthly(selectedNorthStarBudget?.totalMonthlyBudget ?? null)}
                  detail={
                    selectedNorthStarBudget?.year === null ||
                    selectedNorthStarBudget?.year === undefined
                      ? 'Waiting for certified trace rows'
                      : `${selectedNorthStarBudget.year}: spend+health ${formatMonthly(
                          selectedNorthStarBudget.spendAndHealthAnnual === null
                            ? null
                            : selectedNorthStarBudget.spendAndHealthAnnual / 12,
                        )} + fed tax ${formatMonthly(
                          selectedNorthStarBudget.federalTaxAnnual === null
                            ? null
                            : selectedNorthStarBudget.federalTaxAnnual / 12,
                        )}`
                  }
                />
              </div>
              <p className="mt-3 text-[12px] leading-5 text-amber-950">
                Boldin planned compares to current-plan engine cashflow from
                the monthly-review packet; Boldin safe target compares to the
                selected engine cashflow. Current-plan gap to Boldin planned:{' '}
                <span className="font-semibold tabular-nums">
                  {boldinStyleComparison.currentPlanCashOutflowMonthly === null
                    ? 'engine trace missing'
                    : formatMonthlyDelta(
                        boldinStyleComparison.currentPlanCashOutflowMonthly -
                          BOLDIN_PLANNED_MONTHLY_TODAY_DOLLARS,
                      )}
                </span>
                . Selected gap to Boldin safe:{' '}
                <span className="font-semibold tabular-nums">
                  {formatMonthlyDelta(
                    selectedNorthStarBudget?.totalMonthlyBudget === null ||
                      selectedNorthStarBudget?.totalMonthlyBudget === undefined
                      ? null
                      : selectedNorthStarBudget.totalMonthlyBudget -
                        BOLDIN_SAFE_TARGET_MONTHLY_TODAY_DOLLARS,
                  )}
                </span>
                .
              </p>
            </div>

            {run.recommendation.summary && (
              <p className="text-[12px] text-stone-600 border-t border-stone-100 pt-3">
                {run.recommendation.summary}
              </p>
            )}

            {/* Planning backlog */}
            {run.modelTasks.length > 0 && (
              <details className="rounded-lg border border-stone-200 bg-white">
                <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-stone-600 hover:bg-stone-50">
                  Planning backlog · {criticalTasks.length} critical · {run.modelTasks.length} total
                </summary>
                <div className="px-3 pb-3">
                  <ModelTaskList tasks={run.modelTasks} />
                </div>
              </details>
            )}
          </div>
        ) : (
          <p className="text-stone-400">Run the review to get your monthly number.</p>
        )}
      </StepCard>

      {/* ── Debug section ───────────────────────────────────────────────────── */}
      {(transactionEvents.length > 0 || lastAiResponse || lastValidationPacket) && (
        <details className="rounded-xl border border-stone-200 bg-white/60">
          <summary className="cursor-pointer px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400 hover:bg-stone-50">
            Debug
          </summary>
          <div className="space-y-3 px-4 pb-4">
            {transactionEvents.length > 0 && (
              <div className="rounded-xl border border-stone-200 bg-stone-950 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-300">
                  Transaction log · {transactionEvents.length} events
                </p>
                <div className="mt-2 max-h-48 overflow-auto font-mono text-[10px] leading-relaxed text-stone-100">
                  {transactionEvents.map((event) => (
                    <div key={event.id} className="whitespace-pre-wrap">
                      <span className="text-stone-500">{new Date(event.atIso).toLocaleTimeString()}</span>{' '}
                      <span>{event.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {lastAiResponse && (
                <button type="button" onClick={() => setShowRawAiResponse((v) => !v)}
                  className="rounded-full border border-stone-300 bg-white px-3 py-1 text-[11px] font-semibold text-stone-700 hover:bg-stone-50">
                  {showRawAiResponse ? 'Hide AI response' : 'Raw AI response'}
                </button>
              )}
              {lastValidationPacket && (
                <button type="button" onClick={() => setShowValidationPacket((v) => !v)}
                  className="rounded-full border border-stone-300 bg-white px-3 py-1 text-[11px] font-semibold text-stone-700 hover:bg-stone-50">
                  {showValidationPacket ? 'Hide packet' : 'Validation packet'}
                </button>
              )}
            </div>
            {showRawAiResponse && lastAiResponse && (
              <pre className="max-h-72 overflow-auto rounded-lg bg-stone-950 p-3 text-[10px] leading-relaxed text-stone-100">
                {JSON.stringify(lastAiResponse, null, 2)}
              </pre>
            )}
            {showValidationPacket && lastValidationPacket && (
              <pre className="max-h-72 overflow-auto rounded-lg bg-stone-950 p-3 text-[10px] leading-relaxed text-stone-100">
                {JSON.stringify(lastValidationPacket, null, 2)}
              </pre>
            )}
          </div>
        </details>
      )}

        </div>
        <ClusterStatusRail
          peers={cluster.peers}
          session={cluster.session}
          certificationSlots={certificationSlots}
          reviewStage={reviewStage}
          annualTravelOverlay={annualTravelOverlayForCandidateDisplay}
        />
      </div>

      {adoptingCertification && (
        <PolicyAdoptionModal
          policy={adoptingCertification.evaluation.policy}
          currentData={currentData}
          onCancel={() => setAdoptingCertification(null)}
          onConfirm={() => {
            adoptMinedPolicy(adoptingCertification.evaluation.policy, adoptingCertification.evaluation);
            appendTransactionEvent(
              `adopted ${formatCurrency(displayAnnualSpendForCandidate(adoptingCertification.evaluation.policy.annualSpendTodayDollars))}/yr first-year total`,
            );
            setAdoptingCertification(null);
          }}
        />
      )}
    </>
  );
}
