import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ART_HOSTS,
  BACK_FACE,
  CDN_BASE,
  SCRYFALL_IMAGE_BASE,
  cdnUrlFor,
  isCdnKey,
  resolveArtUrl,
  type ArtManifest,
} from './index.ts';

/*
 * Fixtures, never the committed manifest.
 *
 * `apps/ui/src/draft/art-manifest.json` ships empty this wave — no upload has
 * run — so a test written against it would assert nothing today and would start
 * asserting something else entirely the first time someone uploads. These
 * fixtures say what the resolver does; the committed file says what the deck
 * currently looks like, and those are different questions.
 *
 * The keys below are fabricated. They are shaped like real CDN keys (SHA-256 +
 * extension) because that is what the resolver's guard checks, and they name no
 * object that exists.
 */

const KEY_A = `${'a1'.repeat(32)}.jpg`;
const KEY_B = `${'b2'.repeat(32)}.jpg`;
const KEY_C = `${'c3'.repeat(32)}.jpg`;

/** Five real-shaped uuids with distinct first two characters, so sharding shows. */
const ID_CDN = '1a2b3c4d-1111-4111-8111-111111111111';
const ID_CDN_OTHER = '2b3c4d5e-2222-4222-8222-222222222222';
const ID_SCRYFALL = '3c4d5e6f-3333-4333-8333-333333333333';
const ID_ABSENT = '4d5e6f70-4444-4444-8444-444444444444';
const ID_UNKNOWN_SOURCE = '5e6f7081-5555-4555-8555-555555555555';

const MANIFEST: ArtManifest = {
  [ID_CDN]: { source: 'cdn', key: KEY_A },
  [ID_CDN_OTHER]: { source: 'cdn', key: KEY_B },
  [ID_SCRYFALL]: { source: 'scryfall' },
  // A row this build has never heard of — exactly what a hand edit or a manifest
  // written by a newer version of the CLI would leave behind. Cast because the
  // whole point is that the runtime value escapes the declared type.
  [ID_UNKNOWN_SOURCE]: { source: 'commissioned' } as unknown as ArtManifest[string],
};

function scryfallUrl(id: string, size = 'normal'): string {
  return `${SCRYFALL_IMAGE_BASE}/${size}/front/${id[0]}/${id[1]}/${id}.jpg`;
}

describe('resolveArtUrl — case 1, a cdn entry', () => {
  it('composes base + key', () => {
    expect(resolveArtUrl(ID_CDN, MANIFEST)).toBe(`${CDN_BASE}/${KEY_A}`);
  });

  it('honours a cdnBase override, which is how the hostname moves', () => {
    expect(resolveArtUrl(ID_CDN, MANIFEST, { cdnBase: 'https://cdn.example.test' })).toBe(
      `https://cdn.example.test/${KEY_A}`,
    );
  });

  it('never doubles a slash when the base carries a stray one', () => {
    expect(resolveArtUrl(ID_CDN, MANIFEST, { cdnBase: `${CDN_BASE}/` })).toBe(
      `${CDN_BASE}/${KEY_A}`,
    );
  });

  it("asks Scryfall for the artwork alone when the size is art_crop", () => {
    expect(resolveArtUrl(ID_ABSENT, {}, { size: 'art_crop' })).toBe(scryfallUrl(ID_ABSENT, 'art_crop'));
  });

  it('ignores size — a key addresses one stored object at one size', () => {
    const small = resolveArtUrl(ID_CDN, MANIFEST, { size: 'small' });
    const large = resolveArtUrl(ID_CDN, MANIFEST, { size: 'large' });
    expect(small).toBe(`${CDN_BASE}/${KEY_A}`);
    expect(large).toBe(small);
  });
});

describe('resolveArtUrl — case 2, scryfall entry or no entry at all', () => {
  it('builds the sharded URL for an explicit scryfall row', () => {
    expect(resolveArtUrl(ID_SCRYFALL, MANIFEST)).toBe(scryfallUrl(ID_SCRYFALL));
  });

  it('builds the same URL for a card the manifest does not mention', () => {
    expect(resolveArtUrl(ID_ABSENT, MANIFEST)).toBe(scryfallUrl(ID_ABSENT));
  });

  it('defaults to normal, and passes the other sizes through', () => {
    expect(resolveArtUrl(ID_ABSENT, MANIFEST)).toBe(scryfallUrl(ID_ABSENT, 'normal'));
    expect(resolveArtUrl(ID_ABSENT, MANIFEST, { size: 'small' })).toBe(
      scryfallUrl(ID_ABSENT, 'small'),
    );
    expect(resolveArtUrl(ID_ABSENT, MANIFEST, { size: 'large' })).toBe(
      scryfallUrl(ID_ABSENT, 'large'),
    );
  });

  it('shards on the id, not on a fixed prefix', () => {
    expect(resolveArtUrl(ID_ABSENT, MANIFEST)).toContain('/front/4/d/');
    expect(resolveArtUrl(ID_SCRYFALL, MANIFEST)).toContain('/front/3/c/');
  });
});

describe('resolveArtUrl — case 3, no usable id', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['one character', 'a'],
    ['not a uuid', 'stoneforge-mystic'],
    ['a uuid missing a group', '1a2b3c4d-1111-4111-111111111111'],
    ['a uuid with a non-hex character', '1a2b3c4z-1111-4111-8111-111111111111'],
  ])('returns null for %s', (_label, id) => {
    expect(resolveArtUrl(id, MANIFEST)).toBeNull();
  });

  it('returns null even when a malformed id carries a scryfall row', () => {
    const manifest: ArtManifest = { 'not-a-uuid': { source: 'scryfall' } };
    expect(resolveArtUrl('not-a-uuid', manifest)).toBeNull();
  });
});

describe('resolveArtUrl — case 4, a row the resolver does not understand', () => {
  it('falls back to Scryfall for an unknown source rather than throwing', () => {
    expect(() => resolveArtUrl(ID_UNKNOWN_SOURCE, MANIFEST)).not.toThrow();
    expect(resolveArtUrl(ID_UNKNOWN_SOURCE, MANIFEST)).toBe(scryfallUrl(ID_UNKNOWN_SOURCE));
  });

  it('falls back for a cdn row with no key', () => {
    const manifest: ArtManifest = { [ID_CDN]: { source: 'cdn' } };
    expect(resolveArtUrl(ID_CDN, manifest)).toBe(scryfallUrl(ID_CDN));
  });

  it('falls back for a cdn row whose key is blank', () => {
    for (const key of ['', '   ']) {
      const manifest: ArtManifest = { [ID_CDN]: { source: 'cdn', key } };
      expect(resolveArtUrl(ID_CDN, manifest)).toBe(scryfallUrl(ID_CDN));
    }
  });

  /*
   * The guard is applied, not merely exported.
   *
   * `deadbeef.jpg` names no object any more than `''` does, so it takes the
   * same fallback — one rule, not two-and-a-half. This also keeps the resolver
   * in step with the CI D13 gate, which discriminates on the same pattern: a
   * malformed key can never leave this function, so the gate cannot be handed a
   * string it red-fails on.
   */
  it.each([
    ['too few hex characters', 'deadbeef.jpg'],
    ['not hex at all', 'not-a-key.jpg'],
    ['a traversal-shaped path', '../../../etc/passwd'],
    ['a relative path', 'art/1.jpg'],
    ['uppercase hex', `${'A1'.repeat(32)}.jpg`],
    ['the sha with no extension', 'a1'.repeat(32)],
    ['the path form the CDN also returns', `/${'a1'.repeat(32)}.jpg`],
    ['a whole URL instead of a key', `https://cdn.hadoku.me/${'a1'.repeat(32)}.jpg`],
  ])('falls back for a cdn row whose key is %s', (_label, key) => {
    const manifest: ArtManifest = { [ID_CDN]: { source: 'cdn', key } };
    expect(isCdnKey(key)).toBe(false);
    expect(resolveArtUrl(ID_CDN, manifest)).toBe(scryfallUrl(ID_CDN));
  });

  it('still resolves a well-formed 64-hex key to the CDN', () => {
    const key = `${'a1'.repeat(32)}.jpg`;
    const manifest: ArtManifest = { [ID_CDN]: { source: 'cdn', key } };
    expect(isCdnKey(key)).toBe(true);
    expect(resolveArtUrl(ID_CDN, manifest)).toBe(`${CDN_BASE}/${key}`);
  });

  it('still returns null when the fallback itself has nothing to build from', () => {
    const manifest = {
      'not-a-uuid': { source: 'commissioned' },
    } as unknown as ArtManifest;
    expect(resolveArtUrl('not-a-uuid', manifest)).toBeNull();
  });

  it('never returns a relative or same-origin URL, whatever the row says', () => {
    const rows = [
      { source: 'cdn', key: KEY_A },
      { source: 'cdn' },
      { source: 'cdn', key: '' },
      { source: 'cdn', key: '../../../etc/passwd' },
      { source: 'cdn', key: '/cardtable/art/1' },
      { source: 'cdn', key: 'deadbeef.jpg' },
      { source: 'scryfall' },
      { source: 'commissioned' },
      { source: '' },
    ];
    for (const row of rows) {
      const manifest = { [ID_CDN]: row } as unknown as ArtManifest;
      const url = resolveArtUrl(ID_CDN, manifest);
      expect(url, JSON.stringify(row)).not.toBeNull();
      expect(
        ALLOWED_ART_HOSTS.some((host) => (url as string).startsWith(`${host}/`)),
        `${JSON.stringify(row)} produced ${String(url)}`,
      ).toBe(true);
    }
  });
});

/*
 * Case 5 — the swap requirement, asserted rather than asserted-to.
 *
 * This is the lane's reason to exist: repointing ONE card must change that
 * card's URL and nothing else's. Asserting it over a single unchanged card
 * would pass for a resolver that ignored the manifest entirely, so it is
 * asserted over every other id in the fixture, byte-for-byte, with the count of
 * compared ids pinned so that deleting a fixture id cannot quietly shrink the
 * test to nothing.
 */
describe('resolveArtUrl — case 5, repointing one card', () => {
  const ALL_IDS = [ID_CDN, ID_CDN_OTHER, ID_SCRYFALL, ID_ABSENT, ID_UNKNOWN_SOURCE];

  const SWAPPED: ArtManifest = { ...MANIFEST, [ID_CDN]: { source: 'cdn', key: KEY_C } };

  it('changes only the repointed card, and changes it to the new key', () => {
    const before = ALL_IDS.map((id) => resolveArtUrl(id, MANIFEST));
    const after = ALL_IDS.map((id) => resolveArtUrl(id, SWAPPED));

    expect(before[0]).toBe(`${CDN_BASE}/${KEY_A}`);
    expect(after[0]).toBe(`${CDN_BASE}/${KEY_C}`);

    const unchanged = ALL_IDS.slice(1);
    expect(unchanged).toHaveLength(4);
    unchanged.forEach((id, i) => {
      expect(after[i + 1], `${id} moved when it should not have`).toBe(before[i + 1]);
    });
  });

  it('works the same when the new source is not the old one', () => {
    // cdn -> scryfall is the re-sourcing direction that actually matters: it is
    // what rolling a bad upload back looks like.
    const rolledBack: ArtManifest = { ...MANIFEST, [ID_CDN]: { source: 'scryfall' } };
    expect(resolveArtUrl(ID_CDN, rolledBack)).toBe(scryfallUrl(ID_CDN));
    for (const id of ALL_IDS.slice(1)) {
      expect(resolveArtUrl(id, rolledBack)).toBe(resolveArtUrl(id, MANIFEST));
    }
  });

  it('adding a row for a previously unlisted card moves only that card', () => {
    const added: ArtManifest = { ...MANIFEST, [ID_ABSENT]: { source: 'cdn', key: KEY_C } };
    expect(resolveArtUrl(ID_ABSENT, MANIFEST)).toBe(scryfallUrl(ID_ABSENT));
    expect(resolveArtUrl(ID_ABSENT, added)).toBe(`${CDN_BASE}/${KEY_C}`);
    for (const id of [ID_CDN, ID_CDN_OTHER, ID_SCRYFALL, ID_UNKNOWN_SOURCE]) {
      expect(resolveArtUrl(id, added)).toBe(resolveArtUrl(id, MANIFEST));
    }
  });
});

describe("resolveArtUrl — a back face's art id", () => {
  const back = `${ID_ABSENT}${BACK_FACE}`;

  it("builds Scryfall's back image for the same card", () => {
    expect(resolveArtUrl(back, MANIFEST)).toBe(`${SCRYFALL_IMAGE_BASE}/normal/back/4/d/${ID_ABSENT}.jpg`);
    expect(resolveArtUrl(back, MANIFEST, { size: 'art_crop' })).toBe(`${SCRYFALL_IMAGE_BASE}/art_crop/back/4/d/${ID_ABSENT}.jpg`);
  });

  it('is repointed by its own manifest row, leaving the front alone', () => {
    const repointed: ArtManifest = { ...MANIFEST, [back]: { source: 'cdn', key: KEY_C } };
    expect(resolveArtUrl(back, repointed)).toBe(`${CDN_BASE}/${KEY_C}`);
    expect(resolveArtUrl(ID_ABSENT, repointed)).toBe(scryfallUrl(ID_ABSENT));
  });

  it('builds nothing for a marker on something that is not a uuid', () => {
    expect(resolveArtUrl(`not-a-uuid${BACK_FACE}`, MANIFEST)).toBeNull();
    expect(resolveArtUrl(BACK_FACE, MANIFEST)).toBeNull();
  });
});

describe('the allowed hosts are the two origins and nothing else', () => {
  it('names exactly the CDN and Scryfall', () => {
    expect([...ALLOWED_ART_HOSTS].sort()).toEqual([SCRYFALL_IMAGE_BASE, CDN_BASE].sort());
    expect(ALLOWED_ART_HOSTS).toHaveLength(2);
  });

  it('every default-options URL in the fixture lands on one of them', () => {
    const ids = [ID_CDN, ID_CDN_OTHER, ID_SCRYFALL, ID_ABSENT, ID_UNKNOWN_SOURCE];
    const urls = ids.map((id) => resolveArtUrl(id, MANIFEST));
    expect(urls.every((u) => u !== null)).toBe(true);
    for (const url of urls) {
      expect(ALLOWED_ART_HOSTS.some((h) => (url as string).startsWith(`${h}/`))).toBe(true);
    }
  });
});

describe('isCdnKey / cdnUrlFor', () => {
  it('accepts a sha256 plus extension and rejects everything else', () => {
    expect(isCdnKey(KEY_A)).toBe(true);
    expect(isCdnKey(undefined)).toBe(false);
    expect(isCdnKey('')).toBe(false);
    expect(isCdnKey('a1'.repeat(32))).toBe(false); // no extension
    expect(isCdnKey(`${'A1'.repeat(32)}.jpg`)).toBe(false); // uppercase is not the shape
    expect(isCdnKey(`https://cdn.hadoku.me/${KEY_A}`)).toBe(false); // a URL is not a key
  });

  it('composes against CDN_BASE by default', () => {
    expect(cdnUrlFor(KEY_A)).toBe(`${CDN_BASE}/${KEY_A}`);
    expect(cdnUrlFor(KEY_A, 'https://other.test/')).toBe(`https://other.test/${KEY_A}`);
  });

  /*
   * A deliberate division of labour, pinned so nobody "hardens" it by accident.
   * `cdnUrlFor` composes and does not judge; `resolveArtUrl` judges, with
   * `isCdnKey`, at the one place untrusted hand-edited JSON enters. The upload
   * CLI gets its key back from the CDN itself, where it is well-formed by
   * construction, and should not have to null-check a case that cannot arise.
   */
  it('cdnUrlFor stays a dumb composer — the resolver is what guards', () => {
    expect(cdnUrlFor('deadbeef.jpg')).toBe(`${CDN_BASE}/deadbeef.jpg`);
    expect(cdnUrlFor(`/${KEY_A}`)).toBe(`${CDN_BASE}/${KEY_A}`);
    // ...and the resolver refuses to hand it either of those in the first place.
    const bad: ArtManifest = { [ID_CDN]: { source: 'cdn', key: 'deadbeef.jpg' } };
    expect(resolveArtUrl(ID_CDN, bad)).not.toContain(CDN_BASE);
  });
});
