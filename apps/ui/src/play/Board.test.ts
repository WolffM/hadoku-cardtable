// @vitest-environment jsdom
/**
 * The board renders a real game state — every number asserted here is read
 * off the committed fixture, a real Forge match's packet stream (see
 * `fixtures.ts` for its provenance). If the adapter mis-maps a zone, a count
 * below moves and this file fails.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, within } from '@testing-library/react';

import { Board } from './Board.tsx';
import { boardFromFixture, PLAY_FIXTURES } from './fixtures.ts';

afterEach(cleanup);

const fixture = PLAY_FIXTURES[0]!;

function renderBoard() {
  const view = boardFromFixture(fixture);
  const utils = render(createElement(Board, { view }));
  const seat = (id: number) => utils.container.querySelector<HTMLElement>(`[data-testid="player"][data-player-id="${id}"]`)!;
  const zone = (id: number, name: string) => seat(id).querySelector<HTMLElement>(`[data-zone="${name}"]`)!;
  const cardNames = (el: HTMLElement) => [...el.querySelectorAll('.card__name')].map((n) => n.textContent);
  return { ...utils, view, seat, zone, cardNames };
}

describe('turn and phase', () => {
  it('shows the turn, the phase and whose turn it is', () => {
    const { getByTestId } = renderBoard();
    expect(getByTestId('turn').textContent).toBe('Turn 14');
    expect(getByTestId('phase').textContent).toBe('Main 1');
    expect(getByTestId('phase').dataset.phase).toBe('MAIN1');
    expect(getByTestId('active-player').textContent).toBe('Bob (Capturing)’s turn');
  });
});

describe('players', () => {
  it('draws both players, the viewer last on screen, with their life totals', () => {
    const { getAllByTestId, seat } = renderBoard();
    const seats = getAllByTestId('player');
    expect(seats.map((s) => s.dataset.playerId)).toEqual(['1', '0']);
    expect(seat(0).dataset.viewer).toBe('true');
    expect(within(seat(0)).getByTestId('life').textContent).toBe('2');
    expect(within(seat(1)).getByTestId('life').textContent).toBe('16');
  });

  it('counts libraries', () => {
    const { seat } = renderBoard();
    expect(within(seat(0)).getByTestId('library-count').textContent).toBe('library 46');
    expect(within(seat(1)).getByTestId('library-count').textContent).toBe('library 47');
  });
});

describe('zones', () => {
  it('lays out each battlefield with the fixture’s permanents', () => {
    const { zone, cardNames } = renderBoard();
    expect(zone(0, 'battlefield').dataset.count).toBe('5');
    expect(cardNames(zone(0, 'battlefield'))).toEqual([
      'Izzet Guildgate',
      'Island',
      'Fire Urchin',
      'Izzet Guildgate',
      'Island',
    ]);
    expect(zone(1, 'battlefield').dataset.count).toBe('8');
    expect(cardNames(zone(1, 'battlefield'))).toContain('Vulshok War Boar');
    expect(cardNames(zone(1, 'battlefield')).filter((n) => n === 'Mountain')).toHaveLength(4);
  });

  it('marks tapped permanents in words', () => {
    const { zone } = renderBoard();
    const tapped = zone(1, 'battlefield').querySelectorAll('[data-tapped]');
    // Mountain 87, Mountain 78, Vulshok War Boar 99.
    expect(tapped).toHaveLength(3);
    expect(within(tapped[2] as HTMLElement).getByText('tapped')).toBeTruthy();
  });

  it('reports summoning sickness only for creatures on the battlefield', () => {
    // Forge's raw `Sickness` is true on most cards in hand and graveyard too.
    const { container, zone } = renderBoard();
    expect(zone(0, 'hand').textContent).not.toContain('summoning sick');
    expect(zone(0, 'graveyard').textContent).not.toContain('summoning sick');
    expect(container.querySelectorAll('.board-card__chip').length).toBeGreaterThan(0);
  });

  it('fills graveyards and leaves exile empty, as the game did', () => {
    const { zone, cardNames } = renderBoard();
    expect(cardNames(zone(0, 'graveyard'))).toEqual(['Fire Urchin', 'Rubblebelt Boar', "Ral's Staticaster"]);
    expect(cardNames(zone(1, 'graveyard'))).toEqual(['Oxidda Golem', 'Gemini Engine', 'Pyrite Spellbomb']);
    expect(zone(0, 'exile').dataset.count).toBe('0');
    expect(zone(1, 'exile').dataset.count).toBe('0');
  });

  it('shows the viewer’s hand as cards', () => {
    const { zone, cardNames } = renderBoard();
    expect(zone(0, 'hand').dataset.count).toBe('5');
    expect(cardNames(zone(0, 'hand'))).toEqual([
      'Leapfrog',
      'Fearless Halberdier',
      "Ral's Dispersal",
      'Fearless Halberdier',
      'Hellkite Whelp',
    ]);
  });
});

describe('the stack', () => {
  it('lists both items, top first', () => {
    const { container } = renderBoard();
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.dataset.count).toBe('2');
    const items = [...stack.querySelectorAll('.stack__source')].map((n) => n.textContent);
    expect(items).toEqual(['Fire Urchin · ability', 'Direct Current']);
    expect(stack.textContent).toContain('deals 2 damage to Goblin Replica (67)');
  });
});

describe('hidden information', () => {
  it('an opponent’s hand is a count, even though the wire carries the names', () => {
    // The control is only meaningful if the names really are on the wire.
    const wire = JSON.stringify(fixture.raw);
    expect(wire).toContain('"Talon of Pain"');
    expect(wire).toContain('"Electrostatic Bolt"');

    const { zone, container } = renderBoard();
    expect(zone(1, 'hand').dataset.count).toBe('2');
    expect(zone(1, 'hand').textContent).toContain('2 cards, hidden');
    expect(zone(1, 'hand').querySelectorAll('[data-testid="card"]')).toHaveLength(0);
    expect(container.textContent).not.toContain('Talon of Pain');
    expect(container.textContent).not.toContain('Electrostatic Bolt');
  });
});

describe('art and marks (D13/D15)', () => {
  it('builds no image from the wire, which carries no Scryfall id', () => {
    const { container } = renderBoard();
    // Every card is a CardTile; with no scryfallId the resolver returns null
    // and the tile is text. No <img>, and no inline url() of any kind.
    expect(container.querySelectorAll('[data-testid="card"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/url\(/);
  });

  it('draws costs as our own pips, and every card resolved', () => {
    const { view, zone } = renderBoard();
    expect(view.missingCardIds).toEqual([]);
    const boar = [...zone(1, 'battlefield').querySelectorAll('[data-testid="card"]')].find(
      (c) => c.querySelector('.card__name')?.textContent === 'Vulshok War Boar',
    )!;
    expect([...boar.querySelectorAll('.pip')].map((p) => (p as HTMLElement).dataset.token)).toEqual(['2', 'R', 'R']);
    expect(boar.querySelector('.card__stat')?.textContent).toBe('5/5');
  });
});
