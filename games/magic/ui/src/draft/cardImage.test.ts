/*
 * The image boundary in the browser: every card image is the art route, `/api/art/<id>`.
 *
 * Its predecessor asserted "no `<img>` anywhere" and kept passing after images shipped, because
 * the fixtures it ran against carried no ids — the path that builds a URL was never entered. So
 * these build real URLs from real ids. Where the route sends a browser (our CDN copy or
 * Scryfall's, and never anywhere else) is the server's to decide and to test
 * (`games/magic/server/src/http/card-art.test.ts`); here:
 *
 *   - a card id becomes the route, a back face its `/back`, a size other than `normal` a query;
 *   - the browser holds no host, no manifest and no table: nothing it builds names an art host;
 *   - the committed pool carries ids and no URLs — `pool.json` is a reference, never a copy;
 *   - a missing or malformed id yields `null`, so the text tile is the fallback rather than a
 *     broken image.
 */

import { describe, expect, it } from 'vitest';
import { cardImageUrl } from './cardImage.ts';
import poolData from './pool.json';

const REAL_ID = '7673784e-db4b-43a1-8d55-1bb9fc1e284f';

describe('every card image is the art route', () => {
  it('a card is its id under /api/art, at the normal size unless asked otherwise', () => {
    expect(cardImageUrl(REAL_ID)).toBe(`/api/art/${REAL_ID}`);
    expect(cardImageUrl(REAL_ID, 'small')).toBe(`/api/art/${REAL_ID}?size=small`);
  });

  it("a back face is its card's id with /back", () => {
    expect(cardImageUrl(`${REAL_ID}#back`)).toBe(`/api/art/${REAL_ID}/back`);
  });

  it("names no art host: which bytes a card draws is the server's to say", () => {
    for (const size of ['small', 'normal', 'large'] as const) {
      const url = cardImageUrl(REAL_ID, size) as string;
      expect(url).not.toMatch(/^https?:/);
      expect(url).not.toContain('scryfall');
      expect(url).not.toContain('cdn.hadoku.me');
    }
  });
});

describe('a missing or malformed id yields no URL, not a broken one', () => {
  it('returns null rather than guessing', () => {
    expect(cardImageUrl(undefined)).toBeNull();
    expect(cardImageUrl('')).toBeNull();
    expect(cardImageUrl('not-a-uuid')).toBeNull();
    expect(cardImageUrl('7673784e')).toBeNull();
  });

  it('rejects an id that would build a 404 rather than emitting one per card', () => {
    expect(cardImageUrl('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBeNull();
  });
});

describe('the committed pool is a reference, never a copy', () => {
  const pool = poolData as { cards: Array<Record<string, unknown>> };

  it('carries ids', () => {
    const withIds = pool.cards.filter((c) => typeof c.scryfallId === 'string');
    expect(withIds.length).toBeGreaterThan(400);
  });

  it('carries no image URL, no image field, and no Scryfall image blob', () => {
    const json = JSON.stringify(pool);
    expect(json).not.toContain('scryfall.io');
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toContain('image_uris');
    expect(json).not.toMatch(/"image[^"]*":/i);
  });

  it('every id resolves to something the UI can render', () => {
    for (const card of pool.cards) {
      if (typeof card.scryfallId !== 'string') continue;
      expect(cardImageUrl(card.scryfallId)).not.toBeNull();
    }
  });
});
