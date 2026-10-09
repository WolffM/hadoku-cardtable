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
  type PresenceOver,
  type PresenceSpot,
} from '@hadoku/shared';

import { newArrow, positionArrow } from './gestures/arrow.ts';
import { expectPlacement, pendingPlacementFor } from '../Board.tsx';
import { CAST_LANDING_ATTR, expectedGapBox, landCastGhost } from './gestures/cast.ts';
import { commitSpell, onSpellMoved, placeSpell } from './placed.ts';
import type { MatchTransport } from './match.ts';
import './presence.css';

/** After this long without a message, the other seat's presence is taken down. */
export const PRESENCE_STALE_MS = 6000;
/** How long a back waits in its reserved gap for the card; a cast that never resolves just ages out (`Board`'s own TTL). */
export const WAITING_MS = 15_000;
/** A point wait's remaining life once the sender says its card is no longer parked (a cancel, or the id a frame away). */
export const CLEARED_GRACE_MS = 1500;
/**
 * AE26: how long a spell of theirs that showed up on the stack BEFORE their
 * release point reached this screen is remembered, so the point wait that
 * arrives next hands the back to it at once instead of standing beside the
 * face until a timer ends it (the Mana Leak screenshot, 2026-10-09).
 */
export const UNHANDED_MS = 5000;
/** How long a hand-move's glide runs — the same number `./gestures/hand.ts`'s own FLIP uses, so the two screens move in step. */
export const HAND_MOVE_MS = 300;
/** AE18: how long a `forge:placement`'s own point stays "recently placed" — long enough to catch a `placing` echo sent before it, delivered after; the race is one network hop, never seconds. */
export const RECENTLY_PLACED_MS = 3000;

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
  /**
   * Whether THIS seat is actively aiming — a selection is open, or a stack
   * ask is (`match.selectables !== null || stackAsk(match) !== null`, the
   * same condition `paint()` uses for its own arrow). `from` is sent only
   * then: a parked card with no target reports no arrow tail.
   * Absent: treated as never aiming, the safe default (no spurious arrow)
   * until the host wires this in.
   */
  readonly aiming?: () => boolean;
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

/** Close enough to call the same client point — a couple of CSS pixels of rounding, never a real move. */
const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;

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
 * What a client point is OVER, when that is a sharper anchor than the board
 * fraction: a public card (`[data-board-card]` — battlefield,
 * graveyard, exile — or `[data-placed-spell]`, the stack's own layer), or a
 * slot of the VIEWER's OWN hand (never a card id there — the receiver draws
 * that hand as backs, so only the slot's INDEX may cross). Hovering the
 * OTHER seat's hand (already drawn as backs, nothing to anchor to) or
 * nothing at all answers `null`, and the caller falls back to the board
 * fraction exactly as before. Exported for the tests, which prove it against
 * real rectangles the way `spotOf` does.
 */
export function overOf(canvas: HTMLElement, point: Point): PresenceOver | null {
  // jsdom (every test not stubbing this itself) has no `elementFromPoint` at all — the same
  // guard `hint`'s own caller would need, if it had one; this one does not, so it is here.
  if (typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(point.x, point.y);
  if (el === null) return null;
  const ownHandLi = el.closest<HTMLElement>('[data-zone="hand"][data-owner="you"] li');
  if (ownHandLi !== null) {
    const hand = ownHandLi.closest<HTMLElement>('[data-zone="hand"]');
    const siblings = hand === null ? [] : [...hand.querySelectorAll<HTMLElement>('li')];
    const idx = siblings.indexOf(ownHandLi);
    const r = ownHandLi.getBoundingClientRect();
    if (idx < 0 || r.width === 0 || r.height === 0) return null;
    return { hand: idx, x: clamp01((point.x - r.left) / r.width), y: clamp01((point.y - r.top) / r.height) };
  }
  const card = el.closest<HTMLElement>('[data-board-card], [data-placed-spell]');
  // Never a card id out of the viewer's own hand — the branch above already answered that case;
  // anything else under the hand's section (there is none today) stays unanchored, not leaked.
  if (card === null || card.closest('[data-zone="hand"][data-owner="you"]') !== null) return null;
  const id = card.getAttribute('data-board-card') ?? card.getAttribute('data-placed-spell');
  const r = card.getBoundingClientRect();
  if (id === null || r.width === 0 || r.height === 0) return null;
  return { card: id, x: clamp01((point.x - r.left) / r.width), y: clamp01((point.y - r.top) / r.height) };
}

/**
 * The spot `over` names, resolved on THIS board: a public card by the SAME
 * id it carries on either screen, or the i-th back of the sender's hand AS
 * DRAWN HERE (`[data-zone="hand"][data-owner="them"]` — the sender is this
 * board's "them"). Null when the element is not drawn here (yet), so the
 * caller falls back to the board-fraction placement.
 */
function placeOver(canvas: HTMLElement, over: PresenceOver): Point | null {
  if (over === null) return null;
  const el =
    'card' in over
      ? (canvas.querySelector<HTMLElement>(`[data-board-card="${over.card}"]`) ?? canvas.querySelector<HTMLElement>(`[data-placed-spell="${over.card}"]`))
      : (canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="them"]')?.querySelectorAll<HTMLElement>('li')[over.hand] ?? null);
  if (el === null || el === undefined) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.left + over.x * r.width, y: r.top + over.y * r.height };
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
   * `placing` the receiver's fix (`draw()`'s `recentlyPlaced` check) now also
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
    const over = pointer === null ? null : overOf(canvas, pointer);
    const hands = handsOf(canvas, host.aiming?.() ?? false);
    const from = hands.from === null ? null : spotOf(canvas, hands.from);
    const lifted = arrangingOf(canvas);
    const arranging = lifted === null ? null : { card: lifted.card, at: spotOf(canvas, lifted.at) };
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      over,
      held: hands.held,
      from,
      handRows: handRowsOf(canvas),
      arranging: arranging === null || arranging.at === null ? null : { card: arranging.card, at: arranging.at },
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
   * the pointer does moves it. Never over this seat's own hand: a release
   * there is a cancel (`resolveLift`'s `overOwnHand`), nothing is coming.
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
    const over = lastPointer === null ? null : overOf(canvas, lastPointer);
    const hands = handsOf(canvas, host.aiming?.() ?? false);
    const handFrom = hands.from === null ? null : spotOf(canvas, hands.from);
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      over,
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
   * release back onto the hand: that is always a cancel (`resolveLift`'s own
   * `overOwnHand` check is what sends it home, never to Forge), so nothing
   * is ever coming — the back must still vanish at once, not wait.
   */
  function sendRelease(point: Point): void {
    if (!live || host.seat === null) return;
    const spot = spotOf(canvas, point);
    const over = overOf(canvas, point);
    if (sendTimer !== null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    const message: PresenceMessage = {
      matchId: host.matchId,
      type: 'presence',
      pointer: spot,
      over,
      held: false,
      from: null,
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
   * or this times out.
   */
  let waiting: { timer: ReturnType<typeof setTimeout>; forBattlefield: boolean; card: number | null } | null = null;
  let backAt: Point | null = null;
  /** Their cards already on the board; a new one right after the back went is the handoff. */
  let known = new Set<number>(host.theirCards?.() ?? []);
  /** AE26: a spell of theirs that arrived with no wait to hand it to — see `UNHANDED_MS`. */
  let unhanded: { id: number; at: number } | null = null;
  /**
   * AE18: the ONE `forge:placement` this episode ever sends, remembered by its
   * own point — the one thing a `placing` echo of the SAME episode and this
   * message both carry, since presence names no card. `onPlacement` sets this
   * the instant it accepts the message, not when the flight actually fires:
   * motion off, or no settled element yet, still means this episode is over
   * for presence purposes, same as a flight that ran. `draw()`'s `placing`
   * branch reads it to ignore a STALE echo — sent (truthfully, at the time)
   * while this seat's own card was still `carried`, delivered after this
   * message already told the other screen it is done. `RECENTLY_PLACED_MS`
   * is generous on purpose: the race it guards is a presence tick straddling
   * one network hop, never seconds.
   */
  let recentlyPlaced: { at: Point; until: number } | null = null;

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
    setTimeout(() => ghost.remove(), HAND_MOVE_MS);
  }

  function draw(echo: PresenceEcho): void {
    const root = overlay();
    if (root === null) return;
    const box = root.getBoundingClientRect();
    drawArranging(root, box, echo.arranging);
    glideHandMove(root, box, echo.handMove);
    // Card-anchored when `over` resolves to something drawn here (the SAME card, on either
    // screen, or the i-th back of their hand) — the board-fraction mapping of `pointer` drifts off
    // a card the moment the two screens size a row differently. Falls back to the board fraction
    // when `over` is null, or names an element this board has not drawn (yet).
    const at = echo.pointer === null ? null : placeOver(canvas, echo.over) ?? placeSpot(canvas, echo.pointer);
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
      // AE18: this echo was true when it was SENT — the sender's own card was still `carried`,
      // because their board had not yet drawn the real one — but `forge:placement` already told
      // this screen the SAME point is done, and may have already flown it. Presence names no
      // card, so the point this episode's one `forge:placement` carried is the one thing both
      // messages share; a `placing` naming it, arriving after, is that message's stale tail, not
      // a new episode.
      const stale = recentlyPlaced !== null && Date.now() < recentlyPlaced.until && placingAt !== null && samePoint(placingAt, recentlyPlaced.at);
      if (waiting === null && placingAt !== null && !stale) {
        // AD4 rule 2: wait right here — a point, not a battlefield gap — until the spell's id
        // shows up on the stack (`handoff`, below), or a permanent's own placement supersedes this.
        standBack(root, box, placingAt);
        back!.setAttribute('data-waiting', '');
        waiting = { timer: setTimeout(stopWaiting, WAITING_MS), forBattlefield: false, card: null };
        // AE26: their spell beat this message here (Forge's frame won the race against presence):
        // it is already a placed card, drawn pending at nobody's point. Hand the point over NOW —
        // the one object, in place — never a back beside a face until a timer ends it.
        if (unhanded !== null && Date.now() - unhanded.at < UNHANDED_MS) {
          const { id } = unhanded;
          unhanded = null;
          if (!onTheirBattlefield(id)) handToSpell(id);
        }
      }
      // A wait already holds the back — the placement's gap, or this point: it stays put. A
      // stale echo with no wait to hold is simply not acted on — see `stale`, above.
    } else if (echo.held) {
      // Lifted: the back follows the pointer. A wait pending (a card of theirs still arriving)
      // keeps its stand-in; their new lift is drawn once that wait ends.
      if (waiting === null) standBack(root, box, at);
    } else if (waiting === null) {
      back?.remove();
      back = null;
    } else if (!waiting.forBattlefield) {
      // Their parked card is gone from their screen with no placement and no id yet: a cancel
      // (the card went home), or the id is a frame away. The point wait is given a short grace
      // instead of its full timeout — a cast that commits inside it still hands over as usual
      // (`handoff`); a cancel takes the back down in a moment, not in fifteen seconds.
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
   * A SPELL of theirs: its id is public now — the stand-in's point goes to the
   * placed-cards layer (`placeSpell` at `backAt`, the CENTRE `.presence__back` is
   * transformed onto) and the card is turned over there; the back is retired.
   */
  function handToSpell(id: number): void {
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
      const spell = fresh.find((id) => !onTheirBattlefield(id));
      if (spell !== undefined) unhanded = { id: spell, at: Date.now() };
    }
    if (waiting !== null && back !== null) {
      // A PERMANENT (`forBattlefield`): `Board` consumes the reservation when it draws the card in
      // the gap, and the stand-in simply goes. That happens in React's commit of this very change,
      // which may be AFTER this listener runs — so the reservation is read on the next frame, past
      // the commit. A SPELL's wait has no reservation to read; only the id check below clears it.
      if (waiting.forBattlefield) {
        // AE26 (the Mana Leak screenshot): a CREATURE dragged to the battlefield carries a placement
        // (a column is reserved, this wait expects it there) — but while the other seat holds
        // priority it sits on the STACK first. Its id shows up on the stack, never the battlefield,
        // and this wait would stand the back beside the face until its timer. A fresh id of theirs
        // that is on the stack is the spell case: the back hands over to the placed card at its own
        // point, turned over in place; the column's reservation stays for the day it resolves.
        const onStack = fresh.find((id) => !onTheirBattlefield(id));
        if (onStack !== undefined) {
          handToSpell(onStack);
          return;
        }
        const theirs = host.theirPlayerId?.() ?? null;
        const standIn = back;
        const card = waiting.card;
        requestAnimationFrame(() => {
          if (waiting === null || back !== standIn) return;
          if (theirs === null || pendingPlacementFor(theirs) !== null) return;
          // The card is in its column. The stand-in was still on its 300 ms glide there more often
          // than not (Forge answers a cast faster than that), and taking it down here cut the glide
          // short: the back vanished mid-flight and the card popped into the gap — the owner's own
          // screen glides the whole way (`landCastGhost`). So the back hands over to the card's own
          // tile copy from wherever it is right now, which finishes the trip; the card waits hidden
          // under it. From the gap itself (Forge was slow), the trip is a stand-still reveal.
          const now = standIn.getBoundingClientRect();
          const from = now.width > 0 ? { x: now.left + now.width / 2, y: now.top + now.height / 2 } : backAt;
          stopWaiting();
          if (card !== null && from !== null) flyTile(card, from);
        });
        return;
      }
      if (fresh.length === 0) return;
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
    recentlyPlaced = { at: from, until: Date.now() + RECENTLY_PLACED_MS };
    stopWaiting();
    const already = canvas.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${card}"]`);
    if (already !== null) {
      // The frame came first: the reservation moves the card on the next commit; its tile flies
      // from the release point to wherever it settles.
      requestAnimationFrame(() => flyTile(card, from));
      return;
    }
    const rootBox = root.getBoundingClientRect();
    if (back === null) back = backElement(root);
    const standIn = back;
    standIn.style.left = `${from.x - rootBox.left}px`;
    standIn.style.top = `${from.y - rootBox.top}px`;
    standIn.setAttribute('data-waiting', '');
    waiting = { timer: setTimeout(stopWaiting, WAITING_MS), forBattlefield: true, card };
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
      takeDown();
    },
  };
}
