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
 * `@hadoku/shared`'s own naming and this screen's.
 */

import { isPodAi, POD_MAX_SEATS, POD_SEATS, POD_SPLIT_GRACE_MS, RoomPodSchema, type PodMember, type PodSeats, type PodStandingsRow, type PodView } from '@hadoku/shared';

export { isPodAi, POD_MAX_SEATS, POD_SEATS, POD_SPLIT_GRACE_MS };
export type { PodMember, PodSeats, PodStandingsRow, PodView };

/** The AI's seat occupant (`apps/server/src/room/lobby.ts`'s `POD_AI`). */
export const POD_AI = 'ai';

/** A seat the owner closed (`lobby.ts`'s `POD_CLOSED`): nobody sits there, and the draft deals one fewer. */
export const POD_CLOSED = 'closed';

/**
 * Whether every seat is filled — a member or the AI — and every seated member ready. A member who never sat
 * is watching, and is not waited on (the operator, 2026-10-19). The server's `startDraft` holds the same gate.
 */
export function podReady(seats: PodSeats | undefined, members: readonly { id: string; ready: boolean }[]): boolean {
  if (seats === undefined || seats.some((s) => s === null)) return false;
  const humans = seatedDrafters(seats);
  return humans.length > 0 && humans.every((id) => members.find((m) => m.id === id)?.ready === true);
}

/** The members in `seats`, in seat order: never an AI or a closed seat. */
export function seatedDrafters(seats: PodSeats): string[] {
  return seats.flatMap((s) => (s === null || isPodAi(s.memberId) || s.memberId === POD_CLOSED ? [] : [s.memberId]));
}

/**
 * Whether the draft deals as soon as the room is ready (`podReady`): a room of one pod's drafters. One of more
 * deals from the leader's Split & randomize instead (`PodSplit.tsx`).
 */
export function podDealable(seats: PodSeats | undefined, members: readonly { id: string; ready: boolean }[]): boolean {
  return seats !== undefined && seatedDrafters(seats).length <= POD_SEATS && podReady(seats, members);
}

/**
 * The pod's players, by member id: the members in its seats while it is in its
 * lobby, then its `drafters` — the server sends the seats only in the lobby.
 * Never an AI, of either shape (`isPodAi`): a draft pod's shared bot is never
 * listed in `drafters` to begin with, but a TOURNAMENT pod's own AI entrants
 * (`ai:<seat>`) are — this is the one place that filters them back out.
 */
export function podPlayers(pod: PodView): Set<string> {
  if (pod.phase !== 'lobby') return new Set(pod.drafters.filter((id) => !isPodAi(id)));
  return new Set(seatedDrafters(pod.seats));
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
