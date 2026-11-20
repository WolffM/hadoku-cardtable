/*
 * Lore Seeker (cardsfolder/l/lore_seeker.txt): "Reveal CARDNAME as you draft
 * it. After you draft CARDNAME, you may add a booster pack to the draft.
 * (Your next pick is from that booster pack. Pass it to the next player and
 * it's drafted this draft round.)"
 *
 * The pack added is one the draft dealt and never opened (`DraftState.spares`,
 * the round's own source), so with none left there is nothing to ask.
 */

import { ask, putPackFirst, say, YES_NO, type Family } from './kit.ts';

export const loreSeeker: Family = {
  cards: {
    'Lore Seeker': {
      reveal: true,
      drafted: (d, e) => {
        const key = d.roundSources[d.packNumber - 1];
        if (key === undefined || key === null || (d.spares[key]?.length ?? 0) === 0) return;
        ask(d, { seatId: e.seat, source: 'Lore Seeker', title: 'Add a booster pack to the draft?', options: YES_NO, fallback: 'no', data: { key } });
      },
      answered: (d, a, choice) => {
        if (choice !== 'yes') return;
        const pack = d.spares[a.data?.key as string]?.shift();
        if (pack === undefined) return;
        putPackFirst(d, a.seatId, pack);
        say(d, a.seatId, 'added a booster pack to the draft');
      },
    },
  },
};
