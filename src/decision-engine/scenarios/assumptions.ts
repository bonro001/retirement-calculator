import { moveWindfallLater, removeWindfall } from '../helpers';
import type { LeverScenarioDefinition } from '../types';

export function buildAssumptionScenarios(): LeverScenarioDefinition[] {
  return [
    {
      id: 'assumption_remove_inheritance',
      category: 'assumption',
      name: 'Remove Inheritance',
      description: 'Set inheritance amount to zero to test fragility to inheritance dependence.',
      disruption: 'high',
      complexity: 'simple',
      isSensitivity: true,
      apply: (input) => removeWindfall(input, 'inheritance'),
      tags: ['sensitivity', 'inheritance_sensitive'],
    },
    {
      id: 'assumption_remove_home_sale',
      category: 'assumption',
      name: 'Remove Home Sale',
      description: 'Set home sale proceeds to zero to test fragility to housing liquidity assumptions.',
      disruption: 'high',
      complexity: 'simple',
      isSensitivity: true,
      apply: (input) => removeWindfall(input, 'home_sale'),
      tags: ['sensitivity', 'home_sale'],
    },
    {
      id: 'assumption_inheritance_later_2y',
      category: 'assumption',
      name: 'Move Inheritance Later +2 Years',
      description: 'Delay inheritance by two years.',
      disruption: 'medium',
      complexity: 'simple',
      isSensitivity: true,
      apply: (input) => moveWindfallLater(input, 'inheritance', 2),
      tags: ['sensitivity', 'inheritance_sensitive'],
    },
    {
      id: 'assumption_home_sale_later_2y',
      category: 'assumption',
      name: 'Move Home Sale Later +2 Years',
      description: 'Delay home sale proceeds by two years.',
      disruption: 'medium',
      complexity: 'simple',
      isSensitivity: true,
      apply: (input) => moveWindfallLater(input, 'home_sale', 2),
      tags: ['sensitivity', 'home_sale', 'later_home_sale'],
    },
  ];
}
