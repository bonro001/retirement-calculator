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

import { MAX_POLICY_ATTEMPTS, WorkQueue } from '../cluster/work-queue';
import type { Policy } from './policy-miner-types';

function makePolicy(spend: number): Policy {
  return {
    annualSpendTodayDollars: spend,
    primarySocialSecurityClaimAge: 67,
    spouseSocialSecurityClaimAge: null,
    rothConversionAnnualCeiling: 0,
  };
}

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

    const r = q.requeueBatch(a!.batchId);
    expect(r).toEqual({ requeued: 2, dropped: 0 });
    expect(q.pendingCount()).toBe(2);
    expect(q.droppedCountValue()).toBe(0);
    expect(q.snapshot().droppedCount).toBe(0);
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
