import { getHoldingExposure } from '../asset-class-mapper';
import type { PlannerInput } from './types';

const PLANNING_YEAR = new Date('2026-04-16T12:00:00Z').getUTCFullYear();

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function clonePlannerInput(input: PlannerInput): PlannerInput {
  return {
    ...deepClone(input),
    selectedStressors: [...input.selectedStressors],
    selectedResponses: [...input.selectedResponses],
  };
}

function shiftIsoDateByMonths(isoDate: string, monthDelta: number) {
  const next = new Date(isoDate);
  next.setUTCMonth(next.getUTCMonth() + monthDelta);
  return next.toISOString();
}

export function reduceOptionalSpending(input: PlannerInput, percent: number): PlannerInput {
  const next = clonePlannerInput(input);
  const multiplier = 1 - percent / 100;
  next.data.spending.optionalMonthly = Math.max(0, next.data.spending.optionalMonthly * multiplier);
  return next;
}

export function reduceTravelBudget(input: PlannerInput, annualAmount: number): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.spending.travelEarlyRetirementAnnual = Math.max(
    0,
    next.data.spending.travelEarlyRetirementAnnual - annualAmount,
  );
  return next;
}

export function reduceEssentialSpending(input: PlannerInput, percent: number): PlannerInput {
  const next = clonePlannerInput(input);
  const multiplier = 1 - percent / 100;
  next.data.spending.essentialMonthly = Math.max(0, next.data.spending.essentialMonthly * multiplier);
  return next;
}

export function enableResponse(input: PlannerInput, responseId: string): PlannerInput {
  const next = clonePlannerInput(input);
  if (!next.selectedResponses.includes(responseId)) {
    next.selectedResponses = [...next.selectedResponses, responseId];
  }
  return next;
}

export function delayRetirement(input: PlannerInput, months: number): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.income.salaryEndDate = shiftIsoDateByMonths(next.data.income.salaryEndDate, months);
  return next;
}

export function shiftSocialSecurityClaim(input: PlannerInput, years: number): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.income.socialSecurity = next.data.income.socialSecurity.map((entry) => ({
    ...entry,
    claimAge: clamp(entry.claimAge + years, 62, 70),
  }));
  return next;
}

function normalizeAllocation(allocation: Record<string, number>) {
  const entries = Object.entries(allocation).map(([symbol, weight]) => [
    symbol,
    Math.max(0, weight),
  ]) as Array<[string, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) {
    return { CASH: 1 };
  }
  return Object.fromEntries(entries.map(([symbol, weight]) => [symbol, weight / total]));
}

function shiftAllocationToBonds(allocation: Record<string, number>, increasePercent: number) {
  const normalized = normalizeAllocation(allocation);
  const entries = Object.entries(normalized) as Array<[string, number]>;
  const equityContribution = entries.map(([symbol, weight]) => {
    const exposure = getHoldingExposure(symbol);
    return {
      symbol,
      weight,
      equityShare: (exposure.US_EQUITY ?? 0) + (exposure.INTL_EQUITY ?? 0),
      bondShare: exposure.BONDS ?? 0,
    };
  });
  const totalEquityWeight = equityContribution.reduce(
    (sum, row) => sum + row.weight * row.equityShare,
    0,
  );
  if (totalEquityWeight <= 0) {
    return normalized;
  }

  const desiredShift = clamp(increasePercent / 100, 0, totalEquityWeight);
  const next = { ...normalized };
  equityContribution.forEach((row) => {
    const weightedEquity = row.weight * row.equityShare;
    if (weightedEquity <= 0) {
      return;
    }
    const reduction = desiredShift * (weightedEquity / totalEquityWeight);
    next[row.symbol] = Math.max(0, (next[row.symbol] ?? 0) - reduction);
  });

  const bondRows = equityContribution.filter((row) => row.bondShare > 0);
  if (!bondRows.length) {
    next.BND = (next.BND ?? 0) + desiredShift;
  } else {
    const totalBondWeight = bondRows.reduce(
      (sum, row) => sum + row.weight * row.bondShare,
      0,
    );
    bondRows.forEach((row) => {
      const weightedBond = row.weight * row.bondShare;
      const share =
        totalBondWeight > 0 ? weightedBond / totalBondWeight : 1 / bondRows.length;
      next[row.symbol] = (next[row.symbol] ?? 0) + desiredShift * share;
    });
  }

  return normalizeAllocation(next);
}

export function increaseBondAllocation(
  input: PlannerInput,
  increasePercent: number,
): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.accounts.pretax.targetAllocation = shiftAllocationToBonds(
    next.data.accounts.pretax.targetAllocation,
    increasePercent,
  );
  next.data.accounts.roth.targetAllocation = shiftAllocationToBonds(
    next.data.accounts.roth.targetAllocation,
    increasePercent,
  );
  next.data.accounts.taxable.targetAllocation = shiftAllocationToBonds(
    next.data.accounts.taxable.targetAllocation,
    increasePercent,
  );
  if (next.data.accounts.hsa) {
    next.data.accounts.hsa.targetAllocation = shiftAllocationToBonds(
      next.data.accounts.hsa.targetAllocation,
      increasePercent,
    );
  }
  return next;
}

export function removeWindfall(input: PlannerInput, name: string): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.income.windfalls = next.data.income.windfalls.map((item) =>
    item.name === name ? { ...item, amount: 0 } : item,
  );
  return next;
}

export function moveWindfallLater(
  input: PlannerInput,
  name: string,
  years: number,
): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.income.windfalls = next.data.income.windfalls.map((item) =>
    item.name === name ? { ...item, year: item.year + years } : item,
  );
  return next;
}

export function moveHomeSaleYear(
  input: PlannerInput,
  yearDelta: number,
): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.income.windfalls = next.data.income.windfalls.map((item) =>
    item.name === 'home_sale'
      ? { ...item, year: Math.max(PLANNING_YEAR, item.year + yearDelta) }
      : item,
  );
  return next;
}

export function keepHouse(input: PlannerInput): PlannerInput {
  const next = removeWindfall(input, 'home_sale');
  next.selectedResponses = next.selectedResponses.filter((id) => id !== 'sell_home_early');
  return next;
}

export function composeTransforms(
  input: PlannerInput,
  transforms: Array<(state: PlannerInput) => PlannerInput>,
) {
  return transforms.reduce((current, transform) => transform(current), clonePlannerInput(input));
}

export function fnv1aHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
