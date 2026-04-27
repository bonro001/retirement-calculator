import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import {
  DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS,
  deriveAssetClassMappingAssumptionsFromAccounts,
  rollupHoldingsToAssetClasses,
} from './asset-class-mapper';
import fidelityBaseline from '../fixtures/fidelity_baseline.json';

// BACKLOG item: "Allocation check". Validate that our engine's per-bucket
// target allocations aggregate (dollar-weighted across buckets) to the
// portfolio mix that Fidelity reports. Any material drift means either:
//   - the seed-data allocations don't reflect reality, or
//   - the asset-class-mapper is missing a symbol, or
//   - the ambiguous-holding proxies (TRP_2030, CENTRAL_MANAGED) are
//     estimating poorly.

interface FidelityFixture {
  portfolio: {
    assetMixPct: {
      domesticStock: number;
      foreignStock: number;
      bonds: number;
      shortTerm: number;
      other: number;
      unknown: number;
    };
  };
}

function computeEngineAggregateMix() {
  const accounts = initialSeedData.accounts;
  const assumptions = deriveAssetClassMappingAssumptionsFromAccounts(accounts);
  const buckets: Array<{ balance: number; allocation: Record<string, number> }> = [
    { balance: accounts.pretax.balance, allocation: accounts.pretax.targetAllocation },
    { balance: accounts.roth.balance, allocation: accounts.roth.targetAllocation },
    { balance: accounts.taxable.balance, allocation: accounts.taxable.targetAllocation },
    { balance: accounts.cash.balance, allocation: accounts.cash.targetAllocation },
  ];
  if (accounts.hsa) {
    buckets.push({ balance: accounts.hsa.balance, allocation: accounts.hsa.targetAllocation });
  }
  const totalBalance = buckets.reduce((sum, b) => sum + b.balance, 0);

  const dollarWeighted = { US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 0, CASH: 0 };
  for (const bucket of buckets) {
    if (bucket.balance <= 0) continue;
    const exposure = rollupHoldingsToAssetClasses(bucket.allocation, assumptions);
    dollarWeighted.US_EQUITY += exposure.US_EQUITY * bucket.balance;
    dollarWeighted.INTL_EQUITY += exposure.INTL_EQUITY * bucket.balance;
    dollarWeighted.BONDS += exposure.BONDS * bucket.balance;
    dollarWeighted.CASH += exposure.CASH * bucket.balance;
  }

  return {
    usEquity: dollarWeighted.US_EQUITY / totalBalance,
    intlEquity: dollarWeighted.INTL_EQUITY / totalBalance,
    bonds: dollarWeighted.BONDS / totalBalance,
    cash: dollarWeighted.CASH / totalBalance,
    totalBalance,
  };
}

describe('allocation check vs Fidelity-reported asset mix', () => {
  it('engine aggregate mix is within 8pp of Fidelity per asset class', () => {
    const fixture = fidelityBaseline as unknown as FidelityFixture;
    const engine = computeEngineAggregateMix();
    const fidelity = fixture.portfolio.assetMixPct;

    // Our engine has 4 classes (US_EQUITY, INTL_EQUITY, BONDS, CASH);
    // Fidelity reports 6 (domesticStock, foreignStock, bonds, shortTerm,
    // other, unknown). Our CASH includes Fidelity's shortTerm; Fidelity's
    // "other" + "unknown" (~1.8% combined) don't have a mapping target
    // on our side and will simply reduce the absolute alignment by that
    // much. We use an 8pp tolerance to absorb both the class-boundary
    // rounding and the ~2% "other" Fidelity reports.
    const tolerance = 0.08;

    // eslint-disable-next-line no-console
    console.log('allocation check:');
    // eslint-disable-next-line no-console
    console.log(
      `  domestic stock: engine=${(engine.usEquity * 100).toFixed(1)}%  fidelity=${(fidelity.domesticStock * 100).toFixed(1)}%`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `  foreign stock:  engine=${(engine.intlEquity * 100).toFixed(1)}%  fidelity=${(fidelity.foreignStock * 100).toFixed(1)}%`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `  bonds:          engine=${(engine.bonds * 100).toFixed(1)}%  fidelity=${(fidelity.bonds * 100).toFixed(1)}%`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `  cash/short:     engine=${(engine.cash * 100).toFixed(1)}%  fidelity=${((fidelity.shortTerm + fidelity.other + fidelity.unknown) * 100).toFixed(1)}%  (engine CASH = Fidelity shortTerm + other + unknown)`,
    );

    expect(Math.abs(engine.usEquity - fidelity.domesticStock)).toBeLessThan(tolerance);
    expect(Math.abs(engine.intlEquity - fidelity.foreignStock)).toBeLessThan(tolerance);
    expect(Math.abs(engine.bonds - fidelity.bonds)).toBeLessThan(tolerance);
    // Engine CASH vs Fidelity shortTerm + other + unknown.
    const fidelityCashLike = fidelity.shortTerm + fidelity.other + fidelity.unknown;
    expect(Math.abs(engine.cash - fidelityCashLike)).toBeLessThan(tolerance);
  });

  it('engine aggregate mix sums to ~1.0 (no leakage)', () => {
    const engine = computeEngineAggregateMix();
    const total = engine.usEquity + engine.intlEquity + engine.bonds + engine.cash;
    expect(Math.abs(total - 1)).toBeLessThan(0.01);
  });

  it('engine total balance matches current seed-data aggregate', () => {
    const engine = computeEngineAggregateMix();
    const seedTotal =
      initialSeedData.accounts.pretax.balance +
      initialSeedData.accounts.roth.balance +
      initialSeedData.accounts.taxable.balance +
      initialSeedData.accounts.cash.balance +
      (initialSeedData.accounts.hsa?.balance ?? 0);
    expect(engine.totalBalance).toBeCloseTo(seedTotal, 2);
  });

  it('explicit override via rules.assetClassMappingAssumptions is respected', () => {
    // Demonstrates the adoption path for a user who knows the actual
    // composition of CENTRAL_MANAGED (e.g., via a brokerage statement):
    // set rules.assetClassMappingAssumptions.CENTRAL_MANAGED on the seed,
    // and the engine's derived mapping will use that instead of deriving
    // from the bucket's other holdings.
    const accounts = initialSeedData.accounts;
    const explicitOverride = {
      CENTRAL_MANAGED: {
        US_EQUITY: 0.5,
        INTL_EQUITY: 0.1,
        BONDS: 0.3,
        CASH: 0.1,
      },
    };
    const withOverride = deriveAssetClassMappingAssumptionsFromAccounts(
      accounts,
      explicitOverride,
    );
    expect(withOverride.CENTRAL_MANAGED.US_EQUITY).toBeCloseTo(0.5, 4);
    expect(withOverride.CENTRAL_MANAGED.BONDS).toBeCloseTo(0.3, 4);

    const exposure = rollupHoldingsToAssetClasses(
      accounts.taxable.targetAllocation,
      withOverride,
    );
    // Allocation shares must sum close to 1 (seed-data bucket weights
    // total ≈ 1 modulo rounding; here the taxable bucket rounds to
    // 0.9999, which is within rounding tolerance).
    const totalShare = exposure.US_EQUITY + exposure.INTL_EQUITY + exposure.BONDS + exposure.CASH;
    expect(Math.abs(totalShare - 1)).toBeLessThan(0.001);
  });

  it('TRP_2030 uses published-default glide-path, not bucket-derivation', () => {
    // No explicit override → TRP_2030 should match the published default
    // (target-date 2030 glide-path), NOT the pretax bucket's other
    // holdings (which are heavily US-equity and would skew TRP_2030
    // wrong if we derived from the bucket).
    //
    // The test compared with .toEqual (exact equality) but produces
    // 1-ULP (~1e-16) drift in the last decimal place — confirmed
    // pre-existing on main, predating the Phase 1 perf work. Two
    // summation paths in the codebase disagree by a single representable
    // double: derivation produces 0.4437927663734115, the literal
    // DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS constant carries
    // 0.4437927663734116. The math is mathematically identical; only the
    // floating-point summation order differs. Compare per-class with
    // 12-decimal precision — that's 4 orders of magnitude tighter than
    // any real allocation difference would be, so we'd still catch any
    // actual bug in glide-path derivation.
    const derived = deriveAssetClassMappingAssumptionsFromAccounts(
      initialSeedData.accounts,
    );
    const expected = DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030;
    expect(derived.TRP_2030.US_EQUITY).toBeCloseTo(expected.US_EQUITY, 12);
    expect(derived.TRP_2030.INTL_EQUITY).toBeCloseTo(expected.INTL_EQUITY, 12);
    expect(derived.TRP_2030.BONDS).toBeCloseTo(expected.BONDS, 12);
    expect(derived.TRP_2030.CASH).toBeCloseTo(expected.CASH, 12);
  });
});
