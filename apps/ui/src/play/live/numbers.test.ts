// @vitest-environment jsdom
/*
 * Floating combat numbers (`numbers.ts`): the diff, the stacking layout, the
 * counter's steps, and what `installNumbers` draws into a board's overlay
 * root. jsdom gives every element a zero rect, so the DOM half of this suite
 * stubs `getBoundingClientRect` with real numbers — the same device
 * `presence.test.ts` uses for the same reason.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardCard, BoardPlayer, BoardView, StackEntry } from '../adapter.ts';
import { GLIDE_MS, HIT_MS, noteRevealShown, REVEAL_BEAT_MS } from '../motion.ts';
import {
  DEATH_FADE_MS,
  DEATH_FADE_START_MS,
  LIFE_COLOUR_MS,
  POP_MS,
  POP_THRESHOLD,
  RISE_MS,
  STACK_OFFSET_PX,
  STACK_STAGGER_MS,
  TICK_STEP_MS,
  diffViews,
  formatDelta,
  installNumbers,
  lifeColour,
  stackLayout,
  tickSteps,
} from './numbers.ts';

/* ── fixtures: the smallest BoardView/BoardPlayer/BoardCard that typechecks ── */

function card(id: number, damage: number): BoardCard {
  return {
    id,
    card: {
      cardId: `c${id}`,
      name: `Card ${id}`,
      manaCost: [],
      manaValue: 0,
      colors: [],
      typeLine: 'Creature',
      oracleText: '',
      setCode: 'TST',
      collectorNumber: String(id),
      rarity: 'common',
    },
    tapped: false,
    summoningSick: false,
    damage,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
  };
}

function player(
  id: number,
  life: number,
  opts: { battlefield?: BoardCard[]; graveyard?: BoardCard[]; isViewer?: boolean } = {},
): BoardPlayer {
  return {
    id,
    name: `P${id}`,
    life,
    isViewer: opts.isViewer ?? false,
    isActive: false,
    hasPriority: false,
    hasLost: false,
    hand: null,
    handCount: 0,
    libraryCount: 0,
    battlefield: opts.battlefield ?? [],
    graveyard: opts.graveyard ?? [],
    exile: [],
  };
}

function view(players: BoardPlayer[]): BoardView {
  return {
    seq: 1,
    title: 't',
    turn: 1,
    phase: null,
    phaseLabel: '',
    activePlayerId: null,
    players,
    stack: [],
    gameOver: false,
    missingCardIds: [],
  };
}

/* ── pure: diffing ─────────────────────────────────────────────────────── */

describe('diffViews', () => {
  it('the first view ever seen diffs to nothing — there is no "before" to compare it against', () => {
    const v = view([player(0, 20), player(1, 20)]);
    expect(diffViews(null, v)).toEqual({ life: [], damage: [], deaths: [], resolved: [], arrivals: [] });
  });

  it('a life change is reported for the player it happened to, and nobody else', () => {
    const before = view([player(0, 20), player(1, 20)]);
    const after = view([player(0, 17), player(1, 20)]);
    expect(diffViews(before, after)).toEqual({ life: [{ playerId: 0, from: 20, to: 17 }], damage: [], deaths: [], resolved: [], arrivals: [] });
  });

  it('a damage change on a creature still on a battlefield is reported, keyed by card id and owner', () => {
    const before = view([player(0, 20, { battlefield: [card(7, 0)] }), player(1, 20)]);
    const after = view([player(0, 20, { battlefield: [card(7, 1)] }), player(1, 20)]);
    expect(diffViews(before, after)).toEqual({ life: [], damage: [{ cardId: 7, ownerId: 0, from: 0, to: 1 }], deaths: [], resolved: [], arrivals: [] });
  });

  it('a creature that leaves the battlefield AND lands in a graveyard in the same view is a death, carrying the damage it last had', () => {
    const before = view([player(0, 20, { battlefield: [card(7, 3)] }), player(1, 20)]);
    const after = view([player(0, 20, { battlefield: [], graveyard: [card(7, 3)] }), player(1, 20)]);
    expect(diffViews(before, after)).toEqual({ life: [], damage: [], deaths: [{ cardId: 7, ownerId: 0, damage: 3 }], resolved: [], arrivals: [] });
  });

  it('a creature that leaves the battlefield and is NOT in any graveyard (bounced to a hand, say) is not a death', () => {
    const before = view([player(0, 20, { battlefield: [card(7, 0)] }), player(1, 20)]);
    const after = view([player(0, 20, { battlefield: [] }), player(1, 20)]);
    expect(diffViews(before, after).deaths).toEqual([]);
  });

  it('nothing moving at all diffs to nothing', () => {
    const v = view([player(0, 20, { battlefield: [card(7, 2)] }), player(1, 20)]);
    expect(diffViews(v, v)).toEqual({ life: [], damage: [], deaths: [], resolved: [], arrivals: [] });
  });
});

/* ── pure: stacking, ticking, colour and text ─────────────────────────── */

describe('stackLayout', () => {
  it('the first number at an anchor has no offset and no delay; each later one at the SAME instant adds one step of each', () => {
    expect(stackLayout(0)).toEqual({ offsetPx: 0, delayMs: 0 });
    expect(stackLayout(1)).toEqual({ offsetPx: STACK_OFFSET_PX, delayMs: STACK_STAGGER_MS });
    expect(stackLayout(2)).toEqual({ offsetPx: 2 * STACK_OFFSET_PX, delayMs: 2 * STACK_STAGGER_MS });
  });
});

describe('tickSteps', () => {
  it('counts down one at a time to a loss, up to a gain, and is empty for no change', () => {
    expect(tickSteps(20, 17)).toEqual([19, 18, 17]);
    expect(tickSteps(20, 23)).toEqual([21, 22, 23]);
    expect(tickSteps(20, 20)).toEqual([]);
  });
});

describe('colour and text', () => {
  it('life: a gain is the success colour, a loss the danger colour', () => {
    expect(lifeColour(3)).toBe('success');
    expect(lifeColour(-3)).toBe('danger');
  });

  it('formatDelta signs life directly and flips damage, so a hit always reads as a loss', () => {
    expect(formatDelta(3, 'life')).toBe('+3');
    expect(formatDelta(-3, 'life')).toBe('-3');
    expect(formatDelta(3, 'damage'), 'three NEW damage reads as -3, the harm it is — the only direction installNumbers ever spawns one for').toBe('-3');
  });
});

/* ── installNumbers: the DOM ──────────────────────────────────────────── */

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

function board(): { canvas: HTMLElement } {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div data-player-face data-player-id="0" data-viewer=""><span data-testid="life">20</span></div>
      <div data-player-face data-player-id="1"><span data-testid="life">20</span></div>
      <div data-zone="battlefield" data-owner="you"><li class="board-card" data-card-id="7"><span class="board-card__pt"></span></li></div>
      <div data-zone="battlefield" data-owner="them"></div>
      <div data-zone="graveyard" data-owner="you"></div>
      <div data-zone="graveyard" data-owner="them"></div>
      <div class="board__overlay" data-board-overlay=""></div>
    </div>`;
  document.body.append(canvas);
  const boxes: Record<string, Box> = {
    '[data-board-overlay]': { left: 0, top: 0, width: 1000, height: 800 },
    '[data-player-face][data-player-id="0"]': { left: 100, top: 700, width: 60, height: 60 },
    '[data-player-face][data-player-id="1"]': { left: 100, top: 20, width: 60, height: 60 },
    '[data-card-id="7"] .board-card__pt': { left: 300, top: 400, width: 24, height: 16 },
    '[data-zone="graveyard"][data-owner="you"]': { left: 500, top: 700, width: 60, height: 84 },
    '[data-zone="graveyard"][data-owner="them"]': { left: 500, top: 20, width: 60, height: 84 },
  };
  for (const [selector, box] of Object.entries(boxes)) canvas.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(box);
  return { canvas };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('installNumbers: life', () => {
  it('a life loss spawns one number at the face, danger-coloured, signed, and it is gone after its lifetime', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 17)]));

    const numbers = overlay.querySelectorAll<HTMLElement>('.board-number');
    expect(numbers, 'one number, spawned at once (no stacking, nothing to stagger against)').toHaveLength(1);
    expect(numbers[0]!.textContent).toBe('-3');
    expect(numbers[0]!.dataset.numberColour).toBe('danger');
    expect(numbers[0]!.dataset.numberPop, 'a change of 3 does not pop').toBeUndefined();
    expect(numbers[0]!.style.left).toBe('130px'); // player 1's face centre (100+30), overlay-relative
    expect(numbers[0]!.style.top).toBe('50px');

    vi.advanceTimersByTime(RISE_MS - 1);
    expect(overlay.querySelectorAll('.board-number'), 'still rising').toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(overlay.querySelectorAll('.board-number'), 'its lifetime is over').toHaveLength(0);
    handle.dispose();
  });

  it('a change of 5 or more pops, and its lifetime is the pop plus the rise', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 25)]));

    const el = overlay.querySelector<HTMLElement>('.board-number')!;
    expect(el.textContent).toBe('+5');
    expect(el.dataset.numberColour).toBe('success');
    expect(el.dataset.numberPop, `${POP_THRESHOLD} or more pops`).toBe('');

    vi.advanceTimersByTime(POP_MS + RISE_MS - 1);
    expect(overlay.querySelectorAll('.board-number')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(overlay.querySelectorAll('.board-number'), 'gone after pop + rise, not rise alone').toHaveLength(0);
    handle.dispose();
  });

  it('reduced motion: no pop attribute even past the threshold, and the reduced flag is set', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => true, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 25)]));

    const el = overlay.querySelector<HTMLElement>('.board-number')!;
    expect(el.dataset.numberPop, 'reduced motion never pops').toBeUndefined();
    expect(el.dataset.numberReduced).toBe('');

    vi.advanceTimersByTime(RISE_MS);
    expect(overlay.querySelectorAll('.board-number'), 'the plain rise duration, not the popped one').toHaveLength(0);
    handle.dispose();
  });

  it('the seat bar’s own life span ticks in 150ms steps, coloured for 1.5s, with nothing drawn beside it', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    const face1 = canvas.querySelector<HTMLElement>('[data-player-face][data-player-id="1"]')!;
    const lifeSpan = face1.querySelector<HTMLElement>('[data-testid="life"]')!;

    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 17)]));

    expect(lifeSpan.textContent, 'not yet stepped').toBe('20');
    expect(face1.textContent, 'no old value beside the counter').toBe(lifeSpan.textContent);
    expect(lifeSpan.dataset.numberLifeColour).toBe('danger');

    vi.advanceTimersByTime(TICK_STEP_MS);
    expect(lifeSpan.textContent).toBe('19');
    vi.advanceTimersByTime(TICK_STEP_MS);
    expect(lifeSpan.textContent).toBe('18');
    vi.advanceTimersByTime(TICK_STEP_MS);
    expect(lifeSpan.textContent).toBe('17');

    vi.advanceTimersByTime(LIFE_COLOUR_MS - 3 * TICK_STEP_MS - 1);
    expect(lifeSpan.dataset.numberLifeColour, 'still coloured, 1.5s not up yet').toBe('danger');
    vi.advanceTimersByTime(1);
    expect(lifeSpan.dataset.numberLifeColour).toBeUndefined();
    handle.dispose();
  });

  it('Fast Mode: the counter jumps straight to the new value, with nothing drawn beside it', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => true });
    const face1 = canvas.querySelector<HTMLElement>('[data-player-face][data-player-id="1"]')!;
    const lifeSpan = face1.querySelector<HTMLElement>('[data-testid="life"]')!;

    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 17)]));

    expect(lifeSpan.textContent, 'Fast Mode: no stepping').toBe('17');
    expect(face1.textContent, 'no old value beside the counter').toBe('17');
    handle.dispose();
  });

  it('stacking: a second number at the same anchor before the first ends offsets 12px sideways and starts 80ms later', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 18)])); // first: -2, spawns at once
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 16)])); // second: -2, while the first is still active

    expect(overlay.querySelectorAll('.board-number'), 'the second one has not placed yet').toHaveLength(1);
    const first = overlay.querySelector<HTMLElement>('.board-number')!;
    const firstLeft = Number.parseFloat(first.style.left);

    vi.advanceTimersByTime(STACK_STAGGER_MS - 1);
    expect(overlay.querySelectorAll('.board-number'), 'one ms short of the stagger: still one').toHaveLength(1);
    vi.advanceTimersByTime(1);
    const numbers = overlay.querySelectorAll<HTMLElement>('.board-number');
    expect(numbers, 'the stagger elapsed: the second has placed').toHaveLength(2);
    const second = numbers[1]!;
    expect(Number.parseFloat(second.style.left) - firstLeft, 'offset 12px sideways from the first').toBe(STACK_OFFSET_PX);
    handle.dispose();
  });
});

describe('installNumbers: damage', () => {
  it('damage on a creature spawns at its P/T corner, signed as harm', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 1)] }), player(1, 20)]));

    const el = overlay.querySelector<HTMLElement>('.board-number')!;
    expect(el.textContent).toBe('-1');
    expect(el.dataset.numberColour).toBe('danger');
    expect(el.style.left).toBe('312px'); // the P/T corner's centre (300 + 24/2), overlay-relative
    expect(el.style.top).toBe('408px');
    handle.dispose();
  });

  it('nothing for 0: a damage "change" of zero (there is none) and a life change of zero never happen — diffViews already excludes them', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    expect(overlay.querySelectorAll('.board-number')).toHaveLength(0);
    handle.dispose();
  });

  it('a creature that dies gets its number, which turns toward its owner’s graveyard at its own halfway point and is gone by the cleanup', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });

    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 3)] }), player(1, 20)])); // the fatal hit, while still alive
    vi.advanceTimersByTime(RISE_MS); // that number finishes its ordinary life
    expect(overlay.querySelectorAll('.board-number'), 'the survivor’s number is gone before the death is noticed').toHaveLength(0);

    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [], graveyard: [card(7, 3)] }), player(1, 20)]));
    const dying = overlay.querySelector<HTMLElement>('.board-number')!;
    expect(dying, 'the death gets its own number, at the last place the creature was seen').not.toBeNull();
    expect(dying.textContent).toBe('-3');
    expect(dying.dataset.numberDying).toBeUndefined();

    vi.advanceTimersByTime(DEATH_FADE_START_MS - 1);
    expect(dying.dataset.numberDying, 'not yet at the halfway point').toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(dying.dataset.numberDying, 'the halfway point: it turns toward the graveyard').toBe('');
    expect(dying.style.getPropertyValue('--number-dx'), 'aimed at the graveyard it actually died into').not.toBe('');

    vi.advanceTimersByTime(DEATH_FADE_MS - 1);
    expect(overlay.querySelectorAll('.board-number')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(overlay.querySelectorAll('.board-number'), 'gone once the drift finishes').toHaveLength(0);
    handle.dispose();
  });

  it('a creature removed with no damage ever recorded (destroyed outright) draws no number at all', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [] }), player(1, 20, { graveyard: [card(7, 0)] })]));
    expect(overlay.querySelectorAll('.board-number'), 'no damage was ever seen for it, so there is nothing to show').toHaveLength(0);
    handle.dispose();
  });

  it('a cleanup wipe (damage decreasing) is not an event: it spawns no floating number, only the pill catches up', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 3)] }), player(1, 20)]));
    vi.advanceTimersByTime(RISE_MS); // the hit's own number finishes

    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    expect(overlay.querySelectorAll('.board-number'), 'a decrease never spawns a number, success-coloured or otherwise').toHaveLength(0);
    handle.dispose();
  });
});

describe('installNumbers: damage that stays is the badge’s, not this layer’s', () => {
  it('once a hit’s own number has risen, nothing of it is left in the overlay', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 3)] }), player(1, 20)]));
    expect(overlay.querySelectorAll('.board-number'), 'the hit rises').toHaveLength(1);
    vi.advanceTimersByTime(RISE_MS);
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 3)] }), player(1, 20)]));
    expect(overlay.children, 'still damaged, and no standing element beside the P/T badge').toHaveLength(0);
    handle.dispose();
  });
});

describe('installNumbers: dispose', () => {
  it('tears down every active number and the life span’s own colour, and schedules nothing further', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const face1 = canvas.querySelector<HTMLElement>('[data-player-face][data-player-id="1"]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 17)]));
    expect(overlay.querySelectorAll('.board-number')).toHaveLength(1);

    handle.dispose();
    expect(overlay.querySelectorAll('.board-number')).toHaveLength(0);
    expect(face1.querySelector('[data-testid="life"]')!.hasAttribute('data-number-life-colour')).toBe(false);

    // A notify after dispose does nothing — the handle is dead.
    handle.notify(view([player(0, 20, { isViewer: true }), player(1, 10)]));
    vi.advanceTimersByTime(STACK_STAGGER_MS + RISE_MS);
    expect(overlay.querySelectorAll('.board-number')).toHaveLength(0);
  });
});

/* ── a resolution's effects, in beats ─────────────────────────────────── */

function item(id: number, sourceCardId: number | null): StackEntry {
  return { id, description: '', sourceCardId, sourceName: null, sourceCard: null, controllerName: null, isAbility: true };
}

function withStack(v: BoardView, stack: StackEntry[]): BoardView {
  return { ...v, stack };
}

describe('diffViews: what a resolution did', () => {
  it('an item gone from the stack is resolved; a token from nowhere is an arrival from the card that made it', () => {
    const before = withStack(view([player(0, 20, { battlefield: [card(7, 0)] }), player(1, 20)]), [item(40, 7)]);
    const zombie = { ...card(50, 0), token: true, createdBy: 7 };
    const after = view([player(0, 20, { battlefield: [card(7, 0), zombie] }), player(1, 20)]);
    const diff = diffViews(before, after);
    expect(diff.resolved.map((i) => i.id)).toEqual([40]);
    expect(diff.arrivals).toEqual([{ cardId: 50, source: 7 }]);
  });

  it('a card played from a hand the viewer cannot see is not an arrival — the other seat’s landing draws it', () => {
    const before = view([player(0, 20), { ...player(1, 20), handCount: 3, libraryCount: 30 }]);
    const after = view([player(0, 20), { ...player(1, 20, { battlefield: [card(9, 0)] }), handCount: 2, libraryCount: 30 }]);
    expect(diffViews(before, after).arrivals).toEqual([]);
  });

  it('a card a resolution put onto a battlefield out of a library is an arrival, maker unknown', () => {
    const before = withStack(view([{ ...player(0, 20), libraryCount: 30 }, player(1, 20)]), [item(41, null)]);
    const after = view([{ ...player(0, 20, { battlefield: [card(9, 0)] }), libraryCount: 29 }, player(1, 20)]);
    expect(diffViews(before, after).arrivals).toEqual([{ cardId: 9, source: null }]);
  });

  it('a board being set up is not an arrival: permanents and tokens no resolution and no maker explain', () => {
    const before = view([{ ...player(0, 20), libraryCount: 0 }, { ...player(1, 20), libraryCount: 0 }]);
    const after = view([
      { ...player(0, 20, { battlefield: [card(9, 0), { ...card(10, 0), token: true }] }), libraryCount: 6 },
      { ...player(1, 20, { battlefield: [card(11, 0)] }), libraryCount: 6 },
    ]);
    expect(diffViews(before, after).arrivals).toEqual([]);
    const shuffledIn = view([{ ...player(0, 20), libraryCount: 40 }, player(1, 20)]);
    const dealt = view([{ ...player(0, 20, { battlefield: [card(9, 0)] }), libraryCount: 33 }, player(1, 20)]);
    expect(diffViews(shuffledIn, dealt).arrivals, 'not even when a library shrank with it').toEqual([]);
  });
});

describe('installNumbers: a resolution’s hits', () => {
  function sorinBoard(): { canvas: HTMLElement; overlay: HTMLElement; face: HTMLElement; life: HTMLElement } {
    const { canvas } = board();
    canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!.insertAdjacentHTML('beforeend', '<li class="board-card" data-board-card="8" data-card-id="8"></li>');
    canvas.querySelector<HTMLElement>('[data-board-card="8"]')!.getBoundingClientRect = () => rect({ left: 600, top: 500, width: 60, height: 84 });
    const face = canvas.querySelector<HTMLElement>('[data-player-face][data-player-id="1"]')!;
    return { canvas, overlay: canvas.querySelector<HTMLElement>('[data-board-overlay]')!, face, life: face.querySelector<HTMLElement>('[data-testid="life"]')! };
  }

  it('life lost to a resolving ability travels from its source to the face; the number and the counter wait for it to land', () => {
    vi.useFakeTimers();
    const { canvas, overlay, face, life } = sorinBoard();
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(withStack(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0)] }), player(1, 20)]), [item(40, 8)]));
    life.textContent = '18'; // React draws the new total with the frame
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0)] }), player(1, 18)]));

    const mark = overlay.querySelector<HTMLElement>('.effect-hit');
    expect(mark?.dataset.hit, 'a hit leaves the source at once').toBe('player:1');
    expect(mark!.style.left, 'aimed at the face').toBe('130px');
    expect(overlay.querySelectorAll('.board-number'), 'no number before it lands').toHaveLength(0);
    expect(life.textContent, 'the counter still reads the old total').toBe('20');

    vi.advanceTimersByTime(HIT_MS);
    expect(overlay.querySelector('.effect-hit'), 'the mark is gone on landing').toBeNull();
    expect(face.hasAttribute('data-hit-flash'), 'the face flashes').toBe(true);
    expect(overlay.querySelector('.board-number')?.textContent).toBe('-2');
    vi.advanceTimersByTime(2 * TICK_STEP_MS);
    expect(life.textContent).toBe('18');
    handle.dispose();
  });

  it('a reveal shown while the item was on the stack goes first: the hit waits out its beat and comes from the revealed card', () => {
    vi.useFakeTimers();
    const { canvas, overlay } = sorinBoard();
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(withStack(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0)] }), player(1, 20)]), [item(40, 8)]));
    const revealed = document.createElement('li');
    revealed.getBoundingClientRect = () => rect({ left: 200, top: 300, width: 96, height: 134 });
    document.body.append(revealed);
    noteRevealShown(revealed);
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0)] }), player(1, 18)]));

    expect(overlay.querySelector('.effect-hit'), 'nothing travels during the reveal’s beat').toBeNull();
    vi.advanceTimersByTime(REVEAL_BEAT_MS);
    const mark = overlay.querySelector<HTMLElement>('.effect-hit');
    expect(mark, 'then the hit').not.toBeNull();
    // It was placed at the revealed card's centre (248, 367) before being sent on its way.
    expect(mark!.dataset.hitTravelling).toBe('');
    vi.advanceTimersByTime(HIT_MS);
    expect(overlay.querySelector('.board-number')?.textContent).toBe('-2');
    handle.dispose();
  });

  it('a token arrives from the card that made it: marked while it travels, hidden in its slot until it lands', () => {
    vi.useFakeTimers();
    const { canvas } = sorinBoard();
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0)] }), player(1, 20)]));
    canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!.insertAdjacentHTML('beforeend', '<li class="board-card" data-board-card="50" data-card-id="50"></li>');
    const token = canvas.querySelector<HTMLElement>('[data-board-card="50"]')!;
    token.getBoundingClientRect = () => rect({ left: 700, top: 500, width: 60, height: 84 });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0), { ...card(50, 0), token: true, createdBy: 8 }] }), player(1, 20)]));

    expect(token.getAttribute('data-arriving-from'), 'from the maker').toBe('8');
    expect(document.querySelector('[data-cast-ghost], [data-cast-lift]'), 'a stand-in travels from Kalitas').not.toBeNull();
    expect(token.hasAttribute('data-cast-landing'), 'the token itself waits hidden in its slot').toBe(true);
    vi.advanceTimersByTime(GLIDE_MS);
    expect(token.hasAttribute('data-arriving-from')).toBe(false);
    expect(token.hasAttribute('data-cast-landing'), 'and shows once the stand-in is there').toBe(false);
    handle.dispose();
  });

  it('reduced motion: nothing travels — the face flashes and the number appears in place', () => {
    vi.useFakeTimers();
    const { canvas, overlay, face } = sorinBoard();
    const handle = installNumbers(canvas, { reducedMotion: () => true, fastMode: () => false });
    handle.notify(withStack(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0)] }), player(1, 20)]), [item(40, 8)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(8, 0)] }), player(1, 18)]));
    expect(overlay.querySelector('.effect-hit')).toBeNull();
    expect(face.hasAttribute('data-hit-flash')).toBe(true);
    expect(overlay.querySelector('.board-number')?.textContent).toBe('-2');
    handle.dispose();
  });
});
