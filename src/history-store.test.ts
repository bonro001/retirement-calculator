import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { defaultAssumptions } from './default-assumptions';
import { captureSnapshot } from './history-store';

describe('history snapshot capture', () => {
  it('captures investment holdings, direct bank cash, and monthly-review highlights', () => {
    const snapshot = captureSnapshot({
      label: 'before Fidelity refresh',
      data: initialSeedData,
      assumptions: defaultAssumptions,
      yearlySeries: [
        {
          year: new Date().getUTCFullYear(),
          medianAssets: 1_000_000,
          medianSpending: 120_000,
          medianIncome: 0,
          medianFederalTax: 0,
          medianMagi: 80_000,
          medianRothConversion: 0,
          medianRmdAmount: 0,
          medianPretaxBalance: 300_000,
          medianTaxableBalance: 200_000,
          medianRothBalance: 300_000,
          medianCashBalance: 50_000,
          dominantIrmaaTier: 'none',
        } as any,
      ],
      successRate: 0.94,
      medianEndingWealth: 2_500_000,
      adoptedPolicy: null,
      engineVersion: 'history-store-test',
      planHighlights: {
        source: 'monthly_review_cache',
        capturedAtIso: '2026-05-13T00:00:00.000Z',
        recommendationStatus: 'green',
        strategyId: 'jpmorgan_curve_travel_included',
        policyId: 'pol_test',
        annualSpendTodayDollars: 115_000,
        monthlySpendTodayDollars: 9_583.33,
        certificationVerdict: 'green',
        aiVerdict: 'aligned',
        aiConfidence: 'high',
        summary: 'Monthly review aligned.',
        actionItems: ['Refresh Fidelity and compare.'],
        proofBundlePath: '/tmp/proof-bundle',
        proofFiles: { packet: '/tmp/proof-bundle/packet.json' },
      },
    });

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.portfolioState?.bankCashValue).toBe(
      initialSeedData.accounts.cash.balance,
    );
    expect(snapshot.portfolioState?.sourceAccountCount).toBeGreaterThan(0);
    expect(snapshot.portfolioState?.holdingCount).toBeGreaterThan(0);
    expect(
      snapshot.portfolioState?.holdingsBySymbol.some(
        (holding) => holding.symbol === 'VTI',
      ),
    ).toBe(true);
    expect(snapshot.planHighlights?.annualSpendTodayDollars).toBe(115_000);
    expect(snapshot.planHighlights?.aiVerdict).toBe('aligned');
    expect(snapshot.planHighlights?.proofBundlePath).toBe('/tmp/proof-bundle');
  });

  it('can capture a portfolio checkpoint before detailed yearly projection exists', () => {
    const snapshot = captureSnapshot({
      label: 'before Fidelity refresh',
      data: initialSeedData,
      assumptions: defaultAssumptions,
      yearlySeries: [],
      successRate: 1,
      medianEndingWealth: 2_320_000,
      adoptedPolicy: null,
      engineVersion: 'history-store-test',
    });

    expect(snapshot.yearlySeries).toEqual([]);
    expect(snapshot.metrics.thisYearProjectedSpend).toBeNull();
    expect(snapshot.planHighlights?.source).toBe('cockpit');
    expect(snapshot.portfolioState?.holdingCount).toBeGreaterThan(0);
  });
});
