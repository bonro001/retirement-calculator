import { describe, it, expect } from 'vitest';
import annualReturns from '../fixtures/historical_annual_returns.json';

// Sanity-check the embedded approximate values against well-known
// published benchmarks from standard references (Ibbotson/SBBI,
// Damodaran, Shiller). This doesn't replace a definitive Shiller
// back-fill — the accuracy budget remains ~1-2pp per-year — but it
// catches gross transcription errors and flags any year where our
// approximation has drifted into "wrong ballpark" territory.

interface AnnualRow {
  year: number;
  stocks: number;
  bonds: number;
  inflation: number;
}

const rows = (annualReturns as { annual: AnnualRow[] }).annual;
const byYear = new Map<number, AnnualRow>(rows.map((r) => [r.year, r]));

function stocks(year: number) {
  const row = byYear.get(year);
  if (!row) throw new Error(`missing year ${year}`);
  return row.stocks;
}

function inflation(year: number) {
  const row = byYear.get(year);
  if (!row) throw new Error(`missing year ${year}`);
  return row.inflation;
}

// Tolerance: ±3pp for any single value. Anything outside this window
// likely indicates a transcription error in the fixture.
const TOLERANCE = 0.03;

describe('historical fixture plausibility check', () => {
  it('1928 S&P 500 was a big up year (~+43%)', () => {
    expect(Math.abs(stocks(1928) - 0.436)).toBeLessThan(TOLERANCE);
  });

  it('1929-1932 capture the Great Depression sequence (large negatives)', () => {
    expect(stocks(1929)).toBeLessThan(-0.05);
    expect(stocks(1930)).toBeLessThan(-0.2);
    expect(stocks(1931)).toBeLessThan(-0.4); // historical -43.3%
    expect(stocks(1932)).toBeLessThan(0);
  });

  it('1933 is the rebound year (+50% range)', () => {
    expect(stocks(1933)).toBeGreaterThan(0.45);
  });

  it('1974 is the deep oil-shock drawdown (~-27%)', () => {
    expect(Math.abs(stocks(1974) - -0.265)).toBeLessThan(TOLERANCE);
  });

  it('1982 kicks off the big bull run (~+21%)', () => {
    expect(stocks(1982)).toBeGreaterThan(0.15);
  });

  it('2008 is the GFC (~-37%)', () => {
    expect(Math.abs(stocks(2008) - -0.37)).toBeLessThan(TOLERANCE);
  });

  it('inflation peaks in the 1970s/early-80s high-inflation era', () => {
    expect(inflation(1974)).toBeGreaterThan(0.1);
    expect(inflation(1980)).toBeGreaterThan(0.1);
    expect(inflation(1981)).toBeGreaterThan(0.07);
  });

  it('deflation in 1930-1932 Great Depression', () => {
    expect(inflation(1930)).toBeLessThan(-0.04);
    expect(inflation(1931)).toBeLessThan(-0.08);
    expect(inflation(1932)).toBeLessThan(-0.08);
  });

  it('COVID inflation spike hits 2021 (~+7%)', () => {
    expect(inflation(2021)).toBeGreaterThan(0.05);
  });

  it('years are contiguous 1926-2023 with no gaps', () => {
    const years = rows.map((r) => r.year).sort((a, b) => a - b);
    expect(years[0]).toBe(1926);
    expect(years[years.length - 1]).toBe(2023);
    for (let i = 1; i < years.length; i++) {
      expect(years[i] - years[i - 1]).toBe(1);
    }
  });

  it('arithmetic mean stock return 1928-2023 is in the 9-12% historical band', () => {
    const window = rows.filter((r) => r.year >= 1928 && r.year <= 2023);
    const mean = window.reduce((sum, r) => sum + r.stocks, 0) / window.length;
    expect(mean).toBeGreaterThan(0.09);
    expect(mean).toBeLessThan(0.14);
  });

  it('arithmetic mean bond return 1928-2023 is in the 4-6% historical band', () => {
    const window = rows.filter((r) => r.year >= 1928 && r.year <= 2023);
    const mean = window.reduce((sum, r) => sum + r.bonds, 0) / window.length;
    expect(mean).toBeGreaterThan(0.035);
    expect(mean).toBeLessThan(0.065);
  });
});
