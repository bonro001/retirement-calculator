/**
 * Policy Miner — Cluster Corpus Fetcher (browser side).
 *
 * The dispatcher exposes a tiny read-only HTTP API alongside its
 * WebSocket service:
 *
 *   GET /sessions                       → { sessions: SessionListing[] }
 *   GET /sessions/:id                   → { manifest, summary, evaluationCount }
 *   GET /sessions/:id/evaluations       → { sessionId, baselineFingerprint,
 *                                            engineVersion, evaluationCount,
 *                                            evaluations: PolicyEvaluation[] }
 *
 * This module is the browser-side counterpart. It converts the
 * `ws://` URL the user already typed into the cluster status card into
 * the matching `http://` origin, and wraps `fetch` with shape-checked
 * helpers so callers don't need to know the wire format.
 *
 * Why a separate module: keeping the fetcher pure (no React, no hooks)
 * makes it trivially testable and reusable from any future UI surface
 * (sweep view, frontier scatter, sensitivity sweeps).
 *
 * What this module DOESN'T do: it never writes — there is no
 * "import this cluster session into local IndexedDB" path here.
 * The results table renders cluster evaluations directly without
 * mirroring them locally. That keeps two stores from disagreeing
 * about which records exist.
 */

import type { PolicyEvaluation, PolicyMiningSessionConfig } from './policy-miner-types';

/**
 * What the dispatcher's `/sessions` listing returns per row. Mirror of
 * `SessionListing` in `cluster/corpus-reader.ts` — re-declared here so
 * the browser bundle never imports node-only modules from `cluster/`.
 */
export interface ClusterSessionListing {
  sessionId: string;
  manifest: ClusterSessionManifest;
  summary: ClusterSessionSummary | null;
  evaluationCount: number;
  /** Used to sort the picker most-recent-first. */
  lastActivityMs: number;
}

export interface ClusterSessionManifest {
  sessionId: string;
  startedAtIso: string;
  config: PolicyMiningSessionConfig;
  trialCount: number;
  legacyTargetTodayDollars: number;
  totalPolicies: number;
  startedBy: string;
}

export interface ClusterSessionSummary {
  sessionId: string;
  startedAtIso: string;
  endedAtIso: string;
  state: 'completed' | 'cancelled' | 'error';
  totalPolicies: number;
  evaluatedCount: number;
  feasibleCount: number;
  bestPolicyId: string | null;
  reason?: string;
}

export interface ClusterEvaluationsPayload {
  sessionId: string;
  baselineFingerprint: string;
  engineVersion: string;
  evaluationCount: number;
  evaluations: PolicyEvaluation[];
}

/**
 * Convert a WebSocket dispatcher URL (`ws://host:port` or
 * `wss://host:port/path`) into the matching HTTP origin
 * (`http://host:port` / `https://host:port`). Drops any path /
 * query / fragment because the HTTP API lives at the root.
 *
 * Falls back to the input unchanged if it doesn't parse as a URL —
 * the caller's fetch will then surface a meaningful error.
 */
export function clusterUrlToHttp(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const httpProtocol =
      u.protocol === 'wss:' ? 'https:' :
      u.protocol === 'ws:' ? 'http:' :
      // Already http/https — pass through; otherwise let URL throw.
      u.protocol;
    return `${httpProtocol}//${u.host}`;
  } catch {
    return wsUrl;
  }
}

/**
 * Internal: GET <origin>/<path> and parse JSON. Throws a tagged
 * `ClusterFetchError` so the UI can render "dispatcher unreachable"
 * vs "session not found" differently.
 */
async function fetchJson<T>(dispatcherUrl: string, path: string): Promise<T> {
  const origin = clusterUrlToHttp(dispatcherUrl);
  const url = `${origin}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', credentials: 'omit' });
  } catch (err) {
    throw new ClusterFetchError(
      `cannot reach dispatcher at ${origin} — is it running?`,
      'unreachable',
      { cause: err },
    );
  }
  if (res.status === 404) {
    throw new ClusterFetchError(`not found: ${path}`, 'not_found');
  }
  if (!res.ok) {
    throw new ClusterFetchError(
      `dispatcher returned ${res.status} for ${path}`,
      'http_error',
    );
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new ClusterFetchError(
      `dispatcher returned non-JSON body for ${path}`,
      'bad_payload',
      { cause: err },
    );
  }
}

/**
 * Tagged error class so the UI can branch on `kind` rather than
 * regex-matching on message strings.
 */
export class ClusterFetchError extends Error {
  readonly kind: 'unreachable' | 'not_found' | 'http_error' | 'bad_payload';
  constructor(
    message: string,
    kind: ClusterFetchError['kind'],
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions | undefined);
    this.kind = kind;
    this.name = 'ClusterFetchError';
  }
}

/**
 * Fetch every session the dispatcher knows about. Already sorted
 * most-recent-first by the server. Returns [] (not an error) when the
 * dispatcher is up but has never run a session.
 */
export async function loadClusterSessions(
  dispatcherUrl: string,
): Promise<ClusterSessionListing[]> {
  const body = await fetchJson<{ sessions: ClusterSessionListing[] }>(
    dispatcherUrl,
    '/sessions',
  );
  return Array.isArray(body.sessions) ? body.sessions : [];
}

/**
 * Fetch the evaluations payload for one session. The wrapping
 * `{ evaluations, ..., evaluationCount }` envelope is unwrapped —
 * callers get the bare array and the metadata as a tuple-shaped result.
 *
 * Phase 2.D: optional `topN` caps the returned array at the top-N
 * evaluations server-side. Saves the browser from parsing 10MB+ JSON
 * every poll during a Full mine. The `evaluationCount` in the response
 * is the TOTAL records on disk — the UI can show "showing 200 of 4,346
 * evaluated" so the household knows the cap exists.
 *
 * `minFeasibility` (0..1) filters out records below the legacy floor;
 * `minSolvency` (0..1) filters out records below the solvency defense
 * floor. Setting either switches the default sort to spend-desc, so the
 * top-N reflects "highest spend that still clears the household gates".
 */
export async function loadClusterEvaluations(
  dispatcherUrl: string,
  sessionId: string,
  options?: { topN?: number; minFeasibility?: number; minSolvency?: number },
): Promise<ClusterEvaluationsPayload> {
  const qsParts: string[] = [];
  if (options?.topN && options.topN > 0) {
    qsParts.push(`topN=${encodeURIComponent(String(options.topN))}`);
  }
  if (options?.minFeasibility && options.minFeasibility > 0) {
    qsParts.push(
      `minFeasibility=${encodeURIComponent(String(options.minFeasibility))}`,
    );
  }
  if (options?.minSolvency && options.minSolvency > 0) {
    qsParts.push(
      `minSolvency=${encodeURIComponent(String(options.minSolvency))}`,
    );
  }
  const qs = qsParts.length > 0 ? `?${qsParts.join('&')}` : '';
  return fetchJson<ClusterEvaluationsPayload>(
    dispatcherUrl,
    `/sessions/${encodeURIComponent(sessionId)}/evaluations${qs}`,
  );
}

/**
 * Fetch the lightweight metadata for one session (manifest + summary
 * + line count, no payload). Used by "is this session done?" probes
 * and by the picker tooltip.
 */
export async function loadClusterSessionMetadata(
  dispatcherUrl: string,
  sessionId: string,
): Promise<{
  manifest: ClusterSessionManifest;
  summary: ClusterSessionSummary | null;
  evaluationCount: number;
}> {
  return fetchJson(dispatcherUrl, `/sessions/${encodeURIComponent(sessionId)}`);
}
