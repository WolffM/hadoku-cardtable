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

import { standardFormatAt } from '@hadoku/carddata/formats';

import { poolNameKeys } from '../format.ts';
import { writePrebuiltDeck } from '../prebuilt.ts';
import {
  LIBRARY,
  POOL_FIXTURE_DATES,
  deckPath,
  libraryDeckPaths,
  poolFixturePath,
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

function fixture(date: string): PoolFixture {
  return parsePoolFixture(JSON.parse(read(poolFixturePath(date))));
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

const CITATION = /^https:\/\/www\.mtgtop8\.com\/event\?e=\d+&d=\d+&f=ST$/;

/* ── a deck to tamper with, picked once and reused by name ──────────────── */

const RED_DECK_WINS = LIBRARY[0]!.decks.find((d) => d.id === 'power-2008-1-michael-jacob-red-deck-wins')!;
function redDeckWinsText(): string {
  return read(deckPath(LIBRARY[0]!, RED_DECK_WINS));
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
  it('agree with the rotation table about which snapshot was in force', () => {
    // The fixture's card list needs the corpus; its FORMAT block does not —
    // `standardFormatAt` answers from the committed rotation table alone. So
    // this is the one join that can be checked in CI, and it is the join that
    // would break if a fixture were regenerated for the wrong date.
    for (const date of POOL_FIXTURE_DATES) {
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

  it('is exactly the nine eras’ own dates, one fixture each', () => {
    expect(POOL_FIXTURE_DATES).toEqual(LIBRARY.map((c) => c.date));
    expect(new Set(POOL_FIXTURE_DATES).size).toBe(9);
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
      const pool = poolFromFixture(fixture(c.date));
      expect(pool.name).toBe(c.format);
      const deck = libraryDeckOf(c, entry);
      expect(libraryPoolMismatch(deck, pool)).toBeNull();
      expect(libraryIssues(deck, pool).map((i) => i.message)).toEqual([]);
    },
  );

  it('says so when the pool is for a different format', () => {
    const deck = libraryDeckOf(LIBRARY[0]!, RED_DECK_WINS);
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
    const deck = libraryDeckOf(LIBRARY[0]!, RED_DECK_WINS);
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
  // nine power-summer eras, 2008-2016, 96 decks.
  it('is nine eras and ninety-six decks, oldest first', () => {
    expect(LIBRARY.map((c) => [c.id, c.format, c.date, c.decks.length])).toEqual([
      ['power-summer-2008', 'Standard (EVE)', '2008-07-25', 12],
      ['power-summer-2009', 'Standard (M10)', '2009-07-17', 4],
      ['power-summer-2010', 'Standard (M11)', '2010-07-16', 8],
      ['power-summer-2011', 'Standard (M12)', '2011-07-15', 12],
      ['power-summer-2012', 'Standard (M13)', '2012-07-13', 12],
      ['power-summer-2013', 'Standard (M14)', '2013-07-19', 12],
      ['power-summer-2014', 'Standard (M15)', '2014-07-18', 12],
      ['power-summer-2015', 'Standard (ORI)', '2015-07-17', 12],
      ['power-summer-2016', 'Standard (EMN)', '2016-07-22', 12],
    ]);
    expect(ALL_DECKS).toHaveLength(96);
    expect(libraryDeckPaths()).toHaveLength(96);
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
  const FIVE_COLOUR_ERAS = new Set(['power-summer-2008', 'power-summer-2011', 'power-summer-2012', 'power-summer-2013', 'power-summer-2014', 'power-summer-2015', 'power-summer-2016']);

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
    const fixtures = POOL_FIXTURE_DATES.map((d) => fixture(d));
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
    const fixtures = POOL_FIXTURE_DATES.map((d) => fixture(d));
    const missing = [...played].filter(
      (n) => LIBRARY_CARD_COSTS[n] === undefined && fixtures.some((f) => f.manaCost[n] !== undefined),
    );
    expect(missing).toEqual([]);
    // And nothing in the map that no deck plays: this is the library's slice,
    // not the pool's.
    expect(Object.keys(LIBRARY_CARD_COSTS).filter((n) => !played.has(n))).toEqual([]);
  });

  it('is small enough to ship, which is why it is a slice and not the pools', () => {
    const map = read('packages/deck/src/library/deck-costs.generated.ts').length;
    const pools = POOL_FIXTURE_DATES.reduce((n, d) => n + read(poolFixturePath(d)).length, 0);
    expect(map).toBeLessThan(40_000);
    expect(pools).toBeGreaterThan(20 * map);
  });
});
