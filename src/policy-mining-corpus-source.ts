/**
 * Unified corpus loader for the pass-2 analyzer cards.
 *
 * Background: there are two corpora:
 *   - **Local** — IndexedDB on the browser, written by the in-process
 *     12-worker pool when mining runs in this tab.
 *   - **Cluster** — disk files on the dispatcher, read over the
 *     dispatcher's HTTP API. Cluster mines never mirror to the local
 *     IDB by design (see `policy-mining-cluster.ts` header).
 *
 * The results table picks between sources via a UI toggle. The cards
 * (cliff refinement, rule sweep) don't have UI — they just need
 * "whichever corpus has records for this baseline." This helper
 * implements that policy: try cluster first when a dispatcher URL is
 * available, fall back to local IDB. Cluster-first because the cards
 * are typically used in cluster-driven workflows where the local IDB
 * is empty.
 *
 * Returns an empty array (not an error) when neither source has
 * records — the cards interpret zero results as "no recommendation"
 * and render null.
 */

import { loadEvaluationsForBaseline } from './policy-mining-corpus';
import {
  loadClusterEvaluations,
  loadClusterSessions,
} from './policy-mining-cluster';
import type { PolicyEvaluation } from './policy-miner-types';

export async function loadCorpusEvaluations(
  baselineFingerprint: string,
  engineVersion: string,
  dispatcherUrl: string | null,
): Promise<PolicyEvaluation[]> {
  // Try cluster first when a URL is available. The dispatcher's session
  // list is the source of truth for cluster mines; we pick the freshest
  // session matching this baseline + engine version.
  if (dispatcherUrl) {
    try {
      const sessions = await loadClusterSessions(dispatcherUrl);
      // Sessions are sorted most-recent-first by the server. Find the
      // first one matching baseline + engine version.
      const match = sessions.find(
        (s) =>
          s.manifest?.config?.baselineFingerprint === baselineFingerprint &&
          s.manifest?.config?.engineVersion === engineVersion,
      );
      if (match) {
        const payload = await loadClusterEvaluations(
          dispatcherUrl,
          match.sessionId,
        );
        return payload.evaluations;
      }
    } catch {
      // Cluster unreachable / 404 / network glitch — fall through to
      // local. Don't surface the error; the cards' empty-state handling
      // already covers "no records found."
    }
  }
  // Local IDB fallback (covers the in-process-pool workflow and the
  // cluster-unreachable case).
  return loadEvaluationsForBaseline(baselineFingerprint, engineVersion);
}
