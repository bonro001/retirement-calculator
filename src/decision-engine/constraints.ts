import type { PlannerInput } from './types';
import type {
  LeverScenarioDefinition,
  RecommendationConstraintRules,
  RecommendationConstraints,
} from './types';

export interface ScenarioConstraintDecision {
  allowed: boolean;
  reasons: string[];
}

export interface ScenarioConstraintEvaluation {
  allowedScenarios: LeverScenarioDefinition[];
  excludedScenarios: Array<{
    scenario: LeverScenarioDefinition;
    reasons: string[];
  }>;
  activeConstraints: RecommendationConstraints | null;
  notes: string[];
}

function unique<T extends string>(values: T[]) {
  return [...new Set(values)];
}

function mergeTags(base: string[], next?: string[]) {
  return unique([...base, ...(next ?? [])]);
}

function buildDerivedForbiddenTags(
  rules: RecommendationConstraintRules | undefined,
) {
  const forbiddenTags: string[] = [];
  if (!rules) {
    return forbiddenTags;
  }
  if (rules.allowRetirementDelay === false) {
    forbiddenTags.push('retirement_delay');
  }
  if (rules.allowSocialSecurityChanges === false) {
    forbiddenTags.push('ss_timing');
  }
  if (rules.allowAllocationChanges === false) {
    forbiddenTags.push('allocation_change');
  }
  if (rules.allowEssentialSpendingCuts === false) {
    forbiddenTags.push('essential_cut');
  }
  if (rules.allowOptionalSpendingCuts === false) {
    forbiddenTags.push('optional_cut');
  }
  if (rules.allowTravelCuts === false) {
    forbiddenTags.push('travel_cut');
  }
  if (rules.allowHomeSaleChanges === false) {
    forbiddenTags.push('home_sale', 'earlier_home_sale', 'later_home_sale');
  }
  if (rules.allowEarlierHomeSale === false) {
    forbiddenTags.push('earlier_home_sale');
  }
  if (rules.allowLaterHomeSale === false) {
    forbiddenTags.push('later_home_sale');
  }
  if (rules.allowKeepHouseScenario === false) {
    forbiddenTags.push('keep_house');
  }
  if (rules.allowInheritanceReliance === false) {
    forbiddenTags.push('inheritance_sensitive');
  }
  if (rules.allowComboScenarios === false) {
    forbiddenTags.push('combo');
  }
  return unique(forbiddenTags);
}

function normalizeConstraints(
  constraints?: RecommendationConstraints,
): RecommendationConstraints | null {
  if (!constraints) {
    return null;
  }

  const derivedForbiddenTags = buildDerivedForbiddenTags(constraints.rules);
  const forbiddenTags = mergeTags(derivedForbiddenTags, constraints.forbiddenTags);
  const disallowedCategories = [
    ...(constraints.disallowedCategories ?? []),
    ...(constraints.rules?.allowComboScenarios === false ? ['combo' as const] : []),
    ...(constraints.rules?.allowAllocationChanges === false ? ['allocation' as const] : []),
  ];

  return {
    ...constraints,
    disallowedCategories: unique(disallowedCategories),
    disallowedScenarioIds: unique(constraints.disallowedScenarioIds ?? []),
    forbiddenTags,
  };
}

function evaluateByThresholds(
  scenario: LeverScenarioDefinition,
  baseline: PlannerInput,
  constraints: RecommendationConstraints,
) {
  const reasons: string[] = [];
  if (
    typeof constraints.minimumTravelBudgetAnnual === 'number' ||
    typeof constraints.minimumOptionalMonthly === 'number' ||
    typeof constraints.minimumEssentialMonthly === 'number'
  ) {
    const projected = scenario.apply(baseline);
    if (
      typeof constraints.minimumTravelBudgetAnnual === 'number' &&
      projected.data.spending.travelEarlyRetirementAnnual <
        constraints.minimumTravelBudgetAnnual
    ) {
      reasons.push(
        `Travel cuts below ${constraints.minimumTravelBudgetAnnual.toLocaleString()}/year are not allowed.`,
      );
    }
    if (
      typeof constraints.minimumOptionalMonthly === 'number' &&
      projected.data.spending.optionalMonthly < constraints.minimumOptionalMonthly
    ) {
      reasons.push(
        `Optional spending below ${constraints.minimumOptionalMonthly.toLocaleString()}/month is not allowed.`,
      );
    }
    if (
      typeof constraints.minimumEssentialMonthly === 'number' &&
      projected.data.spending.essentialMonthly < constraints.minimumEssentialMonthly
    ) {
      reasons.push(
        `Essential spending below ${constraints.minimumEssentialMonthly.toLocaleString()}/month is not allowed.`,
      );
    }
  }
  return reasons;
}

function evaluateScenario(
  scenario: LeverScenarioDefinition,
  baseline: PlannerInput,
  constraints: RecommendationConstraints | null,
): ScenarioConstraintDecision {
  if (!constraints) {
    return { allowed: true, reasons: [] };
  }

  const reasons: string[] = [];
  const disallowedCategorySet = new Set(constraints.disallowedCategories ?? []);
  const disallowedScenarioSet = new Set(constraints.disallowedScenarioIds ?? []);
  const forbiddenTagSet = new Set(constraints.forbiddenTags ?? []);
  const scenarioTags = scenario.tags ?? [];

  if (disallowedCategorySet.has(scenario.category)) {
    reasons.push(`Scenario category "${scenario.category}" is disallowed.`);
  }
  if (disallowedScenarioSet.has(scenario.id)) {
    reasons.push(`Scenario "${scenario.name}" is disallowed by id.`);
  }
  if (scenarioTags.some((tag) => forbiddenTagSet.has(tag))) {
    const blockedTags = scenarioTags.filter((tag) => forbiddenTagSet.has(tag));
    reasons.push(`Scenario contains forbidden tags: ${blockedTags.join(', ')}.`);
  }
  reasons.push(...evaluateByThresholds(scenario, baseline, constraints));

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function addRuleNotes(
  rules: RecommendationConstraintRules | undefined,
  notes: string[],
) {
  if (!rules) {
    return;
  }
  if (rules.allowRetirementDelay === false) {
    notes.push('Retirement delay scenarios were excluded by user preference.');
  }
  if (rules.allowSocialSecurityChanges === false) {
    notes.push('Social Security timing changes were excluded by user preference.');
  }
  if (rules.allowAllocationChanges === false) {
    notes.push('Allocation-change recommendations were removed.');
  }
  if (rules.allowEssentialSpendingCuts === false) {
    notes.push('Essential spending cuts were excluded by user preference.');
  }
  if (rules.allowOptionalSpendingCuts === false) {
    notes.push('Optional spending cuts were excluded by user preference.');
  }
  if (rules.allowTravelCuts === false) {
    notes.push('Travel-cut scenarios were excluded by user preference.');
  }
  if (rules.allowHomeSaleChanges === false) {
    notes.push('Home-sale-based recommendations were removed.');
  } else {
    if (rules.allowEarlierHomeSale === false) {
      notes.push('Earlier home-sale scenarios were excluded by user preference.');
    }
    if (rules.allowLaterHomeSale === false) {
      notes.push('Later home-sale scenarios were excluded by user preference.');
    }
  }
  if (rules.allowKeepHouseScenario === false) {
    notes.push('Keep-house scenario recommendations were excluded by user preference.');
  }
  if (rules.allowInheritanceReliance === false) {
    notes.push('Inheritance-sensitive recommendations were removed.');
  }
  if (rules.allowComboScenarios === false) {
    notes.push('Combo scenarios were excluded by user preference.');
  }
}

function addThresholdNotes(
  constraints: RecommendationConstraints,
  notes: string[],
) {
  if (typeof constraints.minimumTravelBudgetAnnual === 'number') {
    notes.push(
      `Travel cuts below $${constraints.minimumTravelBudgetAnnual.toLocaleString()}/year were not considered.`,
    );
  }
  if (typeof constraints.minimumOptionalMonthly === 'number') {
    notes.push(
      `Optional spending below $${constraints.minimumOptionalMonthly.toLocaleString()}/month was not considered.`,
    );
  }
  if (typeof constraints.minimumEssentialMonthly === 'number') {
    notes.push(
      `Essential spending below $${constraints.minimumEssentialMonthly.toLocaleString()}/month was not considered.`,
    );
  }
}

export function evaluateScenarioConstraints(
  scenarios: LeverScenarioDefinition[],
  baselineInput: PlannerInput,
  constraints?: RecommendationConstraints,
): ScenarioConstraintEvaluation {
  const activeConstraints = normalizeConstraints(constraints);
  if (!activeConstraints) {
    return {
      allowedScenarios: scenarios,
      excludedScenarios: [],
      activeConstraints: null,
      notes: [],
    };
  }

  const excludedScenarios: ScenarioConstraintEvaluation['excludedScenarios'] = [];
  const allowedScenarios: LeverScenarioDefinition[] = [];
  scenarios.forEach((scenario) => {
    const decision = evaluateScenario(scenario, baselineInput, activeConstraints);
    if (decision.allowed) {
      allowedScenarios.push(scenario);
      return;
    }
    excludedScenarios.push({
      scenario,
      reasons: decision.reasons,
    });
  });

  const notes: string[] = [];
  addRuleNotes(activeConstraints.rules, notes);
  addThresholdNotes(activeConstraints, notes);

  return {
    allowedScenarios,
    excludedScenarios,
    activeConstraints,
    notes: unique(notes),
  };
}
