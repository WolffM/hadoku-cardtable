/*
 * The style map the deck picker tags library decks with, checked against the
 * selections it came from.
 *
 * Like the cost map, `deck-styles.generated.ts` is a second copy of a fact
 * whose home is elsewhere (the `style` on each `chosen` entry of
 * `docs/planning/deck-selection/selections/`), so it is re-derived here on
 * every run and compared as text: a library era catalogued without
 * re-running `build-deck-styles.ts` is red, as is one whose selection gave a
 * deck no style.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { deckStylesModule, libraryDeckStyles } from './build-deck-styles.ts';
import { LIBRARY } from './catalog.ts';
import { LIBRARY_DECK_STYLES } from './deck-styles.generated.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');

describe('the library style map a browser is handed', () => {
  it('gives every selection deck one of the four styles', () => {
    // A style is the SELECTION's verdict (`select_decks.py`'s classify), and a
    // tournament import has no selection — its decks carry no style and the
    // picker's tag draws nothing (`DeckStyleTag.tsx`: "a deck with none ...
    // draws no tag rather than a guess"). The class boundary is the
    // collection's own id, the same `tournament-` prefix `library.test.ts`
    // reads.
    const styles = new Set(['aggro', 'midrange', 'control', 'combo']);
    const unstyled = LIBRARY.flatMap((c) =>
      c.id.startsWith('tournament-') ? [] : c.decks,
    )
      .map((d) => d.id)
      .filter((id) => !styles.has(LIBRARY_DECK_STYLES[id] ?? ''));
    expect(unstyled).toEqual([]);
    // And a tournament deck must never sneak one in: its style would be a
    // classification nobody made.
    const tournamentStyled = LIBRARY.flatMap((c) =>
      c.id.startsWith('tournament-') ? c.decks : [],
    ).filter((d) => LIBRARY_DECK_STYLES[d.id] !== undefined);
    expect(tournamentStyled).toEqual([]);
  });

  it('is exactly what build-deck-styles.ts would write now', () => {
    expect(deckStylesModule(libraryDeckStyles())).toBe(
      readFileSync(join(REPO_ROOT, 'games/magic/packages/deck/src/library/deck-styles.generated.ts'), 'utf8'),
    );
  });
});
