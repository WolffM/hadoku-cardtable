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
import { noteResolutionEffects, PLACEMENT_WAIT_MS } from '../motion.ts';
import {
  besideSource,
  commitSpell,
  defaultSpot,
  forgetPlacements,
  holdSpell,
  installPlaced,
  LEAVE_FADE_MS,
  moveSpell,
  onSpellMoved,
  placeSpell,
  releaseSpell,
  placeStackItem,
  type Rect,
  COUNTERED_MS,
  PLACED_PENDING_MS,
  RESOLVE_BLINK_MS,
  setChainHalted,
  STACK_SETTLE_ATTR,
  SHIMMER_MS,
  scatter,
  squareWidth,
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
    ...(opts.abilityText === undefined ? {} : { abilityText: opts.abilityText }),
    ...(opts.sourceHidden === undefined ? {} : { sourceHidden: opts.sourceHidden }),
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
    // clock, so this waits for the face, as for any React DOM update read from outside `act()`.
    await vi.waitFor(() => expect(canvas.querySelector('[data-placed-spell="9"] .card__name')?.textContent).toBe('Card 9'));
    el = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(el.querySelector('.card-back')).toBeNull();
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
    expect(el.style.top, 'nor drawn over my land').not.toBe('600px');
    // Their release, when it arrives, is what places it.
    placeSpell(90, { x: 400, y: 200 }, 'them');
    expect(el.style.left).toBe('400px');
    expect(el.style.top).toBe('200px');
    handle.dispose();
  });

  it('onSpellMoved hears every moveSpell, by whichever id is current', () => {
    placeStackItem(5, { x: 0, y: 0 }, 'you');
    const heard: Array<[number, { x: number; y: number }]> = [];
    const unsub = onSpellMoved((id, at) => heard.push([id, at]));
    moveSpell(5, { x: 10, y: 20 });
    moveSpell(999, { x: 1, y: 1 }); // nothing placed under 999 — no-op, never heard
    expect(heard).toEqual([[5, { x: 10, y: 20 }]]);
    unsub();
    moveSpell(5, { x: 30, y: 40 });
    expect(heard, 'unsubscribed').toHaveLength(1);
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
    expect([el.style.left, el.style.top], 'drawn where it was put this time').toEqual(['530px', '322px']);
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
    expect(held.style.left).toBe('400px');
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
    expect(el.style.left, 'already where the stand-in comes to rest').toBe('410px');
    releaseSpell(52);
    expect(el.hasAttribute('data-placed-pending'), 'shown in the same task the stand-in goes').toBe(false);
    handle.dispose();
  });

  it('their face-down spell is the hidden card’s own back — a card the inspector enlarges, never a face or a text tile', async () => {
    const { canvas } = board();
    const handle = installPlaced(canvas);
    const hidden = { ...draftCard('Hidden card'), cardId: 'w61' };
    placeSpell(61, { x: 400, y: 320 }, 'them');
    commitSpell(61);
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
    expect(Number.parseFloat(el.style.left)).toBeGreaterThan(180);
    // Nudged by its own `scatter`, never by more than a quarter of its height.
    expect(Math.abs(Number.parseFloat(el.style.top) - 555)).toBeLessThanOrEqual(110 / 4);
    handle.dispose();
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
          description: 'When it enters, return target card. (Targeting: [[Lightning Bolt (12)]]) [Zone Changer: Eternal Witness (201)]',
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
    // `placeStackItem(…, 'them', true)` then `commitSpell`), which used to flip it to a back and back again.
    const { canvas } = board();
    setChainHalted(true);
    const handle = installPlaced(canvas);
    handle.notify(view([stackItem(8, { isAbility: true, sourceCardId: 202, controllerName: 'Bob', sourceName: 'Eternal Witness' })]));
    await vi.waitFor(() => expect(canvas.querySelector('[data-placed-spell="8"] [data-ability-chip]')).not.toBeNull());
    const el = canvas.querySelector<HTMLElement>('[data-placed-spell="8"]')!;
    const chip = el.querySelector('[data-ability-chip]');
    expect(chip).not.toBeNull();
    for (const x of [300, 310, 320]) {
      placeStackItem(8, { x, y: 400 }, 'them', true);
      expect(el.querySelector('.placed__back'), 'never a back').toBeNull();
      expect(el.hasAttribute('data-placed-gliding'), 'every move of their drag glides, the first one included').toBe(true);
      commitSpell(8);
    }
    // A point that is not their drag (a release point, a hand-over) is drawn in place.
    placeStackItem(8, { x: 330, y: 400 }, 'them');
    expect(el.hasAttribute('data-placed-gliding')).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('[data-ability-chip]'), 'the same chip element, never rebuilt').toBe(chip);
    expect(el.style.left).toBe('330px');
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

  it('besideSource places a chip by its own drawn width, and on the source\'s left when its right is off the board', () => {
    const sourceBox: Rect = { left: 100, top: 500, right: 180, bottom: 610 };
    const wide = { width: 240, height: 90 };
    const bounds: Rect = { left: 0, top: 0, right: 1000, bottom: 800 };
    expect(besideSource(sourceBox, [], wide, bounds).x, 'clear of the source by its own half-width').toBe(180 + 6 + 120);
    const nearEdge: Rect = { left: 800, top: 500, right: 880, bottom: 610 };
    expect(besideSource(nearEdge, [], wide, bounds).x, 'no room on the right: on the left').toBe(800 - 6 - 120);
    const narrow: Rect = { left: 0, top: 0, right: 300, bottom: 800 };
    const squeezed = besideSource({ left: 100, top: 500, right: 180, bottom: 610 }, [], wide, narrow);
    expect(squeezed.x - 120, 'room on neither side: inside the board').toBeGreaterThanOrEqual(6);
    expect(squeezed.x + 120).toBeLessThanOrEqual(300 - 6);
  });

  it('besideSource wraps a full row to the row above or below, inside the board, never onto the same spot', () => {
    const sourceBox: Rect = { left: 100, top: 500, right: 180, bottom: 610 };
    const tile = { width: 240, height: 90 };
    const bounds: Rect = { left: 0, top: 0, right: 700, bottom: 800 };
    const taken: Rect[] = [];
    const spots = [0, 1, 2, 3].map(() => {
      const at = besideSource(sourceBox, taken, tile, bounds);
      taken.push({ left: at.x - 120, right: at.x + 120, top: at.y - 45, bottom: at.y + 45 });
      return at;
    });
    expect(spots[0], 'the first beside the source').toEqual({ x: 180 + 6 + 120, y: 555 });
    expect(spots[1]!.y, 'the second further along the same row').toBe(555);
    expect(new Set(spots.map((s) => `${s.x},${s.y}`)).size, 'four spots').toBe(4);
    expect(spots[2]!.y, 'the row is full: the next row').not.toBe(555);
    for (const s of spots) {
      expect(s.x - 120).toBeGreaterThanOrEqual(6);
      expect(s.x + 120).toBeLessThanOrEqual(700 - 6);
      expect(s.y + 45).toBeLessThanOrEqual(800 - 6);
    }
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
    const at = { left: chips[0]!.style.left, top: chips[0]!.style.top };
    expect(new Set(chips.map((c) => `${c.style.left},${c.style.top}`)).size, 'three spots').toBe(3);

    handle.notify({ ...view([stackItem(40, { isAbility: true, sourceCardId: 201 })]), pendingTriggers: [waiting(-12, true), waiting(-13)] });
    const onStack = canvas.querySelector<HTMLElement>('[data-placed-spell="40"]')!;
    expect(onStack, 'the very element the asked-about trigger was drawn as').toBe(chips[0]);
    expect({ left: onStack.style.left, top: onStack.style.top }, 'where it stood').toEqual(at);
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
      if (this.classList.contains('placed__chip-text')) {
        measures += 1;
        return rect({ left: 0, top: 0, width: w, height: textHeight(w) });
      }
      return rect({ left: 0, top: 0, width: w, height: placed.querySelector('.placed__chip-text') === null ? w * 1.4 : BAND + textHeight(w) });
    });
    setChainHalted(true);
    const handle = installPlaced(canvas);
    const stack = [stackItem(9, { isAbility: true, sourceCardId: 201, description: 'Card 201 - When it enters, draw a card.' }), stackItem(8)];
    handle.notify(view(stack, [{ id: 201 }]));
    const chip = canvas.querySelector<HTMLElement>('[data-placed-spell="9"]')!;
    expect(chip.style.width, 'nothing to measure before its text has rendered').toBe('');
    // A fresh React root commits on its own clock; the chip's own resize redraws it then (the ResizeObserver jsdom lacks).
    await vi.waitFor(() => expect(chip.querySelector('.placed__chip-text')?.textContent).toBeTruthy());
    handle.notify(view(stack, [{ id: 201 }]));
    const w = widthOf(chip);
    const h = BAND + textHeight(w);
    expect(w / h, `near square (${w}×${h})`).toBeGreaterThan(0.75);
    expect(w / h, `near square (${w}×${h})`).toBeLessThan(1.33);
    expect(measures, 'one measure, one correction').toBeLessThanOrEqual(2);
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
    expect([el.style.left, el.style.top], 'the graveyard’s centre').toEqual(['40px', '660px']);
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
