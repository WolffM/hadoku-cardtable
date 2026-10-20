/*
 * The match's art, fetched and decoded in the background the moment the
 * server says which cards it holds (`@hadoku/shared`'s `art.ts`): every card of
 * both decks, so a card the other seat turns over — or plays, or reveals — is
 * drawn with its art on the first frame. The operator, 2026-10-09: *"i care
 * much more about pre-loading art so that things load smoothly."*
 *
 * A few at a time, at low priority, and only once the page is idle: the board's
 * own first paint, and any card it is drawing now, come first. A card no deck
 * names (a token, a card made mid-game) is still covered by `artReady`'s own
 * guard where a face is turned over. A double-faced card's back face is warmed
 * beside its front, so a transform draws the other face with its art at once.
 */
import { artIdsWithBacks } from '@hadoku/carddata/art';
import { ArtPreloadSchema } from '@hadoku/shared';

import { artReady, cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import poolData from '../../draft/pool.json' with { type: 'json' };
import { allRelatedIds } from '../../draft/related.ts';

/** How many art loads run at once. */
export const PRELOAD_AT_ONCE = 3;

/** The distinct art URLs a `forge:art` message names for this match — empty for anything else. */
export function preloadUrls(matchId: string, payload: unknown): string[] {
  const parsed = ArtPreloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.matchId !== matchId) return [];
  const ids = parsed.data.cards.map((c) => scryfallIdFor(KNOWN_ART_IDS, c.name, c.set ?? '')).filter((id): id is string => id !== undefined);
  const urls = artIdsWithBacks(KNOWN_ART_IDS, ids).map((id) => cardImageUrl(id));
  return [...new Set(urls.filter((url): url is string => url !== null))];
}

function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 200);
}

/** Start the preload; returns how many distinct images it will warm. */
export function preloadMatchArt(matchId: string, payload: unknown): number {
  return warm(preloadUrls(matchId, payload));
}

/** Every card the cube can deal, with its back face, and the tokens and meld cards the fan draws beside them. */
export function cubeArtUrls(): string[] {
  const ids = (poolData as { cards: { scryfallId?: string }[] }).cards.flatMap((c) => (c.scryfallId === undefined ? [] : [c.scryfallId]));
  const urls = [...artIdsWithBacks(KNOWN_ART_IDS, ids), ...allRelatedIds()].map((id) => cardImageUrl(id));
  return [...new Set(urls.filter((url): url is string => url !== null))];
}

let cubeWarmed = false;

/**
 * The whole cube's art, warmed once a page opens a draft room (the operator,
 * 2026-10-19: *"when a new pack appears i notice slight lag for the art to load …
 * preload the art for all cards in the draft set"*). The cube's list is public —
 * it is in this bundle — so warming all of it says nothing about anyone's pack.
 * Once per page; returns how many it will warm (0 the second time).
 */
export function preloadCubeArt(): number {
  if (cubeWarmed) return 0;
  cubeWarmed = true;
  return warm(cubeArtUrls());
}

/** For tests: the next `preloadCubeArt` warms again. */
export function resetCubeArtForTests(): void {
  cubeWarmed = false;
}

/** Warm `urls` a few at a time, at low priority, once the page is idle. */
function warm(urls: readonly string[]): number {
  let next = 0;
  const pump = (): void => {
    while (next < urls.length) {
      if (!artReady(urls[next++]!, pump, 'low')) return;
    }
  };
  whenIdle(() => {
    for (let i = 0; i < PRELOAD_AT_ONCE; i++) pump();
  });
  return urls.length;
}
