export type RandomSource = () => number;

export interface MonteCarloTrialSummary {
  success: boolean;
  endingWealth: number;
  failureYear: number | null;
}

export interface MonteCarloTrialContext {
  trialIndex: number;
  trialSeed: number;
  random: RandomSource;
}

export interface MonteCarloExecutionInput<TRunResult> {
  seed: number;
  trialCount: number;
  assumptionsVersion: string;
  runTrial: (context: MonteCarloTrialContext) => TRunResult;
  summarizeTrial: (result: TRunResult) => MonteCarloTrialSummary;
  onProgress?: (progress: number) => void;
  isCancelled?: () => boolean;
}

export interface MonteCarloExecutionOutput<TRunResult> {
  runs: TRunResult[];
  successRate: number;
  medianEndingWealth: number;
  percentileEndingWealth: {
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  };
  failureYearDistribution: Array<{
    year: number;
    count: number;
    rate: number;
  }>;
  worstOutcome: {
    endingWealth: number;
    success: boolean;
    failureYear: number | null;
  };
  bestOutcome: {
    endingWealth: number;
    success: boolean;
    failureYear: number | null;
  };
  metadata: {
    seed: number;
    trialCount: number;
    assumptionsVersion: string;
  };
}

export const SIMULATION_CANCELLED_ERROR = 'SIMULATION_CANCELLED';

function normalizeSeed(seed: number) {
  return (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
}

function mixSeed(seed: number, offset: number) {
  let value = (seed ^ (offset * 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

export function createSeededRandom(seed: number): RandomSource {
  let state = normalizeSeed(seed) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussianRandom(random: RandomSource) {
  let first = 0;
  let second = 0;
  while (first === 0) {
    first = random();
  }
  while (second === 0) {
    second = random();
  }
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

export function boundedNormal(
  mean: number,
  stdDev: number,
  min: number,
  max: number,
  random: RandomSource,
) {
  const sample = mean + gaussianRandom(random) * stdDev;
  return Math.min(max, Math.max(min, sample));
}

export function percentile(values: number[], fraction: number) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index];
}

export function median(values: number[]) {
  return percentile(values, 0.5);
}

function buildFailureYearDistribution(
  failureYears: Array<number | null>,
  totalTrials: number,
) {
  const counts = new Map<number, number>();
  failureYears.forEach((value) => {
    if (typeof value !== 'number') {
      return;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([year, count]) => ({
      year,
      count,
      rate: totalTrials > 0 ? count / totalTrials : 0,
    }));
}

export function executeDeterministicMonteCarlo<TRunResult>(
  input: MonteCarloExecutionInput<TRunResult>,
): MonteCarloExecutionOutput<TRunResult> {
  const trialCount = Math.max(1, Math.floor(input.trialCount));
  const seed = normalizeSeed(input.seed);
  const summaries: MonteCarloTrialSummary[] = [];
  const runs: TRunResult[] = [];
  input.onProgress?.(0);

  for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
    if (input.isCancelled?.()) {
      throw new Error(SIMULATION_CANCELLED_ERROR);
    }

    const trialSeed = mixSeed(seed, trialIndex + 1);
    const random = createSeededRandom(trialSeed);
    const run = input.runTrial({ trialIndex, trialSeed, random });
    const summary = input.summarizeTrial(run);
    runs.push(run);
    summaries.push(summary);

    input.onProgress?.((trialIndex + 1) / trialCount);
  }

  const endingWealths = summaries.map((item) => item.endingWealth);
  const successCount = summaries.filter((item) => item.success).length;
  const failureYearDistribution = buildFailureYearDistribution(
    summaries.map((item) => item.failureYear),
    trialCount,
  );

  const bestSummary = [...summaries].sort((left, right) => right.endingWealth - left.endingWealth)[0];
  const worstSummary = [...summaries].sort((left, right) => left.endingWealth - right.endingWealth)[0];

  return {
    runs,
    successRate: trialCount > 0 ? successCount / trialCount : 0,
    medianEndingWealth: median(endingWealths),
    percentileEndingWealth: {
      p10: percentile(endingWealths, 0.1),
      p25: percentile(endingWealths, 0.25),
      p50: percentile(endingWealths, 0.5),
      p75: percentile(endingWealths, 0.75),
      p90: percentile(endingWealths, 0.9),
    },
    failureYearDistribution,
    worstOutcome: {
      endingWealth: worstSummary?.endingWealth ?? 0,
      success: worstSummary?.success ?? false,
      failureYear: worstSummary?.failureYear ?? null,
    },
    bestOutcome: {
      endingWealth: bestSummary?.endingWealth ?? 0,
      success: bestSummary?.success ?? false,
      failureYear: bestSummary?.failureYear ?? null,
    },
    metadata: {
      seed,
      trialCount,
      assumptionsVersion: input.assumptionsVersion,
    },
  };
}

