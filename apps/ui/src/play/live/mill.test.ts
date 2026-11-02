// @vitest-environment jsdom
/* Cards milled (`mill.ts`): which cards a frame milled, how a run is timed, and the copies flown to the pile. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardCard, BoardPlayer, BoardView } from '../adapter.ts';
import { LANDING_ATTR } from './departures.ts';
import { whenBoardUnlocked } from '../motion.ts';
import { installNumbers } from './numbers.ts';
import { installMill, MILL_ATTR, MILL_FLIGHT_MS, MILL_MAX_FLYERS, MILL_MAX_MS, MILL_STAGGER_MS, millsOf, millTiming, SET_ASIDE_VIEWS, setAsideAfter, type Mill } from './mill.ts';

function card(id: number): BoardCard {
  return {
    id,
    card: {
      cardId: `c${id}`,
      name: `Card ${id}`,
      manaCost: [],
      manaValue: 0,
      colors: [],
      typeLine: 'Instant',
      oracleText: '',
      setCode: 'TST',
      collectorNumber: String(id),
      rarity: 'common',
    },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
  };
}

function player(id: number, libraryIds: number[], graveyard: number[], opts: { battlefield?: number[] } = {}): BoardPlayer {
  return {
    id,
    name: `P${id}`,
    life: 20,
    isViewer: id === 0,
    isActive: false,
    hasPriority: false,
    hasLost: false,
    hand: null,
    handCount: 0,
    libraryCount: libraryIds.length,
    libraryIds,
    battlefield: (opts.battlefield ?? []).map(card),
    graveyard: graveyard.map(card),
    exile: [],
  };
}

function view(players: BoardPlayer[]): BoardView {
  return { seq: 1, title: 't', turn: 1, phase: null, phaseLabel: '', activePlayerId: null, players, stack: [], gameOver: false, missingCardIds: [] };
}

describe('millsOf', () => {
  it('finds nothing without a view before', () => {
    expect(millsOf(null, view([player(0, [1, 2], [])]))).toEqual([]);
  });

  it('a card that left a library and is in a graveyard in the same frame is milled, top of the library first', () => {
    const before = view([player(0, [10, 11, 12, 13], [5]), player(1, [20, 21], [])]);
    // Forge's graveyard order is its own; the run is the library's order.
    const after = view([player(0, [13], [5, 12, 10, 11]), player(1, [20, 21], [])]);
    expect(millsOf(before, after)).toEqual([
      { cardId: 10, fromPlayerId: 0, toPlayerId: 0, index: 0 },
      { cardId: 11, fromPlayerId: 0, toPlayerId: 0, index: 1 },
      { cardId: 12, fromPlayerId: 0, toPlayerId: 0, index: 2 },
    ]);
  });

  it("the other seat's library is milled the same way", () => {
    const before = view([player(0, [10], []), player(1, [20, 21, 22], [])]);
    const after = view([player(0, [10], []), player(1, [22], [20, 21])]);
    expect(millsOf(before, after).map((m) => [m.cardId, m.fromPlayerId, m.toPlayerId])).toEqual([
      [20, 1, 1],
      [21, 1, 1],
    ]);
  });

  it('a card already in a graveyard, a draw, a discard or a permanent dying is no mill', () => {
    const before = view([player(0, [10, 11], [5], { battlefield: [7] }), player(1, [], [])]);
    // 10 drawn (to a hand, gone from both), 7 died, 5 was there already.
    const after = view([player(0, [11], [5, 7]), player(1, [], [])]);
    expect(millsOf(before, after)).toEqual([]);
  });

  it('carries the card art id, for the art to decode before it flies', () => {
    const milled = { ...card(10), card: { ...card(10).card, scryfallId: 'abc' } };
    const before = view([player(0, [10], [])]);
    const after = view([{ ...player(0, [], []), graveyard: [milled] }]);
    expect(millsOf(before, after)[0]?.scryfallId).toBe('abc');
  });

  it('a view with no library ids (no library known) finds nothing', () => {
    const before = view([{ ...player(0, [], []), libraryIds: undefined }]);
    expect(millsOf(before, view([player(0, [], [10])]))).toEqual([]);
  });
});

describe('a card set aside out of every zone before its graveyard', () => {
  const hand = (p: BoardPlayer, n: number): BoardPlayer => ({ ...p, handCount: n });

  it("the other screen's surveil: a looked-at card in no zone for a frame, then in the graveyard, is milled", () => {
    // Measured: Notion Rain on the screen that does not know the cards, one of the two in no zone list for a frame.
    const before = view([player(0, [10, 11, 12], []), player(1, [], [])]);
    const looking = view([player(0, [11, 12], []), player(1, [], [])]);
    const after = view([player(0, [12], [10, 11]), player(1, [], [])]);
    expect(millsOf(looking, after).map((m) => m.cardId)).toEqual([11]);
    const aside = setAsideAfter(before, looking);
    expect([...aside.keys()]).toEqual([10]);
    expect(millsOf(looking, after, aside).map((m) => [m.cardId, m.fromPlayerId, m.toPlayerId])).toEqual([
      [10, 0, 0],
      [11, 0, 0],
    ]);
    // In a graveyard, it is somewhere: no longer set aside.
    expect(setAsideAfter(looking, after, aside).size).toBe(0);
  });

  it('a card drawn into a hand nobody sees is never set aside, so its discard later is no mill', () => {
    const before = view([hand(player(0, [10, 11], []), 3)]);
    const drawn = view([hand(player(0, [11], []), 4)]);
    const aside = setAsideAfter(before, drawn);
    expect(aside.size).toBe(0);
    const discarded = view([hand(player(0, [11], [10]), 3)]);
    expect(millsOf(drawn, discarded, aside)).toEqual([]);
  });

  it("a hand that grows forgets its owner's cards set aside: one looked at and taken (Impulse) is no mill when discarded", () => {
    const before = view([hand(player(0, [10, 11, 12], []), 3)]);
    const looking = view([hand(player(0, [12], []), 3)]);
    const aside = setAsideAfter(before, looking);
    expect([...aside.keys()].sort()).toEqual([10, 11]);
    const taken = view([hand(player(0, [12, 11], []), 4)]);
    const after = setAsideAfter(looking, taken, aside);
    expect(after.size).toBe(0);
    expect(millsOf(taken, view([hand(player(0, [12, 11], [10]), 3)]), after)).toEqual([]);
  });

  it('a card put back in a library is no longer set aside, and one in no zone for long is forgotten', () => {
    const before = view([player(0, [10, 11], [])]);
    const looking = view([player(0, [11], [])]);
    const aside = setAsideAfter(before, looking);
    expect(setAsideAfter(looking, view([player(0, [11, 10], [])]), aside).size).toBe(0);
    let carried = aside;
    for (let i = 0; i < SET_ASIDE_VIEWS; i++) carried = setAsideAfter(looking, looking, carried);
    expect(carried.size).toBe(0);
  });
});

describe('millTiming', () => {
  it('one to three cards: full flights, one by one', () => {
    expect(millTiming(1)).toEqual({ flightMs: MILL_FLIGHT_MS, starts: [0], totalMs: MILL_FLIGHT_MS });
    const three = millTiming(3);
    expect(three.flightMs).toBe(MILL_FLIGHT_MS);
    expect(three.starts).toEqual([0, MILL_STAGGER_MS, 2 * MILL_STAGGER_MS]);
    expect(three.totalMs).toBeLessThanOrEqual(MILL_MAX_MS);
  });

  it('a big mill is a riffle: it ends in about a second, never ten full flights', () => {
    for (const n of [10, 13, 30, 60]) {
      const t = millTiming(n);
      expect(t.flightMs).toBeLessThan(MILL_FLIGHT_MS);
      expect(t.totalMs).toBeLessThanOrEqual(MILL_MAX_MS);
      expect(t.totalMs).toBeGreaterThan(MILL_MAX_MS * 0.8);
      const flown = t.starts.filter((s) => s !== null);
      expect(flown.length).toBe(Math.min(n, MILL_MAX_FLYERS));
      // The first and last card of the run both fly, and in order.
      expect(t.starts[0]).toBe(0);
      expect(t.starts[n - 1]).not.toBeNull();
      expect([...flown].sort((a, b) => a! - b!)).toEqual(flown);
    }
  });

  it('nothing to mill takes no time', () => {
    expect(millTiming(0).totalMs).toBe(0);
  });
});

describe('installMill', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function board(ids: number[]): HTMLElement {
    const canvas = document.createElement('div');
    canvas.innerHTML = `
      <div data-board-overlay=""></div>
      <section class="seat"><div data-player-face="" data-player-id="0"></div><span data-testid="library-count"></span>
        <section data-zone="graveyard">${ids.map((id) => `<li class="board-card" data-board-card="${id}"></li>`).join('')}</section>
      </section>`;
    document.body.append(canvas);
    return canvas;
  }
  const mills = (ids: number[]): Mill[] => ids.map((cardId, index) => ({ cardId, fromPlayerId: 0, toPlayerId: 0, index }));
  const pile = (canvas: HTMLElement, id: number): HTMLElement => canvas.querySelector<HTMLElement>(`[data-board-card="${id}"]`)!;

  it('hides the milled cards on the pile at once, flies a copy of each, and shows each as it lands', () => {
    vi.useFakeTimers();
    const canvas = board([1, 2]);
    const handle = installMill(canvas, () => false);
    const ends = handle.fly(mills([1, 2]), 100);
    expect(ends).toBe(100 + millTiming(2).totalMs);
    expect(pile(canvas, 1).hasAttribute(LANDING_ATTR)).toBe(true);
    expect(pile(canvas, 2).hasAttribute(LANDING_ATTR)).toBe(true);
    vi.advanceTimersByTime(100);
    const flying = canvas.querySelectorAll(`[${MILL_ATTR}]`);
    expect([...flying].map((f) => f.getAttribute(MILL_ATTR))).toEqual(['1']);
    // A copy: nothing finds it as the board's card.
    expect(flying[0]!.querySelector('[data-board-card]')).toBeNull();
    vi.advanceTimersByTime(MILL_STAGGER_MS);
    expect(canvas.querySelectorAll(`[${MILL_ATTR}]`).length).toBe(2);
    vi.advanceTimersByTime(MILL_FLIGHT_MS - MILL_STAGGER_MS);
    expect(pile(canvas, 1).hasAttribute(LANDING_ATTR)).toBe(false);
    expect(pile(canvas, 2).hasAttribute(LANDING_ATTR)).toBe(true);
    vi.advanceTimersByTime(MILL_STAGGER_MS);
    expect(pile(canvas, 2).hasAttribute(LANDING_ATTR)).toBe(false);
    expect(canvas.querySelectorAll(`[${MILL_ATTR}]`).length).toBe(0);
    handle.dispose();
  });

  it('a big mill flies at most a riffle of copies, and every card is on the pile when it ends', () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const canvas = board(ids);
    const handle = installMill(canvas, () => false);
    const ends = handle.fly(mills(ids), 0);
    let most = 0;
    for (let t = 0; t <= ends; t += 10) {
      most = Math.max(most, canvas.querySelectorAll(`[${MILL_ATTR}]`).length);
      vi.advanceTimersByTime(10);
    }
    expect(most).toBeLessThanOrEqual(MILL_MAX_FLYERS);
    expect(ids.filter((id) => pile(canvas, id).hasAttribute(LANDING_ATTR))).toEqual([]);
    handle.dispose();
  });

  it('reduced motion: no flight, each card fades in on the pile', () => {
    vi.useFakeTimers();
    const canvas = board([1, 2, 3]);
    const handle = installMill(canvas, () => true);
    const ends = handle.fly(mills([1, 2, 3]), 0);
    vi.advanceTimersByTime(1);
    expect(pile(canvas, 1).hasAttribute('data-mill-fade')).toBe(true);
    vi.advanceTimersByTime(ends);
    expect(canvas.querySelectorAll(`[${MILL_ATTR}]`).length).toBe(0);
    expect([1, 2, 3].filter((id) => pile(canvas, id).hasAttribute(LANDING_ATTR))).toEqual([]);
    handle.dispose();
  });

  it('dispose shows every card still hidden and takes every copy down', () => {
    vi.useFakeTimers();
    const canvas = board([1, 2]);
    const handle = installMill(canvas, () => false);
    handle.fly(mills([1, 2]), 0);
    vi.advanceTimersByTime(10);
    handle.dispose();
    expect(canvas.querySelectorAll(`[${MILL_ATTR}]`).length).toBe(0);
    expect(pile(canvas, 1).hasAttribute(LANDING_ATTR)).toBe(false);
  });
});

describe('the board draws a mill from the frame that made it (`numbers.ts`)', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it("a frame in which the other seat's library went into their graveyard flies those cards, and hides them on the pile until they land", () => {
    vi.useFakeTimers();
    const canvas = document.createElement('div');
    const draw = (graveyard: number[]): void => {
      canvas.innerHTML = `
        <div data-board-overlay=""></div>
        <section class="seat"><div data-player-face="" data-player-id="1"></div><span data-testid="library-count"></span>
          <section data-zone="graveyard">${graveyard.map((id) => `<li class="board-card" data-board-card="${id}"></li>`).join('')}</section>
        </section>`;
    };
    document.body.append(canvas);
    draw([]);
    const numbers = installNumbers(canvas, { reducedMotion: () => false });
    numbers.notify(view([player(0, [1], []), player(1, [20, 21, 22], [])]));
    draw([20, 21]);
    numbers.notify(view([player(0, [1], []), player(1, [22], [20, 21])]));
    const hidden = (): string[] => [...canvas.querySelectorAll(`[${LANDING_ATTR}]`)].map((el) => el.getAttribute('data-board-card')!);
    expect(hidden()).toEqual(['20', '21']);
    expect(canvas.querySelectorAll(`[${MILL_ATTR}]`).length).toBe(1);
    // Nothing waits on a mill: the other seat's next frame (`pace.ts`) is not held for it.
    let unlocked = false;
    whenBoardUnlocked(() => (unlocked = true));
    expect(unlocked).toBe(true);
    vi.advanceTimersByTime(millTiming(2).totalMs + 1);
    expect(hidden()).toEqual([]);
    expect(canvas.querySelectorAll(`[${MILL_ATTR}]`).length).toBe(0);
    numbers.dispose();
  });
});
