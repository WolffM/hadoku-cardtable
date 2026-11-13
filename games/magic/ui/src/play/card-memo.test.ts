// @vitest-environment jsdom
/*
 * Every socket message is a new board view, and the board drew every card again for each: 161–476 components a
 * commit, nearly all with the same props (e2e/perf). A card draws again only when something it draws changed:
 * the adapter keeps a card's object while it says the same thing, and a card compares only its own facts of the
 * interaction. `hasKeyword(…, 'vigilance')` is read once per card drawn, so it counts the cards that drew.
 */
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { boardFromFixture, PLAY_FIXTURES } from './fixtures.ts';
import { Board, type BoardInteraction } from './Board.tsx';
import { keepUnchangedCards, type BoardView } from './adapter.ts';

const drawn = vi.hoisted(() => ({ cards: 0 }));
vi.mock('./adapter.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./adapter.ts')>();
  return {
    ...real,
    hasKeyword: (keywords: readonly string[] | undefined, keyword: string) => {
      if (keyword === 'vigilance') drawn.cards += 1;
      return real.hasKeyword(keywords, keyword);
    },
  };
});

afterEach(cleanup);

/** The same game rebuilt, as the adapter rebuilds it for every message: equal cards, new objects. */
const rebuilt = (): BoardView => boardFromFixture(PLAY_FIXTURES[0]!);
const withLife = (view: BoardView, life: number): BoardView => ({ ...view, players: view.players.map((p, i) => (i === 0 ? { ...p, life } : p)) });

const onSelectCard = (): void => undefined;
const onSelectPlayer = (): void => undefined;
/** A new interaction object every commit, as `LiveBoard` builds one; its callbacks are stable. */
const interaction = (selectable: number[]): BoardInteraction => ({ selectable: new Set(selectable), selectablePlayers: new Set(), onSelectCard, onSelectPlayer });

describe('a card draws again only when something it draws changed', () => {
  it('the adapter keeps every card that says the same thing, and only those', () => {
    const before = rebuilt();
    const next = keepUnchangedCards(before, withLife(rebuilt(), 7));
    const cards = (v: BoardView) => v.players.flatMap((p) => [...p.battlefield, ...(p.hand ?? []), ...p.graveyard, ...p.exile]);
    expect(cards(next).length).toBeGreaterThan(5);
    expect(cards(next).every((c, i) => c === cards(before)[i]), 'a life change keeps every card object').toBe(true);
    const target = before.players[0]!.battlefield[0]!;
    const hurt = rebuilt();
    hurt.players[0]!.battlefield[0] = { ...hurt.players[0]!.battlefield[0]!, damage: target.damage + 2 };
    const after = keepUnchangedCards(before, hurt);
    expect(after.players[0]!.battlefield[0], 'a card that took damage is its new self').not.toBe(target);
    expect(after.players[0]!.battlefield[0]!.damage).toBe(target.damage + 2);
    expect(after.players[0]!.battlefield[1], 'its neighbour is kept').toBe(before.players[0]!.battlefield[1]);
  });

  it('a message that changes a life total draws no card; an offer on one card draws that card', () => {
    let view = rebuilt();
    const field = view.players.find((p) => p.isViewer)!.battlefield;
    expect(field.length).toBeGreaterThan(1);
    const { rerender, container } = render(createElement(Board, { view, interaction: interaction([]), boardLayout: 'type-separated' }));
    drawn.cards = 0;
    view = keepUnchangedCards(view, withLife(rebuilt(), 11));
    act(() => rerender(createElement(Board, { view, interaction: interaction([]), boardLayout: 'type-separated' })));
    expect(drawn.cards, 'only a life total changed').toBe(0);
    act(() => rerender(createElement(Board, { view, interaction: interaction([field[0]!.id]), boardLayout: 'type-separated' })));
    expect(drawn.cards, 'Forge offers one card').toBe(1);
    expect(container.querySelector(`[data-board-card="${field[0]!.id}"]`)?.hasAttribute('data-selectable'), 'and it is drawn offered').toBe(true);
  });
});
