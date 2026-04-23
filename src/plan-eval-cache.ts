import type { UnifiedPlanEvaluationContext } from './store';

const CACHE_KEY = 'retirement-plan-eval-v1';

export function savePlanEvalToCache(context: UnifiedPlanEvaluationContext): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(context));
  } catch {
    // QuotaExceededError or serialization failure — silently ignore
  }
}

export function loadPlanEvalFromCache(
  expectedFingerprint: string,
): UnifiedPlanEvaluationContext | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const context = JSON.parse(raw) as UnifiedPlanEvaluationContext;
    if (context.fingerprint !== expectedFingerprint) return null;
    return context;
  } catch {
    return null;
  }
}

export function clearPlanEvalCache(): void {
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
