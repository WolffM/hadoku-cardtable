// @vitest-environment jsdom
/*
 * The Gauntlet's screens (`docs/planning/constructed-modes-plan.md`, "Gauntlet reveal"): the
 * format title lands first, then the coin flip, then the ten decks deal in one by one; a ban
 * greys and crosses its tile; a pick moves its tile to the picker's column; before each game
 * the other seat's choice stays hidden until both have chosen.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GAUNTLET_REVEAL_MS, type GauntletDeck, type GauntletView } from '@hadoku/shared';

import { FLIP_MS } from '../../play/live/CoinToss.tsx';
import { GauntletScreen } from './GauntletScreen.tsx';
import * as reveal from './reveal.ts';
import { DEAL_FROM_MS, DEAL_STAGGER_MS, TITLE_MS, revealStage } from './reveal.ts';

const IDS = [
  'power-modern-2022-1-maxx-kominowski-ur-aggro',
  'power-modern-2022-1-jordan-lidsky-hammer-time',
  'power-modern-2022-1-will-kowalczyk-amulet-titan',
  'power-modern-2022-1-stormguyisme-living-end',
  'power-modern-2022-1-zach-dubin-4c-yorion',
  'deck-6',
  'deck-7',
  'deck-8',
  'deck-9',
  'deck-10',
] as const;

function deck(id: string, over: Partial<GauntletDeck> = {}): GauntletDeck {
  return {
    id,
    name: `${id} (Pilot)`,
    archetype: id,
    pilot: 'Pilot',
    colors: ['R'],
    main: [
      { count: 4, name: 'Lightning Bolt' },
      { count: 20, name: 'Mountain' },
    ],
    sideboard: [],
    status: 'open',
    by: null,
    played: false,
    ...over,
  };
}

function view(over: Partial<GauntletView> = {}): GauntletView {
  return {
    phase: 'reveal',
    you: 0,
    players: [
      { memberId: 'alice', name: 'Alice' },
      { memberId: 'bob', name: 'Bob' },
    ],
    ready: [true, true],
    era: { id: 'modern-2022', family: 'modern', title: 'Modern — 2022' },
    // A board drawn in ban/pick or later opened after the reveal; one in `reveal` opens as it starts.
    revealAt: over.phase === undefined || over.phase === 'reveal' ? Date.now() : Date.now() - GAUNTLET_REVEAL_MS,
    first: 1,
    decks: IDS.map((id) => deck(id)),
    step: null,
    games: [],
    choice: null,
    winner: null,
    ...over,
  };
}

/** P1 (Bob, table seat 1) bans first. */
const BAN_1 = { index: 0, seat: 1, act: 'ban', count: 1, taken: 0 } as const;

const noop = (): void => {};
function draw(v: GauntletView, acts: { onBan?: (id: string) => void; onPick?: (id: string) => void; onChoose?: (id: string) => void } = {}) {
  return render(createElement(GauntletScreen, { view: v, onBan: acts.onBan ?? noop, onPick: acts.onPick ?? noop, onChoose: acts.onChoose ?? noop }));
}

const tiles = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-testid="gauntlet-deck"]')];
const pool = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('[data-testid="gauntlet-pool"]')!;
const column = (root: HTMLElement, seat: 0 | 1): HTMLElement => root.querySelector<HTMLElement>(`[data-testid="gauntlet-column"][data-seat="${seat}"]`)!;

let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') && reduced,
    media: query,
    addEventListener: noop,
    removeEventListener: noop,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the reveal’s timeline', () => {
  it('title, then the coin, then ten tiles one by one, then done', () => {
    expect(revealStage(0)).toEqual({ coin: false, dealt: 0, done: false });
    expect(revealStage(TITLE_MS - 1).coin).toBe(false);
    expect(revealStage(TITLE_MS).coin).toBe(true);
    expect(revealStage(TITLE_MS + FLIP_MS), 'the landed coin is held to be read').toEqual({ coin: true, dealt: 0, done: false });
    expect(revealStage(DEAL_FROM_MS - 1).dealt).toBe(0);
    expect(revealStage(DEAL_FROM_MS)).toEqual({ coin: false, dealt: 1, done: false });
    expect(revealStage(DEAL_FROM_MS + 4 * DEAL_STAGGER_MS).dealt).toBe(5);
    expect(revealStage(DEAL_FROM_MS + 9 * DEAL_STAGGER_MS).dealt).toBe(10);
    expect(revealStage(GAUNTLET_REVEAL_MS - 1).done).toBe(false);
    expect(revealStage(GAUNTLET_REVEAL_MS - 1).dealt, 'the last deck lands inside the server’s reveal').toBe(10);
    expect(revealStage(GAUNTLET_REVEAL_MS)).toEqual({ coin: false, dealt: 10, done: true });
  });

  it('has one reveal length, the server’s', () => {
    expect('REVEAL_MS' in reveal, 'no second reveal length beside GAUNTLET_REVEAL_MS').toBe(false);
  });
});

describe('the reveal on screen', () => {
  it('lands the format title first, then flips the coin, then deals the ten decks one at a time', () => {
    vi.useFakeTimers();
    const { getByTestId, queryByTestId, container } = draw(view());
    expect(getByTestId('gauntlet-title').textContent).toBe('Modern — 2022');
    expect(queryByTestId('coin-toss'), 'no coin before the title has landed').toBeNull();
    expect(tiles(container)).toHaveLength(0);

    act(() => vi.advanceTimersByTime(TITLE_MS));
    expect(getByTestId('coin-toss').getAttribute('data-winner'), 'the coin lands on P1').toBe('1');
    expect(tiles(container)).toHaveLength(0);

    act(() => vi.advanceTimersByTime(DEAL_FROM_MS - TITLE_MS - 1));
    expect(tiles(container)).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(tiles(container)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(DEAL_STAGGER_MS));
    expect(tiles(container)).toHaveLength(2);
    act(() => vi.advanceTimersByTime(8 * DEAL_STAGGER_MS));
    expect(tiles(container).map((t) => t.dataset.deckId)).toEqual([...IDS]);

    act(() => vi.advanceTimersByTime(GAUNTLET_REVEAL_MS));
    expect(queryByTestId('coin-toss'), 'the coin gives way to the board').toBeNull();
    expect(getByTestId('gauntlet-title').textContent).toBe('Modern — 2022');
  });

  it('under prefers-reduced-motion it draws the end state at once', () => {
    reduced = true;
    const { getByTestId, queryByTestId, container } = draw(view());
    expect(getByTestId('gauntlet-title').textContent).toBe('Modern — 2022');
    expect(queryByTestId('coin-toss')).toBeNull();
    expect(tiles(container)).toHaveLength(10);
  });

  it('runs from the server’s revealAt: a screen that opens mid-reveal joins it there', () => {
    vi.useFakeTimers();
    const { getByTestId, queryByTestId, container } = draw(view({ revealAt: Date.now() - (TITLE_MS + 500) }));
    expect(getByTestId('coin-toss'), 'already past the title: the coin').toBeTruthy();
    expect(tiles(container)).toHaveLength(0);
    act(() => vi.advanceTimersByTime(DEAL_FROM_MS - TITLE_MS - 500 + 4 * DEAL_STAGGER_MS));
    expect(tiles(container)).toHaveLength(5);
    act(() => vi.advanceTimersByTime(GAUNTLET_REVEAL_MS));
    expect(queryByTestId('coin-toss')).toBeNull();
    expect(tiles(container)).toHaveLength(10);
  });

  it('a screen that opens once revealAt + the reveal has passed draws the end state, even before the phase moves on', () => {
    const { queryByTestId, container } = draw(view({ revealAt: Date.now() - GAUNTLET_REVEAL_MS }));
    expect(queryByTestId('coin-toss')).toBeNull();
    expect(tiles(container)).toHaveLength(10);
  });

  it('a screen that arrives after the reveal (a reload during ban/pick) draws the board, not the reveal again', () => {
    const { queryByTestId, container } = draw(view({ phase: 'banpick', step: BAN_1 }));
    expect(queryByTestId('coin-toss')).toBeNull();
    expect(tiles(container)).toHaveLength(10);
  });

  it('every tile is the room’s deck tile: its art band, its name, its colours', () => {
    const { container } = draw(view({ phase: 'banpick', step: BAN_1 }));
    const tile = tiles(container)[0]!;
    expect(tile.classList.contains('deckpick__option')).toBe(true);
    expect(tile.querySelector('.deckpick__art')).not.toBeNull();
    expect(tile.querySelector('.deckpick__name')?.textContent).toBe(IDS[0]);
    expect(within(tile).getByTestId('deck-colors').getAttribute('data-colors')).toBe('R');
  });
});

describe('ban and pick', () => {
  it('the turn banner names who acts and what', () => {
    const { getByTestId } = draw(view({ phase: 'banpick', step: BAN_1 }));
    const banner = getByTestId('gauntlet-turn');
    expect(banner.textContent).toContain('Bob');
    expect(banner.textContent).toContain('Ban 1');
    expect(banner.dataset.seat).toBe('1');
  });

  it('a pick step names how many decks are still to take', () => {
    const { getByTestId } = draw(view({ phase: 'banpick', you: 1, step: { index: 3, seat: 0, act: 'pick', count: 2, taken: 0 } }));
    expect(getByTestId('gauntlet-turn').textContent).toContain('Pick 2');
  });

  it('on your turn an open deck is pressed to act; on theirs nothing is', () => {
    const onBan = vi.fn();
    const mine = draw(view({ phase: 'banpick', you: 1, step: BAN_1 }), { onBan });
    fireEvent.click(tiles(mine.container)[2]!);
    expect(onBan).toHaveBeenCalledWith(IDS[2]);
    cleanup();
    const theirs = draw(view({ phase: 'banpick', you: 0, step: BAN_1 }), { onBan });
    expect(tiles(theirs.container).every((t) => (t as HTMLButtonElement).disabled)).toBe(true);
  });

  it('a ban greys the tile and crosses it, where it lies', () => {
    const before = view({ phase: 'banpick', step: BAN_1 });
    const { container, rerender } = draw(before);
    expect(tiles(container)[3]!.dataset.status).toBe('open');
    const decks = before.decks.map((d, i) => (i === 3 ? { ...d, status: 'banned' as const, by: 1 as const } : d));
    rerender(createElement(GauntletScreen, { view: { ...before, decks, step: { ...BAN_1, index: 1, seat: 0 } }, onBan: noop, onPick: noop, onChoose: noop }));
    const banned = container.querySelector<HTMLElement>(`[data-deck-id="${IDS[3]}"]`)!;
    expect(banned.dataset.status).toBe('banned');
    expect(banned.querySelector('[data-testid="gauntlet-cross"]')).not.toBeNull();
    expect(pool(container).contains(banned), 'a banned deck stays in the pool').toBe(true);
    expect((banned as HTMLButtonElement).disabled).toBe(true);
  });

  it('a pick moves the tile out of the pool into the picker’s column, P1 left and P2 right', () => {
    const before = view({ phase: 'banpick', step: { index: 2, seat: 1, act: 'pick', count: 1, taken: 0 } });
    const { container, rerender } = draw(before);
    expect(column(container, 1).dataset.player).toBe('p1');
    expect(column(container, 0).dataset.player).toBe('p2');
    const sides = [...container.querySelectorAll('[data-testid="gauntlet-column"]')].map((c) => (c as HTMLElement).dataset.player);
    expect(sides, 'P1’s column is drawn first').toEqual(['p1', 'p2']);

    const decks = before.decks.map((d, i) => (i === 5 ? { ...d, status: 'picked' as const, by: 1 as const } : d));
    rerender(createElement(GauntletScreen, { view: { ...before, decks, step: { index: 3, seat: 0, act: 'pick', count: 2, taken: 0 } }, onBan: noop, onPick: noop, onChoose: noop }));
    const picked = container.querySelector<HTMLElement>(`[data-deck-id="${IDS[5]}"]`)!;
    expect(picked.dataset.status).toBe('picked');
    expect(column(container, 1).contains(picked)).toBe(true);
    expect(pool(container).contains(picked)).toBe(false);
    expect(pool(container).querySelectorAll('[data-testid="gauntlet-slot"]'), 'its place in the pool stays, empty').toHaveLength(1);
  });
});

describe('choosing a deck for the next game', () => {
  const picks = (): GauntletDeck[] =>
    IDS.map((id, i) =>
      i < 4 ? deck(id, { status: 'banned', by: (i % 2) as 0 | 1 }) : deck(id, { status: 'picked', by: (i % 2) as 0 | 1 }),
    );

  it('shows your own unplayed picks to choose from, and marks the one you chose', () => {
    const onChoose = vi.fn();
    const { getByTestId } = draw(view({ phase: 'choose', decks: picks(), choice: { mine: null, chosen: [false, false] } }), { onChoose });
    const mine = getByTestId('gauntlet-choose-mine');
    const options = mine.querySelectorAll<HTMLButtonElement>('[data-testid="gauntlet-deck"]');
    expect([...options].map((o) => o.dataset.deckId)).toEqual([IDS[4], IDS[6], IDS[8]]);
    fireEvent.click(options[1]!);
    expect(onChoose).toHaveBeenCalledWith(IDS[6]);
  });

  it('a played deck cannot be chosen again', () => {
    const decks = picks().map((d) => (d.id === IDS[4] ? { ...d, played: true } : d));
    const { getByTestId } = draw(view({ phase: 'choose', decks, games: [{ decks: [IDS[4], IDS[5]], winner: 0 }], choice: { mine: null, chosen: [false, false] } }));
    const played = getByTestId('gauntlet-choose-mine').querySelector<HTMLButtonElement>(`[data-deck-id="${IDS[4]}"]`)!;
    expect(played.disabled).toBe(true);
    expect(played.dataset.played).toBe('true');
  });

  it('the other seat’s choice stays hidden until both have chosen — only that they have', () => {
    const { getByTestId } = draw(view({ phase: 'choose', decks: picks(), choice: { mine: IDS[6], chosen: [true, true] } }));
    const mine = getByTestId('gauntlet-choose-mine');
    expect(mine.querySelector(`[data-deck-id="${IDS[6]}"]`)?.getAttribute('aria-checked')).toBe('true');
    const theirs = getByTestId('gauntlet-choose-theirs');
    expect(theirs.dataset.chosen).toBe('true');
    expect(theirs.querySelector('[aria-checked="true"]'), 'no deck of theirs is marked').toBeNull();
    expect(theirs.querySelector('[data-chosen-deck]')).toBeNull();
  });

  it('once both are revealed, both decks of the game are drawn face up', () => {
    const decks = picks().map((d) => (d.id === IDS[6] || d.id === IDS[5] ? { ...d, played: true } : d));
    const { getByTestId } = draw(view({ phase: 'playing', decks, games: [{ decks: [IDS[6], IDS[5]], winner: null }], choice: null }));
    const shown = getByTestId('gauntlet-game');
    expect(shown.querySelector(`[data-seat="0"] [data-deck-id="${IDS[6]}"]`)).not.toBeNull();
    expect(shown.querySelector(`[data-seat="1"] [data-deck-id="${IDS[5]}"]`)).not.toBeNull();
  });

  it('a watcher sees whether each seat has chosen, and no deck chosen', () => {
    const { getByTestId, queryByTestId } = draw(view({ phase: 'choose', you: null, decks: picks(), choice: { mine: null, chosen: [true, false] } }));
    expect(queryByTestId('gauntlet-choose-mine')).toBeNull();
    const seat = (n: 0 | 1): string | undefined => getByTestId('gauntlet-choose').querySelector<HTMLElement>(`[data-seat="${n}"][data-chosen]`)?.dataset.chosen;
    expect([seat(0), seat(1)]).toEqual(['true', 'false']);
    expect(getByTestId('gauntlet-choose').querySelector('[aria-checked="true"]')).toBeNull();
  });
});

describe('the result', () => {
  it('names the winner and every game’s decks', () => {
    const decks = IDS.map((id) => deck(id, { status: 'picked', by: 0, played: true }));
    const { getByTestId } = draw(
      view({
        phase: 'done',
        decks,
        winner: 1,
        games: [
          { decks: [IDS[4], IDS[5]], winner: 1 },
          { decks: [IDS[6], IDS[7]], winner: 0 },
          { decks: [IDS[8], IDS[9]], winner: 1 },
        ],
      }),
    );
    const result = getByTestId('gauntlet-result');
    expect(within(result).getByTestId('gauntlet-winner').textContent).toContain('Bob');
    expect(result.querySelectorAll('[data-testid="gauntlet-game"]')).toHaveLength(3);
    expect(within(result).getByTestId('gauntlet-score').textContent, 'the series score, P1 (Bob) first').toBe('2–1');
    const won = [...result.querySelectorAll<HTMLElement>('[data-testid="gauntlet-game"]')].map((g) => g.dataset.winner);
    expect(won, 'each game says who won it').toEqual(['1', '0', '1']);
  });
});
