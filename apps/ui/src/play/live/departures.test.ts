// @vitest-environment jsdom
/*
 * A permanent leaving the battlefield (`departures.ts`): which cards left and where to, which exit
 * motion each plays, and the stand-in drawn over the place its row keeps.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardCard } from '../adapter.ts';
import { departureCause, EXIT_MOTIONS, exitMotionFor, installDepartures, LEAVING_GAP_ATTR, type Departure, type DepartureCause } from './departures.ts';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function departure(to: Departure['to'], cause?: DepartureCause): Departure {
  return { cardId: 7, playerId: 0, to, toPlayerId: 0, card: { id: 7 } as BoardCard, index: 0, ...(cause === undefined ? {} : { cause }) };
}

function board(): HTMLElement {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div data-zone="battlefield"><ul><li class="board-card" data-board-card="7" data-card-id="7" data-testid="board-card"><span class="name">Thalia</span></li></ul></div>
    <div data-board-overlay=""></div>`;
  canvas.querySelector<HTMLElement>('[data-board-overlay]')!.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  document.body.append(canvas);
  return canvas;
}

/** What `Board.tsx` draws in the commit the card left in: its place kept as a gap. */
function keepPlace(canvas: HTMLElement): void {
  const gap = document.createElement('li');
  gap.className = 'zone__gap';
  gap.setAttribute(LEAVING_GAP_ATTR, '7');
  gap.getBoundingClientRect = () => rect(300, 400, 60, 84);
  canvas.querySelector('[data-board-card="7"]')!.replaceWith(gap);
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('exitMotionFor', () => {
  it('Forge’s causes fold to a departure’s: lethal damage and deathtouch are damage', () => {
    expect(departureCause('LETHAL_DAMAGE')).toBe('damage');
    expect(departureCause('DEATHTOUCH')).toBe('damage');
    expect(departureCause('DESTROYED')).toBe('destroyed');
    expect(departureCause('SACRIFICED')).toBe('sacrificed');
    expect(departureCause('ZERO_TOUGHNESS')).toBe('zero-toughness');
    expect(departureCause('STATE_RULE')).toBe('state-rule');
  });

  it('destroyed is sliced; every other death crumples', () => {
    expect(exitMotionFor(departure('graveyard', 'destroyed'))).toBe('slice');
    for (const cause of ['damage', 'sacrificed', 'zero-toughness', 'state-rule'] as const) expect(exitMotionFor(departure('graveyard', cause)), cause).toBe('crumple');
  });

  it('with no cause (a Forge too old to say, and no hit): killed by damage crumples; destroyed any other way (a graveyard, or gone) is sliced; out of play any other way fades', () => {
    expect(exitMotionFor(departure('graveyard', 'damage'))).toBe('crumple');
    expect(exitMotionFor(departure('graveyard'))).toBe('slice');
    expect(exitMotionFor(departure('gone'))).toBe('slice');
    expect(exitMotionFor(departure('gone', 'damage'))).toBe('crumple');
    expect(exitMotionFor(departure('exile'))).toBe('fade');
    expect(exitMotionFor(departure('hand'))).toBe('fade');
  });
});

describe('installDepartures', () => {
  it('a copy of the card as it was stands over its place, still until its beat, then plays its motion and is gone, and the place is given back', () => {
    vi.useFakeTimers();
    const canvas = board();
    const onDone = vi.fn();
    const handle = installDepartures(canvas, { onDone });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave(departure('graveyard', 'damage'), 100);

    const standIn = canvas.querySelector<HTMLElement>('[data-board-overlay] .board-departure')!;
    expect(standIn.getAttribute('data-exit')).toBe('crumple');
    expect(standIn.querySelectorAll('.board-departure__piece'), 'one copy').toHaveLength(1);
    expect(standIn.hasAttribute('data-exit-go'), 'still, until its beat').toBe(false);
    expect([standIn.style.left, standIn.style.top, standIn.style.width]).toEqual(['300px', '400px', '60px']);
    expect(standIn.textContent, 'the card as it was drawn').toBe('Thalia');
    expect(standIn.querySelector('[data-card-id], [data-board-card], [data-testid]'), 'no card of the board’s: nothing finds it as one').toBeNull();

    vi.advanceTimersByTime(100);
    expect(standIn.hasAttribute('data-exit-go'), 'its motion plays').toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(EXIT_MOTIONS.crumple.ms);
    expect(canvas.querySelector('.board-departure')).toBeNull();
    expect(onDone).toHaveBeenCalledWith(7);
    handle.dispose();
  });

  it('reduced motion: no copy; the place is given back at the beat', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    const canvas = board();
    const onDone = vi.fn();
    const handle = installDepartures(canvas, { onDone });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave(departure('graveyard'), 100);
    expect(canvas.querySelector('.board-departure')).toBeNull();
    vi.advanceTimersByTime(100);
    expect(onDone).toHaveBeenCalledWith(7);
    handle.dispose();
  });

  it('a slice is drawn as two copies of the card, the two halves, and goes once its motion is over', () => {
    vi.useFakeTimers();
    const canvas = board();
    const onDone = vi.fn();
    const handle = installDepartures(canvas, { onDone });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave(departure('graveyard'), 0);
    const standIn = canvas.querySelector<HTMLElement>('.board-departure')!;
    expect(standIn.getAttribute('data-exit')).toBe('slice');
    expect([...standIn.querySelectorAll<HTMLElement>('.board-departure__piece')].map((p) => [p.dataset.piece, p.textContent])).toEqual([
      ['1', 'Thalia'],
      ['2', 'Thalia'],
    ]);
    vi.advanceTimersByTime(EXIT_MOTIONS.slice.ms);
    expect(canvas.querySelector('.board-departure')).toBeNull();
    expect(onDone).toHaveBeenCalledWith(7);
    handle.dispose();
  });

  it('dispose takes every copy down', () => {
    const canvas = board();
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave(departure('exile'), 0);
    expect(canvas.querySelector('.board-departure[data-exit="fade"]')).not.toBeNull();
    handle.dispose();
    expect(canvas.querySelector('.board-departure')).toBeNull();
  });
});
