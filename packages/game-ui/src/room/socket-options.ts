/*
 * How every socket on the page connects: its path under the bundle's base, its transports and
 * reconnect pacing, and the page's session watch. Not any one game's: the draft, the match, the room
 * feed, the room's session claim and a relay room all connect this way.
 */

import { roomSocketOptions, type RoomSocketOptions } from '@wolffm/rooms-client';
import { watchSocket } from '@hadoku/ui-shell/session';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

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
 * How every socket on the page connects: websocket first with long-polling only as a fallback, and a
 * reconnect after 250 ms, never more than 1 s apart. The platform's one setting, shared with
 * watchparty's sockets: `@wolffm/rooms-client`'s `roomSocketOptions`, whose header says why.
 */
export function socketOptions(path: string = defaultSocketPath()): RoomSocketOptions {
  return roomSocketOptions(path);
}

/**
 * Every socket the page opens: socket.io's `io`, handed to the page's session watch
 * (`@hadoku/ui-shell/session`), so a socket whose handshake the edge refuses because the session is
 * gone stops reconnecting instead of trying every second forever. `url` omitted: same origin.
 */
export function openSocket(settings: Partial<ManagerOptions & SocketOptions> = socketOptions(), url?: string): Socket {
  const socket = url === undefined ? io(settings) : io(url, settings);
  watchSocket(socket);
  return socket;
}
