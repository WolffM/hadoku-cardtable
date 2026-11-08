/*
 * The deck grid's change of list: the old decks crossfade straight into the new ones. The operator,
 * 2026-10-30: *"while flipping through the decks they sort of pop into existence … how do we smoothen
 * the switching between each list?"*; 2026-11-02, on the cut that faded the old tiles out and waited
 * under outlines: *"when a new year is selected, there's a brief flash where all cards turn to black
 * twice"*.
 *
 * A switch is a change of `swapKey` (an era, a format tab), not of the list: a filter typed into the
 * grid's search narrows the tiles in place. On a switch:
 *
 * 1. The tiles on screen stay, as the same elements and at full strength, while the new list's first
 *    screen of faces ({@link ART_FIRST}) loads and decodes through `artReady`, the face rule the
 *    board's own cards keep. A face is known only once the server has said which art its deck's cards
 *    have (`unansweredArt`, by name and pinned set), so the wait covers that answer too. They carry no deck id once leaving, so nothing can choose one.
 *    {@link ART_WAIT_MS} caps the wait for a CDN that never answers.
 * 2. Then the new tiles draw in the grid's flow, whole, and the old ones are lifted over the boxes
 *    they stood in (`crossing`) and fade out over them ({@link FADE_MS}): every frame shows a deck's
 *    art in every box, the old, the new, or one through the other.
 *
 * Outlines stand in only for a list with no grid before it — the first visit — and cascade into
 * tiles once its art is ready. A tile further down still draws no art before it decodes (`DeckArt`).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { artistsReady } from '../draft/artists.ts';
import { artReady, cardImageUrl } from '../draft/cardImage.ts';
import type { PeekList } from './DeckPeek.tsx';
import { namedArtAnswered, unansweredArt, useNamedArt } from './libraryPeek.ts';

/** How long the old tiles take to fade out over the new (`.deckpick__ghost` in `screens.css`). */
export const FADE_MS = 180;
/** How many of the new list's faces must decode before it draws: the first screen of tiles and more. */
export const ART_FIRST = 24;
/** The longest the new list waits for those faces. */
export const ART_WAIT_MS = 4000;

/** The art URLs of a list's first screen of tiles: what a switch to it waits on, and what a warm-up decodes ahead. */
export function firstFaces(options: readonly { artId?: string | undefined }[]): string[] {
  return options.slice(0, ART_FIRST).flatMap((o) => {
    const url = o.artId === undefined ? null : cardImageUrl(o.artId);
    return url === null ? [] : [url];
  });
}

/** The cards of a list's first screen of tiles whose art the server has not said yet: a tile drawn now would gain its art later. */
export function firstUnanswered(options: readonly { list?: PeekList | undefined }[]): string[] {
  return unansweredArt(
    options.slice(0, ART_FIRST).flatMap((o) => (o.list?.main ?? []).filter((l) => l.face.scryfallId === undefined).map((l) => ({ name: l.name, set: l.face.setCode }))),
  );
}

interface Swap<T> {
  /** The list this state is for. */
  key: string;
  /** The tiles on screen when the switch came: held until the new list may draw, then faded out over it. */
  old: readonly T[];
  /** The list `old` was drawn for, so its tiles keep their elements while they leave. */
  oldKey: string;
  /** How many boxes the grid had when the switch came (tiles, or outlines on a first visit). */
  hold: number;
}

export interface DeckSwap<T> {
  /** The tiles to draw as the grid's own: none until the list may draw. */
  shown: readonly T[];
  /** The last list's tiles: held in the grid's flow until `shown` draws, then lifted over it, fading. */
  leaving: readonly T[];
  /** `leaving` is fading out over `shown`, so it no longer holds the boxes it is drawn over. */
  crossing: boolean;
  /** `shown` came in with no grid before it (a first visit), so it cascades in rather than appearing under the old. */
  cascade: boolean;
  /** Which list `leaving` was drawn for (`DeckChooser` keys a tile by its list). */
  leavingKey: string;
  /** How many outlines to draw while a first list is on its way: 0 for none. */
  outlines: number;
  /** How many boxes the grid had before this list: a tile past them brings its box in too. */
  boxes: number;
}

/**
 * Which tiles the grid draws for `options` under `swapKey`. `pending` is the list not being known
 * yet (the pool has not answered), which keeps the wait open whatever `options` holds;
 * `pendingTiles` is how many outlines stand in for a list with no grid before it.
 */
export function useDeckSwap<T extends { value: string; artId?: string | undefined; list?: PeekList | undefined }>(
  options: readonly T[],
  swapKey: string,
  pending: boolean,
  pendingTiles: number,
): DeckSwap<T> {
  const [swap, setSwap] = useState<Swap<T>>({ key: swapKey, old: [], oldKey: '', hold: 0 });
  /** The key whose list has its art ready, so it may draw. */
  const [readyFor, setReadyFor] = useState<string | null>(null);
  /** The key whose old tiles have faded out over the new. */
  const [crossed, setCrossed] = useState<string | null>(null);

  const current = swap.key === swapKey;
  const ready = current && readyFor === swapKey;
  const held = current && swap.old.length > 0 && crossed !== swapKey;
  const boxes = swap.hold > 0 ? swap.hold : pendingTiles;
  const outlines = current && !ready && swap.old.length === 0 ? boxes : 0;
  const leaving = held ? swap.old : [];
  const crossing = held && ready;
  const shown = ready ? options : [];

  /** What the grid has on screen, for the next switch to hold. */
  const drawn = useRef<{ tiles: readonly T[]; key: string; count: number }>({ tiles: [], key: '', count: 0 });
  useLayoutEffect(() => {
    if (!current) return;
    drawn.current = ready
      ? { tiles: options, key: swapKey, count: options.length }
      : swap.old.length > 0
        ? { tiles: swap.old, key: swap.oldKey, count: swap.old.length }
        : { tiles: [], key: '', count: outlines };
  });

  // Before paint, so the new key's first frame is the old tiles still standing, never a blank or a pop.
  useLayoutEffect(() => {
    if (swap.key === swapKey) return;
    const was = drawn.current;
    setSwap({ key: swapKey, old: was.tiles, oldKey: was.key, hold: was.count });
    setReadyFor(null);
    setCrossed(null);
  }, [swap.key, swapKey]);

  useEffect(() => {
    if (!crossing) return;
    const timer = setTimeout(() => setCrossed(swapKey), FADE_MS);
    return () => clearTimeout(timer);
  }, [crossing, swapKey]);

  // The faces that must decode first, as one string: a list that reorders under the same key (win
  // rates landing) does not restart the wait.
  const faces = firstFaces(options).join('\n');
  // A list whose cards' art is still being asked for has faces it cannot name yet: it draws again on
  // the answer, or once the ask has failed, as it would with no answer to wait for.
  useNamedArt();
  const asking = firstUnanswered(options).join('\n');
  const [settled, setSettled] = useState('');
  const unanswered = asking !== '' && asking !== settled;
  useEffect(() => {
    if (!unanswered || pending || !current) return;
    let live = true;
    void namedArtAnswered(asking.split('\n')).then(() => {
      if (live) setSettled(asking);
    });
    return () => {
      live = false;
    };
  }, [unanswered, asking, pending, current]);
  useEffect(() => {
    if (pending || readyFor === swapKey || !current) return;
    if (unanswered) {
      const cap = setTimeout(() => setReadyFor(swapKey), ART_WAIT_MS);
      return () => clearTimeout(cap);
    }
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
  }, [pending, faces, unanswered, swapKey, current, readyFor]);

  return { shown, leaving, leavingKey: swap.oldKey, crossing, cascade: swap.old.length === 0, outlines, boxes };
}
