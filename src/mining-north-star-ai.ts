import type {
  PolicyEvaluation,
  PolicyMiningSessionConfig,
} from './policy-miner-types';
import {
  LEGACY_ATTAINMENT_FLOOR,
  SOLVENCY_DEFENSE_FLOOR,
} from './policy-ranker';

export type MiningNorthStarAiVerdict =
  | 'aligned'
  | 'watch'
  | 'misaligned'
  | 'insufficient_data';

export type MiningNorthStarFindingStatus = 'pass' | 'watch' | 'fail';

export interface MiningNorthStarAiCheckRequest {
  selectedPolicyId?: string | null;
  legacyTargetTodayDollars?: number;
  minFeasibility?: number;
  minSolvency?: number;
  topN?: number;
}

export interface MiningNorthStarCandidateSummary {
  id: string;
  annualSpendTodayDollars: number;
  primarySocialSecurityClaimAge: number;
  spouseSocialSecurityClaimAge: number | null;
  rothConversionAnnualCeiling: number;
  withdrawalRule: string | null;
  solventSuccessRate: number;
  bequestAttainmentRate: number;
  p10EndingWealthTodayDollars: number;
  p50EndingWealthTodayDollars: number;
  p90EndingWealthTodayDollars: number;
  medianLifetimeSpendTodayDollars: number;
  medianLifetimeFederalTaxTodayDollars: number;
  irmaaExposureRate: number;
}

export interface MiningNorthStarDeterministicFinding {
  id: string;
  status: MiningNorthStarFindingStatus;
  title: string;
  detail: string;
  evidence: string[];
}

export interface MiningNorthStarAiReviewInput {
  version: 'mining_north_star_review_input_v1';
  generatedAtIso: string;
  sessionId: string;
  baselineFingerprint: string;
  engineVersion: string;
  northStar: {
    legacyTargetTodayDollars: number;
    objective: 'maximize_early_spending_subject_to_legacy_and_solvency_gates';
    minLegacyAttainment: number;
    minSolvency: number;
  };
  spendingSchedule: {
    basisId: string | null;
    label: string | null;
    firstYear: number | null;
    lastYear: number | null;
    earlyAverageMultiplier: number | null;
    lateAverageMultiplier: number | null;
    earlyToLateRatio: number | null;
  };
  corpus: {
    evaluationCount: number;
    feasibleCount: number;
    spendLevelsTested: number[];
    highestSpendTestedTodayDollars: number | null;
    highestFeasibleSpendTodayDollars: number | null;
    withdrawalRulesTested: string[];
    selectedPolicyId: string | null;
    selectedPolicySource: 'request' | 'best_gate_passing' | 'none';
  };
  selectedCandidate: MiningNorthStarCandidateSummary | null;
  topGatePassingCandidates: MiningNorthStarCandidateSummary[];
  higherSpendAttempts: {
    count: number;
    spendLevels: number[];
    highestSpendTodayDollars: number | null;
    closestByLegacyGate: MiningNorthStarCandidateSummary | null;
    closestBySolvencyGate: MiningNorthStarCandidateSummary | null;
    sample: MiningNorthStarCandidateSummary[];
  };
  deterministicFindings: MiningNorthStarDeterministicFinding[];
}

export interface MiningNorthStarAiFinding {
  id: string;
  status: MiningNorthStarFindingStatus;
  title: string;
  detail: string;
  evidence: string[];
  recommendation?: string;
}

export interface MiningNorthStarAiCheck {
  version: 'mining_north_star_ai_check_v1';
  generatedAtIso: string;
  model: string;
  sessionId: string;
  baselineFingerprint: string;
  engineVersion: string;
  selectedPolicyId: string | null;
  northStar: MiningNorthStarAiReviewInput['northStar'];
  verdict: MiningNorthStarAiVerdict;
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  findings: MiningNorthStarAiFinding[];
  actionItems: string[];
  deterministicInput: MiningNorthStarAiReviewInput;
}

export interface BuildMiningNorthStarAiReviewInputArgs {
  sessionId: string;
  config: PolicyMiningSessionConfig;
  evaluations: PolicyEvaluation[];
  legacyTargetTodayDollars: number;
  request?: MiningNorthStarAiCheckRequest;
  generatedAtIso?: string;
}

const DEFAULT_TOP_CANDIDATES = 8;

function finiteOrNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

function distinctSortedNumbers(values: Iterable<number>): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function distinctSortedStrings(values: Iterable<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      Array.from(values)
        .filter((v): v is string => !!v && v.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function summarizeEvaluation(e: PolicyEvaluation): MiningNorthStarCandidateSummary {
  return {
    id: e.id,
    annualSpendTodayDollars: e.policy.annualSpendTodayDollars,
    primarySocialSecurityClaimAge: e.policy.primarySocialSecurityClaimAge,
    spouseSocialSecurityClaimAge: e.policy.spouseSocialSecurityClaimAge,
    rothConversionAnnualCeiling: e.policy.rothConversionAnnualCeiling,
    withdrawalRule: e.policy.withdrawalRule ?? null,
    solventSuccessRate: e.outcome.solventSuccessRate,
    bequestAttainmentRate: e.outcome.bequestAttainmentRate,
    p10EndingWealthTodayDollars: e.outcome.p10EndingWealthTodayDollars,
    p50EndingWealthTodayDollars: e.outcome.p50EndingWealthTodayDollars,
    p90EndingWealthTodayDollars: e.outcome.p90EndingWealthTodayDollars,
    medianLifetimeSpendTodayDollars: e.outcome.medianLifetimeSpendTodayDollars,
    medianLifetimeFederalTaxTodayDollars:
      e.outcome.medianLifetimeFederalTaxTodayDollars,
    irmaaExposureRate: e.outcome.irmaaExposureRate,
  };
}

function compareForNorthStar(a: PolicyEvaluation, b: PolicyEvaluation): number {
  const aspend = a.policy.annualSpendTodayDollars;
  const bspend = b.policy.annualSpendTodayDollars;
  if (aspend !== bspend) return bspend - aspend;
  const asolv = a.outcome.solventSuccessRate;
  const bsolv = b.outcome.solventSuccessRate;
  if (asolv !== bsolv) return bsolv - asolv;
  const alegacy = a.outcome.bequestAttainmentRate;
  const blegacy = b.outcome.bequestAttainmentRate;
  if (alegacy !== blegacy) return blegacy - alegacy;
  const ap50 = a.outcome.p50EndingWealthTodayDollars;
  const bp50 = b.outcome.p50EndingWealthTodayDollars;
  if (ap50 !== bp50) return bp50 - ap50;
  return a.id.localeCompare(b.id);
}

function buildScheduleSummary(
  config: PolicyMiningSessionConfig,
): MiningNorthStarAiReviewInput['spendingSchedule'] {
  const basis = config.spendingScheduleBasis;
  if (!basis) {
    return {
      basisId: null,
      label: null,
      firstYear: null,
      lastYear: null,
      earlyAverageMultiplier: null,
      lateAverageMultiplier: null,
      earlyToLateRatio: null,
    };
  }

  const rows = Object.entries(basis.multipliersByYear)
    .map(([year, multiplier]) => ({
      year: Number.parseInt(year, 10),
      multiplier,
    }))
    .filter(
      (r) => Number.isFinite(r.year) && Number.isFinite(r.multiplier),
    )
    .sort((a, b) => a.year - b.year);
  const firstYear = rows[0]?.year ?? null;
  const lastYear = rows.at(-1)?.year ?? null;
  const early = rows.slice(0, Math.min(10, rows.length));
  const late = rows.slice(Math.max(0, rows.length - 10));
  const avg = (items: typeof rows): number | null => {
    if (items.length === 0) return null;
    return items.reduce((sum, r) => sum + r.multiplier, 0) / items.length;
  };
  const earlyAverageMultiplier = avg(early);
  const lateAverageMultiplier = avg(late);
  const earlyToLateRatio =
    earlyAverageMultiplier !== null &&
    lateAverageMultiplier !== null &&
    lateAverageMultiplier > 0
      ? earlyAverageMultiplier / lateAverageMultiplier
      : null;

  return {
    basisId: basis.id,
    label: basis.label,
    firstYear,
    lastYear,
    earlyAverageMultiplier,
    lateAverageMultiplier,
    earlyToLateRatio: finiteOrNull(earlyToLateRatio ?? Number.NaN),
  };
}

function buildDeterministicFindings(args: {
  evaluations: PolicyEvaluation[];
  feasible: PolicyEvaluation[];
  selected: PolicyEvaluation | null;
  higherSpendAttempts: PolicyEvaluation[];
  legacyTargetTodayDollars: number;
  minLegacyAttainment: number;
  minSolvency: number;
  schedule: MiningNorthStarAiReviewInput['spendingSchedule'];
  withdrawalRulesTested: string[];
}): MiningNorthStarDeterministicFinding[] {
  const findings: MiningNorthStarDeterministicFinding[] = [];
  const {
    evaluations,
    feasible,
    selected,
    higherSpendAttempts,
    legacyTargetTodayDollars,
    minLegacyAttainment,
    minSolvency,
    schedule,
    withdrawalRulesTested,
  } = args;

  if (evaluations.length === 0) {
    findings.push({
      id: 'empty_corpus',
      status: 'fail',
      title: 'No mined evaluations are available',
      detail: 'The AI reviewer has no candidate outcomes to compare against the north star.',
      evidence: ['evaluationCount=0'],
    });
    return findings;
  }

  if (feasible.length === 0) {
    findings.push({
      id: 'no_gate_passing_candidate',
      status: 'fail',
      title: 'No candidate clears the legacy and solvency gates',
      detail:
        'The mined corpus has not found a policy that meets the minimum bequest-attainment and solvency constraints.',
      evidence: [
        `minLegacyAttainment=${minLegacyAttainment}`,
        `minSolvency=${minSolvency}`,
      ],
    });
  } else {
    findings.push({
      id: 'gate_passing_candidate_found',
      status: 'pass',
      title: 'At least one candidate clears the gates',
      detail:
        'The corpus contains decision-grade candidates under the configured legacy and solvency thresholds.',
      evidence: [`feasibleCount=${feasible.length}`],
    });
  }

  if (selected) {
    const legacyMultiple =
      legacyTargetTodayDollars > 0
        ? selected.outcome.p50EndingWealthTodayDollars / legacyTargetTodayDollars
        : null;
    if (legacyMultiple !== null && legacyMultiple > 3) {
      findings.push({
        id: 'median_legacy_overshoot',
        status: higherSpendAttempts.length > 0 ? 'watch' : 'fail',
        title: 'Median legacy is far above the target',
        detail:
          'The selected candidate may still be leaving too much unspent unless higher-spend candidates were tested and rejected by the gates.',
        evidence: [
          `p50EndingWealthTodayDollars=${Math.round(
            selected.outcome.p50EndingWealthTodayDollars,
          )}`,
          `legacyTargetTodayDollars=${Math.round(legacyTargetTodayDollars)}`,
          `multiple=${legacyMultiple.toFixed(1)}x`,
        ],
      });
    } else if (legacyMultiple !== null) {
      findings.push({
        id: 'median_legacy_near_target',
        status: 'pass',
        title: 'Median legacy is in range of the target',
        detail:
          'The selected candidate is not obviously hoarding wealth relative to the stated legacy goal.',
        evidence: [
          `p50EndingWealthTodayDollars=${Math.round(
            selected.outcome.p50EndingWealthTodayDollars,
          )}`,
          `legacyTargetTodayDollars=${Math.round(legacyTargetTodayDollars)}`,
          `multiple=${legacyMultiple.toFixed(1)}x`,
        ],
      });
    }
  }

  if (selected && higherSpendAttempts.length > 0) {
    findings.push({
      id: 'higher_spend_boundary_tested',
      status: 'pass',
      title: 'Higher spend levels were tested',
      detail:
        'The reviewer can compare the selected candidate against mined policies that spend more but failed at least one gate.',
      evidence: [
        `selectedSpend=${Math.round(selected.policy.annualSpendTodayDollars)}`,
        `higherSpendAttempts=${higherSpendAttempts.length}`,
      ],
    });
  } else if (selected) {
    findings.push({
      id: 'no_higher_spend_boundary',
      status: 'watch',
      title: 'No higher spend level was tested',
      detail:
        'The selected candidate is the highest spend present in the corpus, so the mine has not proven where the spending boundary actually is.',
      evidence: [
        `selectedSpend=${Math.round(selected.policy.annualSpendTodayDollars)}`,
      ],
    });
  }

  if (!schedule.basisId) {
    findings.push({
      id: 'constant_spend_shape',
      status: 'watch',
      title: 'Mine does not encode a front-loaded spend shape',
      detail:
        'The candidate axis is a single real annual spend number. That can maximize level spending, but it is not by itself a go-go/slow-go/no-go early-spending strategy.',
      evidence: ['spendingScheduleBasis=null'],
    });
  } else if (
    schedule.earlyToLateRatio !== null &&
    schedule.earlyToLateRatio >= 1.08
  ) {
    findings.push({
      id: 'front_loaded_schedule',
      status: 'pass',
      title: 'Spending schedule is front-loaded',
      detail:
        'The mining session used a spending basis with meaningfully higher early-year multipliers.',
      evidence: [`earlyToLateRatio=${schedule.earlyToLateRatio.toFixed(2)}`],
    });
  } else {
    findings.push({
      id: 'flat_or_late_loaded_schedule',
      status: 'watch',
      title: 'Spending schedule is not meaningfully front-loaded',
      detail:
        'The spending basis exists, but the early-years multiplier is close to or below the late-years multiplier.',
      evidence: [
        `earlyToLateRatio=${
          schedule.earlyToLateRatio === null
            ? 'unknown'
            : schedule.earlyToLateRatio.toFixed(2)
        }`,
      ],
    });
  }

  if (withdrawalRulesTested.length <= 1) {
    findings.push({
      id: 'withdrawal_order_not_swept',
      status: 'watch',
      title: 'Withdrawal ordering was not swept',
      detail:
        'The mine appears to test only one withdrawal rule. If account-ordering is a decision lever, add it to the mining axes before treating the result as final.',
      evidence: [
        `withdrawalRulesTested=${withdrawalRulesTested.join(',') || 'none'}`,
      ],
    });
  } else {
    findings.push({
      id: 'withdrawal_order_swept',
      status: 'pass',
      title: 'Withdrawal ordering is part of the mine',
      detail:
        'The corpus includes multiple withdrawal-order candidates, so the selected policy is not just optimizing spend and Social Security timing.',
      evidence: [`withdrawalRulesTested=${withdrawalRulesTested.join(',')}`],
    });
  }

  return findings;
}

export function buildMiningNorthStarAiReviewInput({
  sessionId,
  config,
  evaluations,
  legacyTargetTodayDollars,
  request,
  generatedAtIso = new Date().toISOString(),
}: BuildMiningNorthStarAiReviewInputArgs): MiningNorthStarAiReviewInput {
  const minLegacyAttainment =
    request?.minFeasibility ??
    config.feasibilityThreshold ??
    LEGACY_ATTAINMENT_FLOOR;
  const minSolvency = request?.minSolvency ?? SOLVENCY_DEFENSE_FLOOR;
  const requestedTarget =
    request?.legacyTargetTodayDollars &&
    Number.isFinite(request.legacyTargetTodayDollars) &&
    request.legacyTargetTodayDollars > 0
      ? request.legacyTargetTodayDollars
      : null;
  const northStarLegacyTarget =
    requestedTarget ?? legacyTargetTodayDollars;
  const topN =
    request?.topN && Number.isFinite(request.topN) && request.topN > 0
      ? Math.min(25, Math.floor(request.topN))
      : DEFAULT_TOP_CANDIDATES;

  const feasible = evaluations
    .filter(
      (e) =>
        e.outcome.bequestAttainmentRate >= minLegacyAttainment &&
        e.outcome.solventSuccessRate >= minSolvency,
    )
    .sort(compareForNorthStar);
  const bestGatePassing = feasible[0] ?? null;
  const requested =
    request?.selectedPolicyId
      ? evaluations.find((e) => e.id === request.selectedPolicyId) ?? null
      : null;
  const selected = requested ?? bestGatePassing;
  const selectedPolicySource: MiningNorthStarAiReviewInput['corpus']['selectedPolicySource'] =
    requested
      ? 'request'
      : bestGatePassing
        ? 'best_gate_passing'
        : 'none';

  const spendLevelsTested = distinctSortedNumbers(
    evaluations
      .map((e) => e.policy.annualSpendTodayDollars)
      .filter((n) => Number.isFinite(n)),
  );
  const withdrawalRulesTested = distinctSortedStrings([
    ...(config.axes.withdrawalRule ?? []),
    ...evaluations.map((e) => e.policy.withdrawalRule ?? null),
  ]);
  const higherSpendAttempts = selected
    ? evaluations.filter(
        (e) =>
          e.policy.annualSpendTodayDollars >
          selected.policy.annualSpendTodayDollars,
      )
    : [];
  const higherBySpend = [...higherSpendAttempts].sort((a, b) => {
    const spendDiff =
      b.policy.annualSpendTodayDollars - a.policy.annualSpendTodayDollars;
    if (spendDiff !== 0) return spendDiff;
    return compareForNorthStar(a, b);
  });
  const closestByLegacyGate = [...higherSpendAttempts]
    .filter((e) => e.outcome.bequestAttainmentRate < minLegacyAttainment)
    .sort((a, b) => {
      const gapA = minLegacyAttainment - a.outcome.bequestAttainmentRate;
      const gapB = minLegacyAttainment - b.outcome.bequestAttainmentRate;
      if (gapA !== gapB) return gapA - gapB;
      return compareForNorthStar(a, b);
    })[0] ?? null;
  const closestBySolvencyGate = [...higherSpendAttempts]
    .filter((e) => e.outcome.solventSuccessRate < minSolvency)
    .sort((a, b) => {
      const gapA = minSolvency - a.outcome.solventSuccessRate;
      const gapB = minSolvency - b.outcome.solventSuccessRate;
      if (gapA !== gapB) return gapA - gapB;
      return compareForNorthStar(a, b);
    })[0] ?? null;
  const schedule = buildScheduleSummary(config);

  const deterministicFindings = buildDeterministicFindings({
    evaluations,
    feasible,
    selected,
    higherSpendAttempts,
    legacyTargetTodayDollars: northStarLegacyTarget,
    minLegacyAttainment,
    minSolvency,
    schedule,
    withdrawalRulesTested,
  });

  return {
    version: 'mining_north_star_review_input_v1',
    generatedAtIso,
    sessionId,
    baselineFingerprint: config.baselineFingerprint,
    engineVersion: config.engineVersion,
    northStar: {
      legacyTargetTodayDollars: northStarLegacyTarget,
      objective: 'maximize_early_spending_subject_to_legacy_and_solvency_gates',
      minLegacyAttainment,
      minSolvency,
    },
    spendingSchedule: schedule,
    corpus: {
      evaluationCount: evaluations.length,
      feasibleCount: feasible.length,
      spendLevelsTested,
      highestSpendTestedTodayDollars: spendLevelsTested.at(-1) ?? null,
      highestFeasibleSpendTodayDollars:
        bestGatePassing?.policy.annualSpendTodayDollars ?? null,
      withdrawalRulesTested,
      selectedPolicyId: selected?.id ?? null,
      selectedPolicySource,
    },
    selectedCandidate: selected ? summarizeEvaluation(selected) : null,
    topGatePassingCandidates: feasible.slice(0, topN).map(summarizeEvaluation),
    higherSpendAttempts: {
      count: higherSpendAttempts.length,
      spendLevels: distinctSortedNumbers(
        higherSpendAttempts.map((e) => e.policy.annualSpendTodayDollars),
      ),
      highestSpendTodayDollars:
        higherBySpend[0]?.policy.annualSpendTodayDollars ?? null,
      closestByLegacyGate: closestByLegacyGate
        ? summarizeEvaluation(closestByLegacyGate)
        : null,
      closestBySolvencyGate: closestBySolvencyGate
        ? summarizeEvaluation(closestBySolvencyGate)
        : null,
      sample: higherBySpend.slice(0, topN).map(summarizeEvaluation),
    },
    deterministicFindings,
  };
}
