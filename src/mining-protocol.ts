/**
 * Policy Miner Cluster — over-the-wire protocol.
 *
 * Why a dedicated protocol module: the cluster spans browser ↔ Node ↔
 * Node, and every participant needs a single source of truth for what a
 * message looks like. Sticking these types next to the engine (in
 * `policy-miner-types.ts`) would couple the wire format to engine
 * internals; keeping them separate here means we can change the engine's
 * `PolicyEvaluation` shape without renegotiating with offline hosts.
 *
 * Design constraints, in priority order:
 *
 *   1. JSON-friendly. Every payload field round-trips through
 *      `JSON.stringify` / `JSON.parse` cleanly. No `Date`, no `Map`, no
 *      typed arrays — those break across language boundaries (Node ↔
 *      browser is fine but a future Python or Rust host should drop in
 *      with no surprises).
 *   2. Explicit discriminator. Every message has a `kind` literal so a
 *      narrowing switch in the receiver is exhaustive at compile time.
 *      Adding a new message kind forces the compiler to flag every
 *      switch that doesn't handle it.
 *   3. Forward compatible. Optional fields use `?` and consumers tolerate
 *      unknown fields silently. We will absolutely add new fields without
 *      a coordinated cluster restart — old hosts must keep working.
 *   4. Self-routing. The `to` field on outbound messages lets the
 *      dispatcher target a specific host; missing `to` means broadcast.
 *      Hosts always set `from` so multi-hop debugging is possible.
 *
 * What this module is NOT: a transport. WebSocket framing, reconnection,
 * back-pressure all live in the dispatcher / host runtimes. This file is
 * just the alphabet they speak.
 */

import type {
  MiningJobBatch,
  MiningJobResult,
  MiningStats,
  PolicyMiningSessionConfig,
} from './policy-miner-types';

/**
 * Cluster protocol version. Bumped when an existing message kind's shape
 * changes incompatibly (renamed field, removed field, semantic shift).
 * Adding a new optional field or a new message kind does NOT require a
 * bump — old peers will ignore the unknown field/kind.
 *
 * On the wire: every connection sends `register` first with this value,
 * and the dispatcher refuses any peer whose major version differs. This
 * is the cluster's only hard compatibility check.
 */
export const MINING_PROTOCOL_VERSION = '1.0.0';

/** Default WebSocket port the dispatcher listens on. Picked to be memorable
 * and well outside the IANA registered range. Override with env var on the
 * dispatcher and per-host config on the workers. */
export const DEFAULT_DISPATCHER_PORT = 8765;

/**
 * Roles a peer can play in the cluster. A single peer can hold multiple
 * roles — the browser is typically `host` AND `controller` because it
 * both does work and starts/cancels sessions. Stored on the dispatcher's
 * peer registry so we can route messages correctly.
 *
 *   - `host`       — runs the engine, evaluates batches
 *   - `controller` — kicks off / cancels sessions, observes stats
 *   - `observer`   — read-only stats subscriber (e.g. a future ops dashboard)
 */
export type PeerRole = 'host' | 'controller' | 'observer';

export interface ClusterBuildInfo {
  packageVersion: string;
  gitBranch: string | null;
  gitCommit: string | null;
  gitDirty: boolean;
  gitDirtyFiles?: string[];
  gitUpstream: string | null;
  gitUpstreamCommit: string | null;
  source: 'git' | 'env' | 'unknown';
}

export type ClusterBuildStatus =
  | 'match'
  | 'mismatch'
  | 'dirty'
  | 'unknown';

/**
 * Capabilities a host advertises at registration time. The dispatcher
 * uses these to decide how big a batch to send and how aggressively to
 * keep that host fed.
 *
 * Why these fields: batch sizing is the load-balancer's primary lever.
 * A 16-thread Ryzen wants 4-8× the work-in-flight that a 4-perf-core M1
 * does. Without a hint from the host, the dispatcher would over- or
 * under-feed and waste capacity.
 */
export interface HostCapabilities {
  /**
   * Effective worker count. For Apple Silicon, this is perf cluster ×
   * oversubscription factor (12 on the M4 mini). For x86 with SMT, it's
   * the thread count (16 on Ryzen 7800X3D). The dispatcher treats this
   * as "max simultaneous batches in flight", not "trust me, I have N
   * physical cores".
   */
  workerCount: number;
  /**
   * Coarse perf hint so the dispatcher can size INITIAL batches before
   * any throughput data is in. After ~5 batches the dispatcher uses
   * measured ms/policy and ignores this. Tags: `apple-silicon-perf`,
   * `apple-silicon-efficiency`, `x86-modern`, `x86-legacy`.
   */
  perfClass:
    | 'apple-silicon-perf'
    | 'apple-silicon-efficiency'
    | 'x86-modern'
    | 'x86-legacy'
    | 'unknown';
  /**
   * What the host platform reports — for the "10 cores reported" UI line
   * and for diagnostics when a host underperforms. Free-form so different
   * platforms can put what they have (e.g. `darwin-arm64-10cpu` or
   * `win32-x64-16cpu-amd-ryzen7-7800x3d`).
   */
  platformDescriptor: string;
  /**
   * Engine runtime the host will use for policy batches. Optional so
   * older hosts can still join; UI treats missing as "unknown".
   */
  engineRuntime?: string;
}

/**
 * The base envelope every message rides in. Specific message kinds extend
 * this with their own payload. We keep envelope fields short to minimize
 * overhead on the high-frequency `heartbeat` and `batch_progress` traffic.
 */
interface BaseMessage {
  /** Discriminator — exhaustively switched at every receive site. */
  kind: string;
  /** Stable id for this peer (assigned by the dispatcher on register). */
  from?: string;
  /** Target peer id; omit to broadcast. */
  to?: string;
  /** Correlation id when this message replies to a prior one. */
  replyTo?: string;
  /** Sender-local timestamp in ms-since-epoch. Diagnostic only. */
  ts?: number;
}

// ============================================================================
// Connection lifecycle
// ============================================================================

/**
 * First message a peer sends after the WebSocket opens. The dispatcher
 * refuses the connection if `protocolVersion` major differs, then assigns
 * a `peerId` and replies with `welcome`.
 *
 * `desiredPeerId` lets a host that just reconnected after a crash claim
 * its old slot back. The dispatcher honors it if not already in use.
 */
export interface RegisterMessage extends BaseMessage {
  kind: 'register';
  protocolVersion: string;
  roles: PeerRole[];
  /** Human-readable name for logs and the per-host stats panel. */
  displayName: string;
  /** Git/package identity for version compatibility diagnostics. */
  buildInfo?: ClusterBuildInfo;
  /** Stable id the peer would prefer to keep across reconnects. */
  desiredPeerId?: string;
  /** Only set when `roles` includes `host`. */
  capabilities?: HostCapabilities;
}

/**
 * Dispatcher's reply to `register`. Carries the peer's assigned id (which
 * the peer must echo as `from` on every subsequent message) plus the
 * current cluster snapshot so a fresh observer can render state without
 * asking.
 */
export interface WelcomeMessage extends BaseMessage {
  kind: 'welcome';
  peerId: string;
  /** Dispatcher's protocol version — peer can sanity-check the negotiation. */
  protocolVersion: string;
  /** The cluster as the dispatcher sees it right now. */
  clusterSnapshot: ClusterSnapshot;
}

/**
 * Dispatcher's polite refusal when the negotiation fails. The WebSocket
 * is closed immediately after sending. Reason is a short machine-readable
 * tag plus a human-readable detail.
 */
export interface RegisterRejectedMessage extends BaseMessage {
  kind: 'register_rejected';
  reason:
    | 'protocol_version_mismatch'
    | 'duplicate_peer_id'
    | 'capacity'
    | 'unknown';
  detail: string;
}

// ============================================================================
// Liveness
// ============================================================================

/**
 * Periodic ping — every host sends one every `HEARTBEAT_INTERVAL_MS` so
 * the dispatcher can detect dead hosts without waiting on TCP-level
 * keepalive (which is configured at the OS level and varies wildly).
 *
 * The `inFlightBatchIds` field doubles as recovery hint: if the
 * dispatcher missed a `batch_result` due to network blip, the hb tells
 * it which batches are still owed and lets it re-ack on the next round.
 */
export interface HeartbeatMessage extends BaseMessage {
  kind: 'heartbeat';
  /** Batches the host believes it still owes a result on. */
  inFlightBatchIds: string[];
  /** Currently free worker slots — capacity hint for the next batch_assign. */
  freeWorkerSlots: number;
  /**
   * Optional per-host tuning hints derived from the host's own observed
   * behavior — only the host can measure these cheaply (e.g., how often
   * its workers wait for the next batch). Dispatcher uses them to size
   * batches and the in-flight queue per-host instead of using a global
   * constant. Absent on hosts that haven't gathered enough data yet
   * (typically the first ~5 batches of a session).
   */
  tuningHints?: HostTuningHints;
}

/**
 * Per-host tuning hints. Each field is a host's *own* recommendation
 * based on local-only signals; the dispatcher reads them as advisory
 * input to its batch sizing and in-flight queue logic. The host doesn't
 * see other peers' state, so a host can't recommend cluster-wide knobs
 * like worker pool topology.
 */
export interface HostTuningHints {
  /**
   * Median worker idle gap (ms) between finishing one batch and being
   * assigned the next. High values (>200ms with sub-second per-batch
   * compute) indicate the dispatcher should ship more in-flight batches
   * to keep the worker pool fed.
   */
  workerIdleP50Ms?: number;
  /**
   * 95th-percentile worker idle gap (ms). Tail starvation signal —
   * even when median looks fine, sustained high p95 means the host
   * regularly empties its local queue waiting for work.
   */
  workerIdleP95Ms?: number;
  /**
   * Host's own opinion of `IN_FLIGHT_PER_PEER`. Computed from the
   * idle/thrash trade-off the host can observe locally — at 1 the
   * worker pool starves on every batch boundary; at too-high values
   * batches pile up in pendingBatchQueue, holding seedDataPayload
   * memory references with no throughput gain.
   */
  recommendedInFlight?: number;
  /**
   * Host's own opinion of the batch size that maximizes throughput
   * given its worker count and per-policy compute time. Bigger batches
   * amortize per-batch coordination overhead (websocket frame, JSON
   * parse, host main → worker_thread postMessage) but also delay the
   * first result and risk one slow worker tail-blocking the batch.
   */
  recommendedBatchSize?: number;
  /**
   * napi crossing time as a fraction of total per-policy compute (0..1).
   * High values (>0.20) mean the host is paying serialization overhead
   * disproportionate to actual rust compute — a multi-policy napi call
   * would help. Low values mean batch-size knobs dominate.
   */
  napiOverheadFraction?: number;
}

// ============================================================================
// Session control (controller → dispatcher)
// ============================================================================

/**
 * Controller asks the dispatcher to start a new mining session. The
 * dispatcher enumerates policies and starts handing batches to registered
 * hosts. There can be at most one active session at a time per dispatcher.
 *
 * `seedDataPayload` and `marketAssumptionsPayload` are the heavy bits —
 * sending them once at session start (and the dispatcher caching them
 * per-session) means individual `batch_assign` messages can omit them
 * after the first batch to a given host.
 */
export interface StartSessionMessage extends BaseMessage {
  kind: 'start_session';
  config: PolicyMiningSessionConfig;
  /** Serialized SeedData. JSON object — the engine recasts at use site. */
  seedDataPayload: unknown;
  /** Serialized MarketAssumptions. Same as above. */
  marketAssumptionsPayload: unknown;
  /** Trial count per policy this session. Pinned by the controller. */
  trialCount: number;
  /** Legacy bequest target (today $) for attainment rate calc. */
  legacyTargetTodayDollars: number;
  /**
   * Canonical session id, set by the dispatcher when it forwards a
   * start_session to hosts. Omitted on the controller → dispatcher path
   * because the dispatcher generates the id. Hosts MUST use this value
   * (when present) to key their primedSessionIds map so the sessionId
   * on subsequent `batch_assign` messages matches; if omitted, falls back
   * to `config.baselineFingerprint` for backwards compat with the D.2
   * direct-test path.
   */
  sessionId?: string;
}

export interface CancelSessionMessage extends BaseMessage {
  kind: 'cancel_session';
  /** Session id to cancel — defensive against a stale cancel arriving after a new session started. */
  sessionId: string;
  reason?: string;
}

// ============================================================================
// Work distribution (dispatcher ↔ host)
// ============================================================================

/**
 * Dispatcher hands a host a batch to evaluate. The batch is the existing
 * `MiningJobBatch` shape — already designed for this — wrapped with
 * routing metadata.
 */
export interface BatchAssignMessage extends BaseMessage {
  kind: 'batch_assign';
  /** Session this batch belongs to. Hosts ignore batches from a cancelled session. */
  sessionId: string;
  batch: MiningJobBatch;
  /** Soft deadline — if the host can't finish by then, it should `nack` so the dispatcher reassigns. */
  softDeadlineMs?: number;
}

/**
 * Host returns results to the dispatcher. The result contains zero or
 * more evaluations plus an optional `partialFailure`. The dispatcher
 * rebroadcasts the evaluations to subscribed observers and forwards
 * any failed policies back into its work queue.
 */
export interface BatchResultMessage extends BaseMessage {
  kind: 'batch_result';
  sessionId: string;
  result: MiningJobResult;
}

/**
 * Host can't take this batch right now (overloaded, GC pause, whatever).
 * Dispatcher reassigns immediately. Use sparingly — repeated nacks from
 * one host trigger the dispatcher to reduce that host's batch size.
 */
export interface BatchNackMessage extends BaseMessage {
  kind: 'batch_nack';
  sessionId: string;
  batchId: string;
  reason: string;
}

/**
 * Dispatcher's ack for a received result. The host clears its
 * in-flight tracking on receipt. If the ack never comes (network blip),
 * the next heartbeat re-syncs in-flight state.
 */
export interface BatchAckMessage extends BaseMessage {
  kind: 'batch_ack';
  sessionId: string;
  batchId: string;
}

// ============================================================================
// Stats / observability
// ============================================================================

export interface ClusterPeerMetrics {
  assignedBatches: number;
  completedBatches: number;
  nackedBatches: number;
  capacityNacks: number;
  assignedPolicies: number;
  completedPolicies: number;
  reservedWorkerSlots: number;
  busySlotMs: number;
  idleWhilePendingSlotMs: number;
  utilizationRate: number | null;
  avgDispatchToResultMs: number | null;
}

export interface ClusterRuntimeMetrics {
  pendingPolicies: number;
  inFlightBatches: number;
  batchesAssigned: number;
  batchResults: number;
  batchNacks: number;
  capacityNacks: number;
  policiesAssigned: number;
  policiesCompleted: number;
  policiesRequeued: number;
  policiesDropped: number;
  avgBatchSize: number | null;
  avgDispatchToResultMs: number | null;
  hostBusySlotMs: number;
  hostIdleWhilePendingSlotMs: number;
  hostUtilizationRate: number | null;
}

/**
 * Snapshot of the entire cluster — peers, current session, per-host
 * throughput. Sent on `welcome` and re-broadcast every
 * `STATE_BROADCAST_INTERVAL_MS` while a session is active.
 *
 * The shape mirrors what the status card needs to render so the browser
 * doesn't have to massage it before display.
 */
export interface ClusterSnapshot {
  protocolVersion: string;
  /** Code identity the dispatcher expects hosts to run. */
  dispatcherBuildInfo?: ClusterBuildInfo;
  peers: Array<{
    peerId: string;
    displayName: string;
    roles: PeerRole[];
    capabilities: HostCapabilities | null;
    buildInfo?: ClusterBuildInfo;
    buildStatus?: ClusterBuildStatus;
    /** Last heartbeat received, ms-since-epoch. Used to render "stale" indicators. */
    lastHeartbeatTs: number | null;
    /** Rolling mean wall-clock ms per policy on this host. */
    meanMsPerPolicy: number | null;
    /** Batches in flight on this host right now. */
    inFlightBatchCount: number;
    metrics?: ClusterPeerMetrics;
  }>;
  /** Current session — null when nothing is mining. */
  session: {
    sessionId: string;
    startedAtIso: string;
    stats: MiningStats;
    metrics?: ClusterRuntimeMetrics;
  } | null;
}

/**
 * Dispatcher → all subscribed peers: refreshed snapshot. Cheap to compute,
 * cheap to send (a few KB), and the broadcast cadence stays slow enough
 * (~1 Hz) that the wire stays quiet.
 */
export interface ClusterStateMessage extends BaseMessage {
  kind: 'cluster_state';
  snapshot: ClusterSnapshot;
}

/**
 * Dispatcher → controllers: a batch's evaluations have been ingested into
 * the canonical corpus. Lets the browser update its local view without
 * having to round-trip through `loadEvaluationsForBaseline`. Optional
 * — the browser can also poll `cluster_state` and re-fetch.
 */
export interface EvaluationsIngestedMessage extends BaseMessage {
  kind: 'evaluations_ingested';
  sessionId: string;
  /** Just the IDs — the controller fetches full records on demand. */
  evaluationIds: string[];
}

// ============================================================================
// Discriminated union of every kind the wire can carry
// ============================================================================

export type ClusterMessage =
  | RegisterMessage
  | WelcomeMessage
  | RegisterRejectedMessage
  | HeartbeatMessage
  | StartSessionMessage
  | CancelSessionMessage
  | BatchAssignMessage
  | BatchResultMessage
  | BatchNackMessage
  | BatchAckMessage
  | ClusterStateMessage
  | EvaluationsIngestedMessage;

// ============================================================================
// Serialization helpers
// ============================================================================

/**
 * Tagged-error class for parse failures. Lets the dispatcher distinguish
 * "malformed JSON" (drop the connection) from "valid JSON but wrong
 * shape" (log and ignore the message).
 */
export class ProtocolParseError extends Error {
  readonly raw: string;
  readonly cause: unknown;
  constructor(raw: string, cause: unknown) {
    super(
      `mining-protocol parse error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.raw = raw;
    this.cause = cause;
  }
}

/**
 * Stamp every outbound message with `ts` and serialize. Centralizing
 * here means we can later add framing (length-prefix, gzip, signature)
 * without touching the dispatcher or host code.
 */
export function encodeMessage(message: ClusterMessage): string {
  const stamped = { ...message, ts: message.ts ?? Date.now() };
  return JSON.stringify(stamped);
}

/**
 * Parse + light validation. We trust JSON.parse to verify syntax and
 * trust the discriminated union switch downstream to catch unknown
 * `kind` values; this function only enforces "is an object with a
 * string `kind` field" so the switch can take it from there.
 */
export function decodeMessage(raw: string): ClusterMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProtocolParseError(raw, err);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { kind?: unknown }).kind !== 'string'
  ) {
    throw new ProtocolParseError(raw, new Error('missing or non-string `kind`'));
  }
  return parsed as ClusterMessage;
}

/** Heartbeat cadence in ms. Hosts emit at this interval; dispatcher
 *  considers a host stale at 3× this (~9s) and disconnected at 6× (~18s). */
export const HEARTBEAT_INTERVAL_MS = 3000;

/** Cluster state broadcast cadence — slow enough that a 10-host cluster
 *  generates negligible chatter, fast enough that the UI feels live. */
export const STATE_BROADCAST_INTERVAL_MS = 1000;
