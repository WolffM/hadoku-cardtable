/**
 * Generic room-lifecycle constants, shared by nothing Magic-specific.
 *
 * Moved out of `room/lobby.ts` (split, wave 99 §L) so a platform file
 * (`erase/recordings.ts`, `room/watching.ts`) can read them without an edge
 * into the tangled lobby.
 */

/**
 * What a member is called before any request of theirs has named them: one restored from a saved
 * room, which keeps no names (R12). The same word the HTTP layer gives a key the edge sent no
 * name for.
 */
export const UNNAMED = 'friend';

/**
 * How long a room may go without a touch before the front page stops
 * OFFERING it (wave 31). The room is not deleted (`ROOM_IDLE_MS` does that, much
 * later); it just stops advertising itself.
 *
 * The operator: *"why are 'hi there' and 'hi there2' still showing up?"* Rooms
 * restore on boot and live twelve hours, and the list prints a room's STORED
 * members, not who is connected, so a dead table looked alive with an Enter
 * button. A room someone has open is touched by its screen's reads and, for as
 * long as the screen stays open, by the room feed (`room/watching.ts`), so "nobody
 * touched it for thirty minutes" means nobody is there. A room with a match or
 * a draft under way is exempt: its players are on another screen.
 */
export const ROOM_STALE_MS = 30 * 60_000;
