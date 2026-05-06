/**
 * Policy Miner Cluster — Controller CLI.
 *
 * Standalone Node script that connects to the dispatcher as a `controller`,
 * sends a `start_session`, then prints session progress until the session
 * finishes. Exits cleanly when the dispatcher reports `session: null` (or
 * an error).
 *
 * Why a CLI instead of waiting for the browser controller (D.3): D.4
 * needs end-to-end testability today, and the browser path adds a lot of
 * surface (auth, reconnect, UI plumbing). A 200-line CLI lets us drive
 * the dispatcher and one or more hosts on a real LAN as soon as D.4
 * lands; the browser controller in D.3 then has a reference to copy.
 *
 * Run:
 *   npm run cluster:start-session
 *
 * Env:
 *   DISPATCHER_URL          ws URL to dial. Default ws://localhost:8765
 *   SESSION_TRIAL_COUNT     trials per policy. Default 2000 (production setting).
 *   SESSION_LEGACY_TARGET   bequest target in today's dollars. Default 1_000_000.
 *   SESSION_FEASIBILITY     attainment threshold (0..1). Default 0.70.
 *   SESSION_MAX_POLICIES    cap on enumerated policies. Default = full corpus.
 *   SESSION_BASELINE_FILE   path to a SeedData JSON. Default = built-in initialSeedData.
 *   SESSION_ASSUMPTIONS_FILE  path to MarketAssumptions JSON. Default = built-in.
 *   SESSION_COARSE_TRIALS   Phase 2.C: trials for the coarse pre-screening
 *                           pass. Set to enable two-stage screening across
 *                           the cluster (1.5-1.8× wall-time win when the
 *                           feasibility threshold is tight enough that a
 *                           meaningful fraction of policies get screened
 *                           out). Typical: 200. Default: unset (single-pass).
 *   SESSION_COARSE_BUFFER   Phase 2.C: feasibility buffer for the survival
 *                           cut. A policy with coarse attainment
 *                           >= (SESSION_FEASIBILITY - buffer) advances to
 *                           the fine pass. Higher = looser screen (fewer
 *                           false negatives, smaller speedup). Default 0.10.
 *                           Only used when SESSION_COARSE_TRIALS is set.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import WebSocket from 'ws';
import { initialSeedData } from '../src/data';
import {
  buildDefaultPolicyAxes,
  countPolicyCandidates,
  enumeratePolicies,
} from '../src/policy-axis-enumerator';
import {
  POLICY_MINER_ENGINE_VERSION,
  type PolicyMiningSessionConfig,
} from '../src/policy-miner-types';
import {
  DEFAULT_DISPATCHER_PORT,
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type ClusterMessage,
  type ClusterSnapshot,
  type HeartbeatMessage,
  type StartSessionMessage,
} from '../src/mining-protocol';
import type { MarketAssumptions, SeedData } from '../src/types';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string, meta?: Record<string, unknown>) {
  const tail = meta ? ' ' + JSON.stringify(meta) : '';
  // eslint-disable-next-line no-console
  console.log(`[start-session] ${msg}${tail}`);
}

// ---------------------------------------------------------------------------
// Defaults — used when the corresponding *_FILE env var is not set
// ---------------------------------------------------------------------------

/**
 * Default market assumptions. Mirrors what the in-browser miner uses for
 * "press the button" runs and matches the host-smoke fixture so a result
 * here is comparable to a result there. The trial count is overridden
 * from `SESSION_TRIAL_COUNT` below — the value here is just a placeholder
 * that gets replaced before send.
 */
const DEFAULT_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 2000,
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

// ---------------------------------------------------------------------------
// Baseline fingerprint
// ---------------------------------------------------------------------------

/**
 * Stable hash of a SeedData blob. Mirrors what the browser's miner does
 * conceptually (hash → corpus partition key) so a record minted by this
 * controller against the default seed is comparable to one minted by the
 * in-browser miner against the same seed.
 *
 * Implementation note: JSON.stringify is order-stable for object literals
 * in V8, but to defend against accidental reordering we sort keys before
 * hashing. This is the same trick `policyId` uses in the enumerator.
 */
function computeBaselineFingerprint(seed: SeedData): string {
  const sortedJson = JSON.stringify(seed, Object.keys(seed).sort());
  const hash = createHash('sha256').update(sortedJson).digest('hex');
  return `cli-${hash.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  dispatcherUrl: string;
  trialCount: number;
  legacyTarget: number;
  feasibilityThreshold: number;
  maxPolicies: number | null;
  seed: SeedData;
  assumptions: MarketAssumptions;
  controllerName: string;
}

function resolveConfig(): ResolvedConfig {
  const dispatcherUrl =
    process.env.DISPATCHER_URL ?? `ws://localhost:${DEFAULT_DISPATCHER_PORT}`;
  const trialCount = Number.parseInt(process.env.SESSION_TRIAL_COUNT ?? '2000', 10);
  const legacyTarget = Number.parseInt(
    process.env.SESSION_LEGACY_TARGET ?? '1000000',
    10,
  );
  const feasibilityThreshold = Number.parseFloat(
    process.env.SESSION_FEASIBILITY ?? '0.70',
  );
  const maxPoliciesEnv = process.env.SESSION_MAX_POLICIES;
  const maxPolicies = maxPoliciesEnv ? Number.parseInt(maxPoliciesEnv, 10) : null;

  const seed = process.env.SESSION_BASELINE_FILE
    ? (JSON.parse(readFileSync(process.env.SESSION_BASELINE_FILE, 'utf-8')) as SeedData)
    : initialSeedData;
  const assumptions: MarketAssumptions = process.env.SESSION_ASSUMPTIONS_FILE
    ? (JSON.parse(
        readFileSync(process.env.SESSION_ASSUMPTIONS_FILE, 'utf-8'),
      ) as MarketAssumptions)
    : { ...DEFAULT_ASSUMPTIONS, simulationRuns: trialCount };

  // Even if the user supplied an assumptions file, force its trial count
  // to match the env so the CLI is the single source of truth here.
  assumptions.simulationRuns = trialCount;

  return {
    dispatcherUrl,
    trialCount,
    legacyTarget,
    feasibilityThreshold,
    maxPolicies,
    seed,
    assumptions,
    controllerName: process.env.HOST_DISPLAY_NAME ?? `controller-${hostname()}`,
  };
}

// ---------------------------------------------------------------------------
// Progress rendering
// ---------------------------------------------------------------------------

let lastEvaluated = 0;
let lastFeasible = 0;
function renderClusterState(snap: ClusterSnapshot): void {
  if (!snap.session) return;
  const stats = snap.session.stats;
  const newSinceLast = stats.policiesEvaluated - lastEvaluated;
  const newFeasible = stats.feasiblePolicies - lastFeasible;
  lastEvaluated = stats.policiesEvaluated;
  lastFeasible = stats.feasiblePolicies;
  const pct =
    stats.totalPolicies > 0
      ? ((stats.policiesEvaluated / stats.totalPolicies) * 100).toFixed(1)
      : '0.0';
  const remainingMin =
    stats.estimatedRemainingMs > 0
      ? (stats.estimatedRemainingMs / 60_000).toFixed(1) + ' min'
      : '?';
  const hostCount = snap.peers.filter((p) => p.roles.includes('host')).length;
  const metrics = snap.session.metrics;
  const activeHostCount = metrics?.activeHostCount ?? hostCount;
  const quarantinedHostCount = metrics?.quarantinedHostCount ?? 0;
  const unavailableHostCount = metrics?.unavailableHostCount ?? 0;
  const calibratingHostCount = metrics?.calibratingHostCount ?? 0;
  const inactiveHostCount = quarantinedHostCount + unavailableHostCount;
  log('progress', {
    pct: `${pct}%`,
    evaluated: `${stats.policiesEvaluated}/${stats.totalPolicies}`,
    feasible: stats.feasiblePolicies,
    new: newSinceLast,
    newFeasible,
    msPerPolicy: Math.round(stats.meanMsPerPolicy),
    eta: remainingMin,
    hosts:
      inactiveHostCount > 0
        ? `${activeHostCount}/${hostCount}`
        : activeHostCount,
    quarantinedHosts: quarantinedHostCount > 0 ? quarantinedHostCount : undefined,
    unavailableHosts: unavailableHostCount > 0 ? unavailableHostCount : undefined,
    calibratingHosts: calibratingHostCount > 0 ? calibratingHostCount : undefined,
    utilization: metrics?.hostUtilizationRate == null
      ? undefined
      : `${Math.round(metrics.hostUtilizationRate * 100)}%`,
    capacityNacks: metrics?.capacityNacks,
    dropped: metrics?.policiesDropped,
    avgBatch: metrics?.avgBatchSize == null ? undefined : Number(metrics.avgBatchSize.toFixed(1)),
    avgPump:
      metrics?.avgBatchesAssignedPerPump == null
        ? undefined
        : Number(metrics.avgBatchesAssignedPerPump.toFixed(1)),
    hostQueueMs:
      metrics?.avgHostQueueDelayMs == null
        ? undefined
        : Math.round(metrics.avgHostQueueDelayMs),
    appendMs:
      metrics?.avgCorpusAppendMs == null
        ? undefined
        : Math.round(metrics.avgCorpusAppendMs),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = resolveConfig();
  if (!Number.isFinite(cfg.trialCount) || cfg.trialCount < 1) {
    throw new Error(`invalid SESSION_TRIAL_COUNT=${cfg.trialCount}`);
  }
  if (!Number.isFinite(cfg.legacyTarget) || cfg.legacyTarget < 0) {
    throw new Error(`invalid SESSION_LEGACY_TARGET=${cfg.legacyTarget}`);
  }
  if (
    !Number.isFinite(cfg.feasibilityThreshold) ||
    cfg.feasibilityThreshold < 0 ||
    cfg.feasibilityThreshold > 1
  ) {
    throw new Error(`invalid SESSION_FEASIBILITY=${cfg.feasibilityThreshold}`);
  }

  const baselineFingerprint = computeBaselineFingerprint(cfg.seed);
  const axes = buildDefaultPolicyAxes(cfg.seed);
  const totalCandidates = countPolicyCandidates(axes);
  const cap = cfg.maxPolicies ?? totalCandidates;

  log('connecting', {
    dispatcher: cfg.dispatcherUrl,
    baselineFingerprint,
    totalCandidates,
    cap,
    trialCount: cfg.trialCount,
    feasibilityThreshold: cfg.feasibilityThreshold,
  });

  const ws = new WebSocket(cfg.dispatcherUrl);

  let resolveDone: (code: number) => void;
  const done = new Promise<number>((res) => {
    resolveDone = res;
  });

  let sessionId: string | null = null;
  let started = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const stopHeartbeat = (): void => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const startHeartbeat = (peerId: string): void => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const hb: HeartbeatMessage = {
        kind: 'heartbeat',
        from: peerId,
        inFlightBatchIds: [],
        freeWorkerSlots: 0,
      };
      ws.send(encodeMessage(hb));
    }, HEARTBEAT_INTERVAL_MS);
  };

  ws.on('open', () => {
    log('connected, registering as controller');
    ws.send(
      encodeMessage({
        kind: 'register',
        protocolVersion: MINING_PROTOCOL_VERSION,
        roles: ['controller'],
        displayName: cfg.controllerName,
      }),
    );
  });

  ws.on('message', (raw: Buffer) => {
    let message: ClusterMessage;
    try {
      message = decodeMessage(raw.toString('utf-8'));
    } catch (err) {
      log('decode error', { err: String(err) });
      return;
    }

    switch (message.kind) {
      case 'welcome': {
        log('welcomed', { peerId: message.peerId });
        startHeartbeat(message.peerId);
        // Now send the session start. The dispatcher generates and assigns
        // the sessionId; we'll learn it from the next cluster_state.
        //
        // Coarse-stage screening: env-driven first, with an automatic
        // default for V2-scale grids. The original Phase 2.C testing
        // (no wall-time win) was at 1,728 candidates; the V2 grid is
        // ~28× larger (49,368), so the trial-cost component grew enough
        // that coarse screening pays off again. Threshold tuned to keep
        // pre-V2-sized mines on the legacy single-pass path. Override
        // via SESSION_COARSE_TRIALS=0 to force-disable.
        const COARSE_AUTO_THRESHOLD = 5000;
        const coarseTrialsEnv = process.env.SESSION_COARSE_TRIALS;
        const coarseTrialsExplicit = coarseTrialsEnv !== undefined;
        const coarseTrials = coarseTrialsExplicit
          ? Number.parseInt(coarseTrialsEnv!, 10)
          : totalCandidates >= COARSE_AUTO_THRESHOLD
            ? 200
            : 0;
        const coarseStage = coarseTrials > 0
          ? {
              trialCount: coarseTrials,
              feasibilityBuffer: Number.parseFloat(
                process.env.SESSION_COARSE_BUFFER ?? '0.10',
              ),
            }
          : undefined;
        if (coarseStage && (
          !Number.isFinite(coarseStage.trialCount) ||
          coarseStage.trialCount <= 0 ||
          !Number.isFinite(coarseStage.feasibilityBuffer) ||
          coarseStage.feasibilityBuffer < 0
        )) {
          log('invalid coarse-stage config — ignored', {
            coarseTrialsEnv, coarseBufferEnv: process.env.SESSION_COARSE_BUFFER,
          });
        }
        const validCoarseStage = coarseStage &&
          Number.isFinite(coarseStage.trialCount) && coarseStage.trialCount > 0 &&
          Number.isFinite(coarseStage.feasibilityBuffer) && coarseStage.feasibilityBuffer >= 0
          ? coarseStage : undefined;
        if (validCoarseStage) {
          log('two-stage screening enabled', {
            ...validCoarseStage,
            source: coarseTrialsExplicit ? 'env' : 'auto:totalCandidates',
            totalCandidates,
          });
        }
        const config: PolicyMiningSessionConfig = {
          baselineFingerprint,
          engineVersion: POLICY_MINER_ENGINE_VERSION,
          axes,
          feasibilityThreshold: cfg.feasibilityThreshold,
          maxPoliciesPerSession: cap,
          coarseStage: validCoarseStage,
        };
        const start: StartSessionMessage = {
          kind: 'start_session',
          config,
          seedDataPayload: cfg.seed,
          marketAssumptionsPayload: cfg.assumptions,
          trialCount: cfg.trialCount,
          legacyTargetTodayDollars: cfg.legacyTarget,
          from: message.peerId,
        };
        ws.send(encodeMessage(start));
        log('start_session sent', { trialCount: cfg.trialCount, cap });
        return;
      }
      case 'register_rejected': {
        log('rejected by dispatcher', { reason: message.reason, detail: message.detail });
        ws.close();
        resolveDone(1);
        return;
      }
      case 'cluster_state': {
        if (message.snapshot.session) {
          if (!started) {
            sessionId = message.snapshot.session.sessionId;
            started = true;
            log('session active', { sessionId });
          }
          renderClusterState(message.snapshot);
        } else if (started) {
          // Session existed last tick, gone this tick → it ended.
          log('session ended, closing');
          ws.close();
          resolveDone(0);
        }
        return;
      }
      case 'evaluations_ingested': {
        // Cluster state already covers running totals; this is just
        // breadcrumbs for very large sessions where the user wants to
        // tail per-batch ingestion. Quiet by default.
        if (process.env.VERBOSE) {
          log('ingested', { batchSize: message.evaluationIds.length });
        }
        return;
      }
      default:
        // Other server-originated kinds (welcome, register_rejected handled
        // above; batch_assign etc. shouldn't arrive at a controller). Log
        // quietly so noise doesn't drown out progress.
        if (process.env.VERBOSE) {
          log('unhandled message', { kind: message.kind });
        }
    }
  });

  ws.on('close', (code) => {
    stopHeartbeat();
    log('connection closed', { code, sessionId });
    resolveDone(started ? 0 : 2);
  });

  ws.on('error', (err) => {
    stopHeartbeat();
    log('socket error', { err: String(err) });
    resolveDone(1);
  });

  // Ctrl-C → ask the dispatcher to cancel the session before we drop the
  // socket. Without this, the dispatcher would keep churning until it
  // detected the disconnect, which is fine but wasteful.
  process.on('SIGINT', () => {
    stopHeartbeat();
    if (sessionId) {
      log('SIGINT — cancelling session', { sessionId });
      try {
        ws.send(
          encodeMessage({
            kind: 'cancel_session',
            sessionId,
            reason: 'controller SIGINT',
          }),
        );
      } catch {
        /* socket may already be closed */
      }
    }
    setTimeout(() => process.exit(130), 500).unref();
  });

  const code = await done;
  process.exit(code);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[start-session] FAILED', err);
  process.exit(1);
});
