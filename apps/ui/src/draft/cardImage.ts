/*
 * The only place in this project where a card image URL enters the UI.
 *
 * ## One route for every image
 *
 * Every card image a browser draws is `/api/art/<scryfallId>` (`<id>/back` for a back face), and
 * the server answers with a redirect to the bytes: our own copy on `cdn.hadoku.me` when the art
 * mirror holds one, Scryfall's image otherwise (`games/magic/server/src/http/card-art.ts`). The server is
 * the one place that knows which ids are mirrored and which are repointed, so this module holds no
 * host, no manifest and no table: a card's art is still a lookup, not a URL, and the lookup is the
 * server's. Repointing a card stays a one-line data edit there, with no browser rebuild.
 *
 * The bytes never come from our origin — the route only redirects — and the browser caches the
 * redirect for a day, so a card it has drawn costs one request to the art host after that.
 *
 * ## Why `normal`, and why not `art_crop`
 *
 * `normal` is the whole card face — frame, type line, and the copyright and
 * artist credit printed on the card itself. That mattered under Scryfall's
 * presentation guidelines (don't cover, crop or clip off the copyright or artist
 * name; don't distort, skew, stretch, blur, sharpen or recolour), and serving the
 * unmodified whole card satisfied all of them by construction, with nothing for
 * us to remember.
 *
 * It still matters with our own CDN, for a plainer reason: `art_crop` would
 * oblige the UI to surface the artist and copyright itself, somewhere, forever —
 * a promise the first redesign that moved a caption would quietly break. And
 * because the art is a placeholder that may revert to a source that *does* carry
 * presentation rules, the whole-card choice is the one that survives the swap.
 *
 * ## No WotC marks — still true, and not in tension
 *
 * The trademark rule is untouched and absolute: no mana symbols, set symbols,
 * tap symbol, card frames or Magic wordmark drawn by *us*. That governs the
 * chrome we author, which is why `ManaPip` draws its own circles and renders
 * `{T}` as the word TAP. A card image is the card; it is not us drawing their
 * marks.
 */

import { BACK_FACE } from '@hadoku/carddata/art';
import { apiUrl } from '../http.ts';
import { whenIdle } from '../idle.ts';

/** The image sizes the resolver knows how to build. */
export type CardImageSize = 'small' | 'normal' | 'large';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The image URL for a card, or `null` when there is nothing to build from.
 *
 * `null` — not a placeholder, not a guess, not a URL that 404s — is the contract
 * the caller depends on: `CardTile` renders the text tile, which is a complete,
 * readable card on its own. An id that is no card's takes that path, and so does
 * an image that fails to load (via the `<img onError>` fallback).
 */
export function cardImageUrl(
  scryfallId: string | undefined,
  size: CardImageSize = 'normal',
): string | null {
  if (scryfallId === undefined) return null;
  const back = scryfallId.endsWith(BACK_FACE);
  const id = back ? scryfallId.slice(0, -BACK_FACE.length) : scryfallId;
  if (!UUID.test(id)) return null;
  return apiUrl(`art/${id}${back ? '/back' : ''}${size === 'normal' ? '' : `?size=${size}`}`);
}

/**
 * Warm the browser's image cache for every one of these URLs, skipping any
 * `held` already has an entry for and recording the ones it warms.
 *
 * `new Image()`, not `<link rel="prefetch">`. The first cut used a prefetch
 * link — measured live, it made things WORSE: a prefetch request lives in a
 * separate cache partition from an ordinary image load, so it does not
 * coalesce with the picker's own `<img>` for the same URL. The two raced
 * instead of one feeding the other — doubling the requests an era's options
 * sent to the art host, with the `<img>` still a real (if fast) fetch rather
 * than a cache hit. An `Image()` object is an ordinary image LOAD as far as
 * the browser's resource cache is concerned, so a same-URL `<img>` that
 * mounts afterward coalesces onto it — in flight, if it is still loading, or
 * straight from cache, if it has already finished. One request per distinct
 * URL, total, which is the operator's own complaint answered: *"some loaded
 * quick, but others loaded extremely slowly… this is a static list we
 * should be able to cache these images."*
 *
 * `held` keeps every `Image` this call creates alive for as long as the
 * caller keeps the map around. An `Image` nothing references any more is
 * eligible for garbage collection, and a browser is free to abort an
 * in-flight fetch for an object nothing holds — so a bare `Set<string>` of
 * URLs could tell a caller "already asked for", but could not stop that ask
 * from being cancelled under it. One `Map<url, Image>` answers both: `has`
 * is the de-dupe check, and the stored `Image` is the reason the load
 * survives.
 *
 * `held` is the CALLER's map, not a module singleton, on purpose — a module
 * singleton would dedupe against every other mount in the same tab (a second
 * room, a test file's next `it`) as readily as it dedupes within one, and
 * `cardImage.test.ts` would leak state between its own cases. The caller
 * that wants "once per distinct URL for as long as this room is open" keeps
 * one `Map` for the life of its own mount (`ConstructedScreen`, a `useRef`)
 * and hands it in every time the list of options changes — which is what
 * makes two eras that happen to share a card's art warm it only once.
 *
 * `decoding = 'async'` so a slow decode of an image nothing is displaying yet
 * never competes with the main thread. Nothing here ever inserts these
 * `Image` objects into the document — there is no `<img>` to paint and no
 * layout to invalidate; they exist only to make the browser fetch and cache.
 *
 * A no-op without `Image` (SSR, a non-DOM test): nothing to warm, and nothing
 * to throw over.
 */
export function prefetchCardImages(urls: readonly string[], held: Map<string, HTMLImageElement>): void {
  if (typeof Image === 'undefined') return;
  for (const url of urls) {
    if (held.has(url)) continue;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    held.set(url, img);
  }
}

/** Every art load `artReady` started, kept alive for the page's life, and whether it has finished. */
const art = new Map<string, { img: HTMLImageElement; done: boolean; waiting: Set<() => void> }>();

/**
 * Whether a card face can be drawn WITH its art right now: `url`'s image is
 * fetched and decoded, so a `CardTile` mounted next finds it in the document's
 * own list of available images and paints it on its first frame. If not, the
 * load starts (once per URL) and `onReady` is called when it ends — the caller
 * keeps drawing what it drew (a back) until then, and is never shown the text
 * tile first. The operator, 2026-10-09: *"i really dont want a no-art card to
 * show ever."*
 *
 * Called only once this screen knows which card it is — a face this seat may
 * see — never to warm the other seat's hidden cards. A failed load counts as
 * ready: the text tile is then the card (`cardImageUrl`'s own contract), and
 * waiting longer would show nothing better. No URL, or no `Image` that can
 * decode (a non-DOM test, jsdom), is ready at once. `priority` `'low'` is a background warm-up
 * (`play/live/art-preload.ts`), never a face somebody is waiting to see.
 */
export function artReady(url: string | null, onReady: () => void, priority: 'auto' | 'low' = 'auto'): boolean {
  if (url === null || typeof Image === 'undefined' || typeof Image.prototype.decode !== 'function') return true;
  const known = art.get(url);
  if (known?.done === true) return true;
  if (known !== undefined) {
    known.waiting.add(onReady);
    return false;
  }
  const img = new Image();
  img.fetchPriority = priority;
  const entry = { img, done: false, waiting: new Set([onReady]) };
  art.set(url, entry);
  const finish = (): void => {
    entry.done = true;
    for (const fn of entry.waiting) fn();
    entry.waiting.clear();
  };
  img.src = url;
  // Already in the page's list of available images (a tile on screen drew it): ready now, not a frame later.
  if (img.complete && img.naturalWidth > 0) {
    entry.done = true;
    entry.waiting.clear();
    return true;
  }
  img.decode().then(finish, finish);
  return false;
}

/**
 * Deliberately no `srcset`.
 *
 * A card tile is `--card-w: 190px`. A `normal` image is 488px wide, which covers
 * that to ~2.5x device pixel ratio — so `large` (672px) is never the right choice
 * for this UI, at any display density.
 *
 * The first cut shipped a srcset with `sizes="var(--card-w)"`. A CSS variable is
 * not a valid length in a `sizes` attribute, so the browser discarded it, fell
 * back to `100vw`, and picked the LARGEST candidate every time: 780x1086 images
 * for a 190px slot, verified in a real browser. Fifteen of those per pack is
 * roughly three times the bytes for no visible difference, and it was a good part
 * of why the table felt slow.
 *
 * One size, chosen correctly, beats a responsive set that resolves wrong. This
 * is still true with the art on our own CDN — a byte we serve is as slow to
 * download as a byte Scryfall serves.
 */

/** How many background art loads (`warmArt`) run at once. */
export const PRELOAD_AT_ONCE = 3;

/**
 * Warm `urls` in the background: `PRELOAD_AT_ONCE` at a time, at low priority, once the page is idle,
 * each fetched and decoded through `artReady` (so a face drawn next finds it ready). A match's art
 * (`../play/live/art-preload.ts`) and the front page's gallery (`../front/WildcardCard.tsx`). Returns
 * how many it was given.
 */
export function warmArt(urls: readonly string[]): number {
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
