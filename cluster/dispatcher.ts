/**
 * Policy Miner Cluster — Dispatcher.
 *
 * A small Node service that:
 *   1. Accepts WebSocket connections from hosts (browser tabs, Node
 *      processes on other machines), controllers, and observers.
 *   2. Maintains the authoritative peer registry for the cluster.
 *   3. Owns the "what session is running" state machine.
 *   4. Hands `MiningJobBatch`es to hosts and ingests `MiningJobResult`s
 *      back into the canonical corpus on disk.
 *
 * D.4 scope (this commit): all four items above. A controller (today the
 * `cluster:start-session` CLI; later the browser via D.3) sends
 * `start_session`; the dispatcher enumerates policies, opens a session
 * dir on disk, and starts handing batches to every connected host. As
 * results arrive they're appended to `evaluations.jsonl` and broadcast
 * to subscribed observers via `cluster_state`.
 *
 * Why a separate Node service instead of running everything in the
 * browser:
 *   - Browsers can't accept inbound WebSocket connections, only outbound.
 *     The cluster needs a server somewhere; that server may as well
 *     also coordinate.
 *   - The dispatcher needs to outlive any single browser tab. Closing
 *     the unified-plan tab today kills the mining session; with a
 *     dispatcher, the tab is just a client and the session keeps running.
 *   - The canonical corpus on the dispatcher is the bridge between hosts.
 *     Each host writes through to the same JSONL log; dedupe is automatic
 *     via the deterministic policy id.
 *
 * Design notes:
 *   - Single in-process state. Peer registry and session bookkeeping live
 *     in plain Maps and die with the process. Evaluation records ARE
 *     persisted (`evaluations.jsonl`); peer state isn't.
 *   - No auth. LAN-only by default; we bind to all interfaces but rely
 *     on the local network being trusted.
 *   - One session at a time. Multi-session would require per-session
 *     batch routing tables — keep it simple until we need it.
 *   - No resume. If the dispatcher restarts mid-session, the controller
 *     has to re-issue start_session. Resume is D.5.
 */

import { createServer, type IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_DISPATCHER_PORT,
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  STATE_BROADCAST_INTERVAL_MS,
  ProtocolParseError,
  decodeMessage,
  encodeMessage,
  type BatchAssignMessage,
  type CancelSessionMessage,
  type ClusterMessage,
  type ClusterSnapshot,
  type HostCapabilities,
  type PeerRole,
  type RegisterMessage,
  type StartSessionMessage,
  type WelcomeMessage,
} from '../src/mining-protocol';
import {
  enumeratePolicies,
} from '../src/policy-axis-enumerator';
import type {
  MiningJobBatch,
  MiningStats,
  PolicyMiningSessionConfig,
} from '../src/policy-miner-types';
import {
  WorkQueue,
  recommendedBatchSize,
} from './work-queue';
import {
  appendEvaluations,
  closeSessionWithStats,
  openSessionForWrite,
  type SessionManifest,
} from './corpus-writer';

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

/**
 * In-process record for one connected peer. The registry is a `Map<peerId,
 * Peer>` keyed by the dispatcher-assigned id. The WebSocket reference
 * lets us push messages; the metadata fields are mirrored into
 * `ClusterSnapshot.peers` on every state broadcast.
 *
 * Throughput tracking lives here too because (a) the dispatcher uses it
 * to size subsequent batches and (b) the snapshot includes it for the
 * per-host UI panel.
 */
interface Peer {
  peerId: string;
  displayName: string;
  roles: PeerRole[];
  capabilities: HostCapabilities | null;
  socket: WebSocket;
  lastHeartbeatTs: number | null;
  /** Rolling mean ms-per-policy from completed batches. Updated on each
   *  batch_result; used by `recommendedBatchSize` once it's non-null. */
  meanMsPerPolicy: number | null;
  /** Free worker slots reported by the host's last heartbeat. Defaults to
   *  capabilities.workerCount on register so the very first batch can ship
   *  before any heartbeat has arrived. */
  freeWorkerSlots: number;
  /** Batch ids the dispatcher has handed this peer and not yet seen acked. */
  inFlightBatchIds: Set<string>;
  /** Connection time, used for "uptime" diagnostics in logs. */
  connectedAtMs: number;
  /** Count of completed batches; threshold for "trust the measured mean
   *  over the perf-class hint" lives in recommendedBatchSize. */
  completedBatchCount: number;
  /** Earliest wall-clock ms at which this peer may be re-fed. Set by the
   *  nack handler to break tight nack loops; the failsafe pump tick
   *  retries after the cooldown elapses. */
  pumpCooldownUntilMs: number;
}

/** How long after a nack to skip a peer in pumpDispatch. Long enough to
 *  let the host re-prime / recover; short enough that a healthy host
 *  bouncing one bad batch doesn't sit idle. */
const NACK_COOLDOWN_MS = 1_000;

const peers = new Map<string, Peer>();

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Everything we need to know about the currently-running session. Null when
 * the cluster is idle. There's at most one — `start_session` is rejected
 * if this is non-null; `cancel_session` and natural completion both clear it.
 */
interface ActiveSession {
  sessionId: string;
  startedAtIso: string;
  config: PolicyMiningSessionConfig;
  trialCount: number;
  legacyTargetTodayDollars: number;
  /** The pre-serialized SeedData / MarketAssumptions to ship in every
   *  batch. We keep the parsed JSON here (not re-stringified) so each
   *  batch_assign serialization is a single JSON.stringify pass instead
   *  of stringify-then-parse-then-stringify. */
  seedDataPayload: unknown;
  marketAssumptionsPayload: unknown;
  queue: WorkQueue;
  /** Best policy id seen so far; mirrored into the cluster snapshot. */
  bestPolicyId: string | null;
  /** Rolling mean ms/policy across the whole cluster. Used for the ETA. */
  clusterMeanMsPerPolicy: number;
  /** Total policy-evaluations the queue has yielded; used to keep the
   *  rolling mean stable as samples accumulate. */
  ingestedSamples: number;
  controllerPeerId: string | null;
}

let activeSession: ActiveSession | null = null;

/**
 * Counter to generate unique peer ids when a peer doesn't request one.
 * Format: `${hostname}-${role-tag}-${counter}` so logs are scannable.
 */
let peerIdCounter = 0;
function generatePeerId(displayName: string, roles: PeerRole[]): string {
  peerIdCounter += 1;
  const roleTag = roles.includes('host') ? 'h' : roles.includes('controller') ? 'c' : 'o';
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  return `${slug || 'peer'}-${roleTag}-${peerIdCounter}`;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const SELF_HOST = hostname();
function log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  // eslint-disable-next-line no-console
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  stream(`[${ts}] [dispatcher@${SELF_HOST}] [${level}] ${message}${metaStr}`);
}

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

/**
 * Build a wire-friendly snapshot from in-process state. Pure function of
 * `peers` + `activeSession` so tests can stub it.
 */
function buildClusterSnapshot(): ClusterSnapshot {
  let session: ClusterSnapshot['session'] = null;
  if (activeSession) {
    const queueSnap = activeSession.queue.snapshot();
    const stats: MiningStats = {
      sessionStartedAtIso: activeSession.startedAtIso,
      totalPolicies: queueSnap.totalPolicies,
      policiesEvaluated: queueSnap.evaluatedCount,
      feasiblePolicies: queueSnap.feasibleCount,
      meanMsPerPolicy: activeSession.clusterMeanMsPerPolicy,
      // p95 isn't tracked precisely on the dispatcher; expose mean × 1.5
      // as a rough placeholder. The browser UI labels this "approx" anyway.
      p95MsPerPolicy: activeSession.clusterMeanMsPerPolicy * 1.5,
      estimatedRemainingMs: estimateRemainingMs(),
      bestPolicyId: activeSession.bestPolicyId,
      state: queueSnap.evaluatedCount === 0 ? 'running' : 'running',
      lastError: null,
    };
    session = {
      sessionId: activeSession.sessionId,
      startedAtIso: activeSession.startedAtIso,
      stats,
    };
  }
  return {
    protocolVersion: MINING_PROTOCOL_VERSION,
    peers: [...peers.values()].map((p) => ({
      peerId: p.peerId,
      displayName: p.displayName,
      roles: p.roles,
      capabilities: p.capabilities,
      lastHeartbeatTs: p.lastHeartbeatTs,
      meanMsPerPolicy: p.meanMsPerPolicy,
      inFlightBatchCount: p.inFlightBatchIds.size,
    })),
    session,
  };
}

/** Cluster-wide ETA. With distributed work the right way is
 *  remainingPolicies × clusterMean / sumOfWorkerCounts; we approximate
 *  by counting all advertised worker slots. Returns 0 when the session
 *  hasn't measured throughput yet. */
function estimateRemainingMs(): number {
  if (!activeSession) return 0;
  const remaining = activeSession.queue.pendingCount() + activeSession.queue.inFlightCount();
  if (remaining === 0) return 0;
  if (activeSession.clusterMeanMsPerPolicy <= 0) return 0;
  let totalSlots = 0;
  for (const peer of peers.values()) {
    if (peer.roles.includes('host')) {
      totalSlots += peer.capabilities?.workerCount ?? 1;
    }
  }
  if (totalSlots === 0) return 0;
  return Math.round((remaining * activeSession.clusterMeanMsPerPolicy) / totalSlots);
}

/** Send a message to one specific peer. Drops silently if the socket
 *  isn't open — the peer's heartbeat timeout will clean up the dead
 *  registry entry on the next sweep. */
function sendTo(peer: Peer, message: ClusterMessage): void {
  if (peer.socket.readyState !== peer.socket.OPEN) return;
  try {
    peer.socket.send(encodeMessage(message));
  } catch (err) {
    log('warn', 'send failed', { peerId: peer.peerId, err: String(err) });
  }
}

/** Broadcast to every peer matching the role filter. Used for cluster
 *  state pushes (everyone) and session events (controllers + observers). */
function broadcast(message: ClusterMessage, rolesFilter?: PeerRole[]): void {
  for (const peer of peers.values()) {
    if (rolesFilter && !peer.roles.some((r) => rolesFilter.includes(r))) continue;
    sendTo(peer, message);
  }
}

function broadcastClusterState(): void {
  broadcast({ kind: 'cluster_state', snapshot: buildClusterSnapshot(), from: 'dispatcher' });
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function handleRegister(socket: WebSocket, registration: RegisterMessage, remoteAddress: string): Peer | null {
  const incomingMajor = registration.protocolVersion.split('.')[0];
  const expectedMajor = MINING_PROTOCOL_VERSION.split('.')[0];
  if (incomingMajor !== expectedMajor) {
    const reject = encodeMessage({
      kind: 'register_rejected',
      reason: 'protocol_version_mismatch',
      detail: `dispatcher speaks v${MINING_PROTOCOL_VERSION}, peer speaks v${registration.protocolVersion}`,
    });
    socket.send(reject);
    socket.close(1002, 'protocol version mismatch');
    log('warn', 'register rejected: protocol version mismatch', {
      peer: registration.displayName,
      peerVersion: registration.protocolVersion,
    });
    return null;
  }

  let peerId = registration.desiredPeerId ?? generatePeerId(registration.displayName, registration.roles);
  if (registration.desiredPeerId && peers.has(registration.desiredPeerId)) {
    log('warn', 'desired peer id in use, generating fresh id', {
      requested: registration.desiredPeerId,
      assigned: peerId,
    });
    peerId = generatePeerId(registration.displayName, registration.roles);
  }

  const peer: Peer = {
    peerId,
    displayName: registration.displayName,
    roles: registration.roles,
    capabilities: registration.capabilities ?? null,
    socket,
    lastHeartbeatTs: Date.now(),
    meanMsPerPolicy: null,
    // Seed free slots from advertised worker count so we can dispatch the
    // first batch before any heartbeat arrives. Heartbeats refine this.
    freeWorkerSlots: registration.capabilities?.workerCount ?? 0,
    inFlightBatchIds: new Set(),
    connectedAtMs: Date.now(),
    completedBatchCount: 0,
    pumpCooldownUntilMs: 0,
  };
  peers.set(peerId, peer);

  const welcome: WelcomeMessage = {
    kind: 'welcome',
    peerId,
    protocolVersion: MINING_PROTOCOL_VERSION,
    clusterSnapshot: buildClusterSnapshot(),
    from: 'dispatcher',
    to: peerId,
  };
  sendTo(peer, welcome);

  log('info', 'peer registered', {
    peerId,
    displayName: peer.displayName,
    roles: peer.roles.join(','),
    workers: peer.capabilities?.workerCount ?? '?',
    perfClass: peer.capabilities?.perfClass ?? 'unknown',
    remoteAddress,
  });

  // A new host arriving means new capacity — bring it up to speed on the
  // active session (if any) and try to feed it immediately.
  if (peer.roles.includes('host') && activeSession) {
    forwardStartSessionToOnePeer(peer);
    pumpDispatch();
  }

  return peer;
}

/** Unregister + clean up. Idempotent. If the peer had in-flight batches
 *  for the active session, requeue them before returning so a fast
 *  reconnect-elsewhere doesn't permanently lose work. */
function handleDisconnect(peer: Peer | null, reason: string): void {
  if (!peer) return;
  if (!peers.has(peer.peerId)) return;
  peers.delete(peer.peerId);
  let requeued = 0;
  if (activeSession && activeSession.queue.hasInFlightForPeer(peer.peerId)) {
    requeued = activeSession.queue.requeueAllForPeer(peer.peerId);
  }
  log('info', 'peer disconnected', {
    peerId: peer.peerId,
    displayName: peer.displayName,
    reason,
    uptimeMs: Date.now() - peer.connectedAtMs,
    requeuedBatches: requeued,
  });
  broadcastClusterState();
  // Requeued work needs to land somewhere; pump immediately.
  if (requeued > 0 && activeSession) {
    pumpDispatch();
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function handleStartSession(peer: Peer, message: StartSessionMessage): void {
  if (activeSession) {
    log('warn', 'start_session rejected: another session active', {
      from: peer.peerId,
      activeSessionId: activeSession.sessionId,
    });
    // We don't have a dedicated reject message kind for this, so we just
    // log loudly. The controller observes via cluster_state that the
    // session it asked for never appeared and can re-issue.
    return;
  }
  if (!peer.roles.includes('controller')) {
    log('warn', 'start_session from non-controller, ignored', { from: peer.peerId });
    return;
  }

  // Validate config minimally — schema correctness is the controller's job;
  // we only check the things that would crash the dispatcher.
  const cfg = message.config;
  if (!cfg || !cfg.axes || !cfg.baselineFingerprint) {
    log('warn', 'start_session: invalid config', { from: peer.peerId });
    return;
  }
  const policies = enumeratePolicies(cfg.axes);
  if (policies.length === 0) {
    log('warn', 'start_session: enumerator produced 0 policies', { from: peer.peerId });
    return;
  }
  const cap = cfg.maxPoliciesPerSession;
  const sliced =
    cap && cap > 0 && cap < policies.length ? policies.slice(0, cap) : policies;

  // Stamp the session id with controller name + time so logs read well
  // and re-running doesn't risk colliding with a stale on-disk session dir.
  const startedAtMs = Date.now();
  const sessionId = `s-${cfg.baselineFingerprint.slice(0, 12)}-${startedAtMs}`;
  const startedAtIso = new Date(startedAtMs).toISOString();

  const queue = new WorkQueue(sessionId, sliced);

  const manifest: SessionManifest = {
    sessionId,
    startedAtIso,
    config: cfg,
    trialCount: message.trialCount,
    legacyTargetTodayDollars: message.legacyTargetTodayDollars,
    totalPolicies: sliced.length,
    startedBy: peer.displayName,
  };
  try {
    openSessionForWrite(manifest);
  } catch (err) {
    log('error', 'session: corpus open failed', { err: String(err), sessionId });
    return;
  }

  activeSession = {
    sessionId,
    startedAtIso,
    config: cfg,
    trialCount: message.trialCount,
    legacyTargetTodayDollars: message.legacyTargetTodayDollars,
    seedDataPayload: message.seedDataPayload,
    marketAssumptionsPayload: message.marketAssumptionsPayload,
    queue,
    bestPolicyId: null,
    clusterMeanMsPerPolicy: 0,
    ingestedSamples: 0,
    controllerPeerId: peer.peerId,
  };

  log('info', 'session started', {
    sessionId,
    totalPolicies: sliced.length,
    trialCount: message.trialCount,
    feasibilityThreshold: cfg.feasibilityThreshold,
    controller: peer.displayName,
    hostsAvailable: [...peers.values()].filter((p) => p.roles.includes('host')).length,
  });

  // Forward start_session to every host so they prime their worker pools
  // BEFORE the first batch_assign arrives. Without this the host nacks
  // every batch with `no_active_session`. The forwarded message includes
  // the canonical sessionId so subsequent batch_assigns match.
  forwardStartSessionToHosts();

  broadcastClusterState();
  pumpDispatch();
}

/** Send the active session's start_session payload to every host. Idempotent
 *  on the host side — a host that's already primed for this baseline will
 *  warn and replace, but the underlying prime is keyed per worker so
 *  re-priming is harmless. */
function forwardStartSessionToHosts(): void {
  if (!activeSession) return;
  const session = activeSession;
  const start: StartSessionMessage = {
    kind: 'start_session',
    config: session.config,
    seedDataPayload: session.seedDataPayload,
    marketAssumptionsPayload: session.marketAssumptionsPayload,
    trialCount: session.trialCount,
    legacyTargetTodayDollars: session.legacyTargetTodayDollars,
    sessionId: session.sessionId,
    from: 'dispatcher',
  };
  for (const peer of peers.values()) {
    if (!peer.roles.includes('host')) continue;
    sendTo(peer, start);
  }
}

/** Send a single host the current session's start_session. Used when a
 *  host registers mid-session so the next batch_assign doesn't bounce. */
function forwardStartSessionToOnePeer(peer: Peer): void {
  if (!activeSession) return;
  const session = activeSession;
  const start: StartSessionMessage = {
    kind: 'start_session',
    config: session.config,
    seedDataPayload: session.seedDataPayload,
    marketAssumptionsPayload: session.marketAssumptionsPayload,
    trialCount: session.trialCount,
    legacyTargetTodayDollars: session.legacyTargetTodayDollars,
    sessionId: session.sessionId,
    from: 'dispatcher',
    to: peer.peerId,
  };
  sendTo(peer, start);
}

function handleCancelSession(peer: Peer, message: CancelSessionMessage): void {
  if (!activeSession || activeSession.sessionId !== message.sessionId) {
    log('info', 'cancel_session: no matching active session, ignored', {
      from: peer.peerId,
      requested: message.sessionId,
    });
    return;
  }
  log('info', 'session cancelled by controller', {
    sessionId: activeSession.sessionId,
    from: peer.peerId,
    reason: message.reason ?? '(none)',
  });
  endSession('cancelled', message.reason ?? 'controller cancel');
}

/** Tear down the active session: write summary, clear in-flight, broadcast.
 *  Safe to call multiple times; only the first call has an effect. */
function endSession(state: 'completed' | 'cancelled' | 'error', reason?: string): void {
  if (!activeSession) return;
  const session = activeSession;
  // Tell hosts to drop their primed sessions BEFORE we null activeSession
  // — endSession can be re-entrant from a pump-after-broadcast and we
  // don't want a doubled cancel. The host's cancel handler is itself
  // idempotent so a duplicate cancel is harmless either way.
  for (const peer of peers.values()) {
    if (!peer.roles.includes('host')) continue;
    sendTo(peer, {
      kind: 'cancel_session',
      sessionId: session.sessionId,
      reason: reason ?? `session ${state}`,
      from: 'dispatcher',
      to: peer.peerId,
    });
  }
  activeSession = null; // clear FIRST so re-entrant pumps see no session

  const queueSnap = session.queue.snapshot();
  const summary = closeSessionWithStats(
    session.sessionId,
    state,
    session.startedAtIso,
    {
      totalPolicies: queueSnap.totalPolicies,
      evaluatedCount: queueSnap.evaluatedCount,
      feasibleCount: queueSnap.feasibleCount,
    },
    reason,
  );

  // Wipe in-flight ids on every host — there's nothing in flight anymore
  // because the session is gone and the queue is dropped. The hosts will
  // also drop them on their next batch_ack timeout, but cleaning here
  // keeps the cluster snapshot honest immediately.
  for (const peer of peers.values()) {
    peer.inFlightBatchIds.clear();
  }

  log('info', 'session ended', {
    sessionId: session.sessionId,
    state,
    reason: reason ?? '(none)',
    totalPolicies: queueSnap.totalPolicies,
    evaluatedCount: queueSnap.evaluatedCount,
    feasibleCount: queueSnap.feasibleCount,
    bestPolicyId: summary?.bestPolicyId ?? null,
  });

  broadcastClusterState();
}

// ---------------------------------------------------------------------------
// Batch dispatch
// ---------------------------------------------------------------------------

/**
 * The pump. Walks every host with free worker slots and assigns a batch
 * sized for that host. Idempotent — calling it more than necessary is
 * harmless; missing a call is the bug to avoid (it manifests as an idle
 * host while the queue still has work).
 *
 * Triggered from:
 *   - start_session (kick things off)
 *   - new host registers (capacity grew)
 *   - heartbeat (host's freeWorkerSlots changed)
 *   - batch_result / batch_nack (a slot became free)
 *   - 1Hz failsafe tick (catches whatever edge case we forgot)
 */
function pumpDispatch(): void {
  if (!activeSession) return;
  const session = activeSession;
  if (session.queue.pendingCount() === 0) {
    // No more pending — but maybe still in-flight. If neither, the
    // session is done.
    if (session.queue.inFlightCount() === 0) {
      endSession('completed');
    }
    return;
  }

  // Walk hosts in a stable order so a tied set of hosts is fair across
  // pumps. Sort by displayName as a deterministic-ish proxy.
  const hostsByName = [...peers.values()]
    .filter((p) => p.roles.includes('host'))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const now = Date.now();
  for (const peer of hostsByName) {
    if (session.queue.pendingCount() === 0) break;
    if (peer.freeWorkerSlots <= 0) continue;
    if (peer.socket.readyState !== peer.socket.OPEN) continue;
    if (peer.pumpCooldownUntilMs > now) continue;

    // One batch per pump-call per host. Multi-batch-per-pump is doable
    // but adds bookkeeping; the 1Hz tick catches any host that needs a
    // second helping after its first batch completes.
    const size = recommendedBatchSize(
      peer.capabilities?.perfClass ?? 'unknown',
      peer.completedBatchCount >= 3 ? peer.meanMsPerPolicy : null,
      session.queue.pendingCount(),
    );
    const assigned = session.queue.assignBatch(peer.peerId, size);
    if (!assigned) continue;

    const batch: MiningJobBatch = {
      batchId: assigned.batchId,
      baselineFingerprint: session.config.baselineFingerprint,
      engineVersion: session.config.engineVersion,
      seedDataPayload: session.seedDataPayload,
      marketAssumptionsPayload: session.marketAssumptionsPayload,
      policies: assigned.policies,
      trialCount: session.trialCount,
    };
    const batchAssign: BatchAssignMessage = {
      kind: 'batch_assign',
      sessionId: session.sessionId,
      batch,
      from: 'dispatcher',
      to: peer.peerId,
    };
    sendTo(peer, batchAssign);
    peer.inFlightBatchIds.add(assigned.batchId);
    // Optimistic decrement; the next heartbeat will correct us if the
    // host's worker pool was actually busier than we thought.
    peer.freeWorkerSlots = Math.max(0, peer.freeWorkerSlots - 1);
  }
}

/**
 * Result handler. Validates session match, records in queue, appends to
 * corpus, updates per-host throughput, broadcasts evaluations_ingested,
 * acks the host, and pumps again.
 */
function handleBatchResult(peer: Peer, message: Extract<ClusterMessage, { kind: 'batch_result' }>): void {
  if (!activeSession || message.sessionId !== activeSession.sessionId) {
    log('warn', 'batch_result for unknown/old session, ignored', {
      from: peer.peerId,
      reportedSession: message.sessionId,
      activeSession: activeSession?.sessionId ?? null,
    });
    // Still ack so the host clears its in-flight tracking.
    sendTo(peer, {
      kind: 'batch_ack',
      sessionId: message.sessionId,
      batchId: message.result.batchId,
      from: 'dispatcher',
      to: peer.peerId,
    });
    return;
  }
  const session = activeSession;

  // Append to disk. We do this BEFORE marking the batch complete so that
  // a write failure doesn't leave us with a queue that thinks the work
  // is done while the corpus is missing it.
  let appendOutcome: { feasibleInBatch: number; runningBest: ReturnType<typeof appendEvaluations>['runningBest'] };
  try {
    appendOutcome = appendEvaluations(session.sessionId, message.result.evaluations);
  } catch (err) {
    log('error', 'corpus append failed — requeueing batch', {
      err: String(err),
      sessionId: session.sessionId,
      batchId: message.result.batchId,
    });
    // Don't complete; let the next nack/disconnect path requeue. To force
    // immediate reassignment, we just don't ack — the heartbeat reconciler
    // (D.5) would handle this, but for now log and move on.
    return;
  }

  const completed = session.queue.completeBatch(message.result.batchId, appendOutcome.feasibleInBatch);
  if (!completed) {
    log('warn', 'batch_result for unknown batch (already completed?)', {
      from: peer.peerId,
      batchId: message.result.batchId,
    });
    // Still send an ack — the host needs to clear its in-flight tracking.
    sendTo(peer, {
      kind: 'batch_ack',
      sessionId: session.sessionId,
      batchId: message.result.batchId,
      from: 'dispatcher',
      to: peer.peerId,
    });
    return;
  }

  // Update per-host throughput. msPerPolicy from the batch dominates the
  // EWMA; we keep the EWMA so a single slow batch doesn't tank the
  // estimate that the next pump uses for sizing.
  if (message.result.evaluations.length > 0) {
    const batchMsPerPolicy = message.result.batchDurationMs / message.result.evaluations.length;
    if (peer.meanMsPerPolicy === null) {
      peer.meanMsPerPolicy = batchMsPerPolicy;
    } else {
      // Alpha 0.3 — recent batches matter but we don't ignore history.
      peer.meanMsPerPolicy = peer.meanMsPerPolicy * 0.7 + batchMsPerPolicy * 0.3;
    }
    peer.completedBatchCount += 1;

    // Cluster mean — straight average across all evaluations seen this
    // session, weighted by sample count (so a fast host doing 80% of the
    // work doesn't get out-voted by a slow one).
    const newSamples = session.ingestedSamples + message.result.evaluations.length;
    session.clusterMeanMsPerPolicy =
      (session.clusterMeanMsPerPolicy * session.ingestedSamples +
        batchMsPerPolicy * message.result.evaluations.length) /
      newSamples;
    session.ingestedSamples = newSamples;
  }

  if (appendOutcome.runningBest) {
    session.bestPolicyId = appendOutcome.runningBest.id;
  }
  peer.inFlightBatchIds.delete(message.result.batchId);
  // Heartbeats refine free-slot count; the result implies +1 since one
  // worker just freed up.
  peer.freeWorkerSlots += 1;

  // Ack so the host clears its in-flight tracking.
  sendTo(peer, {
    kind: 'batch_ack',
    sessionId: session.sessionId,
    batchId: message.result.batchId,
    from: 'dispatcher',
    to: peer.peerId,
  });

  // Tell controllers + observers what landed. evaluationIds, not full
  // records — the canonical store on disk has everything; this is just
  // a "go look".
  broadcast(
    {
      kind: 'evaluations_ingested',
      sessionId: session.sessionId,
      evaluationIds: message.result.evaluations.map((ev) => ev.id),
      from: 'dispatcher',
    },
    ['controller', 'observer'],
  );

  // Pump first (might queue another batch on this host) THEN broadcast
  // state — the broadcast then includes the freshly-issued batch.
  pumpDispatch();
  broadcastClusterState();
}

function handleBatchNack(peer: Peer, message: Extract<ClusterMessage, { kind: 'batch_nack' }>): void {
  if (!activeSession || message.sessionId !== activeSession.sessionId) {
    log('warn', 'batch_nack for unknown/old session, ignored', {
      from: peer.peerId,
      reportedSession: message.sessionId,
    });
    return;
  }
  const requeued = activeSession.queue.requeueBatch(message.batchId);
  peer.inFlightBatchIds.delete(message.batchId);
  peer.freeWorkerSlots += 1;
  // Cool-down: don't reassign to this peer for a moment. Without this, a
  // peer that's permanently broken (priming failure, stale state) and a
  // dispatcher that always pumps on nack go into a tight infinite-loop
  // racing through batch ids. The 1Hz failsafe pump will retry within a
  // second — plenty fast.
  peer.pumpCooldownUntilMs = Date.now() + NACK_COOLDOWN_MS;
  log('info', 'batch nacked, requeued (peer in cooldown)', {
    from: peer.peerId,
    batchId: message.batchId,
    reason: message.reason,
    requeued,
    cooldownMs: NACK_COOLDOWN_MS,
  });
  // Pump OTHER hosts immediately — they may have idle slots and the
  // requeued batch is now at the head of the queue.
  pumpDispatch();
  broadcastClusterState();
}

// ---------------------------------------------------------------------------
// Per-socket message dispatch
// ---------------------------------------------------------------------------

function handleMessage(peer: Peer, message: ClusterMessage): void {
  switch (message.kind) {
    case 'register':
      log('warn', 'register from already-registered peer, ignored', { peerId: peer.peerId });
      return;

    case 'heartbeat': {
      peer.lastHeartbeatTs = Date.now();
      const prevFree = peer.freeWorkerSlots;
      peer.freeWorkerSlots = message.freeWorkerSlots;
      // If the host now thinks it has more free slots than we did, pump
      // — this catches the case where our optimistic decrement was wrong
      // or where an in-flight batch finished without us noticing.
      if (activeSession && message.freeWorkerSlots > prevFree) {
        pumpDispatch();
      }
      return;
    }

    case 'start_session':
      handleStartSession(peer, message);
      return;

    case 'cancel_session':
      handleCancelSession(peer, message);
      return;

    case 'batch_result':
      handleBatchResult(peer, message);
      return;

    case 'batch_nack':
      handleBatchNack(peer, message);
      return;

    case 'welcome':
    case 'register_rejected':
    case 'batch_assign':
    case 'batch_ack':
    case 'cluster_state':
    case 'evaluations_ingested':
      // Server-originated kinds — should never arrive from a peer.
      log('warn', `unexpected server-originated kind from peer`, {
        kind: message.kind,
        peerId: peer.peerId,
      });
      return;

    default: {
      const exhaustive: never = message;
      log('warn', 'unknown message kind', { kind: (exhaustive as { kind: string }).kind });
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat sweep
// ---------------------------------------------------------------------------

const STALE_PEER_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 6;

function sweepStalePeers(): void {
  const now = Date.now();
  for (const peer of [...peers.values()]) {
    if (peer.lastHeartbeatTs === null) continue;
    const silentMs = now - peer.lastHeartbeatTs;
    if (silentMs > STALE_PEER_THRESHOLD_MS) {
      log('warn', 'stale peer, disconnecting', {
        peerId: peer.peerId,
        silentMs,
      });
      try {
        peer.socket.close(1001, 'heartbeat timeout');
      } catch {
        /* socket may already be dead */
      }
      handleDisconnect(peer, 'heartbeat timeout');
    }
  }
}

// ---------------------------------------------------------------------------
// Server boot
// ---------------------------------------------------------------------------

function startDispatcher(port: number): void {
  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          protocolVersion: MINING_PROTOCOL_VERSION,
          peerCount: peers.size,
          activeSessionId: activeSession?.sessionId ?? null,
          uptimeSec: Math.round(process.uptime()),
        }),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found — try ws:// upgrade or /health');
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress ?? 'unknown';
    log('info', 'incoming connection', { remoteAddress });

    let peer: Peer | null = null;

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString('utf-8');
      let message: ClusterMessage;
      try {
        message = decodeMessage(text);
      } catch (err) {
        if (err instanceof ProtocolParseError) {
          log('warn', 'malformed message, closing socket', {
            err: err.message,
            remoteAddress,
          });
          socket.close(1002, 'protocol error');
        } else {
          log('error', 'unexpected parse error', { err: String(err) });
          socket.close(1011, 'internal error');
        }
        return;
      }

      if (!peer) {
        if (message.kind !== 'register') {
          log('warn', 'first message was not register, closing', {
            kind: message.kind,
            remoteAddress,
          });
          socket.close(1002, 'register required first');
          return;
        }
        peer = handleRegister(socket, message, remoteAddress);
        if (peer) {
          broadcastClusterState();
        }
        return;
      }

      handleMessage(peer, message);
    });

    socket.on('close', (code, reasonBuf) => {
      handleDisconnect(peer, `code=${code} reason=${reasonBuf.toString('utf-8') || '(none)'}`);
    });

    socket.on('error', (err) => {
      log('warn', 'socket error', { err: String(err), peerId: peer?.peerId });
      handleDisconnect(peer, `socket error: ${err.message}`);
    });
  });

  httpServer.listen(port, () => {
    log('info', 'dispatcher listening', {
      port,
      protocolVersion: MINING_PROTOCOL_VERSION,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      stateBroadcastIntervalMs: STATE_BROADCAST_INTERVAL_MS,
      pid: process.pid,
    });
  });

  // Periodic cluster-state broadcast.
  setInterval(() => {
    if (peers.size === 0) return;
    broadcastClusterState();
  }, STATE_BROADCAST_INTERVAL_MS);

  // Stale peer sweep.
  setInterval(sweepStalePeers, HEARTBEAT_INTERVAL_MS);

  // 1Hz failsafe pump — covers any edge case where a slot freed up but
  // we missed the wake-up trigger. The pump itself is cheap (early-exits
  // when there's no session or no work).
  setInterval(() => {
    if (activeSession) pumpDispatch();
  }, 1_000);

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    log('info', 'shutting down', { signal, peerCount: peers.size });
    if (activeSession) {
      // Mark session as cancelled so the on-disk summary is consistent.
      endSession('cancelled', `dispatcher shutdown (${signal})`);
    }
    for (const peer of peers.values()) {
      try {
        peer.socket.close(1001, 'dispatcher shutting down');
      } catch {
        /* already dead */
      }
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const portEnv = process.env.DISPATCHER_PORT;
const port = portEnv ? Number(portEnv) : DEFAULT_DISPATCHER_PORT;
if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
  // eslint-disable-next-line no-console
  console.error(`invalid DISPATCHER_PORT="${portEnv}"`);
  process.exit(1);
}
startDispatcher(port);
