import { increaseBondAllocation } from '../helpers';
import type { LeverScenarioDefinition } from '../types';

export function buildAllocationScenarios(): LeverScenarioDefinition[] {
  return [
    {
      id: 'alloc_bonds_up_5',
      category: 'allocation',
      name: 'Increase Bonds +5%',
      description:
        'Increase bond allocation by 5% and reduce equity exposure correspondingly (preserving tax location by bucket).',
      disruption: 'low',
      complexity: 'moderate',
      apply: (input) => increaseBondAllocation(input, 5),
      tags: ['allocation_change'],
    },
    {
      id: 'alloc_bonds_up_10',
      category: 'allocation',
      name: 'Increase Bonds +10%',
      description:
        'Increase bond allocation by 10% and reduce equity exposure correspondingly (preserving tax location by bucket).',
      disruption: 'medium',
      complexity: 'moderate',
      apply: (input) => increaseBondAllocation(input, 10),
      tags: ['allocation_change'],
    },
  ];
}
