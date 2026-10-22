/*
 * The placed-cards layer (wave 59 §S, AD4 rules 1-5/7, AD3, decision a, c's
 * fade): every item on Forge's stack, drawn as a card at a point — both
 * seats', both kinds (a cast spell, or an activated ability/trigger's
 * ephemeral tile) — in place of the old thumbnail row and lone band, which
 * this wave deletes outright.
 *
 * Framework-free, like `numbers.ts`/`inspect/index.ts`: `installPlaced` boots
 * on a board's root element and paints into lane A's own overlay root
 * (`[data-board-overlay]`), on every `notify(view)` and on every placement
 * change. The one place it is NOT framework-free is the card's own face: a
 * stack item's card is `CardTile`, same as every other card on the board
 * ("Cards are `CardTile`", `Board.tsx`'s own rule), so each placed element
 * mounts a tiny `react-dom/client` root — built with `createElement`, never
 * JSX, so this stays a `.ts` module — exactly the way `play/harness.tsx` boots
 * the whole app into a plain DOM node. Position, arrows and every DOM
 * attribute below are set directly, outside React, so the contract here is
 * testable the same way `numbers.ts`'s is: against the DOM `notify` produces,
 * never against a render tree.
 *
 * ## The seam with lane W (Settled)
 *
 * Five exports — W calls them and never
 * draws:
 *
 *   - `placeSpell(cardId, at, side)` — a release (the park, `gestures/install.ts`)
 *     or an opponent's spell becoming known registers a point, by the CARD's
 *     id (`StackEntry.sourceCardId`'s own namespace — the same id a card
 *     keeps from hand to stack to battlefield): the caster's own release
 *     happens before Forge has pushed a stack item at all. `notify` below
 *     promotes that registration onto the stack item's own `id` the moment
 *     a matching entry appears in `view.stack`, so every call after that — a
 *     drag's `moveSpell`, lane W's `commitSpell` — addresses the same record
 *     by the stack id. The two namespaces are kept apart: Forge numbers cards
 *     and stack items separately, so a land just played as card 37 and the
 *     opponent's spell that is stack item 37 are different things, and the
 *     land's release must never place that spell.
 *   - `placeStackItem(id, at, side)` — a point for a stack item by its own
 *     id: a drag of one with no release behind it (an own trigger), or the
 *     other seat's `forge:placed` echo.
 *   - `moveSpell(id, at)` — the point changes (a drag of the viewer's own, or
 *     lane W's `forge:placed` echo) and every `onSpellMoved` listener hears
 *     it, which is what redraws this id's arrows and what lane W relays over
 *     the wire.
 *   - `commitSpell(id)` — the back (`side: 'them'`) turns over to the real
 *     face. A no-op for `side: 'you'`, which is always its own face — the
 *     owner never needs telling what their own card is.
 *   - `onSpellMoved(listener)` — every `moveSpell` call, including this
 *     module's own drag handling in `gestures/install.ts`. Returns the
 *     unsubscribe.
 *
 * ## The DOM contract (pinned by `placed.test.ts`)
 *
 *   - `[data-placed-spell="<item.id>"]` — one per `view.stack` entry, in the
 *     overlay root. `data-stack-id="<item.id>"` too, on the SAME element:
 *     this is the one thing every existing reader of a stack item's box
 *     keys off (`gestures/stack.ts`'s `stackItemBox`, the fallback arrow
 *     origin in `gestures/install.ts`'s `clickOrigin`) and this wave does
 *     not touch either of those files to tell them the element moved.
 *   - `data-mine` — present when this screen's own viewer placed it
 *     (`side: 'you'`); absent for the opponent's. `gestures/install.ts`'s new
 *     drag gesture (item 5) keys off exactly this.
 *   - `data-placed-next` — the top of `view.stack` (Forge's own order, top
 *     first) alone, never more than one at a time (item 3, item 8's mutation
 *     point).
 *   - `data-placed-leaving` — an item that just left `view.stack` for
 *     anywhere but a battlefield (decision c): fades 250ms, then its element
 *     is gone. An item that left FOR a battlefield is removed at once — the
 *     AC8 reservation (`Board.tsx`'s `notePlayedTo`/`expectPlacement`) is
 *     already drawing its arrival there, and drawing it twice is the bug
 *     this wave exists to retire.
 *   - A counter (AE27): Forge removes the resolving item and the item it
 *     targets in ONE frame. Drawn as three steps instead of one fade: the
 *     resolver blinks (`data-placed-resolving`), the target is destroyed
 *     (`data-placed-countered`), then the resolver fades (`data-placed-leaving`).
 *   - An ability (triggered or activated) is drawn only once the chain HALTS
 *     over it — someone holds priority or must answer with it on the stack
 *     (`setChainHalted`, `LiveBoard`'s own facts). One nobody stopped is never
 *     drawn: when it leaves, its source card on the battlefield shimmers
 *     instead (`data-shimmer` on the board card, `card.css`).
 *   - `.placed__arrow[data-for="<item.id>"]` — one per target the item has
 *     (`aimAt`, `gestures/arrow.ts`, reused exactly as Settled requires — no
 *     second geometry), redrawn on every `notify` and on every `moveSpell`
 *     (item 8's other mutation point — see `registerRepaint`/`afterChange`
 *     below, the one place that call happens, so it is the one place a
 *     mutant can drop it).
 *   - `.placed__hover` — the element's one child, the part that hovers while it
 *     is on the stack (`placed.css`); its face, back or chip is drawn inside it.
 */
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CardTile } from '../../components/CardTile.tsx';
import { artCredit, useArtist } from '../../draft/artists.ts';
import { artReady, cardImageUrl } from '../../draft/cardImage.ts';
import { battlefieldCardWidth, handCardWidth, sizeAsCard } from '../card-size.ts';
import { GLIDE_MS, PLACEMENT_WAIT_MS, prefersReducedMotion, takeResolutionEffects } from '../motion.ts';
import { HiddenCard } from '../HiddenCard.tsx';
import { RulesText } from '../prompts/RulesText.tsx';
import { viewerOf, type BoardView, type StackEntry } from '../adapter.ts';
import { aimAt, newArrow, positionArrow } from './gestures/arrow.ts';
import { centreOf } from '../lift.ts';
import { cardBox, faceBox, overlayOf } from './board-dom.ts';
import type { Point } from './gestures/types.ts';
import './placed.css';

export type { Point };

/** How long a resolved spell takes to travel into where it went, fading as it arrives — the house glide. Reduced motion skips straight to it. */
export const LEAVE_FADE_MS = GLIDE_MS;
/** AE27: the resolving counter's blink, before its target is destroyed. */
export const RESOLVE_BLINK_MS = 400;
/** AE27: the countered target's destroy motion, before the counter itself fades. */
export const COUNTERED_MS = 400;
/** On a permanent's own board card once it resolves off the stack, until its settle has run (`placed.css`'s `stack-settle`). */
export const STACK_SETTLE_ATTR = 'data-stack-settle';
/** One turn of the sheen round a card whose ability resolved with nobody stopping it (`card.css`). */
export const SHIMMER_MS = 1100;

/**
 * AE26 (2026-10-09, the Mana Leak screenshot): a spell of THEIRS that reaches the
 * stack before this screen hears where they let it go (`forge:placement` names
 * no spell; the release point rides on presence, which can lose the race to
 * Forge's frame) used to be drawn face-up at the default spot at once — beside
 * the back still standing at the release point, two objects for one card. For
 * this long a freshly arrived, unregistered spell is drawn but hidden: a
 * registration inside the window (presence handing the point over) draws it as
 * the back AT that point and the flip turns it over there; past the window it
 * shows at the default spot, which is a click-cast's own place (AD4 decision a).
 */
export const PLACED_PENDING_MS = 300;

/** How far a card sits to the right of its source's own box (the ephemeral tile, Settled). */
const BESIDE_GAP = 6;

interface Placement {
  at: Point;
  readonly side: 'you' | 'them';
  committed: boolean;
  /**
   * `Date.now()` when this was last registered, so an unmatched one expires `PLACEMENT_WAIT_MS` after
   * the last word, never after a first one: a card played again inherits nothing of an earlier release
   * that never reached the stack.
   */
  readonly registeredAt: number;
  /** The other seat is dragging it: their moves arrive a message at a time, and it glides between them. */
  gliding: boolean;
}

/** One record per stack item, by its stack id — module-level so `gestures/install.ts` and lane W's `presence.ts` can reach it without a React tree. */
const placements = new Map<number, Placement>();
/**
 * Spells (by CARD id) whose stand-in is still gliding into its gap: the stack card stays hidden until
 * the stand-in comes to rest and hands over there — on their screen `presence.ts`'s back (drawn at the
 * default spot meanwhile, it stood beside the back, w67-shaman), on the caster's own
 * `gestures/install.ts`'s parked ghost (drawn at once, it took over 2–4 px short of the gap). Ended
 * by `placeSpell` or `releaseSpell`; never past `PLACEMENT_WAIT_MS`.
 */
const holds = new Map<number, number>();
/** Releases not yet on the stack, by CARD id — promoted into `placements` once their stack item appears. */
const releases = new Map<number, Placement>();
const moveListeners = new Set<(id: number, at: Point) => void>();
/**
 * Fired SYNCHRONOUSLY, inside `render()`, the instant a NEW element is
 * created for a stack item — never on a later paint. `gestures/install.ts`'s
 * own ghost-to-placed-card handoff (§S) is the one reader: `render()` runs
 * from `Board`'s own `useEffect`, a DIFFERENT subscriber of the same match
 * than `install.ts`'s, with no ordering guarantee between the two — removing
 * the ghost on the match's own say (before this module has drawn anything)
 * left a GAP frame; removing it on a timer guessed at how long React takes
 * and sometimes guessed short, leaving BOTH drawn for a frame. This listener
 * is the one point where "the replacement now exists" is a plain fact, not
 * a guess — the ghost comes off in the SAME synchronous call, atomically.
 */
const drawnListeners = new Set<(id: number) => void>();
/** `installPlaced`'s own repaint hooks — every placement change asks every live instance to redraw. */
const repaintHooks = new Set<() => void>();

function requestRepaint(): void {
  for (const hook of repaintHooks) hook();
}

/** See `setChainHalted`. Null: no live match drives it (a board drawn alone), so every stack item is drawn. */
let chainHalted: boolean | null = null;

/**
 * Whether the chain is halted right now: this seat has a decision open (a live bar, an ask, a
 * payment) or the server says the other seat holds a window (`LiveBoard`'s `viewerOpen`/
 * `opponentOpen`). An ability on the stack is drawn only while this is true — one that resolves with
 * nobody stopping never reaches a screen as a chip, and its source shimmers instead. A withheld
 * window never reaches the wire, so it never halts anything here.
 */
export function setChainHalted(halted: boolean | null): void {
  if (chainHalted === halted) return;
  chainHalted = halted;
  requestRepaint();
}

function register(records: Map<number, Placement>, id: number, at: Point, side: 'you' | 'them', glide = false): void {
  const existing = records.get(id);
  records.set(id, {
    at,
    side,
    committed: existing?.committed ?? side === 'you',
    registeredAt: Date.now(),
    gliding: glide,
  });
  requestRepaint();
}

/**
 * Register (or move) a released card's point, by its CARD id — see the module
 * header. A fresh one starts `committed` on `side === 'you'` (the owner
 * always knows their own card) and face-down otherwise — lane W's
 * `commitSpell` turns it over once the opponent's spell is public.
 */
export function placeSpell(cardId: number, at: Point, side: 'you' | 'them'): void {
  holds.delete(cardId);
  register(releases, cardId, at, side);
}

/**
 * Register (or move) a stack item's point by its own stack id — see the module header.
 * `glide`: the point is a move of the other seat's drag (`presence.ts`'s `onPlaced`), so the
 * element glides to it from wherever it is drawn (`[data-placed-gliding]`, `placed.css`) instead of
 * stepping a message at a time — from their FIRST move on, an ability's first move included. A
 * release point or a hand-over is drawn in place.
 */
export function placeStackItem(id: number, at: Point, side: 'you' | 'them', glide = false): void {
  register(placements, id, at, side, glide);
}

/** Keep the spell `cardId` hidden until its stand-in hands it over — see `holds`. */
export function holdSpell(cardId: number): void {
  holds.set(cardId, Date.now() + PLACEMENT_WAIT_MS);
}

/** The hand-over is now, or not coming after all: draw it as any other. */
export function releaseSpell(cardId: number): void {
  if (holds.delete(cardId)) requestRepaint();
}

function heldUntil(cardId: number | null): number | null {
  if (cardId === null) return null;
  const until = holds.get(cardId);
  if (until === undefined) return null;
  if (Date.now() < until) return until;
  holds.delete(cardId);
  return null;
}

/** Whether a released card's point is still waiting for its stack item (not yet promoted). */
export function isPlaced(cardId: number): boolean {
  return releases.has(cardId);
}

/** Move an already-placed spell. No-op for an id nothing ever placed. */
export function moveSpell(id: number, at: Point): void {
  const p = placements.get(id);
  if (p === undefined) return;
  p.at = at;
  for (const listener of moveListeners) listener(id, at);
  requestRepaint();
}

/** Turn a back over to its face. No-op once committed, or for an id nothing ever placed. */
export function commitSpell(id: number): void {
  const p = placements.get(id) ?? releases.get(id);
  if (p === undefined || p.committed) return;
  p.committed = true;
  requestRepaint();
}

/** Every `moveSpell` call, this module's own drag included. Returns the unsubscribe. */
export function onSpellMoved(listener: (id: number, at: Point) => void): () => void {
  moveListeners.add(listener);
  return () => moveListeners.delete(listener);
}

/** Every time THIS module draws a stack item's element for the first time — see `drawnListeners`'s own note. Returns the unsubscribe. */
export function onSpellDrawn(listener: (id: number) => void): () => void {
  drawnListeners.add(listener);
  return () => drawnListeners.delete(listener);
}

/** Test-only: drop every placement and the halt fact, so one test's state never leaks into the next. */
export function forgetPlacements(): void {
  placements.clear();
  holds.clear();
  releases.clear();
  chainHalted = null;
}

/* ── pure geometry, unit-tested directly ──────────────────────────────── */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** The default spot (decision a): the middle of the column the old stack band stood in. */
export function defaultSpot(canvas: ParentNode): Point | null {
  const mid = canvas.querySelector('[data-testid="board-mid"]');
  if (mid === null) return null;
  return centreOf(mid);
}

/**
 * Where an ephemeral ability card sits beside its source (Settled): to the
 * source's right, clear of it, and clear of any ephemeral tile already
 * placed there this pass (`taken`) — the next free spot along the row's
 * edge. `tile` is the ephemeral tile's own drawn size — a chip is as wide
 * as its text needs to be near square (`squareChip`) — and the source's own box
 * before it has one. Within `bounds` (the overlay) when given: on the
 * source's LEFT when its right has no room, else as far in as it must be.
 */
export function besideSource(
  sourceBox: Rect,
  taken: readonly Rect[],
  tile: { width: number; height: number } = { width: sourceBox.right - sourceBox.left, height: sourceBox.bottom - sourceBox.top },
  bounds: Rect | null = null,
): Point {
  const sourceHeight = sourceBox.bottom - sourceBox.top;
  const centreY = sourceBox.top + sourceHeight / 2;
  // A row that is full on both sides wraps to the rows above and below it, never piles up at the edge.
  for (const row of bounds === null ? [0] : [0, -1, 1, -2, 2]) {
    const spot = alongRow(sourceBox, taken, tile, bounds, centreY + row * (tile.height + BESIDE_GAP));
    if (spot !== null) return spot;
  }
  let left = sourceBox.right + BESIDE_GAP;
  for (const box of taken) {
    const sameRow = Math.abs(box.top - sourceBox.top) < sourceHeight;
    if (sameRow && left < box.right + BESIDE_GAP) left = box.right + BESIDE_GAP;
  }
  let x = left + tile.width / 2;
  let y = centreY;
  if (bounds !== null) {
    const minX = bounds.left + BESIDE_GAP + tile.width / 2;
    const maxX = bounds.right - BESIDE_GAP - tile.width / 2;
    const onLeft = sourceBox.left - BESIDE_GAP - tile.width / 2;
    if (x > maxX) x = onLeft >= minX ? onLeft : Math.max(minX, maxX);
    y = Math.min(Math.max(y, bounds.top + BESIDE_GAP + tile.height / 2), Math.max(bounds.top + BESIDE_GAP + tile.height / 2, bounds.bottom - BESIDE_GAP - tile.height / 2));
  }
  return { x, y };
}

/**
 * The first free spot on the row centred at `y`: right of the source, clear of every tile already
 * there, else left of it — or null when neither side has room inside `bounds`.
 */
function alongRow(sourceBox: Rect, taken: readonly Rect[], tile: { width: number; height: number }, bounds: Rect | null, y: number): Point | null {
  const top = y - tile.height / 2;
  const bottom = y + tile.height / 2;
  if (bounds !== null && (top < bounds.top + BESIDE_GAP || bottom > bounds.bottom - BESIDE_GAP)) return null;
  const inRow = taken.filter((box) => box.bottom > top && box.top < bottom);
  let left = sourceBox.right + BESIDE_GAP;
  for (const box of [...inRow].sort((a, b) => a.left - b.left)) {
    if (box.right + BESIDE_GAP > left && box.left < left + tile.width + BESIDE_GAP) left = box.right + BESIDE_GAP;
  }
  if (bounds === null || left + tile.width <= bounds.right - BESIDE_GAP) return { x: left + tile.width / 2, y };
  let right = sourceBox.left - BESIDE_GAP;
  for (const box of [...inRow].sort((a, b) => b.right - a.right)) {
    if (box.left - BESIDE_GAP < right && box.right > right - tile.width - BESIDE_GAP) right = box.left - BESIDE_GAP;
  }
  return right - tile.width >= bounds.left + BESIDE_GAP ? { x: right - tile.width / 2, y } : null;
}

/**
 * A chip's own small, stable nudge off its spot (the operator, 2026-10-11: "i prefer a bit of
 * random placement rather than stacking all the valakut triggers in the same spot"): seeded by its
 * id, so both screens and every repaint agree, at most a fifth of the chip's width and a quarter of
 * its height either way.
 */
export function scatter(id: number, tile: { width: number; height: number }): { dx: number; dy: number } {
  let h = (Math.abs(id) * 2654435761) >>> 0;
  const next = (): number => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 0x1_0000_0000;
  };
  return { dx: (next() - 0.5) * 0.4 * tile.width, dy: (next() - 0.5) * 0.5 * tile.height };
}

/** `at`, moved just enough to keep a `tile` centred on it inside `bounds`. */
function within(at: Point, tile: { width: number; height: number }, bounds: Rect): Point {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(at.x, bounds.left + BESIDE_GAP + tile.width / 2, bounds.right - BESIDE_GAP - tile.width / 2),
    y: clamp(at.y, bounds.top + BESIDE_GAP + tile.height / 2, bounds.bottom - BESIDE_GAP - tile.height / 2),
  };
}

/**
 * The width at which an ability chip is as near square as its text allows (the operator,
 * 2026-10-11: "the goal should be to get as close to square as possible"). The chip is `fixed`
 * high before its text (the art band and the text's own padding) plus the text's lines, whose area
 * stays about the same at any width: `h(w) = fixed + area / (w - padX)`. `w = h(w)` is a quadratic;
 * its larger root, held within `[min, max]` — never narrower than a card, never wider than the cap.
 */
export function squareWidth(area: number, fixed: number, padX: number, min: number, max: number): number {
  const s = fixed + padX;
  const w = (s + Math.sqrt(s * s - 4 * (padX * fixed - area))) / 2;
  return Math.min(Math.max(w, min), Math.max(min, max));
}

/* ── installPlaced: the DOM ───────────────────────────────────────────── */

export interface PlacedHost {
  /** Defaults to the real `prefers-reduced-motion` media query. */
  readonly reducedMotion?: () => boolean;
  /**
   * Told the card ids of the spells drawn here, whenever that set changes — arriving, on the stack or
   * on their way out: `Board.tsx` keeps each out of the pile it went to until it is gone from here (the
   * operator, 2026-10-16: "make sure all these animations can finish before the card show up in the
   * gy/exile zones"). A spell still flying in when Forge has already resolved it was drawn twice, once
   * on the stack and once in its graveyard (w33's hand-over check, 2026-10-17). An ability is never
   * held: its card may be in a pile using its own ability (flashback, unearth).
   */
  readonly onHolding?: (cardIds: ReadonlySet<number>) => void;
}

/**
 * Q18 (wave 33 §B.1), carried over from the old `StackThumb`: a SPELL entry's
 * own card id may itself be one of Forge's `setSelectables` (re-offered while
 * it already sits on the stack) — never an ability's, whose `sourceCardId` is
 * the permanent, offered for its own separate (re-)activation. `Board.tsx`
 * passes this through `notify` so a placed card stays clickable for exactly
 * that case, without this module importing `BoardInteraction` itself.
 */
export interface PlacedInteraction {
  isSelectable(cardId: number): boolean;
  onSelect(cardId: number): void;
}

export interface PlacedHandle {
  /** Call with every new `BoardView` the board renders. `interaction` is optional — absent, nothing is selectable. */
  notify(view: BoardView, interaction?: PlacedInteraction): void;
  dispose(): void;
}

interface Drawn {
  readonly el: HTMLElement;
  /**
   * The card's one child, `.placed__hover`, made with `el` and kept for its whole life: the face, a
   * back or a chip is mounted INSIDE it, so turning a back over never restarts its hover
   * (`placed.css`). It is what moves; `el` — the arrows' origin, the drag's pickup — stays put.
   */
  readonly hover: HTMLElement;
  /** Null for a back (no `CardTile` to mount) and for the no-card-data text fallback. */
  root: Root | null;
  committed: boolean;
  isAbility: boolean;
  /** The underlying card's id, remembered from when this was drawn — `view.stack` no longer has it once the item is gone. */
  readonly sourceCardId: number | null;
  /** The stack item this one targets, as last drawn — a counter's departure reads it (AE27). */
  targetStackItemId: number | null;
  leaving: boolean;
  /** AE26: hidden until a registration arrives or the window closes — see `PLACED_PENDING_MS`. */
  pendingUntil: number | null;
  /** When a held spell (`holdSpell`) is next looked at, so one hold schedules one look. */
  holdCheckAt: number | null;
  /** An ability's chip: the card width and text it was last squared for (`squareChip`), so it is measured once per change. */
  squaredFor: string | null;
  /** A chip's place off its source's centre, kept once it has its own size, so a repaint never moves it. */
  offset: { dx: number; dy: number } | null;
  /** The id this was first drawn for, which seeds its `scatter`: a waiting trigger's chip keeps it on the stack. */
  readonly seed: number;
  /** A waiting trigger's chip whose target question was open when last drawn — the one that goes on the stack next. */
  current: boolean;
}

/**
 * Where in its hover a stack card starts (`placed.css`'s `--stack-phase`, 0–1): from its stack id,
 * so two cards never bob in step and the same item is in the same phase on both screens.
 */
function setHoverPhase(el: HTMLElement, id: number): void {
  const phase = (((id * 0.618034) % 1) + 1) % 1;
  el.style.setProperty('--stack-phase', phase.toFixed(4));
}

/** Overlay-relative centre of a box. */
function overlayPoint(at: Point, overlayBox: DOMRect): { x: number; y: number } {
  return { x: at.x - overlayBox.left, y: at.y - overlayBox.top };
}

/**
 * Unmount a card's React root off this call's own stack. `render` (and so
 * `mount`/`removeNow`) can run from INSIDE `Board`'s own effect — the one
 * `notify` call a view change makes, and its cleanup's `dispose` — and
 * `root.unmount()` called synchronously from there fights React's own
 * commit for the OUTER tree: measured directly, "Attempted to synchronously
 * unmount a root while React was already rendering." A microtask is always
 * clear of that commit, whichever call reached here.
 */
function deferUnmount(root: Root | null): void {
  if (root !== null) queueMicrotask(() => root.unmount());
}

function faceNode(item: StackEntry): ReactElement | null {
  if (item.isAbility) return createElement(AbilityChip, { item });
  if (item.sourceCard === null) return null;
  // A face-down spell of theirs: the same back a hidden card is in every zone (and the inspector's).
  return item.sourceHidden === true ? createElement(HiddenCard, { card: item.sourceCard }) : createElement(CardTile, { card: item.sourceCard });
}

/**
 * AE29 (the operator, 2026-10-09: "ability chip is the correct thing to do"): a triggered or
 * activated ability on the stack is an EFFECT of its card, never a second copy of it — half a card
 * tall, the source's art as a band with its name, the ability's own text beneath, rounded, no frame,
 * an accent glow. Mock-up: the operator's `ae29-options.html`, option 1.
 *
 * The band is the art without the card's frame, so it carries the illustrator and copyright itself
 * (Scryfall's image guidelines for art shown cropped), and shows no art it cannot credit.
 */
function AbilityChip({ item }: { readonly item: StackEntry }): ReactElement {
  const artId = item.sourceCard?.scryfallId ?? null;
  const artist = useArtist(artId);
  const art = artId === null || typeof artist !== 'string' ? null : cardImageUrl(artId);
  const name = item.sourceName ?? item.sourceCard?.name ?? '';
  // The ability's own words (`abilityTextOf`): its targets are its arrows and its accessible name.
  const text = item.abilityText ?? item.description;
  return createElement(
    'div',
    { className: 'placed__chip', 'data-ability-chip': '' },
    createElement(
      'div',
      { className: 'placed__chip-band' },
      art === null ? null : createElement('img', { className: 'placed__chip-art', src: art, alt: '', 'aria-hidden': 'true', draggable: false }),
      art === null || typeof artist !== 'string' ? null : createElement('span', { className: 'placed__chip-credit' }, artCredit(artist)),
      createElement('span', { className: 'placed__chip-name' }, name),
    ),
    createElement('div', { className: 'placed__chip-text' }, createElement(RulesText, { text })),
  );
}

/**
 * One item's accessible name: who · what[ · ability][ → target] — the same
 * structured join the deleted `StackThumb`'s own `stackItemLabel` built
 * (`Board.tsx`, wave 36 T8), carried over so a keyboard or screen-reader
 * player still gets who/what/target off the card itself, not only its face.
 */
function itemLabel(item: StackEntry): string {
  const source = item.sourceName ?? 'unknown source';
  const what = item.isAbility ? `${source} · ability` : source;
  const who = item.controllerName !== null ? `${item.controllerName} · ${what}` : what;
  const targetLabel = item.targetLabel ?? null;
  return targetLabel === null ? who : `${who} → ${targetLabel}`;
}

export function installPlaced(canvas: HTMLElement, host: PlacedHost = {}): PlacedHandle {
  let live = true;
  let lastView: BoardView | null = null;
  let interaction: PlacedInteraction | undefined;
  const drawn = new Map<number, Drawn>();
  /** Abilities on the stack never drawn (nobody stopped), by stack id → their source card's id. */
  const undrawn = new Map<number, number | null>();
  /** The latest shimmer on each board card, so an earlier one's timer never cuts a fresh one short. */
  const shimmers = new WeakMap<Element, number>();
  const settles = new WeakMap<Element, number>();
  /** Spells that left the stack, by card id → when: each settles once Forge draws it on a battlefield. */
  const resolvedOff = new Map<number, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Everything here is sized off the table's cards (`card-size.ts`) and a chip off its own text:
   * a board that changes size (the window) or a chip whose text has just rendered is drawn again.
   */
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => render()) : null;

  const reduced = (): boolean => host.reducedMotion?.() ?? prefersReducedMotion();
  const overlay = (): HTMLElement | null => overlayOf(canvas);

  function schedule(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (live) fn();
    }, ms);
    timers.add(timer);
  }

  /** Promote a placement keyed by the caster's own card id onto the stack item's real id, the moment both are known. */
  function promote(items: readonly StackEntry[]): void {
    for (const item of items) {
      if (placements.has(item.id)) continue;
      if (item.sourceCardId === null) continue;
      const pending = releases.get(item.sourceCardId);
      if (pending === undefined) continue;
      releases.delete(item.sourceCardId);
      placements.set(item.id, pending);
    }
  }

  /**
   * A waiting trigger's chip becomes its stack item's when Forge puts it on the stack: the item
   * that is new and not yet drawn takes over the chip a waiting trigger of the same card just left
   * (the one asked about first), so it stays exactly where it was.
   */
  function handOver(stack: readonly StackEntry[], currentIds: ReadonlySet<number>): void {
    for (const item of stack) {
      if (!item.isAbility || drawn.has(item.id) || item.sourceCardId === null) continue;
      const left = [...drawn].filter(([id, d]) => id < 0 && !currentIds.has(id) && !d.leaving && d.sourceCardId === item.sourceCardId);
      const taken = left.find(([, d]) => d.current) ?? left[0];
      if (taken === undefined) continue;
      const [id, d] = taken;
      drawn.delete(id);
      drawn.set(item.id, d);
      d.el.setAttribute('data-placed-spell', String(item.id));
      d.el.setAttribute('data-stack-id', String(item.id));
      setHoverPhase(d.el, item.id);
    }
  }

  /** Prune a record that has sat unmatched past its TTL — a land, a cancelled cast, an echo for an item that never came. */
  function pruneStale(items: readonly StackEntry[]): void {
    const now = Date.now();
    const prune = (records: Map<number, Placement>, live: ReadonlySet<number | null>): void => {
      for (const [id, p] of records) if (!live.has(id) && now - p.registeredAt > PLACEMENT_WAIT_MS) records.delete(id);
    };
    prune(releases, new Set(items.map((i) => i.sourceCardId)));
    prune(placements, new Set(items.map((i) => i.id)));
  }

  function viewerName(): string | null {
    return viewerOf(lastView)?.name ?? null;
  }

  function onBattlefieldNow(cardId: number): boolean {
    return (lastView?.players ?? []).some((p) => p.battlefield.some((c) => c.id === cardId));
  }

  function mount(el: HTMLElement, item: StackEntry, wantBack: boolean): Root | null {
    el.innerHTML = '';
    if (wantBack) {
      const back = document.createElement('div');
      back.className = 'card-back placed__back';
      back.setAttribute('data-card-back', '');
      el.append(back);
      return null;
    }
    const face = faceNode(item);
    if (face === null) {
      const text = document.createElement('div');
      text.className = 'placed__text';
      text.textContent = item.sourceName ?? item.description;
      el.append(text);
      return null;
    }
    const host = document.createElement('div');
    host.className = 'placed__tile';
    el.append(host);
    // No `flushSync`: calling it from inside `Board`'s own effect (where
    // `notify` runs) fights React's own commit — measured directly, the exact
    // "flushSync was called from inside a lifecycle method" warning. A caller
    // that needs the card's markup the instant this returns (this module's
    // own tests, a mutation run) finds the FIRST draw of a freshly-created
    // element already there — React commits a fresh root's first render
    // without a scheduling hop in that case — but a later FLIP
    // (`commitSpell`, which tears the old root down and makes a new one
    // rather than re-rendering — see below) is an ordinary React DOM update
    // and needs the same wait any such update does from outside `act()`.
    // of re-rendering it; see `ensureElement`, which only ever calls this once
    // per element's lifetime for that reason.
    const root = createRoot(host);
    root.render(face);
    return root;
  }

  /** `d.committed` tracks what is CURRENTLY mounted — a face, true; a back, false — so this only remounts on an actual flip. */
  function ensureElement(item: StackEntry, record: Placement | undefined): Drawn {
    let d = drawn.get(item.id);
    // Their spell stays a back until it is public AND its art is decoded — a click-cast of theirs too,
    // which has no placement record: the operator, 2026-10-09, "i really dont want a no-art card to show ever".
    // An ability is never a back: it hides no card, so their first drag of it (which registers it here
    // face-down, `presence.ts`'s `onPlaced`) must not turn it over and rebuild it mid-move.
    const theirs = !item.isAbility && (record !== undefined ? record.side === 'them' : item.controllerName !== viewerName());
    const wantBack = theirs && ((record !== undefined && !record.committed) || !artReady(cardImageUrl(item.sourceCard?.scryfallId), requestRepaint));
    if (d === undefined) {
      const el = document.createElement('div');
      el.className = 'placed';
      el.setAttribute('data-placed-spell', String(item.id));
      el.setAttribute('data-stack-id', String(item.id));
      setHoverPhase(el, item.id);
      const hover = document.createElement('div');
      hover.className = 'placed__hover';
      el.append(hover);
      // The card it is, for a reader counting the card's copies on screen (`handover-report.ts`).
      if (!item.isAbility && item.sourceCardId !== null) el.setAttribute('data-placed-card', String(item.sourceCardId));
      // Q18: a SPELL (never an ability) may itself be one of Forge's `setSelectables` while it sits
      // on the stack — `sourceCardId` captured once, at creation, same as every other id here.
      const sourceCardId = item.sourceCardId;
      if (!item.isAbility && sourceCardId !== null) {
        el.addEventListener('click', () => {
          if (interaction?.isSelectable(sourceCardId) === true) interaction.onSelect(sourceCardId);
        });
      }
      overlay()?.append(el);
      const pending = record === undefined && !item.isAbility;
      if (pending) el.setAttribute('data-placed-pending', '');
      d = {
        el,
        hover,
        root: null,
        committed: !wantBack,
        isAbility: item.isAbility,
        sourceCardId: item.sourceCardId,
        targetStackItemId: null,
        leaving: false,
        pendingUntil: pending ? Date.now() + PLACED_PENDING_MS : null,
        holdCheckAt: null,
        squaredFor: null,
        offset: null,
        seed: item.id,
        current: false,
      };
      // A chip is placed beside its source by its own drawn width, which it only has once its text has rendered.
      if (item.isAbility) resized?.observe(el);
      if (pending) schedule(render, PLACED_PENDING_MS + 1);
      d.root = mount(hover, item, wantBack);
      drawn.set(item.id, d);
      // A spell drawn here is in no pile, even when Forge has already put it in one: on the other
      // screen its flight in can still be under way when its resolution's frame arrives.
      if (!item.isAbility) hold(item.id, item.sourceCardId);
      // Synchronous, now that the element (and, for a face, its CardTile — a
      // fresh root's first render commits without a scheduling hop) is
      // actually in the DOM. See `drawnListeners`'s own note.
      for (const listener of drawnListeners) listener(item.id);
    } else if (d.committed === wantBack) {
      // `d.committed` says "showing a face" and `wantBack` says "should show a back" — equal only on
      // a flip (lane W's `commitSpell` turned it over, or — defensively — the other direction).
      deferUnmount(d.root);
      d.root = mount(d.hover, item, wantBack);
      d.committed = !wantBack;
    }
    return d;
  }

  /**
   * An ability's chip, as near square as it can be (`squareWidth`): one measure of its text's area at
   * the width it has, the width solved from it, then one correction for where the lines actually
   * wrapped. Once per chip per card width and text — the redraw the resize itself causes finds it
   * already squared. Not before its text has rendered (the chip's own resize redraws it then).
   */
  function squareChip(d: Drawn, cardWidth: number | null, overlayBox: DOMRect): void {
    const text = d.el.querySelector<HTMLElement>('.placed__chip-text');
    const length = text?.textContent?.length ?? 0;
    if (text === null || length === 0 || cardWidth === null) return;
    const key = `${cardWidth}:${length}`;
    if (d.squaredFor === key) return;
    const style = getComputedStyle(text);
    const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const max = Math.min(cardWidth * 3, overlayBox.width / 3);
    for (let pass = 0; pass < 2; pass += 1) {
      const lines = text.getBoundingClientRect();
      const chip = d.el.getBoundingClientRect();
      if (!(lines.width > padX) || !(lines.height > padY)) return; // no layout yet
      const area = (lines.width - padX) * (lines.height - padY);
      const w = Math.round(squareWidth(area, chip.height - lines.height + padY, padX, cardWidth, max));
      if (Math.abs(w - chip.width) < 1) break;
      d.el.style.width = `${w}px`;
    }
    d.squaredFor = key;
  }

  /**
   * The point for an item with no registered placement, plus the box it occupies — for the NEXT ability's own collision check, when it is one.
   * A chip goes beside its source, nudged by its own `scatter`, and stays at that offset from the source once it has its size.
   */
  function positionOf(item: StackEntry, d: Drawn, taken: readonly Rect[], bounds: Rect): { at: Point; reserved: Rect | null } | null {
    const promoted = placements.get(item.id);
    if (promoted !== undefined) return { at: promoted.at, reserved: null };
    if (item.isAbility && item.sourceCardId !== null) {
      const source = cardBox(canvas, item.sourceCardId);
      if (source !== null) {
        const sourceBox = rectOf(source);
        const drawnBox = d.el.getBoundingClientRect();
        const tile =
          drawnBox.width > 0
            ? { width: drawnBox.width, height: drawnBox.height }
            : { width: sourceBox.right - sourceBox.left, height: sourceBox.bottom - sourceBox.top };
        const centre = { x: (sourceBox.left + sourceBox.right) / 2, y: (sourceBox.top + sourceBox.bottom) / 2 };
        let at: Point;
        if (d.offset !== null) {
          at = within({ x: centre.x + d.offset.dx, y: centre.y + d.offset.dy }, tile, bounds);
        } else {
          const spot = besideSource(sourceBox, taken, tile, bounds);
          const { dx, dy } = scatter(d.seed, tile);
          at = within({ x: spot.x + dx, y: spot.y + dy }, tile, bounds);
          if (d.squaredFor !== null) d.offset = { dx: at.x - centre.x, dy: at.y - centre.y };
        }
        return { at, reserved: { left: at.x - tile.width / 2, right: at.x + tile.width / 2, top: at.y - tile.height / 2, bottom: at.y + tile.height / 2 } };
      }
    }
    const at = defaultSpot(canvas);
    return at === null ? null : { at, reserved: null };
  }

  /** The spells drawn here — arriving, waiting or on their way out — by item id: their card ids, for `PlacedHost.onHolding`. */
  const holding = new Map<number, number>();
  function hold(id: number, cardId: number | null): void {
    if (cardId === null) return;
    holding.set(id, cardId);
    host.onHolding?.(new Set(holding.values()));
  }

  function removeNow(id: number): void {
    if (holding.delete(id)) host.onHolding?.(new Set(holding.values()));
    const d = drawn.get(id);
    if (d === undefined) return;
    deferUnmount(d.root);
    resized?.unobserve(d.el);
    d.el.remove();
    drawn.delete(id);
    placements.delete(id);
  }

  function leave(id: number, cardId: number | null): void {
    const d = drawn.get(id);
    if (d === undefined) return;
    if (cardId !== null) resolvedOff.set(cardId, Date.now());
    if (cardId !== null && onBattlefieldNow(cardId)) {
      // AC8's own reservation draws the arrival (`gestures/cast.ts`'s `landCastGhost`, on either
      // screen): one object at a time, so this card goes at once. The permanent settles instead
      // (`settleArrivals`).
      removeNow(id);
      return;
    }
    if (d.leaving) return;
    d.leaving = true;
    hold(id, cardId);
    if (reduced()) {
      removeNow(id);
      return;
    }
    // What it did is drawn first (`numbers.ts`'s beats: hits, a creature destroyed): it stays where it
    // is while that plays, and then goes the ordinary way — no blink (the operator, 2026-10-15: the
    // "double blink" was "a bit slow and weird").
    const effectsUntil = takeResolutionEffects(id);
    if (effectsUntil !== null && effectsUntil > Date.now()) {
      schedule(() => fadeInto(id, d, cardId), effectsUntil - Date.now());
      return;
    }
    fadeInto(id, d, cardId);
  }

  /** A resolved item travels into wherever its card went, fading as it arrives, and is gone there. */
  function fadeInto(id: number, d: Drawn, cardId: number | null): void {
    // Into wherever it went — a graveyard, an exile, a hand — and gone there; in place when that is not drawn.
    const to = cardId === null ? sourceBox(d) : destinationOf(cardId);
    if (to !== null) {
      const root = overlay();
      const p = root === null ? null : overlayPoint(centreOf(to), root.getBoundingClientRect());
      if (p !== null) {
        d.el.style.left = `${p.x}px`;
        d.el.style.top = `${p.y}px`;
      }
    }
    d.el.setAttribute('data-placed-leaving', '');
    // Gone once it has arrived — its fade's own end, not a clock that a busy frame outruns — and
    // at the latest twice the glide, should the browser never report that end.
    d.el.addEventListener('transitionend', (e) => {
      if (e.target === d.el && e.propertyName === 'opacity') removeNow(id);
    });
    schedule(() => removeNow(id), 2 * LEAVE_FADE_MS);
  }

  /**
   * A spell that left the stack and is on a battlefield now settles there — the stack's shadow under
   * it collapses onto the table (`placed.css`'s `stack-settle`) — whichever frame Forge draws it in,
   * the one that empties the stack or a later one. At once, so it is never shown flat first, and
   * again on the next animation frame should `Board` have drawn it as a new element by then (it
   * moves a placed card into its column after this commit — `gestures/install.ts`'s own landing
   * waits the same frame).
   */
  function settleArrivals(): void {
    for (const [cardId, at] of resolvedOff) {
      if (onBattlefieldNow(cardId)) {
        resolvedOff.delete(cardId);
        const drawnNow = permanentOf(cardId);
        settle(drawnNow);
        requestAnimationFrame(() => {
          const kept = permanentOf(cardId);
          if (live && kept !== drawnNow) settle(kept);
        });
      } else if (Date.now() - at > PLACEMENT_WAIT_MS) resolvedOff.delete(cardId);
    }
  }

  function permanentOf(cardId: number): Element | null {
    return canvas.querySelector(`[data-zone="battlefield"] [data-card-id="${cardId}"]`);
  }

  /** A permanent just resolved off the stack: its shadow settles onto the table, once. */
  function settle(el: Element | null): void {
    if (el === null || reduced()) return;
    const turn = (settles.get(el) ?? 0) + 1;
    settles.set(el, turn);
    el.removeAttribute(STACK_SETTLE_ATTR);
    void (el as HTMLElement).offsetWidth;
    el.setAttribute(STACK_SETTLE_ATTR, '');
    // The settle runs once the card is shown (`placed.css` holds it while a landing still hides the
    // card), so it ends on its own `animationend`; the clock is only the backstop for one never shown.
    el.addEventListener(
      'animationend',
      (e) => {
        if ((e as AnimationEvent).animationName === 'stack-settle' && settles.get(el) === turn) el.removeAttribute(STACK_SETTLE_ATTR);
      },
      { once: true },
    );
    schedule(() => {
      if (settles.get(el) === turn) el.removeAttribute(STACK_SETTLE_ATTR);
    }, PLACEMENT_WAIT_MS);
  }

  /** The element a resolved spell's card is drawn in now: the card itself, else the pile or hand that holds it. */
  function destinationOf(cardId: number): Element | null {
    const own = cardBox(canvas, cardId);
    if (own !== null) return own;
    for (const p of lastView?.players ?? []) {
      const zone = p.graveyard.some((c) => c.id === cardId)
        ? 'graveyard'
        : p.exile.some((c) => c.id === cardId)
          ? 'exile'
          : (p.hand ?? []).some((c) => c.id === cardId)
            ? 'hand'
            : null;
      if (zone !== null) return canvas.querySelector(`[data-testid="player"][data-player-id="${p.id}"] [data-zone="${zone}"]`);
    }
    return null;
  }

  /** An ability's source card on the battlefield: the effect goes back into what made it. */
  function sourceBox(d: Drawn): Element | null {
    return d.sourceCardId === null || !onBattlefieldNow(d.sourceCardId) ? null : cardBox(canvas, d.sourceCardId);
  }

  /**
   * AE27: a counter and the item it targets left in the same frame. The counter blinks, the target
   * is destroyed, then the counter fades — three steps out of Forge's one.
   */
  function counter(resolverId: number, targetId: number): void {
    const resolver = drawn.get(resolverId);
    const target = drawn.get(targetId);
    if (resolver === undefined || target === undefined) return;
    resolver.leaving = true;
    target.leaving = true;
    if (reduced()) {
      removeNow(resolverId);
      removeNow(targetId);
      return;
    }
    resolver.el.removeAttribute('data-placed-next');
    resolver.el.setAttribute('data-placed-resolving', '');
    schedule(() => {
      target.el.setAttribute('data-placed-countered', '');
      schedule(() => removeNow(targetId), COUNTERED_MS);
      schedule(() => {
        resolver.el.removeAttribute('data-placed-resolving');
        resolver.el.setAttribute('data-placed-leaving', '');
        schedule(() => removeNow(resolverId), LEAVE_FADE_MS);
      }, COUNTERED_MS);
    }, RESOLVE_BLINK_MS);
  }

  /** An ability nobody stopped has resolved: its source card on the battlefield, if it is there, shimmers once. */
  function shimmer(cardId: number | null): void {
    if (cardId === null || !onBattlefieldNow(cardId)) return;
    const el = cardBox(canvas, cardId);
    if (el === null) return;
    const turn = (shimmers.get(el) ?? 0) + 1;
    shimmers.set(el, turn);
    // Off and on again in one task restarts the animation for a second ability of the same card.
    el.removeAttribute('data-shimmer');
    void (el as HTMLElement).offsetWidth;
    el.setAttribute('data-shimmer', '');
    schedule(() => {
      if (shimmers.get(el) === turn) el.removeAttribute('data-shimmer');
    }, SHIMMER_MS);
  }

  function drawArrows(items: readonly StackEntry[]): void {
    const root = overlay();
    if (root === null) return;
    const box = root.getBoundingClientRect();
    const seen = new Set<string>();
    for (const item of items) {
      const d = drawn.get(item.id);
      if (d === undefined || d.leaving) continue;
      const from = centreOf(d.el);
      const targets: { key: string; to: Element }[] = [];
      for (const id of item.targetCardIds ?? []) {
        const to = cardBox(canvas, id);
        if (to !== null) targets.push({ key: `${item.id}:card:${id}`, to });
      }
      for (const id of item.targetPlayerIds ?? []) {
        const to = faceBox(canvas, id);
        if (to !== null) targets.push({ key: `${item.id}:player:${id}`, to });
      }
      if (item.targetStackItemId !== null && item.targetStackItemId !== undefined) {
        const target = drawn.get(item.targetStackItemId);
        if (target !== undefined && !target.leaving) targets.push({ key: `${item.id}:stack:${item.targetStackItemId}`, to: target.el });
      }
      for (const { key, to } of targets) {
        seen.add(key);
        const aimed = aimAt(from, rectOf(to), { neighbours: true });
        let svg = root.querySelector<SVGSVGElement>(`.placed__arrow[data-key="${key}"]`);
        if (svg === null) {
          svg = newArrow({ className: 'placed__arrow', testid: 'placed-arrow', shaftClass: 'placed__arrow-shaft', headClass: 'placed__arrow-head' });
          svg.setAttribute('data-for', String(item.id));
          svg.setAttribute('data-key', key);
          root.append(svg);
        }
        positionArrow(svg, aimed.from, aimed.tip, box);
      }
    }
    for (const el of [...root.querySelectorAll('.placed__arrow')]) {
      if (!seen.has(el.getAttribute('data-key') ?? '')) el.remove();
    }
  }

  function render(): void {
    const root = overlay();
    const view = lastView;
    if (root === null || view === null) {
      for (const id of [...drawn.keys()]) removeNow(id);
      return;
    }
    promote(view.stack);
    const overlayBox = root.getBoundingClientRect();
    // A spell is a hand card's size, an ability's chip squared off a battlefield card's (`card-size.ts`, the one source) — measured once per paint.
    const cardWidth = battlefieldCardWidth(canvas, 'you') ?? battlefieldCardWidth(canvas, 'them');
    const spellWidth = handCardWidth(canvas);
    // The triggers still waiting to go on the stack are chips already, after everything on it.
    const items = [...view.stack, ...(view.pendingTriggers ?? [])];
    const currentIds = new Set(items.map((i) => i.id));
    handOver(view.stack, currentIds);

    // Resolved/left items first, so a leaving one never counts toward `taken` below.
    const departed = [...drawn].filter(([id]) => !currentIds.has(id));
    const departedIds = new Set(departed.map(([id]) => id));
    // A counter first: its target must not start an ordinary fade of its own.
    for (const [id, d] of departed) {
      const target = d.targetStackItemId;
      const countered = target === null || d.leaving || !departedIds.has(target) ? undefined : drawn.get(target);
      if (countered === undefined || countered.leaving) continue;
      if (!countered.isAbility && countered.sourceCardId !== null && onBattlefieldNow(countered.sourceCardId)) continue;
      counter(id, target!);
    }
    for (const [id, d] of departed) leave(id, d.isAbility ? null : d.sourceCardId);
    settleArrivals();
    for (const [id, sourceCardId] of undrawn) {
      if (currentIds.has(id)) continue;
      undrawn.delete(id);
      shimmer(sourceCardId);
    }

    const taken: Rect[] = [];
    items.forEach((item, index) => {
      if (item.isAbility && !drawn.has(item.id) && chainHalted === false) {
        // A waiting trigger nobody stopped for shimmers once, as the stack item it becomes.
        if (item.pending !== true) undrawn.set(item.id, item.sourceCardId);
        return;
      }
      undrawn.delete(item.id);
      const record = placements.get(item.id);
      const d = ensureElement(item, record);
      sizeAsCard(d.el, d.isAbility ? cardWidth : spellWidth);
      if (d.isAbility) squareChip(d, cardWidth, overlayBox);
      d.targetStackItemId = item.targetStackItemId ?? null;
      const held = item.isAbility ? null : heldUntil(item.sourceCardId);
      // Held: looked at again when the hold runs out (`placeSpell`/`releaseSpell` repaint sooner).
      if (held !== null && d.holdCheckAt !== held) {
        d.holdCheckAt = held;
        schedule(render, held - Date.now() + 1);
      }
      if (d.pendingUntil !== null && (record !== undefined || Date.now() >= d.pendingUntil)) d.pendingUntil = null;
      d.el.toggleAttribute('data-placed-pending', held !== null || d.pendingUntil !== null);
      if (d.leaving) return; // a resolved id Forge is reusing before the fade finished — rare, leave it be
      const resolved = positionOf(item, d, taken, overlayBox);
      if (resolved === null) return;
      const { at, reserved } = resolved;
      if (reserved !== null) taken.push(reserved);
      const p = overlayPoint(at, overlayBox);
      d.el.toggleAttribute('data-placed-gliding', record?.gliding === true);
      d.el.style.left = `${p.x}px`;
      d.el.style.top = `${p.y}px`;
      d.el.setAttribute('aria-label', itemLabel(item));
      // AE28: a trigger or ability of the viewer's own has no placement record (nothing was released
      // anywhere) — it is still theirs to move, like a spell they placed.
      const viewer = viewerName();
      const ownUnplaced = record === undefined && item.isAbility && viewer !== null && item.controllerName === viewer;
      if ((record !== undefined && record.side === 'you') || ownUnplaced) d.el.setAttribute('data-mine', '');
      else d.el.removeAttribute('data-mine');
      const selectable = !item.isAbility && item.sourceCardId !== null && interaction?.isSelectable(item.sourceCardId) === true;
      if (selectable) d.el.setAttribute('data-selectable', '');
      else d.el.removeAttribute('data-selectable');
      if (index === 0 && item.pending !== true) d.el.setAttribute('data-placed-next', '');
      else d.el.removeAttribute('data-placed-next');
      d.current = item.current === true;
      d.el.toggleAttribute('data-placed-waiting', item.pending === true);
      d.el.toggleAttribute('data-placed-current', d.current);
    });

    drawArrows(view.stack);
    pruneStale(view.stack);
  }

  const hook = (): void => render();
  repaintHooks.add(hook);
  resized?.observe(canvas);

  return {
    notify(view: BoardView, nextInteraction?: PlacedInteraction): void {
      if (!live) return;
      lastView = view;
      interaction = nextInteraction;
      render();
    },
    dispose(): void {
      live = false;
      repaintHooks.delete(hook);
      resized?.disconnect();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const id of [...drawn.keys()]) removeNow(id);
      undrawn.clear();
    },
  };
}
