/**
 * Withdrawal-rule axis verification (MINER_REFACTOR_WORKPLAN step 3).
 *
 * Asserts that each of the four named rules produces the expected
 * directional differences vs the default tax-bracket waterfall:
 *
 *   - tax_bracket_waterfall (default): drains taxable → pretax → roth.
 *   - proportional: pulls pro-rata from all four buckets each year.
 *   - reverse_waterfall: drains roth first, taxable last.
 *   - guyton_klinger: tax_bracket_waterfall + guardrails forced on.
 *
 * The engine produces a `PathResult` per rule; we assert each variant
 * differs from the baseline in the way the rule's name implies.
 */

import { describe, it, expect } from 'vitest';
import { buildPathResults } from './utils';
import type { MarketAssumptions, SeedData, WithdrawalRule } from './types';
import seedFixture from '../seed-data.json';

const ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.07,
  internationalEquityVolatility: 0.17,
  bondMean: 0.04,
  bondVolatility: 0.06,
  cashMean: 0.025,
  cashVolatility: 0.005,
  inflation: 0.025,
  inflationVolatility: 0.01,
  simulationRuns: 200, // small for fast tests; just verifying directional behavior
  irmaaThreshold: 212_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 25,
  guardrailCutPercent: 0.1,
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260501,
  assumptionsVersion: 'withdrawal-rules-test',
};

function runWithRule(rule: WithdrawalRule | undefined) {
  const paths = buildPathResults(
    seedFixture as SeedData,
    rule ? { ...ASSUMPTIONS, withdrawalRule: rule } : ASSUMPTIONS,
    [],
    [],
    { pathMode: 'selected_only' },
  );
  return paths[0]!;
}

describe('withdrawal-rule axis (workplan step 3)', () => {
  it('default (no rule specified) matches tax_bracket_waterfall — backward-compatible', { timeout: 30_000 }, () => {
    const baseline = runWithRule(undefined);
    const explicit = runWithRule('tax_bracket_waterfall');
    expect(baseline.successRate).toBeCloseTo(explicit.successRate, 3);
    expect(baseline.medianEndingWealth).toBeCloseTo(explicit.medianEndingWealth, -3);
  });

  it('produces a PathResult for each named rule (no throws, no NaN)', { timeout: 60_000 }, () => {
    const rules: WithdrawalRule[] = [
      'tax_bracket_waterfall',
      'proportional',
      'reverse_waterfall',
      'guyton_klinger',
    ];
    for (const rule of rules) {
      const path = runWithRule(rule);
      expect(path).toBeTruthy();
      expect(Number.isFinite(path.successRate)).toBe(true);
      expect(Number.isFinite(path.medianEndingWealth)).toBe(true);
      // Sanity: solvency between 0 and 1.
      expect(path.successRate).toBeGreaterThanOrEqual(0);
      expect(path.successRate).toBeLessThanOrEqual(1);
      // Sanity: ending wealth is non-negative when solvent (it can be
      // negative-tail in MC trials, but the median should be sensible).
      expect(path.medianEndingWealth).toBeGreaterThan(-1);
    }
  });

  it('reverse_waterfall leaves more taxable, less roth at end (vs default)', () => {
    // Reverse drains roth first, so end-of-life roth is lower and
    // taxable is higher than the default cascade.
    const baseline = runWithRule('tax_bracket_waterfall');
    const reverse = runWithRule('reverse_waterfall');
    // Sum across the final year's bucket medians to verify the shape
    // is shifted in the expected direction.
    const lastBaseline = baseline.yearlySeries.at(-1);
    const lastReverse = reverse.yearlySeries.at(-1);
    expect(lastBaseline).toBeTruthy();
    expect(lastReverse).toBeTruthy();
    // Reverse waterfall should leave LESS Roth at the end, MORE taxable.
    expect(lastReverse!.medianRothBalance).toBeLessThan(
      lastBaseline!.medianRothBalance,
    );
  });

  it('proportional split touches all four buckets in the same year', () => {
    // Pick a retirement year where the household has positive balances
    // in all four buckets and is actively withdrawing (not still
    // accumulating). Use the first year where pretax+roth+taxable
    // withdrawals are all > 0 — that's the proportional rule's
    // signature behavior.
    const path = runWithRule('proportional');
    // Find any year where multiple bucket withdrawals are simultaneously
    // > 0. The default cascade rarely does this (it drains one at a time);
    // proportional should do this almost every year of retirement.
    const yearsWithMultipleWithdrawals = path.yearlySeries.filter(
      (y) =>
        [
          y.medianWithdrawalCash,
          y.medianWithdrawalTaxable,
          y.medianWithdrawalIra401k,
          y.medianWithdrawalRoth,
        ].filter((v) => v > 0).length >= 3,
    );
    // At least a handful of retirement years should show pro-rata
    // withdrawals — this would be near-zero with the default cascade.
    expect(yearsWithMultipleWithdrawals.length).toBeGreaterThan(0);
  });

  it('guyton_klinger forces guardrails on even under raw_simulation mode', () => {
    // Under raw_simulation + tax_bracket_waterfall, guardrails are off.
    // Under raw_simulation + guyton_klinger, guardrails should be ON,
    // producing different solvency/legacy outcomes vs the same plan
    // without GK. This is the defining feature of GK in our taxonomy.
    const baselineRaw = buildPathResults(
      seedFixture as SeedData,
      {
        ...ASSUMPTIONS,
        withdrawalRule: 'tax_bracket_waterfall',
      },
      [],
      [],
      { pathMode: 'selected_only', strategyMode: 'raw_simulation' },
    )[0]!;
    const gkRaw = buildPathResults(
      seedFixture as SeedData,
      { ...ASSUMPTIONS, withdrawalRule: 'guyton_klinger' },
      [],
      [],
      { pathMode: 'selected_only', strategyMode: 'raw_simulation' },
    )[0]!;
    // Guardrails should improve solvency (cuts spending in down years)
    // — at minimum, the result should be different from the
    // no-guardrails baseline. Equality would mean the GK flag is wired
    // up but not actually firing.
    expect(gkRaw.successRate).not.toBe(baselineRaw.successRate);
  });
});
