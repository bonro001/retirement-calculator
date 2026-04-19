import type { PathResult } from '../types';
import { calculateCurrentAges } from '../utils';
import type { PlannerInput, ScenarioDelta, ScenarioMetrics } from './types';

function getEarliestFailureYear(path: PathResult) {
  const nonZero = path.failureYearDistribution.filter((point) => point.count > 0);
  if (!nonZero.length) {
    return null;
  }
  return nonZero.map((point) => point.year).sort((left, right) => left - right)[0];
}

function getFirstSocialSecurityYear(path: PathResult, input: PlannerInput) {
  const startYear = path.yearlySeries[0]?.year ?? new Date('2026-04-16T12:00:00Z').getUTCFullYear();
  const ages = calculateCurrentAges(input.data);
  const years = input.data.income.socialSecurity.map((entry) => {
    const currentAge = entry.person === 'rob' ? ages.rob : ages.debbie;
    const offset = Math.max(0, Math.ceil(entry.claimAge - currentAge));
    return startYear + offset;
  });
  return years.length ? Math.min(...years) : Number.POSITIVE_INFINITY;
}

function getInheritanceYear(input: PlannerInput) {
  const inheritance = input.data.income.windfalls.find(
    (windfall) => windfall.name === 'inheritance' && windfall.amount > 0,
  );
  return inheritance?.year ?? Number.POSITIVE_INFINITY;
}

function getFailureRateBeforeYear(path: PathResult, yearThreshold: number) {
  const trialCount = path.monteCarloMetadata.trialCount;
  if (trialCount <= 0) {
    return 0;
  }
  const failuresBeforeThreshold = path.failureYearDistribution
    .filter((point) => point.year < yearThreshold)
    .reduce((sum, point) => sum + point.count, 0);
  return failuresBeforeThreshold / trialCount;
}

export function toScenarioMetrics(path: PathResult, input: PlannerInput): ScenarioMetrics {
  const startYear = path.yearlySeries[0]?.year ?? new Date('2026-04-16T12:00:00Z').getUTCFullYear();
  const firstSocialSecurityYear = getFirstSocialSecurityYear(path, input);
  const inheritanceYear = getInheritanceYear(input);
  const percentFailFirst10Years = getFailureRateBeforeYear(path, startYear + 10);

  return {
    successRate: path.successRate,
    failureRate: 1 - path.successRate,
    medianEndingWealth: path.medianEndingWealth,
    p10EndingWealth: path.endingWealthPercentiles.p10,
    p90EndingWealth: path.endingWealthPercentiles.p90,
    earliestFailureYear: getEarliestFailureYear(path),
    percentFailBeforeSocialSecurity: getFailureRateBeforeYear(path, firstSocialSecurityYear),
    percentFailBeforeInheritance: getFailureRateBeforeYear(path, inheritanceYear),
    percentFailFirst10Years,
  };
}

export function toScenarioDelta(
  baseline: ScenarioMetrics,
  scenario: ScenarioMetrics,
): ScenarioDelta {
  return {
    deltaSuccessRate: scenario.successRate - baseline.successRate,
    deltaMedianEndingWealth: scenario.medianEndingWealth - baseline.medianEndingWealth,
    deltaP10EndingWealth: scenario.p10EndingWealth - baseline.p10EndingWealth,
    deltaEarliestFailureYear:
      scenario.earliestFailureYear !== null && baseline.earliestFailureYear !== null
        ? scenario.earliestFailureYear - baseline.earliestFailureYear
        : null,
    deltaFailFirst10Years: scenario.percentFailFirst10Years - baseline.percentFailFirst10Years,
  };
}
