/*
 * The deck grid's change of list: the old tiles fade out, and the new ones arrive once their art can
 * be drawn. The operator, 2026-10-30: *"while flipping through the decks they sort of pop into
 * existence … how do we smoothen the switching between each list?"*
 *
 * A switch is a change of `swapKey` (an era, a format tab), not of the list: a filter typed into the
 * grid's search narrows the tiles in place, with no fade per keystroke. On a switch the tiles last
 * drawn stay on as `leaving` (CSS fades them; they carry no deck id, so nothing can choose one) for
 * {@link FADE_MS}, while the new list's first {@link ART_FIRST} art faces load and decode through
 * `artReady`, the face rule the board's own cards keep. The new tiles draw when both are done, or
 * when {@link ART_WAIT_MS} has passed, whichever is first: a slow CDN costs the grid a wait, never an
 * empty grid. A tile further down still draws no art before it decodes (`DeckArt`).
 *
 * The first list is the same wait with nothing to fade: the skeleton holds until the art is ready.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { artistsReady } from '../draft/artists.ts';
import { artReady, cardImageUrl } from '../draft/cardImage.ts';
import { prefersReducedMotion } from '../play/motion.ts';

/** How long the old tiles take to fade (`.deckpick__option--leaving` in `screens.css`). */
export const FADE_MS = 180;
/** How many of the new list's faces must decode before it draws: about two screens of tiles. */
export const ART_FIRST = 24;
/** The longest the new list waits for those faces. */
export const ART_WAIT_MS = 1500;

interface Swap<T> {
  /** The list this state is for. */
  key: string;
  /** The tiles of the list before, fading out; empty once they have. */
  leaving: readonly T[];
}

export interface DeckSwap<T> {
  /** The tiles to draw as the grid's own: none until the list may draw. */
  shown: readonly T[];
  /** The last list's tiles, fading out. */
  leaving: readonly T[];
  /** The new list is still on its way in: neither its tiles nor the old ones are drawn. */
  waiting: boolean;
}

/**
 * Which tiles the grid draws for `options` under `swapKey`. `pending` is the list not being known
 * yet (the pool has not answered), which keeps the wait open whatever `options` holds.
 */
export function useDeckSwap<T extends { value: string; artId?: string | undefined }>(
  options: readonly T[],
  swapKey: string,
  pending: boolean,
): DeckSwap<T> {
  const [swap, setSwap] = useState<Swap<T>>({ key: swapKey, leaving: [] });
  /** The key whose list has its art ready, so it may draw. */
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const current = swap.key === swapKey;
  const settled = current && readyFor === swapKey && swap.leaving.length === 0;
  const shown = settled ? options : [];

  /** What the grid has on screen, for the next switch to fade out. */
  const drawn = useRef<readonly T[]>([]);
  useLayoutEffect(() => {
    if (current) drawn.current = settled ? options : swap.leaving;
  });

  // Before paint, so the new key's first frame is the old tiles leaving, never a blank or a pop.
  useLayoutEffect(() => {
    if (swap.key === swapKey) return;
    setSwap({ key: swapKey, leaving: prefersReducedMotion() ? [] : drawn.current });
    setReadyFor(null);
  }, [swap.key, swapKey]);

  const fading = swap.leaving.length > 0;
  useEffect(() => {
    if (!fading) return;
    const key = swap.key;
    const timer = setTimeout(() => setSwap((s) => (s.key === key ? { key, leaving: [] } : s)), FADE_MS);
    return () => clearTimeout(timer);
  }, [fading, swap.key]);

  // The faces that must decode first, as one string: a list that reorders under the same key (win
  // rates landing) does not restart the wait.
  const faces = options
    .slice(0, ART_FIRST)
    .flatMap((o) => {
      const url = o.artId === undefined ? null : cardImageUrl(o.artId);
      return url === null ? [] : [url];
    })
    .join('\n');
  useEffect(() => {
    if (pending || readyFor === swapKey || !current) return;
    const urls = faces === '' ? [] : faces.split('\n');
    if (urls.length === 0) {
      setReadyFor(swapKey);
      return;
    }
    let live = true;
    let left = urls.length + 1;
    const one = (): void => {
      left -= 1;
      if (live && left === 0) setReadyFor(swapKey);
    };
    // The credit is part of the face (`DeckArt` draws no art it cannot credit).
    if (artistsReady(one)) one();
    for (const url of urls) if (artReady(url, one)) one();
    const cap = setTimeout(() => {
      if (live) setReadyFor(swapKey);
    }, ART_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(cap);
    };
  }, [pending, faces, swapKey, current, readyFor]);

  return { shown, leaving: current ? swap.leaving : [], waiting: !settled && !(current && fading) };
}
