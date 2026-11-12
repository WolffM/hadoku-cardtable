/*
 * `MatchChannel` (`@wolffm/rooms-protocol`'s `game-bundle.d.ts`, the contract `BundleSlot.tsx`
 * hands a bundle as `ctx.channel`) implemented over the relay socket
 * (`apps/server/src/play/relay-socket.ts`): a socket.io connection on the SAME path and origin
 * every other socket on this page already uses (`../room/socket-options.ts`), joined with
 * `{ matchId: roomKey }`.
 *
 * Identity, the gate and the seal are the server's own `relay-socket.ts`'s job, exactly as the
 * play socket's own `attachPlay` — nothing here carries a credential of its own, same as
 * `play/live/match.ts`'s `socketIoMatchTransport`, whose connection shape this one mirrors.
 *
 * Ordering and at-most-once delivery are `runtimes/relay.ts`'s `RelaySession`'s own guarantees;
 * this file adds nothing to either — it only opens the connection, joins, rejoins on every
 * reconnect and after every match's end, and relays `relay:message` both ways. A watcher's own `send` is a silent no-op from
 * out here too, but only because the SERVER drops it without an error — nothing here tracks
 * whether this socket holds a seat.
 */

import { io, type Socket } from 'socket.io-client';
import type { MatchChannel } from '@wolffm/rooms-protocol';

import { defaultSocketPath, socketOptions } from '../room/socket-options.ts';

/**
 * Mirrors `apps/server/src/play/relay-socket.ts`'s own `RELAY_EVENTS`. The client has no package
 * of the server's to import these from (the server is not a dependency of the UI bundle), so the
 * two literal event names are repeated here rather than re-derived — if they ever drift, every
 * `relay:join` the server answers would simply go unrecognised at the join ack's own shape,
 * which `relay-fixture.spec.ts` (e2e) exercises end to end.
 */
const RELAY_EVENTS = { join: 'relay:join', message: 'relay:message', ended: 'relay:ended' } as const;

/**
 * A `MatchChannel` plus the host's own word that the match ended — the room's, never the
 * bundle's: `winners` are the seat numbers of the `{ t: 'over', winners }` that ended it (the
 * bundle's own `ctx.match` numbering), or null when every seat left. By the time a handler
 * hears it, this channel has already sent its join again: the room's next match is the one it
 * speaks in from then on (`relay-socket.ts`, "A room's next match").
 */
export interface RelayChannel extends MatchChannel {
  onEnded(handler: (winners: readonly number[] | null) => void): () => void;
  /**
   * The room's last result, for the room to show: the winners when a match ends (live, or the
   * join answering for a match that ended before this screen loaded), then null once the next
   * match is under way (the first message this channel sends or hears after that).
   */
  onResult(handler: (winners: readonly number[] | null) => void): () => void;
}

function winnersOf(raw: unknown): readonly number[] | null {
  return Array.isArray(raw) && raw.every((w) => typeof w === 'number') ? (raw as number[]) : null;
}

export interface RelayChannelOptions {
  /** The server's origin, e.g. `http://localhost:9008`. Omitted: same origin (production). */
  url?: string;
  /** socket.io path. Defaults to the bundle's own `/cardtable/socket.io/`. */
  path?: string;
}

/**
 * Opens one relay connection for `matchId` (a relay-runtime room's own id — there is no separate
 * match id for this kind of room; see `rooms/BundleSlot.tsx`'s own doc) and returns it as a
 * `MatchChannel`. `close()` disconnects the socket for good; call it once, on unmount.
 */
export function openRelayChannel(matchId: string, options: RelayChannelOptions = {}): RelayChannel {
  const path = options.path ?? defaultSocketPath();
  const settings = socketOptions(path);
  const socket: Socket = options.url === undefined ? io(settings) : io(options.url, settings);
  const handlers = new Set<(msg: unknown) => void>();
  const endedHandlers = new Set<(winners: readonly number[] | null) => void>();
  const resultHandlers = new Set<(winners: readonly number[] | null) => void>();
  let closed = false;
  /** A result is shown: the next message sent or heard clears it. */
  let showing = false;

  const tellResult = (winners: readonly number[] | null): void => {
    showing = winners !== null;
    for (const handler of [...resultHandlers]) handler(winners);
  };
  const underway = (): void => {
    if (showing) tellResult(null);
  };

  const join = (): void => {
    if (closed) return;
    // A match that ended before this join answers with its result (`relay-socket.ts`'s ack).
    socket.emit(RELAY_EVENTS.join, { matchId }, (ack: { ok?: unknown; ended?: { winners?: unknown } } | undefined) => {
      if (closed || ack?.ok !== true || ack.ended === undefined) return;
      tellResult(winnersOf(ack.ended.winners));
    });
  };
  // A fresh connection joins once it opens; a later reconnect (a dropped network, a deploy) joins
  // again on the new one — `relay-socket.ts` treats that exactly like a brand new peer.
  socket.on('connect', join);

  socket.on(RELAY_EVENTS.message, (msg: unknown) => {
    if (closed) return;
    underway();
    // Snapshotted first: a handler that subscribes or unsubscribes while running must not change
    // who else receives THIS message — the same rule `createInMemoryMatchChannels` documents.
    for (const handler of [...handlers]) handler(msg);
  });

  socket.on(RELAY_EVENTS.ended, (word: { winners?: unknown } | null) => {
    if (closed) return;
    const winners = winnersOf(word?.winners);
    // The room's next match is already registered under the same id: join it on this socket,
    // before anyone is told, so nothing the bundle sends after hearing the end is lost.
    join();
    for (const handler of [...endedHandlers]) handler(winners);
    tellResult(winners);
  });

  return {
    onEnded(handler) {
      if (closed) return () => {};
      endedHandlers.add(handler);
      return () => endedHandlers.delete(handler);
    },
    onResult(handler) {
      if (closed) return () => {};
      resultHandlers.add(handler);
      return () => resultHandlers.delete(handler);
    },
    send(msg) {
      if (closed) return;
      underway();
      socket.emit(RELAY_EVENTS.message, msg);
    },
    on(handler) {
      if (closed) return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      endedHandlers.clear();
      resultHandlers.clear();
      socket.disconnect();
    },
  };
}
