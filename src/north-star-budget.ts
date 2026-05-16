import type {
  MonthlyReviewCertification,
  MonthlyReviewSpendingPathMetrics,
} from './monthly-review';
import {
  protectedReserveFromTarget,
  type ProtectedReserveGoal,
} from './protected-reserve';
import type { PathResult } from './types';

export type NorthStarBudgetVerdict = 'green' | 'yellow' | 'red' | 'pending';

export interface NorthStarBudget {
  year: number | null;
  verdict: NorthStarBudgetVerdict;
  source: 'certification_trace' | 'path_trace' | 'target_only';
  totalAnnualBudget: number | null;
  totalMonthlyBudget: number | null;
  lifestyleAnnual: number | null;
  coreAnnual: number | null;
  travelAnnual: number | null;
  spendAndHealthAnnual: number | null;
  healthcareAndOtherAnnual: number | null;
  federalTaxAnnual: number | null;
  protectedReserve: ProtectedReserveGoal;
  legacyTarget: number;
  medianEndingWealth: number | null;
}

function reserveGoalForInput(input: {
  legacyTarget: number;
  protectedReserve?: ProtectedReserveGoal;
}) {
  return input.protectedReserve ?? protectedReserveFromTarget(input.legacyTarget);
}

export function deflateNominalYearValue(
  value: number,
  year: number,
  baseYear: number,
  inflation: number,
): number {
  if (!Number.isFinite(value)) return 0;
  return value / Math.pow(1 + inflation, Math.max(0, year - baseYear));
}

function annualSpendRowForYear(
  spendingPath: MonthlyReviewSpendingPathMetrics | null,
  year: number | null,
) {
  const rows = spendingPath?.annualSpendRows ?? [];
  if (rows.length === 0) return null;
  return rows.find((row) => year === null || row.year >= year) ?? rows[0] ?? null;
}

export function lifestyleAnnualForYear(input: {
  spendingPath: MonthlyReviewSpendingPathMetrics | null;
  year: number | null;
  fallbackCoreAnnual: number | null;
  fallbackTravelAnnual: number;
}): {
  lifestyleAnnual: number | null;
  coreAnnual: number | null;
  travelAnnual: number | null;
} {
  const row = annualSpendRowForYear(input.spendingPath, input.year);
  const coreAnnual =
    row?.coreAnnualSpendTodayDollars ??
    (input.fallbackCoreAnnual !== null && Number.isFinite(input.fallbackCoreAnnual)
      ? input.fallbackCoreAnnual
      : null);
  const travelAnnual =
    row?.travelAnnualSpendTodayDollars ??
    (input.fallbackTravelAnnual > 0 ? input.fallbackTravelAnnual : 0);
  const lifestyleAnnual =
    row?.annualSpendTodayDollars ??
    (coreAnnual === null ? null : coreAnnual + Math.max(0, travelAnnual));
  return {
    lifestyleAnnual,
    coreAnnual,
    travelAnnual:
      lifestyleAnnual === null || coreAnnual === null
        ? travelAnnual
        : Math.max(0, lifestyleAnnual - coreAnnual),
  };
}

export function buildPendingNorthStarBudget(input: {
  year: number | null;
  verdict?: NorthStarBudgetVerdict;
  spendingPath: MonthlyReviewSpendingPathMetrics | null;
  fallbackCoreAnnual: number | null;
  fallbackTravelAnnual: number;
  legacyTarget: number;
  protectedReserve?: ProtectedReserveGoal;
  medianEndingWealth?: number | null;
}): NorthStarBudget {
  const protectedReserve = reserveGoalForInput(input);
  const lifestyle = lifestyleAnnualForYear({
    spendingPath: input.spendingPath,
    year: input.year,
    fallbackCoreAnnual: input.fallbackCoreAnnual,
    fallbackTravelAnnual: input.fallbackTravelAnnual,
  });
  return {
    year: input.year,
    verdict: input.verdict ?? 'pending',
    source: 'target_only',
    totalAnnualBudget: null,
    totalMonthlyBudget: null,
    lifestyleAnnual: lifestyle.lifestyleAnnual,
    coreAnnual: lifestyle.coreAnnual,
    travelAnnual: lifestyle.travelAnnual,
    spendAndHealthAnnual: null,
    healthcareAndOtherAnnual: null,
    federalTaxAnnual: null,
    protectedReserve,
    legacyTarget: protectedReserve.legacyAliasTodayDollars,
    medianEndingWealth: input.medianEndingWealth ?? null,
  };
}

export function buildNorthStarBudgetFromCertification(input: {
  cert: MonthlyReviewCertification;
  spendingPath: MonthlyReviewSpendingPathMetrics | null;
  retirementYear: number | null;
  inflation: number;
  legacyTarget: number;
  protectedReserve?: ProtectedReserveGoal;
  fallbackTravelAnnual: number;
}): NorthStarBudget {
  const protectedReserve = reserveGoalForInput(input);
  const rows = input.cert.pack.selectedPathEvidence?.yearlyRows ?? [];
  const baseYear = rows[0]?.year ?? null;
  const row =
    rows.find((item) => input.retirementYear === null || item.year >= input.retirementYear) ??
    rows[0] ??
    null;
  const targetYear = row?.year ?? input.retirementYear;
  const lifestyle = lifestyleAnnualForYear({
    spendingPath: input.spendingPath,
    year: targetYear,
    fallbackCoreAnnual: input.cert.evaluation.policy.annualSpendTodayDollars,
    fallbackTravelAnnual: input.fallbackTravelAnnual,
  });
  const medianEndingWealth =
    input.cert.pack.selectedPathEvidence?.outcome?.p50EndingWealthTodayDollars ??
    input.cert.evaluation.outcome.p50EndingWealthTodayDollars ??
    null;

  if (!row || baseYear === null) {
    return buildPendingNorthStarBudget({
      year: targetYear,
      verdict: input.cert.verdict,
      spendingPath: input.spendingPath,
      fallbackCoreAnnual: input.cert.evaluation.policy.annualSpendTodayDollars,
      fallbackTravelAnnual: input.fallbackTravelAnnual,
      legacyTarget: protectedReserve.legacyAliasTodayDollars,
      protectedReserve,
      medianEndingWealth,
    });
  }

  const spendAndHealthAnnual = deflateNominalYearValue(
    row.medianSpending,
    row.year,
    baseYear,
    input.inflation,
  );
  const federalTaxAnnual = deflateNominalYearValue(
    row.medianFederalTax,
    row.year,
    baseYear,
    input.inflation,
  );
  const totalAnnualBudget = spendAndHealthAnnual + federalTaxAnnual;

  return {
    year: row.year,
    verdict: input.cert.verdict,
    source: 'certification_trace',
    totalAnnualBudget,
    totalMonthlyBudget: totalAnnualBudget / 12,
    lifestyleAnnual: lifestyle.lifestyleAnnual,
    coreAnnual: lifestyle.coreAnnual,
    travelAnnual: lifestyle.travelAnnual,
    spendAndHealthAnnual,
    healthcareAndOtherAnnual:
      lifestyle.lifestyleAnnual === null
        ? null
        : Math.max(0, spendAndHealthAnnual - lifestyle.lifestyleAnnual),
    federalTaxAnnual,
    protectedReserve,
    legacyTarget: protectedReserve.legacyAliasTodayDollars,
    medianEndingWealth,
  };
}

export function buildNorthStarBudgetFromPath(input: {
  path: PathResult;
  year: number | null;
  spendingPath: MonthlyReviewSpendingPathMetrics | null;
  fallbackCoreAnnual: number | null;
  fallbackTravelAnnual: number;
  inflation: number;
  legacyTarget: number;
  protectedReserve?: ProtectedReserveGoal;
  verdict?: NorthStarBudgetVerdict;
}): NorthStarBudget {
  const protectedReserve = reserveGoalForInput(input);
  const rows = input.path.yearlySeries ?? [];
  const baseYear = rows[0]?.year ?? null;
  const row =
    rows.find((item) => input.year === null || item.year >= input.year) ??
    rows[0] ??
    null;
  const targetYear = row?.year ?? input.year;
  const lifestyle = lifestyleAnnualForYear({
    spendingPath: input.spendingPath,
    year: targetYear,
    fallbackCoreAnnual: input.fallbackCoreAnnual,
    fallbackTravelAnnual: input.fallbackTravelAnnual,
  });

  if (!row || baseYear === null) {
    return buildPendingNorthStarBudget({
      year: targetYear,
      verdict: input.verdict,
      spendingPath: input.spendingPath,
      fallbackCoreAnnual: input.fallbackCoreAnnual,
      fallbackTravelAnnual: input.fallbackTravelAnnual,
      legacyTarget: protectedReserve.legacyAliasTodayDollars,
      protectedReserve,
      medianEndingWealth: input.path.medianEndingWealth ?? null,
    });
  }

  const spendAndHealthAnnual = deflateNominalYearValue(
    row.medianSpending,
    row.year,
    baseYear,
    input.inflation,
  );
  const federalTaxAnnual = deflateNominalYearValue(
    row.medianFederalTax,
    row.year,
    baseYear,
    input.inflation,
  );
  const totalAnnualBudget = deflateNominalYearValue(
    row.medianTotalCashOutflow ?? row.medianSpending + row.medianFederalTax,
    row.year,
    baseYear,
    input.inflation,
  );

  return {
    year: row.year,
    verdict: input.verdict ?? 'green',
    source: 'path_trace',
    totalAnnualBudget,
    totalMonthlyBudget: totalAnnualBudget / 12,
    lifestyleAnnual: lifestyle.lifestyleAnnual,
    coreAnnual: lifestyle.coreAnnual,
    travelAnnual: lifestyle.travelAnnual,
    spendAndHealthAnnual,
    healthcareAndOtherAnnual:
      lifestyle.lifestyleAnnual === null
        ? null
        : Math.max(0, spendAndHealthAnnual - lifestyle.lifestyleAnnual),
    federalTaxAnnual,
    protectedReserve,
    legacyTarget: protectedReserve.legacyAliasTodayDollars,
    medianEndingWealth: input.path.medianEndingWealth ?? null,
  };
}

export function buildNorthStarBudgetSeriesFromPath(input: {
  path: PathResult;
  spendingPath: MonthlyReviewSpendingPathMetrics | null;
  inflation: number;
  legacyTarget: number;
  protectedReserve?: ProtectedReserveGoal;
  medianEndingWealth: number | null;
  verdict?: NorthStarBudgetVerdict;
}): NorthStarBudget[] {
  const protectedReserve = reserveGoalForInput(input);
  const baseYear = input.path.yearlySeries[0]?.year ?? null;
  if (baseYear === null) return [];
  const firstTargetYear =
    input.spendingPath?.annualSpendRows.find(
      (row) => row.annualSpendTodayDollars > 0,
    )?.year ?? input.path.yearlySeries[0]?.year ?? null;

  return input.path.yearlySeries
    .filter((row) => firstTargetYear === null || row.year >= firstTargetYear)
    .map((row) => {
      const lifestyle = lifestyleAnnualForYear({
        spendingPath: input.spendingPath,
        year: row.year,
        fallbackCoreAnnual: null,
        fallbackTravelAnnual: 0,
      });
      const spendAndHealthAnnual = deflateNominalYearValue(
        row.medianSpending,
        row.year,
        baseYear,
        input.inflation,
      );
      const federalTaxAnnual = deflateNominalYearValue(
        row.medianFederalTax,
        row.year,
        baseYear,
        input.inflation,
      );
      const totalAnnualBudget = deflateNominalYearValue(
        row.medianTotalCashOutflow ?? row.medianSpending + row.medianFederalTax,
        row.year,
        baseYear,
        input.inflation,
      );
      return {
        year: row.year,
        verdict: input.verdict ?? 'green',
        source: 'path_trace' as const,
        totalAnnualBudget,
        totalMonthlyBudget: totalAnnualBudget / 12,
        lifestyleAnnual: lifestyle.lifestyleAnnual,
        coreAnnual: lifestyle.coreAnnual,
        travelAnnual: lifestyle.travelAnnual,
        spendAndHealthAnnual,
        healthcareAndOtherAnnual:
          lifestyle.lifestyleAnnual === null
            ? null
            : Math.max(0, spendAndHealthAnnual - lifestyle.lifestyleAnnual),
        federalTaxAnnual,
        protectedReserve,
        legacyTarget: protectedReserve.legacyAliasTodayDollars,
        medianEndingWealth: input.medianEndingWealth,
      };
    })
    .filter((row) => row.totalAnnualBudget !== null && row.totalAnnualBudget > 0);
}
