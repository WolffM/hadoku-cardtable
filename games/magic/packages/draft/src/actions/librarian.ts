/*
 * Cogwork Librarian (cardsfolder/c/cogwork_librarian.txt): "Draft CARDNAME
 * face up. As you draft a card, you may draft an additional card from that
 * booster pack. If you do, put CARDNAME into that booster pack."
 */

import { leavePool, say, type Family } from './kit.ts';

export const librarian: Family = {
  cards: {
    'Cogwork Librarian': {
      faceUp: true,
      pickUse: {
        extra: true,
        // Two cards to take: the pick and the second.
        usable: (d, seat) => (d.queues[seat]?.[0]?.length ?? 0) >= 2,
        apply: (d, e) => {
          if (e.extra === undefined) return 'no second card named';
          if (!e.rest.includes(e.extra)) return 'the second card went to another use';
          e.rest.splice(e.rest.indexOf(e.extra), 1);
          e.taken.push(e.extra);
          leavePool(d, e.seat, e.holder);
          e.rest.push(e.holder);
          say(d, e.seat, 'put into the pack', { cards: [e.holder] });
        },
      },
    },
  },
};
