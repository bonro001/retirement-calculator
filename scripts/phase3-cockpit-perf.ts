/**
 * Phase 3 perf — measure the cockpit's corpus-fetch + ranker hot path.
 *
 * Pre-refactor: cockpit ran SS → spend → Roth bisection on the main
 * thread for ~10-15s on cold load (250-trial chain). Post-refactor:
 * cockpit fetches the corpus from the dispatcher and runs `bestPolicy`
 * locally. The corpus fetch + ranker is what dominates cold render now.
 *
 * This script times the corpus-fetch path 3 times to capture cold +
 * warm load. The first call is the cold load (no localStorage cache,
 * no IDB warm); subsequent calls hit the persistent layer the cockpit
 * uses on tab swaps.
 */
import { initialSeedData } from '../src/data';
import {
  loadClusterEvaluations,
  loadClusterSessions,
} from '../src/policy-mining-cluster';
import {
  bestPolicy,
  LEGACY_FIRST_LEXICOGRAPHIC,
} from '../src/policy-ranker';
import { buildEvaluationFingerprint } from '../src/evaluation-fingerprint';
import type { MarketAssumptions } from '../src/types';

const DISPATCHER = process.env.DISPATCHER_URL ?? 'http://localhost:8765';
const TRIALS = 2000;

const ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: TRIALS,
  irmaaThreshold: 200_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20_260_417,
  assumptionsVersion: 'cluster-controller-default',
};

const fingerprint = (() => {
  const base = buildEvaluationFingerprint({
    data: initialSeedData,
    assumptions: ASSUMPTIONS,
    selectedStressors: [],
    selectedResponses: [],
  });
  return `${base}|trials=${TRIALS}|fpv1`;
})();

async function timeOne(): Promise<{
  listSessionsMs: number;
  pullEvalsMs: number;
  rankMs: number;
  totalMs: number;
  recordsPulled: number;
  topId: string | null;
}> {
  const t0 = performance.now();
  const sessions = await loadClusterSessions(DISPATCHER);
  const t1 = performance.now();
  const match = sessions.find(
    (s) => s.manifest?.config?.baselineFingerprint === fingerprint,
  );
  if (!match) throw new Error('no matching session');
  const payload = await loadClusterEvaluations(DISPATCHER, match.sessionId, {
    topN: 0,
    minFeasibility: 0.5,
  });
  const t2 = performance.now();
  const evals = payload?.evaluations ?? [];
  const top = bestPolicy(evals, LEGACY_FIRST_LEXICOGRAPHIC);
  const t3 = performance.now();
  return {
    listSessionsMs: t1 - t0,
    pullEvalsMs: t2 - t1,
    rankMs: t3 - t2,
    totalMs: t3 - t0,
    recordsPulled: evals.length,
    topId: top?.id ?? null,
  };
}

async function main() {
  console.log('phase3-perf: dispatcher =', DISPATCHER);
  console.log('phase3-perf: timing useRecommendedPolicy hot path 3x');
  for (let i = 0; i < 3; i += 1) {
    const r = await timeOne();
    console.log(
      `  run ${i + 1}: total=${r.totalMs.toFixed(0)}ms ` +
        `(list=${r.listSessionsMs.toFixed(0)}ms ` +
        `pull=${r.pullEvalsMs.toFixed(0)}ms ` +
        `rank=${r.rankMs.toFixed(0)}ms) ` +
        `records=${r.recordsPulled} top=${r.topId}`,
    );
  }
}

main().catch((err) => {
  console.error('phase3-perf: error', err);
  process.exit(1);
});
