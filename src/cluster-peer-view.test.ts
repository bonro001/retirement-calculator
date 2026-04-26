import { describe, it, expect } from 'vitest';
import { HEARTBEAT_INTERVAL_MS } from './mining-protocol';
import {
  buildGhostView,
  buildPeerView,
  buildPeerViewList,
  classifyPeerStatus,
  formatAgo,
  formatPerfClass,
  formatThroughput,
  GHOST_RETENTION_MS,
  perWorkerPolPerMinute,
  PEER_STALE_THRESHOLD_MS,
  totalPolPerMinute,
  updateGhosts,
  type PeerGhost,
  type SnapshotPeer,
} from './cluster-peer-view';

/**
 * Pure-helper tests for cluster-peer-view.
 *
 * The status card is one of the few places where misclassifying a peer
 * (e.g. flagging a live host as offline) directly misleads the operator,
 * so the boundary cases for both the status thresholds and the ghost
 * lifecycle are exercised explicitly.
 */

const NOW = 1_700_000_000_000;

function makePeer(overrides: Partial<SnapshotPeer> = {}): SnapshotPeer {
  return {
    peerId: 'peer-a',
    displayName: 'host-a',
    roles: ['host'],
    capabilities: {
      workerCount: 8,
      perfClass: 'apple-silicon-perf',
      platformDescriptor: 'darwin-arm64-10cpu',
    },
    lastHeartbeatTs: NOW - 1_000,
    meanMsPerPolicy: 200,
    inFlightBatchCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyPeerStatus
// ---------------------------------------------------------------------------

describe('classifyPeerStatus', () => {
  it('returns stale when no heartbeat has ever arrived', () => {
    expect(classifyPeerStatus(null, NOW)).toBe('stale');
  });

  it('returns live for a fresh heartbeat', () => {
    expect(classifyPeerStatus(NOW - 100, NOW)).toBe('live');
  });

  it('flips to stale exactly at the 2× threshold', () => {
    // At the boundary we round UP to stale — the dispatcher's own cleanup
    // sweep is coarser, but the UI wants earlier feedback.
    expect(classifyPeerStatus(NOW - PEER_STALE_THRESHOLD_MS, NOW)).toBe('stale');
  });

  it('returns stale between 2× and 6× heartbeat interval', () => {
    expect(classifyPeerStatus(NOW - HEARTBEAT_INTERVAL_MS * 4, NOW)).toBe('stale');
  });

  it('returns offline once the dispatcher would also requeue', () => {
    expect(classifyPeerStatus(NOW - HEARTBEAT_INTERVAL_MS * 7, NOW)).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// formatPerfClass
// ---------------------------------------------------------------------------

describe('formatPerfClass', () => {
  it('produces a household-readable label for each enum value', () => {
    expect(formatPerfClass('apple-silicon-perf')).toBe('M-series');
    expect(formatPerfClass('apple-silicon-efficiency')).toBe('M-series (E)');
    expect(formatPerfClass('x86-modern')).toBe('x86');
    expect(formatPerfClass('x86-legacy')).toBe('x86 (older)');
    expect(formatPerfClass('unknown')).toBe('?');
  });

  it('renders a question mark when capabilities are missing', () => {
    expect(formatPerfClass(undefined)).toBe('?');
  });
});

// ---------------------------------------------------------------------------
// throughput math
// ---------------------------------------------------------------------------

describe('perWorkerPolPerMinute', () => {
  it('returns null when no batch has completed', () => {
    expect(perWorkerPolPerMinute(null)).toBeNull();
  });

  it('returns null on degenerate input', () => {
    expect(perWorkerPolPerMinute(0)).toBeNull();
    expect(perWorkerPolPerMinute(-5)).toBeNull();
  });

  it('converts ms/policy to pol/min', () => {
    // 100ms/policy = 600 pol/min/worker
    expect(perWorkerPolPerMinute(100)).toBeCloseTo(600);
  });
});

describe('totalPolPerMinute', () => {
  it('returns null when either input is missing', () => {
    expect(totalPolPerMinute(null, 8)).toBeNull();
    expect(totalPolPerMinute(100, null)).toBeNull();
    expect(totalPolPerMinute(100, 0)).toBeNull();
  });

  it('multiplies per-worker rate by worker count', () => {
    expect(totalPolPerMinute(100, 8)).toBeCloseTo(600 * 8);
  });
});

// ---------------------------------------------------------------------------
// buildPeerView / buildGhostView
// ---------------------------------------------------------------------------

describe('buildPeerView', () => {
  it('classifies and projects a live peer', () => {
    const view = buildPeerView(makePeer(), NOW);
    expect(view.status).toBe('live');
    expect(view.workerCount).toBe(8);
    expect(view.perWorkerPolPerMin).toBeCloseTo(60_000 / 200);
    expect(view.totalPolPerMin).toBeCloseTo((60_000 / 200) * 8);
    expect(view.lastSeenAt).toBe(NOW - 1_000);
  });

  it('falls back to nowMs for lastSeenAt when no heartbeat exists', () => {
    const view = buildPeerView(makePeer({ lastHeartbeatTs: null }), NOW);
    expect(view.lastSeenAt).toBe(NOW);
    expect(view.status).toBe('stale');
  });

  it('handles a peer without capabilities (controller-only)', () => {
    const view = buildPeerView(
      makePeer({ capabilities: null, roles: ['controller'] }),
      NOW,
    );
    expect(view.workerCount).toBeNull();
    expect(view.totalPolPerMin).toBeNull();
  });
});

describe('buildGhostView', () => {
  it('forces status to offline and zeros in-flight regardless of source', () => {
    const peer = makePeer({ inFlightBatchCount: 3 });
    const ghost: PeerGhost = { peer, disappearedAt: NOW - 30_000 };
    const view = buildGhostView(ghost);
    expect(view.status).toBe('offline');
    expect(view.inFlightBatchCount).toBe(0);
    expect(view.lastSeenAt).toBe(NOW - 30_000);
    // Throughput numbers carry forward — the operator may still want to
    // see the host's last-known rate while it's greyed out.
    expect(view.perWorkerPolPerMin).toBeCloseTo(60_000 / 200);
  });
});

// ---------------------------------------------------------------------------
// updateGhosts
// ---------------------------------------------------------------------------

describe('updateGhosts', () => {
  it('returns an empty map on first snapshot (no prevPeers)', () => {
    const next = updateGhosts(new Map(), null, [makePeer()], NOW);
    expect(next.size).toBe(0);
  });

  it('adds a peer that disappeared from the new snapshot', () => {
    const a = makePeer({ peerId: 'a' });
    const b = makePeer({ peerId: 'b' });
    const next = updateGhosts(new Map(), [a, b], [a], NOW);
    expect(next.has('b')).toBe(true);
    expect(next.get('b')!.disappearedAt).toBe(NOW);
    expect(next.has('a')).toBe(false);
  });

  it('un-ghosts a peer that came back', () => {
    const a = makePeer({ peerId: 'a' });
    const prev = new Map<string, PeerGhost>([
      ['a', { peer: a, disappearedAt: NOW - 5_000 }],
    ]);
    const next = updateGhosts(prev, [], [a], NOW);
    expect(next.has('a')).toBe(false);
  });

  it('prunes ghosts older than the retention window', () => {
    const a = makePeer({ peerId: 'a' });
    const prev = new Map<string, PeerGhost>([
      [
        'a',
        { peer: a, disappearedAt: NOW - GHOST_RETENTION_MS - 1_000 },
      ],
    ]);
    const next = updateGhosts(prev, [], [], NOW);
    expect(next.has('a')).toBe(false);
  });

  it('keeps a ghost still inside the retention window', () => {
    const a = makePeer({ peerId: 'a' });
    const prev = new Map<string, PeerGhost>([
      ['a', { peer: a, disappearedAt: NOW - 60_000 }],
    ]);
    const next = updateGhosts(prev, [], [], NOW);
    expect(next.has('a')).toBe(true);
  });

  it('does not mutate the input map', () => {
    const prev = new Map<string, PeerGhost>();
    const a = makePeer({ peerId: 'a' });
    updateGhosts(prev, [a], [], NOW);
    expect(prev.size).toBe(0);
  });

  it('preserves disappearedAt for an existing ghost on subsequent ticks', () => {
    const a = makePeer({ peerId: 'a' });
    const earlier = NOW - 30_000;
    const prev = new Map<string, PeerGhost>([
      ['a', { peer: a, disappearedAt: earlier }],
    ]);
    // Same peer still missing; a is in prevPeers because it's still in
    // the old snapshot? No — once ghosted, subsequent ticks pass the
    // prior nextPeers as prevPeers (which doesn't include a). So the
    // ghost should remain untouched.
    const next = updateGhosts(prev, [], [], NOW);
    expect(next.get('a')!.disappearedAt).toBe(earlier);
  });
});

// ---------------------------------------------------------------------------
// buildPeerViewList — sort order
// ---------------------------------------------------------------------------

describe('buildPeerViewList', () => {
  it('orders live before stale before offline', () => {
    const live = makePeer({ peerId: 'live', lastHeartbeatTs: NOW - 100 });
    const stale = makePeer({
      peerId: 'stale',
      lastHeartbeatTs: NOW - HEARTBEAT_INTERVAL_MS * 4,
    });
    const ghostPeer = makePeer({ peerId: 'ghost' });
    const ghosts = new Map<string, PeerGhost>([
      ['ghost', { peer: ghostPeer, disappearedAt: NOW - 10_000 }],
    ]);
    const list = buildPeerViewList([live, stale], ghosts, NOW);
    expect(list.map((v) => v.peerId)).toEqual(['live', 'stale', 'ghost']);
  });

  it('orders hosts by total throughput descending within a status bucket', () => {
    const fast = makePeer({
      peerId: 'fast',
      displayName: 'fast',
      meanMsPerPolicy: 50, // 1200 pol/min/worker × 8 = 9600
    });
    const slow = makePeer({
      peerId: 'slow',
      displayName: 'slow',
      meanMsPerPolicy: 500, // 120 × 8 = 960
    });
    const list = buildPeerViewList([slow, fast], new Map(), NOW);
    expect(list.map((v) => v.peerId)).toEqual(['fast', 'slow']);
  });

  it('puts host-role peers ahead of controller-only peers in each bucket', () => {
    const host = makePeer({ peerId: 'h', roles: ['host'] });
    const ctrl = makePeer({
      peerId: 'c',
      roles: ['controller'],
      capabilities: null,
      meanMsPerPolicy: null,
    });
    const list = buildPeerViewList([ctrl, host], new Map(), NOW);
    expect(list.map((v) => v.peerId)).toEqual(['h', 'c']);
  });

  it('breaks ties by displayName for stable rendering', () => {
    const a = makePeer({
      peerId: 'a',
      displayName: 'apple',
      meanMsPerPolicy: null,
      capabilities: null,
    });
    const b = makePeer({
      peerId: 'b',
      displayName: 'banana',
      meanMsPerPolicy: null,
      capabilities: null,
    });
    const list = buildPeerViewList([b, a], new Map(), NOW);
    expect(list.map((v) => v.displayName)).toEqual(['apple', 'banana']);
  });
});

// ---------------------------------------------------------------------------
// formatThroughput / formatAgo
// ---------------------------------------------------------------------------

describe('formatThroughput', () => {
  it('renders a dash when no data is available', () => {
    expect(formatThroughput(null)).toBe('—');
  });

  it('uses k suffix above 1000', () => {
    expect(formatThroughput(2_500)).toBe('2.5k pol/min');
  });

  it('rounds whole numbers above 100', () => {
    expect(formatThroughput(456.7)).toBe('457 pol/min');
  });

  it('keeps one decimal below 100', () => {
    expect(formatThroughput(12.34)).toBe('12.3 pol/min');
  });
});

describe('formatAgo', () => {
  it('shows just now under 5 seconds', () => {
    expect(formatAgo(NOW - 2_000, NOW)).toBe('just now');
  });

  it('shows seconds under a minute', () => {
    expect(formatAgo(NOW - 30_000, NOW)).toBe('30s ago');
  });

  it('shows minutes under an hour', () => {
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('shows hours past an hour', () => {
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
  });

  it('clamps negative ages to "just now"', () => {
    expect(formatAgo(NOW + 5_000, NOW)).toBe('just now');
  });
});
