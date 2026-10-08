/*
 * The other seat's presence on this board: their pointer, a card back under
 * it while they hold a card, and their arrow while they aim — and this seat's
 * own, sent to them. Ledger Z5; the schema and the rules of what may cross
 * the wire are `@hadoku/shared`'s `presence.ts`. Approved by the operator from
 * https://claude.ai/artifact/PWTF64Vae8zUUFfoCdipfu, with *"we should see the
 * pointer even when they aren't holding a card."*
 *
 * ## Sending
 *
 * Every `pointermove` over the board, throttled to `PRESENCE_SEND_MS`, plus
 * one message the moment the pointer leaves the board or the tab is hidden
 * (`pointer: null`). What the hands are doing is read off the gesture layer's
 * OWN marks on the DOM rather than through a second channel of state: a card
 * carrying `data-cast-lift` (lifted, parked or carried — not `returning`) is
 * held; the click-targeting arrow (`[data-testid="targeter"]`) has a tail,
 * and that tail is `from`. The gesture layer is not told about this module
 * and need not be.
 *
 * A card let go (`pointerup`/`pointercancel` while held) sends at once,
 * outside the throttle: `held: false` and the release point itself as `from`
 * — so a release with no further movement still reaches the other seat
 * straight away, rather than waiting for a pointer move that may never come.
 * `from` otherwise means the arrow's tail (sent only while `held`); the two
 * never collide because there is no arrow once a card is let go.
 *
 * ## Receiving
 *
 * A message from the other seat is drawn into lane A's overlay root
 * (`[data-board-overlay]`, `pointer-events: none`, so nothing here can ever be
 * the element under this seat's own pointer): a cursor with their name, a
 * card back beside it while `held`, and an arrow from `from` to the pointer
 * while `held` (never once let go — see above). The board card under the
 * mapped pointer, if any, is marked `data-presence-hint` — a hint that they
 * are pointing at it, never a selection. A spot is placed by mirroring the
 * WHOLE board top-to-bottom (the shared schema's header has the reason), not
 * by scaling inside whichever zone it names, and smoothed by a short CSS
 * transition. A seat heard nothing from for `PRESENCE_STALE_MS` is drawn no
 * more. Their hidden hand draws in the row count their own message carries
 * (`handRows`) via `[data-presence-rows]`, which `presence.css` reads.
 *
 * ## The handoff
 *
 * When their back goes — at the release message above, or (failing that)
 * inferred from the last place it was drawn — and a card of theirs appears
 * within `HANDOFF_MS` — on their battlefield (a land, a permanent) or on the
 * stack (a spell) — a copy of that card travels from where the back last was
 * to the card's own place, the same trip this seat's own played card makes
 * (`gestures/cast.ts`'s `landCastGhost`), while the real one waits hidden in
 * its slot. The operator, 2026-10-07: *"when cards actually get placed on the
 * board it's not really coming from the card hovering by the cursor."* With
 * motion off (Fast Mode) it simply appears, like everything else.
 *
 * Nothing drawn here is a card the DOM can address: the back carries no
 * `data-card-id`, the cursor no name but theirs, and the travelling copy is
 * stripped of its ids.
 */

import { PLACEMENT_EVENT, PlacementEchoSchema,
  PRESENCE_EVENT,
  PRESENCE_SEND_MS,
  PresenceEchoSchema,
  type PresenceEcho,
  type PresenceMessage,
  type PresenceSpot,
} from '@hadoku/shared';

import { arrowShape } from './gestures/arrow.ts';
import { expectPlacement, pendingPlacementFor } from '../Board.tsx';
import { expectedGapBox, landCastGhost } from './gestures/cast.ts';
import type { MatchTransport } from './match.ts';
import './presence.css';

/** After this long without a message, the other seat's presence is taken down. */
export const PRESENCE_STALE_MS = 6000;
/** How long after their back goes a card of theirs appearing is taken as the card they were holding. */
export const HANDOFF_MS = 2000;
/** How long a back waits in its reserved gap for the card; a cast that never resolves just ages out (`Board`'s own TTL). */
export const WAITING_MS = 15_000;

export interface PresenceHost {
  readonly matchId: string;
  /** This seat's number; null while unseated (a spectator): then nothing is sent, and everything is shown. */
  readonly seat: number | null;
  readonly transport: Pick<MatchTransport, 'on' | 'emit'>;
  /** The other seat's display name, for the cursor's tag. */
  readonly opponentName: () => string | null;
  /** The other seat's player id, for the column their release reserves (`Board`'s `expectPlacement`). Absent: nothing is reserved. */
  readonly theirPlayerId?: () => number | null;
  /** Wake on every change of the match (`subscribe`), for the handoff; absent, no handoff is drawn. */
  readonly watch?: (onChange: () => void) => () => void;
  /** The ids of the other seat's cards the board draws as cards: their battlefield, and their spells on the stack. */
  readonly theirCards?: () => readonly number[];
  /** Whether motion is on (Fast Mode off); the handoff travels only then. */
  readonly motion?: () => boolean;
}

export interface PresenceHandle {
  dispose(): void;
}

type Point = { x: number; y: number };

const ZONES = ['hand', 'battlefield', 'graveyard', 'exile', 'stack'] as const;
type Zone = (typeof ZONES)[number];
const isZone = (v: string | null): v is Zone => v !== null && (ZONES as readonly string[]).includes(v);

/** The board's own box: the overlay covers the canvas exactly. */
function boardBox(canvas: HTMLElement): DOMRect | null {
  return canvas.querySelector('[data-board-overlay]')?.getBoundingClientRect() ?? null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * A client point as the wire carries it: a fraction of the WHOLE board, plus
 * whichever zone it falls in as a hint — never a fraction of that zone's own
 * box, which is what used to drift at a seam once the two screens sized a
 * zone differently. Exported for the tests, which prove the mirror with real
 * rectangles.
 */
export function spotOf(canvas: HTMLElement, point: Point): PresenceSpot | null {
  const board = boardBox(canvas);
  if (board === null || board.width === 0 || board.height === 0) return null;
  let zone: Zone | null = null;
  for (const el of canvas.querySelectorAll<HTMLElement>('[data-zone]')) {
    const z = el.getAttribute('data-zone');
    if (!isZone(z)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (point.x < r.left || point.x > r.right || point.y < r.top || point.y > r.bottom) continue;
    zone = z;
    break;
  }
  return { zone, x: clamp01((point.x - board.left) / board.width), y: clamp01((point.y - board.top) / board.height) };
}

/**
 * The other board's spot, placed on THIS board, in client coordinates: the
 * same fraction across (the columns run the same way on both boards), and the
 * fraction down mirrored — the sender's own side, at the bottom of their
 * board, is drawn at the TOP of this one (their opponent's place), and their
 * opponent's side, at their top, is drawn at this board's bottom (this seat's
 * own place). No zone's box scales it, on either side. The operator,
 * 2026-10-07: *"i'm hovering the top left card on my board, but looking at
 * the other screen it seems to be hovering the bottom left card."*
 */
export function placeSpot(canvas: HTMLElement, spot: PresenceSpot): Point | null {
  const board = boardBox(canvas);
  if (board === null) return null;
  return { x: board.left + spot.x * board.width, y: board.top + (1 - spot.y) * board.height };
}

/**
 * This seat's own hand's row count, read off its card list rather than
 * carried as a second channel of state: more than one distinct row of tops
 * among its cards is two rows, otherwise one. The wire only ever says 1 or 2
 * (`PresenceSchema`), which is all `board.css` ever draws a hand in.
 */
function handRowsOf(canvas: HTMLElement): 1 | 2 {
  // A lifted, parked or carried card is drawn at the pointer, not in its row: its top is anybody's,
  // and counting it made the other seat see two rows for exactly as long as a card was held (the
  // operator, 2026-10-07: "when i pull one out, they suddenly get reorganized into two rows").
  const cards = canvas.querySelectorAll<HTMLElement>('[data-zone="hand"][data-owner="you"] li:not([data-cast-lift])');
  if (cards.length < 2) return 1;
  const first = Math.round(cards[0]!.getBoundingClientRect().top);
  for (const card of cards) {
    if (Math.round(card.getBoundingClientRect().top) !== first) return 2;
  }
  return 1;
}

/** What this seat's hands are doing, off the gesture layer's own marks. */
function handsOf(canvas: HTMLElement): { held: boolean; from: Point | null } {
  const lift = canvas.querySelector<HTMLElement>('[data-cast-lift]');
  const held = lift !== null && lift.getAttribute('data-cast-lift') !== 'returning';
  // A parked card (waiting on an X question, a target, Forge) has stopped: its centre is `from`,
  // whether or not an arrow is being aimed from it yet — the other screen's back stops there too
  // (the operator, 2026-10-08: "the phantom card should stop moving as soon as it does on both screens").
  const parked = canvas.querySelector<HTMLElement>('[data-cast-ghost][data-cast-lift="parked"], [data-cast-lift="parked"]');
  if (held && parked !== null) {
    const p = parked.getBoundingClientRect();
    if (p.width > 0) return { held, from: { x: p.left + p.width / 2, y: p.top + p.height / 2 } };
  }
  const tail = canvas.querySelector<SVGPathElement>('[data-testid="targeter"] path');
  const d = tail?.getAttribute('d') ?? null;
  const m = d === null ? null : /^M (-?[\d.]+) (-?[\d.]+)/.exec(d);
  if (m === null) return { held, from: null };
  const board = boardBox(canvas);
  if (board === null) return { held, from: null };
  return { held, from: { x: board.left + Number(m[1]), y: board.top + Number(m[2]) } };
}

export function installPresence(options: { canvas: HTMLElement; host: PresenceHost }): PresenceHandle {
  const { canvas, host } = options;
  let live = true;

  /* ── sending ─────────────────────────────────────────────────────── */

  let lastSent = 0;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPointer: Point | null = null;
  let lastMessage: string | null = null;

  function send(pointer: Point | null): void {
    if (!live || host.seat === null) return;
    const spot = pointer === null ? null : spotOf(canvas, pointer);
    const hands = handsOf(canvas);
    const from = hands.from === null ? null : spotOf(canvas, hands.from);
    const message: PresenceMessage = { matchId: host.matchId, type: 'presence', pointer: spot, held: hands.held, from, handRows: handRowsOf(canvas) };
    const key = JSON.stringify(message);
    if (key === lastMessage) return;
    lastMessage = key;
    lastSent = Date.now();
    host.transport.emit(PRESENCE_EVENT, message);
  }

  /** Throttled: at most one message per `PRESENCE_SEND_MS`, the latest position winning. */
  function sendSoon(pointer: Point | null): void {
    lastPointer = pointer;
    if (sendTimer !== null) return;
    const wait = Math.max(0, PRESENCE_SEND_MS - (Date.now() - lastSent));
    sendTimer = setTimeout(() => {
      sendTimer = null;
      send(lastPointer);
    }, wait);
  }

  /**
   * A card let go: sent at once, outside the throttle — a release with no
   * further movement used to wait on a move that might never come, so the
   * back stayed attached after the card had already appeared on the board.
   * `from` carries the release point itself, for the hand-off to start from
   * without having to infer it from whatever was last drawn.
   */
  function sendRelease(point: Point): void {
    if (!live || host.seat === null) return;
    const spot = spotOf(canvas, point);
    if (sendTimer !== null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    const message: PresenceMessage = { matchId: host.matchId, type: 'presence', pointer: spot, held: false, from: spot, handRows: handRowsOf(canvas) };
    lastMessage = JSON.stringify(message);
    lastPointer = { x: point.x, y: point.y };
    lastSent = Date.now();
    host.transport.emit(PRESENCE_EVENT, message);
  }

  function onPointerMove(event: PointerEvent): void {
    sendSoon({ x: event.clientX, y: event.clientY });
  }
  function onPointerLeave(): void {
    sendSoon(null);
  }
  function onPointerRelease(event: PointerEvent): void {
    // Read before the gesture layer's own `pointerup`/`pointercancel` handler runs: this
    // listener is on `canvas`, which the event bubbles through before reaching `window`.
    if (handsOf(canvas).held) sendRelease({ x: event.clientX, y: event.clientY });
  }
  function onVisibility(): void {
    if (document.visibilityState === 'hidden') sendSoon(null);
  }

  /* ── receiving ───────────────────────────────────────────────────── */

  let cursor: HTMLElement | null = null;
  let back: HTMLElement | null = null;
  let arrow: SVGSVGElement | null = null;
  let hinted: Element | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where their back last was, and when it went — the handoff's start. */
  let backWas: { at: Point; gone: number } | null = null;
  /** Their back waiting in the gap their release reserved, until the card arrives (or this times out). */
  let waiting: { timer: ReturnType<typeof setTimeout> } | null = null;
  let backAt: Point | null = null;
  /** Their cards already on the board; a new one right after the back went is the handoff. */
  let known = new Set<number>(host.theirCards?.() ?? []);

  function overlay(): HTMLElement | null {
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }

  function stopWaiting(): void {
    if (waiting === null) return;
    clearTimeout(waiting.timer);
    waiting = null;
    back?.remove();
    back = null;
  }
  function takeDown(): void {
    cursor?.remove();
    arrow?.remove();
    cursor = null;
    arrow = null;
    // A back waiting in its gap stays: it is the card's stand-in now, not the pointer's.
    if (waiting === null) {
      back?.remove();
      back = null;
    }
    hinted?.removeAttribute('data-presence-hint');
    hinted = null;
    canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="them"]')?.removeAttribute('data-presence-rows');
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;
  }

  function hint(at: Point | null): void {
    const under = at === null ? null : document.elementFromPoint(at.x, at.y)?.closest('[data-board-card]') ?? null;
    if (under === hinted) return;
    hinted?.removeAttribute('data-presence-hint');
    hinted = under;
    hinted?.setAttribute('data-presence-hint', '');
  }

  function draw(echo: PresenceEcho): void {
    const root = overlay();
    if (root === null) return;
    const box = root.getBoundingClientRect();
    const at = echo.pointer === null ? null : placeSpot(canvas, echo.pointer);
    if (at === null) {
      takeDown();
      return;
    }
    if (cursor === null) {
      cursor = document.createElement('div');
      cursor.className = 'presence';
      cursor.dataset.presence = String(echo.seat);
      cursor.setAttribute('aria-hidden', 'true');
      cursor.innerHTML =
        '<svg class="presence__pointer" viewBox="0 0 16 16"><path d="M1 1 L1 13 L4.5 9.8 L7 15 L9.3 14 L6.8 9 L11.5 9 Z"/></svg><span class="presence__name"></span>';
      root.append(cursor);
    }
    cursor.querySelector('.presence__name')!.textContent = host.opponentName() ?? '';
    cursor.style.left = `${at.x - box.left}px`;
    cursor.style.top = `${at.y - box.top}px`;

    if (echo.held) {
      // They lifted a card (again): whatever was waiting is abandoned.
      stopWaiting();
      if (back === null) {
        back = document.createElement('div');
        back.className = 'presence__back';
        back.setAttribute('aria-hidden', 'true');
        root.append(back);
      }
      // A touch smaller than a card in their hand (the operator, 2026-10-07: the back looked a fifth
      // bigger than a hand card; "it could be 5% smaller"). Their hand's own backs are the measure;
      // this seat's hand when theirs is empty; the stylesheet's size when neither is drawn.
      const handCard =
        canvas.querySelector('[data-zone="hand"][data-owner="them"] li') ?? canvas.querySelector('[data-zone="hand"][data-owner="you"] li');
      const w = handCard?.getBoundingClientRect().width ?? 0;
      back.style.width = w > 0 ? `${Math.round(w * 0.95)}px` : '';
      // Parked (the arrow's tail, or the card waiting on a question): the back sits THERE, still, while
      // only their pointer moves. Lifted: it follows the pointer.
      const parkedAt = echo.from === null ? null : placeSpot(canvas, echo.from);
      const stand = parkedAt ?? at;
      back.style.left = `${stand.x - box.left}px`;
      back.style.top = `${stand.y - box.top}px`;
      backAt = stand;
    } else {
      // The release message carries the exact release spot as `from`; failing that (no explicit
      // release reached this seat), fall back to the last place the back was actually drawn.
      const released = echo.from === null ? null : placeSpot(canvas, echo.from);
      if (waiting !== null) {
        // The placement already arrived (the act's own message beat the release): the back is the
        // card's stand-in now, not the pointer's — it stays.
      } else {
        if (released !== null) backWas = { at: released, gone: Date.now() };
        else if (back !== null && backAt !== null) backWas = { at: backAt, gone: Date.now() };
        back?.remove();
        back = null;
      }
    }

    const theirHand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="them"]');
    if (echo.handRows === 2) theirHand?.setAttribute('data-presence-rows', '2');
    else theirHand?.removeAttribute('data-presence-rows');

    // The arrow is the tail of an active aim, which only exists while a card is held; once let
    // go, `from` is the release spot above, never an arrow to draw.
    const from = echo.held && echo.from !== null ? placeSpot(canvas, echo.from) : null;
    if (from !== null) {
      if (arrow === null) {
        arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        arrow.setAttribute('class', 'presence__arrow');
        arrow.setAttribute('aria-hidden', 'true');
        arrow.append(document.createElementNS('http://www.w3.org/2000/svg', 'path'), document.createElementNS('http://www.w3.org/2000/svg', 'polygon'));
        root.append(arrow);
      }
      const { d, points } = arrowShape(from.x - box.left, from.y - box.top, at.x - box.left, at.y - box.top);
      arrow.querySelector('path')!.setAttribute('d', d);
      arrow.querySelector('polygon')!.setAttribute('points', points);
    } else {
      arrow?.remove();
      arrow = null;
    }
    hint(at);

    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = setTimeout(takeDown, PRESENCE_STALE_MS);
  }

  /** The card they were holding has appeared: its copy travels from the back's last place to its own. */
  function handoff(): void {
    const cards = host.theirCards?.() ?? [];
    const fresh = cards.filter((id) => !known.has(id));
    known = new Set(cards);
    if (waiting !== null && back !== null) {
      // The card their back stands in for has arrived: `Board` consumes the reservation when it
      // draws the card in the gap, and the stand-in simply goes. That happens in React's commit of
      // this very change, which may be AFTER this listener runs — so the reservation is read on the
      // next frame, past the commit. On the stack first, the back turns over in place (committed —
      // the face is public now) and keeps waiting for the battlefield.
      const theirs = host.theirPlayerId?.() ?? null;
      const standIn = back;
      requestAnimationFrame(() => {
        if (waiting === null || back !== standIn) return;
        if (theirs !== null && pendingPlacementFor(theirs) === null) stopWaiting();
      });
      if (fresh.length === 0) return;
      const id = fresh[0]!;
      const tile = canvas.querySelector(`.stack__item:has([data-card-id="w${id}"]) .card`);
      if (tile !== null && !back.hasAttribute('data-face')) {
        const copy = tile.cloneNode(true) as HTMLElement;
        for (const el of [copy, ...copy.querySelectorAll('[data-card-id], [data-testid]')]) {
          el.removeAttribute('data-card-id');
          el.removeAttribute('data-testid');
        }
        back.replaceChildren(copy);
        back.setAttribute('data-face', '');
      }
      return;
    }
    if (fresh.length === 0 || backWas === null || Date.now() - backWas.gone > HANDOFF_MS) return;
    const from = backWas.at;
    backWas = null;
    if (host.motion?.() !== true) return;
    const id = fresh[0]!;
    const arrived =
      canvas.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${id}"]`) ??
      canvas.querySelector<HTMLElement>(`.stack__item:has([data-card-id="w${id}"])`);
    const tile = arrived?.querySelector('.card');
    if (!(arrived instanceof HTMLElement) || tile === null || tile === undefined) return;
    const ghost = document.createElement('div');
    ghost.className = 'presence__handoff';
    ghost.setAttribute('aria-hidden', 'true');
    const copy = tile.cloneNode(true) as HTMLElement;
    copy.removeAttribute('data-card-id');
    copy.removeAttribute('data-testid');
    for (const el of copy.querySelectorAll('[data-card-id], [data-testid]')) {
      el.removeAttribute('data-card-id');
      el.removeAttribute('data-testid');
    }
    ghost.append(copy);
    landCastGhost(canvas, id, ghost, from, arrived);
  }

  /**
   * The other seat played a card at a column (`forge:placement`, from the act
   * itself through the server — before any Forge frame about the card). This
   * is the one trigger for the other screen's motion: the row reserves the
   * column (`expectPlacement`, by card id), and the stand-in glides from
   * their release point into the gap and waits — the back they were holding,
   * or a fresh one. If Forge's frame has drawn the card already, the card is
   * moved into the column by the same reservation and its own tile flies from
   * the release point to it instead. Either way: the same glide their screen
   * draws, from the same message.
   */
  function onPlacement(payload: unknown): void {
    if (!live) return;
    const parsed = PlacementEchoSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== host.matchId || parsed.data.seat === host.seat) return;
    const theirs = host.theirPlayerId?.() ?? null;
    const root = overlay();
    const from = placeSpot(canvas, parsed.data.at);
    if (theirs === null || root === null || from === null) return;
    const { card, slot, target } = parsed.data;
    expectPlacement(theirs, slot, target, card);
    backWas = null;
    stopWaiting();
    const already = canvas.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${card}"]`);
    if (already !== null) {
      // The frame came first: the reservation moves the card on the next commit; its tile flies
      // from the release point to wherever it settles.
      requestAnimationFrame(() => {
        const settled = canvas.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${card}"]`);
        const tile = settled?.querySelector('.card');
        if (!(settled instanceof HTMLElement) || !tile || host.motion?.() !== true) return;
        const ghost = document.createElement('div');
        ghost.className = 'presence__handoff';
        ghost.setAttribute('aria-hidden', 'true');
        const copy = tile.cloneNode(true) as HTMLElement;
        for (const el of [copy, ...copy.querySelectorAll('[data-card-id], [data-testid]')]) {
          el.removeAttribute('data-card-id');
          el.removeAttribute('data-testid');
        }
        ghost.append(copy);
        landCastGhost(canvas, card, ghost, from, settled);
      });
      return;
    }
    const rootBox = root.getBoundingClientRect();
    if (back === null) {
      back = document.createElement('div');
      back.className = 'presence__back';
      back.setAttribute('aria-hidden', 'true');
      root.append(back);
    }
    const standIn = back;
    standIn.style.left = `${from.x - rootBox.left}px`;
    standIn.style.top = `${from.y - rootBox.top}px`;
    standIn.setAttribute('data-waiting', '');
    waiting = { timer: setTimeout(stopWaiting, WAITING_MS) };
    requestAnimationFrame(() => {
      if (waiting === null || back !== standIn) return;
      const gap = expectedGapBox(canvas, 'them');
      const box2 = overlay()?.getBoundingClientRect();
      if (gap === null || box2 === undefined) return;
      standIn.style.left = `${gap.left + gap.width / 2 - box2.left}px`;
      standIn.style.top = `${gap.top + gap.height / 2 - box2.top}px`;
      standIn.style.width = `${gap.width}px`;
    });
  }

  function onEcho(payload: unknown): void {
    if (!live) return;
    const parsed = PresenceEchoSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== host.matchId) return;
    // This seat's own echo never comes back (the server relays to the others), but a resync could; never draw oneself.
    if (parsed.data.seat === host.seat) return;
    draw(parsed.data);
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerRelease);
  canvas.addEventListener('pointercancel', onPointerRelease);
  document.addEventListener('visibilitychange', onVisibility);
  host.transport.on(PRESENCE_EVENT, onEcho);
  host.transport.on(PLACEMENT_EVENT, onPlacement);
  const unwatch = host.watch?.(handoff) ?? null;

  return {
    dispose() {
      stopWaiting();
      live = false;
      unwatch?.();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerup', onPointerRelease);
      canvas.removeEventListener('pointercancel', onPointerRelease);
      document.removeEventListener('visibilitychange', onVisibility);
      if (sendTimer !== null) clearTimeout(sendTimer);
      sendTimer = null;
      takeDown();
    },
  };
}
