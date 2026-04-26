/**
 * Policy Miner Cluster — Dispatcher.
 *
 * A small Node service that:
 *   1. Accepts WebSocket connections from hosts (browser tabs, Node
 *      processes on other machines), controllers, and observers.
 *   2. Maintains the authoritative peer registry for the cluster.
 *   3. Owns the "what session is running" state machine.
 *   4. Hands `MiningJobBatch`es to hosts and ingests `MiningJobResult`s
 *      back into the canonical corpus.
 *
 * D.1 scope (this commit): items 1 and 2 only — accept connections,
 * track peers, broadcast cluster state on a tick. No work is dispatched
 * yet; that arrives in D.2-D.4. The protocol module already understands
 * the message kinds for those phases, so a peer that connects today
 * will see correct registration / heartbeat / state behavior even
 * before the work-distribution code ships.
 *
 * Why a separate Node service instead of running everything in the
 * browser:
 *   - Browsers can't accept inbound WebSocket connections, only outbound.
 *     The cluster needs a server somewhere; that server may as well
 *     also coordinate.
 *   - The dispatcher needs to outlive any single browser tab. Closing
 *     the unified-plan tab today kills the mining session; with a
 *     dispatcher, the tab is just a client and the session keeps running.
 *   - The canonical corpus on the dispatcher (arriving in D.4) becomes
 *     a bridge between hosts. Today each browser has its own IDB; with
 *     the dispatcher, every host writes through to the same store and
 *     dedupe is automatic.
 *
 * Design notes:
 *   - Single in-process state. No database for D.1 — peer registry lives
 *     in a Map and dies with the process. D.4 adds a JSONL log on disk
 *     for the corpus; the peer registry is intentionally ephemeral.
 *   - No auth. LAN-only by default; we bind to all interfaces but rely
 *     on the local network being trusted. Hardening to internet-facing
 *     would need TLS + token, well outside D.1 scope.
 *   - One session at a time. Multi-session would require per-session
 *     batch routing tables — keep it simple until we need it.
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
  type ClusterMessage,
  type ClusterSnapshot,
  type HostCapabilities,
  type PeerRole,
  type RegisterMessage,
  type WelcomeMessage,
} from '../src/mining-protocol';

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

/**
 * In-process record for one connected peer. The registry is a `Map<peerId,
 * Peer>` keyed by the dispatcher-assigned id. The WebSocket reference
 * lets us push messages; the metadata fields are mirrored into
 * `ClusterSnapshot.peers` on every state broadcast.
 *
 * Throughput tracking lives here too because (a) the dispatcher needs
 * it for batch sizing decisions in D.2+ and (b) the snapshot includes
 * it for the per-host UI panel.
 */
interface Peer {
  peerId: string;
  displayName: string;
  roles: PeerRole[];
  capabilities: HostCapabilities | null;
  socket: WebSocket;
  lastHeartbeatTs: number | null;
  /** Rolling mean ms-per-policy from the last K batch results (D.2+). */
  meanMsPerPolicy: number | null;
  /** Batch ids the dispatcher has handed this peer and not yet seen acked. */
  inFlightBatchIds: Set<string>;
  /** Connection time, used for "uptime" diagnostics in logs. */
  connectedAtMs: number;
}

const peers = new Map<string, Peer>();

/**
 * Counter to generate unique peer ids when a peer doesn't request one.
 * Format: `${hostname}-${role-tag}-${counter}` so logs are scannable.
 * Persisting across restarts isn't useful — peers always re-register.
 */
let peerIdCounter = 0;
function generatePeerId(displayName: string, roles: PeerRole[]): string {
  peerIdCounter += 1;
  const roleTag = roles.includes('host') ? 'h' : roles.includes('controller') ? 'c' : 'o';
  // Strip non-id-safe chars from displayName so the id stays grep-friendly.
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  return `${slug || 'peer'}-${roleTag}-${peerIdCounter}`;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Tiny structured logger. Tagged with the dispatcher hostname so a
 * forwarded log line keeps its origin, and timestamped at second
 * precision for grep-after-the-fact debugging. Level prefixes (`info`,
 * `warn`, `error`) line up so the output reads like a familiar log.
 */
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
 * Build the wire-friendly snapshot from the in-process registry. Pure
 * function of `peers` so tests can stub it.
 */
function buildClusterSnapshot(): ClusterSnapshot {
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
    // No active session in D.1. D.2-D.3 fill this in.
    session: null,
  };
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

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

/**
 * Deal with the first message on a new socket. Must be `register` or we
 * close the connection — defends against accidental http traffic and
 * malformed clients.
 */
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

  // Honor `desiredPeerId` only if it's not currently in use. Reconnecting
  // hosts pass their old id so cluster snapshots don't churn — but two
  // peers with the same id at the same time would corrupt routing.
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
    inFlightBatchIds: new Set(),
    connectedAtMs: Date.now(),
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

  return peer;
}

/** Unregister + clean up. Idempotent — safe to call from both `close`
 *  and `error` handlers without double-counting. */
function handleDisconnect(peer: Peer | null, reason: string): void {
  if (!peer) return;
  if (!peers.has(peer.peerId)) return; // already removed
  peers.delete(peer.peerId);
  log('info', 'peer disconnected', {
    peerId: peer.peerId,
    displayName: peer.displayName,
    reason,
    uptimeMs: Date.now() - peer.connectedAtMs,
  });
  // Push fresh snapshot so observers see the absence quickly.
  broadcast({ kind: 'cluster_state', snapshot: buildClusterSnapshot(), from: 'dispatcher' });
}

/**
 * Main per-socket handler. Most kinds are no-ops in D.1 — we log and
 * move on so peers exercising the protocol see consistent behavior.
 * Real handlers land in D.2 (batch flow) and D.3 (controller commands).
 */
function handleMessage(peer: Peer, message: ClusterMessage): void {
  switch (message.kind) {
    case 'register':
      // Already-registered peer re-sending register — ignore. They should
      // open a fresh connection for re-registration.
      log('warn', 'register from already-registered peer, ignored', { peerId: peer.peerId });
      return;

    case 'heartbeat':
      peer.lastHeartbeatTs = Date.now();
      // D.2+ will reconcile inFlightBatchIds with our records here.
      return;

    case 'start_session':
    case 'cancel_session':
      log('info', `${message.kind} received (D.2 handler not yet wired)`, {
        from: peer.peerId,
      });
      return;

    case 'batch_result':
    case 'batch_nack':
      log('info', `${message.kind} received (D.2 handler not yet wired)`, {
        from: peer.peerId,
        sessionId: message.sessionId,
      });
      return;

    case 'welcome':
    case 'register_rejected':
    case 'batch_assign':
    case 'batch_ack':
    case 'cluster_state':
    case 'evaluations_ingested':
      // Server-originated kinds — should never arrive from a peer. Log
      // loudly so a misbehaving client is visible.
      log('warn', `unexpected server-originated kind from peer`, {
        kind: message.kind,
        peerId: peer.peerId,
      });
      return;

    default: {
      // Exhaustiveness guard. If a new kind is added to the protocol
      // and a handler isn't wired, the compiler complains here.
      const exhaustive: never = message;
      log('warn', 'unknown message kind', { kind: (exhaustive as { kind: string }).kind });
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat sweep
// ---------------------------------------------------------------------------

/** How long without a heartbeat before we declare a peer dead. 6× the
 *  expected heartbeat interval = ~18s — long enough to ride out a brief
 *  network blip, short enough that a dead host stops getting work soon. */
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
        /* socket may already be dead — ignore */
      }
      handleDisconnect(peer, 'heartbeat timeout');
    }
  }
}

// ---------------------------------------------------------------------------
// Server boot
// ---------------------------------------------------------------------------

function startDispatcher(port: number): void {
  // We use a plain HTTP server underneath so a `GET /health` endpoint
  // works for ops tooling alongside the WebSocket upgrade path.
  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          protocolVersion: MINING_PROTOCOL_VERSION,
          peerCount: peers.size,
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

      // First message must be `register`. Anything else and we close.
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
          // Push fresh snapshot so existing peers see the new arrival.
          broadcast({
            kind: 'cluster_state',
            snapshot: buildClusterSnapshot(),
            from: 'dispatcher',
          });
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

  // Periodic cluster-state broadcast. Cheap (a few KB to N peers at 1Hz)
  // and gives observers a steady refresh without each one polling.
  setInterval(() => {
    if (peers.size === 0) return;
    broadcast({ kind: 'cluster_state', snapshot: buildClusterSnapshot(), from: 'dispatcher' });
  }, STATE_BROADCAST_INTERVAL_MS);

  // Stale peer sweep. Runs at the heartbeat interval, not the threshold,
  // so detection latency stays bounded even if a peer dies mid-tick.
  setInterval(sweepStalePeers, HEARTBEAT_INTERVAL_MS);

  // Graceful shutdown — close all peer sockets so clients see a clean
  // disconnect instead of TCP RST. Important for the browser host: a
  // clean close lets it auto-reconnect when the dispatcher comes back.
  const shutdown = (signal: string) => {
    log('info', 'shutting down', { signal, peerCount: peers.size });
    for (const peer of peers.values()) {
      try {
        peer.socket.close(1001, 'dispatcher shutting down');
      } catch {
        /* already dead */
      }
    }
    httpServer.close(() => process.exit(0));
    // Failsafe: don't hang forever waiting on a stuck connection.
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
