/**
 * Die-With-Zero what-if simulator tests (DIE_WITH_ZERO_WORKPLAN Phase 1 MVP).
 *
 * Directional verification — we assert the sign and rough ordering of
 * effects, not pinned numeric values, so the tests remain stable across
 * engine tuning.
 *
 * Uses seedFixture + a deterministic simulationSeed and small simulationRuns
 * (200) to keep the suite fast (< 30s total).
 */

import { describe, it, expect } from 'vitest';
import { simulateGift } from './what-if-simulator';
import type { EvalContext } from './types';
import type { MarketAssumptions, ScheduledOutflow, SeedData } from '../types';
import type { Policy } from '../policy-miner-types';
import { POLICY_MINER_ENGINE_VERSION } from '../policy-miner-types';
import seedFixture from '../../seed-data.json';

// ── Shared test fixtures ──────────────────────────────────────────────────────

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
  simulationRuns: 200,
  irmaaThreshold: 212_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 25,
  guardrailCutPercent: 0.1,
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260510,
  assumptionsVersion: 'dwz-what-if-test',
};

// Representative policy — mid-range spend, FRA claim ages, no Roth conversion.
const BASE_POLICY: Policy = {
  annualSpendTodayDollars: 115_000,
  primarySocialSecurityClaimAge: 67,
  spouseSocialSecurityClaimAge: 67,
  rothConversionAnnualCeiling: 0,
};

const cloner = (data: SeedData): SeedData =>
  JSON.parse(JSON.stringify(data)) as SeedData;

const CTX: EvalContext = {
  assumptions: ASSUMPTIONS,
  baselineFingerprint: 'dwz-test-fp',
  engineVersion: POLICY_MINER_ENGINE_VERSION,
  evaluatedByNodeId: 'test',
  cloner,
  legacyTargetTodayDollars: 500_000,
};

// ── Gift factory ──────────────────────────────────────────────────────────────

function gift(
  name: string,
  year: number,
  amount: number,
  sourceAccount: ScheduledOutflow['sourceAccount'],
  recipient = 'test',
): ScheduledOutflow {
  return {
    name,
    year,
    amount,
    sourceAccount,
    recipient,
    vehicle: 'annual_exclusion_cash',
    label: `Test gift ${name}`,
    taxTreatment: 'gift_no_tax_consequence',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DwZ what-if simulator (Phase 1 MVP)', () => {
  it(
    'empty candidate outflows produce zero deltas',
    { timeout: 30_000 },
    async () => {
      const baseline = cloner(seedFixture as SeedData);
      const result = await simulateGift(baseline, BASE_POLICY, [], CTX);

      // With no candidate gifts the two runs are identical.
      expect(result.delta.medianEndingWealthTodayDollars).toBe(0);
      expect(result.delta.p25EndingWealthTodayDollars).toBe(0);
      expect(result.delta.solventSuccessRate).toBe(0);
      expect(result.delta.bequestAttainmentRate).toBe(0);
      expect(result.appliedOutflows).toHaveLength(0);
    },
  );

  it(
    '$10K cash gift reduces median terminal wealth',
    { timeout: 30_000 },
    async () => {
      const baseline = cloner(seedFixture as SeedData);
      const result = await simulateGift(
        baseline,
        BASE_POLICY,
        [gift('ethan_10k', 2028, 10_000, 'cash', 'ethan')],
        CTX,
      );

      expect(result.delta.medianEndingWealthTodayDollars).toBeLessThan(0);
      expect(result.appliedOutflows).toHaveLength(1);
    },
  );

  it(
    '$100K cash gift has a larger terminal-wealth impact than $10K',
    { timeout: 60_000 },
    async () => {
      const baseline = cloner(seedFixture as SeedData);

      const result10k = await simulateGift(
        baseline,
        BASE_POLICY,
        [gift('gift_10k', 2028, 10_000, 'cash')],
        CTX,
      );
      const result100k = await simulateGift(
        baseline,
        BASE_POLICY,
        [gift('gift_100k', 2028, 100_000, 'cash')],
        CTX,
      );

      // Larger gift → more negative delta.
      expect(result100k.delta.medianEndingWealthTodayDollars).toBeLessThan(
        result10k.delta.medianEndingWealthTodayDollars,
      );
    },
  );

  it(
    'pretax and cash outflows of equal size produce different terminal wealth outcomes',
    { timeout: 60_000 },
    async () => {
      const baseline = cloner(seedFixture as SeedData);

      const cashResult = await simulateGift(
        baseline,
        BASE_POLICY,
        [gift('gift_cash', 2028, 50_000, 'cash')],
        CTX,
      );
      const pretaxResult = await simulateGift(
        baseline,
        BASE_POLICY,
        [gift('gift_pretax', 2028, 50_000, 'pretax')],
        CTX,
      );

      // The engine must differentiate by source account — the pretax
      // withdrawal triggers an income-tax event that the cash gift doesn't.
      expect(pretaxResult.withGift.medianEndingWealthTodayDollars).not.toBe(
        cashResult.withGift.medianEndingWealthTodayDollars,
      );
      // Both should reduce terminal wealth vs baseline.
      expect(cashResult.delta.medianEndingWealthTodayDollars).toBeLessThan(0);
      expect(pretaxResult.delta.medianEndingWealthTodayDollars).toBeLessThan(0);
    },
  );

  it(
    'multiple candidate gifts in one call accumulate their impact',
    { timeout: 90_000 },
    async () => {
      const baseline = cloner(seedFixture as SeedData);

      const resultEthan = await simulateGift(
        baseline,
        BASE_POLICY,
        [gift('ethan_2027', 2027, 10_000, 'cash', 'ethan')],
        CTX,
      );
      const resultMavue = await simulateGift(
        baseline,
        BASE_POLICY,
        [gift('mavue_2027', 2027, 10_000, 'cash', 'mavue')],
        CTX,
      );
      const resultBoth = await simulateGift(
        baseline,
        BASE_POLICY,
        [
          gift('ethan_2027', 2027, 10_000, 'cash', 'ethan'),
          gift('mavue_2027', 2027, 10_000, 'cash', 'mavue'),
        ],
        CTX,
      );

      const deltaEthan = resultEthan.delta.medianEndingWealthTodayDollars;
      const deltaMavue = resultMavue.delta.medianEndingWealthTodayDollars;
      const deltaBoth = resultBoth.delta.medianEndingWealthTodayDollars;

      // Combined delta must be more negative than either individual delta.
      expect(deltaBoth).toBeLessThan(deltaEthan);
      expect(deltaBoth).toBeLessThan(deltaMavue);

      // Linearity check: combined delta should be roughly the sum of
      // individuals (within ±50% for MC noise + nonlinearity).
      const approxSum = deltaEthan + deltaMavue;
      expect(deltaBoth).toBeGreaterThan(approxSum * 1.5); // not worse than 1.5×
      expect(deltaBoth).toBeLessThan(approxSum * 0.5);   // not better than 0.5×
    },
  );

  it(
    'already-adopted outflows in baseline are preserved and the candidate adds on top',
    { timeout: 60_000 },
    async () => {
      // Seed with a "past adopted" gift already baked in.
      const pastGift = gift('past_adopted', 2027, 20_000, 'cash', 'ethan');
      const baselineWithPast = cloner(seedFixture as SeedData);
      baselineWithPast.scheduledOutflows = [pastGift];

      // Simulate an additional new gift on top.
      const newGift = gift('new_candidate', 2028, 10_000, 'cash', 'mavue');
      const result = await simulateGift(
        baselineWithPast,
        BASE_POLICY,
        [newGift],
        CTX,
      );

      // Both runs include the past gift (it's in baseline.scheduledOutflows).
      // The with-gift run adds the new gift on top.
      // So delta is the marginal cost of ONLY the new gift — should be
      // negative and smaller in magnitude than both gifts combined.
      expect(result.delta.medianEndingWealthTodayDollars).toBeLessThan(0);

      // Verify the applied outflows echo only the candidate, not the baseline.
      expect(result.appliedOutflows).toHaveLength(1);
      expect(result.appliedOutflows[0]!.name).toBe('new_candidate');

      // Sanity: baseline run (with past gift) should show lower wealth than
      // a clean-slate run (no outflows). We do this indirectly by checking
      // that the baseline.withGift still has a positive ending wealth
      // (i.e. the plan is viable despite the past gift).
      expect(result.baseline.medianEndingWealthTodayDollars).toBeGreaterThan(0);
    },
  );
});
