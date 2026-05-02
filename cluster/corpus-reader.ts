/**
 * Policy Miner Cluster — Corpus Reader.
 *
 * Read-only counterpart to `corpus-writer.ts`. The writer owns fds and
 * append semantics during a live session; the reader walks the directory
 * tree without holding any state. Used by:
 *
 *   - Dispatcher HTTP endpoints (`GET /sessions`, `GET /sessions/:id/...`)
 *     so the browser UI can pull what the cluster found without re-running.
 *   - Future CLI / debugging tools.
 *
 * Why a separate file: the writer's API is stateful (open / append /
 * close), and intermingling read helpers next to it muddies the contract.
 * Two modules, two clear shapes — readers never touch openSessions, writers
 * never re-parse the JSONL outside resume bootstrapping.
 */

import {
  createReadStream,
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PolicyEvaluation } from '../src/policy-miner-types';
import { DEFAULT_DATA_DIR, type SessionManifest, type SessionSummary } from './corpus-writer';

/**
 * One row in the session listing surface. Sessions can be in three
 * states from a reader's perspective:
 *
 *   - `manifest` only → in progress (or crashed; the dispatcher's
 *     resume scan distinguishes them, but a passive reader can't).
 *   - `manifest + summary` → cleanly closed (completed | cancelled | error).
 *
 * `evaluationCount` is sourced from the JSONL line count, not from the
 * summary — the summary's `evaluatedCount` includes batches that were
 * counted-as-complete via the queue (which can outpace what landed on
 * disk if a pre-D.5-fix bug dropped some). The line count is what the
 * UI can actually render.
 */
export interface SessionListing {
  sessionId: string;
  manifest: SessionManifest;
  summary: SessionSummary | null;
  evaluationCount: number;
  /** mtime of evaluations.jsonl, or manifest.json for empty sessions.
   *  Used to sort the picker dropdown most-recent-first. */
  lastActivityMs: number;
}

/**
 * List every session under `<rootDir>/sessions/`. Skips entries with
 * malformed manifests (the same tolerance as `findResumableSessions`).
 * Sorted most-recent-first by lastActivityMs so a picker dropdown
 * defaults to the freshest session.
 */
export function listSessions(rootDir: string = DEFAULT_DATA_DIR): SessionListing[] {
  const sessionsRoot = join(rootDir, 'sessions');
  if (!existsSync(sessionsRoot)) return [];
  const out: SessionListing[] = [];
  for (const entry of readdirSync(sessionsRoot)) {
    const sessionDir = join(sessionsRoot, entry);
    let st;
    try {
      st = statSync(sessionDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const manifestPath = join(sessionDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: SessionManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SessionManifest;
    } catch {
      continue; // malformed manifest — skip
    }
    const summaryPath = join(sessionDir, 'summary.json');
    let summary: SessionSummary | null = null;
    if (existsSync(summaryPath)) {
      try {
        summary = JSON.parse(readFileSync(summaryPath, 'utf-8')) as SessionSummary;
      } catch {
        // Malformed summary — treat as in-progress for the listing.
        summary = null;
      }
    }
    const evaluationsPath = join(sessionDir, 'evaluations.jsonl');
    let evaluationCount = 0;
    let lastActivityMs = st.mtimeMs;
    if (existsSync(evaluationsPath)) {
      evaluationCount = countJsonlLines(evaluationsPath);
      try {
        const evalSt = statSync(evaluationsPath);
        if (evalSt.mtimeMs > lastActivityMs) lastActivityMs = evalSt.mtimeMs;
      } catch {
        /* ignore */
      }
    }
    out.push({
      sessionId: entry,
      manifest,
      summary,
      evaluationCount,
      lastActivityMs,
    });
  }
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}

/**
 * Read every evaluation line from a session's JSONL file. Tolerates a
 * partial trailing line (a SIGKILL between writev and the trailing
 * newline) and any malformed lines from an old crash. Returns [] if
 * the session doesn't exist.
 *
 * Memory: at our scale (≤8,748 records × ~600B = ~5MB) loading the whole
 * file into memory is fine. If sessions ever grow into the millions,
 * swap for a line-stream — the caller signature doesn't change.
 */
export function readEvaluations(
  sessionId: string,
  rootDir: string = DEFAULT_DATA_DIR,
): PolicyEvaluation[] {
  const evaluationsPath = join(rootDir, 'sessions', sessionId, 'evaluations.jsonl');
  if (!existsSync(evaluationsPath)) return [];
  const text = readFileSync(evaluationsPath, 'utf-8');
  if (text.length === 0) return [];
  const out: PolicyEvaluation[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as PolicyEvaluation);
    } catch {
      // Partial / malformed line — skip. See scanExistingEvaluations
      // in corpus-writer for the same tolerance during resume.
      continue;
    }
  }
  return out;
}

export interface SpendTierSummary {
  spend: number;
  totalRecords: number;
  feasibleRecords: number;
  maxFeasibility: number;
}

export async function readSpendTierSummaries(
  sessionId: string,
  feasibilityThreshold: number,
  rootDir: string = DEFAULT_DATA_DIR,
): Promise<SpendTierSummary[]> {
  const evaluationsPath = join(rootDir, 'sessions', sessionId, 'evaluations.jsonl');
  if (!existsSync(evaluationsPath)) return [];
  const byTier = new Map<
    number,
    { totalRecords: number; feasibleRecords: number; maxFeasibility: number }
  >();
  const lines = createInterface({
    input: createReadStream(evaluationsPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length === 0) continue;
    let ev: PolicyEvaluation;
    try {
      ev = JSON.parse(line) as PolicyEvaluation;
    } catch {
      continue;
    }
    const spend = ev.policy.annualSpendTodayDollars;
    const feasibility = ev.outcome.bequestAttainmentRate;
    const tier = byTier.get(spend) ?? {
      totalRecords: 0,
      feasibleRecords: 0,
      maxFeasibility: 0,
    };
    tier.totalRecords += 1;
    if (feasibility >= feasibilityThreshold) tier.feasibleRecords += 1;
    if (feasibility > tier.maxFeasibility) tier.maxFeasibility = feasibility;
    byTier.set(spend, tier);
  }
  return Array.from(byTier.entries())
    .map(([spend, tier]) => ({ spend, ...tier }))
    .sort((a, b) => a.spend - b.spend);
}

/**
 * Read just the manifest for a single session — used by the dispatcher's
 * `GET /sessions/:id` endpoint when the caller doesn't want the full
 * evaluations payload. Returns null if the session doesn't exist or the
 * manifest is malformed.
 */
export function readSessionMetadata(
  sessionId: string,
  rootDir: string = DEFAULT_DATA_DIR,
): { manifest: SessionManifest; summary: SessionSummary | null; evaluationCount: number } | null {
  const sessionDir = join(rootDir, 'sessions', sessionId);
  const manifestPath = join(sessionDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  let manifest: SessionManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SessionManifest;
  } catch {
    return null;
  }
  const summaryPath = join(sessionDir, 'summary.json');
  let summary: SessionSummary | null = null;
  if (existsSync(summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf-8')) as SessionSummary;
    } catch {
      summary = null;
    }
  }
  const evaluationsPath = join(sessionDir, 'evaluations.jsonl');
  const evaluationCount = existsSync(evaluationsPath)
    ? countJsonlLines(evaluationsPath)
    : 0;
  return { manifest, summary, evaluationCount };
}

/**
 * Count well-formed JSONL lines without parsing them. A trailing
 * incomplete line (no terminating newline) is excluded from the count
 * — matches what `wc -l` reports and matches the convention every
 * append uses (each record is followed by a newline).
 */
function countJsonlLines(path: string): number {
  // Newline-only count is fine for our purposes, but do not turn large
  // JSONL corpora into JS strings just to count line breaks. The Mining
  // UI polls `/sessions`; string-loading every historical session can
  // pin the dispatcher and make the browser think it disconnected.
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let count = 0;
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 10 /* \n */) count += 1;
      }
    }
  } finally {
    closeSync(fd);
  }
  return count;
}
