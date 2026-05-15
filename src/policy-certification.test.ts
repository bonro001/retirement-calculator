import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from './policy-miner-types';
import type { MarketAssumptions, PathResult, SeedData } from './types';

vi.mock('./utils', () => ({
  buildPathResults: vi.fn(),
}));

import { buildPathResults } from './utils';
import {
  classifyPolicyCertificationRows,
  first10YearFailureRisk,
  runPolicyCertification,
  type PolicyCertificationMetricRow,
  type PolicyCertificationSeedAudit,
} from './policy-certification';

const mockedBuildPathResults = buildPathResults as unknown as ReturnType<typeof vi.fn>;

function makeRow(
  overrides: Partial<PolicyCertificationMetricRow> = {},
): PolicyCertificationMetricRow {
  return {
    id: 'row',
    basisId: 'current_faithful',
    basisLabel: 'Current faithful',
    mode: 'forward_parametric',
    modeLabel: 'Forward-looking',
    scenarioId: 'baseline',
    scenarioName: 'Baseline',
    scenarioKind: 'baseline',
    seed: 20260416,
    solvencyRate: 0.98,
    legacyAttainmentRate: 0.9,
    first10YearFailureRisk: 0,
    spendingCutRate: 0.02,
    p10EndingWealthTodayDollars: 1_500_000,
    p50EndingWealthTodayDollars: 2_500_000,
    worstFailureYear: null,
    mostLikelyFailureYear: null,
    failureConcentrationRate: 0,
    appliedStressors: [],
    durationMs: 1,
    ...overrides,
  };
}

function makeAudit(
  overrides: Partial<PolicyCertificationSeedAudit> = {},
): PolicyCertificationSeedAudit {
  return {
    basisId: 'current_faithful',
    basisLabel: 'Current faithful',
    mode: 'forward_parametric',
    modeLabel: 'Forward-looking',
    seeds: [20260416, 20260517, 20260618],
    worstSolvencyRate: 0.96,
    worstLegacyAttainmentRate: 0.86,
    ...overrides,
  };
}

function makePath(overrides: Partial<PathResult> = {}): PathResult {
  return {
    id: 'path',
    label: 'Selected Path',
    simulationMode: 'planner_enhanced',
    plannerLogicActive: true,
    successRate: 0.99,
    medianEndingWealth: 2_500_000,
    tenthPercentileEndingWealth: 1_500_000,
    yearsFunded: 30,
    medianFailureYear: null,
    spendingCutRate: 0.01,
    irmaaExposureRate: 0,
    homeSaleDependenceRate: 0,
    inheritanceDependenceRate: 0,
    flexibilityScore: 1,
    cornerRiskScore: 0,
    rothDepletionRate: 0,
    annualFederalTaxEstimate: 0,
    irmaaExposure: 'Low',
    cornerRisk: 'Low',
    failureMode: 'none',
    notes: '',
    stressors: [],
    responses: [],
    endingWealthPercentiles: {
      p10: 1_500_000,
      p25: 2_000_000,
      p50: 2_500_000,
      p75: 3_000_000,
      p90: 3_500_000,
    },
    failureYearDistribution: [],
    worstOutcome: {
      endingWealth: 0,
      success: true,
      failureYear: null,
    },
    bestOutcome: {
      endingWealth: 4_000_000,
      success: true,
      failureYear: null,
    },
    monteCarloMetadata: {
      seed: 20260416,
      trialCount: 5_000,
      assumptionsVersion: 'test',
      planningHorizonYears: 30,
    },
    simulationConfiguration: {} as PathResult['simulationConfiguration'],
    simulationDiagnostics: {} as PathResult['simulationDiagnostics'],
    riskMetrics: {} as PathResult['riskMetrics'],
    yearlySeries: [
      {
        year: 2026,
        medianAssets: 2_500_000,
        tenthPercentileAssets: 1_500_000,
      } as PathResult['yearlySeries'][number],
      {
        year: 2027,
        medianAssets: 2_450_000,
        tenthPercentileAssets: 1_450_000,
      } as PathResult['yearlySeries'][number],
    ],
    ...overrides,
  };
}

function makeSeed(): SeedData {
  return {
    stressors: [],
    income: {
      socialSecurity: [{ claimAge: 67 }, { claimAge: 67 }],
    },
    spending: {
      essentialMonthly: 6_000,
      optionalMonthly: 3_000,
      annualTaxesInsurance: 12_000,
      travelEarlyRetirementAnnual: 20_000,
    },
    accounts: {},
    rules: {},
    responses: [],
  } as unknown as SeedData;
}

const POLICY: Policy = {
  annualSpendTodayDollars: 120_000,
  primarySocialSecurityClaimAge: 67,
  spouseSocialSecurityClaimAge: 67,
  rothConversionAnnualCeiling: 80_000,
};

const ASSUMPTIONS: MarketAssumptions = {
  simulationRuns: 1_000,
  simulationSeed: 20260416,
  inflation: 0,
  assumptionsVersion: 'test',
} as MarketAssumptions;

beforeEach(() => {
  mockedBuildPathResults.mockReset();
  mockedBuildPathResults.mockReturnValue([makePath()]);
});

describe('first10YearFailureRisk', () => {
  it('sums failures in the first ten calendar years only', () => {
    expect(
      first10YearFailureRisk(
        [
          { year: 2026, count: 1, rate: 0.01 },
          { year: 2035, count: 2, rate: 0.02 },
          { year: 2036, count: 3, rate: 0.03 },
        ],
        2026,
      ),
    ).toBeCloseTo(0.03, 6);
  });
});

describe('classifyPolicyCertificationRows', () => {
  it('returns green when baseline, stress, and seed gates all pass', () => {
    const result = classifyPolicyCertificationRows({
      rows: [
        makeRow(),
        makeRow({
          id: 'stress',
          scenarioId: 'sequence_risk',
          scenarioName: 'Bad early markets',
          scenarioKind: 'stress',
          solvencyRate: 0.9,
          legacyAttainmentRate: 0.75,
          first10YearFailureRisk: 0.02,
          spendingCutRate: 0.1,
        }),
      ],
      seedAudits: [makeAudit()],
    });
    expect(result.verdict).toBe('green');
  });

  it('does not downgrade solely because the broad guardrail-cut metric fires', () => {
    const result = classifyPolicyCertificationRows({
      rows: [
        makeRow({ spendingCutRate: 1 }),
        makeRow({
          id: 'stress',
          scenarioId: 'sequence_risk',
          scenarioName: 'Bad early markets',
          scenarioKind: 'stress',
          solvencyRate: 0.9,
          legacyAttainmentRate: 0.75,
          first10YearFailureRisk: 0.02,
          spendingCutRate: 1,
        }),
      ],
      seedAudits: [makeAudit()],
    });

    expect(result.verdict).toBe('green');
  });

  it('returns red for a baseline solvency breach', () => {
    const result = classifyPolicyCertificationRows({
      rows: [makeRow({ solvencyRate: 0.89 })],
      seedAudits: [makeAudit()],
    });
    expect(result.verdict).toBe('red');
    expect(result.reasons.some((reason) => reason.code === 'baseline_solvency_red')).toBe(true);
  });

  it('treats every supplied basis row as blocking evidence', () => {
    const result = classifyPolicyCertificationRows({
      rows: [
        makeRow({
          basisId: 'current_faithful',
          basisLabel: 'Current faithful',
          legacyAttainmentRate: 0.82,
        }),
        makeRow({
          id: 'jp',
          basisId: 'jpmorgan_curve_travel_included',
          basisLabel: 'J.P. Morgan Curve, Travel Included',
          legacyAttainmentRate: 0.95,
        }),
      ],
      seedAudits: [
        makeAudit(),
        makeAudit({
          basisId: 'jpmorgan_curve_travel_included',
          basisLabel: 'J.P. Morgan Curve, Travel Included',
        }),
      ],
    });
    expect(result.verdict).toBe('yellow');
    expect(result.reasons.some((reason) => reason.code === 'north_star_legacy_watch')).toBe(true);
  });

  it('downgrades green to yellow when seed stability misses the green band', () => {
    const result = classifyPolicyCertificationRows({
      rows: [makeRow()],
      seedAudits: [
        makeAudit({
          worstSolvencyRate: 0.92,
          worstLegacyAttainmentRate: 0.84,
        }),
      ],
    });
    expect(result.verdict).toBe('yellow');
    expect(result.reasons.some((reason) => reason.code === 'seed_stability_yellow')).toBe(true);
  });
});

describe('runPolicyCertification', () => {
  it('certifies the selected spending basis as the operating plan', async () => {
    const pack = await runPolicyCertification({
      policy: POLICY,
      baseline: makeSeed(),
      assumptions: ASSUMPTIONS,
      baselineFingerprint: 'baseline-fp',
      engineVersion: 'engine-test',
      legacyTargetTodayDollars: 1_000_000,
      cloner: (seed) => JSON.parse(JSON.stringify(seed)) as SeedData,
      spendingScheduleBasis: {
        id: 'jpmorgan_curve_travel_included',
        label: 'J.P. Morgan Curve, Travel Included',
        multipliersByYear: {
          2026: 1,
          2027: 0.9,
        },
      },
      scenarios: [],
      yieldEveryMs: 0,
    });

    const options = mockedBuildPathResults.mock.calls.map((call) => call[4]);
    expect(options.every((option) => option.annualSpendScheduleByYear !== undefined)).toBe(true);
    expect(
      options.every(
        (option) =>
          option.annualSpendScheduleByYear?.[2026] === 120_000 &&
          option.annualSpendScheduleByYear?.[2027] === 108_000,
      ),
    ).toBe(true);
    expect(new Set(pack.rows.map((row) => row.basisId))).toEqual(
      new Set(['jpmorgan_curve_travel_included']),
    );
    expect(new Set(pack.seedAudits.map((audit) => audit.basisId))).toEqual(
      new Set(['jpmorgan_curve_travel_included']),
    );
    expect(pack.selectedPathEvidence?.basisId).toBe(
      'jpmorgan_curve_travel_included',
    );
    expect(pack.guardrail.modeledAssetPath.length).toBeGreaterThan(0);
  });

  it('does not drop a shaped Current Faithful basis during certification', async () => {
    const pack = await runPolicyCertification({
      policy: POLICY,
      baseline: makeSeed(),
      assumptions: ASSUMPTIONS,
      baselineFingerprint: 'baseline-fp',
      engineVersion: 'engine-test',
      legacyTargetTodayDollars: 1_000_000,
      cloner: (seed) => JSON.parse(JSON.stringify(seed)) as SeedData,
      spendingScheduleBasis: {
        id: 'current_faithful',
        label: 'Current Faithful spending path',
        multipliersByYear: {
          2026: 1,
          2027: 0.95,
        },
      },
      scenarios: [],
      yieldEveryMs: 0,
    });

    const options = mockedBuildPathResults.mock.calls.map((call) => call[4]);
    expect(
      options.every(
        (option) =>
          option.annualSpendScheduleByYear?.[2026] === 120_000 &&
          option.annualSpendScheduleByYear?.[2027] === 114_000,
      ),
    ).toBe(true);
    expect(new Set(pack.rows.map((row) => row.basisId))).toEqual(
      new Set(['current_faithful']),
    );
    expect(pack.metadata.selectedSpendingBasisId).toBe('current_faithful');
    expect(pack.metadata.selectedSpendingBasisLabel).toBe(
      'Current Faithful spending path',
    );
  });
});
