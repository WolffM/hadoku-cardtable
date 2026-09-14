/*
 * @hadoku/shared — the wire contract.
 *
 * Zod schemas for the draft envelope, plus the types inferred from them. Both
 * the engine (`@hadoku/draft`) and the UI (`@hadoku/ui`) bind here, so this is
 * the one place the shape is stated.
 *
 * Seat vocabulary is NOT defined here — it is re-exported from
 * `@wolffm/rooms-protocol`, which owns it. See `draft.ts`'s header for why the
 * envelope carries an `epoch` alongside its `seq`.
 */

export {
  DraftIdSchema,
  ParticipantIdSchema,
  SeatIdSchema,
  SeatOccupantSchema,
  ManaColorSchema,
  RaritySchema,
  DraftCardSchema,
  DraftSeatViewSchema,
  ViewerViewSchema,
  PassDirectionSchema,
  DraftViewSchema,
  viewerSeat,
  seatLabel,
  isWaiting,
  parseDraftView,
  safeParseDraftView,
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
  type ValidationFailure,
} from './draft.ts';

export { semanticIssues, formatPath } from './semantics.ts';
