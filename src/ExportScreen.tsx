/**
 * Export screen — renders the JSON snapshot of the planning state for
 * external runners (LLM advisors, simulators, audits).
 *
 * Extracted from App.tsx as the first lazy-loaded room: the household
 * rarely opens this surface, so paying for the planning-export worker
 * URL plus 240+ lines of UI on first paint is wasteful. Wrapped in a
 * Suspense boundary at the call site (App.tsx, currentScreen === 'export').
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from './ui-primitives';
import { useAppStore } from './store';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import {
  PLANNING_EXPORT_CACHE_VERSION,
  buildPlanningStateExportWithResolvedContext,
  type PlanningStateExport,
} from './planning-export';
import type {
  PlanningExportWorkerRequest,
  PlanningExportWorkerResponse,
} from './planning-export-worker-types';
import { buildPathResults } from './utils';
import type {
  AccountBucket,
  AccountBucketType,
  PathYearResult,
  SeedData,
} from './types';

// Module-scoped cache + request ID prefix. Lives here (not in App.tsx)
// because nothing else reads them — extracting them with the screen keeps
// related code colocated and lets the worker code-split naturally.
const EXPORT_REQUEST_PREFIX = 'planning-export-request';
const exportPayloadCache = new Map<string, PlanningStateExport>();

/**
 * Year-by-year audit columns. Order is "narrative" (identity → income →
 * spend → tax → decisions → withdrawals → balances) so a CPA reading
 * left-to-right gets the household's story rather than alphabet soup.
 *
 * `key` matches a field on `PathYearResult` (or a derivation); `label`
 * is the friendly column name; `format` controls CSV vs HTML rendering.
 */
type AuditCellFormat = 'currency' | 'percent_or_dash' | 'string' | 'integer';
interface AuditColumn {
  key: string;
  label: string;
  format: AuditCellFormat;
  /** Optional derivation when the value isn't a direct field on the
   *  yearly row (e.g. computed age, derived SS income). */
  derive?: (yr: PathYearResult, ctx: AuditContext) => number | string;
  /** Optional direct field selector for dollar/numeric metrics. */
  pick?: (yr: PathYearResult) => number;
}
interface AuditContext {
  robBirthYear: number;
  debbieBirthYear: number;
}

const AUDIT_COLUMNS: AuditColumn[] = [
  // Identity
  { key: 'year', label: 'Year', format: 'integer', pick: (y) => y.year },
  {
    key: 'rob_age',
    label: 'Rob age',
    format: 'integer',
    derive: (y, ctx) => y.year - ctx.robBirthYear,
  },
  {
    key: 'debbie_age',
    label: 'Debbie age',
    format: 'integer',
    derive: (y, ctx) => y.year - ctx.debbieBirthYear,
  },
  // Income
  { key: 'salary', label: 'Salary (adj wages)', format: 'currency', pick: (y) => y.medianAdjustedWages },
  { key: 'social_security', label: 'Social Security', format: 'currency', pick: (y) => y.medianSocialSecurityIncome },
  { key: 'social_security_rob', label: '· SS Rob', format: 'currency', pick: (y) => y.medianSocialSecurityRob },
  { key: 'social_security_debbie', label: '· SS Debbie', format: 'currency', pick: (y) => y.medianSocialSecurityDebbie },
  { key: 'social_security_inflation_index', label: '· SS inflation index', format: 'string', derive: (y) => y.medianSocialSecurityInflationIndex.toFixed(4) },
  { key: 'windfall_cash', label: 'Windfall cash', format: 'currency', pick: (y) => y.medianWindfallCashInflow },
  { key: 'income_total', label: 'Income total', format: 'currency', pick: (y) => y.medianIncome },
  // Spending
  { key: 'spend_total', label: 'Spend total', format: 'currency', pick: (y) => y.medianSpending },
  { key: 'spend_aca_gross', label: '· Gross ACA premium', format: 'currency', pick: (y) => y.medianAcaPremiumEstimate },
  { key: 'spend_aca_subsidy', label: '· ACA subsidy', format: 'currency', pick: (y) => y.medianAcaSubsidyEstimate },
  { key: 'spend_aca_net', label: '· Net ACA cost', format: 'currency', pick: (y) => y.medianNetAcaCost },
  { key: 'spend_medicare', label: '· Medicare premium', format: 'currency', pick: (y) => y.medianMedicarePremiumEstimate },
  { key: 'spend_irmaa', label: '· IRMAA surcharge', format: 'currency', pick: (y) => y.medianIrmaaSurcharge },
  { key: 'spend_ltc', label: '· LTC cost', format: 'currency', pick: (y) => y.medianLtcCost },
  { key: 'spend_hsa_offset', label: '· HSA offset', format: 'currency', pick: (y) => y.medianHsaOffsetUsed },
  // Tax
  { key: 'fed_tax', label: 'Federal tax', format: 'currency', pick: (y) => y.medianFederalTax },
  { key: 'total_cash_outflow', label: 'Spend + federal tax', format: 'currency', pick: (y) => y.medianTotalCashOutflow },
  { key: 'taxable_income', label: 'Taxable income', format: 'currency', pick: (y) => y.medianTaxableIncome },
  { key: 'magi', label: 'MAGI', format: 'currency', pick: (y) => y.medianMagi },
  { key: 'irmaa_tier', label: 'IRMAA tier', format: 'string', derive: (y) => y.dominantIrmaaTier ?? '' },
  // Decisions
  { key: 'roth_conversion', label: 'Roth conversion', format: 'currency', pick: (y) => y.medianRothConversion },
  { key: 'rmd', label: 'RMD forced', format: 'currency', pick: (y) => y.medianRmdAmount },
  // Contributions (working years)
  { key: 'employee_401k', label: '401k employee', format: 'currency', pick: (y) => y.medianEmployee401kContribution },
  { key: 'employer_match', label: '401k match', format: 'currency', pick: (y) => y.medianEmployerMatchContribution },
  { key: 'hsa_contribution', label: 'HSA contribution', format: 'currency', pick: (y) => y.medianHsaContribution },
  // Withdrawals
  { key: 'withdraw_pretax', label: 'Withdraw pretax', format: 'currency', pick: (y) => y.medianWithdrawalIra401k },
  { key: 'withdraw_taxable', label: 'Withdraw taxable', format: 'currency', pick: (y) => y.medianWithdrawalTaxable },
  { key: 'withdraw_roth', label: 'Withdraw Roth', format: 'currency', pick: (y) => y.medianWithdrawalRoth },
  { key: 'withdraw_cash', label: 'Withdraw cash', format: 'currency', pick: (y) => y.medianWithdrawalCash },
  { key: 'withdraw_total', label: 'Withdraw total', format: 'currency', pick: (y) => y.medianWithdrawalTotal },
  { key: 'unresolved_gap', label: 'Unresolved funding gap', format: 'currency', pick: (y) => y.medianUnresolvedFundingGap },
  // Balances (end-of-year)
  { key: 'bal_pretax', label: 'Bal pretax', format: 'currency', pick: (y) => y.medianPretaxBalance },
  { key: 'bal_taxable', label: 'Bal taxable', format: 'currency', pick: (y) => y.medianTaxableBalance },
  { key: 'bal_roth', label: 'Bal Roth', format: 'currency', pick: (y) => y.medianRothBalance },
  { key: 'bal_cash', label: 'Bal cash', format: 'currency', pick: (y) => y.medianCashBalance },
  { key: 'bal_total', label: 'Bal total', format: 'currency', pick: (y) => y.medianAssets },
];

/**
 * Build a CSV string from yearly results — fully spreadsheet-compatible
 * (RFC 4180): commas as separators, double-quote any string containing
 * comma/quote/newline, double-quotes escaped by doubling. Currency
 * fields written as raw integers (no $ or commas) so spreadsheet
 * formulas treat them as numbers.
 */
function buildAuditCsv(
  yearlySeries: PathYearResult[],
  ctx: AuditContext,
): string {
  const escape = (cell: string): string => {
    if (/[",\n]/.test(cell)) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  const header = AUDIT_COLUMNS.map((c) => escape(c.label)).join(',');
  const rows = yearlySeries.map((yr) =>
    AUDIT_COLUMNS.map((col) => {
      const raw =
        col.derive != null ? col.derive(yr, ctx) : col.pick ? col.pick(yr) : '';
      if (typeof raw === 'string') return escape(raw);
      return Math.round(raw).toString();
    }).join(','),
  );
  return [header, ...rows].join('\n');
}

function formatAuditCell(
  raw: number | string,
  format: AuditCellFormat,
): string {
  if (typeof raw === 'string') return raw || '—';
  if (!Number.isFinite(raw)) return '—';
  if (format === 'integer') return Math.round(raw).toString();
  if (format === 'currency') {
    if (raw === 0) return '—';
    if (Math.abs(raw) >= 1_000_000)
      return `$${(raw / 1_000_000).toFixed(2)}M`;
    if (Math.abs(raw) >= 1_000) return `$${Math.round(raw / 1_000)}k`;
    return `$${Math.round(raw)}`;
  }
  return raw.toString();
}

/**
 * Account-bucket × asset-class matrix. Rows: pretax (IRA/401k), roth,
 * taxable, cash, hsa. Columns: balance, % of total, plus dollar
 * allocation to each asset class (stocks/bonds/cash equivalents)
 * derived from the bucket's `targetAllocation`.
 *
 * Why this matters for verification:
 *   - A second-opinion tool can sanity-check that essential allocations
 *     (e.g., 70/30 stock/bond at age 60) match expectations.
 *   - The household can confirm the total stock/bond exposure they're
 *     running matches the policy/risk dial they think they've set.
 *   - Tax-location is visible at a glance: stocks-in-Roth is good,
 *     stocks-in-pretax with RMDs incoming is a flag.
 */
type AssetKey = string;

function flattenAllocation(
  alloc: Record<string, number>,
): Map<AssetKey, number> {
  // Allocations may use shorthand like { stocks: 0.7, bonds: 0.3 } or
  // long form like { US_EQUITY: 0.5, INTL_EQUITY: 0.2, BONDS: 0.3 }.
  // Bucket the long-form keys into stocks/bonds/cash for display
  // legibility while preserving the raw breakdown for the CSV.
  const m = new Map<AssetKey, number>();
  for (const [k, v] of Object.entries(alloc ?? {})) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    m.set(k, v);
  }
  return m;
}

function classifyAsset(key: string): 'stocks' | 'bonds' | 'cash' | 'other' {
  const k = key.toLowerCase();
  if (
    k.includes('stock') ||
    k.includes('equity') ||
    k.includes('reit') ||
    k.includes('intl') ||
    k.includes('us_equity')
  ) {
    return 'stocks';
  }
  if (k.includes('bond') || k.includes('fixed') || k.includes('treasury')) {
    return 'bonds';
  }
  if (k.includes('cash') || k.includes('money')) return 'cash';
  return 'other';
}

const BUCKET_ORDER: AccountBucketType[] = [
  'pretax',
  'roth',
  'taxable',
  'cash',
];
const BUCKET_LABELS: Record<AccountBucketType, string> = {
  pretax: 'Pretax (IRA / 401k)',
  roth: 'Roth',
  taxable: 'Taxable',
  cash: 'Cash',
};

function PortfolioCompositionTable({ data }: { data: SeedData }) {
  const rows = useMemo(() => {
    const out: Array<{
      bucket: AccountBucketType | 'hsa';
      label: string;
      balance: number;
      stocks: number;
      bonds: number;
      cash: number;
      other: number;
      rawAllocation: Map<AssetKey, number>;
    }> = [];
    const pushBucket = (
      bucket: AccountBucketType | 'hsa',
      label: string,
      ab: AccountBucket | undefined,
    ) => {
      if (!ab) return;
      const balance = ab.balance ?? 0;
      const allocation = flattenAllocation(ab.targetAllocation ?? {});
      let stocks = 0;
      let bonds = 0;
      let cashDollars = 0;
      let other = 0;
      for (const [k, frac] of allocation) {
        const dollars = balance * frac;
        const cls = classifyAsset(k);
        if (cls === 'stocks') stocks += dollars;
        else if (cls === 'bonds') bonds += dollars;
        else if (cls === 'cash') cashDollars += dollars;
        else other += dollars;
      }
      out.push({
        bucket,
        label,
        balance,
        stocks,
        bonds,
        cash: cashDollars,
        other,
        rawAllocation: allocation,
      });
    };
    for (const b of BUCKET_ORDER) {
      pushBucket(b, BUCKET_LABELS[b], data.accounts[b]);
    }
    if (data.accounts.hsa) {
      pushBucket('hsa', 'HSA', data.accounts.hsa);
    }
    return out;
  }, [data]);

  const totals = useMemo(() => {
    const t = { balance: 0, stocks: 0, bonds: 0, cash: 0, other: 0 };
    for (const r of rows) {
      t.balance += r.balance;
      t.stocks += r.stocks;
      t.bonds += r.bonds;
      t.cash += r.cash;
      t.other += r.other;
    }
    return t;
  }, [rows]);

  const fmt = (n: number): string => {
    if (!Number.isFinite(n) || n === 0) return '—';
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
    return `$${Math.round(n)}`;
  };

  const downloadHoldingsCsv = () => {
    // Two-section CSV: top half is the bucket × asset matrix; bottom
    // half is per-source-account, per-holding detail. Spreadsheets
    // open it as a single sheet — auditors can split into two ranges
    // if they want.
    const escape = (s: string): string =>
      /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const round = (n: number) => Math.round(n).toString();
    const lines: string[] = [];
    lines.push('# Portfolio composition (bucket × asset class)');
    lines.push(
      'Bucket,Balance,% of total,Stocks,Bonds,Cash,Other,Raw allocation',
    );
    for (const r of rows) {
      const pct = totals.balance > 0 ? (r.balance / totals.balance) * 100 : 0;
      const rawAllocStr = Array.from(r.rawAllocation.entries())
        .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
        .join('; ');
      lines.push(
        [
          escape(r.label),
          round(r.balance),
          pct.toFixed(1),
          round(r.stocks),
          round(r.bonds),
          round(r.cash),
          round(r.other),
          escape(rawAllocStr),
        ].join(','),
      );
    }
    lines.push(
      [
        'TOTAL',
        round(totals.balance),
        '100.0',
        round(totals.stocks),
        round(totals.bonds),
        round(totals.cash),
        round(totals.other),
        '',
      ].join(','),
    );
    lines.push('');
    lines.push('# Holdings detail (per source account)');
    lines.push('Bucket,Account,Holding symbol,Name,Value,Managed');
    const buckets: Array<[string, AccountBucket | undefined]> = [
      [BUCKET_LABELS.pretax, data.accounts.pretax],
      [BUCKET_LABELS.roth, data.accounts.roth],
      [BUCKET_LABELS.taxable, data.accounts.taxable],
      [BUCKET_LABELS.cash, data.accounts.cash],
      ['HSA', data.accounts.hsa],
    ];
    for (const [label, ab] of buckets) {
      if (!ab?.sourceAccounts) continue;
      for (const acct of ab.sourceAccounts) {
        if (acct.holdings && acct.holdings.length > 0) {
          for (const h of acct.holdings) {
            lines.push(
              [
                escape(label),
                escape(acct.name),
                escape(h.symbol ?? ''),
                escape(h.name ?? ''),
                round(h.value ?? 0),
                acct.managed ? 'true' : 'false',
              ].join(','),
            );
          }
        } else {
          lines.push(
            [
              escape(label),
              escape(acct.name),
              '',
              '(no holdings detail)',
              round(acct.balance ?? 0),
              acct.managed ? 'true' : 'false',
            ].join(','),
          );
        }
      }
    }
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `retirement-plan-portfolio-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-[24px] bg-stone-100/85 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-stone-600">
            Portfolio composition · stocks / bonds / cash by bucket
          </p>
          <p className="text-xs text-stone-500">
            Computed from account balances × target allocation. Lets a
            second tool / advisor verify your effective asset mix and
            tax-location strategy. Holdings-level detail (symbol, value)
            is included in the CSV.
          </p>
          <p className="text-xs text-stone-500">
            Total portfolio:{' '}
            <span className="font-semibold">{fmt(totals.balance)}</span>{' '}
            · {fmt(totals.stocks)} stocks ·{' '}
            {fmt(totals.bonds)} bonds · {fmt(totals.cash)} cash
            {totals.other > 0 ? ` · ${fmt(totals.other)} other` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={downloadHoldingsCsv}
          className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500"
        >
          Download Portfolio CSV
        </button>
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl border border-stone-300 bg-white">
        <table className="min-w-full text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-stone-300 bg-stone-100">
              <th className="px-3 py-2 text-left font-semibold text-stone-700">
                Bucket
              </th>
              <th className="px-3 py-2 text-right font-semibold text-stone-700">
                Balance
              </th>
              <th className="px-3 py-2 text-right font-semibold text-stone-700">
                % of total
              </th>
              <th className="px-3 py-2 text-right font-semibold text-stone-700">
                Stocks
              </th>
              <th className="px-3 py-2 text-right font-semibold text-stone-700">
                Bonds
              </th>
              <th className="px-3 py-2 text-right font-semibold text-stone-700">
                Cash
              </th>
              <th className="px-3 py-2 text-right font-semibold text-stone-700">
                Other
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct =
                totals.balance > 0 ? (r.balance / totals.balance) * 100 : 0;
              return (
                <tr
                  key={r.bucket}
                  className="border-b border-stone-100 last:border-b-0"
                >
                  <td className="px-3 py-2 font-medium text-stone-800">
                    {r.label}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-700">
                    {fmt(r.balance)}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-500">
                    {pct.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right text-blue-700">
                    {fmt(r.stocks)}
                  </td>
                  <td className="px-3 py-2 text-right text-amber-700">
                    {fmt(r.bonds)}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-500">
                    {fmt(r.cash)}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-400">
                    {fmt(r.other)}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-stone-300 bg-stone-50 font-semibold">
              <td className="px-3 py-2 text-stone-900">TOTAL</td>
              <td className="px-3 py-2 text-right text-stone-900">
                {fmt(totals.balance)}
              </td>
              <td className="px-3 py-2 text-right text-stone-500">100.0%</td>
              <td className="px-3 py-2 text-right text-blue-800">
                {fmt(totals.stocks)} (
                {totals.balance > 0
                  ? ((totals.stocks / totals.balance) * 100).toFixed(0)
                  : 0}
                %)
              </td>
              <td className="px-3 py-2 text-right text-amber-800">
                {fmt(totals.bonds)} (
                {totals.balance > 0
                  ? ((totals.bonds / totals.balance) * 100).toFixed(0)
                  : 0}
                %)
              </td>
              <td className="px-3 py-2 text-right text-stone-700">
                {fmt(totals.cash)} (
                {totals.balance > 0
                  ? ((totals.cash / totals.balance) * 100).toFixed(0)
                  : 0}
                %)
              </td>
              <td className="px-3 py-2 text-right text-stone-500">
                {fmt(totals.other)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function YearByYearAuditTable({
  data,
  yearlySeries,
}: {
  data: SeedData;
  yearlySeries: PathYearResult[];
}) {
  const ctx: AuditContext = useMemo(() => {
    const robBirthYear = data.household.robBirthDate
      ? new Date(data.household.robBirthDate).getUTCFullYear()
      : 0;
    const debbieBirthYear = data.household.debbieBirthDate
      ? new Date(data.household.debbieBirthDate).getUTCFullYear()
      : 0;
    return { robBirthYear, debbieBirthYear };
  }, [data]);

  const downloadCsv = () => {
    const csv = buildAuditCsv(yearlySeries, ctx);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `retirement-plan-yearly-audit-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (yearlySeries.length === 0) {
    return (
      <div className="rounded-[24px] bg-stone-100/85 p-4">
        <p className="text-sm font-medium text-stone-600">
          Year-by-year audit
        </p>
        <p className="mt-1 text-xs text-stone-500">
          Run a plan first — the audit table reads from the engine's
          yearly path output.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[24px] bg-stone-100/85 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-stone-600">
            Year-by-year audit table
          </p>
          <p className="text-xs text-stone-500">
            One row per simulated year, median across stochastic trials.
            Open in a spreadsheet to verify income / spend / tax /
            withdrawal / balance flow column-by-column.
          </p>
          <p className="text-xs text-stone-500">
            {yearlySeries.length} years ·{' '}
            {AUDIT_COLUMNS.length} columns · nominal $.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadCsv}
          className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500"
        >
          Download CSV
        </button>
      </div>
      <div className="mt-3 max-h-[480px] overflow-auto rounded-xl border border-stone-300 bg-white">
        <table className="min-w-max text-[11px] tabular-nums">
          <thead className="sticky top-0 z-10 bg-stone-100">
            <tr>
              {AUDIT_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="whitespace-nowrap border-b border-stone-300 px-2 py-1.5 text-left font-semibold text-stone-700"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {yearlySeries.map((yr) => (
              <tr key={yr.year} className="even:bg-stone-50/60">
                {AUDIT_COLUMNS.map((col) => {
                  const raw =
                    col.derive != null
                      ? col.derive(yr, ctx)
                      : col.pick
                      ? col.pick(yr)
                      : '';
                  const text = formatAuditCell(raw, col.format);
                  const isZero = text === '—' || text === '$0' || text === '0';
                  return (
                    <td
                      key={col.key}
                      className={`whitespace-nowrap border-b border-stone-100 px-2 py-1 text-right ${
                        isZero ? 'text-stone-300' : 'text-stone-700'
                      }`}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ExportScreen() {
  const data = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.draftAssumptions);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const latestUnifiedPlanEvaluationContext = useAppStore(
    (state) => state.latestUnifiedPlanEvaluationContext,
  );
  const [copied, setCopied] = useState(false);
  const [payload, setPayload] = useState<PlanningStateExport | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestCounterRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const currentEvaluationFingerprint = useMemo(
    () =>
      buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
      }),
    [assumptions, data, selectedResponses, selectedStressors],
  );
  const unifiedPlanContextIsFresh =
    latestUnifiedPlanEvaluationContext?.fingerprint === currentEvaluationFingerprint;

  const exportCacheKey = useMemo(
    () =>
      JSON.stringify({
        cacheVersion: PLANNING_EXPORT_CACHE_VERSION,
        fingerprint: currentEvaluationFingerprint,
        unifiedPlanContext: unifiedPlanContextIsFresh
          ? {
              fingerprint: latestUnifiedPlanEvaluationContext?.fingerprint ?? null,
              capturedAtIso: latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null,
            }
          : null,
      }),
    [
      currentEvaluationFingerprint,
      latestUnifiedPlanEvaluationContext,
      unifiedPlanContextIsFresh,
    ],
  );
  useEffect(() => {
    const cached = exportPayloadCache.get(exportCacheKey) ?? null;
    if (cached) {
      setPayload(cached);
      setLoadState('ready');
      setLoadError(null);
      return;
    }

    setLoadState('loading');
    setLoadError(null);

    const requestId = `${EXPORT_REQUEST_PREFIX}-${requestCounterRef.current++}`;
    activeRequestIdRef.current = requestId;

    const workerAvailable = typeof Worker !== 'undefined';
    if (!workerAvailable) {
      void (async () => {
        try {
          const next = await buildPlanningStateExportWithResolvedContext({
            data,
            assumptions,
            selectedStressorIds: selectedStressors,
            selectedResponseIds: selectedResponses,
            unifiedPlanEvaluation:
              unifiedPlanContextIsFresh
                ? latestUnifiedPlanEvaluationContext?.evaluation ?? null
                : null,
            unifiedPlanEvaluationCapturedAtIso:
              unifiedPlanContextIsFresh
                ? latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null
                : null,
          });
          exportPayloadCache.set(exportCacheKey, next);
          if (activeRequestIdRef.current === requestId) {
            setPayload(next);
            setLoadState('ready');
            setLoadError(null);
          }
        } catch (error) {
          if (activeRequestIdRef.current === requestId) {
            setLoadState('error');
            setLoadError(error instanceof Error ? error.message : 'Failed to generate export.');
          }
        }
      })();
      return;
    }

    const worker = new Worker(new URL('./planning-export.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<PlanningExportWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== activeRequestIdRef.current) {
        return;
      }
      if (message.type === 'error') {
        setLoadState('error');
        setLoadError(message.error);
        return;
      }
      exportPayloadCache.set(exportCacheKey, message.payload);
      setPayload(message.payload);
      setLoadState('ready');
      setLoadError(null);
    };

    const requestMessage: PlanningExportWorkerRequest = {
      type: 'run',
      payload: {
        requestId,
        data,
        assumptions,
        selectedStressorIds: selectedStressors,
        selectedResponseIds: selectedResponses,
        unifiedPlanEvaluation:
          unifiedPlanContextIsFresh
            ? latestUnifiedPlanEvaluationContext?.evaluation ?? null
            : null,
        unifiedPlanEvaluationCapturedAtIso:
          unifiedPlanContextIsFresh
            ? latestUnifiedPlanEvaluationContext?.capturedAtIso ?? null
            : null,
      },
    };
    worker.postMessage(requestMessage);

    return () => {
      worker.terminate();
    };
  }, [
    assumptions,
    data,
    exportCacheKey,
    latestUnifiedPlanEvaluationContext,
    selectedResponses,
    selectedStressors,
    unifiedPlanContextIsFresh,
  ]);
  const payloadJson = useMemo(
    () => (payload ? JSON.stringify(payload, null, 2) : ''),
    [payload],
  );

  // Year-by-year audit data — runs the engine inline (synchronously)
  // because we already have a hot path doing this in Cockpit. The
  // memo keys ensure we don't re-run unless the inputs that affect
  // the trajectory change.
  const auditYearlySeries = useMemo(() => {
    try {
      const paths = buildPathResults(
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
        { pathMode: 'selected_only' },
      );
      return paths[0]?.yearlySeries ?? [];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[export] audit path build failed:', err);
      return [];
    }
  }, [data, assumptions, selectedStressors, selectedResponses]);
  const probeStatusCounts = useMemo(() => {
    const counts = {
      modeled: 0,
      partial: 0,
      attention: 0,
      missing: 0,
    };
    payload?.probeChecklist.items.forEach((item) => {
      counts[item.status] += 1;
    });
    return counts;
  }, [payload?.probeChecklist.items]);

  const copyPayload = async () => {
    const text = payloadJson;
    if (!text) {
      return;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const element = document.createElement('textarea');
        element.value = text;
        element.setAttribute('readonly', 'true');
        element.style.position = 'absolute';
        element.style.left = '-9999px';
        document.body.appendChild(element);
        element.select();
        document.execCommand('copy');
        document.body.removeChild(element);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Panel
      title="Export"
      subtitle="Machine-readable snapshot of the current planning state for external AI/simulation runners — plus a year-by-year audit table so a CPA / spreadsheet / second opinion can verify the plan column by column."
    >
      <div className="space-y-4">
        <PortfolioCompositionTable data={data} />
        <YearByYearAuditTable
          data={data}
          yearlySeries={auditYearlySeries}
        />

      <div className="rounded-[24px] bg-stone-100/85 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-stone-600">
              Current state export ({payload?.version.schema ?? 'pending'})
            </p>
            <p className="text-xs text-stone-500">
              Unified plan context: {payload?.flightPath.evaluationContext.available
                ? `included (${payload.flightPath.evaluationContext.capturedAtIso ?? 'timestamp unavailable'})`
                : latestUnifiedPlanEvaluationContext
                  ? 'stale versus current draft inputs (rerun Unified Plan to refresh summary metrics)'
                  : 'not available (run Unified Plan to include route-based recommendations)'}
            </p>
            <p className="text-xs text-stone-500">
              Probe checklist: {payload?.probeChecklist.items.length ?? 0} items · modeled {probeStatusCounts.modeled} · partial {probeStatusCounts.partial} · attention {probeStatusCounts.attention} · missing {probeStatusCounts.missing}
            </p>
            {loadState === 'loading' ? (
              <p className="text-xs text-blue-700">Generating export in background…</p>
            ) : null}
            {loadState === 'error' ? (
              <p className="text-xs text-red-700">Export failed: {loadError}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={copyPayload}
            disabled={!payload}
            className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {payload ? (
          <pre className="mt-3 max-h-[640px] overflow-auto rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-100">
            <code>{payloadJson}</code>
          </pre>
        ) : (
          <div className="mt-3 rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-200">
            Building export payload...
          </div>
        )}
      </div>
      </div>
    </Panel>
  );
}
