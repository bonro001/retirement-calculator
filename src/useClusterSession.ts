/**
 * React hook wrapping the cluster client (Phase D.3).
 *
 * The hook owns ONE cluster client per browser tab. We memoize via a
 * module-level singleton rather than `useRef` because:
 *
 *   1. The client must survive Strict Mode double-mount in dev. A useRef
 *      created in `useState(() => createClient())` would be torn down
 *      and recreated in dev, churning sockets and re-registering peers.
 *   2. Multiple components can read cluster state (the status card and,
 *      future, an admin panel) without each spinning up its own socket.
 *
 * The trade-off: hot-reload of `cluster-client.ts` keeps the old client.
 * We accept that — the alternative is a Vite HMR plugin and we're not
 * touching this code often enough to justify it.
 *
 * Persistence: dispatcher URL lives in `localStorage` so the user's
 * choice survives page reload. Default `ws://localhost:8765` matches
 * the dispatcher's default port.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createClusterClient,
  DEFAULT_BROWSER_DISPATCHER_URL,
  type ClusterClient,
  type ClusterClientSnapshot,
  type StartSessionOptions,
} from './cluster-client';
import {
  updateGhosts,
  type PeerGhost,
  type SnapshotPeer,
} from './cluster-peer-view';

const LOCAL_STORAGE_URL_KEY = 'cluster-dispatcher-url';

// ---------------------------------------------------------------------------
// Singleton — one client per tab
// ---------------------------------------------------------------------------

let singletonClient: ClusterClient | null = null;

function readPersistedUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_BROWSER_DISPATCHER_URL;
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_URL_KEY);
    if (raw && /^wss?:\/\//.test(raw)) return raw;
  } catch {
    // localStorage unavailable (private mode, sandboxed iframe). Defaults
    // are still useful — we just won't remember the URL across reloads.
  }
  return DEFAULT_BROWSER_DISPATCHER_URL;
}

function writePersistedUrl(url: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_URL_KEY, url);
  } catch {
    /* see readPersistedUrl */
  }
}

function defaultDisplayName(): string {
  // Browser doesn't have hostname() — best-effort name from UA so the
  // per-host panel can distinguish "Mac Chrome" from "Windows Edge"
  // without us asking the user for a name.
  if (typeof navigator === 'undefined') return 'browser';
  const ua = navigator.userAgent ?? '';
  const platform =
    /Mac/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'win' : /Linux/.test(ua) ? 'linux' : 'browser';
  const browser =
    /Chrome\//.test(ua) && !/Edg\//.test(ua)
      ? 'chrome'
      : /Edg\//.test(ua)
        ? 'edge'
        : /Firefox\//.test(ua)
          ? 'firefox'
          : /Safari\//.test(ua)
            ? 'safari'
            : 'browser';
  return `browser-${platform}-${browser}`;
}

function getSingleton(): ClusterClient {
  if (singletonClient) return singletonClient;
  singletonClient = createClusterClient({
    dispatcherUrl: readPersistedUrl(),
    displayName: defaultDisplayName(),
  });
  return singletonClient;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseClusterSession {
  snapshot: ClusterClientSnapshot;
  /** Convenience: connection state (`snapshot.state`). */
  state: ClusterClientSnapshot['state'];
  /** Convenience: peers from the cluster snapshot, defaulting to []. */
  peers: NonNullable<ClusterClientSnapshot['cluster']>['peers'] | [];
  /** Convenience: the active session if any. */
  session: NonNullable<ClusterClientSnapshot['cluster']>['session'] | null;
  /**
   * Map of recently-disconnected peers, keyed by peerId. The status card
   * shows these greyed-out for a grace period so the operator can tell a
   * Wi-Fi flap apart from a clean shutdown. Pruned automatically as
   * snapshots arrive.
   */
  ghosts: Map<string, PeerGhost>;
  setDispatcherUrl(url: string): void;
  disconnect(): void;
  reconnect(): void;
  startSession(opts: StartSessionOptions): void;
  cancelSession(reason?: string): void;
}

/**
 * Subscribe to the cluster client. Mounting a screen is intentionally
 * passive: callers opt into opening the browser controller socket via
 * `reconnect()`. This keeps the headless Node-host array quiet when the
 * browser is only being used to view results.
 */
export function useClusterSession(): UseClusterSession {
  const client = useMemo(getSingleton, []);
  const [snapshot, setSnapshot] = useState<ClusterClientSnapshot>(() =>
    client.getSnapshot(),
  );

  useEffect(() => {
    const unsubscribe = client.subscribe(setSnapshot);
    return unsubscribe;
  }, [client]);

  // ---- Ghost tracking ---------------------------------------------------
  // The dispatcher snapshot only carries currently-connected peers, so a
  // host that drops simply vanishes from the list. That's the wrong UX:
  // the operator wants to see "host-shop went offline" for a beat instead
  // of having the row silently disappear. We diff successive snapshots
  // and stash recently-departed peers in a ghost map; the status card
  // renders them in a greyed-out state until the retention window expires.
  const prevPeersRef = useRef<SnapshotPeer[] | null>(null);
  const [ghosts, setGhosts] = useState<Map<string, PeerGhost>>(() => new Map());

  useEffect(() => {
    // The cluster snapshot is null while the client is still connecting.
    // We don't want to ghost everything on the first null→peers transition,
    // and we don't want to forget the prior peers when the client briefly
    // disconnects (state goes to `disconnected` but the snapshot stays).
    const nextPeers = snapshot.cluster?.peers ?? null;
    if (!nextPeers) return;
    setGhosts((prev) =>
      updateGhosts(prev, prevPeersRef.current, nextPeers, Date.now()),
    );
    prevPeersRef.current = nextPeers;
  }, [snapshot]);

  const setDispatcherUrl = useCallback(
    (url: string) => {
      writePersistedUrl(url);
      client.setDispatcherUrl(url);
    },
    [client],
  );
  const reconnect = useCallback(() => client.reconnect(), [client]);
  const disconnect = useCallback(() => client.disconnect(), [client]);
  const startSession = useCallback(
    (opts: StartSessionOptions) => client.startSession(opts),
    [client],
  );
  const cancelSession = useCallback(
    (reason?: string) => client.cancelSession(reason),
    [client],
  );

  const peers = snapshot.cluster?.peers ?? [];
  const session = snapshot.cluster?.session ?? null;

  return {
    snapshot,
    state: snapshot.state,
    peers,
    session,
    ghosts,
    setDispatcherUrl,
    disconnect,
    reconnect,
    startSession,
    cancelSession,
  };
}
