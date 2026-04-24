import type { AccountsData, SeedData } from './types';

export interface PlanSnapshot {
  id: string;
  capturedAt: string;
  label: string;
  totalBalance: number;
  bucketBalances: Record<string, number>;
  successRate: number | null;
}

const STORAGE_KEY = 'rc.plan-snapshots.v1';

export function computeBucketBalances(accounts: AccountsData): Record<string, number> {
  return Object.fromEntries(
    Object.entries(accounts).map(([key, bucket]) => [key, bucket?.balance ?? 0]),
  );
}

export function computeTotalBalance(accounts: AccountsData): number {
  return Object.values(accounts).reduce((sum, bucket) => sum + (bucket?.balance ?? 0), 0);
}

function deriveDefaultLabel(capturedAt: string): string {
  return capturedAt.slice(0, 10);
}

export function buildSnapshot(
  data: SeedData,
  options: { capturedAt?: string; label?: string; successRate?: number | null } = {},
): PlanSnapshot {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  return {
    id: `snap-${capturedAt}-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt,
    label: options.label?.trim() || deriveDefaultLabel(capturedAt),
    totalBalance: computeTotalBalance(data.accounts),
    bucketBalances: computeBucketBalances(data.accounts),
    successRate: options.successRate ?? null,
  };
}

function isPlanSnapshot(value: unknown): value is PlanSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.capturedAt === 'string' &&
    typeof v.label === 'string' &&
    typeof v.totalBalance === 'number' &&
    typeof v.bucketBalances === 'object' &&
    (v.successRate === null || typeof v.successRate === 'number')
  );
}

export function loadSnapshots(): PlanSnapshot[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPlanSnapshot);
  } catch {
    return [];
  }
}

export function saveSnapshots(snapshots: PlanSnapshot[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // Ignore quota errors; snapshots are a soft feature.
  }
}
