// @vitest-environment jsdom
/*
 * The placed-cards layer (`placed.ts`): the seam functions, the DOM contract
 * `installPlaced` produces, and the two mutation points item 8 names —
 * dropping the arrow redraw on a move, and dropping the one-at-a-time flash.
 * Same device `numbers.test.ts` uses: jsdom gives every element a zero rect,
 * so `getBoundingClientRect` is stubbed with real numbers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardView, StackEntry } from '../adapter.ts';
import { GLIDE_MS, noteResolutionEffects, PLACEMENT_WAIT_MS, unlockAfter, whenBoardStill, whenBoardUnlocked } from '../motion.ts';
import {
  besideSource,
  clampToLane,
  defaultSpot,
  forgetPlacements,
  holdSpell,
  installPlaced,
  LEAVE_FADE_MS,
  onSpellMoved,
  placeSpell,
  releaseSpell,
  gripStackItem,
  type Rect,
  COUNTERED_MS,
  COUNTER_HOLD_MS,
  PLACED_PENDING_MS,
  STACK_HOVER_MAX,
  RESOLVE_BLINK_MS,
  setChainHalted,
  STACK_SETTLE_ATTR,
  SHIMMER_MS,
  scatter,
  settleStack,
  stackBoxOf,
  CHIP_DWELL_MS,
  DRAG_HOLD_MS,
  squareWidth,
  STACK_CORE,
  HOVER_REACH,
  onOwnClickable,
  setPeerClickable,
  slideCrosses,
} from './placed.ts';

/* ── fixtures ──────────────────────────────────────────────────────────── */

function draftCard(name: string): NonNullable<StackEntry['sourceCard']> {
  return {
    cardId: `c-${name}`,
    name,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: 'Instant',
    oracleText: `${name}'s rules text.`,
    setCode: 'TST',
    collectorNumber: '1',
    rarity: 'common',
  };
}

function stackItem(id: number, opts: Partial<StackEntry> = {}): StackEntry {
  return {
    id,
    description: opts.description ?? `stack item ${id}`,
    sourceCardId: opts.sourceCardId ?? 100 + id,
    sourceName: opts.sourceName ?? `Card ${id}`,
    sourceCard: 'sourceCard' in opts ? opts.sourceCard! : draftCard(`Card ${id}`),
    controllerName: opts.controllerName ?? 'Alice',
    isAbility: opts.isAbility ?? false,
    targetCardIds: opts.targetCardIds ?? [],
    targetPlayerIds: opts.targetPlayerIds ?? [],
    targetStackItemId: opts.targetStackItemId ?? null,
    ...(opts.triggeredByCardIds === undefined ? {} : { triggeredByCardIds: opts.triggeredByCardIds }),
    ...(opts.abilityText === undefined ? {} : { abilityText: opts.abilityText }),
    ...(opts.sourceHidden === undefined ? {} : { sourceHidden: opts.sourceHidden }),
  };
}

function battlefieldCard(id: number): NonNullable<BoardView['players']>[number]['battlefield'][number] {
  return { id, card: draftCard(`Card ${id}`), tapped: false, summoningSick: false, damage: 0, counters: [], attacking: false, blocking: false, token: false };
}

function view(stack: StackEntry[], battlefield: { id: number }[] = [], countered: readonly number[] = []): BoardView {
  return {
    seq: 1,
    title: 't',
    turn: 1,
    phase: null,
    phaseLabel: '',
    activePlayerId: null,
    players: [
      {
        id: 0,
        name: 'Alice',
        life: 20,
        isViewer: true,
        isActive: false,
        hasPriority: false,
        hasLost: false,
        hand: null,
        handCount: 0,
        libraryCount: 0,
        battlefield: battlefield.map((c) => battlefieldCard(c.id)),
        graveyard: [],
        exile: [],
      },
      { id: 1, name: 'Bob', life: 20, isViewer: false, isActive: false, hasPriority: false, hasLost: false, hand: null, handCount: 0, libraryCount: 0, battlefield: [], graveyard: [], exile: [] },
    ],
    stack,
    gameOver: false,
    missingCardIds: [],
    ...(countered.length === 0 ? {} : { counteredStackItems: new Set(countered) }),
  };
}

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

function board(): { canvas: HTMLElement } {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div data-testid="board-mid"></div>
      <div data-zone="battlefield" data-owner="you"><li class="board-card" data-board-card="201" data-card-id="201"></li></div>
      <div data-player-face data-player-id="0" data-viewer=""></div>
      <div data-player-face data-player-id="1"></div>
      <div class="board__overlay" data-board-overlay=""></div>
    </div>`;
  document.body.append(canvas);
  const boxes: Record<string, Box> = {
    '[data-board-overlay]': { left: 0, top: 0, width: 1000, height: 800 },
    '[data-testid="board-mid"]': { left: 700, top: 300, width: 200, height: 200 },
    '[data-card-id="201"]': { left: 100, top: 500, width: 80, height: 110 },
    '[data-player-face][data-player-id="0"]': { left: 20, top: 700, width: 60, height: 60 },
    '[data-player-face][data-player-id="1"]': { left: 20, top: 20, width: 60, height: 60 },
  };
  for (const [selector, box] of Object.entries(boxes)) canvas.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(box);
  return { canvas };
}

afterEach(() => {
  document.body.innerHTML = '';
  forgetPlacements();
  vi.useRealTimers();
});

/* ── placeSpell / gripStackItem / onSpellMoved ──────────── */

describe('the seam', () => {
  it('placeSpell then installPlaced draws a card at that point, centred', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el, 'promoted from the card id onto the stack item’s own id').not.toBeNull();
    expect(el.style.getPropertyValue('--placed-x')).toBe('400px');
    expect(el.style.getPropertyValue('--placed-y')).toBe('300px');
    expect(el.hasAttribute('data-mine'), 'side: "you"').toBe(true);
    expect(el.getAttribute('data-stack-id'), 'the one element every existing reader keys off').toBe('9');
    handle.dispose();
  });

  it('their spell is its face from its registration on — a later registration at the same point never leaves it a back', async () => {
    // The trailer's counter war (2026-10-28): every spell let go at one point, and the later ones of the
    // other seat stayed backs, because turning one over looked it up by where it was drawn.
    const { canvas } = board();
    const handle = installPlaced(canvas);
    placeSpell(301, { x: 200, y: 200 }, 'them');
    handle.notify(view([stackItem(7, { sourceCardId: 301 })]));
    placeSpell(302, { x: 200, y: 200 }, 'them');
    handle.notify(view([stackItem(9, { sourceCardId: 302 }), stackItem(7, { sourceCardId: 301 })]));
    for (const id of [7, 9]) {
      await vi.waitFor(() => expect(canvas.querySelector(`[data-placed-spell="${id}"] .card__name`)?.textContent).toBe(`Card ${id}`));
      expect(canvas.querySelector(`[data-placed-spell="${id}"] .card-back`)).toBeNull();
    }
    handle.dispose();
  });

  it('a card release never places a stack item that only shares its number: a land just played as card 37 and their spell that is stack item 37', () => {
    const { canvas } = board();
    // My land, released over my battlefield: card 37, which never reaches the stack.
    placeSpell(37, { x: 120, y: 600 }, 'you');
    const handle = installPlaced(canvas);
    // Their spell, card 90, is Forge's stack item 37.
    handle.notify(view([stackItem(37, { sourceCardId: 90 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="37"]')!;
    expect(el.hasAttribute('data-mine'), 'their spell is not mine to pick up').toBe(false);
    expect(el.style.getPropertyValue('--placed-y'), 'nor drawn over my land').not.toBe('600px');
    // Their release, when it arrives, is what places it.
    placeSpell(90, { x: 400, y: 200 }, 'them');
    expect(el.style.getPropertyValue('--placed-x')).toBe('400px');
    expect(el.style.getPropertyValue('--placed-y')).toBe('200px');
    handle.dispose();
  });

  it('onSpellMoved hears every move of this screen’s own hand, with its grip — never another seat’s, which came over the wire', () => {
    const heard: Array<[number, { x: number; y: number }, string]> = [];
    const unsub = onSpellMoved((id, at, grip) => heard.push([id, at, grip]));
    gripStackItem(5, 'you', { x: 0, y: 0 }, 'grab', 'you');
    gripStackItem(5, 'you', { x: 10, y: 20 }, 'move', 'you');
    gripStackItem(5, 'seat:1', { x: 1, y: 1 }, 'grab', 'you');
    gripStackItem(5, 'you', { x: 12, y: 22 }, 'drop', 'you');
    expect(heard).toEqual([
      [5, { x: 0, y: 0 }, 'grab'],
      [5, { x: 10, y: 20 }, 'move'],
      [5, { x: 12, y: 22 }, 'drop'],
    ]);
    unsub();
    gripStackItem(5, 'you', { x: 30, y: 40 }, 'grab', 'you');
    expect(heard, 'unsubscribed').toHaveLength(3);
  });

  describe('two hands on one stack item (the operator, 2026-11-02: "a funny interaction i dont want to kill")', () => {
    const drawnAt = (canvas: HTMLElement, id: number) => {
      const el = canvas.querySelector<HTMLElement>(`[data-placed-spell="${id}"]`)!;
      return { x: Number.parseFloat(el.style.getPropertyValue('--placed-x')), y: Number.parseFloat(el.style.getPropertyValue('--placed-y')) };
    };

    it('tug: it stands between the hands holding it, follows the one left when the other lets go, and the last to let go places it', () => {
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => true });
      handle.notify(view([stackItem(9)]));
      gripStackItem(9, 'you', { x: 200, y: 200 }, 'grab', 'you');
      gripStackItem(9, 'seat:1', { x: 400, y: 300 }, 'grab', 'you');
      expect(drawnAt(canvas, 9), 'between the two hands').toMatchObject({ x: 300, y: 250 });
      gripStackItem(9, 'you', { x: 100, y: 200 }, 'move', 'you');
      expect(drawnAt(canvas, 9).x, 'this hand pulls it its way').toBe(250);
      gripStackItem(9, 'you', { x: 100, y: 200 }, 'drop', 'you');
      expect(drawnAt(canvas, 9), 'the hand left has it').toMatchObject({ x: 400, y: 300 });
      gripStackItem(9, 'seat:1', { x: 420, y: 310 }, 'drop', 'you');
      expect(drawnAt(canvas, 9), 'placed where the last hand let go').toMatchObject({ x: 420, y: 310 });
      handle.dispose();
    });

    it('tug, eased: their hand eases from one relay to the next, so both pulling opposite ways never makes it jump back and forth', () => {
      vi.useFakeTimers();
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => false });
      handle.notify(view([stackItem(9)]));
      gripStackItem(9, 'you', { x: 300, y: 200 }, 'grab', 'you');
      gripStackItem(9, 'seat:1', { x: 300, y: 200 }, 'grab', 'you');
      // This hand moves left every pointer event (16 ms); theirs right as the relay sends it (every 60 ms), as fast.
      const xs: number[] = [];
      let mine = 300;
      let theirs = 300;
      for (let ms = 16; ms <= 960; ms += 16) {
        vi.advanceTimersByTime(16);
        mine -= 5;
        gripStackItem(9, 'you', { x: mine, y: 200 }, 'move', 'you');
        if (ms % 64 === 0) {
          theirs += 21;
          gripStackItem(9, 'seat:1', { x: theirs, y: 200 }, 'move', 'you');
        }
        xs.push(drawnAt(canvas, 9).x);
      }
      const steps = xs.slice(1).map((x, n) => x - xs[n]!);
      expect(Math.max(...steps.map(Math.abs)), 'never a step of more than a few pixels').toBeLessThan(4);
      // Back and forth by more than a pixel: the saw-tooth a stepping hand made.
      let turns = 0;
      for (let n = 1; n < steps.length; n++) if (Math.abs(steps[n]!) > 1 && Math.abs(steps[n - 1]!) > 1 && Math.sign(steps[n]!) !== Math.sign(steps[n - 1]!)) turns += 1;
      expect(turns, 'it never turns back while both pull').toBe(0);
      handle.dispose();
      vi.useRealTimers();
    });

    it('tug, eased: coarse steps from this hand and late relays from theirs still never turn it back by 6 px (claw run 41571386507: 7 turns)', () => {
      vi.useFakeTimers();
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => false });
      handle.notify(view([stackItem(9)]));
      gripStackItem(9, 'you', { x: 600, y: 200 }, 'grab', 'you');
      gripStackItem(9, 'seat:1', { x: 600, y: 200 }, 'grab', 'you');
      // This hand: 10 px every 35 ms (the spec's pull). Theirs steps the same way, its latest point relayed every 50–75 ms.
      const gaps = [60, 52, 75, 58, 66, 50, 71, 61];
      let mine = 600;
      let nextMine = 35;
      let nextTheirs = 60;
      let gap = 0;
      const xs: number[] = [];
      for (let ms = 0; ms <= 1400; ms += 1) {
        vi.advanceTimersByTime(1);
        if (ms === nextMine) {
          mine -= 10;
          nextMine += 35;
          gripStackItem(9, 'you', { x: mine, y: 200 }, 'move', 'you');
        }
        if (ms === nextTheirs) {
          // The server heard their grab first, so its order is theirs, then this hand's.
          gripStackItem(9, 'seat:1', { x: 600 + 10 * Math.floor(ms / 35), y: 200 }, 'move', 'you', ['seat:1', 'you']);
          nextTheirs += gaps[gap++ % gaps.length]!;
        }
        if (ms % 16 === 0) {
          handle.notify(view([stackItem(9)]));
          xs.push(drawnAt(canvas, 9).x);
        }
      }
      // The spec's own measure: a turn is a move of 6 px or more against the last one.
      let turns = 0;
      let dir = 0;
      let anchorX = xs[0]!;
      for (const x of xs) {
        if (Math.abs(x - anchorX) < 6) continue;
        const now = Math.sign(x - anchorX);
        if (dir !== 0 && now !== dir) turns += 1;
        dir = now;
        anchorX = x;
      }
      expect(turns, `it never turns back while both pull: ${xs.map(Math.round).join(' ')}`).toBe(0);
      handle.dispose();
      vi.useRealTimers();
    });

    it('their last let-go holds its point until it has glided there and stood DRAG_HOLD_MS: both screens show the same spot before it comes to rest', () => {
      vi.useFakeTimers();
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => false });
      handle.notify(view([stackItem(9)]));
      gripStackItem(9, 'you', { x: 200, y: 200 }, 'grab', 'you');
      gripStackItem(9, 'seat:1', { x: 400, y: 200 }, 'grab', 'you');
      vi.advanceTimersByTime(500);
      gripStackItem(9, 'you', { x: 200, y: 200 }, 'drop', 'you');
      vi.advanceTimersByTime(100);
      gripStackItem(9, 'seat:1', { x: 420, y: 210 }, 'drop', 'you');
      const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
      vi.advanceTimersByTime(GLIDE_MS + DRAG_HOLD_MS - 50);
      handle.notify(view([stackItem(9)]));
      expect(el.hasAttribute('data-placed-held'), 'still standing where it was let go').toBe(true);
      expect(drawnAt(canvas, 9)).toMatchObject({ x: 420, y: 210 });
      vi.advanceTimersByTime(100);
      handle.notify(view([stackItem(9)]));
      expect(el.hasAttribute('data-placed-held'), 'then it comes to rest like any card').toBe(false);
      handle.dispose();
      vi.useRealTimers();
    });

    it('a drag arms one timer to bring the item to rest, never one per paint (w69-perf on 8131301b5: 34 layouts a frame on the other screen)', () => {
      vi.useFakeTimers();
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => false });
      handle.notify(view([stackItem(9)]));
      const idle = vi.getTimerCount();
      gripStackItem(9, 'seat:1', { x: 300, y: 300 }, 'grab', 'you');
      // A second of their drag: a relay every 60 ms, a paint every frame in between.
      for (let ms = 16; ms <= 1000; ms += 16) {
        if (ms % 64 === 0) gripStackItem(9, 'seat:1', { x: 300 + ms / 4, y: 300 }, 'move', 'you');
        vi.advanceTimersByTime(16);
        handle.notify(view([stackItem(9)]));
      }
      expect(vi.getTimerCount() - idle, 'timers pending after a second of dragging').toBeLessThanOrEqual(3);
      handle.dispose();
      vi.useRealTimers();
    });

    it('tug, eased: when one hand lets go it moves on to the other over a moment, and both screens end where the last let go', () => {
      vi.useFakeTimers();
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => false });
      handle.notify(view([stackItem(9)]));
      gripStackItem(9, 'you', { x: 200, y: 200 }, 'grab', 'you');
      gripStackItem(9, 'seat:1', { x: 400, y: 200 }, 'grab', 'you');
      vi.advanceTimersByTime(400);
      gripStackItem(9, 'you', { x: 200, y: 200 }, 'move', 'you');
      expect(drawnAt(canvas, 9).x, 'between the hands').toBe(300);
      gripStackItem(9, 'you', { x: 200, y: 200 }, 'drop', 'you');
      expect(drawnAt(canvas, 9).x, 'not a step to their hand').toBe(300);
      vi.advanceTimersByTime(100);
      gripStackItem(9, 'seat:1', { x: 400, y: 200 }, 'move', 'you');
      const mid = drawnAt(canvas, 9).x;
      expect(mid, 'on its way').toBeGreaterThan(300);
      expect(mid).toBeLessThan(400);
      vi.advanceTimersByTime(400);
      gripStackItem(9, 'seat:1', { x: 420, y: 210 }, 'drop', 'you');
      vi.advanceTimersByTime(400);
      handle.notify(view([stackItem(9)]));
      expect(drawnAt(canvas, 9), 'where the last hand let go').toMatchObject({ x: 420, y: 210 });
      handle.dispose();
      vi.useRealTimers();
    });

    it('a hand the server no longer names is off the item (a seat whose socket went), and one it names that this screen never heard take hold is on it', () => {
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => true });
      handle.notify(view([stackItem(9)]));
      gripStackItem(9, 'you', { x: 200, y: 200 }, 'grab', 'you');
      // Their grab was lost behind a move: the server's word puts their hand on it all the same.
      gripStackItem(9, 'seat:1', { x: 400, y: 300 }, 'move', 'you', ['you', 'seat:1']);
      expect(drawnAt(canvas, 9), 'between the two hands').toMatchObject({ x: 300, y: 250 });
      // Their socket went: the server lets their hand go where it last was.
      gripStackItem(9, 'seat:1', { x: 400, y: 300 }, 'drop', 'you', ['you']);
      expect(drawnAt(canvas, 9), 'their hand is off it: this one has it').toMatchObject({ x: 200, y: 200 });
      handle.dispose();
    });

    it('a move from a hand that holds nothing (a joiner’s replay) is a point of its own, drawn in place', () => {
      const { canvas } = board();
      const handle = installPlaced(canvas, { reducedMotion: () => true });
      handle.notify(view([stackItem(9)]));
      gripStackItem(9, 'seat:1', { x: 330, y: 400 }, 'move', 'them');
      expect(drawnAt(canvas, 9)).toEqual({ x: 330, y: 400 });
      handle.dispose();
    });
  });

  it('a card released again waits its own PLACEMENT_WAIT_MS for its stack item, not what is left of an earlier release that never matched', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const handle = installPlaced(canvas);
    // Played once and never cast (back to the hand, a cancelled aim): its release is still waiting.
    placeSpell(301, { x: 100, y: 100 }, 'you');
    handle.notify(view([]));
    vi.advanceTimersByTime(PLACEMENT_WAIT_MS - 1000);
    // Played again: let go here, and moved into its gap a frame later.
    placeSpell(301, { x: 400, y: 300 }, 'you');
    placeSpell(301, { x: 530, y: 322 }, 'you');
    vi.advanceTimersByTime(2000);
    handle.notify(view([])); // the card left the hand; its spell is not on the stack yet
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect([el.style.getPropertyValue('--placed-x'), el.style.getPropertyValue('--placed-y')], 'drawn where it was put this time').toEqual(['530px', '322px']);
    expect(el.hasAttribute('data-placed-pending'), 'its registration arrived with it').toBe(false);
    handle.dispose();
  });
});

/* ── the DOM contract ──────────────────────────────────────────────────── */

describe('installPlaced: drawing', () => {
  it('a click cast (nothing registered) lands at the default spot — the old stack band’s own centre', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9)]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    const spot = defaultSpot(canvas)!;
    expect(el.style.getPropertyValue('--placed-x')).toBe(`${spot.x}px`);
    expect(el.style.getPropertyValue('--placed-y')).toBe(`${spot.y}px`);
    expect(el.hasAttribute('data-mine'), 'nobody ever claimed it').toBe(false);
    handle.dispose();
  });

  it('portrait (Settled 2): board-mid is display:none (a collapsed box), so the default spot follows the stack chip instead', () => {
    const { canvas } = board();
    const mid = canvas.querySelector<HTMLElement>('[data-testid="board-mid"]')!;
    mid.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 0, height: 0 });
    const chip = document.createElement('div');
    chip.setAttribute('data-testid', 'stack-chip');
    chip.getBoundingClientRect = () => rect({ left: 180, top: 10, width: 30, height: 30 });
    canvas.querySelector('.board')!.append(chip);
    expect(defaultSpot(canvas)).toEqual({ x: 195, y: 25 });
  });

  it('portrait with no stack chip either (not yet rendered): falls back to the board’s own centre rather than null', () => {
    const { canvas } = board();
    const mid = canvas.querySelector<HTMLElement>('[data-testid="board-mid"]')!;
    mid.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 0, height: 0 });
    canvas.querySelector<HTMLElement>('.board')!.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 390, height: 844 });
    expect(defaultSpot(canvas)).toEqual({ x: 195, y: 422 });
  });

  it('the board-centre fallback still finds it when `canvas` IS `.board` itself — Board.tsx’s own shape, not this file’s wrapper-div fixture', () => {
    // A regression this exact shape caught: `Board.test.ts`'s "a spell on the stack is selectable by
    // its card id" started failing silently (data-selectable never set — `want` fell to null,
    // skipping the whole per-item update) the moment `defaultSpot`'s board-centre fallback used
    // `canvas.querySelector('.board')`, which searches `canvas`'s DESCENDANTS: fine for this file's
    // own `board()` fixture (a wrapper div around `.board`), null for `installPlaced(root.current, …)`
    // in production, where `canvas` already IS the `.board` element and so is never its own descendant.
    const el = document.createElement('div');
    el.className = 'board';
    el.innerHTML = '<div data-testid="board-mid"></div>';
    document.body.append(el);
    el.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 390, height: 844 });
    expect(defaultSpot(el)).toEqual({ x: 195, y: 422 });
    el.remove();
  });

  it('an unregistered spell is drawn hidden for PLACED_PENDING_MS; a registration inside the window draws it AT the point (AE26)', async () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(5, { sourceCardId: 48 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="5"]');
    expect(el, 'drawn at once').not.toBeNull();
    expect(el!.hasAttribute('data-placed-pending'), 'but not shown yet').toBe(true);
    placeSpell(48, { x: 400, y: 320 }, 'them');
    expect(el!.hasAttribute('data-placed-pending'), 'the registration shows it').toBe(false);
    expect(el!.querySelector('.placed__back'), 'as its face, at the point').toBeNull();
    expect(el!.style.getPropertyValue('--placed-x')).toBe('400px');
    expect(el!.style.getPropertyValue('--placed-y')).toBe('320px');
    handle.dispose();
  });

  it('an unregistered spell with no registration shows at the default spot once the window closes (a click cast)', async () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(6, { sourceCardId: 49 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="6"]')!;
    expect(el.hasAttribute('data-placed-pending')).toBe(true);
    await new Promise((r) => setTimeout(r, PLACED_PENDING_MS + 40));
    expect(el.hasAttribute('data-placed-pending'), 'shown at the default spot').toBe(false);
    handle.dispose();
  });

  it('a held spell (their back still gliding to its point) stays hidden past the window until the point arrives, or the hold is let go (w67-shaman)', async () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    holdSpell(50);
    handle.notify(view([stackItem(7, { sourceCardId: 50 }), stackItem(8, { sourceCardId: 51 })]));
    holdSpell(51);
    await new Promise((r) => setTimeout(r, PLACED_PENDING_MS + 40));
    const held = canvas.querySelector<HTMLElement>('[data-placed-spell="7"]')!;
    const letGo = canvas.querySelector<HTMLElement>('[data-placed-spell="8"]')!;
    expect(held.hasAttribute('data-placed-pending'), 'never at the default spot while its point is coming').toBe(true);
    expect(letGo.hasAttribute('data-placed-pending')).toBe(true);
    placeSpell(50, { x: 400, y: 320 }, 'them');
    expect(held.hasAttribute('data-placed-pending'), 'shown at its point').toBe(false);
    expect(held.style.getPropertyValue('--placed-x')).toBe('400px');
    releaseSpell(51);
    expect(letGo.hasAttribute('data-placed-pending'), 'let go: drawn like any other').toBe(false);
    handle.dispose();
  });

  it('my own spell, registered at its release, stays hidden while its stand-in glides on, and shows the moment the hold is let go', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    placeSpell(52, { x: 410, y: 330 }, 'you');
    holdSpell(52);
    handle.notify(view([stackItem(9, { sourceCardId: 52 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.hasAttribute('data-placed-pending'), 'its stand-in is still what is drawn').toBe(true);
    expect(el.style.getPropertyValue('--placed-x'), 'already where the stand-in comes to rest').toBe('410px');
    releaseSpell(52);
    expect(el.hasAttribute('data-placed-pending'), 'shown in the same task the stand-in goes').toBe(false);
    handle.dispose();
  });

  it('their face-down spell is the hidden card’s own back — a card the inspector enlarges, never a face or a text tile', async () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    const hidden = { ...draftCard('Hidden card'), cardId: 'w61' };
    placeSpell(61, { x: 400, y: 320 }, 'them');
    handle.notify(view([stackItem(4, { sourceCardId: 61, sourceCard: hidden, sourceName: 'Hidden card', sourceHidden: true, controllerName: 'Bob' })]));
    await vi.waitFor(() => expect(canvas.querySelector('[data-placed-spell="4"] [data-card-back]')).not.toBeNull());
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="4"]')!;
    const back = el.querySelector<HTMLElement>('[data-card-back]');
    expect(back, 'a back').not.toBeNull();
    expect(back!.classList.contains('card'), 'the hidden card’s own, which the inspector enlarges').toBe(true);
    expect(back!.getAttribute('data-card-id')).toBe('w61');
    expect(back!.getAttribute('aria-label')).toBe('Hidden card');
    expect(el.querySelector('.card__name'), 'no face').toBeNull();
    expect(el.querySelector('.placed__text'), 'no text tile').toBeNull();
    handle.dispose();
  });

  it('their click-cast (no registration) stays a back until its art is decoded, then turns over; my own is a face at once', async () => {
    // The operator, 2026-10-09: "i really dont want a no-art card to show ever".
    const decodes: { src: string; settle: () => void }[] = [];
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        fetchPriority = 'auto';
        decode(): Promise<void> {
          return new Promise((resolve) => decodes.push({ src: this.src, settle: resolve }));
        }
      },
    );
    const { canvas } = board();
    const handle = installPlaced(canvas);
    try {
      const card = { ...draftCard('Think Twice'), scryfallId: 'aaaaaaaa-0000-4000-8000-00000000c1a5' };
      handle.notify(view([stackItem(7, { sourceCard: card, controllerName: 'Bob' }), stackItem(8, { sourceCard: { ...card, scryfallId: 'aaaaaaaa-0000-4000-8000-0000000000e8' } })]));
      const theirs = canvas.querySelector<HTMLElement>('[data-placed-spell="7"]')!;
      const mine = canvas.querySelector<HTMLElement>('[data-placed-spell="8"]')!;
      expect(theirs.querySelector('.placed__back'), 'their face waits for its art as a back').not.toBeNull();
      expect(theirs.querySelector('.card'), 'no face without its art').toBeNull();
      expect(mine.querySelector('.placed__back'), 'my own click-cast is never a back').toBeNull();
      expect(decodes.map((d) => d.src)).toHaveLength(1);
      decodes[0]!.settle();
      // The decode settles, the flip remounts, and the fresh React root commits on its scheduler's own
      // turn — how many macrotasks that is depends on where in the event loop the test began.
      await vi.waitFor(() => expect(theirs.querySelector('.card__name')?.textContent).toBe('Think Twice'));
      expect(theirs.querySelector('.placed__back'), 'turned over once decoded').toBeNull();
    } finally {
      handle.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('an ability draws beside its source when the source is on the board, never a row', () => {
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { isAbility: true, sourceCardId: 201 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    // The source's own box is left:100 top:500 width:80 height:110 — beside it is to its right.
    expect(Number.parseFloat(el.style.getPropertyValue('--placed-x'))).toBeGreaterThan(180);
    // Nudged by its own `scatter`, never by more than a quarter of its height.
    expect(Math.abs(Number.parseFloat(el.style.getPropertyValue('--placed-y')) - 555)).toBeLessThanOrEqual(110 / 4);
    handle.dispose();
  });

  describe('a chip keeps clear of the cards the viewer can click (the operator, 2026-11-02)', () => {
    /** Board 201 (the source) with 202 just to its right, every placed element laid out `size` square at its own left/top. */
    function laidOut(): { canvas: HTMLElement; chipBox: (id: number) => Rect; cardBox: Rect } {
      const { canvas } = board();
      const you = canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!;
      you.insertAdjacentHTML('beforeend', '<li class="board-card" data-board-card="202" data-card-id="202"></li>');
      const box = { left: 190, top: 500, width: 80, height: 110 };
      canvas.querySelector<HTMLElement>('[data-card-id="202"]')!.getBoundingClientRect = () => rect(box);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-placed-spell') ? 100 : 0;
      });
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-placed-spell') ? 100 : 0;
      });
      const chipBox = (id: number): Rect => {
        const el = canvas.querySelector<HTMLElement>(`[data-placed-spell="${id}"]`)!;
        const x = Number.parseFloat(el.style.getPropertyValue('--placed-x'));
        const y = Number.parseFloat(el.style.getPropertyValue('--placed-y'));
        return { left: x - 50, top: y - 50, right: x + 50, bottom: y + 50 };
      };
      return { canvas, chipBox, cardBox: { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height } };
    }
    const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const clickableNow = (ids: readonly number[]) => ({ isSelectable: (id: number) => ids.includes(id), onSelect: () => undefined });
    afterEach(() => vi.restoreAllMocks());

    it('drawn clear of a clickable card from its first frame, where beside its source would cover it', () => {
      const { canvas, chipBox, cardBox } = laidOut();
      setChainHalted(true);
      const handle = installPlaced(canvas, { reducedMotion: () => true });
      const field = [{ id: 201 }, { id: 202 }];
      const trigger = stackItem(9, { isAbility: true, sourceCardId: 201 });
      handle.notify(view([], field), clickableNow([202]));
      handle.notify(view([trigger], field), clickableNow([202]));
      expect(overlaps(chipBox(9), cardBox), `first frame clear of 202 (${JSON.stringify(chipBox(9))})`).toBe(false);
      handle.notify(view([trigger], field), clickableNow([202]));
      expect(overlaps(chipBox(9), cardBox), 'and settled clear of it').toBe(false);
      handle.dispose();
    });

    it('a card only the other seat can click is kept clear too (the operator, 2026-11-02: "avoid blocking the opponents playable cards"); this board tells its own once per change', () => {
      const { canvas, chipBox, cardBox } = laidOut();
      setChainHalted(true);
      const told: number[][] = [];
      const stop = onOwnClickable((cards) => told.push([...cards]));
      const handle = installPlaced(canvas, { reducedMotion: () => true });
      const field = [{ id: 201 }, { id: 202 }];
      const trigger = stackItem(9, { isAbility: true, sourceCardId: 201 });
      setPeerClickable(1, [202]);
      handle.notify(view([trigger], field), clickableNow([201]));
      handle.notify(view([trigger], field), clickableNow([201]));
      expect(overlaps(chipBox(9), cardBox), `clear of what the other seat can click (${JSON.stringify(chipBox(9))})`).toBe(false);
      expect(told, 'this board’s own clickable cards, told once').toEqual([[201]]);
      handle.notify(view([trigger], field), clickableNow([]));
      expect(told.at(-1), 'and again when they change').toEqual([]);
      stop();
      handle.dispose();
    });

    it('a card that stops being clickable keeps the chips off it for the rest of the turn; a new turn forgets it', () => {
      const { canvas, chipBox, cardBox } = laidOut();
      setChainHalted(true);
      const handle = installPlaced(canvas, { reducedMotion: () => true });
      const field = [{ id: 201 }, { id: 202 }];
      const trigger = stackItem(9, { isAbility: true, sourceCardId: 201 });
      handle.notify(view([trigger], field), clickableNow([202]));
      handle.notify(view([trigger], field), clickableNow([202]));
      const clear = chipBox(9);
      handle.notify(view([trigger], field), clickableNow([]));
      expect(chipBox(9), 'the next prompt offers nothing: the chip stays put').toEqual(clear);
      handle.notify({ ...view([trigger], field), turn: 2 }, clickableNow([]));
      expect(overlaps(chipBox(9), cardBox), 'next turn, back beside its source').toBe(true);
      handle.dispose();
    });
  });

  it('AE29: an ability is the chip — the source\'s name and art band over the ability\'s own text, never a second card face', async () => {
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    handle.notify(
      view([
        stackItem(9, {
          isAbility: true,
          sourceCardId: 201,
          sourceName: 'Eternal Witness',
          description: 'When it enters, return target card. (Targeting: [[Lightning Bolt (12)]])',
          abilityText: 'When it enters, return target card.',
        }),
      ]),
    );
    // A fresh React root commits on its own clock (see the flip test above).
    await vi.waitFor(() => expect(canvas.querySelector('[data-placed-spell="9"] [data-ability-chip]')).not.toBeNull());
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.querySelector('[data-ability-chip]'), 'the chip').not.toBeNull();
    expect(el.querySelector('.card'), 'no card face').toBeNull();
    expect(el.querySelector('.placed__chip-name')!.textContent).toBe('Eternal Witness');
    expect(el.querySelector('.placed__chip-text')!.textContent, 'the ability\'s own text, never the stack instance\'s notes').toBe('When it enters, return target card.');
    handle.dispose();
  });

  it('a chip\'s art band credits its illustrator and copyright, and shows no art it cannot credit', async () => {
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    const credited = { ...draftCard('Descendant of Storms'), scryfallId: 'f632be90-9e7f-41f8-a52e-a2952354d730' };
    const unknown = { ...draftCard('Nobody'), scryfallId: '00000000-0000-4000-8000-000000000000' };
    handle.notify(view([stackItem(9, { isAbility: true, sourceCard: credited }), stackItem(10, { isAbility: true, sourceCard: unknown })]));
    const chip = (id: number) => canvas.querySelector<HTMLElement>(`[data-placed-spell="${id}"]`)!;
    await vi.waitFor(() => expect(chip(9).querySelector('.placed__chip-credit')).not.toBeNull());
    expect(chip(9).querySelector('.placed__chip-credit')!.textContent).toBe('Illus. Lie Setiawan · ™ & © WotC');
    expect(chip(9).querySelector('img.placed__chip-art'), 'credited, so drawn').not.toBeNull();
    expect(chip(10).querySelector('img'), 'no artist on record: no art').toBeNull();
    expect(chip(10).querySelector('.placed__chip-name')!.textContent, 'the band still names its source').toBe('Card 10');
    handle.dispose();
  });

  it('their ability, dragged by them, moves without ever turning over or being rebuilt — it hides no card', async () => {
    // The operator, 2026-10-10: "moving around ability chips is weirdly visually laggy … only see from
    // the opponents view." Their first move registers the chip here (`presence.ts`'s `onPlaced`:
    // `gripStackItem(…, 'seat:1', …)`), which used to flip it to a back and back again.
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(8, { isAbility: true, sourceCardId: 202, controllerName: 'Bob', sourceName: 'Eternal Witness' })]));
    await vi.waitFor(() => expect(canvas.querySelector('[data-placed-spell="8"] [data-ability-chip]')).not.toBeNull());
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="8"]')!;
    const chip = el.querySelector('[data-ability-chip]');
    expect(chip).not.toBeNull();
    for (const x of [300, 310, 320]) {
      gripStackItem(8, 'seat:1', { x, y: 400 }, x === 300 ? 'grab' : 'move', 'them');
      expect(el.querySelector('.placed__back'), 'never a back').toBeNull();
    }
    // A point that is not a drag (a joiner's replay: a move from a hand that holds nothing) is drawn in place.
    gripStackItem(8, 'seat:1', { x: 315, y: 400 }, 'drop', 'them');
    gripStackItem(8, 'seat:1', { x: 330, y: 400 }, 'move', 'them');
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('[data-ability-chip]'), 'the same chip element, never rebuilt').toBe(chip);
    expect(el.style.getPropertyValue('--placed-x')).toBe('330px');
    handle.dispose();
  });

  it('chips are read in one pass and written in the next: a layout for the stack, never one per chip', () => {
    const { canvas } = board();
    setChainHalted(true);
    const styles = Object.getPrototypeOf(document.createElement('div').style) as object;
    const left = Object.getOwnPropertyDescriptor(styles, 'left')!;
    const read = Element.prototype.getBoundingClientRect;
    let log: ('read' | 'write')[] = [];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      log.push('read');
      return read.call(this);
    });
    for (const el of canvas.querySelectorAll<HTMLElement>('*')) {
      const own = el.getBoundingClientRect;
      if (own !== read) el.getBoundingClientRect = () => (log.push('read'), own.call(el));
    }
    Object.defineProperty(styles, 'left', {
      ...left,
      set(this: CSSStyleDeclaration, v: string) {
        log.push('write');
        left.set!.call(this, v);
      },
    });
    /** How many times a read came after a write: each one lays the page out again. */
    const layouts = (n: number): number => {
      const handle = installPlaced(canvas);
      log = [];
      handle.notify(view(Array.from({ length: n }, (_, i) => stackItem(90 + i, { isAbility: true, sourceCardId: 201 }))));
      handle.dispose();
      return log.filter((e, i) => e === 'read' && log[i - 1] === 'write').length;
    };
    try {
      expect(layouts(4), 'four chips lay out as often as one').toBe(layouts(1));
    } finally {
      Object.defineProperty(styles, 'left', left);
      vi.restoreAllMocks();
    }
  });

  it('AE28: the viewer\'s own ability is theirs to drag (data-mine) though nothing placed it; the opponent\'s is not', () => {
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { isAbility: true, sourceCardId: 201, controllerName: 'Alice' }), stackItem(8, { isAbility: true, sourceCardId: 202, controllerName: 'Bob' })]));
    expect(canvas.querySelector('[data-placed-spell="9"]')!.hasAttribute('data-mine')).toBe(true);
    expect(canvas.querySelector('[data-placed-spell="8"]')!.hasAttribute('data-mine')).toBe(false);
    handle.dispose();
  });

  it('besideSource places a chip by its own drawn width, and on the source\'s left when its right is off the board', () => {
    const sourceBox: Rect = { left: 100, top: 500, right: 180, bottom: 610 };
    const wide = { width: 240, height: 90 };
    const bounds: Rect = { left: 0, top: 0, right: 1000, bottom: 800 };
    expect(besideSource(sourceBox, wide, bounds), 'clear of the source by its own half-width, on its row').toEqual({ x: 180 + 6 + 120, y: 555 });
    const nearEdge: Rect = { left: 800, top: 500, right: 880, bottom: 610 };
    expect(besideSource(nearEdge, wide, bounds).x, 'no room on the right: on the left').toBe(800 - 6 - 120);
    const narrow: Rect = { left: 0, top: 0, right: 300, bottom: 800 };
    const squeezed = besideSource({ left: 100, top: 500, right: 180, bottom: 610 }, wide, narrow);
    expect(squeezed.x - 120, 'room on neither side: inside the board').toBeGreaterThanOrEqual(6);
    expect(squeezed.x + 120).toBeLessThanOrEqual(300 - 6);
  });

  it('scatter: the same nudge for the same id on every call, different ones for different ids, never past a fifth of the width or a quarter of the height', () => {
    const tile = { width: 200, height: 100 };
    expect(scatter(-41, tile)).toEqual(scatter(-41, tile));
    const nudges = [-41, -42, -43, 7, 8].map((id) => scatter(id, tile));
    expect(new Set(nudges.map((n) => `${n.dx},${n.dy}`)).size).toBe(nudges.length);
    for (const n of nudges) {
      expect(Math.abs(n.dx)).toBeLessThanOrEqual(40);
      expect(Math.abs(n.dy)).toBeLessThanOrEqual(25);
    }
  });

  it('waiting triggers are chips already, the one asked about marked; the stack item takes over its chip where it stands', () => {
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    const waiting = (id: number, current = false): StackEntry => ({ ...stackItem(id, { isAbility: true, sourceCardId: 201 }), pending: true, ...(current ? { current: true as const } : {}) });
    handle.notify({ ...view([]), pendingTriggers: [waiting(-11, true), waiting(-12), waiting(-13)] });
    const chips = [...canvas.querySelectorAll<HTMLElement>('[data-placed-spell]')];
    expect(chips.map((c) => c.getAttribute('data-placed-spell'))).toEqual(['-11', '-12', '-13']);
    expect(chips.every((c) => c.hasAttribute('data-placed-waiting')), 'all three waiting').toBe(true);
    expect(canvas.querySelectorAll('[data-placed-current]')).toHaveLength(1);
    expect(canvas.querySelector('[data-placed-current]')!.getAttribute('data-placed-spell')).toBe('-11');
    expect(canvas.querySelector('[data-placed-next]'), 'nothing waiting is next to resolve').toBeNull();
    const at = { left: chips[0]!.style.getPropertyValue('--placed-x'), top: chips[0]!.style.getPropertyValue('--placed-y') };
    expect(new Set(chips.map((c) => `${c.style.getPropertyValue('--placed-x')},${c.style.getPropertyValue('--placed-y')}`)).size, 'three spots').toBe(3);

    handle.notify({ ...view([stackItem(40, { isAbility: true, sourceCardId: 201 })]), pendingTriggers: [waiting(-12, true), waiting(-13)] });
    const onStack = canvas.querySelector<HTMLElement>('[data-placed-spell="40"]')!;
    expect(onStack, 'the very element the asked-about trigger was drawn as').toBe(chips[0]);
    expect({ left: onStack.style.getPropertyValue('--placed-x'), top: onStack.style.getPropertyValue('--placed-y') }, 'where it stood').toEqual(at);
    expect(onStack.hasAttribute('data-placed-waiting')).toBe(false);
    expect(onStack.hasAttribute('data-placed-next')).toBe(true);
    expect(canvas.querySelector('[data-placed-spell="-11"]')).toBeNull();
    expect(canvas.querySelector('[data-placed-current]')!.getAttribute('data-placed-spell')).toBe('-12');
    handle.dispose();
  });

  it('squareWidth: the width whose height is that width, held between one card and the cap', () => {
    const w = squareWidth(12_000, 54, 14, 60, 300);
    expect(w, 'square: h(w) = fixed + area / text width').toBeCloseTo(54 + 12_000 / (w - 14), 6);
    expect(squareWidth(300, 54, 14, 80, 300), 'a short text: never narrower than a card').toBe(80);
    expect(squareWidth(200_000, 54, 14, 80, 240), 'a very long one: never wider than the cap').toBe(240);
    expect(squareWidth(12_000, 54, 14, 80, 40), 'a cap under a card is a card').toBe(80);
  });

  /** The layout sizes `squareChips` reads (jsdom lays nothing out): a chip `widthOf` wide, its text wrapping to `textHeight`. */
  function chipLayout(widthOf: (el: HTMLElement) => number, textHeight: (w: number) => number, band: number, measured?: () => void): { restore: () => void } {
    const chipOf = (el: HTMLElement): HTMLElement | null => {
      const placed = el.closest<HTMLElement>('[data-placed-spell]');
      return placed?.querySelector('.placed__chip-text') ? placed : null;
    };
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      const chip = chipOf(this);
      return chip === null || !(this === chip || this.classList.contains('placed__chip-text')) ? 0 : widthOf(chip);
    });
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const chip = chipOf(this);
      if (chip === null) return 0;
      if (this.classList.contains('placed__chip-text')) {
        measured?.();
        return textHeight(widthOf(chip));
      }
      return this === chip ? band + textHeight(widthOf(chip)) : 0;
    });
    return { restore: () => (width.mockRestore(), height.mockRestore()) };
  }

  it('an ability’s chip is squared once from its text’s measured area — again only when the card width changes; a spell never', async () => {
    const { canvas } = board();
    canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!.insertAdjacentHTML('beforeend', '<ul class="zone__cards"></ul>');
    let card = 80;
    const AREA = 14_000; // the text's laid-out area: ~12 px lines at any width
    const BAND = 42;
    let measures = 0;
    const widthOf = (el: HTMLElement): number => Number.parseFloat(el.style.width) || card;
    const textHeight = (w: number): number => Math.ceil(AREA / w / 12) * 12;
    const original = HTMLElement.prototype.getBoundingClientRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('li.board-card:not([data-card-id])')) return rect({ left: 0, top: 0, width: card, height: card * 1.4 });
      const placed = this.closest<HTMLElement>('[data-placed-spell]');
      if (placed === null) return original.call(this);
      const w = widthOf(placed);
      if (this.classList.contains('placed__chip-text')) return rect({ left: 0, top: 0, width: w, height: textHeight(w) });
      return rect({ left: 0, top: 0, width: w, height: placed.querySelector('.placed__chip-text') === null ? w * 1.4 : BAND + textHeight(w) });
    });
    const layout = chipLayout(widthOf, textHeight, BAND, () => (measures += 1));
    setChainHalted(true);
    const handle = installPlaced(canvas);
    const stack = [stackItem(9, { isAbility: true, sourceCardId: 201, description: 'Card 201 - When it enters, draw a card.' }), stackItem(8)];
    handle.notify(view(stack, [{ id: 201 }]));
    const chip = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(chip.style.width, 'nothing to measure before its text has rendered').toBe('');
    expect(chip.hasAttribute('data-placed-pending'), 'hidden until it has its own size: it is first shown at the size it keeps').toBe(true);
    // A fresh React root commits on its own clock; the chip's own resize redraws it then (the ResizeObserver jsdom lacks).
    await vi.waitFor(() => expect(chip.querySelector('.placed__chip-text')?.textContent).toBeTruthy());
    handle.notify(view(stack, [{ id: 201 }]));
    await vi.waitFor(() => expect(chip.hasAttribute('data-placed-pending'), 'shown the frame after it is squared').toBe(false));
    const w = widthOf(chip);
    const h = BAND + textHeight(w);
    expect(w / h, `near square (${w}×${h})`).toBeGreaterThan(0.75);
    expect(w / h, `near square (${w}×${h})`).toBeLessThan(1.33);
    expect(measures, 'one measure at a card’s width, and corrections until the width holds').toBeLessThanOrEqual(4);
    expect(canvas.querySelector<HTMLElement>('[data-placed-spell="8"]')!.style.width, 'a spell is a card, never squared').toBe('');

    const before = measures;
    handle.notify(view(stack, [{ id: 201 }]));
    expect(measures, 'a repaint with nothing changed measures nothing').toBe(before);
    card = 100;
    handle.notify(view(stack, [{ id: 201 }]));
    expect(measures, 'a new card width squares it again').toBeGreaterThan(before);
    expect(widthOf(chip), 'never narrower than the new card').toBeGreaterThanOrEqual(100);
    handle.dispose();
    spy.mockRestore();
    layout.restore();
  });

  it('an ability’s chip has one shape per card width and text, whatever width it was squared from: a resize squares it as a fresh draw does', async () => {
    // w69-chip-shape at 1920 (run 43301221680): both screens' chips 115 px tall, one 124 px wide and the other 119. The
    // squaring measured the text where the chip stood and stopped after two passes, so the shape followed the chip's
    // history: a screen that squared it once more on the way (a resize's in-between card width) kept another one.
    const AREA = 14_000;
    const BAND = 42;
    const squaredAt = async (widths: readonly number[], sway = 0): Promise<number> => {
      const { canvas } = board();
      canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!.insertAdjacentHTML('beforeend', '<ul class="zone__cards"></ul>');
      let card = widths[0]!;
      const widthOf = (el: HTMLElement): number => Number.parseFloat(el.style.width) || card;
      const textHeight = (w: number): number => Math.ceil(AREA / w / 12) * 12;
      const original = HTMLElement.prototype.getBoundingClientRect;
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.matches('li.board-card:not([data-card-id])')) return rect({ left: 0, top: 0, width: card, height: card * 1.4 });
        const placed = this.closest<HTMLElement>('[data-placed-spell]');
        if (placed === null) return original.call(this);
        // The box a hovering chip's transform draws: a little off its layout, differently on each screen.
        const w = widthOf(placed) + sway;
        if (this.classList.contains('placed__chip-text')) return rect({ left: 0, top: 0, width: w, height: textHeight(w) + sway });
        return rect({ left: 0, top: 0, width: w, height: placed.querySelector('.placed__chip-text') === null ? w * 1.4 : BAND + textHeight(w) + sway });
      });
      const layout = chipLayout(widthOf, textHeight, BAND);
      setChainHalted(true);
      const handle = installPlaced(canvas);
      const stack = [stackItem(9, { isAbility: true, sourceCardId: 201, description: 'Card 201 - When it enters, draw a card.' })];
      handle.notify(view(stack, [{ id: 201 }]));
      const chip = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
      await vi.waitFor(() => expect(chip.querySelector('.placed__chip-text')?.textContent).toBeTruthy());
      for (const width of widths) {
        card = width;
        handle.notify(view(stack, [{ id: 201 }]));
        await vi.waitFor(() => expect(chip.hasAttribute('data-placed-pending')).toBe(false));
      }
      const w = widthOf(chip);
      handle.dispose();
      spy.mockRestore();
      layout.restore();
      return w;
    };
    const fresh = await squaredAt([105]);
    expect(await squaredAt([50, 105]), `squared at 105 by way of 50, as a fresh draw at 105 (${fresh} px)`).toBe(fresh);
    // Run 43414464294, traced: at one chip width alice's text box read 79.0 px wide and bob's 78.1 — the hover's sway and
    // turn — and the two screens squared to 119×115 and 118×128 across a line wrap.
    expect(await squaredAt([105], 3), `squared under a hover's transform, as with none (${fresh} px)`).toBe(fresh);
  });

  it('exactly one item — the top of Forge’s stack — carries data-placed-next (item 3; the mutation at item 8)', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(2), stackItem(1)])); // top first, per BoardView.stack
    const next = canvas.querySelectorAll('[data-placed-next]');
    expect(next, 'never more than one at a time').toHaveLength(1);
    expect(next[0]!.getAttribute('data-placed-spell')).toBe('2');
    handle.dispose();
  });

  it('only the top of a deep stack hovers: below STACK_HOVER_MAX the cards hold still (m-0a1c953741c7: 23 on the stack, 69 endless animations, 25 fps)', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    const depth = STACK_HOVER_MAX + 2;
    handle.notify(view(Array.from({ length: depth }, (_, i) => stackItem(depth - i))));
    const still = [...canvas.querySelectorAll('[data-placed-spell]')].filter((el) => el.hasAttribute('data-placed-still')).map((el) => el.getAttribute('data-placed-spell'));
    expect(still, 'the two deepest').toEqual(['2', '1']);
    handle.notify(view([stackItem(2), stackItem(1)]));
    expect(canvas.querySelector('[data-placed-still]'), 'the stack shrank: everything left hovers again').toBeNull();
    const css = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/live', 'placed.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css, 'a still card drops only the hover from its animations').toMatch(/\.placed\[data-placed-still\]\s*>\s*\.placed__hover\s*\{\s*--stack-hover:\s*none;\s*\}/);
    handle.dispose();
  });

  it('a board no live match drives draws every stack item, abilities included', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { isAbility: true, sourceCardId: 201 })], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell="9"]')).not.toBeNull();
    handle.dispose();
  });

  it('a stack item naming no card draws the honest text fallback, never a guessed face', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCard: null, sourceName: 'Something' })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.querySelector('.placed__text')?.textContent).toBe('Something');
    handle.dispose();
  });

  it('Q18: a spell offered by its own card id is selectable and clicking it answers; an ability never is', () => {
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    const selected: number[] = [];
    const interaction = { isSelectable: (id: number) => id === 301, onSelect: (id: number) => selected.push(id) };
    handle.notify(view([stackItem(9, { sourceCardId: 301 }), stackItem(8, { isAbility: true, sourceCardId: 301 })]), interaction);
    const spell = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    const ability = canvas.querySelector<HTMLElement>('[data-placed-spell="8"]')!;
    expect(spell.hasAttribute('data-selectable')).toBe(true);
    expect(ability.hasAttribute('data-selectable'), 'only a spell, never an ability').toBe(false);
    spell.dispatchEvent(new Event('click', { bubbles: true }));
    ability.dispatchEvent(new Event('click', { bubbles: true }));
    expect(selected).toEqual([301]);
    handle.dispose();
  });
});

describe('installPlaced: arrows (item 2, item 8’s other mutation point)', () => {
  it('draws .placed__arrow[data-for] to a card, a player, and another placed spell, and removes it once the target or the item is gone', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(
      view([
        stackItem(9, { targetCardIds: [201], targetPlayerIds: [1] }),
        stackItem(8, { targetStackItemId: 9 }),
      ]),
    );
    const overlay = canvas.querySelector('[data-board-overlay]')!;
    const arrows = overlay.querySelectorAll('.placed__arrow[data-for="9"]');
    expect(arrows, 'one to the card, one to the player').toHaveLength(2);
    expect(overlay.querySelectorAll('.placed__arrow[data-for="8"]'), 'the stack-to-stack arc').toHaveLength(1);

    handle.notify(view([stackItem(9, { targetCardIds: [201], targetPlayerIds: [1] })])); // 8 resolved
    expect(overlay.querySelectorAll('.placed__arrow[data-for="8"]')).toHaveLength(0);
    handle.dispose();
  });

  it('two of one trigger, set off by two cards, each point at their own, marked apart from a target', () => {
    // The operator, 2026-11-09: Jace, Architect of Thought's +1 met two attackers and drew two chips
    // that looked one. Each chip now points at the attacker it is for.
    const { canvas } = board();
    const second = document.createElement('li');
    second.className = 'board-card';
    second.dataset.boardCard = '202';
    second.dataset.cardId = '202';
    second.getBoundingClientRect = () => rect({ left: 300, top: 500, width: 80, height: 110 });
    canvas.querySelector('[data-zone="battlefield"]')!.append(second);
    const handle = installPlaced(canvas);
    try {
      handle.notify(view([stackItem(9, { triggeredByCardIds: [201] }), stackItem(8, { triggeredByCardIds: [202] })], [{ id: 201 }, { id: 202 }]));
      const overlay = canvas.querySelector('[data-board-overlay]')!;
      const nine = overlay.querySelectorAll('.placed__arrow[data-for="9"]');
      const eight = overlay.querySelectorAll('.placed__arrow[data-for="8"]');
      expect([...nine].map((a) => a.getAttribute('data-key'))).toEqual(['9:cause:201']);
      expect([...eight].map((a) => a.getAttribute('data-key'))).toEqual(['8:cause:202']);
      expect(nine[0]!.hasAttribute('data-cause'), 'drawn as what set it off, not a target').toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it('a moved spell redraws its arrow at once — drop that call and this fails', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCardId: 301, targetCardIds: [201] })]));
    const overlay = canvas.querySelector('[data-board-overlay]')!;
    // jsdom does no layout: a real browser's `getBoundingClientRect` on the
    // placed element reflects whatever `style.left`/`top` currently says
    // (`.placed`'s `translate: -50% -50%` centres it there exactly), so this
    // stub reads those live rather than a box snapshot, the same way the
    // production element behaves once `placed.ts` repositions it.
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    el.getBoundingClientRect = () =>
      rect({ left: Number.parseFloat(el.style.getPropertyValue('--placed-x')) - 40, top: Number.parseFloat(el.style.getPropertyValue('--placed-y')) - 55, width: 80, height: 110 });
    const before = overlay.querySelector('.placed__arrow[data-for="9"] path')!.getAttribute('d');

    gripStackItem(9, 'you', { x: 150, y: 150 }, 'grab', 'you');
    const after = overlay.querySelector('.placed__arrow[data-for="9"] path')!.getAttribute('d');
    expect(after, 'the arrow followed the move without a fresh notify(view)').not.toBe(before);
    handle.dispose();
  });
});

describe('clampToLane (portrait, Settled 4: "relation arrows clamp to the lane edge")', () => {
  function laneAndCard(laneBox: { left: number; top: number; width: number; height: number }, cardBox: { left: number; top: number; width: number; height: number }): Element {
    const lane = document.createElement('div');
    lane.setAttribute('data-testid', 'lane-my-lands');
    lane.getBoundingClientRect = () => rect(laneBox);
    const card = document.createElement('li');
    card.getBoundingClientRect = () => rect(cardBox);
    lane.append(card);
    document.body.append(lane);
    return card;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is a no-op for a target with no lane ancestor (every desktop board)', () => {
    const to = document.createElement('div');
    to.getBoundingClientRect = () => rect({ left: 500, top: 500, width: 80, height: 110 });
    const at = { left: 500, top: 500, right: 580, bottom: 610 };
    expect(clampToLane(at, to)).toEqual(at);
  });

  it('is a no-op for a target fully inside its lane', () => {
    const card = laneAndCard({ left: 0, top: 0, width: 390, height: 120 }, { left: 100, top: 10, width: 80, height: 100 });
    expect(clampToLane({ left: 100, top: 10, right: 180, bottom: 110 }, card)).toEqual({ left: 100, top: 10, right: 180, bottom: 110 });
  });

  it('clamps the trailing edge of a target that has scrolled partly past the lane’s own right edge', () => {
    const card = laneAndCard({ left: 0, top: 0, width: 390, height: 120 }, { left: 350, top: 10, width: 80, height: 100 });
    expect(clampToLane({ left: 350, top: 10, right: 430, bottom: 110 }, card)).toEqual({ left: 350, top: 10, right: 390, bottom: 110 });
  });

  it('clamps the leading edge of a target that has scrolled partly past the lane’s own left edge', () => {
    const card = laneAndCard({ left: 0, top: 0, width: 390, height: 120 }, { left: -40, top: 10, width: 80, height: 100 });
    expect(clampToLane({ left: -40, top: 10, right: 40, bottom: 110 }, card)).toEqual({ left: 0, top: 10, right: 40, bottom: 110 });
  });

  it('collapses to a sliver at the edge the target left from when it no longer overlaps the lane at all', () => {
    const card = laneAndCard({ left: 0, top: 0, width: 390, height: 120 }, { left: 500, top: 10, width: 80, height: 100 });
    expect(clampToLane({ left: 500, top: 10, right: 580, bottom: 110 }, card)).toEqual({ left: 390, top: 10, right: 390, bottom: 110 });
  });
});

describe('installPlaced: resolution (item 4, decision c)', () => {
  it('leaving for the battlefield is removed at once — AC8 already draws the arrival', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    expect(canvas.querySelector('[data-placed-spell="9"]')).not.toBeNull();
    handle.notify(view([], [{ id: 301 }])); // resolved onto a battlefield
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'gone at once, no fade').toBeNull();
    handle.dispose();
  });

  it('a spell leaving for the battlefield leaves its drawn box for its arrival to start from (`stackBoxOf`), once', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    el.getBoundingClientRect = () => rect({ left: 342, top: 220, width: 116, height: 161 });
    handle.notify(view([], [{ id: 301 }]));
    expect(stackBoxOf(301)?.left).toBe(342);
    expect(stackBoxOf(301), 'read once').toBeNull();
    handle.dispose();
  });

  it('leaving for anywhere else travels and fades, and is gone when its fade ends', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([])); // resolved to the graveyard — not on any battlefield
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.hasAttribute('data-placed-leaving')).toBe(true);
    vi.advanceTimersByTime(LEAVE_FADE_MS);
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'a busy frame’s clock does not cut it short').not.toBeNull();
    el.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'left' }));
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'not on its travel’s end').not.toBeNull();
    el.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'opacity' }));
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'on its fade’s').toBeNull();
    handle.dispose();
  });

  it('a spell is held out of every pile from the moment it is drawn until it is gone from the stack (`onHolding`); an ability never is', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const onHolding = vi.fn();
    const handle = installPlaced(canvas, { reducedMotion: () => false, onHolding });
    handle.notify(view([stackItem(9, { sourceCardId: 301 }), stackItem(10, { sourceCardId: 302, isAbility: true })]));
    expect(onHolding, 'drawn: a spell still flying in on the other screen may already be in its graveyard').toHaveBeenLastCalledWith(new Set([301]));
    handle.notify(view([])); // resolved to the graveyard
    expect(onHolding).toHaveBeenLastCalledWith(new Set([301]));
    canvas.querySelector('[data-placed-spell="9"]')!.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'opacity' }));
    expect(onHolding).toHaveBeenLastCalledWith(new Set());
    handle.dispose();
  });

  it('a leaving card whose fade never reports its end is gone at twice the glide', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([]));
    vi.advanceTimersByTime(2 * LEAVE_FADE_MS);
    expect(canvas.querySelector('[data-placed-spell="9"]')).toBeNull();
    handle.dispose();
  });

  it('leaving for the battlefield settles the permanent at once — never shown flat first — until the settle has run', () => {
    const { canvas } = board();
    placeSpell(201, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 201 })]));
    const permanent = canvas.querySelector('[data-card-id="201"]')!;
    handle.notify(view([], [{ id: 201 }]));
    expect(permanent.hasAttribute(STACK_SETTLE_ATTR)).toBe(true);
    permanent.dispatchEvent(Object.assign(new Event('animationend'), { animationName: 'stack-settle' }));
    expect(permanent.hasAttribute(STACK_SETTLE_ATTR), 'once').toBe(false);
    handle.dispose();
  });

  it('a permanent Board draws again as a new element by the next frame settles too', async () => {
    const { canvas } = board();
    placeSpell(201, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 201 })]));
    handle.notify(view([], [{ id: 201 }]));
    const old = canvas.querySelector('[data-card-id="201"]')!;
    const fresh = old.cloneNode() as Element;
    fresh.removeAttribute(STACK_SETTLE_ATTR);
    old.replaceWith(fresh);
    await new Promise((r) => requestAnimationFrame(r));
    expect(fresh.hasAttribute(STACK_SETTLE_ATTR)).toBe(true);
    handle.dispose();
  });

  it('a permanent Forge draws on the battlefield a frame after the stack empties settles all the same', async () => {
    const { canvas } = board();
    placeSpell(201, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 201 })]));
    handle.notify(view([]));
    handle.notify(view([], [{ id: 201 }]));
    await new Promise((r) => requestAnimationFrame(r));
    expect(canvas.querySelector('[data-card-id="201"]')!.hasAttribute(STACK_SETTLE_ATTR)).toBe(true);
    handle.dispose();
  });

  it('leaving for a graveyard travels into it: its point moves onto the pile that holds the card now', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const seat = document.createElement('div');
    seat.setAttribute('data-testid', 'player');
    seat.setAttribute('data-player-id', '0');
    seat.innerHTML = '<div data-zone="graveyard"></div>';
    canvas.querySelector('.board')!.append(seat);
    seat.querySelector<HTMLElement>('[data-zone="graveyard"]')!.getBoundingClientRect = () => rect({ left: 0, top: 600, width: 80, height: 120 });
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    const resolved = view([]);
    resolved.players[0]!.graveyard = [battlefieldCard(301)];
    handle.notify(resolved);
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.hasAttribute('data-placed-leaving')).toBe(true);
    expect([el.style.getPropertyValue('--placed-x'), el.style.getPropertyValue('--placed-y')], 'the graveyard’s centre').toEqual(['40px', '660px']);
    handle.dispose();
  });

  it('nothing else moves when one item resolves — item 4', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    placeSpell(302, { x: 150, y: 150 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => true });
    handle.notify(view([stackItem(10, { sourceCardId: 302 }), stackItem(9, { sourceCardId: 301 })]));
    const staying = canvas.querySelector<HTMLElement>('[data-placed-spell="10"]')!;
    const stayingLeft = staying.style.getPropertyValue('--placed-x');
    handle.notify(view([stackItem(10, { sourceCardId: 302 })])); // 9 resolved away
    expect(staying.style.getPropertyValue('--placed-x'), 'untouched by the other item leaving').toBe(stayingLeft);
    handle.dispose();
  });
});

describe('installPlaced: an ability is drawn only when the chain halts over it', () => {
  it('nobody stopped: never drawn; once it resolves, its source on the battlefield shimmers for SHIMMER_MS', () => {
    setChainHalted(false); // a live match that has said: nobody is stopped
    vi.useFakeTimers();
    const { canvas } = board();
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    const trigger = stackItem(9, { isAbility: true, sourceCardId: 201 });
    handle.notify(view([trigger], [{ id: 201 }]));
    handle.notify(view([trigger], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell]'), 'no chip while nobody has stopped').toBeNull();
    const source = canvas.querySelector('[data-card-id="201"]')!;
    expect(source.hasAttribute('data-shimmer'), 'no shimmer before it resolves').toBe(false);
    handle.notify(view([], [{ id: 201 }]));
    expect(source.hasAttribute('data-shimmer'), 'the source shimmers as it resolves').toBe(true);
    expect(canvas.querySelector('[data-placed-spell]'), 'still never drawn').toBeNull();
    vi.advanceTimersByTime(SHIMMER_MS);
    expect(source.hasAttribute('data-shimmer')).toBe(false);
    handle.dispose();
  });

  it('a source no longer on the battlefield does not shimmer', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { isAbility: true, sourceCardId: 201 })]));
    handle.notify(view([]));
    expect(canvas.querySelector('[data-shimmer]')).toBeNull();
    handle.dispose();
  });

  it('the chain halts: the chip appears; it stays once the halt clears, until it resolves — and then fades, never shimmers', () => {
    setChainHalted(false); // a live match that has said: nobody is stopped
    const { canvas } = board();
    const handle = installPlaced(canvas, { reducedMotion: () => true });
    const trigger = stackItem(9, { isAbility: true, sourceCardId: 201 });
    handle.notify(view([trigger], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell="9"]')).toBeNull();
    setChainHalted(true);
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'drawn the moment the halt is known').not.toBeNull();
    setChainHalted(false);
    handle.notify(view([trigger], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'still drawn: it halted once').not.toBeNull();
    handle.notify(view([], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell="9"]')).toBeNull();
    expect(canvas.querySelector('[data-shimmer]'), 'a drawn ability never shimmers').toBeNull();
    handle.dispose();
  });

  it('a hold opened and closed between two paints still halted the chain: the chip is drawn', () => {
    // w79b-chip: bob passed 101 ms after his window opened, and alice's screen only ever heard "nobody stopped".
    setChainHalted(false, 0);
    const { canvas } = board();
    const handle = installPlaced(canvas, { reducedMotion: () => true });
    const trigger = stackItem(9, { isAbility: true, sourceCardId: 201 });
    handle.notify(view([trigger], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell="9"]')).toBeNull();
    // The other seat held, and passed, before this screen painted again: told as one more halt, still flowing.
    setChainHalted(false, 1);
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'drawn: the chain halted over it').not.toBeNull();
    // A later item that nobody stops for is not drawn on that old halt.
    handle.notify(view([trigger, stackItem(10, { isAbility: true, sourceCardId: 201 })], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell="10"]'), 'a new halt is needed for a new item').toBeNull();
    handle.dispose();
  });

  it('a spell is drawn whether or not the chain halts', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9)]));
    expect(canvas.querySelector('[data-placed-spell="9"]')).not.toBeNull();
    handle.dispose();
  });
});

describe('installPlaced: a cast trigger (the operator’s Emrakul, 2026-10-28)', () => {
  it('a release is the spell’s, never its cast trigger’s: the trigger shares the card’s id and is above it on the stack', () => {
    const { canvas } = board();
    setChainHalted(true);
    placeSpell(301, { x: 400, y: 300 }, 'them');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(12, { sourceCardId: 301, isAbility: true }), stackItem(9, { sourceCardId: 301 })]));
    const spell = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(spell.style.getPropertyValue('--placed-x'), 'the spell stands at the release').toBe('400px');
    expect(spell.style.getPropertyValue('--placed-y')).toBe('300px');
    handle.dispose();
  });

  it('a trigger still waiting to go on the stack makes room for the spell, never the spell for it', () => {
    const { canvas } = board();
    setChainHalted(true);
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    for (const el of canvas.querySelectorAll<HTMLElement>('[data-placed-spell]')) Object.defineProperties(el, { offsetWidth: { value: 116 }, offsetHeight: { value: 161 } });
    const waiting = { ...stackItem(-4, { sourceCardId: 301, isAbility: true }), pending: true as const };
    handle.notify({ ...view([stackItem(9, { sourceCardId: 301 })]), pendingTriggers: [waiting] });
    // Laid out: the spell where it was let go, the chip its own card's size (beside it, 6 px off — inside the stack's gap).
    for (const el of canvas.querySelectorAll<HTMLElement>('[data-placed-spell]')) {
      if (el.offsetWidth === 0) Object.defineProperties(el, { offsetWidth: { value: 116 }, offsetHeight: { value: 161 } });
      el.getBoundingClientRect = () => rect({ left: 342, top: 220, width: 116, height: 161 });
    }
    handle.notify({ ...view([stackItem(9, { sourceCardId: 301 })]), pendingTriggers: [waiting] });
    const spell = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(spell.style.getPropertyValue('--placed-x'), 'the spell keeps its release').toBe('400px');
    expect(spell.style.getPropertyValue('--placed-y')).toBe('300px');
    handle.dispose();
  });

  it('a card shown for the first time is drawn in place — never slid in from where it waited hidden', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(5, { sourceCardId: 48 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="5"]')!;
    expect(el.hasAttribute('data-placed-held'), 'hidden: no slide').toBe(true);
    placeSpell(48, { x: 400, y: 320 }, 'them');
    expect(el.hasAttribute('data-placed-pending')).toBe(false);
    expect(el.hasAttribute('data-placed-held'), 'first shown: in place').toBe(true);
    handle.notify(view([stackItem(5, { sourceCardId: 48 })]));
    expect(el.hasAttribute('data-placed-held'), 'from then on it may slide to its room').toBe(false);
    handle.dispose();
  });

  it('a chip that was seen stays its `CHIP_DWELL_MS` however soon it resolved, then goes', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(12, { sourceCardId: 301, isAbility: true })]));
    const chip = canvas.querySelector<HTMLElement>('[data-placed-spell="12"]')!;
    expect(chip.hasAttribute('data-placed-pending'), 'shown').toBe(false);
    vi.advanceTimersByTime(200);
    handle.notify(view([]));
    expect(chip.hasAttribute('data-placed-leaving'), 'still there, still').toBe(false);
    vi.advanceTimersByTime(CHIP_DWELL_MS - 200);
    expect(chip.hasAttribute('data-placed-leaving'), 'then it goes').toBe(true);
    handle.dispose();
  });

  it('a resolved chip takes no press while it dwells: the click goes to the card under it', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(12, { sourceCardId: 301, isAbility: true })]));
    const chip = canvas.querySelector<HTMLElement>('[data-placed-spell="12"]')!;
    expect(chip.hasAttribute('data-placed-gone'), 'on the stack: it can be hovered').toBe(false);
    handle.notify(view([]));
    expect(chip.hasAttribute('data-placed-leaving'), 'dwelling, not fading yet').toBe(false);
    expect(chip.hasAttribute('data-placed-gone'), 'but already gone from the stack').toBe(true);
    handle.dispose();
  });
});

describe('installPlaced: a resolution with something to draw (the operator’s Slagstorm, 2026-10-15)', () => {
  it('the spell stays, still, until what it did is drawn, then fades the ordinary way — no blink', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    noteResolutionEffects(9, Date.now() + 1500); // `numbers.ts` drew hits and creatures leaving, in this same commit
    handle.notify(view([]));
    const spell = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(spell.hasAttribute('data-placed-resolving'), 'no blink').toBe(false);
    expect(spell.hasAttribute('data-placed-leaving'), 'it does not go yet').toBe(false);
    vi.advanceTimersByTime(1499);
    expect(spell.hasAttribute('data-placed-leaving'), 'it stays while its effects play').toBe(false);
    vi.advanceTimersByTime(1);
    expect(spell.hasAttribute('data-placed-leaving'), 'then it fades').toBe(true);
    handle.dispose();
  });

  it('a resolution that drew nothing fades at once, as before', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([]));
    const spell = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(spell.hasAttribute('data-placed-resolving')).toBe(false);
    expect(spell.hasAttribute('data-placed-leaving')).toBe(true);
    handle.dispose();
  });
});

describe('installPlaced: a counter (AE27)', () => {
  it('both leave in one frame: the counter blinks, then its target is destroyed, then the counter fades', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    placeSpell(302, { x: 450, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(10, { sourceCardId: 302, targetStackItemId: 9 }), stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([], [], [9])); // the counter resolved: Forge removed both at once, and says item 9 was countered
    const counter = canvas.querySelector<HTMLElement>('[data-placed-spell="10"]')!;
    const target = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(counter.hasAttribute('data-placed-resolving'), 'the counter blinks').toBe(true);
    expect(counter.hasAttribute('data-placed-next')).toBe(false);
    expect(target.hasAttribute('data-placed-leaving'), 'the target does not fade with it').toBe(false);
    expect(target.hasAttribute('data-placed-countered')).toBe(false);
    vi.advanceTimersByTime(RESOLVE_BLINK_MS);
    expect(target.hasAttribute('data-placed-countered'), 'then the target is destroyed').toBe(true);
    expect(counter.hasAttribute('data-placed-leaving'), 'the counter waits').toBe(false);
    vi.advanceTimersByTime(COUNTERED_MS);
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'the target is gone').toBeNull();
    expect(counter.hasAttribute('data-placed-leaving'), 'then the counter fades').toBe(true);
    vi.advanceTimersByTime(LEAVE_FADE_MS);
    expect(canvas.querySelector('[data-placed-spell]')).toBeNull();
    handle.dispose();
  });

  // The operator, 2026-10-29: "my 90% rule was more about the more common animations like cards on the stack getting countered".
  it('a counter is a beat of the board until its target has cracked and faded: what waits on the board goes at its 90%', async () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    placeSpell(302, { x: 450, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(10, { sourceCardId: 302, targetStackItemId: 9 }), stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([], [], [9]));
    let unlocked = false;
    let still = false;
    whenBoardUnlocked(() => (unlocked = true));
    whenBoardStill(() => (still = true));
    const countered = RESOLVE_BLINK_MS + COUNTERED_MS;
    await vi.advanceTimersByTimeAsync(unlockAfter(countered) - 1);
    expect(unlocked, 'held while the counter blinks and its target cracks').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(unlocked, 'let go on the last tenth').toBe(true);
    expect(still).toBe(false);
    await vi.advanceTimersByTimeAsync(countered - unlockAfter(countered));
    expect(still, 'over once the target has faded').toBe(true);
    handle.dispose();
  });

  it('the target leaves a frame before its counter: it waits for it, and the counter is still drawn in three steps', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    placeSpell(302, { x: 450, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(10, { sourceCardId: 302, targetStackItemId: 9 }), stackItem(9, { sourceCardId: 301 })]));
    // Forge sends the countered spell to its graveyard in one delta and the counter off the stack in the next
    // (w67-counter, run 39832352790: seq 50 and seq 52, 67 ms apart, drawn in two commits).
    handle.notify(view([stackItem(10, { sourceCardId: 302, targetStackItemId: 9 })]));
    const target = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(target.hasAttribute('data-placed-leaving'), 'the target waits for what targets it').toBe(false);
    vi.advanceTimersByTime(67);
    handle.notify(view([], [], [9]));
    const counter = canvas.querySelector<HTMLElement>('[data-placed-spell="10"]')!;
    expect(counter.hasAttribute('data-placed-resolving'), 'the counter blinks').toBe(true);
    expect(target.hasAttribute('data-placed-leaving'), 'the target does not fade').toBe(false);
    vi.advanceTimersByTime(RESOLVE_BLINK_MS);
    expect(target.hasAttribute('data-placed-countered'), 'then the target is destroyed').toBe(true);
    vi.advanceTimersByTime(COUNTERED_MS);
    expect(counter.hasAttribute('data-placed-leaving'), 'then the counter fades').toBe(true);
    handle.dispose();
  });

  it('a counter keeps its target once the target has left the stack: the wire pairs only items still on it', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    placeSpell(302, { x: 450, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(10, { sourceCardId: 302, targetStackItemId: 9 }), stackItem(9, { sourceCardId: 301 })]));
    // Ward's own run on the claws: the spell went to its graveyard first, and the next view named no
    // pairing for the counter still resolving (`PlayBridge.stackTargetSpellsJson` reads the live stack) —
    // but it DOES say item 9 was countered, the moment it departs.
    handle.notify(view([stackItem(10, { sourceCardId: 302 })], [], [9]));
    const target = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(target.hasAttribute('data-placed-leaving'), 'the target waits for what targeted it').toBe(false);
    handle.notify(view([]));
    vi.advanceTimersByTime(RESOLVE_BLINK_MS);
    expect(target.hasAttribute('data-placed-countered'), 'then the target is destroyed').toBe(true);
    handle.dispose();
  });

  it('a trigger nobody stopped for is still drawn when it counters a spell on the stack: ward', () => {
    setChainHalted(false);
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([stackItem(10, { isAbility: true, sourceCardId: 201, targetStackItemId: 9 }), stackItem(9, { sourceCardId: 301 })], [{ id: 201 }]));
    expect(canvas.querySelector('[data-placed-spell="10"]'), 'the ward trigger is drawn').not.toBeNull();
    const target = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    handle.notify(view([], [{ id: 201 }], [9]));
    vi.advanceTimersByTime(RESOLVE_BLINK_MS);
    expect(target.hasAttribute('data-placed-countered'), 'the countered beat plays').toBe(true);
    handle.dispose();
  });

  it('a target whose counter stays on the stack goes the ordinary way once the wait is over', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(10, { targetStackItemId: 9 }), stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([stackItem(10, { targetStackItemId: 9 })]));
    const target = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    vi.advanceTimersByTime(COUNTER_HOLD_MS - 1);
    expect(target.hasAttribute('data-placed-leaving')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(target.hasAttribute('data-placed-leaving'), 'it fades').toBe(true);
    handle.dispose();
  });

  it('a target that resolved onto a battlefield was not countered: each leaves the ordinary way', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    placeSpell(302, { x: 450, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(10, { sourceCardId: 302, targetStackItemId: 9 }), stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([], [{ id: 301 }]));
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'the arrival is AC8\'s').toBeNull();
    expect(canvas.querySelector('[data-placed-spell="10"]')!.hasAttribute('data-placed-leaving')).toBe(true);
    handle.dispose();
  });

  it('reduced motion: both go at once', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas, { reducedMotion: () => true });
    handle.notify(view([stackItem(10, { targetStackItemId: 9 }), stackItem(9)]));
    handle.notify(view([]));
    expect(canvas.querySelector('[data-placed-spell]')).toBeNull();
    handle.dispose();
  });

  it('a countered spell whose counter was never drawn cracks and fades at once, never waiting on a resolver that cannot arrive', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'them');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    // An undrawn trigger (or a mass/untargeted counter, or a counter the wire did not pair) took it:
    // nothing in `view.stack` ever named a resolver for item 9, only the wire's own word that it was countered.
    handle.notify(view([], [], [9]));
    const target = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(target.hasAttribute('data-placed-resolving'), 'no resolver blink: none was ever drawn').toBe(false);
    expect(target.hasAttribute('data-placed-countered'), 'it cracks on its own').toBe(true);
    expect(target.querySelector('.placed__cracks'), 'crack lines are drawn').not.toBeNull();
    expect(target.hasAttribute('data-placed-leaving'), 'never the house glide').toBe(false);
    vi.advanceTimersByTime(COUNTERED_MS);
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'gone once its crack has run').toBeNull();
    handle.dispose();
  });

  it('a fizzled spell (its own target gone when it resolves) cracks and fades the same way a direct counter does', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    // A fizzle has no resolver at all — Forge's own resolution just found no legal target.
    handle.notify(view([], [], [9]));
    const target = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(target.hasAttribute('data-placed-countered'), 'the wire names it countered the same as a direct counter').toBe(true);
    expect(target.hasAttribute('data-placed-leaving')).toBe(false);
    handle.dispose();
  });

  it('a resolved instant with no wire counter fact still glides the ordinary way', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([])); // resolved cleanly: no `counteredStackItems` at all
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.hasAttribute('data-placed-countered'), 'never the crack').toBe(false);
    expect(el.hasAttribute('data-placed-leaving'), 'the house glide').toBe(true);
    handle.dispose();
  });
});

describe('dispose', () => {
  it('unmounts every drawn card and stops reacting to placement changes', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9)]));
    handle.dispose();
    expect(canvas.querySelector('[data-placed-spell]')).toBeNull();
    expect(() => gripStackItem(9, 'you', { x: 1, y: 1 }, 'grab', 'you')).not.toThrow();
  });
});

describe('installPlaced: layout reads per commit', () => {
  /** Every box and computed style read from here on: the element stubs `board()` set, and every other element's. */
  function countReads(canvas: HTMLElement): { total: () => number; overlay: () => number } {
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    let own = 0;
    let overlayReads = 0;
    for (const el of canvas.querySelectorAll<HTMLElement>('*')) {
      if (!Object.hasOwn(el, 'getBoundingClientRect')) continue;
      const stub = el.getBoundingClientRect.bind(el);
      el.getBoundingClientRect = () => {
        own += 1;
        if (el === overlay) overlayReads += 1;
        return stub();
      };
    }
    const boxes = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    const styles = vi.spyOn(window, 'getComputedStyle');
    return { total: () => own + boxes.mock.calls.length + styles.mock.calls.length, overlay: () => overlayReads };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a commit with nothing on the stack and nothing drawn reads no layout at all', () => {
    const { canvas } = board();
    canvas.querySelector('[data-zone="battlefield"]')!.insertAdjacentHTML('beforeend', '<ul class="zone__cards" style="--card-w: 64px"></ul>');
    const handle = installPlaced(canvas);
    const reads = countReads(canvas);
    handle.notify(view([], [{ id: 201 }]));
    handle.notify(view([], [{ id: 201 }]));
    expect(reads.total()).toBe(0);
    handle.dispose();
  });

  it('a commit with an item on the stack reads the overlay’s box once, for the item and its arrows alike', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    const reads = countReads(canvas);
    handle.notify(view([stackItem(9, { targetCardIds: [201], targetPlayerIds: [1] })]));
    expect(canvas.querySelectorAll('.placed__arrow[data-for="9"]')).toHaveLength(2);
    expect(reads.overlay()).toBe(1);
    handle.dispose();
  });
});

describe('settleStack: the stack bumps, spreads and piles (the operator, 2026-10-30)', () => {
  const board = { left: 0, top: 0, right: 1600, bottom: 1000 };
  const card = { width: 116, height: 161 };
  const chip = { width: 150, height: 150 };
  type P = { x: number; y: number };
  /** The largest share of one box another covers, for boxes `w` × `h` centred on `at`. */
  const worstOverlap = (at: readonly P[], w: number, h: number): number => {
    let worst = 0;
    for (let i = 0; i < at.length; i++) {
      for (let j = i + 1; j < at.length; j++) {
        const ox = Math.max(0, w - Math.abs(at[i]!.x - at[j]!.x));
        const oy = Math.max(0, h - Math.abs(at[i]!.y - at[j]!.y));
        worst = Math.max(worst, (ox * oy) / (w * h));
      }
    }
    return worst;
  };
  const inside = (at: readonly P[], w: number, h: number, b = board): boolean =>
    at.every((p) => p.x - w / 2 >= b.left - 0.01 && p.x + w / 2 <= b.right + 0.01 && p.y - h / 2 >= b.top - 0.01 && p.y + h / 2 <= b.bottom + 0.01);
  const at = (n: number, want: P, size = card, seed = 1): { want: P; width: number; height: number; seed: number }[] =>
    Array.from({ length: n }, (_, i) => ({ want, ...size, seed: seed + i }));

  it('collides on the inner half of a card\'s area only: cards released at one point bump to touching cores, overlapping at their edges', () => {
    const spots = settleStack(at(6, { x: 800, y: 420 }), board);
    expect(STACK_CORE ** 2, 'the core is half the card\'s area').toBeCloseTo(0.5);
    expect(worstOverlap(spots, card.width * STACK_CORE - 0.5, card.height * STACK_CORE - 0.5), 'no two cores overlap').toBe(0);
    expect(worstOverlap(spots, card.width, card.height), 'whole cards do: the edges are free to touch').toBeGreaterThan(0);
    expect(inside(spots, card.width, card.height)).toBe(true);
  });

  it('ten triggers on a board with room for four pile on top of each other: every one is placed, inside the board, none dropped or shrunk', () => {
    const small = { left: 0, top: 0, right: 420, bottom: 340 };
    const spots = settleStack(at(10, { x: 200, y: 170 }, chip), small);
    expect(spots).toHaveLength(10);
    expect(spots.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(inside(spots, chip.width, chip.height, small)).toBe(true);
    expect(worstOverlap(spots, chip.width * STACK_CORE, chip.height * STACK_CORE), 'out of room: cores pile').toBeGreaterThan(0);
    expect(new Set(spots.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size, 'piled where the pile is thinnest, never all on one spot').toBeGreaterThan(4);
  });

  it('the spread is seeded by each item: the same items always settle the same way, other items another way', () => {
    const asks = at(9, { x: 800, y: 420 }, card, 40);
    expect(settleStack(asks, board)).toEqual(settleStack(asks, board));
    expect(settleStack(at(9, { x: 800, y: 420 }, card, 90), board)).not.toEqual(settleStack(asks, board));
  });

  it('a bumped card leaves along a turned push, not along the grid', () => {
    const turned = [3, 4, 5, 6, 7, 8].map((seed) => {
      // Top first: the newer card, released just right of the older one, is the one that bumps.
      const [second] = settleStack([{ want: { x: 830, y: 420 }, ...card, seed }, { want: { x: 800, y: 420 }, ...card, seed: 1 }], board);
      const angle = Math.atan2(second!.y - 420, second!.x - 800);
      return Math.round((angle * 180) / Math.PI);
    });
    expect(new Set(turned).size, 'each seed turns it its own way').toBeGreaterThan(3);
    expect(turned.every((deg) => Math.abs(deg) <= 25), 'about the straight push, no further than the jitter').toBe(true);
    expect(turned.filter((deg) => deg !== 0).length, 'off the axis').toBeGreaterThan(3);
  });

  it('never covers the control box: a card asked onto it, and every card bumped toward it, stays clear', () => {
    const control = { left: 1400, top: 600, right: 1590, bottom: 700 };
    const clear = (p: P, size = card): boolean =>
      p.x + size.width / 2 <= control.left || p.x - size.width / 2 >= control.right || p.y + size.height / 2 <= control.top || p.y - size.height / 2 >= control.bottom;
    const onIt = settleStack([{ want: { x: 1490, y: 650 }, ...card, seed: 1 }], board, [control]);
    expect(clear(onIt[0]!), `asked onto it: moved off (${JSON.stringify(onIt[0])})`).toBe(true);
    const crowd = settleStack(at(12, { x: 1350, y: 620 }, chip), board, [control]);
    expect(crowd.filter((p) => !clear(p, chip)), 'twelve chips beside it').toEqual([]);
  });

  it('a pinned card stands exactly where it asked; the others bump off it', () => {
    const spots = settleStack([{ want: { x: 800, y: 420 }, ...card, seed: 1, pinned: true }, { want: { x: 800, y: 420 }, ...card, seed: 2 }], board);
    expect(spots[0]).toEqual({ x: 800, y: 420 });
    expect(worstOverlap(spots, card.width * STACK_CORE - 0.5, card.height * STACK_CORE - 0.5)).toBe(0);
  });

  it('cards already clear of each other stay where they asked', () => {
    const asks = [{ want: { x: 300, y: 300 }, ...card, seed: 1 }, { want: { x: 900, y: 600 }, ...card, seed: 2 }];
    expect(settleStack(asks, board)).toEqual(asks.map((a) => a.want));
  });

  /** How much of `box` a `size` box centred on `p`, grown by the hover's reach, covers. */
  const covered = (p: P, size: { width: number; height: number }, box: Rect): number => {
    const w = Math.min(p.x + size.width / 2 + HOVER_REACH, box.right) - Math.max(p.x - size.width / 2 - HOVER_REACH, box.left);
    const h = Math.min(p.y + size.height / 2 + HOVER_REACH, box.bottom) - Math.max(p.y - size.height / 2 - HOVER_REACH, box.top);
    return w > 0 && h > 0 ? w * h : 0;
  };

  it('a chip never covers a card the viewer can click, hover and all: asked onto one, it moves clear; anything else stays where it asked', () => {
    const nomads = { left: 740, top: 360, right: 856, bottom: 521 };
    const [chipAt] = settleStack([{ want: { x: 800, y: 440 }, ...chip, seed: 1, yields: true }], board, [], [nomads]);
    expect(covered(chipAt!, chip, nomads), `moved off it (${JSON.stringify(chipAt)})`).toBe(0);
    expect(Math.hypot(chipAt!.x - 800, chipAt!.y - 440), 'to the nearest clear spot, not across the table').toBeLessThan(chip.width + card.width);
    const [spellAt] = settleStack([{ want: { x: 800, y: 440 }, ...card, seed: 1 }], board, [], [nomads]);
    expect(spellAt, 'a card a player put down stays where they put it').toEqual({ x: 800, y: 440 });
  });

  it('ten chips round two clickable cards: they pile on each other before one covers either', () => {
    const small = { left: 0, top: 0, right: 900, bottom: 420 };
    const cards = [
      { left: 60, top: 120, right: 176, bottom: 281 },
      { left: 190, top: 120, right: 306, bottom: 281 },
    ];
    const asks = Array.from({ length: 10 }, (_, i) => ({ want: { x: 250, y: 200 }, ...chip, seed: 30 + i, yields: true }));
    const spots = settleStack(asks, small, [], cards);
    expect(spots.filter((p) => cards.some((c) => covered(p, chip, c) > 0)), 'none covers a clickable card').toEqual([]);
    expect(inside(spots, chip.width, chip.height, small)).toBe(true);
    expect(worstOverlap(spots, chip.width * STACK_CORE, chip.height * STACK_CORE), 'out of clear room: the chips pile').toBeGreaterThan(0);
  });

  it('a slide between two clear spots can still cut across a clickable card: its whole path is tested, hover reach and overshoot included', () => {
    const land = { left: 300, top: 300, right: 416, bottom: 461 };
    const size = { w: 120, h: 120 };
    // Both ends clear of the land by more than the reach; the straight line between them runs through it.
    expect(slideCrosses({ x: 220, y: 200 }, { x: 500, y: 560 }, size.w, size.h, [land]), 'through it').toBe(true);
    // The Underground Sea frame of claw run 41524219782: the corner clipped by a few px on the way past.
    expect(slideCrosses({ x: 220, y: 200 }, { x: 560, y: 200 }, size.w, size.h, [land]), 'past its top edge, 40 px clear').toBe(false);
    expect(slideCrosses({ x: 220, y: 300 - 60 - HOVER_REACH + 4 }, { x: 560, y: 300 - 60 - HOVER_REACH + 4 }, size.w, size.h, [land]), 'within the reach of its top edge').toBe(true);
    // Toward it, stopping short: the easing's overshoot carries it 2% further.
    expect(slideCrosses({ x: 0, y: 380 }, { x: 300 - 60 - HOVER_REACH - 1, y: 380 }, size.w, size.h, [land]), 'overshoot into it').toBe(true);
    expect(slideCrosses({ x: 200, y: 380 }, { x: 200, y: 380 }, size.w, size.h, [land]), 'standing still, clear').toBe(false);
  });

  it('with no clear room anywhere, a chip covers as little of what can be clicked as it can', () => {
    const small = { left: 0, top: 0, right: 400, bottom: 300 };
    const wall = { left: 0, top: 0, right: 400, bottom: 220 };
    const [p] = settleStack([{ want: { x: 200, y: 100 }, ...chip, seed: 1, yields: true }], small, [], [wall]);
    // The lowest it fits is 219; the search steps a tenth of the chip's core at a time.
    expect(p!.y, 'as low as it fits, within one step of the search').toBeGreaterThan(small.bottom - 6 - chip.height / 2 - 11);
    expect(covered(p!, chip, wall), 'covering less than where it asked').toBeLessThan(covered({ x: 200, y: 100 }, chip, wall));
  });
});
