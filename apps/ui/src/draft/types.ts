/*
 * The draft envelope — now re-exported from `@hadoku/shared`.
 *
 * This file used to MIRROR `@wolffm/rooms-protocol`'s seat vocabulary and
 * hand-declare the envelope, because the registry could not be authenticated
 * when the UI was built and a UI lane was the wrong place to discover that. Its
 * own header carried the deletion condition:
 *
 *   > When the dependency resolves, delete the mirror and import the real
 *   > thing — the shapes are deliberately identical so that is a delete, not a
 *   > migration.
 *
 * The dependency resolves. The duplicated declarations are gone and the types
 * now come from the Zod schemas in `@hadoku/shared`, which is what the engine
 * produces — so the UI and the engine can no longer disagree about the shape.
 *
 * The module path survives only so the twelve importers did not all have to
 * change in the same commit as the deletion. Import from `@hadoku/shared`
 * directly in new code.
 *
 * One thing did change rather than move: the envelope now carries an `epoch`
 * alongside its `seq`. See `@hadoku/shared`'s `draft.ts` header — a `seq` alone
 * cannot tell a gap from a restart, and telling those apart is our own P6
 * requirement.
 */

export {
  viewerSeat,
  seatLabel,
  isWaiting,
  type DraftId,
  type ParticipantId,
  type SeatId,
  type SeatOccupant,
  type ManaColor,
  type Rarity,
  type DraftCard,
  type DraftSeatView,
  type ViewerView,
  type PassDirection,
  type DraftView,
} from '@hadoku/shared';
