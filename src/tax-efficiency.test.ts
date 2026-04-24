import { describe, it, expect, beforeAll } from 'vitest';
import { initialSeedData } from './data';
import type { PathResult } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';
import { computeTaxEfficiencyReport } from './tax-efficiency';

let baselinePath: PathResult;

beforeAll(() => {
  const seed = JSON.parse(JSON.stringify(initialSeedData));
  const assumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: 50,
  };
  [baselinePath] = buildPathResults(seed, assumptions, [], []);
});

describe('tax efficiency report', () => {
  it('lifetime federal tax matches path.yearlySeries sum', () => {
    const report = computeTaxEfficiencyReport(baselinePath);
    const manualSum = baselinePath.yearlySeries.reduce(
      (sum, y) => sum + y.medianFederalTax,
      0,
    );
    expect(report.lifetimeFederalTax).toBeCloseTo(manualSum, 2);
  });

  it('category contributions sum to total (rounding tolerated)', () => {
    const report = computeTaxEfficiencyReport(baselinePath);
    const totalShare = report.categoryContributions.reduce(
      (sum, c) => sum + c.sharePct,
      0,
    );
    expect(totalShare).toBeCloseTo(1, 2);
  });

  it('effective lifetime federal rate is bounded in [0, 1]', () => {
    const report = computeTaxEfficiencyReport(baselinePath);
    expect(report.effectiveLifetimeFederalRate).toBeGreaterThanOrEqual(0);
    expect(report.effectiveLifetimeFederalRate).toBeLessThanOrEqual(1);
  });

  it('heatYears is top 5 by total tax burden, sorted descending', () => {
    const report = computeTaxEfficiencyReport(baselinePath);
    expect(report.heatYears.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < report.heatYears.length; i++) {
      expect(report.heatYears[i - 1].totalTaxBurden).toBeGreaterThanOrEqual(
        report.heatYears[i].totalTaxBurden,
      );
    }
  });

  it('heatYears identify at least one primary driver', () => {
    const report = computeTaxEfficiencyReport(baselinePath);
    const drivers = new Set(report.heatYears.map((y) => y.primaryDriver));
    expect(drivers.size).toBeGreaterThan(0);
    // Every classified year must carry a non-empty detail string.
    for (const year of report.heatYears) {
      expect(year.driverDetail.length).toBeGreaterThan(0);
    }
  });

  it('irmaaCliffYears only contain tier 3+', () => {
    const report = computeTaxEfficiencyReport(baselinePath);
    for (const entry of report.irmaaCliffYears) {
      const tierNumber = Number(entry.tier.match(/\d+/)?.[0] ?? 1);
      expect(tierNumber).toBeGreaterThanOrEqual(3);
    }
  });

  it('roth conversion totals are non-negative and sensible', () => {
    const report = computeTaxEfficiencyReport(baselinePath);
    expect(report.rothConversionYearsCount).toBeGreaterThanOrEqual(0);
    expect(report.lifetimeRothConversionAmount).toBeGreaterThanOrEqual(0);
    if (report.rothConversionYearsCount > 0) {
      expect(report.lifetimeRothConversionAmount).toBeGreaterThan(0);
    }
  });
});
