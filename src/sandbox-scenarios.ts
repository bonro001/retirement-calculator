// Sandbox scenario library: the "what if X happens, and I react Y" surface.
//
// What this module is for: the household picks a stressor (layoff, market
// crash, etc.) plus zero or more reactions (cut travel, claim SS early, etc.)
// and Sandbox tells them, in plain English and one dollar number, what the
// scenario does to their plan. Same back-of-envelope spirit as the Easy-to-
// Miss cards: not the Monte Carlo, but enough to steer a conversation.
//
// What this module is NOT: it does NOT mutate the household's saved plan
// and does NOT call the simulation worker. Heuristic only. The Sandbox UI
// can offer a "Run this in the engine" affordance that hands the scenario
// off to Inspector for the honest sim.
//
// Why heuristic instead of running the real engine in Sandbox:
//   1. The real sim takes ~30s/run; trying combinations one at a time
//      makes the room feel broken, not exploratory.
//   2. The household's first question is "is this a $5k problem or a $500k
//      problem?" — order of magnitude matters more than precision.
//   3. The real engine output already lives in Inspector; we don't need to
//      duplicate it. Sandbox is the conversation; Inspector is the proof.
//
// Adding a new stressor or reaction: extend the union types, add a def to
// the registry array, and (for stressors) add a case in `estimateImpact`.
// The UI iterates the registries — no UI changes needed.

import type { MarketAssumptions, SeedData } from './types';

export type SandboxStressorId =
  | 'layoff'
  | 'market_down'
  | 'inflation'
  | 'delayed_inheritance'
  | 'long_term_care';

export type SandboxReactionId =
  | 'cut_spending'
  | 'cut_travel'
  | 'defer_travel'
  | 'delay_retirement'
  | 'early_ss'
  | 'sell_home_early';

export interface SandboxKnob {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: string;
}

export interface SandboxStressorDef {
  id: SandboxStressorId;
  label: string;
  description: string;
  knob: SandboxKnob | null;
  applicableReactions: SandboxReactionId[];
}

export interface SandboxReactionDef {
  id: SandboxReactionId;
  label: string;
  description: string;
  knob: SandboxKnob | null;
}

export const SANDBOX_STRESSORS: SandboxStressorDef[] = [
  {
    id: 'layoff',
    label: 'Layoff',
    description:
      "Salary stops earlier than the plan assumed. The household has to bridge to retirement on portfolio + any severance.",
    knob: {
      id: 'severance_months',
      label: 'Severance (months of salary)',
      min: 0,
      max: 12,
      step: 1,
      defaultValue: 3,
      unit: 'mo',
    },
    applicableReactions: [
      'cut_spending',
      'cut_travel',
      'defer_travel',
      'delay_retirement',
      'early_ss',
      'sell_home_early',
    ],
  },
  {
    id: 'market_down',
    label: 'Market crash',
    description:
      "A sharp drop in the first year of retirement. Sequence-of-returns risk is highest here — the same dollar hit hurts more early than late.",
    knob: {
      id: 'drop_pct',
      label: 'First-year portfolio drop',
      min: 5,
      max: 50,
      step: 5,
      defaultValue: 25,
      unit: '%',
    },
    applicableReactions: [
      'cut_spending',
      'cut_travel',
      'defer_travel',
      'delay_retirement',
      'early_ss',
    ],
  },
  {
    id: 'inflation',
    label: 'High inflation',
    description:
      'Prolonged inflation above the plan assumption. Nominal portfolio holds, but spending power erodes — every fixed-dollar plan line item gets quietly more expensive.',
    knob: {
      id: 'extra_inflation_pct',
      label: 'Extra inflation above plan',
      min: 1,
      max: 6,
      step: 1,
      defaultValue: 3,
      unit: '%',
    },
    applicableReactions: ['cut_spending', 'cut_travel', 'defer_travel'],
  },
  {
    id: 'delayed_inheritance',
    label: 'Delayed inheritance',
    description:
      "An expected inheritance arrives later than planned. The household's bridge to that money has to stretch.",
    knob: {
      id: 'delay_years',
      label: 'Years delayed',
      min: 1,
      max: 15,
      step: 1,
      defaultValue: 5,
      unit: 'yr',
    },
    applicableReactions: [
      'cut_spending',
      'cut_travel',
      'defer_travel',
      'delay_retirement',
      'sell_home_early',
    ],
  },
  {
    id: 'long_term_care',
    label: 'Long-term care event',
    description:
      'One spouse needs paid care for an extended period. National median runs ~$100k/yr; multi-year stays are common.',
    knob: {
      id: 'care_years',
      label: 'Years of care',
      min: 1,
      max: 8,
      step: 1,
      defaultValue: 2,
      unit: 'yr',
    },
    applicableReactions: ['cut_spending', 'sell_home_early'],
  },
];

export const SANDBOX_REACTIONS: SandboxReactionDef[] = [
  {
    id: 'cut_spending',
    label: 'Cut optional spending',
    description:
      'Trim the discretionary bucket — eating out, hobbies, gifts. Essentials and travel stay untouched (each has its own lever).',
    knob: {
      id: 'cut_pct',
      label: 'Cut by',
      min: 5,
      max: 50,
      step: 5,
      defaultValue: 20,
      unit: '%',
    },
  },
  {
    id: 'cut_travel',
    label: 'Reduce travel budget',
    description:
      'Travel less, not later. Smaller annual travel spend going forward — separate from the optional bucket. Essentials stay untouched.',
    knob: {
      id: 'travel_cut_pct',
      label: 'Cut travel by',
      min: 10,
      max: 75,
      step: 5,
      defaultValue: 30,
      unit: '%',
    },
  },
  {
    id: 'defer_travel',
    label: 'Defer travel',
    description:
      'Pause the planned travel budget for a few years (then resume at the original level).',
    knob: {
      id: 'defer_years',
      label: 'Pause for',
      min: 1,
      max: 10,
      step: 1,
      defaultValue: 3,
      unit: 'yr',
    },
  },
  {
    id: 'delay_retirement',
    label: 'Delay retirement',
    description: 'Work additional years before the salary stops.',
    knob: {
      id: 'extra_years',
      label: 'Extra working years',
      min: 1,
      max: 5,
      step: 1,
      defaultValue: 2,
      unit: 'yr',
    },
  },
  {
    id: 'early_ss',
    label: 'Claim Social Security early',
    description:
      'Start benefits at 62 instead of the planned claim age. Smaller monthly checks, but income arrives sooner.',
    knob: null,
  },
  {
    id: 'sell_home_early',
    label: 'Sell home early',
    description:
      'Pull forward the home-sale windfall to free up liquidity and downsize.',
    knob: {
      id: 'years_earlier',
      label: 'Years earlier than planned',
      min: 1,
      max: 10,
      step: 1,
      defaultValue: 5,
      unit: 'yr',
    },
  },
];

export function getStressorDef(id: SandboxStressorId): SandboxStressorDef {
  const def = SANDBOX_STRESSORS.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown sandbox stressor: ${id}`);
  return def;
}

export function getReactionDef(id: SandboxReactionId): SandboxReactionDef {
  const def = SANDBOX_REACTIONS.find((r) => r.id === id);
  if (!def) throw new Error(`Unknown sandbox reaction: ${id}`);
  return def;
}

export interface ScenarioReactionSelection {
  id: SandboxReactionId;
  knobValue: number;
}

export interface ScenarioImpact {
  /** Dollar impact (today's dollars) to the plan if nothing else changes. */
  baselineImpactDollars: number;
  /** Dollar impact after the selected reactions are applied. */
  mitigatedImpactDollars: number;
  /** Sum of dollars the reactions claw back. Always >= 0. */
  reactionOffsetDollars: number;
  /** Plain-English summary, one short sentence. */
  summary: string;
  /** Per-reaction breakdown, in the order selected, for the result panel list. */
  reactionBreakdown: Array<{
    id: SandboxReactionId;
    label: string;
    offsetDollars: number;
    note: string;
  }>;
}

interface ImpactInputs {
  data: SeedData;
  assumptions: MarketAssumptions;
  today: Date;
  stressorKnobValue: number;
  reactions: ScenarioReactionSelection[];
}

/**
 * Years between today and the household's planned salary-end date. Used as
 * the "bridge length" multiplier for the layoff stressor and for sizing
 * reactions like "delay retirement" that only help during the working years.
 * Returns 0 if salary has already ended.
 */
function yearsUntilSalaryEnd(data: SeedData, today: Date): number {
  const endIso = data.income?.salaryEndDate;
  if (!endIso) return 0;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return 0;
  const diffMs = end.getTime() - today.getTime();
  return Math.max(0, diffMs / (365.25 * 24 * 3600 * 1000));
}

function totalPortfolio(data: SeedData): number {
  return (
    (data.accounts?.pretax?.balance ?? 0) +
    (data.accounts?.roth?.balance ?? 0) +
    (data.accounts?.taxable?.balance ?? 0) +
    (data.accounts?.cash?.balance ?? 0) +
    (data.accounts?.hsa?.balance ?? 0)
  );
}

function realReturnRate(
  data: SeedData,
  assumptions: MarketAssumptions,
): number {
  // Weighted nominal return across all account buckets, minus inflation.
  // Same approach as the Advisor's recovery estimator — keeps the heuristic
  // in agreement with the household's actual mix.
  const buckets = ['pretax', 'roth', 'taxable', 'cash', 'hsa'] as const;
  let totalBalance = 0;
  let weightedNominal = 0;
  for (const bucket of buckets) {
    const b = data.accounts?.[bucket];
    if (!b || !(b.balance > 0)) continue;
    totalBalance += b.balance;
    for (const [symbol, weight] of Object.entries(b.targetAllocation ?? {})) {
      const upper = symbol.toUpperCase();
      const expected =
        upper === 'CASH'
          ? assumptions.cashMean
          : upper === 'BONDS' || upper === 'BND' || upper === 'AGG'
            ? assumptions.bondMean
            : upper === 'INTL_EQUITY' || upper === 'VXUS' || upper === 'IXUS'
              ? assumptions.internationalEquityMean
              : assumptions.equityMean;
      weightedNominal += b.balance * weight * expected;
    }
  }
  const nominal = totalBalance > 0 ? weightedNominal / totalBalance : 0.05;
  return Math.max(0.005, nominal - assumptions.inflation);
}

/**
 * Plan years remaining — used by the inflation stressor to scale the
 * "extra dollars consumed" estimate. Capped at 30 to keep multi-decade
 * projections from drowning out the order-of-magnitude read.
 */
function planYearsRemaining(
  data: SeedData,
  assumptions: MarketAssumptions,
  today: Date,
): number {
  const robEnd = assumptions.robPlanningEndAge ?? 90;
  const debbieEnd = assumptions.debbiePlanningEndAge ?? 90;
  const robBirth = data.household?.robBirthDate
    ? new Date(data.household.robBirthDate)
    : null;
  const debbieBirth = data.household?.debbieBirthDate
    ? new Date(data.household.debbieBirthDate)
    : null;
  const ms = today.getTime();
  const yrs = (b: Date) =>
    (ms - b.getTime()) / (365.25 * 24 * 3600 * 1000);
  const robYears = robBirth ? Math.max(0, robEnd - yrs(robBirth)) : 30;
  const debbieYears = debbieBirth
    ? Math.max(0, debbieEnd - yrs(debbieBirth))
    : 30;
  return Math.min(30, Math.max(robYears, debbieYears));
}

// ---------------------------------------------------------------------------
// Stressor impact heuristics (baseline — before any reaction)
// ---------------------------------------------------------------------------

function layoffImpact(args: ImpactInputs): number {
  const yearsLost = yearsUntilSalaryEnd(args.data, args.today);
  const lostWages = (args.data.income?.salaryAnnual ?? 0) * yearsLost;
  const severanceMonths = args.stressorKnobValue;
  const severance =
    ((args.data.income?.salaryAnnual ?? 0) / 12) * severanceMonths;
  return Math.max(0, lostWages - severance);
}

function marketDownImpact(args: ImpactInputs): number {
  const dropPct = args.stressorKnobValue / 100;
  const portfolio = totalPortfolio(args.data);
  // Sequence-risk multiplier: dollars lost early in retirement compound for
  // longer than dollars lost late. We size the impact at the raw drawdown
  // plus the foregone real growth on those dollars over a 10-year horizon —
  // enough to be honest about why year-1 crashes hurt.
  const directLoss = portfolio * dropPct;
  const foregoneGrowth =
    directLoss * realReturnRate(args.data, args.assumptions) * 10;
  return directLoss + foregoneGrowth;
}

function inflationImpact(args: ImpactInputs): number {
  const extraInflation = args.stressorKnobValue / 100;
  const annualSpend =
    ((args.data.spending?.essentialMonthly ?? 0) +
      (args.data.spending?.optionalMonthly ?? 0)) *
      12 +
    (args.data.spending?.travelEarlyRetirementAnnual ?? 0) +
    (args.data.spending?.annualTaxesInsurance ?? 0);
  const years = planYearsRemaining(args.data, args.assumptions, args.today);
  // Approximation: extra inflation compounds; over `years` it adds roughly
  // half the extra rate × years × annual spend (triangle-area integral of a
  // linearly growing gap). Order-of-magnitude correct for this heuristic.
  return annualSpend * extraInflation * years * 0.5;
}

function delayedInheritanceImpact(args: ImpactInputs): number {
  const inheritance = args.data.income?.windfalls?.find(
    (w) => w.name === 'inheritance',
  );
  const amount = inheritance?.amount ?? 0;
  const delayYears = args.stressorKnobValue;
  // Cost of the delay = foregone real return on the inheritance over the
  // delay period (we assumed it'd be invested when received).
  return amount * realReturnRate(args.data, args.assumptions) * delayYears;
}

function longTermCareImpact(args: ImpactInputs): number {
  // National median ~$100k/yr for a private nursing home room; assisted
  // living is lower, memory care higher. Use $100k as the round number;
  // the household can think of this as the order of magnitude.
  const annualCareCost = 100_000;
  return annualCareCost * args.stressorKnobValue;
}

function baselineImpact(
  stressorId: SandboxStressorId,
  args: ImpactInputs,
): number {
  switch (stressorId) {
    case 'layoff':
      return layoffImpact(args);
    case 'market_down':
      return marketDownImpact(args);
    case 'inflation':
      return inflationImpact(args);
    case 'delayed_inheritance':
      return delayedInheritanceImpact(args);
    case 'long_term_care':
      return longTermCareImpact(args);
  }
}

// ---------------------------------------------------------------------------
// Reaction offsets — how many dollars each reaction reclaims from the impact
// ---------------------------------------------------------------------------

function cutSpendingOffset(
  args: ImpactInputs,
  cutPct: number,
  yearsActive: number,
): number {
  const optionalAnnual = (args.data.spending?.optionalMonthly ?? 0) * 12;
  return optionalAnnual * (cutPct / 100) * yearsActive;
}

function deferTravelOffset(
  args: ImpactInputs,
  deferYears: number,
): number {
  return (args.data.spending?.travelEarlyRetirementAnnual ?? 0) * deferYears;
}

/**
 * Permanently smaller annual travel budget. Unlike `defer_travel` (a
 * time-bounded pause), this one rides the full early-retirement travel
 * window. Sized as `travelAnnual × cutPct × earlyWindowYears`.
 */
function cutTravelOffset(
  args: ImpactInputs,
  cutPct: number,
): number {
  const travelAnnual = args.data.spending?.travelEarlyRetirementAnnual ?? 0;
  const earlyWindow = Math.max(1, args.assumptions.travelPhaseYears ?? 10);
  return travelAnnual * (cutPct / 100) * earlyWindow;
}

function delayRetirementOffset(
  args: ImpactInputs,
  extraYears: number,
): number {
  // Each extra working year adds salary AND avoids a year of withdrawals.
  // Conservative read: just count the wages (the avoided draw is a second-
  // order benefit captured in cumulative portfolio growth).
  return (args.data.income?.salaryAnnual ?? 0) * extraYears;
}

function earlySsOffset(args: ImpactInputs): number {
  // Pulling SS forward gives early income at the cost of ~30% lower monthly
  // benefit (62 vs 70). Heuristic: 5 years of "rescue" income at ~70% of
  // FRA benefit, summed across both spouses (if applicable).
  const ssEntries = args.data.income?.socialSecurity ?? [];
  let pulledForward = 0;
  for (const ss of ssEntries) {
    const fraMonthly = ss.fraMonthly ?? 0;
    pulledForward += fraMonthly * 0.7 * 12 * 5;
  }
  return pulledForward;
}

function sellHomeEarlyOffset(args: ImpactInputs, yearsEarlier: number): number {
  const homeSale = args.data.income?.windfalls?.find(
    (w) => w.name === 'home_sale',
  );
  const amount = homeSale?.amount ?? 0;
  // Pulling the windfall forward gives `yearsEarlier` of real return on the
  // proceeds. That's the offset value — the household still receives the
  // sale either way.
  return amount * realReturnRate(args.data, args.assumptions) * yearsEarlier;
}

function reactionOffset(
  reaction: ScenarioReactionSelection,
  args: ImpactInputs,
): number {
  switch (reaction.id) {
    case 'cut_spending': {
      const cutPct = reaction.knobValue;
      const yearsActive = Math.min(
        10,
        planYearsRemaining(args.data, args.assumptions, args.today),
      );
      return cutSpendingOffset(args, cutPct, yearsActive);
    }
    case 'defer_travel':
      return deferTravelOffset(args, reaction.knobValue);
    case 'cut_travel':
      return cutTravelOffset(args, reaction.knobValue);
    case 'delay_retirement':
      return delayRetirementOffset(args, reaction.knobValue);
    case 'early_ss':
      return earlySsOffset(args);
    case 'sell_home_early':
      return sellHomeEarlyOffset(args, reaction.knobValue);
  }
}

function reactionNote(
  reaction: ScenarioReactionSelection,
  offsetDollars: number,
): string {
  const offset = `~${formatRoundDollars(offsetDollars)}`;
  switch (reaction.id) {
    case 'cut_spending':
      return `Cuts ${reaction.knobValue}% of optional spend over the stressor window. Reclaims ${offset}.`;
    case 'defer_travel':
      return `Pauses travel for ${reaction.knobValue} ${reaction.knobValue === 1 ? 'year' : 'years'}. Reclaims ${offset}.`;
    case 'cut_travel':
      return `Reduces annual travel budget by ${reaction.knobValue}% across the early-retirement window. Reclaims ${offset}.`;
    case 'delay_retirement':
      return `${reaction.knobValue} extra working ${reaction.knobValue === 1 ? 'year' : 'years'} of salary. Reclaims ${offset}.`;
    case 'early_ss':
      return `Pulls SS forward to age 62 for both spouses. Reclaims ${offset}.`;
    case 'sell_home_early':
      return `Brings home-sale windfall in ${reaction.knobValue} ${reaction.knobValue === 1 ? 'year' : 'years'} earlier. Reclaims ${offset}.`;
  }
}

function formatRoundDollars(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${Math.round(abs / 1_000)}k`;
  }
  return `${sign}$${abs}`;
}

export function estimateScenarioImpact(args: {
  data: SeedData;
  assumptions: MarketAssumptions;
  today: Date;
  stressorId: SandboxStressorId;
  stressorKnobValue: number;
  reactions: ScenarioReactionSelection[];
}): ScenarioImpact {
  const inputs: ImpactInputs = {
    data: args.data,
    assumptions: args.assumptions,
    today: args.today,
    stressorKnobValue: args.stressorKnobValue,
    reactions: args.reactions,
  };
  const baselineDollars = baselineImpact(args.stressorId, inputs);
  const stressorDef = getStressorDef(args.stressorId);
  const breakdown = args.reactions.map((reaction) => {
    const offsetDollars = reactionOffset(reaction, inputs);
    return {
      id: reaction.id,
      label: getReactionDef(reaction.id).label,
      offsetDollars,
      note: reactionNote(reaction, offsetDollars),
    };
  });
  const reactionOffsetDollars = breakdown.reduce(
    (sum, b) => sum + Math.max(0, b.offsetDollars),
    0,
  );
  // Mitigated impact never goes negative — once the reactions cover the
  // stressor, the household isn't *gaining* money, they're just neutral.
  const mitigatedDollars = Math.max(0, baselineDollars - reactionOffsetDollars);

  const summary = (() => {
    if (baselineDollars <= 0) {
      return `${stressorDef.label} doesn't materially affect this plan at the current settings.`;
    }
    if (args.reactions.length === 0) {
      return `If ${stressorDef.label.toLowerCase()} happens and you don't react, expect about ${formatRoundDollars(baselineDollars)} of plan damage.`;
    }
    const coverage =
      reactionOffsetDollars >= baselineDollars
        ? 'fully'
        : reactionOffsetDollars >= baselineDollars * 0.75
          ? 'mostly'
          : reactionOffsetDollars >= baselineDollars * 0.4
            ? 'meaningfully'
            : 'partially';
    return `${stressorDef.label} costs ~${formatRoundDollars(baselineDollars)} unmitigated. Your selected reactions ${coverage} offset that — net damage drops to ~${formatRoundDollars(mitigatedDollars)}.`;
  })();

  return {
    baselineImpactDollars: baselineDollars,
    mitigatedImpactDollars: mitigatedDollars,
    reactionOffsetDollars,
    summary,
    reactionBreakdown: breakdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-engine integration ("Plan B" synthesizer).
//
// `estimateScenarioImpact()` above returns a heuristic order-of-magnitude
// dollar number — fast, fine for steering a conversation. This block converts
// the same Sandbox state into honest engine inputs so the household can hand
// it to `simulation.worker` and get a real Monte Carlo readout.
//
// Why this lives here instead of in App.tsx: the per-stressor knowledge
// ("market_down means equity haircut at sim start", "long_term_care enables
// the LTC rules block", etc.) belongs next to the knob definitions. The UI
// just calls `buildSandboxEngineRun()` and forwards the result to the worker.
//
// Mapping table (Sandbox id → engine concept):
//   layoff              → engine stressor 'layoff' + layoffSeverance/RetireDate
//   delayed_inheritance → engine stressor 'delayed_inheritance' + years knob
//   long_term_care      → mutate data.rules.ltcAssumptions (force the event)
//   inflation           → mutate assumptions.inflation (+X percentage points)
//   market_down         → instant haircut on equity-allocated balances
//                         (the engine has no first-class "first-year crash"
//                         stressor; this approximates sequence-of-returns
//                         risk by knocking down the starting portfolio).
//
//   cut_spending     → engine response 'cut_spending' + cutSpendingPercent
//                      (only touches the optional/discretionary bucket — the
//                      engine never reduces essentials)
//   cut_travel       → mutate data.spending.travelEarlyRetirementAnnual
//                      (permanent % reduction of the travel line; separate
//                      from optional spending, separate from defer_travel)
//   defer_travel     → mutate data.spending.travelEarlyRetirementAnnual
//                      (proportional reduction; engine has no time-windowed
//                      travel pause)
//   delay_retirement → engine response 'delay_retirement' + delayYears
//   early_ss         → engine response 'early_ss' + claimAge
//   sell_home_early  → engine response 'sell_home_early' + triggerYear
// ─────────────────────────────────────────────────────────────────────────────

import type { Stressor, ResponseOption } from './types';

/** Engine-run inputs synthesized from a Sandbox scenario. */
export interface SandboxEngineRun {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
  stressorKnobs: {
    layoffRetireDate?: string;
    layoffSeverance?: number;
    delayedInheritanceYears?: number;
    cutSpendingPercent?: number;
  };
  /** What we actually mutated, for diagnostics + the result panel footer. */
  mutationNotes: string[];
}

const SANDBOX_STRESSOR_PREFIX = 'sandbox_';

/** Years between today and salary end, rounded down to a whole month. */
function monthsUntilSalaryEnd(data: SeedData, today: Date): number {
  const endIso = data.income?.salaryEndDate;
  if (!endIso) return 0;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return 0;
  const months =
    (end.getFullYear() - today.getFullYear()) * 12 +
    (end.getMonth() - today.getMonth());
  return Math.max(0, months);
}

/** Salary in dollars per month (annual / 12). */
function monthlySalary(data: SeedData): number {
  return (data.income?.salaryAnnual ?? 0) / 12;
}

/**
 * Apply an instant equity haircut to every account bucket, scaled by the
 * bucket's equity weight. A 25% market drop on a 60/40 bucket reduces that
 * bucket's balance by 0.25 × 0.60 = 15%. Honest first-order approximation
 * of "the day the crash happens" — fully mark-to-market, no recovery yet.
 */
function applyEquityHaircut(data: SeedData, dropPct: number): SeedData {
  const drop = Math.max(0, Math.min(100, dropPct)) / 100;
  if (drop <= 0) return data;
  const equityWeight = (allocation: Record<string, number> | undefined) => {
    if (!allocation) return 0;
    let total = 0;
    for (const [symbol, weight] of Object.entries(allocation)) {
      const upper = symbol.toUpperCase();
      const isEquity =
        upper === 'US_EQUITY' ||
        upper === 'INTL_EQUITY' ||
        upper === 'VTI' ||
        upper === 'VXUS' ||
        upper === 'IXUS' ||
        upper === 'VOO' ||
        upper === 'SPY' ||
        upper.includes('EQUITY') ||
        upper.includes('STOCK');
      if (isEquity) total += weight;
    }
    return Math.max(0, Math.min(1, total));
  };
  const haircut = (b: { balance: number; targetAllocation: Record<string, number> }) => {
    const w = equityWeight(b.targetAllocation);
    return { ...b, balance: Math.max(0, b.balance * (1 - drop * w)) };
  };
  return {
    ...data,
    accounts: {
      ...data.accounts,
      pretax: haircut(data.accounts.pretax),
      roth: haircut(data.accounts.roth),
      taxable: haircut(data.accounts.taxable),
      cash: haircut(data.accounts.cash),
      ...(data.accounts.hsa ? { hsa: haircut(data.accounts.hsa) } : {}),
    },
  };
}

/**
 * Synthesize engine inputs for a Sandbox scenario. Pure function — never
 * mutates its inputs. The returned `data`/`assumptions` objects are safe to
 * post to the worker.
 */
export function buildSandboxEngineRun(args: {
  data: SeedData;
  assumptions: MarketAssumptions;
  today: Date;
  stressorId: SandboxStressorId;
  stressorKnobValue: number;
  reactions: ScenarioReactionSelection[];
}): SandboxEngineRun {
  const { stressorId, stressorKnobValue, reactions, today } = args;

  // Start from shallow clones so mutations don't leak back to the store.
  let data: SeedData = {
    ...args.data,
    income: { ...args.data.income, windfalls: [...args.data.income.windfalls] },
    spending: { ...args.data.spending },
    rules: { ...args.data.rules },
    stressors: [...args.data.stressors],
    responses: [...args.data.responses],
    accounts: { ...args.data.accounts },
  };
  let assumptions: MarketAssumptions = { ...args.assumptions };

  const selectedStressorIds: string[] = [];
  const selectedResponseIds: string[] = [];
  const stressorKnobs: SandboxEngineRun['stressorKnobs'] = {};
  const mutationNotes: string[] = [];

  // ── Stressor synthesis ────────────────────────────────────────────────────
  const stressorDef = getStressorDef(stressorId);
  const sandboxStressorId = `${SANDBOX_STRESSOR_PREFIX}${stressorId}`;

  if (stressorId === 'layoff') {
    const severanceMonths = Math.max(0, Math.round(stressorKnobValue));
    const layoffDate = new Date(today.getFullYear(), today.getMonth(), 1);
    const stressor: Stressor = {
      id: 'layoff',
      name: stressorDef.label,
      type: 'layoff',
      salaryEndsEarly: true,
    };
    data.stressors = [...data.stressors, stressor];
    selectedStressorIds.push('layoff');
    stressorKnobs.layoffRetireDate = layoffDate.toISOString();
    stressorKnobs.layoffSeverance = Math.round(monthlySalary(data) * severanceMonths);
    mutationNotes.push(
      `Salary ends ${layoffDate.toISOString().slice(0, 7)} (engine stressor 'layoff'); ${severanceMonths}-month severance lump-sum added`,
    );
  } else if (stressorId === 'delayed_inheritance') {
    const years = Math.max(1, Math.round(stressorKnobValue));
    const stressor: Stressor = {
      id: 'delayed_inheritance',
      name: stressorDef.label,
      type: 'delayed_inheritance',
    };
    data.stressors = [...data.stressors, stressor];
    selectedStressorIds.push('delayed_inheritance');
    stressorKnobs.delayedInheritanceYears = years;
    mutationNotes.push(`Inheritance windfall pushed out ${years}yr (engine stressor)`);
  } else if (stressorId === 'long_term_care') {
    const years = Math.max(1, Math.round(stressorKnobValue));
    const existing = data.rules.ltcAssumptions;
    data.rules = {
      ...data.rules,
      ltcAssumptions: {
        enabled: true,
        startAge: existing?.startAge ?? 78,
        annualCostToday: existing?.annualCostToday ?? 100_000,
        durationYears: years,
        inflationAnnual: existing?.inflationAnnual ?? 0.03,
        // Force the event in this scenario — Sandbox is a "what if it
        // happens to us" room, not a probability sweep.
        eventProbability: 1,
      },
    };
    // No engine stressor — the LTC block in rules is what the engine reads.
    // We tag the synthetic id for diagnostics so it shows up in mutationNotes.
    void sandboxStressorId;
    mutationNotes.push(`LTC event forced ON: ${years}yr × $100k/yr starting age 78`);
  } else if (stressorId === 'inflation') {
    const extraPct = Math.max(0, stressorKnobValue) / 100;
    assumptions = {
      ...assumptions,
      inflation: assumptions.inflation + extraPct,
    };
    mutationNotes.push(
      `Inflation assumption ${(args.assumptions.inflation * 100).toFixed(1)}% → ${(assumptions.inflation * 100).toFixed(1)}%`,
    );
  } else if (stressorId === 'market_down') {
    const dropPct = Math.max(0, stressorKnobValue);
    data = applyEquityHaircut(data, dropPct);
    mutationNotes.push(
      `Equity-allocated balances reduced by ${dropPct.toFixed(0)}% × per-bucket equity weight (instant haircut)`,
    );
  }

  // ── Reaction synthesis ────────────────────────────────────────────────────
  for (const reaction of reactions) {
    const def = getReactionDef(reaction.id);
    if (reaction.id === 'cut_spending') {
      const pct = Math.max(0, Math.min(100, reaction.knobValue));
      const response: ResponseOption = {
        id: 'cut_spending',
        name: def.label,
        optionalReductionPercent: pct,
      };
      data.responses = [...data.responses, response];
      selectedResponseIds.push('cut_spending');
      stressorKnobs.cutSpendingPercent = pct;
      mutationNotes.push(`Optional spending cut ${pct}% (engine response)`);
    } else if (reaction.id === 'delay_retirement') {
      const years = Math.max(1, Math.round(reaction.knobValue));
      const response: ResponseOption = {
        id: 'delay_retirement',
        name: def.label,
        delayYears: years,
      };
      data.responses = [...data.responses, response];
      selectedResponseIds.push('delay_retirement');
      mutationNotes.push(`Salary end pushed +${years}yr (engine response)`);
    } else if (reaction.id === 'early_ss') {
      const response: ResponseOption = {
        id: 'early_ss',
        name: def.label,
        claimAge: 62,
      };
      data.responses = [...data.responses, response];
      selectedResponseIds.push('early_ss');
      mutationNotes.push(`Social Security claim age clamped to 62 (engine response)`);
    } else if (reaction.id === 'sell_home_early') {
      const yearsEarlier = Math.max(1, Math.round(reaction.knobValue));
      const response: ResponseOption = {
        id: 'sell_home_early',
        name: def.label,
        // Engine reads triggerYear as years-from-now offset (see applyResponses).
        triggerYear: yearsEarlier,
      };
      data.responses = [...data.responses, response];
      selectedResponseIds.push('sell_home_early');
      mutationNotes.push(`Home sale pulled forward to year +${yearsEarlier} (engine response)`);
    } else if (reaction.id === 'cut_travel') {
      // Permanent reduction of the early-retirement travel line. No engine
      // response covers travel directly, so we mutate the travel budget on
      // the SeedData clone. Essentials and discretionary stay untouched —
      // this is intentionally separate from cut_spending.
      const pct = Math.max(0, Math.min(100, reaction.knobValue));
      const before = data.spending.travelEarlyRetirementAnnual;
      const next = Math.max(0, Math.round(before * (1 - pct / 100)));
      data.spending = {
        ...data.spending,
        travelEarlyRetirementAnnual: next,
      };
      mutationNotes.push(
        `Travel budget cut ${pct}%: $${before.toLocaleString()} → $${next.toLocaleString()} (essentials untouched)`,
      );
    } else if (reaction.id === 'defer_travel') {
      // No first-class engine response. Approximate as a proportional
      // reduction of the early-retirement travel budget across the early
      // window: defer N of M years ⇒ multiply by (M-N)/M.
      const deferYears = Math.max(0, Math.round(reaction.knobValue));
      const earlyWindow = Math.max(1, assumptions.travelPhaseYears ?? 10);
      const scale = Math.max(0, (earlyWindow - deferYears) / earlyWindow);
      const before = data.spending.travelEarlyRetirementAnnual;
      data.spending = {
        ...data.spending,
        travelEarlyRetirementAnnual: Math.round(before * scale),
      };
      mutationNotes.push(
        `Early-retirement travel $${before.toLocaleString()} → $${data.spending.travelEarlyRetirementAnnual.toLocaleString()} (deferred ${deferYears}yr of ${earlyWindow}yr window)`,
      );
    }
  }

  void monthsUntilSalaryEnd; // reserved for future severance-sizing refinements

  return {
    data,
    assumptions,
    selectedStressorIds,
    selectedResponseIds,
    stressorKnobs,
    mutationNotes,
  };
}
