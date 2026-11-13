/*
 * The wildcard card's own choices (`./WildcardCard.tsx`), pure so they are tested without mounting
 * it: which room is asking for players, which cube is in the spotlight, which page the gallery opens on (`pickWildcard`) and the order of the rest (`wildcardPages`),
 * and the featured tournament's top three (`podiumOf`).
 */

import type { CubeSummary, Tournament } from '@hadoku/shared';

import { faceOf, type Face } from '@hadoku/game-ui/components/Avatar.tsx';
import { gameTypeLabel, type RoomView } from '../rooms/api.ts';
import { records, recordText } from '../screens/pod/swiss.ts';
import { roomCardView, type RoomCardView } from './roomCard.ts';

/**
 * Each kind's weight in the draw for the gallery's first page, and the order of the pages after it:
 * how much it is worth showing over the others when both are there (the operator, 2026-10-30:
 * "manual is better, but let's still have the priority system for what is shown by default and the
 * randomness system beyond that"). A room asking for players outranks everything drawn; the Discord
 * invite is the fallback.
 */
export const WILDCARD_PRIORITY = { tournament: 10, 'open-seats': 6, cube: 3, chat: 3, lfg: 1 } as const;
export type WildcardKind = keyof typeof WILDCARD_PRIORITY;

/**
 * A kind the gallery always opens on when it is there, with no draw: a tournament's result, for the
 * week it holds the seat (`games/magic/server/src/room/featured-tournament.ts`; the operator, 2026-11-08).
 */
const PINNED: WildcardKind = 'tournament';

/** `PINNED` when it is there; otherwise one of `available`, drawn with `WILDCARD_PRIORITY`'s weights; `null` for none. */
export function pickWildcard(available: readonly WildcardKind[], random: () => number = Math.random): WildcardKind | null {
  if (available.includes(PINNED)) return PINNED;
  const total = available.reduce((sum, k) => sum + WILDCARD_PRIORITY[k], 0);
  let roll = random() * total;
  for (const kind of available) {
    roll -= WILDCARD_PRIORITY[kind];
    if (roll < 0) return kind;
  }
  return available.at(-1) ?? null;
}

/** The gallery's pages: the pick first, then every other kind there is, highest priority first. */
export function wildcardPages(available: readonly WildcardKind[], picked: WildcardKind | null): WildcardKind[] {
  const rest = available.filter((k) => k !== picked).sort((a, b) => WILDCARD_PRIORITY[b] - WILDCARD_PRIORITY[a]);
  return picked !== null && available.includes(picked) ? [picked, ...rest] : rest;
}

export interface OpenSeats {
  roomId: string;
  /** `alice's Draft needs 2` — the leader's name, or the room's when the leader has left. */
  title: string;
  missing: number;
  /** The room and its card, so the page draws its seats as the room list does. */
  room: RoomView;
  view: RoomCardView;
}

/**
 * The room closest to starting that the viewer could sit down in: still seating, a seat open, not a
 * testing room, not one waiting for an event that has not started (it is on the calendar instead),
 * and not one the viewer is already in. Fewest missing seats first, then the list's own order.
 * `null` when there is none.
 */
export function openSeats(rooms: readonly RoomView[], now: number = Date.now()): OpenSeats | null {
  let best: OpenSeats | null = null;
  for (const room of rooms) {
    if (room.testing || room.members.some((m) => m.id === room.you.id)) continue;
    if (room.scheduledFor !== null && Date.parse(room.scheduledFor) > now) continue;
    const card = roomCardView(room, false, now);
    if (card.state.key !== 'lobby') continue;
    const missing = card.seatsCapacity - card.seatsFilled;
    if (missing <= 0 || (best !== null && missing >= best.missing)) continue;
    const leader = room.members.find((m) => m.id === room.leader)?.name ?? room.name;
    best = { roomId: room.id, title: `${leader}'s ${gameTypeLabel(room.gameType)} needs ${String(missing)}`, missing, room, view: card };
  }
  return best;
}

/** A cube worth showing: it has cards, and Forge has not refused it. `null` when none qualifies. */
export function spotlightCube(cubes: readonly CubeSummary[], random: () => number = Math.random): CubeSummary | null {
  const playable = cubes.filter((c) => c.size > 0 && c.verdict?.ok !== false);
  return playable.length === 0 ? null : playable[Math.floor(random() * playable.length)]!;
}

export interface PodiumPlace {
  id: string;
  place: 1 | 2 | 3;
  name: string;
  face: Face;
  /** `3–0`. */
  record: string;
}

/** A finished tournament's top three, by the places the server ranked (`PodStandingsRow.rank`); fewer when it had fewer. */
export function podiumOf(t: Tournament): PodiumPlace[] {
  const rec = records(t);
  return [...t.standings]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
    .map((row, i) => ({
      id: row.id,
      place: (i + 1) as 1 | 2 | 3,
      name: t.names[row.id] ?? row.id,
      face: faceOf(t.faces?.[row.id]),
      record: recordText(rec.get(row.id) ?? { w: 0, l: 0, d: 0 }),
    }));
}
