/**
 * V2 axis configuration regression test (MINER_REFACTOR_WORKPLAN
 * step 13's e2e check, narrowed to what we can verify without a
 * fresh cluster mine).
 *
 * Asserts the V2 axis grid produces the expected candidate count
 * (49,368) and that withdrawalRule + 6-month SS resolution are wired
 * end-to-end (Policy.withdrawalRule populated, fractional ages emitted).
 */

import { describe, it, expect } from 'vitest';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
  countPolicyCandidates,
  policyId,
} from './policy-axis-enumerator';
import type { SeedData } from './types';
import seedFixture from '../seed-data.json';

describe('policy axis V2 (workplan step 13)', () => {
  it('default coarse axes produce expected V2 candidate count: 17 × 11 × 11 × 6 × 4 = 49,368', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    expect(axes.annualSpendTodayDollars).toHaveLength(17);
    expect(axes.primarySocialSecurityClaimAge).toHaveLength(11);
    expect(axes.spouseSocialSecurityClaimAge).toHaveLength(11);
    expect(axes.rothConversionAnnualCeiling).toHaveLength(6);
    expect(axes.withdrawalRule).toHaveLength(4);
    expect(countPolicyCandidates(axes)).toBe(49_368);
  });

  it('spend axis covers $80k-$160k in $5k steps (coarse pass)', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    const expected = [];
    for (let v = 80_000; v <= 160_000; v += 5_000) expected.push(v);
    expect(axes.annualSpendTodayDollars).toEqual(expected);
  });

  it('SS axis covers 65-70 in 6-month steps', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    expect(axes.primarySocialSecurityClaimAge).toEqual([
      65, 65.5, 66, 66.5, 67, 67.5, 68, 68.5, 69, 69.5, 70,
    ]);
  });

  it('emits all four named withdrawal rules', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    expect(axes.withdrawalRule).toEqual([
      'tax_bracket_waterfall',
      'proportional',
      'reverse_waterfall',
      'guyton_klinger',
    ]);
  });

  it('every enumerated policy carries a withdrawalRule', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    const policies = enumeratePolicies(axes);
    expect(policies).toHaveLength(49_368);
    expect(policies.every((p) => p.withdrawalRule != null)).toBe(true);
  });

  it('policy id includes withdrawalRule — same (spend, SS, Roth) but different rule produce different ids', () => {
    const base = {
      annualSpendTodayDollars: 100_000,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 40_000,
    };
    const id1 = policyId(
      { ...base, withdrawalRule: 'tax_bracket_waterfall' },
      'fp',
      'eng',
    );
    const id2 = policyId(
      { ...base, withdrawalRule: 'proportional' },
      'fp',
      'eng',
    );
    expect(id1).not.toBe(id2);
  });

  it('policy id is stable for the same withdrawalRule across calls', () => {
    const policy = {
      annualSpendTodayDollars: 110_000,
      primarySocialSecurityClaimAge: 68.5,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 80_000,
      withdrawalRule: 'reverse_waterfall' as const,
    };
    expect(policyId(policy, 'fp', 'eng')).toBe(policyId(policy, 'fp', 'eng'));
  });
});
