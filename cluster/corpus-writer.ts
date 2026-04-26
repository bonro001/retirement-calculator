/**
 * Policy Miner Cluster — Corpus Writer.
 *
 * Owns the on-disk artifacts a session produces. Append-only JSONL for
 * evaluations, a single `summary.json` written when the session finishes,
 * and a `manifest.json` written at session start so a crash leaves enough
 * crumbs for D.5 resume-handling to reconstruct what was happening.
 *
 * Why JSONL: every line is a complete, parseable record. A crash mid-write
 * loses at most one in-flight line (and the dispatcher will requeue that
 * batch on D.5). `cat`, `wc -l`, and `jq` all just work. The browser can
 * stream-parse over a fetch later when D.3+ wires download.
 *
 * Layout on disk:
 *
 *   <root>/sessions/<sessionId>/
 *     manifest.json        — written once at session start (config + axes)
 *     evaluations.jsonl    — one PolicyEvaluation per line, append-only
 *     summary.json         — written once at session end (counts + best policy)
 *
 * Concurrency: the dispatcher is single-threaded so we don't need locks
 * across writers. We DO need to flush after every append so a SIGKILL
 * doesn't strand recent work in the libuv buffer; the cost is one fsync
 * per batch result, which is fine at <1 batch/sec/host.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyEvaluation, PolicyMiningSessionConfig } from '../src/policy-miner-types';

/** Default root for session artifacts. Sits under cluster/data/ so a single
 *  `.gitignore` keeps the whole tree out of git. Override with the env var
 *  `CLUSTER_DATA_DIR` if you want sessions to land somewhere external
 *  (e.g. a NAS mount).
 *
 *  Use `fileURLToPath` rather than `new URL(...).pathname` — the latter
 *  returns a URL-encoded string, so a project path containing spaces
 *  would land at `Retirenment%20Calculator/...` (a sibling directory)
 *  instead of the real project root. */
export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

/**
 * What a manifest captures. Enough to tell, after the fact, exactly what
 * the dispatcher was asked to do. Does NOT include the SeedData payload
 * itself — it's potentially large and the controller is expected to keep
 * its own copy. The fingerprint is the bridge.
 */
export interface SessionManifest {
  sessionId: string;
  startedAtIso: string;
  config: PolicyMiningSessionConfig;
  trialCount: number;
  legacyTargetTodayDollars: number;
  totalPolicies: number;
  /** Display name of the controller that started this session, for audit. */
  startedBy: string;
}

/** What we write at session end. Read by D.3+ controllers and any future
 *  ranking dashboard. */
export interface SessionSummary {
  sessionId: string;
  startedAtIso: string;
  endedAtIso: string;
  state: 'completed' | 'cancelled' | 'error';
  totalPolicies: number;
  evaluatedCount: number;
  feasibleCount: number;
  /** Best policy id discovered. Null if no feasible policies were found. */
  bestPolicyId: string | null;
  /** Optional cause when state !== 'completed'. */
  reason?: string;
}

/**
 * One open session. The fd pointer is kept hot for the duration of the
 * session so we don't pay open()/close() cost per batch result.
 */
interface OpenSession {
  sessionId: string;
  sessionDir: string;
  evaluationsPath: string;
  fd: number;
  evaluationCount: number;
  /** Best evaluation seen so far for the summary. Comparator: highest
   *  feasibility-passing annual spend, with p50 bequest as tiebreaker. */
  bestSoFar: PolicyEvaluation | null;
  feasibilityThreshold: number;
}

/**
 * Bookkeeping for all currently-open sessions. With one-session-at-a-time
 * the map will only ever have 0 or 1 entries, but keeping it as a map
 * means lifting the constraint later (D.5+ multi-session) is trivial.
 */
const openSessions = new Map<string, OpenSession>();

/**
 * Open a new session for writing. Creates the session dir, writes the
 * manifest, and opens evaluations.jsonl for appending. Throws if the
 * session id is already open or if the dir can't be created.
 */
export function openSessionForWrite(
  manifest: SessionManifest,
  rootDir: string = DEFAULT_DATA_DIR,
): void {
  if (openSessions.has(manifest.sessionId)) {
    throw new Error(`session already open: ${manifest.sessionId}`);
  }
  const sessionDir = join(rootDir, 'sessions', manifest.sessionId);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  // Manifest is written once and never updated. If a session reuses an
  // id (it shouldn't — we stamp time into the id) the existing manifest
  // is overwritten and we treat that as caller error elsewhere.
  writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const evaluationsPath = join(sessionDir, 'evaluations.jsonl');
  // 'a' = append; create if missing. If a previous run crashed mid-session
  // and is being re-run, we'd append to the old file — that's a D.5
  // concern (resume vs. fresh start); for D.4 we assume fresh sessionIds.
  const fd = openSync(evaluationsPath, 'a');
  openSessions.set(manifest.sessionId, {
    sessionId: manifest.sessionId,
    sessionDir,
    evaluationsPath,
    fd,
    evaluationCount: 0,
    bestSoFar: null,
    feasibilityThreshold: manifest.config.feasibilityThreshold,
  });
}

/**
 * Append a batch of evaluations to the session's JSONL file. Each
 * evaluation becomes one line. fsync's after the write so a SIGKILL
 * doesn't lose in-flight lines.
 *
 * Returns the running best evaluation (after this batch is applied) — the
 * caller broadcasts it in cluster_state so observers can see the front
 * runner without re-reading the file.
 */
export function appendEvaluations(
  sessionId: string,
  evaluations: PolicyEvaluation[],
): { feasibleInBatch: number; runningBest: PolicyEvaluation | null } {
  const session = openSessions.get(sessionId);
  if (!session) {
    throw new Error(`session not open: ${sessionId}`);
  }
  if (evaluations.length === 0) {
    return { feasibleInBatch: 0, runningBest: session.bestSoFar };
  }
  // Build the chunk first; one writev is way better than N appends. JSONL
  // means newline-terminated; the trailing newline is required so the
  // next append doesn't accidentally concatenate with the prior record.
  const chunk = evaluations.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
  appendFileSync(session.fd, chunk);
  // fdatasync, not fsync — the file metadata can wait, the data can't.
  // On macOS fdatasync is a syscall that delegates to F_FULLFSYNC for
  // safety; on Linux it's the lighter version of fsync. Both correct.
  try {
    fdatasyncSync(session.fd);
  } catch {
    // Some filesystems (tmpfs, fuse) don't implement fdatasync. Not fatal
    // — the data is still in the OS page cache and will land eventually.
  }

  let feasibleInBatch = 0;
  for (const ev of evaluations) {
    if (ev.outcome.bequestAttainmentRate >= session.feasibilityThreshold) {
      feasibleInBatch += 1;
      if (
        !session.bestSoFar ||
        isBetterFeasible(ev, session.bestSoFar, session.feasibilityThreshold)
      ) {
        session.bestSoFar = ev;
      }
    }
  }
  session.evaluationCount += evaluations.length;
  return { feasibleInBatch, runningBest: session.bestSoFar };
}

/**
 * Comparator mirrors the V1 ranking from the in-browser miner: among
 * feasible candidates (bequest attainment ≥ threshold), prefer higher
 * annual spend; tiebreak on higher p50 ending wealth.
 *
 * Lives here (not in policy-miner-eval) because the dispatcher needs to
 * pick a "best so far" without dragging in the browser miner's helpers.
 */
function isBetterFeasible(
  candidate: PolicyEvaluation,
  incumbent: PolicyEvaluation,
  threshold: number,
): boolean {
  if (candidate.outcome.bequestAttainmentRate < threshold) return false;
  if (incumbent.outcome.bequestAttainmentRate < threshold) return true;
  if (candidate.policy.annualSpendTodayDollars !== incumbent.policy.annualSpendTodayDollars) {
    return candidate.policy.annualSpendTodayDollars > incumbent.policy.annualSpendTodayDollars;
  }
  return (
    candidate.outcome.p50EndingWealthTodayDollars >
    incumbent.outcome.p50EndingWealthTodayDollars
  );
}

/**
 * Close out a session. Writes summary.json with authoritative totals
 * supplied by the caller (from the work queue, which knows about batches
 * that nack'd or were requeued — the writer only sees raw appends).
 * Closes the fd and removes the session from the open map. Idempotent
 * — calling twice is a no-op after the first.
 */
export function closeSessionWithStats(
  sessionId: string,
  state: SessionSummary['state'],
  startedAtIso: string,
  totals: { totalPolicies: number; evaluatedCount: number; feasibleCount: number },
  reason?: string,
): SessionSummary | null {
  const session = openSessions.get(sessionId);
  if (!session) return null;
  const summary: SessionSummary = {
    sessionId,
    startedAtIso,
    endedAtIso: new Date().toISOString(),
    state,
    totalPolicies: totals.totalPolicies,
    evaluatedCount: totals.evaluatedCount,
    feasibleCount: totals.feasibleCount,
    bestPolicyId: session.bestSoFar?.id ?? null,
    ...(reason ? { reason } : {}),
  };
  writeFileSync(join(session.sessionDir, 'summary.json'), JSON.stringify(summary, null, 2));
  try {
    closeSync(session.fd);
  } catch {
    /* fd may already be closed */
  }
  openSessions.delete(sessionId);
  return summary;
}

/** For diagnostics / cluster-state. */
export function getSessionPath(sessionId: string): string | null {
  return openSessions.get(sessionId)?.sessionDir ?? null;
}
