// @vitest-environment jsdom
/*
 * Presence (ledger Z5), `presence.ts`: the mirror between the two boards, what
 * is sent, and what is drawn. jsdom gives every element a zero rect, so the
 * geometry here comes from stubbed `getBoundingClientRect`s with real numbers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_EVENT, PRESENCE_SEND_MS } from '@hadoku/shared';

import * as castModule from './gestures/cast.ts';
import { forgetPendingPlacements, pendingPlacementFor } from '../Board.tsx';
import { installPresence, placeSpot, PRESENCE_STALE_MS, spotOf, type PresenceHost } from './presence.ts';

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
      payload: { matchId: 'm-1', type: 'presence', pointer: { zone: 'battlefield', x: 0.32, y: 0.625 }, held: false, from: null, handRows: 1, placing: null },
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
        placing: null,
      },
    });

    // A card not held sends nothing special on pointerup — no spurious release message.
    lifted.remove();
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 310, clientY: 500, bubbles: true }));
    expect(t.sent, 'nothing was held: no extra message').toHaveLength(2);

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
});

describe('receiving', () => {
  it('a release that names a column reserves it for THEIR player, keeps the back waiting in it, and takes the back down when a card of theirs reaches their battlefield', () => {
    // The operator, 2026-10-08, from the opponent's seat: the card flashed at the row's end first, and
    // the back lingered on the cursor. The column travels with the release; the card's arrival is
    // drawn in the reserved gap; the back goes then, not on a timer.
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: true, from: null, handRows: 1 });
    t.receive({
      matchId: 'm-1',
      type: 'presence',
      seat: 1,
      pointer: { zone: 'battlefield', x: 0.5, y: 0.5 },
      held: false,
      from: { zone: 'battlefield', x: 0.5, y: 0.5 },
      handRows: 1,
      placing: { slot: 'back', target: { kind: 'at', column: 1 } },
    });
    expect(pendingPlacementFor(1), 'their column is reserved under their player id').toEqual({ cardId: null, slot: 'back', target: { kind: 'at', column: 1 } });
    const back = canvas.querySelector<HTMLElement>('.presence__back');
    expect(back, 'the back stays — waiting, not following the pointer').not.toBeNull();
    expect(back!.hasAttribute('data-waiting')).toBe(true);
    // Their pointer leaves the board: the cursor goes, the waiting back does not.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1 });
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'still waiting after their pointer left').not.toBeNull();
    // The card shows on their battlefield (the board drew it in the gap): the stand-in simply goes.
    const li = document.createElement('li');
    li.setAttribute('data-board-card', '77');
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"]')!.append(li);
    theirs = [77];
    wake!();
    expect(canvas.querySelector('.presence__back'), 'gone the moment the card is there').toBeNull();
    expect(canvas.querySelector('.presence__handoff'), 'and no second flight: it is already where it was placed').toBeNull();
    handle.dispose();
    forgetPendingPlacements();
  });

  it('draws their cursor with their name where their spot lands, a back while held, an arrow while aiming, and a hint on the card under it', () => {
    vi.useFakeTimers();
    const { canvas, theirCard } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    // Their pointer over THEIR own battlefield's first card: lands on this board's "them" battlefield, over card 7.
    document.elementFromPoint = (x: number, y: number) => (x >= 120 && x <= 180 && y >= 200 && y <= 284 ? theirCard.firstElementChild : null);
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.15, y: 0.6875 }, held: true, from: { zone: 'hand', x: 0.5, y: 0.875 }, handRows: 1 });
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
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.9, y: 0.1 }, held: false, from: null, handRows: 1 });
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
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: true, from: null, handRows: 1 });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: false, from: { zone: 'battlefield', x: 0.3, y: 0.5 }, handRows: 1 });
    expect(overlay.querySelector('.presence__back'), 'gone on the release message').toBeNull();
    expect(overlay.querySelector('.presence__arrow'), 'no arrow drawn from a release spot').toBeNull();
    handle.dispose();
  });

  it('their hand rows (handRows on the wire) set `data-presence-rows` on the hidden hand; 1 clears it', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const theirHand = canvas.querySelector('[data-zone="hand"][data-owner="them"]')!;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 2 });
    expect(theirHand.getAttribute('data-presence-rows'), 'their hand draws two rows').toBe('2');
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1 });
    expect(theirHand.hasAttribute('data-presence-rows'), 'back to one row: no attribute').toBe(false);
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
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: true, from: null, handRows: 1 });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1 });
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
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.1, y: 0.1 }, held: true, from: null, handRows: 1 });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: false, from: { zone: 'battlefield', x: 0.5, y: 0.5 }, handRows: 1 });
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
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1 });
    expect(overlay.querySelector('.presence')).not.toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1 });
    expect(overlay.querySelector('.presence')).toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 0, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1 });
    t.receive({ matchId: 'm-2', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1 });
    expect(overlay.querySelector('.presence'), 'neither drawn').toBeNull();
    handle.dispose();
  });
});
