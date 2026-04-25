import type {
  MiningStats,
  PolicyEvaluation,
} from './policy-miner-types';

/**
 * Policy mining corpus — IndexedDB store of evaluated policies.
 *
 * Schema layout (one DB, two object stores):
 *   - 'evaluations': key = `${baselineFingerprint}:${policy id}`, value = PolicyEvaluation
 *     Indexed by [baselineFingerprint, engineVersion] so the ranking layer
 *     can pull "all policies for this household, this engine build" in one
 *     range scan.
 *   - 'stats': key = baselineFingerprint, value = MiningStats
 *     One row per baseline. The miner overwrites on every update so the
 *     UI panel sees live progress on reload.
 *
 * Versioning policy:
 *   - The IDB schema version (DB_VERSION) bumps only when the object-store
 *     shape changes (new index, new store). Pure data-shape changes within
 *     a record bump CORPUS_SCHEMA_VERSION instead — that gates record
 *     reads in `loadEvaluation` and silently filters out pre-bump rows.
 *   - The engine semantics version (engineVersion in each record) is the
 *     finest-grained kill switch: a tax-table update or rounding fix
 *     should bump engineVersion in the caller, which makes the ranking
 *     layer ignore stale records without dropping them — a future
 *     migration could re-evaluate them in the background.
 *
 * Why not just throw the corpus into localStorage? The cap (~5MB) doesn't
 * fit even a few hundred records, and localStorage is sync — every write
 * blocks the main thread. IndexedDB is async, structured-cloned, and has
 * a soft cap in the hundreds of MB on Chrome/Safari/Firefox.
 */

const DB_NAME = 'retirement-policy-corpus';
const DB_VERSION = 1;
const EVALUATIONS_STORE = 'evaluations';
const STATS_STORE = 'stats';
const CORPUS_SCHEMA_VERSION = 1;

interface StoredEvaluation extends PolicyEvaluation {
  /** Composite key written into the value as well as the IDB key. */
  storageKey: string;
  schemaVersion: number;
}

interface StoredStats extends MiningStats {
  baselineFingerprint: string;
  schemaVersion: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EVALUATIONS_STORE)) {
        const store = db.createObjectStore(EVALUATIONS_STORE, {
          keyPath: 'storageKey',
        });
        // Range queries by baseline + engine version. Note: the index key
        // is a composite array, which IDB supports natively for
        // multi-column equality scans.
        store.createIndex('byBaselineEngine', [
          'baselineFingerprint',
          'engineVersion',
        ]);
      }
      if (!db.objectStoreNames.contains(STATS_STORE)) {
        db.createObjectStore(STATS_STORE, { keyPath: 'baselineFingerprint' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeStorageKey(baselineFingerprint: string, evaluationId: string): string {
  return `${baselineFingerprint}::${evaluationId}`;
}

export async function saveEvaluation(evaluation: PolicyEvaluation): Promise<void> {
  const db = await openDb();
  const stored: StoredEvaluation = {
    ...evaluation,
    storageKey: makeStorageKey(evaluation.baselineFingerprint, evaluation.id),
    schemaVersion: CORPUS_SCHEMA_VERSION,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(EVALUATIONS_STORE, 'readwrite');
    tx.objectStore(EVALUATIONS_STORE).put(stored);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Bulk save — used by the miner to flush a batch of completed policies in
 * a single transaction. Faster and more durable than N saveEvaluation calls.
 */
export async function saveEvaluationsBatch(
  evaluations: PolicyEvaluation[],
): Promise<void> {
  if (evaluations.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(EVALUATIONS_STORE, 'readwrite');
    const store = tx.objectStore(EVALUATIONS_STORE);
    for (const ev of evaluations) {
      const stored: StoredEvaluation = {
        ...ev,
        storageKey: makeStorageKey(ev.baselineFingerprint, ev.id),
        schemaVersion: CORPUS_SCHEMA_VERSION,
      };
      store.put(stored);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadEvaluation(
  baselineFingerprint: string,
  evaluationId: string,
): Promise<PolicyEvaluation | null> {
  const db = await openDb();
  const stored = await new Promise<StoredEvaluation | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(EVALUATIONS_STORE, 'readonly');
      const req = tx
        .objectStore(EVALUATIONS_STORE)
        .get(makeStorageKey(baselineFingerprint, evaluationId));
      req.onsuccess = () =>
        resolve(req.result as StoredEvaluation | undefined);
      req.onerror = () => reject(req.error);
    },
  );
  if (!stored) return null;
  if ((stored.schemaVersion ?? 0) !== CORPUS_SCHEMA_VERSION) return null;
  // Strip the storage-only fields before returning.
  const { storageKey: _key, schemaVersion: _v, ...rest } = stored;
  return rest;
}

/**
 * Load every evaluation for a given baseline + engine version. The ranking
 * layer calls this once on session start and then incrementally as the
 * miner emits new records. We filter out off-version records here rather
 * than in the caller so the corpus quietly self-cleans.
 */
export async function loadEvaluationsForBaseline(
  baselineFingerprint: string,
  engineVersion: string,
): Promise<PolicyEvaluation[]> {
  const db = await openDb();
  return new Promise<PolicyEvaluation[]>((resolve, reject) => {
    const tx = db.transaction(EVALUATIONS_STORE, 'readonly');
    const index = tx.objectStore(EVALUATIONS_STORE).index('byBaselineEngine');
    const range = IDBKeyRange.only([baselineFingerprint, engineVersion]);
    const req = index.getAll(range);
    req.onsuccess = () => {
      const all = (req.result ?? []) as StoredEvaluation[];
      const fresh = all
        .filter((row) => (row.schemaVersion ?? 0) === CORPUS_SCHEMA_VERSION)
        .map(({ storageKey: _k, schemaVersion: _v, ...rest }) => rest);
      resolve(fresh);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete every record tied to a baseline. Called when the household edits
 * SeedData and the old records are no longer comparable. Cheap to run
 * because the index lookup gives us the keys directly.
 */
export async function clearBaseline(baselineFingerprint: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(EVALUATIONS_STORE, 'readwrite');
    const store = tx.objectStore(EVALUATIONS_STORE);
    const index = store.index('byBaselineEngine');
    // We don't know which engine versions exist — open a cursor over
    // every record matching the baseline regardless of engine version.
    // Composite-array indexes support this via a range with a wildcard
    // upper bound on the second element.
    const range = IDBKeyRange.bound(
      [baselineFingerprint, ''],
      [baselineFingerprint, '\uffff'],
    );
    const cursorReq = index.openKeyCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveMiningStats(
  baselineFingerprint: string,
  stats: MiningStats,
): Promise<void> {
  const db = await openDb();
  const stored: StoredStats = {
    ...stats,
    baselineFingerprint,
    schemaVersion: CORPUS_SCHEMA_VERSION,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STATS_STORE, 'readwrite');
    tx.objectStore(STATS_STORE).put(stored);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadMiningStats(
  baselineFingerprint: string,
): Promise<MiningStats | null> {
  const db = await openDb();
  const stored = await new Promise<StoredStats | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(STATS_STORE, 'readonly');
      const req = tx.objectStore(STATS_STORE).get(baselineFingerprint);
      req.onsuccess = () => resolve(req.result as StoredStats | undefined);
      req.onerror = () => reject(req.error);
    },
  );
  if (!stored) return null;
  if ((stored.schemaVersion ?? 0) !== CORPUS_SCHEMA_VERSION) return null;
  const { baselineFingerprint: _bf, schemaVersion: _v, ...rest } = stored;
  return rest;
}

/**
 * Wipe the entire corpus. Used by the "rebuild from scratch" affordance
 * in the dev panel and by the app's reset-state flow.
 */
export async function clearCorpus(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([EVALUATIONS_STORE, STATS_STORE], 'readwrite');
    tx.objectStore(EVALUATIONS_STORE).clear();
    tx.objectStore(STATS_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
