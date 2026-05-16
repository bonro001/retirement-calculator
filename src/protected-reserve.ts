import type { SeedData } from './types';

export type ProtectedReservePurpose = 'care_first_legacy_if_unused';

export type ProtectedReserveAvailableFor =
  | 'late_life_care_or_health_shocks'
  | 'legacy_only';

export type ProtectedReserveModelCompleteness = 'faithful' | 'reconstructed';

export interface ProtectedReserveGoal {
  targetTodayDollars: number;
  purpose: ProtectedReservePurpose;
  availableFor: ProtectedReserveAvailableFor;
  normalLifestyleSpendable: boolean;
  modelCompleteness: ProtectedReserveModelCompleteness;
  assumptionSource: string;
  legacyAliasTodayDollars: number;
}

export interface ProtectedReserveContractIssue {
  id:
    | 'protected_reserve_missing'
    | 'protected_reserve_not_care_first'
    | 'protected_reserve_lifestyle_spendable'
    | 'protected_reserve_target_mismatch'
    | 'protected_reserve_surface_mismatch'
    | 'protected_reserve_completeness_mismatch';
  severity: 'blocking' | 'warning';
  message: string;
}

export const DEFAULT_PROTECTED_RESERVE_TARGET_TODAY_DOLLARS = 1_000_000;
export const DEFAULT_PROTECTED_RESERVE_PURPOSE: ProtectedReservePurpose =
  'care_first_legacy_if_unused';
export const DEFAULT_PROTECTED_RESERVE_AVAILABLE_FOR: ProtectedReserveAvailableFor =
  'late_life_care_or_health_shocks';

export function protectedReserveFromTarget(
  targetTodayDollars: number,
  input?: Partial<Omit<ProtectedReserveGoal, 'targetTodayDollars' | 'legacyAliasTodayDollars'>>,
): ProtectedReserveGoal {
  const target = Number.isFinite(targetTodayDollars)
    ? Math.max(0, targetTodayDollars)
    : DEFAULT_PROTECTED_RESERVE_TARGET_TODAY_DOLLARS;
  return {
    targetTodayDollars: target,
    purpose: input?.purpose ?? DEFAULT_PROTECTED_RESERVE_PURPOSE,
    availableFor: input?.availableFor ?? DEFAULT_PROTECTED_RESERVE_AVAILABLE_FOR,
    normalLifestyleSpendable: input?.normalLifestyleSpendable ?? false,
    modelCompleteness: input?.modelCompleteness ?? 'reconstructed',
    assumptionSource:
      input?.assumptionSource ?? 'derived_from_legacyTargetTodayDollars',
    legacyAliasTodayDollars: target,
  };
}

export function resolveProtectedReserveGoal(
  goals: SeedData['goals'] | undefined,
  fallbackTargetTodayDollars = DEFAULT_PROTECTED_RESERVE_TARGET_TODAY_DOLLARS,
): ProtectedReserveGoal {
  const rawReserve =
    goals?.protectedReserve &&
    typeof goals.protectedReserve === 'object' &&
    !Array.isArray(goals.protectedReserve)
      ? (goals.protectedReserve as Partial<ProtectedReserveGoal>)
      : null;
  const target =
    typeof rawReserve?.targetTodayDollars === 'number'
      ? rawReserve.targetTodayDollars
      : typeof goals?.legacyTargetTodayDollars === 'number'
        ? goals.legacyTargetTodayDollars
        : fallbackTargetTodayDollars;

  return protectedReserveFromTarget(target, {
    purpose: rawReserve?.purpose ?? DEFAULT_PROTECTED_RESERVE_PURPOSE,
    availableFor:
      rawReserve?.availableFor ?? DEFAULT_PROTECTED_RESERVE_AVAILABLE_FOR,
    normalLifestyleSpendable: rawReserve?.normalLifestyleSpendable ?? false,
    modelCompleteness: rawReserve ? 'faithful' : 'reconstructed',
    assumptionSource:
      rawReserve?.assumptionSource ??
      (typeof goals?.legacyTargetTodayDollars === 'number'
        ? 'derived_from_legacyTargetTodayDollars'
        : 'defaulted_protected_reserve_target'),
  });
}

export function auditProtectedReserveContract(input: {
  legacyTargetTodayDollars?: number | null;
  protectedReserve?: Partial<ProtectedReserveGoal> | null;
  claimedModelCompleteness?: ProtectedReserveModelCompleteness;
  northStarLegacyTarget?: number | null;
  surfaces?: Array<{
    name: string;
    targetTodayDollars?: number | null;
    purpose?: string | null;
  }>;
}): ProtectedReserveContractIssue[] {
  const issues: ProtectedReserveContractIssue[] = [];
  const reserve = input.protectedReserve ?? null;
  const reserveTarget = reserve?.targetTodayDollars;

  if (input.legacyTargetTodayDollars !== undefined && input.legacyTargetTodayDollars !== null && !reserve) {
    issues.push({
      id: 'protected_reserve_missing',
      severity: 'blocking',
      message:
        'legacyTargetTodayDollars is present but protectedReserve is missing.',
    });
  }

  if (reserve && reserve.purpose !== DEFAULT_PROTECTED_RESERVE_PURPOSE) {
    issues.push({
      id: 'protected_reserve_not_care_first',
      severity: 'blocking',
      message: `protectedReserve purpose must be ${DEFAULT_PROTECTED_RESERVE_PURPOSE}.`,
    });
  }

  if (reserve?.normalLifestyleSpendable === true) {
    issues.push({
      id: 'protected_reserve_lifestyle_spendable',
      severity: 'blocking',
      message:
        'protectedReserve cannot be marked as normal lifestyle spending money.',
    });
  }

  if (
    typeof reserveTarget === 'number' &&
    typeof input.northStarLegacyTarget === 'number' &&
    reserveTarget !== input.northStarLegacyTarget
  ) {
    issues.push({
      id: 'protected_reserve_target_mismatch',
      severity: 'blocking',
      message:
        'North-star target differs from protectedReserve targetTodayDollars.',
    });
  }

  for (const surface of input.surfaces ?? []) {
    if (
      typeof reserveTarget === 'number' &&
      typeof surface.targetTodayDollars === 'number' &&
      reserveTarget !== surface.targetTodayDollars
    ) {
      issues.push({
        id: 'protected_reserve_surface_mismatch',
        severity: 'blocking',
        message: `${surface.name} target differs from protectedReserve targetTodayDollars.`,
      });
    }
    if (
      surface.purpose !== undefined &&
      surface.purpose !== null &&
      surface.purpose !== reserve?.purpose
    ) {
      issues.push({
        id: 'protected_reserve_surface_mismatch',
        severity: 'blocking',
        message: `${surface.name} purpose differs from protectedReserve purpose.`,
      });
    }
  }

  if (
    input.claimedModelCompleteness === 'faithful' &&
    reserve?.modelCompleteness !== 'faithful'
  ) {
    issues.push({
      id: 'protected_reserve_completeness_mismatch',
      severity: 'blocking',
      message:
        'Packet claims faithful completeness but protectedReserve is missing or reconstructed.',
    });
  }

  return issues;
}
