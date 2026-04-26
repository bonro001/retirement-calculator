import { parentPort } from 'node:worker_threads';
import type { MarketAssumptions, SeedData } from '../src/types';
import type { PolicyEvaluation } from '../src/policy-miner-types';
import { evaluatePolicy } from '../src/policy-miner-eval';
import type {
  PolicyMinerWorkerRequest,
  PolicyMinerWorkerResponse,
} from '../src/policy-miner-worker-types';

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
  try {
    for (const policy of policies) {
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        post({ type: 'cancelled', requestId, partial: evaluations });
        return;
      }
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
      error: error instanceof Error ? error.message : 'host-worker failed',
      partial: evaluations,
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
