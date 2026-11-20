/*
 * Cards that let one seat see something hidden. What a seat is shown goes
 * through `show` and reaches that seat's own payload and nobody else's.
 *
 * Cogwork Spy (cardsfolder/c/cogwork_spy.txt): "Reveal CARDNAME as you draft
 * it. You may look at the next card drafted from this booster pack."
 *
 * Spire Phantasm (cardsfolder/s/spire_phantasm.txt): "Reveal CARDNAME as you
 * draft it. The next time a player drafts a card from this booster pack,
 * guess that card's name. Then that player reveals the drafted card." The
 * guess is asked as the Phantasm is drafted, among the cards its drafter just
 * passed on: by the time the next card is drafted the pack is no longer in
 * front of them. The pack does not wait for the guess, so a card drafted from
 * it first is kept with the question, unseen, and revealed once the guess is in.
 *
 * Illusionary Informant (cardsfolder/i/illusionary_informant.txt): "Draft
 * CARDNAME face up. During the draft, you may turn CARDNAME face down. If you
 * do, look at the next card drafted by a player of your choice."
 *
 * Whispergear Sneak (cardsfolder/w/whispergear_sneak.txt): "Draft CARDNAME
 * face up. During the draft, you may turn CARDNAME face down. If you do, look
 * at any unopened booster pack in the draft or any booster pack not being
 * looked at by another player." The packs it may look at are each seat's
 * unopened pack of every later round and each opened pack waiting behind the
 * one a seat is picking from; the pack at the head of a seat's queue is being
 * looked at.
 */

import type { SeatId } from '@wolffm/rooms-protocol';
import type { DraftCard } from '@hadoku/shared';
import { addEffect, ask, effectsOf, endEffect, markPack, note, say, seatName, show, takeMarks, turnFaceDown, type Draft, type Family } from './kit.ts';

const SPY = 'Cogwork Spy';
const PHANTASM = 'Spire Phantasm';
const INFORMANT = 'Illusionary Informant';
const SNEAK = 'Whispergear Sneak';

/** The drafted card is revealed to the table; a right guess is noted for the guesser, as the Phantasm reads it in a match. */
function revealGuessed(d: Draft, guesser: SeatId, guess: string, card: DraftCard, by: SeatId): void {
  const right = card.name === guess;
  say(d, by, 'revealed', { cards: [card], detail: right ? `as ${seatName(d, guesser)} guessed` : `(${seatName(d, guesser)} guessed ${guess})` });
  if (right) note(d, guesser, PHANTASM, guess);
}

/** A pack the Sneak may look at: where its cards are, and how its button and its line read. */
interface Peekable {
  key: string;
  label: string;
  group: string;
  detail: string;
  cards: DraftCard[];
}

function peekable(d: Draft): Peekable[] {
  const out: Peekable[] = [];
  for (let s = 0; s < d.seatCount; s++) {
    const name = seatName(d, s);
    // Opened and waiting behind the pack the seat is picking from.
    (d.queues[s] ?? []).forEach((cards, i) => {
      const id = d.packMeta[s]?.[i]?.id;
      if (i === 0 || id === undefined || cards.length === 0) return;
      out.push({ key: `pack:${id}`, label: `Waiting ${i}`, group: name, detail: `waiting for ${name}`, cards });
    });
    // Not yet opened: the rounds after this one.
    for (let r = d.packNumber; r < d.rounds.length; r++) {
      const cards = d.rounds[r]?.[s] ?? [];
      if (cards.length === 0) continue;
      out.push({ key: `round:${r}:${s}`, label: `Pack ${r + 1}`, group: name, detail: `in ${name}'s pack ${r + 1}`, cards });
    }
  }
  return out;
}

export const peeks: Family = {
  cards: {
    [SPY]: {
      reveal: true,
      drafted: (d, e) => {
        if (e.rest.length > 0) markPack(d, { packId: e.packId, kind: 'spy', seat: e.seat });
      },
    },

    [PHANTASM]: {
      reveal: true,
      drafted: (d, e) => {
        // One choice a name: the guess is a name, and a pack may hold a name twice.
        const names = e.rest.filter((c, i) => e.rest.findIndex((o) => o.name === c.name) === i);
        const first = names[0];
        if (first === undefined) return;
        const asked = ask(d, { seatId: e.seat, source: PHANTASM, title: 'Guess the next card drafted from this pack', cards: names, fallback: first.cardId });
        markPack(d, { packId: e.packId, kind: 'phantasm', seat: e.seat, data: { askId: asked.id } });
      },
      answered: (d, a, choice) => {
        const guess = a.cards?.find((c) => c.cardId === choice)?.name;
        if (guess === undefined) return;
        const drafted = a.data?.drafted as { card: DraftCard; by: SeatId } | undefined;
        if (drafted !== undefined) {
          revealGuessed(d, a.seatId, guess, drafted.card, drafted.by);
          return;
        }
        const mark = d.packMarks.find((m) => m.kind === 'phantasm' && m.data?.askId === a.id);
        if (mark !== undefined) mark.data = { guess };
      },
    },

    [INFORMANT]: {
      faceUp: true,
      nowUse: {
        usable: (d) => d.seatCount > 1,
        targets: (d, seat) => Array.from({ length: d.seatCount }, (_, s) => s).filter((s) => s !== seat).map((s) => ({ key: String(s), label: seatName(d, s) })),
        apply: (d, e) => {
          turnFaceDown(d, e.seat, e.holder);
          addEffect(d, e.seat, { kind: 'informant', source: INFORMANT, data: { target: Number(e.target) } });
        },
      },
    },

    [SNEAK]: {
      faceUp: true,
      nowUse: {
        usable: (d) => peekable(d).length > 0,
        targets: (d) => peekable(d).map(({ key, label, group }) => ({ key, label, group })),
        apply: (d, e) => {
          const pack = peekable(d).find((p) => p.key === e.target);
          if (pack === undefined) return 'no such pack to look at';
          turnFaceDown(d, e.seat, e.holder);
          show(d, e.seat, SNEAK, pack.cards.slice(), pack.detail);
        },
      },
    },
  },

  hooks: {
    picked: (d, e) => {
      const by = `drafted by ${seatName(d, e.seat)}`;
      for (const mark of takeMarks(d, e.packId, 'spy')) show(d, mark.seat, SPY, [e.card], by);
      for (const mark of takeMarks(d, e.packId, 'phantasm')) {
        const open = d.asks.find((a) => a.id === mark.data?.askId);
        if (open !== undefined) open.data = { drafted: { card: e.card, by: e.seat } };
        else if (typeof mark.data?.guess === 'string') revealGuessed(d, mark.seat, mark.data.guess, e.card, e.seat);
      }
      for (let s = 0; s < d.seatCount; s++) {
        for (const effect of effectsOf(d, s, 'informant')) {
          if (effect.data?.target !== e.seat) continue;
          show(d, s, INFORMANT, [e.card], by);
          endEffect(d, s, effect);
        }
      }
    },
  },
};
