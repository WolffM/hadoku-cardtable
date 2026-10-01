// @vitest-environment jsdom
/*
 * The passive arrow for an already-decided target (first list item 8).
 *
 * Unlike `gestures.test.ts`, nothing here is about the wire: `autoTargetArrows`
 * sends nothing and answers no ask, so these are about what gets DRAWN from a
 * `BoardView`'s own stack, and from the DOM `Board.tsx` renders for it.
 *
 * **Unit-tested only.** `StackEntry.targetCardIds` / `targetPlayerIds` (shape 2,
 * `adapter.ts`'s `readIds(item, 'TargetCards'/'TargetPlayers')`) landed in lane
 * B's half of this wave while this was being written, but lane S's own
 * `auto-target` scenario and real-Forge evidence for whether `TargetCards`
 * reaches the browser at all (`wave33-evidence/s3-auto-target.md` or similar)
 * had not, when this was last checked — so there is still no committed fixture
 * of a real match whose stack carries a real target. These build a
 * `LiveMatch`-shaped stub by hand instead of driving one through
 * `gestures.test.ts`'s replay-server harness. Once S's evidence and scenario
 * land, the real path (a live match → a stack item with a real target → this
 * arrow) should be re-verified end to end — ideally by `e2e/`'s own
 * auto-target spec; this file proves the drawing logic alone.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { autoTargetArrows } from './auto-targets.ts';
import { clearAutoTargetArrows, drawAutoTargetArrows } from './arrow.ts';
import type { LiveMatch } from '../match.ts';
import type { BoardView, StackEntry } from '../../adapter.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A stack entry, with shape 2's fields — optional on `StackEntry` until B lands it, real here. */
function stackEntry(
  id: number,
  targetCardIds: number[] = [],
  targetPlayerIds: number[] = [],
): StackEntry & { targetCardIds: number[]; targetPlayerIds: number[] } {
  return {
    id,
    description: 'Fiend Hunter — Exile target creature',
    sourceCardId: 900 + id,
    sourceName: 'Fiend Hunter',
    sourceCard: null,
    controllerName: null,
    isAbility: false,
    targetCardIds,
    targetPlayerIds,
  };
}

/** A `LiveMatch` stub carrying only what `autoTargetArrows` reads. */
function matchWithStack(stack: StackEntry[]): LiveMatch {
  const view = { stack } as unknown as BoardView;
  return { view } as unknown as LiveMatch;
}

function el(attrs: Record<string, string>): HTMLElement {
  const node = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  document.body.append(node);
  return node;
}

describe('autoTargetArrows', () => {
  it('draws one arrow per target the stack item names, card and player alike', () => {
    el({ 'data-stack-id': '50' });
    const card = el({ 'data-board-card': '12' });
    const face = el({ 'data-player-face': '', 'data-player-id': '1' });
    const match = matchWithStack([stackEntry(50, [12], [1])]);

    const arrows = autoTargetArrows(document.body, match);
    expect(arrows.map((a) => a.key).sort()).toEqual(['50:card:12', '50:player:1']);
    expect(arrows.find((a) => a.key === '50:card:12')!.to).toBe(card);
    expect(arrows.find((a) => a.key === '50:card:12')!.kind).toBe('card');
    expect(arrows.find((a) => a.key === '50:player:1')!.to).toBe(face);
    expect(arrows.find((a) => a.key === '50:player:1')!.kind).toBe('player');
  });

  it('draws nothing for a stack item with no targets', () => {
    el({ 'data-stack-id': '50' });
    const match = matchWithStack([stackEntry(50)]);
    expect(autoTargetArrows(document.body, match)).toEqual([]);
  });

  it('skips a target whose element is not on screen — a guess is never drawn as a fact', () => {
    el({ 'data-stack-id': '50' });
    // Card 12 never mounted.
    const match = matchWithStack([stackEntry(50, [12])]);
    expect(autoTargetArrows(document.body, match)).toEqual([]);
  });

  it('skips a stack item whose own box is not on screen', () => {
    // No [data-stack-id="50"] at all.
    el({ 'data-board-card': '12' });
    const match = matchWithStack([stackEntry(50, [12])]);
    expect(autoTargetArrows(document.body, match)).toEqual([]);
  });

  it('degrades to no arrows when the fields are absent — the pre-shape-2 case', () => {
    el({ 'data-stack-id': '50' });
    el({ 'data-board-card': '12' });
    // Cast away the fields entirely, as a `StackEntry` from before shape 2 would arrive.
    const bare: StackEntry = {
      id: 50,
      description: '',
      sourceCardId: null,
      sourceName: null,
      sourceCard: null,
      controllerName: null,
      isAbility: false,
    };
    const match = matchWithStack([bare]);
    expect(autoTargetArrows(document.body, match)).toEqual([]);
  });

  it('draws one arrow per target when a stack item has several', () => {
    el({ 'data-stack-id': '60' });
    el({ 'data-board-card': '1' });
    el({ 'data-board-card': '2' });
    const match = matchWithStack([stackEntry(60, [1, 2])]);
    const arrows = autoTargetArrows(document.body, match);
    expect(arrows.map((a) => a.key).sort()).toEqual(['60:card:1', '60:card:2']);
  });
});

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
      { key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card' },
      { key: 'b', from: { x: 0, y: 0 }, to: to2, kind: 'player' },
    ]);
    const arrows = [...box.querySelectorAll('[data-testid="stack-target-arrow"]')];
    expect(arrows).toHaveLength(2);
    expect(arrows.map((a) => a.getAttribute('data-key')).sort()).toEqual(['a', 'b']);
    for (const a of arrows) {
      expect(a.classList.contains('targeter--auto')).toBe(true);
      expect(a.querySelector('line')).not.toBeNull();
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
      { key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card' },
      { key: 'b', from: { x: 0, y: 0 }, to: to2, kind: 'player' },
    ]);
    const kept = box.querySelector('[data-testid="stack-target-arrow"][data-key="a"]');
    drawAutoTargetArrows(box, [{ key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card' }]);
    const arrows = [...box.querySelectorAll('[data-testid="stack-target-arrow"]')];
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toBe(kept);
  });

  it('draws nothing, and removes everything, once the spec list is empty', () => {
    const box = overlay();
    const to1 = el({});
    drawAutoTargetArrows(box, [{ key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card' }]);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(1);
    drawAutoTargetArrows(box, []);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(0);
  });

  it('clearAutoTargetArrows takes every one away, and a null overlay is a no-op', () => {
    const box = overlay();
    const to1 = el({});
    drawAutoTargetArrows(box, [{ key: 'a', from: { x: 0, y: 0 }, to: to1, kind: 'card' }]);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(1);
    clearAutoTargetArrows(box);
    expect(box.querySelectorAll('[data-testid="stack-target-arrow"]')).toHaveLength(0);
    expect(() => clearAutoTargetArrows(null)).not.toThrow();
  });
});
