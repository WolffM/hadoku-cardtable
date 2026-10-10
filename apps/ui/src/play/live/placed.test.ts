// @vitest-environment jsdom
/*
 * The placed-cards layer (`placed.ts`): the seam functions, the DOM contract
 * `installPlaced` produces, and the two mutation points item 8 names —
 * dropping the arrow redraw on a move, and dropping the one-at-a-time flash.
 * Same device `numbers.test.ts` uses: jsdom gives every element a zero rect,
 * so `getBoundingClientRect` is stubbed with real numbers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardView, StackEntry } from '../adapter.ts';
import {
  besideSource,
  commitSpell,
  defaultSpot,
  forgetPlacements,
  installPlaced,
  LEAVE_FADE_MS,
  moveSpell,
  onSpellMoved,
  placeSpell,
  type Rect,
  COUNTERED_MS,
  PLACED_PENDING_MS,
  RESOLVE_BLINK_MS,
  setChainHalted,
  SHIMMER_MS,
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
  };
}

function battlefieldCard(id: number): NonNullable<BoardView['players']>[number]['battlefield'][number] {
  return { id, card: draftCard(`Card ${id}`), tapped: false, summoningSick: false, damage: 0, counters: [], attacking: false, blocking: false, token: false };
}

function view(stack: StackEntry[], battlefield: { id: number }[] = []): BoardView {
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
  };
}

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

function board(): { canvas: HTMLElement } {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div data-testid="board-mid"></div>
      <div data-zone="battlefield" data-owner="you"><li class="board-card" data-card-id="201"></li></div>
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

/* ── placeSpell / moveSpell / commitSpell / onSpellMoved ──────────────── */

describe('the seam', () => {
  it('placeSpell then installPlaced draws a card at that point, centred', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el, 'promoted from the card id onto the stack item’s own id').not.toBeNull();
    expect(el.style.left).toBe('400px');
    expect(el.style.top).toBe('300px');
    expect(el.hasAttribute('data-mine'), 'side: "you"').toBe(true);
    expect(el.getAttribute('data-stack-id'), 'the one element every existing reader keys off').toBe('9');
    handle.dispose();
  });

  it('a committed "them" item is its face; an uncommitted one is a back, and commitSpell turns it over', async () => {
    const { canvas } = board();
    placeSpell(302, { x: 200, y: 200 }, 'them');
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { sourceCardId: 302 })]));
    let el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.querySelector('.card-back'), 'not committed yet: a back').not.toBeNull();
    expect(el.querySelector('.card__name')).toBeNull();

    commitSpell(9);
    // The flip tears the old root down and mounts a fresh one (`placed.ts`'s
    // own note on why — `flushSync` nested inside a React effect warns in
    // the real app). React schedules a fresh root's first commit on its own
    // clock (a macrotask in this environment, not a microtask) — this waits
    // for one, same as any other React DOM update read from outside `act()`.
    await new Promise((r) => setTimeout(r, 0));
    el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.querySelector('.card-back')).toBeNull();
    expect(el.querySelector('.card__name')?.textContent).toBe('Card 9');
    handle.dispose();
  });

  it('onSpellMoved hears every moveSpell, by whichever id is current', () => {
    placeSpell(5, { x: 0, y: 0 }, 'you');
    const heard: Array<[number, { x: number; y: number }]> = [];
    const unsub = onSpellMoved((id, at) => heard.push([id, at]));
    moveSpell(5, { x: 10, y: 20 });
    moveSpell(999, { x: 1, y: 1 }); // nothing placed under 999 — no-op, never heard
    expect(heard).toEqual([[5, { x: 10, y: 20 }]]);
    unsub();
    moveSpell(5, { x: 30, y: 40 });
    expect(heard, 'unsubscribed').toHaveLength(1);
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
    expect(el.style.left).toBe(`${spot.x}px`);
    expect(el.style.top).toBe(`${spot.y}px`);
    expect(el.hasAttribute('data-mine'), 'nobody ever claimed it').toBe(false);
    handle.dispose();
  });

  it('an unregistered spell is drawn hidden for PLACED_PENDING_MS; a registration inside the window draws the back AT the point, then the face there (AE26)', async () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(5, { sourceCardId: 48 })]));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="5"]');
    expect(el, 'drawn at once').not.toBeNull();
    expect(el!.hasAttribute('data-placed-pending'), 'but not shown yet').toBe(true);
    placeSpell(48, { x: 400, y: 320 }, 'them');
    expect(el!.hasAttribute('data-placed-pending'), 'the registration shows it').toBe(false);
    expect(el!.querySelector('.placed__back'), 'as the back, at the point').not.toBeNull();
    expect(el!.style.left).toBe('400px');
    expect(el!.style.top).toBe('320px');
    commitSpell(5);
    await Promise.resolve();
    expect(el!.querySelector('.placed__back'), 'turned over in place').toBeNull();
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
      // The decode settles, the flip remounts, and a fresh React root commits one macrotask later.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(theirs.querySelector('.placed__back'), 'turned over once decoded').toBeNull();
      expect(theirs.querySelector('.card__name')?.textContent).toBe('Think Twice');
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
    expect(Number.parseFloat(el.style.left)).toBeGreaterThan(180);
    expect(Number.parseFloat(el.style.top)).toBeCloseTo(555, 0);
    handle.dispose();
  });

  it('AE29: an ability is the chip — the source\'s name and art band over the ability\'s own text, never a second card face', async () => {
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9, { isAbility: true, sourceCardId: 201, sourceName: 'Eternal Witness', description: 'Eternal Witness - When it enters, return target card.' })]));
    // A fresh React root commits on its own clock — one macrotask (see the flip test above).
    await new Promise((r) => setTimeout(r, 0));
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.querySelector('[data-ability-chip]'), 'the chip').not.toBeNull();
    expect(el.querySelector('.card'), 'no card face').toBeNull();
    expect(el.querySelector('.placed__chip-name')!.textContent).toBe('Eternal Witness');
    expect(el.querySelector('.placed__chip-text')!.textContent, 'the name is not repeated in the text').toBe('When it enters, return target card.');
    handle.dispose();
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

  it('besideSource pushes a second ephemeral tile clear of the first at the same source row', () => {
    const sourceBox: Rect = { left: 100, top: 500, right: 180, bottom: 610 };
    const first = besideSource(sourceBox, []);
    const firstBox: Rect = { left: first.x - 40, right: first.x + 40, top: first.y - 55, bottom: first.y + 55 };
    const second = besideSource(sourceBox, [firstBox]);
    expect(second.x, 'the second sits clear of the first, not on top of it').toBeGreaterThan(firstBox.right);
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
      rect({ left: Number.parseFloat(el.style.left) - 40, top: Number.parseFloat(el.style.top) - 55, width: 80, height: 110 });
    const before = overlay.querySelector('.placed__arrow[data-for="9"] path')!.getAttribute('d');

    moveSpell(9, { x: 150, y: 150 });
    const after = overlay.querySelector('.placed__arrow[data-for="9"] path')!.getAttribute('d');
    expect(after, 'the arrow followed the move without a fresh notify(view)').not.toBe(before);
    handle.dispose();
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

  it('leaving for anywhere else fades over 250ms, then is gone', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => false });
    handle.notify(view([stackItem(9, { sourceCardId: 301 })]));
    handle.notify(view([])); // resolved to the graveyard — not on any battlefield
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.hasAttribute('data-placed-leaving')).toBe(true);
    vi.advanceTimersByTime(LEAVE_FADE_MS - 1);
    expect(canvas.querySelector('[data-placed-spell="9"]'), 'still fading').not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(canvas.querySelector('[data-placed-spell="9"]')).toBeNull();
    handle.dispose();
  });

  it('nothing else moves when one item resolves — item 4', () => {
    const { canvas } = board();
    placeSpell(301, { x: 400, y: 300 }, 'you');
    placeSpell(302, { x: 150, y: 150 }, 'you');
    const handle = installPlaced(canvas, { reducedMotion: () => true });
    handle.notify(view([stackItem(10, { sourceCardId: 302 }), stackItem(9, { sourceCardId: 301 })]));
    const staying = canvas.querySelector<HTMLElement>('[data-placed-spell="10"]')!;
    const stayingLeft = staying.style.left;
    handle.notify(view([stackItem(10, { sourceCardId: 302 })])); // 9 resolved away
    expect(staying.style.left, 'untouched by the other item leaving').toBe(stayingLeft);
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

  it('a spell is drawn whether or not the chain halts', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9)]));
    expect(canvas.querySelector('[data-placed-spell="9"]')).not.toBeNull();
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
    handle.notify(view([])); // the counter resolved: Forge removed both at once
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
});

describe('dispose', () => {
  it('unmounts every drawn card and stops reacting to placement changes', () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(9)]));
    handle.dispose();
    expect(canvas.querySelector('[data-placed-spell]')).toBeNull();
    expect(() => moveSpell(9, { x: 1, y: 1 })).not.toThrow();
  });
});
