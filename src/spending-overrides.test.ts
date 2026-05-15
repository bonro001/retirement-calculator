import { describe, expect, it } from 'vitest';
import {
  applySpendingMerchantCategoryRules,
  applySpendingTransactionOverrides,
  buildSpendingMerchantCategoryRule,
  buildSpendingTransactionOverride,
  mergeSpendingTransactionOverrides,
  normalizeSpendingMerchant,
  parseSpendingOverridesFilePayload,
  readSpendingMerchantCategoryRules,
  readSpendingTransactionOverrides,
  SPENDING_CATEGORY_OVERRIDE_STORAGE_KEY,
  SPENDING_MERCHANT_CATEGORY_RULE_STORAGE_KEY,
  writeSpendingMerchantCategoryRules,
  writeSpendingTransactionOverrides,
  type SpendingMerchantCategoryRuleMap,
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

  it('persists an optional readable title on transaction overrides', () => {
    const [moved] = applySpendingTransactionOverrides([tx], {
      'tx-1': buildSpendingTransactionOverride({
        transactionId: 'tx-1',
        categoryId: 'travel',
        title: 'Oregon Trip',
        updatedAtIso: '2026-05-08T12:00:00Z',
      }),
    });

    expect(moved.displayTitle).toBe('Oregon Trip');
    expect(moved.rawEvidence?.categoryOverride).toMatchObject({
      title: 'Oregon Trip',
      updatedAtIso: '2026-05-08T12:00:00Z',
    });
  });

  it('round-trips valid overrides through localStorage', () => {
    const storage = makeStorage();
    const overrides: SpendingTransactionOverrideMap = {
      'tx-1': buildSpendingTransactionOverride({
        transactionId: 'tx-1',
        categoryId: 'travel',
        title: 'Oregon Trip',
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

  it('parses durable backend override files', () => {
    const override = buildSpendingTransactionOverride({
      transactionId: 'tx-1',
      categoryId: 'health',
      updatedAtIso: '2026-05-11T12:00:00Z',
    });

    const payload = parseSpendingOverridesFilePayload({
      schemaVersion: 'spending-overrides-v1',
      updatedAtIso: '2026-05-11T12:00:00Z',
      transactionOverrides: {
        'tx-1': override,
        malformed: { categoryId: 'optional' },
      },
      merchantCategoryRules: {},
    });

    expect(payload?.transactionOverrides).toEqual({ 'tx-1': override });
  });

  it('keeps the newest transaction override when merging sources', () => {
    const older = buildSpendingTransactionOverride({
      transactionId: 'tx-1',
      categoryId: 'optional',
      updatedAtIso: '2026-05-10T12:00:00Z',
    });
    const newer = buildSpendingTransactionOverride({
      transactionId: 'tx-1',
      categoryId: 'health',
      updatedAtIso: '2026-05-11T12:00:00Z',
    });

    expect(
      mergeSpendingTransactionOverrides({ 'tx-1': older }, { 'tx-1': newer }),
    ).toEqual({ 'tx-1': newer });
    expect(
      mergeSpendingTransactionOverrides({ 'tx-1': newer }, { 'tx-1': older }),
    ).toEqual({ 'tx-1': newer });
  });
});

describe('spending merchant category rules', () => {
  it('normalizes common merchant variants', () => {
    expect(normalizeSpendingMerchant('H-E-B #123')).toBe('heb');
    expect(normalizeSpendingMerchant('SAMSCLUB #6453')).toBe('samsclub');
  });

  it('applies merchant rules as manual reviewed classifications', () => {
    const rule = buildSpendingMerchantCategoryRule({
      merchant: 'H-E-B #123',
      categoryId: 'essential',
      updatedAtIso: '2026-05-08T12:00:00Z',
    });
    const hebTransaction: SpendingTransaction = {
      ...tx,
      id: 'heb-1',
      merchant: 'H-E-B #456',
      categoryId: 'optional',
      classificationMethod: 'rule',
    };

    const [moved] = applySpendingMerchantCategoryRules([hebTransaction], {
      [rule.merchantKey]: rule,
    });

    expect(moved.categoryId).toBe('essential');
    expect(moved.classificationMethod).toBe('manual');
    expect(moved.tags).toContain('manual_override');
    expect(moved.tags).toContain('merchant_rule');
    expect(moved.rawEvidence?.merchantCategoryRule).toEqual({
      merchantKey: 'heb',
      merchantLabel: 'H-E-B #123',
      previousCategoryId: 'optional',
      previousClassificationMethod: 'rule',
      previousIgnored: false,
      updatedAtIso: '2026-05-08T12:00:00Z',
      updatedFrom: 'retirenment',
    });
  });

  it('round-trips valid merchant rules through localStorage', () => {
    const storage = makeStorage();
    const rule = buildSpendingMerchantCategoryRule({
      merchant: 'H-E-B',
      categoryId: 'essential',
      updatedAtIso: '2026-05-08T12:00:00Z',
    });
    const rules: SpendingMerchantCategoryRuleMap = {
      [rule.merchantKey]: rule,
    };

    writeSpendingMerchantCategoryRules(storage, rules);
    expect(storage.getItem(SPENDING_MERCHANT_CATEGORY_RULE_STORAGE_KEY)).toBeTruthy();
    expect(readSpendingMerchantCategoryRules(storage)).toEqual(rules);
  });
});
