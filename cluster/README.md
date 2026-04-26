# Policy Miner Cluster

Node-side tooling for running policy-mining work across multiple machines (Mac mini, Mac mini, Windows / Ryzen, …).

## Status

**D.1 — dispatcher skeleton.** Connection lifecycle, registration, heartbeats, and cluster-state broadcasts work. No actual mining work is dispatched yet — that arrives in D.2 (Node host) and D.3 (browser-as-host).

## Components

| File | Role |
| --- | --- |
| `dispatcher.ts` | The central WebSocket service. Runs on the M4 mini. Accepts host/controller/observer connections, maintains the peer registry, will route batches in D.2+. |
| `smoke-client.ts` | A tiny test client that registers as a fake host, heartbeats for 10s, then exits cleanly. Used to verify the dispatcher's connection lifecycle works. |

The shared protocol types live one level up at `src/mining-protocol.ts` so the browser can `import` them.

## Running locally

```bash
# Terminal 1: start the dispatcher (default port 8765)
npm run cluster:dispatcher

# Terminal 2: smoke-test a connection
npm run cluster:smoke
```

Expected output on Terminal 1:

```
[dispatcher@<host>] [info] dispatcher listening { port: 8765, ... }
[dispatcher@<host>] [info] incoming connection { remoteAddress: '127.0.0.1' }
[dispatcher@<host>] [info] peer registered { peerId: 'smoke-<host>-h-1', ... }
[dispatcher@<host>] [info] peer disconnected { peerId: 'smoke-<host>-h-1', ... uptimeMs: ~10000 }
```

## Configuration

Environment variables:

| Var | Default | What |
| --- | --- | --- |
| `DISPATCHER_PORT` | `8765` | TCP port the dispatcher binds. |
| `DISPATCHER_URL` | `ws://localhost:8765` | What the smoke client connects to. Set per-host in D.2+ to point Node hosts at the M4 mini. |

Health endpoint: `GET http://<dispatcher>:8765/health` returns `{status, protocolVersion, peerCount, uptimeSec}`.

## Roadmap

- **D.2** — Node host (`worker_threads` pool, evaluates `MiningJobBatch`es).
- **D.3** — Browser-as-host (existing 12-worker pool pulls work from the dispatcher instead of local enumeration).
- **D.4** — Canonical corpus on the dispatcher (replaces per-tab IndexedDB for cluster runs).
- **D.5** — Failure handling (in-flight reassign, per-host stats in the UI).
- **D.6** — Windows bring-up on the Ryzen 7800X3D.
