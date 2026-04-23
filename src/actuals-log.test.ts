import { describe, it, expect } from 'vitest';
import {
  buildAnnualTaxActual,
  buildBalanceSnapshotActual,
  buildLifeEventActual,
  buildMonthlySpendingActual,
  createInMemoryActualsLogStore,
  createLocalStorageActualsLogStore,
  logActual,
  type ActualsRecord,
} from './actuals-log';

function makeStorage(): Storage {
  const memory = new Map<string, string>();
  return {
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
}

describe('actuals log', () => {
  it('buildBalanceSnapshotActual sums buckets into total', () => {
    const snapshot = buildBalanceSnapshotActual({
      asOfDate: '2026-04-23',
      pretax: 400_000,
      roth: 300_000,
      taxable: 150_000,
      cash: 50_000,
      hsa: 20_000,
    });
    expect(snapshot.totalBalance).toBe(920_000);
    expect(snapshot.balances.pretax).toBe(400_000);
  });

  it('buildMonthlySpendingActual sums buckets', () => {
    const spend = buildMonthlySpendingActual({
      month: '2026-04',
      essentialSpent: 5_200,
      optionalSpent: 3_100,
      healthcareSpent: 900,
    });
    expect(spend.totalSpent).toBe(9_200);
  });

  it('buildAnnualTaxActual carries optional note through', () => {
    const tax = buildAnnualTaxActual({
      taxYear: 2025,
      federalTaxPaid: 45_000,
      notes: 'from 1040 line 24',
    });
    expect(tax.federalTaxPaid).toBe(45_000);
    expect(tax.notes).toBe('from 1040 line 24');
  });

  it('in-memory store append/readAll round-trip', () => {
    const store = createInMemoryActualsLogStore();
    const record: ActualsRecord = {
      capturedAt: '2026-04-23T15:00:00Z',
      planFingerprintAtCapture: 'abc123',
      measurement: buildBalanceSnapshotActual({
        asOfDate: '2026-04-23',
        pretax: 400_000,
        roth: 300_000,
      }),
    };
    logActual(store, record);
    const all = store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].planFingerprintAtCapture).toBe('abc123');
  });

  it('in-memory readAll returns a copy', () => {
    const store = createInMemoryActualsLogStore();
    logActual(store, {
      capturedAt: '2026-04-23T15:00:00Z',
      planFingerprintAtCapture: 'x',
      measurement: buildBalanceSnapshotActual({ asOfDate: '2026-04-23', pretax: 1 }),
    });
    const a = store.readAll();
    a.push({} as ActualsRecord);
    expect(store.readAll()).toHaveLength(1);
  });

  it('localStorage store round-trips multiple measurement kinds', () => {
    const store = createLocalStorageActualsLogStore(makeStorage());
    logActual(store, {
      capturedAt: '2026-04-01T00:00:00Z',
      planFingerprintAtCapture: 'fp1',
      measurement: buildBalanceSnapshotActual({ asOfDate: '2026-03-31', pretax: 100_000 }),
    });
    logActual(store, {
      capturedAt: '2026-04-05T00:00:00Z',
      planFingerprintAtCapture: 'fp1',
      measurement: buildMonthlySpendingActual({
        month: '2026-03',
        essentialSpent: 5000,
        optionalSpent: 3500,
      }),
    });
    logActual(store, {
      capturedAt: '2026-04-15T00:00:00Z',
      planFingerprintAtCapture: 'fp1',
      measurement: buildAnnualTaxActual({ taxYear: 2025, federalTaxPaid: 28_500 }),
    });
    logActual(store, {
      capturedAt: '2026-04-20T00:00:00Z',
      planFingerprintAtCapture: 'fp1',
      measurement: buildLifeEventActual({
        eventDate: '2026-04-19',
        category: 'unplanned_medical',
        amountSigned: -12_000,
        description: 'ER visit deductible',
      }),
    });
    const all = store.readAll();
    expect(all).toHaveLength(4);
    expect(all.map((record) => record.measurement.kind).sort()).toEqual(
      ['annual_tax', 'balance_snapshot', 'life_event', 'monthly_spending'].sort(),
    );
  });
});
