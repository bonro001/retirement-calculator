import { describe, it, expect, beforeAll } from 'vitest';
import {
  compareRuns,
  runProperty,
  type PropertyRunOutputs,
} from './property-harness';

// Strict-dominance invariants — unambiguously better inputs must produce
// unambiguously better outputs in median. These catch sign flips and
// accounting bugs that monotonicity might miss when the baseline metric is
// already at a boundary (e.g. 100% success masks "better" perturbations).

let baseline: PropertyRunOutputs;
beforeAll(() => {
  baseline = runProperty();
});

describe('strict-dominance invariants', () => {
  it('D1: +2pp equity mean return → higher median ending wealth', () => {
    const perturbed = runProperty({
      assumptionPerturb: (a) => {
        a.equityMean += 0.02;
        a.internationalEquityMean += 0.02;
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.medianEndingWealthDelta).toBeGreaterThan(0);
  });

  it('D2: -1pp inflation → higher median ending wealth', () => {
    const perturbed = runProperty({
      assumptionPerturb: (a) => {
        a.inflation -= 0.01;
      },
    });
    const delta = compareRuns(baseline, perturbed);
    // Real spending is fixed via inflation, so lower inflation means less
    // nominal dollars needed. Ending wealth (nominal) could go either way
    // depending on nominal return assumption; use successRate instead.
    expect(delta.successRateDelta).toBeGreaterThanOrEqual(0);
  });

  it('D3: doubling pretax balance → ending wealth at least as high', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.accounts.pretax.balance *= 2;
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.medianEndingWealthDelta).toBeGreaterThan(0);
  });

  it('D4: +5pp on all mean returns → higher median ending wealth', () => {
    // Individual asset-class bumps can get swamped by withdrawal-policy noise
    // at 30 MC runs. A combined bump on all return means is unambiguous.
    const perturbed = runProperty({
      assumptionPerturb: (a) => {
        a.equityMean += 0.05;
        a.internationalEquityMean += 0.05;
        a.bondMean += 0.05;
        a.cashMean += 0.05;
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.medianEndingWealthDelta).toBeGreaterThan(0);
  });

  it('D5: +$1M to all buckets → success never decreases', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.accounts.pretax.balance += 250_000;
        s.accounts.roth.balance += 250_000;
        s.accounts.taxable.balance += 250_000;
        s.accounts.cash.balance += 250_000;
      },
    });
    const delta = compareRuns(baseline, perturbed);
    expect(delta.successRateDelta).toBeGreaterThanOrEqual(0);
    expect(delta.medianEndingWealthDelta).toBeGreaterThan(0);
  });

  it('D6: zeroing all spending → success rate = 100% (nothing to fund)', () => {
    const perturbed = runProperty({
      seedPerturb: (s) => {
        s.spending.essentialMonthly = 0;
        s.spending.optionalMonthly = 0;
        s.spending.annualTaxesInsurance = 0;
        s.spending.travelEarlyRetirementAnnual = 0;
      },
    });
    expect(perturbed.successRate).toBeCloseTo(1, 2);
  });

  it('D7: perturbation is reversible — baseline run is deterministic under fixed seed', () => {
    const again = runProperty();
    expect(again.successRate).toBe(baseline.successRate);
    expect(again.medianEndingWealth).toBe(baseline.medianEndingWealth);
  });
});
