import { describe, expect, it } from 'vitest';
import {
  applySpendingTransactionOverrides,
  buildSpendingTransactionOverride,
  readSpendingTransactionOverrides,
  SPENDING_CATEGORY_OVERRIDE_STORAGE_KEY,
  writeSpendingTransactionOverrides,
  type SpendingTransactionOverrideMap,
} from './spending-overrides';
import type { SpendingTransaction } from './spending-ledger';

function makeStorage(seed?: string): Storage {
  const memory = new Map<string, string>();
  if (seed !== undefined) {
    memory.set(SPENDING_CATEGORY_OVERRIDE_STORAGE_KEY, seed);
  }
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

const tx: SpendingTransaction = {
  id: 'tx-1',
  postedDate: '2026-05-08',
  merchant: 'Amazon',
  amount: 42,
  currency: 'USD',
  categoryId: 'amazon_uncategorized',
  categoryConfidence: 0.45,
  classificationMethod: 'inferred',
  ignored: false,
  tags: ['amazon'],
};

describe('spending transaction overrides', () => {
  it('moves transactions without mutating imported evidence', () => {
    const override = buildSpendingTransactionOverride({
      transactionId: 'tx-1',
      categoryId: 'health',
      updatedAtIso: '2026-05-08T12:00:00Z',
    });

    const [moved] = applySpendingTransactionOverrides([tx], {
      'tx-1': override,
    });

    expect(tx.categoryId).toBe('amazon_uncategorized');
    expect(moved.categoryId).toBe('health');
    expect(moved.classificationMethod).toBe('manual');
    expect(moved.categoryConfidence).toBe(1);
    expect(moved.ignored).toBe(false);
    expect(moved.tags).toContain('manual_override');
    expect(moved.rawEvidence?.categoryOverride).toEqual({
      previousCategoryId: 'amazon_uncategorized',
      previousClassificationMethod: 'inferred',
      previousIgnored: false,
      updatedAtIso: '2026-05-08T12:00:00Z',
      updatedFrom: 'retirenment',
    });
  });

  it('marks transactions ignored when moved to the ignored bucket', () => {
    const [moved] = applySpendingTransactionOverrides([tx], {
      'tx-1': buildSpendingTransactionOverride({
        transactionId: 'tx-1',
        categoryId: 'ignored',
        updatedAtIso: '2026-05-08T12:00:00Z',
      }),
    });

    expect(moved.categoryId).toBe('ignored');
    expect(moved.ignored).toBe(true);
    expect(moved.tags).toContain('ignored');
  });

  it('round-trips valid overrides through localStorage', () => {
    const storage = makeStorage();
    const overrides: SpendingTransactionOverrideMap = {
      'tx-1': buildSpendingTransactionOverride({
        transactionId: 'tx-1',
        categoryId: 'travel',
        updatedAtIso: '2026-05-08T12:00:00Z',
      }),
    };

    writeSpendingTransactionOverrides(storage, overrides);
    expect(readSpendingTransactionOverrides(storage)).toEqual(overrides);
  });

  it('drops malformed localStorage entries', () => {
    const storage = makeStorage(
      JSON.stringify({
        good: buildSpendingTransactionOverride({
          transactionId: 'good',
          categoryId: 'optional',
          updatedAtIso: '2026-05-08T12:00:00Z',
        }),
        bad: { categoryId: 'essential' },
      }),
    );

    expect(Object.keys(readSpendingTransactionOverrides(storage))).toEqual(['good']);
  });
});
