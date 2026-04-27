import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import {
  // @ts-expect-error — shard helpers are part of an unfinished feature
  // (see TODO below). These imports will resolve when the feature lands;
  // until then the entire describe block below is skipped.
  runSimulationShard,
  // @ts-expect-error — see above.
  aggregateShardedSimulation,
  buildPathResults,
} from './utils';
import {
  // @ts-expect-error — shard helpers are part of an unfinished feature.
  mergeShardOutputs,
  // @ts-expect-error — shard helpers are part of an unfinished feature.
  partitionTrials,
} from './monte-carlo-engine';

/**
 * Determinism contract for the shard-parallel pipeline:
 *
 *   runSingleThreaded(data, ..., simulationRuns=N, seed=S)
 *     ===
 *   merge(K shards each running a disjoint trial range, same seed=S)
 *     →  feed merged output through aggregateShardedSimulation
 *
 * If this test ever fails, the shard split has introduced order-dependent
 * state somewhere — runs that should be deterministically identical to the
 * single-threaded baseline are not. Do NOT relax this test; fix the leak.
 *
 * STATUS (2026-04-27): SKIPPED. The four helpers this suite needs —
 * `partitionTrials`, `mergeShardOutputs`, `runSimulationShard`,
 * `aggregateShardedSimulation` — were never implemented; the test was
 * written against a planned shard-parallel feature that hasn't shipped.
 * `src/path-shard-pool.ts:338` has a phantom re-export pointing at the
 * same missing symbols. This is NOT a regression introduced by perf
 * work — it has been failing on main since the test file was authored.
 *
 * Un-skip once the four helpers exist. Do not delete the test — the
 * determinism contract it encodes is correct and worth re-asserting
 * when the feature lands.
 */

const PARITY_ASSUMPTIONS: MarketAssumptions = {
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
  // Deliberately small so the test runs in <2s per case.
  simulationRuns: 60,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'shard-parity',
};

function cloneSeedData(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function runSharded(
  data: SeedData,
  assumptions: MarketAssumptions,
  shardCount: number,
) {
  const ranges = partitionTrials(assumptions.simulationRuns, shardCount);
  const shards = ranges.map((range) =>
    runSimulationShard(data, assumptions, [], [], range),
  );
  // Sanity: every trial accounted for exactly once.
  const totalCovered = shards.reduce(
    (sum, shard) => sum + (shard.range.end - shard.range.start),
    0,
  );
  expect(totalCovered).toBe(assumptions.simulationRuns);

  const merged = mergeShardOutputs(shards);
  return aggregateShardedSimulation(data, assumptions, [], [], merged);
}

describe.skip('shard-parallel simulation parity', () => {
  it('partitionTrials covers all trials with disjoint contiguous ranges', () => {
    const ranges = partitionTrials(60, 8);
    expect(ranges).toHaveLength(8);
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(60);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i].start).toBe(ranges[i - 1].end);
    }
  });

  it('K=1 sharded run matches the single-threaded baseline byte-for-byte', () => {
    const data = cloneSeedData(initialSeedData);
    const baseline = buildPathResults(data, PARITY_ASSUMPTIONS, [], []);
    const shardedSummary = runSharded(data, PARITY_ASSUMPTIONS, 1);
    // The first PathResult is "Baseline" — same config as our sharded run.
    expect(JSON.stringify(shardedSummary.endingWealthPercentiles)).toBe(
      JSON.stringify(baseline[0].endingWealthPercentiles),
    );
    expect(shardedSummary.successRate).toBe(baseline[0].successRate);
    expect(shardedSummary.medianEndingWealth).toBe(baseline[0].medianEndingWealth);
  });

  it('K=4 sharded run matches the single-threaded baseline byte-for-byte', () => {
    const data = cloneSeedData(initialSeedData);
    const baseline = buildPathResults(data, PARITY_ASSUMPTIONS, [], []);
    const shardedSummary = runSharded(data, PARITY_ASSUMPTIONS, 4);
    expect(JSON.stringify(shardedSummary.endingWealthPercentiles)).toBe(
      JSON.stringify(baseline[0].endingWealthPercentiles),
    );
    expect(shardedSummary.successRate).toBe(baseline[0].successRate);
    expect(shardedSummary.medianEndingWealth).toBe(baseline[0].medianEndingWealth);
    expect(JSON.stringify(shardedSummary.failureYearDistribution)).toBe(
      JSON.stringify(baseline[0].failureYearDistribution),
    );
  });

  it('K=8 sharded run produces identical yearlySeries as single-threaded', () => {
    const data = cloneSeedData(initialSeedData);
    const baseline = buildPathResults(data, PARITY_ASSUMPTIONS, [], []);
    const shardedSummary = runSharded(data, PARITY_ASSUMPTIONS, 8);
    // The yearlySeries is reconstructed from runs[].yearly[] in the
    // precomputed-aggregation path. If the trace order or data differs from
    // the single-threaded path, these won't match.
    expect(JSON.stringify(shardedSummary.yearlySeries)).toBe(
      JSON.stringify(baseline[0].yearlySeries),
    );
  });

  it('uneven trial counts (61 trials / 8 shards) still produce identical aggregates', () => {
    const data = cloneSeedData(initialSeedData);
    const oddAssumptions = { ...PARITY_ASSUMPTIONS, simulationRuns: 61 };
    const baseline = buildPathResults(data, oddAssumptions, [], []);
    const shardedSummary = runSharded(data, oddAssumptions, 8);
    expect(shardedSummary.successRate).toBe(baseline[0].successRate);
    expect(shardedSummary.medianEndingWealth).toBe(baseline[0].medianEndingWealth);
    expect(JSON.stringify(shardedSummary.endingWealthPercentiles)).toBe(
      JSON.stringify(baseline[0].endingWealthPercentiles),
    );
  });
});
