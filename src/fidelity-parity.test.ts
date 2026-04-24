import { describe, it, expect } from 'vitest';
import fidelityBaseline from '../fixtures/fidelity_baseline.json';
import boldinLowerReturns from '../fixtures/boldin_lower_returns.json';
import {
  translateFidelityFixture,
  type FidelityFixture,
} from './fidelity-fixture-translator';
import { buildPathResults } from './utils';

interface ComparisonRow {
  metric: string;
  fidelity: number | string;
  boldin: number | string;
  ours: number;
  note?: string;
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

describe('Fidelity parity — historical-methodology triangulation', () => {
  it('reports Fidelity target, Boldin target, and our engine result side-by-side', () => {
    const fixture = fidelityBaseline as unknown as FidelityFixture;
    const { seedData, assumptions, notes } = translateFidelityFixture(fixture);

    const paths = buildPathResults(seedData, assumptions, [], []);
    const baseline = paths[0];

    const ourSuccessPct = baseline.successRate * 100;
    const ourMedianEndingWealth = baseline.medianEndingWealth;
    const ourTenthPercentileEndingWealth = baseline.tenthPercentileEndingWealth;
    const ourLifetimeTaxes = baseline.yearlySeries.reduce(
      (sum, y) => sum + y.medianFederalTax,
      0,
    );

    const fidelityExpected = fixture.expected;
    const boldinExpected = (boldinLowerReturns as unknown as {
      expected: {
        chanceOfSuccessPct: number;
        netWorthAtLongevity: number;
        lifetimeIncomeTaxesPaid: number;
      };
    }).expected;

    const rows: ComparisonRow[] = [
      {
        metric: 'chance of success',
        fidelity: fidelityExpected.probabilityOfSuccessPct,
        boldin: boldinExpected.chanceOfSuccessPct,
        ours: ourSuccessPct,
        note: 'Boldin = Conservative preset; Fidelity = historical MC',
      },
      {
        metric: 'starting balance',
        fidelity: fidelityExpected.currentSavingsBalance,
        boldin: 921173,
        ours:
          seedData.accounts.pretax.balance +
          seedData.accounts.roth.balance +
          seedData.accounts.taxable.balance +
          seedData.accounts.cash.balance +
          (seedData.accounts.hsa?.balance ?? 0),
        note: 'should match within rounding across all three',
      },
      {
        metric: 'ending wealth (p50 median)',
        fidelity: 'n/a',
        boldin: boldinExpected.netWorthAtLongevity,
        ours: ourMedianEndingWealth,
        note: 'Fidelity publishes p10 only',
      },
      {
        metric: 'ending wealth (p10)',
        fidelity: fidelityExpected.assetsRemainingTenthPercentile,
        boldin: 'n/a',
        ours: ourTenthPercentileEndingWealth,
        note: 'Boldin publishes aggregate only',
      },
      {
        metric: 'lifetime federal taxes',
        fidelity: 'n/a',
        boldin: boldinExpected.lifetimeIncomeTaxesPaid,
        ours: ourLifetimeTaxes,
        note: 'Fidelity does not break out taxes',
      },
    ];

    const widths = [30, 18, 18, 18];
    const lines: string[] = [];
    lines.push(
      pad('Metric', widths[0]) +
        padRight('Fidelity', widths[1]) +
        padRight('Boldin', widths[2]) +
        padRight('Ours', widths[3]),
    );
    lines.push('-'.repeat(widths.reduce((a, b) => a + b, 0)));
    for (const row of rows) {
      const m = row.metric.toLowerCase();
      const isCurrency =
        m.includes('wealth') ||
        m.includes('tax') ||
        m.includes('balance');
      const fStr =
        typeof row.fidelity === 'string'
          ? row.fidelity
          : isCurrency
            ? fmtCurrency(row.fidelity)
            : fmtPct(row.fidelity);
      const bStr =
        typeof row.boldin === 'string'
          ? row.boldin
          : isCurrency
            ? fmtCurrency(row.boldin)
            : fmtPct(row.boldin);
      const oStr = isCurrency ? fmtCurrency(row.ours) : fmtPct(row.ours);
      lines.push(
        pad(row.metric, widths[0]) +
          padRight(fStr, widths[1]) +
          padRight(bStr, widths[2]) +
          padRight(oStr, widths[3]),
      );
    }
    const table = lines.join('\n');

    const report = [
      '',
      '================================================================',
      'Triangulation: Fidelity vs Boldin vs our engine',
      '  Same household, same 8 accounts, ~$921-924k portfolio.',
      '  Fidelity: 250 MC sims, historical asset-class sampling.',
      '  Boldin: Conservative preset, 5.92%/11.05% stdev override.',
      '  Ours: 500 MC sims, historical-approximation defaults',
      '        (equity 9.8%, intl 8.5%, bonds 5.3%, cash 3.0%).',
      '  SAFETY CHECK — not a parity gate.',
      '================================================================',
      '',
      table,
      '',
      'Translation notes:',
      ...notes.map((n) => `  [${n.severity}] ${n.field}: ${n.detail}`),
      '',
      'Interpretation hints:',
      '  - Success rate expected to land much closer to Fidelity than',
      '    Boldin. Boldin is running a stress preset; Fidelity and ours',
      '    are both using historical-style returns.',
      '  - If our success rate is > Fidelity by > 5pp, investigate',
      '    yield-as-income accounting, withdrawal smoothing, or Roth',
      '    conversion aggressiveness (same residuals as the Boldin',
      '    investigation).',
      '',
      '================================================================',
      '',
    ].join('\n');

    // eslint-disable-next-line no-console
    console.log(report);

    // Loose sanity assertions only — this test is diagnostic.
    expect(ourSuccessPct).toBeGreaterThanOrEqual(0);
    expect(ourSuccessPct).toBeLessThanOrEqual(100);
    expect(ourMedianEndingWealth).toBeGreaterThanOrEqual(0);
    expect(baseline.yearlySeries.length).toBeGreaterThan(0);
  });
});
