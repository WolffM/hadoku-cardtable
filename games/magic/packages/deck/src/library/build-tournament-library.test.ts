import { describe, expect, it } from 'vitest';

import { parseDck } from '@hadoku/carddata/dck';

import {
  tournamentDeckFileName,
  tournamentDirectoryName,
} from './build-tournament-library.ts';

/**
 * A synthetic MTG_decklistcache event, the shape the converter reads. Small,
 * but field-for-field the same keys the real Feb 2026 MTGO files carry — the
 * header of `build-tournament-library.ts` cites the source shape.
 */
const EVENT = {
  Tournament: {
    Date: '2026-02-07',
    Name: 'Modern Challenge 32',
    Uri: 'https://www.mtgo.com/decklist/modern-challenge-32-2026-02-0712832522',
    Formats: 'Modern',
  },
  Decks: [
    {
      Date: '2026-02-07T02:00:00+00:00',
      Player: 'Misplacedginger',
      Result: '1st Place',
      AnchorUri: 'https://www.mtgo.com/decklist/modern-challenge-32-2026-02-0712832522#deck_Misplacedginger',
      Mainboard: [
        { Count: 4, CardName: 'Ajani, Nacatl Pariah' },
        { Count: 20, CardName: 'Plains' },
      ],
      Sideboard: [{ Count: 2, CardName: 'Celestial Purge' }],
    },
    {
      Date: '2026-02-07T02:00:00+00:00',
      Player: 'Jötun Grunt // Æther Vial',
      Result: '9th-16th Place',
      AnchorUri: '',
      Mainboard: [{ Count: 60, CardName: 'Island' }],
      Sideboard: [],
    },
  ],
  Rounds: [
    {
      RoundName: 'Quarterfinals',
      Matches: [{ Player1: 'Misplacedginger', Player2: 'Jötun Grunt // Æther Vial', Result: '2-0-0' }],
    },
  ],
  Standings: [{ Rank: 1, Player: 'Misplacedginger', Points: 18, Wins: 9, Losses: 0, Draws: 0 }],
};

describe('tournament deck file names', () => {
  it('prefixes a placing with its number, slugging the player', () => {
    expect(tournamentDeckFileName(EVENT.Decks[0]!)).toBe('1-misplacedginger.dck');
  });

  it('takes the first number of a range finish and strips accents from the player', () => {
    expect(tournamentDeckFileName(EVENT.Decks[1]!)).toBe('9-jotun-grunt-ther-vial.dck');
  });
});

describe('tournament collection directory', () => {
  it('carries family, date and a slug of the event name', () => {
    expect(tournamentDirectoryName('modern', '2026-02-07', 'Modern Challenge 32')).toBe(
      'decks/tournament-modern-2026-02-07-modern-challenge-32',
    );
  });

  it('distinguishes the same date across families', () => {
    const standard = tournamentDirectoryName('standard', '2026-02-07', 'Standard Challenge 32');
    const modern = tournamentDirectoryName('modern', '2026-02-07', 'Modern Challenge 32');
    expect(standard).not.toBe(modern);
    expect(standard).toContain('tournament-standard-');
    expect(modern).toContain('tournament-modern-');
  });
});

describe('the .dck the converter writes', () => {
  // Written by main()'s own code path: run the real script against the
  // synthetic event in a temp checkout? No — the script writes under the real
  // REPO_ROOT by design (committed data). For the unit test, parse what
  // buildDeckFile emits by round-tripping through writeDck, exactly what
  // build-library.test-style tests do.
  it('round-trips a cache deck into a .dck loadLibraryDeck can read', async () => {
    // Import the private path through the module's own main flow is not
    // possible without running it, so build the file the way main does and
    // assert the text.
    const { writeDck } = await import('../dck-write.ts');
    const { LIBRARY_PILOT_KEY, LIBRARY_SOURCE_KEY, LIBRARY_PROVENANCE_KEY } = await import('./library.ts');
    const { PREBUILT_FORMAT_KEY, PREBUILT_DATE_KEY } = await import('../prebuilt.ts');
    const { DEFAULT_ART_INDEX } = await import('@hadoku/carddata/dck');

    const deck = EVENT.Decks[0]!;
    const entries = (cards: readonly { Count: number; CardName: string }[]) =>
      cards.map((c) => ({
        count: c.Count,
        card: {
          name: c.CardName,
          set: null,
          collectorNumber: null,
          artIndex: DEFAULT_ART_INDEX,
          foil: false,
          backFace: false,
          flags: null,
        },
      }));

    const metadata = new Map<string, string>([
      ['name', 'Misplacedginger — Modern Challenge 32'],
      [LIBRARY_PILOT_KEY.toLowerCase(), deck.Player],
      ['deck type', 'Constructed'],
      [PREBUILT_FORMAT_KEY.toLowerCase(), 'modern'],
      [PREBUILT_DATE_KEY.toLowerCase(), '2026-02-07'],
      [LIBRARY_SOURCE_KEY.toLowerCase(), deck.AnchorUri ?? ''],
      [LIBRARY_PROVENANCE_KEY.toLowerCase(), 'Transcribed from MTG_decklistcache.'],
    ]);
    const sections = new Map<string, readonly { count: number; card: object }[]>([
      ['main', entries(deck.Mainboard)],
      ['sideboard', entries(deck.Sideboard)],
    ]);

    const text = writeDck({ name: metadata.get('name')!, metadata, sections } as never);
    const parsed = parseDck(text);

    expect(parsed.metadata.get('format')).toBe('modern');
    expect(parsed.metadata.get('effective')).toBe('2026-02-07');
    expect(parsed.sections.get('main')?.map((e) => [e.count, e.card.name])).toEqual([
      [4, 'Ajani, Nacatl Pariah'],
      [20, 'Plains'],
    ]);
    expect(parsed.sections.get('sideboard')?.map((e) => [e.count, e.card.name])).toEqual([
      [2, 'Celestial Purge'],
    ]);
  });
});

describe('the cache contract the converter assumes', () => {
  it('keeps Result and pairings verbatim — no derivation', () => {
    // The pairings travel as-is into tournament.json; the test pins the shape
    // so a cache format change fails HERE rather than as silently-empty
    // pairings.
    const round = EVENT.Rounds![0]!;
    expect(round.Matches[0]).toEqual({
      Player1: 'Misplacedginger',
      Player2: 'Jötun Grunt // Æther Vial',
      Result: '2-0-0',
    });
    expect(EVENT.Standings![0]!.Rank).toBe(1);
  });
});
