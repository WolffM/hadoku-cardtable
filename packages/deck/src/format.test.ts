import { describe, expect, it } from 'vitest';
import { DEFAULT_ART_INDEX, type CardRequest, type DeckEntry } from '@hadoku/carddata';

import { basicLand, deckFromDeckFile, deckIssues, deckProblems, newDeck, type Deck } from './deck.ts';
import {
  CONSTRUCTED_LIMITS,
  formatIssues,
  formatPoolFromEntries,
  isLegalIn,
  type FormatPool,
} from './format.ts';

/*
 * Fixtures are built by hand, in `src/`, on purpose. The 183 MB card corpus at
 * `packages/carddata/data/cards.jsonl` is gitignored and absent in CI, so a
 * test that needs it is a test that does not run — `resolve.test.ts:16` says
 * the same thing. Nothing below touches the filesystem: a `FormatPool` is a set
 * of names and a deck is a list of card references.
 */

function card(name: string, set: string | null = 'ISD'): CardRequest {
  return {
    name,
    set,
    artIndex: DEFAULT_ART_INDEX,
    collectorNumber: null,
    foil: false,
    backFace: false,
    flags: null,
  };
}

function entry(count: number, name: string, set?: string | null): DeckEntry {
  return { count, card: card(name, set === undefined ? 'ISD' : set) };
}

/** Standard as it stood on 2011-09-30, in miniature. */
const SPELLS = [
  'Snapcaster Mage',
  'Delver of Secrets',
  'Mana Leak',
  'Ponder',
  'Gitaxian Probe',
  'Vapor Snag',
  'Geist of Saint Traft',
  'Restoration Angel',
];

const STANDARD_ISD: FormatPool = {
  name: 'Standard (ISD)',
  legal: new Set([...SPELLS, 'Island', 'Plains', 'Seachrome Coast']),
};

/** 24 spells + 36 Islands = a legal 60, with room for the copy limit to bite. */
function legalDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    name: 'Delver',
    main: [
      entry(4, 'Snapcaster Mage'),
      entry(4, 'Delver of Secrets'),
      entry(4, 'Mana Leak'),
      entry(4, 'Ponder'),
      entry(4, 'Gitaxian Probe'),
      entry(4, 'Vapor Snag'),
    ],
    sideboard: [],
    basics: [{ count: 36, card: basicLand('Island') }],
    ...overrides,
  };
}

describe('a legal deck raises nothing', () => {
  it('passes a 60-card deck built from the pool', () => {
    expect(formatIssues(legalDeck(), STANDARD_ISD)).toEqual([]);
    expect(isLegalIn(legalDeck(), STANDARD_ISD)).toBe(true);
  });

  it('uses Forge Constructed numbers when the format states none', () => {
    expect(CONSTRUCTED_LIMITS).toEqual({
      minMainDeckSize: 60,
      maxSideboardSize: 15,
      maxCopies: 4,
    });
    // 59 cards: one short of Forge's floor, and the floor is where it comes from.
    const short = legalDeck({ basics: [{ count: 35, card: basicLand('Island') }] });
    expect(formatIssues(short, STANDARD_ISD).map((i) => [i.kind, i.count, i.limit])).toEqual([
      ['under-minimum-size', 59, 60],
    ]);
  });

  it('allows an empty sideboard however tight the range, as Forge does', () => {
    const tight: FormatPool = { ...STANDARD_ISD, maxSideboardSize: 0 };
    expect(formatIssues(legalDeck(), tight)).toEqual([]);
  });
});

describe('it says WHICH card and WHY, not just no', () => {
  it('names a card that is not in the pool, and how many are played', () => {
    const deck = legalDeck({
      main: [...legalDeck().main.slice(1), entry(4, 'Force of Will', 'ALL')],
    });
    const issues = formatIssues(deck, STANDARD_ISD);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('not-in-pool');
    expect(issues[0].cardName).toBe('Force of Will');
    expect(issues[0].count).toBe(4);
    expect(issues[0].card?.set).toBe('ALL');
    expect(issues[0].message).toBe('plays 4x Force of Will, which is not in Standard (ISD)');
  });

  it('reports every offending card, where Forge stops at the first', () => {
    const deck = legalDeck({
      main: [
        entry(4, 'Force of Will', 'ALL'),
        entry(4, 'Brainstorm', 'ICE'),
        entry(4, 'Mana Leak'),
        entry(4, 'Ponder'),
        entry(4, 'Gitaxian Probe'),
        entry(4, 'Vapor Snag'),
      ],
    });
    const issues = formatIssues(deck, STANDARD_ISD);
    expect(issues.map((i) => i.cardName)).toEqual(['Force of Will', 'Brainstorm']);
    expect(issues.every((i) => i.kind === 'not-in-pool')).toBe(true);
  });

  it('catches the copy limit across maindeck AND sideboard, as Forge does', () => {
    // 3 main + 2 side = 5 Ponder. Neither pile alone breaks the limit.
    const deck = legalDeck({
      main: [
        entry(4, 'Snapcaster Mage'),
        entry(4, 'Delver of Secrets'),
        entry(4, 'Mana Leak'),
        entry(3, 'Ponder'),
        entry(4, 'Gitaxian Probe'),
        entry(4, 'Vapor Snag'),
        entry(1, 'Geist of Saint Traft'),
      ],
      sideboard: [entry(2, 'Ponder')],
    });
    const issues = formatIssues(deck, STANDARD_ISD);
    expect(issues.map((i) => i.message)).toEqual([
      'plays 5x Ponder, but Standard (ISD) allows 4',
    ]);
    expect(issues[0]).toMatchObject({ kind: 'over-the-copy-limit', count: 5, limit: 4 });
  });

  it('counts printings of one card as one card', () => {
    const deck = legalDeck({
      main: [
        entry(3, 'Ponder', 'LRW'),
        entry(3, 'Ponder', 'M12'),
        entry(4, 'Mana Leak'),
        entry(4, 'Gitaxian Probe'),
        entry(4, 'Vapor Snag'),
        entry(4, 'Snapcaster Mage'),
      ],
      basics: [{ count: 38, card: basicLand('Island') }],
    });
    const issues = formatIssues(deck, STANDARD_ISD);
    expect(issues.map((i) => [i.kind, i.cardName, i.count])).toEqual([
      ['over-the-copy-limit', 'Ponder', 6],
    ]);
  });

  it('flags a banned card at any count, and does not also call it out of pool', () => {
    const format: FormatPool = { ...STANDARD_ISD, banned: new Set(['Ponder']) };
    const issues = formatIssues(legalDeck(), format);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'banned', cardName: 'Ponder', count: 4, limit: 0 });
    expect(issues[0].message).toBe('plays 4x Ponder, which Standard (ISD) bans');
  });

  it('restricts to one copy, and passes at one', () => {
    const format: FormatPool = { ...STANDARD_ISD, restricted: new Set(['Ponder']) };
    expect(formatIssues(legalDeck(), format).map((i) => i.message)).toEqual([
      'plays 4x Ponder, but Standard (ISD) restricts it to 1',
    ]);

    const one = legalDeck({
      main: [...legalDeck().main.slice(0, 3), entry(1, 'Ponder'), entry(4, 'Gitaxian Probe')],
      basics: [{ count: 43, card: basicLand('Island') }],
    });
    expect(formatIssues(one, format)).toEqual([]);
  });

  it('flags an oversized sideboard with the number and the limit', () => {
    const deck = legalDeck({ sideboard: [entry(4, 'Mana Leak'), entry(12, 'Vapor Snag')] });
    const issues = formatIssues(deck, STANDARD_ISD);
    expect(issues.map((i) => [i.kind, i.count, i.limit])).toEqual([
      ['sideboard-out-of-range', 16, 15],
      // 4 main + 4 side Mana Leak, and 4 + 12 Vapor Snag.
      ['over-the-copy-limit', 8, 4],
      ['over-the-copy-limit', 16, 4],
    ]);
  });

  it('raises both faults for a card that is unknown AND over the limit', () => {
    const deck = legalDeck({
      main: [
        entry(5, 'Force of Will', 'ALL'),
        entry(4, 'Mana Leak'),
        entry(4, 'Ponder'),
        entry(4, 'Gitaxian Probe'),
        entry(4, 'Vapor Snag'),
      ],
      basics: [{ count: 39, card: basicLand('Island') }],
    });
    expect(formatIssues(deck, STANDARD_ISD).map((i) => i.kind)).toEqual([
      'not-in-pool',
      'over-the-copy-limit',
    ]);
  });
});

describe('the exemptions Forge has, spelled out as data', () => {
  it('lets basic lands past the copy limit', () => {
    // 36 Islands is nine times the limit and is not an issue.
    expect(formatIssues(legalDeck(), STANDARD_ISD)).toEqual([]);
  });

  it('lets a Relentless Rats card past it too, when the pool says so', () => {
    const format: FormatPool = {
      name: 'Standard (ISD)',
      legal: new Set([...STANDARD_ISD.legal, 'Relentless Rats']),
      anyNumberOf: new Set(['Relentless Rats']),
    };
    const deck = legalDeck({ main: [entry(24, 'Relentless Rats')] });
    expect(formatIssues(deck, format)).toEqual([]);
  });

  it('honours a per-card limit against the MAINDECK only, as Forge does', () => {
    // DeckFormat.java:464-467 checks `deck.getMain().countByName` for a
    // DeckLimit card, so 7 main + 4 side is legal where 8 main is not.
    const format: FormatPool = {
      name: 'Standard (ISD)',
      legal: new Set([...STANDARD_ISD.legal, 'Seven Dwarves']),
      copyLimits: new Map([['Seven Dwarves', 7]]),
    };
    const spread = legalDeck({
      main: [entry(7, 'Seven Dwarves'), entry(4, 'Mana Leak'), entry(4, 'Ponder')],
      sideboard: [entry(4, 'Seven Dwarves')],
      basics: [{ count: 45, card: basicLand('Island') }],
    });
    expect(formatIssues(spread, format)).toEqual([]);

    const stacked = legalDeck({
      main: [entry(8, 'Seven Dwarves'), entry(4, 'Mana Leak'), entry(4, 'Ponder')],
      basics: [{ count: 44, card: basicLand('Island') }],
    });
    expect(formatIssues(stacked, format).map((i) => i.message)).toEqual([
      'maindeck plays 8x Seven Dwarves, but Standard (ISD) allows 7',
    ]);
  });

  it('treats basics as legal by default and as ordinary cards when told not to', () => {
    const noBasics: FormatPool = { name: 'No Basics', legal: STANDARD_ISD.legal };
    expect(formatIssues(legalDeck(), noBasics)).toEqual([]);

    const strict: FormatPool = {
      name: 'No Basics',
      legal: new Set(SPELLS),
      basicsAlwaysLegal: false,
    };
    expect(formatIssues(legalDeck(), strict).map((i) => [i.kind, i.cardName])).toEqual([
      ['not-in-pool', 'Island'],
    ]);
  });
});

describe('a pool is just a set of names, however you got it', () => {
  it('builds one from card entries and ignores their counts', () => {
    const pool = formatPoolFromEntries('Cube', [entry(1, 'Ponder'), entry(9, 'Mana Leak')], {
      maxCopies: 1,
    });
    expect([...pool.legal].sort()).toEqual(['Mana Leak', 'Ponder']);
    expect(pool.maxCopies).toBe(1);
    expect(pool.name).toBe('Cube');
  });

  it('reads a deck out of a parsed .dck and validates it', () => {
    const file = {
      name: 'Two Spells',
      metadata: new Map([['name', 'Two Spells']]),
      sections: new Map<string, readonly DeckEntry[]>([
        ['main', [entry(4, 'Ponder'), entry(1, 'Force of Will', 'ALL')]],
        ['sideboard', [entry(1, 'Ponder')]],
      ]),
    };
    const deck = deckFromDeckFile(file);
    expect(deck.name).toBe('Two Spells');
    expect(deck.basics).toEqual([]);
    expect(formatIssues(deck, STANDARD_ISD).map((i) => i.kind)).toEqual([
      'under-minimum-size',
      'over-the-copy-limit',
      'not-in-pool',
    ]);
  });
});

describe('the drafted-pool issues keep their string face', () => {
  it('deckProblems is exactly deckIssues mapped to messages', () => {
    const pool = [entry(1, 'Ponder'), entry(1, 'Mana Leak')];
    const deck: Deck = {
      ...newDeck('Draft', pool),
      main: [entry(3, 'Ponder')],
      sideboard: [],
      basics: [{ count: 1, card: card('Snapcaster Mage') }],
    };
    const issues = deckIssues(deck, pool);
    expect(deckProblems(deck, pool)).toEqual(issues.map((i) => i.message));
    expect(deckProblems(deck, pool)).toEqual([
      'maindeck has 4 cards, needs at least 40',
      'Snapcaster Mage is in the basics pile but is not a basic land',
      'plays 3x Ponder but drafted 1',
    ]);
    expect(issues.map((i) => i.kind)).toEqual([
      'under-minimum-size',
      'not-a-basic-land',
      'more-copies-than-drafted',
    ]);
  });
});
