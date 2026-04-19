import type { DecisionEngineReport, LeverScenarioResult, ScenarioMetrics } from './decision-engine';
import type { PathResult } from './types';

export type ExplainabilityPrimaryIssue =
  | 'early_sequence_risk'
  | 'spending_level'
  | 'weak_assumptions'
  | 'timing';

export interface ExplainabilityFailureProfile {
  successRate: number;
  failureRate: number;
  percentFailFirst10Years: number;
  percentFailBeforeSocialSecurity: number;
  percentFailBeforeInheritance: number;
  medianFailureYear: number | null;
  medianFailureYearsFromStart: number | null;
}

export interface ExplainabilityDependencyProfile {
  inheritanceDependenceRate: number;
  homeSaleDependenceRate: number;
  inheritanceSensitivityDeltaSuccessRate: number | null;
  homeSaleSensitivityDeltaSuccessRate: number | null;
  isInheritanceDependent: boolean;
  isHomeSaleDependent: boolean;
}

export interface ExplainabilityReport {
  primaryIssue: ExplainabilityPrimaryIssue;
  primaryIssueExplanation: string;
  failureProfile: ExplainabilityFailureProfile;
  dependencyProfile: ExplainabilityDependencyProfile;
  driverScores: Record<ExplainabilityPrimaryIssue, number>;
  whyFailuresHappen: string[];
  whenFailuresHappen: string[];
  summaryLines: string[];
  riskFlags: string[];
}

export interface ExplainabilityInput {
  baseline: ScenarioMetrics;
  scenarios: LeverScenarioResult[];
  medianFailureYear: number | null;
  planningStartYear: number;
  inheritanceDependenceRate: number;
  homeSaleDependenceRate: number;
}

const ISSUE_TIE_BREAK_ORDER: ExplainabilityPrimaryIssue[] = [
  'weak_assumptions',
  'early_sequence_risk',
  'timing',
  'spending_level',
];

const INHERITANCE_DEPENDENCE_THRESHOLD = 0.35;
const HOME_SALE_DEPENDENCE_THRESHOLD = 0.35;
const SENSITIVITY_DEPENDENCE_DELTA_THRESHOLD = -0.08;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

function findScenarioById(scenarios: LeverScenarioResult[], scenarioId: string) {
  return scenarios.find((item) => item.scenarioId === scenarioId);
}

function minValue(values: Array<number | null | undefined>) {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length ? Math.min(...filtered) : null;
}

function maxSuccessDeltaForCategory(
  scenarios: LeverScenarioResult[],
  category: LeverScenarioResult['category'],
) {
  return scenarios
    .filter((scenario) => scenario.category === category)
    .reduce((best, scenario) => Math.max(best, scenario.delta.deltaSuccessRate), 0);
}

function getPrimaryIssueExplanation(issue: ExplainabilityPrimaryIssue) {
  if (issue === 'early_sequence_risk') {
    return 'The plan is primarily vulnerable to early retirement sequence risk.';
  }
  if (issue === 'spending_level') {
    return 'The plan is primarily constrained by the current spending level.';
  }
  if (issue === 'weak_assumptions') {
    return 'The plan is primarily constrained by assumption fragility (inheritance/home-sale dependence).';
  }
  return 'The plan is primarily constrained by timing of income and withdrawals.';
}

function choosePrimaryIssue(scores: Record<ExplainabilityPrimaryIssue, number>) {
  const bestScore = Math.max(...Object.values(scores));
  const ties = ISSUE_TIE_BREAK_ORDER.filter((issue) => Math.abs(scores[issue] - bestScore) < 1e-9);
  return ties[0] ?? 'early_sequence_risk';
}

function buildRiskFlags(
  failureProfile: ExplainabilityFailureProfile,
  dependencyProfile: ExplainabilityDependencyProfile,
  primaryIssue: ExplainabilityPrimaryIssue,
) {
  const flags: string[] = [primaryIssue];
  if (failureProfile.percentFailFirst10Years >= 0.35) {
    flags.push('early_failures_concentrated');
  }
  if (failureProfile.percentFailBeforeSocialSecurity >= 0.45) {
    flags.push('pre_social_security_failure_pressure');
  }
  if (failureProfile.percentFailBeforeInheritance >= 0.45) {
    flags.push('pre_inheritance_failure_pressure');
  }
  if (dependencyProfile.isInheritanceDependent) {
    flags.push('inheritance_dependency');
  }
  if (dependencyProfile.isHomeSaleDependent) {
    flags.push('home_sale_dependency');
  }
  return flags;
}

function buildWhenFailuresHappen(failureProfile: ExplainabilityFailureProfile) {
  const lines: string[] = [];
  lines.push(
    `${formatPercent(failureProfile.percentFailFirst10Years)} of trials fail within the first 10 years.`,
  );
  lines.push(
    `${formatPercent(failureProfile.percentFailBeforeSocialSecurity)} of trials fail before Social Security starts.`,
  );
  lines.push(
    `${formatPercent(failureProfile.percentFailBeforeInheritance)} of trials fail before inheritance arrives.`,
  );
  if (failureProfile.medianFailureYear !== null) {
    const offset =
      failureProfile.medianFailureYearsFromStart !== null
        ? ` (about ${failureProfile.medianFailureYearsFromStart} years into the plan)`
        : '';
    lines.push(`Median failure timing is around year ${failureProfile.medianFailureYear}${offset}.`);
  } else {
    lines.push('There is no median failure year because most runs do not fail.');
  }
  return lines;
}

function buildWhyFailuresHappen(
  primaryIssue: ExplainabilityPrimaryIssue,
  failureProfile: ExplainabilityFailureProfile,
  dependencyProfile: ExplainabilityDependencyProfile,
) {
  const lines: string[] = [getPrimaryIssueExplanation(primaryIssue)];

  if (failureProfile.percentFailBeforeSocialSecurity >= 0.5) {
    lines.push('Most failed paths run into trouble before Social Security begins.');
  }
  if (failureProfile.percentFailBeforeInheritance >= 0.5) {
    lines.push('Many failed paths run into trouble before inheritance arrives.');
  }
  if (dependencyProfile.isInheritanceDependent) {
    lines.push('The plan relies heavily on the inheritance assumption.');
  }
  if (dependencyProfile.isHomeSaleDependent) {
    lines.push('The plan relies heavily on home-sale proceeds to stay funded.');
  }

  return lines;
}

export function buildExplainabilityReport(input: ExplainabilityInput): ExplainabilityReport {
  const inheritanceSensitivity = findScenarioById(input.scenarios, 'assumption_remove_inheritance');
  const homeSaleSensitivity = minValue([
    findScenarioById(input.scenarios, 'assumption_remove_home_sale')?.delta.deltaSuccessRate,
    findScenarioById(input.scenarios, 'housing_keep_house')?.delta.deltaSuccessRate,
  ]);

  const failureProfile: ExplainabilityFailureProfile = {
    successRate: input.baseline.successRate,
    failureRate: input.baseline.failureRate,
    percentFailFirst10Years: input.baseline.percentFailFirst10Years,
    percentFailBeforeSocialSecurity: input.baseline.percentFailBeforeSocialSecurity,
    percentFailBeforeInheritance: input.baseline.percentFailBeforeInheritance,
    medianFailureYear: input.medianFailureYear,
    medianFailureYearsFromStart:
      input.medianFailureYear !== null ? Math.max(0, input.medianFailureYear - input.planningStartYear) : null,
  };

  const dependencyProfile: ExplainabilityDependencyProfile = {
    inheritanceDependenceRate: input.inheritanceDependenceRate,
    homeSaleDependenceRate: input.homeSaleDependenceRate,
    inheritanceSensitivityDeltaSuccessRate: inheritanceSensitivity?.delta.deltaSuccessRate ?? null,
    homeSaleSensitivityDeltaSuccessRate: homeSaleSensitivity,
    isInheritanceDependent:
      input.inheritanceDependenceRate >= INHERITANCE_DEPENDENCE_THRESHOLD ||
      (inheritanceSensitivity?.delta.deltaSuccessRate ?? 0) <= SENSITIVITY_DEPENDENCE_DELTA_THRESHOLD,
    isHomeSaleDependent:
      input.homeSaleDependenceRate >= HOME_SALE_DEPENDENCE_THRESHOLD ||
      (homeSaleSensitivity ?? 0) <= SENSITIVITY_DEPENDENCE_DELTA_THRESHOLD,
  };

  const bestSpendingGain = maxSuccessDeltaForCategory(input.scenarios, 'spending');
  const bestTimingGain = maxSuccessDeltaForCategory(input.scenarios, 'timing');
  const maxAssumptionDrop = Math.max(
    0,
    -(dependencyProfile.inheritanceSensitivityDeltaSuccessRate ?? 0),
    -(dependencyProfile.homeSaleSensitivityDeltaSuccessRate ?? 0),
  );
  const maxDependenceRate = Math.max(
    dependencyProfile.inheritanceDependenceRate,
    dependencyProfile.homeSaleDependenceRate,
  );

  const driverScores: Record<ExplainabilityPrimaryIssue, number> = {
    early_sequence_risk: clamp01(
      failureProfile.percentFailFirst10Years * 0.55 +
        failureProfile.percentFailBeforeSocialSecurity * 0.3 +
        ((failureProfile.medianFailureYearsFromStart ?? Number.POSITIVE_INFINITY) <= 10 ? 0.15 : 0),
    ),
    spending_level: clamp01(
      clamp01(bestSpendingGain / 0.15) * 0.85 +
        (failureProfile.percentFailFirst10Years >= 0.3 ? 0.15 : 0),
    ),
    weak_assumptions: clamp01(
      maxDependenceRate * 0.6 + clamp01(maxAssumptionDrop / 0.2) * 0.4,
    ),
    timing: clamp01(
      clamp01(bestTimingGain / 0.15) * 0.7 + failureProfile.percentFailBeforeSocialSecurity * 0.3,
    ),
  };

  const primaryIssue = choosePrimaryIssue(driverScores);
  const primaryIssueExplanation = getPrimaryIssueExplanation(primaryIssue);
  const whyFailuresHappen = buildWhyFailuresHappen(primaryIssue, failureProfile, dependencyProfile);
  const whenFailuresHappen = buildWhenFailuresHappen(failureProfile);
  const summaryLines = [...whyFailuresHappen, ...whenFailuresHappen];
  const riskFlags = buildRiskFlags(failureProfile, dependencyProfile, primaryIssue);

  return {
    primaryIssue,
    primaryIssueExplanation,
    failureProfile,
    dependencyProfile,
    driverScores,
    whyFailuresHappen,
    whenFailuresHappen,
    summaryLines,
    riskFlags,
  };
}

export function buildExplainabilityReportFromSimulation(
  baselinePath: Pick<PathResult, 'medianFailureYear' | 'yearlySeries' | 'inheritanceDependenceRate' | 'homeSaleDependenceRate'>,
  decisionReport: Pick<DecisionEngineReport, 'baseline' | 'allScenarioResults'>,
): ExplainabilityReport {
  const planningStartYear =
    baselinePath.yearlySeries[0]?.year ?? new Date('2026-04-16T12:00:00Z').getUTCFullYear();
  return buildExplainabilityReport({
    baseline: decisionReport.baseline,
    scenarios: decisionReport.allScenarioResults,
    medianFailureYear: baselinePath.medianFailureYear,
    planningStartYear,
    inheritanceDependenceRate: baselinePath.inheritanceDependenceRate,
    homeSaleDependenceRate: baselinePath.homeSaleDependenceRate,
  });
}
