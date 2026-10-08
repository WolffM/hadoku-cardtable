// @vitest-environment jsdom
/*
 * Presence (ledger Z5), `presence.ts`: the mirror between the two boards, what
 * is sent, and what is drawn. jsdom gives every element a zero rect, so the
 * geometry here comes from stubbed `getBoundingClientRect`s with real numbers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLACED_EVENT, PLACEMENT_EVENT, PRESENCE_EVENT, PRESENCE_SEND_MS } from '@hadoku/shared';

import * as castModule from './gestures/cast.ts';
import { forgetPendingPlacements, pendingPlacementFor } from '../Board.tsx';

/*
 * `placed.ts` (lane S) is the seam this module calls into for the stack
 * layer's own drawing (`placeSpell`/`moveSpell`/`commitSpell`/`onSpellMoved`)
 * — this module "calls them and never draws" (wave 59's Settled seam). Mocked
 * here so this file's own receive/send logic proves itself without needing
 * that drawing layer at all.
 */
const { placedMod, spellMovedBox } = vi.hoisted(() => {
  const spellMovedBox: { current: ((id: number, at: { x: number; y: number }) => void) | null } = { current: null };
  const placedMod = {
    placeSpell: vi.fn(),
    moveSpell: vi.fn(),
    commitSpell: vi.fn(),
    onSpellMoved: vi.fn((listener: (id: number, at: { x: number; y: number }) => void) => {
      spellMovedBox.current = listener;
      return () => {
        spellMovedBox.current = null;
      };
    }),
  };
  return { placedMod, spellMovedBox };
});
vi.mock('./placed.ts', () => placedMod);

import { forgetPendingPlaced, HAND_MOVE_MS, installPresence, placeSpot, PRESENCE_STALE_MS, queueHandMove, spotOf, type PresenceHost } from './presence.ts';

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect =>
  ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

/** A board: the overlay covering it, both seats' battlefields and hands, one card of theirs. */
function board(overrides: Partial<Record<string, Box>> = {}, overlay: Box = { left: 0, top: 0, width: 1000, height: 800 }): { canvas: HTMLElement; theirCard: HTMLElement } {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div class="zone zone--hand" data-zone="hand" data-owner="them"><ul class="card-backs"></ul></div>
      <div data-zone="battlefield" data-owner="them"><ul><li class="board-card" data-board-card="7" data-card-id="7"><button class="board-card__face"></button></li></ul></div>
      <div data-zone="battlefield" data-owner="you"></div>
      <div data-zone="hand" data-owner="you"></div>
      <div class="board__overlay" data-board-overlay="" />
    </div>`;
  document.body.append(canvas);
  const boxes: Record<string, Box> = {
    '[data-board-overlay]': overlay,
    '[data-zone="hand"][data-owner="them"]': { left: 100, top: 20, width: 800, height: 100 },
    '[data-zone="battlefield"][data-owner="them"]': { left: 100, top: 150, width: 800, height: 200 },
    '[data-zone="battlefield"][data-owner="you"]': { left: 100, top: 400, width: 800, height: 200 },
    '[data-zone="hand"][data-owner="you"]': { left: 100, top: 650, width: 800, height: 100 },
    '[data-board-card="7"]': { left: 120, top: 200, width: 60, height: 84 },
    ...overrides,
  };
  for (const [selector, box] of Object.entries(boxes)) {
    canvas.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(box);
  }
  return { canvas, theirCard: canvas.querySelector<HTMLElement>('[data-board-card="7"]')! };
}

/** `n` anonymous card backs in the OTHER seat's hidden hand (`HiddenHand`'s own markup), 70px apart. */
function theirHandBacks(canvas: HTMLElement, n: number): HTMLElement[] {
  const zone = canvas.querySelector('[data-zone="hand"][data-owner="them"] ul.card-backs')!;
  const backs: HTMLElement[] = [];
  for (let i = 0; i < n; i += 1) {
    const li = document.createElement('li');
    li.className = 'card-back';
    li.setAttribute('data-card-back', '');
    li.getBoundingClientRect = () => rect({ left: 100 + i * 70, top: 20, width: 60, height: 84 });
    zone.append(li);
    backs.push(li);
  }
  return backs;
}

/** `n` hand cards in the viewer's own hand, laid out in one row or two (stubbed tops). */
function ownHand(canvas: HTMLElement, n: number, rows: 1 | 2): void {
  const zone = canvas.querySelector('[data-zone="hand"][data-owner="you"]')!;
  const list = document.createElement('ul');
  for (let i = 0; i < n; i++) {
    const li = document.createElement('li');
    const top = rows === 2 && i >= Math.ceil(n / 2) ? 700 : 650;
    li.getBoundingClientRect = () => rect({ left: 100 + i * 60, top, width: 56, height: 84 });
    list.append(li);
  }
  zone.append(list);
}

function fakeTransport() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const sent: { event: string; payload: unknown }[] = [];
  return {
    transport: {
      on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
      emit: (event: string, payload: unknown) => sent.push({ event, payload }),
    },
    sent,
    receive: (payload: unknown) => handlers.get(PRESENCE_EVENT)!(payload),
    receivePlacement: (payload: unknown) => handlers.get(PLACEMENT_EVENT)!(payload),
    receivePlaced: (payload: unknown) => handlers.get(PLACED_EVENT)!(payload),
  };
}

const host = (t: ReturnType<typeof fakeTransport>, seat: number | null = 0): PresenceHost => ({
  matchId: 'm-1',
  seat,
  transport: t.transport,
  opponentName: () => 'Bella',
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  placedMod.placeSpell.mockClear();
  placedMod.moveSpell.mockClear();
  placedMod.commitSpell.mockClear();
  placedMod.onSpellMoved.mockClear();
  spellMovedBox.current = null;
  forgetPendingPlaced();
});

describe('the mirror', () => {
  it('a point is sent as a fraction of the WHOLE board, with the zone under it along for the ride as a hint only', () => {
    const { canvas } = board();
    // Over this seat's own battlefield: a board fraction, not a fraction of that zone's own box.
    const spot = spotOf(canvas, { x: 300, y: 500 })!;
    expect(spot).toEqual({ zone: 'battlefield', x: 0.3, y: 0.625 });
    // Outside every zone: still a board fraction, zone null.
    expect(spotOf(canvas, { x: 950, y: 380 })).toEqual({ zone: null, x: 0.95, y: 0.475 });
  });

  it('placeSpot mirrors the WHOLE board top-to-bottom and leaves left-right alone — no zone box scales it', () => {
    const { canvas } = board();
    // The sender's own bottom half (y=0.625, their battlefield) lands near the TOP of this board
    // (this seat's "them" battlefield, 150–350): the physical seat it belongs to is drawn there.
    expect(placeSpot(canvas, { zone: 'battlefield', x: 0.3, y: 0.625 })).toEqual({ x: 300, y: 300 });
    // x is never mirrored.
    expect(placeSpot(canvas, { zone: null, x: 0.1, y: 0.5 })).toEqual({ x: 100, y: 400 });
  });

  it('a pointer crossing the centre line and the hand edge places monotonically on a DIFFERENTLY-sized board: no per-zone scaling to drift at the seam', () => {
    const { canvas: sender } = board();
    // A board shaped like a very vertical window: a taller overlay, and a much bigger hand zone —
    // the exact mismatch that made the old zone-relative math jump at a seam.
    const { canvas: receiver } = board(
      { '[data-zone="hand"][data-owner="them"]': { left: 40, top: 10, width: 360, height: 260 } },
      { left: 0, top: 0, width: 400, height: 1400 },
    );
    // A straight line down the sender's board, crossing its centre line (y=400) and its own
    // hand's top edge (y=650).
    const ys = [100, 300, 390, 400, 410, 500, 640, 650, 660, 750];
    const placedYs = ys.map((y) => placeSpot(receiver, spotOf(sender, { x: 500, y })!)!.y);
    for (let i = 1; i < placedYs.length; i++) {
      expect(placedYs[i], `placed y at sender-y=${ys[i]} is not past placed y at sender-y=${ys[i - 1]}`).toBeLessThanOrEqual(placedYs[i - 1]!);
    }
    expect(new Set(placedYs).size, 'strictly decreasing, not just non-increasing').toBe(placedYs.length);
  });
});

describe('sending', () => {
  it('a pointer move sends the spot, throttled; leaving sends null; a held card and the arrow’s tail travel with it, never a card id', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 320, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect(t.sent, 'two moves inside one window: one message, the latest').toHaveLength(1);
    expect(t.sent[0]).toEqual({
      event: PRESENCE_EVENT,
      payload: { matchId: 'm-1', type: 'presence', pointer: { zone: 'battlefield', x: 0.32, y: 0.625 }, held: false, from: null, handRows: 1, arranging: null, placing: null, handMove: null },
    });

    // The gesture layer lifts a card and aims an arrow from it: read off its own marks.
    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'parked');
    lifted.setAttribute('data-card-id', '31');
    canvas.querySelector('.board')!.append(lifted);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-testid', 'targeter');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M 500 700 Q 1 1 300 500');
    svg.append(path);
    canvas.querySelector('[data-board-overlay]')!.append(svg);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    const second = t.sent[1]!.payload as { held: boolean; from: unknown };
    expect(second.held).toBe(true);
    expect(second.from, 'the arrow’s tail, as a board fraction').toEqual({ zone: 'hand', x: 0.5, y: 0.875 });
    expect(JSON.stringify(second), 'no card id anywhere in it').not.toContain('31');

    canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect((t.sent[2]!.payload as { pointer: unknown }).pointer).toBeNull();
    handle.dispose();
  });

  it('letting go of a held card sends at once, outside the throttle: held false, the release spot as `from`, the back gone on the other screen', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });

    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'parked');
    canvas.querySelector('.board')!.append(lifted);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect(t.sent).toHaveLength(1);

    // Let go without moving first: the release reaches the other seat with NO timer advance at all.
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 500, bubbles: true }));
    expect(t.sent, 'one message, zero ms later').toHaveLength(2);
    expect(t.sent[1]).toEqual({
      event: PRESENCE_EVENT,
      payload: {
        matchId: 'm-1',
        type: 'presence',
        pointer: { zone: 'battlefield', x: 0.3, y: 0.625 },
        held: false,
        from: { zone: 'battlefield', x: 0.3, y: 0.625 },
        handRows: 1,
        arranging: null,
        placing: { at: { zone: 'battlefield', x: 0.3, y: 0.625 } },
        handMove: null,
      },
    });

    // A card not held sends nothing special on pointerup — no spurious release message.
    lifted.remove();
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 310, clientY: 500, bubbles: true }));
    expect(t.sent, 'nothing was held: no extra message').toHaveLength(2);

    handle.dispose();
  });

  it('letting go back over the viewer’s own hand sends no `placing` — a cancelled drag, never a cast', () => {
    // `resolveLift`'s own `overOwnHand` check is what sends a card home instead of to Forge: this
    // seat's own hand zone is at (100,650)-(900,750); a release there is always that cancel.
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'parked');
    canvas.querySelector('.board')!.append(lifted);
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 500, clientY: 700, bubbles: true }));
    expect(t.sent).toHaveLength(1);
    expect((t.sent[0]!.payload as { placing: unknown }).placing, 'nothing is coming — the back must not wait').toBeNull();
    handle.dispose();
  });

  it('a spectator sends nothing, release included', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t, null) });
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 500, bubbles: true }));
    expect(t.sent).toHaveLength(0);
    handle.dispose();
  });

  it('reads its own hand’s row count off the DOM: two rows sent as 2, one row (or a lone card) as 1', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    ownHand(canvas, 6, 2);
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect((t.sent[0]!.payload as { handRows: unknown }).handRows).toBe(2);
    handle.dispose();
  });

  it('a held card, drawn at the pointer, does not count as a second row', () => {
    // The operator, 2026-10-07: "when i pull one out, they suddenly get reorganized into two rows" — the
    // lifted card's top is wherever the pointer is, and it was measured with the row.
    vi.useFakeTimers();
    const { canvas } = board();
    ownHand(canvas, 5, 1);
    const held = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"] li')!;
    held.setAttribute('data-cast-lift', 'lifted');
    held.getBoundingClientRect = () => rect({ left: 400, top: 300, width: 56, height: 84 });
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 300, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect((t.sent[0]!.payload as { handRows: unknown }).handRows).toBe(1);
    handle.dispose();
  });

  /**
   * `./gestures/hand.ts` calls `queueHandMove` once, at the commit —
   * never a card id, never a name, the two hand INDICES only, sent at once,
   * outside the throttle (the same reason `sendRelease` is).
   */
  it('queueHandMove sends at once, outside the throttle, with the two indices and nothing else new', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    queueHandMove(1, 3);
    expect(t.sent, 'sent immediately, no timer advance').toHaveLength(1);
    expect(t.sent[0]!.payload).toMatchObject({ matchId: 'm-1', type: 'presence', handMove: { from: 1, to: 3 }, arranging: null });
    handle.dispose();
  });

  it('a spectator’s queueHandMove sends nothing — there is no seat to speak for', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t, null) });
    queueHandMove(0, 1);
    expect(t.sent).toHaveLength(0);
    handle.dispose();
  });

  it('a disposed instance never hears queueHandMove again', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    handle.dispose();
    queueHandMove(0, 1);
    expect(t.sent).toHaveLength(0);
  });
});

describe('receiving', () => {
  it('their rearrange is mirrored: their card dims in place and a copy of its face follows where they hold it, until they let go', () => {
    // The operator, 2026-10-08: "at the moment the card only updates once it's actually been dropped somewhere."
    const { canvas, theirCard } = board();
    theirCard.innerHTML = '<button class="board-card__face"><article class="card" data-card-id="w7" data-testid="card"><span class="card__name">Memnite</span></article></button>';
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: false, from: null, handRows: 1, arranging: { card: 7, at: { zone: 'battlefield', x: 0.3, y: 0.5 } } });
    expect(theirCard.hasAttribute('data-arrange-dragging'), 'their card dims in place, as on their screen').toBe(true);
    const lift = canvas.querySelector<HTMLElement>('.presence__lift');
    expect(lift, 'a copy of its face follows').not.toBeNull();
    const before = lift!.style.left;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.6, y: 0.5 }, held: false, from: null, handRows: 1, arranging: { card: 7, at: { zone: 'battlefield', x: 0.6, y: 0.5 } } });
    expect(lift!.style.left).not.toBe(before);
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.6, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    expect(canvas.querySelector('.presence__lift'), 'gone when they let go').toBeNull();
    expect(theirCard.hasAttribute('data-arrange-dragging')).toBe(false);
    handle.dispose();
  });

  it('their placement (the act’s own message) reserves the column for THEIR player by card id, keeps the back waiting in the gap, and takes it down when the board has drawn the card there', async () => {
    // The operator, 2026-10-08, from the opponent's seat: the card flashed at the row's end first, and
    // the back lingered on the cursor. The column and the release point come WITH the act, through
    // the server, before any Forge frame about the card; the card's arrival is drawn in the gap.
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 77, slot: 'back', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.5, y: 0.5 } });
    expect(pendingPlacementFor(1), 'their column is reserved under their player id, for THAT card').toEqual({ cardId: 77, slot: 'back', target: { kind: 'at', column: 1 } });
    const back = canvas.querySelector<HTMLElement>('.presence__back');
    expect(back, 'the back stays — waiting, not following the pointer').not.toBeNull();
    expect(back!.hasAttribute('data-waiting')).toBe(true);
    // Their release and their pointer leaving the board change nothing: the back is the card's stand-in now.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: false, from: { zone: 'battlefield', x: 0.5, y: 0.5 }, handRows: 1, arranging: null });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1, arranging: null });
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'still waiting after their release and their pointer left').not.toBeNull();
    // The card arrives: the board draws it in the gap and consumes the reservation; the stand-in goes.
    const li = document.createElement('li');
    li.setAttribute('data-board-card', '77');
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"]')!.append(li);
    theirs = [77];
    forgetPendingPlacements();
    wake!();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(canvas.querySelector('.presence__back'), 'gone the moment the card is there').toBeNull();
    expect(canvas.querySelector('.presence__handoff'), 'and no second flight: it is already where it was placed').toBeNull();
    handle.dispose();
    forgetPendingPlacements();
  });

  /*
   * AD4 rule 2 (wave 59): a SPELL has no battlefield gap, so `placing.at` —
   * sent in the release message itself — is the only point the receiver
   * ever gets. The back waits right there until the id is public.
   */
  it('a release carrying `placing.at` waits a back at that exact point — not a gap — until their spell shows up, then hands it to the placed-cards layer', () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'stack', x: 0.4, y: 0.6 }, held: true, from: null, handRows: 1, arranging: null });
    t.receive({
      matchId: 'm-1',
      type: 'presence',
      seat: 1,
      pointer: { zone: 'stack', x: 0.4, y: 0.6 },
      held: false,
      from: { zone: 'stack', x: 0.4, y: 0.6 },
      handRows: 1,
      arranging: null,
      placing: { at: { zone: 'stack', x: 0.4, y: 0.6 } },
    });
    const back = canvas.querySelector<HTMLElement>('.presence__back');
    expect(back, 'parked, waiting').not.toBeNull();
    expect(back!.hasAttribute('data-waiting')).toBe(true);
    // Mirrored top-to-bottom, same as `placeSpot` always does: x=0.4,y=0.6 on a 1000x800 board lands at (400, 320).
    expect(back!.style.left).toBe('400px');
    expect(back!.style.top).toBe('320px');
    // Their pointer leaving the board changes nothing: the back is the spell's stand-in now.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1, arranging: null });
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'still waiting').not.toBeNull();
    expect(placedMod.commitSpell, 'not yet — the id is not public').not.toHaveBeenCalled();
    // An unrelated permanent of theirs arriving does not end the wait: it is not the awaited spell.
    const land = document.createElement('li');
    land.setAttribute('data-board-card', '9');
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"]')!.append(land);
    theirs = [9];
    wake!();
    expect(placedMod.commitSpell).not.toHaveBeenCalled();
    expect(canvas.querySelector('.presence__back'), 'the wait survives an unrelated arrival').not.toBeNull();
    // Their spell shows up on the stack (never on the battlefield): hand the point to `placed.ts`.
    theirs = [9, 48];
    wake!();
    expect(placedMod.placeSpell, 'placed at the exact point the back was waiting at, for THEIR side').toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them');
    expect(placedMod.commitSpell, 'turned over in place').toHaveBeenCalledWith(48);
    expect(canvas.querySelector('.presence__back'), 'the stand-in is gone — the placed-cards layer draws it now').toBeNull();
    handle.dispose();
  });

  it('a permanent’s own placement message is unaffected by the spell-wait path: `pendingPlacementFor` still clears it, never `commitSpell`', async () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 77, slot: 'back', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.5, y: 0.5 } });
    const li = document.createElement('li');
    li.setAttribute('data-board-card', '77');
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"]')!.append(li);
    theirs = [77];
    forgetPendingPlacements();
    wake!();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(canvas.querySelector('.presence__back'), 'gone — the reservation cleared it').toBeNull();
    expect(placedMod.commitSpell, 'a permanent is never handed to the placed-cards layer').not.toHaveBeenCalled();
    expect(placedMod.placeSpell).not.toHaveBeenCalled();
    handle.dispose();
    forgetPendingPlacements();
  });

  it('`forge:placed` moves the other seat’s copy of a placed spell they dragged — `placeSpell`, not `moveSpell`: a JOINER replaying this has no earlier registration for `moveSpell` to find', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    t.receivePlaced({ matchId: 'm-1', type: 'placed', seat: 1, spell: 48, at: { zone: 'stack', x: 0.4, y: 0.6 } });
    expect(placedMod.placeSpell).toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them');
    expect(placedMod.commitSpell).toHaveBeenCalledWith(48);
    // This seat's own echo (a resync) and another match's are both ignored.
    t.receivePlaced({ matchId: 'm-1', type: 'placed', seat: 0, spell: 49, at: { zone: 'stack', x: 0.1, y: 0.1 } });
    t.receivePlaced({ matchId: 'm-2', type: 'placed', seat: 1, spell: 50, at: { zone: 'stack', x: 0.1, y: 0.1 } });
    expect(placedMod.placeSpell).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('a `forge:placed` replay that reaches a joiner before the board itself has rendered is retried, not dropped', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    // The board is still "Connecting…": no overlay yet for `placeSpot` to place anything on.
    const overlay = canvas.querySelector('[data-board-overlay]')!;
    overlay.remove();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    t.receivePlaced({ matchId: 'm-1', type: 'placed', seat: 1, spell: 48, at: { zone: 'stack', x: 0.4, y: 0.6 } });
    expect(placedMod.placeSpell, 'nothing to place it on yet').not.toHaveBeenCalled();
    canvas.querySelector('.board')!.append(overlay);
    vi.advanceTimersByTime(60);
    expect(placedMod.placeSpell, 'retried once the board painted').toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them');
    expect(placedMod.commitSpell).toHaveBeenCalledWith(48);
    handle.dispose();
  });

  it('a `forge:placed` replay a disposed mount could not place survives to the NEXT mount — `installPresence` itself remounts several times while a page connects', () => {
    const { canvas } = board();
    const overlay = canvas.querySelector('[data-board-overlay]')!;
    overlay.remove();
    const t = fakeTransport();
    // The first mount (a spectator, briefly, before promotion to its own seat) receives the
    // one-time replay with no board to place it on, and is torn down before one ever paints.
    const first = installPresence({ canvas, host: host(t, null) });
    t.receivePlaced({ matchId: 'm-1', type: 'placed', seat: 1, spell: 48, at: { zone: 'stack', x: 0.4, y: 0.6 } });
    expect(placedMod.placeSpell).not.toHaveBeenCalled();
    first.dispose();
    // The board paints, THEN the next mount (promoted to seat 0) starts — no second replay ever
    // comes; it has to find this one for itself.
    canvas.querySelector('.board')!.append(overlay);
    const second = installPresence({ canvas, host: host(t, 0) });
    expect(placedMod.placeSpell, 'the next mount retried it at its own start').toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them');
    expect(placedMod.commitSpell).toHaveBeenCalledWith(48);
    second.dispose();
  });

  it('this seat dragging its own placed spell (`onSpellMoved`) sends `forge:placed`; the wire’s own echo for THEIR spell never bounces back out', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: { ...host(t), theirCards: () => [48] } });
    expect(spellMovedBox.current, 'subscribed at install').not.toBeNull();
    // This seat's own spell (not in `theirCards`): sent.
    spellMovedBox.current!(31, { x: 300, y: 200 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toEqual({ event: PLACED_EVENT, payload: { matchId: 'm-1', type: 'placed', spell: 31, at: { zone: 'battlefield', x: 0.3, y: 0.25 } } });
    // Their spell (in `theirCards` — this is `moveSpell`'s own notification from `onPlaced`, above): not resent.
    spellMovedBox.current!(48, { x: 300, y: 200 });
    expect(t.sent, 'the wire’s own echo never bounces back out').toHaveLength(1);
    handle.dispose();
  });

  it('draws their cursor with their name where their spot lands, a back while held, an arrow while aiming, and a hint on the card under it', () => {
    vi.useFakeTimers();
    const { canvas, theirCard } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    // Their pointer over THEIR own battlefield's first card: lands on this board's "them" battlefield, over card 7.
    document.elementFromPoint = (x: number, y: number) => (x >= 120 && x <= 180 && y >= 200 && y <= 284 ? theirCard.firstElementChild : null);
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.15, y: 0.6875 }, held: true, from: { zone: 'hand', x: 0.5, y: 0.875 }, handRows: 1, arranging: null });
    const cursor = overlay.querySelector<HTMLElement>('.presence')!;
    expect(cursor, 'the cursor').not.toBeNull();
    expect(cursor.style.left).toBe('150px');
    expect(cursor.style.top).toBe('250px');
    expect(cursor.querySelector('.presence__name')!.textContent).toBe('Bella');
    expect(overlay.querySelector('.presence__back'), 'a card back').not.toBeNull();
    expect(overlay.querySelector('.presence__back')!.hasAttribute('data-card-id'), 'that is not a card the DOM can address').toBe(false);
    expect(overlay.querySelector('.presence__arrow path')!.getAttribute('d'), 'the arrow from their hand to the pointer, while held').toMatch(/^M 500 100 Q /);
    expect(theirCard.hasAttribute('data-presence-hint'), 'the card under their pointer is hinted').toBe(true);

    // They let go and move on, with no explicit release reaching this seat first (the regular,
    // throttled path): no back, no arrow — `from` is never drawn as an arrow once not held.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.9, y: 0.1 }, held: false, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence__back')).toBeNull();
    expect(overlay.querySelector('.presence__arrow')).toBeNull();
    expect(theirCard.hasAttribute('data-presence-hint')).toBe(false);
    expect(overlay.querySelectorAll('.presence'), 'still one cursor').toHaveLength(1);

    // Silence: taken down after PRESENCE_STALE_MS.
    vi.advanceTimersByTime(PRESENCE_STALE_MS + 1);
    expect(overlay.querySelector('.presence')).toBeNull();
    handle.dispose();
  });

  it('a release message (held false, `from` the release spot) never draws an arrow, even though `from` is non-null', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: true, from: null, handRows: 1, arranging: null });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: false, from: { zone: 'battlefield', x: 0.3, y: 0.5 }, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence__back'), 'gone on the release message').toBeNull();
    expect(overlay.querySelector('.presence__arrow'), 'no arrow drawn from a release spot').toBeNull();
    handle.dispose();
  });

  it('their hand rows (handRows on the wire) set `data-presence-rows` on the hidden hand; 1 clears it', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const theirHand = canvas.querySelector('[data-zone="hand"][data-owner="them"]')!;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 2, arranging: null });
    expect(theirHand.getAttribute('data-presence-rows'), 'their hand draws two rows').toBe('2');
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    expect(theirHand.hasAttribute('data-presence-rows'), 'back to one row: no attribute').toBe(false);
    handle.dispose();
  });

  /**
   * The other half: a `handMove` echo glides a back of THEIR hidden
   * hand from one position to another — never the card's id or name
   * (`queueHandMove`'s own doc comment has the reason), and every back is
   * interchangeable, so there is nothing for the RESTING state to prove;
   * only the motion is the signal.
   *
   * Mutation: drop `glideHandMove`'s own call in `draw` and this is the one
   * case that fails — nothing else here reads `echo.handMove` at all.
   */
  it('bob sees a back in alice’s hand move from position 0 to 2', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    theirHandBacks(canvas, 4);
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1, arranging: null, handMove: { from: 0, to: 2 } });
    const ghost = canvas.querySelector<HTMLElement>('[data-board-overlay] .presence__back[data-waiting]')!;
    expect(ghost, 'a back glides, even with no pointer in the message at all').not.toBeNull();
    expect(ghost.style.left, 'starts at position 0’s centre').toBe('130px'); // 100 + 0*70 + 30 (half of 60) − overlay left 0
    vi.advanceTimersByTime(16); // the glide's own requestAnimationFrame
    expect(ghost.style.left, 'ends at position 2’s centre').toBe('270px'); // 100 + 2*70 + 30
    vi.advanceTimersByTime(HAND_MOVE_MS);
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'removed once the glide finishes').toBeNull();
    handle.dispose();
  });

  it('an out-of-range handMove (the hand resized mid-flight) draws nothing and throws nothing', () => {
    const { canvas } = board();
    theirHandBacks(canvas, 2);
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    expect(() =>
      t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1, arranging: null, handMove: { from: 0, to: 9 } }),
    ).not.toThrow();
    expect(canvas.querySelector('.presence__back[data-waiting]')).toBeNull();
    handle.dispose();
  });

  it('the handoff: their back goes and a card of theirs appears — a copy travels from the back’s place to the card (motion on)', () => {
    vi.useFakeTimers();
    const { canvas, theirCard } = board();
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, motion: () => true },
    });
    // They hold a card over their battlefield, then let go with no explicit release reaching this
    // seat (the fallback path: the last place the back was actually drawn).
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: true, from: null, handRows: 1, arranging: null });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    expect(canvas.querySelector('.presence__back')).toBeNull();
    // Forge puts card 7 on their battlefield (the fixture's one card of theirs), and the match wakes its subscribers.
    theirs = [7];
    theirCard.innerHTML = '<button class="board-card__face"><article class="card" data-card-id="w7" data-testid="card"><span class="card__name">Their Card</span></article></button>';
    wake!();
    const ghost = canvas.querySelector<HTMLElement>('.presence__handoff')!;
    expect(ghost, 'a copy of the card travels').not.toBeNull();
    // The same trip a played card makes: `landCastGhost` paints it at the back's place, then sends it home
    // (`returning`, the transition) to the card's own centre, which is where its style already points.
    expect(ghost.getAttribute('data-cast-lift'), 'on the same trip a played card makes').toBe('returning');
    expect(ghost.style.left, 'bound for the card’s centre').toBe('150px');
    expect(ghost.style.top).toBe('242px');
    expect(ghost.querySelector('.card__name')!.textContent).toBe('Their Card');
    expect(ghost.querySelector('[data-card-id]'), 'the copy is not a card the DOM can address').toBeNull();
    expect(theirCard.hasAttribute('data-cast-landing'), 'the real card waits hidden in its slot').toBe(true);
    // A later arrival, with no back gone just before it, is not a handoff.
    vi.advanceTimersByTime(3000);
    theirs = [7, 8];
    wake!();
    expect(canvas.querySelectorAll('.presence__handoff'), 'only the one').toHaveLength(0);
    handle.dispose();
  });

  it('the hand-off flight starts from the RELEASE message’s own `from`, not from wherever the back was last drawn', () => {
    const { canvas, theirCard } = board();
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, motion: () => true },
    });
    const spy = vi.spyOn(castModule, 'landCastGhost').mockImplementation(() => undefined);
    // Held at one spot (x=0.1,y=0.1 → placed 100,720), then let go at a DIFFERENT, explicit spot
    // (x=0.5,y=0.5 → placed 500,400) — the throttled stream could easily be stale by release time,
    // so the flight must read the release message's own `from`, not the earlier held position.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.1, y: 0.1 }, held: true, from: null, handRows: 1, arranging: null });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: false, from: { zone: 'battlefield', x: 0.5, y: 0.5 }, handRows: 1, arranging: null });
    theirs = [7];
    theirCard.innerHTML = '<button class="board-card__face"><article class="card" data-card-id="w7" data-testid="card"><span class="card__name">Their Card</span></article></button>';
    wake!();
    expect(spy, 'the flight was started').toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![3], 'from the release spot (500,400), not the held spot (100,720)').toEqual({ x: 500, y: 400 });
    spy.mockRestore();
    handle.dispose();
  });

  it('their pointer leaving their board takes the cursor down; this seat’s own echo and another match’s are ignored', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence')).not.toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence')).toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 0, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    t.receive({ matchId: 'm-2', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence'), 'neither drawn').toBeNull();
    handle.dispose();
  });
});
