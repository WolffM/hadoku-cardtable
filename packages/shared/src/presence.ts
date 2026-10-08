/*
 * Presence: where the other seat's pointer is and what their hands are doing,
 * seat to seat, through the play server — never through Forge.
 *
 * The operator, 2026-10-06 (ledger Z5): *"can we try to show/animate the enemy
 * moving cards around? like when they try to play a card and even get to the
 * point of dragging the arrow to point but then cancel? we shouldn't reveal the
 * card they want to play, still keep it hidden until they actually commit it
 * to the stack. same question for mouse cursor."* And: *"we should see the
 * pointer even when they aren't holding a card."*
 *
 * ## What crosses the wire, and what never does
 *
 * A message is a pointer position, whether a card is held, and where an arrow
 * being aimed starts. It names NO card: `held` is a boolean, and the thing a
 * pointer is over is not sent either — the receiving board reads its own
 * element under the mapped position. So the hidden-information rule
 * (`apps/server/src/play/visibility.ts`; ledger V3, "a card being cast is not
 * shown to the opponent until it is actually on the stack") cannot be broken
 * by this channel, by construction: there is nothing in it to leak.
 *
 * ## Positions are BOARD-relative, with the zone as a hint only
 *
 * Each seat draws itself at the bottom and the other seat at the top, so a
 * screen position means different things on the two boards — but a `Spot`
 * is a fraction of the WHOLE board, never of the zone under it: scaling by a
 * zone's own box drifts at every board/board and board/hand seam the moment
 * the two screens size that zone differently, because the scale factor jumps
 * where one zone's box ends and the next (or the gap between them) begins.
 * `zone` still rides along, naming whichever zone the point fell in (or
 * `null`, between zones), for a receiver that wants to know without
 * re-deriving it — nothing here uses it to place the point.
 *
 * The receiver mirrors the WHOLE board top-to-bottom (the sender's own side,
 * at their board's bottom, is the receiver's opponent, drawn at the
 * receiver's top) and leaves left-right alone, because the columns run the
 * same way on both.
 *
 * `x`/`y` are fractions in [0, 1], not pixels: a pixel of one screen is
 * meaningless on another, and a bounded number is also what makes the schema
 * strict without caring about viewport sizes.
 *
 * ## A deploy is not a reload
 *
 * A match in progress spans a deploy: a tab still on the OLD bundle keeps
 * sending the old shape (a spot carries `owner`; a message carries no
 * `handRows`) until its own seat reloads it. That shape still parses: an
 * `owner` key is accepted and dropped (never read, by any receiver, on
 * either shape), and a missing `handRows` defaults to `1` — the one row
 * every build before this one ever drew. Only a shape that is actually
 * wrong (a bad fraction, an `handRows` that is neither `1` nor `2`, any
 * other extra key) is malformed.
 */

import { z } from 'zod';

/** The socket.io event, both directions. One name, both ways, like `forge:full-control`. */
export const PRESENCE_EVENT = 'forge:presence';

export const PresenceZoneSchema = z.enum(['hand', 'battlefield', 'graveyard', 'exile', 'stack']);

const fraction = z.number().min(0).max(1);

/** A point on a board, in a form the other board can place. */
export const PresenceSpotSchema = z
  .object({
    /** The zone under the point, as a hint only; placing it never scales by a zone's box. */
    zone: PresenceZoneSchema.nullable(),
    /** Fraction across the WHOLE board, 0 at its left edge, 1 at its right. */
    x: fraction,
    /** Fraction down the WHOLE board, 0 at its top edge, 1 at its bottom. */
    y: fraction,
    /** A pre-deploy sender's own zone-relative frame. Accepted so an old tab still parses; never read. */
    owner: z.unknown().optional(),
  })
  .strict()
  .transform(({ owner: _owner, ...spot }) => spot);

export type PresenceSpot = z.output<typeof PresenceSpotSchema>;

/** A column of a battlefield row, in `Board.tsx`'s own drop-target terms. A card id here is one of the sender's battlefield cards: public. */
export const PlacingSchema = z
  .object({
    slot: z.string().min(1).max(32),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('end') }).strict(),
      z.object({ kind: z.literal('before'), id: z.number().int().nonnegative() }).strict(),
      z.object({ kind: z.literal('stack'), id: z.number().int().nonnegative(), onTop: z.boolean() }).strict(),
      z.object({ kind: z.literal('at'), column: z.number().int().min(0).max(64) }).strict(),
    ]),
  })
  .strict();
export type Placing = z.output<typeof PlacingSchema>;

/** Client → server. `pointer` null: the pointer left the board (or the tab was hidden). */
export const PresenceSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.literal('presence'),
    pointer: PresenceSpotSchema.nullable(),
    /** A card is lifted, parked or carried — drawn for the other seat as a card BACK. Never which card. */
    held: z.boolean(),
    /**
     * Where an arrow being aimed starts (its tip is `pointer`) while `held`;
     * the release spot, sent once the moment a held card is let go
     * (`held: false` in the SAME message) — the hand-off flight's start.
     * Null when neither applies.
     */
    from: PresenceSpotSchema.nullable(),
    /**
     * The rows the sender's own hand drew — their hidden hand, on this wire,
     * draws the same. Defaults to `1` so a pre-deploy sender's message (which
     * never had this field) still parses.
     */
    handRows: z.union([z.literal(1), z.literal(2)]).default(1),
    /**
     * Sent once with the release (`held: false`): the COLUMN of the sender's
     * own battlefield the card was let go at — never the card. The other
     * screen reserves that column for the next card of theirs to arrive and
     * draws the back waiting in it, so both screens show the same motion.
     * Null when the release was not over their battlefield. Defaults to null
     * so a pre-deploy sender's message still parses.
     */
    placing: PlacingSchema.nullable().default(null),
  })
  .strict();

export type PresenceMessage = z.output<typeof PresenceSchema>;

/** Server → the match's other sockets: the same, stamped with the seat it came from. */
export const PresenceEchoSchema = PresenceSchema.extend({ seat: z.number().int().min(0) }).strict();

export type PresenceEcho = z.output<typeof PresenceEchoSchema>;

/**
 * How often a seat may send: the sender throttles to `PRESENCE_SEND_MS`, and
 * the server drops anything past `PRESENCE_MAX_PER_SECOND` from one socket
 * (a client bug, not a game event; nothing is owed back for it).
 */
export const PRESENCE_SEND_MS = 60;
export const PRESENCE_MAX_PER_SECOND = 40;
