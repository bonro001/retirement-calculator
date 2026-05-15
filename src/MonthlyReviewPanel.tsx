import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildMonthlyReviewRecommendation,
  buildMonthlyReviewMiningFingerprint,
  buildMonthlyReviewValidationPacket,
  classifyMonthlyReviewModelTasks,
  MONTHLY_REVIEW_AI_DEFAULT_MODEL,
  MONTHLY_REVIEW_AI_DEFAULT_REASONING_EFFORT,
  rankMonthlyReviewCandidates,
  runMonthlyReview,
  type MonthlyReviewAiFinding,
  type MonthlyReviewCertification,
  type MonthlyReviewModelTask,
  type MonthlyReviewQaSignal,
  type MonthlyReviewRun,
  type MonthlyReviewStrategyResult,
  type MonthlyReviewStrategyId,
  type MonthlyReviewValidationPacket,
} from './monthly-review';
import {
  MONTHLY_REVIEW_POLICY_TRIAL_BUDGET,
  MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION,
} from './monthly-review-flow-debug';
import {
  mineMonthlyReviewStrategy,
  waitForMonthlyReviewClusterConnected,
} from './monthly-review-cluster-miner';
import { POLICY_MINING_TRIAL_COUNT } from './policy-mining-config';
import {
  runClusterMonthlyReviewAiApproval,
  saveClusterMonthlyReviewAudit,
  wakeClusterHosts,
} from './policy-mining-cluster';
import { setBrowserHostMode } from './cluster-client';
import {
  ClusterCertifyError,
  runClusterCertification,
} from './policy-certification-cluster';
import type { PolicyCertificationPack } from './policy-certification';
import type { PolicyEvaluation } from './policy-miner-types';
import { PolicyAdoptionModal } from './PolicyAdoptionModal';
import { useAppStore } from './store';
import type { MarketAssumptions, SeedData } from './types';
import type { SnapshotPeer } from './cluster-peer-view';
import {
  useClusterSession,
  type UseClusterSession,
} from './useClusterSession';

type MonthlyReviewStage =
  | 'idle'
  | 'connecting'
  | 'mining'
  | 'certifying'
  | 'ai_review'
  | 'complete'
  | 'failed';

type StepStatus = 'waiting' | 'active' | 'done' | 'failed';

interface Props {
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string | null;
  engineVersion: string;
  dispatcherUrl: string | null;
  legacyTargetTodayDollars: number;
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
  verdict: PolicyCertificationPack['verdict'] | null;
  reasons: Array<{ code: string; message: string }>;
}

interface MiningSnapshot {
  evaluationCount: number;
  spendMin: number | null;
  spendMax: number | null;
  feasibleCount: number;
}

const LAST_AI_PACKET_KEY = 'monthly-review:last-ai-validation-packet';
const LAST_AI_RESPONSE_KEY = 'monthly-review:last-ai-response';

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatCurrency(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—';
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (Math.abs(amount) >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  return `$${Math.round(amount)}`;
}

function formatMonthly(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—';
  return `$${Math.round(amount).toLocaleString()}/mo`;
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

// ─── Step status helpers ──────────────────────────────────────────────────────

function stepStatusForMine(stage: MonthlyReviewStage): StepStatus {
  if (stage === 'idle') return 'waiting';
  if (stage === 'connecting' || stage === 'mining') return 'active';
  if (stage === 'failed') return 'failed';
  return 'done';
}

function stepStatusForCertify(stage: MonthlyReviewStage): StepStatus {
  if (stage === 'idle' || stage === 'connecting' || stage === 'mining') return 'waiting';
  if (stage === 'certifying') return 'active';
  if (stage === 'failed') return 'failed';
  return 'done';
}

function stepStatusForAi(stage: MonthlyReviewStage): StepStatus {
  if (stage === 'idle' || stage === 'connecting' || stage === 'mining' || stage === 'certifying') return 'waiting';
  if (stage === 'ai_review') return 'active';
  if (stage === 'failed') return 'failed';
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
  children,
}: {
  n: number;
  title: string;
  status: StepStatus;
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

  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} overflow-hidden`}>
      {/* Header row — always present */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${circleColor}`}
        >
          {status === 'done' ? '✓' : status === 'failed' ? '!' : n}
        </div>
        <p className={`text-sm font-semibold ${titleColor}`}>{title}</p>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${badgeColor}`}
        >
          {badgeLabel}
        </span>
      </div>

      {/* Body — only rendered when not waiting */}
      {status !== 'waiting' && children && (
        <div className="border-t border-stone-100 px-4 py-3 text-[12px]">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Spend boundary strip ─────────────────────────────────────────────────────

function SpendBoundaryStrip({
  slots,
  recommendedAnnualSpend,
}: {
  slots: CertificationSlot[];
  recommendedAnnualSpend: number | null;
}): JSX.Element | null {
  const sorted = [...slots].sort((a, b) => a.annualSpendTodayDollars - b.annualSpendTodayDollars);
  if (sorted.length === 0) return null;

  return (
    <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
      {sorted.map((slot) => {
        const isRecommended =
          recommendedAnnualSpend !== null &&
          slot.annualSpendTodayDollars === recommendedAnnualSpend;
        const fillColor =
          slot.status === 'running'
            ? 'bg-blue-500'
            : slot.verdict === 'green'
              ? 'bg-emerald-400'
              : slot.verdict === 'yellow'
                ? 'bg-amber-400'
                : slot.verdict === 'red'
                  ? 'bg-rose-400'
                  : 'bg-stone-300';
        const height = isRecommended ? 34 : 28;
        const progressPct =
          slot.status === 'done'
            ? 100
            : slot.total > 0
              ? Math.min(100, Math.max(4, (slot.completed / slot.total) * 100))
              : 0;
        const progressLabel =
          slot.status === 'running' && slot.total > 0
            ? ` · ${slot.completed}/${slot.total}`
            : '';
        return (
          <div key={slot.candidateId} className="flex min-w-[92px] flex-col gap-0.5">
            {isRecommended && (
              <span className="self-start text-[9px] font-bold uppercase tracking-wide text-emerald-700">
                Pick
              </span>
            )}
            <div
              className={`relative w-[92px] overflow-hidden rounded border border-stone-200 bg-stone-100 ${isRecommended ? 'ring-2 ring-emerald-600 ring-offset-1' : ''}`}
              style={{ height: `${height}px` }}
              title={`${formatCurrency(slot.annualSpendTodayDollars)}/yr · ${slot.hostDisplayName ?? 'unassigned'} · ${slot.verdict ?? (slot.status === 'running' ? 'certifying…' : '—')}${progressLabel}`}
            >
              <div
                className={`absolute inset-y-0 left-0 transition-[width] duration-500 ease-out ${fillColor} ${
                  slot.status === 'running' ? 'shadow-[6px_0_12px_rgba(59,130,246,0.22)]' : ''
                }`}
                style={{ width: `${progressPct}%` }}
              />
              {slot.status === 'running' && progressPct === 0 && (
                <div className="absolute inset-0 animate-pulse bg-blue-100" />
              )}
              <div className="relative flex h-full items-center justify-between px-2 text-[10px] font-semibold tabular-nums text-stone-800">
                <span>{formatCurrency(slot.annualSpendTodayDollars)}</span>
                <span className="text-stone-600">
                  {slot.status === 'running' && slot.total > 0
                    ? `${slot.completed}/${slot.total}`
                    : slot.status === 'running'
                      ? '...'
                      : slot.verdict ?? '-'}
                </span>
              </div>
            </div>
            <span
              className={`truncate text-[8px] font-semibold uppercase ${
                slot.verdict === 'green'
                  ? 'text-emerald-600'
                  : slot.verdict === 'yellow'
                    ? 'text-amber-600'
                    : slot.verdict === 'red'
                      ? 'text-rose-600'
                      : 'text-stone-400'
              }`}
            >
              {slot.status === 'running'
                ? slot.hostDisplayName ?? 'assigning'
                : slot.verdict ?? '-'}
            </span>
          </div>
        );
      })}
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
}: {
  peers: SnapshotPeer[];
  session: UseClusterSession['session'];
  certificationSlots: CertificationSlot[];
  reviewStage: MonthlyReviewStage;
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
  const activeCertifications = hosts.reduce(
    (total, peer) => total + hostCertifyInFlight(peer),
    0,
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
              const certifyPct =
                certifyCapacity > 0
                  ? Math.min(100, (certifyInFlight / certifyCapacity) * 100)
                  : 0;
              const miningPct =
                miningCapacity > 0
                  ? Math.min(100, (peer.inFlightBatchCount / miningCapacity) * 100)
                  : 0;
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
                        <span>{peer.inFlightBatchCount}/{miningCapacity}</span>
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
                <span className="tabular-nums text-stone-800">
                  {formatCurrency(slot.annualSpendTodayDollars)}
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

// ─── Finding chips ────────────────────────────────────────────────────────────

type ChipStatus = 'fail' | 'watch' | 'pass' | 'act_now' | 'ok';

interface ChipItem {
  id: string;
  status: ChipStatus;
  title: string;
  detail: string;
  evidence?: string[];
  recommendation?: string;
}

function chipStyle(status: ChipStatus): { chip: string; panel: string } {
  if (status === 'fail' || status === 'act_now') {
    return {
      chip: 'bg-rose-100 text-rose-800 ring-rose-200 hover:bg-rose-200',
      panel: 'border-rose-200 bg-rose-50',
    };
  }
  if (status === 'watch') {
    return {
      chip: 'bg-amber-100 text-amber-800 ring-amber-200 hover:bg-amber-200',
      panel: 'border-amber-200 bg-amber-50',
    };
  }
  return {
    chip: 'bg-emerald-100 text-emerald-800 ring-emerald-200 hover:bg-emerald-200',
    panel: 'border-emerald-200 bg-emerald-50',
  };
}

function chipIcon(status: ChipStatus): string {
  if (status === 'fail' || status === 'act_now') return '!';
  if (status === 'watch') return '⚠';
  return '✓';
}

function FindingChips({ items }: { items: ChipItem[] }): JSX.Element | null {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (items.length === 0) return null;

  const expanded = items.find((x) => x.id === expandedId) ?? null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const { chip } = chipStyle(item.status);
          const isExpanded = expandedId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : item.id)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ring-1 transition ${chip} ${isExpanded ? 'ring-2' : ''}`}
            >
              <span>{chipIcon(item.status)}</span>
              <span>{item.title}</span>
            </button>
          );
        })}
      </div>
      {expanded && (
        <div className={`rounded-xl border px-4 py-3 text-[12px] ${chipStyle(expanded.status).panel}`}>
          <p className="font-semibold text-stone-900">{expanded.title}</p>
          <p className="mt-1 text-stone-700">{expanded.detail}</p>
          {expanded.recommendation && (
            <p className="mt-2 font-medium text-stone-800">{expanded.recommendation}</p>
          )}
          {expanded.evidence && expanded.evidence.length > 0 && (
            <p className="mt-2 break-words font-mono text-[10px] text-stone-500">
              {expanded.evidence.slice(0, 3).join(' · ')}
            </p>
          )}
        </div>
      )}
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

function buildDryRunCertificationPack(input: {
  certification: MonthlyReviewCertification | null;
  evaluation: MonthlyReviewCertification['evaluation'];
  strategyId: string;
  strategyLabel: string;
  baselineFingerprint: string;
  engineVersion: string;
  assumptionsVersion?: string;
}): PolicyCertificationPack {
  const generatedAtIso = new Date().toISOString();
  const outcome = input.evaluation.outcome;
  return {
    verdict: input.certification?.verdict ?? 'green',
    reasons: [{ level: input.certification?.verdict ?? 'green', code: 'flow_debug_certification_skipped', message: 'Flow-debug mode: real certification intentionally skipped.' }],
    metadata: {
      policyId: input.evaluation.id,
      baselineFingerprint: input.baselineFingerprint,
      engineVersion: input.engineVersion,
      spendTarget: input.evaluation.policy.annualSpendTodayDollars,
      selectedSpendingBasisId: input.strategyId,
      selectedSpendingBasisLabel: input.strategyLabel,
      spendingBasisFingerprint: input.strategyId,
      baseSeed: 0,
      auditSeeds: [],
      trialCount: 0,
      assumptionsVersion: input.assumptionsVersion,
      generatedAtIso,
    },
    rows: [{
      id: 'flow-debug-dry-run',
      basisId: input.strategyId,
      basisLabel: input.strategyLabel,
      mode: 'forward_parametric',
      modeLabel: 'Forward-looking',
      scenarioId: 'flow_debug',
      scenarioName: 'Flow debug',
      scenarioKind: 'baseline',
      seed: 0,
      solvencyRate: outcome.solventSuccessRate,
      legacyAttainmentRate: outcome.bequestAttainmentRate,
      first10YearFailureRisk: 0,
      spendingCutRate: 0,
      p10EndingWealthTodayDollars: outcome.p10EndingWealthTodayDollars,
      p50EndingWealthTodayDollars: outcome.p50EndingWealthTodayDollars,
      worstFailureYear: null,
      mostLikelyFailureYear: null,
      failureConcentrationRate: 0,
      appliedStressors: [],
      durationMs: 0,
    }],
    seedAudits: [],
    guardrail: {
      authorizedAnnualSpend: input.evaluation.policy.annualSpendTodayDollars,
      discretionaryThrottleAnnual: 0,
      yellowTrigger: 'Flow-debug only',
      redTrigger: 'Flow-debug only',
      yellowResponse: 'Run real certification before relying on this plan.',
      redResponse: 'Run real certification before relying on this plan.',
      modeledAssetPath: [],
      inferredAssumptions: ['Real certification intentionally skipped.'],
    },
    selectedPathEvidence: null,
  };
}

function buildPreCertificationAiPacket(input: {
  strategy: MonthlyReviewStrategyResult['strategy'];
  evaluations: PolicyEvaluation[];
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  legacyTargetTodayDollars: number;
  generatedAtIso: string;
}): MonthlyReviewValidationPacket | null {
  const rankedCandidates = rankMonthlyReviewCandidates(input.evaluations);
  const selectedEvaluation = rankedCandidates[0] ?? null;
  if (!selectedEvaluation) return null;
  const pack = buildDryRunCertificationPack({
    certification: null,
    evaluation: selectedEvaluation,
    strategyId: input.strategy.id,
    strategyLabel: input.strategy.label,
    baselineFingerprint: selectedEvaluation.baselineFingerprint,
    engineVersion: selectedEvaluation.engineVersion,
    assumptionsVersion: input.assumptions.assumptionsVersion,
  });
  const selectedCertification: MonthlyReviewCertification = {
    strategyId: input.strategy.id,
    evaluation: selectedEvaluation,
    pack,
    verdict: pack.verdict,
    certifiedAtIso: input.generatedAtIso,
  };
  const spendLevels = Array.from(
    new Set(input.evaluations.map((e) => e.policy.annualSpendTodayDollars)),
  ).sort((a, b) => a - b);
  const selectedSpend = selectedEvaluation.policy.annualSpendTodayDollars;
  const higherSpendLevels = spendLevels.filter((s) => s > selectedSpend);
  const strategyResult: MonthlyReviewStrategyResult = {
    strategy: input.strategy,
    corpusEvaluationCount: input.evaluations.length,
    spendBoundary: {
      highestSpendTestedTodayDollars: spendLevels.at(-1) ?? null,
      highestGreenSpendTodayDollars: selectedSpend,
      higherSpendLevelsTested: higherSpendLevels,
      boundaryProven: higherSpendLevels.length > 0,
    },
    rankedCandidates,
    evidenceCandidates: [...input.evaluations].sort((a, b) => {
      const spendDiff = b.policy.annualSpendTodayDollars - a.policy.annualSpendTodayDollars;
      if (spendDiff !== 0) return spendDiff;
      const solvencyDiff = b.outcome.solventSuccessRate - a.outcome.solventSuccessRate;
      if (solvencyDiff !== 0) return solvencyDiff;
      return b.outcome.bequestAttainmentRate - a.outcome.bequestAttainmentRate || a.id.localeCompare(b.id);
    }),
    certifications: [selectedCertification],
    selectedCertification,
    errors: [],
  };
  const strategies = [strategyResult];
  const tasks = classifyMonthlyReviewModelTasks({ strategies, aiApproval: null, generatedAtIso: input.generatedAtIso });
  const recommendation = buildMonthlyReviewRecommendation({ strategies, tasks, aiApproval: null });
  return buildMonthlyReviewValidationPacket({
    data: input.baseline,
    assumptions: input.assumptions,
    baselineFingerprint: input.baselineFingerprint,
    engineVersion: input.engineVersion,
    generatedAtIso: input.generatedAtIso,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    recommendation,
    strategies,
    tasks,
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export function MonthlyReviewPanel({
  baseline,
  assumptions,
  baselineFingerprint,
  engineVersion,
  dispatcherUrl,
  legacyTargetTodayDollars,
  selectedStrategyId,
  onProgressStageChange,
}: Props): JSX.Element | null {
  const cluster = useClusterSession();
  const clusterRef = useRef(cluster);
  const [runState, setRunState] = useState<
    | { kind: 'idle' }
    | { kind: 'running'; message: string }
    | { kind: 'complete'; run: MonthlyReviewRun }
    | { kind: 'failed'; reason: string }
  >({ kind: 'idle' });
  const [reviewStage, setReviewStage] = useState<MonthlyReviewStage>('idle');
  const [miningSnapshot, setMiningSnapshot] = useState<MiningSnapshot | null>(null);
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
  const [adoptingCertification, setAdoptingCertification] =
    useState<MonthlyReviewCertification | null>(null);
  const [certificationSlots, setCertificationSlots] = useState<CertificationSlot[]>([]);
  const [showRawAiResponse, setShowRawAiResponse] = useState(false);
  const [showValidationPacket, setShowValidationPacket] = useState(false);
  const [lastValidationPacket, setLastValidationPacket] =
    useState<MonthlyReviewValidationPacket | null>(() =>
      readStoredJson<MonthlyReviewValidationPacket>(LAST_AI_PACKET_KEY),
    );
  const [lastAiResponse, setLastAiResponse] = useState<MonthlyReviewRun['aiApproval'] | null>(
    () => readStoredJson<MonthlyReviewRun['aiApproval']>(LAST_AI_RESPONSE_KEY),
  );
  const [transactionEvents, setTransactionEvents] = useState<ReviewTransactionEvent[]>([]);
  const transactionEventsRef = useRef<ReviewTransactionEvent[]>([]);
  const nextTransactionEventIdRef = useRef(1);
  const preCertificationAiStartedRef = useRef(false);
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
  // batch_result. (Symptom: UI stuck at "32 / 6,534" forever while the
  // dispatcher actually progresses to completion.)
  //
  // We also skip pass-2 sessions (cliff refinement, typically ≤50 policies)
  // because they would flash a misleading "1/1" right after pass-1's 6,534
  // finishes. Holding the pass-1 value through pass-2 keeps the card calm.
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
      reviewStage !== 'certifying'
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

  const canRun = !!baselineFingerprint;
  const runId = useMemo(() => `monthly-review-${new Date().toISOString().slice(0, 10)}`, []);

  const appendTransactionEvent = useCallback((message: string) => {
    const id = nextTransactionEventIdRef.current++;
    const event = { id, atIso: new Date().toISOString(), message };
    setTransactionEvents((events) => {
      const nextEvents = [...events, event].slice(-80);
      transactionEventsRef.current = nextEvents;
      return nextEvents;
    });
  }, []);

  const setStage = useCallback(
    (stage: MonthlyReviewStage) => { setReviewStage(stage); onProgressStageChange?.(stage); },
    [onProgressStageChange],
  );

  const start = async () => {
    if (!baselineFingerprint) return;
    setBrowserHostMode('off');
    if (!clusterRef.current.session) {
      clusterRef.current.reconnect();
    }
    setMiningSnapshot(null);
    setLastValidationPacket(null);
    setLastAiResponse(null);
    setCertificationSlots([]);
    nextTransactionEventIdRef.current = 1;
    transactionEventsRef.current = [];
    preCertificationAiStartedRef.current = false;
    setTransactionEvents([]);
    appendTransactionEvent('review started');
    setStage('connecting');
    setRunState({ kind: 'running', message: 'Connecting…' });
    try {
      if (!dispatcherUrl) {
        throw new Error('Monthly review needs the dispatcher for mining and AI review.');
      }
      setRunState({ kind: 'running', message: 'Waking worker hosts…' });
      try {
        const wake = await wakeClusterHosts(dispatcherUrl);
        const configuredWakeCount = wake.targets.length + wake.pokes.length;
        if (configuredWakeCount > 0) {
          const pokeSummary =
            wake.pokes.length > 0
              ? `; pokes ${wake.pokes.map((poke) => `${poke.host}:${poke.port} ${poke.status}`).join(', ')}`
              : '';
          appendTransactionEvent(
            `wake request: ${wake.targets.length} target${wake.targets.length === 1 ? '' : 's'}, ${wake.magicPacketsSent} packet${wake.magicPacketsSent === 1 ? '' : 's'}${pokeSummary}`,
          );
          const hasAwakePoke = wake.pokes.some((poke) => poke.status === 'connected');
          if (!hasAwakePoke && wake.targets.length > 0) {
            setRunState({ kind: 'running', message: 'Waiting for worker hosts to wake…' });
            await waitMs(12_000);
            clusterRef.current.reconnect();
          }
        } else {
          appendTransactionEvent('wake skipped: no configured worker targets');
        }
        if (wake.errors.length > 0) {
          appendTransactionEvent(`wake warnings: ${wake.errors.slice(0, 2).join(' | ')}`);
        }
      } catch (wakeError) {
        appendTransactionEvent(`wake failed: ${wakeError instanceof Error ? wakeError.message : String(wakeError)}`);
      }
      setRunState({ kind: 'running', message: 'Connecting…' });
      await waitForMonthlyReviewClusterConnected({ clusterRef, timeoutMs: 30_000 });
      appendTransactionEvent(`cluster connected (${clusterRef.current.peers.length} peers)`);
      if (clusterRef.current.session) {
        throw new Error('A mining session is already running. Let it finish, then run Monthly Review.');
      }
      const hostPeers = clusterRef.current.peers.filter((peer) =>
        peer.roles.includes('host'),
      );
      const hostCertifyCapacity = hostPeers.reduce((total, peer) => {
        const advertised = peer.capabilities?.certifyWorkerCount;
        if (typeof advertised === 'number' && Number.isFinite(advertised)) {
          return total + Math.max(0, Math.floor(advertised));
        }
        return total;
      }, 0);
      if (hostCertifyCapacity <= 0) {
        throw new Error('No Node worker host is registered for certification.');
      }
      const certificationMaxConcurrency = Math.max(
        1,
        Math.min(8, hostCertifyCapacity),
      );
      appendTransactionEvent(
        `certification capacity: ${certificationMaxConcurrency} worker slot${
          certificationMaxConcurrency === 1 ? '' : 's'
        } across host computers`,
      );
      const run = await runMonthlyReview({
        id: runId,
        baselineFingerprint,
        engineVersion,
        legacyTargetTodayDollars,
        data: baseline,
        assumptions,
        strategyIds: selectedStrategyId ? [selectedStrategyId] : undefined,
        certificationMaxConcurrency,
        ports: {
          mineStrategy: async (strategy) => {
            setStage('mining');
            const strategyFingerprint = buildMonthlyReviewMiningFingerprint({
              baselineFingerprint,
              trialCount: POLICY_MINING_TRIAL_COUNT,
              strategy,
            });
            appendTransactionEvent(`${strategy.label}: mining fingerprint ready`);
            const evaluations = await mineMonthlyReviewStrategy({
              strategy,
              strategyFingerprint,
              baseline,
              assumptions,
              legacyTargetTodayDollars,
              dispatcherUrl,
              clusterRef,
              setMessage: (message) => setRunState({ kind: 'running', message }),
              logEvent: appendTransactionEvent,
            });
            appendTransactionEvent(`${strategy.label}: ${evaluations.length.toLocaleString()} evaluations returned`);

            // Capture mining snapshot for Step 1 display
            const spends = evaluations.map((e) => e.policy.annualSpendTodayDollars);
            setMiningSnapshot({
              evaluationCount: evaluations.length,
              spendMin: spends.length > 0 ? Math.min(...spends) : null,
              spendMax: spends.length > 0 ? Math.max(...spends) : null,
              feasibleCount: evaluations.filter(
                (e) => e.outcome.solventSuccessRate >= 0.85,
              ).length,
            });

            if (!preCertificationAiStartedRef.current && dispatcherUrl && evaluations.length > 0) {
              const generatedAtIso = new Date().toISOString();
              const packet = buildPreCertificationAiPacket({
                strategy, evaluations, baseline, assumptions, baselineFingerprint,
                engineVersion, legacyTargetTodayDollars, generatedAtIso,
              });
              if (packet) {
                preCertificationAiStartedRef.current = true;
                setLastValidationPacket(packet);
                writeStoredJson(LAST_AI_PACKET_KEY, packet);
                appendTransactionEvent(`early AI co-review requested for ${strategy.label}`);
                void runClusterMonthlyReviewAiApproval(dispatcherUrl, packet)
                  .then((approval) => {
                    setLastAiResponse(approval);
                    writeStoredJson(LAST_AI_RESPONSE_KEY, approval);
                    appendTransactionEvent(`early AI co-review: ${approval.verdict} (${approval.confidence})`);
                  })
                  .catch((error) => {
                    appendTransactionEvent(`early AI co-review failed: ${error instanceof Error ? error.message : String(error)}`);
                  });
              }
            }
            return { evaluations };
          },
          certifyCandidate: async (strategy, evaluation) => {
            setStage('certifying');
            const startedAtIso = new Date().toISOString();
            const candidateId = evaluation.id;
            const spend = evaluation.policy.annualSpendTodayDollars;
            const mode: CertificationSlot['mode'] =
              MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION ? 'dry_run' : 'node_host';
            setCertificationSlots((slots) => {
              if (slots.some((s) => s.candidateId === candidateId)) return slots;
              return [
                ...slots,
                {
                  candidateId,
                  annualSpendTodayDollars: spend,
                  status: 'running' as const,
                  mode,
                  completed: 0,
                  total: 0,
                  startedAtIso,
                  verdict: null,
                  reasons: [],
                },
              ].sort((a, b) => b.annualSpendTodayDollars - a.annualSpendTodayDollars);
            });
            setRunState({
              kind: 'running',
              message:
                mode === 'node_host'
                  ? `Certifying ${formatCurrency(spend)}/yr on local Node host…`
                  : `Dry-run certifying ${formatCurrency(spend)}/yr…`,
            });
            appendTransactionEvent(
              `${strategy.label}: certifying ${formatCurrency(spend)}/yr via ${
                mode === 'node_host' ? 'Node host' : 'dry-run'
              }`,
            );
            let pack: PolicyCertificationPack;
            if (MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION) {
              pack = buildDryRunCertificationPack({
                certification: null,
                evaluation,
                strategyId: strategy.id,
                strategyLabel: strategy.label,
                baselineFingerprint: evaluation.baselineFingerprint,
                engineVersion: evaluation.engineVersion,
                assumptionsVersion: assumptions.assumptionsVersion,
              });
            } else {
              if (!dispatcherUrl) {
                throw new Error('Certification requires a dispatcher and a registered Node host.');
              }
              try {
                pack = await runClusterCertification(dispatcherUrl, {
                  policy: evaluation.policy,
                  baseline,
                  assumptions,
                  baselineFingerprint: evaluation.baselineFingerprint,
                  engineVersion: evaluation.engineVersion,
                  legacyTargetTodayDollars,
                  spendingScheduleBasis: strategy.spendingScheduleBasis,
                }, {
                  onAssigned: (host) => {
                    setCertificationSlots((slots) =>
                      slots.map((s) =>
                        s.candidateId === candidateId
                          ? {
                            ...s,
                            hostPeerId: host.peerId,
                            hostDisplayName: host.displayName,
                          }
                          : s,
                      ),
                    );
                  },
                  onProgress: (completed, total) => {
                    setCertificationSlots((slots) =>
                      slots.map((s) =>
                        s.candidateId === candidateId ? { ...s, completed, total } : s,
                      ),
                    );
                  },
                });
              } catch (err) {
                const detail =
                  err instanceof ClusterCertifyError && err.code === 'no_host'
                    ? 'no Node host is registered for certification'
                    : err instanceof Error
                      ? err.message
                      : String(err);
                appendTransactionEvent(
                  `${strategy.label}: certify FAILED for ${formatCurrency(spend)}/yr — ${detail}`,
                );
                throw err;
              }
            }
            const completedAtIso = new Date().toISOString();
            const reasons = pack.reasons.map((r) => ({ code: r.code, message: r.message }));
            setCertificationSlots((slots) =>
              slots.map((s) =>
                s.candidateId === candidateId
                  ? {
                    ...s,
                    status: 'done',
                    completed: Math.max(s.completed, s.total || 1),
                    total: s.total || 1,
                    verdict: pack.verdict,
                    reasons,
                  }
                  : s,
              ),
            );
            appendTransactionEvent(`${formatCurrency(spend)}/yr → ${pack.verdict}`);
            return { strategyId: strategy.id, evaluation, pack, verdict: pack.verdict, certifiedAtIso: completedAtIso };
          },
          aiReview: async (packet) => {
            setStage('ai_review');
            setLastValidationPacket(packet);
            writeStoredJson(LAST_AI_PACKET_KEY, packet);
            appendTransactionEvent(`AI co-review: ${MONTHLY_REVIEW_AI_DEFAULT_MODEL} (${MONTHLY_REVIEW_AI_DEFAULT_REASONING_EFFORT})`);
            setRunState({ kind: 'running', message: `AI co-review in progress…` });
            if (!dispatcherUrl) {
              return {
                verdict: 'insufficient_data', confidence: 'low',
                summary: 'Dispatcher not connected — AI co-review could not run.',
                findings: [{ id: 'dispatcher_missing', status: 'fail', title: 'No dispatcher', detail: 'Start the dispatcher and rerun.', evidence: ['dispatcherUrl=null'] }],
                actionItems: ['Start the dispatcher and rerun monthly review.'],
                model: MONTHLY_REVIEW_AI_DEFAULT_MODEL,
                generatedAtIso: new Date().toISOString(),
              };
            }
            const approval = await runClusterMonthlyReviewAiApproval(dispatcherUrl, packet);
            setLastAiResponse(approval);
            writeStoredJson(LAST_AI_RESPONSE_KEY, approval);
            appendTransactionEvent(`AI co-review: ${approval.verdict} (${approval.confidence})`);
            return approval;
          },
        },
      });
      setStage('complete');
      if (dispatcherUrl && run.aiApproval?.auditTrail?.auditId) {
        try {
          const auditTrail = await saveClusterMonthlyReviewAudit(dispatcherUrl, {
            auditId: run.aiApproval.auditTrail.auditId,
            run,
            transactionEvents: transactionEventsRef.current,
          });
          run.aiApproval.auditTrail = auditTrail;
          setLastAiResponse(run.aiApproval);
          writeStoredJson(LAST_AI_RESPONSE_KEY, run.aiApproval);
          appendTransactionEvent(`audit saved: ${auditTrail?.auditDir ?? 'unknown'}`);
        } catch (auditError) {
          appendTransactionEvent(`audit save failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
        }
      }
      appendTransactionEvent(`complete: ${run.recommendation.status}`);
      setRunState({ kind: 'complete', run });
    } catch (error) {
      setStage('failed');
      appendTransactionEvent(`failed: ${error instanceof Error ? error.message : String(error)}`);
      setRunState({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  };

  if (!baselineFingerprint) return null;

  const run = runState.kind === 'complete' ? runState.run : null;
  const isRunning = runState.kind === 'running';

  const selectedCertification =
    run?.strategies
      .map((s) => s.selectedCertification)
      .find(
        (cert): cert is MonthlyReviewCertification =>
          !!cert &&
          cert.strategyId === run.recommendation.strategyId &&
          cert.evaluation.id === run.recommendation.policyId,
      ) ?? null;

  const alreadyAdopted =
    !!selectedCertification &&
    lastPolicyAdoption?.evaluation?.id === selectedCertification.evaluation.id;

  const aiApproval = run?.aiApproval ?? lastAiResponse;
  const findingChips: ChipItem[] = [
    ...(aiApproval?.findings ?? []).map((f: MonthlyReviewAiFinding) => ({
      id: f.id,
      status: f.status as ChipStatus,
      title: f.title,
      detail: f.detail,
      evidence: f.evidence,
      recommendation: f.recommendation,
    })),
    ...(lastValidationPacket?.householdSignals ?? []).map((s: MonthlyReviewQaSignal) => ({
      id: s.id,
      status: s.status as ChipStatus,
      title: s.title,
      detail: s.detail,
      evidence: s.evidence,
      recommendation: s.recommendation,
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
        .map((slot) => `${formatCurrency(slot.annualSpendTodayDollars)}/yr`)
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
            Sleep-at-night max spend
          </h2>
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
      <StepCard n={1} title="Mine" status={stepStatusForMine(reviewStage)}>
        {reviewStage === 'failed' ? (
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
              <span className="tabular-nums font-semibold">{formatCurrency(miningSnapshot.spendMin)}</span>
              {' – '}
              <span className="tabular-nums font-semibold">{formatCurrency(miningSnapshot.spendMax)}</span>/yr
            </p>
            <p className="text-stone-500">
              <span className="tabular-nums">{miningSnapshot.feasibleCount.toLocaleString()}</span> meet the ≥85% solvency floor
            </p>
          </div>
        ) : null}
      </StepCard>

      {/* ── Step 2: Certify ─────────────────────────────────────────────────── */}
      <StepCard n={2} title="Certify candidates" status={stepStatusForCertify(reviewStage)}>
        {certificationSlots.length > 0 ? (
          <div className="space-y-3">
            <p className="text-stone-500">
              {certDone < certTotal
                ? `${certDone} of ${certTotal} candidates certified`
                : `All ${certTotal} candidates certified — pick = highest green`}
            </p>
            {runningCertSpendLine && runningCertElapsedMs !== null && (
              <p className="text-[11px] tabular-nums text-stone-600">
                {runningCertMode ?? 'certification'} active · {runningCertSpendLine} · elapsed{' '}
                {formatDuration(runningCertElapsedMs)}
              </p>
            )}
            <SpendBoundaryStrip
              slots={certificationSlots}
              recommendedAnnualSpend={run?.recommendation.annualSpendTodayDollars ?? null}
            />
          </div>
        ) : reviewStage === 'certifying' ? (
          <p className="text-stone-500">Starting Node-host certification…</p>
        ) : null}
      </StepCard>

      {/* ── Step 3: AI review ───────────────────────────────────────────────── */}
      <StepCard n={3} title="AI review" status={stepStatusForAi(reviewStage)}>
        {reviewStage === 'ai_review' && !aiVerdict ? (
          <p className="text-stone-500">
            Sending validation packet to {MONTHLY_REVIEW_AI_DEFAULT_MODEL}…
          </p>
        ) : aiApproval ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ${
                  aiVerdict === 'aligned'
                    ? 'bg-emerald-100 text-emerald-800 ring-emerald-200'
                    : aiVerdict === 'watch'
                      ? 'bg-amber-100 text-amber-800 ring-amber-200'
                      : 'bg-rose-100 text-rose-800 ring-rose-200'
                }`}
              >
                {aiVerdict === 'aligned' ? 'Aligned' : aiVerdict === 'watch' ? 'Watch' : aiVerdict ?? 'Unknown'}
                {aiApproval.confidence ? ` · ${aiApproval.confidence}` : ''}
              </span>
              {aiApproval.summary && (
                <p className="text-[12px] text-stone-600">{aiApproval.summary}</p>
              )}
            </div>
            {findingChips.length > 0 && <FindingChips items={findingChips} />}
            {aiApproval.actionItems && aiApproval.actionItems.length > 0 && (
              <ul className="space-y-1">
                {aiApproval.actionItems.map((item) => (
                  <li key={item} className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-[11px] text-stone-700">
                    {item}
                  </li>
                ))}
              </ul>
            )}
            {run?.aiApproval?.auditTrail && (
              <ProofBundleLinks auditTrail={run.aiApproval.auditTrail} />
            )}
          </div>
        ) : null}
      </StepCard>

      {/* ── Step 4: Answer ──────────────────────────────────────────────────── */}
      <StepCard n={4} title="Answer" status={stepStatusForAnswer(reviewStage)}>
        {run ? (
          <div className="space-y-4">
            {/* The number */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
                  Spend up to this month
                </p>
                <p
                  className={`mt-1 text-5xl font-bold tabular-nums tracking-tight ${
                    isGreen ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {formatMonthly(run.recommendation.monthlySpendTodayDollars)}
                </p>
                <p className="mt-0.5 text-[12px] text-stone-500">
                  {formatCurrency(run.recommendation.annualSpendTodayDollars)}/yr today's dollars
                </p>
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
        />
      </div>

      {adoptingCertification && (
        <PolicyAdoptionModal
          policy={adoptingCertification.evaluation.policy}
          currentData={currentData}
          onCancel={() => setAdoptingCertification(null)}
          onConfirm={() => {
            adoptMinedPolicy(adoptingCertification.evaluation.policy, adoptingCertification.evaluation);
            appendTransactionEvent(`adopted ${formatCurrency(adoptingCertification.evaluation.policy.annualSpendTodayDollars)}/yr`);
            setAdoptingCertification(null);
          }}
        />
      )}
    </>
  );
}
