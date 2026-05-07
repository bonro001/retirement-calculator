import type { MarketAssumptions, PathResult, SeedData } from './types';

// Append-only log of every plan evaluation. The goal is to build up, over
// months and years, a (prediction, realized-outcome) dataset so we can
// empirically calibrate the model — see CALIBRATION_WORKPLAN.md.
//
// Each record captures:
//   - timestamp (ISO 8601)
//   - planFingerprint: a stable hash of the seed data + assumptions that
//     uniquely identifies the modeled plan. Changes when any input changes.
//   - engineVersion: the assumptions version string (ties the prediction
//     to a specific engine build).
//   - inputs: the seed data + assumptions snapshot as JSON.
//   - outputs: the headline outputs we care about (success rate, median
//     ending wealth, lifetime taxes, etc.).
//
// The log is pluggable — in-browser default is localStorage, tests pass an
// in-memory Map. A future step in CALIBRATION_WORKPLAN swaps in an
// append-only file when we're running under Node.

// Per-year snapshot compressed down to just what the reconciliation layer
// needs to diff a prediction against later actuals. Keeping it narrow
// (not the full PathYearResult) so stored records stay small enough for
// localStorage to hold hundreds of evaluations.
export interface PredictionYearSnapshot {
  year: number;
  medianAssets: number;
  medianSpending: number;
  medianFederalTax: number;
  medianIncome: number;
}

export interface PredictionRecord {
  timestamp: string;
  planFingerprint: string;
  engineVersion: string;
  inputs: {
    seedData: SeedData;
    assumptions: MarketAssumptions;
  };
  outputs: {
    successRate: number;
    medianEndingWealth: number;
    tenthPercentileEndingWealth: number;
    lifetimeFederalTaxEstimate: number;
    peakMedianAssets: number;
    peakMedianAssetsYear: number;
  };
  yearlyTrajectory: PredictionYearSnapshot[];
}

export interface PredictionLogStore {
  readAll(): PredictionRecord[];
  append(record: PredictionRecord): void;
}

export function createInMemoryPredictionLogStore(
  seed: PredictionRecord[] = [],
): PredictionLogStore {
  const records: PredictionRecord[] = [...seed];
  return {
    readAll() {
      return [...records];
    },
    append(record) {
      records.push(record);
    },
  };
}

// Minimal browser-facing store. Bounded by localStorage capacity (~5MB per
// origin); we cap at 500 records with FIFO eviction to avoid hitting that
// ceiling. Enough for ~1 year of daily evaluations.
const LOCAL_STORAGE_KEY = 'retirement-calc:predictions';
const LOCAL_STORAGE_MAX_RECORDS = 500;

export function createLocalStoragePredictionLogStore(
  storage: Storage,
): PredictionLogStore {
  let cachedRecords: PredictionRecord[] | null = null;
  const loadRecords = () => {
    if (cachedRecords) {
      return cachedRecords;
    }
    const raw = storage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) {
      cachedRecords = [];
      return cachedRecords;
    }
    try {
      cachedRecords = JSON.parse(raw) as PredictionRecord[];
    } catch {
      cachedRecords = [];
    }
    return cachedRecords;
  };

  return {
    readAll() {
      return [...loadRecords()];
    },
    append(record) {
      const existing = loadRecords();
      existing.push(record);
      const trimmed =
        existing.length > LOCAL_STORAGE_MAX_RECORDS
          ? existing.slice(existing.length - LOCAL_STORAGE_MAX_RECORDS)
          : existing;
      cachedRecords = trimmed;
      storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(trimmed));
    },
  };
}

// Simple deterministic hash. Not cryptographic — the goal is "same inputs
// produce the same fingerprint, different inputs produce different
// fingerprints." A 64-bit-ish mixing hash of the JSON is sufficient for
// plan-change detection.
function fnv1a64(input: string): string {
  let hashLow = 0x811c9dc5 >>> 0;
  let hashHigh = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i++) {
    hashLow ^= input.charCodeAt(i);
    hashLow = Math.imul(hashLow, 0x01000193) >>> 0;
    hashHigh = Math.imul(hashHigh ^ hashLow, 0x85ebca6b) >>> 0;
  }
  const toHex = (n: number) => n.toString(16).padStart(8, '0');
  return toHex(hashHigh) + toHex(hashLow);
}

// Plan fingerprint — Step 5 of CALIBRATION_WORKPLAN.md. A short, stable
// hash tied to the exact inputs used for this evaluation, so every actuals
// row can reference "which plan version was current when we predicted this."
export function computePlanFingerprint(
  seedData: SeedData,
  assumptions: MarketAssumptions,
): string {
  // Canonicalize by JSON-stringifying in key order so trivial reorderings
  // don't change the fingerprint.
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((accumulator, key) => {
          accumulator[key] = canonicalize((value as Record<string, unknown>)[key]);
          return accumulator;
        }, {});
    }
    return value;
  };
  const canonical = JSON.stringify({
    seed: canonicalize(seedData),
    assumptions: canonicalize(assumptions),
  });
  return fnv1a64(canonical);
}

// Extract the headline outputs from a PathResult. Kept narrow on purpose —
// the calibration analysis doesn't need the full yearly series, just the
// decision-driving numbers.
export function buildPredictionRecord(
  seedData: SeedData,
  assumptions: MarketAssumptions,
  baselinePath: PathResult,
): PredictionRecord {
  const lifetimeFederalTaxEstimate = baselinePath.yearlySeries.reduce(
    (sum, year) => sum + year.medianFederalTax,
    0,
  );
  const peakYear = baselinePath.yearlySeries.reduce(
    (best, year) => (year.medianAssets > best.medianAssets ? year : best),
    baselinePath.yearlySeries[0] ?? {
      medianAssets: 0,
      year: 0,
    },
  );

  const yearlyTrajectory: PredictionYearSnapshot[] = baselinePath.yearlySeries.map(
    (year) => ({
      year: year.year,
      medianAssets: year.medianAssets,
      medianSpending: year.medianSpending,
      medianFederalTax: year.medianFederalTax,
      medianIncome: year.medianIncome,
    }),
  );

  return {
    timestamp: new Date().toISOString(),
    planFingerprint: computePlanFingerprint(seedData, assumptions),
    engineVersion: assumptions.assumptionsVersion ?? 'unversioned',
    inputs: {
      seedData: JSON.parse(JSON.stringify(seedData)) as SeedData,
      assumptions: { ...assumptions },
    },
    outputs: {
      successRate: baselinePath.successRate,
      medianEndingWealth: baselinePath.medianEndingWealth,
      tenthPercentileEndingWealth: baselinePath.tenthPercentileEndingWealth,
      lifetimeFederalTaxEstimate,
      peakMedianAssets: peakYear?.medianAssets ?? 0,
      peakMedianAssetsYear: peakYear?.year ?? 0,
    },
    yearlyTrajectory,
  };
}

export function logPrediction(
  store: PredictionLogStore,
  record: PredictionRecord,
): void {
  store.append(record);
}
