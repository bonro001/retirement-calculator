# Policy Miner Cluster

Node-side tooling for running policy-mining work across multiple machines (Mac mini, Mac mini, Windows / Ryzen, …).

## Status

**D.2 — Node host.** Dispatcher (D.1) accepts connections and tracks peers. Node host (D.2) connects, registers, heartbeats, spawns a `worker_threads` pool, and is wired to evaluate `MiningJobBatch`es end-to-end. The dispatcher does NOT yet generate batches — that's D.4 — so a connected host today registers and idles. The `cluster:host-smoke` script bypasses the dispatcher and validates the full engine path through the worker pool in isolation.

## Components

| File | Role |
| --- | --- |
| `dispatcher.ts` | The central WebSocket service. Runs on the M4 mini. Accepts host/controller/observer connections, maintains the peer registry, will route batches in D.4. |
| `host.ts` | Node host process. Runs on each worker machine (M1 mini, Ryzen). Connects to the dispatcher, registers, manages a `worker_threads` pool, evaluates batches. |
| `host-worker.ts` | Worker thread that primes a session and runs `evaluatePolicy` on a batch. Mirrors the browser worker but uses `node:worker_threads` instead of the DOM Web Worker API. |
| `host-worker-loader.mjs` | Tiny ESM bootstrap that registers tsx in the worker thread so it can resolve `.ts` imports from `src/`. Sidesteps the `--import tsx` worker quirk on Node ≥ 23. |
| `host-smoke.ts` | Standalone smoke test — primes the worker pool with a real `SeedData` baseline and runs a small policy batch to prove the engine ports cleanly to Node. No dispatcher needed. |
| `smoke-client.ts` | A tiny test client that registers as a fake host, heartbeats for 10s, then exits cleanly. Used to verify the dispatcher's connection lifecycle works. |

The shared protocol types live one level up at `src/mining-protocol.ts` so the browser can `import` them.

## Running locally

```bash
# Terminal 1: start the dispatcher on the M4 mini (default port 8765)
npm run cluster:dispatcher

# Terminal 2: smoke-test the dispatcher's connection lifecycle
npm run cluster:smoke

# Terminal 3 (any worker machine): start a Node host
DISPATCHER_URL=ws://<m4-ip>:8765 npm run cluster:host

# Validate the engine port without the dispatcher (any worker machine)
SMOKE_POLICIES=4 SMOKE_TRIALS=200 npm run cluster:host-smoke
```

Expected output on Terminal 1 once a host connects:

```
[dispatcher@<host>] [info] dispatcher listening { port: 8765, ... }
[dispatcher@<host>] [info] incoming connection { remoteAddress: '192.168.1.x' }
[dispatcher@<host>] [info] peer registered { peerId: 'node-host-<other>-h-1', roles: ['host'], capabilities: { workerCount: 8, perfClass: 'apple-silicon-perf', ... } }
```

## Configuration

Environment variables:

| Var | Default | What |
| --- | --- | --- |
| `DISPATCHER_PORT` | `8765` | TCP port the dispatcher binds. |
| `DISPATCHER_URL` | `ws://localhost:8765` | What the host / smoke client dials. Set to `ws://<m4-ip>:8765` on the worker machines. |
| `HOST_WORKERS` | `min(12, cpus-2)` | Worker-thread pool size on a Node host. Override per machine (e.g. `6` for the M1 mini, `12` for the Ryzen). |
| `HOST_DISPLAY_NAME` | `node-host-<hostname>` | Friendly name shown in the per-host stats panel. |
| `HOST_PERF_CLASS` | auto from arch | One of `apple-silicon-perf`, `apple-silicon-efficiency`, `x86-modern`, `x86-legacy`, `unknown`. The dispatcher uses this to size initial batches before measured throughput is in. |
| `HOST_PLATFORM_DESCRIPTOR` | auto | Free-form descriptor surfaced in diagnostics. |
| `SMOKE_POLICIES` | `4` | Number of policies the host smoke evaluates. |
| `SMOKE_TRIALS` | `200` | Trials per policy in the host smoke. |

Health endpoint: `GET http://<dispatcher>:8765/health` returns `{status, protocolVersion, peerCount, uptimeSec}`.

## Roadmap

- **D.1 — done.** Dispatcher skeleton: connections, registration, heartbeats, cluster-state broadcasts.
- **D.2 — done.** Node host: `worker_threads` pool, session priming, batch dispatch path. Engine verified portable to Node via the host smoke (`evaluatePolicy` extracted into the pure `policy-miner-eval` module so the Node import graph stays free of IndexedDB / Web Worker globals).
- **D.3** — Browser-as-host (existing 12-worker pool pulls work from the dispatcher instead of local enumeration).
- **D.4** — Dispatcher work distribution: enumerate policies, hand `MiningJobBatch`es to registered hosts, ingest results into a canonical corpus on disk.
- **D.5** — Failure handling (in-flight reassign, per-host stats in the UI).
- **D.6** — Windows bring-up on the Ryzen 7800X3D.
