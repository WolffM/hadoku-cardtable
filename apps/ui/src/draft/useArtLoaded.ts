/*
 * Whether every one of a set of cards' art can be drawn on the first frame: each image fetched and
 * decoded (`artReady` — a failed one counts, its tile then draws its text). A screen that shows a
 * whole set at once waits on this and draws the set blank until then, rather than letting each
 * picture flash in as it lands (the operator, 2026-10-23: "instead of showing the new cards
 * immediately, can we wait for the art to load? … it looks a bit ugly to see the art flash in").
 */
import { useEffect, useState } from 'react';

import { artReady, cardImageUrl } from './cardImage.ts';

/** How long a set waits on art that has not come: a stalled image must not hold the set blank for good. */
export const ART_WAIT_MS = 5000;

/** `scryfallIds`: the set's cards (`undefined` for one with no art). `null` is "not known yet", never loaded. */
export function useArtLoaded(scryfallIds: readonly (string | undefined)[] | null): boolean {
  const key = scryfallIds === null ? null : scryfallIds.filter((id) => id !== undefined).join(',');
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const ids = key === '' ? [] : key.split(',');
    let left = 0;
    const one = (): void => {
      left -= 1;
      if (left === 0 && live) setLoaded(key);
    };
    for (const id of ids) if (!artReady(cardImageUrl(id), one)) left += 1;
    if (left === 0) setLoaded(key);
    const cap = setTimeout(() => live && setLoaded(key), ART_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(cap);
    };
  }, [key]);
  return key !== null && loaded === key;
}
