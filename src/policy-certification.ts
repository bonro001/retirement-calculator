import { DEFAULT_STRESS_SCENARIOS, type StressScenario } from './policy-stress-test';
import { approximateBequestAttainmentRate } from './plan-evaluation';
import { policyId } from './policy-axis-enumerator';
import {
  applyPolicyToSeed,
  assumptionsForPolicy,
  buildPolicyAnnualSpendScheduleByYear,
  type SeedDataCloner,
} from './policy-miner-eval';
import type {
  Policy,
  PolicyEvaluation,
  PolicySpendingScheduleBasis,
} from './policy-miner-types';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults, type SimulationStressorKnobs } from './utils';

export type PolicyCertificationVerdict = 'green' | 'yellow' | 'red';

export type PolicyCertificationModeId = 'forward_parametric' | 'historical_precedent';

export type PolicyCertificationBasisId = 'current_faithful' | string;

export interface PolicyCertificationMetricRow {
  id: string;
  basisId: PolicyCertificationBasisId;
  basisLabel: string;
  mode: PolicyCertificationModeId;
  modeLabel: string;
  scenarioId: string;
  scenarioName: string;
  scenarioKind: 'baseline' | 'stress';
  seed: number;
  solvencyRate: number;
  legacyAttainmentRate: number;
  first10YearFailureRisk: number;
  spendingCutRate: number;
  p10EndingWealthTodayDollars: number;
  p50EndingWealthTodayDollars: number;
  worstFailureYear: number | null;
  mostLikelyFailureYear: number | null;
  failureConcentrationRate: number;
  appliedStressors: string[];
  durationMs: number;
}

export interface PolicyCertificationSeedAudit {
  basisId: PolicyCertificationBasisId;
  basisLabel: string;
  mode: PolicyCertificationModeId;
  modeLabel: string;
  seeds: number[];
  worstSolvencyRate: number;
  worstLegacyAttainmentRate: number;
}

export interface PolicyCertificationReason {
  level: PolicyCertificationVerdict;
  code: string;
  message: string;
}

export interface PolicyCertificationGuardrail {
  authorizedAnnualSpend: number;
  discretionaryThrottleAnnual: number;
  yellowTrigger: string;
  redTrigger: string;
  yellowResponse: string;
  redResponse: string;
  modeledAssetPath: Array<{
    year: number;
    p10Assets: number;
    p25AssetsEstimate: number;
    medianAssets: number;
  }>;
  inferredAssumptions: string[];
}

export interface PolicyCertificationSelectedPathEvidence {
  basisId: PolicyCertificationBasisId;
  basisLabel: string;
  mode: PolicyCertificationModeId;
  modeLabel: string;
  seed: number;
  outcome: PolicyEvaluation['outcome'];
  annualFederalTaxEstimate: number;
  medianLifetimeSpendTodayDollars: number;
  medianLifetimeFederalTaxTodayDollars: number;
  yearlyRows: Array<{
    year: number;
    medianSpending: number;
    medianFederalTax: number;
    medianMagi: number;
    medianAcaPremiumEstimate: number;
    medianAcaSubsidyEstimate: number;
    medianNetAcaCost: number;
    medianAssets: number;
    tenthPercentileAssets: number;
  }>;
}

export interface PolicyCertificationPack {
  verdict: PolicyCertificationVerdict;
  reasons: PolicyCertificationReason[];
  metadata: {
    policyId: string;
    baselineFingerprint: string;
    engineVersion: string;
    spendTarget: number;
    selectedSpendingBasisId: string | null;
    selectedSpendingBasisLabel: string | null;
    spendingBasisFingerprint: string;
    baseSeed: number;
    auditSeeds: number[];
    trialCount: number;
    assumptionsVersion?: string;
    generatedAtIso: string;
  };
  rows: PolicyCertificationMetricRow[];
  seedAudits: PolicyCertificationSeedAudit[];
  guardrail: PolicyCertificationGuardrail;
  selectedPathEvidence: PolicyCertificationSelectedPathEvidence | null;
}

export interface RunPolicyCertificationInput {
  policy: Policy;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  legacyTargetTodayDollars: number;
  cloner: SeedDataCloner;
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null;
  scenarios?: StressScenario[];
  generatedAtIso?: string;
  onProgress?: (completed: number, total: number) => void;
  yieldEveryMs?: number;
}

const CERTIFICATION_TRIAL_MINIMUM = 5_000;

const BASELINE_GREEN = {
  solvencyRate: 0.95,
  legacyAttainmentRate: 0.85,
  first10YearFailureRisk: 0.01,
  spendingCutRate: 0.10,
};

const STRESS_GREEN = {
  solvencyRate: 0.85,
  legacyAttainmentRate: 0.70,
  first10YearFailureRisk: 0.05,
  spendingCutRate: 0.25,
};

const BASELINE_RED = {
  solvencyRate: 0.90,
  first10YearFailureRisk: 0.03,
};

const STRESS_RED = {
  solvencyRate: 0.75,
  first10YearFailureRisk: 0.10,
};

const SEED_GREEN = {
  solvencyRate: 0.93,
};

const MODES: Array<{
  id: PolicyCertificationModeId;
  label: string;
  useHistoricalBootstrap: boolean;
}> = [
  {
    id: 'forward_parametric',
    label: 'Forward-looking',
    useHistoricalBootstrap: false,
  },
  {
    id: 'historical_precedent',
    label: 'Historical precedent',
    useHistoricalBootstrap: true,
  },
];

function roundRate(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function toTodayDollars(nominal: number, inflation: number, horizonYears: number): number {
  const factor = Math.pow(
    1 + Math.max(-0.99, inflation),
    Math.max(0, horizonYears),
  );
  return factor > 0 ? nominal / factor : nominal;
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  return `$${Math.round(value).toLocaleString()}`;
}

export function first10YearFailureRisk(
  failureYearDistribution: PathResult['failureYearDistribution'],
  startYear: number,
): number {
  const lastFirst10Year = startYear + 9;
  return roundRate(
    failureYearDistribution.reduce((total, item) => {
      if (item.year >= startYear && item.year <= lastFirst10Year) {
        return total + item.rate;
      }
      return total;
    }, 0),
  );
}

function mostLikelyFailure(
  failureYearDistribution: PathResult['failureYearDistribution'],
): { year: number | null; rate: number } {
  let best: { year: number | null; rate: number } = { year: null, rate: 0 };
  for (const item of failureYearDistribution) {
    if (item.rate > best.rate) {
      best = { year: item.year, rate: item.rate };
    }
  }
  return best;
}

function resolveStressorKnobs(
  stressorKnobs: StressScenario['stressorKnobs'] | undefined,
  seed: SeedData,
  policy: Policy,
): SimulationStressorKnobs | undefined {
  if (!stressorKnobs) return undefined;
  return typeof stressorKnobs === 'function'
    ? stressorKnobs(seed, policy)
    : stressorKnobs;
}

function basisFingerprint(basis: PolicySpendingScheduleBasis | null): string {
  if (!basis) return 'current_faithful';
  return JSON.stringify({
    id: basis.id,
    multipliersByYear: basis.multipliersByYear,
  });
}

// Certification proves the operating spending doctrine being adopted.
// Comparison rows belong in the model-review layer, not as blocking cert bases.
function buildBases(
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null,
): Array<{
  id: PolicyCertificationBasisId;
  label: string;
  scheduleBasis: PolicySpendingScheduleBasis | null;
}> {
  return [selectedOperatingBasis(spendingScheduleBasis)];
}

function selectedOperatingBasisId(
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null,
): PolicyCertificationBasisId {
  return spendingScheduleBasis?.id ?? 'current_faithful';
}

function selectedOperatingBasisLabel(
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null,
): string {
  return spendingScheduleBasis?.label ?? 'Current faithful';
}

function selectedOperatingBasis(
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null,
): {
  id: PolicyCertificationBasisId;
  label: string;
  scheduleBasis: PolicySpendingScheduleBasis | null;
} {
  if (spendingScheduleBasis) {
    return {
      id: spendingScheduleBasis.id,
      label: spendingScheduleBasis.label,
      scheduleBasis: spendingScheduleBasis,
    };
  }
  return {
    id: 'current_faithful',
    label: 'Current faithful',
    scheduleBasis: null,
  };
}

function metricRowFromPath(input: {
  path: PathResult;
  policy: Policy;
  basisId: PolicyCertificationBasisId;
  basisLabel: string;
  mode: PolicyCertificationModeId;
  modeLabel: string;
  scenarioId: string;
  scenarioName: string;
  scenarioKind: 'baseline' | 'stress';
  seed: number;
  legacyTargetTodayDollars: number;
  inflation: number;
  appliedStressors: string[];
  durationMs: number;
}): PolicyCertificationMetricRow {
  const horizonYears = input.path.yearlySeries?.length ?? 30;
  const deflate = (value: number) =>
    toTodayDollars(value, input.inflation, horizonYears);
  const p10Today = deflate(input.path.endingWealthPercentiles.p10);
  const p25Today = deflate(input.path.endingWealthPercentiles.p25);
  const p50Today = deflate(input.path.endingWealthPercentiles.p50);
  const p75Today = deflate(input.path.endingWealthPercentiles.p75);
  const p90Today = deflate(input.path.endingWealthPercentiles.p90);
  const legacyAttainmentRate =
    input.legacyTargetTodayDollars > 0
      ? approximateBequestAttainmentRate(input.legacyTargetTodayDollars, {
          p10: p10Today,
          p25: p25Today,
          p50: p50Today,
          p75: p75Today,
          p90: p90Today,
        })
      : 1;
  const startYear =
    input.path.yearlySeries[0]?.year ??
    input.path.failureYearDistribution[0]?.year ??
    new Date().getFullYear();
  const mostLikely = mostLikelyFailure(input.path.failureYearDistribution);

  return {
    id: [
      input.basisId,
      input.mode,
      input.scenarioId,
      input.seed,
      input.policy.annualSpendTodayDollars,
    ].join(':'),
    basisId: input.basisId,
    basisLabel: input.basisLabel,
    mode: input.mode,
    modeLabel: input.modeLabel,
    scenarioId: input.scenarioId,
    scenarioName: input.scenarioName,
    scenarioKind: input.scenarioKind,
    seed: input.seed,
    solvencyRate: roundRate(input.path.successRate),
    legacyAttainmentRate: roundRate(legacyAttainmentRate),
    first10YearFailureRisk: first10YearFailureRisk(
      input.path.failureYearDistribution,
      startYear,
    ),
    spendingCutRate: roundRate(input.path.spendingCutRate),
    p10EndingWealthTodayDollars: p10Today,
    p50EndingWealthTodayDollars: p50Today,
    worstFailureYear: input.path.worstOutcome?.failureYear ?? null,
    mostLikelyFailureYear: mostLikely.year,
    failureConcentrationRate: mostLikely.rate,
    appliedStressors: input.appliedStressors,
    durationMs: input.durationMs,
  };
}

function selectedPathEvidenceFromPath(input: {
  path: PathResult;
  basisId: PolicyCertificationBasisId;
  basisLabel: string;
  mode: PolicyCertificationModeId;
  modeLabel: string;
  seed: number;
  legacyTargetTodayDollars: number;
  inflation: number;
}): PolicyCertificationSelectedPathEvidence {
  const horizonYears = input.path.yearlySeries?.length ?? 30;
  const deflateEnding = (value: number) =>
    toTodayDollars(value, input.inflation, horizonYears);
  const p10 = deflateEnding(input.path.endingWealthPercentiles.p10);
  const p25 = deflateEnding(input.path.endingWealthPercentiles.p25);
  const p50 = deflateEnding(input.path.endingWealthPercentiles.p50);
  const p75 = deflateEnding(input.path.endingWealthPercentiles.p75);
  const p90 = deflateEnding(input.path.endingWealthPercentiles.p90);
  const firstYear = input.path.yearlySeries[0]?.year ?? new Date().getFullYear();
  const deflateYear = (value: number, year: number) =>
    toTodayDollars(value, input.inflation, Math.max(0, year - firstYear));
  const medianLifetimeSpendTodayDollars = input.path.yearlySeries.reduce(
    (total, year) => total + deflateYear(year.medianSpending, year.year),
    0,
  );
  const medianLifetimeFederalTaxTodayDollars = input.path.yearlySeries.reduce(
    (total, year) => total + deflateYear(year.medianFederalTax, year.year),
    0,
  );

  return {
    basisId: input.basisId,
    basisLabel: input.basisLabel,
    mode: input.mode,
    modeLabel: input.modeLabel,
    seed: input.seed,
    annualFederalTaxEstimate: input.path.annualFederalTaxEstimate,
    medianLifetimeSpendTodayDollars,
    medianLifetimeFederalTaxTodayDollars,
    outcome: {
      solventSuccessRate: input.path.successRate,
      bequestAttainmentRate:
        input.legacyTargetTodayDollars > 0
          ? approximateBequestAttainmentRate(input.legacyTargetTodayDollars, {
              p10,
              p25,
              p50,
              p75,
              p90,
            })
          : 1,
      p10EndingWealthTodayDollars: p10,
      p25EndingWealthTodayDollars: p25,
      p50EndingWealthTodayDollars: p50,
      p75EndingWealthTodayDollars: p75,
      p90EndingWealthTodayDollars: p90,
      medianLifetimeSpendTodayDollars,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars,
      irmaaExposureRate: input.path.irmaaExposureRate,
    },
    yearlyRows: input.path.yearlySeries.slice(0, 12).map((year) => ({
      year: year.year,
      medianSpending: year.medianSpending,
      medianFederalTax: year.medianFederalTax,
      medianMagi: year.medianMagi,
      medianAcaPremiumEstimate: year.medianAcaPremiumEstimate,
      medianAcaSubsidyEstimate: year.medianAcaSubsidyEstimate,
      medianNetAcaCost: year.medianNetAcaCost,
      medianAssets: year.medianAssets,
      tenthPercentileAssets: year.tenthPercentileAssets,
    })),
  };
}

function evaluateCertificationPath(input: {
  policy: Policy;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  cloner: SeedDataCloner;
  basis: PolicySpendingScheduleBasis | null;
  mode: (typeof MODES)[number];
  seed: number;
  trialCount: number;
  scenario: StressScenario;
}): { path: PathResult; appliedStressors: string[]; durationMs: number } {
  const startMs = Date.now();
  const policyForRun: Policy = { ...input.policy };
  const baseSeed = input.cloner(input.baseline);
  input.scenario.policyPatch?.(policyForRun, baseSeed);
  const seed = applyPolicyToSeed(baseSeed, policyForRun);
  input.scenario.seedPatch?.(seed, policyForRun);
  const assumptionsForRun = assumptionsForPolicy(
    {
      ...input.assumptions,
      simulationRuns: input.trialCount,
      simulationSeed: input.seed,
      useHistoricalBootstrap: input.mode.useHistoricalBootstrap,
      assumptionsVersion: input.assumptions.assumptionsVersion
        ? `${input.assumptions.assumptionsVersion}-cert-${input.mode.id}-${input.trialCount}`
        : `cert-${input.mode.id}-${input.trialCount}`,
    },
    policyForRun,
  );
  input.scenario.assumptionsPatch?.(assumptionsForRun, seed, policyForRun);
  const knownIds = new Set(seed.stressors?.map((s) => s.id) ?? []);
  const appliedStressors = input.scenario.stressorIds.filter((id) =>
    knownIds.has(id),
  );
  const paths = buildPathResults(
    seed,
    assumptionsForRun,
    appliedStressors,
    [],
    {
      annualSpendTarget: policyForRun.annualSpendTodayDollars,
      annualSpendScheduleByYear: buildPolicyAnnualSpendScheduleByYear(
        policyForRun,
        input.basis ?? undefined,
      ),
      pathMode: 'selected_only',
      stressorKnobs: resolveStressorKnobs(
        input.scenario.stressorKnobs,
        seed,
        policyForRun,
      ),
    },
  );
  const path = paths[0];
  if (!path) {
    throw new Error('Certification engine run returned no path result');
  }
  return {
    path,
    appliedStressors,
    durationMs: Date.now() - startMs,
  };
}

export function classifyPolicyCertificationRows(input: {
  rows: PolicyCertificationMetricRow[];
  seedAudits: PolicyCertificationSeedAudit[];
}): { verdict: PolicyCertificationVerdict; reasons: PolicyCertificationReason[] } {
  const reasons: PolicyCertificationReason[] = [];
  const baselineRows = input.rows.filter((row) => row.scenarioKind === 'baseline');
  const stressRows = input.rows.filter((row) => row.scenarioKind === 'stress');

  for (const row of baselineRows) {
    if (row.solvencyRate < BASELINE_RED.solvencyRate) {
      reasons.push({
        level: 'red',
        code: 'baseline_solvency_red',
        message: `${row.basisLabel} / ${row.modeLabel} baseline solvency is ${formatPct(row.solvencyRate)}, below the ${formatPct(BASELINE_RED.solvencyRate)} red line.`,
      });
    }
    if (row.first10YearFailureRisk > BASELINE_RED.first10YearFailureRisk) {
      reasons.push({
        level: 'red',
        code: 'baseline_first10_red',
        message: `${row.basisLabel} / ${row.modeLabel} first-10 failure risk is ${formatPct(row.first10YearFailureRisk)}, above the ${formatPct(BASELINE_RED.first10YearFailureRisk)} red line.`,
      });
    }
  }

  for (const row of stressRows) {
    if (row.solvencyRate < STRESS_RED.solvencyRate) {
      reasons.push({
        level: 'red',
        code: 'stress_solvency_red',
        message: `${row.scenarioName} under ${row.basisLabel} / ${row.modeLabel} solvency is ${formatPct(row.solvencyRate)}, below the ${formatPct(STRESS_RED.solvencyRate)} red line.`,
      });
    }
    if (row.first10YearFailureRisk > STRESS_RED.first10YearFailureRisk) {
      reasons.push({
        level: 'red',
        code: 'stress_first10_red',
        message: `${row.scenarioName} under ${row.basisLabel} / ${row.modeLabel} first-10 failure risk is ${formatPct(row.first10YearFailureRisk)}, above the ${formatPct(STRESS_RED.first10YearFailureRisk)} red line.`,
      });
    }
  }

  if (reasons.some((reason) => reason.level === 'red')) {
    return { verdict: 'red', reasons };
  }

  for (const row of baselineRows) {
    if (
      row.solvencyRate < BASELINE_GREEN.solvencyRate ||
      row.first10YearFailureRisk > BASELINE_GREEN.first10YearFailureRisk
    ) {
      reasons.push({
        level: 'yellow',
        code: 'baseline_not_green',
        message: `${row.basisLabel} / ${row.modeLabel} baseline is not sleep-well green: solvency ${formatPct(row.solvencyRate)}, first-10 failure ${formatPct(row.first10YearFailureRisk)}.`,
      });
    }
    if (row.legacyAttainmentRate < BASELINE_GREEN.legacyAttainmentRate) {
      reasons.push({
        level: 'yellow',
        code: 'north_star_legacy_watch',
        message: `${row.basisLabel} / ${row.modeLabel} North Star legacy attainment is ${formatPct(row.legacyAttainmentRate)} — below the ${formatPct(BASELINE_GREEN.legacyAttainmentRate)} watch threshold. Central case may not reach $1M. Adapt if trend continues.`,
      });
    }
  }

  for (const row of stressRows) {
    if (
      row.solvencyRate < STRESS_GREEN.solvencyRate ||
      row.legacyAttainmentRate < STRESS_GREEN.legacyAttainmentRate ||
      row.first10YearFailureRisk > STRESS_GREEN.first10YearFailureRisk
    ) {
      reasons.push({
        level: 'yellow',
        code: 'stress_not_green',
        message: `${row.scenarioName} under ${row.basisLabel} / ${row.modeLabel} is not sleep-well green: solvency ${formatPct(row.solvencyRate)}, legacy ${formatPct(row.legacyAttainmentRate)}, first-10 failure ${formatPct(row.first10YearFailureRisk)}.`,
      });
    }
  }

  for (const audit of input.seedAudits) {
    if (audit.worstSolvencyRate < SEED_GREEN.solvencyRate) {
      reasons.push({
        level: 'yellow',
        code: 'seed_stability_yellow',
        message: `${audit.basisLabel} / ${audit.modeLabel} seed audit bottoms at ${formatPct(audit.worstSolvencyRate)} solvency, below the green stability band.`,
      });
    }
  }

  if (reasons.some((reason) => reason.level === 'yellow')) {
    return { verdict: 'yellow', reasons };
  }

  return {
    verdict: 'green',
    reasons: [
      {
        level: 'green',
        code: 'sleep_well_green',
        message: 'All baseline, stress, and seed-stability gates cleared the sleep-well thresholds.',
      },
    ],
  };
}

function buildGuardrail(
  policy: Policy,
  referencePath: PathResult | null,
): PolicyCertificationGuardrail {
  const throttle = Math.max(
    5_000,
    Math.round((policy.annualSpendTodayDollars * 0.05) / 1_000) * 1_000,
  );
  const inferredAssumptions: string[] = [];
  const modeledAssetPath =
    referencePath?.yearlySeries.map((point) => {
      const p25Estimate =
        point.tenthPercentileAssets +
        (point.medianAssets - point.tenthPercentileAssets) * 0.5;
      return {
        year: point.year,
        p10Assets: point.tenthPercentileAssets,
        p25AssetsEstimate: p25Estimate,
        medianAssets: point.medianAssets,
      };
    }) ?? [];
  if (modeledAssetPath.length > 0) {
    inferredAssumptions.push(
      'P25 asset guardrail is estimated halfway between the engine P10 and median yearly asset paths until the engine exports an explicit P25 asset series.',
    );
  }
  return {
    authorizedAnnualSpend: policy.annualSpendTodayDollars,
    discretionaryThrottleAnnual: throttle,
    yellowTrigger:
      'Actual portfolio falls below the modeled p25 asset path for the current year.',
    redTrigger:
      'Actual portfolio falls below the modeled p10 asset path, or any certification red gate is breached.',
    yellowResponse: `Freeze the inflation raise and cut discretionary spending by ${formatMoney(throttle / 2)}/yr.`,
    redResponse: `Cut the full discretionary throttle (${formatMoney(throttle)}/yr) and rerun Mine plus certification before restoring spend.`,
    modeledAssetPath,
    inferredAssumptions,
  };
}

async function maybeYield(ms: number | undefined): Promise<void> {
  if (!ms || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPolicyCertification(
  input: RunPolicyCertificationInput,
): Promise<PolicyCertificationPack> {
  const scenarios = input.scenarios ?? DEFAULT_STRESS_SCENARIOS;
  const trialCount = Math.max(
    CERTIFICATION_TRIAL_MINIMUM,
    Math.floor(input.assumptions.simulationRuns),
  );
  const baseSeed = input.assumptions.simulationSeed ?? 20260416;
  const auditSeeds = [baseSeed, baseSeed + 101, baseSeed + 202];
  const bases = buildBases(input.spendingScheduleBasis);
  const total = bases.length * MODES.length * (auditSeeds.length + scenarios.length);
  let completed = 0;
  const rows: PolicyCertificationMetricRow[] = [];
  const seedAudits: PolicyCertificationSeedAudit[] = [];
  let referencePath: PathResult | null = null;
  let selectedPathEvidence: PolicyCertificationSelectedPathEvidence | null = null;
  const selectedBasisId = selectedOperatingBasisId(input.spendingScheduleBasis);
  const selectedBasisLabel = selectedOperatingBasisLabel(input.spendingScheduleBasis);
  const baselineScenario: StressScenario = {
    id: 'baseline',
    name: 'Baseline',
    description: 'Engine central case — no stressors applied.',
    stressorIds: [],
  };

  const markProgress = () => {
    completed += 1;
    input.onProgress?.(completed, total);
  };

  for (const basis of bases) {
    for (const mode of MODES) {
      const seedRows: PolicyCertificationMetricRow[] = [];
      for (const seed of auditSeeds) {
        await maybeYield(input.yieldEveryMs);
        const run = evaluateCertificationPath({
          policy: input.policy,
          baseline: input.baseline,
          assumptions: input.assumptions,
          cloner: input.cloner,
          basis: basis.scheduleBasis,
          mode,
          seed,
          trialCount,
          scenario: baselineScenario,
        });
        const row = metricRowFromPath({
          path: run.path,
          policy: input.policy,
          basisId: basis.id,
          basisLabel: basis.label,
          mode: mode.id,
          modeLabel: mode.label,
          scenarioId: baselineScenario.id,
          scenarioName: baselineScenario.name,
          scenarioKind: 'baseline',
          seed,
          legacyTargetTodayDollars: input.legacyTargetTodayDollars,
          inflation: input.assumptions.inflation ?? 0.025,
          appliedStressors: run.appliedStressors,
          durationMs: run.durationMs,
        });
        seedRows.push(row);
        if (
          seed === baseSeed &&
          basis.id === selectedBasisId &&
          mode.id === 'forward_parametric'
        ) {
          referencePath = run.path;
          selectedPathEvidence = selectedPathEvidenceFromPath({
            path: run.path,
            basisId: basis.id,
            basisLabel: basis.label,
            mode: mode.id,
            modeLabel: mode.label,
            seed,
            legacyTargetTodayDollars: input.legacyTargetTodayDollars,
            inflation: input.assumptions.inflation ?? 0.025,
          });
        }
        if (seed === baseSeed) {
          rows.push(row);
        }
        markProgress();
      }
      seedAudits.push({
        basisId: basis.id,
        basisLabel: basis.label,
        mode: mode.id,
        modeLabel: mode.label,
        seeds: [...auditSeeds],
        worstSolvencyRate: Math.min(...seedRows.map((row) => row.solvencyRate)),
        worstLegacyAttainmentRate: Math.min(
          ...seedRows.map((row) => row.legacyAttainmentRate),
        ),
      });

      for (const scenario of scenarios) {
        await maybeYield(input.yieldEveryMs);
        const run = evaluateCertificationPath({
          policy: input.policy,
          baseline: input.baseline,
          assumptions: input.assumptions,
          cloner: input.cloner,
          basis: basis.scheduleBasis,
          mode,
          seed: baseSeed,
          trialCount,
          scenario,
        });
        rows.push(
          metricRowFromPath({
            path: run.path,
            policy: input.policy,
            basisId: basis.id,
            basisLabel: basis.label,
            mode: mode.id,
            modeLabel: mode.label,
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            scenarioKind: 'stress',
            seed: baseSeed,
            legacyTargetTodayDollars: input.legacyTargetTodayDollars,
            inflation: input.assumptions.inflation ?? 0.025,
            appliedStressors: run.appliedStressors,
            durationMs: run.durationMs,
          }),
        );
        markProgress();
      }
    }
  }

  const classification = classifyPolicyCertificationRows({ rows, seedAudits });
  return {
    verdict: classification.verdict,
    reasons: classification.reasons,
    metadata: {
      policyId: policyId(input.policy, input.baselineFingerprint, input.engineVersion),
      baselineFingerprint: input.baselineFingerprint,
      engineVersion: input.engineVersion,
      spendTarget: input.policy.annualSpendTodayDollars,
      selectedSpendingBasisId:
        input.spendingScheduleBasis ? selectedBasisId : null,
      selectedSpendingBasisLabel:
        input.spendingScheduleBasis ? selectedBasisLabel : null,
      spendingBasisFingerprint: basisFingerprint(input.spendingScheduleBasis ?? null),
      baseSeed,
      auditSeeds,
      trialCount,
      assumptionsVersion: input.assumptions.assumptionsVersion,
      generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    },
    rows,
    seedAudits,
    guardrail: buildGuardrail(input.policy, referencePath),
    selectedPathEvidence,
  };
}
