// Append-only log of REALIZED outcomes: actual account balances,
// actual monthly spending, actual annual federal tax paid. Mirror of
// src/prediction-log.ts. Together they're the raw material for
// reconciliation — comparing what the engine predicted at time T vs what
// actually happened at T+N.
//
// CALIBRATION_WORKPLAN steps 2 (monthly spending capture), 4 (balance
// snapshot log), and 5's integration point (each actuals row carries the
// plan fingerprint that was current at the time of the observation).
//
// Store is pluggable (in-memory + localStorage) to match the prediction
// log. Future step can swap in a Node file-backed store when the app
// gains a companion CLI / server.

export interface BalanceSnapshotActual {
  kind: 'balance_snapshot';
  asOfDate: string; // ISO date (YYYY-MM-DD)
  balances: {
    pretax?: number;
    roth?: number;
    taxable?: number;
    cash?: number;
    hsa?: number;
  };
  totalBalance: number;
}

export interface MonthlySpendingActual {
  kind: 'monthly_spending';
  month: string; // YYYY-MM
  essentialSpent: number;
  optionalSpent: number;
  healthcareSpent?: number;
  totalSpent: number;
}

export interface AnnualTaxActual {
  kind: 'annual_tax';
  taxYear: number;
  federalTaxPaid: number; // from the user's 1040
  notes?: string;
}

export interface LifeEventActual {
  kind: 'life_event';
  eventDate: string; // ISO date
  category: 'unplanned_medical' | 'gift' | 'windfall' | 'property' | 'other';
  amountSigned: number; // positive = inflow, negative = outflow
  description: string;
}

export type ActualsMeasurement =
  | BalanceSnapshotActual
  | MonthlySpendingActual
  | AnnualTaxActual
  | LifeEventActual;

export interface ActualsRecord {
  capturedAt: string; // ISO timestamp
  // Plan fingerprint that was current at the time of the measurement.
  // Lets the reconciliation layer distinguish "model error" from "user
  // changed the plan in between prediction and this observation."
  planFingerprintAtCapture: string;
  measurement: ActualsMeasurement;
}

export interface ActualsLogStore {
  readAll(): ActualsRecord[];
  append(record: ActualsRecord): void;
}

export function createInMemoryActualsLogStore(
  seed: ActualsRecord[] = [],
): ActualsLogStore {
  const records: ActualsRecord[] = [...seed];
  return {
    readAll() {
      return [...records];
    },
    append(record) {
      records.push(record);
    },
  };
}

const LOCAL_STORAGE_KEY = 'retirement-calc:actuals';
const LOCAL_STORAGE_MAX_RECORDS = 2000;

export function createLocalStorageActualsLogStore(
  storage: Storage,
): ActualsLogStore {
  return {
    readAll() {
      const raw = storage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return [];
      try {
        return JSON.parse(raw) as ActualsRecord[];
      } catch {
        return [];
      }
    },
    append(record) {
      const existing = this.readAll();
      existing.push(record);
      const trimmed =
        existing.length > LOCAL_STORAGE_MAX_RECORDS
          ? existing.slice(existing.length - LOCAL_STORAGE_MAX_RECORDS)
          : existing;
      storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(trimmed));
    },
  };
}

export function logActual(store: ActualsLogStore, record: ActualsRecord): void {
  store.append(record);
}

// Helpers for constructing common measurements with a consistent shape.
// Keeps callers from having to remember every field.

export function buildBalanceSnapshotActual(input: {
  asOfDate: string;
  pretax?: number;
  roth?: number;
  taxable?: number;
  cash?: number;
  hsa?: number;
}): BalanceSnapshotActual {
  const pretax = input.pretax ?? 0;
  const roth = input.roth ?? 0;
  const taxable = input.taxable ?? 0;
  const cash = input.cash ?? 0;
  const hsa = input.hsa ?? 0;
  return {
    kind: 'balance_snapshot',
    asOfDate: input.asOfDate,
    balances: { pretax, roth, taxable, cash, hsa },
    totalBalance: pretax + roth + taxable + cash + hsa,
  };
}

export function buildMonthlySpendingActual(input: {
  month: string;
  essentialSpent: number;
  optionalSpent: number;
  healthcareSpent?: number;
}): MonthlySpendingActual {
  const healthcare = input.healthcareSpent ?? 0;
  return {
    kind: 'monthly_spending',
    month: input.month,
    essentialSpent: input.essentialSpent,
    optionalSpent: input.optionalSpent,
    healthcareSpent: healthcare,
    totalSpent: input.essentialSpent + input.optionalSpent + healthcare,
  };
}

export function buildAnnualTaxActual(input: {
  taxYear: number;
  federalTaxPaid: number;
  notes?: string;
}): AnnualTaxActual {
  return {
    kind: 'annual_tax',
    taxYear: input.taxYear,
    federalTaxPaid: input.federalTaxPaid,
    notes: input.notes,
  };
}

export function buildLifeEventActual(input: {
  eventDate: string;
  category: LifeEventActual['category'];
  amountSigned: number;
  description: string;
}): LifeEventActual {
  return {
    kind: 'life_event',
    eventDate: input.eventDate,
    category: input.category,
    amountSigned: input.amountSigned,
    description: input.description,
  };
}
