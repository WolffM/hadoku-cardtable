// @vitest-environment jsdom
/*
 * The Gauntlet's screens (`docs/planning/constructed-modes-plan.md`, "Gauntlet reveal"): the
 * format title lands first, then the coin flip, then the ten decks deal in one by one; a ban
 * greys and crosses its tile; a pick moves its tile to the picker's column; before each game
 * the other seat's choice stays hidden until both have chosen.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveNamedArt } from '../../play/art.testing.ts';

import { GAUNTLET_REVEAL_MS, type GauntletDeck, type GauntletView } from '@hadoku/shared';

import { FLIP_MS } from '../../play/live/CoinToss.tsx';
import { PEEK_DELAY_MS } from '../DeckPeek.tsx';
import { GauntletScreen } from './GauntletScreen.tsx';
import * as reveal from './reveal.ts';
import { DEAL_FROM_MS, DEAL_STAGGER_MS, TITLE_MS, revealStage } from './reveal.ts';

// A card known by its name is answered as the server answers it (`GET /api/cards/art`).
beforeEach(serveNamedArt);

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

  // The operator, 2026-10-21: "if i'm hovering a deck and i click it the expanded decklist should disappear".
  it('a press on the deck being peeked closes its list, as the choice is made', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onChoose = vi.fn();
    const { getByTestId, queryByTestId } = draw(view({ phase: 'choose', decks: picks(), choice: { mine: null, chosen: [false, false] } }), { onChoose });
    const tile = getByTestId('gauntlet-choose-mine').querySelector<HTMLButtonElement>('[data-testid="gauntlet-deck"]')!;
    fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEEK_DELAY_MS);
    });
    expect(queryByTestId('deck-peek'), 'the list is open on hover').not.toBeNull();
    fireEvent.pointerDown(tile, { pointerType: 'mouse' });
    fireEvent.click(tile);
    expect(onChoose).toHaveBeenCalledWith(IDS[4]);
    expect(queryByTestId('deck-peek'), 'and gone on the press').toBeNull();
  });

  // The operator, 2026-10-21: hovering a deck showed "the regular page tooltip in-addition to the deck popout".
  it('a deck that opens its list on hover carries no native tooltip', () => {
    const { container } = draw(view({ phase: 'banpick', step: BAN_1 }));
    for (const tile of tiles(container)) expect(tile.querySelector('[title]'), tile.dataset['deckId']).toBeNull();
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

  // The operator, 2026-10-21: "theres still an extra screen that happens between selecting a deck in gauntlet
  // mode and game start ... we need to get rid of this." From the choice to the board the choose screen stays.
  it('while the game is dealt and played, the choose screen stays: your pick marked, theirs only Chosen, no versus card', () => {
    const onChoose = vi.fn();
    const { getByTestId, queryByTestId } = draw(view({ phase: 'playing', decks: picks(), games: [{ decks: [IDS[6], null], winner: null }], choice: null }), { onChoose });
    expect(queryByTestId('gauntlet-playing'), 'no screen of its own').toBeNull();
    expect(queryByTestId('gauntlet-game'), 'no versus card').toBeNull();
    expect(queryByTestId('gauntlet-hidden')).toBeNull();
    expect(getByTestId('gauntlet-choose').dataset.phase).toBe('playing');
    expect(getByTestId('gauntlet-title').textContent, 'the game being dealt, not the next').toContain('Game 1');
    const mine = getByTestId('gauntlet-choose-mine');
    expect(mine.dataset.chosen).toBe('true');
    expect(mine.querySelector(`[data-deck-id="${IDS[6]}"]`)?.getAttribute('aria-checked')).toBe('true');
    const theirs = getByTestId('gauntlet-choose-theirs');
    expect(theirs.dataset.chosen).toBe('true');
    expect(theirs.querySelector('[aria-checked="true"]'), 'no deck of theirs is marked (ruling 9)').toBeNull();
    for (const tile of mine.querySelectorAll<HTMLButtonElement>('[data-testid="gauntlet-deck"]')) {
      expect(tile.disabled, 'the choice is made').toBe(true);
      fireEvent.click(tile);
    }
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('a watcher of a game being played sees both seats Chosen and no deck', () => {
    const { getByTestId } = draw(view({ phase: 'playing', you: null, decks: picks(), games: [{ decks: [null, null], winner: null }], choice: null }));
    const seats = [...getByTestId('gauntlet-choose').querySelectorAll<HTMLElement>('[data-seat][data-chosen]')].map((s) => s.dataset.chosen);
    expect(seats).toEqual(['true', 'true']);
    expect(getByTestId('gauntlet-choose').querySelector('[aria-checked="true"]')).toBeNull();
  });

  it('game 2: both seats’ played decks are greyed, your unplayed ones pressable, theirs shown as available', () => {
    const onChoose = vi.fn();
    const decks = picks().map((d) => (d.id === IDS[4] || d.id === IDS[5] ? { ...d, played: true } : d));
    const { getByTestId } = draw(view({ phase: 'choose', decks, games: [{ decks: [IDS[4], IDS[5]], winner: 0 }], choice: { mine: null, chosen: [false, true] } }), { onChoose });
    expect(getByTestId('gauntlet-title').textContent).toContain('Game 2');
    const at = (side: string, id: string) => getByTestId(side).querySelector<HTMLButtonElement>(`[data-deck-id="${id}"]`)!;
    expect(at('gauntlet-choose-mine', IDS[4]).dataset.played).toBe('true');
    expect(at('gauntlet-choose-theirs', IDS[5]).dataset.played).toBe('true');
    for (const id of [IDS[6], IDS[8]]) {
      expect(at('gauntlet-choose-mine', id).dataset.played).toBeUndefined();
      expect(at('gauntlet-choose-mine', id).disabled).toBe(false);
    }
    fireEvent.click(at('gauntlet-choose-mine', IDS[4]));
    expect(onChoose, 'a played deck is not chosen again').not.toHaveBeenCalled();
    for (const id of [IDS[7], IDS[9]]) {
      const tile = at('gauntlet-choose-theirs', id);
      expect(tile.dataset.played, 'theirs, not yet played').toBeUndefined();
      expect(tile.getAttribute('aria-checked'), 'never shown as chosen').toBeNull();
    }
    expect(getByTestId('gauntlet-choose-theirs').dataset.chosen).toBe('true');
  });

  it('a watcher sees whether each seat has chosen, and no deck chosen', () => {
    const { getByTestId, queryByTestId } = draw(view({ phase: 'choose', you: null, decks: picks(), choice: { mine: null, chosen: [true, false] } }));
    expect(queryByTestId('gauntlet-choose-mine')).toBeNull();
    const seat = (n: 0 | 1): string | undefined => getByTestId('gauntlet-choose').querySelector<HTMLElement>(`[data-seat="${n}"][data-chosen]`)?.dataset.chosen;
    expect([seat(0), seat(1)]).toEqual(['true', 'false']);
    expect(getByTestId('gauntlet-choose').querySelector('[aria-checked="true"]')).toBeNull();
  });
});

/*
 * The operator, 2026-11-02, on trailer cut 7: "need a transition between the pick/ban phase and the
 * 'choosing a deck phase', it looks a bit cheap at the moment that it hard cuts to the next step
 * there". `arrive.test.ts` has the choreography as data; this is the screen around it.
 */
describe('from ban/pick into the choice', () => {
  /** The snake's last step: P2 (table seat 0, the viewer) picks the one deck left. */
  const lastStep = (): GauntletView =>
    view({
      phase: 'banpick',
      step: { index: 7, seat: 0, act: 'pick', count: 1, taken: 0 },
      decks: IDS.map((id, i) => (i < 4 ? deck(id, { status: 'banned', by: (i % 2) as 0 | 1 }) : i === 8 ? deck(id) : deck(id, { status: 'picked', by: (i % 2) as 0 | 1 }))),
    });
  const choosing = (before: GauntletView): GauntletView => ({
    ...before,
    phase: 'choose',
    step: null,
    decks: before.decks.map((d) => (d.status === 'open' ? { ...d, status: 'picked' as const, by: 0 as const } : d)),
    choice: { mine: null, chosen: [false, false] },
  });
  const screen = (v: GauntletView, onChoose: (id: string) => void = noop) => createElement(GauntletScreen, { view: v, onBan: noop, onPick: noop, onChoose });
  const leavingBoard = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('.gauntlet--leaving');

  /** Every animation started, held until the test lets it finish. */
  interface Running {
    el: Element;
    keyframes: Keyframe[];
    playState: AnimationPlayState;
    finish: () => void;
  }
  let running: Running[] = [];
  beforeEach(() => {
    running = [];
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value(this: Element, keyframes: Keyframe[]) {
        let finish = noop;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const a = {
          el: this,
          keyframes,
          playState: 'running' as AnimationPlayState,
          finished,
          finish: () => {
            a.playState = 'finished';
            finish();
          },
          pause: () => {
            a.playState = 'paused';
          },
          play: () => {
            a.playState = 'running';
          },
          cancel: noop,
        };
        running.push(a);
        return a;
      },
    });
  });
  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it('arrives over the board it leaves: the choose screen is drawn and live at once, the board under it found by nothing', () => {
    const before = lastStep();
    const { container, getByTestId, getAllByTestId, rerender } = draw(before);
    rerender(screen(choosing(before)));
    const choose = getByTestId('gauntlet-choose');
    expect(choose.dataset.arriving, 'the arrival is under way').toBe('true');
    const board = leavingBoard(container)!;
    expect(board, 'the board as it was left lies under the choose screen').not.toBeNull();
    expect(choose.contains(board)).toBe(true);
    expect(board.dataset.leaving).toBe('move');
    expect(board.hasAttribute('inert')).toBe(true);
    expect(board.getAttribute('aria-hidden')).toBe('true');
    expect(board.querySelectorAll('[data-testid^="gauntlet"]'), 'nothing on it carries a Gauntlet test id').toHaveLength(0);
    expect(getAllByTestId('gauntlet-title'), 'one title').toHaveLength(1);
    expect(board.querySelector(`[data-deck-id="${IDS[8]}"]`)?.getAttribute('data-status'), 'the last pick still lies where it was pressed').toBe('open');
    const mine = [...getByTestId('gauntlet-choose-mine').querySelectorAll<HTMLButtonElement>('[data-testid="gauntlet-deck"]')];
    expect(mine.map((t) => t.dataset.deckId)).toEqual([IDS[4], IDS[6], IDS[8]]);
    for (const t of mine) expect(t.disabled, 'pressable from the first frame').toBe(false);
  });

  it('every surviving deck, name and the title are the choose screen’s own elements, travelling; the bans fall off the board', () => {
    const before = lastStep();
    const { container, getByTestId, rerender } = draw(before);
    rerender(screen(choosing(before)));
    const moved = new Set(running.map((a) => a.el));
    for (const t of getByTestId('gauntlet-choose').querySelectorAll('.gauntlet__picks > [data-testid="gauntlet-deck"]')) expect(moved.has(t), (t as HTMLElement).dataset.deckId).toBe(true);
    for (const n of getByTestId('gauntlet-choose').querySelectorAll(':scope > .gauntlet__seats .gauntlet__player')) expect(moved.has(n)).toBe(true);
    expect(moved.has(getByTestId('gauntlet-title').querySelector('.gauntlet__era')!)).toBe(true);
    const banned = [...leavingBoard(container)!.querySelectorAll('.gauntlet-tile[data-status="banned"]')];
    expect(banned).toHaveLength(4);
    for (const b of banned) expect(moved.has(b)).toBe(true);
  });

  it('a press while it arrives is a choice made: the motion holds still under the pointer and the choice goes through', () => {
    const before = lastStep();
    const onChoose = vi.fn();
    const { getByTestId, rerender } = draw(before, { onChoose });
    rerender(screen(choosing(before), onChoose));
    const tile = getByTestId('gauntlet-choose-mine').querySelector<HTMLButtonElement>(`[data-deck-id="${IDS[6]}"]`)!;
    fireEvent.pointerDown(tile, { pointerType: 'mouse' });
    expect(running.every((a) => a.playState === 'paused'), 'held still while pressed').toBe(true);
    fireEvent.pointerUp(tile, { pointerType: 'mouse' });
    fireEvent.click(tile);
    expect(onChoose).toHaveBeenCalledWith(IDS[6]);
    expect(running.every((a) => a.playState === 'running'), 'and on its way again once let go').toBe(true);
  });

  it('a deck flying under a resting pointer opens no list; once it has landed, a hover does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const before = lastStep();
    const { getByTestId, queryByTestId, rerender } = draw(before);
    rerender(screen(choosing(before)));
    const tile = getByTestId('gauntlet-choose-mine').querySelector<HTMLButtonElement>('[data-testid="gauntlet-deck"]')!;
    fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEEK_DELAY_MS * 2);
    });
    expect(queryByTestId('deck-peek'), 'no list while it arrives').toBeNull();
    await act(async () => {
      for (const a of running) a.finish();
    });
    fireEvent.pointerLeave(tile);
    fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEEK_DELAY_MS);
    });
    expect(queryByTestId('deck-peek'), 'the list on a hover after').not.toBeNull();
  });

  it('once every part has come to rest the board is gone and the choose screen is as it always was', async () => {
    const before = lastStep();
    const { container, getByTestId, rerender } = draw(before);
    rerender(screen(choosing(before)));
    expect(leavingBoard(container)).not.toBeNull();
    await act(async () => {
      for (const a of running) a.finish();
    });
    expect(leavingBoard(container)).toBeNull();
    expect(getByTestId('gauntlet-choose').dataset.arriving).toBeUndefined();
  });

  it('a later view while it arrives (the other seat has chosen) keeps it arriving', () => {
    const before = lastStep();
    const { container, getByTestId, rerender } = draw(before);
    const next = choosing(before);
    rerender(screen(next));
    rerender(screen({ ...next, choice: { mine: null, chosen: [false, true] } }));
    expect(leavingBoard(container)).not.toBeNull();
    expect(getByTestId('gauntlet-choose-theirs').dataset.chosen).toBe('true');
  });

  it('under prefers-reduced-motion the board stays whole for a crossfade', () => {
    reduced = true;
    const before = lastStep();
    const { container, rerender } = draw(before);
    rerender(screen(choosing(before)));
    expect(leavingBoard(container)!.dataset.leaving).toBe('fade');
    expect(running.every((a) => a.keyframes.every((k) => Object.keys(k).every((p) => p === 'opacity' || p === 'offset'))), 'opacity alone').toBe(true);
  });

  it('a screen that opens on the choice, or comes back to it after a game, has no board to leave', () => {
    const before = lastStep();
    const { container, getByTestId } = draw(choosing(before));
    expect(leavingBoard(container)).toBeNull();
    expect(getByTestId('gauntlet-choose').dataset.arriving).toBeUndefined();
    cleanup();
    const game2 = { ...choosing(before), games: [{ decks: [IDS[4], IDS[5]] as [string, string], winner: 0 as const }] };
    const again = draw({ ...game2, phase: 'playing', choice: null });
    again.rerender(screen(game2));
    expect(leavingBoard(again.container)).toBeNull();
    expect(running).toHaveLength(0);
  });

  it('a browser that cannot animate goes straight to the choose screen', async () => {
    delete (Element.prototype as { animate?: unknown }).animate;
    const before = lastStep();
    const { container, rerender } = draw(before);
    await act(async () => {
      rerender(screen(choosing(before)));
    });
    expect(leavingBoard(container)).toBeNull();
  });
});

describe('the result', () => {
  it('names the winner and every game’s decks', () => {
    const decks = IDS.map((id) => deck(id, { status: 'picked', by: 0, played: true }));
    const { getByTestId } = draw(
      view({
        phase: 'done',
        decks,
        winner: 0,
        games: [
          { decks: [IDS[4], IDS[5]], winner: 0 },
          { decks: [IDS[6], IDS[7]], winner: 1 },
          { decks: [IDS[8], IDS[9]], winner: 0 },
        ],
      }),
    );
    const result = getByTestId('gauntlet-result');
    expect(within(result).getByTestId('gauntlet-winner').textContent).toContain('Alice');
    expect(result.querySelectorAll('[data-testid="gauntlet-game"]')).toHaveLength(3);
    expect(within(result).getByTestId('gauntlet-score').textContent, 'the series score beside the winner, theirs first').toBe('2–1');
    const won = [...result.querySelectorAll<HTMLElement>('[data-testid="gauntlet-game"]')].map((g) => g.dataset.winner);
    expect(won, 'each game says who won it').toEqual(['0', '1', '0']);
  });

  it('stacks the games top to bottom (ruling 13.3)', () => {
    // jsdom lays nothing out, so the rule is read; `e2e/cm-gauntlet.spec.ts` measures the boxes.
    const css = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/screens/gauntlet', 'gauntlet.css'), 'utf8');
    const rule = /\.gauntlet__games\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule, 'the result has its own games rule').not.toBe('');
    expect(rule).toMatch(/flex-direction:\s*column|grid-auto-flow:\s*row/);
    expect(rule).not.toMatch(/grid-auto-flow:\s*column/);
  });
});
