/**
 * Unit tests for `cluster/work-queue.ts`.
 *
 * Focus: D.5 per-policy retry counter + dead-letter behavior. We cover
 * the three paths that mattered enough to warrant the dead-letter list
 * in the first place:
 *
 *   1. A policy that nack-loops gets dropped after MAX_POLICY_ATTEMPTS,
 *      not requeued forever.
 *   2. A policy that disconnect-loops (different `requeueAllForPeer`
 *      path) drops on the same threshold.
 *   3. A policy that succeeds on its second attempt does NOT carry
 *      stale attempt counts into a future re-evaluation.
 *
 * Plus the basic "happy path" assertions to lock in the public surface
 * we just expanded (return shapes for `requeueBatch` /
 * `requeueAllForPeer`, snapshot now includes `droppedCount`).
 *
 * The work queue is pure in-memory bookkeeping with no I/O — tests are
 * synchronous and millisecond-fast.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_POLICY_ATTEMPTS,
  WorkQueue,
  maxBatchSizeForRuntime,
  recommendedBatchSize,
  reserveWorkerSlotsForBatch,
  shouldThrottleSlowHostForTail,
  targetBatchWallClockMsForRuntime,
  targetInFlightBatchesForRuntime,
} from '../cluster/work-queue';
import type { Policy } from './policy-miner-types';

function makePolicy(spend: number): Policy {
  return {
    annualSpendTodayDollars: spend,
    primarySocialSecurityClaimAge: 67,
    spouseSocialSecurityClaimAge: null,
    rothConversionAnnualCeiling: 0,
  };
}

describe('recommendedBatchSize', () => {
  it('keeps the legacy 25-policy cap by default', () => {
    expect(recommendedBatchSize('apple-silicon-perf', 10, 500, 1000)).toBe(25);
  });

  it('allows a runtime-specific cap for fast fan-out hosts', () => {
    expect(
      recommendedBatchSize('apple-silicon-perf', 50, 500, 1000, {
        maxBatchSize: 128,
      }),
    ).toBe(100);
  });

  it('still uses single-policy batches at the tail', () => {
    expect(
      recommendedBatchSize('apple-silicon-perf', 10, 8, 1000, {
        maxBatchSize: 128,
      }),
    ).toBe(1);
  });
});

describe('runtime-specific dispatch tuning helpers', () => {
  it('keeps TS hosts at shallow prefetch and Rust compact hosts deeper', () => {
    expect(targetInFlightBatchesForRuntime('ts')).toBe(2);
    expect(targetInFlightBatchesForRuntime('rust-native-compact')).toBe(4);
  });

  it('lets callers override prefetch depths for experiments', () => {
    expect(
      targetInFlightBatchesForRuntime('rust-native-compact', {
        defaultDepth: 1,
        rustCompactDepth: 6,
      }),
    ).toBe(6);
    expect(
      targetInFlightBatchesForRuntime('ts', {
        defaultDepth: 1,
        rustCompactDepth: 6,
      }),
    ).toBe(1);
  });

  it('gives Rust compact larger batches and longer wall-clock targets', () => {
    expect(
      maxBatchSizeForRuntime({
        runtime: 'rust-native-compact',
        workers: 8,
        freeSlots: 8,
      }),
    ).toBe(256);
    expect(
      maxBatchSizeForRuntime({
        runtime: 'ts',
        workers: 8,
        freeSlots: 8,
      }),
    ).toBe(25);
    expect(targetBatchWallClockMsForRuntime('rust-native-compact')).toBeGreaterThan(
      targetBatchWallClockMsForRuntime('ts'),
    );
  });

  it('splits slot reservations across the target number of in-flight batches', () => {
    expect(
      reserveWorkerSlotsForBatch({
        workers: 8,
        targetInFlightBatches: 4,
        policyCount: 256,
      }),
    ).toBe(2);
    expect(
      reserveWorkerSlotsForBatch({
        workers: 8,
        targetInFlightBatches: 4,
        policyCount: 1,
      }),
    ).toBe(1);
  });

  it('throttles dramatically slow hosts only near their tail-risk budget', () => {
    expect(
      shouldThrottleSlowHostForTail({
        peerMsPerPolicy: 120,
        fastestMsPerPolicy: 12,
        pendingPolicies: 1500,
        plannedBatchSize: 100,
        targetInFlightBatches: 4,
      }),
    ).toBe(true);
    expect(
      shouldThrottleSlowHostForTail({
        peerMsPerPolicy: 120,
        fastestMsPerPolicy: 12,
        pendingPolicies: 2000,
        plannedBatchSize: 100,
        targetInFlightBatches: 4,
      }),
    ).toBe(false);
  });

  it('keeps moderately slower hosts eligible during tail throttling', () => {
    expect(
      shouldThrottleSlowHostForTail({
        peerMsPerPolicy: 30,
        fastestMsPerPolicy: 12,
        pendingPolicies: 100,
        plannedBatchSize: 100,
        targetInFlightBatches: 4,
      }),
    ).toBe(false);
  });
});

describe('WorkQueue (D.4 baseline)', () => {
  it('hands out batches in input order and counts evaluated correctly', () => {
    const policies = [makePolicy(50_000), makePolicy(60_000), makePolicy(70_000)];
    const q = new WorkQueue('s-test', policies);

    const a = q.assignBatch('peer-1', 2);
    expect(a).not.toBeNull();
    expect(a!.policies.map((p) => p.annualSpendTodayDollars)).toEqual([50_000, 60_000]);

    const completed = q.completeBatch(a!.batchId, 1);
    expect(completed).not.toBeNull();
    expect(q.evaluatedCountValue()).toBe(2);
    expect(q.feasibleCountValue()).toBe(1);
    expect(q.droppedCountValue()).toBe(0);
  });

  it('returns {requeued, dropped} from requeueBatch on first nack', () => {
    const q = new WorkQueue('s-test', [makePolicy(50_000), makePolicy(60_000)]);
    const a = q.assignBatch('peer-1', 2);
    expect(a).not.toBeNull();
    expect(q.inFlightPolicyCount(a!.batchId)).toBe(2);

    const r = q.requeueBatch(a!.batchId);
    expect(r).toEqual({ requeued: 2, dropped: 0 });
    expect(q.pendingCount()).toBe(2);
    expect(q.droppedCountValue()).toBe(0);
    expect(q.snapshot().droppedCount).toBe(0);
    expect(q.inFlightPolicyCount(a!.batchId)).toBeNull();
  });

  it('can requeue capacity backpressure without consuming policy attempts', () => {
    const policy = makePolicy(50_000);
    const q = new WorkQueue('s-capacity', [policy]);

    for (let i = 0; i < MAX_POLICY_ATTEMPTS + 3; i += 1) {
      const a = q.assignBatch('peer-busy', 1);
      expect(a).not.toBeNull();
      expect(q.requeueBatch(a!.batchId, { countAttemptFailure: false })).toEqual({
        requeued: 1,
        dropped: 0,
      });
    }

    expect(q.pendingCount()).toBe(1);
    expect(q.droppedCountValue()).toBe(0);

    for (let attempt = 1; attempt <= MAX_POLICY_ATTEMPTS; attempt += 1) {
      const a = q.assignBatch('peer-poison', 1);
      expect(a).not.toBeNull();
      const r = q.requeueBatch(a!.batchId);
      expect(r).toEqual(
        attempt < MAX_POLICY_ATTEMPTS
          ? { requeued: 1, dropped: 0 }
          : { requeued: 0, dropped: 1 },
      );
    }
  });
});

describe('WorkQueue (D.5 retry / dead-letter)', () => {
  it('drops a policy after MAX_POLICY_ATTEMPTS nacks, never requeues again', () => {
    const policy = makePolicy(50_000);
    const q = new WorkQueue('s-poison', [policy]);

    // Loop: assign → nack → requeue, MAX_POLICY_ATTEMPTS times. Each
    // requeue should put it back in pending until the threshold is hit.
    for (let attempt = 1; attempt <= MAX_POLICY_ATTEMPTS; attempt += 1) {
      const a = q.assignBatch('peer-flaky', 1);
      expect(a, `assign should succeed on attempt ${attempt}`).not.toBeNull();
      const r = q.requeueBatch(a!.batchId);
      if (attempt < MAX_POLICY_ATTEMPTS) {
        expect(r, `attempt ${attempt} should requeue`).toEqual({
          requeued: 1,
          dropped: 0,
        });
        expect(q.pendingCount()).toBe(1);
        expect(q.droppedCountValue()).toBe(0);
      } else {
        // Final attempt: after the policy has been assigned MAX times,
        // the next requeue must drop it instead of pushing back.
        expect(r, 'final requeue should drop').toEqual({
          requeued: 0,
          dropped: 1,
        });
        expect(q.pendingCount()).toBe(0);
        expect(q.droppedCountValue()).toBe(1);
      }
    }

    // Queue is now done — nothing pending, nothing in-flight, one
    // policy on the dead-letter list.
    expect(q.isComplete()).toBe(true);
    expect(q.deadLetterList()).toHaveLength(1);
    const dropped = q.deadLetterList()[0];
    expect(dropped.policy).toBe(policy);
    expect(dropped.attempts).toBe(MAX_POLICY_ATTEMPTS);
    expect(dropped.lastPeerId).toBe('peer-flaky');
  });

  it('drops on the same threshold via disconnect-driven requeueAllForPeer', () => {
    const policy = makePolicy(50_000);
    const q = new WorkQueue('s-disconnect', [policy]);

    for (let attempt = 1; attempt <= MAX_POLICY_ATTEMPTS; attempt += 1) {
      const a = q.assignBatch(`peer-${attempt}`, 1);
      expect(a, `assign on attempt ${attempt}`).not.toBeNull();
      const r = q.requeueAllForPeer(`peer-${attempt}`);
      if (attempt < MAX_POLICY_ATTEMPTS) {
        expect(r).toEqual({ requeued: 1, dropped: 0 });
      } else {
        expect(r).toEqual({ requeued: 0, dropped: 1 });
      }
    }
    expect(q.isComplete()).toBe(true);
    expect(q.deadLetterList()).toHaveLength(1);
    expect(q.deadLetterList()[0].lastPeerId).toBe(`peer-${MAX_POLICY_ATTEMPTS}`);
  });

  it('separates good policies from poisoned ones in the same session', () => {
    // Mix: one well-behaved policy at the head, one poisoned policy in
    // the middle, one well-behaved at the tail. Confirms that a single
    // poisoned policy doesn't block earlier or later good ones, and
    // that completed policies' attempt counts don't contaminate the
    // poisoned policy's eventual drop decision.
    const goodA = makePolicy(50_000);
    const poisoned = makePolicy(60_000);
    const goodB = makePolicy(70_000);
    const q = new WorkQueue('s-mixed', [goodA, poisoned, goodB]);

    // Serve goodA first; complete cleanly.
    const a1 = q.assignBatch('peer-1', 1);
    expect(a1!.policies).toEqual([goodA]);
    expect(q.completeBatch(a1!.batchId, 0)).not.toBeNull();

    // Serve the poisoned one and nack-loop it. requeueBatch puts it
    // back at the FRONT, so each subsequent size-1 assign re-pulls
    // it; goodB stays at the tail untouched.
    for (let attempt = 1; attempt <= MAX_POLICY_ATTEMPTS; attempt += 1) {
      const a = q.assignBatch('peer-poison', 1);
      expect(a!.policies, `attempt ${attempt} should re-pull poisoned`).toEqual([poisoned]);
      const r = q.requeueBatch(a!.batchId);
      if (attempt < MAX_POLICY_ATTEMPTS) {
        expect(r).toEqual({ requeued: 1, dropped: 0 });
      } else {
        expect(r).toEqual({ requeued: 0, dropped: 1 });
      }
    }
    expect(q.droppedCountValue()).toBe(1);
    expect(q.deadLetterList()[0].policy).toBe(poisoned);

    // goodB is still pending — the drop didn't take it with it.
    expect(q.pendingCount()).toBe(1);
    const a3 = q.assignBatch('peer-2', 1);
    expect(a3!.policies).toEqual([goodB]);
    expect(q.completeBatch(a3!.batchId, 0)).not.toBeNull();

    // Final accounting: 2 evaluated + 1 dropped == 3 total.
    expect(q.isComplete()).toBe(true);
    expect(q.evaluatedCountValue()).toBe(2);
    const snap = q.snapshot();
    expect(
      snap.pendingCount + snap.inFlightCount + snap.evaluatedCount + snap.droppedCount,
    ).toBe(snap.totalPolicies);
  });

  it('priorEvaluatedCount keeps the math honest across a resume', () => {
    // Simulates a D.5 resume: 100 policies originally; the previous run
    // crashed after evaluating 60. The new WorkQueue is constructed
    // with the 40 remaining + priorEvaluatedCount=60. Snapshot must
    // report totalPolicies=100 and evaluatedCount=60 from the start.
    const remaining: Policy[] = [];
    for (let i = 0; i < 40; i += 1) remaining.push(makePolicy(50_000 + i));
    const q = new WorkQueue('s-resume', remaining, { priorEvaluatedCount: 60 });

    const snap0 = q.snapshot();
    expect(snap0.totalPolicies).toBe(100);
    expect(snap0.pendingCount).toBe(40);
    expect(snap0.evaluatedCount).toBe(60);
    expect(snap0.inFlightCount).toBe(0);
    expect(snap0.droppedCount).toBe(0);

    // Drain a batch and confirm the count moves only by the size of
    // the batch — prior count is sticky.
    const a = q.assignBatch('peer-resume', 5);
    expect(a!.policies).toHaveLength(5);
    expect(q.completeBatch(a!.batchId, 2)).not.toBeNull();
    expect(q.evaluatedCountValue()).toBe(65);
    expect(q.feasibleCountValue()).toBe(2);
    // Invariant preserved.
    const snap1 = q.snapshot();
    expect(
      snap1.pendingCount + snap1.inFlightCount + snap1.evaluatedCount + snap1.droppedCount,
    ).toBe(snap1.totalPolicies);
  });

  it('a fully-evaluated resume completes immediately', () => {
    // Edge case: dispatcher crashed AFTER the last batch landed but
    // BEFORE summary.json was written. On resume, every enumerated
    // policy is in evaluatedIds so remainingPolicies is empty. The
    // queue must report isComplete=true so the dispatcher's first
    // pumpDispatch closes the session out cleanly.
    const q = new WorkQueue('s-fully-evaluated', [], { priorEvaluatedCount: 100 });
    expect(q.isComplete()).toBe(true);
    expect(q.snapshot().totalPolicies).toBe(100);
    expect(q.snapshot().evaluatedCount).toBe(100);
    expect(q.snapshot().pendingCount).toBe(0);
  });

  it('a policy that succeeds on retry does not carry stale attempts', () => {
    // Regression guard: completeBatch must clear the attempt counter so
    // a second-attempt success doesn't accidentally count toward a
    // future drop if the policy is somehow re-presented (it isn't in
    // V1, but the invariant is cheap to keep and easy to break).
    const policy = makePolicy(50_000);
    const q = new WorkQueue('s-retry-success', [policy]);

    // Attempt 1: assign + nack.
    const first = q.assignBatch('peer-1', 1);
    expect(q.requeueBatch(first!.batchId)).toEqual({
      requeued: 1,
      dropped: 0,
    });

    // Attempt 2: assign + complete.
    const second = q.assignBatch('peer-1', 1);
    expect(q.completeBatch(second!.batchId, 0)).not.toBeNull();
    expect(q.evaluatedCountValue()).toBe(1);
    expect(q.droppedCountValue()).toBe(0);
    expect(q.deadLetterList()).toHaveLength(0);
  });
});
