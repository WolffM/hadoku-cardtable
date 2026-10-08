/*
 * Arrangement: where a seat put the cards on its own battlefield, sent to the
 * other seat so their screen draws that side the same way.
 *
 * The operator, 2026-10-08: *"the location for where a card is placed on the
 * opponent's board should match where they actually put it. at the moment the
 * two seem to be completely desynced."* Before this, an arrangement lived in
 * the arranging seat's tab alone (`Board.tsx`'s store) and the other screen
 * drew the view's own order.
 *
 * What crosses: the seat's battlefield rows, as piles of card ids per row
 * name. A battlefield card's id is already on the wire to both seats, so
 * nothing hidden is in it — and the HAND row never is: a hand's order names
 * hidden cards, and the schema refuses it outright.
 */
import { z } from 'zod';

export const ARRANGEMENT_EVENT = 'forge:arrangement';

const cardId = z.number().int().nonnegative();

export const ArrangementSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.literal('arrangement'),
    /** The sender's board layout: a receiver on another layout has no row of that name and draws its own order. */
    layout: z.enum(['single', 'type-separated']),
    /** Row name → piles of card ids, in the order the seat placed them. */
    rows: z.record(
      z
        .string()
        .min(1)
        .max(32)
        .regex(/^(?!hand$)/, 'a hand is never sent'),
      z.array(z.array(cardId).max(64)).max(64),
    ),
  })
  .strict();

export type ArrangementMessage = z.output<typeof ArrangementSchema>;

/** Server → the match's other sockets: the same, stamped with the seat it came from. */
export const ArrangementEchoSchema = ArrangementSchema.extend({ seat: z.number().int().min(0) }).strict();

export type ArrangementEcho = z.output<typeof ArrangementEchoSchema>;

/** A socket sending more than this in one second is a client bug; the rest of that second is dropped. */
export const ARRANGEMENT_MAX_PER_SECOND = 20;
