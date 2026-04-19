import {
  composeTransforms,
  delayRetirement,
  increaseBondAllocation,
  keepHouse,
  removeWindfall,
  reduceOptionalSpending,
  reduceTravelBudget,
} from '../helpers';
import type { LeverScenarioDefinition } from '../types';

export function buildComboScenarios(): LeverScenarioDefinition[] {
  return [
    {
      id: 'combo_delay_6m_optional_10',
      category: 'combo',
      name: 'Delay 6 Months + Optional Cut 10%',
      description: 'Delay retirement 6 months and cut optional spending by 10%.',
      disruption: 'medium',
      complexity: 'complex',
      apply: (input) =>
        composeTransforms(input, [
          (state) => delayRetirement(state, 6),
          (state) => reduceOptionalSpending(state, 10),
        ]),
      tags: ['combo', 'retirement_delay', 'optional_cut'],
    },
    {
      id: 'combo_delay_12m_travel_5k',
      category: 'combo',
      name: 'Delay 12 Months + Travel Cut $5k',
      description: 'Delay retirement 12 months and reduce travel by $5,000.',
      disruption: 'high',
      complexity: 'complex',
      apply: (input) =>
        composeTransforms(input, [
          (state) => delayRetirement(state, 12),
          (state) => reduceTravelBudget(state, 5_000),
        ]),
      tags: ['combo', 'retirement_delay', 'travel_cut'],
    },
    {
      id: 'combo_optional_10_conservative',
      category: 'combo',
      name: 'Optional Cut 10% + Conservative Allocation',
      description: 'Cut optional spending by 10% and increase bonds by 10%.',
      disruption: 'medium',
      complexity: 'complex',
      apply: (input) =>
        composeTransforms(input, [
          (state) => reduceOptionalSpending(state, 10),
          (state) => increaseBondAllocation(state, 10),
        ]),
      tags: ['combo', 'optional_cut', 'allocation_change'],
    },
    {
      id: 'combo_no_home_sale_optional_15',
      category: 'combo',
      name: 'No Home Sale + Optional Cut 15%',
      description: 'Retain house and offset by cutting optional spending 15%.',
      disruption: 'high',
      complexity: 'complex',
      isSensitivity: true,
      apply: (input) =>
        composeTransforms(input, [
          (state) => keepHouse(state),
          (state) => reduceOptionalSpending(state, 15),
        ]),
      tags: ['combo', 'keep_house', 'home_sale', 'optional_cut', 'sensitivity'],
    },
    {
      id: 'combo_no_inheritance_delay_12m',
      category: 'combo',
      name: 'No Inheritance + Delay 12 Months',
      description: 'Remove inheritance assumption and delay retirement 12 months.',
      disruption: 'high',
      complexity: 'complex',
      isSensitivity: true,
      apply: (input) =>
        composeTransforms(input, [
          (state) => removeWindfall(state, 'inheritance'),
          (state) => delayRetirement(state, 12),
        ]),
      tags: ['combo', 'inheritance_sensitive', 'retirement_delay', 'sensitivity'],
    },
  ];
}
