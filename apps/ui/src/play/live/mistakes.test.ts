/*
 * The classifier alone (`./mistakes.ts`): a pure function of a `BoardView`, a `refusal()` reason and
 * a card id. `match.ts`'s own wiring (storing the result on `match.mistake`, the auto-cancel path's
 * `payingMana` timing) is proved in `match.test.ts` instead — this file is "is the shape right",
 * not "is match.ts plumbed right".
 */
import { describe, expect, it } from 'vitest';

import type { BoardCard, BoardPlayer, BoardView } from '../adapter.ts';
import { mistakeOfAutoCancel, mistakeOfClick, MISTAKE_LINES, type MistakeKey } from './mistakes.ts';

function card(id: number, typeLine: string, extra: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    card: {
      cardId: `c-${id}`,
      name: `Card ${id}`,
      manaCost: [],
      manaValue: 0,
      colors: [],
      typeLine,
      oracleText: '',
      setCode: 'TST',
      collectorNumber: '1',
      rarity: 'common',
    },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
    ...extra,
  };
}

function player(extra: Partial<BoardPlayer> = {}): BoardPlayer {
  return {
    id: 0,
    name: 'Alice',
    life: 20,
    isViewer: true,
    isActive: true,
    hasPriority: true,
    hasLost: false,
    hand: [],
    handCount: 0,
    libraryCount: 0,
    battlefield: [],
    graveyard: [],
    exile: [],
    ...extra,
  };
}

function view(me: BoardPlayer): BoardView {
  return {
    seq: 1,
    title: 't',
    turn: 1,
    phase: 'MAIN1',
    phaseLabel: '',
    activePlayerId: me.id,
    players: [me, { ...player(), id: 1, isViewer: false, name: 'Bob' }],
    stack: [],
    gameOver: false,
    missingCardIds: [],
  };
}

describe('mistakeOfClick: only the shapes Forge’s own state answers for certain', () => {
  it('a second land press is "land" only once NumLandThisTurn reaches MaxLandPlay', () => {
    const land = card(1, 'Basic Land — Forest');
    const me = player({ hand: [land], numLandThisTurn: 0, maxLandPlay: 1 });
    expect(mistakeOfClick(view(me), 'not-offered', 1)).toBeNull();
    const reached = player({ hand: [land], numLandThisTurn: 1, maxLandPlay: 1 });
    expect(mistakeOfClick(view(reached), 'not-offered', 1)).toBe('land');
  });

  it('is null for a land refusal when the count is not on the view at all (no guessing)', () => {
    const land = card(1, 'Basic Land — Forest');
    const me = player({ hand: [land] });
    expect(mistakeOfClick(view(me), 'not-offered', 1)).toBeNull();
  });

  it('a press with no priority is "priority" — "no-input" and "nothing-offered" alike', () => {
    const me = player({ hasPriority: false });
    expect(mistakeOfClick(view(me), 'no-input', 7)).toBe('priority');
    expect(mistakeOfClick(view(me), 'nothing-offered', 7)).toBe('priority');
  });

  it('is null for "no-input"/"nothing-offered" while the seat DOES have priority — a real gap, not this seat’s mistake', () => {
    const me = player({ hasPriority: true });
    expect(mistakeOfClick(view(me), 'no-input', 7)).toBeNull();
    expect(mistakeOfClick(view(me), 'nothing-offered', 7)).toBeNull();
  });

  it('an attack aim at a summoning-sick creature is "sick" — haste already excluded by the board', () => {
    const sick = card(2, 'Creature — Bear', { summoningSick: true });
    const me = player({ battlefield: [sick] });
    expect(mistakeOfClick(view(me), 'not-offered', 2)).toBe('sick');
    const hasty = card(3, 'Creature — Bear', { summoningSick: false });
    const notSick = player({ battlefield: [hasty] });
    expect(mistakeOfClick(view(notSick), 'not-offered', 3)).toBeNull();
  });

  it('a plain "not-offered" on a nonland, non-sick card says nothing — ambiguous: timing, CantBeCast or no legal target', () => {
    const spell = card(4, 'Instant');
    const me = player({ hand: [spell] });
    expect(mistakeOfClick(view(me), 'not-offered', 4)).toBeNull();
  });

  it('every other refusal reason says nothing', () => {
    const me = player();
    for (const reason of ['no-view', 'disconnected', 'spent', 'ask-open', 'not-in-selection', 'not-in-view']) {
      expect(mistakeOfClick(view(me), reason, 1)).toBeNull();
    }
  });

  it('a null view (no match drawn yet) says nothing', () => {
    expect(mistakeOfClick(null, 'not-offered', 1)).toBeNull();
  });

  it('a card id in neither the viewer’s hand nor battlefield says nothing', () => {
    const me = player();
    expect(mistakeOfClick(view(me), 'not-offered', 999)).toBeNull();
  });
});

describe('mistakeOfAutoCancel: the one case flashIncorrectAction answers for certain', () => {
  it('is always "mana" — match.ts calls it only while payingMana(match) is still true', () => {
    expect(mistakeOfAutoCancel()).toBe('mana');
  });
});

describe('MISTAKE_LINES: the operator’s own words, one per key, first person', () => {
  it('has exactly the four keys, each a non-empty line', () => {
    const keys: MistakeKey[] = ['land', 'priority', 'sick', 'mana'];
    expect(Object.keys(MISTAKE_LINES).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(MISTAKE_LINES[k].length).toBeGreaterThan(0);
  });

  it('is the operator’s wording for "sick", replacing the preview’s own', () => {
    expect(MISTAKE_LINES.sick).toBe('Give that creature a turn to get ready.');
  });
});
