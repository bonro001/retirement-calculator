/**
 * Social Security benefit math — the pieces the basic engine and the
 * SS optimizer share.
 *
 * What's modeled:
 *   1. **Own-claim adjustment** — applies the actual SSA formulas for
 *      claiming early (5/9 of 1% per month for first 36 months, 5/12
 *      of 1% per month thereafter — capped at 36 months early which
 *      stops at 25% reduction for FRA 67) or late (8% per year up to
 *      age 70).
 *   2. **Spousal benefit floor** — lower-earner spouse can claim up
 *      to 50% of higher earner's PIA (FRA monthly), reduced if the
 *      LOWER earner claims early. Engine reports
 *      `max(ownAdjustedBenefit, spousalAdjustedFloor)`.
 *   3. **Survivor switch** — when the higher earner dies, the
 *      surviving spouse's benefit converts to 100% of the deceased
 *      higher earner's claim amount (subject to the surviving
 *      spouse's age >= 60). This is the single biggest reason to
 *      delay the higher earner's claim — survivor benefit is
 *      preserved.
 *
 * What's NOT modeled (V1 simplifications):
 *   - Government Pension Offset / Windfall Elimination (rare; not on
 *     the target household's radar).
 *   - File-and-suspend (deprecated post-2015 reform).
 *   - Claim-and-restart (complex, vanishingly small impact).
 *   - Stochastic mortality — V1 takes a deterministic
 *     `assumedDeathAge` per spouse. The Cockpit can sweep this for
 *     sensitivity; the engine integration (when it comes) can layer
 *     a mortality distribution on top.
 *
 * Units: all monthly amounts are NOMINAL today's $ (the seed's
 * `fraMonthly` is "your projected FRA benefit if you claimed today
 * in today's dollars"). For projections beyond today, callers
 * compound by the COLA assumption (typically equal to inflation;
 * SSA COLA tracks CPI-W).
 */

export interface SocialSecurityEarner {
  /** Display name (Rob, Debbie, …) — used for diagnostics. */
  person: string;
  /** Monthly benefit at full retirement age in today's dollars
   *  (the household's projected SSA statement value). */
  fraMonthly: number;
  /** When this earner files for benefits (62..70). */
  claimAge: number;
  /** Year of birth — needed so `claimAge` can be mapped to a calendar
   *  year for the per-year benefit projection. */
  birthYear: number;
  /** Assumed death age. V1 takes this as deterministic. Pass the
   *  household's planning end age (typically 95) for "max longevity"
   *  cases; sweep lower values for sensitivity. */
  assumedDeathAge: number;
}

export interface AnnualSocialSecurityIncome {
  /** The calendar year this entry applies to. */
  year: number;
  /** Per-earner monthly benefit at this year (NOMINAL today's $).
   *  When an earner is dead, their slot is 0; the surviving
   *  spouse's slot may be elevated by the survivor switch. */
  perEarnerMonthly: Record<string, number>;
  /** Total household monthly SS income this year. */
  householdMonthly: number;
  /** Sum × 12. Useful for callers that want annual right away. */
  householdAnnual: number;
  /** Diagnostic: which earners' benefits are active in this year. */
  activeEarners: string[];
}

/**
 * SSA early-claim reduction factor, relative to FRA monthly.
 * Formula: 5/9 of 1% per month for first 36 months early, then 5/12
 * of 1% per month for additional months. Cap is at 60 months early
 * (claiming at 62 with FRA 67 → 30% reduction).
 *
 * Returns 1.0 at FRA, < 1 below FRA.
 */
function earlyClaimFactor(fraAge: number, claimAge: number): number {
  const monthsEarly = Math.max(0, (fraAge - claimAge) * 12);
  if (monthsEarly === 0) return 1;
  const tier1 = Math.min(36, monthsEarly);
  const tier2 = Math.max(0, monthsEarly - 36);
  const reduction = (tier1 * 5) / 900 + (tier2 * 5) / 1200;
  return 1 - reduction;
}

/**
 * SSA delayed-retirement-credit factor, relative to FRA monthly.
 * Formula: 8% per year past FRA, capped at age 70 (no DRC accrues
 * after 70 even if you delay further).
 *
 * Returns 1.0 at FRA, > 1 above FRA up to 1.32 at age 70 with FRA 65,
 * 1.24 at age 70 with FRA 67.
 */
function delayedRetirementCreditFactor(
  fraAge: number,
  claimAge: number,
): number {
  if (claimAge <= fraAge) return 1;
  const yearsLate = Math.min(claimAge, 70) - fraAge;
  return 1 + 0.08 * yearsLate;
}

/**
 * Combined own-claim adjustment factor — early reduction OR delayed
 * retirement credit, depending on `claimAge` vs `fraAge`.
 */
export function ownClaimAdjustmentFactor(
  fraAge: number,
  claimAge: number,
): number {
  if (claimAge < fraAge) return earlyClaimFactor(fraAge, claimAge);
  if (claimAge > fraAge) return delayedRetirementCreditFactor(fraAge, claimAge);
  return 1;
}

/**
 * Compute the own-benefit monthly amount at claim age for a single
 * earner. Independent of any spouse considerations.
 */
export function ownAdjustedMonthlyBenefit(
  earner: SocialSecurityEarner,
  fraAge: number,
): number {
  return earner.fraMonthly * ownClaimAdjustmentFactor(fraAge, earner.claimAge);
}

/**
 * Spousal benefit floor: lower earner can claim up to 50% of higher
 * earner's PIA (FRA monthly). Reduced if the LOWER earner claims early
 * (using the spousal-reduction schedule, slightly different from own).
 *
 * For V1 we approximate the spousal-reduction schedule with the same
 * early-claim factor as own benefit; SSA's actual schedule is 25/36 of
 * 1% per month for first 36 months, then 5/12 of 1% per month
 * thereafter — slightly steeper than own-benefit but within ~1pp at
 * common claim ages, well inside the noise of any household plan.
 *
 * Spousal benefits do NOT receive delayed retirement credits (a key
 * gotcha). So claiming spousal AFTER FRA does not increase the floor
 * past 50% of the higher earner's PIA.
 */
export function spousalBenefitFloor(
  lowerEarner: SocialSecurityEarner,
  higherEarner: SocialSecurityEarner,
  fraAge: number,
): number {
  const baseSpousal = higherEarner.fraMonthly * 0.5;
  // Spousal benefit reduction if lower earner claims early.
  // No DRC for claims past FRA.
  if (lowerEarner.claimAge < fraAge) {
    return baseSpousal * earlyClaimFactor(fraAge, lowerEarner.claimAge);
  }
  return baseSpousal;
}

/**
 * Effective monthly benefit for an earner who has already filed,
 * given whether their spouse has also filed.
 *
 * SSA rule: spousal benefits only begin AFTER the worker (the
 * higher-earning spouse) files. So the spousal floor only applies
 * when both spouses have filed. Before the spouse files, the lower
 * earner gets only their own benefit.
 *
 * Worked example (Rob FRA $4,100, Debbie FRA $1,444):
 *   - Debbie files 67, Rob delays to 70:
 *     - Debbie ages 67-69: own only = $1,444 (Rob hasn't filed)
 *     - Debbie age 70+: max($1,444 own, 0.5 × $4,100 = $2,050 spousal) = $2,050
 *   - Both file at 67:
 *     - Both ages 67+: Debbie gets max($1,444, $2,050) = $2,050
 *
 * Higher earner (or equal): always own benefit; spousal floor is for
 * the lower earner only.
 */
export function effectiveMonthlyBenefit(
  earner: SocialSecurityEarner,
  spouse: SocialSecurityEarner | null,
  fraAge: number,
  spouseHasFiled = true,
): number {
  const own = ownAdjustedMonthlyBenefit(earner, fraAge);
  if (!spouse) return own;
  if (spouse.fraMonthly <= earner.fraMonthly) {
    // This earner is the higher (or equal) earner — no spousal floor.
    return own;
  }
  if (!spouseHasFiled) {
    // Lower earner, but spouse hasn't filed yet → no spousal benefit
    // available. Own benefit only.
    return own;
  }
  const floor = spousalBenefitFloor(earner, spouse, fraAge);
  return Math.max(own, floor);
}

/**
 * Project per-year SS income for the household across the planning
 * window. Handles:
 *   - Each earner starts collecting at their claim age (and not before)
 *   - Each earner stops collecting on `assumedDeathAge`
 *   - Survivor switch: when higher earner dies, surviving spouse
 *     converts to 100% of the higher earner's claim amount
 *
 * COLA: amounts are returned in TODAY'S dollars assuming COLA equals
 * inflation (the standard simplification). Engines that want nominal
 * dollars should compound by their inflation assumption.
 */
export function projectAnnualSocialSecurityIncome(
  earner1: SocialSecurityEarner,
  earner2: SocialSecurityEarner | null,
  startYear: number,
  endYear: number,
  fraAge = 67,
): AnnualSocialSecurityIncome[] {
  // Identify the higher earner for survivor-switch logic. Tie → earner1.
  const higherEarnerName =
    earner2 && earner2.fraMonthly > earner1.fraMonthly ? earner2.person : earner1.person;
  // Higher earner's own claim-age-adjusted benefit (no spousal floor
  // applies to them) — what the survivor switches to.
  const higherEarnerOwn =
    higherEarnerName === earner1.person
      ? ownAdjustedMonthlyBenefit(earner1, fraAge)
      : earner2
        ? ownAdjustedMonthlyBenefit(earner2, fraAge)
        : 0;

  // Partial-year-of-claim support. Real SSA claiming is monthly; a
  // claim age of 67.5 means payments start 6 months into the year of
  // the 67th birthday. The pre-fix integer-year check rounded the
  // start UP, making fractional claim ages strictly dominated by the
  // next integer (same payment timing, lower benefit factor) — useless
  // to the optimizer when sweeping a 6-month axis. For integer claim
  // ages this returns 12, preserving end-to-end behavior.
  const claimMonthsThisYear = (claimAge: number, ageThisYear: number) => {
    const floor = Math.floor(claimAge);
    if (ageThisYear < floor) return 0;
    if (ageThisYear > floor) return 12;
    return Math.max(0, Math.round((1 - (claimAge - floor)) * 12));
  };

  const result: AnnualSocialSecurityIncome[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    const e1Age = year - earner1.birthYear;
    const e2Age = earner2 ? year - earner2.birthYear : 0;
    const e1Alive = e1Age <= earner1.assumedDeathAge;
    const e2Alive = earner2 ? e2Age <= earner2.assumedDeathAge : false;
    const e1MonthsThisYear = claimMonthsThisYear(earner1.claimAge, e1Age);
    const e2MonthsThisYear = earner2
      ? claimMonthsThisYear(earner2.claimAge, e2Age)
      : 0;
    const e1Claimed = e1MonthsThisYear > 0;
    const e2Claimed = earner2 ? e2MonthsThisYear > 0 : false;

    // Per-year effective benefit accounts for whether the SPOUSE has
    // also filed — spousal floor only kicks in once the higher earner
    // has claimed. Before that, the lower earner gets only own benefit.
    const e1Monthly =
      e1Alive && e1Claimed
        ? effectiveMonthlyBenefit(earner1, earner2, fraAge, e2Claimed)
        : 0;
    let e2Monthly =
      earner2 && e2Alive && e2Claimed
        ? effectiveMonthlyBenefit(earner2, earner1, fraAge, e1Claimed)
        : 0;
    let e1MonthlyFinal = e1Monthly;
    // Track months-paid separately so the survivor switch can override
    // a 0-months count when the surviving spouse hadn't yet claimed
    // their own benefit. SSA pays survivor benefit regardless of the
    // surviving spouse's own claim status.
    let e1PaidMonths = e1Alive ? e1MonthsThisYear : 0;
    let e2PaidMonths = earner2 && e2Alive ? e2MonthsThisYear : 0;

    // Survivor switch: when the higher earner dies, surviving spouse
    // jumps to 100% of higher earner's claim amount (if surviving
    // spouse is at least 60). The survivor benefit is the higher
    // earner's OWN claim amount, not the spousal floor.
    if (earner2) {
      if (higherEarnerName === earner1.person && !e1Alive && e2Alive && e2Age >= 60) {
        e2Monthly = Math.max(e2Monthly, higherEarnerOwn);
        e2PaidMonths = 12;
      } else if (
        higherEarnerName === earner2.person &&
        !e2Alive &&
        e1Alive &&
        e1Age >= 60
      ) {
        e1MonthlyFinal = Math.max(e1MonthlyFinal, higherEarnerOwn);
        e1PaidMonths = 12;
      }
    }

    const perEarnerMonthly: Record<string, number> = {
      [earner1.person]: e1MonthlyFinal,
    };
    if (earner2) perEarnerMonthly[earner2.person] = e2Monthly;
    const householdMonthly = e1MonthlyFinal + e2Monthly;
    const householdAnnual =
      e1MonthlyFinal * e1PaidMonths + e2Monthly * e2PaidMonths;
    const activeEarners: string[] = [];
    if (e1MonthlyFinal > 0) activeEarners.push(earner1.person);
    if (earner2 && e2Monthly > 0) activeEarners.push(earner2.person);

    result.push({
      year,
      perEarnerMonthly,
      householdMonthly,
      householdAnnual,
      activeEarners,
    });
  }
  return result;
}

/**
 * Sum the per-year household SS income from the projection in TODAY'S
 * dollars. With COLA == inflation, each year's projection is already
 * in today's $; sum directly.
 */
export function totalLifetimeSocialSecurityTodayDollars(
  schedule: AnnualSocialSecurityIncome[],
): number {
  return schedule.reduce((acc, row) => acc + row.householdAnnual, 0);
}

/**
 * Compute household SS income for a SINGLE year. Optimized for the
 * engine's per-year iteration loop — avoids projecting a full schedule
 * just to grab one row.
 *
 * @returns combined household ANNUAL nominal SS income (today's $;
 *   caller multiplies by inflationIndex for nominal-future scaling).
 *
 * Both earners pass `currentAge` for this year. Optional `assumedDeathAge`
 * per earner triggers the survivor switch: when one spouse is past
 * their death age, their slot pays 0; the surviving spouse (if at
 * least 60) jumps to 100% of the deceased spouse's claim amount
 * (subject to having filed themselves).
 *
 * The function:
 *   - Skips earners who haven't claimed yet (currentAge < claimAge)
 *   - Computes own benefit with claim-age adjustment
 *   - Adds spousal floor when applicable AND the spouse has also filed
 *   - Caps at the higher of own / spousal (SSA's deemed-filing rule)
 *   - Applies survivor switch when one spouse is past assumedDeathAge
 */
export function computeAnnualHouseholdSocialSecurity(
  earner1: {
    fraMonthly: number;
    claimAge: number;
    currentAge: number;
    /** Optional. When set and `currentAge > assumedDeathAge`, this
     *  earner is treated as deceased — slot pays 0, and surviving
     *  spouse may benefit from the survivor switch. */
    assumedDeathAge?: number;
  },
  earner2: {
    fraMonthly: number;
    claimAge: number;
    currentAge: number;
    assumedDeathAge?: number;
  } | null,
  fraAge = 67,
): number {
  const e1Alive =
    earner1.assumedDeathAge === undefined ||
    earner1.currentAge <= earner1.assumedDeathAge;
  const e2Alive =
    !earner2 ||
    earner2.assumedDeathAge === undefined ||
    earner2.currentAge <= earner2.assumedDeathAge;

  const e1Filed = e1Alive && earner1.currentAge >= earner1.claimAge;
  const e2Filed = !!earner2 && e2Alive && earner2.currentAge >= earner2.claimAge;

  const own = (e: { fraMonthly: number; claimAge: number }) =>
    e.fraMonthly * ownClaimAdjustmentFactor(fraAge, e.claimAge);

  const e1Own = e1Filed ? own(earner1) : 0;
  const e2Own = earner2 && e2Filed ? own(earner2) : 0;

  // Spousal floor: lower earner's effective benefit gets bumped to
  // 50% of higher earner's PIA (no DRC for spousal). Only applies
  // when both are alive AND have filed.
  let e1Effective = e1Own;
  let e2Effective = e2Own;
  if (earner1 && earner2 && e1Filed && e2Filed) {
    if (earner1.fraMonthly < earner2.fraMonthly) {
      const floor = earner2.fraMonthly * 0.5;
      const adjusted =
        earner1.claimAge < fraAge
          ? floor * ownClaimAdjustmentFactor(fraAge, earner1.claimAge)
          : floor;
      e1Effective = Math.max(e1Own, adjusted);
    } else if (earner2.fraMonthly < earner1.fraMonthly) {
      const floor = earner1.fraMonthly * 0.5;
      const adjusted =
        earner2.claimAge < fraAge
          ? floor * ownClaimAdjustmentFactor(fraAge, earner2.claimAge)
          : floor;
      e2Effective = Math.max(e2Own, adjusted);
    }
  }

  // Survivor switch: when the higher earner is dead, the surviving
  // spouse's benefit jumps to 100% of the higher earner's CLAIM
  // amount (own benefit at claim age, not the spousal floor). Subject
  // to the surviving spouse being at least 60 (an SSA gate; rarely
  // binds in retirement plans).
  if (earner1 && earner2) {
    const higherIsE1 = earner1.fraMonthly >= earner2.fraMonthly;
    if (higherIsE1 && !e1Alive && e2Alive && earner2.currentAge >= 60) {
      // earner1 dead, earner2 (lower earner) survives.
      const survivorBenefit = own(earner1);
      e2Effective = Math.max(e2Effective, survivorBenefit);
    } else if (!higherIsE1 && !e2Alive && e1Alive && earner1.currentAge >= 60) {
      const survivorBenefit = own(earner2);
      e1Effective = Math.max(e1Effective, survivorBenefit);
    }
  }

  return (e1Effective + e2Effective) * 12;
}
