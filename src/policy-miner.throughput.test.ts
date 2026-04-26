import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
} from './policy-axis-enumerator';
import { evaluatePolicy } from './policy-miner';

/**
 * Policy-miner throughput probe — answers the "do I need an M4 Pro?"
 * question with empirical numbers from this exact host.
 *
 * Two skipped tests, run on demand:
 *   - QUICK: 10 policies × 500 trials. Validates plumbing in ~15-30s.
 *     Use to verify a code change didn't break anything before kicking
 *     off the long probe.
 *   - FULL: 50 policies × 2000 trials. Realistic-ish throughput in ~3-6
 *     minutes. The number to quote when sizing the hardware question.
 *
 * Both are `.skip` by default so they don't slow CI. Run manually via
 *   npx vitest run src/policy-miner.throughput.test.ts -t throughput
 *
 * After installing the SKIP, change `it.skip` → `it` to run.
 *
 * Output prints to stdout so you can capture timings without parsing
 * the vitest reporter. We deliberately do NOT call into the IndexedDB
 * corpus from these tests — `evaluatePolicy` is the pure compute path
 * and that's what we're measuring. Persistence overhead is added back
 * in by the live miner under live conditions; it's <1ms per record.
 */

const PROBE_ASSUMPTIONS_QUICK: MarketAssumptions = {
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
  simulationRuns: 500,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'policy-miner-probe-quick',
};

const PROBE_ASSUMPTIONS_FULL: MarketAssumptions = {
  ...PROBE_ASSUMPTIONS_QUICK,
  simulationRuns: 2000,
  assumptionsVersion: 'policy-miner-probe-full',
};

interface ProbeResult {
  policyCount: number;
  trialCount: number;
  totalDurationMs: number;
  meanMsPerPolicy: number;
  medianMsPerPolicy: number;
  p95MsPerPolicy: number;
  policiesPerMinute: number;
  /** Projected wall-clock time to mine a 7,776-policy corpus, hours. */
  projectedFullCorpusHours: number;
}

async function runProbe(
  assumptions: MarketAssumptions,
  policyCount: number,
): Promise<ProbeResult> {
  const axes = buildDefaultPolicyAxes(initialSeedData);
  const allPolicies = enumeratePolicies(axes);
  // Take a strided sample so we hit a representative slice of axes
  // rather than the first N (which all share the same Roth/SS settings).
  const stride = Math.max(1, Math.floor(allPolicies.length / policyCount));
  const policies = [];
  for (let i = 0; i < policyCount && i * stride < allPolicies.length; i += 1) {
    policies.push(allPolicies[i * stride]);
  }

  const cloner = (seed: typeof initialSeedData) =>
    structuredClone(seed) as typeof initialSeedData;
  const baselineFingerprint = 'probe-baseline';
  const engineVersion = `probe-${assumptions.assumptionsVersion}`;
  const evaluatedByNodeId = 'local-probe';
  const legacyTarget =
    initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000;

  const durations: number[] = [];
  const startedAt = Date.now();
  for (const policy of policies) {
    const startMs = Date.now();
    await evaluatePolicy(
      policy,
      initialSeedData,
      assumptions,
      baselineFingerprint,
      engineVersion,
      evaluatedByNodeId,
      cloner,
      legacyTarget,
    );
    durations.push(Date.now() - startMs);
  }
  const totalDurationMs = Date.now() - startedAt;
  const sorted = [...durations].sort((a, b) => a - b);
  const meanMsPerPolicy = totalDurationMs / policies.length;
  const medianMsPerPolicy = sorted[Math.floor(sorted.length / 2)];
  const p95MsPerPolicy = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const policiesPerMinute = (policies.length / totalDurationMs) * 60_000;
  const projectedFullCorpusHours = (7776 * meanMsPerPolicy) / 1000 / 3600;
  return {
    policyCount: policies.length,
    trialCount: assumptions.simulationRuns,
    totalDurationMs,
    meanMsPerPolicy,
    medianMsPerPolicy,
    p95MsPerPolicy,
    policiesPerMinute,
    projectedFullCorpusHours,
  };
}

function reportProbe(label: string, r: ProbeResult): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `=== Policy Miner Throughput — ${label} ===`,
      `  policies        : ${r.policyCount}`,
      `  trials/policy   : ${r.trialCount}`,
      `  total           : ${(r.totalDurationMs / 1000).toFixed(1)}s`,
      `  mean ms/policy  : ${r.meanMsPerPolicy.toFixed(0)}`,
      `  median ms/policy: ${r.medianMsPerPolicy.toFixed(0)}`,
      `  p95 ms/policy   : ${r.p95MsPerPolicy.toFixed(0)}`,
      `  policies/minute : ${r.policiesPerMinute.toFixed(1)}`,
      `  projected 7,776 single-thread : ${r.projectedFullCorpusHours.toFixed(2)}h`,
      `  projected 7,776 with 8-worker pool : ${(r.projectedFullCorpusHours / 8).toFixed(2)}h`,
      '',
    ].join('\n'),
  );
}

describe('policy-miner throughput', () => {
  // Marked `.skip` so CI doesn't pay the cost on every run. Flip to `.it`
  // (or use `-t throughput-quick`) to run manually.
  it.skip('throughput-quick: 10 policies @ 500 trials', async () => {
    const result = await runProbe(PROBE_ASSUMPTIONS_QUICK, 10);
    reportProbe('QUICK probe (500 trials)', result);
    expect(result.policyCount).toBe(10);
  }, 120_000);

  it.skip('throughput-full: 50 policies @ 2000 trials', async () => {
    const result = await runProbe(PROBE_ASSUMPTIONS_FULL, 50);
    reportProbe('FULL probe (2000 trials)', result);
    expect(result.policyCount).toBe(50);
  }, 600_000);
});
