import {
  createInMemoryActualsLogStore,
  createLocalStorageActualsLogStore,
  type ActualsLogStore,
} from './actuals-log';
import {
  createInMemoryPredictionLogStore,
  createLocalStoragePredictionLogStore,
  type PredictionLogStore,
} from './prediction-log';

/**
 * App-level singletons for the prediction + actuals logs. Both are
 * localStorage-backed when running in the browser; both fall back to
 * in-memory when localStorage isn't available (SSR / tests / private
 * browsing).
 *
 * Why singletons: the household runs the app for years; the calibration
 * value lives in the LONG tail (see CALIBRATION_WORKPLAN). One store
 * per app load, lazily initialized, persists across React re-mounts.
 *
 * The infrastructure (prediction-log.ts, actuals-log.ts, reconciliation.ts,
 * DeltaDashboardTile.tsx) was already built earlier in the sprint; this
 * module is the missing wire-up that makes them actually accumulate data.
 */

let cachedPredictionStore: PredictionLogStore | null = null;
let cachedActualsStore: ActualsLogStore | null = null;

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    if (!window.localStorage) return null;
    // Sniff for private-browsing where setItem throws.
    const probeKey = '__calibration_stores_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPredictionStore(): PredictionLogStore {
  if (cachedPredictionStore) return cachedPredictionStore;
  const ls = safeLocalStorage();
  cachedPredictionStore = ls
    ? createLocalStoragePredictionLogStore(ls)
    : createInMemoryPredictionLogStore();
  return cachedPredictionStore;
}

export function getActualsStore(): ActualsLogStore {
  if (cachedActualsStore) return cachedActualsStore;
  const ls = safeLocalStorage();
  cachedActualsStore = ls
    ? createLocalStorageActualsLogStore(ls)
    : createInMemoryActualsLogStore();
  return cachedActualsStore;
}

/**
 * Reset the cached stores. Test-only; production never calls this.
 */
export function __testOnly_resetStores(): void {
  cachedPredictionStore = null;
  cachedActualsStore = null;
}
