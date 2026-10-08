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
 * ## Positions are CARD-anchored when the pointer is over a public card,
 * board-relative otherwise
 *
 * Each seat draws itself at the bottom and the other seat at the top, so a
 * screen position means different things on the two boards — but the
 * pointer's `Spot` is a fraction of the WHOLE board, never of the zone under
 * it: scaling by a zone's own box drifts at every board/board and
 * board/hand seam the moment the two screens size that zone differently,
 * because the scale factor jumps where one zone's box ends and the next (or
 * the gap between them) begins. `zone` still rides along, naming whichever
 * zone the point fell in (or `null`, between zones), for a receiver that
 * wants to know without re-deriving it — nothing here uses it to place the
 * point.
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
 * **`over` is the exception** (2026-10-08, the operator:
 * *"the cards themselves don't actually get smaller in size until the screen
 * is much, much smaller. it's important that the cursor is correctly showing
 * what card is being hovered even if the screen size is vastly different."*).
 * A board-fraction pointer drifts off a card the instant the two screens size
 * a card's row differently — which they always do once the aspect ratios
 * differ enough. So when the pointer sits over a PUBLIC card (battlefield,
 * stack, graveyard, exile — any card either seat may see by its own id) or,
 * for the sender's own hand (which the receiver draws as backs, never by
 * id), a slot of it, `over` names that element — a card by its id, a hand
 * slot by its INDEX — and the pointer's fractions WITHIN that element's own
 * box, never the whole board's. The receiver resolves `over` on its own
 * board (the same card id, or the i-th back of the sender's hand as the
 * receiver draws it) and places the cursor there, ignoring `pointer`'s board
 * fraction entirely. `over` is `null` whenever neither applies (off every
 * card, over the OTHER seat's hand as drawn to the sender, or the pointer
 * itself is `null`) — then `pointer`'s board fraction is all there is, as
 * before. A card never carries a hand id: hovering one's OWN hand sends the
 * slot INDEX, never the card there, which is why that branch exists at all —
 * see `live/presence.ts`'s `overOf`.
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
 * `null` — nothing rearranged, nothing just released as a spell.
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

/**
 * What the pointer is over, when that is a more precise anchor than the
 * board fraction: a public card by id, or a slot of the SENDER's own
 * hand by index (never a card id there — the receiver draws that hand as
 * backs). `x`/`y` are fractions of THAT element's own box, never the board's.
 */
export const PresenceOverSchema = z
  .union([
    z.object({ card: z.string().min(1), x: fraction, y: fraction }).strict(),
    z.object({ hand: z.number().int().nonnegative(), x: fraction, y: fraction }).strict(),
  ])
  .nullable();

export type PresenceOver = z.output<typeof PresenceOverSchema>;

/** Client → server. `pointer` null: the pointer left the board (or the tab was hidden). */
export const PresenceSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.literal('presence'),
    pointer: PresenceSpotSchema.nullable(),
    /**
     * What `pointer` is over, when that is sharper than the board fraction
     * — null defaults a pre-deploy sender's message, which never had
     * this field, to the old board-fraction-only placement.
     */
    over: PresenceOverSchema.default(null),
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
     * public — it is on the battlefield) and where it is held now, so the
     * other screen draws the same lifted card following the same point (the
     * operator, 2026-10-08: "all i want is for the views to be completely
     * mirrored"). Null when nothing is being rearranged; defaults so a
     * pre-deploy sender still parses.
     */
    arranging: z.object({ card: z.number().int().nonnegative(), at: PresenceSpotSchema }).strict().nullable().default(null),
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
