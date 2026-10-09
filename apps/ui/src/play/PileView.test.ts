// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { Board, type BoardInteraction } from './Board.tsx';
import { boardFromFixture, PLAY_FIXTURES } from './fixtures.ts';
import { fitPile, placePile, PILE_GAP, PILE_MIN_CARD_W } from './PileView.tsx';

afterEach(cleanup);

describe('fitPile', () => {
  it('keeps the battlefield card size while every card fits at it', () => {
    // 31 cards of 80px in 900×700: 8 to a row in 4 rows of 111px — the most compact layout at full size.
    expect(fitPile(31, 80, { width: 900, height: 700 })).toEqual({ cardW: 80, cols: 8, rows: 4 });
  });

  it('shrinks every card together until the whole pile fits, never scrolling', () => {
    const room = { width: 600, height: 400 };
    const fit = fitPile(60, 80, room);
    expect(fit.cardW).toBeLessThan(80);
    expect(fit.cardW).toBeGreaterThanOrEqual(PILE_MIN_CARD_W);
    expect(fit.cols * fit.cardW + (fit.cols - 1) * PILE_GAP).toBeLessThanOrEqual(room.width);
    expect(fit.rows * fit.cardW * (680 / 488) + (fit.rows - 1) * PILE_GAP).toBeLessThanOrEqual(room.height);
    expect(fit.cols * fit.rows).toBeGreaterThanOrEqual(60);
  });

  it('stops at the minimum width, in as many columns as the room takes', () => {
    expect(fitPile(200, 80, { width: 460, height: 100 })).toEqual({ cardW: PILE_MIN_CARD_W, cols: 10, rows: 20 });
  });
});

describe('placePile', () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 700 };
  it('stands just past the pile, centred on it', () => {
    expect(placePile({ left: 10, top: 300, right: 110, bottom: 500 }, bounds, { width: 400, height: 200 })).toEqual({ left: 110 + PILE_GAP, top: 300 });
  });
  it('stays inside the board on both axes', () => {
    expect(placePile({ left: 10, top: 600, right: 110, bottom: 700 }, bounds, { width: 950, height: 400 })).toEqual({ left: 1000 - PILE_GAP - 950, top: 700 - PILE_GAP - 400 });
  });
});

describe('a pile opens as a PileView', () => {
  const view = boardFromFixture(PLAY_FIXTURES[0]!);
  const me = view.players.find((p) => p.isViewer)!;
  const them = view.players.find((p) => !p.isViewer)!;
  const offeredId = me.graveyard[1]!.id;
  const setup = () => {
    const onSelectCard = vi.fn<(id: number) => void>();
    const interaction: BoardInteraction = {
      selectable: new Set([offeredId]),
      selectablePlayers: new Set(),
      selectionOpen: false,
      actionable: new Set(),
      highlighted: new Set(),
      onSelectCard,
      onSelectPlayer: vi.fn(),
    };
    const utils = render(createElement(Board, { view, interaction }));
    const pile = (id: number) => utils.container.querySelector<HTMLElement>(`[data-player-id="${id}"] [data-zone="graveyard"]`)!;
    const pileView = () => utils.container.querySelector<HTMLElement>('[data-testid="pile-view"]');
    return { ...utils, onSelectCard, pile, pileView };
  };

  it('a click on the pile opens every card of it, top of the pile first, in the board overlay', () => {
    const { pile, pileView } = setup();
    expect(pileView()).toBeNull();
    fireEvent.click(pile(them.id));
    const opened = pileView()!;
    expect(opened.parentElement!.hasAttribute('data-board-overlay')).toBe(true);
    expect([...opened.querySelectorAll('li[data-card-id]')].map((li) => Number(li.getAttribute('data-card-id')))).toEqual(
      [...them.graveyard].reverse().map((c) => c.id),
    );
    expect(opened.textContent).toContain(String(them.graveyard.length));
  });

  it('Esc closes it, a press outside closes it, and the pile toggles it', () => {
    const { pile, pileView, container } = setup();
    fireEvent.click(pile(me.id));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(pileView()).toBeNull();

    fireEvent.click(pile(me.id));
    fireEvent.pointerDown(pileView()!);
    expect(pileView(), 'a press inside keeps it').not.toBeNull();
    fireEvent.pointerDown(container.querySelector('[data-zone="battlefield"]')!);
    expect(pileView()).toBeNull();

    fireEvent.click(pile(me.id));
    fireEvent.pointerDown(pile(me.id));
    fireEvent.click(pile(me.id));
    expect(pileView()).toBeNull();
  });

  it('an offered card answers on the board without opening the view, and in the view answers then closes it', () => {
    const { pile, pileView, onSelectCard } = setup();
    fireEvent.click(pile(me.id).querySelector(`[data-card-id="${offeredId}"] > .board-card__face`)!);
    expect(onSelectCard).toHaveBeenCalledWith(offeredId);
    expect(pileView(), 'a reachable offered card still clicks directly').toBeNull();

    fireEvent.click(pile(me.id));
    const inView = pileView()!.querySelector<HTMLElement>(`[data-card-id="${offeredId}"]`)!;
    expect(inView.hasAttribute('data-selectable')).toBe(true);
    fireEvent.click(inView.querySelector('.board-card__face')!);
    expect(onSelectCard).toHaveBeenCalledTimes(2);
    expect(pileView()).toBeNull();
  });
});
