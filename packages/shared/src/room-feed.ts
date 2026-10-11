/*
 * The room feed: the server says "this changed", the screen reads it again.
 *
 * A room screen, the room list and a match's result screen used to read the
 * room every second and a half for as long as they stayed open, whether or not
 * anything had moved (hadoku_site's request log: ~7,500 requests in 6 h from
 * five rooms, every one a 304). What changes a room is always a write on this one
 * server, so the server knows the moment it happens and says so on the socket
 * the page already speaks.
 *
 * ## A ping, not the room
 *
 * The message names WHICH room changed and nothing else. Every room read is
 * caller-scoped — `you.leader`, `you.ready`, your own deck's verdict, the
 * other player's choice withheld — so a payload pushed to a room would either
 * be built per member (a second copy of every read route's rules) or leak.
 * The screen reads the route it already reads, through the same gate.
 *
 * ## Watching is a set, sent whole
 *
 * A socket says everything it follows in one message — the rooms by id, and
 * whether it follows the list — and each message REPLACES the last. A reconnect
 * sends the set again, so the server needs no memory of a socket it lost. The
 * server acknowledges a watch once it is in force; what changed before that was
 * never going to be said, so the client reads once more on the ack.
 */

import { z } from 'zod';

export const ROOM_FEED_CHANNEL = {
  /** Client → server. Payload: `RoomWatch`. */
  watch: 'rooms:watch',
  /** Server → client. Payload: `RoomChanged`. */
  changed: 'rooms:changed',
} as const;

/** More than a page ever follows (a room screen and its result screen); a ceiling, not a budget. */
export const ROOM_WATCH_MAX = 8;

export const RoomWatchSchema = z.strictObject({
  rooms: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(ROOM_WATCH_MAX),
  list: z.boolean(),
});
export type RoomWatch = z.infer<typeof RoomWatchSchema>;

export const RoomChangedSchema = z.union([z.strictObject({ room: z.string() }), z.strictObject({ list: z.literal(true) })]);
export type RoomChanged = z.infer<typeof RoomChangedSchema>;
