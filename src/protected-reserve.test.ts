import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import {
  auditProtectedReserveContract,
  protectedReserveFromTarget,
  resolveProtectedReserveGoal,
} from './protected-reserve';

describe('protected reserve goal', () => {
  it('resolves the household seed as an explicit care-first reserve', () => {
    const reserve = resolveProtectedReserveGoal(initialSeedData.goals);

    expect(reserve).toEqual({
      targetTodayDollars: 1_000_000,
      purpose: 'care_first_legacy_if_unused',
      availableFor: 'late_life_care_or_health_shocks',
      normalLifestyleSpendable: false,
      modelCompleteness: 'faithful',
      assumptionSource:
        'user_confirmed_2026_05_16_care_first_legacy_if_unused',
      legacyAliasTodayDollars: 1_000_000,
    });
  });

  it('keeps legacy scalar compatibility but flags the reserve as reconstructed', () => {
    const reserve = resolveProtectedReserveGoal({
      legacyTargetTodayDollars: 750_000,
    });

    expect(reserve.targetTodayDollars).toBe(750_000);
    expect(reserve.legacyAliasTodayDollars).toBe(750_000);
    expect(reserve.purpose).toBe('care_first_legacy_if_unused');
    expect(reserve.availableFor).toBe('late_life_care_or_health_shocks');
    expect(reserve.normalLifestyleSpendable).toBe(false);
    expect(reserve.modelCompleteness).toBe('reconstructed');
    expect(reserve.assumptionSource).toBe('derived_from_legacyTargetTodayDollars');
  });

  it('builds a target-only reserve object for older call sites', () => {
    const reserve = protectedReserveFromTarget(1_250_000);

    expect(reserve.targetTodayDollars).toBe(1_250_000);
    expect(reserve.modelCompleteness).toBe('reconstructed');
    expect(reserve.normalLifestyleSpendable).toBe(false);
  });

  it('blocks faithful packets that carry only the legacy scalar', () => {
    const issues = auditProtectedReserveContract({
      legacyTargetTodayDollars: 1_000_000,
      protectedReserve: null,
      claimedModelCompleteness: 'faithful',
    });

    expect(issues.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([
        'protected_reserve_missing',
        'protected_reserve_completeness_mismatch',
      ]),
    );
    expect(issues.every((issue) => issue.severity === 'blocking')).toBe(true);
  });

  it('blocks non-care-first or lifestyle-spendable reserves', () => {
    const issues = auditProtectedReserveContract({
      legacyTargetTodayDollars: 1_000_000,
      protectedReserve: {
        targetTodayDollars: 1_000_000,
        purpose: 'legacy_only' as never,
        availableFor: 'legacy_only',
        normalLifestyleSpendable: true,
        modelCompleteness: 'faithful',
      },
      claimedModelCompleteness: 'faithful',
    });

    expect(issues.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([
        'protected_reserve_not_care_first',
        'protected_reserve_lifestyle_spendable',
      ]),
    );
  });

  it('blocks target and purpose drift across model surfaces', () => {
    const reserve = resolveProtectedReserveGoal(initialSeedData.goals);
    const issues = auditProtectedReserveContract({
      legacyTargetTodayDollars: 1_000_000,
      protectedReserve: reserve,
      northStarLegacyTarget: 950_000,
      claimedModelCompleteness: 'faithful',
      surfaces: [
        {
          name: 'monthly_review',
          targetTodayDollars: 1_000_000,
          purpose: 'care_first_legacy_if_unused',
        },
        {
          name: 'planning_export',
          targetTodayDollars: 1_100_000,
          purpose: 'legacy_only',
        },
      ],
    });

    expect(issues.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([
        'protected_reserve_target_mismatch',
        'protected_reserve_surface_mismatch',
      ]),
    );
    expect(issues).toHaveLength(3);
  });

  it('blocks faithful claims for reconstructed reserve assumptions', () => {
    const reserve = resolveProtectedReserveGoal({
      legacyTargetTodayDollars: 1_000_000,
    });
    const issues = auditProtectedReserveContract({
      legacyTargetTodayDollars: 1_000_000,
      protectedReserve: reserve,
      claimedModelCompleteness: 'faithful',
    });

    expect(issues).toEqual([
      expect.objectContaining({
        id: 'protected_reserve_completeness_mismatch',
        severity: 'blocking',
      }),
    ]);
  });
});
