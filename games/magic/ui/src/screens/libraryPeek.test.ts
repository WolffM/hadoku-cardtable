// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';
import { libraryFace, libraryPeekList, namedPeekLine } from './libraryPeek.ts';

/*
 * `libraryFace`/`namedPeekLine`/`libraryPeekList` used to read ONLY `LIBRARY_CARD_COSTS`
 * (the cost of every card a catalogued LIBRARY deck plays), which is right for a library deck but
 * leaves a drafted cube's own cards uncosted: measured on the operator's own pod (r-67759762d971,
 * deck hash 81aea98e4291), of the 41 distinct names in that drafted Abzan deck, only Qarsi Revenant
 * — which also happens to be in a catalogued precon — had an entry. These tests pin the generalised
 * signature: an optional `costs` map that, when given, is what a line's cost and colour fold off,
 * in place of the static table; omitted, the static table is unchanged (every other caller —
 * the room's deck chooser, the Gauntlet, a table card, the deck editor — passes nothing).
 */
describe('libraryFace, namedPeekLine, libraryPeekList: an optional per-deck cost map', () => {
  // Real names and costs off the operator's own pool (seat 1, pool index 1 of r-67759762d971's
  // draft record) — Dusyut Earthcarver has no `LIBRARY_CARD_COSTS` entry; Qarsi Revenant does.
  const DUSYUT = 'Dusyut Earthcarver';
  const DUSYUT_COST = '{5}{G}';
  const QARSI = 'Qarsi Revenant';

  it('a card with no entry in LIBRARY_CARD_COSTS reads no cost by default', () => {
    expect(LIBRARY_CARD_COSTS[DUSYUT]).toBeUndefined();
    const face = libraryFace({ name: DUSYUT });
    expect(face.manaCost).toEqual([]);
    expect(face.manaValue).toBe(0);
  });

  it('a costs map given for the name answers it instead of the static table', () => {
    const face = libraryFace({ name: DUSYUT }, { [DUSYUT]: DUSYUT_COST });
    expect(face.manaCost).toEqual(['5', 'G']);
    expect(face.manaValue).toBe(6);
  });

  it('LIBRARY_CARD_COSTS still answers a name in it when no override is given', () => {
    expect(libraryFace({ name: QARSI }).manaCost).toEqual(['1', 'B', 'B']);
  });

  it('namedPeekLine folds the same way, with the override', () => {
    const line = namedPeekLine({ name: DUSYUT, count: 1 }, { [DUSYUT]: DUSYUT_COST });
    expect(line.cost).toEqual(['5', 'G']);
    expect(line.manaValue).toBe(6);
  });

  it('libraryPeekList applies the override to main and sideboard alike', () => {
    const list = libraryPeekList([{ name: DUSYUT, count: 1 }], [{ name: QARSI, count: 1 }], { [DUSYUT]: DUSYUT_COST });
    expect(list.main[0]!.cost).toEqual(['5', 'G']);
    // QARSI is not in the override map, and the override REPLACES the static table rather than
    // merging with it (the caller's own merge decides that, as `own-deck.tsx`'s does from the wire).
    expect(list.sideboard[0]!.cost).toEqual([]);
  });

  it('with no override, libraryPeekList is exactly the old LIBRARY_CARD_COSTS behaviour', () => {
    const list = libraryPeekList([{ name: QARSI, count: 1 }], []);
    expect(list.main[0]!.cost).toEqual(['1', 'B', 'B']);
  });
});
