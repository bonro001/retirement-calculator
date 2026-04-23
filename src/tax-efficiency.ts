import type { PathResult, PathYearResult } from './types';

// BACKLOG item: "Surface tax efficiency in the model." Turn the engine's
// per-year tax diagnostics into decision-driving headlines — lifetime
// total, decomposition by category, heat-year identification, IRMAA
// cliff exposure, and a simple "what's costing us the most" ranking.
//
// Pure function of a PathResult. Zero UI dependencies so it can also be
// consumed by planning-export, headless analyses, and tests.

export interface TaxCategoryContribution {
  key: 'federal' | 'irmaa' | 'medicareSurcharge';
  label: string;
  lifetimeTotal: number;
  sharePct: number;
}

export interface TaxHeatYear {
  year: number;
  federalTax: number;
  irmaaSurcharge: number;
  totalTaxBurden: number;
  primaryDriver: 'rmd' | 'roth_conversion' | 'windfall' | 'ordinary';
  driverDetail: string;
  magi: number;
  irmaaTier: string;
}

export interface TaxEfficiencyReport {
  lifetimeFederalTax: number;
  lifetimeIrmaaSurcharge: number;
  lifetimeHealthcarePremiumCost: number;
  lifetimeMedianIncome: number;
  effectiveLifetimeFederalRate: number; // federal tax / lifetime income
  totalTaxBurden: number; // federal + IRMAA
  categoryContributions: TaxCategoryContribution[];
  // Top 5 years by total tax burden. Useful for "what's costing me most"
  // visualization.
  heatYears: TaxHeatYear[];
  // Years in IRMAA tier 3+ (i.e., middle or worse). Every year here is a
  // potential optimization target.
  irmaaCliffYears: Array<{ year: number; tier: string; surcharge: number }>;
  // If Roth conversions were executed, estimate the tax paid ON conversions
  // so the user can see "how much are we pre-paying to avoid RMD pressure".
  rothConversionYearsCount: number;
  lifetimeRothConversionAmount: number;
}

function summarizePrimaryDriver(year: PathYearResult): {
  driver: TaxHeatYear['primaryDriver'];
  detail: string;
} {
  if ((year.medianWindfallOrdinaryIncome ?? 0) + (year.medianWindfallLtcgIncome ?? 0) > 10_000) {
    const windfall =
      (year.medianWindfallOrdinaryIncome ?? 0) + (year.medianWindfallLtcgIncome ?? 0);
    return {
      driver: 'windfall',
      detail: `$${Math.round(windfall).toLocaleString()} windfall realized this year`,
    };
  }
  if ((year.medianRothConversion ?? 0) > 5_000) {
    return {
      driver: 'roth_conversion',
      detail: `$${Math.round(year.medianRothConversion).toLocaleString()} Roth conversion drove taxable income up`,
    };
  }
  if ((year.medianRmdAmount ?? 0) > 10_000) {
    return {
      driver: 'rmd',
      detail: `$${Math.round(year.medianRmdAmount).toLocaleString()} RMD forced taxable distribution`,
    };
  }
  return {
    driver: 'ordinary',
    detail: 'Driven by ordinary retirement income + Social Security taxation.',
  };
}

function parseTier(label: string): number {
  const match = label.match(/Tier\s+(\d+)/i);
  return match ? Number(match[1]) : 1;
}

export function computeTaxEfficiencyReport(path: PathResult): TaxEfficiencyReport {
  const years = path.yearlySeries;
  const lifetimeFederalTax = years.reduce((sum, y) => sum + y.medianFederalTax, 0);
  const lifetimeIrmaaSurcharge = years.reduce(
    (sum, y) => sum + (y.medianIrmaaSurcharge ?? 0),
    0,
  );
  const lifetimeHealthcarePremiumCost = years.reduce(
    (sum, y) => sum + (y.medianTotalHealthcarePremiumCost ?? 0),
    0,
  );
  const lifetimeMedianIncome = years.reduce((sum, y) => sum + y.medianIncome, 0);
  const totalTaxBurden = lifetimeFederalTax + lifetimeIrmaaSurcharge;

  const effectiveLifetimeFederalRate =
    lifetimeMedianIncome > 0 ? lifetimeFederalTax / lifetimeMedianIncome : 0;

  const medicareExcessCost = Math.max(
    0,
    lifetimeHealthcarePremiumCost - lifetimeIrmaaSurcharge,
  );

  const categoryContributions: TaxCategoryContribution[] = [
    {
      key: 'federal',
      label: 'Federal income tax',
      lifetimeTotal: lifetimeFederalTax,
      sharePct: 0,
    },
    {
      key: 'irmaa',
      label: 'IRMAA Medicare surcharge',
      lifetimeTotal: lifetimeIrmaaSurcharge,
      sharePct: 0,
    },
    {
      key: 'medicareSurcharge',
      label: 'Medicare premiums (baseline)',
      lifetimeTotal: medicareExcessCost,
      sharePct: 0,
    },
  ];
  const totalForShare = categoryContributions.reduce((s, c) => s + c.lifetimeTotal, 0);
  for (const contribution of categoryContributions) {
    contribution.sharePct =
      totalForShare > 0 ? contribution.lifetimeTotal / totalForShare : 0;
  }

  const heatYearCandidates = years
    .map((year) => {
      const federalTax = year.medianFederalTax;
      const irmaaSurcharge = year.medianIrmaaSurcharge ?? 0;
      const totalTaxBurdenForYear = federalTax + irmaaSurcharge;
      const driver = summarizePrimaryDriver(year);
      return {
        year: year.year,
        federalTax,
        irmaaSurcharge,
        totalTaxBurden: totalTaxBurdenForYear,
        primaryDriver: driver.driver,
        driverDetail: driver.detail,
        magi: year.medianMagi ?? 0,
        irmaaTier: year.dominantIrmaaTier ?? 'Tier 1',
      };
    })
    .filter((candidate) => candidate.totalTaxBurden > 0)
    .sort((a, b) => b.totalTaxBurden - a.totalTaxBurden);
  const heatYears = heatYearCandidates.slice(0, 5);

  const irmaaCliffYears = years
    .filter((year) => parseTier(year.dominantIrmaaTier ?? 'Tier 1') >= 3)
    .map((year) => ({
      year: year.year,
      tier: year.dominantIrmaaTier,
      surcharge: year.medianIrmaaSurcharge ?? 0,
    }));

  const rothConversionYears = years.filter(
    (year) => (year.medianRothConversion ?? 0) > 0,
  );
  const rothConversionYearsCount = rothConversionYears.length;
  const lifetimeRothConversionAmount = rothConversionYears.reduce(
    (sum, year) => sum + (year.medianRothConversion ?? 0),
    0,
  );

  return {
    lifetimeFederalTax,
    lifetimeIrmaaSurcharge,
    lifetimeHealthcarePremiumCost,
    lifetimeMedianIncome,
    effectiveLifetimeFederalRate,
    totalTaxBurden,
    categoryContributions,
    heatYears,
    irmaaCliffYears,
    rothConversionYearsCount,
    lifetimeRothConversionAmount,
  };
}
