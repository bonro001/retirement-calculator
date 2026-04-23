import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPlanningStateExportWithResolvedContext, PLANNING_EXPORT_CACHE_VERSION, type PlanningExportMode, type PlanningStateExport } from './planning-export';
import type {
  PlanningExportWorkerRequest,
  PlanningExportWorkerResponse,
} from './planning-export-worker-types';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { loadExportPayloadFromCache, saveExportPayloadToCache } from './export-payload-cache';
import { useAppStore } from './store';

export type PlanningExportLoadState = 'idle' | 'loading' | 'ready' | 'error';

const EXPORT_REQUEST_PREFIX = 'planning-export-request';
const exportPayloadCache = new Map<string, PlanningStateExport>();

export function usePlanningExportPayload(exportMode: PlanningExportMode = 'compact') {
  const data = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.draftAssumptions);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const latestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.latestUnifiedPlanEvaluationContext,
  );
  const [payload, setPayload] = useState<PlanningStateExport | null>(null);
  const [loadState, setLoadState] = useState<PlanningExportLoadState>('idle');
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
  const freshUnifiedPlanEvaluationContext = unifiedPlanContextIsFresh
    ? latestUnifiedPlanEvaluationContext
    : null;

  const exportCacheKey = useMemo(
    () =>
      JSON.stringify({
        cacheVersion: PLANNING_EXPORT_CACHE_VERSION,
        exportMode,
        fingerprint: currentEvaluationFingerprint,
        unifiedPlanContext: freshUnifiedPlanEvaluationContext
          ? {
              fingerprint: freshUnifiedPlanEvaluationContext.fingerprint,
              capturedAtIso: freshUnifiedPlanEvaluationContext.capturedAtIso,
            }
          : null,
      }),
    [
      currentEvaluationFingerprint,
      exportMode,
      freshUnifiedPlanEvaluationContext,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    const cached = exportPayloadCache.get(exportCacheKey) ?? null;
    if (cached) {
      setPayload(cached);
      setLoadState('ready');
      setLoadError(null);
      return;
    }

    // Surface a loading state immediately; the async IndexedDB read may hit
    // and swap to 'ready', but until it does we want the UI to show skeletons
    // rather than freeze or render stale data.
    setLoadState('loading');
    setLoadError(null);

    const requestId = `${EXPORT_REQUEST_PREFIX}-${requestCounterRef.current++}`;
    activeRequestIdRef.current = requestId;

    let worker: Worker | null = null;

    void (async () => {
      // Check persistent cache before launching a worker
      const persisted = await loadExportPayloadFromCache(
        currentEvaluationFingerprint,
        exportMode,
        PLANNING_EXPORT_CACHE_VERSION,
      );
      if (cancelled) return;
      if (persisted) {
        exportPayloadCache.set(exportCacheKey, persisted);
        setPayload(persisted);
        setLoadState('ready');
        setLoadError(null);
        return;
      }

      const workerAvailable = typeof Worker !== 'undefined';
      if (!workerAvailable) {
        try {
          const next = await buildPlanningStateExportWithResolvedContext({
            data,
            assumptions,
            selectedStressorIds: selectedStressors,
            selectedResponseIds: selectedResponses,
            exportMode,
            unifiedPlanEvaluation: freshUnifiedPlanEvaluationContext?.evaluation ?? null,
            unifiedPlanEvaluationCapturedAtIso:
              freshUnifiedPlanEvaluationContext?.capturedAtIso ?? null,
          });
          if (cancelled) return;
          exportPayloadCache.set(exportCacheKey, next);
          void saveExportPayloadToCache(
            currentEvaluationFingerprint,
            exportMode,
            PLANNING_EXPORT_CACHE_VERSION,
            next,
          );
          if (activeRequestIdRef.current === requestId) {
            setPayload(next);
            setLoadState('ready');
            setLoadError(null);
          }
        } catch (error) {
          if (cancelled) return;
          if (activeRequestIdRef.current === requestId) {
            setLoadState('error');
            setLoadError(
              error instanceof Error ? error.message : 'Failed to generate export.',
            );
          }
        }
        return;
      }

      worker = new Worker(new URL('./planning-export.worker.ts', import.meta.url), {
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
        void saveExportPayloadToCache(
          currentEvaluationFingerprint,
          exportMode,
          PLANNING_EXPORT_CACHE_VERSION,
          message.payload,
        );
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
          exportMode,
          unifiedPlanEvaluation: freshUnifiedPlanEvaluationContext?.evaluation ?? null,
          unifiedPlanEvaluationCapturedAtIso:
            freshUnifiedPlanEvaluationContext?.capturedAtIso ?? null,
        },
      };
      worker.postMessage(requestMessage);
    })();

    return () => {
      cancelled = true;
      if (worker) worker.terminate();
    };
  }, [
    assumptions,
    data,
    exportCacheKey,
    exportMode,
    freshUnifiedPlanEvaluationContext,
    selectedResponses,
    selectedStressors,
  ]);

  return {
    payload,
    loadState,
    loadError,
    latestUnifiedPlanEvaluationContext,
  };
}
