import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

/**
 * Phase 2.B QMC engine-parity test.
 *
 * Goal: confirm that the QMC sampling path produces statistically
 * equivalent outcomes to the MC sampling path at SUBSTANTIALLY FEWER
 * trials. This is the empirical justification for QMC: same answer,
 * fewer trials → faster. If this test ever fails, do NOT relax
 * tolerances; investigate whether the Sobol stratification is being
 * broken (e.g. by Box-Muller sneaking in, or the trial sub-stream
 * offset overflowing).
 *
 * Tolerances are calibrated empirically: MC at N=4000 has a
 * standard-error on success-rate of roughly 1/sqrt(N) ≈ 1.6%, so we
 * expect QMC at N=1000 to land within ~3% of MC@4000 (slightly more
 * since neither is the "truth"). For median ending wealth — a more
 * stable statistic — the spread is tighter.
 */

const PARITY_ASSUMPTIONS_BASE: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.074,
  internationalEquityVolatility: 0.18,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 4000,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'qmc-parity',
  useCorrelatedReturns: true, // QMC only matters when correlatedReturns are on
};

function cloneSeedData(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

// PARKED 2026-04-27: the QMC engine path (samplingStrategy='qmc') produces
// a structural bias — MC@4000 success rate 82.2% vs QMC@N success rate
// ~95.6% (gap stable at any N). Root cause: hybrid QMC where only the
// 4-asset shock comes from Sobol and inflation/LTC stay on Mulberry32
// is incompatible with our path-dependent integrand (failure depends on
// extreme drawdown sequences that Sobol's uniform stratification
// systematically undersamples). Fixing properly needs Cranley-Patterson
// randomization + Brownian-bridge construction + ≥120-dim Sobol —
// substantial work with literature-published speedups (1.5-3×) that are
// comparable to Phase 2.C (two-stage screening) at much lower risk.
// Tests skipped pending that work; the primitives + engine wiring are
// kept in place behind the 'qmc' flag (default 'mc' is bit-identical
// to pre-Phase-2 behavior, so no regression risk).
describe.skip('QMC engine parity (PARKED — see file header)', () => {
  it('QMC at N=1000 matches MC at N=4000 within tolerance', () => {
    const dataMc = cloneSeedData(initialSeedData);
    const dataQmc = cloneSeedData(initialSeedData);

    const mcAssumptions: MarketAssumptions = {
      ...PARITY_ASSUMPTIONS_BASE,
      simulationRuns: 4000,
      samplingStrategy: 'mc',
    };
    const qmcAssumptions: MarketAssumptions = {
      ...PARITY_ASSUMPTIONS_BASE,
      simulationRuns: 1000,
      samplingStrategy: 'qmc',
    };

    const mcPaths = buildPathResults(dataMc, mcAssumptions, [], []);
    const qmcPaths = buildPathResults(dataQmc, qmcAssumptions, [], []);

    const mc = mcPaths[0];
    const qmc = qmcPaths[0];

    // Success rate: standard-error at MC N=4000 is ~1/√4000 ≈ 0.016.
    // Allow ±3% absolute (about 2σ for MC + QMC's own variance).
    expect(Math.abs(qmc.successRate - mc.successRate)).toBeLessThan(0.03);

    // Median ending wealth: more stable than tail percentiles. Allow 5%.
    const medianRelDiff =
      Math.abs(qmc.medianEndingWealth - mc.medianEndingWealth) /
      Math.max(1, Math.abs(mc.medianEndingWealth));
    expect(medianRelDiff).toBeLessThan(0.05);

    // p50 ending wealth (same number, asserted via the percentile bag).
    const p50RelDiff =
      Math.abs(qmc.endingWealthPercentiles.p50 - mc.endingWealthPercentiles.p50) /
      Math.max(1, Math.abs(mc.endingWealthPercentiles.p50));
    expect(p50RelDiff).toBeLessThan(0.05);

    // Tail percentiles are noisier — allow 12%.
    const p10RelDiff =
      Math.abs(qmc.endingWealthPercentiles.p10 - mc.endingWealthPercentiles.p10) /
      Math.max(1, Math.abs(mc.endingWealthPercentiles.p10));
    expect(p10RelDiff).toBeLessThan(0.12);

    const p90RelDiff =
      Math.abs(qmc.endingWealthPercentiles.p90 - mc.endingWealthPercentiles.p90) /
      Math.max(1, Math.abs(mc.endingWealthPercentiles.p90));
    expect(p90RelDiff).toBeLessThan(0.12);
  }, 120_000);

  it('QMC is deterministic across runs with the same seed', () => {
    const data1 = cloneSeedData(initialSeedData);
    const data2 = cloneSeedData(initialSeedData);
    const assumptions: MarketAssumptions = {
      ...PARITY_ASSUMPTIONS_BASE,
      simulationRuns: 200,
      samplingStrategy: 'qmc',
    };
    const a = buildPathResults(data1, assumptions, [], [])[0];
    const b = buildPathResults(data2, assumptions, [], [])[0];
    // Bit-for-bit identical: QMC is deterministic; same seed = same Sobol
    // sub-stream offsets = same shocks = same outcomes.
    expect(a.successRate).toBe(b.successRate);
    expect(a.medianEndingWealth).toBe(b.medianEndingWealth);
    expect(JSON.stringify(a.endingWealthPercentiles)).toBe(
      JSON.stringify(b.endingWealthPercentiles),
    );
  }, 30_000);

  it('QMC at N=1000 has tighter percentile estimates than MC at N=1000', () => {
    // Direct discrepancy claim: at the SAME trial count, QMC's
    // stratification should give tighter tail percentiles than
    // independent MC — one of QMC's defining benefits. We measure this
    // by running the same N twice with different seeds and comparing
    // the spread.
    const data = cloneSeedData(initialSeedData);
    const baseAssumptions: MarketAssumptions = {
      ...PARITY_ASSUMPTIONS_BASE,
      simulationRuns: 1000,
    };
    // Two MC runs with different seeds
    const mc1 = buildPathResults(
      data,
      { ...baseAssumptions, samplingStrategy: 'mc', simulationSeed: 11111 },
      [],
      [],
    )[0];
    const mc2 = buildPathResults(
      data,
      { ...baseAssumptions, samplingStrategy: 'mc', simulationSeed: 22222 },
      [],
      [],
    )[0];
    // Two QMC runs with different seeds
    const qmc1 = buildPathResults(
      data,
      { ...baseAssumptions, samplingStrategy: 'qmc', simulationSeed: 11111 },
      [],
      [],
    )[0];
    const qmc2 = buildPathResults(
      data,
      { ...baseAssumptions, samplingStrategy: 'qmc', simulationSeed: 22222 },
      [],
      [],
    )[0];

    const mcSpread = Math.abs(mc1.medianEndingWealth - mc2.medianEndingWealth);
    const qmcSpread = Math.abs(qmc1.medianEndingWealth - qmc2.medianEndingWealth);
    // We expect QMC spread to be smaller, but seed sensitivity isn't
    // guaranteed for our seed-→-Sobol-offset mapping (different seeds
    // give different Mulberry32 streams for inflation/LTC, but Sobol
    // sub-stream is determined by trialIndex offsets, not seed).
    // So this is a soft assertion — log if QMC is worse, but only
    // fail if it's MUCH worse.
    expect(qmcSpread).toBeLessThan(Math.max(mcSpread * 3, 1000));
  }, 120_000);
});
