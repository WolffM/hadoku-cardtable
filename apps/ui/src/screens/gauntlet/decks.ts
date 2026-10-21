/*
 * A Gauntlet deck as the room's deck tile reads it (`DeckOption`): its list by name, its colours
 * as the server folded them, its art by the room's own rule over the same committed tables, and
 * no two of the ten tiles showing the same card (`assignDeckArt`).
 */
import type { GauntletDeck } from '@hadoku/shared';
import { LIBRARY_CARD_COSTS, LIBRARY_DECK_STYLES } from '@hadoku/deck/library';

import deckArtTraits from '../../draft/deck-art-traits.json' with { type: 'json' };
import { libraryPeekList, manaValueOf, type DeckOption } from '../ConstructedScreen.tsx';
import { assignDeckArt, rankDeckArt } from '../deckArt.ts';

const ART_TRAITS: Readonly<Record<string, string>> = deckArtTraits.traits;

function gauntletDeckOption(d: GauntletDeck): DeckOption {
  const list = libraryPeekList(d.main, d.sideboard);
  const deckStyle = LIBRARY_DECK_STYLES[d.id];
  return {
    value: d.id,
    label: d.name,
    name: d.archetype,
    pilot: d.pilot,
    colors: d.colors,
    list,
    ...(deckStyle === undefined ? {} : { deckStyle }),
    art: rankDeckArt(
      list.main.flatMap((line) => {
        const cost = LIBRARY_CARD_COSTS[line.name];
        if (cost === undefined) return [];
        return [{ name: line.name, count: line.count, manaValue: manaValueOf(cost), traits: ART_TRAITS[line.name] ?? 'c', scryfallId: line.face.scryfallId }];
      }),
    ),
  };
}

/** The ten decks' tiles, by deck id. */
export function gauntletDeckOptions(decks: readonly GauntletDeck[]): ReadonlyMap<string, DeckOption> {
  const options = decks.map(gauntletDeckOption);
  const artIds = assignDeckArt(options.map((o) => o.art ?? []));
  return new Map(options.map((o, i) => [o.value, { ...o, artId: artIds[i] }]));
}
