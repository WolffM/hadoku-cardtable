/*
 * The art guard (`artReady`) and the match's background preload
 * (`preloadMatchArt`) against a fake `Image` whose decode this test settles by
 * hand — no network, and the order of loads is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftCard, DraftView } from '@hadoku/shared';

import { artReady, cardImageUrl } from '../../draft/cardImage.ts';
import { PRELOAD_AT_ONCE } from '../../draft/cardImage.ts';
import { cubeArtUrls, preloadCubeArt, preloadMatchArt, preloadUrls, resetCubeArtForTests, viewerCards } from './art-preload.ts';

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
  const id = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;
  const ids = [id(1), id(2), id(3), `${id(3)}#back`, id(4), id(5)];

  it('warms each id the server named — a back face as its back image — and ignores another match', () => {
    const urls = preloadUrls('m-1', { matchId: 'm-1', ids });
    expect(urls).toEqual(ids.map((i) => cardImageUrl(i)));
    expect(urls[3]).toMatch(/\/back$/);
    expect(preloadUrls('m-2', { matchId: 'm-1', ids })).toEqual([]);
    expect(preloadUrls('m-1', { matchId: 'm-1', ids: ['https://evil'] }), 'strict: a URL never rides the wire').toEqual([]);
    expect(preloadUrls('m-1', { matchId: 'm-1', ids, cards: [] }), 'strict: nothing else rides it either').toEqual([]);
  });

  it(`runs ${PRELOAD_AT_ONCE} loads at once, low priority, and starts the next as each ends`, async () => {
    expect(preloadMatchArt('m-1', { matchId: 'm-1', ids })).toBe(6);
    expect(loads).toHaveLength(PRELOAD_AT_ONCE);
    expect(loads.every((l) => l.fetchPriority === 'low')).toBe(true);
    loads[0]!.settle(true);
    await settled();
    expect(loads).toHaveLength(PRELOAD_AT_ONCE + 1);
  });
});

/** A minimal, valid `DraftCard` — the plan's own cards carry their `scryfallId` directly, no manifest lookup needed. */
function card(id: string, scryfallId?: string, faces?: DraftCard['faces']): DraftCard {
  return {
    cardId: id,
    scryfallId,
    name: `Card ${id}`,
    manaCost: ['1'],
    manaValue: 1,
    colors: [],
    typeLine: 'Artifact',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: '1',
    rarity: 'common',
    faces,
  };
}

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('cubeArtUrls / preloadCubeArt: the PLAN’s own cards, never the bundled pool (wave 73 §B)', () => {
  afterEach(() => resetCubeArtForTests());

  it("names a card's own id, its back face, and whatever rides with it (`related.ts`'s tokens) — never the old bundled file", () => {
    const front = card('1', UUID_A, [{ ...card('1-back', `${UUID_A}#back`) }]);
    const urls = cubeArtUrls([front]);
    expect(urls).toContain(cardImageUrl(UUID_A));
    expect(urls).toContain(cardImageUrl(`${UUID_A}#back`));

    // A real `related.json` entry (checked 2026-10-22): Ocelot Pride makes a Cat.
    const CAT_ID = '5f458f39-27b6-4121-bda9-1a0d1b42f5fb';
    expect(cubeArtUrls([{ ...card('2', UUID_B), name: 'Ocelot Pride' }])).toEqual([cardImageUrl(UUID_B), cardImageUrl(CAT_ID)]);
  });

  it('deduplicates across cards, and skips a card with no scryfallId', () => {
    const urls = cubeArtUrls([card('1', UUID_A), card('2', UUID_A), card('3')]);
    expect(urls).toEqual([cardImageUrl(UUID_A)]);
  });

  it('warms low, a few at a time, and never warms the same URL twice', () => {
    const cards = [card('1', UUID_A), card('2', UUID_B)];
    expect(preloadCubeArt(cards)).toBe(2);
    expect(loads).toHaveLength(2);
    expect(loads.every((l) => l.fetchPriority === 'low')).toBe(true);
    expect(preloadCubeArt(cards), 'already warmed — nothing new').toBe(0);
  });

  it('a later call warms only the cards it has not already seen — new packs, not the whole cube up front', () => {
    expect(preloadCubeArt([card('1', UUID_A)])).toBe(1);
    expect(preloadCubeArt([card('1', UUID_A), card('2', UUID_B)]), 'the second card is new; the first is not').toBe(1);
  });
});

describe('viewerCards: a seat’s or a watcher’s pack and pool, empty for a spectator', () => {
  const base: Omit<DraftView, 'viewer'> = {
    draftId: 'd1',
    epoch: 'e1',
    seq: 1,
    packNumber: 1,
    pickNumber: 1,
    packCount: 3,
    packSize: 15,
    passDirection: 'left',
    capacity: 8,
    seats: [],
    waitingOn: [],
  };

  it("a seat's own pack and pool", () => {
    const pack = [card('p1', UUID_A)];
    const pool = [card('k1', UUID_B)];
    const view: DraftView = { ...base, viewer: { kind: 'seat', seatId: 0, pack, pool } };
    expect(viewerCards(view)).toEqual([...pack, ...pool]);
  });

  it("a watcher's watched seat, the same way", () => {
    const pack = [card('p1', UUID_A)];
    const view: DraftView = { ...base, viewer: { kind: 'watcher', seatId: 1, pack, pool: [] } };
    expect(viewerCards(view)).toEqual(pack);
  });

  it('nothing for a spectator', () => {
    const view: DraftView = { ...base, viewer: { kind: 'spectator' } };
    expect(viewerCards(view)).toEqual([]);
  });
});
