import { parentPort } from 'node:worker_threads';
import { appendFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { MarketAssumptions, SeedData } from '../src/types';
import type { PolicyEvaluation, PolicyMinerShadowStats } from '../src/policy-miner-types';
import type { EngineCandidateRequest } from '../src/engine-compare';
import {
  buildPolicyMiningReplayInput,
  buildPolicyEvaluationFromSummary,
  assumptionsForPolicy,
  evaluatePolicy,
  evaluatePolicyWithSummary,
} from '../src/policy-miner-eval';
import type { SimulationRandomTape } from '../src/random-tape';
import type {
  PolicyMinerWorkerRequest,
  PolicyMinerWorkerResponse,
} from '../src/policy-miner-worker-types';
import { RustEngineClient } from './rust-engine-client';
import { NativeRustEngineClient } from './rust-engine-native-client';
import { comparePolicyMiningSummaries } from '../src/policy-mining-summary-contract';
import { candidateReplayPackageToRequest } from '../src/candidate-replay-package';

/**
 * Node-side policy-miner worker. Mirrors `src/policy-miner.worker.ts`
 * (the browser version) but uses Node's `worker_threads` instead of
 * the DOM Web Worker API.
 *
 * Why a parallel file rather than sharing the browser worker source:
 *  - Web Workers communicate via `self.postMessage` + `MessageEvent.data`
 *    while node:worker_threads use `parentPort.postMessage` and pass the
 *    data directly (no event wrapper).
 *  - Web Workers reference `DedicatedWorkerGlobalScope`; this file has
 *    no DOM lib in scope.
 *  - The browser worker imports `from './policy-miner'` (which pulls in
 *    `indexedDB`-touching modules in its import graph). This Node worker
 *    imports from the extracted-pure `./policy-miner-eval` module so the
 *    Node import graph stays browser-API-free.
 *
 * The wire protocol (PolicyMinerWorkerRequest/Response) is shared with
 * the browser worker by reusing the type module — meaning the host
 * dispatch code does not care which transport it's talking to.
 *
 * Lifecycle:
 *   1. Main process spawns this worker via `new Worker(...host-worker.ts)`.
 *   2. Main sends a `prime` for each session (one per baseline fingerprint).
 *   3. Main sends `run` messages with batches of policies.
 *   4. Worker replies with `result` (one PolicyEvaluation per input policy).
 *   5. On `cancel`, the worker drains the current policy and replies
 *      `cancelled` with whatever evaluations completed before the signal
 *      landed. The main process can re-issue the missing policies.
 *   6. On `unprime`, the worker drops the cached session payload to free
 *      memory (a fresh PDF import would otherwise sit pinned indefinitely).
 */

interface PrimedSession {
  data: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
  replayTapeCache: Map<string, SimulationRandomTape>;
}

if (!parentPort) {
  // Hard-fail: this module must run inside a worker_thread, never as a
  // standalone Node script. Doing so would silently no-op every message
  // — which is the worst kind of failure.
  throw new Error('cluster/host-worker.ts must be loaded as a worker_thread');
}

const port = parentPort;
const cancelledRequests = new Set<string>();
const primedSessions = new Map<string, PrimedSession>();
type EngineRuntime =
  | 'ts'
  | 'rust-shadow'
  | 'rust-dry-run'
  | 'rust-native-shadow'
  | 'rust-native-compact-shadow'
  | 'rust-native-compact';
type ShadowEngineRuntime = Exclude<EngineRuntime, 'ts' | 'rust-native-compact'>;
type TelemetryEngineRuntime = Exclude<EngineRuntime, 'ts'>;
const configuredEngineRuntime =
  process.env.ENGINE_RUNTIME ?? process.env.ENGINE_RUNTIME_DEFAULT;
const engineRuntime: EngineRuntime =
  configuredEngineRuntime === 'rust-shadow' ||
  configuredEngineRuntime === 'rust-dry-run' ||
  configuredEngineRuntime === 'rust-native-shadow' ||
  configuredEngineRuntime === 'rust-native-compact-shadow' ||
  configuredEngineRuntime === 'rust-native-compact'
    ? configuredEngineRuntime
    : 'ts';
const rustShadowLogPath = process.env.RUST_SHADOW_LOG_PATH;
const explicitRustDryRunOutputPath = process.env.RUST_DRY_RUN_OUTPUT_PATH
  ? resolve(process.env.RUST_DRY_RUN_OUTPUT_PATH)
  : null;
const replayTapeCacheEnabled = process.env.ENGINE_REPLAY_TAPE_CACHE !== '0';
type RustSummaryClient = {
  runPolicyMiningSummaryWithTiming: (
    request: EngineCandidateRequest,
  ) =>
    | ReturnType<RustEngineClient['runPolicyMiningSummaryWithTiming']>
    | ReturnType<NativeRustEngineClient['runPolicyMiningSummaryWithTiming']>;
  runPolicyMiningSummaryCompactWithTiming?: NativeRustEngineClient['runPolicyMiningSummaryCompactWithTiming'];
  close?: () => Promise<void> | void;
};
let rustClient: RustSummaryClient | null = null;

interface RuntimeTimingSample {
  tsEvaluationDurationMs?: number;
  tapeRecordDurationMs?: number;
  requestBuildDurationMs?: number;
  rustSummaryDurationMs?: number;
  rustIpcWriteDurationMs?: number;
  rustResponseWaitDurationMs?: number;
  rustResponseParseDurationMs?: number;
  rustTotalDurationMs?: number;
  compareDurationMs?: number;
  candidateRequestBytes?: number;
  candidateRequestDataBytes?: number;
  candidateRequestAssumptionsBytes?: number;
  candidateRequestTapeBytes?: number;
  candidateRequestTapeBytesSaved?: number;
  candidateRequestEnvelopeBytes?: number;
  rustResponseBytes?: number;
  tapeCacheHits?: number;
  tapeCacheMisses?: number;
  compactTapeCacheHits?: number;
  compactTapeCacheMisses?: number;
}

function post(msg: PolicyMinerWorkerResponse): void {
  port.postMessage(msg);
}

function cloneSeedData(value: SeedData): SeedData {
  // Node 17+ ships structuredClone in the global; tsx targets ≥20 so
  // this is always available. Falling back to JSON.parse(JSON.stringify)
  // would silently drop Date / Map / Set instances if SeedData ever
  // grows them — better to fail loudly than to corrupt the corpus.
  if (typeof structuredClone !== 'function') {
    throw new Error(
      'host-worker: structuredClone unavailable — Node 17+ required',
    );
  }
  return structuredClone(value);
}

function isShadowRuntime(runtime: EngineRuntime): runtime is ShadowEngineRuntime {
  return (
    runtime === 'rust-shadow' ||
    runtime === 'rust-dry-run' ||
    runtime === 'rust-native-shadow' ||
    runtime === 'rust-native-compact-shadow'
  );
}

function getRustClient(): RustSummaryClient {
  rustClient ??=
    engineRuntime === 'rust-native-shadow' ||
    engineRuntime === 'rust-native-compact-shadow' ||
    engineRuntime === 'rust-native-compact'
      ? new NativeRustEngineClient()
      : new RustEngineClient();
  return rustClient;
}

async function closeRustClient() {
  const client = rustClient;
  rustClient = null;
  await client?.close?.();
}

function emitJsonl(path: string, event: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify({
    timestampIso: new Date().toISOString(),
    ...event,
  })}\n`;
  appendFileSync(path, line);
}

function emitRustShadowEvent(event: Record<string, unknown>) {
  if (rustShadowLogPath) {
    emitJsonl(rustShadowLogPath, event);
    return;
  }
  console.warn(
    JSON.stringify({
      timestampIso: new Date().toISOString(),
      ...event,
    }),
  );
}

function safePathPart(value: unknown) {
  const text = String(value ?? 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text.length > 0 ? text.slice(0, 80) : 'unknown';
}

function defaultRustDryRunOutputPath(
  input: Awaited<ReturnType<typeof evaluatePolicyWithSummary>>,
  sessionId?: string,
) {
  const host = safePathPart(input.evaluation.evaluatedByNodeId || hostname());
  const session = safePathPart(sessionId ?? input.evaluation.baselineFingerprint);
  const runtime = safePathPart(engineRuntime);
  const engine = safePathPart(input.evaluation.engineVersion);
  return resolve(
    'out',
    'rust-dry-run',
    `${host}__${session}__${runtime}__${engine}__pid${process.pid}.jsonl`,
  );
}

function emitRustDryRunEvent(
  input: Awaited<ReturnType<typeof evaluatePolicyWithSummary>>,
  event: Record<string, unknown>,
  sessionId?: string,
) {
  emitJsonl(
    explicitRustDryRunOutputPath ?? defaultRustDryRunOutputPath(input, sessionId),
    event,
  );
}

function measureCandidateRequestSections(request: EngineCandidateRequest) {
  const dataBytes = Buffer.byteLength(JSON.stringify(request.data), 'utf8');
  const assumptionsBytes = Buffer.byteLength(
    JSON.stringify(request.assumptions),
    'utf8',
  );
  const tapeBytes = Buffer.byteLength(JSON.stringify(request.tape), 'utf8');
  const totalBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  return {
    candidateRequestDataBytes: dataBytes,
    candidateRequestAssumptionsBytes: assumptionsBytes,
    candidateRequestTapeBytes: tapeBytes,
    candidateRequestEnvelopeBytes: Math.max(
      0,
      totalBytes - dataBytes - assumptionsBytes - tapeBytes,
    ),
  };
}

function policyMiningTapeCacheKey(
  policy: import('../src/policy-miner-types').Policy,
  session: PrimedSession,
) {
  const { withdrawalRule: _withdrawalRule, ...tapeAssumptions } =
    assumptionsForPolicy(session.assumptions, policy) as MarketAssumptions & {
      withdrawalRule?: unknown;
    };
  // Summary replay tapes contain stochastic market/LTC inputs only. Current
  // policy axes such as spend, Social Security claim age, Roth cap, and
  // withdrawal rule do not change those draws, so one tape can be replayed
  // across the policy grid for a fixed session and assumption set.
  return JSON.stringify({
    strategyMode: 'planner_enhanced',
    assumptions: tapeAssumptions,
  });
}

function buildPolicyMiningReplayInputWithCache(
  policy: import('../src/policy-miner-types').Policy,
  session: PrimedSession,
) {
  if (!replayTapeCacheEnabled) {
    return {
      replayInput: buildPolicyMiningReplayInput(
        policy,
        session.data,
        session.assumptions,
        session.baselineFingerprint,
        session.engineVersion,
        cloneSeedData,
      ),
      cacheHit: false,
    };
  }
  const cacheKey = policyMiningTapeCacheKey(policy, session);
  const cachedTape = session.replayTapeCache.get(cacheKey);
  if (cachedTape) {
    return {
      replayInput: buildPolicyMiningReplayInput(
        policy,
        session.data,
        session.assumptions,
        session.baselineFingerprint,
        session.engineVersion,
        cloneSeedData,
        { replayTape: cachedTape },
      ),
      cacheHit: true,
    };
  }
  const replayInput = buildPolicyMiningReplayInput(
    policy,
    session.data,
    session.assumptions,
    session.baselineFingerprint,
    session.engineVersion,
    cloneSeedData,
  );
  session.replayTapeCache.set(cacheKey, replayInput.tape);
  return { replayInput, cacheHit: false };
}

async function runRustSummaryWithTiming(request: EngineCandidateRequest) {
  const client = getRustClient();
  if (
    engineRuntime !== 'rust-native-compact-shadow' &&
    engineRuntime !== 'rust-native-compact'
  ) {
    return client.runPolicyMiningSummaryWithTiming(request);
  }
  if (typeof client.runPolicyMiningSummaryCompactWithTiming !== 'function') {
    return client.runPolicyMiningSummaryWithTiming(request);
  }
  try {
    return client.runPolicyMiningSummaryCompactWithTiming(request);
  } catch (error) {
    emitRustShadowEvent({
      event: 'rust_native_compact_fallback',
      reason: error instanceof Error ? error.message : String(error),
    });
    return client.runPolicyMiningSummaryWithTiming(request);
  }
}

async function evaluatePolicyWithRustNativeCompact(
  policy: import('../src/policy-miner-types').Policy,
  session: PrimedSession,
): Promise<{ evaluation: PolicyEvaluation; timings: RuntimeTimingSample }> {
  const startMs = Date.now();
  const tapeStartedAt = performance.now();
  const { replayInput, cacheHit } = buildPolicyMiningReplayInputWithCache(
    policy,
    session,
  );
  const tapeRecordDurationMs = performance.now() - tapeStartedAt;
  const requestBuildStartedAt = performance.now();
  const request: EngineCandidateRequest = {
    schemaVersion: 'engine-candidate-request-v1',
    data: replayInput.candidateData,
    assumptions: replayInput.candidateAssumptions,
    mode: replayInput.simulationMode,
    tape: replayInput.tape,
    annualSpendTarget: replayInput.annualSpendTarget,
    outputLevel: 'policy_mining_summary',
  };
  const requestBuildDurationMs = performance.now() - requestBuildStartedAt;
  const { summary, timings: rustTimings } = await runRustSummaryWithTiming(request);
  const evaluation = buildPolicyEvaluationFromSummary({
    policy,
    summary,
    assumptions: replayInput.candidateAssumptions,
    baselineFingerprint: session.baselineFingerprint,
    engineVersion: session.engineVersion,
    evaluatedByNodeId: session.evaluatedByNodeId,
    legacyTargetTodayDollars: session.legacyTargetTodayDollars,
    evaluationDurationMs: Date.now() - startMs,
  });
  return {
    evaluation,
    timings: {
      tapeRecordDurationMs,
      requestBuildDurationMs,
      rustSummaryDurationMs: rustTimings.totalDurationMs,
      rustIpcWriteDurationMs: rustTimings.ipcWriteDurationMs,
      rustResponseWaitDurationMs: rustTimings.responseWaitDurationMs,
      rustResponseParseDurationMs: rustTimings.responseParseDurationMs,
      rustTotalDurationMs: rustTimings.totalDurationMs,
      candidateRequestBytes: rustTimings.requestBytes,
      candidateRequestDataBytes: rustTimings.candidateRequestDataBytes,
      candidateRequestAssumptionsBytes: rustTimings.candidateRequestAssumptionsBytes,
      candidateRequestTapeBytes: rustTimings.candidateRequestTapeBytes,
      candidateRequestTapeBytesSaved:
        rustTimings.candidateRequestTapeBytesSaved,
      candidateRequestEnvelopeBytes: rustTimings.candidateRequestEnvelopeBytes,
      rustResponseBytes: rustTimings.responseBytes,
      compactTapeCacheHits: rustTimings.compactTapeCacheHits,
      compactTapeCacheMisses: rustTimings.compactTapeCacheMisses,
      tapeCacheHits: cacheHit ? 1 : 0,
      tapeCacheMisses: cacheHit ? 0 : 1,
    },
  };
}

process.once('beforeExit', () => {
  void closeRustClient();
});

async function shadowWithRust(
  input: Awaited<ReturnType<typeof evaluatePolicyWithSummary>>,
  timings?: RuntimeTimingSample,
): Promise<{
  status: 'matched' | 'mismatch' | 'error' | 'skipped';
  firstMismatch: PolicyMinerShadowStats['firstMismatch'];
  timings?: RuntimeTimingSample;
}> {
  if (!input.tape) {
    emitRustShadowEvent({
      event: 'rust_shadow_skipped',
      reason: 'missing_random_tape',
      policyId: input.evaluation.id,
      policy: input.evaluation.policy,
    });
    return { status: 'skipped', firstMismatch: null, timings };
  }
  try {
    const requestBuildStartedAt = performance.now();
    const request = candidateReplayPackageToRequest(
      input,
      'policy_mining_summary',
    );
    const requestBuildDurationMs = performance.now() - requestBuildStartedAt;
    const {
      summary: rustSummary,
      timings: rustTimings,
    } = await runRustSummaryWithTiming(request);
    const compareStartedAt = performance.now();
    const comparison = comparePolicyMiningSummaries(input.summary, rustSummary);
    const compareDurationMs = performance.now() - compareStartedAt;
    const resultTimings: RuntimeTimingSample = {
      ...timings,
      requestBuildDurationMs,
      rustSummaryDurationMs: rustTimings.totalDurationMs,
      rustIpcWriteDurationMs: rustTimings.ipcWriteDurationMs,
      rustResponseWaitDurationMs: rustTimings.responseWaitDurationMs,
      rustResponseParseDurationMs: rustTimings.responseParseDurationMs,
      rustTotalDurationMs: rustTimings.totalDurationMs,
      compareDurationMs,
      candidateRequestBytes: rustTimings.requestBytes,
      ...(engineRuntime === 'rust-native-compact-shadow'
        ? {
            candidateRequestDataBytes: rustTimings.candidateRequestDataBytes,
            candidateRequestAssumptionsBytes:
              rustTimings.candidateRequestAssumptionsBytes,
            candidateRequestTapeBytes: rustTimings.candidateRequestTapeBytes,
            candidateRequestTapeBytesSaved:
              rustTimings.candidateRequestTapeBytesSaved,
            candidateRequestEnvelopeBytes:
              rustTimings.candidateRequestEnvelopeBytes,
          }
        : measureCandidateRequestSections(request)),
      rustResponseBytes: rustTimings.responseBytes,
    };
    if (!comparison.pass) {
      emitRustShadowEvent({
        event: 'rust_shadow_summary_mismatch',
        policyId: input.evaluation.id,
        policy: input.evaluation.policy,
        baselineFingerprint: input.evaluation.baselineFingerprint,
        engineVersion: input.evaluation.engineVersion,
        mode: input.summary.simulationMode,
        trialCount: input.summary.monteCarloMetadata.trialCount,
        timings: resultTimings,
        firstDifference: comparison.firstDifference,
        tape: {
          seed: input.tape.seed,
          trialCount: input.tape.trialCount,
          planningHorizonYears: input.tape.planningHorizonYears,
          assumptionsVersion: input.tape.assumptionsVersion,
          samplingStrategy: input.tape.samplingStrategy,
          returnModel: input.tape.returnModel,
        },
      });
      const diff = comparison.firstDifference;
      return {
        status: 'mismatch',
        timings: resultTimings,
        firstMismatch: diff
          ? {
              policyId: input.evaluation.id,
              field: diff.field,
              expected: diff.expected,
              actual: diff.actual,
              delta: diff.delta,
              tolerance: diff.tolerance,
            }
          : null,
      };
    }
    return {
      status: 'matched',
      firstMismatch: null,
      timings: resultTimings,
    };
  } catch (error) {
    emitRustShadowEvent({
      event: 'rust_shadow_error',
      policyId: input.evaluation.id,
      policy: input.evaluation.policy,
      message: error instanceof Error ? error.message : String(error),
    });
    return { status: 'error', firstMismatch: null, timings };
  }
}

async function dryRunWithRust(
  input: Awaited<ReturnType<typeof evaluatePolicyWithSummary>>,
  timings?: RuntimeTimingSample & {
    sessionId?: string;
  },
): Promise<{
  status: 'matched' | 'mismatch' | 'error' | 'skipped';
  firstMismatch: PolicyMinerShadowStats['firstMismatch'];
  timings?: RuntimeTimingSample;
}> {
  if (!input.tape) {
    emitRustDryRunEvent(
      input,
      {
        event: 'rust_dry_run_skipped',
        reason: 'missing_random_tape',
        policyId: input.evaluation.id,
        policy: input.evaluation.policy,
      },
      timings?.sessionId,
    );
    return { status: 'skipped', firstMismatch: null, timings };
  }
  try {
    const requestBuildStartedAt = performance.now();
    const request = candidateReplayPackageToRequest(
      input,
      'policy_mining_summary',
    );
    const requestBuildDurationMs = performance.now() - requestBuildStartedAt;
    const requestSections = measureCandidateRequestSections(request);
    const {
      summary: rustSummary,
      timings: rustTimings,
    } = await getRustClient().runPolicyMiningSummaryWithTiming(request);
    const compareStartedAt = performance.now();
    const comparison = comparePolicyMiningSummaries(input.summary, rustSummary);
    const compareDurationMs = performance.now() - compareStartedAt;
    const resultTimings: RuntimeTimingSample = {
      ...timings,
      requestBuildDurationMs,
      rustSummaryDurationMs: rustTimings.totalDurationMs,
      rustIpcWriteDurationMs: rustTimings.ipcWriteDurationMs,
      rustResponseWaitDurationMs: rustTimings.responseWaitDurationMs,
      rustResponseParseDurationMs: rustTimings.responseParseDurationMs,
      rustTotalDurationMs: rustTimings.totalDurationMs,
      compareDurationMs,
      candidateRequestBytes: rustTimings.requestBytes,
      ...requestSections,
      rustResponseBytes: rustTimings.responseBytes,
    };
    emitRustDryRunEvent(
      input,
      {
        event: 'rust_dry_run_result',
        policyId: input.evaluation.id,
        policy: input.evaluation.policy,
        baselineFingerprint: input.evaluation.baselineFingerprint,
        engineVersion: input.evaluation.engineVersion,
        replayPackageVersion: input.packageVersion,
        mode: input.summary.simulationMode,
        outputLevel: 'policy_mining_summary',
        trialCount: input.summary.monteCarloMetadata.trialCount,
        timings: resultTimings,
        comparison,
        tsSummary: input.summary,
        rustSummary,
        tape: {
          seed: input.tape.seed,
          trialCount: input.tape.trialCount,
          planningHorizonYears: input.tape.planningHorizonYears,
          assumptionsVersion: input.tape.assumptionsVersion,
          samplingStrategy: input.tape.samplingStrategy,
          returnModel: input.tape.returnModel,
        },
      },
      timings?.sessionId,
    );
    const diff = comparison.firstDifference;
    const result: {
      status: 'matched' | 'mismatch';
      firstMismatch: PolicyMinerShadowStats['firstMismatch'];
    } = comparison.pass
      ? { status: 'matched', firstMismatch: null }
      : {
          status: 'mismatch',
          firstMismatch: diff
            ? {
                policyId: input.evaluation.id,
                field: diff.field,
                expected: diff.expected,
                actual: diff.actual,
                delta: diff.delta,
                tolerance: diff.tolerance,
              }
            : null,
        };
    return {
      ...result,
      timings: resultTimings,
    };
  } catch (error) {
    emitRustDryRunEvent(
      input,
      {
        event: 'rust_dry_run_error',
        policyId: input.evaluation.id,
        policy: input.evaluation.policy,
        message: error instanceof Error ? error.message : String(error),
      },
      timings?.sessionId,
    );
    return { status: 'error', firstMismatch: null, timings };
  }
}

function createShadowStats(runtime: TelemetryEngineRuntime): PolicyMinerShadowStats {
  return {
    runtime,
    evaluated: 0,
    mismatches: 0,
    errors: 0,
    skipped: 0,
    timings: {
      tsEvaluationDurationMsTotal: 0,
      rustSummaryDurationMsTotal: 0,
      tsEvaluationDurationMsAverage: 0,
      rustSummaryDurationMsAverage: 0,
      tapeRecordDurationMsTotal: 0,
      requestBuildDurationMsTotal: 0,
      rustIpcWriteDurationMsTotal: 0,
      rustResponseWaitDurationMsTotal: 0,
      rustResponseParseDurationMsTotal: 0,
      rustTotalDurationMsTotal: 0,
      compareDurationMsTotal: 0,
      candidateRequestBytesTotal: 0,
      candidateRequestDataBytesTotal: 0,
      candidateRequestAssumptionsBytesTotal: 0,
      candidateRequestTapeBytesTotal: 0,
      candidateRequestTapeBytesSavedTotal: 0,
      candidateRequestEnvelopeBytesTotal: 0,
      rustResponseBytesTotal: 0,
      tapeCacheHitsTotal: 0,
      tapeCacheMissesTotal: 0,
      compactTapeCacheHitsTotal: 0,
      compactTapeCacheMissesTotal: 0,
      tapeRecordDurationMsAverage: 0,
      requestBuildDurationMsAverage: 0,
      rustIpcWriteDurationMsAverage: 0,
      rustResponseWaitDurationMsAverage: 0,
      rustResponseParseDurationMsAverage: 0,
      rustTotalDurationMsAverage: 0,
      compareDurationMsAverage: 0,
      candidateRequestBytesAverage: 0,
      candidateRequestDataBytesAverage: 0,
      candidateRequestAssumptionsBytesAverage: 0,
      candidateRequestTapeBytesAverage: 0,
      candidateRequestTapeBytesSavedAverage: 0,
      candidateRequestEnvelopeBytesAverage: 0,
      rustResponseBytesAverage: 0,
      tapeCacheHitRate: 0,
      compactTapeCacheHitRate: 0,
    },
    firstMismatch: null,
  };
}

function recordShadowTimings(
  stats: PolicyMinerShadowStats,
  timings?: RuntimeTimingSample,
) {
  if (!stats.timings || !timings) return;
  stats.timings.tsEvaluationDurationMsTotal +=
    timings.tsEvaluationDurationMs ?? 0;
  stats.timings.rustSummaryDurationMsTotal +=
    timings.rustSummaryDurationMs ?? 0;
  stats.timings.tapeRecordDurationMsTotal =
    (stats.timings.tapeRecordDurationMsTotal ?? 0) +
    (timings.tapeRecordDurationMs ?? 0);
  stats.timings.requestBuildDurationMsTotal =
    (stats.timings.requestBuildDurationMsTotal ?? 0) +
    (timings.requestBuildDurationMs ?? 0);
  stats.timings.rustIpcWriteDurationMsTotal =
    (stats.timings.rustIpcWriteDurationMsTotal ?? 0) +
    (timings.rustIpcWriteDurationMs ?? 0);
  stats.timings.rustResponseWaitDurationMsTotal =
    (stats.timings.rustResponseWaitDurationMsTotal ?? 0) +
    (timings.rustResponseWaitDurationMs ?? 0);
  stats.timings.rustResponseParseDurationMsTotal =
    (stats.timings.rustResponseParseDurationMsTotal ?? 0) +
    (timings.rustResponseParseDurationMs ?? 0);
  stats.timings.rustTotalDurationMsTotal =
    (stats.timings.rustTotalDurationMsTotal ?? 0) +
    (timings.rustTotalDurationMs ?? 0);
  stats.timings.compareDurationMsTotal =
    (stats.timings.compareDurationMsTotal ?? 0) +
    (timings.compareDurationMs ?? 0);
  stats.timings.candidateRequestBytesTotal =
    (stats.timings.candidateRequestBytesTotal ?? 0) +
    (timings.candidateRequestBytes ?? 0);
  stats.timings.candidateRequestDataBytesTotal =
    (stats.timings.candidateRequestDataBytesTotal ?? 0) +
    (timings.candidateRequestDataBytes ?? 0);
  stats.timings.candidateRequestAssumptionsBytesTotal =
    (stats.timings.candidateRequestAssumptionsBytesTotal ?? 0) +
    (timings.candidateRequestAssumptionsBytes ?? 0);
  stats.timings.candidateRequestTapeBytesTotal =
    (stats.timings.candidateRequestTapeBytesTotal ?? 0) +
    (timings.candidateRequestTapeBytes ?? 0);
  stats.timings.candidateRequestTapeBytesSavedTotal =
    (stats.timings.candidateRequestTapeBytesSavedTotal ?? 0) +
    (timings.candidateRequestTapeBytesSaved ?? 0);
  stats.timings.candidateRequestEnvelopeBytesTotal =
    (stats.timings.candidateRequestEnvelopeBytesTotal ?? 0) +
    (timings.candidateRequestEnvelopeBytes ?? 0);
  stats.timings.rustResponseBytesTotal =
    (stats.timings.rustResponseBytesTotal ?? 0) +
    (timings.rustResponseBytes ?? 0);
  stats.timings.tapeCacheHitsTotal =
    (stats.timings.tapeCacheHitsTotal ?? 0) + (timings.tapeCacheHits ?? 0);
  stats.timings.tapeCacheMissesTotal =
    (stats.timings.tapeCacheMissesTotal ?? 0) + (timings.tapeCacheMisses ?? 0);
  stats.timings.compactTapeCacheHitsTotal =
    (stats.timings.compactTapeCacheHitsTotal ?? 0) +
    (timings.compactTapeCacheHits ?? 0);
  stats.timings.compactTapeCacheMissesTotal =
    (stats.timings.compactTapeCacheMissesTotal ?? 0) +
    (timings.compactTapeCacheMisses ?? 0);
  stats.timings.tsEvaluationDurationMsAverage =
    stats.evaluated > 0
      ? stats.timings.tsEvaluationDurationMsTotal / stats.evaluated
      : 0;
  stats.timings.rustSummaryDurationMsAverage =
    stats.evaluated > 0
      ? stats.timings.rustSummaryDurationMsTotal / stats.evaluated
      : 0;
  const average = (total: number | undefined) =>
    stats.evaluated > 0 ? (total ?? 0) / stats.evaluated : 0;
  stats.timings.tapeRecordDurationMsAverage = average(
    stats.timings.tapeRecordDurationMsTotal,
  );
  stats.timings.requestBuildDurationMsAverage = average(
    stats.timings.requestBuildDurationMsTotal,
  );
  stats.timings.rustIpcWriteDurationMsAverage = average(
    stats.timings.rustIpcWriteDurationMsTotal,
  );
  stats.timings.rustResponseWaitDurationMsAverage = average(
    stats.timings.rustResponseWaitDurationMsTotal,
  );
  stats.timings.rustResponseParseDurationMsAverage = average(
    stats.timings.rustResponseParseDurationMsTotal,
  );
  stats.timings.rustTotalDurationMsAverage = average(
    stats.timings.rustTotalDurationMsTotal,
  );
  stats.timings.compareDurationMsAverage = average(
    stats.timings.compareDurationMsTotal,
  );
  stats.timings.candidateRequestBytesAverage = average(
    stats.timings.candidateRequestBytesTotal,
  );
  stats.timings.candidateRequestDataBytesAverage = average(
    stats.timings.candidateRequestDataBytesTotal,
  );
  stats.timings.candidateRequestAssumptionsBytesAverage = average(
    stats.timings.candidateRequestAssumptionsBytesTotal,
  );
  stats.timings.candidateRequestTapeBytesAverage = average(
    stats.timings.candidateRequestTapeBytesTotal,
  );
  stats.timings.candidateRequestTapeBytesSavedAverage = average(
    stats.timings.candidateRequestTapeBytesSavedTotal,
  );
  stats.timings.candidateRequestEnvelopeBytesAverage = average(
    stats.timings.candidateRequestEnvelopeBytesTotal,
  );
  stats.timings.rustResponseBytesAverage = average(
    stats.timings.rustResponseBytesTotal,
  );
  const tapeCacheLookups =
    (stats.timings.tapeCacheHitsTotal ?? 0) +
    (stats.timings.tapeCacheMissesTotal ?? 0);
  stats.timings.tapeCacheHitRate =
    tapeCacheLookups > 0
      ? (stats.timings.tapeCacheHitsTotal ?? 0) / tapeCacheLookups
      : 0;
  const compactTapeCacheLookups =
    (stats.timings.compactTapeCacheHitsTotal ?? 0) +
    (stats.timings.compactTapeCacheMissesTotal ?? 0);
  stats.timings.compactTapeCacheHitRate =
    compactTapeCacheLookups > 0
      ? (stats.timings.compactTapeCacheHitsTotal ?? 0) /
        compactTapeCacheLookups
      : 0;
}

async function handleRun(payload: {
  requestId: string;
  sessionId: string;
  policies: import('../src/policy-miner-types').Policy[];
}): Promise<void> {
  const { requestId, sessionId, policies } = payload;
  cancelledRequests.delete(requestId);

  const session = primedSessions.get(sessionId);
  if (!session) {
    post({
      type: 'error',
      requestId,
      error: `host-worker: session ${sessionId} not primed`,
      partial: [],
    });
    return;
  }

  const startMs = Date.now();
  const evaluations: PolicyEvaluation[] = [];
  const shadowStats = engineRuntime !== 'ts'
    ? createShadowStats(engineRuntime)
    : undefined;
  try {
    for (const policy of policies) {
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        post({
          type: 'cancelled',
          requestId,
          partial: evaluations,
          shadowStats,
        });
        return;
      }
      if (engineRuntime === 'rust-native-compact') {
        const { evaluation, timings } = await evaluatePolicyWithRustNativeCompact(
          policy,
          session,
        );
        evaluations.push(evaluation);
        if (shadowStats) {
          shadowStats.evaluated += 1;
          recordShadowTimings(shadowStats, timings);
        }
      } else if (isShadowRuntime(engineRuntime)) {
        const tsStartedAt = Date.now();
        let policyTiming = { tapeRecordDurationMs: 0 };
        const run = await evaluatePolicyWithSummary(
          policy,
          session.data,
          session.assumptions,
          session.baselineFingerprint,
          session.engineVersion,
          session.evaluatedByNodeId,
          cloneSeedData,
          session.legacyTargetTodayDollars,
          {
            recordTape: true,
            onTiming: (timing) => {
              policyTiming = timing;
            },
          },
        );
        const tsEvaluationDurationMs = Date.now() - tsStartedAt;
        evaluations.push(run.evaluation);
        const baseTimings = {
          tsEvaluationDurationMs,
          tapeRecordDurationMs: policyTiming.tapeRecordDurationMs,
        };
        const shadow =
          engineRuntime === 'rust-dry-run'
            ? await dryRunWithRust(run, { ...baseTimings, sessionId })
            : await shadowWithRust(run, baseTimings);
        if (shadowStats) {
          shadowStats.evaluated += 1;
          recordShadowTimings(shadowStats, shadow.timings);
          if (shadow.status === 'mismatch') {
            shadowStats.mismatches += 1;
            shadowStats.firstMismatch ??= shadow.firstMismatch;
          } else if (shadow.status === 'error') {
            shadowStats.errors += 1;
          } else if (shadow.status === 'skipped') {
            shadowStats.skipped += 1;
          }
        }
      } else {
        // Per-policy: evaluatePolicy clones the primed seed internally
        // (via the cloner we pass) and runs the engine.
        const evaluation = await evaluatePolicy(
          policy,
          session.data,
          session.assumptions,
          session.baselineFingerprint,
          session.engineVersion,
          session.evaluatedByNodeId,
          cloneSeedData,
          session.legacyTargetTodayDollars,
        );
        evaluations.push(evaluation);
      }
    }
    post({
      type: 'result',
      requestId,
      evaluations,
      batchDurationMs: Date.now() - startMs,
      shadowStats,
    });
  } catch (error) {
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      post({
        type: 'cancelled',
        requestId,
        partial: evaluations,
        shadowStats,
      });
      return;
    }
    post({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : 'host-worker failed',
      partial: evaluations,
      shadowStats,
    });
  }
}

port.on('message', (message: PolicyMinerWorkerRequest) => {
  if (message.type === 'cancel') {
    cancelledRequests.add(message.requestId);
    return;
  }
  if (message.type === 'prime') {
    primedSessions.set(message.payload.sessionId, {
      data: message.payload.data,
      assumptions: message.payload.assumptions,
      baselineFingerprint: message.payload.baselineFingerprint,
      engineVersion: message.payload.engineVersion,
      evaluatedByNodeId: message.payload.evaluatedByNodeId,
      legacyTargetTodayDollars: message.payload.legacyTargetTodayDollars,
      replayTapeCache: new Map(),
    });
    return;
  }
  if (message.type === 'unprime') {
    primedSessions.delete(message.sessionId);
    return;
  }
  if (message.type === 'run') {
    void handleRun(message.payload);
    return;
  }
  // Unknown discriminator — ignore. Forward-compatible: a future host
  // main that learns a new request kind can deploy ahead of the worker
  // without crashing the pool.
});
