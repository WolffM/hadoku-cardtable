// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { battlefieldCardWidth } from './card-size.ts';
import { installPlaced } from './live/placed.ts';
import type { BoardView, StackEntry } from './adapter.ts';

/** A board whose battlefield row lays its cards out at 64px (the row's own `--card-w`). */
function board(): HTMLElement {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div data-zone="battlefield" data-owner="you"><ul class="zone__cards" style="--card-w: 64px"></ul></div>
      <div data-zone="battlefield" data-owner="them"><ul class="zone__cards" style="--card-w: 64px"></ul></div>
      <div class="board__overlay" data-board-overlay=""></div>
    </div>`;
  document.body.append(canvas);
  return canvas;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('one source of truth for a card’s size (the operator, 2026-10-09)', () => {
  it('reads the battlefield row’s own card width, for either seat', () => {
    const canvas = board();
    expect(battlefieldCardWidth(canvas, 'you')).toBe(64);
    expect(battlefieldCardWidth(canvas, 'them')).toBe(64);
  });

  it('null before the board has drawn a battlefield', () => {
    expect(battlefieldCardWidth(document.createElement('div'), 'you')).toBeNull();
  });

  it('a stack card is drawn at that width — never a size of its own (the release flash: a hardcoded 6.5rem)', () => {
    const canvas = board();
    const handle = installPlaced(canvas);
    const item: StackEntry = {
      id: 9, description: 'Bolt', sourceCardId: 109, sourceName: 'Bolt', sourceCard: null, controllerName: 'Alice', isAbility: false,
      targetCardIds: [], targetPlayerIds: [], targetStackItemId: null,
    } as StackEntry;
    const view = {
      seq: 1, title: 't', turn: 1, phase: null, phaseLabel: '', activePlayerId: null,
      players: [{ id: 0, name: 'Alice', isViewer: true, battlefield: [] }, { id: 1, name: 'Bob', isViewer: false, battlefield: [] }],
      stack: [item],
    } as unknown as BoardView;
    handle.notify(view);
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.style.getPropertyValue('--card-w')).toBe('64px');
    handle.dispose();
  });
});
