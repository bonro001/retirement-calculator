import {
  readSpendingMerchantCategoryRules,
  readSpendingTransactionOverrides,
  type SpendingMerchantCategoryRuleMap,
  type SpendingTransactionOverrideMap,
} from './spending-overrides';

export interface SpendingOverrideStorePayload {
  schemaVersion: 'spending-overrides-v1';
  updatedAtIso: string | null;
  transactionOverrides: SpendingTransactionOverrideMap;
  merchantCategoryRules: SpendingMerchantCategoryRuleMap;
}

const emptyPayload: SpendingOverrideStorePayload = {
  schemaVersion: 'spending-overrides-v1',
  updatedAtIso: null,
  transactionOverrides: {},
  merchantCategoryRules: {},
};

function objectStorage(value: unknown): Pick<Storage, 'getItem'> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    getItem() {
      return JSON.stringify(source);
    },
  };
}

export function normalizeSpendingOverrideStorePayload(
  value: unknown,
): SpendingOverrideStorePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyPayload;
  }
  const candidate = value as Partial<SpendingOverrideStorePayload>;
  if (candidate.schemaVersion !== 'spending-overrides-v1') {
    return emptyPayload;
  }
  const updatedAtIso =
    typeof candidate.updatedAtIso === 'string' ? candidate.updatedAtIso : null;
  return {
    schemaVersion: 'spending-overrides-v1',
    updatedAtIso,
    transactionOverrides: readSpendingTransactionOverrides(
      objectStorage(candidate.transactionOverrides),
    ),
    merchantCategoryRules: readSpendingMerchantCategoryRules(
      objectStorage(candidate.merchantCategoryRules),
    ),
  };
}
