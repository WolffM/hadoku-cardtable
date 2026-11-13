/*
 * Placed: a spell or ability already committed to the stack, moved by either
 * seat while it waits to resolve (AD4 rule 3, "the move crosses to the other
 * screen; arrows follow it"; the operator, 2026-11-02, lifted "its owner": "lets
 * also make it so the opponent can drag and move things on the stack around").
 *
 * The id here is a STACK ITEM's — public only once the spell is committed,
 * which `games/magic/ui/src/play/live/presence.ts`'s own receive path only ever
 * calls `commitSpell` for after it has shown on the other seat's stack — so
 * nothing hidden crosses. Unlike `placement.ts` (which rides WITH the act
 * that plays a card, before Forge has a frame about it, because the id is
 * known at that moment), a move of an already-placed spell has no act to
 * ride: it is its own message, sent only when a seat drags it, the same
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
    /** Where it was moved to, on the sender's own board. */
    at: PresenceSpotSchema,
    /**
     * Where the sender's drag is: `grab` picked it up, `drop` let it go. Absent: a move. Either seat
     * may drag any stack item, and both may hold one at once (the operator, 2026-11-02: "a funny
     * interaction i dont want to kill"); the server keeps who holds it (`holders` on the echo).
     */
    grip: z.enum(['grab', 'move', 'drop']).optional(),
  })
  .strict();
export type PlacedMessage = z.output<typeof PlacedSchema>;

/**
 * Server → the match's other sockets: the same, stamped with the seat it came from — `presence.ts`'s
 * own echo shape — and the seats holding the item after it, in the order they took hold (the newest
 * last). The server is the one record of who holds what: a seat whose socket goes lets go.
 */
export const PlacedEchoSchema = PlacedSchema.extend({
  seat: z.number().int().min(0),
  holders: z.array(z.number().int().min(0)).max(8).optional(),
}).strict();
export type PlacedEcho = z.output<typeof PlacedEchoSchema>;
