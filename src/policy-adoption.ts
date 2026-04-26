/**
 * Policy Adoption — pure helpers for "make this mined policy my plan".
 *
 * The mining engine evaluates each policy by cloning the household's
 * SeedData and applying the policy's axes (spend target, SS claim ages,
 * Roth conversion ceiling) before running the simulation. Adoption is
 * the same operation, but durable: write the policy's axes into the
 * household's draft SeedData so subsequent Run Plan Analysis runs
 * reflect the adopted choice.
 *
 * Why a separate module from `policy-miner-eval.ts:applyPolicyToSeed`:
 *
 *   - The miner's helper MUTATES a clone (cheap, deliberate — it's on
 *     the hot path, ~8,748 calls per session). The store needs a PURE
 *     helper that returns a new object so React renders + zustand
 *     equality checks behave.
 *
 *   - The miner doesn't write spending categories — it passes
 *     `annualSpendTarget` directly to the engine each call. Adoption
 *     DOES need to write them, because the user's next interactive
 *     run reads the four `SpendingData` categories to compute total
 *     spend (no `annualSpendTarget` override is in play).
 *
 *   - Spending category scaling needs a deliberate policy choice (do
 *     we cut essentials? travel only? proportional?), and that
 *     decision belongs next to the rest of the adoption mapping, not
 *     buried in the miner.
 *
 * The chosen scaling: PROPORTIONAL across all four spending
 * categories. This matches what `buildPlan`'s runtime spend-target
 * scaler already does when an `annualSpendTarget` override is
 * supplied. Two reasons it's the right default:
 *
 *   1. Apples-to-apples with what the miner evaluated. The mined
 *      $130k policy was simulated by scaling all four categories
 *      proportionally to hit $130k; writing them back the same way
 *      preserves the result the user just decided to adopt.
 *
 *   2. No cross-category judgement call ("cut essentials" vs "cut
 *      travel"). The user retains full control to manually rebalance
 *      categories afterward — adoption is the starting point, not
 *      the final word.
 */

import type { Policy } from './policy-miner-types';
import type { SeedData, SpendingData } from './types';

export interface AdoptionDiffEntry {
  /** Stable key the modal uses to render rows. */
  key: 'spend' | 'primarySs' | 'spouseSs' | 'roth';
  /** Human-readable label. */
  label: string;
  /** Current value, formatted for display. Null = "not set". */
  currentLabel: string;
  /** New value, formatted for display. */
  proposedLabel: string;
  /** Whether the value actually changes. Used to gray out no-op rows. */
  changed: boolean;
}

export interface AdoptionDiff {
  /** Top-line summary used in the undo banner ("$130k · SS 70/68 · Roth $40k"). */
  summary: string;
  /** Per-axis diff rows for the modal table. */
  rows: AdoptionDiffEntry[];
  /** Per-category breakdown for the spending row's tooltip / sub-line. */
  spendingBreakdown: SpendingBreakdownEntry[];
  /** What the spend categories sum to today (today's $). */
  currentAnnualSpend: number;
  /** What the spend categories will sum to after adoption. */
  proposedAnnualSpend: number;
}

export interface SpendingBreakdownEntry {
  key: keyof Pick<
    SpendingData,
    | 'essentialMonthly'
    | 'optionalMonthly'
    | 'annualTaxesInsurance'
    | 'travelEarlyRetirementAnnual'
  >;
  label: string;
  /** Current value in its native cadence ($/mo for monthlies, $/yr for annuals). */
  current: number;
  /** Scaled value in the same cadence. */
  proposed: number;
  /** "$/mo" or "$/yr" — pre-formatted so the modal doesn't need to know which. */
  unit: '$/mo' | '$/yr';
}

/**
 * Sum of the four spending categories in today's dollars / year.
 * Mirrors `utils.ts:buildPlan`'s `baselineAnnualSpend` calculation —
 * keep these in sync or proportional scaling will drift.
 */
export function totalAnnualSpendFromCategories(spending: SpendingData): number {
  return (
    (spending.essentialMonthly ?? 0) * 12 +
    (spending.optionalMonthly ?? 0) * 12 +
    (spending.annualTaxesInsurance ?? 0) +
    (spending.travelEarlyRetirementAnnual ?? 0)
  );
}

/**
 * Scale the four spending categories proportionally so their sum
 * equals `targetAnnual`. Returns a new SpendingData; doesn't mutate.
 *
 * Edge case: if the current total is 0 (or non-finite), we can't
 * scale — return the input unchanged. The caller is responsible for
 * surfacing "can't adopt: spending is unset" if it cares.
 */
function scaleSpendingProportional(
  spending: SpendingData,
  targetAnnual: number,
): SpendingData {
  const currentTotal = totalAnnualSpendFromCategories(spending);
  if (!Number.isFinite(currentTotal) || currentTotal <= 0) return spending;
  const multiplier = targetAnnual / currentTotal;
  // Round to whole dollars on the unit each category is stored in (monthly
  // for monthlies, annual for annuals). Avoids fractional-cent drift in the
  // UI; the engine doesn't care about $1 rounding.
  return {
    ...spending,
    essentialMonthly: Math.round(spending.essentialMonthly * multiplier),
    optionalMonthly: Math.round(spending.optionalMonthly * multiplier),
    annualTaxesInsurance: Math.round(spending.annualTaxesInsurance * multiplier),
    travelEarlyRetirementAnnual: Math.round(
      spending.travelEarlyRetirementAnnual * multiplier,
    ),
  };
}

/**
 * Build the adopted SeedData from a current SeedData + a mined policy.
 * Pure: returns a new top-level object with new sub-objects for the
 * branches that change (spending, income, rules). Other branches are
 * shared by reference — accounts, goals, etc. — so a downstream
 * shallow-equality check (zustand, useMemo) can short-circuit.
 *
 * What gets written:
 *   - `spending.{essentialMonthly, optionalMonthly,
 *      annualTaxesInsurance, travelEarlyRetirementAnnual}`: scaled
 *      proportionally so sum = `policy.annualSpendTodayDollars`.
 *   - `income.socialSecurity[0].claimAge`: primary's claim age.
 *   - `income.socialSecurity[1].claimAge`: spouse's claim age (if
 *      household has a spouse and the policy specifies one).
 *   - `rules.rothConversionPolicy.{enabled, minAnnualDollars,
 *      magiBufferDollars}`: matches `applyPolicyToSeed` so the
 *      adopted plan behaves identically to what the miner simulated.
 */
export function buildAdoptedSeedData(seed: SeedData, policy: Policy): SeedData {
  const next: SeedData = { ...seed };

  // Spending: scale categories proportionally to hit policy target.
  next.spending = scaleSpendingProportional(
    seed.spending,
    policy.annualSpendTodayDollars,
  );

  // Social Security: write claim ages for primary (and spouse if both
  // exist in the household and the policy supplies one).
  const ssCurrent = seed.income?.socialSecurity ?? [];
  if (ssCurrent.length > 0) {
    const ssNext = ssCurrent.map((claim, i) => {
      if (i === 0) {
        return { ...claim, claimAge: policy.primarySocialSecurityClaimAge };
      }
      if (i === 1 && policy.spouseSocialSecurityClaimAge != null) {
        return { ...claim, claimAge: policy.spouseSocialSecurityClaimAge };
      }
      return claim;
    });
    next.income = { ...seed.income, socialSecurity: ssNext };
  }

  // Roth conversion: same convention as the miner's `applyPolicyToSeed`
  // — `magiBufferDollars` proxies for the per-year ceiling. V1.1 of the
  // engine is expected to introduce a real per-year cap field; when
  // that lands, this mapping needs to follow.
  if (seed.rules) {
    next.rules = {
      ...seed.rules,
      rothConversionPolicy: {
        ...(seed.rules.rothConversionPolicy ?? {}),
        enabled: policy.rothConversionAnnualCeiling > 0,
        minAnnualDollars: 0,
        magiBufferDollars: policy.rothConversionAnnualCeiling,
      },
    };
  }

  return next;
}

function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(0)}k`;
  return `$${Math.round(amount)}`;
}

function formatDollars(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return `$${Math.round(amount).toLocaleString()}`;
}

/**
 * Compute the diff a UI surface (modal, undo banner, log) needs to show
 * the user what `buildAdoptedSeedData` will change. Pure derivation
 * from current SeedData + policy — no React, no DOM.
 */
export function diffAdoption(seed: SeedData, policy: Policy): AdoptionDiff {
  const currentAnnualSpend = totalAnnualSpendFromCategories(seed.spending);
  const proposedAnnualSpend = policy.annualSpendTodayDollars;

  const currentPrimarySs = seed.income?.socialSecurity?.[0]?.claimAge ?? null;
  const currentSpouseSs = seed.income?.socialSecurity?.[1]?.claimAge ?? null;
  const currentRothCeiling =
    seed.rules?.rothConversionPolicy?.magiBufferDollars ?? 0;

  const hasSpouse = (seed.income?.socialSecurity?.length ?? 0) >= 2;

  const rows: AdoptionDiffEntry[] = [
    {
      key: 'spend',
      label: 'Annual spend (today $)',
      currentLabel: formatCurrency(currentAnnualSpend),
      proposedLabel: formatCurrency(proposedAnnualSpend),
      changed:
        Math.round(currentAnnualSpend) !== Math.round(proposedAnnualSpend),
    },
    {
      key: 'primarySs',
      label: 'Primary SS claim age',
      currentLabel: currentPrimarySs == null ? '—' : `${currentPrimarySs}`,
      proposedLabel: `${policy.primarySocialSecurityClaimAge}`,
      changed: currentPrimarySs !== policy.primarySocialSecurityClaimAge,
    },
  ];

  if (hasSpouse) {
    rows.push({
      key: 'spouseSs',
      label: 'Spouse SS claim age',
      currentLabel: currentSpouseSs == null ? '—' : `${currentSpouseSs}`,
      proposedLabel:
        policy.spouseSocialSecurityClaimAge == null
          ? currentSpouseSs == null
            ? '—'
            : `${currentSpouseSs}`
          : `${policy.spouseSocialSecurityClaimAge}`,
      changed:
        policy.spouseSocialSecurityClaimAge != null &&
        currentSpouseSs !== policy.spouseSocialSecurityClaimAge,
    });
  }

  rows.push({
    key: 'roth',
    label: 'Roth conversion ceiling',
    currentLabel: formatCurrency(currentRothCeiling),
    proposedLabel: formatCurrency(policy.rothConversionAnnualCeiling),
    changed:
      Math.round(currentRothCeiling) !==
      Math.round(policy.rothConversionAnnualCeiling),
  });

  // Spending breakdown: scaled values for the modal sub-line.
  const scaled = scaleSpendingProportional(seed.spending, proposedAnnualSpend);
  const spendingBreakdown: SpendingBreakdownEntry[] = [
    {
      key: 'essentialMonthly',
      label: 'Essentials',
      current: seed.spending.essentialMonthly,
      proposed: scaled.essentialMonthly,
      unit: '$/mo',
    },
    {
      key: 'optionalMonthly',
      label: 'Optional',
      current: seed.spending.optionalMonthly,
      proposed: scaled.optionalMonthly,
      unit: '$/mo',
    },
    {
      key: 'annualTaxesInsurance',
      label: 'Taxes & insurance',
      current: seed.spending.annualTaxesInsurance,
      proposed: scaled.annualTaxesInsurance,
      unit: '$/yr',
    },
    {
      key: 'travelEarlyRetirementAnnual',
      label: 'Travel (early retirement)',
      current: seed.spending.travelEarlyRetirementAnnual,
      proposed: scaled.travelEarlyRetirementAnnual,
      unit: '$/yr',
    },
  ];

  // Build the one-line summary for the undo banner.
  const summaryParts: string[] = [
    `${formatCurrency(proposedAnnualSpend)}/yr`,
    `SS ${policy.primarySocialSecurityClaimAge}${
      policy.spouseSocialSecurityClaimAge != null && hasSpouse
        ? `/${policy.spouseSocialSecurityClaimAge}`
        : ''
    }`,
    `Roth ${formatCurrency(policy.rothConversionAnnualCeiling)}`,
  ];

  return {
    summary: summaryParts.join(' · '),
    rows,
    spendingBreakdown,
    currentAnnualSpend,
    proposedAnnualSpend,
  };
}

/**
 * Convenience: format a spending breakdown row's current/proposed pair
 * for the modal's tooltip line. Re-exported so the UI doesn't have to
 * own the dollar-formatting convention.
 */
export function formatBreakdownEntry(entry: SpendingBreakdownEntry): string {
  return `${entry.label} ${formatDollars(entry.current)}${entry.unit} → ${formatDollars(entry.proposed)}${entry.unit}`;
}
