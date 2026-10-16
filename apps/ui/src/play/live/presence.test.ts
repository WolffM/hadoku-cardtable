// @vitest-environment jsdom
/*
 * Presence (ledger Z5), `presence.ts`: the mirror between the two boards, what
 * is sent, and what is drawn. jsdom gives every element a zero rect, so the
 * geometry here comes from stubbed `getBoundingClientRect`s with real numbers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLACED_EVENT, PLACEMENT_EVENT, PRESENCE_EVENT, PRESENCE_SEND_MS } from '@hadoku/shared';

import { forgetPendingPlacements, pendingPlacementFor } from '../Board.tsx';
import { GLIDE_MS, PLACEMENT_WAIT_MS } from '../motion.ts';

/*
 * `placed.ts` (lane S) is the seam this module calls into for the stack
 * layer's own drawing (`placeSpell`/`placeStackItem`/`moveSpell`/`commitSpell`/`onSpellMoved`)
 * — this module "calls them and never draws" (wave 59's Settled seam). Mocked
 * here so this file's own receive/send logic proves itself without needing
 * that drawing layer at all.
 */
const { placedMod, spellMovedBox } = vi.hoisted(() => {
  const spellMovedBox: { current: ((id: number, at: { x: number; y: number }) => void) | null } = { current: null };
  const placedMod = {
    placeSpell: vi.fn(),
    placeStackItem: vi.fn(),
    moveSpell: vi.fn(),
    commitSpell: vi.fn(),
    holdSpell: vi.fn(),
    releaseSpell: vi.fn(),
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

import { forgetPendingPlaced, anchorOf, installPresence, placeAnchor, placeSpot, PRESENCE_STALE_MS, queueHandMove, spotOf, type PresenceHost, CLEARED_GRACE_MS, PARKED_RESTATE_MS } from './presence.ts';

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
    li.className = 'board-card';
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

/**
 * `aiming` defaults to `true` here (never in production, where the host must
 * wire its own reader — see `presence.ts`'s own doc comment): every existing
 * fixture in this file that lifts a card or aims an arrow is exactly the
 * "actively aiming" case item 3 means, and defaulting it on lets those keep
 * testing `from` without each threading the flag through by hand. The one
 * test for item 3 itself (a parked card reports no `from` when
 * NOT aiming) overrides it explicitly.
 */
const host = (t: ReturnType<typeof fakeTransport>, seat: number | null = 0): PresenceHost => ({
  matchId: 'm-1',
  seat,
  transport: t.transport,
  opponentName: () => 'Bella',
  aiming: () => true,
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  placedMod.placeSpell.mockClear();
  placedMod.placeStackItem.mockClear();
  placedMod.moveSpell.mockClear();
  placedMod.commitSpell.mockClear();
  placedMod.holdSpell.mockClear();
  placedMod.releaseSpell.mockClear();
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

describe('anchorOf', () => {
  it('over a battlefield card: the zone, whose, the card by its (public) id and the pointer’s offset in THAT card’s own box', () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    // theirCard's box is (120,200)-(180,284); (138,242) is 0.3 across, 0.5 down it.
    const anchor = anchorOf(canvas, { x: 138, y: 242 });
    expect(anchor).toEqual({ zone: 'battlefield', own: false, row: null, card: 7, item: null, x: 0.3, y: 0.5 });
  });

  it('between cards it is still the NEAREST card, offset past its edge — continuous, never a snap', () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    // 20px right of the card's right edge (180): x = (200 - 120) / 60.
    const anchor = anchorOf(canvas, { x: 200, y: 242 })!;
    expect(anchor.card).toBe(7);
    expect(anchor.x).toBeCloseTo(80 / 60, 6);
  });

  it('over the viewer’s OWN hand: the slot index, never the card’s id', () => {
    const { canvas } = board();
    ownHand(canvas, 3, 1);
    document.elementFromPoint = () => null;
    // The second card's box is (160,650)-(216,734) per `ownHand`; (188,692) is its centre.
    const anchor = anchorOf(canvas, { x: 188, y: 692 });
    expect(anchor).toEqual({ zone: 'hand', own: true, row: null, card: null, item: 1, x: 0.5, y: 0.5 });
  });

  it('over the OTHER seat’s hand: the back’s index — the receiver draws that hand face up, and an index tells nothing the backs did not', () => {
    const { canvas } = board();
    theirHandBacks(canvas, 2);
    document.elementFromPoint = () => null;
    expect(anchorOf(canvas, { x: 200, y: 62 })).toEqual({ zone: 'hand', own: false, row: null, card: null, item: 1, x: 0.5, y: 0.5 });
  });

  it('a battlefield tier or lane with no card in it rides by NAME', () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const tier = document.createElement('ul');
    tier.setAttribute('data-tier', 'back');
    tier.getBoundingClientRect = () => rect({ left: 100, top: 500, width: 800, height: 100 });
    canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!.append(tier);
    expect(anchorOf(canvas, { x: 300, y: 550 })).toEqual({ zone: 'battlefield', own: true, row: 'back', card: null, item: null, x: 0.25, y: 0.5 });
  });

  it('outside every zone, or over a stack card (itself placed by the board fraction): null — the board fraction is all that is sent', () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    expect(anchorOf(canvas, { x: 950, y: 380 })).toBeNull();
    const spell = document.createElement('div');
    spell.setAttribute('data-placed-spell', '12');
    document.elementFromPoint = () => spell;
    expect(anchorOf(canvas, { x: 138, y: 242 })).toBeNull();
    document.elementFromPoint = () => null;
  });
});

describe('sending', () => {
  it('a rearrange sends the card and its lifted copy’s offset from the card’s own home, in units of the card — never a board fraction', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const home = document.createElement('li');
    home.className = 'board-card';
    home.setAttribute('data-card-id', '3');
    home.setAttribute('data-arrange-dragging', '');
    home.getBoundingClientRect = () => rect({ left: 300, top: 450, width: 60, height: 84 });
    canvas.querySelector('[data-zone="battlefield"][data-owner="you"]')!.append(home);
    // The ghost is drawn scaled up (`board.css`), so its box is bigger; only its centre counts.
    const ghost = document.createElement('li');
    ghost.className = 'board-card';
    ghost.setAttribute('data-arrange-ghost', '3');
    ghost.getBoundingClientRect = () => rect({ left: 330 + 15 - 32.4, top: 492 + 8.4 - 45.36, width: 64.8, height: 90.72 });
    canvas.querySelector('.board')!.append(ghost);
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 345, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    const sent = t.sent[0]!.payload as { arranging: { card: number; x: number; y: number }; anchor: { card: number } };
    expect(sent.arranging.card).toBe(3);
    expect(sent.arranging.x).toBeCloseTo(0.25, 6);
    expect(sent.arranging.y).toBeCloseTo(0.1, 6);
    expect(sent.anchor.card, 'the cursor is anchored to the same card').toBe(3);
    handle.dispose();
  });

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
      payload: { matchId: 'm-1', type: 'presence', pointer: { zone: 'battlefield', x: 0.32, y: 0.625 }, anchor: { zone: 'battlefield', own: true, row: null, card: null, item: null, x: 0.275, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null, placing: null, handMove: null },
    });

    // The gesture layer lifts a card and aims an arrow from it: read off its own marks.
    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'lifted');
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

  /**
   * The operator saw an arrow draw on the other screen for a
   * parked card with no target at all, and again while picking Condescend's
   * X (a selection, not an arrow-worthy aim). `from` must be null whenever
   * THIS seat is not actually aiming, held or not — this is item 3's own
   * mutation point (6b): keeping `from` for a parked card with no selection
   * open is exactly the bug.
   */
  it('a parked card is NOT held: every message says where it stands (`placing.at`), and no `from` unless this seat is actually aiming', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: { ...host(t), aiming: () => false } });
    const parked = document.createElement('li');
    parked.setAttribute('data-cast-lift', 'parked');
    parked.getBoundingClientRect = () => rect({ left: 270, top: 370, width: 60, height: 84 }); // centre (300, 412)
    canvas.querySelector('.board')!.append(parked);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    const first = t.sent[0]!.payload as { held: boolean; from: unknown; placing: unknown };
    expect(first.held, 'parked is not held — the pointer is free of it').toBe(false);
    expect(first.placing, 'where it stands, on a plain move too').toEqual({ at: { zone: 'battlefield', x: 0.3, y: 0.515 } });
    expect(first.from, 'not aiming: no tail to send').toBeNull();
    // Her pointer goes to the pop-up: the card stands exactly where it was (the operator, 2026-10-08:
    // "as my cursor moves to answer the question … the phantom card is still attached. that's nonsense").
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 100, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    const second = t.sent[1]!.payload as { held: boolean; pointer: { x: number }; placing: unknown };
    expect(second.pointer.x).toBe(0.8);
    expect(second.held).toBe(false);
    expect(second.placing, 'the same stand, pointer or no pointer').toEqual({ at: { zone: 'battlefield', x: 0.3, y: 0.515 } });
    handle.dispose();
  });

  it('a parked card with the pointer at rest is said again every PARKED_RESTATE_MS, and no more once it is gone', () => {
    // w35's Thoughtseize: the target ask stayed open for over fifteen seconds with her pointer still,
    // nothing was sent, and the other screen's clock took the back down before the spell was cast.
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: { ...host(t), aiming: () => false } });
    const parked = document.createElement('li');
    parked.setAttribute('data-cast-lift', 'parked');
    parked.getBoundingClientRect = () => rect({ left: 270, top: 370, width: 60, height: 84 });
    canvas.querySelector('.board')!.append(parked);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect(t.sent).toHaveLength(1);
    vi.advanceTimersByTime(PARKED_RESTATE_MS * 3);
    expect(t.sent, 'said again on the restate clock, the same message each time').toHaveLength(4);
    for (const m of t.sent) expect(m.payload).toEqual(t.sent[0]!.payload);
    parked.remove();
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 310, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    const n = t.sent.length;
    expect((t.sent[n - 1]!.payload as { placing: unknown }).placing, 'gone: said once').toBeNull();
    vi.advanceTimersByTime(PARKED_RESTATE_MS * 3);
    expect(t.sent, 'nothing parked, nothing restated').toHaveLength(n);
    handle.dispose();
  });

  it('the three states are spoken the moment they change, with no pointer move at all: lifted, parked, gone', async () => {
    // The operator, 2026-10-08: "after the question is answered, the card correctly animates to
    // the right spot but the phantom card is STILL attached to the cursor until i move the mouse
    // again." The gesture layer's own mark changing is the event; the pointer is not consulted.
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: { ...host(t), aiming: () => false } });
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 500, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    expect(t.sent).toHaveLength(1);
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const card = document.createElement('li');
    card.getBoundingClientRect = () => rect({ left: 270, top: 370, width: 60, height: 84 });
    canvas.querySelector('.board')!.append(card);
    card.setAttribute('data-cast-lift', 'lifted');
    await settle();
    expect(t.sent, 'lifted: spoken at once, no timer advanced').toHaveLength(2);
    expect(t.sent[1]!.payload).toMatchObject({ held: true, placing: null });
    card.setAttribute('data-cast-lift', 'parked');
    await settle();
    expect(t.sent, 'parked: spoken at once').toHaveLength(3);
    expect(t.sent[2]!.payload).toMatchObject({ held: false, placing: { at: { zone: 'battlefield', x: 0.3, y: 0.515 } } });
    card.setAttribute('data-cast-lift', 'returning');
    await settle();
    expect(t.sent, 'on its way home (or landed): spoken at once').toHaveLength(4);
    expect(t.sent[3]!.payload).toMatchObject({ held: false, placing: null });
    card.remove();
    await settle();
    expect(t.sent, 'the element going does not say anything new').toHaveLength(4);
    handle.dispose();
  });

  /*
   * AE18 (2026-10-08, the operator, a second report on top of AE12: "it looks
   * like we have two sets of card play animations going on... a new card
   * phantom pops into the cursor"): `settleParkedIfResolved`
   * (`gestures/install.ts`) sets `CAST_LANDING_ATTR` on the real card the
   * exact frame landing is confirmed, but the ghost's own `data-cast-lift`
   * does not flip to `'returning'` until the NEXT animation frame
   * (`landCastGhost`'s own one-frame wait for a painted start point). A
   * regular, throttled presence tick that lands in that one frame still
   * finds the ghost `'parked'` and would send `placing.at` once more for a
   * card this seat already knows is landing.
   */
  it('a card mid-landing — CAST_LANDING_ATTR set, the ghost not yet flipped to returning — sends neither held nor parked (AE18, the sender half)', async () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: { ...host(t), aiming: () => false } });
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const ghost = document.createElement('li');
    ghost.getBoundingClientRect = () => rect({ left: 270, top: 370, width: 60, height: 84 });
    canvas.querySelector('.board')!.append(ghost);
    ghost.setAttribute('data-cast-lift', 'parked');
    await settle();
    expect(t.sent, 'parked: spoken at once').toHaveLength(1);
    expect(t.sent[0]!.payload).toMatchObject({ held: false, placing: { at: { zone: 'battlefield', x: 0.3, y: 0.515 } } });

    // The real card has landed (`settleParkedIfResolved`'s own synchronous mark) — the ghost's
    // `data-cast-lift` has NOT changed yet (still `'parked'`, exactly as `landCastGhost` left it
    // one frame ago). A regular pointer-driven tick, not the lift-change observer, is what a
    // tick straddling this exact frame would be.
    const real = document.createElement('li');
    real.setAttribute('data-cast-landing', '');
    canvas.querySelector('.board')!.append(real);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 301, clientY: 501, bubbles: true }));
    vi.advanceTimersByTime(PRESENCE_SEND_MS + 1);
    const last = t.sent[t.sent.length - 1]!.payload;
    expect(last, 'landing in progress: neither held nor parked, whatever the ghost still says').toMatchObject({ held: false, placing: null });
    handle.dispose();
  });

  it('letting go of a held card sends at once, outside the throttle: held false, the release spot as `placing.at`, no `from`', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });

    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'lifted');
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
        anchor: { zone: 'battlefield', own: true, row: null, card: null, item: null, x: 0.25, y: 0.5 },
        held: false,
        from: null,
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

  it('the release reads the lifted card’s OWN box centre, not the raw pointerup coordinates', () => {
    // No `pointermove` fires between the card's last drawn spot and the up event — exactly the
    // gap the operator saw as "a bit of desync between where the phantom card was and where the
    // cursor actually released the card." The lifted element's own rect is what `drawCastLift`
    // last positioned it at; the up event's own (different) coordinates must lose.
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'lifted');
    lifted.getBoundingClientRect = () => rect({ left: 270, top: 370, width: 60, height: 84 }); // centre (300, 412)
    canvas.querySelector('.board')!.append(lifted);
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 320, clientY: 440, bubbles: true }));
    expect(t.sent).toHaveLength(1);
    const payload = t.sent[0]!.payload as { pointer: { x: number; y: number } };
    // (300,412) on a 1000x800 board is x=0.3, y=0.515 — the card's centre, not the event's (320,440).
    expect(payload.pointer).toEqual({ zone: 'battlefield', x: 0.3, y: 0.515 });
    handle.dispose();
  });

  it('letting go back over the viewer’s own hand sends no `placing` — a cancelled drag, never a cast', () => {
    // `resolveLift`'s own `overHome` check is what sends a card home instead of to Forge: this
    // seat's own hand zone is at (100,650)-(900,750); a release there is always that cancel.
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'lifted');
    canvas.querySelector('[data-zone="hand"][data-owner="you"]')!.append(lifted);
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 500, clientY: 700, bubbles: true }));
    expect(t.sent).toHaveLength(1);
    expect((t.sent[0]!.payload as { placing: unknown }).placing, 'nothing is coming — the back must not wait').toBeNull();
    handle.dispose();
  });

  it('a card lifted out of the graveyard: let go over its graveyard is a cancel, over the table a cast', () => {
    const { canvas } = board();
    const yard = document.createElement('div');
    yard.setAttribute('data-zone', 'graveyard');
    yard.setAttribute('data-owner', 'you');
    yard.getBoundingClientRect = () => rect({ left: 10, top: 400, width: 80, height: 300 });
    canvas.querySelector('.board')!.append(yard);
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const lifted = document.createElement('li');
    lifted.setAttribute('data-cast-lift', 'lifted');
    yard.append(lifted);
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 50, clientY: 500, bubbles: true }));
    expect((t.sent.at(-1)!.payload as { placing: unknown }).placing, 'over its own graveyard: nothing is coming').toBeNull();
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 500, clientY: 500, bubbles: true }));
    expect((t.sent.at(-1)!.payload as { placing: unknown }).placing, 'over the table: the cast waits there').toEqual({ at: { zone: 'battlefield', x: 0.5, y: 0.625 } });
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

  it('says its hand row count the moment it changes — a card drawn, a window resized — with no pointer move', async () => {
    vi.useFakeTimers();
    const { canvas } = board();
    ownHand(canvas, 4, 1);
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const hand = canvas.querySelector('[data-zone="hand"][data-owner="you"]')!;
    hand.replaceChildren();
    ownHand(canvas, 8, 2);
    await vi.waitFor(() => expect(t.sent, 'the drawn card wrapped the hand: said at once').toHaveLength(1));
    expect(t.sent[0]!.payload).toMatchObject({ pointer: null, handRows: 2 });
    for (const li of hand.querySelectorAll<HTMLElement>('li')) li.getBoundingClientRect = () => rect({ left: 100, top: 650, width: 56, height: 84 });
    window.dispatchEvent(new Event('resize'));
    expect(t.sent, 'a wider window: one row, said at once').toHaveLength(2);
    expect(t.sent[1]!.payload).toMatchObject({ pointer: null, handRows: 1 });
    window.dispatchEvent(new Event('resize'));
    expect(t.sent, 'a resize that changes no row count says nothing').toHaveLength(2);
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

describe('receiving: anchored', () => {
  it('lands inside the TWIN card on this board, whatever shape this board is, with the card’s height mirrored like the seats', () => {
    // A receiver board where the card sits somewhere the sender's board fraction would NOT land.
    const { canvas } = board({ '[data-board-card="7"]': { left: 600, top: 160, width: 120, height: 168 } });
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    t.receive({
      matchId: 'm-1',
      type: 'presence',
      seat: 1,
      pointer: { zone: 'battlefield', x: 0.01, y: 0.01 }, // a board fraction that would land nowhere near the card
      anchor: { zone: 'battlefield', own: true, row: null, item: 0, x: 0.3, y: 0.8 },
      held: false,
      from: null,
      handRows: 1,
      arranging: null,
    });
    const cursor = canvas.querySelector<HTMLElement>('.presence')!;
    // The card's box is (600,160)-(720,328): 0.3 across is 636; 0.8 down THEIR card (its text box)
    // is 0.2 down this one — the operator, 2026-10-09: "on the opponents screen the cursor should
    // actually be on the top part of the card".
    expect(cursor.style.left).toBe('636px');
    expect(Number.parseFloat(cursor.style.top)).toBeCloseTo(160 + 0.2 * 168, 6);
    handle.dispose();
  });

  it('is continuous across a card’s edge on differently sized boards — the cursor never jumps onto the card', () => {
    // Sender: the card is (120,200)-(180,284). Receiver: the twin is twice the size, elsewhere.
    const sender = board().canvas;
    document.elementFromPoint = () => null;
    const inside = anchorOf(sender, { x: 179.5, y: 242 });
    const outside = anchorOf(sender, { x: 180.5, y: 242 });
    sender.remove();
    const receiver = board({ '[data-board-card="7"]': { left: 600, top: 160, width: 120, height: 168 } }).canvas;
    const a = placeAnchor(receiver, { ...inside!, own: !inside!.own })!;
    const b = placeAnchor(receiver, { ...outside!, own: !outside!.own })!;
    expect(Math.abs(b.x - a.x), 'one sender pixel is two receiver pixels — never a snap').toBeLessThan(3);
    expect(Math.abs(b.y - a.y)).toBeLessThan(1);
  });

  it('a hand slot lands on the i-th back of the sender’s hand, as drawn HERE', () => {
    const { canvas } = board();
    const backs = theirHandBacks(canvas, 4);
    document.elementFromPoint = () => null;
    const box = backs[2]!.getBoundingClientRect();
    expect(placeAnchor(canvas, { zone: 'hand', own: true, row: null, card: null, item: 2, x: 0.5, y: 0.25 })).toEqual({ x: box.left + box.width / 2, y: box.top + 0.75 * box.height });
  });

  it('a battlefield card lands on THIS board’s drawing of it, whatever column it sits in here — never by its column index', () => {
    // The operator, 2026-10-10: a Swamp nudged 25 px on one screen stood a card-width off it on the other.
    const { canvas } = board({ '[data-board-card="7"]': { left: 420, top: 200, width: 60, height: 84 } });
    const list = canvas.querySelector('[data-zone="battlefield"][data-owner="them"] ul')!;
    const other = document.createElement('li');
    other.className = 'board-card';
    other.setAttribute('data-card-id', '5');
    other.getBoundingClientRect = () => rect({ left: 120, top: 200, width: 60, height: 84 });
    list.prepend(other);
    // 0.3 across and 0.8 down the card on theirs: 0.3 across and 0.2 down it here, mirrored.
    expect(placeAnchor(canvas, { zone: 'battlefield', own: true, row: null, card: 7, item: null, x: 0.3, y: 0.8 })).toEqual({ x: 420 + 0.3 * 60, y: 200 + 0.2 * 84 });
    expect(placeAnchor(canvas, { zone: 'battlefield', own: true, row: null, card: 99, item: null, x: 0.3, y: 0.8 }), 'a card not drawn here: the board fraction').toBeNull();
  });

  it('kept inside the twin zone: an offset far past the last card stops at the zone’s edge', () => {
    const { canvas } = board();
    expect(placeAnchor(canvas, { zone: 'battlefield', own: true, row: null, card: 7, item: null, x: 40, y: 0.5 })!.x).toBe(900);
  });

  it('an anchor naming something this board has not drawn falls back to the board fraction', () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    t.receive({
      matchId: 'm-1',
      type: 'presence',
      seat: 1,
      pointer: { zone: null, x: 0.9, y: 0.1 },
      anchor: { zone: 'battlefield', own: true, row: null, card: 9, item: null, x: 0.5, y: 0.5 },
      held: false,
      from: null,
      handRows: 1,
      arranging: null,
    });
    const cursor = canvas.querySelector<HTMLElement>('.presence')!;
    expect(cursor.style.left).toBe('900px');
    expect(cursor.style.top).toBe(`${(1 - 0.1) * 800}px`);
    handle.dispose();
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
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: false, from: null, handRows: 1, arranging: { card: 7, x: 0, y: 0 } });
    expect(theirCard.hasAttribute('data-arrange-dragging'), 'their card dims in place, as on their screen').toBe(true);
    const lift = canvas.querySelector<HTMLElement>('.presence__lift');
    expect(lift, 'a copy of its face follows').not.toBeNull();
    // The card is (120,200)-(180,284) here: centred on it, then a quarter of a card right and a tenth
    // of a card DOWN theirs — UP this one, the seats are mirrored.
    expect([lift!.style.left, lift!.style.top]).toEqual(['150px', '242px']);
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.6, y: 0.5 }, held: false, from: null, handRows: 1, arranging: { card: 7, x: 0.25, y: 0.1 } });
    expect(lift!.style.left).toBe(`${150 + 0.25 * 60}px`);
    expect(Number.parseFloat(lift!.style.top)).toBeCloseTo(242 - 0.1 * 84, 6);
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.6, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    expect(canvas.querySelector('.presence__lift'), 'gone when they let go').toBeNull();
    expect(theirCard.hasAttribute('data-arrange-dragging')).toBe(false);
    handle.dispose();
  });

  it('their placement (the act’s own message) reserves the column for THEIR player by card id, keeps the back waiting in the gap, and hands it over to the card’s own tile copy once the board has drawn the card there', async () => {
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
    // The card arrives: the board draws it in the gap and consumes the reservation. The stand-in
    // hands over to a copy of the card's own tile, which finishes the trip from wherever the back
    // is (`landCastGhost`, the same trip the owner's screen draws) — never cut short: Forge answers
    // a cast faster than the back's 300 ms glide, and taking the back down at once popped the card
    // into the gap mid-glide (presence.spec's Memnite case, red on a fast CI runner).
    const li = document.createElement('li');
    li.setAttribute('data-board-card', '77');
    li.innerHTML = '<button class="board-card__face"><article class="card" data-card-id="w77" data-testid="card"><span class="card__name">Memnite</span></article></button>';
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"]')!.append(li);
    theirs = [77];
    forgetPendingPlacements();
    wake!();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(canvas.querySelector('.presence__back'), 'the back is gone the moment the card is there').toBeNull();
    const flight = canvas.querySelector<HTMLElement>('.presence__handoff');
    expect(flight, 'and its tile copy is on the trip in its place').not.toBeNull();
    expect(flight!.getAttribute('data-cast-lift'), 'the same trip a played card makes').toBe('returning');
    expect(flight!.querySelector('.card__name')!.textContent).toBe('Memnite');
    expect(flight!.querySelector('[data-card-id]'), 'the copy is not a card the DOM can address').toBeNull();
    expect(li.hasAttribute('data-cast-landing'), 'the real card waits hidden in its slot until the copy lands').toBe(true);
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

  it('a point wait outlives the safety clock while their card is still parked, and still hands over to the spell — the clock runs only from the last word', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    const report = vi.fn();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({ canvas, host: { ...host(t), report, watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs } });
    const at = { zone: 'battlefield' as const, x: 0.4, y: 0.6 };
    const parked = { matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: false, from: null, handRows: 1, arranging: null, placing: { at } };
    t.receive(parked);
    // A target ask open for twice the clock, their pointer at rest: their screen restates the park.
    for (let elapsed = 0; elapsed < 2 * PLACEMENT_WAIT_MS; elapsed += PARKED_RESTATE_MS) {
      vi.advanceTimersByTime(PARKED_RESTATE_MS);
      t.receive(parked);
    }
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'still their play: the back stands').not.toBeNull();
    theirs = [48];
    wake!();
    expect(placedMod.placeSpell, 'handed over where it stood').toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them');
    expect(canvas.querySelector('.presence__back'), 'its card took it down').toBeNull();
    // A sender gone silent mid-park is the one thing the clock is for: PLACEMENT_WAIT_MS after the last word.
    t.receive({ ...parked, held: true, placing: null });
    t.receive(parked);
    vi.advanceTimersByTime(PARKED_RESTATE_MS);
    t.receive(parked);
    vi.advanceTimersByTime(PLACEMENT_WAIT_MS - 1);
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'counted from the last word, not the release').not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(canvas.querySelector('.presence__back')).toBeNull();
    expect(report.mock.calls.filter(([k]) => k === 'stand-in'), 'only the silent one was the clock').toEqual([['stand-in', expect.objectContaining({ how: 'timeout', ms: PARKED_RESTATE_MS + PLACEMENT_WAIT_MS })]]);
    handle.dispose();
  });

  it('their spell reaching the stack BEFORE the release point arrives still hands the point over at once — never a back beside the face until a timer (AE26, the Mana Leak screenshot)', () => {
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
    // Forge's frame wins the race: the spell is on the stack before their release message lands here.
    theirs = [48];
    wake!();
    expect(placedMod.placeSpell, 'nothing to hand it to yet').not.toHaveBeenCalled();
    t.receive({
      matchId: 'm-1',
      type: 'presence',
      seat: 1,
      pointer: { zone: 'stack', x: 0.4, y: 0.6 },
      held: false,
      from: null,
      handRows: 1,
      arranging: null,
      placing: { at: { zone: 'stack', x: 0.4, y: 0.6 } },
    });
    expect(placedMod.placeSpell, 'the point goes to the placed-cards layer the moment it arrives').toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them');
    expect(placedMod.commitSpell, 'turned over in place').toHaveBeenCalledWith(48);
    expect(canvas.querySelector('.presence__back'), 'no back stands beside the face').toBeNull();
    handle.dispose();
  });

  /** Their battlefield's reserved gap (`Board`'s `data-expected` column), centred on 430,242. */
  function reservedGap(canvas: HTMLElement): HTMLElement {
    const gap = document.createElement('li');
    gap.className = 'zone__gap';
    gap.setAttribute('data-expected', '');
    gap.getBoundingClientRect = () => rect({ left: 400, top: 200, width: 60, height: 84 });
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"] ul')!.append(gap);
    return gap;
  }
  /*
   * These run on a fake clock: a frame and the 300 ms glide are advanced, never waited out on the
   * wall clock, where a full check's load made two of them flake (green alone, red in land.sh's
   * check at 14:02Z on 2026-10-11).
   */
  const fakeClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  };
  const frame = async (): Promise<void> => {
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
  };
  const glide = async (): Promise<void> => {
    vi.advanceTimersByTime(GLIDE_MS);
    await Promise.resolve();
  };

  it('a creature placed to a column but held on the STACK, put there while its back is still gliding into the gap, is handed over to the placed card when the glide ends, at the gap — never short of it (AE26; w67-shaman: 16 px, then a hop)', async () => {
    const { canvas } = board();
    fakeClock();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirStackCards: () => theirs, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.4, y: 0.6 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 121, slot: 'front', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.4, y: 0.6 } });
    reservedGap(canvas);
    await frame();
    const back = canvas.querySelector<HTMLElement>('.presence__back[data-waiting]')!;
    expect([back.style.left, back.style.top], 'the back is gliding into the gap').toEqual(['430px', '242px']);
    // Forge puts it on the stack a frame into the glide.
    theirs = [121];
    wake!();
    await frame();
    expect(placedMod.placeSpell, 'not mid-glide').not.toHaveBeenCalled();
    expect(placedMod.holdSpell, 'its stack card held hidden meanwhile, never at the default spot').toHaveBeenCalledWith(121);
    expect(back.isConnected, 'the back finishes its glide').toBe(true);
    await glide();
    expect(placedMod.placeSpell, 'handed over where the glide ends: the gap the card lands in').toHaveBeenCalledWith(121, { x: 430, y: 242 }, 'them');
    expect(placedMod.commitSpell, 'turned over in place').toHaveBeenCalledWith(121);
    expect(canvas.querySelector('.presence__back'), 'one object: the back is gone').toBeNull();
    handle.dispose();
    forgetPendingPlacements();
  });

  it('a spell that goes public while its back is still gliding turns the back over on its way — with the face placed.ts drew for it, never before its art is in — and hands over to that same face at the gap', async () => {
    const { canvas } = board();
    fakeClock();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirStackCards: () => theirs, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.4, y: 0.6 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 121, slot: 'front', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.4, y: 0.6 } });
    reservedGap(canvas);
    await frame();
    const back = canvas.querySelector<HTMLElement>('.presence__back[data-waiting]')!;
    // The held stack card `placed.ts` drew for it: still a back, its art not decoded yet.
    const placed = document.createElement('div');
    placed.setAttribute('data-placed-card', '121');
    placed.innerHTML = '<div class="card-back placed__back"></div>';
    canvas.append(placed);
    theirs = [121];
    wake!();
    await frame();
    expect(back.hasAttribute('data-face'), 'no face before its art is in').toBe(false);
    // The art decodes: placed.ts draws the face.
    placed.innerHTML = '<div class="placed__tile"><div class="card" data-card-id="121" data-testid="card-121"><span class="card__name">Grizzly Bears</span></div></div>';
    await frame();
    expect(back.hasAttribute('data-face'), 'turned over mid-glide').toBe(true);
    expect(back.querySelector('.card .card__name')?.textContent, 'with the card’s own face').toBe('Grizzly Bears');
    expect(back.querySelector('[data-card-id], [data-testid]'), 'a copy, never a second element a reader counts as the card').toBeNull();
    expect(placedMod.placeSpell, 'still not handed over mid-glide').not.toHaveBeenCalled();
    await glide();
    expect(placedMod.placeSpell, 'handed over at the gap').toHaveBeenCalledWith(121, { x: 430, y: 242 }, 'them');
    expect(canvas.querySelector('.presence__back'), 'one object: the stand-in is gone').toBeNull();
    handle.dispose();
    forgetPendingPlacements();
  });

  it('a creature on the stack before the board has even drawn its gap waits for the gap, and the glide, before it is handed over', async () => {
    const { canvas } = board();
    fakeClock();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirStackCards: () => theirs, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.4, y: 0.6 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 121, slot: 'front', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.4, y: 0.6 } });
    theirs = [121];
    wake!();
    await frame();
    await frame();
    expect(placedMod.placeSpell, 'not at the release point').not.toHaveBeenCalled();
    reservedGap(canvas);
    await frame();
    expect(placedMod.placeSpell, 'not as the glide starts').not.toHaveBeenCalled();
    await glide();
    expect(placedMod.placeSpell, 'at the gap, once there').toHaveBeenCalledWith(121, { x: 430, y: 242 }, 'them');
    handle.dispose();
    forgetPendingPlacements();
  });

  it('a creature that resolves into its column before the glide ends is never handed to the stack layer: its copy finishes the trip', async () => {
    const { canvas } = board();
    fakeClock();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let onStack: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirStackCards: () => onStack, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.4, y: 0.6 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 121, slot: 'front', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.4, y: 0.6 } });
    const gap = reservedGap(canvas);
    await frame();
    theirs = [121];
    onStack = [121];
    wake!();
    await frame();
    // It resolves: the board draws it in the gap and consumes the reservation.
    gap.remove();
    const li = document.createElement('li');
    li.setAttribute('data-board-card', '121');
    li.innerHTML = '<button class="board-card__face"><article class="card"><span class="card__name">Viridian Shaman</span></article></button>';
    li.getBoundingClientRect = () => rect({ left: 400, top: 200, width: 60, height: 84 });
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"] ul')!.append(li);
    onStack = [];
    forgetPendingPlacements();
    wake!();
    await frame();
    await glide();
    expect(placedMod.placeSpell, 'the stack layer never drew it').not.toHaveBeenCalled();
    expect(canvas.querySelector('.presence__back'), 'the back handed over to the card').toBeNull();
    handle.dispose();
    forgetPendingPlacements();
  });

  it('a creature that resolves while its back is still gliding is hidden under its flying copy on the commit that draws it — never a painted frame in its slot first (w67-shaman bears)', async () => {
    const { canvas } = board();
    fakeClock();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    let theirs: number[] = [];
    let onStack: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirStackCards: () => onStack, theirPlayerId: () => 1, motion: () => true },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.4, y: 0.6 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 121, slot: 'front', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.4, y: 0.6 } });
    const gap = reservedGap(canvas);
    await frame();
    theirs = [121];
    onStack = [121];
    wake!();
    await frame();
    // Still on its way into the gap, 100 px short of it.
    const back = canvas.querySelector<HTMLElement>('.presence__back[data-waiting]')!;
    back.getBoundingClientRect = () => rect({ left: 300, top: 200, width: 60, height: 84 });
    // It resolves: the board draws it in the gap and consumes the reservation — and no frame passes.
    gap.remove();
    const li = document.createElement('li');
    li.setAttribute('data-board-card', '121');
    li.innerHTML = '<button class="board-card__face"><article class="card"><span class="card__name">Grizzly Bears</span></article></button>';
    li.getBoundingClientRect = () => rect({ left: 400, top: 200, width: 60, height: 84 });
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"] ul')!.append(li);
    onStack = [];
    forgetPendingPlacements();
    await Promise.resolve();
    expect(li.hasAttribute('data-cast-landing'), 'the card is hidden before the frame paints').toBe(true);
    expect(canvas.querySelector('.presence__handoff'), 'its copy covers it').not.toBeNull();
    expect(canvas.querySelector('.presence__back'), 'the back handed over to the copy').toBeNull();
    expect(placedMod.placeSpell, 'the stack layer never drew it').not.toHaveBeenCalled();
    handle.dispose();
    forgetPendingPlacements();
  });

  it('telemetry: their creature’s hand-over to the stack card and its landing are each reported once, as the receiver, from the back’s drawn box', async () => {
    const { canvas } = board();
    fakeClock();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    const report = vi.fn();
    let theirs: number[] = [];
    let onStack: number[] = [];
    let wake: (() => void) | null = null;
    const handle = installPresence({
      canvas,
      host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => theirs, theirStackCards: () => onStack, theirPlayerId: () => 1, motion: () => true, report },
    });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.4, y: 0.6 }, held: true, from: null, handRows: 1, arranging: null });
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 121, slot: 'front', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.4, y: 0.6 } });
    const gap = document.createElement('li');
    gap.className = 'zone__gap';
    gap.setAttribute('data-expected', '');
    gap.getBoundingClientRect = () => rect({ left: 400, top: 200, width: 60, height: 84 });
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"] ul')!.append(gap);
    await frame();
    const back = canvas.querySelector<HTMLElement>('.presence__back[data-waiting]')!;
    back.getBoundingClientRect = () => rect({ left: 400, top: 200, width: 60, height: 84 });
    theirs = [121];
    onStack = [121];
    wake!();
    await frame();
    await frame();
    await glide();
    await frame();
    const handover = report.mock.calls.filter(([kind]) => kind === 'handover');
    expect(handover, 'one hand-over').toHaveLength(1);
    expect(handover[0]![1]).toMatchObject({ screen: 'receiver', how: 'stack', card: 121, fromX: 430, fromY: 242, motion: true });
    expect(handover[0]![1]).toHaveProperty('msSinceRelease');
    expect(handover[0]![1]).toHaveProperty('glideMs');
    // It resolves into its column, drawn where the stack card stood: a swap in place.
    gap.remove();
    const li = document.createElement('li');
    li.setAttribute('data-board-card', '121');
    li.innerHTML = '<button class="board-card__face"><article class="card"><span class="card__name">Viridian Shaman</span></article></button>';
    li.getBoundingClientRect = () => rect({ left: 400, top: 200, width: 60, height: 84 });
    canvas.querySelector('[data-zone="battlefield"][data-owner="them"] ul')!.append(li);
    onStack = [];
    forgetPendingPlacements();
    wake!();
    await frame();
    await frame();
    const landing = report.mock.calls.filter(([kind]) => kind === 'landing');
    expect(landing, 'one landing').toHaveLength(1);
    expect(landing[0]![1]).toMatchObject({ screen: 'receiver', how: 'swap', card: 121, fromX: 430, fromY: 242, toX: 430, toY: 242, dist: 0 });
    expect(landing[0]![1]).toHaveProperty('msSinceStackFrame');
    handle.dispose();
    forgetPendingPlacements();
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

  /*
   * AE18, the receiver half: the operator's own words are in the test title.
   * The sender's `placing` was true when SENT (their card was still
   * `carried`, waiting for their own board to draw the real one) but
   * `forge:placement` already told this screen the SAME point is done, and
   * the flight already ran. Presence names no card, so the point the ONE
   * `forge:placement` of this episode carried is the one thing both messages
   * share.
   */
  it('a `placing` echo naming the same point as an already-flown placement is ignored — "a new card phantom pops into the cursor" (AE18, the receiver half)', async () => {
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

    // A regular presence tick, sent (truthfully) while their card was still `carried`, delivered
    // only now — naming the EXACT point the placement that already flew carried.
    t.receive({
      matchId: 'm-1',
      type: 'presence',
      seat: 1,
      pointer: { zone: 'battlefield', x: 0.9, y: 0.1 },
      held: false,
      from: null,
      handRows: 1,
      arranging: null,
      placing: { at: { zone: 'battlefield', x: 0.5, y: 0.5 } },
    });
    expect(canvas.querySelector('.presence__back'), 'no phantom stands back up for a placement already flown').toBeNull();
    // Their stand-in had glided into the gap, so a later tick names THAT point, not the release
    // (the Viridian Shaman recording): still the same play — no lift since — still nothing.
    const tick = (placing: { zone: 'battlefield'; x: number; y: number } | null, held = false) =>
      t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.8, y: 0.2 }, held, from: null, handRows: 1, arranging: null, placing: placing === null ? null : { at: placing } });
    tick({ zone: 'battlefield', x: 0.52, y: 0.4 });
    expect(canvas.querySelector('.presence__back'), 'no phantom at the gap either').toBeNull();
    // A new play begins with a lift: its release waits as ever.
    tick(null, true);
    tick({ zone: 'battlefield', x: 0.3, y: 0.3 });
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'the next play’s release stands its back').not.toBeNull();
    handle.dispose();
    forgetPendingPlacements();
  });

  it('`forge:placed` moves the other seat’s copy of a placed spell they dragged — `placeStackItem`, not `moveSpell`: a JOINER replaying this has no earlier registration for `moveSpell` to find', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    t.receivePlaced({ matchId: 'm-1', type: 'placed', seat: 1, spell: 48, at: { zone: 'stack', x: 0.4, y: 0.6 } });
    expect(placedMod.placeStackItem).toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them', true);
    expect(placedMod.commitSpell).toHaveBeenCalledWith(48);
    // This seat's own echo (a resync) and another match's are both ignored.
    t.receivePlaced({ matchId: 'm-1', type: 'placed', seat: 0, spell: 49, at: { zone: 'stack', x: 0.1, y: 0.1 } });
    t.receivePlaced({ matchId: 'm-2', type: 'placed', seat: 1, spell: 50, at: { zone: 'stack', x: 0.1, y: 0.1 } });
    expect(placedMod.placeStackItem).toHaveBeenCalledTimes(1);
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
    expect(placedMod.placeStackItem, 'nothing to place it on yet').not.toHaveBeenCalled();
    canvas.querySelector('.board')!.append(overlay);
    vi.advanceTimersByTime(60);
    expect(placedMod.placeStackItem, 'retried once the board painted').toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them', true);
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
    expect(placedMod.placeStackItem).not.toHaveBeenCalled();
    first.dispose();
    // The board paints, THEN the next mount (promoted to seat 0) starts — no second replay ever
    // comes; it has to find this one for itself.
    canvas.querySelector('.board')!.append(overlay);
    const second = installPresence({ canvas, host: host(t, 0) });
    expect(placedMod.placeStackItem, 'the next mount retried it at its own start').toHaveBeenCalledWith(48, { x: 400, y: 320 }, 'them', true);
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

  it('a drag of its own placed card is sent at most once per `PRESENCE_SEND_MS`, its latest point winning — never once per pointer event', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    for (let x = 300; x <= 360; x += 10) spellMovedBox.current!(31, { x, y: 200 });
    expect(t.sent, 'the first move goes at once').toHaveLength(1);
    vi.advanceTimersByTime(PRESENCE_SEND_MS);
    expect(t.sent, 'the rest wait for the next window, as one message').toHaveLength(2);
    expect(t.sent[1]!.payload).toMatchObject({ spell: 31, at: { x: 0.36, y: 0.25 } });
    vi.advanceTimersByTime(PRESENCE_SEND_MS * 3);
    expect(t.sent, 'nothing more without a move').toHaveLength(2);
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

  it('a release message (held false, `placing.at` the release spot, no `from`) draws no arrow and stands the back there, waiting', () => {
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: true, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence__back[data-waiting]'), 'following, not waiting').toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.3, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null, placing: { at: { zone: 'battlefield', x: 0.3, y: 0.5 } } });
    expect(overlay.querySelector('.presence__back[data-waiting]'), 'standing at the release point').not.toBeNull();
    expect(overlay.querySelector('.presence__arrow'), 'no arrow: nothing is being aimed').toBeNull();
    handle.dispose();
  });

  it('a parked card’s back stands where `placing.at` says and nothing their pointer does moves it — to the pop-up, across the table', () => {
    // The operator, 2026-10-08 (the fourth report): "when i release godless shrine and then move
    // to answer the question … from the opponents view that the phantom card is still attached."
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const stand = { zone: 'battlefield' as const, x: 0.3, y: 0.5 };
    // The first parked message already has her pointer elsewhere (on its way to the pop-up): the
    // back is placed by `placing.at`, never by where the pointer happens to be.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.7, y: 0.2 }, held: false, from: null, handRows: 1, arranging: null, placing: { at: stand } });
    const back = overlay.querySelector<HTMLElement>('.presence__back')!;
    expect([back.style.left, back.style.top], 'x=0.3,y=0.5 on a 1000x800 board, mirrored: (300, 400) — not the pointer’s (700, 640)').toEqual(['300px', '400px']);
    for (const pointer of [
      { zone: null, x: 0.9, y: 0.1 },
      { zone: 'hand' as const, x: 0.5, y: 0.9 },
      { zone: 'battlefield' as const, x: 0.1, y: 0.5 },
    ]) {
      t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer, held: false, from: null, handRows: 1, arranging: null, placing: { at: stand } });
      expect(overlay.querySelectorAll('.presence__back'), 'one back').toHaveLength(1);
      expect([back.style.left, back.style.top], `still standing while their pointer is at ${JSON.stringify(pointer)}`).toEqual(['300px', '400px']);
      expect(back.hasAttribute('data-waiting')).toBe(true);
    }
    handle.dispose();
  });

  it('a cleared message (held false, no `placing`) takes a following back down at once, and a point wait down after a short grace — never a placement’s gap', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    const at = { zone: 'battlefield' as const, x: 0.3, y: 0.5 };
    // Following: gone the moment the lift is.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: true, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence__back')).not.toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: false, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence__back'), 'a following back goes with the lift').toBeNull();
    // Parked, then cleared with no id and no placement (a cancel): a grace, then gone.
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: false, from: null, handRows: 1, arranging: null, placing: { at } });
    expect(overlay.querySelector('.presence__back[data-waiting]')).not.toBeNull();
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: false, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelector('.presence__back[data-waiting]'), 'still there: the id may be a frame away').not.toBeNull();
    vi.advanceTimersByTime(CLEARED_GRACE_MS + 1);
    expect(overlay.querySelector('.presence__back'), 'a cancel: gone after the grace, not fifteen seconds').toBeNull();
    handle.dispose();
  });

  it('the grace starts once: their pointer moving on after a cancel never keeps the back on the board', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const report = vi.fn();
    const handle = installPresence({ canvas, host: { ...host(t), report } });
    const at = { zone: 'battlefield' as const, x: 0.3, y: 0.5 };
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: false, from: null, handRows: 1, arranging: null, placing: { at } });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: false, from: null, handRows: 1, arranging: null });
    // Every move after the cancel carries the same cleared state; the old code restarted the grace on each.
    for (let i = 1; i <= 6; i++) {
      vi.advanceTimersByTime(CLEARED_GRACE_MS / 4);
      t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { ...at, x: 0.3 + i * 0.05 }, held: false, from: null, handRows: 1, arranging: null });
    }
    expect(canvas.querySelector('.presence__back'), 'gone one grace after the cancel, however they moved').toBeNull();
    expect(report.mock.calls, 'the clock, not its card, took it down — said once').toEqual([['stand-in', expect.objectContaining({ how: 'grace', ms: CLEARED_GRACE_MS, forBattlefield: false, lastEcho: 'none' })]]);
    handle.dispose();
  });

  it('a cancel, as Forge says it — the card back in their hand — flies the back home to their hand’s last back, the caster’s own trip home (`landCastGhost`)', async () => {
    const { canvas } = board();
    const backs = theirHandBacks(canvas, 2);
    const t = fakeTransport();
    let wake: (() => void) | null = null;
    const handle = installPresence({ canvas, host: { ...host(t), watch: (cb) => ((wake = cb), () => undefined), theirCards: () => [], motion: () => true } });
    const frame = (): Promise<unknown> => new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const at = { zone: 'battlefield' as const, x: 0.3, y: 0.5 };
    // Parked before Forge took the card out of their hand (presence beats Forge's frame).
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: at, held: false, from: null, handRows: 1, arranging: null, placing: { at } });
    const back = canvas.querySelector<HTMLElement>('.presence__back[data-waiting]')!;
    back.getBoundingClientRect = () => rect({ left: 270, top: 370, width: 60, height: 84 });
    // Forge takes it out of the hand to aim it: one back fewer. Nothing goes home.
    backs[1]!.remove();
    wake!();
    await frame();
    expect(canvas.querySelector('.presence__back[data-waiting]'), 'still waiting while they aim').not.toBeNull();
    // Cancelled: Forge puts it back — one more back than at any point of the wait.
    const [home] = theirHandBacks(canvas, 1);
    home!.getBoundingClientRect = () => rect({ left: 170, top: 20, width: 60, height: 84 });
    wake!();
    await frame();
    expect(canvas.querySelector('.presence__back'), 'nothing of theirs stands on the board').toBeNull();
    const ghost = canvas.querySelector<HTMLElement>('.board > .presence__handoff');
    expect(ghost, 'a back flies home').not.toBeNull();
    expect(ghost!.querySelector('.card-back'), 'drawn as a back — the card is still hidden').not.toBeNull();
    expect(ghost!.getAttribute('data-cast-lift')).toBe('returning');
    expect([ghost!.style.left, ghost!.style.top], 'to the centre of their hand’s last back').toEqual(['200px', '62px']);
    expect(home!.hasAttribute('data-cast-landing'), 'that back waits hidden until it lands').toBe(true);
    await new Promise((r) => setTimeout(r, GLIDE_MS + 20));
    expect(canvas.querySelector('.presence__handoff'), 'landed').toBeNull();
    expect(home!.hasAttribute('data-cast-landing')).toBe(false);
    handle.dispose();
  });

  it('a held message while their placement is still arriving does not abandon the gap: the stand-in stays, their pointer is just a pointer', () => {
    const { canvas } = board();
    document.elementFromPoint = () => null;
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: { ...host(t), theirPlayerId: () => 1 } });
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    t.receivePlacement({ matchId: 'm-1', seat: 1, card: 44, slot: 'back', target: { kind: 'at', column: 1 }, at: { zone: 'battlefield', x: 0.4, y: 0.6 } });
    const standIn = overlay.querySelector<HTMLElement>('.presence__back[data-waiting]')!;
    expect(standIn, 'the placement’s stand-in').not.toBeNull();
    expect(standIn.getAttribute('data-presence-card'), 'named: the placement made the card public').toBe('44');
    const where = [standIn.style.left, standIn.style.top];
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.9, y: 0.1 }, held: true, from: null, handRows: 1, arranging: null });
    expect(overlay.querySelectorAll('.presence__back'), 'still the one stand-in').toHaveLength(1);
    expect(overlay.querySelector('.presence__back'), 'the same element').toBe(standIn);
    expect([standIn.style.left, standIn.style.top], 'not moved to their pointer').toEqual(where);
    expect(standIn.hasAttribute('data-waiting')).toBe(true);
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

  it('their hand rows outlive their cursor: a pointer that leaves, or goes quiet, never re-lays their hand out', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const t = fakeTransport();
    const handle = installPresence({ canvas, host: host(t) });
    const theirHand = canvas.querySelector('[data-zone="hand"][data-owner="them"]')!;
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 2, arranging: null });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 2, arranging: null });
    expect(canvas.querySelector('.presence'), 'their pointer left: no cursor').toBeNull();
    expect(theirHand.getAttribute('data-presence-rows'), 'their hand still draws two rows').toBe('2');
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: null, x: 0.5, y: 0.5 }, held: false, from: null, handRows: 2, arranging: null });
    vi.advanceTimersByTime(PRESENCE_STALE_MS + 1);
    expect(canvas.querySelector('.presence'), 'gone quiet: no cursor').toBeNull();
    expect(theirHand.getAttribute('data-presence-rows'), 'and still two rows').toBe('2');
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: null, held: false, from: null, handRows: 1, arranging: null });
    expect(theirHand.hasAttribute('data-presence-rows'), 'a pointer-less message still carries their rows').toBe(false);
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
    const ghost = canvas.querySelector<HTMLElement>('[data-board-overlay] .presence__back[data-gliding]')!;
    expect(ghost, 'a back glides, even with no pointer in the message at all').not.toBeNull();
    expect(ghost.style.left, 'starts at position 0’s centre').toBe('130px'); // 100 + 0*70 + 30 (half of 60) − overlay left 0
    vi.advanceTimersByTime(16); // the glide's own requestAnimationFrame
    expect(ghost.style.left, 'ends at position 2’s centre').toBe('270px'); // 100 + 2*70 + 30
    vi.advanceTimersByTime(GLIDE_MS);
    expect(canvas.querySelector('.presence__back[data-gliding]'), 'removed once the glide finishes').toBeNull();
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
    expect(canvas.querySelector('.presence__back[data-gliding]')).toBeNull();
    handle.dispose();
  });

  /*
   * Wave 64 (J13): the inferred handoff that used to run off `backWas`/
   * `HANDOFF_MS` — "their back went, and *something* of theirs showed up
   * within two seconds" — is gone. `onPlacement` (`forge:placement`) is the
   * one trigger for a permanent's handoff now, proven below; a permanent's
   * arrival with no placement message animates nothing, which this pins.
   */
  it('a permanent arriving with no `forge:placement` message animates nothing — `onPlacement` is the one trigger', () => {
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
    // seat and no `forge:placement` either (a joiner, or a column-less release).
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: true, from: null, handRows: 1, arranging: null });
    t.receive({ matchId: 'm-1', type: 'presence', seat: 1, pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held: false, from: null, handRows: 1, arranging: null });
    expect(canvas.querySelector('.presence__back')).toBeNull();
    // Forge puts card 7 on their battlefield (the fixture's one card of theirs), and the match wakes its subscribers.
    theirs = [7];
    theirCard.innerHTML = '<button class="board-card__face"><article class="card" data-card-id="w7" data-testid="card"><span class="card__name">Their Card</span></article></button>';
    wake!();
    expect(canvas.querySelector('.presence__handoff'), 'no placement message, no travelling copy').toBeNull();
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
