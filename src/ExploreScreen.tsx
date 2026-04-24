import { useState } from 'react';
import { SpendVsSafetyScreen } from './SpendVsSafetyScreen';
import { TimeAsSafetyPanel } from './TimeAsSafety';
import { TradeBuilderSection } from './Plan20Screen';
import { useAppStore } from './store';
import { usePlanningExportPayload } from './usePlanningExportPayload';

// Narrow structural view of the compact planning export — avoids the
// PlanningStateExportCompact type rot left by the sim-worker-migration
// refactor. We only need three fields from it.
type CompactPayloadShape = {
  activeSimulationProfile?: 'rawSimulation' | 'plannerEnhancedSimulation';
  activeSimulationOutcome: Parameters<typeof TradeBuilderSection>[0]['activeOutcome'];
  income: { retirementYear: number };
  assumptions: { horizon: { travelPhaseYears: number } };
};

type ExplorePanel = 'timeAsSafety' | 'spendSafety' | 'tradeBuilder';

const PANELS: { id: ExplorePanel; label: string; blurb: string }[] = [
  {
    id: 'timeAsSafety',
    label: 'Time as Safety',
    blurb: 'Trade portfolio sensitivity for patience — how much shift in the retirement date buys what margin.',
  },
  {
    id: 'spendSafety',
    label: 'Spend vs Safety',
    blurb: 'Sweep a spending dial and see where success bends down — the point where one more dollar costs real risk.',
  },
  {
    id: 'tradeBuilder',
    label: 'Trade Builder',
    blurb: 'Size a discretionary purchase against plan tolerance. See which year and which source keeps the plan calm.',
  },
];

export function ExploreScreen() {
  const [active, setActive] = useState<ExplorePanel>('timeAsSafety');

  const data = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.draftAssumptions);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);

  const { payload, loadState, loadError } = usePlanningExportPayload('compact');
  const compactPayload = payload as CompactPayloadShape | null;
  const activeOutcome = compactPayload?.activeSimulationOutcome;

  const activePanel = PANELS.find((panel) => panel.id === active) ?? PANELS[0];

  return (
    <section className="space-y-6">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Explore</p>
        <h2 className="text-3xl font-semibold tracking-tight text-stone-900">
          Curious scenarios
        </h2>
        <p className="max-w-[72ch] text-sm leading-6 text-stone-600">
          One-off tools for poking at the plan without rewriting it. Nothing here
          changes your baseline — it's for learning what moves the numbers.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {PANELS.map((panel) => {
          const selected = panel.id === active;
          return (
            <button
              key={panel.id}
              type="button"
              onClick={() => setActive(panel.id)}
              className={
                selected
                  ? 'rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white shadow-sm'
                  : 'rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50'
              }
            >
              {panel.label}
            </button>
          );
        })}
      </div>

      <p className="max-w-[72ch] text-sm leading-6 text-stone-600">{activePanel.blurb}</p>

      <div>
        {active === 'timeAsSafety' ? (
          <TimeAsSafetyPanel
            data={data}
            assumptions={assumptions}
            selectedStressors={selectedStressors}
            selectedResponses={selectedResponses}
            strategyMode={
              compactPayload?.activeSimulationProfile === 'rawSimulation'
                ? 'raw_simulation'
                : 'planner_enhanced'
            }
          />
        ) : null}

        {active === 'spendSafety' ? <SpendVsSafetyScreen /> : null}

        {active === 'tradeBuilder' ? (
          loadState === 'loading' || loadState === 'idle' ? (
            <TradeBuilderLoading />
          ) : loadState === 'error' || !compactPayload || !activeOutcome ? (
            <TradeBuilderUnavailable
              detail={loadError ?? 'The compact export has not populated for this draft yet.'}
            />
          ) : (
            <TradeBuilderSection
              data={data}
              assumptions={assumptions}
              selectedStressors={selectedStressors}
              selectedResponses={selectedResponses}
              activeOutcome={activeOutcome}
              retirementYear={compactPayload.income.retirementYear}
              travelPhaseYears={compactPayload.assumptions.horizon.travelPhaseYears}
            />
          )
        ) : null}
      </div>
    </section>
  );
}

function TradeBuilderLoading() {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-8 text-sm text-stone-600">
      Loading the compact export for Trade Builder…
    </div>
  );
}

function TradeBuilderUnavailable({ detail }: { detail: string }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
      <p className="font-medium">Trade Builder is waiting for planner data.</p>
      <p className="mt-2 text-amber-800">{detail}</p>
    </div>
  );
}
