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
  const scaled = {
    ...spending,
    essentialMonthly: Math.round(spending.essentialMonthly * multiplier),
    optionalMonthly: Math.round(spending.optionalMonthly * multiplier),
    annualTaxesInsurance: Math.round(spending.annualTaxesInsurance * multiplier),
    travelEarlyRetirementAnnual: Math.round(
      spending.travelEarlyRetirementAnnual * multiplier,
    ),
  };
  const drift = targetAnnual - totalAnnualSpendFromCategories(scaled);
  if (!Number.isFinite(drift) || Math.abs(drift) < 0.005) return scaled;

  // Monthly buckets annualize in $12 jumps after rounding. Reconcile the
  // tiny residual into an annual bucket so the adopted plan totals exactly
  // to the mined policy target instead of surfacing as a false stale-plan
  // warning in Cockpit.
  if (scaled.travelEarlyRetirementAnnual + drift >= 0) {
    return {
      ...scaled,
      travelEarlyRetirementAnnual: scaled.travelEarlyRetirementAnnual + drift,
    };
  }
  if (scaled.annualTaxesInsurance + drift >= 0) {
    return {
      ...scaled,
      annualTaxesInsurance: scaled.annualTaxesInsurance + drift,
    };
  }
  return {
    ...scaled,
    optionalMonthly: scaled.optionalMonthly + drift / 12,
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

// ---------------------------------------------------------------------------
// Plain-English explanation
// ---------------------------------------------------------------------------

/**
 * Narrative produced by `explainAdoption` for the post-adoption banner.
 *
 * Three slots so the UI can format them with hierarchy (headline bold,
 * detail regular, feasibility quieter) without having to parse a single
 * string. All three are pre-composed sentences ending in periods —
 * concatenate with a space to render flat.
 */
export interface AdoptionExplanation {
  /** What this adoption does at the top line — spend delta, mostly. */
  headline: string;
  /**
   * One sentence on the most consequential lever and *why* it pays off.
   * Null when the only change is the spend target itself (rare — would
   * mean an identity adoption with a different total).
   */
  detail: string | null;
  /**
   * Optional feasibility footnote when an evaluation is supplied. Null
   * when no evaluation is passed (corpus lookup miss, or caller didn't
   * have one to hand).
   */
  feasibilityNote: string | null;
}

interface LeverChange {
  kind: 'primarySs' | 'spouseSs' | 'roth';
  /** Sortable importance score; higher = bigger story to tell. */
  weight: number;
  sentence: string;
}

/**
 * Build a 1-3 sentence household-readable explanation of WHY the
 * adopted policy is the pick. Pure derivation from previous SeedData +
 * adopted Policy + (optionally) the policy's evaluation outcome.
 *
 * Why not just stop at the diff rows: the modal already shows what
 * changed in numbers. The narrative tells the user what the change is
 * *for* — "delaying SS to 70 trades smaller checks early for ~24%
 * larger checks for life, which is what funds the higher spend." A
 * household reading the table sees four numbers; reading this they see
 * a thesis they can agree or disagree with.
 *
 * Honesty constraints:
 *   - Headline numbers come straight from the diff. No invented values.
 *   - The "biggest lever" is picked by a transparent weight (years of
 *     SS delay × per-year benefit growth, or |Roth delta|), not by a
 *     hidden marginal-impact model. We don't claim to have run a
 *     counterfactual we didn't run.
 *   - Causal phrasing is reserved for textbook mechanisms (SS delay
 *     credit, Roth-vs-RMD/IRMAA tradeoff). No editorializing.
 */
export function explainAdoption(
  previousData: SeedData,
  policy: Policy,
  evaluation?: { bequestAttainmentRate: number } | null,
): AdoptionExplanation {
  const diff = diffAdoption(previousData, policy);
  const spendDelta = diff.proposedAnnualSpend - diff.currentAnnualSpend;

  // ---- Headline ---------------------------------------------------------
  let headline: string;
  if (Math.abs(spendDelta) < 500) {
    // Within rounding of the current spend — the adoption preserved
    // spend and only moved structural levers. Frame it accordingly so
    // the user doesn't expect a different chart in dollar terms.
    headline = `Holds annual spend at ${formatCurrency(diff.proposedAnnualSpend)} while restructuring claim ages and conversions.`;
  } else if (spendDelta > 0) {
    headline = `Lifts annual spend from ${formatCurrency(diff.currentAnnualSpend)} to ${formatCurrency(diff.proposedAnnualSpend)} (+${formatCurrency(spendDelta)}/yr in today's dollars).`;
  } else {
    headline = `Trims annual spend from ${formatCurrency(diff.currentAnnualSpend)} to ${formatCurrency(diff.proposedAnnualSpend)} (${formatCurrency(spendDelta)}/yr) to restore feasibility.`;
  }

  // ---- Detail: pick the heaviest changed lever --------------------------
  const currentPrimarySs = previousData.income?.socialSecurity?.[0]?.claimAge ?? null;
  const currentSpouseSs = previousData.income?.socialSecurity?.[1]?.claimAge ?? null;
  const hasSpouse = (previousData.income?.socialSecurity?.length ?? 0) >= 2;
  const currentRothCeiling =
    previousData.rules?.rothConversionPolicy?.magiBufferDollars ?? 0;

  const candidates: LeverChange[] = [];

  if (
    currentPrimarySs !== null &&
    currentPrimarySs !== policy.primarySocialSecurityClaimAge
  ) {
    const yearsDelta = policy.primarySocialSecurityClaimAge - currentPrimarySs;
    candidates.push({
      kind: 'primarySs',
      // Per-year SS growth past FRA is ~8%; before FRA the actuarial
      // adjustment is ~6-7%. Use 8 as the lever weight — it's the
      // upper bound and the lever's dominance over Roth still holds.
      weight: Math.abs(yearsDelta) * 8,
      sentence: ssDelaySentence('primary', currentPrimarySs, policy.primarySocialSecurityClaimAge),
    });
  }

  if (
    hasSpouse &&
    policy.spouseSocialSecurityClaimAge !== null &&
    currentSpouseSs !== null &&
    currentSpouseSs !== policy.spouseSocialSecurityClaimAge
  ) {
    const yearsDelta = policy.spouseSocialSecurityClaimAge - currentSpouseSs;
    candidates.push({
      kind: 'spouseSs',
      // Spouse benefits are typically smaller in absolute terms — about
      // half the household weight of the primary delay, on average.
      weight: Math.abs(yearsDelta) * 4,
      sentence: ssDelaySentence(
        'spouse',
        currentSpouseSs,
        policy.spouseSocialSecurityClaimAge,
      ),
    });
  }

  const rothDelta = policy.rothConversionAnnualCeiling - currentRothCeiling;
  if (Math.abs(rothDelta) >= 5_000) {
    candidates.push({
      kind: 'roth',
      // $10k of Roth-ceiling change ≈ one year of SS delay in long-run
      // tax savings — this is a rough heuristic, but keeps the ranking
      // honest without overclaiming a precise comparison.
      weight: Math.abs(rothDelta) / 1_250,
      sentence: rothSentence(currentRothCeiling, policy.rothConversionAnnualCeiling),
    });
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const detail = candidates.length > 0 ? candidates[0].sentence : null;

  // ---- Feasibility note (optional) --------------------------------------
  let feasibilityNote: string | null = null;
  if (evaluation && Number.isFinite(evaluation.bequestAttainmentRate)) {
    const pct = Math.round(evaluation.bequestAttainmentRate * 100);
    if (pct >= 95) {
      feasibilityNote = `Bequest target met in ${pct}% of trials — comfortable headroom.`;
    } else if (pct >= 85) {
      feasibilityNote = `Bequest target met in ${pct}% of trials — solidly above the 85% feasibility threshold.`;
    } else {
      feasibilityNote = `Bequest target met in ${pct}% of trials — at the edge of feasibility; consider running a stress test.`;
    }
  }

  return { headline, detail, feasibilityNote };
}

function ssDelaySentence(
  who: 'primary' | 'spouse',
  fromAge: number,
  toAge: number,
): string {
  const label = who === 'primary' ? 'primary' : 'spouse';
  if (toAge > fromAge) {
    const years = toAge - fromAge;
    const yearLabel = years === 1 ? 'year' : 'years';
    return `The biggest lever is delaying ${label} Social Security from ${fromAge} to ${toAge} — each ${yearLabel.replace('s', '')} past full retirement age grows the lifetime benefit by roughly 8%, so the larger checks help carry the higher spend.`;
  }
  return `The biggest lever is filing ${label} Social Security earlier — from ${fromAge} to ${toAge} — which puts cash in hand sooner and lets the portfolio stay invested longer.`;
}

function rothSentence(fromCeiling: number, toCeiling: number): string {
  if (toCeiling > fromCeiling) {
    return `The biggest lever is raising the Roth conversion ceiling from ${formatCurrency(fromCeiling)} to ${formatCurrency(toCeiling)} — more dollars move into tax-free growth before RMDs and IRMAA brackets bite.`;
  }
  return `The biggest lever is lowering the Roth conversion ceiling from ${formatCurrency(fromCeiling)} to ${formatCurrency(toCeiling)} — smaller conversions keep MAGI down and avoid triggering IRMAA brackets in the years ahead.`;
}
