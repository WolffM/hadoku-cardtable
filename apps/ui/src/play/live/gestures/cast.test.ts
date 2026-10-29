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

  it('null for a 0-heft permanent — a land (mana value 0) or a 0-power creature — never a weight tail to fight landCastGhost\'s own float-home (played-card.spec.ts, 2026-10-28)', () => {
    const v = view([player(1, [card(5, 'Land', { manaValue: 0 }), card(6, 'Creature — Construct', { power: '0' })])]);
    expect(castLandingWeight(v, 5)).toBeNull();
    expect(castLandingWeight(v, 6)).toBeNull();
  });
});

const rect = (x: number, y: number, width: number, height: number): DOMRect =>
  ({ left: x - width / 2, top: y - height / 2, width, height, right: x + width / 2, bottom: y + height / 2, x: x - width / 2, y: y - height / 2, toJSON: () => null }) as DOMRect;

/** A card drawn at `x`,`y` in a board with an overlay: on a battlefield, or (`zone`) somewhere else. */
function arrivedAt(x: number, y: number, zone = 'battlefield'): HTMLElement {
  const board = document.createElement('div');
  board.className = 'board';
  const overlay = document.createElement('div');
  overlay.setAttribute('data-board-overlay', '');
  const row = document.createElement('ul');
  row.setAttribute('data-zone', zone);
  const li = document.createElement('li');
  li.setAttribute('data-board-card', '7');
  li.getBoundingClientRect = () => rect(x, y, 60, 84);
  row.append(li);
  board.append(row, overlay);
  document.body.append(board);
  return li;
}

/** A stand-in drawn at `x`,`y`, `width` wide. */
function ghostAt(x: number, y: number, width = 60): HTMLElement {
  const ghost = document.createElement('div');
  ghost.getBoundingClientRect = () => rect(x, y, width, width * 1.4);
  document.body.append(ghost);
  return ghost;
}

const entries = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('.board-entry');

describe('landCastGhost', () => {
  it('a weightless stand-in already where the card is drawn swaps in place: no trip, the card shown at once', () => {
    const arrived = arrivedAt(400, 300);
    arrived.setAttribute(CAST_LANDING_ATTR, '');
    const ghost = ghostAt(401, 302);
    expect(landCastGhost(document, 7, ghost, { x: 401, y: 302 }, arrived)).toEqual({ how: 'swap', from: { x: 401, y: 302 }, to: { x: 400, y: 300 }, shrink: 0 });
    expect(ghost.isConnected, 'the stand-in is gone').toBe(false);
    expect(entries(), 'nothing travels').toHaveLength(0);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the card is not hidden').toBe(false);
  });

  it('a stand-in at rest in the gap its card took, a few px off the card, swaps in place too (w67-shaman’s bears: a 300 ms flight of 4–5 px)', () => {
    const arrived = arrivedAt(454, 280);
    const ghost = ghostAt(450, 283);
    landCastGhost(document, 7, ghost, { x: 450, y: 283 }, arrived);
    expect(ghost.isConnected, 'no trip').toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the card is shown at once').toBe(false);
  });

  it('onto a battlefield from anywhere else it is ONE entry stand-in from the start (W79 2b/2c): the ghost gone at once, the card hidden until it touches down', async () => {
    const arrived = arrivedAt(400, 60);
    const ghost = ghostAt(500, 400, 85);
    expect(landCastGhost(document, null, ghost, { x: 500, y: 400 }, arrived, entryWeight(15)).how).toBe('flight');
    expect(ghost.isConnected, 'the ghost hands over to the entry in the same task').toBe(false);
    expect([...entries()].map((e) => e.dataset.entry)).toEqual(['cast']);
    expect(entries()[0]!.closest('[data-board-overlay]'), 'in the overlay, never position: fixed inside the board a shake transforms').not.toBeNull();
    expect(arrived.hasAttribute(CAST_LANDING_ATTR)).toBe(true);
    await vi.waitFor(() => expect(entries(), 'it touched down').toHaveLength(0));
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the row card is shown where it landed').toBe(false);
  });

  it('a weighted card already over its slot still lifts and drops: the landing is the entry, never a swap that skips it', () => {
    const arrived = arrivedAt(400, 300);
    landCastGhost(document, 7, ghostAt(400, 300), { x: 400, y: 300 }, arrived, entryWeight(5));
    expect(entries()).toHaveLength(1);
  });

  it('the stand-in never carries the landing mark that hides its row card', () => {
    const arrived = arrivedAt(400, 60);
    arrived.setAttribute(CAST_LANDING_ATTR, '');
    landCastGhost(document, 7, ghostAt(500, 400), { x: 500, y: 400 }, arrived);
    expect(entries()[0]!.querySelector(`[${CAST_LANDING_ATTR}]`)).toBeNull();
  });

  it('a card going home to a hand back — not a battlefield — floats there, the back hidden until it does', () => {
    vi.useFakeTimers();
    const arrived = arrivedAt(400, 60, 'hand');
    const ghost = document.createElement('div');
    expect(landCastGhost(document, null, ghost, { x: 500, y: 400 }, arrived).how).toBe('flight');
    expect(ghost.getAttribute(CAST_LIFT_ATTR)).toBe('returning');
    expect([ghost.style.left, ghost.style.top]).toEqual(['400px', '60px']);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR)).toBe(true);
    vi.advanceTimersByTime(GLIDE_MS);
    expect(ghost.isConnected).toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR)).toBe(false);
  });

  it('a stand-in waiting over its slot at a hand card’s size says so from the box it starts at — not a frame sampled later', () => {
    const arrived = arrivedAt(454, 602);
    const ghost = ghostAt(454, 602, 85);
    expect(landCastGhost(document, 7, ghost, { x: 454, y: 602 }, arrived)).toEqual({ how: 'flight', from: { x: 454, y: 602 }, to: { x: 454, y: 602 }, shrink: 25 });
  });
});
