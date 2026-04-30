/**
 * Tests for the policy ranker — single source of truth for "which
 * policy is THE recommendation." See MINER_REFACTOR_WORKPLAN step 4.
 */

import { describe, it, expect } from 'vitest';
import {
  rankPolicies,
  bestPolicy,
  explainRanking,
  LEGACY_FIRST_LEXICOGRAPHIC,
  type RankingRule,
} from './policy-ranker';
import type { PolicyEvaluation } from './policy-miner-types';

function ev(opts: {
  id: string;
  spend: number;
  solvent: number;
  legacy: number;
  p50: number;
}): PolicyEvaluation {
  return {
    id: opts.id,
    evaluatedByNodeId: 'test',
    baselineFingerprint: 'fp',
    engineVersion: 'v',
    evaluatedAtIso: new Date().toISOString(),
    policy: {
      annualSpendTodayDollars: opts.spend,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 0,
    },
    outcome: {
      solventSuccessRate: opts.solvent,
      bequestAttainmentRate: opts.legacy,
      p10EndingWealthTodayDollars: 0,
      p25EndingWealthTodayDollars: 0,
      p50EndingWealthTodayDollars: opts.p50,
      p75EndingWealthTodayDollars: 0,
      p90EndingWealthTodayDollars: 0,
      medianLifetimeSpendTodayDollars: 0,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 0,
      irmaaTrialFraction: 0,
      irmaaTier3PlusTrialFraction: 0,
      medianMaxIrmaaTier: 0,
      medianYearsAboveIrmaaThreshold: 0,
      medianRothConversionsTodayDollars: 0,
      medianRothConversionsYearCount: 0,
      acaSubsidyTrialFraction: 0,
    },
  } as PolicyEvaluation;
}

describe('policy ranker (workplan step 4)', () => {
  describe('bestPolicy', () => {
    it('returns null on empty corpus', () => {
      expect(bestPolicy([])).toBeNull();
    });

    it('returns null when no entry clears the legacy 85% gate', () => {
      const all = [
        ev({ id: 'a', spend: 100_000, solvent: 1.0, legacy: 0.5, p50: 1_000_000 }),
        ev({ id: 'b', spend: 90_000, solvent: 1.0, legacy: 0.84, p50: 1_500_000 }),
      ];
      expect(bestPolicy(all)).toBeNull();
    });

    it('returns null when no entry clears the solvency 70% gate', () => {
      const all = [
        ev({ id: 'a', spend: 100_000, solvent: 0.6, legacy: 0.95, p50: 1_000_000 }),
      ];
      expect(bestPolicy(all)).toBeNull();
    });

    it('picks the highest-spend candidate that clears both gates', () => {
      const all = [
        ev({ id: 'a', spend: 100_000, solvent: 1.0, legacy: 0.95, p50: 2_000_000 }),
        ev({ id: 'b', spend: 110_000, solvent: 1.0, legacy: 0.88, p50: 1_800_000 }),
        ev({ id: 'c', spend: 120_000, solvent: 1.0, legacy: 0.82, p50: 1_500_000 }), // fails legacy gate
      ];
      const best = bestPolicy(all);
      expect(best?.id).toBe('b'); // 110k clears both gates and beats 100k on spend
    });

    it('breaks spend ties on solvency desc', () => {
      const all = [
        ev({ id: 'a', spend: 110_000, solvent: 0.95, legacy: 0.88, p50: 1_500_000 }),
        ev({ id: 'b', spend: 110_000, solvent: 1.0, legacy: 0.86, p50: 1_400_000 }),
      ];
      expect(bestPolicy(all)?.id).toBe('b'); // higher solvency wins
    });

    it('breaks spend + solvency ties on legacy attainment desc', () => {
      const all = [
        ev({ id: 'a', spend: 110_000, solvent: 1.0, legacy: 0.86, p50: 1_500_000 }),
        ev({ id: 'b', spend: 110_000, solvent: 1.0, legacy: 0.88, p50: 1_400_000 }),
      ];
      expect(bestPolicy(all)?.id).toBe('b');
    });

    it('breaks all-equal-metric ties stably on id', () => {
      const all = [
        ev({ id: 'b', spend: 110_000, solvent: 1.0, legacy: 0.88, p50: 1_500_000 }),
        ev({ id: 'a', spend: 110_000, solvent: 1.0, legacy: 0.88, p50: 1_500_000 }),
      ];
      // localeCompare is ascending — 'a' < 'b' returns -1 → 'a' is "less than" 'b'
      // → 'a' is "earlier" → 'a' wins as best
      expect(bestPolicy(all)?.id).toBe('a');
    });
  });

  describe('rankPolicies', () => {
    it('filters infeasible records and sorts feasible best-first', () => {
      const all = [
        ev({ id: 'low', spend: 90_000, solvent: 1.0, legacy: 0.99, p50: 2_500_000 }),
        ev({ id: 'mid', spend: 100_000, solvent: 1.0, legacy: 0.95, p50: 2_000_000 }),
        ev({ id: 'high', spend: 110_000, solvent: 1.0, legacy: 0.88, p50: 1_800_000 }),
        ev({ id: 'fail', spend: 130_000, solvent: 1.0, legacy: 0.5, p50: 1_500_000 }),
      ];
      const ranked = rankPolicies(all);
      expect(ranked.map((e) => e.id)).toEqual(['high', 'mid', 'low']);
    });
  });

  describe('explainRanking', () => {
    it('explains why a feasible record clears all gates', () => {
      const e = ev({
        id: 'a',
        spend: 110_000,
        solvent: 1.0,
        legacy: 0.88,
        p50: 1_500_000,
      });
      const result = explainRanking(e);
      expect(result.passes).toBe(true);
      expect(result.reason).toContain('Clears all');
      expect(result.reason).toContain('spend desc');
    });

    it('explains which gate an infeasible record fails', () => {
      const e = ev({
        id: 'a',
        spend: 110_000,
        solvent: 1.0,
        legacy: 0.5,
        p50: 1_500_000,
      });
      const result = explainRanking(e);
      expect(result.passes).toBe(false);
      expect(result.reason).toContain('legacy attainment');
      expect(result.reason).toContain('50');
      expect(result.reason).toContain('85');
    });
  });

  describe('rule pluggability', () => {
    it('a custom solvency-first rule produces a different winner', () => {
      const all = [
        ev({ id: 'high-spend', spend: 110_000, solvent: 0.92, legacy: 0.88, p50: 1_500_000 }),
        ev({ id: 'safe', spend: 95_000, solvent: 1.0, legacy: 0.99, p50: 1_700_000 }),
      ];
      // Default (legacy-first, max spend): 110k wins.
      expect(bestPolicy(all, LEGACY_FIRST_LEXICOGRAPHIC)?.id).toBe('high-spend');
      // Solvency-first variant: max solvency among feasible.
      const solvencyFirst: RankingRule = {
        ...LEGACY_FIRST_LEXICOGRAPHIC,
        name: 'solvency_first_lex',
        tiebreakers: [
          { label: 'solvency desc', direction: 'desc', metric: (e) => e.outcome.solventSuccessRate },
          { label: 'spend desc', direction: 'desc', metric: (e) => e.policy.annualSpendTodayDollars },
        ],
      };
      expect(bestPolicy(all, solvencyFirst)?.id).toBe('safe');
    });
  });
});
