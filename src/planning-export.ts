import type {
  MarketAssumptions,
  ResponseOption,
  SeedData,
  SimulationConfigurationSnapshot,
  SimulationStrategyMode,
  Stressor,
} from './types';
import type { OptimizationObjective } from './optimization-objective';

const EXPORT_SCHEMA_VERSION = 'retirement-planner-export.v1';

type HousingFundingPolicy = 'baseline' | 'home_sale_accelerated';
type WithdrawalPreference = 'standard' | 'preserve_roth';
type CashBufferPolicy = 'baseline' | 'increased';

const RETURN_GENERATION_ASSUMPTIONS: SimulationConfigurationSnapshot['returnGeneration'] = {
  model: 'bounded_normal_by_asset_class',
  boundsByAssetClass: {
    US_EQUITY: { min: -0.45, max: 0.45 },
    INTL_EQUITY: { min: -0.5, max: 0.45 },
    BONDS: { min: -0.2, max: 0.2 },
    CASH: { min: -0.01, max: 0.08 },
  },
  stressOverlayRules: [
    'market_down: years 1-3 US_EQUITY and INTL_EQUITY overrides [-18%, -12%, -8%] (replace sampled values), years 4-8 equity rebound uplift (+4%)',
    'market_up: years 1-3 US_EQUITY and INTL_EQUITY overrides [+12%, +10%, +8%] (replace sampled values)',
    'market_down/market_up: BONDS and CASH remain stochastic (no deterministic override)',
    'inflation: years 1-10 floor at 5%',
  ],
};

export interface PlanningAdjustment {
  source: 'stressor' | 'response';
  id: string;
  name: string;
  changes: string[];
  parameters?: Record<string, number | string | boolean>;
}

export interface PlanningExportSnapshot {
  household: SeedData['household'];
  assets: {
    byBucket: {
      pretax: number;
      roth: number;
      taxable: number;
      cash: number;
      hsa: number;
    };
    allocations: {
      pretax: Record<string, number>;
      roth: Record<string, number>;
      taxable: Record<string, number>;
      cash: Record<string, number>;
      hsa: Record<string, number> | null;
    };
    totals: {
      liquid: number;
      invested: number;
      trackedNetWorth: number;
    };
  };
  spending: {
    essentialMonthly: number;
    optionalMonthly: number;
    annualTaxesInsurance: number;
    travelEarlyRetirementAnnual: number;
    annualCoreSpend: number;
    annualWithTravelSpend: number;
  };
  income: {
    salaryAnnual: number;
    salaryEndDate: string;
    retirementYear: number;
    socialSecurity: SeedData['income']['socialSecurity'];
    windfalls: SeedData['income']['windfalls'];
    preRetirementContributions: SeedData['income']['preRetirementContributions'];
  };
  assumptions: {
    returns: {
      equityMean: number;
      equityVolatility: number;
      internationalEquityMean: number;
      internationalEquityVolatility: number;
      bondMean: number;
      bondVolatility: number;
      cashMean: number;
      cashVolatility: number;
    };
    inflation: {
      mean: number;
      volatility: number;
    };
    guardrails: {
      floorYears: number;
      ceilingYears: number;
      cutPercent: number;
    };
    horizon: {
      robPlanningEndAge: number;
      debbiePlanningEndAge: number;
      travelPhaseYears: number;
    };
  };
  constraints: {
    filingStatus: string;
    withdrawalStyle: string;
    irmaaAware: boolean;
    replaceModeImports: boolean;
    irmaaThreshold: number;
    healthcarePremiums: {
      baselineAcaPremiumAnnual: number | null;
      baselineMedicarePremiumAnnual: number | null;
    };
    withdrawalPreference: WithdrawalPreference;
    housingFundingPolicy: HousingFundingPolicy;
    cashBufferPolicy: CashBufferPolicy;
  };
  simulationSettings: {
    mode: SimulationStrategyMode;
    plannerAutopilotActive: boolean;
    optimizationObjective: OptimizationObjective;
    simulationRuns: number;
    simulationSeed: number | null;
    assumptionsVersion: string | null;
    inflationHandling: SimulationConfigurationSnapshot['inflationHandling'];
    returnGeneration: SimulationConfigurationSnapshot['returnGeneration'];
    timingConventions: SimulationConfigurationSnapshot['timingConventions'];
  };
}

export interface PlanningStateExport {
  version: {
    schema: string;
    exportedAt: string;
  };
  household: PlanningExportSnapshot['household'];
  assets: PlanningExportSnapshot['assets'];
  spending: PlanningExportSnapshot['spending'];
  income: PlanningExportSnapshot['income'];
  assumptions: PlanningExportSnapshot['assumptions'];
  constraints: PlanningExportSnapshot['constraints'];
  activeStressors: Array<{ id: string; name: string; type: string }>;
  activeResponses: Array<{ id: string; name: string }>;
  simulationSettings: PlanningExportSnapshot['simulationSettings'];
  toggleState: {
    stressorIds: string[];
    responseIds: string[];
  };
  adjustmentsApplied: PlanningAdjustment[];
  simulationProfiles: {
    rawSimulation: SimulationConfigurationSnapshot;
    plannerEnhancedSimulation: SimulationConfigurationSnapshot;
  };
  baseInputs: PlanningExportSnapshot;
  effectiveInputs: PlanningExportSnapshot;
  effectiveSimulationInputs: PlanningExportSnapshot;
  effectivePlanningStrategyInputs: PlanningExportSnapshot;
}

interface BuildPlanningExportInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
  optimizationObjective?: OptimizationObjective;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getCurrentPlanningYear() {
  return new Date().getUTCFullYear();
}

function shiftDateYears(value: string, years: number) {
  const date = new Date(value);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString();
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function moveIntoCash(data: SeedData, targetAmount: number) {
  let remaining = Math.max(0, targetAmount);
  const moved = {
    fromTaxable: 0,
    fromPretax: 0,
  };

  const taxableTransfer = Math.min(data.accounts.taxable.balance, remaining);
  if (taxableTransfer > 0) {
    data.accounts.taxable.balance -= taxableTransfer;
    data.accounts.cash.balance += taxableTransfer;
    moved.fromTaxable = taxableTransfer;
    remaining -= taxableTransfer;
  }

  const pretaxTransfer = Math.min(data.accounts.pretax.balance, remaining);
  if (pretaxTransfer > 0) {
    data.accounts.pretax.balance -= pretaxTransfer;
    data.accounts.cash.balance += pretaxTransfer;
    moved.fromPretax = pretaxTransfer;
    remaining -= pretaxTransfer;
  }

  return {
    movedTotal: targetAmount - remaining,
    ...moved,
  };
}

function applyStressors(
  data: SeedData,
  activeStressors: Stressor[],
  adjustments: PlanningAdjustment[],
) {
  const currentYear = getCurrentPlanningYear();

  activeStressors.forEach((stressor) => {
    if (stressor.id === 'layoff') {
      const nextDate = new Date(Date.UTC(currentYear, 0, 1)).toISOString();
      adjustments.push({
        source: 'stressor',
        id: stressor.id,
        name: stressor.name,
        changes: [
          `salaryEndDate ${data.income.salaryEndDate} -> ${nextDate}`,
          `retirementYear -> ${currentYear}`,
        ],
        parameters: { layoffYear: currentYear },
      });
      data.income.salaryEndDate = nextDate;
      return;
    }

    if (stressor.id === 'delayed_inheritance') {
      const inheritance = data.income.windfalls.find((item) => item.name === 'inheritance');
      if (!inheritance) {
        return;
      }
      const previousYear = inheritance.year;
      inheritance.year += 5;
      adjustments.push({
        source: 'stressor',
        id: stressor.id,
        name: stressor.name,
        changes: [`inheritance.year ${previousYear} -> ${inheritance.year}`],
        parameters: { delayYears: 5 },
      });
      return;
    }

    adjustments.push({
      source: 'stressor',
      id: stressor.id,
      name: stressor.name,
      changes: ['scenario return/inflation overlay enabled'],
    });
  });
}

function applyResponses(
  data: SeedData,
  activeResponses: ResponseOption[],
  adjustments: PlanningAdjustment[],
) {
  const currentYear = getCurrentPlanningYear();

  activeResponses.forEach((response) => {
    if (response.id === 'cut_spending') {
      const cut = response.optionalReductionPercent ?? 20;
      const previousOptionalMonthly = data.spending.optionalMonthly;
      data.spending.optionalMonthly *= 1 - cut / 100;
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [
          `optionalMonthly ${roundMoney(previousOptionalMonthly)} -> ${roundMoney(data.spending.optionalMonthly)}`,
        ],
        parameters: { optionalReductionPercent: cut },
      });
      return;
    }

    if (response.id === 'sell_home_early') {
      const homeSale = data.income.windfalls.find((item) => item.name === 'home_sale');
      if (!homeSale) {
        return;
      }
      const triggerYear = response.triggerYear ?? 3;
      const previousYear = homeSale.year;
      homeSale.year = currentYear + triggerYear;
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [`home_sale.year ${previousYear} -> ${homeSale.year}`],
        parameters: { triggerYear },
      });
      return;
    }

    if (response.id === 'delay_retirement') {
      const years = response.delayYears ?? 1;
      const previousDate = data.income.salaryEndDate;
      data.income.salaryEndDate = shiftDateYears(data.income.salaryEndDate, years);
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [`salaryEndDate ${previousDate} -> ${data.income.salaryEndDate}`],
        parameters: { delayYears: years },
      });
      return;
    }

    if (response.id === 'early_ss' && response.claimAge) {
      const changedClaims: string[] = [];
      data.income.socialSecurity = data.income.socialSecurity.map((entry) => {
        const nextClaimAge = Math.min(entry.claimAge, response.claimAge!);
        if (nextClaimAge !== entry.claimAge) {
          changedClaims.push(`${entry.person}: ${entry.claimAge} -> ${nextClaimAge}`);
        }
        return { ...entry, claimAge: nextClaimAge };
      });
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: changedClaims.length ? changedClaims : ['social security claim cap applied'],
        parameters: { claimAgeCap: response.claimAge },
      });
      return;
    }

    if (response.id === 'increase_cash_buffer') {
      const essentialAnnual = data.spending.essentialMonthly * 12;
      const targetAmount = essentialAnnual * 2;
      const move = moveIntoCash(data, targetAmount);
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [
          `cash +${roundMoney(move.movedTotal)}`,
          `taxable -${roundMoney(move.fromTaxable)}`,
          `pretax -${roundMoney(move.fromPretax)}`,
        ],
        parameters: { targetCashBufferAmount: roundMoney(targetAmount) },
      });
      return;
    }

    if (response.id === 'preserve_roth') {
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: ['withdrawal preference set to preserve Roth where practical'],
      });
      return;
    }

    adjustments.push({
      source: 'response',
      id: response.id,
      name: response.name,
      changes: ['response enabled'],
    });
  });
}

function buildSimulationProfile({
  assumptions,
  mode,
  stressorIds,
  responseIds,
  preserveRothPreference,
}: {
  assumptions: MarketAssumptions;
  mode: SimulationStrategyMode;
  stressorIds: string[];
  responseIds: string[];
  preserveRothPreference: boolean;
}): SimulationConfigurationSnapshot {
  const plannerLogicActive = mode === 'planner_enhanced';

  return {
    mode,
    plannerLogicActive,
    activeStressors: [...stressorIds],
    activeResponses: [...responseIds],
    withdrawalPolicy: {
      order: plannerLogicActive
        ? ['cash', 'taxable', 'pretax', 'roth (conditional)']
        : ['cash', 'taxable', 'pretax', 'roth'],
      dynamicDefenseOrdering: plannerLogicActive,
      irmaaAware: plannerLogicActive,
      acaAware: false,
      preserveRothPreference: plannerLogicActive && preserveRothPreference,
    },
    rothConversionPolicy: {
      proactiveConversionsEnabled: false,
      description:
        'Simulation engine export baseline: no proactive Roth conversion strategy in Monte Carlo run loop.',
    },
    liquidityFloorBehavior: {
      guardrailsEnabled: plannerLogicActive,
      floorYears: assumptions.guardrailFloorYears,
      ceilingYears: assumptions.guardrailCeilingYears,
      cutPercent: assumptions.guardrailCutPercent,
    },
    inflationHandling: {
      baseMean: assumptions.inflation,
      volatility: assumptions.inflationVolatility,
      highInflationStressorFloor: 0.05,
      highInflationStressorDurationYears: 10,
    },
    returnGeneration: RETURN_GENERATION_ASSUMPTIONS,
    timingConventions: {
      currentPlanningYear: getCurrentPlanningYear(),
      salaryProrationRule: 'month_fraction',
      inflationCompounding: 'annual',
    },
    simulationSettings: {
      seed: assumptions.simulationSeed ?? 20260416,
      runCount: Math.max(1, assumptions.simulationRuns),
      assumptionsVersion: assumptions.assumptionsVersion ?? 'v1',
    },
  };
}

function buildSnapshot(
  data: SeedData,
  assumptions: MarketAssumptions,
  activeResponses: ResponseOption[],
  mode: SimulationStrategyMode,
  stressorIds: string[],
  responseIds: string[],
  optimizationObjective: OptimizationObjective,
): PlanningExportSnapshot {
  const hsaBalance = data.accounts.hsa?.balance ?? 0;
  const liquid = data.accounts.cash.balance + data.accounts.taxable.balance;
  const invested =
    data.accounts.pretax.balance + data.accounts.roth.balance + data.accounts.taxable.balance + hsaBalance;
  const trackedNetWorth = invested + data.accounts.cash.balance;
  const annualCoreSpend =
    data.spending.essentialMonthly * 12 +
    data.spending.optionalMonthly * 12 +
    data.spending.annualTaxesInsurance;
  const annualWithTravelSpend = annualCoreSpend + data.spending.travelEarlyRetirementAnnual;
  const withdrawalPreference: WithdrawalPreference = activeResponses.some(
    (item) => item.id === 'preserve_roth',
  )
    ? 'preserve_roth'
    : 'standard';
  const housingFundingPolicy: HousingFundingPolicy = activeResponses.some(
    (item) => item.id === 'sell_home_early',
  )
    ? 'home_sale_accelerated'
    : 'baseline';
  const cashBufferPolicy: CashBufferPolicy = activeResponses.some(
    (item) => item.id === 'increase_cash_buffer',
  )
    ? 'increased'
    : 'baseline';
  const simulationProfile = buildSimulationProfile({
    assumptions,
    mode,
    stressorIds,
    responseIds,
    preserveRothPreference: withdrawalPreference === 'preserve_roth',
  });

  return {
    household: clone(data.household),
    assets: {
      byBucket: {
        pretax: roundMoney(data.accounts.pretax.balance),
        roth: roundMoney(data.accounts.roth.balance),
        taxable: roundMoney(data.accounts.taxable.balance),
        cash: roundMoney(data.accounts.cash.balance),
        hsa: roundMoney(hsaBalance),
      },
      allocations: {
        pretax: clone(data.accounts.pretax.targetAllocation),
        roth: clone(data.accounts.roth.targetAllocation),
        taxable: clone(data.accounts.taxable.targetAllocation),
        cash: clone(data.accounts.cash.targetAllocation),
        hsa: data.accounts.hsa ? clone(data.accounts.hsa.targetAllocation) : null,
      },
      totals: {
        liquid: roundMoney(liquid),
        invested: roundMoney(invested),
        trackedNetWorth: roundMoney(trackedNetWorth),
      },
    },
    spending: {
      essentialMonthly: roundMoney(data.spending.essentialMonthly),
      optionalMonthly: roundMoney(data.spending.optionalMonthly),
      annualTaxesInsurance: roundMoney(data.spending.annualTaxesInsurance),
      travelEarlyRetirementAnnual: roundMoney(data.spending.travelEarlyRetirementAnnual),
      annualCoreSpend: roundMoney(annualCoreSpend),
      annualWithTravelSpend: roundMoney(annualWithTravelSpend),
    },
    income: {
      salaryAnnual: roundMoney(data.income.salaryAnnual),
      salaryEndDate: data.income.salaryEndDate,
      retirementYear: new Date(data.income.salaryEndDate).getUTCFullYear(),
      socialSecurity: clone(data.income.socialSecurity),
      windfalls: clone(data.income.windfalls),
      preRetirementContributions: clone(data.income.preRetirementContributions),
    },
    assumptions: {
      returns: {
        equityMean: assumptions.equityMean,
        equityVolatility: assumptions.equityVolatility,
        internationalEquityMean: assumptions.internationalEquityMean,
        internationalEquityVolatility: assumptions.internationalEquityVolatility,
        bondMean: assumptions.bondMean,
        bondVolatility: assumptions.bondVolatility,
        cashMean: assumptions.cashMean,
        cashVolatility: assumptions.cashVolatility,
      },
      inflation: {
        mean: assumptions.inflation,
        volatility: assumptions.inflationVolatility,
      },
      guardrails: {
        floorYears: assumptions.guardrailFloorYears,
        ceilingYears: assumptions.guardrailCeilingYears,
        cutPercent: assumptions.guardrailCutPercent,
      },
      horizon: {
        robPlanningEndAge: assumptions.robPlanningEndAge,
        debbiePlanningEndAge: assumptions.debbiePlanningEndAge,
        travelPhaseYears: assumptions.travelPhaseYears,
      },
    },
    constraints: {
      filingStatus: data.household.filingStatus,
      withdrawalStyle: data.rules.withdrawalStyle,
      irmaaAware: data.rules.irmaaAware,
      replaceModeImports: data.rules.replaceModeImports,
      irmaaThreshold: assumptions.irmaaThreshold,
      healthcarePremiums: {
        baselineAcaPremiumAnnual:
          data.rules.healthcarePremiums?.baselineAcaPremiumAnnual ?? null,
        baselineMedicarePremiumAnnual:
          data.rules.healthcarePremiums?.baselineMedicarePremiumAnnual ?? null,
      },
      withdrawalPreference,
      housingFundingPolicy,
      cashBufferPolicy,
    },
    simulationSettings: {
      mode,
      plannerAutopilotActive: mode === 'planner_enhanced',
      optimizationObjective,
      simulationRuns: assumptions.simulationRuns,
      simulationSeed: assumptions.simulationSeed ?? null,
      assumptionsVersion: assumptions.assumptionsVersion ?? null,
      inflationHandling: simulationProfile.inflationHandling,
      returnGeneration: simulationProfile.returnGeneration,
      timingConventions: simulationProfile.timingConventions,
    },
  };
}

export function buildPlanningStateExport(
  input: BuildPlanningExportInput,
): PlanningStateExport {
  const optimizationObjective = input.optimizationObjective ?? 'maximize_flat_spending';
  const activeStressors = input.data.stressors.filter((item) =>
    input.selectedStressorIds.includes(item.id),
  );
  const activeResponses = input.data.responses.filter((item) =>
    input.selectedResponseIds.includes(item.id),
  );

  const baseData = clone(input.data);
  const effectiveData = clone(input.data);
  const adjustmentsApplied: PlanningAdjustment[] = [];
  const activeStressorIds = activeStressors.map((item) => item.id);
  const activeResponseIds = activeResponses.map((item) => item.id);

  applyStressors(effectiveData, activeStressors, adjustmentsApplied);
  applyResponses(effectiveData, activeResponses, adjustmentsApplied);

  const baseInputs = buildSnapshot(
    baseData,
    input.assumptions,
    [],
    'planner_enhanced',
    [],
    [],
    optimizationObjective,
  );
  const effectiveInputs = buildSnapshot(
    effectiveData,
    input.assumptions,
    activeResponses,
    'planner_enhanced',
    activeStressorIds,
    activeResponseIds,
    optimizationObjective,
  );
  const effectiveSimulationInputs = buildSnapshot(
    effectiveData,
    input.assumptions,
    activeResponses,
    'raw_simulation',
    activeStressorIds,
    activeResponseIds,
    optimizationObjective,
  );
  const effectivePlanningStrategyInputs = buildSnapshot(
    effectiveData,
    input.assumptions,
    activeResponses,
    'planner_enhanced',
    activeStressorIds,
    activeResponseIds,
    optimizationObjective,
  );
  const simulationProfiles = {
    rawSimulation: buildSimulationProfile({
      assumptions: input.assumptions,
      mode: 'raw_simulation',
      stressorIds: activeStressorIds,
      responseIds: activeResponseIds,
      preserveRothPreference: false,
    }),
    plannerEnhancedSimulation: buildSimulationProfile({
      assumptions: input.assumptions,
      mode: 'planner_enhanced',
      stressorIds: activeStressorIds,
      responseIds: activeResponseIds,
      preserveRothPreference: activeResponses.some((item) => item.id === 'preserve_roth'),
    }),
  };

  return {
    version: {
      schema: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
    },
    household: effectiveInputs.household,
    assets: effectiveInputs.assets,
    spending: effectiveInputs.spending,
    income: effectiveInputs.income,
    assumptions: effectiveInputs.assumptions,
    constraints: effectiveInputs.constraints,
    activeStressors: activeStressors.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
    })),
    activeResponses: activeResponses.map((item) => ({
      id: item.id,
      name: item.name,
    })),
    simulationSettings: effectiveInputs.simulationSettings,
    toggleState: {
      stressorIds: [...input.selectedStressorIds],
      responseIds: [...input.selectedResponseIds],
    },
    adjustmentsApplied,
    simulationProfiles,
    baseInputs,
    effectiveInputs,
    effectiveSimulationInputs,
    effectivePlanningStrategyInputs,
  };
}
