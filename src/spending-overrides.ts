import type {
  SpendingClassificationMethod,
  SpendingTransaction,
} from './spending-ledger';

export const SPENDING_CATEGORY_OVERRIDE_STORAGE_KEY =
  'retirement-calc:spending-category-overrides:v1';

export interface SpendingTransactionOverride {
  transactionId: string;
  categoryId: string;
  classificationMethod: Extract<SpendingClassificationMethod, 'manual'>;
  ignored: boolean;
  updatedAtIso: string;
  updatedFrom: 'retirenment';
}

export type SpendingTransactionOverrideMap = Record<
  string,
  SpendingTransactionOverride
>;

export function isIgnoredCategory(categoryId: string): boolean {
  return categoryId === 'ignored';
}

export function buildSpendingTransactionOverride(input: {
  transactionId: string;
  categoryId: string;
  updatedAtIso?: string;
}): SpendingTransactionOverride {
  return {
    transactionId: input.transactionId,
    categoryId: input.categoryId,
    classificationMethod: 'manual',
    ignored: isIgnoredCategory(input.categoryId),
    updatedAtIso: input.updatedAtIso ?? new Date().toISOString(),
    updatedFrom: 'retirenment',
  };
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
          updatedAtIso: override.updatedAtIso,
          updatedFrom: override.updatedFrom,
        },
      },
    };
  });
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
