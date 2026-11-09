/*
 * Following a room, or the room list, without polling it.
 *
 * The server says when a room changed (`apps/server/src/room/watching.ts`) and a screen reads it
 * then. The pings come from the rooms core's feed client (`@wolffm/rooms-client`'s
 * `createFeedPings`): one socket per page, shared by every follower, opened by the first and
 * closed once the commit that let go of the last is over (`e2e/embed.spec.ts` counts them), and a
 * `heard` ping whenever the server confirms the watch — at the start and after every reconnect,
 * since nothing that changed before then could have been said. Its own connection, not the
 * match's or the pod's: those come and go with their screens.
 *
 * A following screen reads:
 *
 *   - once when it starts following, if the tab is shown;
 *   - on every ping, if the tab is shown;
 *   - once when the tab is shown again;
 *   - and every `FALLBACK_MS` while shown, in case a ping was lost some other way. That is the
 *     resilience read, not the mechanism.
 *
 * A hidden tab reads nothing. The server keeps the room offered meanwhile: the watch is presence.
 */

import { io } from 'socket.io-client';
import { ROOM_FEED_CHANNEL, parseRoomChanged } from '@wolffm/rooms-protocol';
import { createFeedPings, type FeedSocket, type FeedTarget, type PingSource } from '@wolffm/rooms-client';

import { socketOptions } from '../room/socket-options.ts';
import { documentVisibility, rereadWhileVisible, type RereadDeps } from '../visible.ts';

export type { FeedTarget, PingReason, PingSource } from '@wolffm/rooms-client';

/**
 * How often a visible screen reads anyway. A lost ping costs at most this much staleness. Long,
 * because a ping is lost only with its socket, and a reconnect already reads again on the ack.
 */
export const FALLBACK_MS = 120_000;

export interface RoomFeed {
  /** Call `refresh` on the schedule in this file's header. Returns the stop. */
  follow(target: FeedTarget, refresh: () => void): () => void;
}

export function createRoomFeed(pings: PingSource, deps: RereadDeps & { fallbackMs?: number } = {}): RoomFeed {
  const page = deps.page ?? documentVisibility();
  return {
    follow(target, refresh) {
      const stopReread = rereadWhileVisible(refresh, deps.fallbackMs ?? FALLBACK_MS, { ...deps, page });
      const stopPings = pings.subscribe(target, () => {
        if (!page.hidden()) refresh();
      });
      return () => {
        stopPings();
        stopReread();
      };
    },
  };
}

let sharedPings: PingSource | undefined;
let shared: RoomFeed | undefined;

/** The page's one feed socket's pings. */
function roomPings(): PingSource {
  sharedPings ??= createFeedPings({
    wire: { channel: ROOM_FEED_CHANNEL, parseChanged: parseRoomChanged },
    connect: () => io(socketOptions()) as unknown as FeedSocket,
  });
  return sharedPings;
}

/** The page's feed. Nothing connects until a screen follows something. */
export function roomFeed(): RoomFeed {
  shared ??= createRoomFeed(roomPings());
  return shared;
}
