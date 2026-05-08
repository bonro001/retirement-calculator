/**
 * V2 axis configuration regression test (MINER_REFACTOR_WORKPLAN
 * step 13's e2e check, narrowed to what we can verify without a
 * fresh cluster mine).
 *
 * Asserts the V2.1 axis grid produces the expected pass-1 candidate
 * count (12,342 = 17 × 11 × 11 × 6 × 1, single-rule pass-1) and that
 * 6-month SS resolution + withdrawal-rule plumbing are wired
 * end-to-end (Policy.withdrawalRule populated, fractional ages emitted,
 * ALL_WITHDRAWAL_RULES exported for the pass-2 sweep).
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_WITHDRAWAL_RULES,
  buildDefaultPolicyAxes,
  enumeratePolicies,
  countPolicyCandidates,
  policyId,
} from './policy-axis-enumerator';
import { buildPolicyMinerRunEngineVersion } from './policy-miner-types';
import type { SeedData } from './types';
import seedFixture from '../seed-data.json';

describe('policy axis V2.1 (single-rule pass-1)', () => {
  it('default pass-1 axes produce expected candidate count: 17 × 11 × 11 × 6 × 1 = 12,342', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    expect(axes.annualSpendTodayDollars).toHaveLength(17);
    expect(axes.primarySocialSecurityClaimAge).toHaveLength(11);
    expect(axes.spouseSocialSecurityClaimAge).toHaveLength(11);
    expect(axes.rothConversionAnnualCeiling).toHaveLength(6);
    expect(axes.withdrawalRule).toHaveLength(1);
    expect(countPolicyCandidates(axes)).toBe(12_342);
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

  it('pass-1 default rule is tax_bracket_waterfall (the safe historical baseline)', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    expect(axes.withdrawalRule).toEqual(['tax_bracket_waterfall']);
  });

  it('exports the full rule list for pass-2 sweep', () => {
    expect(ALL_WITHDRAWAL_RULES).toEqual([
      'tax_bracket_waterfall',
      'proportional',
      'reverse_waterfall',
      'guyton_klinger',
    ]);
  });

  it('every enumerated pass-1 policy carries a withdrawalRule', () => {
    const axes = buildDefaultPolicyAxes(seedFixture as SeedData);
    const policies = enumeratePolicies(axes);
    expect(policies).toHaveLength(12_342);
    expect(policies.every((p) => p.withdrawalRule === 'tax_bracket_waterfall')).toBe(true);
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

  it('policy id changes when the mining exploration seed changes', () => {
    const policy = {
      annualSpendTodayDollars: 110_000,
      primarySocialSecurityClaimAge: 68.5,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 80_000,
      withdrawalRule: 'tax_bracket_waterfall' as const,
    };
    const seedOneEngine = buildPolicyMinerRunEngineVersion('eng', 111);
    const seedTwoEngine = buildPolicyMinerRunEngineVersion('eng', 222);
    expect(policyId(policy, 'fp', seedOneEngine)).not.toBe(
      policyId(policy, 'fp', seedTwoEngine),
    );
  });
});
