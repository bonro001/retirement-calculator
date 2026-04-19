import { useState, type ReactNode } from 'react';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import {
  evaluatePlan,
  type LegacyPriority,
  type PlanEvaluation,
} from './plan-evaluation';
import type { IrmaaPosture } from './retirement-plan';
import { useAppStore } from './store';
import { formatCurrency, formatPercent } from './utils';

const INTERACTIVE_UNIFIED_PLAN_MAX_RUNS = 700;

type ConstraintModifierKey =
  | 'retireLater'
  | 'sellHouse';

interface ConstraintModifiers {
  retireLater: boolean;
  sellHouse: boolean;
}

const DEFAULT_CONSTRAINT_MODIFIERS: ConstraintModifiers = {
  retireLater: false,
  sellHouse: false,
};

const CONSTRAINT_MODIFIER_LABELS: Record<ConstraintModifierKey, string> = {
  retireLater: 'Retire later',
  sellHouse: 'Sell the house',
};

interface PlanControlsSectionState {
  stressors: boolean;
  responses: boolean;
  baseInputs: boolean;
  spending: boolean;
  incomeTiming: boolean;
  assumptions: boolean;
  planSettings: boolean;
  legacyGoal: boolean;
  recommendationOverlay: boolean;
}

const DEFAULT_PLAN_CONTROLS_SECTION_STATE: PlanControlsSectionState = {
  stressors: false,
  responses: false,
  baseInputs: false,
  spending: false,
  incomeTiming: false,
  assumptions: false,
  planSettings: false,
  legacyGoal: false,
  recommendationOverlay: false,
};

function getInteractiveUnifiedPlanAssumptions(
  assumptions: MarketAssumptions,
): MarketAssumptions {
  if (assumptions.simulationRuns <= INTERACTIVE_UNIFIED_PLAN_MAX_RUNS) {
    return assumptions;
  }
  return {
    ...assumptions,
    simulationRuns: INTERACTIVE_UNIFIED_PLAN_MAX_RUNS,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-plan`
      : 'plan',
  };
}

function nextPaint(callback: () => void) {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    callback();
    return;
  }
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      callback();
    });
  });
}

function cloneEvaluation(value: PlanEvaluation): PlanEvaluation {
  return JSON.parse(JSON.stringify(value)) as PlanEvaluation;
}

function formatDeltaPercent(value: number) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function deltaPresentation(value: number) {
  if (Math.abs(value) < 0.005) {
    return { label: 'No meaningful change', className: 'text-stone-600' };
  }
  if (value > 0) {
    return { label: `↑ ${(value * 100).toFixed(1)}%`, className: 'text-emerald-700' };
  }
  return { label: `↓ ${(Math.abs(value) * 100).toFixed(1)}%`, className: 'text-red-700' };
}

function buildRunDelta(
  previousRun: PlanEvaluation | null,
  currentRun: PlanEvaluation,
) {
  if (!previousRun) {
    return null;
  }
  const successDelta =
    currentRun.raw.decision.baseline.successRate - previousRun.raw.decision.baseline.successRate;
  const currentTop = currentRun.raw.decision.rankedRecommendations[0]?.name ?? null;
  const previousTop = previousRun.raw.decision.rankedRecommendations[0]?.name ?? null;
  const currentDriver = currentRun.raw.decision.biggestDriver?.scenarioName ?? null;
  const previousDriver = previousRun.raw.decision.biggestDriver?.scenarioName ?? null;
  const medianWealthDelta =
    currentRun.raw.decision.baseline.medianEndingWealth -
    previousRun.raw.decision.baseline.medianEndingWealth;

  return {
    successDelta,
    topRecommendationMessage:
      currentTop === previousTop
        ? 'Top recommendation unchanged.'
        : `Top recommendation changed from ${previousTop ?? 'none'} to ${currentTop ?? 'none'}.`,
    biggestDriverMessage:
      currentDriver === previousDriver
        ? 'Biggest driver unchanged.'
        : `Biggest driver changed from ${previousDriver ?? 'none'} to ${currentDriver ?? 'none'}.`,
    medianWealthDelta,
  };
}

function verdictClassName(verdict: 'Strong' | 'Moderate' | 'Fragile') {
  if (verdict === 'Strong') {
    return 'text-emerald-700';
  }
  if (verdict === 'Moderate') {
    return 'text-amber-700';
  }
  return 'text-rose-700';
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <article className="rounded-[24px] bg-stone-100/80 p-5">
      <p className="text-sm font-medium text-stone-500">{title}</p>
      {subtitle ? <p className="mt-1 text-sm text-stone-600">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </article>
  );
}

function ControlSection({
  title,
  summary,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white/85">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-stone-100/80"
      >
        <div>
          <p className="text-sm font-semibold text-stone-900">{title}</p>
          <p className="mt-1 text-xs text-stone-500">{summary}</p>
        </div>
        <span className="rounded-full bg-stone-200 px-2 py-1 text-xs font-semibold text-stone-700">
          {isOpen ? 'Hide' : 'Show'}
        </span>
      </button>
      {isOpen ? <div className="space-y-3 px-4 pb-4">{children}</div> : null}
    </section>
  );
}

function areConstraintModifiersEqual(
  left: ConstraintModifiers,
  right: ConstraintModifiers,
) {
  return left.retireLater === right.retireLater && left.sellHouse === right.sellHouse;
}

function summarizeSelectedModifiers(modifiers: ConstraintModifiers) {
  const selected = (Object.keys(CONSTRAINT_MODIFIER_LABELS) as ConstraintModifierKey[])
    .filter((key) => modifiers[key])
    .map((key) => CONSTRAINT_MODIFIER_LABELS[key]);

  if (!selected.length) {
    return 'No modifiers selected';
  }
  return selected.join(' · ');
}

function summarizeActiveControls(input: {
  stressorCount: number;
  responseCount: number;
  legacySummary: string;
  modifierSummary: string;
}) {
  return `Stressors ${input.stressorCount} active · Responses ${input.responseCount} active · Legacy ${input.legacySummary} · ${input.modifierSummary}`;
}

function summarizeSelectorNames(names: string[]) {
  if (!names.length) {
    return 'None selected';
  }

  return `${names.length} selected: ${names.join(', ')}`;
}

function formatPersonLabel(value: string) {
  if (!value) {
    return '';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatWindfallLabel(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatLegacyPriorityLabel(value: LegacyPriority) {
  if (value === 'nice_to_have') {
    return 'Nice to have';
  }
  if (value === 'must_preserve') {
    return 'Must preserve';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function UnifiedPlanScreen({
  data,
  assumptions,
  selectedStressors,
  selectedResponses,
  pathResults,
}: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  pathResults: PathResult[];
}) {
  const toggleStressor = useAppStore((state) => state.toggleStressor);
  const toggleResponse = useAppStore((state) => state.toggleResponse);
  const updateIncome = useAppStore((state) => state.updateIncome);
  const updateSpending = useAppStore((state) => state.updateSpending);
  const updateSocialSecurityClaim = useAppStore((state) => state.updateSocialSecurityClaim);
  const updateWindfall = useAppStore((state) => state.updateWindfall);
  const updateAssumption = useAppStore((state) => state.updateAssumption);

  const [legacyTargetTodayDollars, setLegacyTargetTodayDollars] = useState(1_000_000);
  const [legacyPriority, setLegacyPriority] = useState<LegacyPriority>('important');
  const [targetSuccessRatePercent, setTargetSuccessRatePercent] = useState(80);
  const [irmaaPosture, setIrmaaPosture] = useState<IrmaaPosture>('balanced');
  const [draftConstraintModifiers, setDraftConstraintModifiers] = useState<ConstraintModifiers>(
    DEFAULT_CONSTRAINT_MODIFIERS,
  );
  const [appliedConstraintModifiers, setAppliedConstraintModifiers] =
    useState<ConstraintModifiers>(DEFAULT_CONSTRAINT_MODIFIERS);
  const [autopilotDefensive, setAutopilotDefensive] = useState(true);
  const [autopilotOptionalCutsAllowed, setAutopilotOptionalCutsAllowed] = useState(true);
  const [optionalFlexPercent, setOptionalFlexPercent] = useState(12);
  const [travelFlexPercent, setTravelFlexPercent] = useState(20);
  const [preserveRothPreference, setPreserveRothPreference] = useState(false);
  const [currentEvaluation, setCurrentEvaluation] = useState<PlanEvaluation | null>(null);
  const [previousEvaluation, setPreviousEvaluation] = useState<PlanEvaluation | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlsSectionState, setControlsSectionState] = useState<PlanControlsSectionState>(
    DEFAULT_PLAN_CONTROLS_SECTION_STATE,
  );

  const primaryPath = pathResults[2] ?? pathResults[0];
  const constraintSummary = summarizeSelectedModifiers(draftConstraintModifiers);
  const legacySummary = `${formatCurrency(legacyTargetTodayDollars)} · ${formatLegacyPriorityLabel(legacyPriority)}`;
  const activeControlsSummary = summarizeActiveControls({
    stressorCount: selectedStressors.length,
    responseCount: selectedResponses.length,
    legacySummary,
    modifierSummary: constraintSummary,
  });
  const hasDraftConstraintChanges = !areConstraintModifiersEqual(
    draftConstraintModifiers,
    appliedConstraintModifiers,
  );
  const activeStressorNames = data.stressors
    .filter((item) => selectedStressors.includes(item.id))
    .map((item) => item.name);
  const activeResponseNames = data.responses
    .filter((item) => selectedResponses.includes(item.id))
    .map((item) => item.name);
  const stressorSummary = summarizeSelectorNames(activeStressorNames);
  const responseSummary = summarizeSelectorNames(activeResponseNames);

  const setControlsSectionOpen = (
    key: keyof PlanControlsSectionState,
    open: boolean,
  ) => {
    setControlsSectionState((previous) => ({
      ...previous,
      [key]: open,
    }));
  };

  const runUnifiedAnalysis = (modifiersToApply = appliedConstraintModifiers) => {
    const priorSnapshot = currentEvaluation ? cloneEvaluation(currentEvaluation) : null;
    setError(null);
    setIsRunning(true);
    nextPaint(() => {
      void (async () => {
        try {
          const interactiveAssumptions = getInteractiveUnifiedPlanAssumptions(assumptions);
          const evaluation = await evaluatePlan(
            {
            data,
            assumptions: interactiveAssumptions,
              controls: {
                selectedStressorIds: selectedStressors,
                selectedResponseIds: selectedResponses,
                toggles: {
                  preserveRoth: preserveRothPreference,
                  increaseCashBuffer: false,
                  avoidRetirementDelayRecommendations: !modifiersToApply.retireLater,
                  avoidHomeSaleRecommendations: !modifiersToApply.sellHouse,
                },
              },
              preferences: {
                irmaaPosture,
                preserveLifestyleFloor: true,
                calibration: {
                  targetLegacyTodayDollars: Math.max(0, legacyTargetTodayDollars),
                  legacyPriority,
                  minSuccessRate: Math.max(0, Math.min(1, targetSuccessRatePercent / 100)),
                  successRateRange: {
                    min: Math.max(0, Math.min(1, targetSuccessRatePercent / 100)),
                    max: Math.max(
                      0,
                      Math.min(1, (Math.min(99, targetSuccessRatePercent + 10)) / 100),
                    ),
                  },
                },
                responsePolicy: {
                  posture: autopilotDefensive ? 'defensive' : 'balanced',
                  optionalSpendingCutsAllowed: autopilotOptionalCutsAllowed,
                  optionalSpendingFlexPercent: optionalFlexPercent,
                  travelFlexPercent,
                  preserveRothPreference,
                },
              },
            },
            {
              previousEvaluation: priorSnapshot,
            },
          );

          setPreviousEvaluation(priorSnapshot);
          setCurrentEvaluation(evaluation);
          console.log('[Unified Plan] full result', evaluation);
        } catch (runError) {
          setError(runError instanceof Error ? runError.message : 'Unified plan analysis failed.');
        } finally {
          setIsRunning(false);
        }
      })();
    });
  };

  const handleUpdateModelFromDraft = () => {
    const nextApplied = { ...draftConstraintModifiers };
    setAppliedConstraintModifiers(nextApplied);
    runUnifiedAnalysis(nextApplied);
  };

  const setDraftModifier = (key: ConstraintModifierKey, checked: boolean) => {
    setDraftConstraintModifiers((previous) => ({
      ...previous,
      [key]: checked,
    }));
  };

  const currentRun = currentEvaluation?.raw.run ?? null;
  const runDelta = currentEvaluation ? buildRunDelta(previousEvaluation, currentEvaluation) : null;
  const successDeltaPresentation = runDelta ? deltaPresentation(runDelta.successDelta) : null;

  return (
    <section className="rounded-[32px] border border-white/70 bg-white/80 p-6 shadow-lg shadow-amber-950/5 backdrop-blur">
      <div className="mb-5">
        <h2 className="font-serif text-3xl tracking-tight text-stone-900">Plan</h2>
        <p className="mt-2 max-w-[68ch] text-sm leading-6 text-stone-600">
          One integrated retirement plan model for spending support, autopilot response, IRMAA
          exposure, recommendations, and Monte Carlo risk.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => runUnifiedAnalysis()}
          disabled={isRunning}
          className="rounded-full bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRunning ? 'Running Plan Analysis…' : 'Run Plan Analysis'}
        </button>
        <p className="text-sm text-stone-600">
          Live path baseline: {formatPercent(primaryPath.successRate)} success,{' '}
          {formatCurrency(primaryPath.medianEndingWealth)} median ending wealth.
        </p>
      </div>

      <SectionCard
        title="Plan Controls"
        subtitle="Single control surface for recommendation-driving inputs: stressors, responses, core plan inputs, settings, and excluded-option modifiers."
      >
        <div className="rounded-2xl bg-white/90 p-4">
          <p className="text-sm font-medium text-stone-700">Active controls</p>
          <p className="mt-1 text-sm text-stone-600">{activeControlsSummary}</p>
          <p className="mt-1 text-xs text-stone-500">
            Active stressors: {activeStressorNames.length ? activeStressorNames.join(', ') : 'None'}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Active responses: {activeResponseNames.length ? activeResponseNames.join(', ') : 'None'}
          </p>
        </div>

        <div className="mt-4 space-y-3">
          <ControlSection
            title="Stressors"
            summary={stressorSummary}
            isOpen={controlsSectionState.stressors}
            onToggle={() => setControlsSectionOpen('stressors', !controlsSectionState.stressors)}
          >
            <div className="grid gap-2 md:grid-cols-2">
              {data.stressors.map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={selectedStressors.includes(item.id)}
                    onChange={() => toggleStressor(item.id)}
                  />
                  {item.name}
                </label>
              ))}
            </div>
          </ControlSection>

          <ControlSection
            title="Responses"
            summary={responseSummary}
            isOpen={controlsSectionState.responses}
            onToggle={() => setControlsSectionOpen('responses', !controlsSectionState.responses)}
          >
            <div className="grid gap-2 md:grid-cols-2">
              {data.responses.map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={selectedResponses.includes(item.id)}
                    onChange={() => toggleResponse(item.id)}
                  />
                  {item.name}
                </label>
              ))}
            </div>
          </ControlSection>

          <ControlSection
            title="Base Inputs"
            summary={`${formatCurrency(data.income.salaryAnnual)} salary · ends ${data.income.salaryEndDate.slice(0, 10)}`}
            isOpen={controlsSectionState.baseInputs}
            onToggle={() => setControlsSectionOpen('baseInputs', !controlsSectionState.baseInputs)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-stone-700">
                Salary annual
                <input
                  type="number"
                  value={data.income.salaryAnnual}
                  min={0}
                  step={1000}
                  onChange={(event) => updateIncome('salaryAnnual', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Salary end date
                <input
                  type="date"
                  value={data.income.salaryEndDate.slice(0, 10)}
                  onChange={(event) => updateIncome('salaryEndDate', new Date(event.target.value).toISOString())}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Spending Inputs"
            summary={`${formatCurrency(data.spending.essentialMonthly)}/mo essential · ${formatCurrency(data.spending.optionalMonthly)}/mo optional · ${formatCurrency(data.spending.travelEarlyRetirementAnnual)}/yr travel`}
            isOpen={controlsSectionState.spending}
            onToggle={() => setControlsSectionOpen('spending', !controlsSectionState.spending)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-stone-700">
                Essential monthly
                <input
                  type="number"
                  value={data.spending.essentialMonthly}
                  min={0}
                  step={100}
                  onChange={(event) => updateSpending('essentialMonthly', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Optional monthly
                <input
                  type="number"
                  value={data.spending.optionalMonthly}
                  min={0}
                  step={100}
                  onChange={(event) => updateSpending('optionalMonthly', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Taxes + insurance annual
                <input
                  type="number"
                  value={data.spending.annualTaxesInsurance}
                  min={0}
                  step={500}
                  onChange={(event) => updateSpending('annualTaxesInsurance', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Travel annual
                <input
                  type="number"
                  value={data.spending.travelEarlyRetirementAnnual}
                  min={0}
                  step={500}
                  onChange={(event) => updateSpending('travelEarlyRetirementAnnual', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Income Timing"
            summary={`SS ${data.income.socialSecurity.map((entry) => `${formatPersonLabel(entry.person)} ${entry.claimAge}`).join(' / ')} · windfalls ${data.income.windfalls.map((item) => `${formatWindfallLabel(item.name)} ${item.year}`).join(' / ')}`}
            isOpen={controlsSectionState.incomeTiming}
            onToggle={() => setControlsSectionOpen('incomeTiming', !controlsSectionState.incomeTiming)}
          >
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                {data.income.socialSecurity.map((entry) => (
                  <label key={entry.person} className="text-sm text-stone-700">
                    {formatPersonLabel(entry.person)} SS claim age
                    <input
                      type="number"
                      min={62}
                      max={70}
                      step={1}
                      value={entry.claimAge}
                      onChange={(event) =>
                        updateSocialSecurityClaim(
                          entry.person,
                          Math.max(62, Math.min(70, Number(event.target.value) || 62)),
                        )
                      }
                      className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                    />
                  </label>
                ))}
              </div>
              <div className="space-y-3">
                {data.income.windfalls.map((windfall) => (
                  <div key={windfall.name} className="grid gap-3 md:grid-cols-2">
                    <label className="text-sm text-stone-700">
                      {formatWindfallLabel(windfall.name)} year
                      <input
                        type="number"
                        min={new Date().getFullYear()}
                        step={1}
                        value={windfall.year}
                        onChange={(event) =>
                          updateWindfall(
                            windfall.name,
                            'year',
                            Math.max(new Date().getFullYear(), Math.round(Number(event.target.value) || 0)),
                          )
                        }
                        className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                      />
                    </label>
                    <label className="text-sm text-stone-700">
                      {formatWindfallLabel(windfall.name)} amount
                      <input
                        type="number"
                        min={0}
                        step={10000}
                        value={windfall.amount}
                        onChange={(event) =>
                          updateWindfall(windfall.name, 'amount', Math.max(0, Number(event.target.value) || 0))
                        }
                        className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </ControlSection>

          <ControlSection
            title="Market Assumptions"
            summary={`Eq ${formatPercent(assumptions.equityMean)} · Vol ${formatPercent(assumptions.equityVolatility)} · Inflation ${formatPercent(assumptions.inflation)}`}
            isOpen={controlsSectionState.assumptions}
            onToggle={() => setControlsSectionOpen('assumptions', !controlsSectionState.assumptions)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-stone-700">
                Equity mean
                <input
                  type="number"
                  min={0.04}
                  max={0.1}
                  step={0.002}
                  value={assumptions.equityMean}
                  onChange={(event) => updateAssumption('equityMean', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Equity volatility
                <input
                  type="number"
                  min={0.08}
                  max={0.28}
                  step={0.005}
                  value={assumptions.equityVolatility}
                  onChange={(event) => updateAssumption('equityVolatility', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Inflation
                <input
                  type="number"
                  min={0.01}
                  max={0.07}
                  step={0.002}
                  value={assumptions.inflation}
                  onChange={(event) => updateAssumption('inflation', Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Simulation runs
                <input
                  type="number"
                  min={100}
                  max={25000}
                  step={100}
                  value={assumptions.simulationRuns}
                  onChange={(event) => updateAssumption('simulationRuns', Math.max(100, Number(event.target.value) || 100))}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Plan Settings"
            summary={`IRMAA ${irmaaPosture} · Autopilot ${autopilotDefensive ? 'defensive' : 'balanced'} · Flex ${optionalFlexPercent}% optional / ${travelFlexPercent}% travel`}
            isOpen={controlsSectionState.planSettings}
            onToggle={() => setControlsSectionOpen('planSettings', !controlsSectionState.planSettings)}
          >
            <div className="grid gap-4 lg:grid-cols-3">
              <label className="text-sm text-stone-700">
                Exit target (today $)
                <input
                  type="number"
                  value={exitTargetTodayDollars}
                  min={0}
                  step={10000}
                  onChange={(event) => setExitTargetTodayDollars(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Target success rate (%)
                <input
                  type="number"
                  value={targetSuccessRatePercent}
                  min={1}
                  max={99}
                  step={1}
                  onChange={(event) => setTargetSuccessRatePercent(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                IRMAA posture
                <select
                  value={irmaaPosture}
                  onChange={(event) => setIrmaaPosture(event.target.value as IrmaaPosture)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="minimize">Minimize</option>
                  <option value="balanced">Balanced</option>
                  <option value="ignore">Ignore</option>
                </select>
              </label>
              <label className="text-sm text-stone-700">
                Autopilot posture
                <select
                  value={autopilotDefensive ? 'defensive' : 'balanced'}
                  onChange={(event) => setAutopilotDefensive(event.target.value === 'defensive')}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                >
                  <option value="defensive">Defensive</option>
                  <option value="balanced">Balanced</option>
                </select>
              </label>
              <label className="text-sm text-stone-700">
                Optional spending flexibility (%)
                <input
                  type="number"
                  value={optionalFlexPercent}
                  min={0}
                  max={40}
                  step={1}
                  onChange={(event) => setOptionalFlexPercent(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
              <label className="text-sm text-stone-700">
                Travel flexibility (%)
                <input
                  type="number"
                  value={travelFlexPercent}
                  min={0}
                  max={60}
                  step={1}
                  onChange={(event) => setTravelFlexPercent(Number(event.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  checked={autopilotOptionalCutsAllowed}
                  onChange={(event) => setAutopilotOptionalCutsAllowed(event.target.checked)}
                />
                Optional cuts allowed
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  checked={preserveRothPreference}
                  onChange={(event) => setPreserveRothPreference(event.target.checked)}
                />
                Prefer preserving Roth
              </label>
            </div>
          </ControlSection>

          <ControlSection
            title="Excluded High-Impact Options"
            summary={constraintSummary}
            isOpen={controlsSectionState.recommendationOverlay}
            onToggle={() =>
              setControlsSectionOpen(
                'recommendationOverlay',
                !controlsSectionState.recommendationOverlay,
              )
            }
          >
            <p className="text-xs text-stone-500">
              Thin overlay only. Recommendations still derive from current plan controls.
            </p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {(Object.keys(CONSTRAINT_MODIFIER_LABELS) as ConstraintModifierKey[]).map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={draftConstraintModifiers[key]}
                    onChange={(event) => setDraftModifier(key, event.target.checked)}
                  />
                  {CONSTRAINT_MODIFIER_LABELS[key]}
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={isRunning || !hasDraftConstraintChanges}
                onClick={handleUpdateModelFromDraft}
                className="rounded-full bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRunning ? 'Updating…' : 'Update Model'}
              </button>
              <p className="text-xs text-stone-500">
                {hasDraftConstraintChanges
                  ? 'Draft modifiers differ from the applied model.'
                  : 'Draft and applied modifiers are in sync.'}
              </p>
            </div>
          </ControlSection>
        </div>
      </SectionCard>

      {error ? (
        <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {!currentEvaluation || !currentRun ? (
        <div className="mt-4 rounded-[24px] bg-stone-100/80 p-5 text-sm text-stone-600">
          Run Plan Analysis to generate an integrated plan view: supported spending, exit amount,
          autopilot response policy, IRMAA exposure, recommendations, and tradeoffs.
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <SectionCard title="Plan Summary">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl bg-white p-3">
                <p className="text-xs text-stone-500">Supported annual spending</p>
                <p className="mt-1 text-lg font-semibold text-stone-900">
                  {formatCurrency(currentEvaluation.summary.planSupportsAnnual)}
                </p>
              </div>
              <div className="rounded-xl bg-white p-3">
                <p className="text-xs text-stone-500">Exit target / projected (today $)</p>
                <p className="mt-1 text-lg font-semibold text-stone-900">
                  {formatCurrency(currentEvaluation.calibration.targetLegacyTodayDollars)} /{' '}
                  {formatCurrency(currentEvaluation.calibration.projectedLegacyTodayDollars)}
                </p>
              </div>
              <div className="rounded-xl bg-white p-3">
                <p className="text-xs text-stone-500">Success / verdict</p>
                <p className={`mt-1 text-lg font-semibold ${verdictClassName(currentEvaluation.summary.planVerdict)}`}>
                  {formatPercent(currentEvaluation.summary.successRate)} · {currentEvaluation.summary.planVerdict}
                </p>
              </div>
            </div>
            <div className="mt-3 rounded-xl bg-white p-4 text-sm text-stone-700">
              <p>
                <span className="font-semibold">Biggest driver:</span>{' '}
                {currentEvaluation.summary.biggestDriver}
              </p>
              <p className="mt-1">
                <span className="font-semibold">Biggest risk:</span> {currentEvaluation.summary.biggestRisk}
              </p>
              <p className="mt-1">
                <span className="font-semibold">What to do next:</span> {currentEvaluation.summary.bestAction}
              </p>
            </div>
          </SectionCard>

          <SectionCard
            title="Spending + Autopilot"
            subtitle="Calibration and response policy are part of the same plan."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Plan calibration</p>
                <p className="mt-2 text-sm text-stone-700">
                  Sustainable spend: <span className="font-semibold">{formatCurrency(currentEvaluation.calibration.supportedAnnualSpend)}</span> annual (
                  {formatCurrency(currentEvaluation.calibration.supportedMonthlySpend)} monthly)
                </p>
                <p className="mt-1 text-sm text-stone-700">
                  Safe band: {formatCurrency(currentEvaluation.calibration.safeBandAnnual.lower)} to{' '}
                  {formatCurrency(currentEvaluation.calibration.safeBandAnnual.upper)}
                </p>
                <p className="mt-1 text-sm text-stone-700">
                  Binding constraint: {currentEvaluation.calibration.bindingConstraint}
                </p>
              </div>
              <div className="rounded-xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">How this plan responds</p>
                <p className="mt-2 text-sm text-stone-700">
                  Posture: <span className="font-semibold">{currentEvaluation.responsePolicy.posture}</span> · Guardrails{' '}
                  {currentRun.plan.assumptions.guardrailFloorYears}/{currentRun.plan.assumptions.guardrailCeilingYears}
                </p>
                <p className="mt-1 text-sm text-stone-700">
                  Optional spending flexibility: {currentRun.plan.autopilotPolicy.optionalSpendingFlexPercent}%
                </p>
                <p className="mt-1 text-sm text-stone-700">
                  Travel flexibility: {currentRun.plan.autopilotPolicy.travelFlexPercent}%
                </p>
                <p className="mt-1 text-sm text-stone-700">
                  Route summary: {currentEvaluation.responsePolicy.routeSummary}
                </p>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="IRMAA">
            <div className="rounded-xl bg-white p-4">
              <p className="text-sm text-stone-700">
                Posture: <span className="font-semibold">{currentEvaluation.irmaa.posture}</span> · Exposure:{' '}
                <span className="font-semibold">{currentEvaluation.irmaa.exposureLevel}</span>
              </p>
              <p className="mt-1 text-sm text-stone-700">
                Likely years at risk:{' '}
                {currentEvaluation.irmaa.likelyYearsAtRisk.length
                  ? currentEvaluation.irmaa.likelyYearsAtRisk.join(', ')
                  : 'none'}
              </p>
              <p className="mt-1 text-sm text-stone-700">{currentEvaluation.irmaa.explanation}</p>
              <p className="mt-2 text-sm font-semibold text-stone-800">Main drivers</p>
              <ul className="mt-1 space-y-1 text-sm text-stone-700">
                {currentEvaluation.irmaa.mainDrivers.map((driver) => (
                  <li key={driver}>• {driver}</li>
                ))}
              </ul>
              <p className="mt-2 text-sm font-semibold text-stone-800">What would lower exposure</p>
              <ul className="mt-1 space-y-1 text-sm text-stone-700">
                {currentEvaluation.irmaa.whatWouldLowerExposure.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            </div>
          </SectionCard>

          <SectionCard title="Recommendations">
            <p className="text-sm text-stone-700">
              Recommendations are aligned to current plan controls (stressors, responses, and plan
              settings), with synthetic levers only used as secondary sensitivities.
            </p>
            <p className="mt-2 text-sm text-stone-700">{currentEvaluation.recommendations.summary}</p>
            <div className="mt-3 grid gap-2">
              {currentEvaluation.recommendations.top.map((scenario) => (
                <div key={scenario.scenarioId} className="rounded-xl bg-white p-3">
                  <p className="font-semibold text-stone-900">{scenario.name}</p>
                  <p className="mt-1 text-sm text-stone-700">{scenario.summary}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    Success delta {formatDeltaPercent(scenario.deltaSuccessRate)}
                    {scenario.isPlanControl
                      ? ' · Plan control'
                      : ' · Model lever'}
                  </p>
                </div>
              ))}
              {!currentEvaluation.recommendations.top.length ? (
                <p className="text-sm text-stone-600">
                  No positive recommendation candidates were found under current constraints.
                </p>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="What changed from last run?">
            {!runDelta ? (
              <p className="text-sm text-stone-600">
                No previous run yet. Run again after changing settings to compare.
              </p>
            ) : (
              <div className="space-y-2 text-sm text-stone-700">
                <p>
                  Change from last run:{' '}
                  <span className={`font-semibold ${successDeltaPresentation?.className ?? ''}`}>
                    {successDeltaPresentation?.label}
                  </span>
                </p>
                <p>{runDelta.topRecommendationMessage}</p>
                <p>{runDelta.biggestDriverMessage}</p>
                <p>
                  Median ending wealth change:{' '}
                  <span className="font-semibold">{formatCurrency(runDelta.medianWealthDelta)}</span>
                </p>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Sensitivities / Excluded High-Impact Options">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Biggest downside sensitivity</p>
                <p className="mt-1 text-sm font-semibold text-stone-900">
                  {currentEvaluation.sensitivities.biggestDownside?.name ?? 'Not available'}
                </p>
                {currentEvaluation.sensitivities.biggestDownside ? (
                  <p className="mt-1 text-sm text-stone-700">
                    Success delta{' '}
                    {formatDeltaPercent(currentEvaluation.sensitivities.biggestDownside.deltaSuccessRate)}
                  </p>
                ) : null}
              </div>
              <div className="rounded-xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Excluded high-impact levers</p>
                {currentEvaluation.excludedOptions.highImpact.length ? (
                  <ul className="mt-1 space-y-2 text-sm text-stone-700">
                    {currentEvaluation.excludedOptions.highImpact.map((item) => (
                      <li key={`${item.scenario}-${item.reason}`}>
                        <p className="font-semibold text-stone-900">{item.scenario}</p>
                        <p>
                          Would improve success by {formatDeltaPercent(item.deltaSuccessRate)} but is excluded: {item.reason}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-stone-600">No excluded high-impact levers in this run.</p>
                )}
              </div>
            </div>
          </SectionCard>

          {currentRun.plan.inferredAssumptions.length ? (
            <SectionCard title="Model Completeness">
              <p className="text-sm text-stone-700">
                Model completeness: <span className="font-semibold">{currentRun.plan.modelCompleteness}</span>
              </p>
              <ul className="mt-2 space-y-1 text-sm text-stone-700">
                {currentRun.plan.inferredAssumptions.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>
      )}
    </section>
  );
}
