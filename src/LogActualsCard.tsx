import { useState } from 'react';
import { computePlanFingerprint } from './prediction-log';
import {
  buildAnnualTaxActual,
  buildBalanceSnapshotActual,
  buildMonthlySpendingActual,
  logActual,
  type ActualsRecord,
} from './actuals-log';
import { getActualsStore } from './calibration-stores';
import type { MarketAssumptions, SeedData } from './types';

/**
 * Log-actuals card. The household enters their REAL current balances
 * / spending / taxes; the engine writes them to the actuals log keyed
 * on today's plan fingerprint. The reconciliation layer (already
 * shipped: `src/reconciliation.ts`) joins actuals against the most
 * recent matching prediction and surfaces the drift.
 *
 * Three measurement types in one card:
 *   1. Balance snapshot (account balances on a given date)
 *   2. Monthly spending (essential / optional / healthcare for a month)
 *   3. Annual federal tax paid (from the 1040)
 *
 * V1 UX: tabs for the three measurement types; each tab is a small
 * form. Future enhancement: import-from-Fidelity / from-bank flow.
 *
 * Privacy: nothing leaves the device. localStorage only.
 */

type ActualKind = 'balance' | 'spending' | 'tax';

export function LogActualsCard({
  data,
  assumptions,
}: {
  data: SeedData | null;
  assumptions: MarketAssumptions | null;
}) {
  const [kind, setKind] = useState<ActualKind>('balance');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Balance snapshot fields
  const todayIso = new Date().toISOString().slice(0, 10);
  const [asOfDate, setAsOfDate] = useState(todayIso);
  const [pretax, setPretax] = useState('');
  const [roth, setRoth] = useState('');
  const [taxable, setTaxable] = useState('');
  const [cash, setCash] = useState('');
  const [hsa, setHsa] = useState('');

  // Monthly spending fields
  const thisMonth = todayIso.slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [essentialSpent, setEssentialSpent] = useState('');
  const [optionalSpent, setOptionalSpent] = useState('');
  const [healthcareSpent, setHealthcareSpent] = useState('');

  // Annual tax fields
  const [taxYear, setTaxYear] = useState(`${new Date().getFullYear() - 1}`);
  const [federalTaxPaid, setFederalTaxPaid] = useState('');
  const [taxNotes, setTaxNotes] = useState('');

  const handleSave = () => {
    if (!data || !assumptions) {
      setError('Plan not loaded');
      return;
    }
    setError(null);
    try {
      const fp = computePlanFingerprint(data, assumptions);
      const num = (s: string): number | undefined => {
        const v = Number(s.replace(/[$,]/g, ''));
        return Number.isFinite(v) ? v : undefined;
      };
      let measurement: ActualsRecord['measurement'];
      if (kind === 'balance') {
        if (
          !num(pretax) &&
          !num(roth) &&
          !num(taxable) &&
          !num(cash) &&
          !num(hsa)
        ) {
          setError('Enter at least one balance');
          return;
        }
        measurement = buildBalanceSnapshotActual({
          asOfDate,
          pretax: num(pretax),
          roth: num(roth),
          taxable: num(taxable),
          cash: num(cash),
          hsa: num(hsa),
        });
      } else if (kind === 'spending') {
        const ess = num(essentialSpent);
        const opt = num(optionalSpent);
        if (ess === undefined && opt === undefined) {
          setError('Enter essential or optional spend');
          return;
        }
        measurement = buildMonthlySpendingActual({
          month,
          essentialSpent: ess ?? 0,
          optionalSpent: opt ?? 0,
          healthcareSpent: num(healthcareSpent),
        });
      } else {
        const ftp = num(federalTaxPaid);
        const ty = Number(taxYear);
        if (!Number.isFinite(ty) || ftp === undefined) {
          setError('Enter year + tax paid');
          return;
        }
        measurement = buildAnnualTaxActual({
          taxYear: ty,
          federalTaxPaid: ftp,
          notes: taxNotes || undefined,
        });
      }
      logActual(getActualsStore(), {
        capturedAt: new Date().toISOString(),
        planFingerprintAtCapture: fp,
        measurement,
      });
      setSavedAt(new Date().toLocaleTimeString());
      // Clear inputs after a successful save (keep dates).
      setPretax('');
      setRoth('');
      setTaxable('');
      setCash('');
      setHsa('');
      setEssentialSpent('');
      setOptionalSpent('');
      setHealthcareSpent('');
      setFederalTaxPaid('');
      setTaxNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  };

  const tabClass = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
      active
        ? 'bg-stone-900 text-white'
        : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
    }`;

  return (
    <div className="rounded-2xl border border-stone-200 bg-white/70 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">
            Log actuals · calibration
          </p>
          <p className="mt-1 text-[12px] text-stone-600">
            Enter what really happened — balances, spending, taxes. The
            engine compares to its prediction and surfaces drift in the
            Calibration Dashboard.
          </p>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setKind('balance')}
            className={tabClass(kind === 'balance')}
          >
            Balances
          </button>
          <button
            type="button"
            onClick={() => setKind('spending')}
            className={tabClass(kind === 'spending')}
          >
            Spending
          </button>
          <button
            type="button"
            onClick={() => setKind('tax')}
            className={tabClass(kind === 'tax')}
          >
            Taxes
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-[12px]">
        {kind === 'balance' && (
          <>
            <label className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-stone-500">As of</span>
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 tabular-nums"
              />
            </label>
            {(
              [
                ['Pretax / 401k', pretax, setPretax],
                ['Roth', roth, setRoth],
                ['Taxable', taxable, setTaxable],
                ['Cash', cash, setCash],
                ['HSA', hsa, setHsa],
              ] as const
            ).map(([label, val, setter]) => (
              <label
                key={label}
                className="grid grid-cols-[120px_1fr] items-center gap-2"
              >
                <span className="text-stone-500">{label}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="$"
                  value={val}
                  onChange={(e) => setter(e.target.value)}
                  className="rounded border border-stone-300 px-2 py-1 tabular-nums"
                />
              </label>
            ))}
          </>
        )}
        {kind === 'spending' && (
          <>
            <label className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-stone-500">Month</span>
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 tabular-nums"
              />
            </label>
            {(
              [
                ['Essential', essentialSpent, setEssentialSpent],
                ['Optional', optionalSpent, setOptionalSpent],
                ['Healthcare', healthcareSpent, setHealthcareSpent],
              ] as const
            ).map(([label, val, setter]) => (
              <label
                key={label}
                className="grid grid-cols-[120px_1fr] items-center gap-2"
              >
                <span className="text-stone-500">{label}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="$"
                  value={val}
                  onChange={(e) => setter(e.target.value)}
                  className="rounded border border-stone-300 px-2 py-1 tabular-nums"
                />
              </label>
            ))}
          </>
        )}
        {kind === 'tax' && (
          <>
            <label className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-stone-500">Tax year</span>
              <input
                type="number"
                value={taxYear}
                onChange={(e) => setTaxYear(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 tabular-nums"
              />
            </label>
            <label className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-stone-500">Federal tax paid</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="$"
                value={federalTaxPaid}
                onChange={(e) => setFederalTaxPaid(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 tabular-nums"
              />
            </label>
            <label className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-stone-500">Notes</span>
              <input
                type="text"
                value={taxNotes}
                onChange={(e) => setTaxNotes(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1"
              />
            </label>
          </>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-emerald-700"
        >
          Log actuals
        </button>
        {savedAt && (
          <span className="text-[11px] text-emerald-700">
            Saved at {savedAt}
          </span>
        )}
        {error && <span className="text-[11px] text-rose-700">{error}</span>}
      </div>
    </div>
  );
}
