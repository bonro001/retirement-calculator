import type { DecisionEngineReport, LeverScenarioResult, ScenarioMetrics } from './types';

function signedPercentPoints(value: number) {
  const points = value * 100;
  const sign = points > 0 ? '+' : '';
  return `${sign}${points.toFixed(1)}`;
}

function absolutePercentPoints(value: number) {
  return `${(Math.abs(value) * 100).toFixed(1)}`;
}

function signedCurrency(value: number) {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toLocaleString()}`;
}

export function buildRecommendationSummary(result: LeverScenarioResult) {
  const successPhrase =
    result.delta.deltaSuccessRate > 0
      ? 'improves'
      : result.delta.deltaSuccessRate < 0
        ? 'reduces'
        : 'keeps';
  const earlyRiskPhrase =
    result.delta.deltaFailFirst10Years < 0
      ? 'reduces'
      : result.delta.deltaFailFirst10Years > 0
        ? 'increases'
        : 'keeps';
  return `${result.name} ${successPhrase} success by ${signedPercentPoints(
    result.delta.deltaSuccessRate,
  )} pts, ${earlyRiskPhrase} first-10-year failure risk by ${absolutePercentPoints(
    result.delta.deltaFailFirst10Years,
  )} pts, and shifts p10 wealth by ${signedCurrency(result.delta.deltaP10EndingWealth)}.`;
}

const BASELINE_RISK_WARNING_THRESHOLD = 0.7;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function maxDeltaSuccessByCategory(
  scenarios: LeverScenarioResult[],
  category: LeverScenarioResult['category'],
) {
  return scenarios
    .filter((scenario) => scenario.category === category && !scenario.excludedByConstraints)
    .reduce((best, scenario) => Math.max(best, scenario.delta.deltaSuccessRate), 0);
}

function inheritanceSensitivityDrop(scenarios: LeverScenarioResult[]) {
  const scenario = scenarios.find(
    (item) =>
      item.scenarioId === 'assumption_remove_inheritance' &&
      !item.excludedByConstraints,
  );
  if (!scenario) {
    return 0;
  }
  return Math.max(0, -scenario.delta.deltaSuccessRate);
}

function deriveBaselineRiskDriver(
  baseline: ScenarioMetrics,
  scenarios: LeverScenarioResult[],
) {
  const sequenceScore =
    baseline.percentFailFirst10Years * 0.65 +
    baseline.percentFailBeforeSocialSecurity * 0.35;

  const spendingRelief = maxDeltaSuccessByCategory(scenarios, 'spending');
  const spendingScore =
    clamp01(spendingRelief / 0.15) * 0.7 +
    clamp01(baseline.percentFailFirst10Years / 0.5) * 0.3;

  const inheritanceDrop = inheritanceSensitivityDrop(scenarios);
  const inheritanceScore =
    clamp01(inheritanceDrop / 0.2) * 0.7 +
    clamp01(baseline.percentFailBeforeInheritance / 0.6) * 0.3;

  const timingRelief = maxDeltaSuccessByCategory(scenarios, 'timing');
  const timingScore =
    clamp01(timingRelief / 0.15) * 0.6 +
    clamp01(baseline.percentFailBeforeSocialSecurity / 0.6) * 0.4;

  const scores = [
    { driver: 'early sequence risk', score: sequenceScore },
    { driver: 'spending level', score: spendingScore },
    { driver: 'reliance on inheritance', score: inheritanceScore },
    { driver: 'timing gap before Social Security', score: timingScore },
  ];

  scores.sort((left, right) => right.score - left.score);
  return scores[0]?.driver ?? 'spending level';
}

export function deriveBaselineRiskWarning(
  baseline: ScenarioMetrics,
  scenarios: LeverScenarioResult[],
) {
  if (baseline.successRate >= BASELINE_RISK_WARNING_THRESHOLD) {
    return null;
  }

  const driver = deriveBaselineRiskDriver(baseline, scenarios);
  return `If no changes are made, the plan has a meaningful risk of failure, primarily driven by ${driver}.`;
}

export function buildTradeoffs(result: LeverScenarioResult) {
  const tradeoffs: string[] = [];
  tradeoffs.push(`Disruption: ${result.disruption}`);
  tradeoffs.push(`Complexity: ${result.complexity}`);

  if (result.delta.deltaMedianEndingWealth < 0) {
    tradeoffs.push('Improves resilience but lowers median legacy outcome.');
  } else if (result.delta.deltaMedianEndingWealth > 0) {
    tradeoffs.push('Improves both resilience and median legacy outcomes.');
  }

  if (result.delta.deltaEarliestFailureYear !== null && result.delta.deltaEarliestFailureYear < 0) {
    tradeoffs.push('Can bring earliest failure earlier in the timeline.');
  }

  if (result.isSensitivity) {
    tradeoffs.push('Sensitivity scenario: use for fragility analysis, not direct advice.');
  }

  return tradeoffs;
}

export function buildTopLevelNotes(report: DecisionEngineReport) {
  const notes: string[] = [];
  const bestOverall = report.rankedRecommendations[0];
  const bestLowDisruption = report.topLowDisruption[0];
  const worstSensitivity = report.worstSensitivityScenarios[0];
  const bestCombo = report.topDefensiveCombos[0];

  if (report.baselineRiskWarning) {
    notes.push(report.baselineRiskWarning);
  }
  if (report.recommendationSummary.summary) {
    notes.push(report.recommendationSummary.summary);
  }

  if (bestOverall) {
    notes.push(
      `Best overall lever: ${bestOverall.name} (${signedPercentPoints(
        bestOverall.delta.deltaSuccessRate,
      )} pts success).`,
    );
  }
  if (bestLowDisruption) {
    notes.push(
      `Best low-disruption lever: ${bestLowDisruption.name} (${signedPercentPoints(
        bestLowDisruption.delta.deltaSuccessRate,
      )} pts success).`,
    );
  }
  if (worstSensitivity) {
    notes.push(
      `Biggest downside sensitivity: ${worstSensitivity.name} (${signedPercentPoints(
        worstSensitivity.delta.deltaSuccessRate,
      )} pts success).`,
    );
  }
  if (bestCombo) {
    notes.push(
      `Best defensive combo: ${bestCombo.name} (score ${bestCombo.recommendationScore.toFixed(2)}).`,
    );
  }

  if (!report.rankedRecommendations.length) {
    notes.push('No positive recommendation candidates met the non-harmful threshold.');
  }

  return notes;
}
