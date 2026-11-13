/*
 * This tab's claim on the room it is in: one live tab per player per room.
 *
 * The operator, 2026-11-07: a player opening a game they already have open elsewhere is asked, in the
 * middle of the screen with the rest of the site greyed out, whether to take over here; yes ends the
 * other session. The rule and the wire are the shared room layer's (`@wolffm/rooms-protocol`'s
 * `session.ts`); the server's half is `packages/game-server/src/room/session.ts`. This is the screen's half:
 *
 *   - one socket per room screen, opened when the screen has a room, which sends `session:claim`
 *     with this tab's settled id (`./tab-id.ts`) on every connect;
 *   - its answer is the state: `granted` and `watcher` play on, `held` asks, and `refused` (a request
 *     the server could not read) plays on as before rather than lock a player out;
 *   - `taken` (told, or closed by the server, which is how a take ends a tab's sockets) stops the
 *     screen and offers to take it back; that and the ask's yes are the same claim with `take`;
 *   - the screen claims again when it moves to another kind of screen in the room (the room → its
 *     match), so a watcher who sat down holds the room once their game starts;
 *   - the server's `session:beat` is answered at once. It arrives as a message, so a hidden tab whose
 *     timers the browser throttles still answers, and only a tab that is really gone goes stale.
 *
 * A server-side close does not reconnect, so a taken tab never loops back into the room by itself.
 */

import { io } from 'socket.io-client';
import { SESSION_EVENTS, parseSessionAnswer, parseSessionTaken, type SessionClaimRequest, type SessionClaimStatus } from '@wolffm/rooms-protocol';

import { socketOptions } from './socket-options.ts';
import { settledTabId } from './tab-id.ts';

/** `pending` until the first answer; `taken` once another tab of this account took the room. */
export type SessionState = 'pending' | SessionClaimStatus | 'taken';

/** The part of a socket.io client this file uses. */
export interface SessionSocket {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, payload: unknown, ack: (answer: unknown) => void): void;
  readonly connected: boolean;
  connect(): void;
  close(): void;
}

export interface RoomSessionDeps {
  connect?: () => SessionSocket;
  tabId?: () => Promise<string>;
}

export interface RoomSession {
  state(): SessionState;
  /** Called on every change of state. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Take the room from the tab holding it: the ask's yes, and the taken tab's way back. */
  take(): void;
  /** Claim again while playing or watching: whether this account plays here may have changed. */
  reclaim(): void;
  close(): void;
}

export function roomSession(room: string, deps: RoomSessionDeps = {}): RoomSession {
  const listeners = new Set<() => void>();
  let state: SessionState = 'pending';
  let closed = false;
  let wantTake = false;
  let socket: SessionSocket | null = null;
  let tabId: string | null = null;

  const set = (next: SessionState): void => {
    if (closed || next === state) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  const claim = (): void => {
    if (closed || socket === null || tabId === null || !socket.connected) return;
    const take = wantTake;
    const request: SessionClaimRequest = take ? { room, tabId, take } : { room, tabId };
    socket.emit(SESSION_EVENTS.claim, request, (raw) => {
      const answer = parseSessionAnswer(raw);
      if (answer === null) {
        console.warn('[session] an answer the wire does not allow', raw);
        set('refused');
        return;
      }
      if (take && answer.status !== 'held') wantTake = false;
      set(answer.status);
    });
  };

  const open = (id: string): void => {
    if (closed) return;
    tabId = id;
    const s = (deps.connect ?? (() => io(socketOptions()) as unknown as SessionSocket))();
    socket = s;
    s.on('connect', claim);
    s.on(SESSION_EVENTS.beat, (...args) => {
      const ack = args.at(-1);
      if (typeof ack === 'function') (ack as () => void)();
    });
    s.on(SESSION_EVENTS.taken, (raw) => {
      if (parseSessionTaken(raw)?.room === room) set('taken');
    });
    s.on('disconnect', (reason) => {
      // Only a take closes a session socket from the server's side.
      if (reason === 'io server disconnect') set('taken');
    });
  };

  void (deps.tabId ?? settledTabId)().then(open, (err: unknown) => {
    console.warn('[session] no tab id; the room plays on without a claim', err);
    set('refused');
  });

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take() {
      wantTake = true;
      if (socket === null) return;
      if (socket.connected) claim();
      else socket.connect();
    },
    reclaim() {
      if (state === 'granted' || state === 'watcher') claim();
    },
    close() {
      closed = true;
      socket?.close();
      listeners.clear();
    },
  };
}
