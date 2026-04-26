/**
 * Export screen — renders the JSON snapshot of the planning state for
 * external runners (LLM advisors, simulators, audits).
 *
 * Extracted from App.tsx as the first lazy-loaded room: the household
 * rarely opens this surface, so paying for the planning-export worker
 * URL plus 240+ lines of UI on first paint is wasteful. Wrapped in a
 * Suspense boundary at the call site (App.tsx, currentScreen === 'export').
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from './ui-primitives';
import { useAppStore } from './store';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import {
  PLANNING_EXPORT_CACHE_VERSION,
  buildPlanningStateExportWithResolvedContext,
  type PlanningStateExport,
} from './planning-export';
import type {
  PlanningExportWorkerRequest,
  PlanningExportWorkerResponse,
} from './planning-export-worker-types';

// Module-scoped cache + request ID prefix. Lives here (not in App.tsx)
// because nothing else reads them — extracting them with the screen keeps
// related code colocated and lets the worker code-split naturally.
const EXPORT_REQUEST_PREFIX = 'planning-export-request';
const exportPayloadCache = new Map<string, PlanningStateExport>();

export function ExportScreen() {
  const data = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.draftAssumptions);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const latestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.latestUnifiedPlanEvaluationContext,
  );
  const [copied, setCopied] = useState(false);
  const [payload, setPayload] = useState<PlanningStateExport | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestCounterRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const currentEvaluationFingerprint = useMemo(
    () =>
      buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
      }),
    [assumptions, data, selectedResponses, selectedStressors],
  );
  const unifiedPlanContextIsFresh =
    latestUnifiedPlanEvaluationContext?.fingerprint === currentEvaluationFingerprint;

  const exportCacheKey = useMemo(
    () =>
      JSON.stringify({
        cacheVersion: PLANNING_EXPORT_CACHE_VERSION,
        fingerprint: currentEvaluationFingerprint,
        unifiedPlanContext: unifiedPlanContextIsFresh
          ? {
              fingerprint: latestUnifiedPlanEvaluationContext?.fingerprint ?? null,
              capturedAtIso: latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null,
            }
          : null,
      }),
    [
      currentEvaluationFingerprint,
      latestUnifiedPlanEvaluationContext,
      unifiedPlanContextIsFresh,
    ],
  );
  useEffect(() => {
    const cached = exportPayloadCache.get(exportCacheKey) ?? null;
    if (cached) {
      setPayload(cached);
      setLoadState('ready');
      setLoadError(null);
      return;
    }

    setLoadState('loading');
    setLoadError(null);

    const requestId = `${EXPORT_REQUEST_PREFIX}-${requestCounterRef.current++}`;
    activeRequestIdRef.current = requestId;

    const workerAvailable = typeof Worker !== 'undefined';
    if (!workerAvailable) {
      void (async () => {
        try {
          const next = await buildPlanningStateExportWithResolvedContext({
            data,
            assumptions,
            selectedStressorIds: selectedStressors,
            selectedResponseIds: selectedResponses,
            unifiedPlanEvaluation:
              unifiedPlanContextIsFresh
                ? latestUnifiedPlanEvaluationContext?.evaluation ?? null
                : null,
            unifiedPlanEvaluationCapturedAtIso:
              unifiedPlanContextIsFresh
                ? latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null
                : null,
          });
          exportPayloadCache.set(exportCacheKey, next);
          if (activeRequestIdRef.current === requestId) {
            setPayload(next);
            setLoadState('ready');
            setLoadError(null);
          }
        } catch (error) {
          if (activeRequestIdRef.current === requestId) {
            setLoadState('error');
            setLoadError(error instanceof Error ? error.message : 'Failed to generate export.');
          }
        }
      })();
      return;
    }

    const worker = new Worker(new URL('./planning-export.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<PlanningExportWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== activeRequestIdRef.current) {
        return;
      }
      if (message.type === 'error') {
        setLoadState('error');
        setLoadError(message.error);
        return;
      }
      exportPayloadCache.set(exportCacheKey, message.payload);
      setPayload(message.payload);
      setLoadState('ready');
      setLoadError(null);
    };

    const requestMessage: PlanningExportWorkerRequest = {
      type: 'run',
      payload: {
        requestId,
        data,
        assumptions,
        selectedStressorIds: selectedStressors,
        selectedResponseIds: selectedResponses,
        unifiedPlanEvaluation:
          unifiedPlanContextIsFresh
            ? latestUnifiedPlanEvaluationContext?.evaluation ?? null
            : null,
        unifiedPlanEvaluationCapturedAtIso:
          unifiedPlanContextIsFresh
            ? latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null
            : null,
      },
    };
    worker.postMessage(requestMessage);

    return () => {
      worker.terminate();
    };
  }, [
    assumptions,
    data,
    exportCacheKey,
    latestUnifiedPlanEvaluationContext,
    selectedResponses,
    selectedStressors,
    unifiedPlanContextIsFresh,
  ]);
  const payloadJson = useMemo(
    () => (payload ? JSON.stringify(payload, null, 2) : ''),
    [payload],
  );
  const probeStatusCounts = useMemo(() => {
    const counts = {
      modeled: 0,
      partial: 0,
      attention: 0,
      missing: 0,
    };
    payload?.probeChecklist.items.forEach((item) => {
      counts[item.status] += 1;
    });
    return counts;
  }, [payload?.probeChecklist.items]);

  const copyPayload = async () => {
    const text = payloadJson;
    if (!text) {
      return;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const element = document.createElement('textarea');
        element.value = text;
        element.setAttribute('readonly', 'true');
        element.style.position = 'absolute';
        element.style.left = '-9999px';
        document.body.appendChild(element);
        element.select();
        document.execCommand('copy');
        document.body.removeChild(element);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Panel
      title="Export"
      subtitle="Machine-readable snapshot of the current planning state for external AI/simulation runners."
    >
      <div className="rounded-[24px] bg-stone-100/85 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-stone-600">
              Current state export ({payload?.version.schema ?? 'pending'})
            </p>
            <p className="text-xs text-stone-500">
              Unified plan context: {payload?.flightPath.evaluationContext.available
                ? `included (${payload.flightPath.evaluationContext.capturedAtIso ?? 'timestamp unavailable'})`
                : latestUnifiedPlanEvaluationContext
                  ? 'stale versus current draft inputs (rerun Unified Plan to refresh summary metrics)'
                  : 'not available (run Unified Plan to include route-based recommendations)'}
            </p>
            <p className="text-xs text-stone-500">
              Probe checklist: {payload?.probeChecklist.items.length ?? 0} items · modeled {probeStatusCounts.modeled} · partial {probeStatusCounts.partial} · attention {probeStatusCounts.attention} · missing {probeStatusCounts.missing}
            </p>
            {loadState === 'loading' ? (
              <p className="text-xs text-blue-700">Generating export in background…</p>
            ) : null}
            {loadState === 'error' ? (
              <p className="text-xs text-red-700">Export failed: {loadError}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={copyPayload}
            disabled={!payload}
            className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {payload ? (
          <pre className="mt-3 max-h-[640px] overflow-auto rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-100">
            <code>{payloadJson}</code>
          </pre>
        ) : (
          <div className="mt-3 rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-200">
            Building export payload...
          </div>
        )}
      </div>
    </Panel>
  );
}
