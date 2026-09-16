import { describe, expect, it } from 'vitest';
import { parseDck, type DeckEntry } from '@hadoku/carddata';

import { writeDck } from './dck-write.ts';
import { formatPoolFromEntries, type FormatPool } from './format.ts';
import {
  PREBUILT_DATE_KEY,
  PREBUILT_FORMAT_KEY,
  PrebuiltDeckError,
  loadPrebuiltDeck,
  prebuiltDeck,
  prebuiltIssues,
  prebuiltToDeck,
  writePrebuiltDeck,
} from './prebuilt.ts';

/*
 * A hand-built `.dck`, in `src/`, with no filesystem behind it — the corpus at
 * `packages/carddata/data/` is gitignored and absent in CI, so anything that
 * needed it would silently not run.
 *
 * The card list is a real Standard-era deck shape (Innistrad-block Delver) but
 * the names are only ever compared to the pool the test hands in; nothing here
 * resolves a card.
 */
const DELVER_DCK = [
  '[metadata]',
  'Name=Delver Blue',
  'Format=Standard (ISD)',
  'Effective=2011-09-30',
  '[Main]',
  '4 Delver of Secrets|ISD',
  '4 Snapcaster Mage|ISD',
  '2 Mana Leak|M12',
  '4 Ponder|M12',
  '4 Gitaxian Probe|NPH',
  '4 Vapor Snag|NPH',
  '14 Island',
  '4 Seachrome Coast|SOM',
  '[Sideboard]',
  '2 Mana Leak|M12',
  '',
].join('\n');

const STANDARD_ISD: FormatPool = {
  name: 'Standard (ISD)',
  legal: new Set([
    'Delver of Secrets',
    'Snapcaster Mage',
    'Mana Leak',
    'Ponder',
    'Gitaxian Probe',
    'Vapor Snag',
    'Seachrome Coast',
    'Island',
  ]),
  // 40 cards is the deck above; the real floor would reject it, and the test
  // for that is below.
  minMainDeckSize: 40,
};

describe('a prebuilt deck is a .dck plus a format and a date', () => {
  it('loads all three out of the file itself', () => {
    const deck = loadPrebuiltDeck(DELVER_DCK);
    expect(deck.name).toBe('Delver Blue');
    expect(deck.format).toBe('Standard (ISD)');
    expect(deck.date).toBe('2011-09-30');
    expect(deck.file.sections.get('main')).toHaveLength(8);
    expect(deck.file.sections.get('sideboard')).toHaveLength(1);
  });

  it('reads the deck as a maindeck and a sideboard', () => {
    const deck = prebuiltToDeck(loadPrebuiltDeck(DELVER_DCK));
    expect(deck.name).toBe('Delver Blue');
    // 4+4+2+4+4+4+14+4 = 40 in the main section; basics stay where the file
    // put them, so the basics pile is empty and the Islands are in `main`.
    expect(deck.main.reduce((n, e) => n + e.count, 0)).toBe(40);
    expect(deck.basics).toEqual([]);
    expect(deck.sideboard.reduce((n, e) => n + e.count, 0)).toBe(2);
  });

  it('lets an override supply metadata a file predating the convention lacks', () => {
    const bare = ['[metadata]', 'Name=Old Deck', '[Main]', '4 Ponder|M12', ''].join('\n');
    const deck = loadPrebuiltDeck(bare, { format: 'Standard (ISD)', date: '2011-09-30' });
    expect([deck.name, deck.format, deck.date]).toEqual([
      'Old Deck',
      'Standard (ISD)',
      '2011-09-30',
    ]);
  });

  it('refuses a deck that is missing metadata, and names every field at once', () => {
    const bare = ['[metadata]', '[Main]', '4 Ponder|M12', ''].join('\n');
    expect(() => loadPrebuiltDeck(bare)).toThrow(PrebuiltDeckError);
    expect(() => loadPrebuiltDeck(bare)).toThrow(
      'prebuilt deck needs a deck name (metadata key `Name`), ' +
        'and a format (metadata key `Format`), ' +
        'and a date (metadata key `Effective`, YYYY-MM-DD)',
    );
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    const wrong = DELVER_DCK.replace('Effective=2011-09-30', 'Effective=Sept 2011');
    expect(() => loadPrebuiltDeck(wrong)).toThrow(/YYYY-MM-DD, not "Sept 2011"/);
  });

  it('uses keys stock Forge ignores, so the file still loads there', () => {
    // DeckFileHeader.java:36-56 declares thirteen keys by name and reads only
    // those; ours are not among them and are carried through untouched.
    const forgeKeys = new Set([
      'name',
      'deck type',
      'source url',
      'tags',
      'draftnotes',
      'keycards',
      'sleeveart',
      'sleeveoffset',
      'comment',
      'aihints',
      'player',
      'custom pool',
      'playertype',
    ]);
    expect(forgeKeys.has(PREBUILT_FORMAT_KEY.toLowerCase())).toBe(false);
    expect(forgeKeys.has(PREBUILT_DATE_KEY.toLowerCase())).toBe(false);
    const metadata = loadPrebuiltDeck(DELVER_DCK).file.metadata;
    expect(metadata.get('format')).toBe('Standard (ISD)');
    expect(metadata.get('effective')).toBe('2011-09-30');
  });
});

describe('round-tripping a prebuilt deck', () => {
  it('writes back byte-identical text', () => {
    expect(writePrebuiltDeck(loadPrebuiltDeck(DELVER_DCK))).toBe(DELVER_DCK);
  });

  it('is a fixed point: load, write, load, write', () => {
    const once = writePrebuiltDeck(loadPrebuiltDeck(DELVER_DCK));
    const twice = writePrebuiltDeck(loadPrebuiltDeck(once));
    expect(twice).toBe(once);
    expect(twice).toBe(DELVER_DCK);
  });

  it('keeps the file order rather than sorting, as writeDck does', () => {
    const lines = writePrebuiltDeck(loadPrebuiltDeck(DELVER_DCK)).split('\n');
    expect(lines.slice(5, 8)).toEqual([
      '4 Delver of Secrets|ISD',
      '4 Snapcaster Mage|ISD',
      '2 Mana Leak|M12',
    ]);
  });

  it('keeps the header casing the source used, lowercase included', () => {
    const lower = DELVER_DCK.replace('[Main]', '[main]').replace('Format=', 'format=');
    expect(writePrebuiltDeck(loadPrebuiltDeck(lower))).toBe(lower);
  });

  it('round-trips a deck built in code, not just one read from text', () => {
    const sections = new Map<string, readonly DeckEntry[]>([
      ['main', parseDck(DELVER_DCK).sections.get('main') ?? []],
    ]);
    const built = prebuiltDeck(
      { name: 'Delver Blue', format: 'Standard (ISD)', date: '2011-09-30' },
      sections,
    );
    const text = writePrebuiltDeck(built);
    expect(text.split('\n').slice(0, 5)).toEqual([
      '[metadata]',
      'Name=Delver Blue',
      'Format=Standard (ISD)',
      'Effective=2011-09-30',
      '[Main]',
    ]);
    const reloaded = loadPrebuiltDeck(text);
    expect(reloaded.name).toBe('Delver Blue');
    expect(writePrebuiltDeck(reloaded)).toBe(text);
  });

  it('refuses to build one with a malformed date', () => {
    expect(() =>
      prebuiltDeck({ name: 'x', format: 'y', date: '2011-9-30' }, new Map()),
    ).toThrow(PrebuiltDeckError);
  });

  it('does not change what writeDck alone would emit', () => {
    const deck = loadPrebuiltDeck(DELVER_DCK);
    expect(writePrebuiltDeck(deck)).toBe(writeDck(deck.file, { spelling: deck.spelling }));
  });
});

describe('a prebuilt deck validates against a SUPPLIED pool', () => {
  it('passes against a pool that contains it', () => {
    expect(prebuiltIssues(loadPrebuiltDeck(DELVER_DCK), STANDARD_ISD)).toEqual([]);
  });

  it('reports which card is not in the pool and why', () => {
    const narrow: FormatPool = {
      ...STANDARD_ISD,
      legal: new Set([...STANDARD_ISD.legal].filter((n) => n !== 'Snapcaster Mage')),
    };
    const issues = prebuiltIssues(loadPrebuiltDeck(DELVER_DCK), narrow);
    expect(issues.map((i) => [i.kind, i.cardName, i.count, i.message])).toEqual([
      [
        'not-in-pool',
        'Snapcaster Mage',
        4,
        'plays 4x Snapcaster Mage, which is not in Standard (ISD)',
      ],
    ]);
  });

  it('applies the real Constructed floor when the pool does not lower it', () => {
    const real: FormatPool = { name: 'Standard (ISD)', legal: STANDARD_ISD.legal };
    expect(prebuiltIssues(loadPrebuiltDeck(DELVER_DCK), real).map((i) => i.message)).toEqual([
      'maindeck has 40 cards, Standard (ISD) needs at least 60',
    ]);
  });

  it('counts the sideboard against the copy limit, from the file', () => {
    // 2 Mana Leak in [Main] and 2 more in [Sideboard] is four copies: legal at
    // Forge's limit of 4, and the only card in the deck whose count needs both
    // sections to add up.
    expect(prebuiltIssues(loadPrebuiltDeck(DELVER_DCK), { ...STANDARD_ISD, maxCopies: 4 }))
      .toEqual([]);

    const tight = prebuiltIssues(loadPrebuiltDeck(DELVER_DCK), {
      ...STANDARD_ISD,
      maxCopies: 3,
    });
    // Mana Leak at 4 is 2 + 2; a maindeck-only count would read 2 and pass.
    expect(tight.map((i) => [i.cardName, i.count, i.limit])).toEqual([
      ['Delver of Secrets', 4, 3],
      ['Snapcaster Mage', 4, 3],
      ['Mana Leak', 4, 3],
      ['Ponder', 4, 3],
      ['Gitaxian Probe', 4, 3],
      ['Vapor Snag', 4, 3],
      ['Seachrome Coast', 4, 3],
    ]);
    // The 14 Islands are nearly five times the limit and are not an issue.
    expect(tight.some((i) => i.cardName === 'Island')).toBe(false);
  });

  it('validates against a pool built from another deck list', () => {
    const cube = formatPoolFromEntries(
      'Tiny Cube',
      parseDck(DELVER_DCK).sections.get('main') ?? [],
      { minMainDeckSize: 40 },
    );
    expect(prebuiltIssues(loadPrebuiltDeck(DELVER_DCK), cube)).toEqual([]);
  });
});
