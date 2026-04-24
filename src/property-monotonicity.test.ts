import { describe, it, expect, beforeAll } from 'vitest';
import {
  compareRuns,
  runProperty,
  type PropertyRunOutputs,
} from './property-harness';

// Monotonicity invariants — perturbations that should only ever move a
// headline metric in one direction. See docs/property-invariants.md for
// the catalog. A small epsilon allows tiny MC noise that sneaks through
// the deterministic-seed pipeline in non-trivial ways.

const EPSILON = 1e-6;

// MC tolerance floor: even with a fixed seed, tiny numerical differences in
// code paths (e.g., slightly different withdrawal composition on the stressed
// path vs baseline) can produce minuscule deltas on metrics that should be
// strictly equal. We allow a larger tolerance on dollar-denominated metrics
// than on rate metrics because their magnitudes differ by orders of magnitude.
const SUCCESS_RATE_TOLERANCE = 0.002; // ~0.2pp
const WEALTH_TOLERANCE = 2_000; // $2k on ~$1M+ portfolios is sub-0.2%

let baseline: PropertyRunOutputs;
beforeAll(() => {
  baseline = runProperty();
});

describe('monotonicity invariants', () => {
  it('M1: doubling optional spending cannot increase success rate', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.spending.optionalMonthly *= 2;
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.successRateDelta).toBeLessThanOrEqual(SUCCESS_RATE_TOLERANCE);
  });

  it('M2: halving essential spending cannot reduce success rate', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.spending.essentialMonthly = Math.floor(
          s.spending.essentialMonthly / 2,
        );
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.successRateDelta).toBeGreaterThanOrEqual(
      -SUCCESS_RATE_TOLERANCE,
    );
  });

  it('M3: pushing salary end-date two years later cannot reduce success rate', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        const current = new Date(s.income.salaryEndDate);
        current.setFullYear(current.getFullYear() + 2);
        s.income.salaryEndDate = current.toISOString().slice(0, 10);
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.successRateDelta).toBeGreaterThanOrEqual(
      -SUCCESS_RATE_TOLERANCE,
    );
  });

  it('M4: adding a $500k non-taxable windfall cannot reduce ending wealth', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.income.windfalls = [
          ...s.income.windfalls,
          {
            name: 'property_test_gift',
            year: 2028,
            amount: 500_000,
            taxTreatment: 'cash_non_taxable',
          },
        ];
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.medianEndingWealthDelta).toBeGreaterThan(-WEALTH_TOLERANCE);
    expect(delta.medianEndingWealthDelta).toBeGreaterThan(0);
  });

  it('M5: adding $200k to cash bucket cannot reduce ending wealth', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.accounts.cash.balance += 200_000;
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.medianEndingWealthDelta).toBeGreaterThan(-WEALTH_TOLERANCE);
  });

  it('M6: halving cash balance cannot increase ending wealth', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.accounts.cash.balance = Math.floor(s.accounts.cash.balance / 2);
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.medianEndingWealthDelta).toBeLessThan(WEALTH_TOLERANCE);
  });
});
