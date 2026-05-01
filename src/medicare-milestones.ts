import type { SeedData } from './types';

/**
 * Medicare enrollment milestones + HSA contribution lookback check.
 *
 * Why this exists: Medicare's Initial Enrollment Period (IEP) is a
 * hard 7-month window bracketing the 65th birthday — 3 months before,
 * the birthday month, and 3 months after. Missing it triggers a
 * permanent Part B premium penalty (10% per year of delay) plus
 * coverage gaps and Medigap-underwriting risk. The Cockpit should
 * surface a milestone reminder as the household crosses into and
 * through this window.
 *
 * Adjacent gotcha: HSA contributions must STOP 6 months BEFORE
 * Medicare enrollment due to the Part A six-month look-back rule —
 * Medicare back-dates Part A coverage 6 months when you enroll, and
 * HSA contributions during covered months are excess contributions
 * (excise tax). For households still working past 65 with HSA
 * contributions, this is a real penalty risk.
 *
 * V1 model: deterministic — milestones key off `household.{rob,debbie}BirthDate`
 * and `today`. HSA conflict checks intersect the 6-month lookback
 * window with the salary-end window (after which HSA contributions
 * already stop naturally).
 */

export type MedicareIepStage =
  | 'far_off' // > 6 months before age 65
  | 'approaching' // 3-6 months before age 65 — start preparing
  | 'in_window' // within 3 months of age 65, or 0-3 months after — must enroll now
  | 'missed' // > 3 months past 65th birthday and still not enrolled
  | 'enrolled_or_past'; // assumed enrolled (well past IEP)

export interface MedicareMilestone {
  /** Which spouse: 'rob' | 'debbie'. */
  person: string;
  /** Display name for the household — usually same as `person`. */
  displayName: string;
  /** Months from `asOf` to the 65th birthday. Negative when past. */
  monthsToAge65: number;
  /** Calendar date of the 65th birthday. */
  age65Date: Date;
  /** Where this person is in the IEP timeline. */
  stage: MedicareIepStage;
  /** Human label for the stage. */
  stageLabel: string;
  /** When this milestone should next escalate (e.g., "6 months out
   *  becomes 3 months out"). */
  nextEscalationLabel: string;
}

export interface HsaContributionConflict {
  person: string;
  /** First date the HSA contribution conflicts with the Medicare
   *  6-month look-back window. */
  conflictStartDate: Date;
  /** Description of the conflict. */
  message: string;
}

export interface MedicareMilestoneReport {
  milestones: MedicareMilestone[];
  /** HSA contribution conflicts (if any). Empty array means no risk. */
  hsaConflicts: HsaContributionConflict[];
  /** Whether the report has anything actionable to surface. The UI
   *  should hide the card entirely when this is false. */
  hasActionableSignal: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 30.4375; // 365.25 / 12

function parseBirthDate(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function add65YearsTo(birth: Date): Date {
  // Use UTC to avoid DST boundary issues; for milestone dates a
  // few-hour timezone shift is irrelevant.
  return new Date(
    Date.UTC(
      birth.getUTCFullYear() + 65,
      birth.getUTCMonth(),
      birth.getUTCDate(),
    ),
  );
}

function monthsBetween(from: Date, to: Date): number {
  // Approximate calendar-month delta. Good enough for milestone
  // bucketing (we only need 3-month and 6-month thresholds).
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY / DAYS_PER_MONTH);
}

function classifyStage(monthsToAge65: number): MedicareIepStage {
  if (monthsToAge65 > 6) return 'far_off';
  if (monthsToAge65 > 3) return 'approaching';
  if (monthsToAge65 >= -3) return 'in_window';
  // More than 3 months past 65 — should be enrolled. We can't tell
  // from the seed whether they actually enrolled; surface "missed"
  // up to 12 months past, then assume enrolled afterwards.
  if (monthsToAge65 >= -12) return 'missed';
  return 'enrolled_or_past';
}

function stageLabel(stage: MedicareIepStage, months: number): string {
  switch (stage) {
    case 'far_off':
      return `Medicare-eligible in ${months} months`;
    case 'approaching':
      return `IEP starts in ${months - 3} month${months - 3 === 1 ? '' : 's'} (3 months before age 65)`;
    case 'in_window':
      return months >= 0
        ? `In Medicare IEP — enroll now`
        : `In Medicare IEP — last ${3 + months} month${3 + months === 1 ? '' : 's'} to enroll`;
    case 'missed':
      return `IEP missed ${Math.abs(months) - 3} month${Math.abs(months) - 3 === 1 ? '' : 's'} ago — special-enrollment-period rules apply`;
    case 'enrolled_or_past':
      return 'Past IEP (assumed enrolled)';
    default:
      return '';
  }
}

function escalationLabel(stage: MedicareIepStage, months: number): string {
  switch (stage) {
    case 'far_off':
      return `Will escalate in ${months - 6} months when IEP-prep starts`;
    case 'approaching':
      return `Escalates in ${months - 3} months → "in window — enroll"`;
    case 'in_window':
      return months >= 0
        ? `Last ${3 + months} months to enroll without penalty`
        : `Final ${3 + months} months — penalty after`;
    case 'missed':
      return 'Special enrollment / late penalty applies';
    case 'enrolled_or_past':
      return '';
    default:
      return '';
  }
}

/**
 * Compute Medicare milestone status for both spouses + HSA contribution
 * conflict checks. Pure function over seed + `asOf` (defaults to today).
 */
export function computeMedicareMilestones(
  data: SeedData,
  asOf = new Date(),
): MedicareMilestoneReport {
  const milestones: MedicareMilestone[] = [];

  const robBirth = parseBirthDate(data.household?.robBirthDate);
  const debbieBirth = parseBirthDate(data.household?.debbieBirthDate);

  if (robBirth) {
    const age65 = add65YearsTo(robBirth);
    const months = monthsBetween(asOf, age65);
    const stage = classifyStage(months);
    milestones.push({
      person: 'rob',
      displayName: 'Rob',
      monthsToAge65: months,
      age65Date: age65,
      stage,
      stageLabel: stageLabel(stage, months),
      nextEscalationLabel: escalationLabel(stage, months),
    });
  }
  if (debbieBirth) {
    const age65 = add65YearsTo(debbieBirth);
    const months = monthsBetween(asOf, age65);
    const stage = classifyStage(months);
    milestones.push({
      person: 'debbie',
      displayName: 'Debbie',
      monthsToAge65: months,
      age65Date: age65,
      stage,
      stageLabel: stageLabel(stage, months),
      nextEscalationLabel: escalationLabel(stage, months),
    });
  }

  // HSA conflict check. The Part A 6-month look-back means HSA
  // contributions in the 6 months before Medicare enrollment count
  // as excess contributions. If the household's salary (and therefore
  // HSA contributions, which are payroll-deducted) extends INTO the
  // 6-month-pre-65 window, flag it.
  const hsaConflicts: HsaContributionConflict[] = [];
  const hsaPct =
    data.income?.preRetirementContributions?.hsaPercentOfSalary ?? 0;
  const salaryEnd = parseBirthDate(data.income?.salaryEndDate);

  if (hsaPct > 0 && salaryEnd) {
    for (const m of milestones) {
      // Lookback start: 6 months before age 65.
      const lookbackStart = new Date(m.age65Date.getTime());
      lookbackStart.setUTCMonth(lookbackStart.getUTCMonth() - 6);
      // Conflict iff salary continues past the lookback start (HSA
      // contributions would still be flowing during the protected
      // window).
      if (salaryEnd.getTime() > lookbackStart.getTime()) {
        hsaConflicts.push({
          person: m.person,
          conflictStartDate: lookbackStart,
          message: `HSA contributions are scheduled past ${m.displayName}'s 6-month Medicare look-back start (${lookbackStart.toLocaleDateString()}). Stop HSA payroll deferrals by then to avoid the IRS excise tax on excess contributions.`,
        });
      }
    }
  }

  // Surface the card when planning meaningfully intersects Medicare:
  //   - any spouse approaching / in / past the IEP window, OR
  //   - "far_off" but within 36 months — gives planning lead time so
  //     the household sees Medicare on the radar early enough to:
  //     (a) align retirement timing with IEP, and (b) plan HSA
  //     contributions to stop before the 6-month look-back. 36 months
  //     covers the typical "I'm thinking about retirement in 3 years"
  //     household which is exactly when they should start watching
  //     Medicare. OR there's an HSA conflict at any horizon.
  const hasActionableSignal =
    milestones.some(
      (m) =>
        m.stage === 'approaching' ||
        m.stage === 'in_window' ||
        m.stage === 'missed' ||
        (m.stage === 'far_off' && m.monthsToAge65 <= 36),
    ) || hsaConflicts.length > 0;

  return {
    milestones,
    hsaConflicts,
    hasActionableSignal,
  };
}
