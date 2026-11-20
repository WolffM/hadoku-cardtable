/*
 * The cards that change where a pack goes and what a seat may see of it.
 *
 * Canal Dredger (cardsfolder/c/canal_dredger.txt): "Draft CARDNAME face up.
 * Each player passes the last card from each booster pack to a player who
 * drafted a card named CARDNAME."
 *
 * "A player who drafted" is a fact about what the seat did, so it is kept on
 * the seat (a `SeatEffect`) and holds for the rest of the draft, whether the
 * Dredger is later turned face down or leaves the pool. With several such
 * seats the passer chooses: a seat that drafted one keeps the card, as Forge
 * has it (`BoosterDraft.java`'s `passPacks`), and any other seat is asked.
 * While it is asked the card is in front of nobody; the ask holds it.
 *
 * Archdemon of Paliano (cardsfolder/a/archdemon_of_paliano.txt): "Draft
 * CARDNAME face up. As long as CARDNAME is face up during the draft, you
 * can't look at booster packs and must draft cards at random. After you draft
 * three cards this way, turn CARDNAME face down. (You may look at cards as
 * you draft them.)"
 *
 * Each Archdemon counts its own three, and a card drafted at random counts
 * for every Archdemon face up in front of the seat (the card's own ruling:
 * "Each card you draft at random counts toward the demands of all your
 * Archdemons").
 */

import type { SeatId } from '@wolffm/rooms-protocol';
import type { DraftCard } from '@hadoku/shared';
import { addEffect, ask, effectsOf, endEffect, isFaceUp, putPackLast, receiver, say, seatName, turnFaceDown, type Draft, type Family, type SeatEffect } from './kit.ts';

const DREDGER = 'Canal Dredger';
const ARCHDEMON = 'Archdemon of Paliano';

/** The seats that drafted a Canal Dredger, in seat order. */
function dredgers(d: Draft): SeatId[] {
  return Array.from({ length: d.seatCount }, (_, s) => s).filter((s) => effectsOf(d, s, 'drafted-dredger').length > 0);
}

/** The first of `seats` a pack leaving `from` would reach, the way packs are passing. */
function nearest(d: Draft, from: SeatId, seats: readonly SeatId[]): SeatId {
  let at = from;
  for (let n = 0; n < d.seatCount; n++) {
    at = receiver(d, at);
    if (seats.includes(at)) return at;
  }
  return from;
}

function sayLastCard(d: Draft, from: SeatId, to: SeatId): void {
  if (to === from) say(d, from, 'kept the last card');
  else say(d, from, 'passed the last card to', { detail: seatName(d, to) });
}

/** The Archdemons face up in front of a seat, each with the cards it still demands (`n`). */
function demands(d: Draft, seat: SeatId): SeatEffect[] {
  return effectsOf(d, seat, 'archdemon').filter((e) => isFaceUp(d, seat, e.data?.cardId as string));
}

export const flow: Family = {
  cards: {
    [DREDGER]: {
      faceUp: true,
      drafted: (d, e) => addEffect(d, e.seat, { kind: 'drafted-dredger', source: DREDGER }),
      answered: (d, a, choice) => {
        const to = Number(choice);
        putPackLast(d, to, a.data?.cards as DraftCard[], a.seatId, a.data?.packId as number);
        sayLastCard(d, a.seatId, to);
      },
    },
    [ARCHDEMON]: {
      faceUp: true,
      // Added after the pick that drafted it is counted: the Archdemon itself is not one of its three.
      drafted: (d, e) => addEffect(d, e.seat, { kind: 'archdemon', source: ARCHDEMON, n: 3, data: { cardId: e.card.cardId } }),
    },
  },
  hooks: {
    passTo: (d, from, rest, _to, packId) => {
      if (rest.length !== 1) return undefined;
      const seats = dredgers(d);
      if (seats.length === 0) return undefined;
      const to = seats.length === 1 ? seats[0]! : seats.includes(from) ? from : undefined;
      if (to !== undefined) {
        sayLastCard(d, from, to);
        return to;
      }
      // The question names seats, never the card: a seat drafting at random has not seen it.
      ask(d, {
        seatId: from,
        source: DREDGER,
        title: 'Pass the last card to',
        options: seats.map((s) => ({ key: String(s), label: seatName(d, s) })),
        fallback: String(nearest(d, from, seats)),
        data: { cards: rest.splice(0), packId },
      });
      return undefined;
    },
    blind: (d, seat) => demands(d, seat).length > 0,
    picked: (d, e) => {
      for (const demand of effectsOf(d, e.seat, 'archdemon')) {
        const held = (d.pools[e.seat] ?? []).find((c) => c.cardId === demand.data?.cardId);
        // Turned face down or taken away by another card: it demands nothing more.
        if (held === undefined || !isFaceUp(d, e.seat, held.cardId)) {
          endEffect(d, e.seat, demand);
          continue;
        }
        demand.n = (demand.n ?? 0) - 1;
        if (demand.n > 0) continue;
        turnFaceDown(d, e.seat, held);
        endEffect(d, e.seat, demand);
      }
    },
  },
};
