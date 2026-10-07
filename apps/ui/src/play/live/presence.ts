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
 * ## Receiving
 *
 * A message from the other seat is drawn into lane A's overlay root
 * (`[data-board-overlay]`, `pointer-events: none`, so nothing here can ever be
 * the element under this seat's own pointer): a cursor with their name, a
 * card back beside it while `held`, and an arrow from `from` to the pointer.
 * The board card under the mapped pointer, if any, is marked
 * `data-presence-hint` — a hint that they are pointing at it, never a
 * selection. Positions are mapped zone to zone with the owner swapped (the
 * two boards are mirrored; the shared schema's header has the reason), and
 * smoothed by a short CSS transition. A seat heard nothing from for
 * `PRESENCE_STALE_MS` is drawn no more.
 *
 * ## The handoff
 *
 * When their back goes and a card of theirs appears within `HANDOFF_MS` — on
 * their battlefield (a land, a permanent) or on the stack (a spell) — a copy
 * of that card travels from where the back last was to the card's own place,
 * the same trip this seat's own played card makes (`gestures/cast.ts`'s
 * `landCastGhost`), while the real one waits hidden in its slot. The operator,
 * 2026-10-07: *"when cards actually get placed on the board it's not really
 * coming from the card hovering by the cursor."* With motion off (Fast Mode)
 * it simply appears, like everything else.
 *
 * Nothing drawn here is a card the DOM can address: the back carries no
 * `data-card-id`, the cursor no name but theirs, and the travelling copy is
 * stripped of its ids.
 */

import {
  PRESENCE_EVENT,
  PRESENCE_SEND_MS,
  PresenceEchoSchema,
  type PresenceEcho,
  type PresenceMessage,
  type PresenceSpot,
} from '@hadoku/shared';

import { arrowShape } from './gestures/arrow.ts';
import { landCastGhost } from './gestures/cast.ts';
import type { MatchTransport } from './match.ts';
import './presence.css';

/** After this long without a message, the other seat's presence is taken down. */
export const PRESENCE_STALE_MS = 6000;
/** How long after their back goes a card of theirs appearing is taken as the card they were holding. */
export const HANDOFF_MS = 2000;

export interface PresenceHost {
  readonly matchId: string;
  /** This seat's number; null while unseated (a spectator): then nothing is sent, and everything is shown. */
  readonly seat: number | null;
  readonly transport: Pick<MatchTransport, 'on' | 'emit'>;
  /** The other seat's display name, for the cursor's tag. */
  readonly opponentName: () => string | null;
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
const isOwner = (v: string | null): v is 'you' | 'them' | 'table' => v === 'you' || v === 'them' || v === 'table';

/** The board's own box: the overlay covers the canvas exactly. */
function boardBox(canvas: HTMLElement): DOMRect | null {
  return canvas.querySelector('[data-board-overlay]')?.getBoundingClientRect() ?? null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * A client point as the wire carries it: inside the innermost zone under it
 * when there is one, else inside the board. Exported for the tests, which
 * prove the mirror with real rectangles.
 */
export function spotOf(canvas: HTMLElement, point: Point): PresenceSpot | null {
  const board = boardBox(canvas);
  if (board === null || board.width === 0 || board.height === 0) return null;
  for (const el of canvas.querySelectorAll<HTMLElement>('[data-zone][data-owner]')) {
    const zone = el.getAttribute('data-zone');
    const owner = el.getAttribute('data-owner');
    if (!isZone(zone) || !isOwner(owner)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (point.x < r.left || point.x > r.right || point.y < r.top || point.y > r.bottom) continue;
    return { zone, owner, x: clamp01((point.x - r.left) / r.width), y: clamp01((point.y - r.top) / r.height) };
  }
  return { zone: null, owner: null, x: clamp01((point.x - board.left) / board.width), y: clamp01((point.y - board.top) / board.height) };
}

/**
 * The other board's spot, placed on THIS board, in client coordinates. Their
 * `you` is this seat's `them` — and a battlefield is drawn upside down for its
 * other seat (the front row nearest the centre line, `Board.tsx`'s
 * `data-tiers="mirrored"`), so its fraction DOWN flips too; the columns run the
 * same way for both. The operator, 2026-10-07: *"i'm hovering the top left
 * card on my board, but looking at the other screen it seems to be hovering
 * the bottom left card."*
 */
export function placeSpot(canvas: HTMLElement, spot: PresenceSpot): Point | null {
  const board = boardBox(canvas);
  if (board === null) return null;
  if (spot.zone !== null && spot.owner !== null) {
    const owner = spot.owner === 'you' ? 'them' : spot.owner === 'them' ? 'you' : 'table';
    const el = canvas.querySelector<HTMLElement>(`[data-zone="${spot.zone}"][data-owner="${owner}"]`);
    const r = el?.getBoundingClientRect();
    const y = spot.zone === 'battlefield' && spot.owner !== 'table' ? 1 - spot.y : spot.y;
    if (r !== undefined && r.width > 0 && r.height > 0) return { x: r.left + spot.x * r.width, y: r.top + y * r.height };
  }
  return { x: board.left + spot.x * board.width, y: board.top + spot.y * board.height };
}

/** What this seat's hands are doing, off the gesture layer's own marks. */
function handsOf(canvas: HTMLElement): { held: boolean; from: Point | null } {
  const lift = canvas.querySelector<HTMLElement>('[data-cast-lift]');
  const held = lift !== null && lift.getAttribute('data-cast-lift') !== 'returning';
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
    const message: PresenceMessage = { matchId: host.matchId, type: 'presence', pointer: spot, held: hands.held, from };
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

  function onPointerMove(event: PointerEvent): void {
    sendSoon({ x: event.clientX, y: event.clientY });
  }
  function onPointerLeave(): void {
    sendSoon(null);
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
  let backAt: Point | null = null;
  /** Their cards already on the board; a new one right after the back went is the handoff. */
  let known = new Set<number>(host.theirCards?.() ?? []);

  function overlay(): HTMLElement | null {
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }

  function takeDown(): void {
    cursor?.remove();
    back?.remove();
    arrow?.remove();
    cursor = null;
    back = null;
    arrow = null;
    hinted?.removeAttribute('data-presence-hint');
    hinted = null;
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
      back.style.left = `${at.x - box.left}px`;
      back.style.top = `${at.y - box.top}px`;
      backAt = at;
    } else {
      if (back !== null && backAt !== null) backWas = { at: backAt, gone: Date.now() };
      back?.remove();
      back = null;
    }

    const from = echo.from === null ? null : placeSpot(canvas, echo.from);
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
  document.addEventListener('visibilitychange', onVisibility);
  host.transport.on(PRESENCE_EVENT, onEcho);
  const unwatch = host.watch?.(handoff) ?? null;

  return {
    dispose() {
      live = false;
      unwatch?.();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      if (sendTimer !== null) clearTimeout(sendTimer);
      sendTimer = null;
      takeDown();
    },
  };
}
