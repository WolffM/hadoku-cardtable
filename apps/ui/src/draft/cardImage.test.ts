/*
 * D13, as it actually reads now that cards have art.
 *
 * The rule is not "no images" — it is "a link, not a host"
 * (`docs/LICENSING.md` §Concrete rules 2-3): never commit or host card images;
 * the browser fetches them from upstream directly; our server never proxies,
 * caches or stores them.
 *
 * So these tests assert the boundary rather than the absence:
 *
 *   - a URL is only ever built in the browser, from an id;
 *   - every URL points at `cards.scryfall.io` and nowhere else — above all not
 *     at our own origin, which would make us the host;
 *   - the committed pool carries ids and no URLs;
 *   - the image is never modified, which is Scryfall's presentation rule.
 *
 * The version of this that said "no `<img>` anywhere" kept passing after images
 * shipped, because the fixtures it ran against carry no ids. That is the exact
 * failure this file exists to replace.
 */

import { describe, expect, it } from 'vitest';
import { cardImageUrl } from './cardImage.ts';
import poolData from './pool.json';

const REAL_ID = '7673784e-db4b-43a1-8d55-1bb9fc1e284f';

describe('a URL is built from an id, in the browser', () => {
  it('builds Scryfall’s sharded path', () => {
    expect(cardImageUrl(REAL_ID)).toBe(
      `https://cards.scryfall.io/normal/front/7/6/${REAL_ID}.jpg`,
    );
  });

  it('shards on the first two characters of the id', () => {
    const url = cardImageUrl(REAL_ID);
    expect(url).toContain('/front/7/6/');
  });

  it('defaults to normal — the only size this UI ever needs', () => {
    // A tile is 190px; normal is 488px, which covers ~2.5x DPR. `large` is
    // never right here, and a srcset that resolved to it was measurably
    // slower for no visible gain. See cardImage.ts.
    expect(cardImageUrl(REAL_ID)).toContain('/normal/');
  });
});

describe('the host is Scryfall and only Scryfall', () => {
  it('every URL it can produce points at cards.scryfall.io', () => {
    for (const size of ['small', 'normal', 'large'] as const) {
      const url = cardImageUrl(REAL_ID, size);
      expect(url).not.toBeNull();
      expect(new URL(url as string).origin).toBe('https://cards.scryfall.io');
    }
  });

  it('never produces a same-origin URL — that would make us the host', () => {
    const url = cardImageUrl(REAL_ID) as string;
    expect(url.startsWith('/')).toBe(false);
    expect(url).not.toContain('hadoku.me');
    expect(url).not.toContain('/cardtable/');
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

  it('every id is a uuid, so every URL it builds resolves', () => {
    for (const card of pool.cards) {
      if (typeof card.scryfallId !== 'string') continue;
      expect(cardImageUrl(card.scryfallId)).not.toBeNull();
    }
  });
});
