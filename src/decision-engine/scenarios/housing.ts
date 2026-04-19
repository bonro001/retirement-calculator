import { enableResponse, keepHouse, moveHomeSaleYear } from '../helpers';
import type { LeverScenarioDefinition } from '../types';

export function buildHousingScenarios(): LeverScenarioDefinition[] {
  return [
    {
      id: 'response_sell_home_early',
      category: 'housing',
      name: 'Enable "Sell Home Early" Response',
      description: 'Use the existing planner response control for an earlier home sale.',
      disruption: 'high',
      complexity: 'simple',
      apply: (input) => enableResponse(input, 'sell_home_early'),
      tags: ['home_sale', 'earlier_home_sale', 'response_toggle', 'ui_control'],
    },
    {
      id: 'housing_keep_house',
      category: 'housing',
      name: 'Keep House',
      description: 'Model primary residence as retained (no home sale proceeds).',
      disruption: 'medium',
      complexity: 'simple',
      isSensitivity: true,
      apply: (input) => keepHouse(input),
      tags: ['home_sale', 'keep_house', 'sensitivity'],
    },
    {
      id: 'housing_sell_earlier_2y',
      category: 'housing',
      name: 'Sell House Earlier -2 Years',
      description: 'Bring home sale proceeds forward by two years.',
      disruption: 'high',
      complexity: 'moderate',
      apply: (input) => moveHomeSaleYear(input, -2),
      tags: ['home_sale', 'earlier_home_sale'],
    },
    {
      id: 'housing_sell_later_2y',
      category: 'housing',
      name: 'Sell House Later +2 Years',
      description: 'Delay home sale proceeds by two years.',
      disruption: 'medium',
      complexity: 'moderate',
      isSensitivity: true,
      apply: (input) => moveHomeSaleYear(input, 2),
      tags: ['home_sale', 'later_home_sale', 'sensitivity'],
    },
  ];
}
