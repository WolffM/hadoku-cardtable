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
 * within `HANDOFF_MS` on their battlefield (a land, a permanent), a copy of
 * that card travels from where the back last was to the card's own place,
 * the same trip this seat's own played card makes (`gestures/cast.ts`'s
 * `landCastGhost`), while the real one waits hidden in its slot. The
 * operator, 2026-10-07: *"when cards actually get placed on the board it's
 * not really coming from the card hovering by the cursor."* With motion off
 * (Fast Mode) it simply appears, like everything else.
 *
 * A SPELL is different (AD4 rule 2, wave 59): nothing travels. A release
 * carrying `placing.at` parks the back AT that exact point and waits — not a
 * battlefield gap, a spell has none — until the id shows up (their spell is
 * now on the stack, `theirCards`): `./placed.ts`'s `placeSpell`/`commitSpell`
 * take the stand-in over from there, drawn as a card at the same point. This
 * module never draws the placed-card layer itself, only the plain back while
 * the id is still unknown, and calls `placeSpell`/`commitSpell` again when
 * `forge:placed` says the owner moved it (a live drag, or the server's own
 * replay to a joiner, who has no earlier registration to `moveSpell`).
 *
 * Nothing drawn here is a card the DOM can address: the back carries no
 * `data-card-id`, the cursor no name but theirs, and the travelling copy is
 * stripped of its ids.
 */

import { PLACED_EVENT, PlacedEchoSchema,
  PLACEMENT_EVENT, PlacementEchoSchema,
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
import { commitSpell, onSpellMoved, placeSpell } from './placed.ts';
import type { MatchTransport } from './match.ts';
import './presence.css';

/** After this long without a message, the other seat's presence is taken down. */
export const PRESENCE_STALE_MS = 6000;
/** How long after their back goes a card of theirs appearing is taken as the card they were holding. */
export const HANDOFF_MS = 2000;
/** How long a back waits in its reserved gap for the card; a cast that never resolves just ages out (`Board`'s own TTL). */
export const WAITING_MS = 15_000;
/** How long a hand-move's glide runs — the same number `./gestures/hand.ts`'s own FLIP uses, so the two screens move in step. */
export const HAND_MOVE_MS = 300;

/**
 * `live/gestures/hand.ts`'s own seam into this module: a hand reorder
 * just committed, told to every live `installPresence` instance so it can
 * send at once, outside the throttle — `sendRelease`'s own reason, a release
 * with no further movement should not wait on a move that may never come.
 * Module-level, the same shape `Board.tsx`'s `carryCastOffStack` listeners
 * use: there is only ever one live board, but the gesture layer and this
 * module are separate lanes with no import of each other's internals.
 */
const handMoveListeners = new Set<(from: number, to: number) => void>();

export function queueHandMove(from: number, to: number): void {
  for (const listener of handMoveListeners) listener(from, to);
}

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
/**
 * A battlefield card of this seat's being rearranged (`Board.tsx`'s own drag:
 * the pressed card carries `data-arrange-dragging`, its ghost follows the
 * pointer), and where the ghost is — read, like everything else here, off the
 * DOM the gesture already draws.
 */
function arrangingOf(canvas: HTMLElement): { card: number; at: Point } | null {
  const li = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"] [data-arrange-dragging]');
  const ghost = canvas.querySelector<HTMLElement>('.board > [data-arrange-ghost]');
  const id = Number(li?.getAttribute('data-board-card') ?? li?.getAttribute('data-card-id'));
  if (li === null || ghost === null || !Number.isFinite(id)) return null;
  const g = ghost.getBoundingClientRect();
  return g.width > 0 ? { card: id, at: { x: g.left + g.width / 2, y: g.top + g.height / 2 } } : null;
}

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

/**
 * A `forge:placed` replay whose `placeSpot` had no board to place it on yet
 * — module-level, not per-instance: `installPresence` itself remounts
 * several times while a page connects (spectator, then promoted to its
 * seat), and a retry tied to one of those instances' own `live` flag dies
 * with it long before the board ever paints. The NEXT mount picks this up
 * at its own start, so the one-time replay a joiner gets is never lost to
 * a mount it happened to race.
 */
let pendingPlaced: unknown | null = null;

/** Test-only: drop a carried-over replay, so one test's leftover never reaches the next. */
export function forgetPendingPlaced(): void {
  pendingPlaced = null;
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
    const lifted = arrangingOf(canvas);
    const arranging = lifted === null ? null : { card: lifted.card, at: spotOf(canvas, lifted.at) };
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      held: hands.held,
      from,
      handRows: handRowsOf(canvas),
      arranging: arranging === null || arranging.at === null ? null : { card: arranging.card, at: arranging.at },
      // `placing` only ever rides on the release message (`sendRelease`), never a plain move.
      placing: null,
      handMove: null,
    };
    const key = JSON.stringify(message);
    if (key === lastMessage) return;
    lastMessage = key;
    lastSent = Date.now();
    host.transport.emit(PRESENCE_EVENT, message);
  }

  /**
   * `./gestures/hand.ts` just committed a reorder: sent at once, outside the
   * throttle, the same reason `sendRelease` is — a release with no further
   * pointer movement should not wait on one that may never come. Everything
   * else in the message is read fresh off the DOM exactly as `send` reads it,
   * so the other seat's cursor and held-card state stay correct alongside it.
   */
  function sendHandMove(from: number, to: number): void {
    if (!live || host.seat === null) return;
    if (sendTimer !== null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    const spot = lastPointer === null ? null : spotOf(canvas, lastPointer);
    const hands = handsOf(canvas);
    const handFrom = hands.from === null ? null : spotOf(canvas, hands.from);
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      held: hands.held,
      from: handFrom,
      handRows: handRowsOf(canvas),
      arranging: null,
      handMove: { from, to },
    };
    lastMessage = JSON.stringify(message);
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
   * without having to infer it from whatever was last drawn. `placing`
   * carries the SAME point as a durable marker (AD4 rule 2): the receiver
   * waits a back there, rather than inferring the wait from timing, until
   * either the id shows up on the stack (a spell) or a permanent's own
   * placement message (`placement.ts`) supersedes it. Never sent for a
   * release back onto the hand: that is always a cancel (`resolveLift`'s own
   * `overOwnHand` check is what sends it home, never to Forge), so nothing
   * is ever coming — the back must still vanish at once, not wait.
   */
  function sendRelease(point: Point): void {
    if (!live || host.seat === null) return;
    const spot = spotOf(canvas, point);
    if (sendTimer !== null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      held: false,
      from: spot,
      handRows: handRowsOf(canvas),
      arranging: null,
      placing: spot === null || spot.zone === 'hand' ? null : { at: spot },
      handMove: null,
    };
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
  /**
   * Their back waiting for the card its stand-in is: in the gap their release
   * reserved for a PERMANENT (`forBattlefield: true`, `Board`'s own
   * reservation clears it below), or at the exact point for a SPELL
   * (`forBattlefield: false`, cleared by `handoff`'s id check instead) —
   * or this times out.
   */
  let waiting: { timer: ReturnType<typeof setTimeout>; forBattlefield: boolean } | null = null;
  let backAt: Point | null = null;
  /** Their cards already on the board; a new one right after the back went is the handoff. */
  let known = new Set<number>(host.theirCards?.() ?? []);

  function overlay(): HTMLElement | null {
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }

  /**
   * The `[data-placed-spell]` element `placed.ts` drew at exactly `at` (its
   * own `overlayPoint`, inverted) — this seam's only way to recover an id
   * `promote` may have already renamed by the time the caller can act on it.
   */
  function findPlacedSpellAt(at: Point): number | null {
    const box = overlay()?.getBoundingClientRect();
    if (box === undefined) return null;
    for (const el of canvas.querySelectorAll<HTMLElement>('[data-placed-spell]')) {
      const left = Number.parseFloat(el.style.left);
      const top = Number.parseFloat(el.style.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
      if (Math.abs(left + box.left - at.x) < 1 && Math.abs(top + box.top - at.y) < 1) {
        const id = Number(el.getAttribute('data-placed-spell'));
        return Number.isFinite(id) ? id : null;
      }
    }
    return null;
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
    if (liftedCard !== null) {
      liftedCard.el.removeAttribute('data-arrange-dragging');
      liftedCard.tile.remove();
      liftedCard = null;
    }
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

  /** Their rearrange, mirrored: their card dims in place and its tile follows where they hold it. */
  let liftedCard: { id: number; el: HTMLElement; tile: HTMLElement } | null = null;
  function drawArranging(root: HTMLElement, box: DOMRect, arranging: PresenceEcho['arranging']): void {
    if (arranging === null) {
      if (liftedCard !== null) {
        liftedCard.el.removeAttribute('data-arrange-dragging');
        liftedCard.tile.remove();
        liftedCard = null;
      }
      return;
    }
    const at = placeSpot(canvas, arranging.at);
    if (at === null) return;
    if (liftedCard !== null && liftedCard.id !== arranging.card) drawArranging(root, box, null);
    if (liftedCard === null) {
      const el = canvas.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${arranging.card}"]`);
      const face = el?.querySelector('.card');
      if (!(el instanceof HTMLElement) || !face) return;
      const tile = document.createElement('div');
      tile.className = 'presence__lift';
      tile.setAttribute('aria-hidden', 'true');
      const copy = face.cloneNode(true) as HTMLElement;
      for (const n of [copy, ...copy.querySelectorAll('[data-card-id], [data-testid]')]) {
        n.removeAttribute('data-card-id');
        n.removeAttribute('data-testid');
      }
      tile.append(copy);
      tile.style.width = `${el.getBoundingClientRect().width}px`;
      root.append(tile);
      el.setAttribute('data-arrange-dragging', '');
      liftedCard = { id: arranging.card, el, tile };
    }
    liftedCard.tile.style.left = `${at.x - box.left}px`;
    liftedCard.tile.style.top = `${at.y - box.top}px`;
  }

  /**
   * The other half of the hand reorder: a back of THEIR hidden hand glides from `from` to
   * `to` (both indices, `./gestures/hand.ts`'s own doc comment has the
   * reason none of this ever carries an id). A plain `div.presence__back`,
   * the SAME element their held card already uses — `[data-waiting]` is
   * borrowed only for its 300ms house-curve transition, never for the
   * "waiting on a placement" meaning it carries elsewhere in this file — so
   * no new stylesheet rule exists for this. Every back is identical, so
   * there is nothing to settle into: the glide alone is the whole signal.
   */
  function glideHandMove(root: HTMLElement, box: DOMRect, move: PresenceEcho['handMove']): void {
    if (move === null) return;
    const hand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="them"]');
    const backs = hand === null ? [] : [...hand.querySelectorAll<HTMLElement>('li.card-back')];
    const from = backs[move.from]?.getBoundingClientRect();
    const to = backs[move.to]?.getBoundingClientRect();
    if (from === undefined || to === undefined || from.width === 0 || to.width === 0) return;
    const ghost = document.createElement('div');
    ghost.className = 'presence__back';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('data-waiting', '');
    ghost.style.width = `${from.width}px`;
    ghost.style.left = `${from.left + from.width / 2 - box.left}px`;
    ghost.style.top = `${from.top + from.height / 2 - box.top}px`;
    root.append(ghost);
    requestAnimationFrame(() => {
      ghost.style.left = `${to.left + to.width / 2 - box.left}px`;
      ghost.style.top = `${to.top + to.height / 2 - box.top}px`;
    });
    setTimeout(() => ghost.remove(), HAND_MOVE_MS);
  }

  function draw(echo: PresenceEcho): void {
    const root = overlay();
    if (root === null) return;
    const box = root.getBoundingClientRect();
    drawArranging(root, box, echo.arranging);
    glideHandMove(root, box, echo.handMove);
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

    // A spell they released stays "held" (`data-cast-lift="parked"`, never `'returning'`) for the
    // WHOLE targeting-and-payment window that follows a cast with a target — every pointer move
    // through it is a fresh `held: true` message for the SAME in-flight card, not a new lift. The
    // point-wait already has the right spot (the release, not wherever her cursor is now aiming);
    // resetting it here raced the id showing up on the stack against her own next mouse move, and
    // the loser decided whether the back ever made it to `commitSpell` at the right point at all.
    const spellWaiting = waiting !== null && !waiting.forBattlefield;
    if (echo.held && !spellWaiting) {
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
    } else if (!echo.held) {
      // The release message carries the exact release spot as `placing.at` (durable: the back
      // waits there until the id shows up) or, from a pre-deploy sender, only `from` (no wait —
      // the old handoff heuristic below). A permanent's own placement message (`placement.ts`)
      // supersedes either the moment it arrives, the same way it always has (`waiting !== null`).
      const placingAt = echo.placing === null ? null : placeSpot(canvas, echo.placing.at);
      if (waiting !== null) {
        // The placement, or an earlier placing wait, already claimed the back — it stays.
      } else if (placingAt !== null) {
        // AD4 rule 2: wait right here — a point, not a battlefield gap — until the spell's id
        // shows up on the stack (`handoff`, below), or a permanent's own placement supersedes this.
        if (back === null) {
          back = document.createElement('div');
          back.className = 'presence__back';
          back.setAttribute('aria-hidden', 'true');
          root.append(back);
        }
        back.style.left = `${placingAt.x - box.left}px`;
        back.style.top = `${placingAt.y - box.top}px`;
        back.setAttribute('data-waiting', '');
        backAt = placingAt;
        waiting = { timer: setTimeout(stopWaiting, WAITING_MS), forBattlefield: false };
      } else {
        const released = echo.from === null ? null : placeSpot(canvas, echo.from);
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
      // A PERMANENT (`forBattlefield`): `Board` consumes the reservation when it draws the card in
      // the gap, and the stand-in simply goes. That happens in React's commit of this very change,
      // which may be AFTER this listener runs — so the reservation is read on the next frame, past
      // the commit. A SPELL's wait has no reservation to read; only the id check below clears it.
      if (waiting.forBattlefield) {
        const theirs = host.theirPlayerId?.() ?? null;
        const standIn = back;
        requestAnimationFrame(() => {
          if (waiting === null || back !== standIn) return;
          if (theirs !== null && pendingPlacementFor(theirs) === null) stopWaiting();
        });
        return;
      }
      if (fresh.length === 0) return;
      const id = fresh[0]!;
      // A permanent's own arrival is handled above, by the reservation going null — never here.
      const onBattlefield = canvas.querySelector(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${id}"]`) !== null;
      if (onBattlefield) return;
      // A SPELL: its id is public now — hand the stand-in to the placed-cards layer, in the same
      // spot this back has been waiting at (`backAt`, the CENTRE `.presence__back` is transformed
      // onto).
      if (backAt !== null) {
        placeSpell(id, backAt, 'them');
        // `placeSpell`'s own repaint runs `placed.ts`'s `promote` SYNCHRONOUSLY, inside this very
        // call — which, the moment `id` (the CARD's) matches a `view.stack` entry's `sourceCardId`,
        // re-keys the registration onto that entry's OWN id at once. `commitSpell(id)` right after
        // would silently no-op on a key that is already gone, so the real id — the one the element
        // `placeSpell` just (re)drew at this exact point now carries — is read back off the DOM,
        // the same way every other geometry fact here is.
        const committed = findPlacedSpellAt(backAt) ?? id;
        commitSpell(committed);
      } else {
        commitSpell(id);
      }
      stopWaiting();
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
    waiting = { timer: setTimeout(stopWaiting, WAITING_MS), forBattlefield: true };
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

  /**
   * AD4 rule 3: the owner of a placed spell dragged it — move the OTHER
   * seat's copy to match. `placeSpell`, not `moveSpell`: the server replays
   * this to a JOINER too (a reload), who has no earlier registration for the
   * id at all — `moveSpell` is a no-op without one. `placeSpell` registers it
   * fresh when needed and just updates the point otherwise, and
   * `commitSpell` is a no-op once already committed — a stack item named on
   * this wire is public either way.
   *
   * A replay can reach this BEFORE the board itself has ever rendered (the
   * match is still "Connecting…" when `forge:join`'s ack carries it) —
   * `placeSpot` has no board box to place it on yet. Retried for up to 3s
   * (the connect-to-board-painted window measured against a real stack,
   * generously bounded), rather than dropped: a joiner has no later message
   * to fall back on.
   */
  function onPlaced(payload: unknown, retryDeadline = Date.now() + 1000): void {
    if (!live) return;
    const parsed = PlacedEchoSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== host.matchId || parsed.data.seat === host.seat) return;
    const at = placeSpot(canvas, parsed.data.at);
    if (at === null) {
      // The board has not painted yet (this can be a joiner's one-time replay, on `forge:join`'s
      // own ack). Retried within this mount for up to a second; `pendingPlaced` carries it past
      // THIS instance's own dispose, for the next mount to pick up — this one remounts several
      // times while a page connects (spectator, then promoted), well inside a second.
      pendingPlaced = payload;
      if (Date.now() < retryDeadline) setTimeout(() => onPlaced(payload, retryDeadline), 50);
      return;
    }
    if (pendingPlaced === payload) pendingPlaced = null;
    placeSpell(parsed.data.spell, at, 'them');
    commitSpell(parsed.data.spell);
  }

  /**
   * This seat dragged a placed spell of its own (`placed.ts`'s own gesture,
   * `gestures/install.ts` — the only caller of `moveSpell` left, since
   * `onPlaced` above uses `placeSpell`/`commitSpell` instead): tell the other
   * screen. `theirCards` is a defensive check should anything else ever call
   * `moveSpell` for the opponent's own spell — that must never bounce back
   * out as if it were this seat's own move.
   */
  const unwatchSpellMoved = onSpellMoved((id, at) => {
    if (!live || host.seat === null) return;
    if ((host.theirCards?.() ?? []).includes(id)) return;
    const spot = spotOf(canvas, at);
    if (spot === null) return;
    host.transport.emit(PLACED_EVENT, { matchId: host.matchId, type: 'placed', spell: id, at: spot });
  });

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerRelease);
  canvas.addEventListener('pointercancel', onPointerRelease);
  document.addEventListener('visibilitychange', onVisibility);
  host.transport.on(PRESENCE_EVENT, onEcho);
  host.transport.on(PLACEMENT_EVENT, onPlacement);
  host.transport.on(PLACED_EVENT, onPlaced);
  // A replay an EARLIER mount of this module received and could not yet place (the board had not
  // painted) — this mount gets its own fresh attempt, since the server only ever sends it once.
  if (pendingPlaced !== null) onPlaced(pendingPlaced);
  const unwatch = host.watch?.(handoff) ?? null;
  handMoveListeners.add(sendHandMove);

  return {
    dispose() {
      stopWaiting();
      live = false;
      unwatch?.();
      unwatchSpellMoved();
      handMoveListeners.delete(sendHandMove);
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
