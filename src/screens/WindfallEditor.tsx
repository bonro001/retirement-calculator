import { useState } from 'react';
import { useAppStore } from '../store';
import type { WindfallEntry, WindfallTaxTreatment } from '../types';
import { formatCurrency } from '../utils';

const TAX_TREATMENT_OPTIONS: Array<{ value: WindfallTaxTreatment; label: string }> = [
  { value: 'cash_non_taxable', label: 'Tax-free (gift / qualified inheritance)' },
  { value: 'ordinary_income', label: 'Ordinary income (severance, etc.)' },
  { value: 'ltcg', label: 'Long-term capital gain' },
  { value: 'primary_home_sale', label: 'Primary home sale' },
  { value: 'inherited_ira_10y', label: 'Inherited IRA (10-year)' },
];

const DEFAULT_GROWTH_RATE_PERCENT = 4;

interface DraftState {
  name: string;
  year: string;
  amount: string;
  growthRatePercent: string;
  taxTreatment: WindfallTaxTreatment;
}

const EMPTY_DRAFT: DraftState = {
  name: '',
  year: String(new Date().getFullYear()),
  amount: '',
  growthRatePercent: String(DEFAULT_GROWTH_RATE_PERCENT),
  taxTreatment: 'cash_non_taxable',
};

export function WindfallEditor() {
  const windfalls = useAppStore((state) => state.data.income.windfalls);
  const updateIncome = useAppStore((state) => state.updateIncome);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const handleAdd = () => {
    const year = Number.parseInt(draft.year, 10);
    const amount = Number.parseFloat(draft.amount.replace(/[$,]/g, ''));
    const growthRatePercent = Number.parseFloat(draft.growthRatePercent);
    if (!Number.isFinite(year) || !Number.isFinite(amount) || amount <= 0) return;
    const trimmedName = draft.name.trim();
    const entry: WindfallEntry = {
      name: trimmedName.length > 0 ? trimmedName : `windfall_${windfalls.length + 1}`,
      year,
      amount,
      taxTreatment: draft.taxTreatment,
      certainty: 'estimated',
      ...(Number.isFinite(growthRatePercent) && growthRatePercent !== 0
        ? { presentValueGrowthRate: growthRatePercent / 100 }
        : {}),
    };
    updateIncome('windfalls', [...windfalls, entry]);
    setDraft(EMPTY_DRAFT);
  };

  const handleDelete = (index: number) => {
    const next = windfalls.slice();
    next.splice(index, 1);
    updateIncome('windfalls', next);
  };

  return (
    <div className="rounded-[28px] bg-stone-100/85 p-5">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.18em] text-stone-500">
            Windfalls
          </p>
          <h3 className="mt-1 text-2xl font-semibold text-stone-900">
            One-time inflows
          </h3>
        </div>
        <p className="max-w-[260px] text-xs text-stone-500">
          Gifts, inheritance, severance, home sale. Amount is in today's
          dollars. Optional growth rate compounds the amount until the
          year it lands — useful when the funds are invested elsewhere
          while waiting.
        </p>
      </header>

      <div className="space-y-2">
        {windfalls.length === 0 ? (
          <p className="text-sm text-stone-500">No windfalls yet. Add one below.</p>
        ) : (
          windfalls.map((entry, index) => (
            <div
              key={`${entry.name}-${entry.year}-${index}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/80 px-4 py-3 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium text-stone-900">
                  {entry.name.replaceAll('_', ' ')}
                </span>
                <span className="text-xs text-stone-500">
                  {entry.year} · {formatCurrency(entry.amount)} (today's $)
                  {entry.presentValueGrowthRate != null
                    ? ` · grows ${(entry.presentValueGrowthRate * 100).toFixed(1)}%/yr`
                    : ''}
                  {entry.taxTreatment != null && entry.taxTreatment !== 'cash_non_taxable'
                    ? ` · ${entry.taxTreatment.replaceAll('_', ' ')}`
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

      <div className="mt-5 grid gap-3 rounded-xl border border-stone-200 bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <label className="flex flex-col gap-1 text-xs text-stone-600 sm:col-span-2">
          <span>Name</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Gift from FIL"
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-stone-600">
          <span>Year</span>
          <input
            type="number"
            value={draft.year}
            onChange={(e) => setDraft((prev) => ({ ...prev, year: e.target.value }))}
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900 tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-stone-600">
          <span>Amount (today's $)</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) => setDraft((prev) => ({ ...prev, amount: e.target.value }))}
            placeholder="20000"
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900 tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-stone-600">
          <span>Growth %/yr</span>
          <input
            type="number"
            step="0.1"
            value={draft.growthRatePercent}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, growthRatePercent: e.target.value }))
            }
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900 tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-stone-600 sm:col-span-2 lg:col-span-6">
          <span>Tax treatment</span>
          <select
            value={draft.taxTreatment}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                taxTreatment: e.target.value as WindfallTaxTreatment,
              }))
            }
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900"
          >
            {TAX_TREATMENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-2 lg:col-span-6">
          <button
            type="button"
            onClick={handleAdd}
            disabled={
              !Number.isFinite(Number.parseFloat(draft.amount.replace(/[$,]/g, ''))) ||
              !Number.isFinite(Number.parseInt(draft.year, 10))
            }
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:bg-stone-300 disabled:text-stone-500"
          >
            Add windfall
          </button>
        </div>
      </div>
    </div>
  );
}
