import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { SeedData } from './types';
import { computeMedicareMilestones } from './medicare-milestones';

function buildSeed(overrides: Partial<SeedData['household']> = {}): SeedData {
  return JSON.parse(
    JSON.stringify({
      ...initialSeedData,
      household: { ...initialSeedData.household, ...overrides },
    }),
  );
}

describe('computeMedicareMilestones — stages', () => {
  it('classifies "far_off" when both spouses are years from 65', () => {
    const seed = buildSeed({
      robBirthDate: '1970-01-01',
      debbieBirthDate: '1970-01-01',
    });
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    for (const m of r.milestones) {
      expect(m.stage).toBe('far_off');
      expect(m.monthsToAge65).toBeGreaterThan(6);
    }
  });

  it('classifies "approaching" 3-6 months before 65', () => {
    // Rob turns 65 in 5 months from "now".
    const seed = buildSeed({
      robBirthDate: '1961-09-29',
      debbieBirthDate: '1970-01-01',
    });
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    const rob = r.milestones.find((m) => m.person === 'rob')!;
    expect(rob.stage).toBe('approaching');
  });

  it('classifies "in_window" when within 3 months of birthday', () => {
    // Rob turns 65 in 2 months.
    const seed = buildSeed({
      robBirthDate: '1961-06-29',
      debbieBirthDate: '1970-01-01',
    });
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    const rob = r.milestones.find((m) => m.person === 'rob')!;
    expect(rob.stage).toBe('in_window');
  });

  it('classifies "missed" when more than 3 months past 65 (within 12)', () => {
    // Rob turned 65 a year ago.
    const seed = buildSeed({
      robBirthDate: '1960-04-29',
      debbieBirthDate: '1970-01-01',
    });
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    const rob = r.milestones.find((m) => m.person === 'rob')!;
    expect(rob.stage).toBe('missed');
  });

  it('classifies "enrolled_or_past" well after 65', () => {
    const seed = buildSeed({
      robBirthDate: '1955-01-01',
      debbieBirthDate: '1970-01-01',
    });
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    const rob = r.milestones.find((m) => m.person === 'rob')!;
    expect(rob.stage).toBe('enrolled_or_past');
  });
});

describe('computeMedicareMilestones — HSA conflict check', () => {
  it('flags conflict when HSA contributions extend into the 6-month look-back window', () => {
    // Rob turns 65 in mid-2027; salary ends 2027-07-01 (well into
    // his 6-month look-back). HSA conflict expected.
    const seed = buildSeed({
      robBirthDate: '1962-08-15',
      debbieBirthDate: '1970-01-01',
    });
    seed.income.salaryEndDate = '2027-07-01';
    seed.income.preRetirementContributions.hsaPercentOfSalary = 0.02;
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    expect(r.hsaConflicts.length).toBeGreaterThan(0);
    expect(r.hasActionableSignal).toBe(true);
  });

  it("does NOT flag when salary ends before any spouse's look-back window starts", () => {
    // Both spouses far from 65; salary ends well before any look-back.
    const seed = buildSeed({
      robBirthDate: '1970-01-01',
      debbieBirthDate: '1970-01-01',
    });
    seed.income.salaryEndDate = '2027-07-01';
    seed.income.preRetirementContributions.hsaPercentOfSalary = 0.02;
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    expect(r.hsaConflicts).toHaveLength(0);
  });

  it('does NOT flag when HSA percent is 0 (not contributing)', () => {
    const seed = buildSeed({
      robBirthDate: '1962-08-15',
      debbieBirthDate: '1970-01-01',
    });
    seed.income.salaryEndDate = '2027-07-01';
    seed.income.preRetirementContributions.hsaPercentOfSalary = 0;
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    expect(r.hsaConflicts).toHaveLength(0);
  });
});

describe('computeMedicareMilestones — household-level signal', () => {
  it('hasActionableSignal=false when both spouses are >36 months out and no HSA conflict', () => {
    const seed = buildSeed({
      robBirthDate: '1970-01-01',
      debbieBirthDate: '1972-01-01',
    });
    seed.income.preRetirementContributions.hsaPercentOfSalary = 0;
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    expect(r.hasActionableSignal).toBe(false);
  });

  it('hasActionableSignal=true when one spouse is within 36 months', () => {
    // Birth 1963-10-29 → turns 65 in 2028-10 → ~30 months out from
    // 2026-04-29 (matches the actual household's situation).
    const seed = buildSeed({
      robBirthDate: '1963-10-29',
      debbieBirthDate: '1963-10-29',
    });
    seed.income.preRetirementContributions.hsaPercentOfSalary = 0;
    const r = computeMedicareMilestones(seed, new Date('2026-04-29'));
    expect(r.hasActionableSignal).toBe(true);
  });
});
