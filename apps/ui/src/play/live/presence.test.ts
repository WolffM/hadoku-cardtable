// @vitest-environment jsdom
/*
 * Presence (ledger Z5), `presence.ts`: the mirror between the two boards, what
 * is sent, and what is drawn. jsdom gives every element a zero rect, so the
 * geometry here comes from stubbed `getBoundingClientRect`s with real numbers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_EVENT, PRESENCE_SEND_MS } from '@hadoku/shared';

import { installPresence, placeSpot, PRESENCE_STALE_MS, spotOf, type PresenceHost } from './presence.ts';

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect =>
  ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

/** A board: the overlay covering it, both seats' battlefields and hands, one card of theirs. */
function board(): { canvas: HTMLElement; theirCard: HTMLElement } {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div data-zone="hand" data-owner="them"></div>
      <div data-zone="battlefield" data-owner="them"><ul><li class="board-card" data-board-card="7" data-card-id="7"><button class="board-card__face"></button></li></ul></div>
      <div data-zone="battlefield" data-owner="you"></div>
      <div data-zone="hand" data-owner="you"></div>
      <div class="board__overlay" data-board-overlay=""></div>
    </div>`;
  document.body.append(canvas);
  const boxes: Record<string, Box> = {
    '[data-board-overlay]': { left: 0, top: 0, width: 1000, height: 800 },
    '[data-zone="hand"][data-owner="them"]': { left: 100, top: 20, width: 800, height: 100 },
    '[data-zone="battlefield"][data-owner="them"]': { left: 100, top: 150, width: 800, height: 200 },
    '[data-zone="battlefield"][data-owner="you"]': { left: 100, top: 400, width: 800, height: 200 },
    '[data-zone="hand"][data-owner="you"]': { left: 100, top: 650, width: 800, height: 100 },
    '[data-board-card="7"]': { left: 120, top: 200, width: 60, height: 84 },
  };
  for (const [selector, box] of Object.entries(boxes)) {
    canvas.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(box);
  }
  return { canvas, theirCard: canvas.querySelector<HTMLElement>('[data-board-card="7"]')! };
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
  it('a point in a zone is sent as that zone and a fraction of it; the other board places it in the SAME zone of the OTHER owner', () => {
    const { canvas } = board();
    // Over this seat's own battlefield, a quarter across and halfway down.
    const spot = spotOf(canvas, { x: 300, y: 500 })!;
    expect(spot).toEqual({ zone: 'battlefield', owner: 'you', x: 0.25, y: 0.5 });
    // Received by the other board (the same layout here): their "you" is this board's "them".
    const placed = placeSpot(canvas, spot)!;
    expect(placed).toEqual({ x: 300, y: 250 });
  });

  it('a point outside every zone is a fraction of the board, and lands at the same fraction', () => {
    const { canvas } = board();
    const spot = spotOf(canvas, { x: 950, y: 380 })!;
    expect(spot).toEqual({ zone: null, owner: null, x: 0.95, y: 0.475 });
    expect(placeSpot(canvas, spot)).toEqual({ x: 950, y: 380 });
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
      payload: { matchId: 'm-1', type: 'presence', pointer: { zone: 'battlefield', owner: 'you', x: 0.275, y: 0.5 }, held: false, from: null },
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
    expect(second.from, 'the arrow’s tail, in the hand it was lifted from').toEqual({ zone: 'hand', owner: 'you', x: 0.5, y: 0.5 });
    expect(JSON.stringify(second), 'no card id anywhere in it').not.toContain('31');

    canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect((t.sent[2]!.payload as { pointer: unknown }).pointer).toBeNull();
    handle.dispose();
  });

  it('a spectator sends nothing', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t, null) });
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect(t.sent).toHaveLength(0);
    handle.dispose();
  });
});

describe('receiving', () => {
  it('draws their cursor with their name where their spot lands, a back while held, an arrow while aiming, and a hint on the card under it', () => {
    vi.useFakeTimers();
    const { canvas, theirCard } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    // Their pointer over THEIR own battlefield's first card: lands on this board's "them" battlefield, over card 7.
    document.elementFromPoint = (x: number, y: number) => (x >= 120 && x <= 180 && y >= 200 && y <= 284 ? theirCard.firstElementChild : null);
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', owner: 'you', x: 0.0625, y: 0.5 }, held: true, from: { zone: 'hand', owner: 'you', x: 0.5, y: 0.5 } });
    const cursor = overlay.querySelector<HTMLElement>('.presence')!;
    expect(cursor, 'the cursor').not.toBeNull();
    expect(cursor.style.left).toBe('150px');
    expect(cursor.style.top).toBe('250px');
    expect(cursor.querySelector('.presence__name')!.textContent).toBe('Bella');
    expect(overlay.querySelector('.presence__back'), 'a card back').not.toBeNull();
    expect(overlay.querySelector('.presence__back')!.hasAttribute('data-card-id'), 'that is not a card the DOM can address').toBe(false);
    expect(overlay.querySelector('.presence__arrow path')!.getAttribute('d'), 'the arrow from their hand (this board’s top row) to the pointer').toMatch(/^M 500 70 Q /);
    expect(theirCard.hasAttribute('data-presence-hint'), 'the card under their pointer is hinted').toBe(true);

    // They let go and move on: no back, no arrow, no hint.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, owner: null, x: 0.9, y: 0.1 }, held: false, from: null });
    expect(overlay.querySelector('.presence__back')).toBeNull();
    expect(overlay.querySelector('.presence__arrow')).toBeNull();
    expect(theirCard.hasAttribute('data-presence-hint')).toBe(false);
    expect(overlay.querySelectorAll('.presence'), 'still one cursor').toHaveLength(1);

    // Silence: taken down after PRESENCE_STALE_MS.
    vi.advanceTimersByTime(PRESENCE_STALE_MS + 1);
    expect(overlay.querySelector('.presence')).toBeNull();
    handle.dispose();
  });

  it('their pointer leaving their board takes the cursor down; this seat’s own echo and another match’s are ignored', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, owner: null, x: 0.5, y: 0.5 }, held: false, from: null });
    expect(overlay.querySelector('.presence')).not.toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null });
    expect(overlay.querySelector('.presence')).toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 0, pointer: { zone: null, owner: null, x: 0.5, y: 0.5 }, held: false, from: null });
    t.receive({ matchId: 'm-2', type: 'presence', seat: 1, pointer: { zone: null, owner: null, x: 0.5, y: 0.5 }, held: false, from: null });
    expect(overlay.querySelector('.presence'), 'neither drawn').toBeNull();
    handle.dispose();
  });
});
