/*
 * The draft rope: how long a seat has for one pick, and what it takes when the
 * time runs out (the operator, 2026-10-30, wave 83 D3).
 *
 * A per-pick timer, not a total. The times are Wizards' MTR Appendix B, by the
 * cards left in the pack the seat is picking from. The last card has no timer:
 * there is nothing to choose, so the seat takes it at once.
 *
 * Pure, like the rest of the package: the deadline itself is the server's
 * (`apps/server/src/room/socket.ts`), which is the only thing that knows what
 * time it is. This file only says how long, and which card.
 */

import type { SeatId } from '@wolffm/rooms-protocol';
import { choosePick } from './bot.ts';
import { botRng, packOf, pick, type PickResult, type DraftState } from './engine.ts';
import type { DraftCard } from '@hadoku/shared';

/** MTR Appendix B: [fewest cards left this row covers, seconds]. Read top-down; the first row at or under wins. */
const MTR_SECONDS: readonly (readonly [number, number])[] = [
  [14, 40],
  [13, 35],
  [12, 30],
  [10, 25],
  [8, 20],
  [7, 15],
  [5, 10],
  [2, 5],
];

/** Seconds for a pick from a pack holding `cardsLeft`, at the table's own speed; null for the last card. */
export function pickSeconds(cardsLeft: number): number | null {
  for (const [atLeast, seconds] of MTR_SECONDS) if (cardsLeft >= atLeast) return seconds;
  return null;
}

/**
 * Milliseconds for one pick: the MTR time divided by the room's speed (2 is
 * twice as fast, 0.5 twice as long). Null when the pick has no timer.
 */
export function pickTimeMs(cardsLeft: number, speed: number): number | null {
  const seconds = pickSeconds(cardsLeft);
  return seconds === null ? null : Math.round((seconds * 1000) / speed);
}

/**
 * The seat's pick when its time runs out: the card the draft bot would take
 * in its place, from the same per-(seat, pack, pick) generator a bot seat
 * uses, so it never depends on when the timer fired.
 */
export function timeoutPick(state: DraftState, seatId: SeatId): PickResult | null {
  const card: DraftCard | null = choosePick(packOf(state, seatId), state.pools[seatId] ?? [], botRng(state, seatId));
  return card === null ? null : pick(state, seatId, card.cardId);
}
