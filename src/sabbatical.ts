import type { IncomeData, SabbaticalObligation } from './types';

export interface SabbaticalRepayment {
  weeksOwed: number;
  dollars: number;
  zeroObligationDate: string;
}

function parseIsoDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthsBetween(from: Date, to: Date): number {
  const wholeMonths =
    (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  const dayFraction = (to.getDate() - from.getDate()) / 30;
  return wholeMonths + dayFraction;
}

export function computeSabbaticalRepayment(
  retireDate: string | Date,
  salaryAnnual: number,
  obligation: SabbaticalObligation | undefined,
): SabbaticalRepayment | null {
  if (!obligation) return null;
  const start = parseIsoDate(obligation.returnDate);
  const retire = retireDate instanceof Date ? retireDate : parseIsoDate(retireDate);
  if (!start || !retire) return null;

  const monthsWorked = Math.max(0, monthsBetween(start, retire));
  const weeksForgiven = monthsWorked * obligation.weeksForgivenPerMonth;
  const weeksOwed = Math.max(0, obligation.paidWeeks - weeksForgiven);

  const weeklySalary = salaryAnnual / 52;
  const dollars = Math.round(weeksOwed * weeklySalary);

  const monthsToClear = obligation.paidWeeks / obligation.weeksForgivenPerMonth;
  const zeroDate = new Date(start);
  zeroDate.setMonth(zeroDate.getMonth() + Math.ceil(monthsToClear));

  return {
    weeksOwed: Math.round(weeksOwed * 10) / 10,
    dollars,
    zeroObligationDate: zeroDate.toISOString().slice(0, 10),
  };
}

export interface RetirementDateSensitivityPoint {
  monthsShift: number;
  shiftedRetireDate: string;
  salaryIncomeDelta: number;
  magiDelta: number;
  sabbaticalRepayment: number;
  netCashDelta: number;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

export function computeRetirementDateSensitivity(
  income: IncomeData,
  offsets: number[] = [-6, -3, 3, 6],
): RetirementDateSensitivityPoint[] {
  const base = parseIsoDate(income.salaryEndDate);
  if (!base) return [];

  const salaryAnnual = Math.max(0, income.salaryAnnual);
  const monthlySalary = salaryAnnual / 12;
  const preTaxRate = income.preRetirementContributions?.employee401kPreTaxPercentOfSalary ?? 0;
  const hsaRate = income.preRetirementContributions?.hsaPercentOfSalary ?? 0;
  const magiMonthly = monthlySalary * (1 - preTaxRate - hsaRate);

  return offsets.map((monthsShift) => {
    const shifted = addMonths(base, monthsShift);
    const salaryIncomeDelta = Math.round(monthlySalary * monthsShift);
    const magiDelta = Math.round(magiMonthly * monthsShift);
    const repayment =
      computeSabbaticalRepayment(shifted, salaryAnnual, income.sabbatical)?.dollars ?? 0;
    return {
      monthsShift,
      shiftedRetireDate: shifted.toISOString().slice(0, 10),
      salaryIncomeDelta,
      magiDelta,
      sabbaticalRepayment: repayment,
      netCashDelta: salaryIncomeDelta - repayment,
    };
  });
}
