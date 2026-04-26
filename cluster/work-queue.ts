/**
 * Policy Miner Cluster — Work Queue.
 *
 * Pure in-memory bookkeeping for one mining session. Tracks which policies
 * are still pending, which are out on the wire (and to whom), and which
 * have come back. No I/O — corpus writes happen in `corpus-writer.ts` and
 * WebSocket sends happen in `dispatcher.ts`.
 *
 * Why a separate module: the dispatcher's session lifecycle is the heart
 * of D.4 and is by far the easiest place to get the bookkeeping subtly
 * wrong (drop a batch on disconnect, double-count a result, leak in-flight
 * state past session end). Pulling the math out into a pure class lets us
 * unit-test it without spinning up sockets, and lets the dispatcher stay
 * focused on transport concerns.
 *
 * Lifecycle of one policy through the queue:
 *
 *     enumeratePolicies → pending(FIFO) → assignBatch → inFlight(peerId)
 *                                                            │
 *                            ┌───────────────────────────────┤
 *           batch_result?    │       batch_nack / disconnect │
 *                            ▼                               ▼
 *                       completeBatch                    requeueBatch
 *                      (count + drop)                  (back to head of pending)
 *
 * Ordering invariants:
 *  - pending is FIFO, BUT requeued batches go back at the HEAD so a
 *    flapping host doesn't permanently delay its old batches.
 *  - in-flight batches are addressable by `(peerId, batchId)` for fast
 *    O(1) lookup on result/nack — both arrive frequently enough that
 *    a linear scan would matter at fleet scale.
 *  - `evaluatedCount` only ever moves forward; if the same batch arrives
 *    twice (network blip + retry), the second arrival is silently
 *    discarded by `completeBatch` returning null.
 */

import type { Policy } from '../src/policy-miner-types';

/**
 * Coarse perf-class throughput hints. Used to size the FIRST batch to a
 * host before we have any measured data. Numbers are ms/policy at the
 * pinned 2000-trial setting, calibrated from the throughput probe (see
 * commit 92be1bf): M4 perf-cores ~500ms, Ryzen ~400ms, Apple efficiency
 * cores ~1500ms (no probe data; conservative guess).
 *
 * After 3+ completed batches, `recommendedBatchSize` switches to using
 * the host's measured `meanMsPerPolicy` and ignores these defaults.
 */
const PERF_CLASS_HINT_MS_PER_POLICY: Record<string, number> = {
  'apple-silicon-perf': 500,
  'apple-silicon-efficiency': 1500,
  'x86-modern': 400,
  'x86-legacy': 1200,
  unknown: 800,
};

/** Target wall-clock per batch. Big enough to amortize roundtrip overhead
 *  (postMessage + WS send + ack — typically <50ms total), small enough
 *  that a cancelled session loses at most a few seconds of work. */
const TARGET_BATCH_WALL_CLOCK_MS = 5_000;

/** Hard cap so a slow host with absurdly stale stats doesn't get handed
 *  100 policies in one batch. Empirically 25 is plenty even on a
 *  16-thread Ryzen at the cheap end of the trial-count range. */
const MAX_BATCH_SIZE = 25;

/**
 * How many times one policy may be assigned (and then nacked or
 * disconnected away) before the queue gives up on it and drops it to
 * the dead-letter list. Keeps a poisoned policy — one that crashes
 * every host that touches it — from thrashing the cluster forever.
 *
 * 5 is generous: a flapping host can cost a policy 1–2 attempts, and
 * a genuinely-broken evaluator should fail the same way every time, so
 * 5 distinct attempts (likely across multiple hosts) is plenty of
 * evidence to declare it bad. Tunable per-session if needed later.
 */
export const MAX_POLICY_ATTEMPTS = 5;

/**
 * Compute the right batch size for a host based on its perf class +
 * measured throughput. Pure; safe to call from anywhere.
 *
 *   batchSize = clamp(1, MAX, floor(TARGET / msPerPolicy))
 *
 * `measuredMsPerPolicy` is preferred when present; otherwise the perf-class
 * hint is used. If neither is available (genuinely unknown peer), defaults
 * to size 4 — small enough not to bottleneck a fast host, big enough not to
 * thrash on roundtrip overhead.
 */
export function recommendedBatchSize(
  perfClass: string,
  measuredMsPerPolicy: number | null,
  remainingPolicies: number,
): number {
  const msPerPolicy =
    measuredMsPerPolicy && Number.isFinite(measuredMsPerPolicy) && measuredMsPerPolicy > 0
      ? measuredMsPerPolicy
      : PERF_CLASS_HINT_MS_PER_POLICY[perfClass] ?? PERF_CLASS_HINT_MS_PER_POLICY.unknown;
  const sizeFromTime = Math.max(1, Math.floor(TARGET_BATCH_WALL_CLOCK_MS / msPerPolicy));
  // Don't hand out a batch bigger than what's actually left to do — at the
  // tail of a session, fast hosts should still get useful work even if
  // it's small.
  return Math.min(sizeFromTime, MAX_BATCH_SIZE, Math.max(1, remainingPolicies));
}

/**
 * One outstanding batch. Lives in `WorkQueue.inFlight` keyed by batchId
 * and additionally indexed by peerId so disconnect handling is O(k) in
 * the host's outstanding work, not O(N) in total in-flight.
 */
interface InFlightBatch {
  batchId: string;
  peerId: string;
  policies: Policy[];
  /** When we sent it. Used for soft-deadline tracking + telemetry. */
  assignedAtMs: number;
}

/** A policy that exceeded MAX_POLICY_ATTEMPTS. Kept in memory so the
 *  dispatcher can include the count in the cluster snapshot and (later)
 *  write a `dead-letter.jsonl` next to `evaluations.jsonl`. The queue
 *  doesn't compute the canonical policy id (that needs the baseline
 *  fingerprint, which lives on the dispatcher); it just hands back the
 *  raw Policy and lets the caller hash if it wants to. */
export interface DeadLetterRecord {
  policy: Policy;
  attempts: number;
  /** Last peer that held the batch before the final requeue triggered drop. */
  lastPeerId: string;
  droppedAtMs: number;
}

/**
 * Snapshot of queue state. Cheap to compute; called every cluster_state
 * broadcast (~1Hz). Numbers should add up: pending + inFlight + evaluated
 * + dropped = totalPolicies, always.
 */
export interface WorkQueueSnapshot {
  totalPolicies: number;
  pendingCount: number;
  inFlightCount: number;
  evaluatedCount: number;
  feasibleCount: number;
  /** Policies that exceeded MAX_POLICY_ATTEMPTS and were given up on. */
  droppedCount: number;
  /** Per-host in-flight batch counts. Empty entries are pruned. */
  inFlightByPeer: Array<{ peerId: string; batchCount: number; policyCount: number }>;
}

/**
 * Mutable session-scoped queue. One instance per active session on the
 * dispatcher. Construct with the full enumerated policy list; call
 * `assignBatch` to pull work out, `completeBatch` / `requeueBatch` to
 * close batches as results arrive.
 */
export class WorkQueue {
  readonly sessionId: string;
  readonly totalPolicies: number;

  private readonly pending: Policy[];
  private readonly inFlight: Map<string, InFlightBatch> = new Map();
  private evaluatedCount = 0;
  private feasibleCount = 0;
  /** Monotonic counter for unique batch ids within this session. */
  private nextBatchSeq = 0;
  /** Per-policy attempt counter. Incremented when a policy is moved into
   *  in-flight by `assignBatch`. Used by `requeueBatch` to decide whether
   *  to send a policy back to pending or drop it. Keyed by Policy
   *  reference identity — the queue owns these refs from constructor
   *  through completion / drop, so identity is stable. */
  private readonly attemptsByPolicy: WeakMap<Policy, number> = new WeakMap();
  /** Policies the queue has given up on. Drop reasons are coarse: the
   *  queue only sees "this batch was requeued" — it doesn't know whether
   *  the host nacked it for a real bug or just disconnected. So all we
   *  record is "this many attempts exhausted." */
  private readonly deadLetters: DeadLetterRecord[] = [];

  /**
   * @param sessionId           Stamped session identity; mirrored into batch ids.
   * @param remainingPolicies   Policies the queue should hand out. On a fresh
   *                            session this is every enumerated policy; on a
   *                            D.5 resumed session it's the enumerated set
   *                            minus those already on disk.
   * @param opts.priorEvaluatedCount
   *                            Count of policies already evaluated before
   *                            this WorkQueue was constructed (resume only).
   *                            Defaults to 0. `totalPolicies` is computed as
   *                            `remainingPolicies.length + priorEvaluatedCount`
   *                            so progress reporting and the
   *                            `pending + inFlight + evaluated + dropped`
   *                            invariant both work across the resume boundary.
   */
  constructor(
    sessionId: string,
    remainingPolicies: Policy[],
    opts: { priorEvaluatedCount?: number } = {},
  ) {
    this.sessionId = sessionId;
    // Slice-copy so the caller can't mutate the queue from under us.
    // Reverse so we can pop() from the END (cheap) while still serving
    // policies in input order.
    this.pending = [...remainingPolicies].reverse();
    const priorEvaluated = opts.priorEvaluatedCount ?? 0;
    this.totalPolicies = remainingPolicies.length + priorEvaluated;
    this.evaluatedCount = priorEvaluated;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  evaluatedCountValue(): number {
    return this.evaluatedCount;
  }

  feasibleCountValue(): number {
    return this.feasibleCount;
  }

  droppedCountValue(): number {
    return this.deadLetters.length;
  }

  /** Read-only view of the dead-letter list for snapshotting / disk
   *  serialization. Do not mutate. */
  deadLetterList(): readonly DeadLetterRecord[] {
    return this.deadLetters;
  }

  /**
   * True when there's no more work to hand out and nothing outstanding.
   * Once true, the dispatcher closes the corpus and broadcasts session
   * complete. Dropped policies are NOT in pending or in-flight — they
   * can't block completion.
   */
  isComplete(): boolean {
    return this.pending.length === 0 && this.inFlight.size === 0;
  }

  /**
   * Pop up to `size` policies for `peerId` and record an in-flight batch.
   * Returns null if pending is empty (caller should skip this host).
   *
   * `size` should come from `recommendedBatchSize` — this method does NOT
   * second-guess it, so the call site is the single source of truth for
   * sizing policy.
   */
  assignBatch(peerId: string, size: number): { batchId: string; policies: Policy[] } | null {
    if (this.pending.length === 0) return null;
    if (size < 1) return null;
    const take = Math.min(size, this.pending.length);
    const policies: Policy[] = [];
    for (let i = 0; i < take; i += 1) {
      // pop() is O(1). We reversed the array in the constructor so this
      // serves policies in original enumeration order.
      const next = this.pending.pop();
      if (!next) break;
      policies.push(next);
      // Bump attempt count BEFORE the wire send. If the host happens to
      // crash between assign and the first byte going out, we still want
      // the count to reflect "this peer was given the work" so the
      // disconnect-driven requeue increments don't miscount.
      const prev = this.attemptsByPolicy.get(next) ?? 0;
      this.attemptsByPolicy.set(next, prev + 1);
    }
    this.nextBatchSeq += 1;
    const batchId = `${this.sessionId}-b${this.nextBatchSeq}`;
    this.inFlight.set(batchId, {
      batchId,
      peerId,
      policies,
      assignedAtMs: Date.now(),
    });
    return { batchId, policies };
  }

  /**
   * Mark a batch as completed. Returns the in-flight record so the
   * dispatcher can reconcile (e.g. compute wall-clock time, update
   * peer throughput stats). Returns null if the batch is unknown — most
   * commonly a duplicate result after an ack was lost; safe to ignore.
   *
   * `feasibleInBatch` is the count of evaluations whose attainment rate
   * passed the session's threshold; aggregated into `feasibleCount` for
   * the snapshot. The caller computes it because the dispatcher already
   * has to walk the evaluations to write them to the corpus.
   */
  completeBatch(batchId: string, feasibleInBatch: number): InFlightBatch | null {
    const batch = this.inFlight.get(batchId);
    if (!batch) return null;
    this.inFlight.delete(batchId);
    this.evaluatedCount += batch.policies.length;
    this.feasibleCount += feasibleInBatch;
    // Clear attempt counters for completed policies. (WeakMap doesn't
    // strictly need this — the refs are dropped from inFlight here and
    // GC'd whenever the wire payload also lets them go — but explicit
    // delete makes the lifecycle obvious to a reader.)
    for (const policy of batch.policies) {
      this.attemptsByPolicy.delete(policy);
    }
    return batch;
  }

  /**
   * Put a batch back at the FRONT of the queue. Used for `batch_nack`
   * (host couldn't take the work) and for disconnect-driven reassignment.
   * Returning to the head — not the tail — keeps a flapping host from
   * permanently starving its abandoned batches.
   *
   * Per-policy attempt counts are checked here: any policy that has
   * already hit MAX_POLICY_ATTEMPTS is dropped to the dead-letter list
   * instead of being requeued, so a poisoned policy can't thrash the
   * cluster forever.
   *
   * Returns:
   *   - `null` if the batch is unknown (already completed, or duplicate
   *     requeue from a racing nack + disconnect) — idempotent.
   *   - `{requeued, dropped}` counts otherwise. `requeued + dropped` ==
   *     batch.policies.length.
   */
  requeueBatch(batchId: string): { requeued: number; dropped: number } | null {
    const batch = this.inFlight.get(batchId);
    if (!batch) return null;
    this.inFlight.delete(batchId);
    let requeued = 0;
    let dropped = 0;
    // Walk in reverse so the requeued tail ends up at the END of the
    // reversed-pending array == HEAD of the logical FIFO, in original
    // order. Dropped policies fall out of the queue entirely; they don't
    // need ordering.
    for (let i = batch.policies.length - 1; i >= 0; i -= 1) {
      const policy = batch.policies[i];
      const attempts = this.attemptsByPolicy.get(policy) ?? 0;
      if (attempts >= MAX_POLICY_ATTEMPTS) {
        // Give up on this policy. Don't reset attempts — the dead-letter
        // record carries the final count for diagnostics.
        this.deadLetters.push({
          policy,
          attempts,
          lastPeerId: batch.peerId,
          droppedAtMs: Date.now(),
        });
        this.attemptsByPolicy.delete(policy);
        dropped += 1;
      } else {
        this.pending.push(policy);
        requeued += 1;
      }
    }
    return { requeued, dropped };
  }

  /**
   * Requeue ALL in-flight batches for a peer. Called when the dispatcher
   * notices a peer disconnect — the work has to land somewhere. Returns
   * aggregate `{requeued, dropped}` across the peer's batches.
   */
  requeueAllForPeer(peerId: string): { requeued: number; dropped: number } {
    let requeued = 0;
    let dropped = 0;
    for (const batch of [...this.inFlight.values()]) {
      if (batch.peerId === peerId) {
        const r = this.requeueBatch(batch.batchId);
        if (r) {
          requeued += r.requeued;
          dropped += r.dropped;
        }
      }
    }
    return { requeued, dropped };
  }

  /** O(1) check used by the disconnect handler to decide whether to bother. */
  hasInFlightForPeer(peerId: string): boolean {
    for (const batch of this.inFlight.values()) {
      if (batch.peerId === peerId) return true;
    }
    return false;
  }

  /** For the cluster snapshot. O(n) over in-flight; fine at our scale. */
  snapshot(): WorkQueueSnapshot {
    const byPeer = new Map<string, { batchCount: number; policyCount: number }>();
    for (const batch of this.inFlight.values()) {
      const entry = byPeer.get(batch.peerId) ?? { batchCount: 0, policyCount: 0 };
      entry.batchCount += 1;
      entry.policyCount += batch.policies.length;
      byPeer.set(batch.peerId, entry);
    }
    return {
      totalPolicies: this.totalPolicies,
      pendingCount: this.pending.length,
      inFlightCount: this.inFlight.size,
      evaluatedCount: this.evaluatedCount,
      feasibleCount: this.feasibleCount,
      droppedCount: this.deadLetters.length,
      inFlightByPeer: [...byPeer.entries()].map(([peerId, v]) => ({
        peerId,
        batchCount: v.batchCount,
        policyCount: v.policyCount,
      })),
    };
  }
}
