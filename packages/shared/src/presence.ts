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
 * ## Positions are zone-relative, because the two boards are mirrored
 *
 * Each seat draws itself at the bottom and the other seat at the top, so a
 * screen position means different things on the two boards. A `Spot` is
 * therefore expressed inside a zone when the pointer is in one — `zone` and
 * `owner` as the SENDER's board names them (`you`/`them`), plus the fraction
 * across and down that zone — and the receiver swaps the owner and maps the
 * fraction into its own copy of that zone. Outside every zone (the stack's
 * column, the rail) it is a fraction of the whole board, unmirrored.
 *
 * `x`/`y` are fractions in [0, 1], not pixels: a pixel of one screen is
 * meaningless on another, and a bounded number is also what makes the schema
 * strict without caring about viewport sizes.
 */

import { z } from 'zod';

/** The socket.io event, both directions. One name, both ways, like `forge:full-control`. */
export const PRESENCE_EVENT = 'forge:presence';

export const PresenceZoneSchema = z.enum(['hand', 'battlefield', 'graveyard', 'exile', 'stack']);
export const PresenceOwnerSchema = z.enum(['you', 'them', 'table']);

const fraction = z.number().min(0).max(1);

/** A point on a board, in a form the other board can place. */
export const PresenceSpotSchema = z
  .object({
    /** The zone the point is in, as the sender's board names it; null for a point outside every zone. */
    zone: PresenceZoneSchema.nullable(),
    owner: PresenceOwnerSchema.nullable(),
    /** Fraction across the zone (or the board), 0 at its left edge, 1 at its right. */
    x: fraction,
    /** Fraction down the zone (or the board), 0 at its top edge, 1 at its bottom. */
    y: fraction,
  })
  .strict();

export type PresenceSpot = z.output<typeof PresenceSpotSchema>;

/** Client → server. `pointer` null: the pointer left the board (or the tab was hidden). */
export const PresenceSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.literal('presence'),
    pointer: PresenceSpotSchema.nullable(),
    /** A card is lifted, parked or carried — drawn for the other seat as a card BACK. Never which card. */
    held: z.boolean(),
    /** Where an arrow being aimed starts (its tip is `pointer`); null when no arrow is up. */
    from: PresenceSpotSchema.nullable(),
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
