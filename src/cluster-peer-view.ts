import { HEARTBEAT_INTERVAL_MS, type ClusterSnapshot, type HostCapabilities } from './mining-protocol';

/**
 * Per-host visibility helpers for the Policy Mining status card.
 *
 * The cluster_state snapshot the dispatcher sends is intentionally
 * minimal — the wire stays small, broadcasts stay cheap. But the
 * status card needs a richer view: live/stale/offline classification,
 * derived throughput numbers, plus visibility into hosts that JUST
 * disconnected (so the operator notices a flapping machine instead
 * of just seeing it disappear from the list).
 *
 * Everything in this module is pure — no React, no sockets — so it's
 * straightforward to test without standing up a dispatcher. The
 * stateful ghost tracking lives in `useClusterSession` and consumes
 * the helpers below.
 *
 * Design choice: the operator cares about "is this host doing work
 * right now" more than "did this host ever connect". So we treat any
 * peer that hasn't heartbeated in ~2 intervals as `stale` even though
 * the dispatcher's own stale threshold is 6× (the dispatcher needs
 * the longer window to avoid premature requeue thrash; the UI wants
 * earlier feedback).
 */

/**
 * Live-ness classification.
 *   - live    : heartbeat within 2 × interval, host is working normally.
 *   - stale   : heartbeat 2-6 × interval ago — degraded, dispatcher
 *               hasn't given up on it yet but the operator should look.
 *   - offline : peer has dropped out of the snapshot entirely. Carried
 *               in the UI for a short window via ghost tracking.
 */
export type PeerStatus = 'live' | 'stale' | 'offline';

/**
 * Thresholds. The "stale" threshold is intentionally tighter than the
 * dispatcher's 6× requeue threshold so the UI flags a degraded host
 * before the dispatcher pulls the trigger.
 */
export const PEER_STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 2;

/**
 * How long to keep a disappeared peer visible (greyed out) after it
 * leaves the snapshot. Long enough that a Wi-Fi flap visibly resolves
 * itself, short enough that the panel doesn't fill up with hours-old
 * dead entries.
 */
export const GHOST_RETENTION_MS = 5 * 60 * 1000;

/** Subset of ClusterSnapshot.peers[number] that we actually consume. */
export type SnapshotPeer = ClusterSnapshot['peers'][number];

/** Augmented peer ready for direct rendering by the status card. */
export interface PeerView {
  peerId: string;
  displayName: string;
  roles: SnapshotPeer['roles'];
  capabilities: HostCapabilities | null;
  status: PeerStatus;
  /** ms-since-epoch — last heartbeat for live/stale peers, last snapshot
   *  presence for ghosts. Used to render "X ago". */
  lastSeenAt: number;
  /** Last completed-batch heartbeat. Same as lastHeartbeatTs from the
   *  snapshot for live/stale; carried forward for ghosts. */
  lastHeartbeatTs: number | null;
  meanMsPerPolicy: number | null;
  /** Aggregate pol/min for the host (workerCount × per-worker rate).
   *  Null until we have at least one completed batch. */
  totalPolPerMin: number | null;
  /** pol/min/worker — what the existing UI showed. */
  perWorkerPolPerMin: number | null;
  /** Batches in flight at last snapshot. Always 0 for ghosts. */
  inFlightBatchCount: number;
  /** Workers this host advertised. Null when capabilities is missing
   *  (controllers that aren't also hosts). */
  workerCount: number | null;
}

/** Ghost entry — a peer that left the snapshot, kept for grace period. */
export interface PeerGhost {
  peer: SnapshotPeer;
  /** When we noticed the peer was missing. Drives the offline label. */
  disappearedAt: number;
}

/**
 * Classify a snapshot peer's liveness based on its last heartbeat
 * timestamp. Returns `live` when the heartbeat is fresh, `stale` when
 * it's between 2 × interval and 6 × interval, and `offline` past that
 * (used when a peer is still in the snapshot but its heartbeat has
 * fallen far enough behind that the dispatcher would also classify
 * it stale on the next sweep).
 */
export function classifyPeerStatus(
  lastHeartbeatTs: number | null,
  nowMs: number,
): PeerStatus {
  if (lastHeartbeatTs == null) return 'stale';
  const age = nowMs - lastHeartbeatTs;
  if (age < PEER_STALE_THRESHOLD_MS) return 'live';
  if (age < HEARTBEAT_INTERVAL_MS * 6) return 'stale';
  return 'offline';
}

/**
 * Friendly perf-class labels. The protocol stores raw enum values for
 * forward compatibility; the UI wants household-readable strings so
 * the operator can scan the host list at a glance.
 */
export function formatPerfClass(
  perfClass: HostCapabilities['perfClass'] | undefined,
): string {
  switch (perfClass) {
    case 'apple-silicon-perf':
      return 'M-series';
    case 'apple-silicon-efficiency':
      return 'M-series (E)';
    case 'x86-modern':
      return 'x86';
    case 'x86-legacy':
      return 'x86 (older)';
    case 'unknown':
    case undefined:
      return '?';
  }
}

/**
 * Per-worker pol/min from a mean ms/policy. Returns null when the host
 * hasn't completed a batch yet — better to show "awaiting first batch"
 * than a misleading 0.
 */
export function perWorkerPolPerMinute(
  meanMsPerPolicy: number | null,
): number | null {
  if (meanMsPerPolicy == null || meanMsPerPolicy <= 0) return null;
  return 60_000 / meanMsPerPolicy;
}

/**
 * Aggregate host throughput in pol/min. Multiplies the per-worker rate
 * by the worker count. Returns null when either input is missing.
 */
export function totalPolPerMinute(
  meanMsPerPolicy: number | null,
  workerCount: number | null,
): number | null {
  const perWorker = perWorkerPolPerMinute(meanMsPerPolicy);
  if (perWorker == null || workerCount == null || workerCount <= 0) return null;
  return perWorker * workerCount;
}

/**
 * Build a PeerView from a live snapshot peer. Pure — caller passes
 * `nowMs` so tests can stub the clock.
 */
export function buildPeerView(
  peer: SnapshotPeer,
  nowMs: number,
): PeerView {
  const status = classifyPeerStatus(peer.lastHeartbeatTs, nowMs);
  const workerCount = peer.capabilities?.workerCount ?? null;
  return {
    peerId: peer.peerId,
    displayName: peer.displayName,
    roles: peer.roles,
    capabilities: peer.capabilities,
    status,
    lastSeenAt: peer.lastHeartbeatTs ?? nowMs,
    lastHeartbeatTs: peer.lastHeartbeatTs,
    meanMsPerPolicy: peer.meanMsPerPolicy,
    totalPolPerMin: totalPolPerMinute(peer.meanMsPerPolicy, workerCount),
    perWorkerPolPerMin: perWorkerPolPerMinute(peer.meanMsPerPolicy),
    inFlightBatchCount: peer.inFlightBatchCount,
    workerCount,
  };
}

/**
 * Build a PeerView for a ghosted (recently-disappeared) peer. The
 * status is forced to `offline` and in-flight is zeroed regardless of
 * the last snapshot value.
 */
export function buildGhostView(ghost: PeerGhost): PeerView {
  const peer = ghost.peer;
  const workerCount = peer.capabilities?.workerCount ?? null;
  return {
    peerId: peer.peerId,
    displayName: peer.displayName,
    roles: peer.roles,
    capabilities: peer.capabilities,
    status: 'offline',
    lastSeenAt: ghost.disappearedAt,
    lastHeartbeatTs: peer.lastHeartbeatTs,
    meanMsPerPolicy: peer.meanMsPerPolicy,
    totalPolPerMin: totalPolPerMinute(peer.meanMsPerPolicy, workerCount),
    perWorkerPolPerMin: perWorkerPolPerMinute(peer.meanMsPerPolicy),
    inFlightBatchCount: 0,
    workerCount,
  };
}

/**
 * Diff two consecutive sets of snapshot peers and update the ghost map.
 *
 *   - Peers in the new snapshot are removed from `ghosts` (a peer that
 *     reappeared isn't a ghost any more).
 *   - Peers in the old snapshot but not the new one get added to
 *     `ghosts` with `disappearedAt = nowMs`.
 *   - Ghosts older than `GHOST_RETENTION_MS` are pruned.
 *
 * Returns a NEW map — pure function, never mutates inputs. The caller
 * (the React hook) owns the map's lifecycle.
 */
export function updateGhosts(
  prevGhosts: Map<string, PeerGhost>,
  prevPeers: SnapshotPeer[] | null,
  nextPeers: SnapshotPeer[],
  nowMs: number,
): Map<string, PeerGhost> {
  const next = new Map(prevGhosts);
  const nextIds = new Set(nextPeers.map((p) => p.peerId));
  // Peers that came back from the dead — un-ghost them.
  for (const id of next.keys()) {
    if (nextIds.has(id)) next.delete(id);
  }
  // Peers we had a moment ago that are gone now — ghost them.
  if (prevPeers) {
    for (const peer of prevPeers) {
      if (!nextIds.has(peer.peerId) && !next.has(peer.peerId)) {
        next.set(peer.peerId, { peer, disappearedAt: nowMs });
      }
    }
  }
  // Prune long-dead ghosts.
  for (const [id, ghost] of next) {
    if (nowMs - ghost.disappearedAt > GHOST_RETENTION_MS) {
      next.delete(id);
    }
  }
  return next;
}

/**
 * Merge live snapshot peers + ghost peers into one display list, sorted
 * for the panel:
 *
 *   1. Live hosts by total throughput desc — busiest at the top.
 *   2. Stale hosts (still in snapshot but degraded heartbeat) below.
 *   3. Offline ghosts at the bottom, newest disappearance first.
 *   4. Non-host roles (controllers) interleaved by name within each
 *      bucket — they don't have throughput, but the operator may
 *      still want to see them.
 */
export function buildPeerViewList(
  snapshotPeers: SnapshotPeer[],
  ghosts: Map<string, PeerGhost>,
  nowMs: number,
): PeerView[] {
  const live = snapshotPeers.map((p) => buildPeerView(p, nowMs));
  const ghostViews = Array.from(ghosts.values()).map(buildGhostView);
  const all = [...live, ...ghostViews];

  // Stable sort: status bucket ASC (live=0, stale=1, offline=2), then
  // host-role first within each bucket, then by total throughput desc
  // (with null/zero last), then by displayName for stable ties.
  const statusRank = (s: PeerStatus): number =>
    s === 'live' ? 0 : s === 'stale' ? 1 : 2;
  return all.sort((a, b) => {
    const sa = statusRank(a.status);
    const sb = statusRank(b.status);
    if (sa !== sb) return sa - sb;
    const aHost = a.roles.includes('host') ? 0 : 1;
    const bHost = b.roles.includes('host') ? 0 : 1;
    if (aHost !== bHost) return aHost - bHost;
    const aTp = a.totalPolPerMin ?? -1;
    const bTp = b.totalPolPerMin ?? -1;
    if (aTp !== bTp) return bTp - aTp;
    return a.displayName.localeCompare(b.displayName);
  });
}

// ---------------------------------------------------------------------------
// Format helpers (UI-facing, but pure & tested for sanity)
// ---------------------------------------------------------------------------

/**
 * Compact pol/min number for the throughput column. Hides decimals
 * past three significant digits so the column stays narrow.
 */
export function formatThroughput(perMin: number | null): string {
  if (perMin == null) return '—';
  if (perMin >= 1000) return `${(perMin / 1000).toFixed(1)}k pol/min`;
  if (perMin >= 100) return `${Math.round(perMin)} pol/min`;
  return `${perMin.toFixed(1)} pol/min`;
}

/**
 * Render a relative-time string the operator can read at a glance.
 * Carried separately from PolicyMiningStatusCard's `formatRelative`
 * so this module stays self-contained for testing.
 */
export function formatAgo(timestampMs: number, nowMs: number): string {
  const ageSec = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (ageSec < 5) return 'just now';
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  return `${Math.round(ageSec / 3600)}h ago`;
}
