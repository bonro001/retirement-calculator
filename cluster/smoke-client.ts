/**
 * D.1 smoke-test client.
 *
 * What it does: connects to the dispatcher, registers as a fake host,
 * heartbeats for ~10 seconds, then exits cleanly. Used to verify that
 * D.1's connection lifecycle, registration, snapshot push, and stale-
 * peer sweep all behave correctly without needing the full Node host
 * (which lands in D.2).
 *
 * Run with two terminals:
 *   T1: npm run cluster:dispatcher
 *   T2: npm run cluster:smoke
 *
 * Expected output on T1: "peer registered" log line, periodic cluster
 * snapshots in any other connected client, "peer disconnected" when
 * the smoke client exits.
 */

import { hostname } from 'node:os';
import WebSocket from 'ws';
import {
  DEFAULT_DISPATCHER_PORT,
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type ClusterMessage,
  type HeartbeatMessage,
  type RegisterMessage,
} from '../src/mining-protocol';

const RUN_DURATION_MS = 10_000;
const DISPATCHER_URL =
  process.env.DISPATCHER_URL ?? `ws://localhost:${DEFAULT_DISPATCHER_PORT}`;

function log(message: string, meta?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(
    `[smoke-client] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`,
  );
}

const socket = new WebSocket(DISPATCHER_URL);

let myPeerId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

socket.on('open', () => {
  const register: RegisterMessage = {
    kind: 'register',
    protocolVersion: MINING_PROTOCOL_VERSION,
    roles: ['host'],
    displayName: `smoke-${hostname()}`,
    capabilities: {
      workerCount: 4,
      perfClass: 'unknown',
      platformDescriptor: `smoke-test on ${process.platform}-${process.arch}`,
    },
  };
  socket.send(encodeMessage(register));
  log('sent register');
});

socket.on('message', (raw: Buffer) => {
  const text = raw.toString('utf-8');
  let message: ClusterMessage;
  try {
    message = decodeMessage(text);
  } catch (err) {
    log('parse error', { err: String(err) });
    return;
  }

  switch (message.kind) {
    case 'welcome':
      myPeerId = message.peerId;
      log('welcomed', {
        peerId: message.peerId,
        clusterPeerCount: message.clusterSnapshot.peers.length,
      });
      // Start heartbeating.
      heartbeatTimer = setInterval(() => {
        if (!myPeerId) return;
        const hb: HeartbeatMessage = {
          kind: 'heartbeat',
          from: myPeerId,
          inFlightBatchIds: [],
          freeWorkerSlots: 4,
        };
        socket.send(encodeMessage(hb));
      }, HEARTBEAT_INTERVAL_MS);
      // Schedule clean exit.
      setTimeout(() => {
        log('test duration elapsed, closing');
        socket.close(1000, 'smoke test complete');
      }, RUN_DURATION_MS);
      return;

    case 'register_rejected':
      log('register rejected', { reason: message.reason, detail: message.detail });
      return;

    case 'cluster_state':
      log('cluster state push', {
        peers: message.snapshot.peers.length,
        sessionActive: message.snapshot.session !== null,
      });
      return;

    default:
      log('received', { kind: message.kind });
  }
});

socket.on('close', (code, reason) => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  log('closed', { code, reason: reason.toString('utf-8') });
  process.exit(0);
});

socket.on('error', (err) => {
  log('error', { err: String(err) });
  process.exit(1);
});
