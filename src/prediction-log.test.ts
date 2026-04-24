import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';
import {
  buildPredictionRecord,
  computePlanFingerprint,
  createInMemoryPredictionLogStore,
  createLocalStoragePredictionLogStore,
  logPrediction,
  type PredictionRecord,
} from './prediction-log';

function runBaseline(): {
  seedData: SeedData;
  assumptions: MarketAssumptions;
  baselinePath: PathResult;
} {
  const seedData = JSON.parse(JSON.stringify(initialSeedData)) as SeedData;
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: 30,
  };
  const [baselinePath] = buildPathResults(seedData, assumptions, [], []);
  return { seedData, assumptions, baselinePath };
}

describe('prediction log', () => {
  it('computePlanFingerprint is stable under re-ordering and re-serialization', () => {
    const { seedData, assumptions } = runBaseline();
    const a = computePlanFingerprint(seedData, assumptions);
    const reSerialized = JSON.parse(JSON.stringify(seedData)) as SeedData;
    const b = computePlanFingerprint(reSerialized, assumptions);
    expect(b).toBe(a);
  });

  it('computePlanFingerprint changes when any input changes', () => {
    const { seedData, assumptions } = runBaseline();
    const a = computePlanFingerprint(seedData, assumptions);

    const spendMutated = JSON.parse(JSON.stringify(seedData)) as SeedData;
    spendMutated.spending.optionalMonthly += 1;
    const b = computePlanFingerprint(spendMutated, assumptions);
    expect(b).not.toBe(a);

    const assumptionsMutated = { ...assumptions, equityMean: assumptions.equityMean + 0.001 };
    const c = computePlanFingerprint(seedData, assumptionsMutated);
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
  });

  it('buildPredictionRecord captures outputs and tags with fingerprint', () => {
    const { seedData, assumptions, baselinePath } = runBaseline();
    const record = buildPredictionRecord(seedData, assumptions, baselinePath);

    expect(record.planFingerprint).toBe(computePlanFingerprint(seedData, assumptions));
    expect(record.engineVersion).toBe(assumptions.assumptionsVersion);
    expect(record.outputs.successRate).toBe(baselinePath.successRate);
    expect(record.outputs.medianEndingWealth).toBe(baselinePath.medianEndingWealth);
    expect(record.outputs.lifetimeFederalTaxEstimate).toBeCloseTo(
      baselinePath.yearlySeries.reduce((sum, y) => sum + y.medianFederalTax, 0),
      2,
    );
    expect(new Date(record.timestamp).toString()).not.toBe('Invalid Date');
    expect(record.outputs.peakMedianAssets).toBeGreaterThan(0);
  });

  it('buildPredictionRecord captures a yearly trajectory for reconciliation', () => {
    const { seedData, assumptions, baselinePath } = runBaseline();
    const record = buildPredictionRecord(seedData, assumptions, baselinePath);
    expect(record.yearlyTrajectory.length).toBe(baselinePath.yearlySeries.length);
    expect(record.yearlyTrajectory[0].year).toBe(baselinePath.yearlySeries[0].year);
    expect(record.yearlyTrajectory[0].medianAssets).toBe(
      baselinePath.yearlySeries[0].medianAssets,
    );
  });

  it('in-memory store appends and reads deterministically', () => {
    const store = createInMemoryPredictionLogStore();
    const record1 = {
      timestamp: '2026-01-01T00:00:00Z',
      planFingerprint: 'abc',
      engineVersion: 'v1',
      inputs: { seedData: initialSeedData, assumptions: getDefaultVerificationAssumptions() },
      outputs: {
        successRate: 0.8,
        medianEndingWealth: 1_000_000,
        tenthPercentileEndingWealth: 500_000,
        lifetimeFederalTaxEstimate: 100_000,
        peakMedianAssets: 1_500_000,
        peakMedianAssetsYear: 2050,
      },
      yearlyTrajectory: [],
    } as PredictionRecord;

    logPrediction(store, record1);
    logPrediction(store, { ...record1, timestamp: '2026-02-01T00:00:00Z' });

    const all = store.readAll();
    expect(all).toHaveLength(2);
    expect(all[0].timestamp).toBe('2026-01-01T00:00:00Z');
    expect(all[1].timestamp).toBe('2026-02-01T00:00:00Z');
  });

  it('in-memory store returns a copy (caller mutations do not affect store)', () => {
    const store = createInMemoryPredictionLogStore();
    const record = {
      timestamp: '2026-01-01T00:00:00Z',
      planFingerprint: 'abc',
      engineVersion: 'v1',
      inputs: { seedData: initialSeedData, assumptions: getDefaultVerificationAssumptions() },
      outputs: {
        successRate: 0.8,
        medianEndingWealth: 0,
        tenthPercentileEndingWealth: 0,
        lifetimeFederalTaxEstimate: 0,
        peakMedianAssets: 0,
        peakMedianAssetsYear: 0,
      },
      yearlyTrajectory: [],
    } as PredictionRecord;
    logPrediction(store, record);

    const snapshot = store.readAll();
    snapshot.push({ ...record, timestamp: '2099-99-99' });
    const fresh = store.readAll();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('localStorage store round-trips records', () => {
    const memory = new Map<string, string>();
    const fakeStorage: Storage = {
      get length() {
        return memory.size;
      },
      clear() {
        memory.clear();
      },
      getItem(key) {
        return memory.get(key) ?? null;
      },
      key(index) {
        return Array.from(memory.keys())[index] ?? null;
      },
      removeItem(key) {
        memory.delete(key);
      },
      setItem(key, value) {
        memory.set(key, value);
      },
    };
    const store = createLocalStoragePredictionLogStore(fakeStorage);
    const record = {
      timestamp: '2026-01-01T00:00:00Z',
      planFingerprint: 'abc',
      engineVersion: 'v1',
      inputs: {
        seedData: initialSeedData,
        assumptions: getDefaultVerificationAssumptions(),
      },
      outputs: {
        successRate: 0.9,
        medianEndingWealth: 2_000_000,
        tenthPercentileEndingWealth: 800_000,
        lifetimeFederalTaxEstimate: 120_000,
        peakMedianAssets: 2_400_000,
        peakMedianAssetsYear: 2055,
      },
      yearlyTrajectory: [],
    } as PredictionRecord;
    logPrediction(store, record);

    const fresh = store.readAll();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].outputs.successRate).toBe(0.9);
  });

  it('localStorage store caps at LOCAL_STORAGE_MAX_RECORDS with FIFO eviction', () => {
    const memory = new Map<string, string>();
    const fakeStorage: Storage = {
      get length() {
        return memory.size;
      },
      clear() {
        memory.clear();
      },
      getItem(key) {
        return memory.get(key) ?? null;
      },
      key(index) {
        return Array.from(memory.keys())[index] ?? null;
      },
      removeItem(key) {
        memory.delete(key);
      },
      setItem(key, value) {
        memory.set(key, value);
      },
    };
    const store = createLocalStoragePredictionLogStore(fakeStorage);
    const template = {
      planFingerprint: 'abc',
      engineVersion: 'v1',
      inputs: {
        seedData: initialSeedData,
        assumptions: getDefaultVerificationAssumptions(),
      },
      outputs: {
        successRate: 0.9,
        medianEndingWealth: 0,
        tenthPercentileEndingWealth: 0,
        lifetimeFederalTaxEstimate: 0,
        peakMedianAssets: 0,
        peakMedianAssetsYear: 0,
      },
      yearlyTrajectory: [],
    };
    for (let i = 0; i < 525; i++) {
      logPrediction(store, {
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
        ...template,
      } as PredictionRecord);
    }

    const all = store.readAll();
    expect(all.length).toBeLessThanOrEqual(500);
    // FIFO — oldest gone, most-recent preserved.
    expect(all[all.length - 1].timestamp).toContain('2026-01-01T00:00:');
  });
});
