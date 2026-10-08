/*
 * Placed: a spell already committed to the stack, moved by its owner while
 * it waits to resolve (AD4 rule 3 — "its owner can drag it while it is on
 * the stack; the move crosses to the other screen; arrows follow it").
 *
 * The id here is a STACK ITEM's — public only once the spell is committed,
 * which `apps/ui/src/play/live/presence.ts`'s own receive path only ever
 * calls `commitSpell` for after it has shown on the other seat's stack — so
 * nothing hidden crosses. Unlike `placement.ts` (which rides WITH the act
 * that plays a card, before Forge has a frame about it, because the id is
 * known at that moment), a move of an already-placed spell has no act to
 * ride: it is its own message, sent only when the owner drags it, the same
 * shape `arrangement.ts`'s per-seat relay already is.
 */
import { z } from 'zod';
import { PresenceSpotSchema } from './presence.ts';

export const PLACED_EVENT = 'forge:placed';

export const PlacedSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.literal('placed'),
    /** A stack item's id — public by the time this can be sent. */
    spell: z.number().int().nonnegative(),
    /** Where the owner moved it to, on their own board. */
    at: PresenceSpotSchema,
  })
  .strict();
export type PlacedMessage = z.output<typeof PlacedSchema>;

/** Server → the match's other sockets: the same, stamped with the seat it came from — `presence.ts`'s own echo shape. */
export const PlacedEchoSchema = PlacedSchema.extend({ seat: z.number().int().min(0) }).strict();
export type PlacedEcho = z.output<typeof PlacedEchoSchema>;
