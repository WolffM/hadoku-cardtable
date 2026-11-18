/**
 * A room's game seats as they travel: who holds each seat, by seat number — a member's id, one of
 * the two markers below, or null for an open seat. The server writes them (`@hadoku/game-server`'s
 * `room/record.ts`) and every game's page reads them (`@hadoku/game-ui`'s `seats/platform.ts`), so
 * the markers are defined once, here, for both.
 */

/** The marker of a seat an AI holds. */
export const AI_SEAT = 'ai';

/** The marker of a seat its room's leader closed: nobody sits there, and the game is a seat smaller. */
export const CLOSED_SEAT = 'closed';

/** An AI seat as a player: one of the platform's characters, by its own name (`knight` plays as Knight). */
export interface AiPersona {
  name: string;
  avatarId: string;
}
