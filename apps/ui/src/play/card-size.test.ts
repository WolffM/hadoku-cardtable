// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { battlefieldCardWidth, handCardWidth } from './card-size.ts';
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

  it('reads a card the battlefield already draws, in any of its rows, and adds nothing to any row to do it', () => {
    const canvas = board();
    const rows = canvas.querySelectorAll<HTMLElement>('.zone__cards');
    rows[1]!.innerHTML = '<li class="board-card" style="width: 71px"></li>';
    const added: Node[] = [];
    const watch = new MutationObserver((records) => added.push(...records.flatMap((r) => [...r.addedNodes])));
    watch.observe(canvas, { childList: true, subtree: true });
    expect(battlefieldCardWidth(canvas, 'them')).toBe(71);
    watch.takeRecords().forEach((r) => added.push(...r.addedNodes));
    watch.disconnect();
    expect(added, 'no probe column was appended').toEqual([]);
  });

  it('null before the board has drawn a battlefield', () => {
    expect(battlefieldCardWidth(document.createElement('div'), 'you')).toBeNull();
  });

  it('a hand card’s width is the hand row’s own, adding nothing that stays — else the battlefield’s', () => {
    const canvas = board();
    expect(handCardWidth(canvas), 'no hand: the battlefield’s').toBe(64);
    canvas.querySelector('.board')!.insertAdjacentHTML('beforeend', '<div data-zone="hand" data-owner="you"><ul class="zone__cards" style="--card-w: 92px"><li class="board-card"></li></ul></div>');
    expect(handCardWidth(canvas)).toBe(92);
    expect(canvas.querySelectorAll('[data-zone="hand"] .zone__cards > *')).toHaveLength(1);
  });

  it('a spell on the stack is drawn at a hand card’s width, an ability’s chip off a battlefield card’s (the operator, 2026-10-15)', () => {
    const canvas = board();
    canvas.querySelector('.board')!.insertAdjacentHTML('beforeend', '<div data-zone="hand" data-owner="you"><ul class="zone__cards" style="--card-w: 92px"></ul></div>');
    const handle = installPlaced(canvas);
    const entry = (id: number, isAbility: boolean): StackEntry =>
      ({
        id, description: 'Bolt', sourceCardId: 100 + id, sourceName: 'Bolt', sourceCard: null, controllerName: 'Alice', isAbility,
        targetCardIds: [], targetPlayerIds: [], targetStackItemId: null,
      }) as StackEntry;
    const view = {
      seq: 1, title: 't', turn: 1, phase: null, phaseLabel: '', activePlayerId: null,
      players: [{ id: 0, name: 'Alice', isViewer: true, battlefield: [] }, { id: 1, name: 'Bob', isViewer: false, battlefield: [] }],
      stack: [entry(9, false), entry(10, true)],
    } as unknown as BoardView;
    handle.notify(view);
    expect(canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!.style.getPropertyValue('--card-w')).toBe('92px');
    expect(canvas.querySelector<HTMLElement>('[data-placed-spell="10"]')!.style.getPropertyValue('--card-w')).toBe('64px');
    handle.dispose();
  });
});
