/*
 * The art guard (`artReady`) and the match's background preload
 * (`preloadMatchArt`) against a fake `Image` whose decode this test settles by
 * hand — no network, and the order of loads is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { artReady, cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import { PRELOAD_AT_ONCE, preloadMatchArt, preloadUrls } from './art-preload.ts';

const loads: { src: string; fetchPriority: string; settle: (ok: boolean) => void }[] = [];

class FakeImage {
  src = '';
  fetchPriority = 'auto';
  decode(): Promise<void> {
    return new Promise((resolve, reject) => {
      loads.push({ src: this.src, fetchPriority: this.fetchPriority, settle: (ok) => (ok ? resolve() : reject(new Error('404'))) });
    });
  }
}

beforeEach(() => {
  loads.length = 0;
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('requestIdleCallback', (fn: () => void) => fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('artReady: a face is turned over only once its art is decoded', () => {
  it('not ready until the decode ends, then ready for good — one load per URL, every waiter told', async () => {
    const url = 'https://cards.scryfall.io/normal/front/a/a/test-ready-1.jpg';
    const first = vi.fn();
    const second = vi.fn();
    expect(artReady(url, first)).toBe(false);
    expect(artReady(url, second)).toBe(false);
    expect(loads).toHaveLength(1);
    loads[0]!.settle(true);
    await settled();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(artReady(url, vi.fn())).toBe(true);
  });

  it('an image the page already holds (a tile on screen drew it) is ready at once — no back for a frame', () => {
    class HeldImage extends FakeImage {
      complete = true;
      naturalWidth = 488;
    }
    vi.stubGlobal('Image', HeldImage);
    const url = 'https://cards.scryfall.io/normal/front/a/a/test-held.jpg';
    expect(artReady(url, vi.fn())).toBe(true);
    expect(loads, 'no decode waited on').toHaveLength(0);
    expect(artReady(url, vi.fn())).toBe(true);
  });

  it('a failed load counts as ready — the text tile is then the card — and no URL is ready at once', async () => {
    const url = 'https://cards.scryfall.io/normal/front/a/a/test-404.jpg';
    expect(artReady(url, vi.fn())).toBe(false);
    loads[0]!.settle(false);
    await settled();
    expect(artReady(url, vi.fn())).toBe(true);
    expect(artReady(null, vi.fn())).toBe(true);
  });
});

describe('preloadMatchArt: both decks’ art, a few at a time, at low priority', () => {
  const cards = [
    { name: 'Volcanic Hammer', set: null },
    { name: 'Grizzly Bears', set: null },
    { name: 'Lightning Bolt', set: null },
    { name: 'Counterspell', set: null },
    { name: 'Ponder', set: null },
    { name: 'Not A Real Card Name', set: null },
  ];

  it('resolves each name through the same art index the board draws with, skips what has no art, and ignores another match', () => {
    const urls = preloadUrls('m-1', { matchId: 'm-1', cards });
    expect(urls).toContain(cardImageUrl(scryfallIdFor(KNOWN_ART_IDS, 'Volcanic Hammer', '')));
    expect(urls).toHaveLength(5);
    expect(preloadUrls('m-2', { matchId: 'm-1', cards })).toEqual([]);
    expect(preloadUrls('m-1', { matchId: 'm-1', cards: [{ name: 'x', set: null, url: 'https://evil' }] }), 'strict: a URL never rides the wire').toEqual([]);
  });

  it(`runs ${PRELOAD_AT_ONCE} loads at once, low priority, and starts the next as each ends`, async () => {
    expect(preloadMatchArt('m-1', { matchId: 'm-1', cards })).toBe(5);
    expect(loads).toHaveLength(PRELOAD_AT_ONCE);
    expect(loads.every((l) => l.fetchPriority === 'low')).toBe(true);
    loads[0]!.settle(true);
    await settled();
    expect(loads).toHaveLength(4);
  });
});
