/**
 * Policy-miner perf baseline harness — Phase 0.1.
 *
 * Why this exists: the Phase 0 plan needs a measured baseline before any
 * optimization, plus a hotspot signal *inside* `evaluatePolicy` (clone vs
 * engine vs post-processing). The existing `policy-miner.throughput.test.ts`
 * gives us per-policy totals only — fine as a sanity check, but it can't
 * tell us whether the structuredClone is dominating the run or whether
 * it's lost in the noise of the engine.
 *
 * This harness inlines the body of `evaluatePolicy` with section-level
 * timers so a single run produces:
 *
 *   - total wall-clock
 *   - per-policy mean / median / p95 / p99
 *   - per-phase mean (cloner, applyPolicy, engine buildPathResults, post)
 *
 * That's enough to know what's worth optimizing before we even reach for
 * `node --prof` (Phase 0.2). If one phase is 70% of the budget, the
 * V8 profile will only confirm what the section timing already showed.
 *
 * Usage:
 *   tsx scripts/perf-baseline.ts                 # default: 50 policies × 500 trials
 *   tsx scripts/perf-baseline.ts --policies 100 --trials 1000
 *   tsx scripts/perf-baseline.ts --json           # machine-readable output to stdout
 *
 * Profiled run (Phase 0.2):
 *   node --import tsx --prof scripts/perf-baseline.ts --policies 50 --trials 500
 *   node --prof-process isolate-*.log > perf/profile-baseline.txt
 */

import { initialSeedData } from '../src/data';
import type { MarketAssumptions } from '../src/types';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
  policyId,
} from '../src/policy-axis-enumerator';
import { applyPolicyToSeed } from '../src/policy-miner-eval';
import { buildPathResults } from '../src/utils';
import { approximateBequestAttainmentRate } from '../src/plan-evaluation';

interface CliArgs {
  policyCount: number;
  trialCount: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { policyCount: 50, trialCount: 500, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--policies') {
      args.policyCount = Number(argv[++i]);
    } else if (tok === '--trials') {
      args.trialCount = Number(argv[++i]);
    } else if (tok === '--json') {
      args.json = true;
    } else if (tok === '--help' || tok === '-h') {
      process.stderr.write(
        'usage: tsx scripts/perf-baseline.ts [--policies N] [--trials N] [--json]\n',
      );
      process.exit(0);
    }
  }
  return args;
}

function pct(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

interface PhaseStats {
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  totalMs: number;
}

function summarize(samples: number[]): PhaseStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    meanMs: mean(samples),
    medianMs: pct(sorted, 0.5),
    p95Ms: pct(sorted, 0.95),
    p99Ms: pct(sorted, 0.99),
    totalMs: samples.reduce((a, b) => a + b, 0),
  };
}

interface BaselineResult {
  hostname: string;
  nodeVersion: string;
  arch: string;
  policyCount: number;
  trialCount: number;
  totalWallMs: number;
  policiesPerMinute: number;
  perPolicy: PhaseStats;
  perPhase: {
    clone: PhaseStats;
    applyPolicy: PhaseStats;
    engineBuildPath: PhaseStats;
    postProcess: PhaseStats;
  };
  phaseShareOfPolicy: {
    clonePct: number;
    applyPolicyPct: number;
    engineBuildPathPct: number;
    postProcessPct: number;
  };
  projection: {
    fullCorpusSingleThreadMin: number;
    fullCorpus8WorkerMin: number;
    fullCorpus24WorkerMin: number;
  };
}

function toTodayDollars(
  nominal: number,
  inflation: number,
  horizonYears: number,
): number {
  const factor = Math.pow(
    1 + Math.max(-0.99, inflation),
    Math.max(0, horizonYears),
  );
  if (factor <= 0) return nominal;
  return nominal / factor;
}

async function runBaseline(args: CliArgs): Promise<BaselineResult> {
  const { policyCount, trialCount } = args;

  const assumptions: MarketAssumptions = {
    equityMean: 0.074,
    equityVolatility: 0.16,
    internationalEquityMean: 0.074,
    internationalEquityVolatility: 0.18,
    bondMean: 0.038,
    bondVolatility: 0.07,
    cashMean: 0.02,
    cashVolatility: 0.01,
    inflation: 0.028,
    inflationVolatility: 0.01,
    simulationRuns: trialCount,
    irmaaThreshold: 200000,
    guardrailFloorYears: 12,
    guardrailCeilingYears: 18,
    guardrailCutPercent: 0.2,
    robPlanningEndAge: 90,
    debbiePlanningEndAge: 95,
    travelPhaseYears: 10,
    simulationSeed: 20260417, // deterministic — matches throughput test
    assumptionsVersion: 'perf-baseline-v1',
  };

  const baseline = initialSeedData;
  const axes = buildDefaultPolicyAxes(baseline);
  const allPolicies = enumeratePolicies(axes);
  if (allPolicies.length === 0) {
    throw new Error('perf-baseline: enumerator returned 0 policies');
  }

  // Strided sample so we hit a representative slice of axes (not the
  // first N which all share Roth/SS settings). Same trick the throughput
  // test uses.
  const stride = Math.max(1, Math.floor(allPolicies.length / policyCount));
  const policies = [];
  for (let i = 0; i < policyCount && i * stride < allPolicies.length; i += 1) {
    policies.push(allPolicies[i * stride]);
  }

  const baselineFingerprint = 'perf-baseline';
  const engineVersion = 'perf-baseline-engine';
  const evaluatedByNodeId = 'perf-host';
  const legacyTarget =
    initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000;
  const inflation = assumptions.inflation ?? 0.025;

  const perPolicyMs: number[] = [];
  const cloneMs: number[] = [];
  const applyMs: number[] = [];
  const engineMs: number[] = [];
  const postMs: number[] = [];

  // --- Warmup ---------------------------------------------------------
  // V8 needs a few invocations to JIT the hot paths. Without warmup the
  // first 1-3 policies dominate the p95/p99 numbers and skew the mean
  // up by 20-40%. Throw away the first 3 policies' timings.
  const WARMUP = Math.min(3, Math.max(1, Math.floor(policies.length / 20)));

  const wallStart = process.hrtime.bigint();

  for (let i = 0; i < policies.length; i += 1) {
    const policy = policies[i];

    // --- Phase: clone ---
    const t0 = process.hrtime.bigint();
    const clone = structuredClone(baseline);
    const t1 = process.hrtime.bigint();

    // --- Phase: applyPolicy ---
    applyPolicyToSeed(clone, policy);
    const t2 = process.hrtime.bigint();

    // --- Phase: engine ---
    const paths = buildPathResults(clone, assumptions, [], [], {
      annualSpendTarget: policy.annualSpendTodayDollars,
      pathMode: 'selected_only',
    });
    const t3 = process.hrtime.bigint();

    // --- Phase: post-process ---
    const baselinePath = paths[0];
    if (!baselinePath) throw new Error('perf-baseline: no path result');
    const horizonYears = baselinePath.yearlySeries?.length ?? 30;
    const todayDollarsP10 = toTodayDollars(
      baselinePath.endingWealthPercentiles.p10,
      inflation,
      horizonYears,
    );
    const todayDollarsP25 = toTodayDollars(
      baselinePath.endingWealthPercentiles.p25,
      inflation,
      horizonYears,
    );
    const todayDollarsP50 = toTodayDollars(
      baselinePath.endingWealthPercentiles.p50,
      inflation,
      horizonYears,
    );
    const todayDollarsP75 = toTodayDollars(
      baselinePath.endingWealthPercentiles.p75,
      inflation,
      horizonYears,
    );
    const todayDollarsP90 = toTodayDollars(
      baselinePath.endingWealthPercentiles.p90,
      inflation,
      horizonYears,
    );
    const _attainment =
      legacyTarget > 0
        ? approximateBequestAttainmentRate(legacyTarget, {
            p10: todayDollarsP10,
            p25: todayDollarsP25,
            p50: todayDollarsP50,
            p75: todayDollarsP75,
            p90: todayDollarsP90,
          })
        : 1;
    const _id = policyId(policy, baselineFingerprint, engineVersion);
    const _stamp = new Date().toISOString();
    void _attainment;
    void _id;
    void _stamp;
    void evaluatedByNodeId;
    const t4 = process.hrtime.bigint();

    // Convert ns → ms (float). hrtime.bigint is monotonic and ns-resolution.
    const nsToMs = (a: bigint, b: bigint) => Number(b - a) / 1_000_000;
    if (i >= WARMUP) {
      cloneMs.push(nsToMs(t0, t1));
      applyMs.push(nsToMs(t1, t2));
      engineMs.push(nsToMs(t2, t3));
      postMs.push(nsToMs(t3, t4));
      perPolicyMs.push(nsToMs(t0, t4));
    }
  }

  const totalWallMs = Number(process.hrtime.bigint() - wallStart) / 1_000_000;

  const measuredCount = perPolicyMs.length;
  const policiesPerMinute =
    measuredCount > 0
      ? (measuredCount / perPolicyMs.reduce((a, b) => a + b, 0)) * 60_000
      : 0;

  const perPolicy = summarize(perPolicyMs);
  const perPhase = {
    clone: summarize(cloneMs),
    applyPolicy: summarize(applyMs),
    engineBuildPath: summarize(engineMs),
    postProcess: summarize(postMs),
  };

  const phaseShareOfPolicy = {
    clonePct: (perPhase.clone.meanMs / perPolicy.meanMs) * 100,
    applyPolicyPct: (perPhase.applyPolicy.meanMs / perPolicy.meanMs) * 100,
    engineBuildPathPct: (perPhase.engineBuildPath.meanMs / perPolicy.meanMs) * 100,
    postProcessPct: (perPhase.postProcess.meanMs / perPolicy.meanMs) * 100,
  };

  const projection = {
    fullCorpusSingleThreadMin: (7776 * perPolicy.meanMs) / 1000 / 60,
    fullCorpus8WorkerMin: (7776 * perPolicy.meanMs) / 1000 / 60 / 8,
    fullCorpus24WorkerMin: (7776 * perPolicy.meanMs) / 1000 / 60 / 24,
  };

  return {
    hostname: (await import('node:os')).hostname(),
    nodeVersion: process.version,
    arch: process.arch,
    policyCount: measuredCount,
    trialCount,
    totalWallMs,
    policiesPerMinute,
    perPolicy,
    perPhase,
    phaseShareOfPolicy,
    projection,
  };
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function reportHuman(r: BaselineResult): void {
  const lines = [
    '',
    '═══════════════════════════════════════════════════════════',
    '  Policy-Miner Perf Baseline (Phase 0.1)',
    '═══════════════════════════════════════════════════════════',
    `  host       : ${r.hostname} (${r.arch}, node ${r.nodeVersion})`,
    `  policies   : ${r.policyCount}  (after warmup discard)`,
    `  trials/pol : ${r.trialCount}`,
    `  wall time  : ${fmt(r.totalWallMs / 1000)}s`,
    `  throughput : ${fmt(r.policiesPerMinute)} pol/min  (single thread)`,
    '',
    '  Per-policy time (ms):',
    `    mean   ${fmt(r.perPolicy.meanMs)}`,
    `    median ${fmt(r.perPolicy.medianMs)}`,
    `    p95    ${fmt(r.perPolicy.p95Ms)}`,
    `    p99    ${fmt(r.perPolicy.p99Ms)}`,
    '',
    '  Phase breakdown (mean ms / % of per-policy):',
    `    clone        ${fmt(r.perPhase.clone.meanMs).padStart(8)} ms  (${fmt(r.phaseShareOfPolicy.clonePct)}%)`,
    `    applyPolicy  ${fmt(r.perPhase.applyPolicy.meanMs).padStart(8)} ms  (${fmt(r.phaseShareOfPolicy.applyPolicyPct)}%)`,
    `    engine       ${fmt(r.perPhase.engineBuildPath.meanMs).padStart(8)} ms  (${fmt(r.phaseShareOfPolicy.engineBuildPathPct)}%)`,
    `    postProcess  ${fmt(r.perPhase.postProcess.meanMs).padStart(8)} ms  (${fmt(r.phaseShareOfPolicy.postProcessPct)}%)`,
    '',
    '  Full corpus projection (7,776 policies):',
    `    single thread       ${fmt(r.projection.fullCorpusSingleThreadMin)} min`,
    `    8-worker pool       ${fmt(r.projection.fullCorpus8WorkerMin)} min`,
    `    24-worker pool      ${fmt(r.projection.fullCorpus24WorkerMin)} min`,
    '═══════════════════════════════════════════════════════════',
    '',
  ];
  process.stderr.write(lines.join('\n'));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const result = await runBaseline(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    reportHuman(result);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
