/*
 * A Gauntlet deck as the room's deck tile reads it (`DeckOption`): its list by name, its colours
 * as the server folded them, its art by the room's own rule over the same committed tables, and
 * no two of the ten tiles showing the same card (`assignDeckArt`).
 */
import type { GauntletDeck } from '@hadoku/shared';
import { LIBRARY_DECK_STYLES } from '@hadoku/deck/library';

import { libraryDeckArt, libraryPeekList, type DeckOption } from '../ConstructedScreen.tsx';
import { assignDeckArt } from '../deckArt.ts';

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
    art: libraryDeckArt(list),
  };
}

/** The ten decks' tiles, by deck id. */
export function gauntletDeckOptions(decks: readonly GauntletDeck[]): ReadonlyMap<string, DeckOption> {
  const options = decks.map(gauntletDeckOption);
  const artIds = assignDeckArt(options.map((o) => o.art ?? []));
  return new Map(options.map((o, i) => [o.value, { ...o, artId: artIds[i] }]));
}
