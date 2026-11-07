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
 * Three exports — W calls them and never
 * draws:
 *
 *   - `placeSpell(cardId, at, side)` — a release (the park, `gestures/install.ts`)
 *     or an opponent's spell becoming known registers a point, by the CARD's
 *     id (`StackEntry.sourceCardId`'s own namespace — the same id a card
 *     keeps from hand to stack to battlefield): the caster's own release
 *     happens before Forge has pushed a stack item at all. `notify` below
 *     promotes that registration onto the stack item's own `id` the moment
 *     a matching SPELL entry appears in `view.stack` (never an ability of the
 *     same card — a cast trigger's source is the spell itself), so every call
 *     after that — a drag's `gripStackItem` — addresses the same record by the
 *     stack id. The two namespaces are kept apart: Forge numbers cards
 *     and stack items separately, so a land just played as card 37 and the
 *     opponent's spell that is stack item 37 are different things, and the
 *     land's release must never place that spell.
 *   - `gripStackItem(id, hand, at, grip, side, order?)` — a hand on a stack
 *     item, by its own id, takes hold, moves it or lets go: this screen's own
 *     drag (`gestures/install.ts`, any item, either seat's) or another seat's,
 *     relayed (`forge:placed`, `presence.ts`), with the server's word on who
 *     holds it. It registers the item's point if it had none (an own trigger
 *     nobody placed), and redraws this id's arrows.
 *   - `onSpellMoved(listener)` — every move of this screen's own hand, with its
 *     grip, which is what lane W relays over the wire. Returns the unsubscribe.
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
 *   - A counter or a fizzle (AE27): the WIRE says which departed stack items
 *     left this way, never resolving cleanly (`BoardView.counteredStackItems`,
 *     `PlayBridge.java`'s `EffectJournal` — a direct counter has no
 *     `GameEventSpellResolved` of its own; a fizzle has one with
 *     `hasFizzled`). Every such item cracks and fades in place
 *     (`data-placed-countered`), never the house glide `data-placed-leaving`
 *     gets. When the item that countered it is ALSO drawn and departs the
 *     same round, aimed at it (`targetStackItemId`), it gets the nicer
 *     three-beat instead: the resolver blinks (`data-placed-resolving`), the
 *     target cracks and fades, then the resolver fades
 *     (`data-placed-leaving`) — the wire fact decides WHETHER it was
 *     countered; a drawn, aimed pairing only decides whether the resolver
 *     gets its own beat too.
 *   - An ability (triggered or activated) is drawn only once the chain HALTS
 *     over it — someone holds priority or must answer with it on the stack
 *     (`setChainHalted`, `LiveBoard`'s own facts). One nobody stopped is never
 *     drawn: when it leaves, its source card on the battlefield shimmers
 *     instead (`data-shimmer` on the board card, `card.css`).
 *   - `.placed__arrow[data-for="<item.id>"]` — one per target the item has
 *     (`aimAt`, `gestures/arrow.ts`, reused exactly as Settled requires — no
 *     second geometry), redrawn on every `notify` and on every `gripStackItem`
 *     (item 8's other mutation point — see `registerRepaint`/`afterChange`
 *     below, the one place that call happens, so it is the one place a
 *     mutant can drop it).
 *   - `.placed__hover` — the element's one child, the part that hovers while it
 *     is on the stack (`placed.css`); its face, back or chip is drawn inside it.
 */
import { PRESENCE_SEND_MS } from '@hadoku/shared';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CardTile } from '../../components/CardTile.tsx';
import { artistsReady } from '../../draft/artists.ts';
import { artReady, cardImageUrl } from '../../draft/cardImage.ts';
import { battlefieldCardWidth, handCardWidth, onCardWidthsChanged, sizeAsCard } from '../card-size.ts';
import { GLIDE_MS, HOUSE_DURATIONS, noteBoardDrawing, PLACEMENT_WAIT_MS, takeResolutionEffects, writeDurations } from '../motion.ts';
import { prefersReducedMotion } from '@hadoku/ui-shell/motion';
import { AbilityChip } from './AbilityChip.tsx';
import { resolvedTempo } from './tempo.ts';
import { HiddenCard } from '../HiddenCard.tsx';
import { viewerOf, type BoardView, type StackEntry } from '../adapter.ts';
import { aimBetween, breathe, landArrow, newArrow, positionArrow, removeArrow, retireCommitted } from './gestures/arrow.ts';
import { shards } from './departures.ts';
import { centreOf } from '../lift.ts';
import { battlefieldCard, cardBox, faceBox, overlayOf, zoneOf } from './board-dom.ts';
import type { Point } from './gestures/types.ts';
import './placed.css';

export type { Point };

/** How long a resolved spell takes to travel into where it went, fading as it arrives — the house glide. Reduced motion skips straight to it. */
export const LEAVE_FADE_MS = GLIDE_MS;
/** AE27: the resolving counter's blink, before its target cracks (the three-beat version only). */
export const RESOLVE_BLINK_MS = 400;
/** AE27: a countered or fizzled item's crack-and-fade — the wire decides WHICH items get this, never this constant. */
export const COUNTERED_MS = 400;
/** AE27: how many crack lines spread across a countered card's face (`departures.ts`'s `shards`, its `cracks` alone — no pieces, no parts). */
const COUNTERED_CRACKS = 5;
/**
 * AE27: once the wire says an item was countered, how long this waits to see whether a DRAWN item
 * aimed at it also departs the stack (the nicer three-beat, `counter()`) before giving up and
 * cracking it alone. Forge can send the countered spell off in one delta and the counter in the
 * next (w67-counter, run 39832352790: 67 ms apart, drawn in two commits) — this is purely about
 * getting the resolver's own beat, never about WHETHER the target was countered, which the wire
 * already said.
 */
export const COUNTER_HOLD_MS = 1000;
/** A stack card sliding to the room the others left it (`placed.css`'s `--stack-move-ms`). */
export const STACK_MOVE_MS = 360;
/** A placed card easing to the opacity its state draws it at. */
const FADE_MS = 250;
/** The lengths `placed.css` animates over, set on the canvas so the sheet never restates one. */
const DURATIONS = [
  ...HOUSE_DURATIONS,
  ['--fade-ms', FADE_MS],
  ['--leave-fade-ms', LEAVE_FADE_MS],
  ['--resolve-blink-ms', RESOLVE_BLINK_MS],
  ['--countered-ms', COUNTERED_MS],
  ['--stack-move-ms', STACK_MOVE_MS],
] as const;
/** On a permanent's own board card once it resolves off the stack, until its settle has run (`placed.css`'s `stack-settle`). */
export const STACK_SETTLE_ATTR = 'data-stack-settle';
/**
 * How many of the stack's top cards hover (`placed.css`'s `--stack-hover`); the rest hold still. Each hovering
 * card is three endless animations the browser runs every frame: 23 triggers on the stack ran the operator's
 * game at 25 fps for thirteen seconds (match m-0a1c953741c7, 2026-10-25).
 */
export const STACK_HOVER_MAX = 4;
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

/**
 * How long an ability's chip stays on screen, still and with its art, before it goes — however soon
 * Forge resolved it (the operator, 2026-10-28: "the ability chip showed for only a brief moment and
 * was missing the art").
 */
export const CHIP_DWELL_MS = 1500;
/** The longest a chip waits, hidden, for its art, its credit and its own size before it is drawn without them. */
export const CHIP_ART_WAIT_MS = 1000;

/**
 * A card being dragged stands exactly where the pointer puts it, and the stack makes room round it; this
 * long after its last move it is let go, and comes to rest clear of the others like any card.
 */
export const DRAG_HOLD_MS = 400;

/** How far a card sits to the right of its source's own box (the ephemeral tile, Settled). */
const BESIDE_GAP = 6;
/** The match's control box (`LiveBoard.tsx`'s End Turn and the buttons with it), which no stack card covers. */
const CONTROL_BOX = '[data-testid="live-buttons"]';

interface Placement {
  at: Point;
  readonly side: 'you' | 'them';
  /**
   * `Date.now()` when this was last registered, so an unmatched one expires `PLACEMENT_WAIT_MS` after
   * the last word, never after a first one: a card played again inherits nothing of an earlier release
   * that never reached the stack.
   */
  readonly registeredAt: number;
  /** `Date.now()` of the last move of a drag (either seat's), or when its glide there ends: until `DRAG_HOLD_MS` after it, it stands where it was put. */
  movedAt: number | null;
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
/** Where a drag of this screen's is: picked up, moving, let go (`@hadoku/shared`'s `placed.ts`, `grip`). */
export type Grip = 'grab' | 'move' | 'drop';
const moveListeners = new Set<(id: number, at: Point, grip: Grip) => void>();
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
export function setChainHalted(halted: boolean | null, halts = haltsTold): void {
  if (chainHalted === halted && halts === haltsTold) return;
  chainHalted = halted;
  haltsTold = halts;
  requestRepaint();
}

/**
 * How many times the other seat has held the chain (`LiveMatch.othersHalted`), as last told and as
 * last drawn. A hold that opened and closed between two paints still halted the chain: the next
 * paint draws what is on the stack as if it were halted, so a pass however quick shows its chip.
 */
let haltsTold = 0;
let haltsDrawn = 0;

/**
 * The other seats' clickable battlefield cards, by seat, as their boards last said (`forge:offered`,
 * relayed by `presence.ts`): the chips here keep clear of those too. The operator, 2026-11-02: *"we
 * should avoid blocking the opponents playable cards as well."*
 */
const peerClickable = new Map<number, readonly number[]>();
export function setPeerClickable(seat: number, cards: readonly number[]): void {
  peerClickable.set(seat, cards);
  requestRepaint();
}

/** This board's own clickable battlefield cards, each time they change: `presence.ts` says them to the other screens. */
const ownClickableListeners = new Set<(cards: readonly number[]) => void>();
export function onOwnClickable(listener: (cards: readonly number[]) => void): () => void {
  ownClickableListeners.add(listener);
  return () => ownClickableListeners.delete(listener);
}

function register(records: Map<number, Placement>, id: number, at: Point, side: 'you' | 'them', movedAt: number | null = null): void {
  records.set(id, { at, side, registeredAt: Date.now(), movedAt });
  requestRepaint();
}

/**
 * Register (or move) a released card's point, by its CARD id — see the module
 * header. A spell of theirs is registered once it is public, so it is drawn
 * as its face as soon as its art has decoded.
 */
export function placeSpell(cardId: number, at: Point, side: 'you' | 'them'): void {
  holds.delete(cardId);
  register(releases, cardId, at, side);
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

/**
 * Two hands on one stack item: it stands between them, and the last to let go places it. The
 * operator, 2026-11-02: *"lets also make it so the opponent can drag and move things on the stack
 * around … make sure we handle the case where both players try to drag and move the same thing. this
 * is a funny interaction i dont want to kill."* A tug of war, chosen over the newest hand taking it.
 */

/**
 * A hand on a stack item: where it is drawn from (`from`, at `since`), its latest point (`to`), and
 * how long it takes to get there (`ms`). Alone on an item, this screen's own hand is always at its
 * latest: a drag follows the pointer. With two hands on it, every hand eases, or the point between
 * them saw-tooths: another seat's arrives a relay apart (`PRESENCE_SEND_MS`, later when the wire is
 * slow) and eases over two relays, so it never stops between them; this screen's own moves a
 * pointer event at a time and eases over one. Claw runs 41545233269 (3 turns in 46 frames, the
 * other hand stepping) and 41571386507 (7 turns at 60 fps, this hand stepping 10 px a move).
 */
type Hand = { from: Point; to: Point; since: number; ms: number };
const OWN_EASE_MS = PRESENCE_SEND_MS;
const RELAYED_EASE_MS = 2 * PRESENCE_SEND_MS;
/** When the hands on an item change (one takes hold or lets go), it moves to its new point over this, never in a step. */
const HANDS_CHANGE_MS = GLIDE_MS;

/**
 * The hands on each stack item, by item id, in the order they took hold — `you` (this screen's
 * pointer) and `seat:N` (another seat's, as the server relays it).
 */
const hands = new Map<number, Map<string, Hand>>();
/** Items whose hands just changed: the point it was drawn at then, and when. */
const handsChanged = new Map<number, { from: Point; since: number }>();

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const progress = (now: number, since: number, ms: number): number => (ms <= 0 ? 1 : Math.min(1, Math.max(0, (now - since) / ms)));

/** Where a hand is drawn at `now`: its latest, or (`ease`) on its way there from where it was. */
function handAt(hand: Hand, now: number, ease: boolean): Point {
  return ease ? lerp(hand.from, hand.to, progress(now, hand.since, hand.ms)) : hand.to;
}

/** Where the hands on an item put it: between them. */
function handsPoint(held: ReadonlyMap<string, Hand>, now: number, ease: boolean): Point | null {
  const points = [...held.values()].map((h) => handAt(h, now, ease));
  if (points.length === 0) return null;
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
}

/**
 * Where stack item `id` is drawn at `now`, and whether it is still on its way there (another frame is
 * due). `at`: its placement's own point, which is the hands' latest. `ease`: false under reduced
 * motion, where it steps to each point.
 */
function drawnPoint(id: number, at: Point, now: number, ease: boolean): { at: Point; moving: boolean } {
  if (!ease) return { at, moving: false };
  const held = hands.get(id);
  const target = held === undefined ? at : (handsPoint(held, now, true) ?? at);
  let moving = held !== undefined && [...held.values()].some((h) => now - h.since < h.ms);
  const changed = handsChanged.get(id);
  if (changed === undefined) return { at: target, moving };
  const t = progress(now, changed.since, HANDS_CHANGE_MS);
  if (t >= 1) {
    handsChanged.delete(id);
    return { at: target, moving };
  }
  moving = true;
  // Ease out: quick to leave, settling into the new point.
  return { at: lerp(changed.from, target, 1 - (1 - t) ** 3), moving };
}

/**
 * A hand on stack item `id` takes hold, moves or lets go (`grip`). `you` is this screen's own pointer
 * (`gestures/install.ts`), and is told on to the other screens (`onSpellMoved`); any other hand is
 * another seat's, relayed by the server (`presence.ts`), with `order`, the hands the server says hold
 * it now, oldest first: the one record both screens settle on, so a hand it let go (its socket went)
 * goes here too. A move from a hand that holds nothing is a plain point, as every move was before
 * shared drags. `side` is whose the item is, for one this screen has no record of yet.
 */
export function gripStackItem(id: number, hand: string, at: Point, grip: Grip, side: 'you' | 'them', order?: readonly string[]): void {
  const now = Date.now();
  const record = placements.get(id);
  const held = hands.get(id) ?? new Map<string, Hand>();
  const was = record === undefined ? null : drawnPoint(id, record.at, now, true).at;
  const before = [...held.keys()].join();
  const fresh = (p: Point): Hand => ({ from: p, to: p, since: now, ms: 0 });
  if (grip === 'grab' || grip === 'drop') held.delete(hand);
  if (grip === 'grab') held.set(hand, fresh(at));
  else if (grip === 'move' && held.has(hand)) {
    // A hand eases on from where it is drawn now (see `Hand`); this screen's own, alone on it, is where the pointer is.
    const shared = held.size > 1;
    const ms = hand !== 'you' ? RELAYED_EASE_MS : shared ? OWN_EASE_MS : 0;
    held.set(hand, ms === 0 ? fresh(at) : { from: handAt(held.get(hand)!, now, true), to: at, since: now, ms });
  }
  if (order !== undefined) {
    const mine = held.get('you');
    const kept = new Map(order.filter((h) => held.has(h) || h === hand).map((h) => [h, held.get(h) ?? fresh(at)] as const));
    // This screen's own hand stays while it drags, though the server has not heard it take hold yet.
    if (mine !== undefined && !kept.has('you')) kept.set('you', mine);
    held.clear();
    for (const [h, p] of kept) held.set(h, p);
  }
  const after = [...held.keys()].join();
  if (held.size > 0) hands.set(id, held);
  else hands.delete(id);
  // A change of hands moves it from where it was drawn: but this screen's own hand alone, picking it up or putting it down, is the pointer's.
  if (was !== null && after !== before && (hand !== 'you' || before.includes(',') || after.includes(','))) handsChanged.set(id, { from: was, since: now });
  // A point from no hand at all (a joiner's replay) is drawn where it says, at once.
  if (held.size === 0 && grip === 'move') handsChanged.delete(id);
  // The last hand to let go places it where it let go; a move from no hand is a point of its own.
  const point = held.size > 0 ? handsPoint(held, now, false)! : at;
  // A drag's point stands where it was put for a moment (`DRAG_HOLD_MS`), counted from when it gets
  // there: after a change of hands' glide, so the last let-go places it at the same spot on every
  // screen before it comes to rest. A joiner's replay is just a point.
  const movedAt = handsChanged.has(id) ? now + HANDS_CHANGE_MS : now;
  if (record === undefined) register(placements, id, point, side, held.size > 0 || grip === 'drop' ? movedAt : null);
  else {
    record.at = point;
    record.movedAt = movedAt;
  }
  if (hand === 'you') for (const listener of moveListeners) listener(id, at, grip);
  requestRepaint();
}

/**
 * Where the stack last drew a spell that resolved onto a battlefield, by its CARD id: its arrival
 * (`gestures/cast.ts`) starts from this box, so a card the stack moved lands from where it was seen.
 * Read once; gone after `PLACEMENT_WAIT_MS`.
 */
const landedFrom = new Map<number, { box: DOMRect; at: number }>();

export function stackBoxOf(cardId: number): DOMRect | null {
  const seen = landedFrom.get(cardId);
  landedFrom.delete(cardId);
  return seen === undefined || Date.now() - seen.at > PLACEMENT_WAIT_MS ? null : seen.box;
}

/** Every move of this screen's own hand on a stack item (`gripStackItem`), with its grip. Returns the unsubscribe. */
export function onSpellMoved(listener: (id: number, at: Point, grip: Grip) => void): () => void {
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
  landedFrom.clear();
  chainHalted = null;
  haltsTold = 0;
  haltsDrawn = 0;
  peerClickable.clear();
  hands.clear();
  handsChanged.clear();
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

/**
 * The default spot (decision a): the middle of the column the old stack band stood in — or, in
 * portrait (Settled 2: "the stack chip replaces `board__mid`'s column"), the stack chip itself,
 * since `board__mid` is `display: none` there (`portrait.css`) and its box has collapsed to
 * nothing. Read by measuring, not by checking `data-layout`: a collapsed box is the one fact that
 * actually matters here, and it is true exactly when `board__mid` has nothing to anchor on, however
 * that came to be.
 */
export function defaultSpot(canvas: ParentNode): Point | null {
  const mid = canvas.querySelector('[data-testid="board-mid"]');
  if (mid !== null) {
    const box = mid.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return centreOf(mid);
  }
  const stackChip = canvas.querySelector('[data-testid="stack-chip"]');
  if (stackChip !== null) return centreOf(stackChip);
  /*
   * `canvas` IS `.board` itself in production (`Board.tsx` calls `installPlaced(root.current, …)`,
   * and `root` is the `<section className="board">` ref) — `canvas.querySelector('.board')` would
   * search `.board`'s own DESCENDANTS for a SECOND `.board`, find none, and return null even though
   * the board plainly exists. `canvas` is only ever an `Element` in every caller (`installPlaced`'s
   * own signature) and in every test fixture's own wrapper div, so checking it against the selector
   * itself first, the way `Element.closest` would, is what actually finds it either way.
   */
  const board = canvas instanceof Element && canvas.matches('.board') ? canvas : canvas.querySelector('.board');
  return board === null ? null : centreOf(board);
}

/**
 * Portrait (Settled 4: "relation arrows clamp to the lane edge"): a target scrolled out of its own
 * lane still has a real (off-screen, possibly negative) box from `getBoundingClientRect` — aiming
 * an arrow at it would point off the visible board. Clamped to the lane's own visible width when
 * `to` sits inside one; a no-op everywhere else, including every desktop board, since
 * `[data-testid^="lane-"]` exists on nothing outside portrait (`Board.tsx`'s lane `<ul>`s). A target
 * scrolled PAST the lane entirely (nothing of it overlaps the lane's own box) clamps to a sliver at
 * whichever edge it left from, rather than inverting into a negative-width rect.
 */
export function clampToLane(at: Rect, to: Element): Rect {
  const lane = to.closest<HTMLElement>('[data-testid^="lane-"]');
  if (lane === null) return at;
  const laneBox = lane.getBoundingClientRect();
  const left = Math.max(at.left, laneBox.left);
  const right = Math.min(at.right, laneBox.right);
  if (right <= left) {
    const edge = at.right <= laneBox.left ? laneBox.left : laneBox.right;
    return { left: edge, right: edge, top: at.top, bottom: at.bottom };
  }
  return { left, right, top: at.top, bottom: at.bottom };
}

/**
 * Where an ephemeral ability card sits beside its source (Settled): to the source's right, clear of
 * it, at its own drawn size (`tile` — a chip is as wide as its text needs to be near square,
 * `squareChip` — and the source's own box before it has one). Within `bounds` (the overlay) when
 * given: on the source's LEFT when its right has no room, else as far in as it must be. Several
 * chips of one source all ask for this one spot; the stack spreads them from it (`settleStack`).
 */
export function besideSource(
  sourceBox: Rect,
  tile: { width: number; height: number } = { width: sourceBox.right - sourceBox.left, height: sourceBox.bottom - sourceBox.top },
  bounds: Rect | null = null,
): Point {
  const y = (sourceBox.top + sourceBox.bottom) / 2;
  const right = sourceBox.right + BESIDE_GAP + tile.width / 2;
  if (bounds === null) return { x: right, y };
  const left = sourceBox.left - BESIDE_GAP - tile.width / 2;
  const roomRight = right + tile.width / 2 <= bounds.right - BESIDE_GAP;
  const roomLeft = left - tile.width / 2 >= bounds.left + BESIDE_GAP;
  return within({ x: roomRight || !roomLeft ? right : left, y }, tile, bounds);
}

/** A stream of numbers in [0, 1) seeded by `id`: the same id draws the same numbers on both screens and on every repaint. */
function seeded(id: number): () => number {
  let h = (Math.abs(id) * 2654435761) >>> 0;
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 0x1_0000_0000;
  };
}

/**
 * A chip's own small, stable nudge off its spot (the operator, 2026-10-11: "i prefer a bit of
 * random placement rather than stacking all the valakut triggers in the same spot"): seeded by its
 * id, so both screens and every repaint agree, at most a fifth of the chip's width and a quarter of
 * its height either way.
 */
export function scatter(id: number, tile: { width: number; height: number }): { dx: number; dy: number } {
  const next = seeded(id);
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

/**
 * The stack's room. The operator, 2026-10-30, on ten Valakut triggers: *"if there isn't enough space
 * to fit more triggers, i wish for them to stack on top of eachother. it's okay if it's messy. allow
 * them to bump into eachother and make the collision only the inner 50% of the card's area. also when
 * they spread out can we apply a slight randomization to the directional vector?"*
 *
 * Each item asks for a spot (`want`: where it was released, beside its source, the default spot) at
 * its own size. The oldest is settled first and keeps its spot; each newer one bumps off the cards
 * settled before it: only their CORES collide (`STACK_CORE`, the inner half of a card's area), so
 * neighbours overlap at their edges. A bumped card moves the shortest way to a free spot, starting
 * from the push straight away from what it hit, turned by up to `STACK_JITTER` either way by its own
 * `seed` (its stack item), so a spread looks thrown rather than gridded, and a replay of the same
 * items draws the same layout. With no free spot left inside `bounds` it piles on top, where the
 * cards under it are thinnest: no card is ever refused a place or shrunk. A `pinned` item (one being
 * dragged) is settled before all of them, exactly where it is. No card's whole box enters a
 * `keepOut` box (the match's control box). Deterministic: the same asks always settle the same way.
 *
 * The operator, 2026-11-02, on Cephalid Breakfast: *"the ability chips eventually start to cover the
 * two cards, might be better if ability chips also respect "click-able" cards on the battlefield when
 * evaluating collision."* An ask that `yields` (an ability's chip, which nobody put anywhere) keeps
 * its whole box, and the reach of its hover (`HOVER_REACH`), off every `clickable` box: the cards the
 * viewer can click. That outranks the stack's own crowding, so with no clear room left the chips pile
 * on each other, as above, before one covers a card you can click; only a table with no clear room
 * at all lets one, where it covers least. A card nobody can click is no obstacle.
 */
export interface StackAsk {
  readonly want: Point;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly pinned?: boolean;
  readonly yields?: boolean;
}

/** The share of a stack card's width and of its height that collides: the inner half of its area. */
export const STACK_CORE = Math.SQRT1_2;
/** How far a bumped card's direction turns off the straight push, either way, in radians (about 20°). */
export const STACK_JITTER = 0.35;
/** The directions a bumped card tries, nearest the push first, and how far apart its tries are, as a share of its core. */
const SPREAD_RAYS = 24;
const SPREAD_STEP = 0.2;
/**
 * How far a hovering chip's drawn box reaches past its place (`placed.css`): the bob's 5px and the
 * drift's 3px, the turn's corner swing on a chip three cards wide, and a hair. A yielding chip keeps
 * this much further off a clickable card, so its hover never carries it over one.
 */
export const HOVER_REACH = 10;

type Core = { x: number; y: number; hw: number; hh: number };

/** How much of the boxes in `boxes` a `width` × `height` box centred on `p` covers, in px². */
function covering(p: Point, width: number, height: number, boxes: readonly Rect[]): number {
  let sum = 0;
  for (const b of boxes) {
    const w = Math.min(p.x + width / 2, b.right) - Math.max(p.x - width / 2, b.left);
    const h = Math.min(p.y + height / 2, b.bottom) - Math.max(p.y - height / 2, b.top);
    if (w > 0.01 && h > 0.01) sum += w * h;
  }
  return sum;
}

/** How much of `a`'s core the cores in `done` cover, in px². */
function crowding(a: Core, done: readonly Core[]): number {
  let sum = 0;
  for (const o of done) {
    const w = Math.min(a.x + a.hw, o.x + o.hw) - Math.max(a.x - a.hw, o.x - o.hw);
    const h = Math.min(a.y + a.hh, o.y + o.hh) - Math.max(a.y - a.hh, o.y - o.hh);
    if (w > 0.01 && h > 0.01) sum += w * h;
  }
  return sum;
}

/** `asks` is in stack order, top first — the order `view.stack` is in. */
export function settleStack(asks: readonly StackAsk[], bounds: Rect, keepOut: readonly Rect[] = [], clickable: readonly Rect[] = []): Point[] {
  const order = asks.map((_, i) => i).sort((i, j) => Number(asks[j]!.pinned === true) - Number(asks[i]!.pinned === true) || j - i);
  const at = new Array<Point>(asks.length);
  const done: Core[] = [];
  for (const i of order) {
    const ask = asks[i]!;
    const p = ask.pinned === true ? ask.want : spread(ask, bounds, keepOut, done, clickable);
    at[i] = p;
    done.push({ x: p.x, y: p.y, hw: (ask.width * STACK_CORE) / 2, hh: (ask.height * STACK_CORE) / 2 });
  }
  return at;
}

/**
 * The nearest spot to an ask's own where it is drawn clear of every `clickable` box, ignoring the rest
 * of the stack: a yielding chip is first shown here, so it never appears over a card you can click and
 * slides from there only to make room for the other chips (`settleStack`). Any other ask keeps its own.
 */
export function clearOfClickable(ask: StackAsk, bounds: Rect, keepOut: readonly Rect[], clickable: readonly Rect[]): Point {
  return ask.yields === true && clickable.length > 0 ? spread(ask, bounds, keepOut, [], clickable) : ask.want;
}

/** How far past its room a sliding card's easing carries it (`placed.css`'s `cubic-bezier(0.2, 0.8, 0.25, 1.1)` peaks at 1.018). */
const SLIDE_OVERSHOOT = 0.02;

/**
 * Whether a `width` × `height` card sliding in a straight line from `from` to `to`, its easing's overshoot
 * and its hover's reach included, passes over any of `boxes`: both ends may be clear of a card and the way
 * between them not (a corner cut on the way to its room). Each box is grown by half the card and the reach,
 * and the path's centre line is tested against it.
 */
export function slideCrosses(from: Point, to: Point, width: number, height: number, boxes: readonly Rect[]): boolean {
  const dx = (to.x - from.x) * (1 + SLIDE_OVERSHOOT);
  const dy = (to.y - from.y) * (1 + SLIDE_OVERSHOOT);
  const hw = width / 2 + HOVER_REACH;
  const hh = height / 2 + HOVER_REACH;
  return boxes.some((b) => {
    let enter = 0;
    let exit = 1;
    for (const [p, d, lo, hi] of [
      [from.x, dx, b.left - hw, b.right + hw],
      [from.y, dy, b.top - hh, b.bottom + hh],
    ] as const) {
      if (Math.abs(d) < 1e-9) {
        if (p <= lo || p >= hi) return false;
        continue;
      }
      const a = (lo - p) / d;
      const z = (hi - p) / d;
      enter = Math.max(enter, Math.min(a, z));
      exit = Math.min(exit, Math.max(a, z));
      if (enter >= exit) return false;
    }
    return true;
  });
}

function spread(ask: StackAsk, bounds: Rect, keepOut: readonly Rect[], done: readonly Core[], clickable: readonly Rect[]): Point {
  const size = { width: ask.width, height: ask.height };
  const hw = (ask.width * STACK_CORE) / 2;
  const hh = (ask.height * STACK_CORE) / 2;
  const start = within(ask.want, size, bounds);
  const allowed = (p: Point): boolean =>
    fits(p, size, bounds) &&
    keepOut.every((k) => p.x + size.width / 2 <= k.left || p.x - size.width / 2 >= k.right || p.y + size.height / 2 <= k.top || p.y - size.height / 2 >= k.bottom);
  const crowd = (p: Point): number => crowding({ x: p.x, y: p.y, hw, hh }, done);
  const avoid = ask.yields === true ? clickable : [];
  const reachW = ask.width + 2 * HOVER_REACH;
  const reachH = ask.height + 2 * HOVER_REACH;
  const covers = (p: Point): number => (avoid.length === 0 ? 0 : covering(p, reachW, reachH, avoid));
  if (allowed(start) && covers(start) === 0 && crowd(start) === 0) return start;
  // The push: straight away from what is in the way (the cores it hits and the cards it must not cover, else the box it must stay out of), turned by its seed.
  let ax = 0;
  let ay = 0;
  for (const o of done) {
    const c = crowding({ x: start.x, y: start.y, hw, hh }, [o]);
    ax += (start.x - o.x) * c;
    ay += (start.y - o.y) * c;
  }
  for (const k of avoid) {
    const c = covering(start, reachW, reachH, [k]);
    ax += (start.x - (k.left + k.right) / 2) * c;
    ay += (start.y - (k.top + k.bottom) / 2) * c;
  }
  if (ax === 0 && ay === 0) {
    for (const k of keepOut) {
      ax += start.x - (k.left + k.right) / 2;
      ay += start.y - (k.top + k.bottom) / 2;
    }
  }
  const next = seeded(ask.seed);
  const turn = (next() * 2 - 1) * STACK_JITTER;
  const push = (ax === 0 && ay === 0 ? next() * 2 * Math.PI : Math.atan2(ay, ax)) + turn;
  const step = Math.max(4, Math.min(hw, hh) * SPREAD_STEP);
  const reach = Math.hypot(bounds.right - bounds.left, bounds.bottom - bounds.top);
  // Where it piles with no free spot: covering the least of what can be clicked, then where the stack is thinnest.
  let pile: { p: Point; covers: number; crowd: number } | null = allowed(start) ? { p: start, covers: covers(start), crowd: crowd(start) } : null;
  for (let r = step; r <= reach; r += step) {
    for (let k = 0; k < SPREAD_RAYS; k++) {
      // Nearest the push first: 0, +1, −1, +2, −2 … rays off it.
      const off = k % 2 === 0 ? k / 2 : -(k + 1) / 2;
      const a = push + (off * 2 * Math.PI) / SPREAD_RAYS;
      const p = { x: start.x + r * Math.cos(a), y: start.y + r * Math.sin(a) };
      if (!allowed(p)) continue;
      const v = covers(p);
      if (pile !== null && v > pile.covers + 0.01) continue;
      const c = crowd(p);
      if (v === 0 && c === 0) return p;
      if (pile === null || v < pile.covers - 0.01 || c < pile.crowd - 0.01) pile = { p, covers: v, crowd: c };
    }
  }
  return pile?.p ?? start;
}

/** Whether a `tile` centred on `p` lies inside `bounds`, as `within` would keep it. */
function fits(p: Point, tile: { width: number; height: number }, bounds: Rect): boolean {
  const q = within(p, tile, bounds);
  return Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01;
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
  /** What is mounted now: a face (true) or a back (false), so it only remounts on an actual flip. */
  face: boolean;
  isAbility: boolean;
  /** The underlying card's id, remembered from when this was drawn — `view.stack` no longer has it once the item is gone. */
  readonly sourceCardId: number | null;
  /** The stack item this one targets, as last drawn — a counter's departure reads it (AE27). */
  targetStackItemId: number | null;
  /**
   * AE27: set true the moment the wire first says this item departed the stack not by resolving
   * cleanly (`BoardView.counteredStackItems`) — captured onto the record so a LATER callback
   * (`awaitCounter`'s timeout, `counter()`'s own schedules) never needs the view that said so, which
   * may already have moved on by the time it runs.
   */
  countered: boolean;
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
  /** When this was first drawn: a chip waits for its art from here, at most `CHIP_ART_WAIT_MS`. */
  readonly drawnAt: number;
  /** When it was first shown (no longer pending): a chip dwells from here (`CHIP_DWELL_MS`). */
  shownAt: number | null;
  /** Shown at its asked-for spot once: from the next paint it slides to its room (`settleStack`); until then it is drawn in place. */
  placedOnce: boolean;
  /** Where it was last drawn, in the page's coordinates: where a slide to its next place starts. */
  point: Point | null;
}

/** An item this paint draws, with what its place is worked out from. */
type Shown = { readonly item: StackEntry; readonly index: number; readonly d: Drawn; readonly record: Placement | undefined };

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
  // The ability's own words (`abilityTextOf`): its targets are its arrows and its accessible name.
  if (item.isAbility) return createElement(AbilityChip, { source: item.sourceCard, name: item.sourceName ?? item.sourceCard?.name ?? '', text: item.abilityText ?? item.description });
  if (item.sourceCard === null) return null;
  // A face-down spell of theirs: the same back a hidden card is in every zone (and the inspector's).
  return item.sourceHidden === true ? createElement(HiddenCard, { card: item.sourceCard }) : createElement(CardTile, { card: item.sourceCard });
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

/**
 * Draws a placed card centred on `p`, in the overlay's coordinates. The point is two custom properties that
 * `placed.css` turns into the card's `translate`, so a slide to a new point (the stack making room, a resolved
 * card leaving) runs on the compositor. Sliding `left`/`top` restyled, laid out and repainted it every frame.
 */
export function placeAt(el: HTMLElement, p: { x: number; y: number }): void {
  el.style.setProperty('--placed-x', `${p.x}px`);
  el.style.setProperty('--placed-y', `${p.y}px`);
}

export function installPlaced(canvas: HTMLElement, host: PlacedHost = {}): PlacedHandle {
  writeDurations(canvas, DURATIONS);
  // A chip's credit is the artist table, a lazy chunk: asked for now, so the first chip never waits on it.
  artistsReady(() => undefined);
  let live = true;
  let lastView: BoardView | null = null;
  let interaction: PlacedInteraction | undefined;
  /**
   * The battlefield cards either player could click at any point this turn — the viewer's, and the
   * other seat's as its board said (`setPeerClickable`) — which the chips keep clear of
   * (`StackAsk.yields`). Every prompt changes what can be clicked (a target, then priority with
   * your lands): a chip moves off a card the moment it can be clicked, and stays off it until the turn
   * ends rather than sliding back on between two prompts.
   */
  const clickable = { turn: Number.NaN, ids: new Set<number>(), own: '' };
  const drawn = new Map<number, Drawn>();
  /** AE27: items gone from the stack, still drawn while something on it targets them (`awaitCounter`). */
  const awaitingCounter = new Set<number>();
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
      if (item.isAbility || placements.has(item.id)) continue;
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
    // (its art decoding, which tears the old root down and makes a new one
    // rather than re-rendering — see below) is an ordinary React DOM update
    // and needs the same wait any such update does from outside `act()`.
    // of re-rendering it; see `ensureElement`, which only ever calls this once
    // per element's lifetime for that reason.
    const root = createRoot(host);
    root.render(face);
    return root;
  }

  /** `d.face` tracks what is CURRENTLY mounted, so this only remounts on an actual flip. */
  function ensureElement(item: StackEntry, record: Placement | undefined): Drawn {
    let d = drawn.get(item.id);
    // Their spell stays a back until it is public AND its art is decoded — a click-cast of theirs too,
    // which has no placement record: the operator, 2026-10-09, "i really dont want a no-art card to show ever".
    // An ability is never a back: it hides no card, so their first drag of it (which registers it here
    // face-down, `presence.ts`'s `onPlaced`) must not turn it over and rebuild it mid-move.
    const theirs = !item.isAbility && (record !== undefined ? record.side === 'them' : item.controllerName !== viewerName());
    const wantBack = theirs && !artReady(cardImageUrl(item.sourceCard?.scryfallId), requestRepaint);
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
        face: !wantBack,
        isAbility: item.isAbility,
        sourceCardId: item.sourceCardId,
        targetStackItemId: null,
        countered: false,
        leaving: false,
        pendingUntil: pending ? Date.now() + PLACED_PENDING_MS : null,
        holdCheckAt: null,
        squaredFor: null,
        offset: null,
        seed: item.id,
        current: false,
        drawnAt: Date.now(),
        shownAt: null,
        placedOnce: false,
        point: null,
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
    } else if (d.face === wantBack) {
      // Showing a face where a back is wanted, or the other way: its art has just decoded.
      deferUnmount(d.root);
      d.root = mount(d.hover, item, wantBack);
      d.face = !wantBack;
    }
    return d;
  }

  /**
   * Each ability's chip, as near square as it can be (`squareWidth`): one measure of its text's area at
   * the width it has, the width solved from it, then one correction for where the lines actually
   * wrapped. Every chip is read before any is written, so a pass is one layout for the whole stack.
   * Once per chip per card width and text — the redraw the resize itself causes finds it already
   * squared. Not before its text has rendered (the chip's own resize redraws it then). Says whether a
   * chip still waiting to be shown got its size, which it is shown at from the next paint.
   */
  function squareChips(chips: readonly Drawn[], cardWidth: number | null, overlayBox: DOMRect): boolean {
    if (cardWidth === null) return false;
    const waiting = chips.filter((d) => d.squaredFor === null && d.el.hasAttribute('data-placed-pending'));
    const max = Math.min(cardWidth * 3, overlayBox.width / 3);
    const px = (v: string): number => Number.parseFloat(v) || 0;
    let open = chips.flatMap((d) => {
      const text = d.el.querySelector<HTMLElement>('.placed__chip-text');
      const key = `${cardWidth}:${text?.textContent?.length ?? 0}`;
      if (text === null || d.squaredFor === key) return [];
      // No text to wrap: a card's width is already its size.
      if (!text.textContent) {
        d.squaredFor = key;
        return [];
      }
      const style = getComputedStyle(text);
      return [{ d, text, key, padX: px(style.paddingLeft) + px(style.paddingRight), padY: px(style.paddingTop) + px(style.paddingBottom) }];
    });
    for (let pass = 0; pass < 2 && open.length > 0; pass += 1) {
      const read = open.map((c) => ({ c, lines: c.text.getBoundingClientRect(), chip: c.d.el.getBoundingClientRect() }));
      open = [];
      for (const { c, lines, chip } of read) {
        if (!(lines.width > c.padX) || !(lines.height > c.padY)) continue; // no layout yet
        c.d.squaredFor = c.key;
        const area = (lines.width - c.padX) * (lines.height - c.padY);
        const w = Math.round(squareWidth(area, chip.height - lines.height + c.padY, c.padX, cardWidth, max));
        if (Math.abs(w - chip.width) < 1) continue;
        c.d.el.style.width = `${w}px`;
        open.push(c);
      }
    }
    return waiting.some((d) => d.squaredFor !== null);
  }

  /**
   * A spell's own card on the stack — a cast trigger's source is there, not on a battlefield — where
   * this paint puts it: at its placement when it has one, so a chip beside it moves with it in the same
   * paint, never a frame behind; else where it is drawn.
   */
  function spellOf(cardId: number): Rect | null {
    for (const [id, d] of drawn) {
      if (d.isAbility || d.leaving || d.sourceCardId !== cardId) continue;
      const at = placements.get(id)?.at;
      if (at === undefined || d.el.offsetWidth === 0) return rectOf(d.el);
      const w = d.el.offsetWidth / 2;
      const h = d.el.offsetHeight / 2;
      return { left: at.x - w, right: at.x + w, top: at.y - h, bottom: at.y + h };
    }
    return null;
  }

  /**
   * Whether a chip's art band can be drawn whole: its source's art decoded and its credit known
   * (`AbilityChip` shows no art it cannot credit). A source with no art of its own is ready at once.
   */
  function chipReady(item: StackEntry): boolean {
    const url = cardImageUrl(item.sourceCard?.scryfallId);
    if (url === null) return true;
    // Both asked every time, so both loads start together.
    const credited = artistsReady(requestRepaint);
    return artReady(url, requestRepaint) && credited;
  }

  /** What `positionOf` reads of an ability's chip: its source's box and its own drawn size, read before any chip is moved. */
  function chipBoxesOf(item: StackEntry, d: Drawn): { source: Rect; tile: { width: number; height: number } } | null {
    if (!item.isAbility || item.sourceCardId === null || placements.has(item.id)) return null;
    const onTable = cardBox(canvas, item.sourceCardId);
    const sourceBox = onTable !== null ? rectOf(onTable) : spellOf(item.sourceCardId);
    if (sourceBox === null) return null;
    const drawnBox = d.el.getBoundingClientRect();
    const tile =
      drawnBox.width > 0 ? { width: drawnBox.width, height: drawnBox.height } : { width: sourceBox.right - sourceBox.left, height: sourceBox.bottom - sourceBox.top };
    return { source: sourceBox, tile };
  }

  /**
   * Portrait (Settled 4: "unplaced spells land at the end of their lane"): a non-ability item with
   * no chip (`positionOf`'s own `chip === null` branch) used to fall straight to the shared default
   * `spot` (the stack chip, now — `defaultSpot`'s own doc) whatever it is. In portrait that spot is
   * one point shared by EVERY unplaced spell at once; this instead reads the lane the item's own
   * card would settle into — its controller's (`viewerName`) and its type's (`sourceCard.typeLine`,
   * the same land/other split `Board.tsx`'s `laneTestId` draws the lane from) — and aims at that
   * lane's own leading edge, where an arriving permanent actually lands. `null` wherever no such
   * lane exists (every desktop board: `Board.tsx` only sets `data-testid="lane-…"` in portrait), so
   * `positionOf` falls back to the shared `spot` there exactly as before.
   */
  function laneEndSpot(item: StackEntry): Point | null {
    if (item.isAbility || item.sourceCard === null) return null;
    const mine = item.controllerName !== null && item.controllerName === viewerName();
    const isLand = /\bLand\b/i.test(item.sourceCard.typeLine);
    const lane = canvas.querySelector(`[data-testid="lane-${mine ? 'my' : 'their'}-${isLand ? 'lands' : 'permanents'}"]`);
    if (lane === null) return null;
    const box = lane.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const EDGE_PAD = 14;
    return { x: box.right - EDGE_PAD, y: box.top + box.height / 2 };
  }

  /**
   * The point an item asks for (`settleStack` makes the room).
   * Worked out from boxes read before any item moved (`chipBoxesOf`, the default `spot`). A chip goes beside its source, nudged by its own `scatter`, and stays at that offset from the source once it has its size.
   */
  function positionOf(item: StackEntry, d: Drawn, chip: ReturnType<typeof chipBoxesOf>, spot: Point | null, bounds: Rect): Point | null {
    const promoted = placements.get(item.id);
    if (promoted !== undefined) {
      const drawn = drawnPoint(item.id, promoted.at, Date.now(), !reduced());
      if (drawn.moving) easing = true;
      return drawn.at;
    }
    if (chip !== null) {
      const { source: sourceBox, tile } = chip;
      const centre = { x: (sourceBox.left + sourceBox.right) / 2, y: (sourceBox.top + sourceBox.bottom) / 2 };
      let at: Point;
      if (d.offset !== null) {
        at = within({ x: centre.x + d.offset.dx, y: centre.y + d.offset.dy }, tile, bounds);
      } else {
        const spot = besideSource(sourceBox, tile, bounds);
        const { dx, dy } = scatter(d.seed, tile);
        at = within({ x: spot.x + dx, y: spot.y + dy }, tile, bounds);
        if (d.squaredFor !== null) d.offset = { dx: at.x - centre.x, dy: at.y - centre.y };
      }
      return at;
    }
    return laneEndSpot(item) ?? spot;
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
      landedFrom.set(cardId, { box: d.el.getBoundingClientRect(), at: Date.now() });
      removeNow(id);
      return;
    }
    if (d.leaving) return;
    markGone(d);
    hold(id, cardId);
    if (reduced()) {
      removeNow(id);
      return;
    }
    // What it did is drawn first (`numbers.ts`'s beats: hits, a creature destroyed): it stays where it
    // is while that plays, and then goes the ordinary way — no blink (the operator, 2026-10-15: the
    // "double blink" was "a bit slow and weird").
    // A chip nobody ever saw goes as it came; one that was seen stays its `CHIP_DWELL_MS` first, at the tempo it resolved at (`./tempo.ts`).
    if (d.isAbility && d.shownAt === null) {
      removeNow(id);
      return;
    }
    const until = Math.max(takeResolutionEffects(id) ?? 0, d.isAbility ? d.shownAt! + CHIP_DWELL_MS / resolvedTempo(id) : 0);
    if (until > Date.now()) {
      schedule(() => fadeInto(id, d, cardId), until - Date.now());
      return;
    }
    fadeInto(id, d, cardId);
  }

  /**
   * An item has left the stack: from here it only plays out (a chip's dwell, a crack, a fade) and
   * takes no pointer. A resolved chip dwells `CHIP_DWELL_MS` beside its source and, at `auto`, swallowed
   * the press meant for the permanent under it (`e2e/tf-thopter-sword.spec.ts`: the Foundry's own
   * click landed on the leaving chip).
   */
  function markGone(d: Drawn): void {
    d.leaving = true;
    d.el.setAttribute('data-placed-gone', '');
  }

  /** A resolved item travels into wherever its card went, fading as it arrives, and is gone there. */
  function fadeInto(id: number, d: Drawn, cardId: number | null): void {
    // Into wherever it went — a graveyard, an exile, a hand — and gone there; in place when that is not drawn.
    const to = cardId === null ? sourceBox(d) : destinationOf(cardId);
    if (to !== null) {
      const root = overlay();
      const p = root === null ? null : overlayPoint(centreOf(to), root.getBoundingClientRect());
      if (p !== null) {
        placeAt(d.el, p);
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
   * AE27: the crack-and-fade look itself — crack lines spread across the card's face (`shards`'
   * own `cracks`, reused from the departures' approved look, never its pieces or parts: this card
   * never spins, shrinks or falls apart), then it drains of colour and fades, in place. One draw per
   * item; `removeNow` tears the lines down with the rest of `d.el` once it is gone.
   */
  function crack(id: number, d: Drawn): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'placed__cracks');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    for (const points of shards(d.sourceCardId ?? id, COUNTERED_CRACKS).cracks) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', points);
      line.setAttribute('pathLength', '1');
      svg.append(line);
    }
    d.el.append(svg);
    d.el.setAttribute('data-placed-countered', '');
  }

  /**
   * AE27: a countered or fizzled item with no drawn resolver to pair it with (an undrawn trigger's
   * counter, a mass counter, a fizzle, a counter the wire paired a frame late and nothing turned up
   * to wait for) — cracks and fades on its own, in place, never the house glide.
   */
  function crackAndFade(id: number, d: Drawn): void {
    if (d.leaving) return;
    markGone(d);
    hold(id, d.isAbility ? null : d.sourceCardId);
    if (reduced()) {
      removeNow(id);
      return;
    }
    crack(id, d);
    countering(COUNTERED_MS);
    schedule(() => removeNow(id), COUNTERED_MS);
  }

  /**
   * A spell being countered is a beat of the board, until the countered spell has cracked and faded: what
   * waits on the board's beats waits on it (`../motion.ts`'s `noteBoardDrawing`; the operator, 2026-10-29:
   * *"my 90% rule was more about the more common animations like cards on the stack getting countered"*). On
   * its own clock, so a disposed layer still lets it go; and not before its animations, started a render late
   * on a loaded page, are 90% through themselves.
   */
  function countering(ms: number): void {
    noteBoardDrawing(new Promise((over) => setTimeout(over, ms)), { endsInMs: ms, root: canvas });
  }

  /**
   * AE27: a drawn resolver, aimed at a drawn target the wire already says was countered, both
   * departing the stack the same round. The counter blinks, the target cracks and fades, then the
   * counter fades — three steps out of Forge's one.
   */
  function counter(resolverId: number, targetId: number): void {
    const resolver = drawn.get(resolverId);
    const target = drawn.get(targetId);
    if (resolver === undefined || target === undefined) return;
    markGone(resolver);
    markGone(target);
    if (reduced()) {
      removeNow(resolverId);
      removeNow(targetId);
      return;
    }
    resolver.el.removeAttribute('data-placed-next');
    resolver.el.setAttribute('data-placed-resolving', '');
    countering(RESOLVE_BLINK_MS + COUNTERED_MS);
    schedule(() => {
      crack(targetId, target);
      schedule(() => removeNow(targetId), COUNTERED_MS);
      schedule(() => {
        resolver.el.removeAttribute('data-placed-resolving');
        resolver.el.setAttribute('data-placed-leaving', '');
        schedule(() => removeNow(resolverId), LEAVE_FADE_MS);
      }, COUNTERED_MS);
    }, RESOLVE_BLINK_MS);
  }

  /**
   * AE27: the wire already says `id` was countered or fizzled (`d.countered`); this waits to see
   * whether a DRAWN item aimed at it also departs the stack this round or the next, for the nicer
   * three-beat (`counter`, above) — past `COUNTER_HOLD_MS` nothing turned up, and it cracks alone.
   */
  function awaitCounter(id: number, d: Drawn): void {
    if (awaitingCounter.has(id)) return;
    awaitingCounter.add(id);
    schedule(() => {
      awaitingCounter.delete(id);
      if (drawn.get(id) !== d || d.leaving) return;
      if (d.countered) crackAndFade(id, d);
      else leave(id, d.isAbility ? null : d.sourceCardId);
    }, COUNTER_HOLD_MS);
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

  /** Every arrow's ends read first, then every arrow written: one layout for the lot, and none with nothing aimed. */
  function drawArrows(items: readonly StackEntry[], overlayBox: () => DOMRect): void {
    const root = overlay();
    if (root === null) return;
    const aims: { key: string; item: number; source: number | null; to: Element; at: Rect; aimed: { from: Point; tip: Point } }[] = [];
    for (const item of items) {
      const d = drawn.get(item.id);
      if (d === undefined || d.leaving) continue;
      const targets: { key: string; to: Element; box?: Rect | undefined }[] = [];
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
        if (target !== undefined && !target.leaving) targets.push({ key: `${item.id}:stack:${item.targetStackItemId}`, to: target.el, box: settledBoxes.get(item.targetStackItemId) });
      }
      if (targets.length === 0) continue;
      // From the card's top centre to just inside its target, drawn over the stack (`placed.css`): a near
      // target is landed on at its middle (`aimBetween`), never pointed at with a stub.
      const own = settledBoxes.get(item.id) ?? rectOf(d.el);
      for (const { key, to, box } of targets) {
        const at = clampToLane(box ?? rectOf(to), to);
        aims.push({ key, item: item.id, source: item.sourceCardId, to, at, aimed: aimBetween(own, at) });
      }
    }
    const box = aims.length === 0 ? null : overlayBox();
    // The top of the stack resolves next: its arrows breathe.
    const next = items[0]?.id;
    const seen = new Set<string>();
    for (const { key, item, source, to, at, aimed } of aims) {
      seen.add(key);
      let svg = root.querySelector<SVGSVGElement>(`.placed__arrow[data-key="${key}"]`);
      if (svg === null) {
        svg = newArrow({ className: 'placed__arrow', testid: 'placed-arrow' });
        svg.setAttribute('data-for', String(item));
        svg.setAttribute('data-key', key);
        root.append(svg);
      }
      breathe(svg, item === next);
      // It bows to the side whose head points nearer its target's middle (`bendToward`).
      positionArrow(svg, aimed.from, aimed.tip, box!, at);
      landArrow(root, svg, to, source);
    }
    for (const el of [...root.querySelectorAll('.placed__arrow')]) {
      if (!seen.has(el.getAttribute('data-key') ?? '')) removeArrow(el);
    }
    retireCommitted(root, aims.map((a) => a.to));
  }

  /**
   * The stack item `item` targets. The wire pairs only items still on the stack, so once a countered
   * spell has gone to its graveyard the counter still resolving names nothing: it keeps the target
   * it was drawn with.
   */
  function aimOf(item: StackEntry): number | null {
    return item.targetStackItemId ?? drawn.get(item.id)?.targetStackItemId ?? null;
  }

  function render(): void {
    const root = overlay();
    const view = lastView;
    if (root === null || view === null) {
      for (const id of [...drawn.keys()]) removeNow(id);
      return;
    }
    noteClickable(view);
    promote(view.stack);
    // The overlay's box, and a spell at a hand card's size and an ability's chip squared off a battlefield
    // card's (`card-size.ts`, the one source): read once per paint, and only once something is drawn at
    // them — any box read lays out whatever the commit changed, and most commits have no stack at all.
    let sizes: { overlayBox: DOMRect; cardWidth: number | null; spellWidth: number | null } | null = null;
    const measure = (): { overlayBox: DOMRect; cardWidth: number | null; spellWidth: number | null } =>
      (sizes ??= {
        overlayBox: root.getBoundingClientRect(),
        cardWidth: battlefieldCardWidth(canvas, 'you') ?? battlefieldCardWidth(canvas, 'them'),
        spellWidth: handCardWidth(canvas),
      });
    // The triggers still waiting to go on the stack are chips already, after everything on it.
    const items = [...view.stack, ...(view.pendingTriggers ?? [])];
    const currentIds = new Set(items.map((i) => i.id));
    handOver(view.stack, currentIds);

    // Resolved/left items first, so a leaving one never takes room below.
    const departed = [...drawn].filter(([id]) => !currentIds.has(id));
    const departedIds = new Set(departed.map(([id]) => id));
    const counteredIds = view.counteredStackItems;
    // The wire's own word, captured onto the record once: later callbacks (`awaitCounter`'s timeout,
    // `counter`'s schedules) read `d.countered`, never a view that may have moved on by then.
    if (counteredIds !== undefined) for (const [id, d] of departed) if (counteredIds.has(id)) d.countered = true;
    // A paired counter first, when the wire confirms it: its target must not start a fade of its own.
    for (const [id, d] of departed) {
      const target = d.targetStackItemId;
      const candidate = target === null || d.leaving || !departedIds.has(target) ? undefined : drawn.get(target);
      if (candidate === undefined || candidate.leaving || !candidate.countered) continue;
      if (!candidate.isAbility && candidate.sourceCardId !== null && onBattlefieldNow(candidate.sourceCardId)) continue;
      counter(id, target!);
    }
    for (const [id, d] of departed) {
      if (d.leaving) continue;
      const landed = !d.isAbility && d.sourceCardId !== null && onBattlefieldNow(d.sourceCardId);
      if (!landed && view.stack.some((i) => aimOf(i) === id)) {
        awaitCounter(id, d);
        continue;
      }
      if (d.countered) crackAndFade(id, d);
      else leave(id, d.isAbility ? null : d.sourceCardId);
    }
    settleArrivals();
    for (const [id, sourceCardId] of undrawn) {
      if (currentIds.has(id)) continue;
      undrawn.delete(id);
      // AE27: one Stifle (or similar) ever drawn nothing for this ability — a shimmer would say
      // "resolved unhindered", which a countered id never did.
      if (counteredIds?.has(id) === true) continue;
      shimmer(sourceCardId);
    }

    // Every item's element and size first, then every box read, then every place written: a layout per pass, never one per chip.
    const shown: Shown[] = [];
    const flowing = chainHalted === false && haltsDrawn === haltsTold;
    haltsDrawn = haltsTold;
    items.forEach((item, index) => {
      // An ability aimed at a spell on the stack is drawn all the same: its counter is the beat to see (ward's trigger).
      const aimed = aimOf(item);
      if (item.isAbility && !drawn.has(item.id) && flowing && !(aimed !== null && drawn.has(aimed))) {
        // A waiting trigger nobody stopped for shimmers once, as the stack item it becomes.
        if (item.pending !== true) undrawn.set(item.id, item.sourceCardId);
        return;
      }
      undrawn.delete(item.id);
      const { cardWidth, spellWidth } = measure();
      const record = placements.get(item.id);
      const d = ensureElement(item, record);
      sizeAsCard(d.el, d.isAbility ? cardWidth : spellWidth);
      d.targetStackItemId = aimOf(item);
      const held = item.isAbility ? null : heldUntil(item.sourceCardId);
      // Held: looked at again when the hold runs out (`placeSpell`/`releaseSpell` repaint sooner).
      if (held !== null && d.holdCheckAt !== held) {
        d.holdCheckAt = held;
        schedule(render, held - Date.now() + 1);
      }
      if (d.pendingUntil !== null && (record !== undefined || Date.now() >= d.pendingUntil)) d.pendingUntil = null;
      // A chip waits, hidden, for its art and for its own size (`squareChips`, measured while hidden): the spot it
      // is first shown at is chosen for the size it keeps, so it never grows over a card once seen.
      const chipWait =
        d.isAbility && d.shownAt === null && Date.now() < d.drawnAt + CHIP_ART_WAIT_MS && (!chipReady(item) || (cardWidth !== null && d.squaredFor === null));
      if (chipWait && d.holdCheckAt !== d.drawnAt + CHIP_ART_WAIT_MS) {
        d.holdCheckAt = d.drawnAt + CHIP_ART_WAIT_MS;
        schedule(render, CHIP_ART_WAIT_MS - (Date.now() - d.drawnAt) + 1);
      }
      const pending = held !== null || d.pendingUntil !== null || chipWait;
      d.el.toggleAttribute('data-placed-pending', pending);
      if (!pending) d.shownAt ??= Date.now();
      if (d.leaving) return; // a resolved id Forge is reusing before the fade finished — rare, leave it be
      shown.push({ item, index, d, record });
    });
    if (shown.length > 0) place(shown, measure());

    drawArrows(view.stack, () => measure().overlayBox);
    pruneStale(view.stack);
  }

  /** Set while this paint draws an item still on its way to its point (`drawnPoint`); a frame is then due (`frameDue`). */
  let easing = false;
  let frameDue = false;

  /**
   * Look again once a dragged item's `DRAG_HOLD_MS` is up, so it comes to rest: ONE timer for the
   * board, never one per paint. A drag paints every pointer event (and, eased, every frame), and a
   * timer per paint each painting again while the item was still held piled up into dozens of paints
   * a frame on the other screen (w69-perf on main 8131301b5: 34 forced layouts a frame, 70 % of the
   * page dirtied). The one timer, when it fires, paints, and that paint arms it again if anything is
   * still held.
   */
  let holdCheckAt: number | null = null;
  function checkHoldsBy(ms: number): void {
    const due = Date.now() + ms;
    // One already due by then covers it; only an earlier hold's end arms another.
    if (holdCheckAt !== null && holdCheckAt <= due) return;
    holdCheckAt = due;
    schedule(() => {
      if (holdCheckAt === due) holdCheckAt = null;
      render();
    }, ms);
  }

  /** The last `settleStack` this board ran, by what it was asked: a repaint with the same asks reuses it. */
  let lastSettle: { key: string; result: ReturnType<typeof settleStack> } | null = null;
  /** Each drawn item's box as this paint settles it, for its arrows: never a box read mid-slide. */
  const settledBoxes = new Map<number, Rect>();

  /**
   * What the stack never covers: the match's control box (cut 2 of the trailer: a Valakut trigger sat over
   * End Turn). It is the board's sibling, in the match's own root, not inside the board.
   */
  function controlBoxes(): Rect[] {
    const scope = canvas.closest('.live') ?? canvas;
    return [...scope.querySelectorAll(CONTROL_BOX)].map(rectOf).filter((r) => r.right > r.left && r.bottom > r.top);
  }

  /** Note what either player can click now into this turn's set (`clickable`), and tell the viewer's own when it changes. */
  function noteClickable(view: BoardView): void {
    if (view.turn !== clickable.turn) {
      clickable.turn = view.turn;
      clickable.ids.clear();
    }
    const own = interaction === undefined ? [] : view.players.flatMap((p) => p.battlefield.filter((c) => interaction!.isSelectable(c.id)).map((c) => c.id));
    for (const id of own) clickable.ids.add(id);
    for (const cards of peerClickable.values()) for (const id of cards) clickable.ids.add(id);
    const key = own.join(',');
    if (key === clickable.own) return;
    clickable.own = key;
    for (const listener of ownClickableListeners) listener(own);
  }

  /** The boxes of this turn's clickable cards still on a battlefield. */
  function clickableBoxes(): Rect[] {
    return [...clickable.ids].flatMap((id) => {
      const el = battlefieldCard(canvas, id);
      if (el === null) return [];
      const r = rectOf(el);
      return r.right > r.left && r.bottom > r.top ? [r] : [];
    });
  }

  /** Where the stack may stand: across the board, from the top of their battlefield to the foot of this seat's. */
  function tableBounds(overlayBox: DOMRect): Rect {
    const them = zoneOf(canvas, 'them', 'battlefield')?.getBoundingClientRect();
    const you = zoneOf(canvas, 'you', 'battlefield')?.getBoundingClientRect();
    const top = them !== undefined && them.height > 0 ? them.top : overlayBox.top;
    const bottom = you !== undefined && you.height > 0 ? you.bottom : overlayBox.bottom;
    return { left: overlayBox.left, right: overlayBox.right, top, bottom: bottom > top ? bottom : overlayBox.bottom };
  }

  /** Square the chips, read every box the places come from, settle the stack's room, then write each item's place. */
  function place(shown: readonly Shown[], { overlayBox, cardWidth }: { overlayBox: DOMRect; cardWidth: number | null }): void {
    const sized = squareChips(
      shown.filter((s) => s.d.isAbility).map((s) => s.d),
      cardWidth,
      overlayBox,
    );
    const chips = shown.map(({ item, d }) => chipBoxesOf(item, d));
    const spot = chips.some((chip, n) => chip === null && !placements.has(shown[n]!.item.id)) ? defaultSpot(canvas) : null;
    const now = Date.now();
    const wants = shown.map(({ item, d, record }, n) => {
      const at = positionOf(item, d, chips[n]!, spot, overlayBox);
      const held = record?.movedAt != null && now - record.movedAt < DRAG_HOLD_MS;
      if (held) checkHoldsBy(record!.movedAt! + DRAG_HOLD_MS - now + 1);
      // A card's own size: hidden ones (pending) and ones not laid out yet take no room.
      const size = { width: d.el.offsetWidth, height: d.el.offsetHeight };
      const settles = at !== null && size.width > 0 && !d.el.hasAttribute('data-placed-pending');
      // A chip nobody put anywhere keeps clear of what the viewer can click; anything a player placed stays where they put it.
      const yields = d.isAbility && !placements.has(item.id);
      return at === null ? null : { at, held, settles, size, seed: d.seed, yields };
    });
    const bounds = tableBounds(overlayBox);
    const keepOut = wants.some((w) => w?.settles === true) ? controlBoxes() : [];
    const avoid = wants.some((w) => w?.settles === true && w.yields) ? clickableBoxes() : [];
    for (const w of wants) if (w !== null && w.settles) w.at = clearOfClickable({ want: w.at, ...w.size, seed: w.seed, yields: w.yields }, bounds, keepOut, avoid);
    // Top first, as `settleStack` reads it: a trigger still waiting to go on the stack is newer than anything on it.
    const settling = wants.flatMap((w, n) => (w !== null && w.settles ? [n] : [])).sort((a, b) => Number(shown[b]!.item.pending === true) - Number(shown[a]!.item.pending === true) || a - b);
    const asks: StackAsk[] = settling.map((n) => ({ want: wants[n]!.at, ...wants[n]!.size, seed: wants[n]!.seed, pinned: wants[n]!.held, yields: wants[n]!.yields }));
    const key = JSON.stringify([asks, bounds, keepOut, avoid]);
    if (lastSettle?.key !== key) lastSettle = { key, result: settleStack(asks, bounds, keepOut, avoid) };
    const settled = lastSettle.result;
    const settledAt = new Map(settling.map((n, k) => [n, settled[k]!]));
    settledBoxes.clear();
    let again = sized;
    shown.forEach(({ item, index, d, record }, n) => {
      const want = wants[n];
      if (want === null || want === undefined) return;
      const room = settledAt.get(n) ?? want.at;
      // A chip never travels over a card the viewer can click: where its slide to its room would, it is drawn there at once.
      const from = d.placedOnce ? d.point : want.at;
      const jumps = want.yields && avoid.length > 0 && from !== null && slideCrosses(from, room, want.size.width, want.size.height, avoid);
      // First shown where it was let go — the hand-over's own point — then it slides to its room.
      const at = d.placedOnce || jumps ? room : want.at;
      // Hidden, or shown for the first time: drawn in place, never slid in from where it waited unseen.
      const inPlace = want.held || !d.placedOnce || jumps;
      if (!d.placedOnce && !d.el.hasAttribute('data-placed-pending')) {
        d.placedOnce = true;
        if (room.x !== at.x || room.y !== at.y) again = true;
      }
      d.point = at;
      const p = overlayPoint(at, overlayBox);
      d.el.toggleAttribute('data-placed-held', inPlace);
      placeAt(d.el, p);
      const w = want.size.width / 2;
      const h = want.size.height / 2;
      if (want.size.width > 0) settledBoxes.set(item.id, { left: at.x - w, right: at.x + w, top: at.y - h, bottom: at.y + h });
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
      d.el.toggleAttribute('data-placed-still', index >= STACK_HOVER_MAX);
      if (index === 0 && item.pending !== true) d.el.setAttribute('data-placed-next', '');
      else d.el.removeAttribute('data-placed-next');
      d.current = item.current === true;
      d.el.toggleAttribute('data-placed-waiting', item.pending === true);
      d.el.toggleAttribute('data-placed-current', d.current);
    });
    // The slide starts from the drawn spot, and a chip just given its size is shown: the next frame, once this one has painted.
    // Hands on an item still easing draw again too, one frame at a time.
    if ((again || easing) && !frameDue) {
      frameDue = true;
      requestAnimationFrame(() => {
        frameDue = false;
        if (live) render();
      });
    }
    easing = false;
  }

  const hook = (): void => render();
  repaintHooks.add(hook);
  resized?.observe(canvas);
  const unsubscribeWidths = onCardWidthsChanged(hook);

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
      unsubscribeWidths();
      resized?.disconnect();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const id of [...drawn.keys()]) removeNow(id);
      undrawn.clear();
    },
  };
}
