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
 * being aimed starts. It names NO hidden card: `held` is a boolean, and the
 * only ids it carries are of BATTLEFIELD cards (the one nearest the pointer,
 * one being rearranged), which both seats already draw face up with their
 * ids. So the hidden-information rule (`apps/server/src/play/visibility.ts`;
 * ledger V3, "a card being cast is not shown to the opponent until it is
 * actually on the stack") cannot be broken by this channel, by construction:
 * there is nothing in it to leak.
 *
 * ## Positions are ANCHORED to what both boards draw, board-relative otherwise
 *
 * Each seat draws itself at the bottom and the other seat at the top, as a
 * vertical mirror: hand, then battlefield tiers or lanes, the side column
 * reversed. So every zone, every tier or lane, and every card in it has a
 * twin on the other screen — at a different size and often in a different
 * column, because the two windows differ and each lays its rows out for its
 * own width. `anchor` names the thing under the pointer by what both boards
 * share — the zone (and whose); on the battlefield the NEAREST CARD by its
 * id, elsewhere the nearest slot by its INDEX — and the pointer's offset in
 * units of that card's own box. The receiver finds the twin on its own board
 * and places the cursor at the same offset, mirrored top-to-bottom like the
 * seats themselves. Nearest, not only the one under the pointer, so the
 * offset runs past 0..1 between cards and the mapping is continuous: the
 * cursor never snaps onto a card as it enters one (the operator, 2026-10-09:
 * the card-anchored `over` this replaces jumped "very awkward[ly]" at every
 * card edge, and did not mirror within the card). A battlefield column's
 * index is not shared: a row's gaps, or a layout the receiver does not draw,
 * put the same index a card or more away (the operator, 2026-10-10, a Swamp
 * nudged 25 px drawn a card-width off on the other screen: "the difference
 * here is quite jarring"). A hand slot never carries a card id — an index
 * is all that crosses, and the receiver draws that hand as backs.
 *
 * `pointer`, a fraction of the WHOLE board, is the fallback, and the only
 * placement outside every zone (the stack, the strip between the seats, the
 * avatars): the receiver mirrors it top-to-bottom and leaves left-right alone,
 * because the columns run the same way on both. A stack card is itself placed
 * by that same board fraction, so a pointer over one is sent unanchored.
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
 *
 * The same holds for `arranging` (absent before it existed) and for
 * `placing` (wave 59): a message missing either still parses, defaulted to
 * `null` — nothing rearranged, nothing just released as a spell. An
 * `arranging` in the old whole-board `at` shape parses as `null` too: a
 * board fraction cannot be placed against the receiver's own drawing of
 * the card, so a pre-deploy sender's rearrange is not drawn until it
 * reloads. An anchor with no `card` is a pre-deploy sender's slot index,
 * and is placed as one.
 */

import { z } from 'zod';

/** The socket.io event, both directions. One name, both ways, like `forge:full-control`. */
export const PRESENCE_EVENT = 'forge:presence';

export const PresenceZoneSchema = z.enum(['hand', 'battlefield', 'graveyard', 'exile', 'stack']);

const fraction = z.number().min(0).max(1);
const cardId = z.number().int().nonnegative();
/** An offset in units of a card's own box: past 0..1 off the card, bounded so a stray value stays strict. */
const offset = z.number().min(-50).max(50);

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

/**
 * The pointer, anchored to something both boards draw (see "Positions are
 * ANCHORED" above). `card` is the nearest battlefield card's id; `row` a
 * battlefield tier or lane by name (`data-tier`, `data-board-row`), null for
 * a zone drawn as one box; `item` the nearest slot's index in a zone that is
 * not the battlefield, null when it holds none; `x`/`y` the offset in units
 * of that card's or slot's box (or the row's, or the zone's, without one) —
 * beyond 0..1 between and around cards, bounded so a stray value stays strict.
 */
export const PresenceAnchorSchema = z
  .object({
    zone: z.enum(['hand', 'battlefield', 'graveyard', 'exile']),
    /** The sender's own zone — drawn at the bottom of THEIR board, at the top of the receiver's. */
    own: z.boolean(),
    row: z.string().regex(/^[a-z]{1,16}$/).nullable(),
    /** Defaults so a pre-deploy sender's battlefield slot index still parses. */
    card: cardId.nullable().default(null),
    item: z.number().int().nonnegative().max(999).nullable(),
    x: offset,
    y: offset,
  })
  .strict()
  .nullable();

export type PresenceAnchor = z.output<typeof PresenceAnchorSchema>;

/** Client → server. `pointer` null: the pointer left the board (or the tab was hidden). */
export const PresenceSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.literal('presence'),
    pointer: PresenceSpotSchema.nullable(),
    /** Where `pointer` is, anchored to what both boards draw — null outside every zone, or from a pre-deploy sender. */
    anchor: PresenceAnchorSchema.default(null),
    /** A pre-deploy sender's card-anchored `over`. Accepted so an old tab still parses; never read. */
    over: z.unknown().optional(),
    /**
     * A card is LIFTED and following the pointer — drawn for the other seat as
     * a card BACK at the pointer. Never which card. A card let go and waiting
     * (parked on a question, an X, a target, Forge's frame) is NOT held: it
     * is `placing` below, and the pointer is free to go anywhere without it.
     */
    held: z.boolean(),
    /**
     * Where an arrow being aimed starts (its tip is `pointer`): a parked card's
     * centre, or the targeter's own start — only while the sender is aiming.
     * Never where a back stands (that is `placing`). Null otherwise.
     */
    from: PresenceSpotSchema.nullable(),
    /**
     * The rows the sender's own hand drew — their hidden hand, on this wire,
     * draws the same. Defaults to `1` so a pre-deploy sender's message (which
     * never had this field) still parses.
     */
    handRows: z.union([z.literal(1), z.literal(2)]).default(1),
    /**
     * A battlefield card of the sender's being rearranged: which (its id is
     * public — it is on the battlefield) and where its lifted copy's centre
     * is, as an offset from the centre of the card's own home box in units of
     * that box. The other screen draws the same lifted card the same fraction
     * of a card off ITS drawing of that card, whatever width either window
     * lays the row out at (the operator, 2026-10-08: "all i want is for the
     * views to be completely mirrored"). Null when nothing is being
     * rearranged; defaults so a pre-deploy sender still parses, and its
     * whole-board `at` parses as null (see "A deploy is not a reload").
     */
    arranging: z
      .union([
        z.object({ card: cardId, x: offset, y: offset }).strict(),
        z.object({ card: cardId, at: PresenceSpotSchema }).strict().transform(() => null),
      ])
      .nullable()
      .default(null),
    /**
     * A PARKED card's point (AD4 rule 2): where the sender's card stands,
     * let go and waiting — on the release message and on EVERY message after
     * it for as long as the card is parked, never only once. The receiver
     * stands a back AT it, as a durable marker, and nothing the pointer does
     * moves that back (the operator, 2026-10-08: "as my cursor moves to answer
     * the question … the phantom card is still attached. that's nonsense").
     * The wait ends when the spell's id is public (it shows on the stack), or
     * a permanent's own placement (`placement.ts`, riding WITH the act)
     * supersedes it the moment it arrives, as it always has. Null otherwise —
     * nothing parked, or a pre-deploy sender never had the field.
     */
    placing: z.object({ at: PresenceSpotSchema }).strict().nullable().default(null),
    /**
     * A HAND reorder just committed: `from` moved to `to`, both INDICES
     * in the sender's own hand order — never a card id, never a name, so the
     * receiver's hidden hand stays hidden; it only ever glides one of its own
     * anonymous backs. Rides with the one presence message sent right after
     * the commit and is read once; every other message carries `null`.
     * Defaults so a pre-deploy sender still parses.
     */
    handMove: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict().nullable().default(null),
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
