/*
 * The wildcard card's own choices (`./WildcardCard.tsx`), pure so they are tested without mounting
 * it: which room is asking for players, which cube is in the spotlight, which of its cards show, and
 * which one thing the card shows (`pickWildcard`).
 */

import type { CubeSummary, DraftCard } from '@hadoku/shared';

import { gameTypeLabel, type RoomView } from '../rooms/api.ts';
import { roomCardView } from './roomCard.ts';

/**
 * The card shows one thing. Each kind's weight in the draw: how much it is worth showing over the
 * others when both are there — the start of a priority system the operator means to refine. A
 * room asking for players now outranks everything; the Discord invite is the fallback.
 */
export const WILDCARD_PRIORITY = { 'open-seats': 6, cube: 3, 'last-game': 2, lfg: 1 } as const;
export type WildcardKind = keyof typeof WILDCARD_PRIORITY;

/** One of `available`, drawn with `WILDCARD_PRIORITY`'s weights; `null` for none. */
export function pickWildcard(available: readonly WildcardKind[], random: () => number = Math.random): WildcardKind | null {
  const total = available.reduce((sum, k) => sum + WILDCARD_PRIORITY[k], 0);
  let roll = random() * total;
  for (const kind of available) {
    roll -= WILDCARD_PRIORITY[kind];
    if (roll < 0) return kind;
  }
  return available.at(-1) ?? null;
}

export interface OpenSeats {
  roomId: string;
  /** `alice's Draft needs 2` — the leader's name, or the room's when the leader has left. */
  title: string;
  missing: number;
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
    best = { roomId: room.id, title: `${leader}'s ${gameTypeLabel(room.gameType)} needs ${String(missing)}`, missing };
  }
  return best;
}

/** A cube worth showing: it has cards, and Forge has not refused it. `null` when none qualifies. */
export function spotlightCube(cubes: readonly CubeSummary[], random: () => number = Math.random): CubeSummary | null {
  const playable = cubes.filter((c) => c.size > 0 && c.verdict?.ok !== false);
  return playable.length === 0 ? null : playable[Math.floor(random() * playable.length)]!;
}

/** Up to `n` distinct cards' art ids from a cube's own cards, drawn at random. */
export function sampleArt(cards: readonly DraftCard[], n: number, random: () => number = Math.random): string[] {
  const ids = [...new Set(cards.map((c) => c.scryfallId).filter((id): id is string => id !== undefined))];
  const out: string[] = [];
  while (out.length < n && ids.length > 0) out.push(ids.splice(Math.floor(random() * ids.length), 1)[0]!);
  return out;
}
