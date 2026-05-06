# Policy Miner Cluster

Node-side tooling for running policy-mining work across multiple machines (Mac mini, Mac mini, Windows / Ryzen, …).

## Status

**D.5 — Failure handling.** The dispatcher now survives both poisoned policies and its own restarts. A policy that gets nacked or disconnected away `MAX_POLICY_ATTEMPTS` (5) times in a row is dropped to a dead-letter list rather than thrashing the cluster forever. And on boot the dispatcher scans for sessions on disk that have a `manifest.json` but no `summary.json` (the only way that combo arises is a crash); when a controller re-issues `start_session` for the same baseline, the matching session is resumed in place — already-evaluated policies are filtered out via the canonical `policyId` hash, and progress reporting picks up where it left off.

Earlier phases:
- **D.1** Dispatcher skeleton: connections, registration, heartbeats, cluster-state broadcasts.
- **D.2** Node host: `worker_threads` pool, session priming, batch dispatch path. Engine verified portable to Node.
- **D.3** Browser-as-host: the existing 12-worker Web Worker pool registers as a dispatcher host (and as the controller, in the same socket).
- **D.4** Dispatcher work distribution: enumerator → session dir → adaptive batch sizing → JSONL ingest.
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

## Prerequisites

**Node 23+ on every cluster host.** Empirically (see `perf/PHASE_0_FINDINGS.md`,
multi-machine section) Node 23's V8/TurboFan codegen is ~26% faster per
policy than Node 20 on the post-Phase-1 hot path — a measured 158 → 213
pol/min/thread on the same M2 mini just from the version bump, no code
changes. Mixed-version clusters work but waste throughput on the older
hosts. The repo's `package.json` declares `"engines": { "node": ">=23.0.0" }`
to make accidental drift visible.

If a host doesn't have Node 23, the easiest install is via `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.zshrc       # or ~/.bashrc
nvm install 23
nvm use 23
node -v               # should print v23.x.x
```

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
| `HOST_AUTO_UPDATE` | `0` | When `1`, a host that sees a dispatcher build mismatch exits through `scripts/start-rust-host.mjs` so the launcher can pull/build/restart. |
| `CLUSTER_ALLOW_BUILD_MISMATCH` | `0` | Emergency override. By default, hosts on a different or unknown git/package build stay visible but receive no mining batches. |
| `CLUSTER_BLOCK_DIRTY_BUILDS` | `0` | When `1`, dirty hosts/dispatcher builds are also withheld from dispatch. Dirty state is otherwise visible but allowed for local development. |
| `CLUSTER_WARMUP_MAX_BATCH_SIZE` | `16` | Per-host calibration cap. At the start of each stage, the dispatcher sends one small real-work batch to each eligible host before normal scheduling. |
| `CLUSTER_PREFETCH_DEPTH` | `2` | Dispatcher target for outstanding batches per non-Rust host. |
| `CLUSTER_RUST_COMPACT_PREFETCH_DEPTH` | `4` | Dispatcher target for outstanding batches per `rust-native-compact` host. Keeps fast hosts prefilled to avoid CPU pulse. |
| `SMOKE_POLICIES` | `4` | Number of policies the host smoke evaluates. |
| `SMOKE_TRIALS` | `200` | Trials per policy in the host smoke. |
| `CLUSTER_DATA_DIR` | `cluster/data` | Where the dispatcher writes session artifacts. Override to a NAS mount if you want corpora to outlive the local disk. |
| `SESSION_TRIAL_COUNT` | `2000` | Trials per policy this session (controller CLI). |
| `SESSION_LEGACY_TARGET` | `1000000` | Bequest target in today's dollars (controller CLI). |
| `SESSION_FEASIBILITY` | `0.70` | Bequest-attainment threshold for "feasible" classification (controller CLI). |
| `SESSION_MAX_POLICIES` | full corpus | Cap on enumerated policies — useful for first-time dry runs. |
| `SESSION_BASELINE_FILE` | built-in `initialSeedData` | Path to a `SeedData` JSON to mine against. |
| `SESSION_ASSUMPTIONS_FILE` | built-in defaults | Path to a `MarketAssumptions` JSON. |
| `CLUSTER_CORPUS_FSYNC_EVERY_BATCHES` | `8` | Dispatcher JSONL durability cadence. Set to `1` for strict per-batch `fdatasync`. |
| `CLUSTER_CORPUS_FSYNC_EVERY_MS` | `2000` | Time-based JSONL sync cap; final session close always syncs. |

Health endpoint: `GET http://<dispatcher>:8765/health` returns `{status, protocolVersion, peerCount, uptimeSec}`.

## Roadmap

- **D.1 — done.** Dispatcher skeleton: connections, registration, heartbeats, cluster-state broadcasts.
- **D.2 — done.** Node host: `worker_threads` pool, session priming, batch dispatch path. Engine verified portable to Node via the host smoke (`evaluatePolicy` extracted into the pure `policy-miner-eval` module so the Node import graph stays free of IndexedDB / Web Worker globals).
- **D.6 — done.** Windows bring-up on the Ryzen 7800X3D.
- **D.4 — done.** Dispatcher work distribution: `cluster:start-session` controller CLI sends `start_session`; dispatcher enumerates policies, opens session dir, pumps `MiningJobBatch`es to every host based on perf-class hint then measured EWMA, ingests `BatchResult` into `evaluations.jsonl`. In-flight batches are requeued automatically on host disconnect or `batch_nack`. Session-complete writes `summary.json` and broadcasts `session: null`.
- **D.3 — done.** Browser-as-host: the existing 12-worker pool registers as a dispatcher host (and as the controller in the same connection) and pulls batches from the dispatcher instead of enumerating locally. `PolicyMiningStatusCard` shows live per-host stats from the cluster snapshot.
- **D.5 — done.** Failure handling: (a) per-policy retry cap with dead-letter list — a poisoned policy that nacks or disconnects every time it's assigned is dropped after `MAX_POLICY_ATTEMPTS` (5) instead of looping forever, with `droppedPolicies` surfaced in the snapshot; (b) dispatcher restart resume — at boot the dispatcher scans `cluster/data/sessions/*/` for sessions with a `manifest.json` but no `summary.json` (i.e. crashed), reads their `evaluations.jsonl` to seed evaluated-policy ids and best-so-far, and the next `start_session` matching the same baseline fingerprint reuses that session id and skips already-evaluated policies. The controller doesn't have to know — it just re-issues its original `start_session`.
