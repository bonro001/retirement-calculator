import { describe, it, expect } from 'vitest';
import boldinLowerReturnsFixture from '../fixtures/boldin_lower_returns.json';
import {
  translateBoldinFixture,
  type BoldinFixture,
  type TranslationOptions,
} from './boldin-fixture-translator';
import { buildPathResults } from './utils';

interface RunOutputs {
  label: string;
  successPct: number;
  endingWealth: number;
  lifetimeTaxes: number;
  startingBalance: number;
  peakWealth: number;
  peakYear: number;
  notes: string[];
  spendingByYear: Array<{
    year: number;
    spending: number;
    assets: number;
    income: number;
    tax: number;
    withdrawals: number;
  }>;
  withdrawalByBucketByYear: Array<{
    year: number;
    cash: number;
    taxable: number;
    ira401k: number;
    roth: number;
  }>;
  windfallByYear: Array<{
    year: number;
    cashInflow: number;
    ordinaryIncome: number;
    ltcgIncome: number;
  }>;
}

interface ComparisonRow {
  metric: string;
  boldin: number;
  raw: number;
  levered: number;
  rawDeltaPct: number;
  leveredDeltaPct: number;
}

function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return String(n);
  return `${n.toFixed(digits)}%`;
}

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padRight(s: string, w: number) {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function runVariant(
  label: string,
  fixture: BoldinFixture,
  options: TranslationOptions,
): RunOutputs {
  const { seedData, assumptions, notes } = translateBoldinFixture(fixture, options);
  const paths = buildPathResults(seedData, assumptions, [], []);
  const baseline = paths[0];
  const startingBalance =
    seedData.accounts.pretax.balance +
    seedData.accounts.roth.balance +
    seedData.accounts.taxable.balance +
    seedData.accounts.cash.balance +
    (seedData.accounts.hsa?.balance ?? 0);
  const lifetimeTaxes = baseline.yearlySeries.reduce(
    (sum, y) => sum + y.medianFederalTax,
    0,
  );
  const peak = baseline.yearlySeries.reduce(
    (acc, y) => (y.medianAssets > acc.medianAssets ? y : acc),
    baseline.yearlySeries[0],
  );
  return {
    label,
    successPct: baseline.successRate * 100,
    endingWealth: baseline.medianEndingWealth,
    lifetimeTaxes,
    startingBalance,
    peakWealth: peak?.medianAssets ?? NaN,
    peakYear: peak?.year ?? NaN,
    notes: notes.map((n) => `  [${n.severity}] ${n.field}: ${n.detail}`),
    spendingByYear: baseline.yearlySeries.map((y) => ({
      year: y.year,
      spending: y.medianSpending,
      assets: y.medianAssets,
      income: y.medianIncome,
      tax: y.medianFederalTax,
      withdrawals:
        y.medianWithdrawalCash +
        y.medianWithdrawalTaxable +
        y.medianWithdrawalIra401k +
        y.medianWithdrawalRoth,
    })),
    withdrawalByBucketByYear: baseline.yearlySeries.map((y) => ({
      year: y.year,
      cash: y.medianWithdrawalCash,
      taxable: y.medianWithdrawalTaxable,
      ira401k: y.medianWithdrawalIra401k,
      roth: y.medianWithdrawalRoth,
    })),
    windfallByYear: baseline.yearlySeries.map((y) => ({
      year: y.year,
      cashInflow: y.medianWindfallCashInflow,
      ordinaryIncome: y.medianWindfallOrdinaryIncome,
      ltcgIncome: y.medianWindfallLtcgIncome,
    })),
  };
}

function estimateBoldinIncomeForYear(year: number): number {
  // Boldin-visible income components (nominal):
  //   - Salary $14k/mo with 2.54% growth, prior to Jan 2026 → Jun 2027
  //   - Windfall $500k one-time in Dec 2028
  //   - SS spouse $2,100/mo starting Oct 2030 + Rob $4,078/mo starting Dec
  //     2031, each COLA'd at 2.54%. Boldin shows combined $7,004/mo when
  //     both claiming — we use that as the "both claiming" anchor.
  let salary = 0;
  if (year === 2026) salary = 14000 * 12;
  else if (year === 2027) salary = 14000 * 6 * Math.pow(1.0254, 1);

  const windfall = year === 2028 ? 500000 : 0;

  let ss = 0;
  if (year >= 2030) {
    // Spouse monthly with COLA from 2030 onwards.
    const spouseMonthly = 2100 * Math.pow(1.0254, year - 2030);
    const spouseMonths = year === 2030 ? 3 : 12;
    ss += spouseMonthly * spouseMonths;
  }
  if (year >= 2031) {
    const headMonthly = 4078 * Math.pow(1.0254, year - 2031);
    const headMonths = year === 2031 ? 1 : 12;
    ss += headMonthly * headMonths;
  }

  return salary + windfall + ss;
}

// Boldin's visible expense components, inflated to nominal dollars each year:
//   - recurring $9,000/mo at 2.54% general inflation
//   - travel bolus $120k total spread Jul 2027 → Sep 2032 (~63 months)
//   - pre-65 medical $1,500/mo Jul 2027 → Nov 2029 at 3.36% medical inflation
//   - Medicare (post-65) approximated from lifetime total, medical inflation
function estimateBoldinSpendForYear(year: number): number {
  const baseMonthly2026 = 9000;
  const general = baseMonthly2026 * 12 * Math.pow(1.0254, year - 2026);

  let travel = 0;
  if (year >= 2027 && year <= 2032) {
    const monthsThisYear =
      year === 2027 ? 6 : year === 2032 ? 9 : 12;
    travel = (120000 / 63) * monthsThisYear;
  }

  let medicalPre65 = 0;
  if (year >= 2027 && year <= 2029) {
    const monthsThisYear =
      year === 2027 ? 6 : year === 2029 ? 11 : 12;
    medicalPre65 = 1500 * monthsThisYear * Math.pow(1.0336, year - 2026);
  }

  let medicare = 0;
  const spouseOnMedicare = year >= 2026;
  const headOnMedicare = year >= 2030;
  const medicarePeople = (spouseOnMedicare ? 1 : 0) + (headOnMedicare ? 1 : 0);
  if (medicarePeople > 0) {
    medicare = 7448 * medicarePeople * Math.pow(1.0336, year - 2026);
  }

  return general + travel + medicalPre65 + medicare;
}

function renderTable(rows: ComparisonRow[]): string {
  const header = ['Metric', 'Boldin', 'Raw', 'Levered', 'Raw Δ%', 'Lev Δ%'];
  const widths = [28, 15, 15, 15, 10, 10];
  const lines: string[] = [];
  lines.push(
    pad(header[0], widths[0]) +
      padRight(header[1], widths[1]) +
      padRight(header[2], widths[2]) +
      padRight(header[3], widths[3]) +
      padRight(header[4], widths[4]) +
      padRight(header[5], widths[5]),
  );
  lines.push('-'.repeat(widths.reduce((a, b) => a + b, 0)));
  for (const row of rows) {
    const m = row.metric.toLowerCase();
    const isCurrency =
      m.includes('wealth') ||
      m.includes('worth') ||
      m.includes('tax') ||
      m.includes('balance') ||
      m.includes('assets');
    const b = isCurrency ? fmtCurrency(row.boldin) : fmtPct(row.boldin);
    const r = isCurrency ? fmtCurrency(row.raw) : fmtPct(row.raw);
    const l = isCurrency ? fmtCurrency(row.levered) : fmtPct(row.levered);
    const rdp = fmtPct(row.rawDeltaPct);
    const ldp = fmtPct(row.leveredDeltaPct);
    lines.push(
      pad(row.metric, widths[0]) +
        padRight(b, widths[1]) +
        padRight(r, widths[2]) +
        padRight(l, widths[3]) +
        padRight(rdp, widths[4]) +
        padRight(ldp, widths[5]),
    );
  }
  return lines.join('\n');
}

describe('Boldin "Lower Returns" parity smoke test (home removed)', () => {
  it('compares raw translation vs. all-levers against the fresh no-home Boldin scenario', () => {
    const fixture = boldinLowerReturnsFixture as unknown as BoldinFixture;
    const e = fixture.expected as BoldinFixture['expected'] & {
      netWorthAtRetirementAge62?: number;
      projectedPeakNetWorthApprox?: number;
      projectedPeakYearApprox?: number;
    };

    // Force home off on our side too. Fixture already has zero real estate,
    // but passing the option guards against accidental reintroduction.
    const sharedOptions: TranslationOptions = { excludeHome: true };

    const raw = runVariant('raw (home excluded)', fixture, sharedOptions);
    const levered = runVariant('Boldin-conservative calibrated', fixture, {
      ...sharedOptions,
      healthcareOverlayFromBoldin: true,
      disableRothConversions: true,
      matchBoldinConservativeDistribution: true,
    });

    expect(raw.startingBalance).toBe(fixture.accountsTotal);
    expect(levered.startingBalance).toBe(fixture.accountsTotal);

    const deltaPct = (ours: number, boldin: number) =>
      boldin !== 0 ? ((ours - boldin) / boldin) * 100 : NaN;

    const rows: ComparisonRow[] = [
      {
        metric: 'chance of success',
        boldin: e.chanceOfSuccessPct,
        raw: raw.successPct,
        levered: levered.successPct,
        rawDeltaPct: deltaPct(raw.successPct, e.chanceOfSuccessPct),
        leveredDeltaPct: deltaPct(levered.successPct, e.chanceOfSuccessPct),
      },
      {
        metric: 'starting balance',
        boldin: e.currentSavingsBalance,
        raw: raw.startingBalance,
        levered: levered.startingBalance,
        rawDeltaPct: deltaPct(raw.startingBalance, e.currentSavingsBalance),
        leveredDeltaPct: deltaPct(levered.startingBalance, e.currentSavingsBalance),
      },
      {
        metric: 'net worth at longevity',
        boldin: e.netWorthAtLongevity,
        raw: raw.endingWealth,
        levered: levered.endingWealth,
        rawDeltaPct: deltaPct(raw.endingWealth, e.netWorthAtLongevity),
        leveredDeltaPct: deltaPct(levered.endingWealth, e.netWorthAtLongevity),
      },
      {
        metric: 'lifetime income taxes',
        boldin: e.lifetimeIncomeTaxesPaid,
        raw: raw.lifetimeTaxes,
        levered: levered.lifetimeTaxes,
        rawDeltaPct: deltaPct(raw.lifetimeTaxes, e.lifetimeIncomeTaxesPaid),
        leveredDeltaPct: deltaPct(
          levered.lifetimeTaxes,
          e.lifetimeIncomeTaxesPaid,
        ),
      },
    ];

    if (typeof e.projectedPeakNetWorthApprox === 'number') {
      rows.push({
        metric: 'peak projected net worth',
        boldin: e.projectedPeakNetWorthApprox,
        raw: raw.peakWealth,
        levered: levered.peakWealth,
        rawDeltaPct: deltaPct(raw.peakWealth, e.projectedPeakNetWorthApprox),
        leveredDeltaPct: deltaPct(
          levered.peakWealth,
          e.projectedPeakNetWorthApprox,
        ),
      });
    }

    // Spend-path diagnostic. Shows whether our engine is actually drawing
    // down the amount Boldin's plan implies. Every ~5 years plus first/last
    // to keep the output scannable.
    const spendYears = raw.spendingByYear
      .map((r) => r.year)
      .filter((y, idx, arr) => idx === 0 || idx === arr.length - 1 || y % 5 === 0);
    const spendRows: string[] = [];
    spendRows.push(
      pad('Year', 6) +
        padRight('Boldin impl.', 16) +
        padRight('Raw', 16) +
        padRight('Levered', 16) +
        padRight('Raw Δ%', 10) +
        padRight('Lev Δ%', 10),
    );
    spendRows.push('-'.repeat(6 + 16 + 16 + 16 + 10 + 10));
    let boldinLifetime = 0;
    let rawLifetime = 0;
    let leveredLifetime = 0;
    for (const r of raw.spendingByYear) {
      const boldin = estimateBoldinSpendForYear(r.year);
      const lev = levered.spendingByYear.find((y) => y.year === r.year);
      boldinLifetime += boldin;
      rawLifetime += r.spending;
      leveredLifetime += lev?.spending ?? 0;
      if (!spendYears.includes(r.year)) continue;
      const rawDelta = boldin !== 0 ? ((r.spending - boldin) / boldin) * 100 : NaN;
      const levDelta =
        boldin !== 0 && lev ? ((lev.spending - boldin) / boldin) * 100 : NaN;
      spendRows.push(
        pad(String(r.year), 6) +
          padRight(fmtCurrency(boldin), 16) +
          padRight(fmtCurrency(r.spending), 16) +
          padRight(fmtCurrency(lev?.spending ?? NaN), 16) +
          padRight(fmtPct(rawDelta), 10) +
          padRight(fmtPct(levDelta), 10),
      );
    }
    spendRows.push('-'.repeat(6 + 16 + 16 + 16 + 10 + 10));
    const lifetimeRawDelta =
      boldinLifetime !== 0
        ? ((rawLifetime - boldinLifetime) / boldinLifetime) * 100
        : NaN;
    const lifetimeLevDelta =
      boldinLifetime !== 0
        ? ((leveredLifetime - boldinLifetime) / boldinLifetime) * 100
        : NaN;
    spendRows.push(
      pad('TOTAL', 6) +
        padRight(fmtCurrency(boldinLifetime), 16) +
        padRight(fmtCurrency(rawLifetime), 16) +
        padRight(fmtCurrency(leveredLifetime), 16) +
        padRight(fmtPct(lifetimeRawDelta), 10) +
        padRight(fmtPct(lifetimeLevDelta), 10),
    );

    // Money-flow diagnostic. Shows whether our engine's income, taxes and
    // withdrawals reconcile with the size of the asset pile each year. If
    // our income line consistently exceeds Boldin's implied income, that's
    // the source of the ending-wealth over-run.
    const flowYears = levered.spendingByYear
      .map((r) => r.year)
      .filter((y, idx, arr) => idx === 0 || idx === arr.length - 1 || y % 5 === 0);
    const flowRows: string[] = [];
    flowRows.push(
      pad('Year', 6) +
        padRight('Boldin inc.', 14) +
        padRight('Our income', 14) +
        padRight('Our withdr.', 14) +
        padRight('Our tax', 12) +
        padRight('Our assets', 14),
    );
    flowRows.push('-'.repeat(6 + 14 + 14 + 14 + 12 + 14));
    let boldinIncomeLifetime = 0;
    let ourIncomeLifetime = 0;
    let ourWithdrawalsLifetime = 0;
    for (const r of levered.spendingByYear) {
      const boldinInc = estimateBoldinIncomeForYear(r.year);
      boldinIncomeLifetime += boldinInc;
      ourIncomeLifetime += r.income;
      ourWithdrawalsLifetime += r.withdrawals;
      if (!flowYears.includes(r.year)) continue;
      flowRows.push(
        pad(String(r.year), 6) +
          padRight(fmtCurrency(boldinInc), 14) +
          padRight(fmtCurrency(r.income), 14) +
          padRight(fmtCurrency(r.withdrawals), 14) +
          padRight(fmtCurrency(r.tax), 12) +
          padRight(fmtCurrency(r.assets), 14),
      );
    }
    flowRows.push('-'.repeat(6 + 14 + 14 + 14 + 12 + 14));
    flowRows.push(
      pad('TOTAL', 6) +
        padRight(fmtCurrency(boldinIncomeLifetime), 14) +
        padRight(fmtCurrency(ourIncomeLifetime), 14) +
        padRight(fmtCurrency(ourWithdrawalsLifetime), 14) +
        padRight('', 12) +
        padRight('', 14),
    );
    const incomeLifetimeDelta =
      boldinIncomeLifetime !== 0
        ? ((ourIncomeLifetime - boldinIncomeLifetime) / boldinIncomeLifetime) * 100
        : NaN;

    // (j) Per-bucket withdrawal trajectory (Levered). Shows which bucket the
    // engine is actually pulling from year by year. If taxable is near-zero
    // across the board, the taxable bucket compounds unchecked.
    const bucketYears = levered.withdrawalByBucketByYear
      .map((r) => r.year)
      .filter((y, idx, arr) => idx === 0 || idx === arr.length - 1 || y % 5 === 0);
    const bucketRows: string[] = [];
    bucketRows.push(
      pad('Year', 6) +
        padRight('Cash', 12) +
        padRight('Taxable', 12) +
        padRight('Pretax', 12) +
        padRight('Roth', 12) +
        padRight('Total', 12),
    );
    bucketRows.push('-'.repeat(6 + 12 * 5));
    let bucketLifetime = { cash: 0, taxable: 0, ira401k: 0, roth: 0 };
    for (const r of levered.withdrawalByBucketByYear) {
      bucketLifetime.cash += r.cash;
      bucketLifetime.taxable += r.taxable;
      bucketLifetime.ira401k += r.ira401k;
      bucketLifetime.roth += r.roth;
      if (!bucketYears.includes(r.year)) continue;
      const total = r.cash + r.taxable + r.ira401k + r.roth;
      bucketRows.push(
        pad(String(r.year), 6) +
          padRight(fmtCurrency(r.cash), 12) +
          padRight(fmtCurrency(r.taxable), 12) +
          padRight(fmtCurrency(r.ira401k), 12) +
          padRight(fmtCurrency(r.roth), 12) +
          padRight(fmtCurrency(total), 12),
      );
    }
    bucketRows.push('-'.repeat(6 + 12 * 5));
    const bucketTotal =
      bucketLifetime.cash +
      bucketLifetime.taxable +
      bucketLifetime.ira401k +
      bucketLifetime.roth;
    bucketRows.push(
      pad('TOTAL', 6) +
        padRight(fmtCurrency(bucketLifetime.cash), 12) +
        padRight(fmtCurrency(bucketLifetime.taxable), 12) +
        padRight(fmtCurrency(bucketLifetime.ira401k), 12) +
        padRight(fmtCurrency(bucketLifetime.roth), 12) +
        padRight(fmtCurrency(bucketTotal), 12),
    );
    const bucketMixPct = {
      cash: bucketTotal ? (bucketLifetime.cash / bucketTotal) * 100 : 0,
      taxable: bucketTotal ? (bucketLifetime.taxable / bucketTotal) * 100 : 0,
      ira401k: bucketTotal ? (bucketLifetime.ira401k / bucketTotal) * 100 : 0,
      roth: bucketTotal ? (bucketLifetime.roth / bucketTotal) * 100 : 0,
    };
    bucketRows.push(
      pad('MIX %', 6) +
        padRight(fmtPct(bucketMixPct.cash), 12) +
        padRight(fmtPct(bucketMixPct.taxable), 12) +
        padRight(fmtPct(bucketMixPct.ira401k), 12) +
        padRight(fmtPct(bucketMixPct.roth), 12) +
        padRight('', 12),
    );

    // (k) Windfall spot-check. Dump any year where our engine recorded a
    // windfall cash inflow, ordinary income, or LTCG. Expect the $500k
    // Boldin windfall to show up in 2028.
    const windfallRows: string[] = [];
    windfallRows.push(
      pad('Year', 6) +
        padRight('Cash inflow', 16) +
        padRight('Ord. income', 16) +
        padRight('LTCG', 16),
    );
    windfallRows.push('-'.repeat(6 + 16 * 3));
    let sawAnyWindfall = false;
    for (const r of levered.windfallByYear) {
      if (r.cashInflow === 0 && r.ordinaryIncome === 0 && r.ltcgIncome === 0)
        continue;
      sawAnyWindfall = true;
      windfallRows.push(
        pad(String(r.year), 6) +
          padRight(fmtCurrency(r.cashInflow), 16) +
          padRight(fmtCurrency(r.ordinaryIncome), 16) +
          padRight(fmtCurrency(r.ltcgIncome), 16),
      );
    }
    if (!sawAnyWindfall) {
      windfallRows.push('  (no windfall inflows recorded by the engine)');
    }

    const report = [
      '',
      '================================================================',
      'Boldin "Lower Returns" — parity smoke report',
      '  Fresh Boldin state: home REMOVED, equity-side accounts at',
      '  Conservative preset (5.92% mean, 11.05% stdev).',
      '  Current Boldin result: 48% success, $42,624 NW at longevity,',
      '  $156k lifetime taxes. Near-depletion stress case.',
      '  This is a SAFETY CHECK, not a parity gate.',
      '================================================================',
      '',
      renderTable(rows),
      '',
      `Peak years   — Boldin: ~${e.projectedPeakYearApprox}  Raw: ${raw.peakYear}  Levered: ${levered.peakYear}`,
      '',
      '--- Spend-path diagnostic -------------------------------------',
      '  Boldin impl. = inflated $9k/mo + travel bolus + pre-65 med +',
      '  Medicare (approx from published lifetime totals).',
      '',
      ...spendRows,
      '',
      '--- Money-flow diagnostic (Levered only) ----------------------',
      '  Boldin inc. = inflated salary + $500k windfall 2028 + SS (both',
      '  claim dates, 2.54% COLA).',
      '',
      ...flowRows,
      '',
      `Lifetime income delta (Ours vs Boldin): ${fmtPct(incomeLifetimeDelta)}`,
      '',
      '--- Per-bucket withdrawal trajectory (Levered) ----------------',
      '  Shows which bucket the engine prefers. Taxable near-zero =',
      '  taxable bucket compounds unchecked — would confirm the',
      '  yield-tax-leakage hypothesis.',
      '',
      ...bucketRows,
      '',
      '--- Windfall spot-check (Levered, 2028 expected) --------------',
      '  Boldin expected: $500,000 inflow Dec 2028, non-taxable.',
      '',
      ...windfallRows,
      '',
      'Raw translation notes:',
      ...raw.notes,
      '',
      'Levered translation notes:',
      ...levered.notes,
      '',
      '================================================================',
      '',
    ].join('\n');

    // eslint-disable-next-line no-console
    console.log(report);

    for (const run of [raw, levered]) {
      expect(run.successPct).toBeGreaterThanOrEqual(0);
      expect(run.successPct).toBeLessThanOrEqual(100);
      expect(run.endingWealth).toBeGreaterThanOrEqual(0);
    }
  });
});
