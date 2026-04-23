import type { ActualsLogStore } from './actuals-log';
import { DeltaDashboardTile } from './DeltaDashboardTile';
import { PreRetirementOptimizerTile } from './PreRetirementOptimizerTile';
import type { PathResult, MarketAssumptions, SeedData } from './types';
import { TaxEfficiencyTile } from './TaxEfficiencyTile';
import { UncertaintyRangeTile } from './UncertaintyRangeTile';
import type { PredictionLogStore } from './prediction-log';

// Single import / single insert for UnifiedPlanScreen adoption. Composes
// the four unwired tiles built this sprint into a consistent two-column
// dashboard grid. Each child tile remains usable individually — this is
// just a convenience wrapper to reduce adoption friction.
//
// Layout (desktop grid / mobile stacks):
//   | UncertaintyRangeTile     | TaxEfficiencyTile            |
//   | PreRetirementOptimizerTile | (empty on narrow viewports) |
//   | DeltaDashboardTile (full width — may contain many rows)    |

export interface CalibrationDashboardProps {
  seedData: SeedData;
  assumptions: MarketAssumptions;
  baselinePath: PathResult;
  predictionStore?: PredictionLogStore;
  actualsStore?: ActualsLogStore;
  title?: string;
  marginalFederalRate?: number;
}

export function CalibrationDashboard({
  seedData,
  assumptions,
  baselinePath,
  predictionStore,
  actualsStore,
  title = 'Plan calibration',
  marginalFederalRate = 0.22,
}: CalibrationDashboardProps) {
  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-stone-900">{title}</h2>
        <p className="text-xs text-stone-500">
          Decision-grade signals: range not a point, tax exposure, pre-retirement
          optimization, prediction vs actual.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <UncertaintyRangeTile seedData={seedData} assumptions={assumptions} />
        <TaxEfficiencyTile path={baselinePath} />
        <PreRetirementOptimizerTile
          seedData={seedData}
          assumptions={assumptions}
          marginalFederalRate={marginalFederalRate}
        />
      </div>

      {predictionStore && actualsStore ? (
        <DeltaDashboardTile
          predictionStore={predictionStore}
          actualsStore={actualsStore}
        />
      ) : null}
    </section>
  );
}
