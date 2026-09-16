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

import { asSeqCursor, cursorOf } from '@hadoku/shared';
import { classifySeq, needsResync, type SeqVerdict } from '@wolffm/rooms-protocol';

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
 * What the table decided to do with an inbound payload.
 *
 * A verdict rather than a bare state, because three of the four answers need
 * the CALLER to do something the table cannot do for itself: a gap and an epoch
 * change both need a full snapshot fetched, and only whatever owns the
 * transport can ask for one.
 */
export type PayloadVerdict = SeqVerdict | 'other-draft';

export interface PayloadDecision {
  verdict: PayloadVerdict;
  /** What to render next. Referentially the SAME object when nothing applied. */
  state: TableState;
  /** Whether `state` is a new view. False means the payload was dropped. */
  applied: boolean;
  /** Whether the caller must now ask the server for a full snapshot. */
  resync: boolean;
}

/**
 * Classify an authoritative payload against what the table is showing, and say
 * what to do about it.
 *
 * ## Why this is not a `seq` comparison, which is what it used to be
 *
 * The first cut read:
 *
 *     if (next.seq <= state.view.seq) return state;
 *
 * That is the epoch-blind bug `@wolffm/rooms-protocol`'s `resync.d.ts` was
 * written about, sitting in the UI. A server restart keeps the draft id and
 * starts `seq` again from 1, so a table holding seq 20 would read every payload
 * of the new incarnation as stale and sit there discarding live events for the
 * rest of the draft — a screen that is frozen while the server is perfectly
 * healthy. Our own P6 requirement ("a 45-minute draft survives a server
 * restart") is exactly the case it got wrong.
 *
 * `classifySeq` compares the epoch FIRST and never does arithmetic across two
 * of them, which is the whole reason the envelope carries one
 * (`@hadoku/shared`'s `draft.ts` header).
 *
 * ## The four answers, and why `duplicate` and `gap` differ
 *
 *  - `ok` — the next payload. Adopt it and drop any pending pick.
 *  - `duplicate` — already seen. Drop it, and ask for NOTHING. Retransmits
 *    arrive in bursts and a client that resynced on "anything that isn't ok"
 *    answers a burst with a request storm. `needsResync` is what gets this
 *    right; `verdict !== 'ok'` is the bug it exists to prevent, and it is not
 *    spelled that way here either.
 *  - `gap` — payloads were missed, so this one cannot be applied on top of what
 *    we have: the pack it describes is several picks ahead of the pool we hold.
 *    Drop it and resync. This matches `socket.ts`'s driver exactly, on purpose
 *    — two components that disagree about a gap is how a pool goes wrong.
 *  - `epoch-change` — a different incarnation. Everything local is about a
 *    draft that no longer exists, so the new payload is adopted (it is the only
 *    truthful thing on hand) AND a refetch is asked for.
 *
 * A payload for a DIFFERENT DRAFT is not a sequencing question at all — the
 * cursors are not comparable — so it short-circuits and switches outright.
 */
export function decidePayload(state: TableState, next: DraftView): PayloadDecision {
  if (next.draftId !== state.view.draftId) {
    return {
      verdict: 'other-draft',
      state: { view: next, pending: null },
      applied: true,
      resync: false,
    };
  }

  const verdict = classifySeq(asSeqCursor(cursorOf(state.view)), asSeqCursor(cursorOf(next)));
  const resync = needsResync(verdict);
  const adopt = verdict === 'ok' || verdict === 'epoch-change';

  return {
    verdict,
    state: adopt ? { view: next, pending: null } : state,
    applied: adopt,
    resync,
  };
}

/**
 * Adopt a newer authoritative payload, dropping any pending pick.
 *
 * The state half of `decidePayload`, kept because callers that have no
 * transport to resync over — the fixture stream — genuinely have nothing to do
 * with the verdict. Anything holding a socket should call `decidePayload` and
 * act on `resync`.
 */
export function applyPayload(state: TableState, next: DraftView): TableState {
  return decidePayload(state, next).state;
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

/**
 * Whether this seat has taken every pick the draft has.
 *
 * Derived, not carried: the envelope describes a draft's position, and a seat
 * holding `packCount * packSize` cards — 3 × 15 = 45 for a standard pod — has
 * nothing left to take. Identical to `socket.ts`'s `isComplete`, deliberately:
 * the screen must reach the same conclusion as the driver, and a second rule
 * would be a second answer.
 *
 * The PENDING pick counts. A player who has just clicked their forty-fifth card
 * is done from the screen's point of view, and making them wait for the payload
 * to say so would put the deck behind one more round trip at the only moment it
 * matters.
 *
 * A spectator is never complete — they have no pool and no picks.
 */
export function isDraftComplete(state: TableState): boolean {
  const seat = viewerSeat(state.view);
  if (!seat) return false;
  return visiblePool(state).length >= state.view.packCount * state.view.packSize;
}
