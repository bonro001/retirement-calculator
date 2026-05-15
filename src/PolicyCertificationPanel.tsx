import { useEffect, useMemo, useState } from 'react';
import {
  type PolicyCertificationMetricRow,
  type PolicyCertificationPack,
  type PolicyCertificationVerdict,
} from './policy-certification';
import type {
  PolicyEvaluation,
  PolicySpendingScheduleBasis,
} from './policy-miner-types';
import type {
  PolicyCertificationWorkerRequest,
  PolicyCertificationWorkerResponse,
} from './policy-certification.worker-types';
import type { MarketAssumptions, SeedData } from './types';

interface Props {
  evaluation: PolicyEvaluation;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  legacyTargetTodayDollars: number;
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null;
  onClose: () => void;
}

type RunState =
  | { kind: 'running'; completed: number; total: number; startedAtMs: number }
  | { kind: 'complete'; pack: PolicyCertificationPack; startedAtMs: number; finishedAtMs: number }
  | { kind: 'failed'; reason: string };

function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (Math.abs(amount) >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  return `$${Math.round(amount)}`;
}

function formatExactCurrency(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return `$${Math.round(amount).toLocaleString()}`;
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function verdictClass(verdict: PolicyCertificationVerdict): string {
  switch (verdict) {
    case 'green':
      return 'border-emerald-200 bg-emerald-50 text-emerald-900';
    case 'yellow':
      return 'border-amber-200 bg-amber-50 text-amber-900';
    case 'red':
      return 'border-rose-200 bg-rose-50 text-rose-900';
  }
}

function rowTone(row: PolicyCertificationMetricRow): string {
  if (row.scenarioKind === 'baseline') {
    if (
      row.solvencyRate < 0.9 ||
      row.legacyAttainmentRate < 0.8 ||
      row.first10YearFailureRisk > 0.03
    ) {
      return 'text-rose-700';
    }
    if (
      row.solvencyRate < 0.95 ||
      row.legacyAttainmentRate < 0.85 ||
      row.first10YearFailureRisk > 0.01 ||
      row.spendingCutRate > 0.1
    ) {
      return 'text-amber-700';
    }
    return 'text-emerald-700';
  }
  if (row.solvencyRate < 0.75 || row.first10YearFailureRisk > 0.1) {
    return 'text-rose-700';
  }
  if (
    row.solvencyRate < 0.85 ||
    row.legacyAttainmentRate < 0.7 ||
    row.first10YearFailureRisk > 0.05 ||
    row.spendingCutRate > 0.25
  ) {
    return 'text-amber-700';
  }
  return 'text-emerald-700';
}

function basisKey(basis?: PolicySpendingScheduleBasis | null): string {
  if (!basis) return 'current_faithful';
  return JSON.stringify({
    id: basis.id,
    multipliersByYear: basis.multipliersByYear,
  });
}

function MetricTable({
  rows,
  title,
}: {
  rows: PolicyCertificationMetricRow[];
  title: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
        {title}
      </p>
      <div className="mt-1 overflow-x-auto">
        <table className="min-w-full text-left text-[11px] tabular-nums">
          <thead className="border-b border-stone-200 text-stone-500">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Basis</th>
              <th className="py-1.5 pr-3 font-medium">Mode</th>
              <th className="py-1.5 pr-3 font-medium">Scenario</th>
              <th className="py-1.5 pr-3 text-right font-medium">Solvent</th>
              <th className="py-1.5 pr-3 text-right font-medium">Legacy</th>
              <th className="py-1.5 pr-3 text-right font-medium">First-10 fail</th>
              <th className="py-1.5 pr-3 text-right font-medium">Cut rate</th>
              <th className="py-1.5 pr-3 text-right font-medium">P10 EW</th>
              <th className="py-1.5 pr-3 text-right font-medium">P50 EW</th>
              <th className="py-1.5 text-right font-medium">Failure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((row) => (
              <tr key={row.id} className="align-top">
                <td className="py-1.5 pr-3 font-medium text-stone-800">{row.basisLabel}</td>
                <td className="py-1.5 pr-3 text-stone-600">{row.modeLabel}</td>
                <td className="py-1.5 pr-3 text-stone-600">{row.scenarioName}</td>
                <td className={`py-1.5 pr-3 text-right font-semibold ${rowTone(row)}`}>
                  {formatPct(row.solvencyRate)}
                </td>
                <td className="py-1.5 pr-3 text-right">{formatPct(row.legacyAttainmentRate)}</td>
                <td className="py-1.5 pr-3 text-right">{formatPct(row.first10YearFailureRisk)}</td>
                <td className="py-1.5 pr-3 text-right">{formatPct(row.spendingCutRate)}</td>
                <td className="py-1.5 pr-3 text-right">{formatCurrency(row.p10EndingWealthTodayDollars)}</td>
                <td className="py-1.5 pr-3 text-right">{formatCurrency(row.p50EndingWealthTodayDollars)}</td>
                <td className="py-1.5 text-right text-stone-500">
                  {row.mostLikelyFailureYear
                    ? `${row.mostLikelyFailureYear} (${formatPct(row.failureConcentrationRate)})`
                    : 'none'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PolicyCertificationPanel({
  evaluation,
  baseline,
  assumptions,
  baselineFingerprint,
  engineVersion,
  legacyTargetTodayDollars,
  spendingScheduleBasis,
  onClose,
}: Props): JSX.Element {
  const [runState, setRunState] = useState<RunState>({
    kind: 'running',
    completed: 0,
    total: 1,
    startedAtMs: Date.now(),
  });
  const scheduleKey = useMemo(
    () => basisKey(spendingScheduleBasis),
    [spendingScheduleBasis],
  );

  useEffect(() => {
    let cancelled = false;
    const requestId = `cert-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const startedAtMs = Date.now();
    const worker = new Worker(
      new URL('./policy-certification.worker.ts', import.meta.url),
      { type: 'module' },
    );

    setRunState({ kind: 'running', completed: 0, total: 1, startedAtMs });

    worker.onmessage = (
      event: MessageEvent<PolicyCertificationWorkerResponse>,
    ) => {
      const message = event.data;
      if (message.requestId !== requestId || cancelled) return;
      if (message.type === 'progress') {
        setRunState({
          kind: 'running',
          completed: message.completed,
          total: message.total,
          startedAtMs,
        });
        return;
      }
      if (message.type === 'result') {
        setRunState({
          kind: 'complete',
          pack: message.pack,
          startedAtMs,
          finishedAtMs: Date.now(),
        });
        worker.terminate();
        return;
      }
      setRunState({
        kind: 'failed',
        reason: message.error,
      });
      worker.terminate();
    };

    worker.onerror = (event) => {
      if (!cancelled) {
        setRunState({
          kind: 'failed',
          reason: event.message || 'Certification worker failed',
        });
      }
      worker.terminate();
    };

    const request: PolicyCertificationWorkerRequest = {
      type: 'run',
      requestId,
      payload: {
        policy: evaluation.policy,
        baseline,
        assumptions,
        baselineFingerprint,
        engineVersion,
        legacyTargetTodayDollars,
        spendingScheduleBasis,
      },
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      worker.terminate();
      if (!cancelled) {
        setRunState({
          kind: 'failed',
          reason:
            error instanceof Error
              ? error.message
              : 'Certification worker could not start',
        });
      }
    }

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [
    assumptions,
    baseline,
    baselineFingerprint,
    engineVersion,
    evaluation.id,
    legacyTargetTodayDollars,
    scheduleKey,
  ]);

  const pack = runState.kind === 'complete' ? runState.pack : null;
  const baselineRows = pack?.rows.filter((row) => row.scenarioKind === 'baseline') ?? [];
  const stressRows = pack?.rows.filter((row) => row.scenarioKind === 'stress') ?? [];
  const elapsedMs =
    runState.kind === 'complete'
      ? runState.finishedAtMs - runState.startedAtMs
      : runState.kind === 'running'
        ? Date.now() - runState.startedAtMs
        : null;

  return (
    <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50/60 p-3 text-[12px] text-stone-700">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-700">
            Certification pack
          </p>
          <p className="mt-1 text-base font-semibold text-stone-950">
            {formatExactCurrency(evaluation.policy.annualSpendTodayDollars)}/yr spend check
          </p>
          <p className="mt-0.5 text-stone-500">
            Conservative dual-basis review across current faithful and the selected spending curve.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="self-start rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-stone-600 ring-1 ring-stone-200 transition hover:bg-stone-50"
        >
          Close
        </button>
      </div>

      {runState.kind === 'running' && (
        <div className="mt-3 rounded-lg bg-white/80 p-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-semibold text-stone-800">Running certification</span>
            <span className="text-stone-500">
              {runState.completed}/{runState.total}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100">
            <div
              className="h-full rounded-full bg-blue-600 transition-all"
              style={{
                width: `${Math.max(
                  4,
                  Math.min(100, (runState.completed / Math.max(1, runState.total)) * 100),
                )}%`,
              }}
            />
          </div>
          <p className="mt-2 text-[11px] text-stone-500">
            Running both distribution modes, stress rows, and three-seed stability audit.
          </p>
        </div>
      )}

      {runState.kind === 'failed' && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-rose-800">
          Certification failed: {runState.reason}
        </p>
      )}

      {pack && (
        <div className="mt-3 space-y-3">
          <div className={`rounded-lg border px-3 py-2 ${verdictClass(pack.verdict)}`}>
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-semibold">
                  {pack.verdict === 'green'
                    ? 'Green: sleep-well certified'
                    : pack.verdict === 'yellow'
                      ? 'Yellow: usable, but not sleep-well'
                      : 'Red: do not rely on this spend yet'}
                </p>
                <p className="mt-0.5 text-[11px] opacity-80">
                  {pack.metadata.trialCount.toLocaleString()} trials · seeds{' '}
                  {pack.metadata.auditSeeds.join(', ')}
                  {elapsedMs !== null ? ` · ${Math.round(elapsedMs / 1000)}s` : ''}
                </p>
              </div>
              <div className="text-[11px] font-medium">
                Basis: {pack.metadata.selectedSpendingBasisLabel ?? 'Current faithful only'}
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Why this verdict
            </p>
            <ul className="mt-2 space-y-1 text-[12px] text-stone-700">
              {pack.reasons.slice(0, 6).map((reason) => (
                <li key={`${reason.code}-${reason.message}`}>
                  <span className="font-semibold">{reason.level.toUpperCase()}:</span>{' '}
                  {reason.message}
                </li>
              ))}
            </ul>
          </div>

          <MetricTable rows={baselineRows} title="Dual-basis baseline rows" />
          <MetricTable rows={stressRows} title="Stress rows" />

          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-lg bg-white/80 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                Seed stability
              </p>
              <div className="mt-2 space-y-1">
                {pack.seedAudits.map((audit) => (
                  <p key={`${audit.basisId}-${audit.mode}`} className="text-[12px] text-stone-700">
                    <span className="font-medium">{audit.basisLabel} / {audit.modeLabel}:</span>{' '}
                    worst seed {formatPct(audit.worstSolvencyRate)} solvent ·{' '}
                    {formatPct(audit.worstLegacyAttainmentRate)} legacy
                  </p>
                ))}
              </div>
            </div>
            <div className="rounded-lg bg-white/80 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                Operating guardrail
              </p>
              <p className="mt-2 text-[12px] text-stone-700">
                Authorized spend {formatExactCurrency(pack.guardrail.authorizedAnnualSpend)}/yr.
                Discretionary throttle{' '}
                {formatExactCurrency(pack.guardrail.discretionaryThrottleAnnual)}/yr.
              </p>
              <p className="mt-1 text-[11px] text-stone-500">{pack.guardrail.yellowTrigger}</p>
              <p className="mt-1 text-[11px] text-stone-500">{pack.guardrail.redTrigger}</p>
              <p className="mt-1 text-[11px] text-amber-700">{pack.guardrail.yellowResponse}</p>
              <p className="mt-1 text-[11px] text-rose-700">{pack.guardrail.redResponse}</p>
              {pack.guardrail.inferredAssumptions.length ? (
                <p className="mt-1 text-[10px] text-stone-400">
                  {pack.guardrail.inferredAssumptions[0]}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
