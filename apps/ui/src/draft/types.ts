/**
 * The §B.5 wire envelope, as this lane consumes it.
 *
 * ## Why these types live here and not in `@wolffm/rooms-protocol`
 *
 * The seat vocabulary below — `SeatId` **as** the ordering, `SeatOccupant` with
 * `kind: 'bot'`, positional `bot:<n>` ids, `capacity` — is NOT invented here. It
 * is mirrored from `@wolffm/rooms-protocol`'s `seats.ts`, read at source. We do
 * not depend on that package because its registry (GitHub Packages) cannot be
 * authenticated in this wave's environment, and a UI lane is the wrong place to
 * discover that. **When the dependency resolves, delete the mirror and import
 * the real thing** — the shapes are deliberately identical so that is a delete,
 * not a migration.
 *
 * ## Why per-seat visibility is a *type*, not a convention
 *
 * `ViewerView` is a discriminated union with exactly two arms, and only the
 * `'seat'` arm carries cards. A spectator payload is structurally incapable of
 * holding a pack or a pool, and `DraftSeatView` carries `pickedCount` — a
 * number — rather than the picks themselves. That is the hidden-information
 * split expressed where the compiler can hold it: there is no field anywhere on
 * this envelope that could carry another seat's cards, so leaking one requires
 * adding a field rather than forgetting a filter.
 *
 * `hiddenInfo.ts` asserts the same property at runtime over serialised
 * payloads, because a fixture is JSON and JSON does not typecheck.
 *
 * ## No images, ever (D13)
 *
 * `DraftCard` has no image field and must never grow one. Everything the table
 * renders is text and geometry we draw ourselves.
 */

/** Opaque id for one draft. */
export type DraftId = string;

/**
 * Index into `seats`, not a sort key. Seat order is load-bearing: the pack
 * passes left, then right, then left again. Mirrors `rooms-protocol`.
 */
export type SeatId = number;

/** `fk:…` | `dev:…` | `eph:…`. Mirrors `rooms-protocol`'s `ParticipantId`. */
export type ParticipantId = string;

/** Mirrors `rooms-protocol`'s `SeatOccupant`. Bot ids are positional. */
export type SeatOccupant =
  | { kind: 'human'; participantId: ParticipantId }
  | { kind: 'bot'; botId: string };

/** The five colours. Colourless and generic are not colours and are not here. */
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special';

/**
 * A card as the draft table needs it: enough to pick with, nothing more.
 *
 * `manaCost` is a list of symbol *tokens* (`['2','W','W']`, `['X','R']`,
 * `['W/U']`) rather than a rendered string, because we draw our own pips and a
 * renderer needs the pieces. It is deliberately not a WotC symbol font.
 */
export interface DraftCard {
  /** Stable within one draft. Distinguishes two copies of the same card. */
  cardId: string;
  name: string;
  manaCost: string[];
  manaValue: number;
  colors: ManaColor[];
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  setCode: string;
  collectorNumber: string;
  rarity: Rarity;
}

/**
 * What everyone at the table may know about one seat.
 *
 * `pickedCount` is a count on purpose — the pool itself belongs to that seat
 * alone. Adding a `picked: DraftCard[]` here is the exact leak this lane exists
 * to make impossible.
 */
export interface DraftSeatView {
  id: SeatId;
  /** null = empty and claimable, same as `rooms-protocol`'s `Seat`. */
  occupant: SeatOccupant | null;
  /** Presentational only. Never an identity. */
  displayName: string;
  pickedCount: number;
}

/**
 * The recipient's own slice. A spectator arm carries no cards at all, which is
 * why it is a union rather than an optional field.
 */
export type ViewerView =
  | { kind: 'seat'; seatId: SeatId; pack: DraftCard[]; pool: DraftCard[] }
  | { kind: 'spectator' };

/** Pack-pass direction for the current round: left, then right, then left. */
export type PassDirection = 'left' | 'right';

/**
 * One per-recipient draft payload.
 *
 * `seq` is monotonic per draft and matches `CoreRoomState.lastEventSeq`'s
 * contract: a recipient that sees a gap has missed an event and must resync
 * rather than patch. Nothing in this wave transports it; the field exists so
 * that wiring in a later wave is wiring.
 */
export interface DraftView {
  draftId: DraftId;
  seq: number;
  /** 1-based. */
  packNumber: number;
  /** 1-based, within the current pack round. */
  pickNumber: number;
  /** How many pack rounds this draft has in total. */
  packCount: number;
  /** Cards in a fresh pack, per the recipe. */
  packSize: number;
  passDirection: PassDirection;
  /** Pod size, or null for unbounded. Mirrors `SeatTable.capacity`. */
  capacity: number | null;
  /** Index === SeatId, same invariant as `rooms-protocol`'s `SeatTable`. */
  seats: DraftSeatView[];
  /**
   * Seats still owing a pick this round — "whose turn it is", generalised.
   *
   * A booster draft is simultaneous, so this is normally several seats; a
   * strict-turn variant is the one-element case. Expressing it as a set means
   * the UI does not have to be rewritten if the engine changes its mind.
   */
  waitingOn: SeatId[];
  viewer: ViewerView;
}

/** Convenience: the seat arm, or null for a spectator. */
export function viewerSeat(view: DraftView): Extract<ViewerView, { kind: 'seat' }> | null {
  return view.viewer.kind === 'seat' ? view.viewer : null;
}

/** Label for a seat: the human's name, or the bot's positional id. */
export function seatLabel(seat: DraftSeatView): string {
  if (seat.occupant === null) return `Seat ${seat.id} — empty`;
  return seat.displayName;
}

/** Whether this seat still owes a pick in the current round. */
export function isWaiting(view: DraftView, id: SeatId): boolean {
  return view.waitingOn.includes(id);
}
