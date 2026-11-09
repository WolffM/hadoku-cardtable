// @vitest-environment jsdom
/*
 * The passive arrow for an already-decided target: `combatArrows` is this
 * file's one producer left (wave 64/J6 deleted the other two, `autoTargetArrows`
 * and `stackTargetArrows` — see `./auto-targets.ts`'s header for why neither
 * had a production caller left).
 *
 * Unlike `gestures.test.ts`, nothing here is about the wire: `combatArrows`
 * sends nothing and answers no ask, so these are about what gets DRAWN from a
 * `BoardView`'s own `view.combat`, and from the DOM `Board.tsx` renders for it.
 * These build a `LiveMatch`-shaped stub by hand rather than driving one through
 * `gestures.test.ts`'s replay-server harness.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { combatArrows } from './auto-targets.ts';
import { clearAutoTargetArrows, drawAutoTargetArrows, landArrow, newArrow } from './arrow.ts';
import type { LiveMatch } from '../match.ts';
import type { BoardView, CombatBand } from '../../adapter.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A `LiveMatch` stub carrying only what `combatArrows` reads. */
function matchWithCombat(combat: CombatBand[]): LiveMatch {
  const view = { combat } as unknown as BoardView;
  return { view } as unknown as LiveMatch;
}

function el(attrs: Record<string, string>): HTMLElement {
  const node = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  document.body.append(node);
  return node;
}

describe('drawAutoTargetArrows', () => {
  function overlay(): HTMLElement {
    const node = document.createElement('div');
    document.body.append(node);
    return node;
  }

  it('creates one SVG per spec, keyed by data-key, with the auto-target class and no interactive testid', () => {
    const box = overlay();
    const to1 = el({});
    const to2 = el({});
    drawAutoTargetArrows(box, [
      { key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card', role: 'attack' },
      { key: 'b', from: { x: 0, y: 0 }, to: to2, kind: 'player', role: 'block' },
    ]);
    const arrows = [...box.querySelectorAll('[data-testid="stack-target-arrow"]')];
    expect(arrows).toHaveLength(2);
    expect(arrows.map((a) => a.getAttribute('data-key')).sort()).toEqual(['a', 'b']);
    // An attack and a block are told apart by `data-role`, which the stylesheet colours.
    expect(arrows.map((a) => `${a.getAttribute('data-key')}:${a.getAttribute('data-role')}`).sort()).toEqual(['a:attack', 'b:block']);
    for (const a of arrows) {
      expect(a.classList.contains('arrow--auto')).toBe(true);
      expect(a.querySelector('path')).not.toBeNull();
      expect(a.querySelector('polygon')).not.toBeNull();
    }
    // The one interactive arrow's own testid is never touched by this function.
    expect(box.querySelector('[data-testid="targeter"]')).toBeNull();
  });

  it('removes an arrow whose spec is gone, and leaves the DOM NODE of a surviving one alone', () => {
    const box = overlay();
    const to1 = el({});
    const to2 = el({});
    drawAutoTargetArrows(box, [
      { key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card', role: 'attack' },
      { key: 'b', from: { x: 0, y: 0 }, to: to2, kind: 'player', role: 'block' },
    ]);
    const kept = box.querySelector('[data-testid="stack-target-arrow"][data-key="a"]');
    drawAutoTargetArrows(box, [{ key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card', role: 'attack' }]);
    const arrows = [...box.querySelectorAll('[data-testid="stack-target-arrow"]')];
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toBe(kept);
  });

  it('draws nothing, and removes everything, once the spec list is empty', () => {
    const box = overlay();
    const to1 = el({});
    drawAutoTargetArrows(box, [{ key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card', role: 'attack' }]);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(1);
    drawAutoTargetArrows(box, []);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(0);
  });

  it("a cast's aim gives way to its stack item's own arrow at the same target, at once and for good", () => {
    const box = overlay();
    const bob = el({});
    const aimed = { key: 'aim:player:1', from: { x: 0, y: 0 }, to: bob, kind: 'player', role: 'aim', source: 7 } as const;
    drawAutoTargetArrows(box, [aimed]);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(1);
    const placed = newArrow({ className: 'placed__arrow', testid: 'placed-arrow' });
    box.append(placed);
    landArrow(box, placed, bob, 7);
    expect(box.querySelectorAll('svg.arrow'), 'the stack item lands its arrow: the aim goes in the same frame').toHaveLength(1);
    drawAutoTargetArrows(box, [aimed]);
    expect(box.querySelectorAll('svg.arrow'), 'and a stale selection does not draw it again').toHaveLength(1);
  });

  it("another card's aim at the same target, or this card's at another, stays", () => {
    const box = overlay();
    const bob = el({});
    const elsewhere = el({});
    const placed = newArrow({ className: 'placed__arrow', testid: 'placed-arrow' });
    box.append(placed);
    landArrow(box, placed, bob, 7);
    drawAutoTargetArrows(box, [
      { key: 'aim:player:1', from: { x: 0, y: 0 }, to: bob, kind: 'player', role: 'aim', source: 8 },
      { key: 'aim:card:2', from: { x: 0, y: 0 }, to: elsewhere, kind: 'card', role: 'aim', source: 7 },
    ]);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(2);
  });

  it('clearAutoTargetArrows takes every one away, and a null overlay is a no-op', () => {
    const box = overlay();
    const to1 = el({});
    drawAutoTargetArrows(box, [{ key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card', role: 'attack' }]);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(1);
    clearAutoTargetArrows(box);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(0);
    expect(() => clearAutoTargetArrows(null)).not.toThrow();
  });
});

/*
 * X1 — the lasting attack arrow, drawn from `view.combat` rather than a
 * stack item's own target. Same "build a stub by hand" style as the block
 * above: `combatArrows` reads nothing but `match.view.combat` and the DOM.
 */
describe('combatArrows', () => {
  it('draws attacker → defender for a card defender (a planeswalker or a battle)', () => {
    el({ 'data-board-card': '10' });
    const pw = el({ 'data-board-card': '55' });
    const match = matchWithCombat([{ attackers: [10], defender: { kind: 'card', id: 55 } }]);
    const arrows = combatArrows(document.body, match, new Set());
    expect(arrows).toEqual([{ key: 'combat:10', from: expect.anything(), to: pw, kind: 'card', role: 'attack' }]);
    expect(arrows[0]!.to).toBe(pw);
  });

  it('draws attacker → defender for a player defender, off the face box', () => {
    el({ 'data-board-card': '10' });
    const face = el({ 'data-player-face': '', 'data-player-id': '1' });
    const match = matchWithCombat([{ attackers: [10], defender: { kind: 'player', id: 1 } }]);
    const arrows = combatArrows(document.body, match, new Set());
    expect(arrows).toEqual([{ key: 'combat:10', from: expect.anything(), to: face, kind: 'player', role: 'attack' }]);
  });

  it('draws one arrow per attacker in a multi-attacker band, all to the same defender', () => {
    el({ 'data-board-card': '10' });
    el({ 'data-board-card': '11' });
    const face = el({ 'data-player-face': '', 'data-player-id': '1' });
    const match = matchWithCombat([{ attackers: [10, 11], defender: { kind: 'player', id: 1 } }]);
    const arrows = combatArrows(document.body, match, new Set());
    expect(arrows.map((a) => a.key).sort()).toEqual(['combat:10', 'combat:11']);
    for (const a of arrows) expect(a.to).toBe(face);
  });

  it('skips a band whose attacker or defender is not on screen', () => {
    // Neither card 10 nor player 1 is mounted.
    const match = matchWithCombat([{ attackers: [10], defender: { kind: 'player', id: 1 } }]);
    expect(combatArrows(document.body, match, new Set())).toEqual([]);
  });

  it('on a phone held upright an attack on a player points at the middle of that player’s edge; one on a card keeps its card', () => {
    document.documentElement.dataset.layout = 'portrait';
    try {
      const board = el({ class: 'board' });
      board.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
      el({ 'data-board-card': '10' });
      el({ 'data-board-card': '20' });
      el({ 'data-player-face': '', 'data-player-id': '1' });
      el({ 'data-player-face': '', 'data-player-id': '2' });
      const pw = el({ 'data-board-card': '55' });
      const view = {
        players: [
          { id: 1, isViewer: false },
          { id: 2, isViewer: true },
        ],
        combat: [
          { attackers: [10], defender: { kind: 'player', id: 1 } },
          { attackers: [20], defender: { kind: 'player', id: 2 } },
          { attackers: [30], defender: { kind: 'card', id: 55 } },
        ],
      } as unknown as BoardView;
      el({ 'data-board-card': '30' });
      const arrows = combatArrows(document.body, { view } as unknown as LiveMatch, new Set());
      const byKey = Object.fromEntries(arrows.map((a) => [a.key, a]));
      expect(byKey['combat:10']!.toward, 'ours: the top edge’s middle').toEqual({ x: 195, y: 12 });
      expect(byKey['combat:20']!.toward, 'theirs: the bottom edge’s middle').toEqual({ x: 195, y: 832 });
      expect(byKey['combat:30']!.toward, 'a planeswalker keeps its card').toBeUndefined();
      expect(byKey['combat:30']!.to).toBe(pw);
    } finally {
      delete document.documentElement.dataset.layout;
    }
  });

  // The operator, 2026-11-09: "i wanted creatures to auto-target the player, not for the combat arrow to be gone".
  it('draws the arrow when the player was the only defender to choose', () => {
    el({ 'data-board-card': '10' });
    const face = el({ 'data-player-face': '', 'data-player-id': '1' });
    const view = {
      players: [
        { id: 1, isViewer: false, hasLost: false, battlefield: [{ id: 40, card: { typeLine: 'Creature — Wall' } }] },
        { id: 2, isViewer: true, hasLost: false, battlefield: [{ id: 10, card: { typeLine: 'Creature — Bear' } }] },
      ],
      combat: [{ attackers: [10], defender: { kind: 'player', id: 1 } }],
    } as unknown as BoardView;
    const arrows = combatArrows(document.body, { view } as unknown as LiveMatch, new Set());
    expect(arrows.map((a) => [a.key, a.to, a.role])).toEqual([['combat:10', face, 'attack']]);
  });

  it('draws nothing outside combat — an absent or empty `view.combat`', () => {
    expect(combatArrows(document.body, matchWithCombat([]), new Set())).toEqual([]);
    expect(combatArrows(document.body, { view: {} } as unknown as LiveMatch, new Set())).toEqual([]);
  });
});
