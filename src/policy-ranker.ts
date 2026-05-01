/**
 * Policy ranker — single source of truth for "which policy is THE
 * recommendation for this household."
 *
 * Today the Cockpit has its own bisection optimizer (250 trials, ad-hoc
 * objective) and the Mining screen has a corpus (2000 trials,
 * spend-desc grid). They predictably disagree. This module is the
 * single ranker both screens are migrating to consume.
 *
 * The default rule (`LEGACY_FIRST_LEXICOGRAPHIC`) is locked in by the
 * MINER_REFACTOR_WORKPLAN: gate on legacy ≥ 85%, defense gate on
 * solvency ≥ 70%, then maximize spend, with solvency and P50 EW as
 * tiebreakers. Switching rules is a one-line change in one place.
 *
 * The household commits to one ranking rule when they commit to using
 * the cockpit. The mining screen still surfaces the full corpus for
 * what-if exploration; the ranker just picks the row it cites in the
 * cockpit headline.
 */

import type { PolicyEvaluation } from './policy-miner-types';

/**
 * Lexicographic ranking rule. Each entry in `gates` must be true; each
 * entry in `tiebreakers` is read in order, descending by default.
 */
export interface RankingRule {
  name: string;
  gates: Array<{
    label: string;
    minimum: number;
    metric: (e: PolicyEvaluation) => number;
  }>;
  tiebreakers: Array<{
    label: string;
    direction: 'asc' | 'desc';
    metric: (e: PolicyEvaluation) => number;
  }>;
}

/**
 * The household's locked-in rule. Legacy attainment is the binding
 * constraint at their wealth level (solvency is ~100% across every
 * candidate they'd seriously consider), so legacy-first uses the
 * binding constraint as the primary filter. Solvency 70% is the
 * defense-in-depth gate so future plan tweaks can't recommend a plan
 * that runs out of money.
 *
 * Tiebreaker order:
 *   1. spend desc — live as well as possible while keeping the gates
 *   2. solvency desc — among same-spend candidates, prefer the
 *      sturdier one
 *   3. legacy attainment desc — among ties on the above, prefer more
 *      reliable bequest
 *   4. P50 ending wealth desc — last-resort tiebreaker; bigger bequest
 *      dollars win
 */
export const LEGACY_FIRST_LEXICOGRAPHIC: RankingRule = {
  name: 'legacy_first_lexicographic',
  gates: [
    {
      label: 'legacy attainment ≥ 85%',
      minimum: 0.85,
      metric: (e) => e.outcome.bequestAttainmentRate,
    },
    {
      label: 'solvency ≥ 70%',
      minimum: 0.7,
      metric: (e) => e.outcome.solventSuccessRate,
    },
  ],
  tiebreakers: [
    {
      label: 'spend desc',
      direction: 'desc',
      metric: (e) => e.policy.annualSpendTodayDollars,
    },
    {
      label: 'solvency desc',
      direction: 'desc',
      metric: (e) => e.outcome.solventSuccessRate,
    },
    {
      label: 'legacy attainment desc',
      direction: 'desc',
      metric: (e) => e.outcome.bequestAttainmentRate,
    },
    {
      label: 'p50 EW desc',
      direction: 'desc',
      metric: (e) => e.outcome.p50EndingWealthTodayDollars,
    },
  ],
};

export function clearsGates(e: PolicyEvaluation, rule: RankingRule): boolean {
  return rule.gates.every((g) => g.metric(e) >= g.minimum);
}

export function compareByTiebreakers(
  a: PolicyEvaluation,
  b: PolicyEvaluation,
  rule: RankingRule,
): number {
  for (const t of rule.tiebreakers) {
    const av = t.metric(a);
    const bv = t.metric(b);
    if (av === bv) continue;
    return t.direction === 'desc' ? bv - av : av - bv;
  }
  // Stable tiebreak so rerunning the ranker on the same inputs returns
  // the same row when the metrics are exactly equal.
  return a.id.localeCompare(b.id);
}

/**
 * Return the corpus filtered to gate-passing entries and sorted under
 * the rule (best-first). Stable: equal-on-all-metrics rows tiebreak by id.
 */
export function rankPolicies(
  evaluations: PolicyEvaluation[],
  rule: RankingRule = LEGACY_FIRST_LEXICOGRAPHIC,
): PolicyEvaluation[] {
  return evaluations
    .filter((e) => clearsGates(e, rule))
    .sort((a, b) => compareByTiebreakers(a, b, rule));
}

/**
 * Return the single highest-ranked entry, or null if no entry clears
 * all gates. This is what the Cockpit's headline reads.
 */
export function bestPolicy(
  evaluations: PolicyEvaluation[],
  rule: RankingRule = LEGACY_FIRST_LEXICOGRAPHIC,
): PolicyEvaluation | null {
  let best: PolicyEvaluation | null = null;
  for (const e of evaluations) {
    if (!clearsGates(e, rule)) continue;
    if (!best || compareByTiebreakers(e, best, rule) < 0) {
      best = e;
    }
  }
  return best;
}

/**
 * Plain-English summary of why a given evaluation is (or isn't) the
 * top-ranked record. Used by the cockpit's "why" toggle.
 */
export function explainRanking(
  e: PolicyEvaluation,
  rule: RankingRule = LEGACY_FIRST_LEXICOGRAPHIC,
): { passes: boolean; reason: string } {
  const failed = rule.gates.find((g) => g.metric(e) < g.minimum);
  if (failed) {
    const actual = (failed.metric(e) * 100).toFixed(1);
    const required = (failed.minimum * 100).toFixed(0);
    return {
      passes: false,
      reason: `Fails the "${failed.label}" gate — ${actual}% vs ${required}% required.`,
    };
  }
  return {
    passes: true,
    reason: `Clears all ${rule.gates.length} gate(s); ranked by ${rule.tiebreakers.map((t) => t.label).join(' → ')}.`,
  };
}
