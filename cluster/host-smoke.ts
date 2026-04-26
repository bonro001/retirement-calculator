/**
 * D.2 host smoke test.
 *
 * Proves the engine runs end-to-end inside Node `worker_threads`,
 * independent of the dispatcher. The dispatcher's batch-distribution
 * logic doesn't land until D.4, but we can validate everything
 * downstream of `batch_assign` today by:
 *
 *   1. Spinning up the host's worker pool.
 *   2. Priming it with a real SeedData baseline + MarketAssumptions.
 *   3. Synthesizing a small batch of policies (drawn from the same
 *      enumerator the production miner uses).
 *   4. Running the batch through the pool.
 *   5. Checking the results have the expected shape and timing.
 *
 * This is the "does the engine port to Node?" question — the riskiest
 * piece of D.2. If `evaluatePolicy` (or anything in its import graph)
 * silently relies on a browser API, it will surface here.
 *
 * Run:  npm run cluster:host-smoke
 *
 * Defaults to 4 policies × 200 trials (~5-10s on M4 mini). Override:
 *   SMOKE_POLICIES=8 SMOKE_TRIALS=500 npm run cluster:host-smoke
 */

import { initialSeedData } from '../src/data';
import type { MarketAssumptions } from '../src/types';
import {
  buildDefaultPolicyAxes,
  enumeratePolicies,
} from '../src/policy-axis-enumerator';
import { POLICY_MINER_ENGINE_VERSION } from '../src/policy-miner-types';
import {
  spawnPool,
  shutdownPool,
  primeAllSlotsForSession,
  runBatchOnPool,
  freeSlotCount,
  HOST_WORKER_COUNT,
} from './host';

const POLICY_COUNT = Number.parseInt(process.env.SMOKE_POLICIES ?? '4', 10);
const TRIAL_COUNT = Number.parseInt(process.env.SMOKE_TRIALS ?? '200', 10);

function log(msg: string, meta?: Record<string, unknown>) {
  const tail = meta ? ' ' + JSON.stringify(meta) : '';
  // eslint-disable-next-line no-console
  console.log(`[host-smoke] ${msg}${tail}`);
}

const SMOKE_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: TRIAL_COUNT,
  irmaaThreshold: 200_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20_260_417,
  assumptionsVersion: 'host-smoke',
};

async function main(): Promise<void> {
  log('starting', {
    workers: HOST_WORKER_COUNT,
    policies: POLICY_COUNT,
    trials: TRIAL_COUNT,
  });

  spawnPool();

  const sessionId = 'smoke-session';
  const baselineFingerprint = 'smoke-baseline';
  const evaluatedByNodeId = 'smoke-host';

  // Prime every worker with the same SeedData/assumptions. This is the
  // exact code path the live host uses when handling `start_session` +
  // first `batch_assign`.
  primeAllSlotsForSession(
    sessionId,
    initialSeedData,
    SMOKE_ASSUMPTIONS,
    baselineFingerprint,
    POLICY_MINER_ENGINE_VERSION,
    evaluatedByNodeId,
    1_000_000, // legacy bequest target ($1M today)
  );

  // Build a representative slice of the policy space — strided sample so
  // we hit different SS-claim / Roth combos rather than the first N
  // policies (which all share the same low-spend axis).
  const axes = buildDefaultPolicyAxes(initialSeedData);
  const allPolicies = enumeratePolicies(axes);
  const stride = Math.max(1, Math.floor(allPolicies.length / POLICY_COUNT));
  const policies = [];
  for (let i = 0; i < POLICY_COUNT && i * stride < allPolicies.length; i += 1) {
    policies.push(allPolicies[i * stride]);
  }
  log('policy slice', {
    sampled: policies.length,
    totalCorpus: allPolicies.length,
    stride,
  });

  // Run the full batch on a single slot — same code path the dispatcher
  // would trigger. We could fan to multiple slots in parallel here too,
  // but keeping it serial makes the per-policy timing easy to read.
  const startMs = Date.now();
  const evaluations = await runBatchOnPool(sessionId, 'smoke-batch-1', policies);
  const elapsedMs = Date.now() - startMs;

  log('batch complete', {
    evaluations: evaluations.length,
    totalMs: elapsedMs,
    msPerPolicy: Math.round(elapsedMs / Math.max(1, evaluations.length)),
    freeSlots: freeSlotCount(),
  });

  // Sanity checks — fail loudly if the engine returned nonsense.
  if (evaluations.length !== policies.length) {
    throw new Error(
      `evaluation count mismatch: got ${evaluations.length}, expected ${policies.length}`,
    );
  }
  for (const ev of evaluations) {
    if (
      typeof ev.outcome.solventSuccessRate !== 'number' ||
      ev.outcome.solventSuccessRate < 0 ||
      ev.outcome.solventSuccessRate > 1
    ) {
      throw new Error(
        `invalid success rate ${ev.outcome.solventSuccessRate} on ${ev.id}`,
      );
    }
    if (!Number.isFinite(ev.outcome.p50EndingWealthTodayDollars)) {
      throw new Error(`non-finite p50 wealth on ${ev.id}`);
    }
  }
  log('shape checks passed', {
    sampleId: evaluations[0]?.id,
    sampleSuccessRate: evaluations[0]?.outcome.solventSuccessRate.toFixed(3),
    sampleP50TodayDollars: Math.round(
      evaluations[0]?.outcome.p50EndingWealthTodayDollars ?? 0,
    ),
  });

  await shutdownPool();
  log('done — engine runs cleanly in node:worker_threads');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[host-smoke] FAILED', err);
  void shutdownPool().finally(() => process.exit(1));
});
