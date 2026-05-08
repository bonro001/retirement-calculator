import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialSeedData } from '../src/data';
import { DEFAULT_ENGINE_COMPARE_ASSUMPTIONS, type EngineCandidateRequest } from '../src/engine-compare';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
  policyId,
} from '../src/policy-axis-enumerator';
import {
  applyPolicyToSeed,
  assumptionsForPolicy,
  buildPolicyEvaluationFromSummary,
  evaluatePolicyWithSummary,
} from '../src/policy-miner-eval';
import { POLICY_MINER_ENGINE_VERSION, type Policy, type PolicyEvaluation } from '../src/policy-miner-types';
import { rankPolicies } from '../src/policy-ranker';
import type { MarketAssumptions, SeedData } from '../src/types';
import { buildPolicyMiningRandomTape } from '../src/utils';
import { NativeRustEngineClient } from '../cluster/rust-engine-native-client';
import type { RustEngineClientTiming } from '../cluster/rust-engine-client';
import type { SimulationRandomTape } from '../src/random-tape';

type Runtime = 'rust-native-compact' | 'ts';
type Mode = 'parametric' | 'historical';

interface CliOptions {
  policies: number;
  trials: number;
  repeats: number;
  runtime: Runtime;
  modes: Mode[];
  instrumentation: {
    taxCallCounts: boolean;
    moduleTimings: boolean;
  };
  csvPath: string;
  logDir: string;
  label: string;
  json: boolean;
  writeRequestPath: string | null;
}

interface ModuleTimingReport {
  calls: number;
  totalNs: number;
  totalMs: number;
  perCallUs: number;
}

interface InstrumentationTotals {
  taxCallCounts: Record<string, number>;
  moduleTimings: Record<string, ModuleTimingReport>;
}

interface ProofLadderRecommendation {
  module: string;
  calls: number;
  perCallUs: number;
  fullRemovalMs: number;
  recommendation: 'skip' | 'simplify-only' | 'one-k-ab' | 'full-5k-after-1k';
  rationale: string;
}

interface PhaseSamples {
  seedPrepMs: number[];
  tapeGenerationMs: number[];
  requestBuildMs: number[];
  nativeRequestSerializeMs: number[];
  nativeResponseWaitMs: number[];
  nativeResponseParseMs: number[];
  nativeTotalMs: number[];
  evaluationBuildMs: number[];
  perPolicyWallMs: number[];
}

interface PhaseTotals {
  enumerationMs: number;
  seedPrepMs: number;
  tapeGenerationMs: number;
  requestBuildMs: number;
  nativeRequestSerializeMs: number;
  nativeResponseWaitMs: number;
  nativeResponseParseMs: number;
  nativeTotalMs: number;
  evaluationBuildMs: number;
  rankingMs: number;
  outputMs: number;
}

interface RunReport {
  pass: true;
  timestampIso: string;
  label: string;
  host: string;
  platform: string;
  arch: string;
  osRelease: string;
  totalMemoryBytes: number;
  nodeVersion: string;
  git: {
    branch: string;
    commit: string;
    dirty: boolean;
  };
  runtime: Runtime;
  mode: Mode;
  repeatIndex: number;
  policiesRequested: number;
  policiesEvaluated: number;
  totalPolicyUniverse: number;
  trials: number;
  simulationSeed: number;
  assumptionsVersion: string;
  wallMs: number;
  phaseTotals: PhaseTotals;
  phaseShareOfWall: Record<keyof PhaseTotals, number>;
  perPolicy: {
    meanMs: number;
    medianMs: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
  };
  throughput: {
    policiesPerMinute: number;
    projected5000PoliciesMinutes: number;
    projectedFullUniverseMinutes: number;
  };
  caches: {
    replayTapeHits: number;
    replayTapeMisses: number;
    compactTapeHits: number;
    compactTapeMisses: number;
  };
  bytes: {
    requestBytesTotal: number;
    requestBytesAverage: number;
    requestTapeBytesTotal: number;
    requestTapeBytesSavedTotal: number;
    responseBytesTotal: number;
  };
  memory: {
    rssStartBytes: number;
    rssEndBytes: number;
    rssDeltaBytes: number;
    heapUsedStartBytes: number;
    heapUsedEndBytes: number;
    heapUsedDeltaBytes: number;
  };
  ranking: {
    rankedPolicyCount: number;
    bestPolicyId: string | null;
    bestAnnualSpendTodayDollars: number | null;
    bestSolventSuccessRate: number | null;
    bestBequestAttainmentRate: number | null;
  };
  artifacts: {
    reportPath: string;
    csvPath: string;
    representativeRequestPath: string | null;
  };
  instrumentation?: {
    requested: {
      taxCallCounts: boolean;
      moduleTimings: boolean;
    };
    taxCallCounts?: Record<string, number>;
    moduleTimings?: Record<string, ModuleTimingReport>;
    proofLadder?: ProofLadderRecommendation[];
  };
}

const DEFAULT_CSV_PATH = 'perf/cpu-baseline-history.csv';
const DEFAULT_LOG_DIR = 'out/cpu-baseline';

function printHelp() {
  process.stdout.write(`Usage:
  npm run perf:cpu-baseline
  npm run perf:cpu-baseline -- --policies 5000 --trials 5000 --repeats 1
  npm run perf:cpu-baseline -- --runtime ts --policies 200 --trials 1000

Options:
  --policies <n>          Representative policy count. Defaults to 100.
  --trials <n>            Trials per policy. Defaults to 1000.
  --repeats <n>           Repeat count. Defaults to 3.
  --runtime <name>        rust-native-compact or ts. Defaults to rust-native-compact.
  --mode <name>           parametric, historical, or both. Defaults to parametric.
  --instrument <list>     Comma list: tax-counters,tax,module-timers,module.
  --csv <path>            Append history CSV. Defaults to ${DEFAULT_CSV_PATH}.
  --log-dir <path>        Write JSON reports here. Defaults to ${DEFAULT_LOG_DIR}.
  --label <text>          Free-form run label.
  --write-request <path>  Write the first Rust EngineCandidateRequest JSON for flamegraph/allocation runs.
  --json                  Print machine-readable reports.`);
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    policies: 100,
    trials: 1000,
    repeats: 3,
    runtime: 'rust-native-compact',
    modes: ['parametric'],
    instrumentation: {
      taxCallCounts: false,
      moduleTimings: false,
    },
    csvPath: DEFAULT_CSV_PATH,
    logDir: DEFAULT_LOG_DIR,
    label: 'cpu-baseline',
    json: false,
    writeRequestPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--policies' && next) {
      options.policies = Number(next);
      index += 1;
    } else if (arg === '--trials' && next) {
      options.trials = Number(next);
      index += 1;
    } else if (arg === '--repeats' && next) {
      options.repeats = Number(next);
      index += 1;
    } else if (arg === '--runtime' && next) {
      if (next !== 'rust-native-compact' && next !== 'ts') {
        throw new Error(`Unsupported --runtime ${next}`);
      }
      options.runtime = next;
      index += 1;
    } else if (arg === '--mode' && next) {
      if (next === 'both') {
        options.modes = ['parametric', 'historical'];
      } else if (next === 'parametric' || next === 'historical') {
        options.modes = [next];
      } else {
        throw new Error(`Unsupported --mode ${next}`);
      }
      index += 1;
    } else if (arg === '--instrument' && next) {
      for (const rawName of next.split(',')) {
        const name = rawName.trim();
        if (name === 'tax-counters' || name === 'tax') {
          options.instrumentation.taxCallCounts = true;
        } else if (name === 'module-timers' || name === 'module' || name === 'timers') {
          options.instrumentation.moduleTimings = true;
        } else if (name === 'all') {
          options.instrumentation.taxCallCounts = true;
          options.instrumentation.moduleTimings = true;
        } else if (name.length > 0) {
          throw new Error(`Unsupported --instrument value ${name}`);
        }
      }
      index += 1;
    } else if (arg === '--csv' && next) {
      options.csvPath = next;
      index += 1;
    } else if (arg === '--log-dir' && next) {
      options.logDir = next;
      index += 1;
    } else if (arg === '--label' && next) {
      options.label = next;
      index += 1;
    } else if (arg === '--write-request' && next) {
      options.writeRequestPath = next;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  options.policies = Math.max(1, Math.floor(options.policies));
  options.trials = Math.max(1, Math.floor(options.trials));
  options.repeats = Math.max(1, Math.floor(options.repeats));
  return options;
}

function gitOutput(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function gitInfo() {
  return {
    branch: gitOutput(['branch', '--show-current']) || 'detached',
    commit: gitOutput(['rev-parse', '--short', 'HEAD']),
    dirty: gitOutput(['status', '--porcelain']).length > 0,
  };
}

function benchmarkId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function assumptionsForMode(options: CliOptions, mode: Mode): MarketAssumptions {
  return {
    ...DEFAULT_ENGINE_COMPARE_ASSUMPTIONS,
    simulationRuns: options.trials,
    useHistoricalBootstrap: mode === 'historical',
    assumptionsVersion: `cpu-baseline-${mode}-v1`,
  };
}

function cloneSeedData(seed: SeedData): SeedData {
  return structuredClone(seed);
}

function representativePolicies(policies: Policy[], limit: number): Policy[] {
  if (limit >= policies.length) return policies;
  const selected = new Map<string, Policy>();
  for (let index = 0; index < limit; index += 1) {
    const policyIndex = Math.min(
      policies.length - 1,
      Math.floor(((index + 0.5) * policies.length) / limit),
    );
    const policy = policies[policyIndex];
    selected.set(JSON.stringify(policy), policy);
  }
  if (selected.size < limit) {
    for (const policy of policies) {
      selected.set(JSON.stringify(policy), policy);
      if (selected.size >= limit) break;
    }
  }
  return Array.from(selected.values()).slice(0, limit);
}

function percentile(sortedAsc: number[], fraction: number) {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * fraction))] ?? 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]) {
  return values.length ? sum(values) / values.length : 0;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    meanMs: mean(values),
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function emptyInstrumentationTotals(): InstrumentationTotals {
  return {
    taxCallCounts: {},
    moduleTimings: {},
  };
}

function addNumericDiagnostics(
  target: Record<string, number>,
  source: unknown,
) {
  if (!source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

function addModuleTimingDiagnostics(
  target: Record<string, ModuleTimingReport>,
  source: unknown,
) {
  if (!source || typeof source !== 'object') return;
  for (const [module, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue;
    const calls = Number((value as Record<string, unknown>).calls ?? 0);
    const totalNs = Number((value as Record<string, unknown>).totalNs ?? 0);
    if (!Number.isFinite(calls) || !Number.isFinite(totalNs)) continue;
    const existing = target[module] ?? {
      calls: 0,
      totalNs: 0,
      totalMs: 0,
      perCallUs: 0,
    };
    existing.calls += calls;
    existing.totalNs += totalNs;
    existing.totalMs = existing.totalNs / 1_000_000;
    existing.perCallUs =
      existing.calls > 0 ? existing.totalNs / existing.calls / 1_000 : 0;
    target[module] = existing;
  }
}

function aggregateDiagnostics(
  totals: InstrumentationTotals,
  diagnostics: Record<string, unknown> | undefined,
) {
  if (!diagnostics) return;
  addNumericDiagnostics(totals.taxCallCounts, diagnostics.taxCallCounts);
  addModuleTimingDiagnostics(totals.moduleTimings, diagnostics.moduleTimings);
}

function proofRecommendationForMs(
  fullRemovalMs: number,
): ProofLadderRecommendation['recommendation'] {
  if (fullRemovalMs < 50) return 'skip';
  if (fullRemovalMs < 1000) return 'simplify-only';
  if (fullRemovalMs < 3000) return 'one-k-ab';
  return 'full-5k-after-1k';
}

function proofRationale(recommendation: ProofLadderRecommendation['recommendation']) {
  if (recommendation === 'skip') {
    return 'Even full removal is below the 50ms proof threshold.';
  }
  if (recommendation === 'simplify-only') {
    return 'Candidate savings are likely below clean 5K timing noise; only take tiny code simplifications.';
  }
  if (recommendation === 'one-k-ab') {
    return 'Large enough to prove with a quick 1K A/B before spending quiet-baseline time.';
  }
  return 'Large enough to justify a full 5K quiet rerun after a confirming 1K A/B.';
}

function buildProofLadder(
  moduleTimings: Record<string, ModuleTimingReport>,
): ProofLadderRecommendation[] {
  return Object.entries(moduleTimings)
    .map(([module, timing]) => {
      const recommendation = proofRecommendationForMs(timing.totalMs);
      return {
        module,
        calls: timing.calls,
        perCallUs: timing.perCallUs,
        fullRemovalMs: timing.totalMs,
        recommendation,
        rationale: proofRationale(recommendation),
      };
    })
    .sort((left, right) => right.fullRemovalMs - left.fullRemovalMs);
}

function emptyPhaseSamples(): PhaseSamples {
  return {
    seedPrepMs: [],
    tapeGenerationMs: [],
    requestBuildMs: [],
    nativeRequestSerializeMs: [],
    nativeResponseWaitMs: [],
    nativeResponseParseMs: [],
    nativeTotalMs: [],
    evaluationBuildMs: [],
    perPolicyWallMs: [],
  };
}

function policyMiningTapeCacheKey(assumptions: MarketAssumptions) {
  const { withdrawalRule: _withdrawalRule, ...tapeAssumptions } = assumptions as MarketAssumptions & {
    withdrawalRule?: unknown;
  };
  return JSON.stringify({
    strategyMode: 'planner_enhanced',
    assumptions: tapeAssumptions,
  });
}

function buildRequest(input: {
  policy: Policy;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  instrumentation: EngineCandidateRequest['instrumentation'];
  baselineFingerprint: string;
  engineVersion: string;
  tapeCache: Map<string, SimulationRandomTape>;
  samples: PhaseSamples;
  cacheStats: { replayTapeHits: number; replayTapeMisses: number };
}) {
  const seedPrepStartedAt = performance.now();
  const seed = applyPolicyToSeed(cloneSeedData(input.baseline), input.policy);
  const policyAssumptions = assumptionsForPolicy(input.assumptions, input.policy);
  input.samples.seedPrepMs.push(performance.now() - seedPrepStartedAt);

  const cacheKey = policyMiningTapeCacheKey(policyAssumptions);
  const cachedTape = input.tapeCache.get(cacheKey);
  let tape: SimulationRandomTape;
  if (cachedTape) {
    input.cacheStats.replayTapeHits += 1;
    tape = cachedTape;
    input.samples.tapeGenerationMs.push(0);
  } else {
    input.cacheStats.replayTapeMisses += 1;
    const tapeStartedAt = performance.now();
    tape = buildPolicyMiningRandomTape({
      data: seed,
      assumptions: policyAssumptions,
      annualSpendTarget: input.policy.annualSpendTodayDollars,
      label: `policy-miner:${policyId(
        input.policy,
        input.baselineFingerprint,
        input.engineVersion,
      )}`,
    });
    input.samples.tapeGenerationMs.push(performance.now() - tapeStartedAt);
    input.tapeCache.set(cacheKey, tape);
  }

  const requestBuildStartedAt = performance.now();
  const request: EngineCandidateRequest = {
    schemaVersion: 'engine-candidate-request-v1',
    data: seed,
    assumptions: policyAssumptions,
    mode: tape.simulationMode,
    tape,
    annualSpendTarget: input.policy.annualSpendTodayDollars,
    outputLevel: 'policy_mining_summary',
    ...(input.instrumentation?.taxCallCounts || input.instrumentation?.moduleTimings
      ? { instrumentation: input.instrumentation }
      : {}),
  };
  input.samples.requestBuildMs.push(performance.now() - requestBuildStartedAt);
  return { request, policyAssumptions };
}

function recordNativeTiming(samples: PhaseSamples, timings: RustEngineClientTiming) {
  samples.nativeRequestSerializeMs.push(timings.requestSerializeDurationMs);
  samples.nativeResponseWaitMs.push(timings.responseWaitDurationMs);
  samples.nativeResponseParseMs.push(timings.responseParseDurationMs);
  samples.nativeTotalMs.push(timings.totalDurationMs);
}

function addBytes(
  totals: RunReport['bytes'],
  timings: RustEngineClientTiming,
) {
  totals.requestBytesTotal += timings.requestBytes;
  totals.requestTapeBytesTotal += timings.candidateRequestTapeBytes ?? 0;
  totals.requestTapeBytesSavedTotal += timings.candidateRequestTapeBytesSaved ?? 0;
  totals.responseBytesTotal += timings.responseBytes;
}

async function runRustBaseline(input: {
  policies: Policy[];
  assumptions: MarketAssumptions;
  options: CliOptions;
  mode: Mode;
  repeatIndex: number;
  baselineFingerprint: string;
  engineVersion: string;
  representativeRequestState: { written: boolean; path: string | null };
}) {
  const samples = emptyPhaseSamples();
  const client = new NativeRustEngineClient();
  const evaluations: PolicyEvaluation[] = [];
  const tapeCache = new Map<string, SimulationRandomTape>();
  const cacheStats = {
    replayTapeHits: 0,
    replayTapeMisses: 0,
    compactTapeHits: 0,
    compactTapeMisses: 0,
  };
  const bytes = {
    requestBytesTotal: 0,
    requestBytesAverage: 0,
    requestTapeBytesTotal: 0,
    requestTapeBytesSavedTotal: 0,
    responseBytesTotal: 0,
  };
  const instrumentation = emptyInstrumentationTotals();

  try {
    for (const policy of input.policies) {
      const policyStartedAt = performance.now();
      const { request, policyAssumptions } = buildRequest({
        policy,
        baseline: initialSeedData,
        assumptions: input.assumptions,
        instrumentation: input.options.instrumentation,
        baselineFingerprint: input.baselineFingerprint,
        engineVersion: input.engineVersion,
        tapeCache,
        samples,
        cacheStats,
      });
      if (
        input.representativeRequestState.path &&
        !input.representativeRequestState.written
      ) {
        const requestPath = resolve(input.representativeRequestState.path);
        mkdirSync(dirname(requestPath), { recursive: true });
        writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
        input.representativeRequestState.written = true;
      }

      const { summary, timings, diagnostics } =
        client.runPolicyMiningSummaryCompactWithTiming(request);
      aggregateDiagnostics(instrumentation, diagnostics);
      recordNativeTiming(samples, timings);
      addBytes(bytes, timings);
      cacheStats.compactTapeHits += timings.compactTapeCacheHits ?? 0;
      cacheStats.compactTapeMisses += timings.compactTapeCacheMisses ?? 0;

      const evaluationBuildStartedAt = performance.now();
      evaluations.push(buildPolicyEvaluationFromSummary({
        policy,
        summary,
        assumptions: policyAssumptions,
        baselineFingerprint: input.baselineFingerprint,
        engineVersion: input.engineVersion,
        evaluatedByNodeId: hostname(),
        legacyTargetTodayDollars:
          initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000,
        evaluationDurationMs: performance.now() - policyStartedAt,
      }));
      samples.evaluationBuildMs.push(performance.now() - evaluationBuildStartedAt);
      samples.perPolicyWallMs.push(performance.now() - policyStartedAt);
    }
  } finally {
    await client.close();
  }

  bytes.requestBytesAverage =
    input.policies.length > 0 ? bytes.requestBytesTotal / input.policies.length : 0;
  return { samples, evaluations, cacheStats, bytes, instrumentation };
}

async function runTsBaseline(input: {
  policies: Policy[];
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
}) {
  const samples = emptyPhaseSamples();
  const evaluations: PolicyEvaluation[] = [];
  for (const policy of input.policies) {
    const policyStartedAt = performance.now();
    const run = await evaluatePolicyWithSummary(
      policy,
      initialSeedData,
      input.assumptions,
      input.baselineFingerprint,
      input.engineVersion,
      hostname(),
      cloneSeedData,
      initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000,
    );
    samples.nativeResponseWaitMs.push(performance.now() - policyStartedAt);
    samples.nativeTotalMs.push(performance.now() - policyStartedAt);
    samples.perPolicyWallMs.push(performance.now() - policyStartedAt);
    evaluations.push(run.evaluation);
  }
  return {
    samples,
    evaluations,
    cacheStats: {
      replayTapeHits: 0,
      replayTapeMisses: 0,
      compactTapeHits: 0,
      compactTapeMisses: 0,
    },
    bytes: {
      requestBytesTotal: 0,
      requestBytesAverage: 0,
      requestTapeBytesTotal: 0,
      requestTapeBytesSavedTotal: 0,
      responseBytesTotal: 0,
    },
    instrumentation: emptyInstrumentationTotals(),
  };
}

function phaseShares(totals: PhaseTotals, wallMs: number) {
  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [
      key,
      wallMs > 0 ? value / wallMs : 0,
    ]),
  ) as Record<keyof PhaseTotals, number>;
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  'timestampIso',
  'label',
  'host',
  'platform',
  'arch',
  'nodeVersion',
  'gitBranch',
  'gitCommit',
  'gitDirty',
  'runtime',
  'mode',
  'repeatIndex',
  'policies',
  'trials',
  'wallMs',
  'policiesPerMinute',
  'meanMsPerPolicy',
  'p95MsPerPolicy',
  'enumerationMs',
  'seedPrepMs',
  'tapeGenerationMs',
  'requestBuildMs',
  'nativeRequestSerializeMs',
  'nativeResponseWaitMs',
  'nativeResponseParseMs',
  'rankingMs',
  'outputMs',
  'replayTapeHitRate',
  'compactTapeHitRate',
  'requestBytesAverage',
  'requestTapeBytesTotal',
  'requestTapeBytesSavedTotal',
  'rssDeltaBytes',
  'heapUsedDeltaBytes',
  'bestPolicyId',
  'reportPath',
] as const;

function csvRow(report: RunReport) {
  const replayTapeDenominator =
    report.caches.replayTapeHits + report.caches.replayTapeMisses;
  const compactTapeDenominator =
    report.caches.compactTapeHits + report.caches.compactTapeMisses;
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    timestampIso: report.timestampIso,
    label: report.label,
    host: report.host,
    platform: report.platform,
    arch: report.arch,
    nodeVersion: report.nodeVersion,
    gitBranch: report.git.branch,
    gitCommit: report.git.commit,
    gitDirty: report.git.dirty,
    runtime: report.runtime,
    mode: report.mode,
    repeatIndex: report.repeatIndex,
    policies: report.policiesEvaluated,
    trials: report.trials,
    wallMs: report.wallMs.toFixed(3),
    policiesPerMinute: report.throughput.policiesPerMinute.toFixed(3),
    meanMsPerPolicy: report.perPolicy.meanMs.toFixed(3),
    p95MsPerPolicy: report.perPolicy.p95Ms.toFixed(3),
    enumerationMs: report.phaseTotals.enumerationMs.toFixed(3),
    seedPrepMs: report.phaseTotals.seedPrepMs.toFixed(3),
    tapeGenerationMs: report.phaseTotals.tapeGenerationMs.toFixed(3),
    requestBuildMs: report.phaseTotals.requestBuildMs.toFixed(3),
    nativeRequestSerializeMs:
      report.phaseTotals.nativeRequestSerializeMs.toFixed(3),
    nativeResponseWaitMs: report.phaseTotals.nativeResponseWaitMs.toFixed(3),
    nativeResponseParseMs: report.phaseTotals.nativeResponseParseMs.toFixed(3),
    rankingMs: report.phaseTotals.rankingMs.toFixed(3),
    outputMs: report.phaseTotals.outputMs.toFixed(3),
    replayTapeHitRate:
      replayTapeDenominator > 0
        ? (report.caches.replayTapeHits / replayTapeDenominator).toFixed(4)
        : '',
    compactTapeHitRate:
      compactTapeDenominator > 0
        ? (report.caches.compactTapeHits / compactTapeDenominator).toFixed(4)
        : '',
    requestBytesAverage: report.bytes.requestBytesAverage.toFixed(1),
    requestTapeBytesTotal: report.bytes.requestTapeBytesTotal,
    requestTapeBytesSavedTotal: report.bytes.requestTapeBytesSavedTotal,
    rssDeltaBytes: report.memory.rssDeltaBytes,
    heapUsedDeltaBytes: report.memory.heapUsedDeltaBytes,
    bestPolicyId: report.ranking.bestPolicyId ?? '',
    reportPath: report.artifacts.reportPath,
  };
  return CSV_COLUMNS.map((column) => csvEscape(values[column])).join(',');
}

function appendCsv(report: RunReport) {
  const csvPath = resolve(report.artifacts.csvPath);
  mkdirSync(dirname(csvPath), { recursive: true });
  if (!existsSync(csvPath)) {
    appendFileSync(csvPath, `${CSV_COLUMNS.join(',')}\n`);
  }
  appendFileSync(csvPath, `${csvRow(report)}\n`);
}

function printHuman(report: RunReport) {
  const fmt = (value: number, digits = 1) => value.toFixed(digits);
  const lines = [
    `cpu-baseline pass=true runtime=${report.runtime} mode=${report.mode} policies=${report.policiesEvaluated} trials=${report.trials}`,
    `host=${report.host} node=${report.nodeVersion} git=${report.git.commit}${report.git.dirty ? '+dirty' : ''}`,
    `wall=${fmt(report.wallMs / 1000, 2)}s mean=${fmt(report.perPolicy.meanMs, 2)}ms p95=${fmt(report.perPolicy.p95Ms, 2)}ms throughput=${fmt(report.throughput.policiesPerMinute, 1)} pol/min`,
    `phases: enumeration=${fmt(report.phaseTotals.enumerationMs)}ms tape=${fmt(report.phaseTotals.tapeGenerationMs)}ms native=${fmt(report.phaseTotals.nativeResponseWaitMs)}ms rank=${fmt(report.phaseTotals.rankingMs)}ms output=${fmt(report.phaseTotals.outputMs)}ms`,
    `cache: replay=${report.caches.replayTapeHits}/${report.caches.replayTapeHits + report.caches.replayTapeMisses} compact=${report.caches.compactTapeHits}/${report.caches.compactTapeHits + report.caches.compactTapeMisses}`,
  ];
  if (report.instrumentation?.proofLadder?.length) {
    lines.push('proof ladder:');
    for (const item of report.instrumentation.proofLadder.slice(0, 6)) {
      lines.push(
        `  ${item.module}: calls=${item.calls} perCall=${fmt(item.perCallUs, 3)}us fullRemoval=${fmt(item.fullRemovalMs, 1)}ms -> ${item.recommendation}`,
      );
    }
    lines.push('  candidate estimate: callReduction * perCallUs / 1000 = savedMs');
  }
  lines.push(`artifacts: report=${report.artifacts.reportPath} csv=${report.artifacts.csvPath}`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

async function runOne(input: {
  options: CliOptions;
  mode: Mode;
  repeatIndex: number;
  git: ReturnType<typeof gitInfo>;
  id: string;
}): Promise<RunReport> {
  const options = input.options;
  const assumptions = assumptionsForMode(options, input.mode);
  const memoryStart = process.memoryUsage();
  const timestampIso = new Date().toISOString();
  const wallStartedAt = performance.now();

  const enumerationStartedAt = performance.now();
  const axes = buildDefaultPolicyAxes(initialSeedData);
  const allPolicies = enumeratePolicies(axes);
  const policies = representativePolicies(allPolicies, options.policies);
  const enumerationMs = performance.now() - enumerationStartedAt;

  const baselineFingerprint = 'cpu-baseline';
  const engineVersion = `${POLICY_MINER_ENGINE_VERSION}+cpu-baseline`;
  const representativeRequestState = {
    written: false,
    path:
      input.repeatIndex === 1 && input.mode === options.modes[0]
        ? options.writeRequestPath
        : null,
  };

  const run =
    options.runtime === 'rust-native-compact'
      ? await runRustBaseline({
          policies,
          assumptions,
          options,
          mode: input.mode,
          repeatIndex: input.repeatIndex,
          baselineFingerprint,
          engineVersion,
          representativeRequestState,
        })
      : await runTsBaseline({
          policies,
          assumptions,
          baselineFingerprint,
          engineVersion,
        });

  const rankingStartedAt = performance.now();
  const ranked = rankPolicies(run.evaluations);
  const rankingMs = performance.now() - rankingStartedAt;
  const best = ranked[0] ?? null;
  const outputStartedAt = performance.now();
  const wallMsBeforeOutput = performance.now() - wallStartedAt;
  const phaseTotals: PhaseTotals = {
    enumerationMs,
    seedPrepMs: sum(run.samples.seedPrepMs),
    tapeGenerationMs: sum(run.samples.tapeGenerationMs),
    requestBuildMs: sum(run.samples.requestBuildMs),
    nativeRequestSerializeMs: sum(run.samples.nativeRequestSerializeMs),
    nativeResponseWaitMs: sum(run.samples.nativeResponseWaitMs),
    nativeResponseParseMs: sum(run.samples.nativeResponseParseMs),
    nativeTotalMs: sum(run.samples.nativeTotalMs),
    evaluationBuildMs: sum(run.samples.evaluationBuildMs),
    rankingMs,
    outputMs: 0,
  };
  const memoryEnd = process.memoryUsage();
  const reportPath = resolve(
    options.logDir,
    `${input.id}-${options.runtime}-${input.mode}-r${input.repeatIndex}.json`,
  );
  const report: RunReport = {
    pass: true,
    timestampIso,
    label: options.label,
    host: hostname(),
    platform: platform(),
    arch: process.arch,
    osRelease: release(),
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
    git: input.git,
    runtime: options.runtime,
    mode: input.mode,
    repeatIndex: input.repeatIndex,
    policiesRequested: options.policies,
    policiesEvaluated: policies.length,
    totalPolicyUniverse: allPolicies.length,
    trials: options.trials,
    simulationSeed: assumptions.simulationSeed ?? 20260416,
    assumptionsVersion: assumptions.assumptionsVersion ?? 'v1',
    wallMs: wallMsBeforeOutput,
    phaseTotals,
    phaseShareOfWall: phaseShares(phaseTotals, wallMsBeforeOutput),
    perPolicy: summarize(run.samples.perPolicyWallMs),
    throughput: {
      policiesPerMinute:
        wallMsBeforeOutput > 0 ? (policies.length / wallMsBeforeOutput) * 60_000 : 0,
      projected5000PoliciesMinutes:
        policies.length > 0 ? (5000 * mean(run.samples.perPolicyWallMs)) / 1000 / 60 : 0,
      projectedFullUniverseMinutes:
        policies.length > 0
          ? (allPolicies.length * mean(run.samples.perPolicyWallMs)) / 1000 / 60
          : 0,
    },
    caches: run.cacheStats,
    bytes: run.bytes,
    memory: {
      rssStartBytes: memoryStart.rss,
      rssEndBytes: memoryEnd.rss,
      rssDeltaBytes: memoryEnd.rss - memoryStart.rss,
      heapUsedStartBytes: memoryStart.heapUsed,
      heapUsedEndBytes: memoryEnd.heapUsed,
      heapUsedDeltaBytes: memoryEnd.heapUsed - memoryStart.heapUsed,
    },
    ranking: {
      rankedPolicyCount: ranked.length,
      bestPolicyId: best?.id ?? null,
      bestAnnualSpendTodayDollars: best?.policy.annualSpendTodayDollars ?? null,
      bestSolventSuccessRate: best?.outcome.solventSuccessRate ?? null,
      bestBequestAttainmentRate: best?.outcome.bequestAttainmentRate ?? null,
    },
    artifacts: {
      reportPath,
      csvPath: resolve(options.csvPath),
      representativeRequestPath: representativeRequestState.written
        ? resolve(representativeRequestState.path!)
        : null,
    },
    ...(options.instrumentation.taxCallCounts || options.instrumentation.moduleTimings
      ? {
          instrumentation: {
            requested: options.instrumentation,
            ...(run.instrumentation &&
            Object.keys(run.instrumentation.taxCallCounts).length > 0
              ? { taxCallCounts: run.instrumentation.taxCallCounts }
              : {}),
            ...(run.instrumentation &&
            Object.keys(run.instrumentation.moduleTimings).length > 0
              ? {
                  moduleTimings: run.instrumentation.moduleTimings,
                  proofLadder: buildProofLadder(run.instrumentation.moduleTimings),
                }
              : {}),
          },
        }
      : {}),
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  report.phaseTotals.outputMs = performance.now() - outputStartedAt;
  report.phaseShareOfWall = phaseShares(report.phaseTotals, report.wallMs);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  appendCsv(report);
  return report;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const id = benchmarkId();
  const git = gitInfo();
  const reports: RunReport[] = [];

  for (const mode of options.modes) {
    for (let repeatIndex = 1; repeatIndex <= options.repeats; repeatIndex += 1) {
      const report = await runOne({
        options,
        mode,
        repeatIndex,
        git,
        id,
      });
      reports.push(report);
      if (!options.json) {
        printHuman(report);
      }
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
