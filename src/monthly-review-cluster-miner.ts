import { recommendCombinedPass2 } from './combined-pass2-analyzer';
import {
  MONTHLY_REVIEW_POLICY_TRIAL_BUDGET,
  MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION,
} from './monthly-review-flow-debug';
import type { MonthlyReviewStrategyDefinition } from './monthly-review';
import {
  POLICY_MINING_REFINEMENT_MAX_WINDOW_DOLLARS,
  POLICY_MINING_REFINEMENT_TRIAL_COUNT,
  POLICY_MINING_TRIAL_COUNT,
} from './policy-mining-config';
import {
  loadClusterEvaluations,
  loadClusterSessions,
} from './policy-mining-cluster';
import type { PolicyAxes, PolicyEvaluation } from './policy-miner-types';
import {
  LEGACY_ATTAINMENT_FLOOR,
  SOLVENCY_DEFENSE_FLOOR,
} from './policy-ranker';
import type { MarketAssumptions, SeedData } from './types';
import type { UseClusterSession } from './useClusterSession';

export interface MonthlyReviewClusterRef {
  current: UseClusterSession;
}

export interface MineMonthlyReviewStrategyInput {
  strategy: MonthlyReviewStrategyDefinition;
  strategyFingerprint: string;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  legacyTargetTodayDollars: number;
  dispatcherUrl: string;
  clusterRef: MonthlyReviewClusterRef;
  setMessage: (message: string) => void;
  logEvent?: (message: string) => void;
}

export function makeMonthlyReviewMiningSeed(strategyFingerprint: string): number {
  const max = 2_147_483_647;
  const text = `monthly-review-seed-v1|${strategyFingerprint}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 1 + (hash % max);
}

function maxContiguousSpendWindow(spends: readonly number[]): number {
  if (spends.length < 2) return 0;
  const sorted = Array.from(new Set(spends)).sort((a, b) => a - b);
  let start = sorted[0]!;
  let end = sorted[0]!;
  let maxWindow = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const spend = sorted[i]!;
    if (spend === end + 1_000) {
      end = spend;
      continue;
    }
    maxWindow = Math.max(maxWindow, end - start);
    start = spend;
    end = spend;
  }
  return Math.max(maxWindow, end - start);
}

export function chooseMonthlyReviewPass2TrialCount(
  baseTrialCount: number,
  hasCliff: boolean,
  spends: readonly number[],
): number {
  if (!hasCliff) return baseTrialCount;
  const window = maxContiguousSpendWindow(spends);
  if (window > POLICY_MINING_REFINEMENT_MAX_WINDOW_DOLLARS) {
    return baseTrialCount;
  }
  return Math.max(baseTrialCount, POLICY_MINING_REFINEMENT_TRIAL_COUNT);
}

function maxPoliciesForTrialBudget(trialCount: number, strategyCount = 1): number {
  return Math.max(
    1,
    Math.floor(
      MONTHLY_REVIEW_POLICY_TRIAL_BUDGET /
        Math.max(1, strategyCount) /
        Math.max(1, trialCount),
    ),
  );
}

const MONTHLY_REVIEW_MIN_PASS2_POLICIES_WHEN_CAPPED = 10;

export function shouldApplyMonthlyReviewPass2TrialBudget(): boolean {
  return MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION;
}

function chooseCappedMonthlyReviewPass2TrialCount(input: {
  baseTrialCount: number;
  hasCliff: boolean;
  spends: readonly number[];
}): number {
  const preferred = chooseMonthlyReviewPass2TrialCount(
    input.baseTrialCount,
    input.hasCliff,
    input.spends,
  );
  if (!MONTHLY_REVIEW_SKIP_REAL_CERTIFICATION) return preferred;
  if (
    maxPoliciesForTrialBudget(preferred) >=
    MONTHLY_REVIEW_MIN_PASS2_POLICIES_WHEN_CAPPED
  ) {
    return preferred;
  }
  return input.baseTrialCount;
}

export function mergeMonthlyReviewMiningPasses(
  pass1: readonly PolicyEvaluation[],
  pass2: readonly PolicyEvaluation[],
): PolicyEvaluation[] {
  const byId = new Map(pass1.map((evaluation) => [evaluation.id, evaluation]));
  for (const evaluation of pass2) {
    byId.set(evaluation.id, evaluation);
  }
  return Array.from(byId.values());
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function hasUsableMonthlyReviewClusterConnection(
  cluster: UseClusterSession,
): boolean {
  return cluster.snapshot.state === 'connected' && !!cluster.snapshot.peerId;
}

export async function waitForMonthlyReviewClusterConnected(input: {
  clusterRef: MonthlyReviewClusterRef;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  if (!hasUsableMonthlyReviewClusterConnection(input.clusterRef.current)) {
    input.clusterRef.current.reconnect();
  }
  while (Date.now() - startedAt < input.timeoutMs) {
    if (hasUsableMonthlyReviewClusterConnection(input.clusterRef.current)) return;
    await sleep(250);
  }
  const snapshot = input.clusterRef.current.snapshot;
  throw new Error(
    snapshot.lastError
      ? `Cluster did not connect: ${snapshot.lastError}`
      : 'Cluster did not connect before the monthly review timeout.',
  );
}

async function startMonthlyReviewClusterSession(input: {
  clusterRef: MonthlyReviewClusterRef;
  sessionOptions: Parameters<UseClusterSession['startSession']>[0];
  setMessage: (message: string) => void;
  label: string;
}): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await waitForMonthlyReviewClusterConnected({
      clusterRef: input.clusterRef,
      timeoutMs: 30_000,
    });
    try {
      input.clusterRef.current.startSession(input.sessionOptions);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/cluster client not connected/i.test(message) || attempt === 4) {
        throw error;
      }
      input.setMessage(
        `${input.label}: reconnecting cluster controller before starting session...`,
      );
      input.clusterRef.current.reconnect();
      await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForMonthlyReviewSessionEnd(input: {
  clusterRef: MonthlyReviewClusterRef;
  dispatcherUrl: string;
  strategyFingerprint: string;
  startedAfterMs: number;
  timeoutMs: number;
  label: string;
  setMessage: (message: string) => void;
  logEvent?: (message: string) => void;
}): Promise<string> {
  const startedAt = Date.now();
  let seenSessionId: string | null = null;
  while (Date.now() - startedAt < input.timeoutMs) {
    const session = input.clusterRef.current.session;
    if (session) {
      seenSessionId = session.sessionId;
      const evaluated = session.stats?.policiesEvaluated ?? 0;
      const total = session.stats?.totalPolicies ?? 0;
      const progress =
        total > 0
          ? `${evaluated.toLocaleString()} / ${total.toLocaleString()} policies`
          : `${evaluated.toLocaleString()} policies`;
      input.setMessage(`${input.label}: ${progress}`);
    } else if (seenSessionId) {
      input.logEvent?.(`${input.label}: live session ended (${seenSessionId})`);
      return seenSessionId;
    } else {
      try {
        const sessions = await loadClusterSessions(input.dispatcherUrl);
        const matching = sessions.find((candidate) => {
          const started = Date.parse(candidate.manifest.startedAtIso);
          return (
            candidate.manifest.config.baselineFingerprint ===
              input.strategyFingerprint &&
            Number.isFinite(started) &&
            started >= input.startedAfterMs - 1_000
          );
        });
        if (matching?.summary) {
          input.logEvent?.(
            `${input.label}: dispatcher session completed (${matching.summary.evaluatedCount.toLocaleString()} evaluated, ${matching.summary.feasibleCount.toLocaleString()} feasible)`,
          );
          return matching.sessionId;
        }
        if (matching) {
          seenSessionId = matching.sessionId;
          input.setMessage(`${input.label}: dispatcher accepted session...`);
        }
      } catch {
        // Keep waiting on the live cluster snapshot; fetch errors are
        // transient while the dispatcher is busy or reconnecting.
      }
    }
    await sleep(500);
  }
  throw new Error(`${input.label} did not finish before the timeout.`);
}

async function fetchMonthlyReviewSessionEvaluations(input: {
  dispatcherUrl: string;
  sessionId: string;
}): Promise<PolicyEvaluation[]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const payload = await loadClusterEvaluations(
        input.dispatcherUrl,
        input.sessionId,
      );
      if (payload.evaluations.length > 0 || attempt >= 2) {
        return payload.evaluations;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(400 + attempt * 300);
  }
  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return [];
}

async function runMonthlyReviewMiningPass(input: {
  label: string;
  strategyFingerprint: string;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  legacyTargetTodayDollars: number;
  dispatcherUrl: string;
  clusterRef: MonthlyReviewClusterRef;
  explorationSeed: number;
  trialCount: number;
  strategy: MonthlyReviewStrategyDefinition;
  axesOverride?: PolicyAxes;
  maxPoliciesPerSession?: number;
  applyTrialBudget?: boolean;
  setMessage: (message: string) => void;
  logEvent?: (message: string) => void;
}): Promise<PolicyEvaluation[]> {
  const maxPolicies = input.applyTrialBudget
    ? Math.min(
        input.maxPoliciesPerSession ?? Number.MAX_SAFE_INTEGER,
        maxPoliciesForTrialBudget(input.trialCount),
      )
    : (input.maxPoliciesPerSession ?? Number.MAX_SAFE_INTEGER);
  const capped = maxPolicies < Number.MAX_SAFE_INTEGER;
  input.setMessage(
    capped
      ? `${input.label}: starting cluster session (${maxPolicies.toLocaleString()} policies max, ${(
          maxPolicies * input.trialCount
        ).toLocaleString()} policy-trials)...`
      : `${input.label}: starting full cluster session...`,
  );
  input.logEvent?.(
    capped
      ? `${input.label}: start requested (${maxPolicies.toLocaleString()} policies max, ${input.trialCount.toLocaleString()} trials each)`
      : `${input.label}: start requested (full corpus, ${input.trialCount.toLocaleString()} trials each)`,
  );
  const sessionStartRequestedAtMs = Date.now();
  await startMonthlyReviewClusterSession({
    clusterRef: input.clusterRef,
    label: input.label,
    setMessage: input.setMessage,
    sessionOptions: {
    baseline: input.baseline,
    assumptions: input.assumptions,
    baselineFingerprint: input.strategyFingerprint,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    feasibilityThreshold: LEGACY_ATTAINMENT_FLOOR,
    trialCount: input.trialCount,
    explorationSeed: input.explorationSeed,
    axesOverride: input.axesOverride,
    maxPoliciesPerSession: maxPolicies,
    spendingScheduleBasis: input.strategy.spendingScheduleBasis ?? undefined,
    },
  });
  const sessionId = await waitForMonthlyReviewSessionEnd({
    clusterRef: input.clusterRef,
    dispatcherUrl: input.dispatcherUrl,
    strategyFingerprint: input.strategyFingerprint,
    startedAfterMs: sessionStartRequestedAtMs,
    timeoutMs: 12 * 60 * 60 * 1_000,
    label: input.label,
    setMessage: input.setMessage,
    logEvent: input.logEvent,
  });
  input.setMessage(`${input.label}: loading session results...`);
  input.logEvent?.(`${input.label}: loading evaluations from ${sessionId}`);
  const evaluations = await fetchMonthlyReviewSessionEvaluations({
    dispatcherUrl: input.dispatcherUrl,
    sessionId,
  });
  input.logEvent?.(
    `${input.label}: loaded ${evaluations.length.toLocaleString()} evaluations`,
  );
  return evaluations;
}

export async function mineMonthlyReviewStrategy(
  input: MineMonthlyReviewStrategyInput,
): Promise<PolicyEvaluation[]> {
  const explorationSeed = makeMonthlyReviewMiningSeed(input.strategyFingerprint);
  input.logEvent?.(
    `${input.strategy.label}: deterministic mining seed ${explorationSeed}`,
  );
  const pass1 = await runMonthlyReviewMiningPass({
    label: `${input.strategy.label} pass 1`,
    strategyFingerprint: input.strategyFingerprint,
    baseline: input.baseline,
    assumptions: input.assumptions,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    dispatcherUrl: input.dispatcherUrl,
    clusterRef: input.clusterRef,
    explorationSeed,
    trialCount: POLICY_MINING_TRIAL_COUNT,
    strategy: input.strategy,
    setMessage: input.setMessage,
    logEvent: input.logEvent,
  });
  input.logEvent?.(
    `${input.strategy.label}: pass 1 analyzer received ${pass1.length.toLocaleString()} evaluations`,
  );
  const recommendation = recommendCombinedPass2(
    pass1,
    input.baseline,
    LEGACY_ATTAINMENT_FLOOR,
    'legacy',
    SOLVENCY_DEFENSE_FLOOR,
  );
  if (!recommendation.hasRecommendation) {
    input.setMessage(
      `${input.strategy.label}: pass 1 produced no pass-2 recommendation.`,
    );
    return pass1;
  }

  const pass2TrialCount = chooseCappedMonthlyReviewPass2TrialCount({
    baseTrialCount: POLICY_MINING_TRIAL_COUNT,
    hasCliff: recommendation.hasCliff,
    spends: recommendation.axes.annualSpendTodayDollars,
  });
  const pass2 = await runMonthlyReviewMiningPass({
    label: `${input.strategy.label} pass 2`,
    strategyFingerprint: input.strategyFingerprint,
    baseline: input.baseline,
    assumptions: input.assumptions,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    dispatcherUrl: input.dispatcherUrl,
    clusterRef: input.clusterRef,
    explorationSeed,
    trialCount: pass2TrialCount,
    strategy: input.strategy,
    axesOverride: recommendation.axes,
    maxPoliciesPerSession: recommendation.estimatedPass2Candidates,
    // The trial-budget cap exists for flow-debug runs where real
    // certification is intentionally skipped. In production review, pass 2
    // is the actual refinement/rule-sweep pass; capping a 20k-trial pass to
    // one or two policies silently starves the candidate set.
    applyTrialBudget: shouldApplyMonthlyReviewPass2TrialBudget(),
    setMessage: input.setMessage,
    logEvent: input.logEvent,
  });
  const merged = mergeMonthlyReviewMiningPasses(pass1, pass2);
  input.logEvent?.(
    `${input.strategy.label}: merged corpus has ${merged.length.toLocaleString()} evaluations`,
  );
  return merged;
}
