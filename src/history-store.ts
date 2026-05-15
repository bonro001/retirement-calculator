/**
 * History snapshot store — captures a moment-in-time view of the
 * household's plan so they can compare month-over-month or
 * quarter-over-quarter as accounts update and decisions are taken.
 *
 * Storage: IndexedDB, single object store keyed by snapshotId. Snapshots
 * are ~30KB each (metrics + 30-year `yearlySeries`); the store handles
 * thousands without strain. No automatic eviction — the household
 * owns their history and decides what to keep.
 *
 * Why a separate store vs. piggy-backing on the export-payload cache:
 * different lifecycle. Exports are computed-on-demand, freshness-bound,
 * cleaned up automatically. Snapshots are intentional captures the
 * household chose to keep — they should never be silently dropped.
 *
 * Why IDB vs localStorage: localStorage caps at ~5MB, which only buys
 * ~150 snapshots. IDB is unbounded (storage quota policy) and supports
 * efficient indexes for time-range queries.
 */

import type {
  AccountBucket,
  Holding,
  PathYearResult,
  SeedData,
  MarketAssumptions,
} from './types';
import type { Policy } from './policy-miner-types';

const DB_NAME = 'flight-path-history';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

/**
 * One captured snapshot. Stored verbatim in IDB; the schema is the
 * versioning contract — bump `schemaVersion` if the shape changes
 * incompatibly so old snapshots can be migrated forward (or, worst
 * case, marked as legacy).
 */
export interface PlanSnapshot {
  /** Auto-generated key (timestamp-based). Never collides because we
   *  also include a random suffix. */
  snapshotId: string;
  /** Human-readable label the household assigns: "Q1 2026 review",
   *  "after the Apr stress test", etc. Falls back to the ISO date if
   *  the household didn't pick anything. */
  label: string;
  /** When the snapshot was captured. */
  capturedAtIso: string;
  /** Schema version — bump on incompatible shape changes. */
  schemaVersion: 1 | 2;
  /** Headline metrics — what the household sees at-a-glance in the
   *  history list. Computed from baselinePath + adopted policy. */
  metrics: {
    /** Median ending wealth (today's $). */
    medianEndingWealth: number;
    /** Solvency rate — fraction of trials that don't run out (0..1). */
    solventSuccessRate: number;
    /** Total portfolio at the time of capture (today's $). */
    totalAssetsToday: number;
    /** Adopted policy's annual spend, if a policy is adopted. */
    adoptedAnnualSpend: number | null;
    /** This year's projected total spend (engine output, today's $). */
    thisYearProjectedSpend: number | null;
    /** This year's projected MAGI (today's $). */
    thisYearProjectedMagi: number | null;
    /** This year's IRMAA tier name, if any. */
    thisYearIrmaaTier: string | null;
    /** North Star (legacy target, today's $). */
    legacyTargetTodayDollars: number | null;
  };
  /** Year-by-year median balances + spend trajectory. ~30 entries.
   *  Used to draw the "balances over time" chart per snapshot, and
   *  to compute deltas vs another snapshot. */
  yearlySeries: Array<
    Pick<
      PathYearResult,
      | 'year'
      | 'medianAssets'
      | 'medianSpending'
      | 'medianIncome'
      | 'medianFederalTax'
      | 'medianMagi'
      | 'medianRothConversion'
      | 'medianRmdAmount'
      | 'medianPretaxBalance'
      | 'medianTaxableBalance'
      | 'medianRothBalance'
      | 'medianCashBalance'
    >
  >;
  /** The adopted policy at capture time, if any. Stored so the
   *  history view can show "you were running policy X this month."
   *  null when the household hasn't adopted yet. */
  adoptedPolicy: Policy | null;
  /** Account balance totals per bucket at capture. Useful for showing
   *  "your pretax balance has grown $40k since last snapshot." */
  accountBalances: {
    pretax: number;
    roth: number;
    taxable: number;
    cash: number;
    hsa: number | null;
  };
  /** Portfolio checkpoint captured from real account/bank state.
   *  This is the main "before/after Fidelity refresh" payload:
   *  bucket totals, source accounts, exact holdings, shares, price,
   *  cost basis, and direct bank/cash reserve. Optional so old
   *  schema-v1 snapshots remain readable. */
  portfolioState?: SnapshotPortfolioState;
  /** Compact plan context attached to the checkpoint. Usually sourced
   *  from the latest Monthly Review AI packet/response cache. */
  planHighlights?: SnapshotPlanHighlights;
  /** Engine identity — so future versions can detect when a snapshot
   *  came from a different engine and warn before comparing. */
  engineVersion: string;
  simulationRuns: number;
}

export interface SnapshotSourceAccount {
  bucket: string;
  id: string;
  name: string;
  owner?: string;
  managed?: boolean;
  balance: number;
  holdingCount: number;
  costBasis: number | null;
  unrealizedGain: number | null;
}

export interface SnapshotHolding {
  bucket: string;
  accountId: string;
  accountName: string;
  owner?: string;
  managed?: boolean;
  symbol: string;
  name?: string;
  value: number;
  shares: number | null;
  lastPrice: number | null;
  costBasis: number | null;
  unrealizedGain: number | null;
  asOfDate?: string;
  cashLike: boolean;
}

export interface SnapshotHoldingAggregate {
  symbol: string;
  name?: string;
  value: number;
  shares: number | null;
  costBasis: number | null;
  unrealizedGain: number | null;
  accounts: string[];
}

export interface SnapshotPortfolioState {
  totalBalance: number;
  investmentValue: number;
  bankCashValue: number;
  investmentCashLikeValue: number;
  sourceAccountCount: number;
  holdingCount: number;
  holdingsAsOfDate: string | null;
  bucketBalances: Record<string, number>;
  sourceAccounts: SnapshotSourceAccount[];
  holdings: SnapshotHolding[];
  holdingsBySymbol: SnapshotHoldingAggregate[];
}

export interface SnapshotPlanHighlights {
  source: 'monthly_review_cache' | 'cockpit';
  capturedAtIso: string | null;
  recommendationStatus: string | null;
  strategyId: string | null;
  policyId: string | null;
  annualSpendTodayDollars: number | null;
  monthlySpendTodayDollars: number | null;
  certificationVerdict: string | null;
  aiVerdict: string | null;
  aiConfidence: string | null;
  summary: string | null;
  actionItems: string[];
  proofBundlePath: string | null;
  proofFiles: Record<string, string>;
  cockpit: {
    solventSuccessRate: number;
    medianEndingWealth: number;
    thisYearProjectedSpend: number | null;
    thisYearProjectedMagi: number | null;
    adoptedAnnualSpend: number | null;
    legacyTargetTodayDollars: number | null;
  };
}

/**
 * Inputs to `captureSnapshot`. Caller pulls these from the cockpit's
 * existing memos (data, assumptions, baseline path, adopted policy).
 */
export interface CaptureSnapshotInputs {
  label: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  yearlySeries: PathYearResult[];
  /** Trust metrics from the baseline path. */
  successRate: number;
  medianEndingWealth: number;
  /** Adopted policy from the store, if any. */
  adoptedPolicy: Policy | null;
  /** Engine version constant — for forward compat. */
  engineVersion: string;
  /** Latest Monthly Review recommendation/proof metadata, if available. */
  planHighlights?: Omit<SnapshotPlanHighlights, 'cockpit'> | null;
}

function generateSnapshotId(): string {
  // Time-prefixed so default lexicographic sort is chronological;
  // suffix prevents collisions when two snapshots are saved in the
  // same millisecond (rare, but the random tail covers it).
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `snap_${ts}_${rand}`;
}

function isCashLikeHolding(holding: Holding): boolean {
  const symbol = holding.symbol.trim().toUpperCase();
  const name = holding.name?.toLowerCase() ?? '';
  return (
    symbol === 'CASH' ||
    symbol.includes('SPAXX') ||
    symbol.includes('FDRXX') ||
    name.includes('cash') ||
    name.includes('money market') ||
    name.includes('sweep')
  );
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function holdingCostBasis(holding: Holding): number | null {
  return finiteOrNull(holding.costBasis);
}

function buildSyntheticCashHolding(input: {
  bucket: string;
  accountId: string;
  accountName: string;
  balance: number;
}): SnapshotHolding {
  return {
    bucket: input.bucket,
    accountId: input.accountId,
    accountName: input.accountName,
    symbol: 'CASH',
    name: input.accountName,
    value: input.balance,
    shares: null,
    lastPrice: null,
    costBasis: null,
    unrealizedGain: null,
    cashLike: true,
  };
}

export function buildPortfolioState(data: SeedData): SnapshotPortfolioState {
  const bucketBalances: Record<string, number> = {};
  const sourceAccounts: SnapshotSourceAccount[] = [];
  const holdings: SnapshotHolding[] = [];
  let bankCashValue = 0;
  let investmentCashLikeValue = 0;
  let holdingsAsOfDate: string | null = null;

  for (const [bucket, bucketState] of Object.entries(data.accounts) as Array<
    [string, AccountBucket | undefined]
  >) {
    if (!bucketState) continue;
    const bucketBalance = bucketState.balance ?? 0;
    bucketBalances[bucket] = bucketBalance;
    if (bucket === 'cash') {
      bankCashValue += bucketBalance;
    }

    const accounts = bucketState.sourceAccounts ?? [];
    if (accounts.length === 0 && bucket === 'cash' && bucketBalance > 0) {
      sourceAccounts.push({
        bucket,
        id: 'direct-cash',
        name: 'Direct bank/cash reserve',
        balance: bucketBalance,
        holdingCount: 1,
        costBasis: null,
        unrealizedGain: null,
      });
      holdings.push(
        buildSyntheticCashHolding({
          bucket,
          accountId: 'direct-cash',
          accountName: 'Direct bank/cash reserve',
          balance: bucketBalance,
        }),
      );
      continue;
    }

    for (const account of accounts) {
      const accountHoldings = account.holdings ?? [];
      const accountCostBasis = accountHoldings.reduce((sum, holding) => {
        const basis = holdingCostBasis(holding);
        return basis === null ? sum : sum + basis;
      }, 0);
      const hasCostBasis = accountHoldings.some(
        (holding) => holdingCostBasis(holding) !== null,
      );
      sourceAccounts.push({
        bucket,
        id: account.id,
        name: account.name,
        owner: account.owner,
        managed: account.managed,
        balance: account.balance,
        holdingCount: accountHoldings.length,
        costBasis: hasCostBasis ? accountCostBasis : null,
        unrealizedGain: hasCostBasis ? account.balance - accountCostBasis : null,
      });

      if (accountHoldings.length === 0 && account.balance > 0) {
        holdings.push(
          buildSyntheticCashHolding({
            bucket,
            accountId: account.id,
            accountName: account.name,
            balance: account.balance,
          }),
        );
        continue;
      }

      for (const holding of accountHoldings) {
        const costBasis = holdingCostBasis(holding);
        const cashLike = isCashLikeHolding(holding);
        if (cashLike && bucket !== 'cash') {
          investmentCashLikeValue += holding.value;
        }
        if (holding.asOfDate && (!holdingsAsOfDate || holding.asOfDate > holdingsAsOfDate)) {
          holdingsAsOfDate = holding.asOfDate;
        }
        holdings.push({
          bucket,
          accountId: account.id,
          accountName: account.name,
          owner: account.owner,
          managed: account.managed,
          symbol: holding.symbol.trim().toUpperCase(),
          name: holding.name,
          value: holding.value,
          shares: finiteOrNull(holding.shares),
          lastPrice: finiteOrNull(holding.lastPrice),
          costBasis,
          unrealizedGain: costBasis === null ? null : holding.value - costBasis,
          asOfDate: holding.asOfDate,
          cashLike,
        });
      }
    }
  }

  const totalBalance = Object.values(bucketBalances).reduce((sum, value) => sum + value, 0);
  const aggregateMap = new Map<string, SnapshotHoldingAggregate>();
  for (const holding of holdings) {
    const existing = aggregateMap.get(holding.symbol);
    if (!existing) {
      aggregateMap.set(holding.symbol, {
        symbol: holding.symbol,
        name: holding.name,
        value: holding.value,
        shares: holding.shares,
        costBasis: holding.costBasis,
        unrealizedGain: holding.unrealizedGain,
        accounts: [holding.accountName],
      });
      continue;
    }
    existing.value += holding.value;
    existing.shares =
      existing.shares === null || holding.shares === null
        ? null
        : existing.shares + holding.shares;
    existing.costBasis =
      existing.costBasis === null || holding.costBasis === null
        ? null
        : existing.costBasis + holding.costBasis;
    existing.unrealizedGain =
      existing.unrealizedGain === null || holding.unrealizedGain === null
        ? null
        : existing.unrealizedGain + holding.unrealizedGain;
    if (!existing.accounts.includes(holding.accountName)) {
      existing.accounts.push(holding.accountName);
    }
  }

  return {
    totalBalance,
    investmentValue: Math.max(0, totalBalance - bankCashValue),
    bankCashValue,
    investmentCashLikeValue,
    sourceAccountCount: sourceAccounts.length,
    holdingCount: holdings.length,
    holdingsAsOfDate,
    bucketBalances,
    sourceAccounts,
    holdings,
    holdingsBySymbol: [...aggregateMap.values()].sort((a, b) => b.value - a.value),
  };
}

/**
 * Open / upgrade the IDB database. Idempotent — caches the open
 * promise so the second call doesn't re-open.
 */
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'snapshotId',
        });
        // Index on capturedAtIso so we can query time ranges and sort
        // efficiently without loading every snapshot into memory.
        store.createIndex('capturedAt', 'capturedAtIso', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * Build a snapshot from the cockpit's current state. Pure function —
 * does not write to disk; caller passes the result to `saveSnapshot`.
 * Separated so tests can validate the metric extraction without
 * needing IDB.
 */
export function captureSnapshot(inputs: CaptureSnapshotInputs): PlanSnapshot {
  const currentYear = new Date().getUTCFullYear();
  const thisYear =
    inputs.yearlySeries.find((y) => y.year === currentYear) ?? null;

  const totalAssets =
    (inputs.data.accounts?.pretax?.balance ?? 0) +
    (inputs.data.accounts?.roth?.balance ?? 0) +
    (inputs.data.accounts?.taxable?.balance ?? 0) +
    (inputs.data.accounts?.cash?.balance ?? 0) +
    (inputs.data.accounts?.hsa?.balance ?? 0);

  const cockpitHighlights: SnapshotPlanHighlights['cockpit'] = {
    solventSuccessRate: inputs.successRate,
    medianEndingWealth: inputs.medianEndingWealth,
    thisYearProjectedSpend: thisYear?.medianSpending ?? null,
    thisYearProjectedMagi: thisYear?.medianMagi ?? null,
    adoptedAnnualSpend: inputs.adoptedPolicy?.annualSpendTodayDollars ?? null,
    legacyTargetTodayDollars:
      inputs.data.goals?.legacyTargetTodayDollars ?? null,
  };

  const defaultPlanHighlights: Omit<SnapshotPlanHighlights, 'cockpit'> = {
    source: 'cockpit',
    capturedAtIso: null,
    recommendationStatus: null,
    strategyId: null,
    policyId: null,
    annualSpendTodayDollars: inputs.adoptedPolicy?.annualSpendTodayDollars ?? null,
    monthlySpendTodayDollars:
      inputs.adoptedPolicy?.annualSpendTodayDollars == null
        ? null
        : inputs.adoptedPolicy.annualSpendTodayDollars / 12,
    certificationVerdict: null,
    aiVerdict: null,
    aiConfidence: null,
    summary: null,
    actionItems: [],
    proofBundlePath: null,
    proofFiles: {},
  };

  return {
    snapshotId: generateSnapshotId(),
    label: inputs.label || new Date().toISOString().slice(0, 10),
    capturedAtIso: new Date().toISOString(),
    schemaVersion: 2,
    metrics: {
      medianEndingWealth: inputs.medianEndingWealth,
      solventSuccessRate: inputs.successRate,
      totalAssetsToday: totalAssets,
      adoptedAnnualSpend: inputs.adoptedPolicy?.annualSpendTodayDollars ?? null,
      thisYearProjectedSpend: thisYear?.medianSpending ?? null,
      thisYearProjectedMagi: thisYear?.medianMagi ?? null,
      thisYearIrmaaTier: thisYear?.dominantIrmaaTier ?? null,
      legacyTargetTodayDollars:
        inputs.data.goals?.legacyTargetTodayDollars ?? null,
    },
    yearlySeries: inputs.yearlySeries.map((y) => ({
      year: y.year,
      medianAssets: y.medianAssets,
      medianSpending: y.medianSpending,
      medianIncome: y.medianIncome,
      medianFederalTax: y.medianFederalTax,
      medianMagi: y.medianMagi,
      medianRothConversion: y.medianRothConversion,
      medianRmdAmount: y.medianRmdAmount,
      medianPretaxBalance: y.medianPretaxBalance,
      medianTaxableBalance: y.medianTaxableBalance,
      medianRothBalance: y.medianRothBalance,
      medianCashBalance: y.medianCashBalance,
    })),
    adoptedPolicy: inputs.adoptedPolicy,
    accountBalances: {
      pretax: inputs.data.accounts?.pretax?.balance ?? 0,
      roth: inputs.data.accounts?.roth?.balance ?? 0,
      taxable: inputs.data.accounts?.taxable?.balance ?? 0,
      cash: inputs.data.accounts?.cash?.balance ?? 0,
      hsa: inputs.data.accounts?.hsa?.balance ?? null,
    },
    portfolioState: buildPortfolioState(inputs.data),
    planHighlights: {
      ...(inputs.planHighlights ?? defaultPlanHighlights),
      cockpit: cockpitHighlights,
    },
    engineVersion: inputs.engineVersion,
    simulationRuns: inputs.assumptions.simulationRuns,
  };
}

/**
 * Persist a snapshot. Resolves with the saved snapshot (which now has
 * the assigned snapshotId). Errors propagate — caller decides how to
 * surface (toast, console, etc.).
 */
export async function saveSnapshot(snapshot: PlanSnapshot): Promise<PlanSnapshot> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(snapshot);
    req.onsuccess = () => resolve(snapshot);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Read all snapshots, sorted most-recent-first. The store is small
 * enough that loading everything is fine — the household will have
 * tens to low-hundreds of snapshots over years of monthly captures.
 */
export async function loadSnapshots(): Promise<PlanSnapshot[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = (req.result as PlanSnapshot[]) ?? [];
      all.sort((a, b) => b.capturedAtIso.localeCompare(a.capturedAtIso));
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete one snapshot by ID. Returns true if it was present.
 */
export async function deleteSnapshot(snapshotId: string): Promise<boolean> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(snapshotId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Update just the label of an existing snapshot. Used so the
 * household can rename a snapshot after the fact ("oh, this is
 * actually right after I adopted the new policy").
 */
export async function renameSnapshot(
  snapshotId: string,
  label: string,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(snapshotId);
    getReq.onsuccess = () => {
      const existing = getReq.result as PlanSnapshot | undefined;
      if (!existing) {
        resolve();
        return;
      }
      const next = { ...existing, label };
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}
