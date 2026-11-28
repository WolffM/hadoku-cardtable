/**
 * What a page does when its session is gone: stop asking, and go back through the edge's sign-in
 * wall. A signed-out caller gets a 401 from the edge on every gated path, a page load too, and
 * every socket's handshake. Without this a tab left open across a lost session retries every socket
 * forever (reconnects never more than a second apart) and every poller polls on: one browser sent
 * 45k refused requests in 22 hours (2026-11-23), its page dead to its player the whole time.
 *
 * ONE watch per page, two ways in:
 *  - every `fetch` the page makes under `scope` (one wrapper, installed at start, so no client has
 *    to remember to): a 401 is a suspicion;
 *  - every socket handed to {@link watchSocket}: a `connect_error` is a suspicion (the socket
 *    library never says why a handshake failed).
 * A suspicion is checked by ONE probe, `probeUrl` (a gated GET under `scope`), at most once per
 * {@link PROBE_GAP_MS}: only the edge's 401 there means the session is gone. Anything else (a
 * restart's 502, a 404, a network error, a backend's own 401 on some other path) is not a lost
 * session, and the page carries on.
 *
 * A lost session stops everything at once: every watched socket is disconnected (which ends its
 * reconnecting), every later `fetch` under `scope` fails without leaving the page, and the page
 * reloads. The edge answers that load with its sign-in wall, which gives a signed-out visitor an
 * account and sends them on. A second loss within {@link RELOAD_GUARD_MS} of one this tab already
 * reloaded for does not reload again: the page stays stopped rather than loop.
 *
 * A session the page changes ITSELF is not a lost one. Delete account, a sign-in with a key or a
 * passkey: each is a write to the fleet's session service ({@link SESSION_SERVICE_PATHS}) that ends
 * or replaces this browser's session, and the page goes somewhere of its own choosing once it
 * answers. Until then the edge refuses everything under `scope`, and a reload would cut the write
 * off and send the browser through the wall as a new guest (2026-11-27, Delete account on
 * cardtable-ppe). So the same `fetch` wrapper watches for those writes (any caller's: the fleet
 * header posts them with the page's own `fetch`), and while one is in flight, and for
 * {@link SESSION_WRITE_HOLD_MS} after one succeeds, no suspicion is probed and no probe's 401
 * stops the page. A write that fails holds nothing past its answer.
 */

/** The least time between two probes. */
export const PROBE_GAP_MS = 10_000;
/** A loss inside this long after the last reload for one stays stopped instead of reloading. */
export const RELOAD_GUARD_MS = 60_000;
/** Where this tab notes when it last reloaded for a lost session. */
export const RELOADED_KEY = 'hadoku:session-lost-reload';
/** The fleet's session service on the page's origin: a write under one of these changes who this browser is. */
export const SESSION_SERVICE_PATHS = ['/session/', '/auth/'] as const;
/** How long after a session write succeeds the page is left to its own navigation. */
export const SESSION_WRITE_HOLD_MS = PROBE_GAP_MS;

/** What the watch needs of a socket (socket.io's `Socket` is one): its connect errors and its end, and a way to end it. */
export interface WatchedSocket {
  on(event: 'connect_error' | 'disconnect', listener: (reason?: unknown) => void): unknown;
  off(event: 'connect_error' | 'disconnect', listener: (reason?: unknown) => void): unknown;
  disconnect(): unknown;
}

/** socket.io's reason when the page itself closed a socket: the watch lets go of it. */
const CLOSED_BY_PAGE = 'io client disconnect';

/** The page, as far as the watch touches it. */
export interface SessionHost {
  fetch: typeof fetch;
  location: { origin: string; reload(): void };
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export interface SessionWatchOptions {
  /** The path prefix the edge gates for this app, `/cardtable/`: a 401 under it means signed out. */
  scope: string;
  /** A gated GET under `scope`, asked to confirm a suspicion. */
  probeUrl: string;
  host?: SessionHost;
  now?: () => number;
  /** Told once, when a probe confirms the loss. */
  onLost?: () => void;
}

export interface SessionWatch {
  /** Something looked like a lost session: probe, unless one was asked lately. */
  suspect(): void;
  lost(): boolean;
  /** Takes the fetch wrapper off and forgets every socket (an embed's unmount). */
  stop(): void;
}

let current: Watch | null = null;

interface Watch extends SessionWatch {
  add(socket: WatchedSocket): void;
}

/** Signed out: the request a stopped page did not send. */
export class SessionLostError extends Error {
  constructor() {
    super('signed out');
    this.name = 'SessionLostError';
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
}

/** Start the page's one watch. A second start replaces the first. */
export function startSessionWatch(options: SessionWatchOptions): SessionWatch {
  current?.stop();
  const host: SessionHost = options.host ?? window;
  const now = options.now ?? Date.now;
  const scopeUrl = new URL(options.scope, host.location.origin);
  const pageFetch = host.fetch;
  /** Each watched socket, with its own two listeners. */
  const sockets = new Map<WatchedSocket, { onError: () => void; onClose: (reason?: unknown) => void }>();
  const release = (socket: WatchedSocket): void => {
    const listeners = sockets.get(socket);
    if (listeners === undefined) return;
    sockets.delete(socket);
    socket.off('connect_error', listeners.onError);
    socket.off('disconnect', listeners.onClose);
  };
  let isLost = false;
  let probing = false;
  let lastProbe = -Infinity;
  /** Session writes in flight, and when the last one that succeeded stops holding the watch. */
  let sessionWrites = 0;
  let heldUntil = -Infinity;
  const held = (): boolean => sessionWrites > 0 || now() < heldUntil;

  const pathOf = (input: RequestInfo | URL): string | null => {
    try {
      const url = new URL(urlOf(input), host.location.origin);
      return url.origin === scopeUrl.origin ? url.pathname : null;
    } catch {
      return null;
    }
  };
  const inScope = (input: RequestInfo | URL): boolean => pathOf(input)?.startsWith(scopeUrl.pathname) ?? false;
  const isSessionWrite = (input: RequestInfo | URL, init: RequestInit | undefined): boolean => {
    const method = methodOf(input, init);
    if (method === 'GET' || method === 'HEAD') return false;
    const path = pathOf(input);
    return path !== null && SESSION_SERVICE_PATHS.some((prefix) => path.startsWith(prefix));
  };

  /** The page's own write to its session: held while it is in flight, and a while after it succeeds. */
  const sessionWrite = async (input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> => {
    sessionWrites += 1;
    try {
      const res = await pageFetch.call(undefined, input, init);
      if (res.ok) heldUntil = now() + SESSION_WRITE_HOLD_MS;
      return res;
    } finally {
      sessionWrites -= 1;
    }
  };

  /** When this tab last reloaded for a lost session, noting now as the next one's answer. */
  const swapLastReload = (): number | null => {
    const store = host.sessionStorage;
    try {
      const raw = store?.getItem(RELOADED_KEY) ?? null;
      store?.setItem(RELOADED_KEY, String(now()));
      return raw === null ? null : Number(raw);
    } catch {
      // Storage refused (a private window): reload anyway; the edge's wall is what ends a loop.
      return null;
    }
  };

  const reload = (): void => {
    const last = swapLastReload();
    if (last !== null && Number.isFinite(last) && now() - last < RELOAD_GUARD_MS) return;
    host.location.reload();
  };

  const lose = (): void => {
    if (isLost || held()) return;
    isLost = true;
    for (const socket of [...sockets.keys()]) {
      release(socket);
      socket.disconnect();
    }
    options.onLost?.();
    reload();
  };

  const probe = async (): Promise<void> => {
    probing = true;
    lastProbe = now();
    try {
      const res = await pageFetch.call(undefined, options.probeUrl, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (res.status === 401) lose();
    } catch {
      // No answer is not "signed out": the next suspicion asks again.
    } finally {
      probing = false;
    }
  };

  const suspect = (): void => {
    if (isLost || probing || held() || now() - lastProbe < PROBE_GAP_MS) return;
    void probe();
  };

  const watched: typeof fetch = async (input, init) => {
    if (isSessionWrite(input, init)) return sessionWrite(input, init);
    if (!inScope(input)) return pageFetch.call(undefined, input, init);
    if (isLost) throw new SessionLostError();
    const res = await pageFetch.call(undefined, input, init);
    if (res.status === 401) suspect();
    return res;
  };
  host.fetch = watched;

  const watch: Watch = {
    suspect,
    lost: () => isLost,
    add(socket) {
      if (isLost) {
        socket.disconnect();
        return;
      }
      if (sockets.has(socket)) return;
      const listeners = {
        onError: () => suspect(),
        onClose: (reason?: unknown) => {
          if (reason === CLOSED_BY_PAGE) release(socket);
        },
      };
      sockets.set(socket, listeners);
      socket.on('connect_error', listeners.onError);
      socket.on('disconnect', listeners.onClose);
    },
    stop() {
      if (host.fetch === watched) host.fetch = pageFetch;
      for (const socket of [...sockets.keys()]) release(socket);
      if (current === watch) current = null;
    },
  };
  current = watch;
  return watch;
}

/**
 * Hand a socket to the page's watch: its connect errors are suspicions, and a lost session ends it.
 * The page's own `disconnect()` lets go of it. Nothing, with no watch started (a test, a harness page).
 */
export function watchSocket(socket: WatchedSocket): void {
  current?.add(socket);
}
