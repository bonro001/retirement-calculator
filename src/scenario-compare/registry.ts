import {
  clonePlannerInput,
  delayRetirement,
  keepHouse,
  removeWindfall,
} from '../decision-engine/helpers';
import type { PlannerInput } from '../decision-engine/types';
import type { ScenarioCompareDefinition } from './types';

const DEFAULT_MORE_TRAVEL_DELTA = 5_000;

function withStressor(
  input: PlannerInput,
  stressorId: string,
  options?: {
    removeIds?: string[];
  },
): PlannerInput {
  const next = clonePlannerInput(input);
  if (!next.selectedStressors.includes(stressorId)) {
    next.selectedStressors = [...next.selectedStressors, stressorId];
  }
  if (options?.removeIds?.length) {
    const removeSet = new Set(options.removeIds);
    next.selectedStressors = next.selectedStressors.filter((id) => !removeSet.has(id));
  }
  return next;
}

function increaseTravelBudget(input: PlannerInput, annualAmount: number): PlannerInput {
  const next = clonePlannerInput(input);
  next.data.spending.travelEarlyRetirementAnnual = Math.max(
    0,
    next.data.spending.travelEarlyRetirementAnnual + annualAmount,
  );
  return next;
}

function noHomeSale(input: PlannerInput): PlannerInput {
  return removeWindfall(input, 'home_sale');
}

const registry: ScenarioCompareDefinition[] = [
  {
    id: 'base',
    name: 'Base',
    description: 'Current baseline assumptions and active controls.',
    apply: (input) => clonePlannerInput(input),
  },
  {
    id: 'bad_first_3_years',
    name: 'Bad First 3 Years',
    description: 'Applies the market_down stressor to test early sequence risk.',
    apply: (input) => withStressor(input, 'market_down', { removeIds: ['market_up'] }),
  },
  {
    id: 'no_inheritance',
    name: 'No Inheritance',
    description: 'Removes inheritance windfall to test fragility.',
    apply: (input) => removeWindfall(input, 'inheritance'),
  },
  {
    id: 'no_home_sale',
    name: 'No Home Sale',
    description: 'Removes home-sale proceeds while keeping other assumptions unchanged.',
    apply: (input) => noHomeSale(input),
  },
  {
    id: 'delay_retirement_12_months',
    name: 'Delay Retirement 12 Months',
    description: 'Pushes salary end date out by one year.',
    apply: (input) => delayRetirement(input, 12),
  },
  {
    id: 'keep_house',
    name: 'Keep House',
    description: 'Retains house and removes sale-related liquidity.',
    apply: (input) => keepHouse(input),
  },
  {
    id: 'more_travel',
    name: 'More Travel',
    description: 'Increases annual early-retirement travel budget by $5,000.',
    apply: (input) => increaseTravelBudget(input, DEFAULT_MORE_TRAVEL_DELTA),
  },
];

export function getScenarioCompareRegistry(): ScenarioCompareDefinition[] {
  return registry;
}

export function getScenarioCompareDefinitionById(
  scenarioId: string,
): ScenarioCompareDefinition | null {
  return registry.find((scenario) => scenario.id === scenarioId) ?? null;
}
