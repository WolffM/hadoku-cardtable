import { describe, expect, it } from 'vitest';

import type { DraftCard } from '@hadoku/shared';

import { toBoardView, type BoardCard, type BoardPlayer, type BoardView, type StackEntry } from '../adapter.ts';
import { loadPackets, PLAY_FIXTURES } from '../fixtures.ts';
import { foldPackets } from '../fold.ts';
import { castRole, colourCell, colourRow, deriveSoundEvents, LAND_THUD_DELAY_MS, wasShuffled } from './sound-events.ts';

function card(typeLine: string, colors: DraftCard['colors'] = []): DraftCard {
  return {
    cardId: typeLine,
    name: typeLine,
    manaCost: [],
    manaValue: 0,
    colors,
    typeLine,
    oracleText: '',
    setCode: 'tst',
    collectorNumber: '1',
    rarity: 'common',
  };
}

function entry(id: number, c: DraftCard, extra: Partial<BoardCard> = {}): BoardCard {
  return { id, card: c, tapped: false, summoningSick: false, damage: 0, counters: [], attacking: false, blocking: false, token: false, ...extra };
}

function player(id: number, isViewer: boolean, extra: Partial<BoardPlayer> = {}): BoardPlayer {
  return {
    id,
    name: isViewer ? 'alice' : 'bob',
    life: 20,
    isViewer,
    isActive: false,
    hasPriority: false,
    hasLost: false,
    hand: isViewer ? [] : null,
    handCount: 5,
    libraryCount: 30,
    battlefield: [],
    graveyard: [],
    exile: [],
    ...extra,
  };
}

function view(seq: number, me: Partial<BoardPlayer>, them: Partial<BoardPlayer> = {}, extra: Partial<BoardView> = {}): BoardView {
  return {
    seq,
    title: '',
    turn: 3,
    phase: 'MAIN1',
    phaseLabel: 'Main',
    activePlayerId: 1,
    players: [player(1, true, me), player(2, false, them)],
    stack: [],
    gameOver: false,
    missingCardIds: [],
    ...extra,
  };
}

function spell(id: number, c: DraftCard, controllerName: string, isAbility = false): StackEntry {
  return { id, description: c.name, sourceCardId: 100 + id, sourceName: c.name, sourceCard: c, controllerName, isAbility } as StackEntry;
}

const ids = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);
/** A fixed reordering that keeps no neighbours: odds then evens, reversed. */
const scramble = (list: readonly number[]): number[] => [...list.filter((_, i) => i % 2 === 1), ...list.filter((_, i) => i % 2 === 0)].reverse();

const BEAR = card('Creature — Bear', ['G']);
const GOLEM = card('Artifact Creature — Golem');
const FOREST = card('Basic Land — Forest');
const BOLT = card('Instant', ['R']);

describe('colours and types', () => {
  it('spells a colour set the way COLOUR_IDS does', () => {
    expect(colourRow([])).toBe('C');
    expect(colourRow(['G'])).toBe('G');
    expect(colourRow(['G', 'R'])).toBe('RG');
    expect(colourRow(['W', 'B', 'G'])).toBe('WBG');
    expect(colourRow(['W', 'U', 'B', 'R'])).toBe('WUBRG');
  });

  it('layers a card by its paradigm, and a basic land by its land type', () => {
    expect(colourCell(entry(1, BEAR))).toBe('G|creature');
    expect(colourCell(entry(1, GOLEM))).toBe('C|artifact-creature');
    expect(colourCell(entry(1, FOREST))).toBe('G|land');
    expect(colourCell(entry(1, card('Enchantment')))).toBeNull();
  });

  it('names the cast by the most specific type', () => {
    expect(castRole('Artifact Creature — Golem')).toBe('g.cast.creature');
    expect(castRole('Legendary Planeswalker — Jace')).toBe('g.cast.planeswalker');
    expect(castRole('Instant')).toBe('g.cast.instant');
    expect(castRole('Sorcery')).toBe('g.cast.sorcery');
    expect(castRole('Enchantment — Aura')).toBe('g.cast.enchantment');
  });
});

describe('deriveSoundEvents', () => {
  it('says nothing for the first view, or a view that is not newer', () => {
    const v = view(5, {});
    expect(deriveSoundEvents(null, v)).toEqual([]);
    expect(deriveSoundEvents(v, view(5, {}))).toEqual([]);
  });

  it('a creature spell: the quiet cast, then on resolution its voice, then the thud', () => {
    const before = view(1, { hand: [entry(101, BEAR)], handCount: 1 });
    const cast = view(2, { hand: [], handCount: 0 }, {}, { stack: [spell(1, BEAR, 'alice')] });
    expect(deriveSoundEvents(before, cast)).toEqual([{ role: 'g.cast.creature', seat: 'me' }]);

    const resolved = view(3, { hand: [], handCount: 0, battlefield: [entry(101, BEAR)] });
    expect(deriveSoundEvents(cast, resolved)).toEqual([
      { role: 'g.resolve', seat: 'me' },
      { role: 'g.creature', seat: 'me', colourCell: 'G|creature', delayMs: 60 },
      { role: 'g.enter', seat: 'me', delayMs: 60 + LAND_THUD_DELAY_MS },
    ]);
  });

  it("the opponent's instant resolves with its colour's spell cell, from their seat", () => {
    const cast = view(1, {}, {}, { stack: [spell(1, BOLT, 'bob')] });
    const done = view(2, {}, { graveyard: [entry(101, BOLT)] });
    expect(deriveSoundEvents(cast, done)).toEqual([{ role: 'g.resolve', seat: 'opp', colourCell: 'R|spell' }]);
  });

  it('a permanent spell that ends in the graveyard was countered', () => {
    const cast = view(1, {}, {}, { stack: [spell(1, BEAR, 'alice')] });
    const countered = view(2, { graveyard: [entry(101, BEAR)] });
    expect(deriveSoundEvents(cast, countered).map((e) => e.role)).toEqual(['g.counter']);
  });

  it('a land from hand plays the land role layered with its basic type', () => {
    const before = view(1, { hand: [entry(7, FOREST)], handCount: 1 });
    const after = view(2, { hand: [], handCount: 0, battlefield: [entry(7, FOREST)] });
    expect(deriveSoundEvents(before, after)).toEqual([{ role: 'g.land', seat: 'me', colourCell: 'G|land' }]);
  });

  it("a creature dying on your turn is your doing; a token appearing is its owner's", () => {
    const before = view(1, {}, { battlefield: [entry(9, BEAR)] });
    const after = view(2, { battlefield: [entry(10, BEAR, { token: true })] }, { graveyard: [entry(9, BEAR)] });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.token', seat: 'me' },
      { role: 'g.dies', seat: 'me' },
    ]);
  });

  it('several permanents untapping at once is the untap step, one tap is a tap', () => {
    const tapped = [entry(1, FOREST, { tapped: true }), entry(2, FOREST, { tapped: true })];
    const before = view(1, { battlefield: tapped });
    const after = view(2, { battlefield: [entry(1, FOREST), entry(2, FOREST, { tapped: true })] });
    expect(deriveSoundEvents(before, after).map((e) => e.role)).toEqual(['g.untap']);
    const all = view(3, { battlefield: [entry(1, FOREST), entry(2, FOREST)] });
    expect(deriveSoundEvents(before, all).map((e) => e.role)).toEqual(['g.untap-all']);
    const tap = view(4, { battlefield: [entry(1, FOREST, { tapped: true }), entry(2, FOREST, { tapped: true }), entry(3, FOREST, { tapped: true })] });
    expect(deriveSoundEvents(view(3, { battlefield: [...all.players[0]!.battlefield, entry(3, FOREST)] }), tap).map((e) => e.role)).toEqual([
      'g.tap',
      'g.tap',
      'g.tap',
    ]);
  });

  it('draws, damage to a player and life gain read off the player', () => {
    const before = view(1, { handCount: 5, libraryCount: 30, life: 20 }, { life: 20 });
    const after = view(2, { handCount: 6, libraryCount: 29, life: 23 }, { life: 17 });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.draw', seat: 'me' },
      { role: 'g.lifegain', seat: 'me' },
      { role: 'g.damage-player', seat: 'me' },
    ]);
  });

  it('a new turn is whose turn it is, and says nothing else about the phase', () => {
    const before = view(1, {}, {}, { turn: 3, activePlayerId: 1, phase: 'CLEANUP' });
    const after = view(2, {}, {}, { turn: 4, activePlayerId: 2, phase: 'UNTAP' });
    expect(deriveSoundEvents(before, after)).toEqual([{ role: 'g.turn-theirs', seat: 'me' }]);
  });

  it('attackers and blockers, from their controllers', () => {
    const before = view(1, { battlefield: [entry(1, BEAR)] }, { battlefield: [entry(2, BEAR)] });
    const after = view(2, { battlefield: [entry(1, BEAR, { attacking: true, tapped: true })] }, { battlefield: [entry(2, BEAR, { blocking: true })] });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.tap', seat: 'me' },
      { role: 'g.attack', seat: 'me' },
      { role: 'g.block', seat: 'opp' },
    ]);
  });

  it('the end of the game is a win or a loss and nothing else', () => {
    const before = view(1, {});
    expect(deriveSoundEvents(before, view(2, { life: 0, hasLost: true }, {}, { gameOver: true }))).toEqual([{ role: 'g.lose', seat: 'me' }]);
    expect(deriveSoundEvents(before, view(2, {}, { hasLost: true }, { gameOver: true }))).toEqual([{ role: 'g.win', seat: 'me' }]);
  });

  it('a mulligan sends the hand back and shuffles', () => {
    const library = ids(1, 33);
    const before = view(1, { handCount: 7, libraryCount: 33, libraryIds: library });
    const after = view(2, { handCount: 0, libraryCount: 40, libraryIds: scramble([...library, ...ids(34, 7)]) });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.mulligan', seat: 'me' },
      { role: 'g.shuffle', seat: 'me', delayMs: 250 },
    ]);
  });

  it('a London mulligan is one delta: the same counts, a new hand, the library shuffled', () => {
    // The shape `mulligan.jvm.test.ts` reads off real Forge: 53 → 53, 7 → 7.
    const library = ids(1, 53);
    const before = view(1, { handCount: 7, libraryCount: 53, libraryIds: library });
    const after = view(2, { handCount: 7, libraryCount: 53, libraryIds: scramble([...library.slice(7), ...ids(60, 7)]) });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.mulligan', seat: 'me' },
      { role: 'g.shuffle', seat: 'me', delayMs: 250 },
    ]);
  });

  it('a library reordered in place is a shuffle, whoever owns it', () => {
    const library = ids(1, 30);
    expect(deriveSoundEvents(view(1, {}, { libraryIds: library }), view(2, {}, { libraryIds: scramble(library) }))).toEqual([
      { role: 'g.shuffle', seat: 'opp' },
    ]);
  });

  it('a tutor is a card leaving and the rest shuffled', () => {
    const library = ids(1, 30);
    const after = scramble(library.filter((id) => id !== 12));
    expect(wasShuffled(library, after)).toBe(true);
  });

  it('a draw, a mill, a scry or a card put on top is not a shuffle', () => {
    const library = ids(1, 30);
    expect(wasShuffled(library, library.slice(1))).toBe(false);
    expect(wasShuffled(library, library.slice(3))).toBe(false);
    expect(wasShuffled(library, [...library.slice(2), library[1]!, library[0]!])).toBe(false);
    expect(wasShuffled(library, [99, ...library])).toBe(false);
    expect(wasShuffled(library, [library[1]!, library[0]!, ...library.slice(2)])).toBe(false);
  });

  it('too few shared cards to tell, or nothing known, stays quiet', () => {
    expect(wasShuffled([1, 2, 3], [3, 1, 2])).toBe(false);
    expect(wasShuffled(undefined, [1, 2, 3, 4])).toBe(false);
  });

  it('a view that changes everything at once is a snapshot, not a moment', () => {
    const before = view(1, { battlefield: [] });
    const after = view(2, { battlefield: Array.from({ length: 30 }, (_, i) => entry(i + 1, BEAR)) });
    expect(deriveSoundEvents(before, after)).toEqual([]);
  });
});

describe('against a real captured game', () => {
  /*
   * The deriver's zone moves assume a card keeps its id from hand to stack to
   * battlefield (`fold.ts` replaces the object on a zone change). This replays
   * the committed Tier C capture one packet at a time and proves the stream
   * comes out as a game sounds: a creature cast in one view resolves with its
   * voice in a later one, lands come from hand with their basic type.
   */
  it('turns the captured stream into the moments a game is made of', () => {
    const fixture = PLAY_FIXTURES[0]!;
    const packets = loadPackets(fixture);
    const roles = new Set<string>();
    const cells = new Set<string>();
    let prev: BoardView | null = null;
    for (let k = 1; k <= packets.length; k++) {
      const { state, seq } = foldPackets(packets.slice(0, k));
      const next = toBoardView(state, seq, { viewerPlayerId: fixture.viewerPlayerId });
      for (const e of deriveSoundEvents(prev, next)) {
        roles.add(e.role);
        if (e.colourCell != null) cells.add(e.colourCell);
      }
      prev = next;
    }
    for (const role of ['g.turn-mine', 'g.turn-theirs', 'g.draw', 'g.land', 'g.cast.creature', 'g.resolve', 'g.creature', 'g.enter', 'g.tap', 'g.untap-all', 'g.attack', 'g.block', 'g.dies', 'g.damage-player']) {
      expect(roles, role).toContain(role);
    }
    expect(roles, 'no false shuffles in an ordinary game').not.toContain('g.shuffle');
    expect(cells).toContain('R|land');
    expect(cells).toContain('R|creature');
  });
});
