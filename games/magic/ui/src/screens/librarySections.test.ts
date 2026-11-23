/*
 * The Library's Decks tab: which section a deck is in and its place there (operator, 2026-11-23).
 * Favourites above everything; yours (built, or a drafted deck touched and out of its
 * tournament); then from drafts. Each section by last played unless another sort is picked.
 */
import { describe, expect, it } from 'vitest';

import { librarySections, playedLine, sectionOf, sourcePasses, type LibraryEntry } from './deckFilter.ts';

const at = (month: number, day: number): number => Date.UTC(2026, month - 1, day, 12);
const deck = (name: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  kind: 'drafted',
  name,
  favourite: false,
  touched: false,
  inTournament: false,
  lastPlayedAt: null,
  createdAt: at(10, 1),
  games: 0,
  wins: 0,
  ...over,
});
const names = (sections: { decks: LibraryEntry[] }[]): string[][] => sections.map((s) => s.decks.map((d) => d.name));

describe('a deck’s section', () => {
  it('is Favourites when starred, whatever it is', () => {
    expect(sectionOf(deck('a', { favourite: true }))).toBe('favourites');
    expect(sectionOf(deck('a', { favourite: true, inTournament: true }))).toBe('favourites');
    expect(sectionOf(deck('a', { favourite: true, kind: 'built', touched: true }))).toBe('favourites');
  });

  it('is yours once touched, and only out of its tournament', () => {
    expect(sectionOf(deck('a', { kind: 'built', touched: true }))).toBe('yours');
    expect(sectionOf(deck('a', { touched: true }))).toBe('yours');
    expect(sectionOf(deck('a', { touched: true, inTournament: true }))).toBe('drafts');
  });

  it('is From drafts when the draft made it and nobody touched it', () => {
    expect(sectionOf(deck('a'))).toBe('drafts');
    expect(sectionOf(deck('a', { inTournament: true }))).toBe('drafts');
  });
});

describe('librarySections', () => {
  const decks = [
    deck('old draft', { lastPlayedAt: at(10, 3) }),
    deck('never played', { createdAt: at(10, 21) }),
    deck('never played, older', { createdAt: at(9, 1) }),
    deck('recent draft', { lastPlayedAt: at(11, 19) }),
    deck('built', { kind: 'built', touched: true, lastPlayedAt: at(11, 1), games: 4, wins: 1 }),
    deck('renamed', { touched: true, lastPlayedAt: at(11, 20), games: 2, wins: 2 }),
    deck('starred', { favourite: true, lastPlayedAt: at(1, 1) }),
    deck('live', { inTournament: true, lastPlayedAt: at(11, 22) }),
  ];

  it('orders Favourites, Your decks, From drafts, each by last played, the never played last and newest first', () => {
    const sections = librarySections(decks, 'played');
    expect(sections.map((s) => s.section)).toEqual(['favourites', 'yours', 'drafts']);
    expect(names(sections)).toEqual([['starred'], ['renamed', 'built'], ['live', 'recent draft', 'old draft', 'never played', 'never played, older']]);
  });

  it('leaves out a section with no decks', () => {
    expect(librarySections([deck('a')], 'played').map((s) => s.section)).toEqual(['drafts']);
    expect(librarySections([], 'played')).toEqual([]);
  });

  it('sorts by win rate (unplayed last), by name, or newest, inside each section', () => {
    const yours = [
      deck('Zed', { touched: true, games: 4, wins: 1, createdAt: at(1, 1) }),
      deck('alpha', { touched: true, games: 2, wins: 2, createdAt: at(3, 1) }),
      deck('Mid', { touched: true, games: 0, wins: 0, createdAt: at(2, 1) }),
    ];
    expect(names(librarySections(yours, 'winrate'))).toEqual([['alpha', 'Zed', 'Mid']]);
    expect(names(librarySections(yours, 'name'))).toEqual([['alpha', 'Mid', 'Zed']]);
    expect(names(librarySections(yours, 'newest'))).toEqual([['alpha', 'Mid', 'Zed']]);
    // Sorting never moves a deck between sections.
    expect(librarySections([...yours, deck('fav', { favourite: true, games: 0 })], 'winrate').map((s) => s.section)).toEqual(['favourites', 'yours']);
  });
});

describe('the source filter', () => {
  it('keeps built, drafted, or decks in a running tournament', () => {
    const built = deck('b', { kind: 'built', touched: true });
    const live = deck('l', { inTournament: true });
    const done = deck('d');
    expect([built, live, done].filter((d) => sourcePasses(d, 'all'))).toHaveLength(3);
    expect([built, live, done].filter((d) => sourcePasses(d, 'built'))).toEqual([built]);
    expect([built, live, done].filter((d) => sourcePasses(d, 'drafted'))).toEqual([live, done]);
    expect([built, live, done].filter((d) => sourcePasses(d, 'live'))).toEqual([live]);
  });
});

describe('the tile’s when-line', () => {
  it('says when it was last played, or that it never was and when it was made', () => {
    expect(playedLine({ kind: 'drafted', lastPlayedAt: at(11, 19), createdAt: at(10, 1) })).toBe('Last played Nov 19');
    expect(playedLine({ kind: 'drafted', lastPlayedAt: null, createdAt: at(10, 21) })).toBe('Never played · drafted Oct 21');
    expect(playedLine({ kind: 'built', lastPlayedAt: null, createdAt: at(10, 21) })).toBe('Never played · built Oct 21');
  });
});
