import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { getDefaultVerificationAssumptions } from './verification-harness';
import {
  buildUncertaintySurface,
  DEFAULT_UNCERTAINTY_PERTURBATIONS,
} from './uncertainty-surface';

function quickRunInputs(): { seed: SeedData; assumptions: MarketAssumptions } {
  return {
    seed: JSON.parse(JSON.stringify(initialSeedData)) as SeedData,
    assumptions: {
      ...getDefaultVerificationAssumptions(),
      simulationRuns: 30,
    },
  };
}

describe('uncertainty surface', () => {
  it('emits one scenario per perturbation', () => {
    const { seed, assumptions } = quickRunInputs();
    const surface = buildUncertaintySurface(seed, assumptions);
    expect(surface.scenarios.length).toBe(DEFAULT_UNCERTAINTY_PERTURBATIONS.length);
    const ids = surface.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('baseline scenario matches the unperturbed run', () => {
    const { seed, assumptions } = quickRunInputs();
    const surface = buildUncertaintySurface(seed, assumptions);
    const baseline = surface.scenarios.find((s) => s.id === 'baseline');
    expect(baseline).toBeDefined();
    expect(baseline!.successRate).toBeGreaterThanOrEqual(0);
    expect(baseline!.successRate).toBeLessThanOrEqual(1);
  });

  it('equity -2pp scenario produces no-better outcomes than equity +2pp', () => {
    const { seed, assumptions } = quickRunInputs();
    const surface = buildUncertaintySurface(seed, assumptions);
    const minus = surface.scenarios.find((s) => s.id === 'equity-minus-2pp');
    const plus = surface.scenarios.find((s) => s.id === 'equity-plus-2pp');
    expect(minus).toBeDefined();
    expect(plus).toBeDefined();
    expect(plus!.medianEndingWealth).toBeGreaterThanOrEqual(minus!.medianEndingWealth);
  });

  it('honest headline range brackets the point estimate', () => {
    const { seed, assumptions } = quickRunInputs();
    const surface = buildUncertaintySurface(seed, assumptions);
    const baseline = surface.scenarios.find((s) => s.id === 'baseline');
    const basePct = Math.round(baseline!.successRate * 100);
    expect(surface.honestHeadline.successRateMinPct).toBeLessThanOrEqual(basePct);
    expect(surface.honestHeadline.successRateMaxPct).toBeGreaterThanOrEqual(basePct);
  });

  it('summary text is a descriptive range string', () => {
    const { seed, assumptions } = quickRunInputs();
    const surface = buildUncertaintySurface(seed, assumptions);
    expect(surface.honestHeadline.summary.length).toBeGreaterThan(0);
    expect(typeof surface.honestHeadline.summary).toBe('string');
  });

  it('ranges are monotonic (max >= min)', () => {
    const { seed, assumptions } = quickRunInputs();
    const surface = buildUncertaintySurface(seed, assumptions);
    expect(surface.successRateRange.max).toBeGreaterThanOrEqual(
      surface.successRateRange.min,
    );
    expect(surface.medianEndingWealthRange.max).toBeGreaterThanOrEqual(
      surface.medianEndingWealthRange.min,
    );
  });
});
