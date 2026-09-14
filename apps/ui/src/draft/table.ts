/**
 * What the table shows right now = the last authoritative payload, plus at most
 * one pick this client has made and the server has not answered yet.
 *
 * ## The pending pick is presentation, not engine
 *
 * This is NOT a draft reducer and must never become one. The engine owns pack
 * passing, pick validation and bot picks; it is a separate package and a
 * separate lane. All this does is hold the card you just clicked so the pool
 * gains it and the pack loses it immediately — the optimistic half of what a
 * real client does, with the reconciling half (the next `DraftView`) supplied
 * by `applyPayload`.
 *
 * The deliberate omission is the giveaway that it is not an engine: after you
 * pick, **the pack you see is empty, not the next pack**. Nothing on this
 * client knows which pack your neighbour is about to pass you, and inventing
 * one would be a lie that renders convincingly. So the pack area says it is
 * waiting, and the wait ends when a payload arrives.
 *
 * ## Why a pick can be rejected here at all
 *
 * The engine rejects an out-of-turn or unknown pick as a value (§B.3), and the
 * UI should not be able to send one in the first place. The same two checks run
 * here so the button is disabled rather than the click being swallowed; the
 * server's answer is still the one that counts.
 */

import type { DraftCard, DraftView } from './types.ts';
import { viewerSeat } from './types.ts';

export interface TableState {
  /** The last payload the server sent. Replaced wholesale, never patched. */
  view: DraftView;
  /** The card clicked since that payload, if any. */
  pending: DraftCard | null;
}

export type PickRejection =
  | { reason: 'spectator' }
  | { reason: 'not-your-turn'; seatId: number }
  | { reason: 'already-picked'; cardId: string }
  | { reason: 'not-in-pack'; cardId: string };

export type PickResult =
  | { ok: true; state: TableState }
  | { ok: false; rejection: PickRejection };

export function initialState(view: DraftView): TableState {
  return { view, pending: null };
}

/** Cards still choosable: the pack, minus a pick already sent. */
export function visiblePack(state: TableState): DraftCard[] {
  const seat = viewerSeat(state.view);
  if (!seat) return [];
  if (state.pending === null) return seat.pack;
  // After a pick the rest of the pack is gone — it is in front of the next
  // seat, not in front of you. See this module's header.
  return [];
}

/** The pool as the player should see it, including a pick in flight. */
export function visiblePool(state: TableState): DraftCard[] {
  const seat = viewerSeat(state.view);
  if (!seat) return [];
  return state.pending === null ? seat.pool : [...seat.pool, state.pending];
}

/** True while this client is waiting for the payload that confirms its pick. */
export function isAwaitingConfirmation(state: TableState): boolean {
  return state.pending !== null;
}

/** Whether a pick is legal from this client's point of view. */
export function pickBlockedBy(state: TableState): PickRejection | null {
  const seat = viewerSeat(state.view);
  if (!seat) return { reason: 'spectator' };
  if (state.pending !== null) return { reason: 'already-picked', cardId: state.pending.cardId };
  if (!state.view.waitingOn.includes(seat.seatId)) {
    return { reason: 'not-your-turn', seatId: seat.seatId };
  }
  return null;
}

/**
 * Take a card. Returns a rejection as a value — a misclick is not an exception,
 * and the engine's contract says the same thing about the wire.
 */
export function pick(state: TableState, cardId: string): PickResult {
  const blocked = pickBlockedBy(state);
  if (blocked) return { ok: false, rejection: blocked };

  const seat = viewerSeat(state.view);
  const card = seat?.pack.find((c) => c.cardId === cardId);
  if (!card) return { ok: false, rejection: { reason: 'not-in-pack', cardId } };

  return { ok: true, state: { view: state.view, pending: card } };
}

/**
 * Adopt a newer authoritative payload, dropping any pending pick.
 *
 * A payload with a `seq` at or below the current one is stale — a reorder or a
 * replay — and is ignored rather than applied backwards. A *gap* is not
 * detectable from one payload and is the resync contract's problem, not this
 * function's; it is called out here so the next reader does not assume this
 * covers it.
 */
export function applyPayload(state: TableState, next: DraftView): TableState {
  if (next.draftId !== state.view.draftId) return { view: next, pending: null };
  if (next.seq <= state.view.seq) return state;
  return { view: next, pending: null };
}

/** A human-readable reason, for the status line. */
export function explainRejection(rejection: PickRejection): string {
  switch (rejection.reason) {
    case 'spectator':
      return 'Spectators do not pick.';
    case 'not-your-turn':
      return `Seat ${rejection.seatId} has already picked this pack.`;
    case 'already-picked':
      return 'That pick is still in flight.';
    case 'not-in-pack':
      return 'That card is not in this pack.';
  }
}
