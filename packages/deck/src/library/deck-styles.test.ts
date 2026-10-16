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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('the library style map a browser is handed', () => {
  it('gives every catalogued deck one of the four styles', () => {
    const styles = new Set(['aggro', 'midrange', 'control', 'combo']);
    const unstyled = LIBRARY.flatMap((c) => c.decks)
      .map((d) => d.id)
      .filter((id) => !styles.has(LIBRARY_DECK_STYLES[id] ?? ''));
    expect(unstyled).toEqual([]);
  });

  it('is exactly what build-deck-styles.ts would write now', () => {
    expect(deckStylesModule(libraryDeckStyles())).toBe(
      readFileSync(join(REPO_ROOT, 'packages/deck/src/library/deck-styles.generated.ts'), 'utf8'),
    );
  });
});
