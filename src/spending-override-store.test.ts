import { describe, expect, it } from 'vitest';
import {
  buildSpendingMerchantCategoryRule,
  buildSpendingTransactionOverride,
} from './spending-overrides';
import { normalizeSpendingOverrideStorePayload } from './spending-override-store';

describe('spending override store', () => {
  it('normalizes valid transaction and merchant overrides from the shared file shape', () => {
    const transactionOverride = buildSpendingTransactionOverride({
      transactionId: 'tx-1',
      categoryId: 'ignored',
      title: 'Noise',
      updatedAtIso: '2026-05-10T12:00:00Z',
    });
    const merchantRule = buildSpendingMerchantCategoryRule({
      merchant: 'H-E-B #024',
      categoryId: 'essential',
      updatedAtIso: '2026-05-10T12:01:00Z',
    });

    const payload = normalizeSpendingOverrideStorePayload({
      schemaVersion: 'spending-overrides-v1',
      updatedAtIso: '2026-05-10T12:02:00Z',
      transactionOverrides: {
        'tx-1': transactionOverride,
      },
      merchantCategoryRules: {
        [merchantRule.merchantKey]: merchantRule,
      },
    });

    expect(payload.transactionOverrides).toEqual({ 'tx-1': transactionOverride });
    expect(payload.merchantCategoryRules).toEqual({
      [merchantRule.merchantKey]: merchantRule,
    });
  });
});

