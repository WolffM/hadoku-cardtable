/*
 * The image boundary, as it actually reads now that we host art ourselves.
 *
 * ## Why this file exists at all
 *
 * Its predecessor asserted "no `<img>` anywhere". It kept passing after images
 * shipped, because the fixtures it ran against carried no ids — so the code path
 * that builds a URL was never entered and the assertion was true about nothing.
 * A green gate is a claim, and that one was empty. This repo has paid for that
 * lesson three separate times; the story stays in this header so the next person
 * to rewrite these tests knows what the failure mode looks like.
 *
 * ## What the boundary is now
 *
 * The old rule ("a link, not a host") was repealed by the operator: card art is
 * served from `cdn.hadoku.me`. What remains, and what these tests guard, is
 * narrower and sharper:
 *
 *   - a URL is only ever built in the browser, from an id plus a manifest;
 *   - every URL points at one of `ALLOWED_ART_HOSTS` and nowhere else — the set
 *     is imported, not retyped, so adding a source in the resolver cannot
 *     silently widen what this file accepts;
 *   - **never our own origin.** We serve the app, not the bytes. A relative or
 *     same-origin `src` is still a bug. This is the assertion that must not
 *     weaken, and it is the one that gets mutation-tested;
 *   - the committed pool carries ids and no URLs — `pool.json` is a reference,
 *     never a copy;
 *   - the committed manifest carries KEYS and no URLs, because the CDN hostname
 *     is expected to move (`@wolffm/cdn-client`'s rule) and a baked-in hostname
 *     fails silently when it does;
 *   - a missing or malformed id yields `null`, so the text tile is the fallback
 *     rather than a broken image.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ART_HOSTS,
  CDN_BASE,
  SCRYFALL_IMAGE_BASE,
  resolveArtUrl,
  type ArtManifest,
  type ArtManifestFile,
} from '@hadoku/carddata/art';
import { cardImageUrl } from './cardImage.ts';
import manifestData from './art-manifest.json';
import poolData from './pool.json';

const REAL_ID = '7673784e-db4b-43a1-8d55-1bb9fc1e284f';
const OTHER_ID = 'a1b2c3d4-0000-4000-8000-0123456789ab';

/**
 * `ALLOWED_ART_HOSTS` is the single source of truth for what an art URL may
 * carry. Accept it written either as a bare host or as a full origin, and
 * compare against `URL.origin` — normalising the spelling does not widen the
 * set, which is the property that matters.
 */
const ALLOWED_ORIGINS = new Set(
  ALLOWED_ART_HOSTS.map((h) => (h.includes('://') ? new URL(h).origin : `https://${h}`)),
);

/** A manifest that points one card at our CDN, and says nothing about any other. */
const CDN_KEY = 'a'.repeat(64) + '.jpg';

const CDN_MANIFEST: ArtManifest = {
  [REAL_ID]: { source: 'cdn', key: CDN_KEY },
};

const EMPTY_MANIFEST: ArtManifest = {};

describe('a URL is built in the browser, from an id and a manifest', () => {
  it('falls back to Scryfall’s sharded path when no entry claims the card', () => {
    expect(resolveArtUrl(REAL_ID, EMPTY_MANIFEST)).toBe(
      `${SCRYFALL_IMAGE_BASE}/normal/front/7/6/${REAL_ID}.jpg`,
    );
  });

  it('shards on the first two characters of the id', () => {
    expect(resolveArtUrl(REAL_ID, EMPTY_MANIFEST)).toContain('/front/7/6/');
  });

  it('defaults to normal — the only size this UI ever needs', () => {
    // A tile is 190px; normal is 488px, which covers ~2.5x DPR. `large` is
    // never right here, and a srcset that resolved to it was measurably slower
    // for no visible gain. See cardImage.ts.
    expect(cardImageUrl(REAL_ID)).toContain('/normal/');
  });
});

describe('the three renders: a CDN entry, a Scryfall fallback, and no art at all', () => {
  it('a CDN entry resolves to our CDN, keyed', () => {
    expect(resolveArtUrl(REAL_ID, CDN_MANIFEST)).toBe(`${CDN_BASE}/${CDN_KEY}`);
  });

  it('a card with no entry falls back to Scryfall', () => {
    // Same manifest, a different card: the entry is per-card, so one repointed
    // card does not move any other. That is the whole point of the indirection.
    const url = resolveArtUrl(OTHER_ID, CDN_MANIFEST);
    expect(url).not.toBeNull();
    expect(new URL(url as string).origin).toBe(new URL(SCRYFALL_IMAGE_BASE).origin);
  });

  it('a card with neither an entry nor a usable id yields null — the text tile', () => {
    expect(resolveArtUrl(undefined, CDN_MANIFEST)).toBeNull();
    expect(resolveArtUrl('not-a-uuid', CDN_MANIFEST)).toBeNull();
  });

  it('the UI path is the resolver, bound to the committed manifest and nothing else', () => {
    // The three arms above are asserted against the resolver directly, because
    // the committed manifest is empty this wave and cannot exercise the CDN arm.
    // This is what makes them arms of the *UI* too: cardImageUrl adds no host,
    // no path shape and no id handling of its own, so whatever the resolver
    // answers for the committed entries is exactly what a tile renders.
    const entries = (manifestData as ArtManifestFile).entries;
    for (const id of [REAL_ID, OTHER_ID, undefined, '', 'not-a-uuid']) {
      for (const size of ['small', 'normal', 'large'] as const) {
        expect(cardImageUrl(id, size)).toBe(resolveArtUrl(id, entries, { size }));
      }
    }
  });
});

describe('the host is one of the allowed ones and nothing else', () => {
  it('the allowed set contains both sources we actually use', () => {
    expect(ALLOWED_ORIGINS.has(new URL(CDN_BASE).origin)).toBe(true);
    expect(ALLOWED_ORIGINS.has(new URL(SCRYFALL_IMAGE_BASE).origin)).toBe(true);
  });

  it('the allowed set does not contain our own origin', () => {
    for (const origin of ALLOWED_ORIGINS) {
      expect(origin).not.toContain('hadoku.me/cardtable');
      expect(new URL(origin).hostname).not.toBe('hadoku.me');
    }
  });

  it('every URL either resolver path can produce carries an allowed origin', () => {
    for (const size of ['small', 'normal', 'large'] as const) {
      for (const manifest of [CDN_MANIFEST, EMPTY_MANIFEST]) {
        const url = resolveArtUrl(REAL_ID, manifest, { size });
        expect(url).not.toBeNull();
        expect(ALLOWED_ORIGINS.has(new URL(url as string).origin)).toBe(true);
      }
    }
  });

  it('every URL the UI itself builds carries an allowed origin', () => {
    for (const size of ['small', 'normal', 'large'] as const) {
      const url = cardImageUrl(REAL_ID, size);
      expect(url).not.toBeNull();
      expect(ALLOWED_ORIGINS.has(new URL(url as string).origin)).toBe(true);
    }
  });

  it('never produces a same-origin or relative URL — we serve the app, not the bytes', () => {
    // The assertion that must not weaken. Everything above allows a new source
    // to be added by editing ALLOWED_ART_HOSTS; this one allows nothing.
    for (const size of ['small', 'normal', 'large'] as const) {
      const url = cardImageUrl(REAL_ID, size) as string;
      expect(url.startsWith('/')).toBe(false);
      expect(url.startsWith('./')).toBe(false);
      expect(url).toMatch(/^https:\/\//);
      expect(new URL(url).hostname).not.toBe('hadoku.me');
      expect(url).not.toContain('/cardtable/');
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

describe('the committed manifest stores keys, never URLs', () => {
  const manifest = manifestData as ArtManifestFile;

  it('is a version-1 manifest file', () => {
    expect(manifest.version).toBe(1);
    expect(typeof manifest.entries).toBe('object');
  });

  it('carries no absolute URL and no hostname of any kind', () => {
    // The CDN hostname is expected to move — that is `@wolffm/cdn-client`'s
    // rule — and a hostname baked into committed data fails silently when it
    // does: every entry keeps resolving, to the wrong place. Keys only.
    const json = JSON.stringify(manifest.entries);
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toContain('cards.scryfall.io');
    expect(json).not.toContain('hadoku.me');
  });

  it('gives every entry a known source, and a key when it is ours', () => {
    for (const [id, entry] of Object.entries(manifest.entries)) {
      expect(id, `entry key ${id} is not a uuid`).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(['cdn', 'scryfall']).toContain(entry.source);
      if (entry.source === 'cdn') expect(typeof entry.key).toBe('string');
    }
  });
});
