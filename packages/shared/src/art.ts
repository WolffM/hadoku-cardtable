/*
 * Art: every card either seat could show this match, told to each client once
 * it has joined, so its browser can fetch and decode the art before any of it
 * is drawn. A card turned over on the other screen used to draw its text tile
 * for as long as the art took to arrive (the operator, 2026-10-09: "i really
 * dont want a no-art card to show ever ... card art should load instantly").
 *
 * BOTH decks, to both seats: the operator's call, the same day — "if people
 * really wanted to cheat in this way i'd be fine with it. i care much more about
 * pre-loading art so that things load smoothly." Names and set codes only, the
 * same two keys the client's own art index resolves a card by
 * (`@hadoku/carddata/art`'s `scryfallIdFor`); never a URL, which stays the
 * client's to build (`apps/ui/src/draft/cardImage.ts`).
 *
 * Its own event, not a field on the join ack: the snapshot schema is mirrored
 * byte for byte in `apps/ui/src/play/live/transport.ts` and carries the seat's
 * state history, and the list is a fact about the match, not about any frame —
 * the same reasoning `forge:full-control` and `forge:seats` are their own
 * events. Sent on every join and resync, so a reload or a resumed match warms
 * its cache too.
 */
import { z } from 'zod';

export const ART_EVENT = 'forge:art';

export const ArtCardSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** The set code the deck names it by, or null when it names none. */
    set: z.string().min(1).max(16).nullable(),
  })
  .strict();
export type ArtCard = z.output<typeof ArtCardSchema>;

/** Server → one socket, after its join or resync ack. */
export const ArtPreloadSchema = z
  .object({
    matchId: z.string().min(1),
    cards: z.array(ArtCardSchema).max(2000),
  })
  .strict();
export type ArtPreload = z.output<typeof ArtPreloadSchema>;
