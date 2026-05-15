/// <reference lib="webworker" />

import type { MarketAssumptions, SeedData } from './types';
import type { PolicyEvaluation, PolicySpendingScheduleBasis } from './policy-miner-types';
import { evaluatePolicy } from './policy-miner';
import type {
  PolicyMinerWorkerRequest,
  PolicyMinerWorkerResponse,
} from './policy-miner-worker-types';

/**
 * Policy-miner worker — evaluates one or more policies per request and
 * returns the resulting `PolicyEvaluation[]`.
 *
 * Session model mirrors `path-shard.worker.ts`: the pool primes each
 * worker once with the SeedData + assumptions + session metadata; each
 * subsequent run references that primed session by id. Eliminates the
 * dominant cloning cost across the worker boundary.
 *
 * Cancellation: a `cancel` message marks the request id as cancelled.
 * The worker drains its current policy (no checkpoints inside the engine)
 * and posts a `cancelled` response with whatever evaluations completed
 * before the cancel landed. The dispatcher reschedules the missing
 * policies on the next available worker.
 */

interface PrimedSession {
  data: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  evaluatedByNodeId: string;
  legacyTargetTodayDollars: number;
  spendingScheduleBasis?: PolicySpendingScheduleBasis;
}

const workerScope = self as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<string>();
const primedSessions = new Map<string, PrimedSession>();

function post(msg: PolicyMinerWorkerResponse) {
  workerScope.postMessage(msg);
}

function cloneSeedData(value: SeedData): SeedData {
  // Workers always have structuredClone in evergreen browsers + Node 17+.
  // Fall back to JSON parse/stringify only if absolutely necessary so we
  // don't silently lose `Date` / `Map` / `Set` objects.
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as SeedData;
}

workerScope.onmessage = async (
  event: MessageEvent<PolicyMinerWorkerRequest>,
) => {
  const message = event.data;

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
      spendingScheduleBasis: message.payload.spendingScheduleBasis,
    });
    return;
  }

  if (message.type === 'unprime') {
    primedSessions.delete(message.sessionId);
    return;
  }

  // 'run' branch
  const { payload } = message;
  const { requestId, sessionId, policies } = payload;
  cancelledRequests.delete(requestId);

  const session = primedSessions.get(sessionId);
  if (!session) {
    post({
      type: 'error',
      requestId,
      error: `Policy miner worker: session ${sessionId} not primed.`,
      partial: [],
    });
    return;
  }

  const startMs = Date.now();
  const evaluations: PolicyEvaluation[] = [];
  try {
    for (const policy of policies) {
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        post({ type: 'cancelled', requestId, partial: evaluations });
        return;
      }
      // Per-policy: clone the primed seed (the engine mutates working
      // copies inside) and evaluate. The evaluator handles policy
      // application and metric extraction.
      const evaluation = await evaluatePolicy(
        policy,
        session.data,
        session.assumptions,
        session.baselineFingerprint,
        session.engineVersion,
        session.evaluatedByNodeId,
        cloneSeedData,
        session.legacyTargetTodayDollars,
        session.spendingScheduleBasis,
      );
      evaluations.push(evaluation);
    }
    post({
      type: 'result',
      requestId,
      evaluations,
      batchDurationMs: Date.now() - startMs,
    });
  } catch (error) {
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      post({ type: 'cancelled', requestId, partial: evaluations });
      return;
    }
    post({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : 'Policy miner worker failed',
      partial: evaluations,
    });
  }
};
