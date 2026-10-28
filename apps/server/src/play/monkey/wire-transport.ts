/*
 * The monkey's own socket.io connection — the actual wire protocol a browser
 * tab speaks, never an in-process shortcut. `apps/ui/src/play/live/match.ts`
 * already has `socketIoMatchTransport`, but it has no way to carry the
 * identity cookie the e2e stand-in edge (`e2e/edge.ts`) resolves a caller
 * from, so this is that same shape with one more option.
 *
 * Every frame crossing this socket, in both directions, is also handed to
 * `onEnvelope` — the monkey's flag detector taps the real wire traffic there
 * (`flashIncorrectAction`, a loop, a stall) rather than guessing from the
 * client's folded state.
 */

import { io, type Socket } from 'socket.io-client';

import type { MatchTransport } from '../../../../ui/src/play/live/match.ts';

export interface WireTap {
  /** Every inbound `forge:s2c` envelope, as `match.ts`'s own transport sees it — before it folds anything. */
  onServerFrame?(envelope: unknown): void;
  /** Every outbound client frame this seat sends, on `forge:c2s`. */
  onClientFrame?(payload: unknown): void;
}

export interface SocketTransportOptions {
  url: string;
  path: string;
  /** The e2e stand-in edge's session cookie (`e2e/identities.ts`'s `SESSION_COOKIE=<name>`). */
  cookie: string;
  ackTimeoutMs?: number;
  tap?: WireTap;
}

const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/** The raw socket, for the caller that needs to close it directly (`closeSocketTransport`). */
const sockets = new WeakMap<MatchTransport, Socket>();

export function closeSocketTransport(transport: MatchTransport): void {
  sockets.get(transport)?.disconnect();
}

export function socketTransport(options: SocketTransportOptions): MatchTransport {
  const socket: Socket = io(options.url, {
    path: options.path,
    transports: ['websocket'],
    extraHeaders: { Cookie: options.cookie },
    reconnection: true,
  });

  const transport: MatchTransport = {
    on: (event, handler) => {
      socket.on(event, (payload?: unknown) => {
        if (event === 'forge:s2c') options.tap?.onServerFrame?.(payload);
        handler(payload);
      });
    },
    emit: (event, payload) => {
      if (event === 'forge:c2s') options.tap?.onClientFrame?.(payload);
      socket.emit(event, payload);
    },
    request: (event, payload, onAck) => {
      socket.timeout(options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS).emit(event, payload, (err: Error | null, response?: unknown) => {
        onAck(err, response);
      });
    },
    disconnect: () => {
      socket.disconnect();
    },
  };
  sockets.set(transport, socket);
  return transport;
}
