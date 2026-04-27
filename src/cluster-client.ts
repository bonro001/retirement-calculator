/**
 * Browser-side cluster client (Phase D.3).
 *
 * The browser plays two roles in the cluster simultaneously:
 *
 *   - **host**       : exposes its 12-worker policy-miner pool to the
 *                      dispatcher. Receives `batch_assign`, runs each batch
 *                      through `runPolicyBatch`, returns `batch_result`.
 *   - **controller** : the user clicks "Start mining" in the UI; the
 *                      browser sends `start_session` and the dispatcher
 *                      enumerates + dispatches across every host (the
 *                      browser itself, plus any Node hosts that connected).
 *
 * Why both roles in one client: the alternative is a separate
 * "cluster-controller-only" client that the UI uses, plus a daemon-style
 * "cluster-host-only" client. That double dispatches batches the browser
 * would otherwise run locally through a network hop to itself. Co-locating
 * makes a one-machine "cluster" (browser + localhost dispatcher) work
 * with no extra ceremony.
 *
 * What this module is NOT: React. The client is a plain object exposing
 * subscribe/unsubscribe; `useClusterSession` wraps it for components.
 *
 * Design choices:
 *
 * - **Native `WebSocket`**, not the `ws` npm package. The browser bundles
 *   `WebSocket` for free; pulling in `ws` (which depends on `node:net`)
 *   would break the Vite build.
 * - **Reconnect with capped exponential backoff**. The cluster/host.ts
 *   Node host uses "die and let the supervisor respawn"; the browser has
 *   no supervisor, so we reconnect in-process. Backoff prevents a hot
 *   loop when the dispatcher is down.
 * - **Single in-flight session**. We don't try to track overlapping
 *   sessions client-side — the dispatcher already enforces one-at-a-time
 *   semantics. If two `start_session` calls land back-to-back, the
 *   dispatcher decides which wins.
 * - **No persistence**. The browser pool runs batches and returns results
 *   to the dispatcher; the dispatcher writes the canonical corpus to disk
 *   under `cluster/data/sessions/`. The browser never writes to IndexedDB
 *   in cluster mode.
 */

import {
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type BatchAssignMessage,
  type BatchNackMessage,
  type BatchResultMessage,
  type CancelSessionMessage,
  type ClusterMessage,
  type ClusterSnapshot,
  type HeartbeatMessage,
  type HostCapabilities,
  type RegisterMessage,
  type StartSessionMessage,
} from './mining-protocol';
import {
  cancelMinerSession,
  describeMinerPoolSizing,
  getBrowserHostMode,
  getFreeMinerSlotCount,
  getMinerPoolSize,
  primeMinerSession,
  runPolicyBatch,
  unprimeMinerSession,
} from './policy-miner-pool';
import {
  POLICY_MINER_ENGINE_VERSION,
  type MiningJobResult,
  type PolicyEvaluation,
  type PolicyMiningSessionConfig,
} from './policy-miner-types';
import { buildDefaultPolicyAxes } from './policy-axis-enumerator';
import type { MarketAssumptions, SeedData } from './types';

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/**
 * Coarse client-state for the UI. Finer-grained errors are exposed via
 * `lastError` on the snapshot.
 *
 *   - `idle`         — `connect()` not yet called.
 *   - `connecting`   — socket is opening or has opened but not yet been welcomed.
 *   - `connected`    — `welcome` received; ready to receive batches and
 *                      send `start_session`.
 *   - `disconnected` — socket closed gracefully (e.g. user toggled off
 *                      cluster mode). Will not auto-reconnect.
 *   - `error`        — socket failed; auto-reconnect timer scheduled.
 */
export type ClusterClientState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface ClusterClientSnapshot {
  state: ClusterClientState;
  /** Peer id assigned by the dispatcher on `welcome`. Null until welcomed. */
  peerId: string | null;
  /** Last cluster snapshot the dispatcher broadcast. Null until first `cluster_state`. */
  cluster: ClusterSnapshot | null;
  /** Last user-visible error string; cleared on next successful connect. */
  lastError: string | null;
  /** ms-since-epoch of next reconnect attempt (for "retrying in 4s..." UI). Null when not retrying. */
  nextReconnectAtMs: number | null;
  /** Current dispatcher URL we're dialing. */
  dispatcherUrl: string;
}

export type ClusterClientListener = (snapshot: ClusterClientSnapshot) => void;

/**
 * Public surface the React hook (and any future caller) drives the
 * client through. Methods are synchronous fire-and-forget — observe
 * effects via `subscribe`.
 */
export interface ClusterClient {
  getSnapshot(): ClusterClientSnapshot;
  subscribe(listener: ClusterClientListener): () => void;
  /** Open a connection. Idempotent: no-op if already connecting/connected. */
  connect(): void;
  /** Close the socket and stop auto-reconnect. Idempotent. */
  disconnect(): void;
  /** Explicit retry — used by the "retry now" button in the UI. */
  reconnect(): void;
  /** Change the dispatcher URL. Triggers a reconnect if currently connected. */
  setDispatcherUrl(url: string): void;
  /**
   * Send a `start_session` to the dispatcher. The dispatcher generates
   * the sessionId and forwards `start_session` back to every host
   * (including this browser as host). Throws if not yet connected.
   */
  startSession(opts: StartSessionOptions): void;
  /** Send a `cancel_session` for the currently-active session. No-op if none. */
  cancelSession(reason?: string): void;
}

export interface StartSessionOptions {
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  legacyTargetTodayDollars: number;
  feasibilityThreshold: number;
  maxPoliciesPerSession?: number;
  /** Default 2000 — the production-grade trial count. */
  trialCount?: number;
  /**
   * Override the default axes (which come from `buildDefaultPolicyAxes`
   * applied to the baseline). Used by the E.5 sensitivity sweep to feed
   * a tight grid centered on an adopted policy. When set, the dispatcher
   * still does cartesian enumeration — caller controls the shape.
   */
  axesOverride?: import('./policy-miner-types').PolicyAxes;
  /**
   * Phase 2.C — two-stage screening (opt-in). When set, the dispatcher
   * runs a cheap coarse pass at `coarseStage.trialCount` first, drops
   * policies whose coarse `bequestAttainmentRate` is below
   * `feasibilityThreshold - coarseStage.feasibilityBuffer`, and
   * re-evaluates only the survivors at the full `trialCount`. Same top
   * winner as single-pass on every test run; correctness preserved.
   *
   * Per-batch fan-out is enabled on every cluster host (commit b2a7de9).
   * End-to-end cluster wall-time impact is currently neutral-to-mildly-
   * negative at 500-policy scale; see perf/PHASE_0_FINDINGS.md
   * "In-host fan-out attempt" subsection. Pure win on the in-process
   * pool path (browser-only sessions): ~1.79× at tight feasibility.
   */
  coarseStage?: {
    trialCount: number;
    feasibilityBuffer: number;
  };
}

interface ClusterClientConfig {
  dispatcherUrl: string;
  /** Display name surfaced in the per-host stats panel. */
  displayName: string;
}

// ---------------------------------------------------------------------------
// Reconnect tuning
// ---------------------------------------------------------------------------

/** First reconnect attempt fires this many ms after an unexpected close. */
const RECONNECT_INITIAL_MS = 1_000;
/** Each subsequent attempt doubles up to this ceiling. */
const RECONNECT_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Construct a fresh client. Most callers want one per app — the React
 * hook memoizes this so re-renders don't churn sockets.
 */
export function createClusterClient(config: ClusterClientConfig): ClusterClient {
  let dispatcherUrl = config.dispatcherUrl;
  const displayName = config.displayName;

  let socket: WebSocket | null = null;
  let snapshot: ClusterClientSnapshot = {
    state: 'idle',
    peerId: null,
    cluster: null,
    lastError: null,
    nextReconnectAtMs: null,
    dispatcherUrl,
  };
  const listeners = new Set<ClusterClientListener>();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = RECONNECT_INITIAL_MS;
  /** Set to true by `disconnect()`; suppresses auto-reconnect. */
  let intentionallyClosed = false;

  /** Per-session bookkeeping. Cleared on cancel / new session. */
  let activeSessionId: string | null = null;
  const inFlightBatchIds = new Set<string>();

  /** Mutate-and-broadcast helper. Always replaces the snapshot reference
   *  so React's `useSyncExternalStore` notices the change. */
  function publish(patch: Partial<ClusterClientSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener(snapshot);
  }

  // -------------------------------------------------------------------------
  // Capabilities — browser side equivalent of the Node host's auto-detect
  // -------------------------------------------------------------------------

  function browserCapabilities(): HostCapabilities {
    const sizing = describeMinerPoolSizing();
    // Apple Silicon (M-series) reports total cores via hardwareConcurrency
    // but Web Workers pin to the perf cluster — same heuristic as host.ts.
    const ua =
      typeof navigator !== 'undefined' ? navigator.userAgent ?? '' : '';
    const isAppleSilicon =
      /Mac/.test(ua) && /(Apple|Macintosh)/.test(ua); // ARM detection from UA is unreliable; assume Mac == AS for our fleet
    const perfClass: HostCapabilities['perfClass'] = isAppleSilicon
      ? 'apple-silicon-perf'
      : /Windows|Linux|X11/.test(ua)
        ? 'x86-modern'
        : 'unknown';
    return {
      workerCount: sizing.poolSize,
      perfClass,
      platformDescriptor: `browser-${ua.slice(0, 60).replace(/\s+/g, '_')}-hc${sizing.hardwareConcurrency}`,
    };
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  function clearTimers(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason: string): void {
    if (intentionallyClosed) return;
    if (reconnectTimer !== null) return;
    const delay = reconnectDelayMs;
    const at = Date.now() + delay;
    publish({
      state: 'error',
      lastError: reason,
      nextReconnectAtMs: at,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Exponential backoff capped at RECONNECT_MAX_MS so a long outage
      // doesn't hammer the dispatcher when it comes back.
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
      openSocket();
    }, delay);
  }

  function openSocket(): void {
    intentionallyClosed = false;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    publish({
      state: 'connecting',
      peerId: null,
      lastError: null,
      nextReconnectAtMs: null,
    });
    let s: WebSocket;
    try {
      s = new WebSocket(dispatcherUrl);
    } catch (err) {
      // Synchronous WebSocket() errors happen on malformed URLs. Surface
      // and schedule a retry — but not before the user fixes the URL,
      // so cap the loop by treating this like any other failure.
      scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    socket = s;

    s.addEventListener('open', () => {
      // Reset the backoff so the NEXT failure starts at 1s, not 30s.
      reconnectDelayMs = RECONNECT_INITIAL_MS;
      // Phase 2.C UX: when the user has set browser host mode to 'off',
      // register as controller-only — don't claim host capacity we won't
      // serve. This prevents the dispatcher from sending us batches when
      // a co-located Node host should handle that work instead.
      const browserMode = getBrowserHostMode();
      const isHost = browserMode !== 'off';
      const register: RegisterMessage = {
        kind: 'register',
        protocolVersion: MINING_PROTOCOL_VERSION,
        roles: isHost ? ['host', 'controller'] : ['controller'],
        displayName,
        capabilities: browserCapabilities(),
      };
      s.send(encodeMessage(register));
    });

    s.addEventListener('message', (event) => {
      // Browser WebSockets can deliver Blob, ArrayBuffer, or string
      // depending on `binaryType`. We send/receive JSON text, so coerce.
      if (typeof event.data !== 'string') return;
      let message: ClusterMessage;
      try {
        message = decodeMessage(event.data);
      } catch (err) {
        // Silent drop — same as host.ts. Log to aid local debugging.
        // eslint-disable-next-line no-console
        console.warn('[cluster-client] decode error', err);
        return;
      }
      void handleMessage(message);
    });

    s.addEventListener('error', () => {
      // The browser fires both 'error' and 'close' on a failed connection.
      // We act on close so we don't double-schedule reconnects; record
      // the fact for diagnostics here.
      // eslint-disable-next-line no-console
      console.warn('[cluster-client] socket error');
    });

    s.addEventListener('close', (event) => {
      clearTimers();
      socket = null;
      // Drop any cached session — when we reconnect, the dispatcher will
      // re-send a `start_session` if a session is still active.
      if (activeSessionId) {
        cancelMinerSession();
        unprimeMinerSession(activeSessionId);
        activeSessionId = null;
      }
      inFlightBatchIds.clear();
      if (intentionallyClosed) {
        publish({
          state: 'disconnected',
          peerId: null,
          cluster: null,
          nextReconnectAtMs: null,
        });
        return;
      }
      const reason =
        event.code === 1006
          ? 'connection lost (no response from dispatcher)'
          : `socket closed (code ${event.code}${event.reason ? ': ' + event.reason : ''})`;
      scheduleReconnect(reason);
    });
  }

  function startHeartbeat(): void {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (
        !snapshot.peerId ||
        !socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      const hb: HeartbeatMessage = {
        kind: 'heartbeat',
        from: snapshot.peerId,
        inFlightBatchIds: Array.from(inFlightBatchIds),
        freeWorkerSlots: getFreeMinerSlotCount(),
      };
      socket.send(encodeMessage(hb));
    }, HEARTBEAT_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Inbound message handling
  // -------------------------------------------------------------------------

  async function handleMessage(message: ClusterMessage): Promise<void> {
    switch (message.kind) {
      case 'welcome': {
        publish({
          state: 'connected',
          peerId: message.peerId,
          cluster: message.clusterSnapshot,
          lastError: null,
          nextReconnectAtMs: null,
        });
        startHeartbeat();
        return;
      }
      case 'register_rejected': {
        publish({
          state: 'error',
          lastError: `dispatcher rejected: ${message.reason} — ${message.detail}`,
        });
        // Deliberate disconnect — don't auto-reconnect on a protocol/cap
        // rejection. The user has to fix something (URL, version) first.
        intentionallyClosed = true;
        socket?.close();
        return;
      }
      case 'start_session': {
        handleStartSession(message);
        return;
      }
      case 'cancel_session': {
        handleCancelSession(message);
        return;
      }
      case 'batch_assign': {
        await handleBatchAssign(message);
        return;
      }
      case 'batch_ack': {
        inFlightBatchIds.delete(message.batchId);
        return;
      }
      case 'cluster_state': {
        publish({ cluster: message.snapshot });
        return;
      }
      case 'evaluations_ingested': {
        // Quiet — cluster_state already conveys totals. Future: poke a
        // results-table refresh by re-fetching the new IDs from the
        // dispatcher. Out of scope for D.3 minimum viable.
        return;
      }
      // Outbound-only kinds — should never arrive here. Ignore silently.
      case 'register':
      case 'heartbeat':
      case 'batch_result':
      case 'batch_nack':
        return;
      default: {
        // Exhaustiveness guard: if a new kind is added to ClusterMessage,
        // TS will flag this branch.
        const _exhaustive: never = message;
        void _exhaustive;
        return;
      }
    }
  }

  function handleStartSession(message: StartSessionMessage): void {
    // The dispatcher always stamps sessionId when forwarding to hosts.
    // The fallback to baselineFingerprint mirrors what cluster/host.ts
    // does for the D.2 direct-test path; in cluster mode it's never hit.
    const sessionId = message.sessionId ?? message.config.baselineFingerprint;
    if (activeSessionId && activeSessionId !== sessionId) {
      // Defensive — dispatcher promises one session at a time but be
      // robust to crossed wires (e.g. a stale start_session after
      // reconnect).
      cancelMinerSession();
      unprimeMinerSession(activeSessionId);
    }
    activeSessionId = sessionId;
    primeMinerSession({
      sessionId,
      data: message.seedDataPayload as SeedData,
      assumptions: message.marketAssumptionsPayload as MarketAssumptions,
      baselineFingerprint: message.config.baselineFingerprint,
      engineVersion: message.config.engineVersion,
      evaluatedByNodeId: snapshot.peerId ?? 'browser',
      legacyTargetTodayDollars: message.legacyTargetTodayDollars,
    });
  }

  function handleCancelSession(message: CancelSessionMessage): void {
    if (!activeSessionId || activeSessionId !== message.sessionId) return;
    cancelMinerSession();
    unprimeMinerSession(activeSessionId);
    activeSessionId = null;
    inFlightBatchIds.clear();
  }

  async function handleBatchAssign(message: BatchAssignMessage): Promise<void> {
    const { sessionId, batch } = message;
    if (!activeSessionId || activeSessionId !== sessionId) {
      sendNack(sessionId, batch.batchId, 'no_active_session');
      return;
    }
    if (batch.engineVersion !== POLICY_MINER_ENGINE_VERSION) {
      sendNack(sessionId, batch.batchId, 'engine_version_mismatch');
      return;
    }
    inFlightBatchIds.add(batch.batchId);
    const startedAt =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    let evaluations: PolicyEvaluation[] = [];
    let partialFailure: MiningJobResult['partialFailure'] = null;
    try {
      evaluations = await runPolicyBatch(sessionId, batch.policies);
    } catch (err) {
      const partial = (err as Error & { partial?: PolicyEvaluation[] })
        .partial;
      if (partial && partial.length > 0) evaluations = partial;
      partialFailure = {
        completedPolicyIds: evaluations.map((e) => e.id),
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    const endedAt =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const result: MiningJobResult = {
      batchId: batch.batchId,
      evaluatedByNodeId: snapshot.peerId ?? 'browser',
      batchDurationMs: Math.round(endedAt - startedAt),
      evaluations,
      partialFailure,
    };
    sendBatchResult(sessionId, result);
  }

  function sendBatchResult(
    sessionId: string,
    result: MiningJobResult,
  ): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const msg: BatchResultMessage = {
      kind: 'batch_result',
      from: snapshot.peerId ?? undefined,
      sessionId,
      result,
    };
    socket.send(encodeMessage(msg));
  }

  function sendNack(
    sessionId: string,
    batchId: string,
    reason: string,
  ): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const msg: BatchNackMessage = {
      kind: 'batch_nack',
      from: snapshot.peerId ?? undefined,
      sessionId,
      batchId,
      reason,
    };
    socket.send(encodeMessage(msg));
  }

  // -------------------------------------------------------------------------
  // Controller surface — start / cancel a session
  // -------------------------------------------------------------------------

  function startSession(opts: StartSessionOptions): void {
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !snapshot.peerId
    ) {
      throw new Error('cluster client not connected');
    }
    const axes = opts.axesOverride ?? buildDefaultPolicyAxes(opts.baseline);
    const config: PolicyMiningSessionConfig = {
      baselineFingerprint: opts.baselineFingerprint,
      engineVersion: POLICY_MINER_ENGINE_VERSION,
      axes,
      feasibilityThreshold: opts.feasibilityThreshold,
      maxPoliciesPerSession:
        opts.maxPoliciesPerSession ?? Number.MAX_SAFE_INTEGER,
      // Phase 2.C: optional two-stage screening config. When undefined
      // (the default), the dispatcher runs single-pass behavior. When
      // set, the dispatcher pre-screens every policy at coarse trial
      // count and re-evaluates only survivors at full trialCount.
      coarseStage: opts.coarseStage,
    };
    // Pin trialCount onto the assumptions payload so a host that uses
    // assumptions.simulationRuns ends up with the same number the
    // controller asked for. Mirror the CLI's behavior.
    const trialCount = opts.trialCount ?? 2000;
    const assumptionsWithTrials: MarketAssumptions = {
      ...opts.assumptions,
      simulationRuns: trialCount,
    };
    const start: StartSessionMessage = {
      kind: 'start_session',
      from: snapshot.peerId,
      config,
      seedDataPayload: opts.baseline,
      marketAssumptionsPayload: assumptionsWithTrials,
      trialCount,
      legacyTargetTodayDollars: opts.legacyTargetTodayDollars,
    };
    socket.send(encodeMessage(start));
  }

  function cancelSession(reason?: string): void {
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !snapshot.peerId
    ) {
      return;
    }
    // Prefer the dispatcher-known session id from cluster snapshot —
    // the activeSessionId we track is set on START but the controller
    // can also cancel a session we never primed for (e.g. session
    // running on Node hosts only because the browser was offline).
    const sid = snapshot.cluster?.session?.sessionId ?? activeSessionId;
    if (!sid) return;
    const msg: CancelSessionMessage = {
      kind: 'cancel_session',
      from: snapshot.peerId,
      sessionId: sid,
      reason,
    };
    socket.send(encodeMessage(msg));
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      // Push current snapshot so subscribers don't have to poll on mount.
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: openSocket,
    disconnect() {
      intentionallyClosed = true;
      clearTimers();
      socket?.close(1000, 'user disconnect');
    },
    reconnect() {
      // Cancel pending backoff, reset the curve, retry immediately.
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectDelayMs = RECONNECT_INITIAL_MS;
      socket?.close();
      openSocket();
    },
    setDispatcherUrl(url) {
      if (url === dispatcherUrl) return;
      dispatcherUrl = url;
      publish({ dispatcherUrl: url });
      // If we're currently connected/connecting, swap to the new URL.
      // If idle, the next connect() picks it up.
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        intentionallyClosed = false;
        reconnectDelayMs = RECONNECT_INITIAL_MS;
        socket.close();
        // openSocket will fire on the close listener via scheduleReconnect
        // — schedule one explicitly here so the user sees fast feedback.
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          openSocket();
        }, 50);
      }
    },
    startSession,
    cancelSession,
  };
}

// ---------------------------------------------------------------------------
// Helpers exposed for the React hook + UI
// ---------------------------------------------------------------------------

/** Default URL used when no localStorage override is present. */
export const DEFAULT_BROWSER_DISPATCHER_URL = 'ws://localhost:8765';

/** Browser pool size hint for capability advertisement. Shared with the
 *  card so the "12 workers" line in the UI matches what we told the
 *  dispatcher. Lazy: doesn't initialize the pool. */
export function browserPoolHint(): {
  poolSize: number;
  hardwareConcurrency: number;
  actualPoolSize: number | null;
  mode: 'off' | 'reduced' | 'full';
} {
  const sizing = describeMinerPoolSizing();
  // getMinerPoolSize spawns workers — only call when the pool is already
  // up. Heuristic: if free slot count is non-zero we know it's spawned.
  const free = getFreeMinerSlotCount();
  const actualPoolSize = free > 0 ? getMinerPoolSize() : null;
  return { ...sizing, actualPoolSize };
}

// Re-export the host-mode setter so the status card can flip the picker
// without importing from policy-miner-pool directly. Convention in this
// file: cluster-client is the public-facing surface for the UI.
export { setBrowserHostMode } from './policy-miner-pool';
