/*
 * The deck grid's change of list: the old tiles fade out, and the new ones arrive once their art can
 * be drawn. The operator, 2026-10-30: *"while flipping through the decks they sort of pop into
 * existence … how do we smoothen the switching between each list?"* — and on the first cut,
 * 2026-10-31: *"it looks a little janky? … i dont think it's loading cleanly."*
 *
 * A switch is a change of `swapKey` (an era, a format tab), not of the list: a filter typed into the
 * grid's search narrows the tiles in place, with no fade per keystroke. On a switch:
 *
 * 1. The boxes on screen stay, as the same elements, and their content fades out ({@link FADE_MS}).
 *    They carry no deck id once leaving, so nothing can choose one.
 * 2. If the new list is not ready when the fade ends, outlines drawn as the same boxes take their
 *    place: the grid never blanks, and never collapses and springs back under the page.
 * 3. The new list draws once its first screen of faces ({@link ART_FIRST}) has loaded and decoded
 *    through `artReady`, the face rule the board's own cards keep, and its content cascades into
 *    the boxes as one stagger: nothing in view arrives late. {@link ART_WAIT_MS} caps the wait for a
 *    CDN that never answers. A tile further down still draws no art before it decodes (`DeckArt`).
 *
 * The first list is the same wait with nothing to fade: the outlines hold until the art is ready.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { artistsReady } from '../draft/artists.ts';
import { artReady, cardImageUrl } from '../draft/cardImage.ts';
import { prefersReducedMotion } from '../play/motion.ts';

/** How long the old tiles take to fade (`.deckpick__option--leaving` in `screens.css`). */
export const FADE_MS = 180;
/** How many of the new list's faces must decode before it draws: the first screen of tiles and more. */
export const ART_FIRST = 24;
/** The longest the new list waits for those faces. */
export const ART_WAIT_MS = 4000;

interface Swap<T> {
  /** The list this state is for. */
  key: string;
  /** The tiles on screen when the switch came, fading out and then holding their space. */
  old: readonly T[];
  /** The list `old` was drawn for, so its tiles keep their elements while they leave. */
  oldKey: string;
  /** How many boxes the grid had when the switch came: the outlines draw this many. */
  hold: number;
}

export interface DeckSwap<T> {
  /** The tiles to draw as the grid's own: none until the list may draw. */
  shown: readonly T[];
  /** The last list's tiles, their content fading out of their boxes. */
  leaving: readonly T[];
  /** Which list `leaving` was drawn for (`DeckChooser` keys a tile by its list). */
  leavingKey: string;
  /** How many outlines to draw while the new list is on its way: 0 for none. */
  outlines: number;
  /** How many boxes the grid had before this list: a tile past them brings its box in too. */
  boxes: number;
}

/**
 * Which tiles the grid draws for `options` under `swapKey`. `pending` is the list not being known
 * yet (the pool has not answered), which keeps the wait open whatever `options` holds;
 * `pendingTiles` is how many outlines stand in for a list with no grid before it.
 */
export function useDeckSwap<T extends { value: string; artId?: string | undefined }>(
  options: readonly T[],
  swapKey: string,
  pending: boolean,
  pendingTiles: number,
): DeckSwap<T> {
  const [swap, setSwap] = useState<Swap<T>>({ key: swapKey, old: [], oldKey: '', hold: 0 });
  /** The key whose list has its art ready, so it may draw. */
  const [readyFor, setReadyFor] = useState<string | null>(null);
  /** The key whose old tiles have faded out. */
  const [faded, setFaded] = useState<string | null>(null);

  const current = swap.key === swapKey;
  const fadeDone = swap.old.length === 0 || faded === swapKey;
  const settled = current && readyFor === swapKey && fadeDone;
  const boxes = swap.hold > 0 ? swap.hold : pendingTiles;
  const outlines = current && !settled && fadeDone ? boxes : 0;
  const leaving = current && !fadeDone ? swap.old : [];
  const shown = settled ? options : [];

  /** What the grid has on screen, for the next switch to fade out. */
  const drawn = useRef<{ tiles: readonly T[]; key: string; count: number }>({ tiles: [], key: '', count: 0 });
  useLayoutEffect(() => {
    if (!current) return;
    drawn.current = settled
      ? { tiles: options, key: swapKey, count: options.length }
      : { tiles: leaving, key: swap.oldKey, count: leaving.length > 0 ? leaving.length : outlines };
  });

  // Before paint, so the new key's first frame is the old tiles leaving, never a blank or a pop.
  useLayoutEffect(() => {
    if (swap.key === swapKey) return;
    const was = drawn.current;
    setSwap({ key: swapKey, old: prefersReducedMotion() ? [] : was.tiles, oldKey: was.key, hold: was.count });
    setReadyFor(null);
    setFaded(null);
  }, [swap.key, swapKey]);

  const fading = current && swap.old.length > 0 && faded !== swapKey;
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFaded(swapKey), FADE_MS);
    return () => clearTimeout(timer);
  }, [fading, swapKey]);

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

  return { shown, leaving, leavingKey: swap.oldKey, outlines, boxes };
}
