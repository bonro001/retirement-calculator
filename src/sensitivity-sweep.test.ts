import { describe, it, expect } from 'vitest';
import {
  buildSensitivitySweepAxes,
  extractSensitivityArms,
  sensitivitySweepSize,
  formatBequestDelta,
  formatFeasibilityDelta,
} from './sensitivity-sweep';
import { initialSeedData } from './data';
import type { Policy, PolicyEvaluation } from './policy-miner-types';

/**
 * E.5 — sensitivity math. The user-facing claim is "if you bump SS one
 * year, bequest changes by $X". If the marginal extraction picks up the
 * wrong cells (e.g. averages across off-diagonal points), the displayed
 * delta is meaningless. These tests pin the slicing to a known grid.
 */

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'pol_test',
    annualSpendTodayDollars: 130_000,
    primarySocialSecurityClaimAge: 70,
    spouseSocialSecurityClaimAge: 68,
    rothConversionAnnualCeiling: 40_000,
    ...overrides,
  } as Policy;
}

function makeEval(p: Policy, bequestP50: number): PolicyEvaluation {
  return {
    id: `eval_${p.annualSpendTodayDollars}_${p.primarySocialSecurityClaimAge}_${p.spouseSocialSecurityClaimAge}_${p.rothConversionAnnualCeiling}`,
    policy: p,
    baselineFingerprint: 'bf_test',
    engineVersion: 'test-v1',
    evaluatedAtIso: '2026-04-26T00:00:00Z',
    evaluatedByNodeId: 'test',
    trialCount: 2000,
    outcome: {
      bequestAttainmentRate: 0.85,
      p10EndingWealthTodayDollars: bequestP50 * 0.4,
      p50EndingWealthTodayDollars: bequestP50,
      p90EndingWealthTodayDollars: bequestP50 * 1.6,
      legacyTargetTodayDollars: 1_000_000,
    },
  } as PolicyEvaluation;
}

describe('buildSensitivitySweepAxes', () => {
  it('produces a tight 3-wide window centered on the adopted spend', () => {
    const adopted = makePolicy({ annualSpendTodayDollars: 130_000 });
    const axes = buildSensitivitySweepAxes(adopted, initialSeedData);
    // Default spend grid has $5k steps in the sweet spot — so window
    // around $130k should be {$125k, $130k, $135k}.
    expect(axes.annualSpendTodayDollars).toContain(130_000);
    expect(axes.annualSpendTodayDollars.length).toBeGreaterThanOrEqual(2);
    expect(axes.annualSpendTodayDollars.length).toBeLessThanOrEqual(3);
  });

  it('clamps the SS age window at the upper edge (70)', () => {
    const adopted = makePolicy({ primarySocialSecurityClaimAge: 70 });
    const axes = buildSensitivitySweepAxes(adopted, initialSeedData);
    // Window should be {69, 70} — no 71, 72, since SS caps at 70.
    expect(axes.primarySocialSecurityClaimAge).toContain(70);
    expect(axes.primarySocialSecurityClaimAge).not.toContain(71);
    expect(axes.primarySocialSecurityClaimAge.length).toBeLessThanOrEqual(2);
  });

  it('drops spouse axis when household has no spouse SS record', () => {
    const seedNoSpouse = {
      ...initialSeedData,
      income: {
        ...initialSeedData.income,
        socialSecurity: initialSeedData.income.socialSecurity?.slice(0, 1) ?? [],
      },
    };
    const adopted = makePolicy({ spouseSocialSecurityClaimAge: null as unknown as number });
    const axes = buildSensitivitySweepAxes(adopted, seedNoSpouse);
    expect(axes.spouseSocialSecurityClaimAge).toBeNull();
  });

  it('keeps cartesian size in the interactive band (≤ 81)', () => {
    const adopted = makePolicy();
    const axes = buildSensitivitySweepAxes(adopted, initialSeedData);
    expect(sensitivitySweepSize(axes)).toBeLessThanOrEqual(81);
  });
});

describe('extractSensitivityArms', () => {
  it('returns null until the adopted-cell evaluation is present', () => {
    const adopted = makePolicy();
    const axes = buildSensitivitySweepAxes(adopted, initialSeedData);
    // No evaluations at all → no anchor → null.
    expect(extractSensitivityArms([], adopted, axes)).toBeNull();
  });

  it('extracts the spend marginal arm holding other axes at adopted', () => {
    const adopted = makePolicy({
      annualSpendTodayDollars: 130_000,
      primarySocialSecurityClaimAge: 70,
      spouseSocialSecurityClaimAge: 68,
      rothConversionAnnualCeiling: 40_000,
    });
    const axes = buildSensitivitySweepAxes(adopted, initialSeedData);
    // Build evaluations for the spend marginal: 3 spends × 1 each on
    // other axes. Each spend gets a distinct bequest so we can verify
    // the slicing picks up the right cells.
    const spends = axes.annualSpendTodayDollars;
    const evals = spends.map((s, i) =>
      makeEval(makePolicy({ annualSpendTodayDollars: s }), 1_000_000 + i * 100_000),
    );
    const result = extractSensitivityArms(evals, adopted, axes);
    expect(result).not.toBeNull();
    const spendArm = result!.arms.find((a) => a.axis === 'annualSpendTodayDollars');
    expect(spendArm).toBeDefined();
    expect(spendArm!.points.length).toBe(spends.length);
    // Adopted point flagged correctly.
    expect(spendArm!.points[spendArm!.adoptedIndex].axisValue).toBe(130_000);
    expect(spendArm!.points[spendArm!.adoptedIndex].isAdopted).toBe(true);
    // Points are sorted ascending by axis value.
    for (let i = 1; i < spendArm!.points.length; i += 1) {
      expect(spendArm!.points[i].axisValue).toBeGreaterThan(
        spendArm!.points[i - 1].axisValue,
      );
    }
  });

  it('ignores corpus records outside the sweep grid', () => {
    const adopted = makePolicy();
    const axes = buildSensitivitySweepAxes(adopted, initialSeedData);
    // One in-grid eval (the anchor), one wildly out-of-grid eval that
    // should be filtered out by the grid-membership check.
    const anchor = makeEval(makePolicy(), 1_500_000);
    const offGrid = makeEval(
      makePolicy({ annualSpendTodayDollars: 999_999 }),
      9_999_999,
    );
    const result = extractSensitivityArms([anchor, offGrid], adopted, axes);
    expect(result).not.toBeNull();
    // Spend arm should only contain the anchor point — off-grid filtered.
    const spendArm = result!.arms.find((a) => a.axis === 'annualSpendTodayDollars');
    expect(
      spendArm!.points.every((p) => p.axisValue !== 999_999),
    ).toBe(true);
  });
});

describe('display formatters', () => {
  it('formatBequestDelta uses a minus sign for negatives', () => {
    expect(formatBequestDelta(-150_000)).toMatch(/^[−-]\$/);
    expect(formatBequestDelta(150_000)).toMatch(/^\+\$/);
    expect(formatBequestDelta(0)).toBe('$0');
  });

  it('formatFeasibilityDelta uses pp units and rounds tiny moves to ≈0', () => {
    expect(formatFeasibilityDelta(0.001)).toBe('≈0');
    expect(formatFeasibilityDelta(0.05)).toBe('+5pp');
    expect(formatFeasibilityDelta(-0.12)).toMatch(/^[−-]12pp$/);
  });
});
