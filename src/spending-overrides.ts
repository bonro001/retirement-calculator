import type {
  SpendingClassificationMethod,
  SpendingTransaction,
} from './spending-ledger';

export const SPENDING_CATEGORY_OVERRIDE_STORAGE_KEY =
  'retirement-calc:spending-category-overrides:v1';
export const SPENDING_MERCHANT_CATEGORY_RULE_STORAGE_KEY =
  'retirement-calc:spending-merchant-category-rules:v1';

export interface SpendingTransactionOverride {
  transactionId: string;
  categoryId: string;
  title?: string;
  classificationMethod: Extract<SpendingClassificationMethod, 'manual'>;
  ignored: boolean;
  updatedAtIso: string;
  updatedFrom: 'retirenment';
}

export type SpendingTransactionOverrideMap = Record<
  string,
  SpendingTransactionOverride
>;

export interface SpendingMerchantCategoryRule {
  merchantKey: string;
  merchantLabel: string;
  categoryId: string;
  classificationMethod: Extract<SpendingClassificationMethod, 'manual'>;
  ignored: boolean;
  updatedAtIso: string;
  updatedFrom: 'retirenment';
}

export type SpendingMerchantCategoryRuleMap = Record<
  string,
  SpendingMerchantCategoryRule
>;

export function isIgnoredCategory(categoryId: string): boolean {
  return categoryId === 'ignored';
}

export function normalizeSpendingMerchant(merchant: string): string {
  const tokens = merchant
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/#\d+/g, ' ')
    .replace(/\b\d{2,}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => token.length === 1)) {
    return tokens.join('');
  }
  return tokens.join(' ');
}

export function buildSpendingTransactionOverride(input: {
  transactionId: string;
  categoryId: string;
  title?: string;
  updatedAtIso?: string;
}): SpendingTransactionOverride {
  const title = input.title?.trim();
  return {
    transactionId: input.transactionId,
    categoryId: input.categoryId,
    ...(title ? { title } : {}),
    classificationMethod: 'manual',
    ignored: isIgnoredCategory(input.categoryId),
    updatedAtIso: input.updatedAtIso ?? new Date().toISOString(),
    updatedFrom: 'retirenment',
  };
}

export function buildSpendingMerchantCategoryRule(input: {
  merchant: string;
  categoryId: string;
  updatedAtIso?: string;
}): SpendingMerchantCategoryRule {
  const merchantKey = normalizeSpendingMerchant(input.merchant);
  return {
    merchantKey,
    merchantLabel: input.merchant,
    categoryId: input.categoryId,
    classificationMethod: 'manual',
    ignored: isIgnoredCategory(input.categoryId),
    updatedAtIso: input.updatedAtIso ?? new Date().toISOString(),
    updatedFrom: 'retirenment',
  };
}

export function applySpendingMerchantCategoryRules(
  transactions: SpendingTransaction[],
  merchantRules: SpendingMerchantCategoryRuleMap,
): SpendingTransaction[] {
  return transactions.map((transaction) => {
    const merchantKey = normalizeSpendingMerchant(transaction.merchant);
    const rule = merchantRules[merchantKey];
    if (!rule) return transaction;

    const tags = new Set(transaction.tags ?? []);
    tags.add('manual_override');
    tags.add('merchant_rule');
    if (rule.ignored) {
      tags.add('ignored');
    } else {
      tags.delete('ignored');
    }

    return {
      ...transaction,
      categoryId: rule.categoryId,
      classificationMethod: rule.classificationMethod,
      categoryConfidence: 1,
      ignored: rule.ignored,
      tags: Array.from(tags),
      rawEvidence: {
        ...(transaction.rawEvidence ?? {}),
        merchantCategoryRule: {
          merchantKey: rule.merchantKey,
          merchantLabel: rule.merchantLabel,
          previousCategoryId: transaction.categoryId,
          previousClassificationMethod: transaction.classificationMethod,
          previousIgnored: transaction.ignored ?? false,
          updatedAtIso: rule.updatedAtIso,
          updatedFrom: rule.updatedFrom,
        },
      },
    };
  });
}

export function applySpendingTransactionOverrides(
  transactions: SpendingTransaction[],
  overrides: SpendingTransactionOverrideMap,
): SpendingTransaction[] {
  return transactions.map((transaction) => {
    const override = overrides[transaction.id];
    if (!override) return transaction;

    const tags = new Set(transaction.tags ?? []);
    tags.add('manual_override');
    if (override.ignored) {
      tags.add('ignored');
    } else {
      tags.delete('ignored');
    }

    return {
      ...transaction,
      ...(override.title ? { displayTitle: override.title } : {}),
      categoryId: override.categoryId,
      classificationMethod: override.classificationMethod,
      categoryConfidence: 1,
      ignored: override.ignored,
      tags: Array.from(tags),
      rawEvidence: {
        ...(transaction.rawEvidence ?? {}),
        categoryOverride: {
          previousCategoryId: transaction.categoryId,
          previousClassificationMethod: transaction.classificationMethod,
          previousIgnored: transaction.ignored ?? false,
          ...(override.title ? { title: override.title } : {}),
          updatedAtIso: override.updatedAtIso,
          updatedFrom: override.updatedFrom,
        },
      },
    };
  });
}

export function readSpendingMerchantCategoryRules(
  storage: Pick<Storage, 'getItem'>,
): SpendingMerchantCategoryRuleMap {
  const raw = storage.getItem(SPENDING_MERCHANT_CATEGORY_RULE_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>).flatMap(
      ([merchantKey, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return [];
        }
        const candidate = value as Partial<SpendingMerchantCategoryRule>;
        if (
          candidate.merchantKey !== merchantKey ||
          typeof candidate.merchantLabel !== 'string' ||
          typeof candidate.categoryId !== 'string' ||
          candidate.classificationMethod !== 'manual' ||
          typeof candidate.ignored !== 'boolean' ||
          typeof candidate.updatedAtIso !== 'string' ||
          candidate.updatedFrom !== 'retirenment'
        ) {
          return [];
        }
        return [[merchantKey, candidate as SpendingMerchantCategoryRule]];
      },
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function writeSpendingMerchantCategoryRules(
  storage: Pick<Storage, 'setItem'>,
  merchantRules: SpendingMerchantCategoryRuleMap,
): void {
  storage.setItem(
    SPENDING_MERCHANT_CATEGORY_RULE_STORAGE_KEY,
    JSON.stringify(merchantRules),
  );
}

export function readSpendingTransactionOverrides(
  storage: Pick<Storage, 'getItem'>,
): SpendingTransactionOverrideMap {
  const raw = storage.getItem(SPENDING_CATEGORY_OVERRIDE_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>).flatMap(
      ([transactionId, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return [];
        }
        const candidate = value as Partial<SpendingTransactionOverride>;
        if (
          candidate.transactionId !== transactionId ||
          typeof candidate.categoryId !== 'string' ||
          (candidate.title !== undefined && typeof candidate.title !== 'string') ||
          candidate.classificationMethod !== 'manual' ||
          typeof candidate.ignored !== 'boolean' ||
          typeof candidate.updatedAtIso !== 'string' ||
          candidate.updatedFrom !== 'retirenment'
        ) {
          return [];
        }
        return [[transactionId, candidate as SpendingTransactionOverride]];
      },
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function writeSpendingTransactionOverrides(
  storage: Pick<Storage, 'setItem'>,
  overrides: SpendingTransactionOverrideMap,
): void {
  storage.setItem(
    SPENDING_CATEGORY_OVERRIDE_STORAGE_KEY,
    JSON.stringify(overrides),
  );
}

function newestByUpdatedAt<T extends { updatedAtIso: string }>(left: T | undefined, right: T): T {
  if (!left) return right;
  return right.updatedAtIso.localeCompare(left.updatedAtIso) >= 0 ? right : left;
}

export function mergeSpendingTransactionOverrides(
  ...maps: SpendingTransactionOverrideMap[]
): SpendingTransactionOverrideMap {
  const merged: SpendingTransactionOverrideMap = {};
  maps.forEach((map) => {
    Object.entries(map).forEach(([transactionId, override]) => {
      merged[transactionId] = newestByUpdatedAt(merged[transactionId], override);
    });
  });
  return merged;
}

export function mergeSpendingMerchantCategoryRules(
  ...maps: SpendingMerchantCategoryRuleMap[]
): SpendingMerchantCategoryRuleMap {
  const merged: SpendingMerchantCategoryRuleMap = {};
  maps.forEach((map) => {
    Object.entries(map).forEach(([merchantKey, rule]) => {
      merged[merchantKey] = newestByUpdatedAt(merged[merchantKey], rule);
    });
  });
  return merged;
}
