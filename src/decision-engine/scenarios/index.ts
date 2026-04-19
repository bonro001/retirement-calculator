import { buildAllocationScenarios } from './allocation';
import { buildAssumptionScenarios } from './assumptions';
import { buildComboScenarios } from './combos';
import { buildHousingScenarios } from './housing';
import { buildSpendingScenarios } from './spending';
import { buildTimingScenarios } from './timing';

export function buildLeverScenarioLibrary() {
  return [
    ...buildSpendingScenarios(),
    ...buildTimingScenarios(),
    ...buildAllocationScenarios(),
    ...buildAssumptionScenarios(),
    ...buildHousingScenarios(),
    ...buildComboScenarios(),
  ];
}
