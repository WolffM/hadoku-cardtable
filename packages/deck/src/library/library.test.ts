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
 *
 * ## Wave 34: nine power-summer eras
 *
 * This file used to pin eight mid-season tournament collections and 49 decks.
 * The library is now nine eras, one per year 2008-2016, 96 decks chosen for
 * colour and style spread rather than a hand-picked Top 8 — `catalog.ts`'s
 * header and `docs/planning/deck-selection/` have the full story. The tests
 * below are the same shape, generalised from "one named collection" to "every
 * collection in `LIBRARY`", because there is no longer one collection worth
 * singling out.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { formatAtFamily } from '@hadoku/carddata/formats';

import { poolNameKeys } from '../format.ts';
import { writePrebuiltDeck } from '../prebuilt.ts';
import {
  LIBRARY,
  POOL_FIXTURE_KEYS,
  deckPath,
  libraryDeckPaths,
  poolFixturePath,
  type FormatFamily,
  type LibraryCollection,
  type LibraryEntry,
} from './catalog.ts';
import { deckCostsModule, libraryCardCosts, libraryCardNames } from './build-deck-costs.ts';
import { LIBRARY_CARD_COSTS } from './deck-costs.generated.ts';
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

function fixture(date: string, family: FormatFamily = 'standard'): PoolFixture {
  return parsePoolFixture(JSON.parse(read(poolFixturePath(date, family))));
}

/** Every deck in the library, with the collection it is filed under. */
const ALL_DECKS = LIBRARY.flatMap((c) => c.decks.map((entry) => ({ collection: c, entry })));

function libraryDeckOf(collection: LibraryCollection, entry: LibraryEntry): LibraryDeck {
  return loadLibraryDeck(read(deckPath(collection, entry)));
}

function sectionCount(deck: LibraryDeck, section: string): number {
  return (deck.file.sections.get(section) ?? []).reduce((sum, e) => sum + e.count, 0);
}

/** `Caw-Blade (Marcello Calvetta)` → `Caw-Blade`. The file's own `Name` is the copy that counts. */
function archetypeOf(deck: LibraryDeck): string {
  const matched = /^(.*) \([^()]+\)$/.exec(deck.name);
  if (matched === null) throw new Error(`deck name "${deck.name}" is not "Archetype (Player)"`);
  return matched[1] as string;
}

const CITATION = /^https:\/\/www\.mtgtop8\.com\/event\?e=\d+&d=\d+&f=(ST|MO|LE)$/;

/* ── a deck to tamper with, picked once and reused by name ──────────────── */

// Looked up by id rather than `LIBRARY[0]` — wave 48 §T put 2003-2007 ahead of
// 2008 in catalog order (oldest first), so the index that used to BE 2008 no
// longer is.
const POWER_SUMMER_2008 = LIBRARY.find((c) => c.id === 'power-summer-2008') as LibraryCollection;
const RED_DECK_WINS = POWER_SUMMER_2008.decks.find((d) => d.id === 'power-2008-1-michael-jacob-red-deck-wins')!;
function redDeckWinsText(): string {
  return read(deckPath(POWER_SUMMER_2008, RED_DECK_WINS));
}

describe('every collection: catalog, files and citations agree', () => {
  it.each(LIBRARY.map((c) => c.id))('%s lists every .dck in its directory, and no others', (id) => {
    const c = LIBRARY.find((x) => x.id === id) as LibraryCollection;
    const onDisk = readdirSync(join(REPO_ROOT, c.directory))
      .filter((f) => f.endsWith('.dck'))
      .sort();
    expect(onDisk).toEqual(c.decks.map((d) => d.file).sort());
  });

  it.each(ALL_DECKS.map(({ collection, entry }) => [collection.id, entry.id] as const))(
    '%s / %s is filed under its collection, cites its event, and is a legal size',
    (collectionId, entryId) => {
      const c = LIBRARY.find((x) => x.id === collectionId) as LibraryCollection;
      const entry = c.decks.find((d) => d.id === entryId) as LibraryEntry;
      const deck = libraryDeckOf(c, entry);
      expect(deck.format).toBe(c.format);
      expect(deck.date).toBe(c.date);
      expect(deck.citation).toMatch(CITATION);
      expect(deck.provenance).toMatch(/Transcribed from mtgtop8 deck \d+\.$/);
      // The citation and the provenance name the same mtgtop8 deck.
      const cited = /&d=(\d+)&/.exec(deck.citation)?.[1];
      expect(deck.provenance).toContain(`mtgtop8 deck ${String(cited)}.`);
      // 60 is a minimum, not a target — a handful of these decks registered 61.
      expect(sectionCount(deck, 'main')).toBeGreaterThanOrEqual(60);
      expect(sectionCount(deck, 'sideboard')).toBeLessThanOrEqual(15);
      expect(writePrebuiltDeck(deck)).toBe(read(deckPath(c, entry)));
    },
  );
});

describe('every deck loads, with a citation', () => {
  it.each(ALL_DECKS.map(({ collection, entry }) => [collection.id, entry.id] as const))(
    '%s / %s',
    (collectionId, entryId) => {
      const c = LIBRARY.find((x) => x.id === collectionId) as LibraryCollection;
      const entry = c.decks.find((d) => d.id === entryId) as LibraryEntry;
      const deck = libraryDeckOf(c, entry);
      expect(deck.name.length).toBeGreaterThan(0);
      expect(deck.citation).toMatch(CITATION);
      expect(deck.provenance).toMatch(/Transcribed from mtgtop8 deck \d+\.$/);
    },
  );
});

describe('the committed pool fixtures', () => {
  it('agree with the rotation table about which snapshot was in force, for every family', () => {
    // The fixture's card list needs the corpus; its FORMAT block does not —
    // `formatAtFamily` answers from the committed rotation table alone. So
    // this is the one join that can be checked in CI, and it is the join that
    // would break if a fixture were regenerated for the wrong date or family.
    for (const { family, date } of POOL_FIXTURE_KEYS) {
      const frozen = fixture(date, family);
      const live = formatAtFamily(family, date);
      const label = `${family} ${date}`;
      expect(live.ok, label).toBe(true);
      if (!live.ok) continue;
      expect(frozen.name, label).toBe(live.name);
      expect(frozen.effective, label).toBe(live.effective);
      expect(frozen.source, label).toBe(live.source);
      expect(frozen.sets, label).toEqual([...live.setList]);
      expect(frozen.banned, label).toEqual([...live.banned]);
    }
  });

  it('is exactly one fixture per catalogued collection, even where two families share a date', () => {
    // Modern/Legacy eras are pinned to Standard's own dates (Settled), so the
    // DATE alone is not unique across the library — (family, date) is.
    expect(POOL_FIXTURE_KEYS).toEqual(LIBRARY.map((c) => ({ family: c.family, date: c.date })));
    expect(new Set(POOL_FIXTURE_KEYS.map((k) => `${k.family}:${k.date}`)).size).toBe(LIBRARY.length);
  });

  it('the 2011 pool carries the Jace/Stoneforge ban this era’s window crosses', () => {
    const frozen = fixture('2011-07-15');
    expect(frozen.name).toBe('Standard (M12)');
    expect(frozen.banned).toEqual(['Jace, the Mind Sculptor', 'Stoneforge Mystic']);
    for (const banned of frozen.banned) expect(frozen.cards).not.toContain(banned);
  });

  it('refuses a fixture that is missing fields, naming every one', () => {
    expect(() => parsePoolFixture({ date: '2008-07-25' })).toThrow(PoolFixtureError);
    try {
      parsePoolFixture({ date: '2008-07-25' });
      expect.unreachable('a fixture with one field should not parse');
    } catch (error) {
      const message = (error as Error).message;
      for (const key of ['name', 'effective', 'source', 'sets', 'banned', 'cards']) {
        expect(message).toContain(`\`${key}\``);
      }
    }
  });

  it('refuses an empty pool, which passes every shape check and fails every deck', () => {
    const empty = { ...fixture(LIBRARY[0]!.date), cards: [] };
    expect(() => parsePoolFixture(empty)).toThrow(/`cards` is empty/);
  });
});

describe('validating the library against its own pool', () => {
  // One test per deck, named, so a list that stops validating fails by name.
  it.each(ALL_DECKS.map(({ collection, entry }) => [collection.id, entry.id] as const))(
    '%s / %s is legal in its own era\'s frozen pool',
    (collectionId, entryId) => {
      const c = LIBRARY.find((x) => x.id === collectionId) as LibraryCollection;
      const entry = c.decks.find((d) => d.id === entryId) as LibraryEntry;
      const pool = poolFromFixture(fixture(c.date, c.family));
      expect(pool.name).toBe(c.format);
      const deck = libraryDeckOf(c, entry);
      expect(libraryPoolMismatch(deck, pool)).toBeNull();
      expect(libraryIssues(deck, pool).map((i) => i.message)).toEqual([]);
    },
  );

  it('says so when the pool is for a different format', () => {
    const deck = libraryDeckOf(POWER_SUMMER_2008, RED_DECK_WINS);
    const laterPool = poolFromFixture(fixture('2011-07-15'));
    expect(libraryPoolMismatch(deck, laterPool)).toBe(
      'deck "Red Deck Wins (Michael Jacob)" is built for "Standard (EVE)" as of 2008-07-25, but the pool supplied is "Standard (M12)"',
    );
  });
});

describe('the failure path, named card by card', () => {
  /**
   * Real cross-era data, not a tampered list: 2010's UG Polymorph (Antoine
   * Ruel) plays four Jace, the Mind Sculptor, legal in `Standard (M11)`
   * (2010-07-16). Checked against `Standard (M12)` (2011-07-15), a year on, it
   * is illegal twice over — genuinely, not by invention: Essence Scatter and
   * Polymorph were M10 cards that had rotated out by then, and the Jace that
   * survived rotation was banned the same day M12 took effect. A deck that
   * ages out this way across two real rules changes is worth more here than a
   * tampered list with one fault.
   */
  it('reports a real card as banned, and rotation-illegal, when checked against a LATER era', () => {
    const c2010 = LIBRARY.find((x) => x.id === 'power-summer-2010') as LibraryCollection;
    const ugPolymorph = c2010.decks.find((d) => d.id === 'power-2010-3-antoine-ruel-ug-polymorph') as LibraryEntry;
    const deck = libraryDeckOf(c2010, ugPolymorph);
    expect(sectionCount(deck, 'main')).toBeGreaterThanOrEqual(60);

    const laterPool = poolFromFixture(fixture('2011-07-15'));
    const issues = libraryIssues(deck, laterPool);
    expect(issues.map((i) => [i.kind, i.message])).toEqual([
      ['not-in-pool', 'plays 1x Essence Scatter, which is not in Standard (M12)'],
      ['not-in-pool', 'plays 4x Polymorph, which is not in Standard (M12)'],
      ['banned', 'plays 4x Jace, the Mind Sculptor, which Standard (M12) bans'],
    ]);
  });

  it('reports which card is not in the pool, and that it is not a ban', () => {
    // Derived from a real list rather than invented, so what is being tested is
    // one swapped card and not a hand-built deck's shape. Birthing Pod is New
    // Phyrexia: legal from 2011-05-13, three years after this 2008 deck.
    const original = redDeckWinsText();
    const tampered = original.replace('4 Skred|CSP', '4 Birthing Pod|NPH');
    expect(tampered).not.toBe(original);

    const pool2008 = fixture('2008-07-25');
    const pool2012 = fixture('2012-07-13');
    expect(pool2008.cards).not.toContain('Birthing Pod');
    expect(pool2012.cards).toContain('Birthing Pod');

    const issues = libraryIssues(loadLibraryDeck(tampered), poolFromFixture(pool2008));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('not-in-pool');
    expect(issues[0]!.cardName).toBe('Birthing Pod');
    expect(issues[0]!.count).toBe(4);
    expect(issues[0]!.message).toBe('plays 4x Birthing Pod, which is not in Standard (EVE)');
  });

  it('reports a copy-limit break by card and by number', () => {
    const original = redDeckWinsText();
    const tampered = original
      .replace('4 Flame Javelin|SHM', '5 Flame Javelin|SHM')
      .replace('4 Incinerate|10E', '3 Incinerate|10E');
    const issues = libraryIssues(loadLibraryDeck(tampered), poolFromFixture(fixture('2008-07-25')));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('over-the-copy-limit');
    expect(issues[0]!.message).toBe('plays 5x Flame Javelin, but Standard (EVE) allows 4');
  });

  /**
   * 2008 is the only era with Coldsnap legal, and five of its twelve decks play
   * more than four of one snow-covered basic — `pool-fixture.ts`'s
   * `SNOW_BASIC_LAND_NAMES` is why that is not a false `over-the-copy-limit`.
   * Reverting that exemption and re-running this one is this fix's mutation
   * test (see the lane report).
   */
  it('does not flag a snow-covered basic over 4 copies as over the limit', () => {
    const deck = libraryDeckOf(POWER_SUMMER_2008, RED_DECK_WINS);
    expect(deck.file.sections.get('main')?.some((e) => e.card.name === 'Snow-Covered Mountain' && e.count === 22)).toBe(true);
    const issues = libraryIssues(deck, poolFromFixture(fixture('2008-07-25')));
    expect(issues).toEqual([]);
  });
});

describe('a deck that cannot be traced does not load', () => {
  const ORIGINAL = redDeckWinsText;

  it('refuses a deck with no Source URL', () => {
    const stripped = ORIGINAL()
      .split('\n')
      .filter((l) => !l.startsWith('Source URL='))
      .join('\n');
    expect(() => loadLibraryDeck(stripped)).toThrow(LibraryDeckError);
    expect(() => loadLibraryDeck(stripped)).toThrow(/needs a citation \(metadata key `Source URL`\)/);
  });

  it('names the citation and the provenance together when both are gone', () => {
    const stripped = ORIGINAL()
      .split('\n')
      .filter((l) => !l.startsWith('Source URL=') && !l.startsWith('Comment='))
      .join('\n');
    expect(() => loadLibraryDeck(stripped)).toThrow(
      /needs a citation \(metadata key `Source URL`\), and a provenance line \(metadata key `Comment`\)/,
    );
  });

  it('re-throws a prebuilt fault as a library fault, message intact', () => {
    const stripped = ORIGINAL()
      .split('\n')
      .filter((l) => !l.startsWith('Effective='))
      .join('\n');
    expect(() => loadLibraryDeck(stripped)).toThrow(LibraryDeckError);
    expect(() => loadLibraryDeck(stripped)).toThrow(/needs a date \(metadata key `Effective`, YYYY-MM-DD\)/);
  });

  it('accepts overrides for a file that predates the convention', () => {
    const stripped = ORIGINAL()
      .split('\n')
      .filter((l) => !l.startsWith('Source URL=') && !l.startsWith('Comment='))
      .join('\n');
    const deck = loadLibraryDeck(stripped, { citation: 'https://example.invalid/x', provenance: 'somewhere' });
    expect(deck.citation).toBe('https://example.invalid/x');
    expect(deck.provenance).toBe('somewhere');
  });
});

describe('the library as a whole', () => {
  // Pins the library's exact shape on purpose, so adding or changing an era is
  // a deliberate act with a visible diff rather than something that drifts in.
  // Wave 34 replaced the previous pin (eight collections, 49 decks) wholesale:
  // nine power-summer eras, 2008-2016, 96 decks. Wave 48 §T extended Standard
  // back to 2003 and added Modern (2012-2016, §M) and Legacy (2005-2016, §L):
  // 31 eras across three families, 338 decks. 2026-10-10 doubled the target to
  // 24 per era (the operator: "can you try to get 24?") and kept every one of
  // the 338: 676 decks. Thin seasons (fewer than 24 legal, distinct
  // candidates on mtgtop8, competitive and regular events both — not padded):
  // Standard 2003 (8), 2005 (7) and 2009 (11); Legacy 2005 (9) and 2006 (17).
  // Every other era is 24.
  it('is thirty-one eras across three families and 676 decks, oldest first within each family', () => {
    expect(LIBRARY.map((c) => [c.id, c.family, c.format, c.date, c.decks.length])).toEqual([
      ['power-summer-2003', 'standard', 'Standard (8ED)', '2003-09-01', 8],
      ['power-summer-2004', 'standard', 'Standard (5DN)', '2004-06-20', 24],
      ['power-summer-2005', 'standard', 'Standard (9ED)', '2005-08-20', 7],
      ['power-summer-2006', 'standard', 'Standard (CSP)', '2006-08-20', 24],
      ['power-summer-2007', 'standard', 'Standard (10E)', '2007-07-20', 24],
      ['power-summer-2008', 'standard', 'Standard (EVE)', '2008-07-25', 24],
      ['power-summer-2009', 'standard', 'Standard (M10)', '2009-07-17', 11],
      ['power-summer-2010', 'standard', 'Standard (M11)', '2010-07-16', 24],
      ['power-summer-2011', 'standard', 'Standard (M12)', '2011-07-15', 24],
      ['power-summer-2012', 'standard', 'Standard (M13)', '2012-07-13', 24],
      ['power-summer-2013', 'standard', 'Standard (M14)', '2013-07-19', 24],
      ['power-summer-2014', 'standard', 'Standard (M15)', '2014-07-18', 24],
      ['power-summer-2015', 'standard', 'Standard (ORI)', '2015-07-17', 24],
      ['power-summer-2016', 'standard', 'Standard (EMN)', '2016-07-22', 24],
      ['power-summer-modern-2012', 'modern', 'Modern (M13)', '2012-07-13', 24],
      ['power-summer-modern-2013', 'modern', 'Modern (M14)', '2013-07-19', 24],
      ['power-summer-modern-2014', 'modern', 'Modern (M15)', '2014-07-18', 24],
      ['power-summer-modern-2015', 'modern', 'Modern (ORI)', '2015-07-17', 24],
      ['power-summer-modern-2016', 'modern', 'Modern (EMN)', '2016-07-22', 24],
      ['power-summer-legacy-2005', 'legacy', 'Legacy (9ED)', '2005-08-20', 9],
      ['power-summer-legacy-2006', 'legacy', 'Legacy (CSP)', '2006-08-20', 17],
      ['power-summer-legacy-2007', 'legacy', 'Legacy (10E)', '2007-07-20', 24],
      ['power-summer-legacy-2008', 'legacy', 'Legacy (EVE)', '2008-07-25', 24],
      ['power-summer-legacy-2009', 'legacy', 'Legacy (M10)', '2009-07-17', 24],
      ['power-summer-legacy-2010', 'legacy', 'Legacy (M11)', '2010-07-16', 24],
      ['power-summer-legacy-2011', 'legacy', 'Legacy (M12)', '2011-07-15', 24],
      ['power-summer-legacy-2012', 'legacy', 'Legacy (M13)', '2012-07-13', 24],
      ['power-summer-legacy-2013', 'legacy', 'Legacy (M14)', '2013-07-19', 24],
      ['power-summer-legacy-2014', 'legacy', 'Legacy (M15)', '2014-07-18', 24],
      ['power-summer-legacy-2015', 'legacy', 'Legacy (ORI)', '2015-07-17', 24],
      ['power-summer-legacy-2016', 'legacy', 'Legacy (EMN)', '2016-07-22', 24],
    ]);
    expect(ALL_DECKS).toHaveLength(676);
    expect(libraryDeckPaths()).toHaveLength(676);
  });

  it('is oldest-first WITHIN each family, in Standard/Modern/Legacy order', () => {
    // Settled (wave 48 plan): catalog order is oldest-first within a family.
    // Across families, T chose Standard, then Modern, then Legacy — the order
    // Standard already had, with the two new families appended after it.
    const families = LIBRARY.map((c) => c.family);
    const firstModern = families.indexOf('modern');
    const firstLegacy = families.indexOf('legacy');
    expect(families.slice(0, firstModern).every((f) => f === 'standard')).toBe(true);
    expect(families.slice(firstModern, firstLegacy).every((f) => f === 'modern')).toBe(true);
    expect(families.slice(firstLegacy).every((f) => f === 'legacy')).toBe(true);
    for (const family of ['standard', 'modern', 'legacy'] as const) {
      const dates = LIBRARY.filter((c) => c.family === family).map((c) => c.date);
      expect(dates, family).toEqual([...dates].sort());
    }
  });

  it('every archetype appears once within its own era', () => {
    for (const c of LIBRARY) {
      const archetypes = c.decks.map((d) => archetypeOf(libraryDeckOf(c, d)));
      expect(new Set(archetypes).size, `${c.id}: ${archetypes.join(', ')}`).toBe(archetypes.length);
    }
  });

  // The five-colour rule the selection searched for, checked here the same way
  // `review/README.md` describes it being judged: a basic land in at least one
  // maindeck is the plainest evidence a deck plays that colour. Not every era
  // can hit all five with 4-12 decks (2009's four decks field only four
  // colours — `review/2009.md` records it), so this reports rather than
  // requires five, except where the review table says an era has all five.
  // Every era EXCEPT the four thinnest ones (fewer than 8 chosen decks):
  // Standard 2009 (4) and 2010 (8, misses one colour anyway) and Legacy 2005
  // (4, no black deck at all) do not field all five — checked directly off
  // the basics each era's decks actually play, not assumed from deck count.
  // Modern has no thin era (every one of its five is 12 decks, all five
  // colours) — wave 48 §M found no season that thin.
  const FIVE_COLOUR_ERAS = new Set([
    'power-summer-2003', 'power-summer-2004', 'power-summer-2005', 'power-summer-2006', 'power-summer-2007',
    'power-summer-2008', 'power-summer-2011', 'power-summer-2012', 'power-summer-2013', 'power-summer-2014',
    'power-summer-2015', 'power-summer-2016',
    'power-summer-modern-2012', 'power-summer-modern-2013', 'power-summer-modern-2014',
    'power-summer-modern-2015', 'power-summer-modern-2016',
    'power-summer-legacy-2006', 'power-summer-legacy-2007', 'power-summer-legacy-2008', 'power-summer-legacy-2009',
    'power-summer-legacy-2010', 'power-summer-legacy-2011', 'power-summer-legacy-2012', 'power-summer-legacy-2013',
    'power-summer-legacy-2014', 'power-summer-legacy-2015', 'power-summer-legacy-2016',
  ]);

  /** `Snow-Covered Plains` counts as white the same as `Plains` does — 2008 is the only
   * Coldsnap-legal era, and every white-playing deck in it chose the snow basic. */
  const BASIC_TO_COLOUR: Readonly<Record<string, string>> = {
    Plains: 'Plains',
    'Snow-Covered Plains': 'Plains',
    Island: 'Island',
    'Snow-Covered Island': 'Island',
    Swamp: 'Swamp',
    'Snow-Covered Swamp': 'Swamp',
    Mountain: 'Mountain',
    'Snow-Covered Mountain': 'Mountain',
    Forest: 'Forest',
    'Snow-Covered Forest': 'Forest',
  };

  it.each([...FIVE_COLOUR_ERAS])('%s can field every colour', (id) => {
    const c = LIBRARY.find((x) => x.id === id) as LibraryCollection;
    const basics = new Set<string>();
    for (const d of c.decks) {
      for (const e of libraryDeckOf(c, d).file.sections.get('main') ?? []) {
        const colour = BASIC_TO_COLOUR[e.card.name];
        if (colour !== undefined) basics.add(colour);
      }
    }
    expect([...basics].sort(), c.id).toEqual(['Forest', 'Island', 'Mountain', 'Plains', 'Swamp']);
  });

  it('every deck id is unique across the whole library', () => {
    const ids = LIBRARY.flatMap((c) => c.decks.map((d) => d.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every deck file is unique within its own era', () => {
    for (const c of LIBRARY) {
      const files = c.decks.map((d) => d.file);
      expect(new Set(files).size, c.id).toBe(files.length);
    }
  });
});

/*
 * The double-faced-card trap.
 *
 * Scryfall names a DFC `Front // Back`; Forge's `.dck` and every human-written
 * decklist name the front face alone. A pool frozen from Scryfall therefore
 * holds `Delver of Secrets // Insectile Aberration` while the deck that plays
 * it says `Delver of Secrets`.
 *
 * Before `poolNameKeys`, a straight set-membership test on the full name made
 * EVERY Innistrad-era deck illegal — Delver of Secrets, Huntmaster, Garruk
 * Relentless. It was found by adding the first real decks from that block and
 * watching a Pro Tour winner's list get refused in the format it won.
 */
describe('double-faced cards are named by their front face', () => {
  it('splits a Scryfall DFC name into both keys, and leaves a single name alone', () => {
    expect(poolNameKeys('Huntmaster of the Fells // Ravager of the Fells')).toEqual([
      'Huntmaster of the Fells // Ravager of the Fells',
      'Huntmaster of the Fells',
    ]);
    expect(poolNameKeys('Ponder')).toEqual(['Ponder']);
  });

  it('a frozen pool accepts the front-face spelling a decklist actually uses', () => {
    // 2012's era is the Innistrad-to-M13 pool, so its decks play Delver and
    // double-faced Innistrad cards by their front face.
    const pool = poolFromFixture(fixture('2012-07-13'));
    expect(pool.legal.has('Delver of Secrets')).toBe(true);
    // A card that is genuinely not in the format stays out, so the widening
    // above is a front-face rule and not a hole.
    expect(pool.legal.has('Jace, the Mind Sculptor')).toBe(false);
  });
});

/*
 * The cost map the browser gets, checked against the fixtures it came from.
 *
 * `deck-costs.generated.ts` is a SECOND COPY of costs that are already in
 * `decks/pools/*.generated.json`, and `catalog.ts`' own rule is that a second
 * copy of a fact is a copy free to drift invisibly. This is what buys the
 * exception: the map is re-derived here from the fixtures and the `.dck` files
 * on every run, and compared as TEXT, so regenerating is the only way to change
 * it and forgetting to regenerate is red.
 *
 * It exists because the room screen's deck dropdown folds a library deck's
 * colours in the browser, which has no `readFileSync` and is sent card names
 * without costs (`GET /api/tables/decks`).
 */
describe('the library cost map a browser is handed', () => {
  it('is exactly what build-deck-costs.ts would write now', () => {
    expect(deckCostsModule(libraryCardCosts())).toBe(
      read('packages/deck/src/library/deck-costs.generated.ts'),
    );
  });

  it('is the fixtures unchanged, not a re-computation of them', () => {
    // Every entry must be byte-identical to the frozen pool's own string, in at
    // least one pool. A cost invented here would fold to the wrong colours.
    // POOL_FIXTURE_KEYS, not POOL_FIXTURE_DATES: Modern/Legacy eras share a
    // DATE with Standard's own era (Settled), so the date alone would read
    // the wrong family's fixture (default 'standard') for those keys.
    const fixtures = POOL_FIXTURE_KEYS.map(({ family, date }) => fixture(date, family));
    for (const [name, cost] of Object.entries(LIBRARY_CARD_COSTS)) {
      const seen = fixtures.map((f) => f.manaCost[name]).filter((c) => c !== undefined);
      expect(seen.length, `${name} is in no frozen pool`).toBeGreaterThan(0);
      expect(new Set(seen), `${name} disagrees between pools`).toEqual(new Set([cost]));
    }
  });

  it('covers every card the library plays that has a cost, and no land', () => {
    const played = libraryCardNames();
    // Absence means "no coloured pip", so a name absent from the map must be
    // absent from every pool's cost map too — otherwise the dropdown silently
    // drops a colour the deck is playing.
    const fixtures = POOL_FIXTURE_KEYS.map(({ family, date }) => fixture(date, family));
    const missing = [...played].filter(
      (n) => LIBRARY_CARD_COSTS[n] === undefined && fixtures.some((f) => f.manaCost[n] !== undefined),
    );
    expect(missing).toEqual([]);
    // And nothing in the map that no deck plays: this is the library's slice,
    // not the pool's.
    expect(Object.keys(LIBRARY_CARD_COSTS).filter((n) => !played.has(n))).toEqual([]);
  });

  it('is small enough to ship, which is why it is a slice and not the pools', () => {
    // Thresholds raised for wave 48 §T: 9 Standard fixtures / a ~27KB map
    // became 31 fixtures across three families / a ~52KB map once Modern and
    // Legacy's much wider card pools (every paper set ever, for Legacy) were
    // added. The MAP stays small because it is a slice of the library's own
    // played cards, not the pools themselves — the ratio check is the one
    // that actually matters here.
    const map = read('packages/deck/src/library/deck-costs.generated.ts').length;
    const pools = POOL_FIXTURE_KEYS.reduce((n, { family, date }) => n + read(poolFixturePath(date, family)).length, 0);
    expect(map).toBeLessThan(80_000);
    expect(pools).toBeGreaterThan(20 * map);
  });
});
