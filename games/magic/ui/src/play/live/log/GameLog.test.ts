// @vitest-environment jsdom
/*
 * The log panel's own behaviour (`./GameLog.tsx`); what its lines look like is `../LiveBoard.test.ts`'s
 * and the tree they are drawn from `./model.test.ts`'s.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { GameLogLine } from '@hadoku/forge-wire';

import type { Say } from '../match.ts';
import { GameLog } from './GameLog.tsx';
import { revealScroll } from './reveal.ts';

afterEach(cleanup);

const say = (text: string, type: GameLogLine['type'], meta: Omit<GameLogLine, 'type' | 'cards'> = {}): Say => ({ text, log: { type, cards: [], ...meta } });

/** Four turns of a land each: the first two fold, the last two are open. */
const SAYS: Say[] = [1, 2, 3, 4].flatMap((turn) => [
  say(`Turn ${turn} (alice)`, 'TURN', { actor: 0, turn, phase: 'UNTAP' }),
  say('alice played Mountain', 'LAND', { actor: 0, phase: 'MAIN1' }),
]);

describe('revealScroll: how far the log scrolls to show what a press opened or closed', () => {
  const box = { top: 100, bottom: 300 };

  it('stays put for a turn wholly in view', () => {
    expect(revealScroll(box, { top: 120, bottom: 280 })).toBe(0);
  });

  it('scrolls down by what ends below the box', () => {
    expect(revealScroll(box, { top: 250, bottom: 360 })).toBe(60);
  });

  it('never scrolls a turn taller than the box past its own header', () => {
    expect(revealScroll(box, { top: 150, bottom: 900 })).toBe(50);
  });

  it('scrolls up to a header left above the box', () => {
    expect(revealScroll(box, { top: 40, bottom: 70 })).toBe(-60);
  });
});

/*
 * The operator, 2026-11-19: *"expanding/collapsing cards in the log is a bit awkward, i would expect
 * it to always scroll to the bottom if the displayed text is offscreen."*
 */
describe('a turn opened in the log is scrolled into view', () => {
  /** jsdom lays nothing out: the scroll box is 100–300, and a turn is where `at` says, by whether it is open. */
  function laidOut(container: HTMLElement, at: (open: boolean) => { top: number; bottom: number }): HTMLElement {
    const scroll = container.querySelector<HTMLElement>('[data-testid="live-log"]')!;
    const rect = (r: { top: number; bottom: number }): DOMRect => ({ ...r, left: 0, right: 0, x: 0, y: r.top, width: 0, height: r.bottom - r.top, toJSON: () => r });
    scroll.getBoundingClientRect = () => rect({ top: 100, bottom: 300 });
    for (const turn of container.querySelectorAll<HTMLElement>('[data-testid="log-turn"]')) {
      turn.getBoundingClientRect = () => rect(at(turn.hasAttribute('data-open')));
    }
    scroll.scrollTop = 500;
    return scroll;
  }
  const head = (container: HTMLElement, index: number): HTMLElement => container.querySelector<HTMLElement>(`[data-log-turn-index="${index}"] button`)!;

  it('opening a turn whose rows end below the box scrolls them into it', () => {
    const { container } = render(createElement(GameLog, { says: SAYS, view: null }));
    const scroll = laidOut(container, (open) => (open ? { top: 270, bottom: 370 } : { top: 270, bottom: 295 }));
    expect(head(container, 0).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head(container, 0));
    expect(head(container, 0).getAttribute('aria-expanded')).toBe('true');
    expect(scroll.scrollTop, 'down by the 70px that ended below the box').toBe(570);
  });

  it('opening a turn that fits where it is moves nothing', () => {
    const { container } = render(createElement(GameLog, { says: SAYS, view: null }));
    const scroll = laidOut(container, () => ({ top: 120, bottom: 200 }));
    fireEvent.click(head(container, 0));
    expect(scroll.scrollTop).toBe(500);
  });

  it('closing a turn whose header was held above its rows keeps the header in the box', () => {
    const { container } = render(createElement(GameLog, { says: SAYS, view: null }));
    const scroll = laidOut(container, (open) => (open ? { top: -200, bottom: 400 } : { top: -200, bottom: -175 }));
    fireEvent.click(head(container, 3));
    expect(head(container, 3).getAttribute('aria-expanded')).toBe('false');
    expect(scroll.scrollTop, 'up to the folded header').toBe(200);
  });
});
