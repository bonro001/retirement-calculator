# Policy Miner Cluster

Node-side tooling for running policy-mining work across multiple machines (Mac mini, Mac mini, Windows / Ryzen, …).

## Status

**D.4 — Work distribution.** The dispatcher now owns the full session lifecycle: a controller (the `cluster:start-session` CLI today; the browser via D.3 later) sends `start_session` with a baseline + axes spec, the dispatcher enumerates policies, opens a session directory on disk, and pumps `MiningJobBatch`es out to every connected host based on their advertised worker count and measured throughput. Results stream back as `BatchResult` and append to `evaluations.jsonl` one line per `PolicyEvaluation`. When the queue drains the dispatcher writes `summary.json` and broadcasts session-complete.

Earlier phases:
- **D.1** Dispatcher skeleton: connections, registration, heartbeats, cluster-state broadcasts.
- **D.2** Node host: `worker_threads` pool, session priming, batch dispatch path. Engine verified portable to Node.
- **D.6** Windows bring-up on Ryzen 7800X3D — registered and serving batches.

## Components

| File | Role |
| --- | --- |
| `dispatcher.ts` | The central WebSocket service. Runs on the M4 mini. Accepts host/controller/observer connections, maintains the peer registry, owns session state, enumerates policies, dispatches batches, ingests results into the on-disk corpus. |
| `work-queue.ts` | Pure in-memory bookkeeping: pending FIFO, in-flight by `(peerId, batchId)`, completed counters. Adaptive batch sizing math (perf-class hint → measured EWMA). Unit-testable without sockets. |
| `corpus-writer.ts` | Owns the on-disk artifacts under `cluster/data/sessions/<sessionId>/`: `manifest.json`, append-only `evaluations.jsonl`, final `summary.json`. fsync's after every batch append. |
| `host.ts` | Node host process. Runs on each worker machine (M1 mini, Ryzen). Connects to the dispatcher, registers, manages a `worker_threads` pool, evaluates batches. |
| `host-worker.ts` | Worker thread that primes a session and runs `evaluatePolicy` on a batch. Mirrors the browser worker but uses `node:worker_threads` instead of the DOM Web Worker API. |
| `host-worker-loader.mjs` | Tiny ESM bootstrap that registers tsx in the worker thread so it can resolve `.ts` imports from `src/`. Sidesteps the `--import tsx` worker quirk on Node ≥ 23. |
| `host-smoke.ts` | Standalone smoke test — primes the worker pool with a real `SeedData` baseline and runs a small policy batch to prove the engine ports cleanly to Node. No dispatcher needed. |
| `start-session.ts` | Controller CLI. Connects to the dispatcher as a `controller`, sends `start_session` with the built-in baseline + axes (or files passed via env), then prints session progress until the dispatcher reports complete. |
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

# Terminal 4: kick off a mining session (controller CLI)
SESSION_MAX_POLICIES=200 SESSION_TRIAL_COUNT=200 npm run cluster:start-session

# Validate the engine port without the dispatcher (any worker machine)
SMOKE_POLICIES=4 SMOKE_TRIALS=200 npm run cluster:host-smoke
```

While the session runs, results land at `cluster/data/sessions/<sessionId>/evaluations.jsonl`. Each line is one `PolicyEvaluation` JSON record. When the session finishes, `summary.json` lands in the same directory.

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
| `CLUSTER_DATA_DIR` | `cluster/data` | Where the dispatcher writes session artifacts. Override to a NAS mount if you want corpora to outlive the local disk. |
| `SESSION_TRIAL_COUNT` | `2000` | Trials per policy this session (controller CLI). |
| `SESSION_LEGACY_TARGET` | `1000000` | Bequest target in today's dollars (controller CLI). |
| `SESSION_FEASIBILITY` | `0.70` | Bequest-attainment threshold for "feasible" classification (controller CLI). |
| `SESSION_MAX_POLICIES` | full corpus | Cap on enumerated policies — useful for first-time dry runs. |
| `SESSION_BASELINE_FILE` | built-in `initialSeedData` | Path to a `SeedData` JSON to mine against. |
| `SESSION_ASSUMPTIONS_FILE` | built-in defaults | Path to a `MarketAssumptions` JSON. |

Health endpoint: `GET http://<dispatcher>:8765/health` returns `{status, protocolVersion, peerCount, uptimeSec}`.

## Roadmap

- **D.1 — done.** Dispatcher skeleton: connections, registration, heartbeats, cluster-state broadcasts.
- **D.2 — done.** Node host: `worker_threads` pool, session priming, batch dispatch path. Engine verified portable to Node via the host smoke (`evaluatePolicy` extracted into the pure `policy-miner-eval` module so the Node import graph stays free of IndexedDB / Web Worker globals).
- **D.6 — done.** Windows bring-up on the Ryzen 7800X3D.
- **D.4 — done.** Dispatcher work distribution: `cluster:start-session` controller CLI sends `start_session`; dispatcher enumerates policies, opens session dir, pumps `MiningJobBatch`es to every host based on perf-class hint then measured EWMA, ingests `BatchResult` into `evaluations.jsonl`. In-flight batches are requeued automatically on host disconnect or `batch_nack`. Session-complete writes `summary.json` and broadcasts `session: null`.
- **D.3** — Browser-as-host (existing 12-worker pool pulls work from the dispatcher instead of local enumeration).
- **D.5** — Failure handling (in-flight reassign retry policies, per-host stats in the UI, dispatcher restart resume).
