/*
 * The cards drafted face up and used with a later pick. Each is "Draft
 * CARDNAME face up." and then (cardsfolder/<letter>/<name>.txt):
 *
 * - Leovold's Operative: "As you draft a card, you may draft an additional
 *   card from that booster pack. If you do, turn CARDNAME face down, then pass
 *   the next booster pack without drafting a card from it. (You may look at
 *   that booster pack.)"
 * - Agent of Acquisitions: "Instead of drafting a card from a booster pack,
 *   you may draft each card in that booster pack, one at a time. If you do,
 *   turn CARDNAME face down and you can't draft cards for the rest of this
 *   draft round. (You may look at booster packs passed to you.)"
 * - Cogwork Grinder: "As you draft a card, you may remove it from the draft
 *   face down. (Those cards aren't in your card pool.)"
 * - Animus of Predation: "As you draft a card, you may remove it from the
 *   draft face up. (It isn't in your card pool.)"
 * - Noble Banneret: "As you draft a creature card, you may reveal it, note its
 *   name, then turn CARDNAME face down."
 * - Paliano Vanguard: "As you draft a creature card, you may reveal it, note
 *   its creature types, then turn CARDNAME face down."
 * - Smuggler Captain: "As you draft a card, you may reveal it, note its name,
 *   then turn CARDNAME face down."
 *
 * ## Several used with one pick
 *
 * "The card you draft" is the card pressed, for every use of that pick.
 *
 * - One card is removed once, and a removed card is not revealed for a note:
 *   two removers, or a remover and a noter, are refused.
 * - A second card serves one use: two Operatives, or an Operative and a
 *   Librarian, are refused (the second finds its card gone).
 * - The Agent takes the whole pack, so it is refused with a second card named,
 *   and two Agents on one pack are refused.
 * - Everything else goes together. Several noters each note the one revealed
 *   card. A second card beside a remover or a noter: the pick is removed or
 *   noted and the second card is kept. The Agent beside a remover or a noter:
 *   the pressed card is removed or noted and the rest of the pack is taken.
 */

import type { DraftCard } from '@hadoku/shared';
import type { SeatId } from '@wolffm/rooms-protocol';
import { meetsNeed } from '@hadoku/shared';
import { creatureTypesOf, keywordsOf } from './card-text.ts';
import { addEffect, effectsOf, endEffect, note, say, show, turnFaceDown, type CardActions, type Draft, type Family, type PickUseEvent, type Refusal } from './kit.ts';

const OPERATIVE = "Leovold's Operative";
const AGENT = 'Agent of Acquisitions';
const GRINDER = 'Cogwork Grinder';
const ANIMUS = 'Animus of Predation';

/** The seat passes its next pack on whole (Leovold's Operative). */
const SKIP_NEXT = 'pass-next-pack';
/** The seat drafts nothing for the rest of the round in `data.round` (Agent of Acquisitions). */
const SKIP_ROUND = 'no-drafting-this-round';

const picking = (d: Draft, seat: SeatId): DraftCard[] => d.queues[seat]?.[0] ?? [];

/** Whether another card of one of these names is used with the same pick. */
const sharesPickWith = (e: PickUseEvent, names: readonly string[]): boolean => e.together.some((c) => c !== e.holder && names.includes(c.name));

const NOTERS: string[] = [];

/** The picked card leaves the draft: not the pool, not the pack. `told` tells the table. */
function remover(name: string, told: (d: Draft, e: PickUseEvent) => void, noted: (card: DraftCard) => string | undefined): CardActions {
  return {
    faceUp: true,
    pickUse: {
      usable: (d, seat) => picking(d, seat).length > 0,
      apply: (d, e): Refusal | void => {
        if (sharesPickWith(e, [GRINDER, ANIMUS])) return 'a card is removed once';
        if (sharesPickWith(e, NOTERS)) return 'a removed card is not revealed for a note';
        e.taken.splice(e.taken.indexOf(e.card), 1);
        told(d, e);
        const value = noted(e.card);
        if (value !== undefined) note(d, e.seat, name, value);
      },
    },
  };
}

/** The picked card is revealed to the table and still drafted; the holder notes `noted` of it and is turned face down. */
function noter(name: string, needs: 'creature' | undefined, noted: (card: DraftCard) => string[]): CardActions {
  NOTERS.push(name);
  return {
    faceUp: true,
    pickUse: {
      ...(needs === undefined ? {} : { needs }),
      usable: (d, seat) => picking(d, seat).some((c) => meetsNeed(c, needs)),
      apply: (d, e): Refusal | void => {
        if (sharesPickWith(e, [GRINDER, ANIMUS])) return 'a removed card is not revealed for a note';
        say(d, e.seat, 'revealed', { cards: [e.card], detail: `for ${name}` });
        for (const value of noted(e.card)) note(d, e.seat, name, value);
        turnFaceDown(d, e.seat, e.holder);
      },
    },
  };
}

export const pickUses: Family = {
  cards: {
    [OPERATIVE]: {
      faceUp: true,
      pickUse: {
        extra: true,
        usable: (d, seat) => picking(d, seat).length >= 2,
        apply: (d, e) => {
          if (e.extra === undefined) return 'no second card named';
          if (!e.rest.includes(e.extra)) return 'the second card went to another use';
          e.rest.splice(e.rest.indexOf(e.extra), 1);
          e.taken.push(e.extra);
          turnFaceDown(d, e.seat, e.holder);
          addEffect(d, e.seat, { kind: SKIP_NEXT, source: OPERATIVE });
        },
      },
    },
    [AGENT]: {
      faceUp: true,
      pickUse: {
        usable: (d, seat) => picking(d, seat).length > 0,
        apply: (d, e) => {
          if (e.extra !== undefined) return 'the whole pack is taken: no second card';
          if (sharesPickWith(e, [AGENT])) return 'one pack is taken once';
          e.taken.push(...e.rest.splice(0));
          turnFaceDown(d, e.seat, e.holder);
          addEffect(d, e.seat, { kind: SKIP_ROUND, source: AGENT, data: { round: d.packNumber } });
        },
      },
    },
    [GRINDER]: remover(
      GRINDER,
      (d, e) => say(d, e.seat, 'removed a card from the draft face down'),
      (card) => card.name,
    ),
    [ANIMUS]: remover(
      ANIMUS,
      (d, e) => say(d, e.seat, 'removed', { cards: [e.card], detail: 'from the draft' }),
      // One entry of the creature's keywords, as Forge's `LimitedPlayer.recordRemoveFromDraft` notes them.
      (card) => {
        const keywords = meetsNeed(card, 'creature') ? keywordsOf(card.oracleText) : [];
        return keywords.length === 0 ? undefined : keywords.join(',');
      },
    ),
    'Noble Banneret': noter('Noble Banneret', 'creature', (card) => [card.name]),
    'Paliano Vanguard': noter('Paliano Vanguard', 'creature', (card) => creatureTypesOf(card.typeLine)),
    'Smuggler Captain': noter('Smuggler Captain', undefined, (card) => [card.name]),
  },
  hooks: {
    skips: (d, seat) => effectsOf(d, seat, SKIP_NEXT).length > 0 || effectsOf(d, seat, SKIP_ROUND).some((e) => e.data?.round === d.packNumber),
    // The seat may look at a pack it passes on whole; the Operative's skip is one pack and is spent by it.
    skipped: (d, seat, pack) => {
      const next = effectsOf(d, seat, SKIP_NEXT)[0];
      const round = effectsOf(d, seat, SKIP_ROUND).find((e) => e.data?.round === d.packNumber);
      const by = next ?? round;
      if (by === undefined) return;
      show(d, seat, by.source, pack.slice());
      if (next !== undefined) endEffect(d, seat, next);
    },
    // A round's bar on drafting is over once its seat drafts again.
    picked: (d, e) => {
      for (const spent of effectsOf(d, e.seat, SKIP_ROUND).filter((x) => x.data?.round !== d.packNumber)) endEffect(d, e.seat, spent);
    },
  },
};
