/*
 * `RoomView.pod`'s wire shape — `@hadoku/shared`'s `pod.ts` (lane P, wave 72
 * §P, landed `98f45240`). This file used to carry a hand-restated LOCAL
 * mirror of it, built while that package was still mid-flight and the
 * manager's instruction was to build against fixtures rather than import
 * it; now that P has landed, importing it directly is exactly the one-line
 * swap that file's own header said it would be — nothing downstream in
 * `screens/pod/` changes, because the shapes already agreed field for
 * field (checked by hand against `packages/shared/src/pod.ts` at the time).
 *
 * `POD_SEATS`/`PodSeats`/`PodView`/`PodStandingsRow` are re-exported from
 * here, not imported at each call site, so this stays the one seam between
 * `@hadoku/shared`'s own naming and this screen's — the real `PodView` also
 * carries `results` and `pairings`, neither of which any component here
 * reads (`PodTables.tsx`'s own header explains why `pairings` adds nothing
 * `RoomView.tables` does not already say better).
 */

import { POD_SEATS, RoomPodSchema, type PodMember, type PodSeats, type PodStandingsRow, type PodView } from '@hadoku/shared';

export { POD_SEATS };
export type { PodMember, PodSeats, PodStandingsRow, PodView };

/** The AI's seat occupant (`apps/server/src/room/lobby.ts`'s `POD_AI`). */
export const POD_AI = 'ai';

/** A seat the owner closed (`lobby.ts`'s `POD_CLOSED`): nobody sits there, and the draft deals one fewer. */
export const POD_CLOSED = 'closed';

/**
 * Whether the draft deals: no seat open — every one a member or the AI — and
 * every seated member ready. A member who never sat is watching, and is not
 * waited on (the operator, 2026-10-19). The server's `startDraft` holds the same gate.
 */
export function podDealable(seats: PodSeats | undefined, members: readonly { id: string; ready: boolean }[]): boolean {
  if (seats === undefined || seats.some((s) => s === null)) return false;
  const humans = seats.filter((s) => s !== null && s.memberId !== POD_AI && s.memberId !== POD_CLOSED).map((s) => s!.memberId);
  return humans.length > 0 && humans.every((id) => members.find((m) => m.id === id)?.ready === true);
}


/**
 * `RoomView.pod`, narrowed. `null` for a constructed room, for a body this
 * cannot parse (an old server), and for a draft room genuinely in no pod
 * yet. Anything unparseable reads as `null` rather than a half-filled
 * guess: a pod screen with no pod data shows its own "waiting for the
 * table" state (already there from the drafting phase), never a misdrawn
 * one.
 */
export function parsePodView(v: unknown): PodView | null {
  const parsed = RoomPodSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}
