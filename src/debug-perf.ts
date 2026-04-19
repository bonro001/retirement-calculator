type PerfScope =
  | 'simulation'
  | 'solver'
  | 'plan-eval'
  | 'retirement-plan'
  | 'unified-plan';

interface PerfMeta {
  [key: string]: unknown;
}

let perfSequence = 0;

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function debugEnabled() {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  const devMode = typeof window !== 'undefined' && Boolean(meta.env?.DEV);
  const forcedFlag =
    typeof globalThis !== 'undefined' &&
    Boolean((globalThis as { __RETIRE_DEBUG_PERF__?: boolean }).__RETIRE_DEBUG_PERF__);
  return devMode || forcedFlag;
}

export function perfLog(scope: PerfScope, message: string, meta?: PerfMeta) {
  if (!debugEnabled()) {
    return;
  }
  if (meta) {
    console.info(`[perf][${scope}] ${message}`, meta);
    return;
  }
  console.info(`[perf][${scope}] ${message}`);
}

export function perfStart(scope: PerfScope, message: string, meta?: PerfMeta) {
  const id = ++perfSequence;
  const startedAt = nowMs();
  perfLog(scope, `${message}:start`, { id, ...meta });

  return (outcome: 'ok' | 'error' | 'cancelled' | 'skipped', extra?: PerfMeta) => {
    const durationMs = Number((nowMs() - startedAt).toFixed(1));
    perfLog(scope, `${message}:end`, {
      id,
      outcome,
      durationMs,
      ...(extra ?? {}),
    });
  };
}
