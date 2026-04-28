import { describe, it, expect } from 'vitest';
import { partitionPolicies } from '../cluster/host';
import type { Policy } from './policy-miner-types';

/**
 * Phase 2.C in-host fan-out — partitionPolicies unit tests.
 *
 * The cluster host fans large batches across its own worker_threads
 * pool by partitioning the batch into contiguous slices, dispatching
 * each slice to a free slot, and merging results in original input
 * order. If `partitionPolicies` ever drops a policy, double-counts one,
 * or breaks input-order preservation, every fan-out batch silently
 * returns the wrong result. These tests guard the contract.
 */

function makePolicies(count: number): Policy[] {
  return Array.from({ length: count }, (_, i) => ({
    annualSpendTodayDollars: 50_000 + i * 1_000,
    primarySocialSecurityClaimAge: 67,
    spouseSocialSecurityClaimAge: 67,
    rothConversionAnnualCeiling: 0,
  }));
}

function totalPolicies(parts: Policy[][]): number {
  return parts.reduce((sum, part) => sum + part.length, 0);
}

describe('partitionPolicies (cluster host fan-out)', () => {
  it('single slot returns one partition with everything', () => {
    const policies = makePolicies(10);
    const parts = partitionPolicies(policies, 1);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(10);
  });

  it('zero or negative slot count clamps to 1', () => {
    const policies = makePolicies(5);
    expect(partitionPolicies(policies, 0)).toHaveLength(1);
    expect(partitionPolicies(policies, -3)).toHaveLength(1);
  });

  it('evenly divisible: each partition gets the same size', () => {
    const policies = makePolicies(20);
    const parts = partitionPolicies(policies, 4);
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => p.length)).toEqual([5, 5, 5, 5]);
    expect(totalPolicies(parts)).toBe(20);
  });

  it('unevenly divisible: front partitions take the extras', () => {
    // 10 policies / 3 slots → [4, 3, 3]
    const policies = makePolicies(10);
    const parts = partitionPolicies(policies, 3);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.length)).toEqual([4, 3, 3]);
    expect(totalPolicies(parts)).toBe(10);
  });

  it('more slots than policies: partition count caps at policies.length', () => {
    const policies = makePolicies(3);
    const parts = partitionPolicies(policies, 8);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.length)).toEqual([1, 1, 1]);
    expect(totalPolicies(parts)).toBe(3);
  });

  it('flatten reproduces input policy order (merge contract)', () => {
    // The fan-out merge step concatenates successful partitions in
    // order. For that to give us evaluations matching the input
    // policy order, the partition step must slice contiguously.
    const policies = makePolicies(17);
    const parts = partitionPolicies(policies, 5);
    const flat = parts.flat();
    expect(flat).toHaveLength(17);
    for (let i = 0; i < 17; i += 1) {
      expect(flat[i].annualSpendTodayDollars).toBe(50_000 + i * 1_000);
    }
  });

  it('returns a copy (caller mutation does not affect input)', () => {
    const policies = makePolicies(5);
    const parts = partitionPolicies(policies, 1);
    parts[0].push({
      annualSpendTodayDollars: 999_999,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 0,
    });
    expect(policies).toHaveLength(5); // input unchanged
  });

  it('handles the cluster realistic case: 25 policies × 8 slots', () => {
    // M4 host gets a 25-policy batch with 8 free workers. Should split
    // into 8 partitions: [4, 4, 4, 4, 3, 3, 3] — except 25/8=3 with
    // remainder 1, so [4, 3, 3, 3, 3, 3, 3, 3].
    const policies = makePolicies(25);
    const parts = partitionPolicies(policies, 8);
    expect(parts).toHaveLength(8);
    expect(parts.map((p) => p.length).reduce((s, n) => s + n, 0)).toBe(25);
    // Each partition is 3 or 4 polices — never empty, never huge.
    for (const part of parts) {
      expect(part.length).toBeGreaterThanOrEqual(3);
      expect(part.length).toBeLessThanOrEqual(4);
    }
  });
});
