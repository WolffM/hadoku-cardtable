/*
 * How every socket on the page connects: its path under the bundle's base, and its transports and
 * reconnect pacing. Not any one game's: the draft, the match, the room feed and the room's session
 * claim all connect this way.
 */

/**
 * `/cardtable/` → `/cardtable/socket.io/`.
 *
 * Pure, and tested as such, because the value it produces is only observable
 * in a browser against a live edge — which is the definition of a thing that
 * gets shipped wrong.
 */
export function socketPath(base: string): string {
  const prefix = base === '' ? '/' : base;
  return `${prefix.endsWith('/') ? prefix : `${prefix}/`}socket.io/`;
}

/** The path for THIS bundle, from the base Vite was built with. */
export function defaultSocketPath(): string {
  const base = import.meta.env?.BASE_URL;
  return socketPath(typeof base === 'string' ? base : '/');
}

/**
 * A dropped socket tries again after a quarter second, and never waits more than a second between
 * tries. socket.io's default (1 s doubling to 5 s) let a socket sit out up to five seconds after a
 * deploy's restart had already finished. The edge holds each try's handshake through the restart
 * (hadoku_site's `proxy.ts`, `holdThroughRestart`), so a short delay costs a few held requests, not
 * a storm of failed ones, and the socket lands the moment the new server listens.
 */
export const RECONNECT_DELAY_MS = 250;
export const RECONNECT_DELAY_MAX_MS = 1000;

/**
 * How every socket on the page connects: a websocket first, and long-polling only if the websocket
 * fails to open (`tryAllTransports`), so a network that refuses websockets still connects. socket.io's
 * default starts on long-polling and upgrades, which cost each connection three or four extra round
 * trips through the edge before its first frame, each a run of the edge worker. Watchparty connects
 * websocket-first through the same edge.
 */
export function socketOptions(path: string = defaultSocketPath()): {
  path: string;
  transports: ('websocket' | 'polling')[];
  tryAllTransports: true;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
} {
  return { path, transports: ['websocket', 'polling'], tryAllTransports: true, reconnectionDelay: RECONNECT_DELAY_MS, reconnectionDelayMax: RECONNECT_DELAY_MAX_MS };
}
