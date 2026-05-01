/**
 * Mortality assumptions — SSA period-life-table summaries used to
 * surface "what if one of us dies early" sensitivities in the Cockpit.
 *
 * Source: SSA period life table 2020 (most recent; published 2024).
 * For a person currently age N, the table gives the probability of
 * surviving to each future age. We summarize that as three age
 * percentiles per gender:
 *   - p10 (early): 10% of people this age die by this future age
 *   - p50 (median): 50% by this age
 *   - p90 (late): 90% by this age
 *
 * Coarse-grained because the Cockpit only needs three sensitivity
 * scenarios (early / median / late). Use the closest-current-age
 * row; intermediate ages aren't worth interpolating for V1.
 *
 * NOT used for the baseline projection — household plans to the
 * `planningEndAge` (95) by default. These life-table ages are for
 * the Cockpit's mortality-sensitivity sweep only.
 */

export type LifeTableSex = 'male' | 'female';

interface LifeTableRow {
  /** Current age. */
  currentAge: number;
  /** Age by which 10% of people this age have died (early-death case). */
  p10DeathAge: number;
  /** Median death age (50th percentile of survival from current age). */
  p50DeathAge: number;
  /** Age by which 90% of people this age have died (long-life case). */
  p90DeathAge: number;
}

/**
 * Sparse table of life expectancy quantiles by current age.
 * Approximate — source SSA period life table 2020. The actual table
 * uses single-year ages with q_x (probability of dying within the
 * year); the percentile death ages here are integrated from those.
 */
const LIFE_TABLE_MALE: Record<number, LifeTableRow> = {
  60: { currentAge: 60, p10DeathAge: 67, p50DeathAge: 82, p90DeathAge: 93 },
  62: { currentAge: 62, p10DeathAge: 69, p50DeathAge: 83, p90DeathAge: 93 },
  65: { currentAge: 65, p10DeathAge: 72, p50DeathAge: 84, p90DeathAge: 94 },
  70: { currentAge: 70, p10DeathAge: 76, p50DeathAge: 85, p90DeathAge: 94 },
  75: { currentAge: 75, p10DeathAge: 80, p50DeathAge: 86, p90DeathAge: 95 },
  80: { currentAge: 80, p10DeathAge: 84, p50DeathAge: 88, p90DeathAge: 96 },
};

const LIFE_TABLE_FEMALE: Record<number, LifeTableRow> = {
  60: { currentAge: 60, p10DeathAge: 70, p50DeathAge: 85, p90DeathAge: 96 },
  62: { currentAge: 62, p10DeathAge: 72, p50DeathAge: 86, p90DeathAge: 96 },
  65: { currentAge: 65, p10DeathAge: 75, p50DeathAge: 87, p90DeathAge: 96 },
  70: { currentAge: 70, p10DeathAge: 79, p50DeathAge: 87, p90DeathAge: 97 },
  75: { currentAge: 75, p10DeathAge: 82, p50DeathAge: 88, p90DeathAge: 97 },
  80: { currentAge: 80, p10DeathAge: 86, p50DeathAge: 90, p90DeathAge: 98 },
};

/**
 * Look up the closest-age life-table row for a given current age + sex.
 * Rounds DOWN to the nearest table entry (more conservative — older
 * percentile ages mean longer projected life, which understates the
 * "early death" sensitivity slightly; acceptable for a coarse signal).
 */
export function lifeTableRowFor(
  currentAge: number,
  sex: LifeTableSex,
): LifeTableRow {
  const table = sex === 'male' ? LIFE_TABLE_MALE : LIFE_TABLE_FEMALE;
  const ages = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  let chosen = ages[0];
  for (const a of ages) {
    if (a <= currentAge) chosen = a;
  }
  return table[chosen] ?? table[ages[0]];
}

/**
 * Compute current age from a birth date and an "as of" date. UTC
 * to avoid DST/timezone weirdness. Floors to whole years.
 */
export function currentAgeFromBirthDate(
  birthDateIso: string,
  asOf: Date = new Date(),
): number {
  const birth = new Date(birthDateIso);
  if (Number.isNaN(birth.getTime())) return 0;
  let age = asOf.getUTCFullYear() - birth.getUTCFullYear();
  const m = asOf.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && asOf.getUTCDate() < birth.getUTCDate())) age -= 1;
  return Math.max(0, age);
}
