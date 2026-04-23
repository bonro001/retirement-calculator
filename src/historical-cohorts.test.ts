import { describe, it, expect } from 'vitest';
import annualReturns from '../fixtures/historical_annual_returns.json';
import { replayCohort, type CohortSpec } from './historical-replay';

interface AnnualRow {
  year: number;
  stocks: number;
  bonds: number;
  inflation: number;
}

const rows = (annualReturns as { annual: AnnualRow[] }).annual;
const byYear = new Map<number, AnnualRow>(rows.map((r) => [r.year, r]));

function returnsWindow(startYear: number, durationYears: number) {
  const window: CohortSpec['returnsByYear'] = {};
  for (let i = 0; i < durationYears; i++) {
    const year = startYear + i;
    const row = byYear.get(year);
    if (!row) throw new Error(`Missing historical returns for ${year}`);
    window[year] = {
      stocks: row.stocks,
      bonds: row.bonds,
      inflation: row.inflation,
    };
  }
  return window;
}

// Canonical Bengen / Trinity setup: retire age 65, $1M starting, $40k
// initial withdrawal (4% SWR), 60/40 stocks/bonds, inflate withdrawal by
// realized CPI each year, rebalance annually.

function cohortSpec(label: string, startYear: number, durationYears = 30): CohortSpec {
  return {
    label,
    startYear,
    durationYears,
    startingBalance: 1_000_000,
    initialAnnualWithdrawal: 40_000,
    allocation: { stocks: 0.6, bonds: 0.4 },
    returnsByYear: returnsWindow(startYear, durationYears),
  };
}

describe('historical cohort replay — Trinity/Bengen outcomes', () => {
  it('1966 retiree (worst-on-record 4% SWR window): survives but depletes', () => {
    // 1966 is the historically most-cited worst 30-year window for 4% SWR.
    // Reference: Bengen (1994) and Trinity (1998). The classic result is
    // that the portfolio lasts the full 30 years but finishes much lower
    // in real terms than it started. A modest-positive-real result is the
    // signature outcome — substantial cushion would indicate data errors
    // skewed too bullish, and a failure would indicate too bearish.
    const result = replayCohort(cohortSpec('1966 retiree, 60/40, 4% SWR', 1966));
    expect(result.survived).toBe(true);
    expect(result.yearsFunded).toBe(30);
    expect(result.finalRealBalance).toBeGreaterThan(0);
    expect(result.finalRealBalance).toBeLessThan(result.years[0].startBalance);
  });

  it('1982 retiree (best-on-record): ends wildly wealthier in real terms', () => {
    // The 1982 cohort caught the largest bull run in US history. Even
    // drawing 4% annually, real ending wealth is multiples of the start.
    const result = replayCohort(cohortSpec('1982 retiree, 60/40, 4% SWR', 1982));
    expect(result.survived).toBe(true);
    expect(result.yearsFunded).toBe(30);
    expect(result.finalRealBalance).toBeGreaterThan(2_500_000);
  });

  it('1929 retiree (Great Depression start): survives the 30-year window', () => {
    // 1929 start is historically a survivable window under 4% SWR — the
    // 1930s losses are deep but recovery through WWII + post-war boom
    // compensates. Verifies that our replay handles multi-year drawdowns
    // plus sustained recovery correctly.
    const result = replayCohort(cohortSpec('1929 retiree, 60/40, 4% SWR', 1929));
    expect(result.survived).toBe(true);
    expect(result.yearsFunded).toBe(30);
  });

  it('2000 retiree (dot-com bust): survives 20 years with material depletion', () => {
    // Data only goes through 2023, so this is a 24-year window (not the
    // full 30). The canonical "lost decade" followed by GFC makes this a
    // real sequence-risk stress case. Expect substantial depletion but
    // not failure over 24 years.
    const result = replayCohort(cohortSpec('2000 retiree, 60/40, 4% SWR', 2000, 24));
    expect(result.survived).toBe(true);
    expect(result.yearsFunded).toBe(24);
    expect(result.finalRealBalance).toBeLessThan(1_200_000);
  });

  it('4% SWR cohort is deterministic under fixed inputs', () => {
    // Replay twice and confirm identical outputs — basic sanity check on
    // the engine for non-random, non-stateful behavior.
    const a = replayCohort(cohortSpec('1966 deterministic check', 1966));
    const b = replayCohort(cohortSpec('1966 deterministic check', 1966));
    expect(a.finalBalance).toBe(b.finalBalance);
    expect(a.finalRealBalance).toBe(b.finalRealBalance);
  });

  it('peak-year behavior: 1982 cohort peaks late (after compounding dominates)', () => {
    const result = replayCohort(cohortSpec('1982 peak check', 1982));
    expect(result.peakYear).toBeGreaterThanOrEqual(1999);
  });

  it('peak-year behavior: 1966 cohort peaks early before drawdown dominates', () => {
    const result = replayCohort(cohortSpec('1966 peak check', 1966));
    expect(result.peakYear).toBeLessThan(1990);
  });

  it('higher allocation to stocks → better or equal outcome in 1982 (strict-dominance check)', () => {
    const baseline = replayCohort(cohortSpec('1982 60/40', 1982));
    const aggressive: CohortSpec = {
      ...cohortSpec('1982 80/20', 1982),
      allocation: { stocks: 0.8, bonds: 0.2 },
    };
    const aggressiveResult = replayCohort(aggressive);
    // 1982 was a stocks-dominant bull market — higher equity allocation
    // must end at or above the 60/40 result.
    expect(aggressiveResult.finalBalance).toBeGreaterThan(baseline.finalBalance);
  });

  it('zero withdrawal → portfolio never depletes (sanity)', () => {
    const noWithdrawal: CohortSpec = {
      ...cohortSpec('1966 zero-withdrawal sanity', 1966),
      initialAnnualWithdrawal: 0,
    };
    const result = replayCohort(noWithdrawal);
    expect(result.survived).toBe(true);
    expect(result.finalBalance).toBeGreaterThan(1_000_000);
  });
});
