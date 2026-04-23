import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

// Prototype: instead of emitting a single "92% success" point estimate,
// run a small handful of perturbed scenarios and report the RANGE of
// outputs the plan produces under reasonable input variation. This is
// the trust lever flagged throughout the validation sprints: a model
// that honestly reports uncertainty is safer to act on than one that
// implies false precision.
//
// Keep scope tight — 6 perturbations chosen to span the assumptions a
// typical retiree would be most wrong about. NOT a full sensitivity grid.

export interface UncertaintyPerturbation {
  id: string;
  label: string;
  mutateAssumptions?: (assumptions: MarketAssumptions) => MarketAssumptions;
  mutateSeed?: (seed: SeedData) => void;
}

export const DEFAULT_UNCERTAINTY_PERTURBATIONS: UncertaintyPerturbation[] = [
  {
    id: 'baseline',
    label: 'As entered',
  },
  {
    id: 'equity-minus-2pp',
    label: 'Equity returns -2pp',
    mutateAssumptions: (a) => ({
      ...a,
      equityMean: a.equityMean - 0.02,
      internationalEquityMean: a.internationalEquityMean - 0.02,
    }),
  },
  {
    id: 'equity-plus-2pp',
    label: 'Equity returns +2pp',
    mutateAssumptions: (a) => ({
      ...a,
      equityMean: a.equityMean + 0.02,
      internationalEquityMean: a.internationalEquityMean + 0.02,
    }),
  },
  {
    id: 'inflation-plus-1pp',
    label: 'Inflation +1pp',
    mutateAssumptions: (a) => ({ ...a, inflation: a.inflation + 0.01 }),
  },
  {
    id: 'spending-plus-10pct',
    label: 'Spending +10%',
    mutateSeed: (seed) => {
      seed.spending.essentialMonthly = Math.round(seed.spending.essentialMonthly * 1.1);
      seed.spending.optionalMonthly = Math.round(seed.spending.optionalMonthly * 1.1);
    },
  },
  {
    id: 'spending-minus-10pct',
    label: 'Spending -10%',
    mutateSeed: (seed) => {
      seed.spending.essentialMonthly = Math.round(seed.spending.essentialMonthly * 0.9);
      seed.spending.optionalMonthly = Math.round(seed.spending.optionalMonthly * 0.9);
    },
  },
];

export interface UncertaintyScenarioResult {
  id: string;
  label: string;
  successRate: number;
  medianEndingWealth: number;
  tenthPercentileEndingWealth: number;
}

export interface UncertaintySurface {
  scenarios: UncertaintyScenarioResult[];
  successRateRange: { min: number; max: number; span: number };
  medianEndingWealthRange: { min: number; max: number; span: number };
  // The "honest headline" — a range expression like "85%-94% success
  // depending on assumption variation." Useful as the replacement for
  // the single-point success rate in user-facing UI.
  honestHeadline: {
    successRateMinPct: number;
    successRateMaxPct: number;
    summary: string;
  };
}

function cloneSeed(seed: SeedData): SeedData {
  return JSON.parse(JSON.stringify(seed)) as SeedData;
}

export function buildUncertaintySurface(
  seedData: SeedData,
  assumptions: MarketAssumptions,
  perturbations: UncertaintyPerturbation[] = DEFAULT_UNCERTAINTY_PERTURBATIONS,
): UncertaintySurface {
  const scenarioResults: UncertaintyScenarioResult[] = perturbations.map((pert) => {
    const seedForPert = cloneSeed(seedData);
    pert.mutateSeed?.(seedForPert);
    const assumptionsForPert = pert.mutateAssumptions
      ? pert.mutateAssumptions(assumptions)
      : assumptions;
    const [path] = buildPathResults(seedForPert, assumptionsForPert, [], []);
    return {
      id: pert.id,
      label: pert.label,
      successRate: path.successRate,
      medianEndingWealth: path.medianEndingWealth,
      tenthPercentileEndingWealth: path.tenthPercentileEndingWealth,
    };
  });

  const successValues = scenarioResults.map((s) => s.successRate);
  const successMin = Math.min(...successValues);
  const successMax = Math.max(...successValues);
  const wealthValues = scenarioResults.map((s) => s.medianEndingWealth);
  const wealthMin = Math.min(...wealthValues);
  const wealthMax = Math.max(...wealthValues);

  const successRateMinPct = Math.round(successMin * 100);
  const successRateMaxPct = Math.round(successMax * 100);

  return {
    scenarios: scenarioResults,
    successRateRange: { min: successMin, max: successMax, span: successMax - successMin },
    medianEndingWealthRange: { min: wealthMin, max: wealthMax, span: wealthMax - wealthMin },
    honestHeadline: {
      successRateMinPct,
      successRateMaxPct,
      summary:
        successRateMinPct === successRateMaxPct
          ? `~${successRateMaxPct}% success across the scenarios tested.`
          : `${successRateMinPct}%–${successRateMaxPct}% success across variations in returns, inflation, and spending.`,
    },
  };
}
