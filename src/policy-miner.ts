import type { MarketAssumptions, SeedData } from './types';
import {
  policyId,
  countPolicyCandidates,
} from './policy-axis-enumerator';
import {
  loadEvaluationsForBaseline,
  saveEvaluationsBatch,
  saveMiningStats,
} from './policy-mining-corpus';
import {
  primeMinerSession,
  runPolicyBatch,
  unprimeMinerSession,
  cancelMinerSession,
  getMinerPoolSize,
} from './policy-miner-pool';
import type {
  MiningStats,
  Policy,
  PolicyEvaluation,
  PolicyMiningSessionConfig,
} from './policy-miner-types';
// The pure eval helpers live in `policy-miner-eval.ts` so the Node-side
// host worker can import them without dragging in IndexedDB or Web
// Worker globals. We import here for in-file use and re-export at the
// bottom so existing import sites (`policy-miner.worker.ts`,
// `policy-miner.throughput.test.ts`, `PolicyMiningStatusCard.tsx`)
// keep working unchanged.
import { evaluatePolicy, type SeedDataCloner } from './policy-miner-eval';

/**
 * V1 ranking comparator: among feasibility-passing candidates, prefer
 * highest annual spend; break ties by highest p50 today-dollar bequest.
 *
 * Single source of truth so the in-flight miner and the corpus-reader
 * UI can never drift. If V2 changes the rank function (e.g. add tax /
 * smoothness terms), this is the only knob to turn.
 */
export function isBetterFeasibleCandidate(
  candidate: PolicyEvaluation,
  incumbent: PolicyEvaluation | null,
): boolean {
  if (!incumbent) return true;
  const candSpend = candidate.policy.annualSpendTodayDollars;
  const incSpend = incumbent.policy.annualSpendTodayDollars;
  if (candSpend !== incSpend) return candSpend > incSpend;
  return (
    candidate.outcome.p50EndingWealthTodayDollars >
    incumbent.outcome.p50EndingWealthTodayDollars
  );
}

/**
 * Policy Miner — single-host implementation.
 *
 * What this does: take a SeedData baseline and a candidate policy list,
 * run the full Monte Carlo engine on each policy (bypassing the
 * spend-solver because the policy already pins annual spend), extract
 * the metrics the ranking layer needs, persist to the corpus, emit live
 * progress.
 *
 * What this does NOT do (yet):
 *   - Phase B: fan out across a worker pool. This V1 runs serially on
 *     the calling thread. Acceptable for an idle background panel; the
 *     UI panel checks a "pause" flag between policies so it never blocks
 *     interactive work for more than one policy duration (~3-5s).
 *   - Phase D: distribute across Mac minis. The MiningJobBatch /
 *     MiningJobResult shapes already exist for that day; the dispatcher
 *     interface goes here when we add it.
 *
 * Why bypass the solver: the solver inverts annual spend to hit a
 * success target. The miner does the opposite — it varies annual spend
 * (and other axes) and OBSERVES the success outcomes. Running both
 * would mean the solver re-derives spend on every policy, defeating the
 * purpose. Passing `annualSpendTarget` to `buildPathResults` skips the
 * solve and runs the engine with that pinned spend.
 */

// `applyPolicyToSeed`, `evaluatePolicy`, and `SeedDataCloner` are
// defined in `policy-miner-eval.ts` and re-exported at the bottom of
// this file.

/**
 * Streaming control surface returned by `runMiningSession`. The UI panel
 * uses this to pause / resume / cancel without holding a reference to
 * internal mutable state.
 */
export interface MiningSessionHandle {
  /** Whether the session is still actively evaluating. */
  isRunning: () => boolean;
  /** Soft pause — finish current policy, then idle. */
  pause: () => void;
  /** Resume a paused session. */
  resume: () => void;
  /** Hard cancel — stops at end of current policy and rejects the result promise. */
  cancel: () => void;
  /** The promise that resolves when the session finishes (or rejects on cancel). */
  donePromise: Promise<void>;
  /** Read the latest stats snapshot at any time. */
  readStats: () => MiningStats;
}

/**
 * Run a full mining session. Iterates serially through the policy list,
 * persists each result to the corpus, and emits stats updates via
 * `onStats`. Designed to be called from a Web Worker so the main thread
 * stays responsive — but it doesn't ASSUME a worker context, so a test
 * rig can call it directly.
 */
export function runMiningSession(args: {
  config: PolicyMiningSessionConfig;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  policies: Policy[];
  cloner: SeedDataCloner;
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
  /** Notified after every policy completes. Synchronous, must be cheap. */
  onStats?: (stats: MiningStats) => void;
  /** Notified after every batch flush. Lets the UI re-rank lazily. */
  onBatchPersisted?: (batch: PolicyEvaluation[]) => void;
  /** Number of evaluations to buffer before writing to IndexedDB. */
  batchSize?: number;
}): MiningSessionHandle {
  const {
    config,
    baseline,
    assumptions,
    policies,
    cloner,
    evaluatedByNodeId,
    legacyTargetTodayDollars,
    onStats,
    onBatchPersisted,
    batchSize = 8,
  } = args;

  const totalPolicies = Math.min(
    policies.length,
    config.maxPoliciesPerSession,
  );
  const stats: MiningStats = {
    sessionStartedAtIso: new Date().toISOString(),
    totalPolicies,
    policiesEvaluated: 0,
    feasiblePolicies: 0,
    meanMsPerPolicy: 0,
    p95MsPerPolicy: 0,
    estimatedRemainingMs: 0,
    bestPolicyId: null,
    state: 'idle',
  };

  // Sanity: catch enumerator-vs-policies-arg mismatches in tests early.
  void countPolicyCandidates;

  let pauseRequested = false;
  let cancelRequested = false;
  let resumeNow: (() => void) | null = null;

  const handle: MiningSessionHandle = {
    isRunning: () => stats.state === 'running',
    pause: () => {
      pauseRequested = true;
    },
    resume: () => {
      pauseRequested = false;
      if (resumeNow) {
        resumeNow();
        resumeNow = null;
      }
    },
    cancel: () => {
      cancelRequested = true;
      if (resumeNow) {
        resumeNow();
        resumeNow = null;
      }
    },
    donePromise: Promise.resolve(),
    readStats: () => ({ ...stats }),
  };

  const recentDurations: number[] = [];
  let bestFeasibleEval: PolicyEvaluation | null = null;
  const flushBuffer: PolicyEvaluation[] = [];

  const flushBatch = async () => {
    if (flushBuffer.length === 0) return;
    const batch = flushBuffer.splice(0, flushBuffer.length);
    await saveEvaluationsBatch(batch);
    onBatchPersisted?.(batch);
  };

  handle.donePromise = (async () => {
    stats.state = 'running';
    onStats?.({ ...stats });
    try {
      for (let i = 0; i < totalPolicies; i += 1) {
        if (cancelRequested) {
          stats.state = 'cancelled';
          break;
        }
        if (pauseRequested) {
          stats.state = 'paused';
          onStats?.({ ...stats });
          await new Promise<void>((resolve) => {
            resumeNow = resolve;
          });
          if (cancelRequested) {
            stats.state = 'cancelled';
            break;
          }
          stats.state = 'running';
          onStats?.({ ...stats });
        }

        const policy = policies[i];
        const evalStart = Date.now();
        const evaluation = await evaluatePolicy(
          policy,
          baseline,
          assumptions,
          config.baselineFingerprint,
          config.engineVersion,
          evaluatedByNodeId,
          cloner,
          legacyTargetTodayDollars,
        );
        const durationMs = Date.now() - evalStart;
        recentDurations.push(durationMs);
        if (recentDurations.length > 50) recentDurations.shift();

        flushBuffer.push(evaluation);
        if (flushBuffer.length >= batchSize) await flushBatch();

        stats.policiesEvaluated = i + 1;
        const meets = evaluation.outcome.bequestAttainmentRate >=
          config.feasibilityThreshold;
        if (meets) {
          stats.feasiblePolicies += 1;
          // V1 ranking: feasibility, then HIGHEST annual spend (tablestakes
          // floor is enforced upstream by the enumerator, so every feasible
          // candidate is already livable). Bequest p50 is the tiebreaker.
          // Why max spend not max bequest: max-bequest trivially picks the
          // cheapest plan because not spending leaves more behind. The
          // household's actual question is "how much can we safely spend?"
          if (isBetterFeasibleCandidate(evaluation, bestFeasibleEval)) {
            bestFeasibleEval = evaluation;
            stats.bestPolicyId = evaluation.id;
          }
        }
        const sorted = [...recentDurations].sort((a, b) => a - b);
        stats.meanMsPerPolicy =
          sorted.reduce((s, x) => s + x, 0) / sorted.length;
        stats.p95MsPerPolicy =
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
        stats.estimatedRemainingMs =
          (totalPolicies - stats.policiesEvaluated) * stats.meanMsPerPolicy;
        await saveMiningStats(config.baselineFingerprint, stats);
        onStats?.({ ...stats });
      }
      await flushBatch();
      if (stats.state === 'running') {
        stats.state = 'completed';
      }
      onStats?.({ ...stats });
    } catch (err) {
      stats.state = 'error';
      stats.lastError = err instanceof Error ? err.message : String(err);
      try {
        await saveMiningStats(config.baselineFingerprint, stats);
      } catch {
        /* persistence best-effort on error path */
      }
      onStats?.({ ...stats });
      throw err;
    }
  })();

  return handle;
}

/**
 * Pool-backed mining session — same control surface as `runMiningSession`,
 * but fans batches across the worker pool defined in `policy-miner-pool.ts`.
 *
 * Concurrency model: keep `poolSize × batchesPerWorker` batches in flight.
 * As each resolves, persist its evaluations, update stats, and dispatch
 * the next batch. This is a sliding-window dispatcher rather than a
 * fire-and-forget Promise.all so:
 *   - we get streaming `onStats` / `onBatchPersisted` callbacks
 *   - cancel/pause take effect mid-session, not only at the very end
 *   - corpus writes happen per batch (recoverable if the tab dies)
 *
 * Why batches at all: postMessage has fixed overhead per call (~1-2ms
 * with structured-clone). At ~1.9s per policy (production trial count),
 * 4-policy batches drop overhead to <0.1% while keeping cancellation
 * latency under ~8s — acceptable for an opt-in background sweep.
 *
 * Pause semantics: the dispatcher stops issuing NEW batches but lets
 * in-flight batches drain. Resume picks up where the queue left off.
 *
 * Cancel semantics: posts cancel-all to every busy worker (they finish
 * their current policy and return whatever evaluations completed). The
 * partial evaluations come back via the pool's reject path with a
 * `partial` field; we still persist those before rejecting `donePromise`.
 */
export function runMiningSessionWithPool(args: {
  config: PolicyMiningSessionConfig;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  policies: Policy[];
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
  /** Notified after every batch flush. */
  onStats?: (stats: MiningStats) => void;
  /** Notified after every batch flush. */
  onBatchPersisted?: (batch: PolicyEvaluation[]) => void;
  /** Policies per worker batch (default 4). */
  policiesPerBatch?: number;
  /** In-flight batches per worker slot (default 1 — pool stays full but not bloated). */
  batchesPerWorker?: number;
}): MiningSessionHandle {
  const {
    config,
    baseline,
    assumptions,
    policies,
    evaluatedByNodeId,
    legacyTargetTodayDollars,
    onStats,
    onBatchPersisted,
    policiesPerBatch = 4,
    batchesPerWorker = 1,
  } = args;

  const totalPolicies = Math.min(
    policies.length,
    config.maxPoliciesPerSession,
  );
  const slicedPolicies = policies.slice(0, totalPolicies);

  // Carve into batches up front. Deterministic ordering keeps progress
  // recovery simple — a future "resume after browser reload" feature can
  // diff completed corpus IDs against this list.
  const batches: Policy[][] = [];
  for (let i = 0; i < slicedPolicies.length; i += policiesPerBatch) {
    batches.push(slicedPolicies.slice(i, i + policiesPerBatch));
  }

  const stats: MiningStats = {
    sessionStartedAtIso: new Date().toISOString(),
    totalPolicies,
    policiesEvaluated: 0,
    feasiblePolicies: 0,
    meanMsPerPolicy: 0,
    p95MsPerPolicy: 0,
    estimatedRemainingMs: 0,
    bestPolicyId: null,
    state: 'idle',
  };

  let pauseRequested = false;
  let cancelRequested = false;
  let resumeNow: (() => void) | null = null;

  const handle: MiningSessionHandle = {
    isRunning: () => stats.state === 'running',
    pause: () => {
      pauseRequested = true;
    },
    resume: () => {
      pauseRequested = false;
      if (resumeNow) {
        resumeNow();
        resumeNow = null;
      }
    },
    cancel: () => {
      cancelRequested = true;
      cancelMinerSession();
      if (resumeNow) {
        resumeNow();
        resumeNow = null;
      }
    },
    donePromise: Promise.resolve(),
    readStats: () => ({ ...stats }),
  };

  const recentDurations: number[] = [];
  let bestFeasibleEval: PolicyEvaluation | null = null;

  // Sessionwide id — workers cache the primed payload by this key. Must
  // not collide across overlapping sessions (we don't currently allow
  // overlapping, but a future "preview policy" feature might).
  const sessionId = `mine-${config.baselineFingerprint}-${Date.now()}`;

  const ingestBatchResult = async (evaluations: PolicyEvaluation[]) => {
    if (evaluations.length === 0) return;
    await saveEvaluationsBatch(evaluations);
    onBatchPersisted?.(evaluations);

    for (const evaluation of evaluations) {
      recentDurations.push(evaluation.evaluationDurationMs);
      if (recentDurations.length > 50) recentDurations.shift();
      stats.policiesEvaluated += 1;

      const meets =
        evaluation.outcome.bequestAttainmentRate >=
        config.feasibilityThreshold;
      if (meets) {
        stats.feasiblePolicies += 1;
        if (isBetterFeasibleCandidate(evaluation, bestFeasibleEval)) {
          bestFeasibleEval = evaluation;
          stats.bestPolicyId = evaluation.id;
        }
      }
    }

    const sorted = [...recentDurations].sort((a, b) => a - b);
    stats.meanMsPerPolicy =
      sorted.reduce((s, x) => s + x, 0) / Math.max(1, sorted.length);
    stats.p95MsPerPolicy =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    // Wall-clock estimate must account for pool parallelism — N policies
    // in flight at once means remaining wall time is policies/N × mean.
    const poolSize = Math.max(1, getMinerPoolSize());
    const remainingPolicies = totalPolicies - stats.policiesEvaluated;
    stats.estimatedRemainingMs =
      (remainingPolicies / poolSize) * stats.meanMsPerPolicy;
    await saveMiningStats(config.baselineFingerprint, stats);
    onStats?.({ ...stats });
  };

  handle.donePromise = (async () => {
    // Resume support: skip policies already in the corpus for this baseline
    // + engine. Lets cancel-and-restart pick up where it left off, makes
    // "Start mining" idempotent across page reloads, and means an axis
    // bump (which adds new policies but leaves old IDs intact) only
    // evaluates the genuinely new candidates.
    //
    // Best-effort: any IDB hiccup falls through to a full re-run, which
    // is correct just slower.
    try {
      const existing = await loadEvaluationsForBaseline(
        config.baselineFingerprint,
        config.engineVersion,
      );
      if (existing.length > 0) {
        const existingById = new Map(existing.map((e) => [e.id, e]));
        const filtered: Policy[] = [];
        for (const policy of slicedPolicies) {
          const id = policyId(
            policy,
            config.baselineFingerprint,
            config.engineVersion,
          );
          if (!existingById.has(id)) filtered.push(policy);
        }
        const skipped = slicedPolicies.length - filtered.length;
        if (skipped > 0) {
          // Re-batch the remaining work and adjust totals so the card's
          // progress bar reflects this session's actual workload.
          batches.length = 0;
          for (let i = 0; i < filtered.length; i += policiesPerBatch) {
            batches.push(filtered.slice(i, i + policiesPerBatch));
          }
          stats.totalPolicies = filtered.length;
          // Seed best-so-far + feasibility count from the existing corpus
          // so the "Best so far" card doesn't appear empty until the
          // first new batch lands. The UI's polling re-rank from the
          // corpus would catch up eventually, but this avoids a
          // visually-empty window at session start.
          for (const ev of existing) {
            if (
              ev.outcome.bequestAttainmentRate >= config.feasibilityThreshold
            ) {
              stats.feasiblePolicies += 1;
              if (isBetterFeasibleCandidate(ev, bestFeasibleEval)) {
                bestFeasibleEval = ev;
                stats.bestPolicyId = ev.id;
              }
            }
          }
          // eslint-disable-next-line no-console
          console.info(
            `[policy-miner] resume: ${skipped} already evaluated, running ${filtered.length} new policies`,
          );
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        '[policy-miner] dedupe lookup failed, evaluating full set:',
        e,
      );
    }

    stats.state = 'running';
    onStats?.({ ...stats });

    const poolSize = Math.max(1, getMinerPoolSize());
    const concurrency = Math.max(1, poolSize * batchesPerWorker);

    primeMinerSession({
      sessionId,
      data: baseline,
      assumptions,
      baselineFingerprint: config.baselineFingerprint,
      engineVersion: config.engineVersion,
      evaluatedByNodeId,
      legacyTargetTodayDollars,
    });

    let nextBatchIndex = 0;
    let didError: Error | null = null;

    const runWorker = async (): Promise<void> => {
      while (true) {
        if (cancelRequested) return;
        if (pauseRequested) {
          stats.state = 'paused';
          onStats?.({ ...stats });
          await new Promise<void>((resolve) => {
            // Last writer wins — only one resumer is needed; pause/resume
            // is single-source from the UI panel.
            resumeNow = resolve;
          });
          if (cancelRequested) return;
          stats.state = 'running';
          onStats?.({ ...stats });
        }
        const myBatchIdx = nextBatchIndex;
        if (myBatchIdx >= batches.length) return;
        nextBatchIndex += 1;
        const batch = batches[myBatchIdx];
        try {
          const evaluations = await runPolicyBatch(sessionId, batch);
          await ingestBatchResult(evaluations);
        } catch (err) {
          // The pool decorates errors with a `partial` field carrying
          // any evaluations the worker completed before the failure.
          // Persist those before propagating so the corpus stays useful.
          const partial = (err as Error & { partial?: PolicyEvaluation[] })
            .partial;
          if (partial && partial.length > 0) {
            try {
              await ingestBatchResult(partial);
            } catch {
              /* persistence best-effort on error path */
            }
          }
          // POLICY_MINER_CANCELLED is the cancel-all signal. Don't treat
          // it as an error — the donePromise resolves via the cancelled
          // state below.
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'POLICY_MINER_CANCELLED') return;
          didError = err instanceof Error ? err : new Error(message);
          return;
        }
      }
    };

    try {
      const workers: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i += 1) {
        workers.push(runWorker());
      }
      await Promise.all(workers);

      if (didError) {
        stats.state = 'error';
        stats.lastError = didError.message;
        await saveMiningStats(config.baselineFingerprint, stats);
        onStats?.({ ...stats });
        throw didError;
      }
      if (cancelRequested) {
        stats.state = 'cancelled';
      } else if (stats.state === 'running') {
        stats.state = 'completed';
      }
      await saveMiningStats(config.baselineFingerprint, stats);
      onStats?.({ ...stats });
    } finally {
      // Always release the primed payload so workers free the SeedData
      // clone. Cheap message; safe to send even if priming failed.
      try {
        unprimeMinerSession(sessionId);
      } catch {
        /* best-effort */
      }
    }
  })();

  return handle;
}

// Re-export the pure eval helpers so existing import sites
// (`policy-miner.worker.ts`, `policy-miner.throughput.test.ts`,
// `PolicyMiningStatusCard.tsx`) keep working unchanged.
export {
  applyPolicyToSeed,
  evaluatePolicy,
  type SeedDataCloner,
} from './policy-miner-eval';
