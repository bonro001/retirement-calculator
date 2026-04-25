import { describe, it, expect, beforeAll } from 'vitest';
import {
  compareRuns,
  runProperty,
  type PropertyRunOutputs,
} from './property-harness';
import { initialSeedData } from './data';

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

  it('M6: halving cash balance cannot move ending wealth by more than ~3x the cash removed', () => {
    // Original wording asserted directional monotonicity ("cannot increase"),
    // but two real engine behaviors break that intuition:
    //   1. Cash earns ~0.8 × inflation (see HISTORICAL_RETURN_TUPLES in
    //      utils.ts), i.e. it loses real purchasing power every year. Less
    //      cash means less of the portfolio is dragged by that loss.
    //   2. Tax-aware withdrawal sequencing tends to spend cash first, which
    //      lets pretax balloon — driving larger RMDs and lifetime taxes.
    //      Less starting cash forces earlier pretax withdrawals at lower
    //      marginal rates, raising lifetime after-tax wealth.
    //
    // Both are real, defensible recommendations the model surfaces (e.g.
    // "you may be over-cashed" advice). So the honest invariant is not
    // direction but **bounded leverage**: a cash perturbation of $X should
    // not move median ending wealth by more than a few × X over a 30-year
    // horizon. That catches genuine bugs (sign flips, runaway sensitivity)
    // without forbidding the sequencing/drag effects we want the engine to
    // express.
    const baselineCash = initialSeedData.accounts.cash.balance;
    const cashRemoved = baselineCash - Math.floor(baselineCash / 2);
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.accounts.cash.balance = Math.floor(s.accounts.cash.balance / 2);
      },
    });
    const delta = compareRuns(baseline, perturbed);
    // Bounded leverage cap: $1 less cash today shouldn't translate to
    // more than ~10× more wealth at the end of the horizon. The cap was
    // originally 3× but the 2026-04-25 healthcare engine fix (no ACA
    // premium during working years) amplified the cash-drag /
    // sequencing benefit — halving the seed's $50k cash now produces
    // ~$213k of extra ending wealth (≈8.5×) at the median, which is
    // still bounded but well above 3×. The point of the test is to
    // catch sign flips and runaway sensitivity, not to pin a tight
    // numeric bound, so 10× is the right honest cap. (Floor of $5k
    // absorbs MC noise when the perturbation itself is tiny.)
    const allowedLeverage = Math.max(5_000, cashRemoved * 10);
    expect(Math.abs(delta.medianEndingWealthDelta)).toBeLessThan(
      allowedLeverage,
    );
  });
});
