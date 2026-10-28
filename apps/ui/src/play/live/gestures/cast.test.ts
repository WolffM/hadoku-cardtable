// @vitest-environment jsdom
/*
 * `landCastGhost`: the one trip a card makes to its place, on either screen —
 * and the trip it does not make when it is already there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CAST_LANDING_ATTR, CAST_LIFT_ATTR, castLandingWeight, landCastGhost } from './cast.ts';
import { GLIDE_MS } from '../../motion.ts';
import { entryHeft, entryWeight } from '../entries.ts';
import type { BoardCard, BoardPlayer, BoardView } from '../../adapter.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function card(id: number, typeLine: string, opts: { power?: string; manaValue?: number } = {}): BoardCard {
  return {
    id,
    card: {
      cardId: `c${id}`,
      name: `Card ${id}`,
      manaCost: [],
      manaValue: opts.manaValue ?? 0,
      colors: [],
      typeLine,
      oracleText: '',
      setCode: 'TST',
      collectorNumber: String(id),
      rarity: 'common',
      ...(opts.power !== undefined ? { power: opts.power } : {}),
    },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
  };
}

function player(id: number, battlefield: BoardCard[]): BoardPlayer {
  return {
    id,
    name: `P${id}`,
    life: 20,
    isViewer: false,
    isActive: false,
    hasPriority: false,
    hasLost: false,
    hand: null,
    handCount: 0,
    libraryCount: 0,
    battlefield,
    graveyard: [],
    exile: [],
  };
}

function view(players: BoardPlayer[]): BoardView {
  return { seq: 1, title: 't', turn: 1, phase: null, phaseLabel: '', activePlayerId: null, players, stack: [], gameOver: false, missingCardIds: [] };
}

describe('castLandingWeight', () => {
  it('a cast creature weighs by its power, off its own card data — never a DOM badge', () => {
    const v = view([player(1, [card(7, 'Creature — Bear', { power: '8' })])]);
    expect(castLandingWeight(v, 7)).toEqual(entryWeight(entryHeft({ typeLine: 'Creature — Bear', power: '8' })));
    expect(castLandingWeight(v, 7)?.power).toBeCloseTo(entryWeight(8).power);
  });

  it('a cast noncreature permanent weighs by its mana value, where a power badge never exists', () => {
    const v = view([player(1, [card(9, 'Artifact', { manaValue: 8 })])]);
    const weight = castLandingWeight(v, 9);
    expect(weight).not.toBeNull();
    expect(weight).toEqual(entryWeight(8));
    expect(weight?.cracks).not.toBeNull();
  });

  it('null for a card not yet drawn anywhere on the battlefield, or with no id', () => {
    const v = view([player(1, [card(9, 'Artifact', { manaValue: 8 })])]);
    expect(castLandingWeight(v, 999)).toBeNull();
    expect(castLandingWeight(v, null)).toBeNull();
    expect(castLandingWeight(null, 9)).toBeNull();
  });
});

function arrivedAt(x: number, y: number): HTMLElement {
  const board = document.createElement('div');
  board.className = 'board';
  const li = document.createElement('li');
  li.getBoundingClientRect = () => ({ left: x - 30, top: y - 42, width: 60, height: 84, right: x + 30, bottom: y + 42, x: x - 30, y: y - 42, toJSON: () => null }) as DOMRect;
  board.append(li);
  document.body.append(board);
  return li;
}

describe('landCastGhost', () => {
  it('a stand-in already where the card is drawn swaps in place: no flight, the card shown at once', () => {
    const arrived = arrivedAt(400, 300);
    arrived.setAttribute(CAST_LANDING_ATTR, '');
    const ghost = document.createElement('div');
    document.body.append(ghost);
    expect(landCastGhost(document, 7, ghost, { x: 401, y: 302 }, arrived)).toEqual({ how: 'swap', from: { x: 401, y: 302 }, to: { x: 400, y: 300 }, shrink: 0 });
    expect(ghost.isConnected, 'the stand-in is gone').toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the card is not hidden').toBe(false);
  });

  it('a stand-in at rest in the gap its card took, a few px off the card, swaps in place too (w67-shaman’s bears: a 300 ms flight of 4–5 px)', () => {
    const arrived = arrivedAt(454, 280);
    const ghost = document.createElement('div');
    document.body.append(ghost);
    landCastGhost(document, 7, ghost, { x: 450, y: 283 }, arrived);
    expect(ghost.isConnected, 'no flight').toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the card is shown at once').toBe(false);
  });

  it('from anywhere else it travels, the card hidden until it lands — a card of no id (their hidden hand) included', () => {
    vi.useFakeTimers();
    const arrived = arrivedAt(400, 60);
    const ghost = document.createElement('div');
    expect(landCastGhost(document, null, ghost, { x: 500, y: 400 }, arrived).how).toBe('flight');
    expect(ghost.getAttribute(CAST_LIFT_ATTR)).toBe('returning');
    expect([ghost.style.left, ghost.style.top]).toEqual(['400px', '60px']);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR)).toBe(true);
    vi.advanceTimersByTime(GLIDE_MS);
    expect(ghost.isConnected).toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR)).toBe(false);
  });

  it('a stand-in waiting over its slot at a hand card’s size shrinks into it in place, and says so from the box it starts at — not a frame sampled later in the shrink', () => {
    vi.useFakeTimers();
    const arrived = arrivedAt(454, 602);
    const ghost = document.createElement('div');
    ghost.getBoundingClientRect = () => ({ left: 454 - 42.5, top: 602 - 59, width: 85, height: 118, right: 454 + 42.5, bottom: 602 + 59, x: 454 - 42.5, y: 602 - 59, toJSON: () => null }) as DOMRect;
    document.body.append(ghost);
    expect(landCastGhost(document, 7, ghost, { x: 454, y: 602 }, arrived)).toEqual({ how: 'flight', from: { x: 454, y: 602 }, to: { x: 454, y: 602 }, shrink: 25 });
    expect([ghost.style.width, ghost.style.height], 'it ends at the slot’s size').toEqual(['60px', '84px']);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the card hidden under it until it lands').toBe(true);
  });
});
