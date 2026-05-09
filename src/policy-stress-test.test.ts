import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyFeasibilityDelta,
  DEFAULT_STRESS_SCENARIOS,
  formatBequestDelta,
  formatFeasibilityDelta,
  runPolicyStressTest,
  worstCaseSummary,
  type StressTestReport,
  type StressTestResult,
} from './policy-stress-test';
import type { Policy } from './policy-miner-types';
import type { MarketAssumptions, SeedData, Stressor } from './types';

/**
 * E.6 — stress-test pure-helper tests.
 *
 * The integration story (full engine round-trip) is implicitly covered
 * by `policy-miner.throughput.test.ts` and the existing engine tests.
 * Here we only test the pure layer:
 *   - the scenario registry shape (so the panel doesn't render a row
 *     with a typo'd ID and silently no-op)
 *   - the report-orchestration loop (progress callback fires once per
 *     run including baseline; baseline always runs first)
 *   - the household-readable formatters (sign, suffix, edge cases)
 *   - the worst-case selector (picks by feasibility, not bequest)
 */

// -----------------------------------------------------------------------------
// Mock the engine. We don't want to run a real Monte Carlo here — the test is
// about wiring, not engine behavior. The mock returns a stub PathResult whose
// percentiles depend on which stressor IDs were passed, so the orchestration
// can be verified end-to-end.
// -----------------------------------------------------------------------------

vi.mock('./utils', () => ({
  buildPathResults: vi.fn(),
}));

vi.mock('./plan-evaluation', () => ({
  approximateBequestAttainmentRate: vi.fn((target: number, p: { p50: number }) =>
    // Stub: 1.0 if median >= target, else median/target.
    p.p50 >= target ? 1.0 : p.p50 / target,
  ),
}));

import { buildPathResults } from './utils';

const mockedBuildPathResults = buildPathResults as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedBuildPathResults.mockReset();
  // Default: bigger stressor list = lower bequest. Lets a test assert the
  // perfect_storm scenario actually beats out single-stressor ones.
  mockedBuildPathResults.mockImplementation(
    (
      _seed: SeedData,
      _assumptions: MarketAssumptions,
      stressors: string[],
      _responses: string[],
      _options: unknown,
    ) => {
      const damping = 1 - stressors.length * 0.2;
      const base = 2_000_000 * damping;
      return [
        {
          label: 'Selected Path',
          successRate: 0.9 - stressors.length * 0.1,
          endingWealthPercentiles: {
            p10: base * 0.4,
            p25: base * 0.7,
            p50: base,
            p75: base * 1.3,
            p90: base * 1.6,
          },
          yearlySeries: new Array(30),
        },
      ];
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const stubStressors: Stressor[] = [
  { id: 'market_down', name: 'Bad Markets', type: 'market' },
  { id: 'inflation', name: 'High Inflation', type: 'inflation' },
  { id: 'layoff', name: 'Laid Off Early', type: 'income' },
  { id: 'delayed_inheritance', name: 'Delayed Inheritance', type: 'timing' },
];

function buildSeed(): SeedData {
  return {
    stressors: stubStressors,
    income: {
      salaryAnnual: 240_000,
      socialSecurity: [{ claimAge: 67 }, { claimAge: 67 }],
    },
    rules: {},
    responses: [],
  } as unknown as SeedData;
}

function buildPolicy(): Policy {
  return {
    annualSpendTodayDollars: 100_000,
    primarySocialSecurityClaimAge: 67,
    spouseSocialSecurityClaimAge: 67,
    rothConversionAnnualCeiling: 50_000,
  };
}

const ASSUMPTIONS: MarketAssumptions = { inflation: 0.025 } as MarketAssumptions;
const cloner = (s: SeedData) => JSON.parse(JSON.stringify(s));

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('DEFAULT_STRESS_SCENARIOS', () => {
  it('includes the four core scenarios', () => {
    const ids = DEFAULT_STRESS_SCENARIOS.map((s) => s.id);
    expect(ids).toContain('sequence_risk');
    expect(ids).toContain('high_inflation');
    expect(ids).toContain('laid_off_october');
    expect(ids).toContain('delayed_inheritance');
    expect(ids).toContain('perfect_storm');
  });

  it('has unique scenario ids', () => {
    const ids = DEFAULT_STRESS_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references stressor IDs that exist in the seed registry', () => {
    // The seed-data.json registry is the source of truth — every default
    // stressorId must resolve, otherwise the scenario silently no-ops.
    const knownStressorIds = new Set(stubStressors.map((s) => s.id));
    for (const scenario of DEFAULT_STRESS_SCENARIOS) {
      for (const id of scenario.stressorIds) {
        expect(knownStressorIds.has(id)).toBe(true);
      }
    }
  });

  it('every scenario has a non-empty name and description', () => {
    for (const s of DEFAULT_STRESS_SCENARIOS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe('runPolicyStressTest', () => {
  it('runs the baseline first, then each scenario in input order', async () => {
    const report = await runPolicyStressTest(
      buildPolicy(),
      buildSeed(),
      ASSUMPTIONS,
      1_000_000,
      cloner,
    );
    expect(report.baseline.scenario.id).toBe('baseline');
    expect(report.baseline.appliedStressors).toEqual([]);
    expect(report.scenarios.map((r) => r.scenario.id)).toEqual(
      DEFAULT_STRESS_SCENARIOS.map((s) => s.id),
    );
    // First call to the engine is the baseline (no stressors).
    const firstCallStressors = mockedBuildPathResults.mock.calls[0][2];
    expect(firstCallStressors).toEqual([]);
  });

  it('fires onProgress once per run including baseline', async () => {
    const onProgress = vi.fn();
    await runPolicyStressTest(
      buildPolicy(),
      buildSeed(),
      ASSUMPTIONS,
      1_000_000,
      cloner,
      { onProgress },
    );
    const total = DEFAULT_STRESS_SCENARIOS.length + 1; // +1 for baseline
    expect(onProgress).toHaveBeenCalledTimes(total);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, total);
    expect(onProgress).toHaveBeenLastCalledWith(total, total);
  });

  it('drops stressor IDs the seed registry does not know about', async () => {
    const seed = buildSeed();
    // Wipe the inflation stressor from the registry — high_inflation must
    // gracefully degrade to a no-op instead of throwing.
    (seed as { stressors: Stressor[] }).stressors = stubStressors.filter(
      (s) => s.id !== 'inflation',
    );
    const report = await runPolicyStressTest(
      buildPolicy(),
      seed,
      ASSUMPTIONS,
      1_000_000,
      cloner,
    );
    const inflationResult = report.scenarios.find(
      (r) => r.scenario.id === 'high_inflation',
    );
    expect(inflationResult).toBeDefined();
    expect(inflationResult!.appliedStressors).toEqual([]);
  });

  it('honors a custom scenario set', async () => {
    const custom = [
      {
        id: 'just_markets',
        name: 'Just markets',
        description: 'one stressor',
        stressorIds: ['market_down'],
      },
    ];
    const report = await runPolicyStressTest(
      buildPolicy(),
      buildSeed(),
      ASSUMPTIONS,
      1_000_000,
      cloner,
      { scenarios: custom },
    );
    expect(report.scenarios.length).toBe(1);
    expect(report.scenarios[0].scenario.id).toBe('just_markets');
  });

  it('passes the October layoff date and three months severance to the engine', async () => {
    await runPolicyStressTest(
      buildPolicy(),
      buildSeed(),
      ASSUMPTIONS,
      1_000_000,
      cloner,
    );

    const scenarioIndex = DEFAULT_STRESS_SCENARIOS.findIndex(
      (s) => s.id === 'laid_off_october',
    );
    expect(scenarioIndex).toBeGreaterThanOrEqual(0);

    const engineCall = mockedBuildPathResults.mock.calls[scenarioIndex + 1];
    expect(engineCall[2]).toEqual(['layoff']);
    expect(engineCall[4]).toMatchObject({
      stressorKnobs: {
        layoffRetireDate: '2026-10-01',
        layoffSeverance: 60_000,
      },
    });
  });

  it('records a positive duration for each run', async () => {
    const report = await runPolicyStressTest(
      buildPolicy(),
      buildSeed(),
      ASSUMPTIONS,
      1_000_000,
      cloner,
    );
    expect(report.baseline.durationMs).toBeGreaterThanOrEqual(0);
    for (const r of report.scenarios) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

// -----------------------------------------------------------------------------
// Pure formatter / classifier tests
// -----------------------------------------------------------------------------

describe('classifyFeasibilityDelta', () => {
  it('classifies a 15pp drop as severe', () => {
    expect(classifyFeasibilityDelta(-0.15)).toBe('severe');
  });

  it('classifies a 5pp drop as notable', () => {
    expect(classifyFeasibilityDelta(-0.05)).toBe('notable');
  });

  it('treats <2pp jitter as neutral in either direction', () => {
    expect(classifyFeasibilityDelta(0.01)).toBe('neutral');
    expect(classifyFeasibilityDelta(-0.01)).toBe('neutral');
  });

  it('classifies a 5pp gain as positive', () => {
    expect(classifyFeasibilityDelta(0.05)).toBe('positive');
  });

  it('boundary at exactly −10pp is severe (inclusive)', () => {
    expect(classifyFeasibilityDelta(-0.10)).toBe('severe');
  });
});

describe('formatBequestDelta', () => {
  it('handles zero', () => {
    expect(formatBequestDelta(0)).toBe('—');
  });

  it('formats a positive delta with millions suffix', () => {
    expect(formatBequestDelta(1_500_000)).toBe('+$1.50M');
  });

  it('formats a negative delta with thousands suffix', () => {
    expect(formatBequestDelta(-250_000)).toBe('−$250k');
  });

  it('formats a small delta in dollars', () => {
    expect(formatBequestDelta(-150)).toBe('−$150');
  });
});

describe('formatFeasibilityDelta', () => {
  it('rounds to whole percentage points', () => {
    expect(formatFeasibilityDelta(-0.123)).toBe('−12pp');
    expect(formatFeasibilityDelta(0.078)).toBe('+8pp');
  });

  it('returns the dash when delta rounds to 0pp', () => {
    expect(formatFeasibilityDelta(0)).toBe('—');
    expect(formatFeasibilityDelta(0.004)).toBe('—');
  });
});

describe('worstCaseSummary', () => {
  function mkResult(
    id: string,
    bequestAttainmentRate: number,
    p50: number,
  ): StressTestResult {
    return {
      scenario: { id, name: id, description: '', stressorIds: [] },
      appliedStressors: [],
      outcome: {
        bequestAttainmentRate,
        horizonYears: 30,
        p10EndingWealthTodayDollars: p50 * 0.4,
        p25EndingWealthTodayDollars: p50 * 0.7,
        p50EndingWealthTodayDollars: p50,
        p75EndingWealthTodayDollars: p50 * 1.3,
        p90EndingWealthTodayDollars: p50 * 1.6,
        solventSuccessRate: 0.9,
      },
      durationMs: 1,
    };
  }

  it('returns null when no scenarios were run', () => {
    const report: StressTestReport = {
      baseline: mkResult('baseline', 0.95, 2_000_000),
      scenarios: [],
      totalDurationMs: 1,
    };
    expect(worstCaseSummary(report)).toBeNull();
  });

  it('picks the scenario with the largest negative feasibility delta', () => {
    const report: StressTestReport = {
      baseline: mkResult('baseline', 0.95, 2_000_000),
      scenarios: [
        mkResult('a', 0.85, 1_800_000),
        mkResult('b', 0.60, 1_200_000), // worst on feasibility
        mkResult('c', 0.80, 800_000), // worst on bequest, but better feasibility than b
      ],
      totalDurationMs: 1,
    };
    const summary = worstCaseSummary(report);
    expect(summary).not.toBeNull();
    expect(summary!.scenarioName).toBe('b');
    expect(summary!.feasibilityDeltaRate).toBeCloseTo(-0.35, 2);
  });
});
