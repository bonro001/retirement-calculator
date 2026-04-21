import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { buildPlanningStateExport } from './planning-export';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

const TEST_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.074,
  internationalEquityVolatility: 0.18,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 120,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'parity-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

describe('simulation parity / validation', () => {
  it('export includes parity-required simulation and planning fields', () => {
    const payload = buildPlanningStateExport({
      data: initialSeedData,
      assumptions: TEST_ASSUMPTIONS,
      selectedStressorIds: ['market_down', 'inflation'],
      selectedResponseIds: ['cut_spending', 'preserve_roth'],
    });

    expect(payload.version.schema).toBe('retirement-planner-export.v2');
    expect(payload.baseInputs).toBeDefined();
    expect(payload.effectiveInputs).toBeDefined();
    expect(payload.effectiveSimulationInputs).toBeDefined();
    expect(payload.effectivePlanningStrategyInputs).toBeDefined();
    expect(payload.simulationProfiles.rawSimulation.mode).toBe('raw_simulation');
    expect(payload.simulationProfiles.plannerEnhancedSimulation.mode).toBe('planner_enhanced');
    expect(
      payload.simulationProfiles.plannerEnhancedSimulation.withdrawalPolicy
        .closedLoopHealthcareTaxIteration,
    ).toBe(true);
    expect(payload.simulationProfiles.plannerEnhancedSimulation.withdrawalPolicy.maxClosedLoopPasses)
      .toBeGreaterThanOrEqual(2);
    expect(
      payload.simulationProfiles.plannerEnhancedSimulation.withdrawalPolicy
        .closedLoopConvergenceThresholds,
    ).toEqual(
      expect.objectContaining({
        magiDeltaDollars: expect.any(Number),
        federalTaxDeltaDollars: expect.any(Number),
        healthcarePremiumDeltaDollars: expect.any(Number),
      }),
    );
    expect(payload.simulationProfiles.plannerEnhancedSimulation.rothConversionPolicy.source).toBe(
      'rules',
    );
    expect(payload.simulationProfiles.plannerEnhancedSimulation.rothConversionPolicy.strategy).toBe(
      'aca_then_irmaa_headroom',
    );
    expect(
      payload.effectivePlanningStrategyInputs.simulationSettings.returnGeneration.model,
    ).toBe('bounded_normal_by_asset_class');
    expect(payload.effectivePlanningStrategyInputs.simulationSettings.timingConventions).toEqual(
      expect.objectContaining({
        salaryProrationRule: 'month_fraction',
        inflationCompounding: 'annual',
      }),
    );
  });

  it('raw simulation mode is reproducible for fixed seed', () => {
    const first = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      ['market_down'],
      ['cut_spending'],
      {
        pathMode: 'selected_only',
        strategyMode: 'raw_simulation',
      },
    );
    const second = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      ['market_down'],
      ['cut_spending'],
      {
        pathMode: 'selected_only',
        strategyMode: 'raw_simulation',
      },
    );

    expect(second).toEqual(first);
  });

  it('planner-enhanced simulation mode is reproducible for fixed seed', () => {
    const first = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      ['market_down'],
      ['cut_spending'],
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      },
    );
    const second = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      ['market_down'],
      ['cut_spending'],
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      },
    );

    expect(second).toEqual(first);
  });

  it('raw and planner modes diverge for strategy-policy reasons while sharing base assumptions', () => {
    const planner = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      ['market_down', 'inflation'],
      ['cut_spending', 'preserve_roth'],
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      },
    )[0];
    const raw = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      ['market_down', 'inflation'],
      ['cut_spending', 'preserve_roth'],
      {
        pathMode: 'selected_only',
        strategyMode: 'raw_simulation',
      },
    )[0];

    expect(planner.simulationConfiguration.activeStressors).toEqual(
      raw.simulationConfiguration.activeStressors,
    );
    expect(planner.simulationConfiguration.activeResponses).toEqual(
      raw.simulationConfiguration.activeResponses,
    );
    expect(planner.simulationConfiguration.simulationSettings).toEqual(
      raw.simulationConfiguration.simulationSettings,
    );
    expect(planner.plannerLogicActive).toBe(true);
    expect(raw.plannerLogicActive).toBe(false);
    expect(planner.simulationConfiguration.withdrawalPolicy.dynamicDefenseOrdering).toBe(true);
    expect(raw.simulationConfiguration.withdrawalPolicy.dynamicDefenseOrdering).toBe(false);
    expect(planner.simulationConfiguration.withdrawalPolicy.irmaaAware).toBe(true);
    expect(raw.simulationConfiguration.withdrawalPolicy.irmaaAware).toBe(false);
    expect(planner.simulationDiagnostics.closedLoopConvergencePath.length).toBeGreaterThan(0);
    expect(planner.riskMetrics.earlyFailureProbability).toBeGreaterThanOrEqual(0);
    expect(planner.riskMetrics.worstDecileEndingWealth).toBe(
      planner.endingWealthPercentiles.p10,
    );
    expect(planner.riskMetrics.equitySalesInAdverseEarlyYearsRate).toBeGreaterThanOrEqual(0);
    expect(planner.simulationDiagnostics.closedLoopConvergenceSummary).toEqual(
      expect.objectContaining({
        converged: expect.any(Boolean),
        stopReason: expect.any(String),
      }),
    );
    expect(planner.simulationDiagnostics.closedLoopRunSummary).toEqual(
      expect.objectContaining({
        runCount: expect.any(Number),
        convergedRunRate: expect.any(Number),
      }),
    );
    expect(planner.simulationDiagnostics.closedLoopRunConvergence.length).toBe(
      planner.simulationConfiguration.simulationSettings.runCount,
    );
    expect(raw.simulationDiagnostics.conversionPath.every((point) => point.value === 0)).toBe(true);
    expect(
      raw.simulationDiagnostics.rothConversionEligibilityPath.every(
        (point) => point.executedRunRate === 0,
      ),
    ).toBe(true);
  });

  it('toggle selections flow into export payload and simulation configuration', () => {
    const selectedStressors = ['layoff', 'delayed_inheritance'];
    const selectedResponses = [
      'delay_retirement',
      'early_ss',
      'sell_home_early',
      'increase_cash_buffer',
    ];
    const payload = buildPlanningStateExport({
      data: initialSeedData,
      assumptions: TEST_ASSUMPTIONS,
      selectedStressorIds: selectedStressors,
      selectedResponseIds: selectedResponses,
    });
    const planner = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      selectedStressors,
      selectedResponses,
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      },
    )[0];

    expect(payload.toggleState.stressorIds).toEqual(selectedStressors);
    expect(payload.toggleState.responseIds).toEqual(selectedResponses);
    expect(payload.activeStressors.map((item) => item.id)).toEqual(selectedStressors);
    expect(payload.activeResponses.map((item) => item.id)).toEqual(
      expect.arrayContaining(selectedResponses),
    );
    expect(
      payload.adjustmentsApplied.map((item) => item.id),
    ).toEqual(expect.arrayContaining(selectedStressors.concat(selectedResponses)));
    expect(payload.effectiveInputs.income.salaryEndDate).not.toBe(
      payload.baseInputs.income.salaryEndDate,
    );
    expect(planner.simulationConfiguration.activeStressors).toEqual(selectedStressors);
    expect(planner.simulationConfiguration.activeResponses).toEqual(selectedResponses);
  });

  it('falls back to default Roth policy snapshot when rules do not provide one', () => {
    const data = cloneSeedData(initialSeedData);
    delete data.rules.rothConversionPolicy;

    const payload = buildPlanningStateExport({
      data,
      assumptions: TEST_ASSUMPTIONS,
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    expect(payload.simulationProfiles.plannerEnhancedSimulation.rothConversionPolicy.source).toBe(
      'default',
    );
    expect(payload.simulationProfiles.plannerEnhancedSimulation.rothConversionPolicy.strategy).toBe(
      'aca_then_irmaa_headroom',
    );
    expect(
      payload.simulationProfiles.plannerEnhancedSimulation.rothConversionPolicy.minAnnualDollars,
    ).toBeGreaterThan(0);
  });
});
