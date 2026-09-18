/*
 * The library, checked without the corpus.
 *
 * `packages/carddata/data/cards.jsonl` is 183 MB, gitignored and absent in CI,
 * so these tests run against `decks/pools/*.generated.json` — pools computed by
 * `build-pool-fixture.ts` from that corpus and committed. Nothing here is
 * conditional and nothing here skips: a test that stands down when its data is
 * missing is a green gate that checks nothing, and this repo has found five of
 * those. The real-corpus run is `validate-library.ts`, by hand, and its result
 * is reported rather than asserted.
 *
 * Reading files is allowed here and nowhere else in this package: test files
 * are node programs (`index.ts`'s last paragraph), and the modules under test
 * take text.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { standardFormatAt } from '@hadoku/carddata/formats';

import { writePrebuiltDeck } from '../prebuilt.ts';
import {
  LIBRARY,
  PT_PARIS_2011_STANDARD,
  deckPath,
  libraryDeckPaths,
  poolFixturePath,
} from './catalog.ts';
import {
  LibraryDeckError,
  libraryIssues,
  libraryPoolMismatch,
  loadLibraryDeck,
  type LibraryDeck,
} from './library.ts';
import {
  parsePoolFixture,
  poolFromFixture,
  PoolFixtureError,
  type PoolFixture,
} from './pool-fixture.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(repoRelative: string): string {
  return readFileSync(join(REPO_ROOT, repoRelative), 'utf8');
}

function fixture(date: string): PoolFixture {
  return parsePoolFixture(JSON.parse(read(poolFixturePath(date))));
}

const PT_PARIS = PT_PARIS_2011_STANDARD;
const DECK_TEXTS = new Map(PT_PARIS.decks.map((d) => [d.id, read(deckPath(PT_PARIS, d))]));

function deckOf(id: string): LibraryDeck {
  const text = DECK_TEXTS.get(id);
  if (text === undefined) throw new Error(`no deck text for ${id}`);
  return loadLibraryDeck(text);
}

describe('the catalog and the files agree', () => {
  it('lists every .dck in the collection directory, and no others', () => {
    const onDisk = readdirSync(join(REPO_ROOT, PT_PARIS.directory))
      .filter((f) => f.endsWith('.dck'))
      .sort();
    const catalogued = PT_PARIS.decks.map((d) => d.file).sort();
    expect(onDisk).toEqual(catalogued);
  });

  it('is the complete Top 8 and nothing else', () => {
    expect(PT_PARIS.decks).toHaveLength(8);
    expect(new Set(PT_PARIS.decks.map((d) => d.id)).size).toBe(8);
    // `libraryDeckPaths()` spans the WHOLE library, not this collection — so it
    // is 8 per collection. Asserting the collection's own count against a
    // library-wide total held only while there was one collection, and broke
    // the moment a second landed (PT Dark Ascension, 2026-09-18).
    expect(libraryDeckPaths()).toHaveLength(LIBRARY.reduce((n, c) => n + c.decks.length, 0));
  });

  it('files every deck under the format and date the collection claims', () => {
    for (const entry of PT_PARIS.decks) {
      const deck = deckOf(entry.id);
      expect(deck.format, entry.id).toBe(PT_PARIS.format);
      expect(deck.date, entry.id).toBe(PT_PARIS.date);
    }
  });
});

describe('every deck loads, with a citation', () => {
  it.each(PT_PARIS.decks.map((d) => d.id))('%s', (id) => {
    const deck = deckOf(id);
    expect(deck.name.length).toBeGreaterThan(0);
    // The citation has to be checkable by a person, which means a URL and not a
    // sentence. mtgtop8 deck ids are the finest granularity the source offers.
    expect(deck.citation).toMatch(/^https:\/\/www\.mtgtop8\.com\/event\?e=1016&d=\d+&f=ST$/);
    expect(deck.provenance).toContain('Pro Tour Paris 2011');
    expect(deck.provenance).toMatch(/Transcribed from mtgtop8 deck \d+\.$/);
  });

  it('round-trips byte-for-byte through the writer', () => {
    for (const entry of PT_PARIS.decks) {
      const text = read(deckPath(PT_PARIS, entry));
      expect(writePrebuiltDeck(loadLibraryDeck(text)), entry.file).toBe(text);
    }
  });

  it('is a 60-card deck with a 15-card sideboard, as a Pro Tour deck must be', () => {
    for (const entry of PT_PARIS.decks) {
      const deck = deckOf(entry.id);
      const count = (section: string): number =>
        (deck.file.sections.get(section) ?? []).reduce((sum, e) => sum + e.count, 0);
      expect(count('main'), entry.id).toBe(60);
      expect(count('sideboard'), entry.id).toBe(15);
    }
  });
});

describe('the committed pool fixtures', () => {
  it('agree with the rotation table about which snapshot was in force', () => {
    // The fixture's card list needs the corpus; its FORMAT block does not —
    // `standardFormatAt` answers from the committed 154-row table alone. So this
    // is the one join that can be checked in CI, and it is the join that would
    // break if a fixture were regenerated for the wrong date.
    for (const date of [PT_PARIS.date, '2011-07-01']) {
      const frozen = fixture(date);
      const live = standardFormatAt(date);
      expect(live.ok, date).toBe(true);
      if (!live.ok) continue;
      expect(frozen.name, date).toBe(live.name);
      expect(frozen.effective, date).toBe(live.effective);
      expect(frozen.source, date).toBe(live.source);
      expect(frozen.sets, date).toEqual([...live.setList]);
      expect(frozen.banned, date).toEqual([...live.banned]);
    }
  });

  it('carries the pool the library needs: Standard (MBS), 1204 cards, nothing banned', () => {
    const frozen = fixture(PT_PARIS.date);
    expect(frozen.name).toBe('Standard (MBS)');
    expect(frozen.effective).toBe('2011-02-04');
    expect(frozen.cards).toHaveLength(1204);
    expect(frozen.banned).toEqual([]);
    expect(new Set(frozen.cards).size).toBe(1204);
  });

  it('carries the post-ban pool too: 1367 cards, Jace and Stoneforge removed', () => {
    const frozen = fixture('2011-07-01');
    expect(frozen.cards).toHaveLength(1367);
    expect(frozen.banned).toEqual(['Jace, the Mind Sculptor', 'Stoneforge Mystic']);
    for (const banned of frozen.banned) expect(frozen.cards).not.toContain(banned);
    // New Phyrexia joined between the two dates, which is why the later pool is
    // bigger despite losing two cards.
    expect(frozen.sets).toContain('NPH');
  });

  it('refuses a fixture that is missing fields, naming every one', () => {
    expect(() => parsePoolFixture({ date: '2011-02-13' })).toThrow(PoolFixtureError);
    try {
      parsePoolFixture({ date: '2011-02-13' });
      expect.unreachable('a fixture with one field should not parse');
    } catch (error) {
      const message = (error as Error).message;
      for (const key of ['name', 'effective', 'source', 'sets', 'banned', 'cards']) {
        expect(message).toContain(`\`${key}\``);
      }
    }
  });

  it('refuses an empty pool, which passes every shape check and fails every deck', () => {
    const empty = { ...fixture(PT_PARIS.date), cards: [] };
    expect(() => parsePoolFixture(empty)).toThrow(/`cards` is empty/);
  });
});

describe('validating the library against its own pool', () => {
  it('finds every deck legal in Standard (MBS) on 2011-02-13', () => {
    const pool = poolFromFixture(fixture(PT_PARIS.date));
    for (const entry of PT_PARIS.decks) {
      const deck = deckOf(entry.id);
      expect(libraryPoolMismatch(deck, pool), entry.id).toBeNull();
      expect(libraryIssues(deck, pool).map((i) => i.message), entry.id).toEqual([]);
    }
  });

  it('says so when the pool is for a different format', () => {
    const deck = deckOf('pt-paris-2011-1-ben-stark');
    const later = poolFromFixture(fixture('2011-07-01'));
    expect(libraryPoolMismatch(deck, later)).toBe(
      'deck "Mystic Caw Go (Ben Stark)" is built for "Standard (MBS)" as of 2011-02-13, but the pool supplied is "Standard (2011-07-01)"',
    );
  });
});

describe('the failure path, named card by card', () => {
  /**
   * The ban path, on real data. Nothing here is tampered with: these are the
   * lists as played, checked against the Standard that took effect on
   * 2011-07-01, which banned Jace, the Mind Sculptor and Stoneforge Mystic
   * (`Archived/Standard/2011-07-01.txt`). Every one of the eight played at
   * least one of the two, which is a fair description of why they were banned.
   */
  const EXPECTED_BANNED: Readonly<Record<string, readonly string[]>> = {
    'pt-paris-2011-1-ben-stark': [
      'plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans',
      'plays 4x Stoneforge Mystic, which Standard (2011-07-01) bans',
    ],
    'pt-paris-2011-2-paul-rietzl': [
      'plays 3x Stoneforge Mystic, which Standard (2011-07-01) bans',
    ],
    'pt-paris-2011-3-vincent-lemoine': [
      'plays 4x Stoneforge Mystic, which Standard (2011-07-01) bans',
    ],
    'pt-paris-2011-4-naoki-nakada': [
      'plays 2x Stoneforge Mystic, which Standard (2011-07-01) bans',
      'plays 3x Jace, the Mind Sculptor, which Standard (2011-07-01) bans',
    ],
    'pt-paris-2011-5-nico-bohny': [
      'plays 1x Stoneforge Mystic, which Standard (2011-07-01) bans',
    ],
    'pt-paris-2011-6-tom-martell': [
      'plays 4x Stoneforge Mystic, which Standard (2011-07-01) bans',
      'plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans',
    ],
    'pt-paris-2011-7-shintaro-ishimura': [
      'plays 4x Stoneforge Mystic, which Standard (2011-07-01) bans',
      'plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans',
    ],
    'pt-paris-2011-8-patrick-chapin': [
      'plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans',
    ],
  };

  it('reports which card is banned, and how many, for all eight decks', () => {
    const pool = poolFromFixture(fixture('2011-07-01'));
    let total = 0;
    for (const entry of PT_PARIS.decks) {
      const issues = libraryIssues(deckOf(entry.id), pool);
      expect(issues.map((i) => i.kind), entry.id).toEqual(issues.map(() => 'banned'));
      expect(issues.map((i) => i.message), entry.id).toEqual(EXPECTED_BANNED[entry.id]);
      total += issues.length;
    }
    // 12 is the number `validate-library.ts` reports against the real corpus.
    expect(total).toBe(12);
  });

  it('reports which card is not in the pool, and that it is not a ban', () => {
    // Derived from a real list rather than invented, so what is being tested is
    // one swapped card and not a hand-built deck's shape. Birthing Pod is New
    // Phyrexia: legal from 2011-05-13, three months after this tournament.
    const tampered = DECK_TEXTS.get('pt-paris-2011-1-ben-stark')!.replace(
      '4 Preordain|M11',
      '4 Birthing Pod|NPH',
    );
    expect(tampered).not.toBe(DECK_TEXTS.get('pt-paris-2011-1-ben-stark'));

    const february = fixture(PT_PARIS.date);
    const july = fixture('2011-07-01');
    // The card is genuinely outside the pool on the deck's date and genuinely
    // inside it later. Neither half is assumed.
    expect(february.cards).not.toContain('Birthing Pod');
    expect(july.cards).toContain('Birthing Pod');

    const issues = libraryIssues(loadLibraryDeck(tampered), poolFromFixture(february));
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('not-in-pool');
    expect(issues[0].cardName).toBe('Birthing Pod');
    expect(issues[0].count).toBe(4);
    expect(issues[0].message).toBe('plays 4x Birthing Pod, which is not in Standard (MBS)');
  });

  it('reports a copy-limit break by card and by number', () => {
    const tampered = DECK_TEXTS.get('pt-paris-2011-1-ben-stark')!
      .replace('4 Preordain|M11', '5 Preordain|M11')
      .replace('3 Mana Leak|M11', '2 Mana Leak|M11');
    const issues = libraryIssues(loadLibraryDeck(tampered), poolFromFixture(fixture(PT_PARIS.date)));
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('over-the-copy-limit');
    expect(issues[0].message).toBe('plays 5x Preordain, but Standard (MBS) allows 4');
  });
});

describe('a deck that cannot be traced does not load', () => {
  const BEN_STARK = () => DECK_TEXTS.get('pt-paris-2011-1-ben-stark') as string;

  it('refuses a deck with no Source URL', () => {
    const stripped = BEN_STARK()
      .split('\n')
      .filter((l) => !l.startsWith('Source URL='))
      .join('\n');
    expect(() => loadLibraryDeck(stripped)).toThrow(LibraryDeckError);
    expect(() => loadLibraryDeck(stripped)).toThrow(/needs a citation \(metadata key `Source URL`\)/);
  });

  it('names the citation and the provenance together when both are gone', () => {
    const stripped = BEN_STARK()
      .split('\n')
      .filter((l) => !l.startsWith('Source URL=') && !l.startsWith('Comment='))
      .join('\n');
    expect(() => loadLibraryDeck(stripped)).toThrow(
      /needs a citation \(metadata key `Source URL`\), and a provenance line \(metadata key `Comment`\)/,
    );
  });

  it('re-throws a prebuilt fault as a library fault, message intact', () => {
    const stripped = BEN_STARK()
      .split('\n')
      .filter((l) => !l.startsWith('Effective='))
      .join('\n');
    expect(() => loadLibraryDeck(stripped)).toThrow(LibraryDeckError);
    expect(() => loadLibraryDeck(stripped)).toThrow(/needs a date \(metadata key `Effective`, YYYY-MM-DD\)/);
  });

  it('accepts overrides for a file that predates the convention', () => {
    const stripped = BEN_STARK()
      .split('\n')
      .filter((l) => !l.startsWith('Source URL=') && !l.startsWith('Comment='))
      .join('\n');
    const deck = loadLibraryDeck(stripped, { citation: 'https://example.invalid/x', provenance: 'somewhere' });
    expect(deck.citation).toBe('https://example.invalid/x');
    expect(deck.provenance).toBe('somewhere');
  });
});

describe('the library as a whole', () => {
  // Pins the library's exact shape on purpose, so adding a collection is a
  // deliberate act with a visible diff rather than something that drifts in.
  // It caught the 2026-09-18 addition of PT Dark Ascension, which is what it is
  // for — the failure was the test doing its job, not a regression.
  it('is two collections, sixteen decks, one per format', () => {
    expect(LIBRARY).toHaveLength(2);
    expect(LIBRARY.flatMap((c) => c.decks)).toHaveLength(16);
    expect(LIBRARY.map((c) => c.format)).toEqual(['Standard (MBS)', 'Standard (DKA)']);
  });

  it('every collection is a complete Top 8', () => {
    for (const c of LIBRARY) expect(c.decks, c.id).toHaveLength(8);
  });

  it('every deck id is unique across collections', () => {
    const ids = LIBRARY.flatMap((c) => c.decks.map((d) => d.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
