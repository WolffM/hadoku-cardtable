/*
 * Placement: where a card a seat just played goes on its battlefield — the
 * column and the release point — carried WITH THE ACT through the server and
 * broadcast to every socket of the match before any Forge frame about the
 * card can arrive. One channel, ordered: both screens reserve the gap and
 * glide the stand-in into it from the same message, and the card's arrival is
 * drawn in that gap on both (the operator, 2026-10-08: "on card release we
 * should see it animate in the same way that it animates from the view side").
 *
 * Before this the other screen learned the column from presence, a separate
 * relay that could lose the race against the Forge frame: the card then
 * appeared at once and the back waited in a gap for a card that had already
 * come. The card id here is the one the act commits: Forge has it on the
 * stack within the same round trip, so nothing hidden is revealed.
 */
import { z } from 'zod';
import { PresenceSpotSchema } from './presence.ts';

export const PLACEMENT_EVENT = 'forge:placement';

/** A column of a battlefield row, in `Board.tsx`'s own drop-target terms; a card id in a target is one of the sender's battlefield cards: public. */
export const PlacementTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('end') }).strict(),
  z.object({ kind: z.literal('before'), id: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('stack'), id: z.number().int().nonnegative(), onTop: z.boolean() }).strict(),
  z.object({ kind: z.literal('at'), column: z.number().int().min(0).max(64) }).strict(),
]);

/** Rides on the act (`forge:c2s`'s envelope) that plays the card. */
export const PlacementSchema = z
  .object({
    slot: z.string().min(1).max(32),
    target: PlacementTargetSchema,
    /** The release point on the sender's board, for the other screen's stand-in to glide from. */
    at: PresenceSpotSchema,
  })
  .strict();
export type Placement = z.output<typeof PlacementSchema>;

/** Server → every socket of the match, the moment the act arrives. */
export const PlacementEchoSchema = PlacementSchema.extend({
  matchId: z.string().min(1),
  seat: z.number().int().min(0),
  card: z.number().int().nonnegative(),
}).strict();
export type PlacementEcho = z.output<typeof PlacementEchoSchema>;
