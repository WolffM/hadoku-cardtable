// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TableGame } from '@hadoku/shared';

import { TableCard, tablePhase, type TableCardProps } from './TableCard.tsx';

afterEach(cleanup);

const names: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob' };
const GAME: TableGame = {
  decks: [
    { name: 'Goblins', colors: ['R'], art: 'Goblin Matron' },
    { name: 'Esper Control', colors: ['W', 'U', 'B'], art: null },
  ],
  live: { turn: 7, active: 1, life: [14, 9], hand: [2, 4] },
};

function card(over: Partial<TableCardProps> = {}) {
  return render(
    createElement(TableCard, {
      size: 'full',
      players: ['u-alice', 'u-bob'],
      nameOf: (id) => names[id] ?? id,
      avatarOf: () => null,
      myMemberId: 'u-alice',
      series: { length: 3, wins: [1, 0], played: 1, phase: 'playing' },
      matchId: 'm-000000000002',
      game: GAME,
      go: { label: 'Return to game', href: '#/match/m-000000000002', testId: 'card-go' },
      testId: 'card',
      tableId: 't-1',
      ...over,
    }),
  );
}

describe('tablePhase', () => {
  it('is Start before Forge deals and through the opening turns, Mid after, Sideboard between games, End once the series is', () => {
    expect(tablePhase('seating', null, undefined)).toBe('start');
    expect(tablePhase('playing', 'm-1', { ...GAME, live: null })).toBe('start');
    expect(tablePhase('playing', 'm-1', { ...GAME, live: { ...GAME.live!, turn: 2 } })).toBe('start');
    expect(tablePhase('playing', 'm-1', GAME)).toBe('mid');
    expect(tablePhase('sideboarding', null, GAME)).toBe('sideboard');
    expect(tablePhase('between', null, GAME)).toBe('sideboard');
    expect(tablePhase('done', null, GAME)).toBe('end');
  });
});

describe('TableCard', () => {
  it('draws both seats half and half: each player, their deck and its colours, life and hand while the game runs, the score between', () => {
    card();
    const sides = [...document.querySelectorAll('.table-card__side')];
    expect(sides.map((s) => s.querySelector('.table-card__name')?.textContent)).toEqual(['Alice', 'Bob']);
    expect(sides.map((s) => s.querySelector('.table-card__deck-name')?.textContent)).toEqual(['Goblins', 'Esper Control']);
    expect(sides.map((s) => s.querySelector('[data-testid="deck-colors"]')?.getAttribute('data-colors'))).toEqual(['R', 'WUB']);
    expect(screen.getByTestId('card-counts-0').textContent).toBe('Life 142 in hand');
    expect(screen.getByTestId('card-counts-1').textContent).toBe('Life 94 in hand');
    expect(document.querySelector('.table-card__wins')?.textContent).toBe('1–0');
    expect(document.querySelector('.table-card__of')?.textContent).toBe('Best of 3');
  });

  it('heads with the game, its turn and whose it is, and the phase it is in', () => {
    card();
    expect(document.querySelector('.table-card__game')?.textContent).toBe('Game 2Turn 7 · Bob');
    expect([...document.querySelectorAll('.table-card__phase')].map((p) => [p.textContent, p.hasAttribute('data-at')])).toEqual([
      ['Start', false],
      ['Mid', true],
      ['End', false],
      ['Sideboard', false],
    ]);
    expect(screen.getByTestId('card').dataset.moment).toBe('mid');
  });

  it('between games names the next one, and draws no life or hand', () => {
    card({ series: { length: 3, wins: [1, 1], played: 2, phase: 'sideboarding' }, matchId: null, game: { ...GAME, live: null } });
    expect(document.querySelector('.table-card__game')?.textContent).toBe('Game 3 next');
    expect(screen.queryByTestId('card-counts-0')).toBeNull();
  });

  it('a seat whose deck the server never saw draws its player alone', () => {
    card({ game: { decks: [GAME.decks[0], null], live: null }, matchId: null, series: { length: 1, wins: [0, 0], played: 0, phase: 'seating' } });
    expect(document.querySelectorAll('.table-card__deck')).toHaveLength(1);
    expect(document.querySelector('.table-card__of')).toBeNull();
  });

  it('is the way in, the whole card one link; a finished series marks who won', () => {
    card();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByTestId('card-go').getAttribute('href')).toBe('#/match/m-000000000002');
    expect(screen.getByTestId('card').dataset.mine).toBe('');
    cleanup();
    card({ series: { length: 3, wins: [2, 1], played: 3, phase: 'done' }, matchId: null, go: null });
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(document.querySelector('.table-card__game')?.textContent).toBe('Match over');
    expect(document.querySelector('[data-side="left"]')?.hasAttribute('data-won')).toBe(true);
    expect(document.querySelector('[data-side="right"]')?.hasAttribute('data-lost')).toBe(true);
  });

  it('draws a compact card with its one phase', () => {
    card({ size: 'compact' });
    expect(screen.getByTestId('card').className).toContain('table-card--compact');
    expect([...document.querySelectorAll('.table-card__phase')].map((p) => p.textContent)).toEqual(['Mid']);
  });

  it('offers my own game in play to concede: the confirm shows the score it leaves, Keep playing backs out, Concede asks the server', async () => {
    const onConcede = vi.fn(async () => null as string | null);
    card({ onConcede });
    expect(screen.getByTestId('card-concede').closest('a'), 'never inside the way in').toBeNull();
    fireEvent.click(screen.getByTestId('card-concede'));
    expect(screen.getByTestId('card-concede-confirm').querySelector('.table-card__change')?.textContent).toBe('1–0→1–1');
    fireEvent.click(screen.getByTestId('card-concede-keep'));
    expect(screen.queryByTestId('card-concede-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('card-concede'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-concede-yes'));
    });
    expect(onConcede).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('card-concede-confirm')).toBeNull();
  });

  it('says the server’s refusal, and offers no concede on a game that is not mine or not in play', async () => {
    card({ onConcede: async () => 'the game has already ended' });
    fireEvent.click(screen.getByTestId('card-concede'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-concede-yes'));
    });
    expect(screen.getByRole('alert').textContent).toBe('the game has already ended');
    cleanup();
    card({ onConcede: async () => null, myMemberId: 'u-carol' });
    expect(screen.queryByTestId('card-concede')).toBeNull();
    cleanup();
    card({ onConcede: async () => null, series: { length: 3, wins: [1, 1], played: 2, phase: 'sideboarding' }, matchId: null });
    expect(screen.queryByTestId('card-concede')).toBeNull();
  });

  it('offers Abandon on a constructed series of mine, between games too: the confirm leaves no result, Abandon asks the server', async () => {
    const onAbandon = vi.fn(async () => null as string | null);
    card({ onAbandon, series: { length: 3, wins: [1, 0], played: 1, phase: 'sideboarding' }, matchId: null });
    fireEvent.click(screen.getByTestId('card-abandon'));
    expect(screen.getByTestId('card-abandon-confirm').querySelector('.table-card__change')?.textContent).toBe('1–0→No result');
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-abandon-yes'));
    });
    expect(onAbandon).toHaveBeenCalledTimes(1);
    cleanup();
    card({ onAbandon, series: { length: 1, wins: [1, 0], played: 1, phase: 'done' }, matchId: null });
    expect(screen.queryByTestId('card-abandon'), 'a finished series is a result, not one to abandon').toBeNull();
    cleanup();
    card({ onAbandon, myMemberId: 'u-carol' });
    expect(screen.queryByTestId('card-abandon'), 'only a player of it').toBeNull();
  });

  it('offers Drop match on a pod match of mine: the confirm shows the forfeit — theirs by the majority, my won games standing', async () => {
    const onDrop = vi.fn(async () => null as string | null);
    card({ onDrop });
    fireEvent.click(screen.getByTestId('card-drop'));
    expect(screen.getByTestId('card-drop-confirm').querySelector('.table-card__change')?.textContent).toBe('1–0→1–2');
    fireEvent.click(screen.getByTestId('card-drop-keep'));
    expect(screen.queryByTestId('card-drop-confirm')).toBeNull();
    cleanup();
    card({ onDrop, myMemberId: 'u-bob', series: { length: 3, wins: [0, 0], played: 0, phase: 'seating' }, matchId: null });
    fireEvent.click(screen.getByTestId('card-drop'));
    expect(screen.getByTestId('card-drop-confirm').querySelector('.table-card__change')?.textContent).toBe('0–0→2–0');
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-drop-yes'));
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('card-drop').closest('a'), 'never inside the way in').toBeNull();
  });
});
