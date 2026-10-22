// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { battlefieldCardWidth, forgetCardWidths, handCardWidth, onCardWidthsChanged } from './card-size.ts';
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
  forgetCardWidths();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** jsdom has no `ResizeObserver`: this one reports a resize when a test says the box changed. */
class Resizes {
  static last: Resizes | null = null;
  readonly observed = new Set<Element>();
  constructor(private readonly report: ResizeObserverCallback) {
    Resizes.last = this;
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  resize(el: Element): void {
    if (this.observed.has(el)) this.report([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

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

describe('a card’s width is measured once, and again only when what it was read from changes size', () => {
  it('a battlefield card’s width comes from the last measure until the card resizes, and whoever draws at it hears the change', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    const canvas = board();
    const row = canvas.querySelector<HTMLElement>('[data-owner="you"] .zone__cards')!;
    row.innerHTML = '<li class="board-card" style="width: 71px"></li>';
    const reads = vi.spyOn(window, 'getComputedStyle');
    expect(battlefieldCardWidth(canvas, 'you')).toBe(71);
    const once = reads.mock.calls.length;
    expect(battlefieldCardWidth(canvas, 'you')).toBe(71);
    expect(battlefieldCardWidth(canvas, 'you')).toBe(71);
    expect(reads.mock.calls.length, 'no second read').toBe(once);

    const heard = vi.fn();
    const stop = onCardWidthsChanged(heard);
    const card = row.querySelector<HTMLElement>('li')!;
    card.style.width = '58px';
    Resizes.last!.resize(card);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(battlefieldCardWidth(canvas, 'you')).toBe(58);
    stop();
  });

  it('a resize that leaves the width as it was tells nobody', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    const canvas = board();
    const row = canvas.querySelector<HTMLElement>('[data-owner="you"] .zone__cards')!;
    row.innerHTML = '<li class="board-card" style="width: 71px"></li>';
    expect(battlefieldCardWidth(canvas, 'you')).toBe(71);
    const heard = vi.fn();
    const stop = onCardWidthsChanged(heard);
    Resizes.last!.resize(row.querySelector('li')!);
    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it('the hand’s row is probed once, not on every call, and again when its first card changes', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    const canvas = board();
    canvas.querySelector('.board')!.insertAdjacentHTML('beforeend', '<div data-zone="hand" data-owner="you"><ul class="zone__cards" style="--card-w: 92px"><li class="board-card"></li></ul></div>');
    const hand = canvas.querySelector<HTMLElement>('[data-zone="hand"] .zone__cards')!;
    const probes = vi.spyOn(hand, 'append');
    expect(handCardWidth(canvas)).toBe(92);
    expect(handCardWidth(canvas)).toBe(92);
    expect(probes, 'one probe for both').toHaveBeenCalledTimes(1);
    hand.style.setProperty('--card-w', '80px');
    hand.firstElementChild!.remove();
    hand.insertAdjacentHTML('afterbegin', '<li class="board-card"></li>');
    expect(handCardWidth(canvas), 'a different first card: measured again').toBe(80);
    expect(probes).toHaveBeenCalledTimes(2);
  });

  it('forgetting every width (the UI scale moved) measures again and tells whoever draws at them', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    const canvas = board();
    const row = canvas.querySelector<HTMLElement>('[data-owner="you"] .zone__cards')!;
    expect(battlefieldCardWidth(canvas, 'you')).toBe(64);
    row.style.setProperty('--card-w', '77px');
    const heard = vi.fn();
    const stop = onCardWidthsChanged(heard);
    forgetCardWidths();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(battlefieldCardWidth(canvas, 'you')).toBe(77);
    stop();
  });

  it('with no ResizeObserver to say when a width goes stale, every call measures', () => {
    const canvas = board();
    const row = canvas.querySelector<HTMLElement>('[data-owner="you"] .zone__cards')!;
    expect(battlefieldCardWidth(canvas, 'you')).toBe(64);
    row.style.setProperty('--card-w', '77px');
    expect(battlefieldCardWidth(canvas, 'you')).toBe(77);
  });
});
