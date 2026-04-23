import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { getDefaultVerificationAssumptions } from './verification-harness';
import {
  buildPredictionRecord,
  computePlanFingerprint,
  createInMemoryPredictionLogStore,
  logPrediction,
  type PredictionRecord,
} from './prediction-log';
import { buildPathResults } from './utils';
import {
  detectBehaviorChanges,
  diffPredictions,
} from './behavior-change-detector';

function makeRecord(
  seedMutate: (seed: SeedData) => void,
  assumptionsMutate: (a: MarketAssumptions) => MarketAssumptions = (a) => a,
  timestamp = new Date().toISOString(),
): PredictionRecord {
  const seed = JSON.parse(JSON.stringify(initialSeedData)) as SeedData;
  seedMutate(seed);
  const assumptions = assumptionsMutate({
    ...getDefaultVerificationAssumptions(),
    simulationRuns: 20,
  });
  const [baseline] = buildPathResults(seed, assumptions, [], []);
  const record = buildPredictionRecord(seed, assumptions, baseline);
  return { ...record, timestamp };
}

describe('behavior-change detector', () => {
  it('detects retirement-date shift with direction and magnitude', () => {
    const from = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const to = makeRecord(
      (seed) => {
        const current = new Date(seed.income.salaryEndDate);
        current.setFullYear(current.getFullYear() + 2);
        seed.income.salaryEndDate = current.toISOString().slice(0, 10);
      },
      undefined,
      '2026-06-01T00:00:00Z',
    );
    const diff = diffPredictions(from, to);
    const retirementChange = diff.changes.find(
      (c) => c.field === 'income.salaryEndDate',
    );
    expect(retirementChange).toBeDefined();
    expect(retirementChange!.description).toMatch(/shifted later by 24 months/);
    expect(retirementChange!.signedDelta).toBe(24);
  });

  it('detects spending increase on essential bucket', () => {
    const from = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const to = makeRecord(
      (seed) => {
        seed.spending.essentialMonthly += 2000;
      },
      undefined,
      '2026-02-01T00:00:00Z',
    );
    const diff = diffPredictions(from, to);
    const spendChange = diff.changes.find(
      (c) => c.field === 'spending.essentialMonthly',
    );
    expect(spendChange).toBeDefined();
    expect(spendChange!.signedDelta).toBe(2000);
    expect(spendChange!.description).toMatch(/up/);
  });

  it('detects bucket balance changes', () => {
    const from = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const to = makeRecord(
      (seed) => {
        seed.accounts.pretax.balance += 50_000;
      },
      undefined,
      '2026-02-01T00:00:00Z',
    );
    const diff = diffPredictions(from, to);
    const change = diff.changes.find(
      (c) => c.field === 'accounts.pretax.balance',
    );
    expect(change).toBeDefined();
    expect(change!.signedDelta).toBe(50_000);
  });

  it('detects added and removed windfalls', () => {
    const from = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const to = makeRecord(
      (seed) => {
        seed.income.windfalls.push({
          name: 'surprise_gift',
          year: 2030,
          amount: 100_000,
          taxTreatment: 'cash_non_taxable',
        });
      },
      undefined,
      '2026-02-01T00:00:00Z',
    );
    const diff = diffPredictions(from, to);
    const added = diff.changes.find((c) =>
      c.description.includes('Added windfall "surprise_gift"'),
    );
    expect(added).toBeDefined();
    expect(added!.signedDelta).toBe(100_000);
  });

  it('detects assumption changes (equity mean shift)', () => {
    const from = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const to = makeRecord(
      () => {},
      (a) => ({ ...a, equityMean: a.equityMean + 0.01 }),
      '2026-02-01T00:00:00Z',
    );
    const diff = diffPredictions(from, to);
    const change = diff.changes.find((c) => c.field === 'assumptions.equityMean');
    expect(change).toBeDefined();
    expect(change!.description).toMatch(/equityMean moved from/);
  });

  it('summary text is sensible when no changes', () => {
    const from = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const to = makeRecord(() => {}, undefined, '2026-02-01T00:00:00Z');
    const diff = diffPredictions(from, to);
    // Same inputs → fingerprints match → no changes.
    expect(diff.changes.length).toBe(0);
    expect(diff.summary).toMatch(/No plan changes detected/);
  });

  it('detectBehaviorChanges walks the log in chronological order', () => {
    const store = createInMemoryPredictionLogStore();
    const r1 = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const r2 = makeRecord(
      (seed) => {
        seed.spending.optionalMonthly += 500;
      },
      undefined,
      '2026-02-01T00:00:00Z',
    );
    const r3 = makeRecord(
      (seed) => {
        seed.spending.optionalMonthly += 500;
        seed.accounts.cash.balance -= 10_000;
      },
      undefined,
      '2026-03-01T00:00:00Z',
    );
    logPrediction(store, r1);
    logPrediction(store, r2);
    logPrediction(store, r3);

    const diffs = detectBehaviorChanges(store);
    expect(diffs).toHaveLength(2);
    // First diff is r1 → r2: only optional spending change.
    expect(diffs[0].changes.some((c) => c.field === 'spending.optionalMonthly')).toBe(
      true,
    );
    // Second diff is r2 → r3: cash balance is the only new change
    // (optional spending stayed at r2's mutated value in both records'
    // relative-to-baseline construction here).
    expect(
      diffs[1].changes.some((c) => c.field === 'accounts.cash.balance'),
    ).toBe(true);
  });

  it('skips consecutive records with identical fingerprints', () => {
    const store = createInMemoryPredictionLogStore();
    const r1 = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const r2 = makeRecord(() => {}, undefined, '2026-02-01T00:00:00Z');
    // Same inputs → same fingerprint → no diff row expected.
    logPrediction(store, r1);
    logPrediction(store, r2);
    expect(r1.planFingerprint).toBe(r2.planFingerprint);
    const diffs = detectBehaviorChanges(store);
    expect(diffs).toHaveLength(0);
  });

  it('plan fingerprint in diff matches computePlanFingerprint output', () => {
    const from = makeRecord(() => {}, undefined, '2026-01-01T00:00:00Z');
    const to = makeRecord(
      (seed) => {
        seed.spending.essentialMonthly += 100;
      },
      undefined,
      '2026-02-01T00:00:00Z',
    );
    const diff = diffPredictions(from, to);
    expect(diff.fromFingerprint).toBe(
      computePlanFingerprint(from.inputs.seedData, from.inputs.assumptions),
    );
    expect(diff.toFingerprint).toBe(
      computePlanFingerprint(to.inputs.seedData, to.inputs.assumptions),
    );
    expect(diff.fromFingerprint).not.toBe(diff.toFingerprint);
  });
});
