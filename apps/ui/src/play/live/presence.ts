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
 * and need not be. A card lifted out of the graveyard to be cast (flashback)
 * is public, yet it is held the same way and drawn as the same back: `held`
 * is a boolean by construction, and the wire names no card while it is held.
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
 * A PERMANENT's handoff is always `forge:placement` (`onPlacement`, below):
 * the release rides with the act, through the server, before any Forge frame
 * about the card — both apps ship that wire together, so there is no older
 * sender to fall back to for it. The row reserves the gap the message names;
 * a copy of the card travels from the release point into it, the same trip
 * this seat's own played card makes (`gestures/cast.ts`'s `landCastGhost`),
 * while the real one waits hidden in its slot. The operator, 2026-10-07:
 * *"when cards actually get placed on the board it's not really coming from
 * the card hovering by the cursor."* With motion off (Fast Mode) it simply
 * appears, like everything else.
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
  type PresenceAnchor,
  type PresenceSpot,
} from '@hadoku/shared';

import { newArrow, positionArrow } from './gestures/arrow.ts';
import { expectPlacement, pendingPlacementFor } from '../Board.tsx';
import { CAST_LANDING_ATTR, expectedGapBox, IN_PLACE_PX, landCastGhost } from './gestures/cast.ts';
import { drawnCentreOf, PRESENCE_CARD_ATTR, reportHandover, type HandoverFacts, type Report } from './handover-report.ts';
import { commitSpell, holdSpell, onSpellMoved, placeSpell, placeStackItem, releaseSpell } from './placed.ts';
import { battlefieldCardWidth, sizeAsBattlefieldCard } from '../card-size.ts';
import { GLIDE_MS, PLACEMENT_WAIT_MS } from '../motion.ts';
import type { MatchTransport } from './match.ts';
import { hitAt, scopeOf } from '../../dom.ts';
import './presence.css';

/** After this long without a message, the other seat's presence is taken down. */
export const PRESENCE_STALE_MS = 6000;
/** A point wait's remaining life once the sender says its card is no longer parked and Forge has not yet said where it went. Started once, never pushed back by later messages. */
export const CLEARED_GRACE_MS = 1500;
/**
 * AE26: how long a spell of theirs that showed up on the stack BEFORE their
 * release point reached this screen is remembered, so the point wait that
 * arrives next hands the back to it at once instead of standing beside the
 * face until a timer ends it (the Mana Leak screenshot, 2026-10-09).
 */
export const UNHANDED_MS = 5000;
/** How many frames a placement's stand-in looks for the gap the board reserves for it before giving up. */
const GAP_FRAMES = 30;

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
  /** AE26: the subset of `theirCards` that is on the STACK (by card id) — a spell held there, never a permanent still being drawn. */
  readonly theirStackCards?: () => readonly number[];
  /** Whether motion is on (Fast Mode off); the handoff travels only then. */
  readonly motion?: () => boolean;
  /**
   * Whether THIS seat is actively aiming — a selection is open, or a stack
   * ask is (`match.selectables !== null || stackAsk(match) !== null`, the
   * same condition `paint()` uses for its own arrow). `from` is sent only
   * then: a parked card with no target reports no arrow tail.
   * Absent: treated as never aiming, the safe default (no spurious arrow)
   * until the host wires this in.
   */
  readonly aiming?: () => boolean;
  /** Telemetry: their card's stand-in giving way to its stack card and its row (`./handover-report.ts`). Absent: nothing is sent. */
  readonly report?: Report;
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
 * What a point anchors to inside `frame`: on the battlefield its cards, each named by its id (public
 * there, and drawn by both boards wherever their own layouts put it); in any other zone its slots by
 * index, in the order both boards draw them — a hand's cards or backs.
 */
function slotsOf(frame: HTMLElement, battlefield: boolean): HTMLElement[] {
  return [...frame.querySelectorAll<HTMLElement>(battlefield ? 'li.board-card[data-card-id]' : 'li.board-card, li.card-back')];
}

const ANCHOR_ZONES = ['hand', 'battlefield', 'graveyard', 'exile'] as const;
type AnchorZone = (typeof ANCHOR_ZONES)[number];
const isAnchorZone = (z: string | null): z is AnchorZone => (ANCHOR_ZONES as readonly (string | null)[]).includes(z);
const inside = (r: DOMRect, p: Point): boolean => r.width > 0 && r.height > 0 && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const bounded = (v: number): number => Math.max(-50, Math.min(50, v));

/**
 * A client point, anchored to what BOTH boards draw (`@hadoku/shared`'s
 * "Positions are ANCHORED"): the zone it is in and whose; the NEAREST card
 * of the tier or lane under it (of the whole zone between them) — on the
 * battlefield by its id, elsewhere by its index — or, with none, that tier or
 * lane by name; and the offset in units of that card's box — past 0..1
 * between cards, so the other screen's cursor moves continuously instead of
 * snapping onto a card at its edge. Null outside every zone, and over a stack
 * card (placed by the board fraction itself), so the caller's board fraction
 * is all that is sent. Exported for the tests, which prove it against real
 * rectangles.
 */
export function anchorOf(canvas: HTMLElement, point: Point): PresenceAnchor | null {
  if (hitAt(scopeOf(canvas), point.x, point.y)?.closest('[data-placed-spell]')) return null;
  const zoneEl = [...canvas.querySelectorAll<HTMLElement>('[data-zone][data-owner]')].find(
    (el) => isAnchorZone(el.getAttribute('data-zone')) && inside(el.getBoundingClientRect(), point),
  );
  if (zoneEl === undefined) return null;
  const zone = zoneEl.getAttribute('data-zone') as AnchorZone;
  const battlefield = zone === 'battlefield';
  const rowEl = [...zoneEl.querySelectorAll<HTMLElement>('[data-tier], [data-board-row]')].find((el) => inside(el.getBoundingClientRect(), point)) ?? null;
  const row = rowEl === null ? null : (rowEl.getAttribute('data-tier') ?? rowEl.getAttribute('data-board-row'));
  const frame = rowEl ?? zoneEl;
  let nearest: HTMLElement | null = null;
  let item: number | null = null;
  let box = frame.getBoundingClientRect();
  let best = Infinity;
  slotsOf(frame, battlefield).forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const dx = Math.max(r.left - point.x, 0, point.x - r.right);
    const dy = Math.max(r.top - point.y, 0, point.y - r.bottom);
    if (dx * dx + dy * dy < best) {
      best = dx * dx + dy * dy;
      nearest = el;
      item = i;
      box = r;
    }
  });
  if (box.width === 0 || box.height === 0) return null;
  const card = battlefield && nearest !== null ? Number((nearest as HTMLElement).getAttribute('data-card-id')) : null;
  return {
    zone,
    own: zoneEl.getAttribute('data-owner') === 'you',
    row: card === null && row !== null && /^[a-z]{1,16}$/.test(row) ? row : null,
    card,
    item: card === null ? item : null,
    x: bounded((point.x - box.left) / box.width),
    y: bounded((point.y - box.top) / box.height),
  };
}

/**
 * The anchor resolved on THIS board: the twin zone (the sender's own is this
 * board's "them"); in it the same card by id, wherever this board draws it,
 * or the same tier or lane and slot index; and the same offset in that box
 * with its height mirrored — the seats are drawn mirrored, so their card's
 * bottom edge is at the top here, and a pointer moving down their board moves
 * up this one everywhere, on a card or between cards alike. Kept inside the
 * twin zone (or row). Null when the twin is not drawn here (yet), so the
 * caller falls back to the board fraction.
 */
export function placeAnchor(canvas: HTMLElement, anchor: PresenceAnchor): Point | null {
  if (anchor === null) return null;
  const zoneEl = canvas.querySelector<HTMLElement>(`[data-zone="${anchor.zone}"][data-owner="${anchor.own ? 'them' : 'you'}"]`);
  if (zoneEl === null) return null;
  const frame = anchor.row === null ? zoneEl : zoneEl.querySelector<HTMLElement>(`[data-tier="${anchor.row}"], [data-board-row="${anchor.row}"]`);
  if (frame === null) return null;
  const bounds = frame.getBoundingClientRect();
  const slot =
    anchor.card !== null
      ? frame.querySelector<HTMLElement>(`li.board-card[data-card-id="${anchor.card}"]`)
      : anchor.item === null
        ? frame
        : slotsOf(frame, anchor.zone === 'battlefield')[anchor.item];
  if (slot === undefined || slot === null) return null;
  const r = slot.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return {
    x: Math.max(bounds.left, Math.min(bounds.right, r.left + anchor.x * r.width)),
    y: Math.max(bounds.top, Math.min(bounds.bottom, r.top + (1 - anchor.y) * r.height)),
  };
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
 * pointer), and where the ghost's centre is from the centre of the card's own
 * home box, in units of that box — what the other screen can place against
 * its own drawing of the card. Read, like everything else here, off the DOM
 * the gesture already draws.
 */
function arrangingOf(canvas: HTMLElement): PresenceMessage['arranging'] {
  const li = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"] [data-arrange-dragging]');
  const ghost = canvas.querySelector<HTMLElement>('.board > [data-arrange-ghost]');
  const id = Number(li?.getAttribute('data-board-card') ?? li?.getAttribute('data-card-id'));
  if (li === null || ghost === null || !Number.isFinite(id)) return null;
  const g = ghost.getBoundingClientRect();
  const home = li.getBoundingClientRect();
  if (g.width === 0 || home.width === 0 || home.height === 0) return null;
  return {
    card: id,
    x: bounded((g.left + g.width / 2 - (home.left + home.width / 2)) / home.width),
    y: bounded((g.top + g.height / 2 - (home.top + home.height / 2)) / home.height),
  };
}

/**
 * What this seat's hands are doing, off the gesture layer's own marks — THREE
 * states, and the wire names each one outright (the operator, 2026-10-08, the
 * fourth report of a phantom that would not stand still: "as my cursor moves
 * to answer the question, i can see from the opponents view that the phantom
 * card is still attached. that's nonsense."):
 *
 *   `held`   — `data-cast-lift="lifted"`: the card follows the pointer.
 *   `parked` — `"parked"` or `"carried"`: let go, waiting (a question, an X, a
 *              target, Forge's own frame), standing at its own box centre. NOT
 *              held: the pointer may go anywhere now — to the pop-up, across
 *              the table — and the card stays put, on both screens.
 *   neither  — nothing lifted, or a card on its way home (`"returning"`).
 *
 * `from` is the arrow's tail and nothing else: only while this seat is aiming
 * — the parked card's centre, or the targeter's own path start. The receiver
 * never derives where a back STANDS from it; `parked` carries that, as
 * `placing.at`, on every message for as long as the card is parked.
 */
function handsOf(canvas: HTMLElement, aiming: boolean): { held: boolean; parked: Point | null; from: Point | null } {
  /*
   * AE18 (2026-10-08, the operator, on top of AE12: "it looks like we have two
   * sets of card play animations going on... a new card phantom pops into
   * the cursor"): `settleParkedIfResolved` (`gestures/install.ts`) confirms
   * landing and sets `CAST_LANDING_ATTR` on the real card SYNCHRONOUSLY, the
   * same frame — but the ghost's own `CAST_LIFT_ATTR` does not flip to
   * `'returning'` until the NEXT animation frame (`landCastGhost`'s own
   * one-frame wait, so the flight has a painted start point to transition
   * from). A presence tick that lands in that one-frame gap still finds the
   * ghost `'parked'`, and sends `placing.at` once more for a card this very
   * seat already knows is landing — the sender's own half of the stale
   * `placing` the receiver's own rule (`draw()`'s `lifted` check) also
   * guards against. Checked first, cheaply: this is never true outside that
   * one frame.
   */
  if (canvas.querySelector(`[${CAST_LANDING_ATTR}]`) !== null) return { held: false, parked: null, from: null };
  const standing = canvas.querySelector<HTMLElement>(
    '[data-cast-ghost][data-cast-lift="parked"], [data-cast-lift="parked"], [data-cast-lift="carried"]',
  );
  let parked: Point | null = null;
  if (standing !== null) {
    const p = standing.getBoundingClientRect();
    if (p.width > 0) parked = { x: p.left + p.width / 2, y: p.top + p.height / 2 };
  }
  const held = standing === null && canvas.querySelector('[data-cast-lift="lifted"]') !== null;
  if (!aiming) return { held, parked, from: null };
  if (parked !== null) return { held, parked, from: parked };
  const tail = canvas.querySelector<SVGPathElement>('[data-testid="targeter"] path');
  const d = tail?.getAttribute('d') ?? null;
  const m = d === null ? null : /^M (-?[\d.]+) (-?[\d.]+)/.exec(d);
  if (m === null) return { held, parked, from: null };
  const board = boardBox(canvas);
  if (board === null) return { held, parked, from: null };
  return { held, parked, from: { x: board.left + Number(m[1]), y: board.top + Number(m[2]) } };
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
    const anchor = pointer === null ? null : anchorOf(canvas, pointer);
    const hands = handsOf(canvas, host.aiming?.() ?? false);
    const from = hands.from === null ? null : spotOf(canvas, hands.from);
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      anchor,
      held: hands.held,
      from,
      handRows: handRowsOf(canvas),
      arranging: arrangingOf(canvas),
      placing: placingOf(hands.parked),
      handMove: null,
    };
    const key = JSON.stringify(message);
    if (key === lastMessage) return;
    lastMessage = key;
    lastSent = Date.now();
    host.transport.emit(PRESENCE_EVENT, message);
  }

  /**
   * `placing.at` for a parked card: its centre, as a spot, on EVERY message
   * while it is parked — the other screen stands its back there and nothing
   * the pointer does moves it. Never over this seat's own hand: a hand card
   * released there is a cancel (`resolveLift`'s `overHome`), nothing is coming.
   */
  function placingOf(parked: Point | null): { at: PresenceSpot } | null {
    if (parked === null) return null;
    const spot = spotOf(canvas, parked);
    return spot === null || spot.zone === 'hand' ? null : { at: spot };
  }

  /**
   * The lift's state as one string (held, or parked and where), for the
   * observer below to tell a change from a repaint.
   */
  function liftStateOf(): string {
    const hands = handsOf(canvas, false);
    const where = hands.parked === null ? '-' : `${Math.round(hands.parked.x)},${Math.round(hands.parked.y)}`;
    return `${hands.held ? 'held' : '-'}@${where}`;
  }
  let lastLiftState = liftStateOf();

  /** Right now, outside the throttle — a state change, not a position. */
  function sendNow(): void {
    if (sendTimer !== null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    send(lastPointer);
  }

  /**
   * The gesture layer marks its own DOM (`data-cast-lift`: lifted → parked →
   * gone); this seat speaks the moment that mark changes, not on the next
   * pointer move — which may never come. The operator, 2026-10-08: "after the
   * question is answered, the card correctly animates to the right spot but
   * the phantom card is STILL attached to the cursor until i move the mouse
   * again." A repaint that changes nothing (the same state at the same point)
   * sends nothing; `send`'s own dedup catches the rest.
   */
  const liftWatch = new MutationObserver(() => {
    const state = liftStateOf();
    if (state === lastLiftState) return;
    lastLiftState = state;
    sendNow();
  });

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
    const anchor = lastPointer === null ? null : anchorOf(canvas, lastPointer);
    const hands = handsOf(canvas, host.aiming?.() ?? false);
    const handFrom = hands.from === null ? null : spotOf(canvas, hands.from);
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      anchor,
      held: hands.held,
      from: handFrom,
      handRows: handRowsOf(canvas),
      arranging: null,
      placing: placingOf(hands.parked),
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
   * `placing` carries the release point as a durable marker (AD4 rule 2): the
   * receiver stands a back there, rather than inferring the wait from timing,
   * until either the id shows up on the stack (a spell) or a permanent's own
   * placement message (`placement.ts`) supersedes it; every message after
   * this one, while the card is parked, carries the same (`placingOf`). `from`
   * is null here — it is the arrow's tail, never a stand. Never sent for a
   * release back over the zone the card was lifted from — the hand, or the
   * graveyard a flashback card came out of: that is always a cancel
   * (`resolveLift`'s own `overHome` check is what sends it home, never to
   * Forge), so nothing is ever coming — the back must still vanish at once,
   * not wait.
   */
  function sendRelease(point: Point): void {
    if (!live || host.seat === null) return;
    const spot = spotOf(canvas, point);
    const anchor = anchorOf(canvas, point);
    const home = canvas.querySelector('[data-cast-lift="lifted"]')?.closest('[data-zone]') ?? null;
    const cancelled = home !== null && inside(home.getBoundingClientRect(), point);
    if (sendTimer !== null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      anchor,
      held: false,
      from: null,
      handRows: handRowsOf(canvas),
      arranging: null,
      placing: spot === null || cancelled ? null : { at: spot },
      handMove: null,
    };
    lastMessage = JSON.stringify(message);
    lastPointer = { x: point.x, y: point.y };
    lastSent = Date.now();
    host.transport.emit(PRESENCE_EVENT, message);
  }

  /**
   * The release point `sendRelease` carries: the lifted card's OWN
   * box centre right now, not the raw pointerup coordinates — a frame can go
   * by with no intervening `pointermove` before the up event, which left the
   * card's last-drawn spot and the wire's release spot a few pixels apart
   * (the operator, 2026-10-08: "a bit of desync between where the phantom
   * card was and where the cursor actually released the card"). Falls back
   * to the raw point when nothing is lifted (a release this module did not
   * cause) or has no box yet (a test fixture with no stubbed rect).
   */
  function liftedCentre(fallback: Point): Point {
    const lift = canvas.querySelector<HTMLElement>('[data-cast-lift]');
    if (lift === null) return fallback;
    const r = lift.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : fallback;
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
    if (handsOf(canvas, host.aiming?.() ?? false).held) sendRelease(liftedCentre({ x: event.clientX, y: event.clientY }));
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
  /**
   * Their back waiting for the card its stand-in is: in the gap their release
   * reserved for a PERMANENT (`forBattlefield: true`, `Board`'s own
   * reservation clears it below), or at the exact point for a SPELL
   * (`forBattlefield: false`, cleared by `handoff`'s id check instead) —
   * or this times out. `hand` is the fewest backs their hand has had since the
   * wait began: one more than that is the card coming home (`flyHome`).
   * `cleared`: the sender has said the card is no longer parked, and the
   * short grace is running.
   */
  let waiting: { timer: ReturnType<typeof setTimeout>; forBattlefield: boolean; card: number | null; hand: number; cleared: boolean } | null = null;
  /** Where the back stands, or — on its glide into a placement's gap — where it is heading. */
  let backAt: Point | null = null;
  /** Telemetry for the play in hand (`./handover-report.ts`): when its release reached this screen, its glide began, its spell was seen on the stack. */
  let play: { releasedAt: number; glideStartedAt: number | null; stackFrameAt: number | null } = { releasedAt: 0, glideStartedAt: null, stackFrameAt: null };
  function receiverFacts(card: number, how: string, from: Point | null, to: Point | null): HandoverFacts {
    return { screen: 'receiver', card, how, from, to, glideStartedAt: play.glideStartedAt, releasedAt: play.releasedAt === 0 ? null : play.releasedAt, stackFrameAt: play.stackFrameAt, motion: host.motion?.() === true };
  }
  /**
   * The stand-in's glide into its gap (`onPlacement`): `'seeking'` while the board has yet to draw
   * the gap, then `Date.now()` when the glide ends; null when it is not gliding.
   */
  let glide: 'seeking' | number | null = null;
  /** A hand-over to the stack layer held until that glide ends — see the stack case in `handoff`. */
  let handTimer: ReturnType<typeof setTimeout> | null = null;
  let afterSeek: (() => void) | null = null;
  /** The spell (card id) that hand-over is for, kept hidden on the stack layer meanwhile (`holdSpell`). */
  let heldSpell: number | null = null;
  /** Their cards already on the board; a new one right after the back went is the handoff. */
  let known = new Set<number>(host.theirCards?.() ?? []);
  /** AE26: a spell of theirs that arrived with no wait to hand it to — see `UNHANDED_MS`. */
  let unhanded: { id: number; at: number } | null = null;
  /**
   * The card of theirs a placement is waiting for, watched on the DOM until the board draws it in
   * its column: its tile copy flies there from where its stand-in is — the back in the gap, or,
   * for a creature that went to the stack first (the other seat held priority), the placed face
   * its back turned into — instead of the card popping into the gap (presence.spec's release
   * case, red on 812689e). On the DOM itself, so the flight starts in the same frame the board
   * draws the card: waiting for the next match change showed the card in its slot for 13–79 ms
   * first (the Viridian Shaman recording, 2026-10-09), and the next animation frame for one
   * painted frame (w67-shaman's bears, a spell resolving before the glide ended).
   */
  let stackBound: MutationObserver | null = null;
  /**
   * A play of theirs begins with a lift: a `placing` opens a wait only if their
   * card has been lifted (`held`) since the last wait ended. Every message sent
   * while their card stood parked carries `placing.at` — and the stand-in glides
   * into the gap meanwhile, so the point moves — and one sent just before their
   * screen let it go can arrive after this screen already handed the play over
   * (`forge:placement`, the spell's id, or the card home). Matched by POINT it
   * stood up a second back wherever the point had moved to, for as long as their
   * pointer kept sending (the Viridian Shaman recording, 2026-10-09; AE18 before
   * it). True at the start: a joiner may arrive mid-play.
   */
  let lifted = true;

  function overlay(): HTMLElement | null {
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }

  /** Where `el`'s centre is drawn this frame — mid-glide included — or null when it has no box. */
  function drawnCentre(el: Element): Point | null {
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
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
    lifted = false;
    if (handTimer !== null) clearTimeout(handTimer);
    handTimer = null;
    afterSeek = null;
    glide = null;
    if (heldSpell !== null) releaseSpell(heldSpell);
    heldSpell = null;
    if (waiting === null) return;
    clearTimeout(waiting.timer);
    waiting = null;
    back?.remove();
    back = null;
  }
  /**
   * Their spell is public while its stand-in is still gliding into its gap: the stand-in turns over
   * on its way, so the card is revealed with the lands that pay for it (the operator, 2026-10-11:
   * "release card, reveal it, pay for mana … can we squish together 1-3"), and the stack card that
   * takes over where it comes to rest is the same face. The face is the one `placed.ts` already drew
   * for the held stack card, so it is never shown sooner than that one would be — a back until the
   * art has decoded — and looked for each frame until it is there or the glide is over.
   */
  function turnOver(standIn: HTMLElement, card: number): void {
    if (back !== standIn || waiting === null || standIn.hasAttribute('data-face')) return;
    const placed = canvas.querySelector(`[data-placed-card="${card}"]`);
    const face = placed === null || placed.querySelector('.placed__back') !== null ? null : placed.querySelector('.placed__tile .card');
    if (face === null) {
      requestAnimationFrame(() => turnOver(standIn, card));
      return;
    }
    const copy = face.cloneNode(true) as HTMLElement;
    for (const el of [copy, ...copy.querySelectorAll('[data-card-id], [data-testid]')]) {
      el.removeAttribute('data-card-id');
      el.removeAttribute('data-testid');
    }
    standIn.append(copy);
    standIn.setAttribute('data-face', '');
  }

  /** The one element every back/stand-in on this board is — appended, never reused across one. */
  function backElement(root: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = 'presence__back';
    el.setAttribute('aria-hidden', 'true');
    root.append(el);
    return el;
  }
  /** The one back, at `at` (its centre): made if missing, sized like a card in their hand. */
  function standBack(root: HTMLElement, box: DOMRect, at: Point): void {
    if (back === null) back = backElement(root);
    // A battlefield card's size — the size their lifted card is drawn at (AD2) and the size it lands
    // at — from the one measure (`card-size.ts`); never a hand card's, never a stylesheet guess.
    sizeAsBattlefieldCard(back, battlefieldCardWidth(canvas, 'them') ?? battlefieldCardWidth(canvas, 'you'));
    back.style.left = `${at.x - box.left}px`;
    back.style.top = `${at.y - box.top}px`;
    backAt = at;
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
    const under = at === null ? null : hitAt(scopeOf(canvas), at.x, at.y)?.closest('[data-board-card]') ?? null;
    if (under === hinted) return;
    hinted?.removeAttribute('data-presence-hint');
    hinted = under;
    hinted?.setAttribute('data-presence-hint', '');
  }

  /** Their rearrange, mirrored: their card dims in place and its tile stands as far off it, in cards, as theirs does. */
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
    // A redraw of their row replaces the card's element: the tile is rebuilt on the new one.
    if (liftedCard !== null && (liftedCard.id !== arranging.card || !liftedCard.el.isConnected)) drawArranging(root, box, null);
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
    // Off the card's home as THIS board draws it, by the same fraction of a card, the height mirrored.
    const home = liftedCard.el.getBoundingClientRect();
    liftedCard.tile.style.left = `${home.left + home.width * (0.5 + arranging.x) - box.left}px`;
    liftedCard.tile.style.top = `${home.top + home.height * (0.5 - arranging.y) - box.top}px`;
  }

  /**
   * The other half of the hand reorder: a back of THEIR hidden hand glides from `from` to
   * `to` (both indices, `./gestures/hand.ts`'s own doc comment has the
   * reason none of this ever carries an id). A plain `div.presence__back`,
   * the SAME element their held card already uses — `[data-gliding]` (J3,
   * wave 64) is its OWN attribute, sharing `[data-waiting]`'s 300ms
   * house-curve transition in `presence.css` but never its "waiting on a
   * placement" meaning: before this fold, this glide borrowed
   * `[data-waiting]` itself, which read as a placement wait to anything
   * watching for one (`e2e/presence.spec.ts`'s own placement assertions had
   * to read past it). Every back is identical, so there is nothing to settle
   * into: the glide alone is the whole signal.
   */
  function glideHandMove(root: HTMLElement, box: DOMRect, move: PresenceEcho['handMove']): void {
    if (move === null) return;
    const hand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="them"]');
    const backs = hand === null ? [] : [...hand.querySelectorAll<HTMLElement>('li.card-back')];
    const from = backs[move.from]?.getBoundingClientRect();
    const to = backs[move.to]?.getBoundingClientRect();
    if (from === undefined || to === undefined || from.width === 0 || to.width === 0) return;
    const ghost = backElement(root);
    ghost.setAttribute('data-gliding', '');
    ghost.style.width = `${from.width}px`;
    ghost.style.left = `${from.left + from.width / 2 - box.left}px`;
    ghost.style.top = `${from.top + from.height / 2 - box.top}px`;
    requestAnimationFrame(() => {
      ghost.style.left = `${to.left + to.width / 2 - box.left}px`;
      ghost.style.top = `${to.top + to.height / 2 - box.top}px`;
    });
    setTimeout(() => ghost.remove(), GLIDE_MS);
  }

  function draw(echo: PresenceEcho): void {
    const root = overlay();
    if (root === null) return;
    const box = root.getBoundingClientRect();
    drawArranging(root, box, echo.arranging);
    glideHandMove(root, box, echo.handMove);
    // Anchored to the twin of what their pointer is in (`anchorOf`) — the board fraction drifts off
    // a card the moment the two screens size a row differently; it is the fallback outside every zone.
    const at = echo.pointer === null ? null : placeAnchor(canvas, echo.anchor) ?? placeSpot(canvas, echo.pointer);
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

    // The wire says which of three things their card is doing (`handsOf`), and the back is drawn
    // from that alone. Parked (`placing.at`): a back stands THERE, and nothing their pointer does
    // moves it. Held: a back follows their pointer. Neither: no back — unless a wait already owns
    // one (the placement's gap, or this very point), which only its own ending takes down
    // (`onPlacement`'s reservation, `handoff`'s id, or the timeout). Four days of a phantom
    // attached to the cursor came from inferring the first state from the second.
    if (echo.placing !== null) {
      const placingAt = placeSpot(canvas, echo.placing.at);
      // A play already handed over (no lift since): this echo was true when it was SENT, and is
      // that play's stale tail now — see `lifted`.
      if (waiting === null && placingAt !== null && lifted) {
        // AD4 rule 2: wait right here — a point, not a battlefield gap — until the spell's id
        // shows up on the stack (`handoff`, below), or a permanent's own placement supersedes this.
        standBack(root, box, placingAt);
        back!.setAttribute('data-waiting', '');
        play = { releasedAt: Date.now(), glideStartedAt: null, stackFrameAt: null };
        waiting = { timer: setTimeout(stopWaiting, PLACEMENT_WAIT_MS), forBattlefield: false, card: null, hand: theirHandBacks().length, cleared: false };
        // AE26: their spell beat this message here (Forge's frame won the race against presence):
        // it is already a placed card, drawn pending at nobody's point. Hand the point over NOW —
        // the one object, in place — never a back beside a face until a timer ends it.
        if (unhanded !== null && Date.now() - unhanded.at < UNHANDED_MS) {
          const { id } = unhanded;
          unhanded = null;
          if (onTheirStack(id)) handToSpell(id);
        }
      }
      // A wait already holds the back — the placement's gap, or this point: it stays put.
    } else if (echo.held) {
      lifted = true;
      // Lifted: the back follows the pointer. A wait pending (a card of theirs still arriving)
      // keeps its stand-in; their new lift is drawn once that wait ends.
      if (waiting === null) standBack(root, box, at);
    } else if (waiting === null) {
      back?.remove();
      back = null;
    } else if (!waiting.forBattlefield && !waiting.cleared) {
      // Their parked card is gone from their screen with no placement and no id yet. Forge says
      // which: the id on the stack (`handoff` hands over), or the card back in their hand
      // (`flyHome`). The grace only covers a cast Forge never took at all, so it starts once —
      // every pointer move after a cancel carries this same state, and restarting it on each one
      // kept the back on the board for as long as they kept moving.
      waiting.cleared = true;
      clearTimeout(waiting.timer);
      waiting.timer = setTimeout(stopWaiting, CLEARED_GRACE_MS);
    }

    const theirHand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="them"]');
    if (echo.handRows === 2) theirHand?.setAttribute('data-presence-rows', '2');
    else theirHand?.removeAttribute('data-presence-rows');

    // The arrow is the tail of an active aim — `from` is sent for nothing else (a parked card
    // being aimed from, or the targeter's own start), so it is drawn whenever it is there.
    const from = echo.from === null ? null : placeSpot(canvas, echo.from);
    if (from !== null) {
      if (arrow === null) {
        arrow = newArrow({ className: 'presence__arrow' });
        root.append(arrow);
      }
      positionArrow(arrow, from, at, box);
    } else {
      arrow?.remove();
      arrow = null;
    }
    hint(at);

    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = setTimeout(takeDown, PRESENCE_STALE_MS);
  }

  function onTheirBattlefield(id: number): boolean {
    return canvas.querySelector(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${id}"]`) !== null;
  }

  /**
   * Whether a fresh card of theirs is a SPELL on the stack. The host's own reader when it
   * has one: "not on the battlefield yet" is also true of a land in the frame before React
   * draws it, and that misread handed a land drop to the stack layer (presence.spec's
   * release case, 3/3 red on the first AE26 cut).
   */
  function onTheirStack(id: number): boolean {
    const stack = host.theirStackCards?.();
    return stack === undefined ? !onTheirBattlefield(id) : stack.includes(id);
  }

  /**
   * A SPELL of theirs: its id is public now — the stand-in's point goes to the
   * placed-cards layer (`placeSpell` where the back stands) and the card is
   * turned over there; the back is retired. A back still gliding into its gap is
   * never handed over mid-way: the stack case in `handoff` waits for the glide to
   * end, so the face is drawn where the back came to rest, which is where the
   * card lands.
   */
  function handToSpell(id: number): Point | null {
    const at = backAt;
    play.stackFrameAt ??= Date.now();
    back?.setAttribute(PRESENCE_CARD_ATTR, String(id));
    reportHandover(host.report, 'handover', canvas, receiverFacts(id, 'stack', back === null ? null : drawnCentre(back), at));
    if (at !== null) {
      placeSpell(id, at, 'them');
      // `placeSpell`'s own repaint runs `placed.ts`'s `promote` SYNCHRONOUSLY, inside this very
      // call — which, the moment `id` (the CARD's) matches a `view.stack` entry's `sourceCardId`,
      // re-keys the registration onto that entry's OWN id at once. `commitSpell(id)` right after
      // would silently no-op on a key that is already gone, so the real id — the one the element
      // `placeSpell` just (re)drew at this exact point now carries — is read back off the DOM,
      // the same way every other geometry fact here is.
      const committed = findPlacedSpellAt(at) ?? id;
      commitSpell(committed);
    } else {
      commitSpell(id);
    }
    stopWaiting();
    return at;
  }

  function theirHandBacks(): NodeListOf<HTMLElement> {
    return canvas.querySelectorAll<HTMLElement>('[data-zone="hand"][data-owner="them"] li.card-back');
  }

  /**
   * Their cast was cancelled: Forge has put the card back in their hand (one
   * more back there than at any point of the wait). The stand-in goes home the
   * way the caster's own screen sends it — `landCastGhost`, the one trip a card
   * makes to its place on either screen — from where it stands to the last back
   * of their hand, which waits hidden until it lands. The operator, 2026-10-09:
   * *"it should have returned to the hand using the same animation as how cards
   * return to the hand when viewed from the active players side."*
   */
  function flyHome(): void {
    const from = back?.getBoundingClientRect() ?? null;
    const backs = theirHandBacks();
    const slot = backs[backs.length - 1];
    stopWaiting();
    if (from === null || from.width === 0 || slot === undefined || host.motion?.() !== true) return;
    const ghost = document.createElement('div');
    ghost.className = 'presence__handoff';
    ghost.setAttribute('aria-hidden', 'true');
    const face = document.createElement('div');
    face.className = 'card-back';
    ghost.append(face);
    ghost.style.width = `${from.width}px`;
    landCastGhost(canvas, null, ghost, { x: from.left + from.width / 2, y: from.top + from.height / 2 }, slot);
  }

  /**
   * `stackBound`: fly `card` from `from()` the moment the board draws it in their battlefield —
   * in the commit's own microtask, so the card is never painted in its slot before its copy
   * covers it. `from()` returning null means the play ended some other way: nothing flies.
   */
  function flyWhenDrawn(card: number, from: () => Point | null): void {
    stackBound?.disconnect();
    const until = Date.now() + PLACEMENT_WAIT_MS;
    const watch = new MutationObserver(() => {
      if (Date.now() < until && !onTheirBattlefield(card)) return;
      watch.disconnect();
      if (stackBound === watch) stackBound = null;
      const at = Date.now() < until ? from() : null;
      if (at !== null) flyTile(card, at);
    });
    watch.observe(canvas, { childList: true, subtree: true });
    stackBound = watch;
  }

  /** The card they were holding has appeared: its copy travels from the back's last place to its own. */
  function handoff(): void {
    const cards = host.theirCards?.() ?? [];
    const fresh = cards.filter((id) => !known.has(id));
    known = new Set(cards);
    if (waiting === null) {
      // AE26: a spell arriving with no wait to hand it to is remembered for the point wait that
      // may be a message behind it (Forge's frame beat presence here). A permanent's arrival is
      // `onPlacement`'s, never this.
      const spell = fresh.find((id) => onTheirStack(id));
      if (spell !== undefined) unhanded = { id: spell, at: Date.now() };
    }
    if (waiting !== null && back !== null) {
      // A PERMANENT (`forBattlefield`): `Board` consumes the reservation when it draws the card in
      // the gap, and `onPlacement`'s watch flies it there on that commit. That commit may be AFTER
      // this listener runs — so the reservation is read on the next frame, past it: still pending
      // means the card went to the stack. A SPELL's wait has no reservation to read; only the id
      // check below clears it.
      if (waiting.forBattlefield) {
        const theirs = host.theirPlayerId?.() ?? null;
        const standIn = back;
        requestAnimationFrame(() => {
          if (waiting === null || back !== standIn || theirs === null || pendingPlacementFor(theirs) === null) return;
          // AE26 (the Mana Leak screenshot): a CREATURE dragged to the battlefield carries a
          // placement (a column is reserved, this wait expects it there) — but while the other
          // seat holds priority it sits on the STACK first. Past React's commit (this frame) a
          // fresh id of theirs that is still nowhere on the battlefield, with the reservation
          // still pending, is on the stack: the spell case — the back hands over to the placed
          // card at its own point, turned over in place; the column's reservation stays for the
          // day it resolves. The host says which of their cards are on the stack; without that
          // reader (tests), "not on the battlefield" stands in for it.
          //
          // Forge answers a cast in about the glide's own time, so the back may still be on its
          // way into the gap: handing over then drew the face short of it, and the card hopped the
          // rest of the way when it landed (w67-shaman, 16 px). The glide finishes first, the stack
          // card held hidden meanwhile (`holdSpell`: its pending window alone ran out first when
          // the glide started late, and it showed at the default spot). A spell that resolves
          // meanwhile is in its column, and `onPlacement`'s watch flies it there.
          const onStack = fresh.find((id) => onTheirStack(id));
          if (onStack === undefined) return;
          play.stackFrameAt ??= Date.now();
          const wait = waiting;
          const settle = (): void => {
            handTimer = null;
            afterSeek = null;
            if (waiting !== wait || back !== standIn || !onTheirStack(onStack)) return;
            const left = glide === 'seeking' ? null : (glide ?? 0) - Date.now();
            if (left === null || left > 0) {
              holdSpell(onStack);
              heldSpell = onStack;
              turnOver(standIn, onStack);
              if (left === null) afterSeek = settle;
              else handTimer = setTimeout(settle, left);
              return;
            }
            const at = handToSpell(onStack);
            if (at !== null) flyWhenDrawn(onStack, () => at);
          };
          if (handTimer !== null) clearTimeout(handTimer);
          settle();
        });
        return;
      }
      if (fresh.length === 0) {
        // Past React's commit, their hand's backs are what Forge says now.
        const standIn = back;
        requestAnimationFrame(() => {
          if (waiting === null || waiting.forBattlefield || back !== standIn) return;
          const n = theirHandBacks().length;
          if (n < waiting.hand) waiting.hand = n;
          else if (n > waiting.hand) flyHome();
        });
        return;
      }
      const id = fresh[0]!;
      // A permanent's own arrival is handled above, by the reservation going null — never here.
      if (onTheirBattlefield(id)) return;
      handToSpell(id);
      return;
    }
    // No wait pending: a permanent's arrival with no placement message is not this seat's to
    // animate — `onPlacement` is the one trigger, and both apps ship it together.
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
  /**
   * A copy of their card's own tile travels from `from` to the card's place in
   * its row (`landCastGhost`: the one trip a played card makes on EITHER
   * screen), the card itself hidden there until the copy lands. Nothing
   * travels with motion off, or before the board has drawn the tile.
   */
  function flyTile(card: number, from: Point): void {
    const settled = canvas.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${card}"]`);
    const tile = settled?.querySelector('.card');
    const to = drawnCentreOf(settled);
    const inPlace = to !== null && Math.hypot(to.x - from.x, to.y - from.y) < IN_PLACE_PX;
    const how = !(settled instanceof HTMLElement) || !tile ? 'no-tile' : host.motion?.() !== true ? 'motion-off' : inPlace ? 'swap' : 'flight';
    reportHandover(host.report, 'landing', canvas, receiverFacts(card, how, from, to));
    if (!(settled instanceof HTMLElement) || !tile || host.motion?.() !== true) return;
    const ghost = document.createElement('div');
    ghost.className = 'presence__handoff';
    ghost.setAttribute(PRESENCE_CARD_ATTR, String(card));
    sizeAsBattlefieldCard(ghost, battlefieldCardWidth(canvas, 'them'));
    ghost.setAttribute('aria-hidden', 'true');
    const copy = tile.cloneNode(true) as HTMLElement;
    for (const el of [copy, ...copy.querySelectorAll('[data-card-id], [data-testid]')]) {
      el.removeAttribute('data-card-id');
      el.removeAttribute('data-testid');
    }
    ghost.append(copy);
    landCastGhost(canvas, card, ghost, from, settled);
  }

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
    play = { releasedAt: Date.now(), glideStartedAt: null, stackFrameAt: null };
    const already = canvas.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${card}"]`);
    if (already !== null) {
      // The frame came first: the reservation moves the card on the next commit; its tile flies
      // from the release point to wherever it settles.
      stopWaiting();
      requestAnimationFrame(() => flyTile(card, from));
      return;
    }
    // The back this play already drew — following their pointer, or waiting at the release point —
    // is the stand-in from here, at a hand card's size; taking it down and making a new one drew the
    // stylesheet's fallback size, twice a battlefield card (the Viridian Shaman recording).
    if (waiting !== null) clearTimeout(waiting.timer);
    waiting = null;
    lifted = false;
    standBack(root, root.getBoundingClientRect(), from);
    const standIn = back!;
    standIn.setAttribute('data-waiting', '');
    standIn.setAttribute(PRESENCE_CARD_ATTR, String(card));
    const wait = { timer: setTimeout(stopWaiting, PLACEMENT_WAIT_MS), forBattlefield: true, card, hand: theirHandBacks().length, cleared: false };
    waiting = wait;
    // The card reaching its column while the stand-in still waits — straight from the hand, or a
    // spell resolving before the glide let it hand over to the stack — finishes the stand-in's
    // trip: the card's own tile copy flies on from wherever the stand-in is drawn now (Forge
    // answers a cast faster than the 300 ms glide more often than not; taking the back down cut
    // the glide short and the card popped into the gap), and from the gap itself (Forge was slow)
    // it is a stand-still reveal. A spell handed over to the stack re-arms this from there.
    flyWhenDrawn(card, () => {
      if (waiting !== wait || back !== standIn) return null;
      const at = drawnCentre(standIn) ?? backAt;
      stopWaiting();
      return at;
    });
    // The board draws the reserved gap on its next commit — usually before the next frame, not
    // always under load (a busy claw left the back at the release point, w67-shaman): looked for
    // again each frame until it is there.
    // A spell that reaches the stack meanwhile waits for the glide (`handoff`'s `settle`).
    glide = 'seeking';
    const seek = (frames: number): void => {
      if (waiting === null || back !== standIn) return;
      const gap = expectedGapBox(canvas, 'them');
      const box2 = overlay()?.getBoundingClientRect();
      if (gap === null || box2 === undefined) {
        if (frames > 0) requestAnimationFrame(() => seek(frames - 1));
        else {
          glide = null;
          afterSeek?.();
        }
        return;
      }
      // It stands in the gap from here: a spell it hands over to (a creature held on the stack)
      // is drawn there, not back at the release point (the Viridian Shaman recording).
      backAt = { x: gap.left + gap.width / 2, y: gap.top + gap.height / 2 };
      standIn.style.left = `${backAt.x - box2.left}px`;
      standIn.style.top = `${backAt.y - box2.top}px`;
      standIn.style.width = `${gap.width}px`;
      play.glideStartedAt = Date.now();
      glide = Date.now() + GLIDE_MS;
      afterSeek?.();
    };
    requestAnimationFrame(() => seek(GAP_FRAMES));
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
   * seat's copy to match. `placeStackItem`, not `moveSpell`: the server replays
   * this to a JOINER too (a reload), who has no earlier registration for the
   * id at all — `moveSpell` is a no-op without one. `placeStackItem` registers it
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
    placeStackItem(parsed.data.spell, at, 'them', true);
    commitSpell(parsed.data.spell);
  }

  /**
   * This seat dragged a placed spell of its own (`placed.ts`'s own gesture,
   * `gestures/install.ts` — the only caller of `moveSpell` left, since
   * `onPlaced` above uses `placeSpell`/`commitSpell` instead): tell the other
   * screen. `theirCards` is a defensive check should anything else ever call
   * `moveSpell` for the opponent's own spell — that must never bounce back
   * out as if it were this seat's own move. Throttled to `PRESENCE_SEND_MS`
   * like the pointer, the latest point of each id winning: every message is a
   * full repaint of the stack layer on the other screen, which glides between
   * them (`placed.css`'s `[data-placed-gliding]`), and one per pointer event
   * outran that screen's frames (the operator, 2026-10-10, of an ability chip:
   * "weirdly visually laggy … only see from the opponents view").
   */
  const placedDue = new Map<number, PresenceSpot>();
  let placedTimer: ReturnType<typeof setTimeout> | null = null;
  let placedSent = 0;
  function sendPlaced(): void {
    placedTimer = null;
    placedSent = Date.now();
    for (const [spell, at] of placedDue) host.transport.emit(PLACED_EVENT, { matchId: host.matchId, type: 'placed', spell, at });
    placedDue.clear();
  }
  const unwatchSpellMoved = onSpellMoved((id, at) => {
    if (!live || host.seat === null) return;
    if ((host.theirCards?.() ?? []).includes(id)) return;
    const spot = spotOf(canvas, at);
    if (spot === null) return;
    placedDue.set(id, spot);
    if (placedTimer !== null) return;
    const wait = PRESENCE_SEND_MS - (Date.now() - placedSent);
    if (wait <= 0) sendPlaced();
    else placedTimer = setTimeout(sendPlaced, wait);
  });

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerRelease);
  canvas.addEventListener('pointercancel', onPointerRelease);
  document.addEventListener('visibilitychange', onVisibility);
  liftWatch.observe(canvas, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-cast-lift'] });
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
      stackBound?.disconnect();
      live = false;
      unwatch?.();
      unwatchSpellMoved();
      handMoveListeners.delete(sendHandMove);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerup', onPointerRelease);
      canvas.removeEventListener('pointercancel', onPointerRelease);
      document.removeEventListener('visibilitychange', onVisibility);
      liftWatch.disconnect();
      if (sendTimer !== null) clearTimeout(sendTimer);
      sendTimer = null;
      if (placedTimer !== null) clearTimeout(placedTimer);
      placedTimer = null;
      takeDown();
    },
  };
}
