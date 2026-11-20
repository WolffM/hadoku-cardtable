/*
 * The cards that only reveal themselves and note something for the match.
 *
 * Custodi Peacekeeper, Garbage Fire, Lurking Automaton and Pyretic Hunter
 * (cardsfolder/c/custodi_peacekeeper.txt and its three peers): "Reveal
 * CARDNAME as you draft it. Note how many cards you've drafted this draft
 * round, including CARDNAME." Cards, not picks: a pick that took two counts
 * two (`DraftState.roundCards`).
 *
 * Cogwork Tracker (cardsfolder/c/cogwork_tracker.txt): "Reveal CARDNAME as you
 * draft it. Note the player who passed CARDNAME to you." A pack its drafter
 * opened was passed by nobody, so there is nothing to note.
 *
 * Aether Searcher (cardsfolder/a/aether_searcher.txt): "Reveal CARDNAME as you
 * draft it. Reveal the next card you draft and note its name." Each Searcher
 * waits on its seat for the next card to reach the seat's pool, whichever
 * pick or round brings it.
 */

import { addEffect, effectsOf, endEffect, note, say, seatName, type CardActions, type Family } from './kit.ts';

const SEARCHER = 'Aether Searcher';
/** A Searcher waiting on its seat for the next card that seat drafts. */
const AWAITING_NEXT = 'searcher-next';

/** "Note how many cards you've drafted this draft round, including CARDNAME." */
const countsRound: CardActions = {
  reveal: true,
  drafted: (d, e) => {
    const count = String(d.roundCards[e.seat] ?? 0);
    note(d, e.seat, e.card.name, count);
    say(d, e.seat, 'noted', { cards: [e.card], detail: count });
  },
};

export const noters: Family = {
  cards: {
    'Custodi Peacekeeper': countsRound,
    'Garbage Fire': countsRound,
    'Lurking Automaton': countsRound,
    'Pyretic Hunter': countsRound,
    'Cogwork Tracker': {
      reveal: true,
      drafted: (d, e) => {
        if (e.from === null) return;
        note(d, e.seat, e.card.name, String(e.from));
        say(d, e.seat, 'noted', { cards: [e.card], detail: seatName(d, e.from) });
      },
    },
    [SEARCHER]: { reveal: true },
  },
  hooks: {
    // The cards of one pick in the order they were taken: a Searcher taken first waits for the second.
    picked: (d, e) => {
      for (const card of e.taken) {
        for (const waiting of effectsOf(d, e.seat, AWAITING_NEXT)) {
          endEffect(d, e.seat, waiting);
          note(d, e.seat, SEARCHER, card.name);
          say(d, e.seat, 'revealed and noted', { cards: [card], detail: `for ${SEARCHER}` });
        }
        if (card.name === SEARCHER) addEffect(d, e.seat, { kind: AWAITING_NEXT, source: SEARCHER });
      }
    },
  },
};
