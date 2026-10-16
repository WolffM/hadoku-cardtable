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
import { BEAT_STAGGER_MS, GLIDE_MS, HIT_MS, noteRevealShown, REVEAL_BEAT_MS, takeResolutionEffects } from '../motion.ts';
import { EXIT_MOTIONS, LEAVING_GAP_ATTR, type Departure } from './departures.ts';
import {
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
    expect(diffViews(null, v)).toEqual({ life: [], damage: [], resolved: [], arrivals: [], hits: [], departures: [] });
  });

  it('a life change is reported for the player it happened to, and nobody else', () => {
    const before = view([player(0, 20), player(1, 20)]);
    const after = view([player(0, 17), player(1, 20)]);
    expect(diffViews(before, after)).toEqual({ life: [{ playerId: 0, from: 20, to: 17 }], damage: [], resolved: [], arrivals: [], hits: [], departures: [] });
  });

  it('a damage change on a creature still on a battlefield is reported, keyed by card id and owner', () => {
    const before = view([player(0, 20, { battlefield: [card(7, 0)] }), player(1, 20)]);
    const after = view([player(0, 20, { battlefield: [card(7, 1)] }), player(1, 20)]);
    expect(diffViews(before, after)).toEqual({ life: [], damage: [{ cardId: 7, ownerId: 0, from: 0, to: 1 }], resolved: [], arrivals: [], hits: [], departures: [] });
  });

  it('a creature that leaves the battlefield for a graveyard is a departure', () => {
    const before = view([player(0, 20, { battlefield: [card(7, 3)] }), player(1, 20)]);
    const after = view([player(0, 20, { battlefield: [], graveyard: [card(7, 3)] }), player(1, 20)]);
    expect(diffViews(before, after)).toEqual({ life: [], damage: [], resolved: [], arrivals: [], hits: [],
      departures: [{ cardId: 7, playerId: 0, to: 'graveyard', toPlayerId: 0, card: card(7, 3), index: 0 }] });
  });

  it('nothing moving at all diffs to nothing', () => {
    const v = view([player(0, 20, { battlefield: [card(7, 2)] }), player(1, 20)]);
    expect(diffViews(v, v)).toEqual({ life: [], damage: [], resolved: [], arrivals: [], hits: [], departures: [] });
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

  it('formatDelta signs a life change', () => {
    expect(formatDelta(3)).toBe('+3');
    expect(formatDelta(-3)).toBe('-3');
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

describe('installNumbers: a creature gets no number', () => {
  it('damage marked on a creature, or a creature dying with damage on it, draws no number — its hit is the impact (Forge’s own hits)', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20)]));
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 2)] }), player(1, 20)]));
    expect(overlay.querySelectorAll('.board-number'), 'damage marked: the badge shows it, nothing floats').toHaveLength(0);
    handle.notify(view([player(0, 20, { isViewer: true, graveyard: [card(7, 2)] }), player(1, 20)]));
    expect(overlay.querySelectorAll('.board-number'), 'it died: still no number').toHaveLength(0);
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
    expect(mark!.dataset.projectile, 'drawn as a bolt').toBe('bolt');
    expect(mark!.dataset.colour, 'an ability of a card the fixture gives no colour: colourless').toBe('C');
    // No Web Animations in jsdom: the ball is put where it lands, the face's centre (130, 50).
    expect(mark!.style.transform, 'aimed at the face').toBe('translate(130px, 50px) translate(-50%, -50%)');
    expect(overlay.querySelectorAll('.board-number'), 'no number before it lands').toHaveLength(0);
    expect(life.textContent, 'the counter still reads the old total').toBe('20');

    vi.advanceTimersByTime(HIT_MS);
    expect(overlay.querySelector('.effect-hit'), 'the mark is gone on landing').toBeNull();
    expect(face.hasAttribute('data-hit-flash'), 'the face flashes').toBe(true);
    expect(overlay.querySelector('.effect-impact'), 'and takes the impact').not.toBeNull();
    expect(overlay.querySelector('.board-number')?.textContent, 'a life total still shows its number').toBe('-2');
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
    expect(mark!.dataset.hit).toBe('player:1');
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

describe('diffViews: Forge’s own hits and what left the battlefield', () => {
  it('a view’s hits are the ones above the last seq already seen, on a card that was or is on a battlefield', () => {
    const before = { ...view([player(0, 20, { battlefield: [card(7, 0), card(9, 0)] }), player(1, 20)]), hits: [{ seq: 1, cardId: 7, sourceId: 40, amount: 2 }] };
    const after = {
      ...view([player(0, 20, { battlefield: [card(9, 0)], graveyard: [card(7, 0)] }), player(1, 20)]),
      hits: [
        { seq: 1, cardId: 7, sourceId: 40, amount: 2 },
        { seq: 2, cardId: 7, sourceId: 41, amount: 3 },
        { seq: 3, cardId: 9, sourceId: null, amount: 1 },
        { seq: 4, cardId: 99, sourceId: 41, amount: 1 },
      ],
    };
    expect(diffViews(before, after).hits.map((h) => h.seq), 'seq 1 was drawn already; card 99 was never on a battlefield').toEqual([2, 3]);
  });

  it('a permanent that left every battlefield is a departure, wherever it went; one that changed control is not', () => {
    const before = view([player(0, 20, { battlefield: [card(7, 0), card(8, 0), card(9, 0), card(10, 0)] }), player(1, 20)]);
    const after = view([
      { ...player(0, 20, { graveyard: [card(7, 0)] }), exile: [card(8, 0)] },
      player(1, 20, { battlefield: [card(10, 0)] }),
    ]);
    expect(diffViews(before, after).departures.map((d) => [d.cardId, d.to, d.toPlayerId, d.index])).toEqual([
      [7, 'graveyard', 0, 0],
      [8, 'exile', 0, 1],
      [9, 'gone', 0, 2],
    ]);
  });
});

describe('installNumbers: a sweeper (the operator’s Slagstorm, 2026-10-15)', () => {
  /** Two of my creatures, 7 and 9, and Slagstorm (item 40, card 131) drawn on the stack. */
  function sweeperBoard(): { canvas: HTMLElement; overlay: HTMLElement } {
    const { canvas } = board();
    const field = canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!;
    field.querySelector('[data-card-id="7"]')!.setAttribute('data-board-card', '7');
    field.insertAdjacentHTML('beforeend', '<li class="board-card" data-board-card="9" data-card-id="9"><span class="board-card__pt"></span></li>');
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    overlay.insertAdjacentHTML('beforeend', '<div data-placed-spell="40"></div>');
    overlay.querySelector<HTMLElement>('[data-placed-spell="40"]')!.getBoundingClientRect = () => rect({ left: 450, top: 350, width: 96, height: 134 });
    return { canvas, overlay };
  }

  /** What `Board.tsx` draws in the commit Forge's frame lands in: each creature's place kept as a gap. */
  function keepPlaces(canvas: HTMLElement): void {
    for (const [id, left] of [
      [7, 300],
      [9, 380],
    ] as const) {
      const gap = document.createElement('li');
      gap.className = 'zone__gap';
      gap.setAttribute(LEAVING_GAP_ATTR, String(id));
      gap.getBoundingClientRect = () => rect({ left, top: 400, width: 60, height: 84 });
      canvas.querySelector(`[data-board-card="${id}"]`)!.replaceWith(gap);
    }
  }

  const before = withStack(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0), card(9, 0)] }), player(1, 20)]), [
    { ...item(40, 131), isAbility: false, sourceCard: { ...card(131, 0).card, name: 'Slagstorm', colors: ['R'] } },
  ]);
  const after: BoardView = {
    ...view([player(0, 20, { isViewer: true, graveyard: [card(7, 0), card(9, 0)] }), player(1, 20)]),
    hits: [
      { seq: 1, cardId: 7, sourceId: 131, amount: 3 },
      { seq: 2, cardId: 9, sourceId: 131, amount: 3 },
    ],
  };

  it('a red fireball flies at once to each creature and slams into it (no number); each is destroyed the moment its own hit lands — and the spell fades only after', () => {
    vi.useFakeTimers();
    const { canvas, overlay } = sweeperBoard();
    const left: [Departure, number][] = [];
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false, leave: (d, ms) => left.push([d, ms]) });
    handle.notify(before);
    keepPlaces(canvas);
    const at = Date.now();
    handle.notify(after);

    const ball = overlay.querySelector<HTMLElement>('.effect-hit');
    expect(ball?.dataset.hit, 'the first fireball leaves the spell at once: no blink first').toBe('card:7:1');
    expect(ball?.dataset.colour, 'in Slagstorm’s colour').toBe('R');
    expect(left.map(([d, ms]) => [d.cardId, d.to, d.cause, ms]), 'each goes the moment its own fireball lands, killed by damage').toEqual([
      [7, 'graveyard', 'damage', HIT_MS],
      [9, 'graveyard', 'damage', BEAT_STAGGER_MS + HIT_MS],
    ]);
    expect(takeResolutionEffects(40), 'the spell fades once the last creature is gone').toBe(at + BEAT_STAGGER_MS + HIT_MS + EXIT_MOTIONS.crumple.ms);

    vi.advanceTimersByTime(HIT_MS);
    expect(canvas.querySelector(`[${LEAVING_GAP_ATTR}="7"]`)!.hasAttribute('data-hit-flash'), 'where it stands flashes').toBe(true);
    expect([...overlay.querySelectorAll<HTMLElement>('.effect-impact')].map((n) => [n.dataset.impact, n.dataset.colour]), 'it slams in').toEqual([['card:7:1', 'R']]);
    vi.advanceTimersByTime(BEAT_STAGGER_MS);
    expect([...overlay.querySelectorAll<HTMLElement>('.effect-impact')].map((n) => n.dataset.impact)).toEqual(['card:7:1', 'card:9:2']);
    expect(overlay.querySelector('.board-number'), 'no number on a creature: the impact is the hit').toBeNull();
    handle.dispose();
  });

  it('destroyed with no damage (no hits): the creatures go at once, while the spell waits on the stack', () => {
    vi.useFakeTimers();
    const { canvas } = sweeperBoard();
    const left: [number, number, string | undefined][] = [];
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false, leave: (d, ms) => left.push([d.cardId, ms, d.cause]) });
    handle.notify(before);
    keepPlaces(canvas);
    handle.notify({ ...after, hits: [] });
    expect(left, 'no cause: destroyed, so sliced').toEqual([
      [7, 0, undefined],
      [9, 0, undefined],
    ]);
    handle.dispose();
  });

  it('Fast Mode: nothing waits to leave', () => {
    vi.useFakeTimers();
    const { canvas, overlay } = sweeperBoard();
    const left: [number, number][] = [];
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => true, leave: (d, ms) => left.push([d.cardId, ms]) });
    handle.notify(before);
    keepPlaces(canvas);
    handle.notify(after);
    expect(overlay.querySelector<HTMLElement>('.effect-hit')?.dataset.hit, 'the first hit leaves at once').toBe('card:7:1');
    expect(left).toEqual([
      [7, 0],
      [9, 0],
    ]);
    handle.dispose();
  });
});

describe('installNumbers: combat damage', () => {
  it('a hit with nothing resolving is the impact alone, at the creature — no projectile, no number', () => {
    const { canvas } = board();
    canvas.querySelector('[data-card-id="7"]')!.setAttribute('data-board-card', '7');
    canvas.querySelector<HTMLElement>('[data-board-card="7"]')!.getBoundingClientRect = () => rect({ left: 300, top: 400, width: 60, height: 84 });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    const attacker = { ...card(50, 0), card: { ...card(50, 0).card, colors: ['G' as const] } };
    handle.notify(view([player(0, 20, { isViewer: true, battlefield: [card(7, 0)] }), player(1, 20, { battlefield: [attacker] })]));
    handle.notify({
      ...view([player(0, 20, { isViewer: true, battlefield: [card(7, 2)] }), player(1, 20, { battlefield: [attacker] })]),
      hits: [{ seq: 1, cardId: 7, sourceId: 50, amount: 2 }],
    });
    expect(overlay.querySelector('.effect-hit'), 'no fireball between creatures').toBeNull();
    expect(overlay.querySelector<HTMLElement>('.effect-impact')?.dataset.impact).toBe('card:7:1');
    expect(overlay.querySelector<HTMLElement>('.effect-impact')?.dataset.colour, 'in the attacker’s colour').toBe('G');
    expect(overlay.querySelector('.board-number')).toBeNull();
    handle.dispose();
  });
});
