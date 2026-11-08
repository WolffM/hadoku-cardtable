/*
 * Following a room without polling it.
 *
 * The room screen, the room list and the result screen each used to read the
 * room every second and a half for as long as they stayed open — every open tab,
 * around the clock (hadoku_site's request log: ~7,500 reads in 6 h, five rooms).
 * Now the server says when a room changed (`apps/server/src/room/feed.ts`, over
 * the socket this page already speaks), and a screen reads it then:
 *
 *   - once when it starts following;
 *   - whenever the server says the room (or the list) changed;
 *   - once more when the server confirms it is watching for this screen — at
 *     the start and after every reconnect — because nothing that changed
 *     before then could have been said;
 *   - once when the tab is shown again;
 *   - and every `FALLBACK_MS` while the tab is visible, in case a ping was lost
 *     some other way. That is the resilience read, not the mechanism.
 *
 * A hidden tab reads NOTHING — not the fallback, not a ping — until it is shown
 * again, and then reads once. The server keeps the room offered meanwhile: the
 * watch itself is presence there.
 *
 * ## One socket per page, opened while something follows
 *
 * Every follower on the page shares one connection, and it is closed when the
 * last one stops and no other has started in the same tick: an embed that
 * unmounts leaves no socket behind
 * (`e2e/embed.spec.ts` counts them). Its own connection, not the match's: a
 * match socket comes and goes with the match screen, and a pod's with the pod.
 */

import { io } from 'socket.io-client';
import { ROOM_FEED_CHANNEL, ROOM_WATCH_MAX, RoomChangedSchema, type RoomWatch } from '@hadoku/shared';

import { socketOptions } from '../room/socket-options.ts';
import { documentVisibility, rereadWhileVisible, type PageVisibility } from '../visible.ts';

/** How often a visible screen reads anyway. A lost ping costs at most this much staleness. */
export const FALLBACK_MS = 30_000;

/** What a screen follows: one room, or the room list. */
export type FeedTarget = { room: string } | 'list';

export interface RoomFeed {
  /** Call `refresh` on the schedule in this file's header. Returns the stop. */
  follow(target: FeedTarget, refresh: () => void): () => void;
}

/**
 * Why a follower is pinged: the room `changed`, or the server has just `heard` the watch naming it —
 * at the start and after every reconnect, which is also when a restarted server has this screen back.
 */
export type PingReason = 'changed' | 'heard';

/** Where the "it changed" pings come from. `onPing` is also called after a reconnect. */
export interface PingSource {
  subscribe(target: FeedTarget, onPing: (why: PingReason) => void): () => void;
}

/** The part of a socket.io client this file uses. */
export interface FeedSocket {
  on(event: string, handler: (payload?: unknown) => void): void;
  emit(event: string, payload: unknown, ack: () => void): void;
  readonly connected: boolean;
  close(): void;
}

export interface FeedDeps {
  pings: PingSource;
  page?: PageVisibility;
  fallbackMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function createRoomFeed(deps: FeedDeps): RoomFeed {
  const page = deps.page ?? documentVisibility();
  return {
    follow(target, refresh) {
      const stopReread = rereadWhileVisible(refresh, deps.fallbackMs ?? FALLBACK_MS, { ...deps, page });
      const stopPings = deps.pings.subscribe(target, () => {
        if (!page.hidden()) refresh();
      });
      return () => {
        stopPings();
        stopReread();
      };
    },
  };
}

/**
 * Pings over one socket, shared by every follower, opened by the first and closed by the last.
 *
 * A follower is "heard" once the server has acknowledged a watch that names it.
 * Until then a change to its room could not have been said to it — it read the
 * room when it started following, but the watch reached the server later, or
 * the socket was down — so the ack that makes it heard is also one more read.
 * A reconnect makes every follower unheard again.
 */
export function socketPings(connect: () => FeedSocket = () => io(socketOptions()) as unknown as FeedSocket): PingSource {
  const followers = new Map<number, { target: FeedTarget; onPing: (why: PingReason) => void; heard: boolean }>();
  let next = 0;
  let socket: FeedSocket | null = null;

  const watch = (): RoomWatch => {
    const rooms = new Set<string>();
    let list = false;
    for (const { target } of followers.values()) {
      if (target === 'list') list = true;
      else rooms.add(target.room);
    }
    return { rooms: [...rooms].slice(0, ROOM_WATCH_MAX), list };
  };

  const sendWatch = (to: FeedSocket): void => {
    const named = [...followers.keys()];
    to.emit(ROOM_FEED_CHANNEL.watch, watch(), () => {
      for (const id of named) {
        const f = followers.get(id);
        if (f === undefined || f.heard) continue;
        f.heard = true;
        f.onPing('heard');
      }
    });
  };

  const open = (): FeedSocket => {
    const opened = connect();
    opened.on('connect', () => {
      for (const f of followers.values()) f.heard = false;
      sendWatch(opened);
    });
    opened.on(ROOM_FEED_CHANNEL.changed, (raw) => {
      const parsed = RoomChangedSchema.safeParse(raw);
      if (!parsed.success) return;
      const changed = parsed.data;
      for (const f of [...followers.values()]) {
        if ('list' in changed ? f.target === 'list' : f.target !== 'list' && f.target.room === changed.room) f.onPing('changed');
      }
    });
    return opened;
  };

  return {
    subscribe(target, onPing) {
      const id = (next += 1);
      followers.set(id, { target, onPing, heard: false });
      if (socket === null) socket = open();
      else if (socket.connected) sendWatch(socket);
      return () => {
        followers.delete(id);
        if (socket === null) return;
        if (followers.size > 0) {
          if (socket.connected) sendWatch(socket);
          return;
        }
        // Closed once the commit that let go of the last follower is over, so a screen
        // that replaces another (the room → the lobby) keeps the connection instead of
        // opening a new one — which, still upgrading when an embed unmounted, polled on
        // after the unmount.
        const idle = socket;
        queueMicrotask(() => {
          if (followers.size > 0 || socket !== idle) return;
          idle.close();
          socket = null;
        });
      };
    },
  };
}

let sharedPings: PingSource | undefined;
let shared: RoomFeed | undefined;

/** The page's one socket's pings, for a follower that acts on a reconnect rather than reading the room. */
export function roomPings(): PingSource {
  sharedPings ??= socketPings();
  return sharedPings;
}

/** The page's feed. Nothing connects until a screen follows something. */
export function roomFeed(): RoomFeed {
  shared ??= createRoomFeed({ pings: roomPings() });
  return shared;
}
