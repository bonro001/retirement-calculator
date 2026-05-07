import { useState } from 'react';
import { useAppStore } from '../store';
import type { WindfallEntry } from '../types';
import { formatCurrency } from '../utils';

interface DraftState {
  label: string;
  year: string;
  amount: string;
}

function currentYear(): number {
  return new Date().getFullYear();
}

function emptyDraft(): DraftState {
  return {
    label: '',
    year: String(currentYear()),
    amount: '',
  };
}

function parseCurrencyInput(value: string): number {
  return Number.parseFloat(value.replace(/[$,]/g, ''));
}

function buildWindfallName(label: string, year: number, windfalls: WindfallEntry[]) {
  const stem =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `cash_${year}`;
  const names = new Set(windfalls.map((entry) => entry.name));
  let candidate = stem;
  let suffix = 2;
  while (names.has(candidate)) {
    candidate = `${stem}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function formatWindfallName(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function estimateWindfallLiquidity(entry: WindfallEntry): number {
  if (typeof entry.liquidityAmount === 'number') {
    return Math.max(0, entry.liquidityAmount);
  }
  if (entry.name !== 'home_sale') {
    return Math.max(0, entry.amount);
  }
  const gross = Math.max(0, entry.amount);
  const sellingCost = gross * Math.max(0, Math.min(1, entry.sellingCostPercent ?? 0));
  const replacementHomeCost = Math.max(0, entry.replacementHomeCost ?? 0);
  const replacementCost =
    replacementHomeCost +
    replacementHomeCost * Math.max(0, Math.min(1, entry.purchaseClosingCostPercent ?? 0)) +
    Math.max(0, entry.movingCost ?? 0);
  return Math.max(0, gross - sellingCost - replacementCost);
}

export function WindfallEditor() {
  const windfalls = useAppStore((state) => state.data.income.windfalls);
  const updateIncome = useAppStore((state) => state.updateIncome);
  const [draft, setDraft] = useState<DraftState>(() => emptyDraft());

  const parsedYear = Number.parseInt(draft.year, 10);
  const parsedAmount = parseCurrencyInput(draft.amount);
  const canAdd =
    Number.isFinite(parsedYear) &&
    parsedYear >= currentYear() &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0;

  const handleAdd = () => {
    if (!canAdd) return;
    const entry: WindfallEntry = {
      name: buildWindfallName(draft.label, parsedYear, windfalls),
      year: parsedYear,
      amount: parsedAmount,
      liquidityAmount: parsedAmount,
      taxTreatment: 'cash_non_taxable',
      certainty: 'estimated',
    };
    updateIncome('windfalls', [...windfalls, entry]);
    setDraft(emptyDraft());
  };

  const handleDelete = (index: number) => {
    const next = windfalls.slice();
    next.splice(index, 1);
    updateIncome('windfalls', next);
  };

  return (
    <div className="rounded-[28px] bg-stone-100/85 p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm uppercase tracking-[0.18em] text-stone-500">
            Windfalls
          </p>
          <h3 className="mt-1 text-2xl font-semibold text-stone-900">
            Simple cash events
          </h3>
        </div>
        <p className="max-w-[320px] text-xs text-stone-500">
          Add bonuses, gifts, inheritance, or other incoming cash as net
          after-tax dollars in today's value. The model treats each entry
          as cash when it lands.
        </p>
      </header>

      <div className="space-y-2">
        {windfalls.length === 0 ? (
          <p className="text-sm text-stone-500">
            No cash events yet. Add one below.
          </p>
        ) : (
          windfalls.map((entry, index) => (
            <div
              key={`${entry.name}-${entry.year}-${index}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/80 px-4 py-3 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium text-stone-900">
                  {formatWindfallName(entry.name)}
                </span>
                <span className="text-xs text-stone-500">
                  {entry.year} · {formatCurrency(estimateWindfallLiquidity(entry))} net cash
                  {entry.amount !== estimateWindfallLiquidity(entry)
                    ? ` · ${formatCurrency(entry.amount)} gross seed`
                    : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(index)}
                className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-600 hover:border-red-300 hover:text-red-600"
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>

      <div className="mt-5 grid gap-3 rounded-xl border border-stone-200 bg-white/60 p-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-stone-600">
          <span>Label</span>
          <input
            type="text"
            value={draft.label}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, label: e.target.value }))
            }
            placeholder="Bonus"
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-stone-600">
          <span>Year</span>
          <input
            type="number"
            min={currentYear()}
            step={1}
            value={draft.year}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, year: e.target.value }))
            }
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900 tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-stone-600">
          <span>Net amount</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, amount: e.target.value }))
            }
            placeholder="25000"
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900 tabular-nums"
          />
        </label>
        <div className="sm:col-span-3">
          <button
            type="button"
            onClick={handleAdd}
            disabled={!canAdd}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:bg-stone-300 disabled:text-stone-500"
          >
            Add cash event
          </button>
        </div>
      </div>
    </div>
  );
}
