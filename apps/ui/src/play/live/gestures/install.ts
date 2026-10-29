/*
 * The gesture state machine, and the one entry point.
 *
 * Framework-free: `installGestures` takes lane C's canvas element, attaches
 * `pointerdown` to it by DELEGATION and the move/release pair to `window`, and
 * creates its own DOM inside lane A's overlay root. It renders nothing through
 * React and holds no React state, which is what lets the same code answer a
 * drag, a box-draw and a bare hover without a re-render between them.
 *
 * ## window, not pointer capture
 *
 * The move and the release are listened for on `window` with no pointer
 * capture, so the event's own target is the element UNDER the pointer: jsdom
 * has no `elementFromPoint`, and a captured pointer would report the source
 * anyway. Read through `eventTarget` (`../../../dom.ts`), never `event.target`:
 * embedded in a watchparty room the board is in a shadow root, and `window`
 * sees every event in it retargeted to the shadow host. The e2e arrow spec cancels a drag by dispatching `pointercancel` on
 * `window`, which is the same seam from the other side.
 *
 * ## Which gesture a press starts
 *
 * In this order, and the order is the whole of the disambiguation:
 *
 *  1. **on a card Forge offered** → a DRAG from that card. This is also how
 *     an attacker is declared by dragging it forward, which
 *     `../combat-drag.jvm.test.ts` proves against a real Forge, so it stays
 *     first.
 *  2. **elsewhere on the table while this seat is declaring attackers** → a
 *     box-draw. Nothing else claims that press: a selection is not open
 *     during `InputAttack`, so the pointing gesture below cannot fire.
 *     **Or while Forge takes a click on this seat's lands** (`landsOffered`:
 *     at priority or under a payment, no question open) → the same box, and
 *     the lands it touches are tapped or untapped — see "A box taps lands".
 *  3. **elsewhere on the table while a selection is open** → the source-less
 *     pointing gesture: the spell doing the targeting is not itself one of
 *     Forge's choices, so there is often no offered card to drag FROM.
 *
 * A press that never passes `DRAG_SLOP_PX` is a plain click and this layer
 * stays out of it — no click is suppressed. What a claimed press DOES refuse,
 * from the press itself, is the browser's default: a drag on the table may
 * not highlight the words it crosses (`claim`).
 *
 * ## A box taps lands
 *
 * The operator, 2026-10-06: *"can we make it so i can draw boxes to tap
 * things? drawing boxes to attack seems to work, so why not lands?"* The box
 * is the one attackers use. What differs is the send: `InputAttack` takes
 * every attacker's click at once, but a land's tap is a whole action in
 * Forge's priority loop (it re-offers the board after each one, and a click on
 * a land before that offer is not a click on an offer — `selectCard` refuses
 * it). So the lands a box touched are QUEUED and sent one at a time: the next
 * goes out when the board shows the one before it tapped and Forge offers the
 * next (`pumpTaps`, on every notify). The sweep ends early, with nothing more
 * sent, if Forge opens a selection or asks anything that is not about the land
 * in flight, and in any case after `TAP_SWEEP_MS` without progress.
 *
 * The SEND stays one at a time — Forge's own loop above is
 * unchanged — but the DRAWN state no longer waits on it. Every boxed land
 * gets `./commit.ts`'s `data-tapped-pending` at the release, all of them at
 * once (`card.css`'s tapped selector draws it the same as a real
 * `data-tapped`); `pumpTaps` drops the mark off a land the moment its real
 * `Tapped` arrives, and `endTapSweep` drops it off whatever the sweep never
 * reached.
 *
 * ### and untaps them
 *
 * The operator, 2026-10-21: *"i should also be able to draw a box to untap
 * multiple lands. after all my lands are tapped i dont seem to be able to draw
 * a box anymore"*. A click on a land tapped for mana that still floats untaps
 * it — Forge offers that land, and undoes its one activation on the click
 * (`InputPassPriority.onCardSelected` → `PlayerControllerHuman.tryUndo`). The
 * box sends that same click: the sweep above runs either way, `tapTo` saying
 * which state each land is waiting for, and the mark is
 * `data-untapped-pending`. Which way a box goes is `./commit.ts`'s
 * `boxToggle`: any land still to tap in it → it taps those; only tapped ones
 * → it untaps them.
 *
 * ## Nothing here decides legality
 *
 * Every send goes through `./commit.ts` into `../match.ts`'s `selectCard` /
 * `selectPlayer`, which re-check Forge's CURRENT offer. A gesture can pick the
 * wrong thing; it cannot put an id on the wire that Forge did not name.
 *
 * ## Casting a hand card: click and drag are one interaction, and nothing
 * reaches Forge until the release
 *
 * A press on a card Forge offered already starts the drag above — that part
 * is unchanged. What is different for a card sitting in the VIEWER's own hand
 * right now (never a battlefield permanent — a land offered for its mana
 * ability is a battlefield card, and this is false for it) is that the drag
 * is tagged `lifted: true` from the press itself, before the slop, so a PLAIN
 * CLICK lifts it exactly as a drag does. `onPointerMove` draws the lifted
 * card following the pointer (`drawCastLift`) and two cues: the viewer's own
 * battlefield lights up for a card that needs no target, and the hand shows a
 * cancel cue under the pointer. No text is drawn. No arrow yet: nothing
 * has been aimed at anything, because nothing has been sent.
 *
 * ### A card Forge offers from the graveyard or exile is lifted the same way
 *
 * The operator, 2026-10-11, on Cabal Therapy: *"it should be possible to
 * pick up cards from the graveyard if they have flashback. so i should be
 * able to drag them and play them like a spell, not have a target arrow
 * drawn. the target arrow should come after the spell is played."* A card
 * Forge offers at priority from the viewer's own graveyard or exile
 * (`./cast.ts`'s `castZoneOf`: flashback, unearth, escape, foretell…) is
 * lifted from the press exactly as a hand card is, on the board's pile or in
 * its opened `PileView` (which gives way to it), and everything below holds
 * for it with its own zone in the hand's place: a release back over that
 * zone sends nothing and the card goes home. So is the top card of the
 * viewer's library while the board draws it (Courser of Kruphix's land).
 *
 * ### Everything a lift decides happens at the release
 *
 * The card's CURRENT type line decides what a release means (`./cast.ts`'s
 * `needsTarget` — Instant, Sorcery, or an Aura subtype needs a target;
 * everything else does not), and nothing is sent before the release either
 * way. `resolveLift` below is the one place a lifted hand card's gesture
 * ends, however it ends:
 *
 *  - over the viewer's own hand → the card floats back; nothing is sent,
 *    whatever the card is (nothing was ever sent to undo);
 *  - no target needed, over the viewer's own battlefield → `selectCard`
 *    (the play), one call telling `Board` where it landed, at the slot under
 *    the release point, and the card PARKS at that point exactly as a
 *    targeted cast does — see "A played card waits where it was let go";
 *  - no target needed, anywhere else → the card floats back; nothing is
 *    sent;
 *  - a target is needed, anywhere outside the hand → `selectCard` (the cast)
 *    goes out now, the card is pinned at the release point (`drawCastLift`
 *    with `'parked'`), and this module's `parked` holds that fact until
 *    Forge's reply resolves it. While Forge asks for the target, the card is
 *    in no zone the board draws, so React unmounts its element: a stand-in
 *    copied at the release (`parkedGhost`) is drawn at the park point
 *    instead, and the click-targeting arrow (`paint()`'s fallback branch)
 *    leaves from `parked` itself rather than from a DOM lookup, so a target
 *    ask is answered like any other click-cast.
 *
 * ### A played card waits where it was let go
 *
 * The operator, on a shockland and on a creature: *"why isn't the land
 * hovering over the board while the question is being asked, and then after
 * the question is finished place the card on the board from the hover"*, and
 * *"i dont like the snap back to the hand"*. Until Forge has the card on the
 * battlefield it is still in the hand as far as the state goes — through a
 * shockland's "pay 2 life?", through a payment — or in no zone at all while
 * its spell is on the stack. Letting the lift go at the release therefore
 * dropped it back into the hand for exactly that long. So a played card is
 * `parked` too (`played: true`), and it ends one of three ways:
 *
 *  - Forge has it on a battlefield → it lands in its row: at once in Fast
 *    Mode, travelling from the park point otherwise (`./cast.ts`'s
 *    `landCastGhost`);
 *  - it is back in the hand after having left it, or somewhere else the board
 *    draws (a countered creature's graveyard) → the lift simply comes off;
 *  - Forge never took the play (`PARK_UNANSWERED_MS` with the card still in
 *    the hand and nothing open) → it floats back, the same as a cancel.
 *
 * While it waits, its own spell is not drawn on the caster's stack
 * (`Board.tsx`'s `carryCastOffStack`): the parked card IS that spell, for as
 * long as it is the only thing on the stack — the stack redesign (2026-10-06,
 * approved: https://claude.ai/artifact/BUeXnHbHkeqtxFccyHQSfd) draws a lone
 * spell as the card and the row only at two or more. The row takes it back
 * the moment something joins it — see `syncStackStandIn`.
 *
 * ### A click lifts; the next press is the release
 *
 * A plain click's `pointerup` (zero `moved`) does NOT resolve the gesture: it
 * flips `held` to `false` and nothing more. `onPointerMove` is a bare
 * `window` listener that never checks button state, so the card keeps
 * following the pointer and the cues keep updating exactly as a held drag
 * does. The NEXT press (`onPointerDown`'s very first checks) is the release,
 * at its own point — not wherever the first click happened to let go.
 *
 * A plain click's `pointerup` ALSO fires a native `click` right after it with
 * no intervening movement, and that click would otherwise reach the card's
 * own `onClick` in `Board.tsx` and send a premature `selectCard` before this
 * layer ever gets to decide anything — the `clicks` latch marks exactly the
 * presses this module has claimed, and the capturing `click` listener on
 * `canvas` swallows that one native click before React's own delegated
 * handler, attached to this same element, ever sees it. The same flag, left untouched,
 * also swallows the native click the resolving press leaves behind (see
 * `onPointerDown`): that press may land on something Forge offers for an
 * unrelated reason (a land offered for its mana ability, say), and the native
 * click reaching IT would be a second, accidental `selectCard`.
 *
 * ### Cancelling a lift or a cast in progress
 *
 * `cancelLive` is the one function a right-click or Escape calls. While a
 * cast is PARKED (Forge has been asked to cast it, and may or may not have
 * opened a target ask yet), a cancel sends Forge's own Cancel —
 * `pressButton(match, 'cancel')`, the SAME sender the control bar's own
 * Cancel button uses — but ONLY while Forge is actually asking about THIS
 * cast (`match.selectables !== null`, or a mana payment is open): a land, or
 * a spell that needed neither, is already done by the time its release
 * returns, Forge is back at priority, and its button 2 may well be bound to
 * something else entirely — pressing it regardless of what Forge is asking
 * would send that instead. Before any cast at all (the card is merely
 * LIFTED, held or click-armed), a cancel is silent: nothing was ever sent, so
 * there is nothing to undo — the card simply floats back.
 *
 * A PLAYED card (a permanent on its way to the battlefield) that Forge is not
 * asking about cannot be cancelled at all: the play is done, and floating the
 * card back to a hand it is about to leave would draw something untrue. Those
 * inputs are ignored until it lands.
 *
 * One more cancel beyond right-click and Escape: a left click that lands on
 * nothing Forge's open selection names, while a cast is parked, is the same
 * cancel rather than a resolving press — there is nothing left for it to
 * resolve, since the cast already went out at release. `onPointerDown`'s own
 * check for a press while `parked` is what answers that.
 *
 * ## Where a cast lands
 *
 * `selectCard` alone tells Forge WHAT to cast, never WHERE the player put it,
 * so a newly-arrived permanent used to append to the end of its type row
 * every time. `Board.tsx` exports `notePlayedTo(cardId, point)` for exactly
 * this gap, read across the lane boundary like every other cross-lane import
 * in this file, never written to. This module calls it exactly once, from
 * `resolveLift`, at the release that actually plays the card: by the time
 * that call happens the card has not reached Forge yet, so `Board`'s own
 * re-render once Forge's reply adds it to the battlefield is already the
 * right moment to apply the pending placement.
 */
import {
  boardInteraction,
  choosingMulligan,
  declaringAttackers,
  declaringCombat,
  landsOffered,
  payingMana,
  pickedOf,
  pressButton,
  selectCard,
  subscribe,
  type LiveAsk,
  type LiveMatch,
} from '../match.ts';
// Where a cast lands on the battlefield — a plain function, not a component,
// read across the lane boundary.
import { carryCastOffStack, endPlacement, notePlayedTo, placementAt, previewPlayedTo, type PlayEnd } from '../../Board.tsx';
// §S's seam: the park registers the point every stack item draws at
// (`placeSpell`); a drag of the viewer's own placed spell moves it
// (`moveSpell`), which is also what tells lane W to relay it; `onSpellDrawn`
// is the ghost's own handoff signal — see `syncParkedGhost`'s own note.
import { holdSpell, isPlaced, moveSpell, onSpellDrawn, placeSpell, placeStackItem, releaseSpell, stackBoxOf } from '../placed.ts';
import { spotOf } from '../presence.ts';
import { afterGlide, HOUSE_DURATIONS, prefersReducedMotion, writeDurations } from '../../motion.ts';
import { drawnCentreOf, reportHandover, type HandoverFacts } from '../handover-report.ts';
import type { GameEntityRef } from '@hadoku/forge-wire';
import { combatArrows, type AutoTargetArrow } from './auto-targets.ts';
import { RAMMING_ATTR } from '../ram.ts';
import { clearArrow, clearAutoTargetArrows, clearCommitted, commitArrowAt, drawArrow, drawAutoTargetArrows } from './arrow.ts';
import { CAST_LANDING_ATTR, expectedGapBox,
  CAST_LIFT_ATTR,
  castCardTypeLine,
  castLandingWeight,
  castZoneOf,
  clearAllCastLifts,
  clearCastLift,
  clearDropCues,
  drawCastLift,
  floatCastLiftHome,
  isHandCard,
  landCastGhost,
  needsTarget,
  overHome,
  overOwnBattlefield,
  parkedGhost,
  updateDropCues,
  type CastZone,
} from './cast.ts';
import { closePileView } from '../../PileView.tsx';
import { aimedTarget, attackWith, clearTapPending, commitDrag, commitMarquee, landsInBox, markTapPending, rectOf, type Rect } from './commit.ts';
import {
  clearHandIndicator,
  commitHandReorder,
  handCardPress,
  handOrderIds,
  holdLiftedSlot,
  releaseLiftedSlot,
  updateHandIndicator,
} from './hand.ts';
import { installMarks, markScanWanted } from './intent.ts';
import { clearMarquee, drawMarquee } from './marquee.ts';
import { MOVABLE_DIALOG } from '../movable.tsx';
import { guardTextSelection } from './text-press.ts';
import { commitStackTarget, stackAsk, stackItemBox, stackItemUnder } from './stack.ts';
import { playRole } from '../../../sound/index.ts';
import { centreOf } from '../../lift.ts';
import { viewerOf } from '../../adapter.ts';
import { cardBox, faceBox, overlayOf } from '../board-dom.ts';
import { boxOf, targetUnder } from './targets.ts';
import {
  clickLatch,
  pastSlop,
  type DragState,
  type DropTarget,
  type GestureHandle,
  type GestureOptions,
  type MarqueeState,
  type Point,
} from './types.ts';
import { eventTarget } from '../../../dom.ts';
import { timed } from '../work-meter.ts';
import './gestures.css';

/** Set on the canvas while this layer is installed, so `./gestures.css` can dress it. */
const CANVAS_ATTR = 'data-gesture-canvas';

/**
 * How long a parked card may sit with Forge showing no sign of the play — the
 * card still in the hand, no question, no payment — before it floats back. An
 * act is dropped when Forge was not at the input the click was meant for, and
 * a card pinned over the board for good is worse than one returned.
 */
export const PARK_UNANSWERED_MS = 4000;

/** How long a box's tap sweep may sit with no land tapping before the rest of it is dropped. */
const TAP_SWEEP_MS = 5000;

/**
 * A card sent at release and pinned at the point it was released: a targeted
 * cast being aimed, or (`played`) a permanent on its way to the battlefield.
 * `home` is where it floats back to on a cancel: the same point `drag.from`
 * held, the card's own centre at the moment it was first lifted.
 */
interface Parked {
  readonly source: number;
  at: Point;
  readonly home: Point;
  /** The card's stand-in at `at`, shown only while the board renders no element for the card itself. */
  readonly ghost: HTMLElement | null;
  /** The viewer's zone the card was lifted out of: the hand, or a graveyard or exile Forge cast it from. */
  readonly zone: CastZone;
  /** Forge's state has shown the card out of `zone` since the cast went out. */
  leftZone: boolean;
  /** A permanent played to the viewer's own battlefield rather than a cast being aimed. */
  readonly played: boolean;
  /** The stack has taken this card's spell back (`syncStackStandIn`). Never returns to false. */
  onStack: boolean;
  /** §S: `live/placed.ts` has drawn the real stack item in the ghost's place — see `syncParkedGhost`'s own note. Never returns to false. */
  ghostHandedOff: boolean;
  /** Telemetry (`../handover-report.ts`): `Date.now()` of the release, of the stand-in's glide into its gap, of the stack card's draw. */
  readonly releasedAt: number;
  glideStartedAt: number | null;
  stackFrameAt: number | null;
  /**
   * The stand-in is still gliding into its gap: its stack card is held hidden (`holdSpell`) and the
   * hand-over waits for the glide to end (`endGlide`) — taken mid-glide, the stack card stood 2–4 px
   * from where the stand-in was drawn (w67-shaman's caster telemetry).
   */
  gliding: boolean;
  /** The stack item drawn (hidden) while it glided, handed over when the glide ends. */
  drawnMidGlide: number | null;
}

/**
 * How a park ended, for its `park` client event: it `landed` in its row; the lift came off because
 * Forge `settled` it (resolved, or back home after leaving), put it somewhere `elsewhere` than a
 * battlefield, or `offered` it as an answer to a new decision; it `floated-unanswered` home after
 * the clock ran out on silence; a `cancel`; a `next-play` taking over; the layer `disposed`.
 */
/** Which input cancelled a live gesture — reported with a parked cast's `cancel`. */
type CancelInput = 'right-click' | 'stray-click' | 'pointercancel' | 'escape';

/** What a press landed on, for a cancel's report: the nearest card, face or testid, else the tag. */
function describeNode(node: EventTarget | null): string {
  if (!(node instanceof Element)) return '-';
  const card = node.closest('[data-board-card]');
  if (card !== null) return `card:${card.getAttribute('data-board-card') ?? ''}`;
  const face = node.closest('[data-player-face]');
  if (face !== null) return `face:${face.getAttribute('data-player-id') ?? ''}`;
  const tagged = node.closest('[data-testid]');
  if (tagged !== null) return `testid:${tagged.getAttribute('data-testid') ?? ''}`;
  return `${node.tagName.toLowerCase()}.${node.getAttribute('class') ?? ''}`;
}

type ParkEnd = Extract<PlayEnd, 'landed' | 'settled' | 'elsewhere' | 'offered' | 'floated-unanswered' | 'cancel' | 'next-play' | 'disposed'>;

/** Where Forge's state holds the card now: still in the zone it was lifted out of, another zone the board draws, or nowhere it draws (mid-cast). */
function whereIs(match: LiveMatch, id: number, home: CastZone): 'home' | 'drawn' | 'limbo' {
  if (castZoneOf(match, id) === home) return 'home';
  for (const p of match.view?.players ?? []) {
    for (const zone of [p.battlefield, p.graveyard, p.exile]) {
      if (zone.some((c) => c.id === id)) return 'drawn';
    }
  }
  return 'limbo';
}

/** Forge has a decision open for this seat: a question, a selection, or a payment. */
function decisionOpen(match: LiveMatch): boolean {
  return match.asks.length > 0 || match.selectables !== null || payingMana(match);
}

/** The open ask offers the card `id` itself as one of its answers. */
function askOffers(ask: LiveAsk, id: number): boolean {
  if (ask.method === 'getChoices') return ask.choices.some((c) => c.ref?.kind === 'card' && c.ref.id === id);
  if (ask.method === 'chooseSingleEntityForEffect' || ask.method === 'chooseEntitiesForEffect') return ask.optionList.some((r) => r.kind === 'card' && r.id === id);
  return false;
}

/** The open decision — a selection or a question — offers the card `id` as something to choose. */
function offersCard(match: LiveMatch, id: number): boolean {
  return match.selectables?.cards.has(id) === true || match.asks.some((ask) => askOffers(ask, id));
}

/** Forge's state has the card on a battlefield — the one zone that draws an element per card for it to land on. */
function onBattlefield(match: LiveMatch, id: number): boolean {
  return (match.view?.players ?? []).some((p) => p.battlefield.some((c) => c.id === id));
}

/**
 * Lasting block arrows: blocker → attacker for every assignment in
 * `view.combat`, on both screens — the defender's while it assigns, and the
 * attacker's watching it. Read off `CombatBand.plannedBlockers`, Forge's live
 * `combat.getBlockers(band)` in every frame (`GameView.java:216-235`), so an
 * assignment appears and goes as `InputBlock` makes and undoes it and stays
 * once the blocks are declared. One mechanism with `combatArrows`
 * (`auto-targets.ts`): feeds the same `drawAutoTargetArrows` reconciler this
 * module already calls once per paint, not a second drawer. A band with
 * several attackers (banding) draws every blocker to the band's first
 * attacker — Forge gives the whole band one shared assignment, so there is no
 * second one to point at. A block goes with the ram of either creature in it
 * (`rammed`), as the attack arrow does.
 */
function blockArrows(canvas: ParentNode, match: LiveMatch, rammed: ReadonlySet<number>): AutoTargetArrow[] {
  const out: AutoTargetArrow[] = [];
  for (const band of match.view?.combat ?? []) {
    const blockerIds = band.plannedBlockers ?? [];
    if (blockerIds.length === 0) continue;
    const attackerId = band.attackers[0];
    if (attackerId === undefined || rammed.has(attackerId)) continue;
    const to = cardBox(canvas, attackerId);
    if (to === null) continue;
    for (const blockerId of blockerIds) {
      if (rammed.has(blockerId)) continue;
      const source = cardBox(canvas, blockerId);
      if (source === null) continue;
      out.push({ key: `block:${blockerId}:${attackerId}`, from: centreOf(source), to, kind: 'card', role: 'block' });
    }
  }
  return out;
}

export function installGestures(options: GestureOptions): GestureHandle {
  const { canvas, match } = options;
  writeDurations(canvas, HOUSE_DURATIONS);
  const reduced = (): boolean => options.reducedMotion?.() ?? prefersReducedMotion();
  const marks = installMarks(canvas, { scan: options.markScan ?? markScanWanted() });
  let drag: DragState | null = null;
  let marquee: MarqueeState | null = null;
  /**
   * A box's attackers held for the defender click — `./commit.ts`'s
   * `commitMarquee` returned them instead of sending, because Forge offers more
   * than one defender. An arrow leaves the group and follows the pointer
   * (`at`, over `node`); the next press on a defender sends the group against it
   * (`attackWith`), and any other press, a right-click or Escape drops it with
   * nothing sent. It also drops the moment Forge's declare window is gone
   * (`dropStaleAim`), so it never outlives the input it was for.
   */
  let aim: { ids: number[]; at: Point; node: EventTarget | null } | null = null;
  /** The right-click in progress cancelled a live gesture: its `contextmenu` is the gesture's. */
  let cancelledByRightClick = false;
  /** Where the pointer is while NO gesture is held — the click-targeting arrow's tip. */
  let hover: { at: Point; node: EventTarget | null } | null = null;
  /** What was drawn last, so `onChange` fires on a change and not on every move. */
  let shape = '';
  /**
   * The creatures whose ram has set off in the combat on the board (`../ram.ts` marks a creature's own
   * element `[data-ramming]` as its copy leaves): their attack and block arrows are spent (the operator,
   * 2026-10-22: "can we have arrows disappear once the attack animations actually start?"). Kept until
   * the combat ends, so an arrow does not come back once its creature is home again.
   */
  const rammed = new Set<number>();
  let live = true;
  /** A targeted cast already sent, pinned, waiting on Forge — see the module header. Null: no cast in flight. */
  let parked: Parked | null = null;
  /** Running from a park until Forge shows any sign of it — `PARK_UNANSWERED_MS`. */
  let unansweredTimer: ReturnType<typeof setTimeout> | null = null;
  /** The parked stand-in's glide into its gap, ending when it comes to rest (`afterGlide`) — see `Parked.gliding`; cancels it. */
  let stopGlide: (() => void) | null = null;
  /*
   * The placement preview, once per frame. `previewPlayedTo` measures every
   * slot and pile of the viewer's battlefield and then moves the indicator,
   * so run on every pointermove it forces a layout per move and the lifted
   * card stalls the moment it crosses onto the battlefield (the operator,
   * 2026-10-07: "smoother from hand all the way to battlefield boundary, but
   * once i cross over the boundary it seems to get stuck"). The latest point
   * wins; a `null` (the lift ended) is applied at once and drops the frame.
   */
  let previewFrame = 0;
  let previewPoint: Point | null = null;
  /** A landing waiting for Board's placement commit — see `settleParkedIfResolved`. */
  let landingFrame = 0;
  function previewAt(point: Point | null): void {
    previewPoint = point;
    if (point === null) {
      if (previewFrame !== 0) cancelAnimationFrame(previewFrame);
      previewFrame = 0;
      previewPlayedTo(null);
      return;
    }
    if (previewFrame !== 0) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      previewPlayedTo(previewPoint);
    });
  }
  /**
   * The hand's own reorder preview, once per frame — the same reason, and
   * the same shape, as `previewAt` just above: `updateHandIndicator` forces
   * a layout per call (it measures the hand's own siblings and the board),
   * so calling it on every pointermove (and at the press itself, before the
   * lift has even painted) cost the same stall `previewAt` already exists to
   * avoid. `null` clears the indicator at once and drops any pending frame;
   * a point schedules the next frame if one is not already pending, the
   * latest point winning.
   */
  let handIndicatorFrame = 0;
  let handIndicatorArgs: { cardId: number; point: Point } | null = null;
  function scheduleHandIndicator(args: { cardId: number; point: Point } | null): void {
    handIndicatorArgs = args;
    if (args === null) {
      if (handIndicatorFrame !== 0) cancelAnimationFrame(handIndicatorFrame);
      handIndicatorFrame = 0;
      clearHandIndicator();
      return;
    }
    if (handIndicatorFrame !== 0) return;
    handIndicatorFrame = requestAnimationFrame(() => {
      handIndicatorFrame = 0;
      if (handIndicatorArgs !== null) updateHandIndicator(canvas, handIndicatorArgs.cardId, handIndicatorArgs.point);
    });
  }
  /** The lands a box touched that are still to be clicked, in order — see "A box taps lands". */
  let tapQueue: number[] = [];
  /** The land whose click is out and not yet shown on the board. */
  let tapSent: number | null = null;
  /** The state the sweep's clicks put each land in: tapped (true) or untapped. */
  let tapTo = true;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed the moment a press is claimed — see the module header's own section — and reset at the top of every FRESH `pointerdown`. */
  const clicks = clickLatch();
  /**
   * Item 5: a press on the viewer's own placed spell (`live/placed.ts`'s
   * `[data-placed-spell][data-mine]`), picking it up to drag it somewhere
   * else — no cast, no target, a pure rearrange. A SEPARATE little gesture
   * from `drag`/`marquee` above (never set alongside either): Forge's own
   * stack-choice ask (`stackAsk`) still takes the press first, since the
   * same element answers that too (`data-stack-id`). `press` is where the
   * pointer went down, for the slop check; `moved` gates whether a release
   * commits anything at all — a press that never moved is a click (reserved
   * for the inspector's hover/long-press, not this gesture).
   */
  let placedDrag: { id: number; press: Point; moved: boolean } | null = null;
  /**
   * The hand-reorder gesture's one piece of state this module keeps for it
   * (`./hand.ts`'s own is all pure functions over the DOM): the card's
   * position in the hand at the press that started the current lift, read
   * once via `handOrderIds` before anything moves. `resolveLift` passes it to
   * `commitHandReorder` as `fromIndex`; null once there is no lift to resolve
   * it for.
   */
  let handPressIndex: number | null = null;


  /** On the table: a press there may start a board gesture. A dialog over it (`../movable.tsx`) is the dialog's to move. */
  const inside = (node: EventTarget | null): boolean =>
    node instanceof Element && (node.closest('.board') !== null || node.closest('[data-zone]') !== null) && node.closest(MOVABLE_DIALOG) === null;

  /**
   * The press began on a card `Board.tsx`'s own arrange gesture picks up
   * (`data-arrange-card`: the viewer's battlefield, never a hand card, never
   * one an open selection is waiting on). A press there starts no gesture of
   * ours, or one press would rearrange the battlefield AND send `selectCard`
   * for whatever it was released over.
   *
   * **Forge publishes no selection during declare-attackers or
   * declare-blockers, nor for a mana payment** — `../match.ts`'s
   * `declaringCombat` and `payingMana` carry the call sites — so in those
   * moments the viewer's own permanents stay arrangeable, and the guard yields
   * to both: the press claimed here (`claim`) is one `useArrangeDrag` skips.
   */
  const arrangeable = (node: EventTarget | null): boolean => {
    if (!(node instanceof Element)) return false;
    const found = node.closest('[data-arrange-card]');
    return found !== null && canvas.contains(found);
  };

  /**
   * The tail of the click-targeting arrow, or null when there is nothing to
   * draw from.
   *
   * A drag anchors its arrow to the card it was picked up from. A click has
   * no such anchor, so the tail is the card the question itself names
   * (`match.promptCard`), then the thing the player pointed at last
   * (`match.lastSelectedCard` — the card they clicked to cast or activate)
   * and, failing that, the top of the stack: a triggered ability that wants a
   * target was never clicked at all, and its source is what the arrow should
   * leave from. No origin, no arrow — a tail from nowhere is not guidance.
   *
   * A parked cast comes first and is answered from `parked` itself, never
   * from a DOM lookup alone: while Forge asks for its target the card is in
   * no zone the board draws, so its element is usually gone and only the
   * release point says where the arrow leaves from.
   *
   * **The stack item's OWN element, when the source card has none of its
   * own.** World Breaker's cast trigger ("when you cast this spell") needs
   * its target while World Breaker itself is still ON THE STACK — not yet on
   * any battlefield, not in any hand — so `cardBox` finds nothing for it
   * (`StackItem` in `../../Board.tsx` carries `data-stack-id`, never
   * `data-card-id`/`data-board-card`; its `CardTile` carries a DRAFT-namespaced
   * id `targets.ts`'s `boardId` already refuses). `stackItemBox` is the one
   * element that is always there for a stack-resident source, so it is the
   * fallback — never a fallback POINT.
   */
  function clickOrigin(): { at: Point; source: number | null; box: Element | null } | null {
    // A parked card is where the player let go of it, whether or not the
    // board still renders its element — EXCEPT once `live/placed.ts` has
    // taken over drawing its spell (§S: the moment a matching item appears
    // on `view.stack`, the ghost retires — `syncParkedGhost` below), when the
    // placed element itself is the thing asking, and the arrow leaves from
    // it (W17, "from the played card on the stack") at its OWN current
    // point — which may have moved, if the player dragged it (item 5).
    if (parked !== null) {
      // Never an ABILITY entry sharing this id — World Breaker's own cast
      // trigger (W17) names World Breaker as its `sourceCardId` too, before
      // World Breaker's own SPELL is itself a stack entry, and that trigger
      // draws at its own default spot (no source to stand beside), never at
      // the park point — this ghost's job precisely until a real SPELL
      // entry (never an ability) takes over.
      const onStack = (match.view?.stack ?? []).find((item) => !item.isAbility && item.sourceCardId === parked!.source);
      const stackBox = onStack === undefined ? null : stackItemBox(canvas, onStack.id);
      if (stackBox !== null) return { at: centreOf(stackBox), source: parked.source, box: stackBox };
      const box = cardBox(canvas, parked.source);
      return { at: box === null ? parked.at : centreOf(box), source: parked.source, box };
    }
    // The card Forge says the question is ABOUT, when it names one, before the
    // card this seat happened to click last: a selection an opponent's spell
    // opens here (Smallpox's "discard a card") is not about anything this seat
    // clicked, and the last click — a land played two turns ago — is still on
    // record until a selection of this seat's own closes. Found in a live game:
    // the arrow left from that land.
    const asked = match.promptCard;
    if (asked !== null) {
      const box = cardBox(canvas, asked);
      if (box !== null) return { at: centreOf(box), source: asked, box };
      const item = (match.view?.stack ?? []).find((i) => i.sourceCardId === asked);
      const stackBox = item === undefined ? null : stackItemBox(canvas, item.id);
      if (stackBox !== null) return { at: centreOf(stackBox), source: asked, box: stackBox };
    }
    const held = match.lastSelectedCard;
    if (held !== null) {
      const box = cardBox(canvas, held);
      if (box !== null) return { at: centreOf(box), source: originId(box), box };
    }
    for (const item of match.view?.stack ?? []) {
      if (item.sourceCardId === null) continue;
      const box = cardBox(canvas, item.sourceCardId);
      if (box !== null) return { at: centreOf(box), source: originId(box), box };
      const stackBox = stackItemBox(canvas, item.id);
      if (stackBox !== null) return { at: centreOf(stackBox), source: item.sourceCardId, box: stackBox };
    }
    return null;
  }

  /**
   * Whether the open selection is AIMING — choosing targets — so a click-targeting arrow means
   * something. Forge says so on the prompt (`match.promptSelection`): a cost's sacrifice or
   * discard, a "choose a creature", is a pick and draws no arrow. Found in a live game (the
   * operator, 2026-10-19, Bone Shards): its sacrifice, then asked after its target, drew the same
   * aiming arrow from the parked card as the target had, so the target looked unchosen. Only a prompt
   * that does not say falls back to `choosingOwnHand`.
   */
  function aiming(): boolean {
    const said = match.promptSelection;
    return said === null ? !choosingOwnHand() : said.targets;
  }

  /**
   * What the open selection's ability is already aimed at, drawn from the same tail the
   * click-targeting arrow leaves from, so every target chosen keeps its arrow while the next is aimed.
   *
   * During a target choice that is what Forge has marked: `InputSelectTargets` marks each target as
   * it is chosen and unmarks one taken back (`addTarget`/`removeTarget`) — the operator, 2026-10-21, on
   * Conflagrate: the first target's arrow snapped back to the pointer for the next. During a pick
   * that pays for the ability (a creature to tap, a card to exile, picked after the targets) it is
   * the prompt's own `match.promptSelection.aimed`.
   */
  function aimedArrows(): AutoTargetArrow[] {
    const said = match.promptSelection;
    const refs: readonly GameEntityRef[] =
      said !== null && !said.targets
        ? said.aimed
        : aiming() && match.selectables !== null
          ? [
              ...[...pickedOf(match)].map((id) => ({ kind: 'card' as const, id })),
              ...[...(match.highlightedPlayers ?? [])].map((id) => ({ kind: 'player' as const, id })),
            ]
          : [];
    if (refs.length === 0) return [];
    const origin = clickOrigin();
    if (origin === null) return [];
    const out: AutoTargetArrow[] = [];
    for (const ref of refs) {
      const to = ref.kind === 'card' ? cardBox(canvas, ref.id) : faceBox(canvas, ref.id);
      if (to === null) continue;
      out.push({ key: `aim:${ref.kind}:${ref.id}`, from: origin.at, to, kind: ref.kind, role: 'aim' });
    }
    return out;
  }

  /** Forge's selectables are all cards of the viewer's own hand, and no player: a pick, not a target. */
  function choosingOwnHand(): boolean {
    const sel = match.selectables;
    if (sel === null || sel.cards.size === 0) return false;
    if (sel.players !== null && sel.players.size > 0) return false;
    const hand = viewerOf(match.view)?.hand;
    if (hand === undefined || hand === null) return false;
    const inHand = new Set(hand.map((c) => c.id));
    for (const id of sel.cards) if (!inHand.has(id)) return false;
    return true;
  }

  /**
   * What is under `node` that a gesture from `source` may aim at. While a
   * question is up that Forge asked about the STACK (a counterspell's "select
   * target spell"), the stack items it names are the targets; otherwise it is
   * what the release would send as one (`./commit.ts`'s `aimedTarget`).
   */
  function targetAt(node: EventTarget | null, source: number | null): DropTarget | null {
    const asked = stackAsk(match);
    if (asked !== null) {
      const id = stackItemUnder(node, asked);
      return id === null ? null : { kind: 'stack', id };
    }
    return aimedTarget(match, source, node);
  }

  /**
   * A paint at the next frame, however many ask before it: Forge's frames, React's redraws and every
   * ram's start each asked for one, and each paint measures the board's cards — in combat, a layout of
   * the whole board several times a frame. A pointer's own paint stays immediate (`paint`).
   */
  let paintFrame = 0;
  function paintSoon(): void {
    if (paintFrame !== 0) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      if (live) paint();
    });
  }

  /** Draw whatever the current state means, into lane A's overlay. Absent overlay: nothing. */
  function paint(): void {
    timed('gestures', paintNow);
  }

  function paintNow(): void {
    const overlay = overlayOf(canvas);
    // Forge's own already-decided targets, measured before this paint writes anything: a box read after
    // a write lays the whole board out again, and in combat this runs on every frame Forge sends.
    if ((match.view?.combat ?? []).length === 0) rammed.clear();
    const lasting = overlay === null ? null : [...combatArrows(canvas, match, rammed), ...blockArrows(canvas, match, rammed), ...aimedArrows()];
    flag(CANVAS_ATTR, '');
    flag('data-dragging', drag !== null && drag.moved ? '' : null);
    flag('data-marquee', marquee !== null && marquee.moved ? '' : null);
    flag('data-aiming', aim !== null ? '' : null);
    applyMarks();

    let next = '';
    if (overlay === null) {
      // The arrow is guidance, not the gesture: with no overlay nothing is
      // drawn and every send below still happens.
    } else if (drag !== null && drag.lifted) {
      // Pre-release: the card follows the pointer (drawn directly from
      // `onPointerMove`/`onPointerDown`, not here) and there is no arrow —
      // nothing has been aimed at anything, because nothing has been sent
      // yet.
      clearArrow(overlay);
      clearMarquee(overlay);
      next = `lift:${drag.source ?? ''}`;
    } else if (drag !== null && drag.moved) {
      const snap = drag.target === null ? null : boxOf(canvas, drag.target);
      const tail = drag.source === null ? (clickOrigin()?.box ?? null) : cardBox(canvas, drag.source);
      drawArrow(overlay, { from: drag.from, to: drag.at, source: drag.source, target: drag.target, snap, tail, mode: 'drag' });
      clearMarquee(overlay);
      next = `drag:${drag.source ?? ''}:${drag.target === null ? '' : `${drag.target.kind}:${drag.target.id}`}`;
    } else if (marquee !== null && marquee.moved) {
      clearArrow(overlay);
      drawMarquee(overlay, rectOf(marquee.press, marquee.at));
      next = 'marquee';
    } else if (aim !== null) {
      // The same arrow a single attacker's drag draws, from the middle of the group.
      const target = aimedTarget(match, aim.ids[0]!, aim.node);
      const snap = target === null ? null : boxOf(canvas, target);
      drawArrow(overlay, { from: groupCentre(aim.ids, aim.at), to: aim.at, source: null, target, snap, tail: null, mode: 'drag' });
      clearMarquee(overlay);
      next = `aim:${aim.ids.join(',')}:${target === null ? '' : `${target.kind}:${target.id}`}`;
    } else {
      // This is also how a parked cast draws its arrow, see `clickOrigin`.
      // A choice among this seat's OWN HAND cards is not aiming — the cleanup
      // discard ("Select 1 card(s) to discard…"), a reveal, the London
      // mulligan's bottom pick: nothing is being pointed at anything, so no
      // arrow, whatever `clickOrigin` could have supplied as a tail (found in
      // a live game, the operator 2026-10-08: the discard drew an arrow from
      // the card clicked last). Targets are never in the chooser's own hand.
      const origin = hover !== null && aiming() && (match.selectables !== null || stackAsk(match) !== null) ? clickOrigin() : null;
      if (origin === null || hover === null) {
        clearArrow(overlay);
        clearMarquee(overlay);
      } else {
        const target = targetAt(hover.node, null);
        const snap = target === null ? null : boxOf(canvas, target);
        const source = origin.source;
        drawArrow(overlay, { from: origin.at, to: hover.at, source, target, snap, tail: origin.box, mode: 'click' });
        clearMarquee(overlay);
        next = `click:${source ?? ''}:${target === null ? '' : `${target.kind}:${target.id}`}`;
      }
    }
    // Forge's own already-decided targets. Independent of whichever gesture
    // (if any) is in progress above, so it is reconciled every paint
    // regardless of branch — a drag or a box-draw does not hide it.
    //
    // §S superseded, and wave 64/J6 deleted, the other two of `auto-targets.ts`'s
    // original four producers: a stack item's own target (`autoTargetArrows`)
    // and the counterspell arc (`stackTargetArrows`) are `live/placed.ts`'s own
    // `.placed__arrow`s now, drawn FROM the placed element — the old row's box —
    // so feeding them here too would draw every stack-item arrow twice. Only
    // the lasting attack arrow and the lasting block arrow — neither a
    // stack-item concern — stay on this reconciler.
    if (overlay !== null && lasting !== null) drawAutoTargetArrows(overlay, lasting);
    if (next === shape) return;
    shape = next;
    options.onChange?.();
  }

  /** Forge's attack intents, and the held group's own mark — on every paint, and again whenever React redraws a card. */
  function applyMarks(): void {
    marks.apply(match, aim?.ids ?? []);
  }

  /** The centre of the group's own cards, or `fallback` when none of them is drawn. */
  function groupCentre(ids: readonly number[], fallback: Point): Point {
    const centres = ids.flatMap((id) => {
      const box = cardBox(canvas, id);
      return box === null ? [] : [centreOf(box)];
    });
    if (centres.length === 0) return fallback;
    return { x: centres.reduce((n, c) => n + c.x, 0) / centres.length, y: centres.reduce((n, c) => n + c.y, 0) / centres.length };
  }

  /**
   * A held group whose window is gone is dropped: Forge left declare-attackers
   * (it moved on, the turn changed), or the offer emptied (a reconnect, a
   * question). Only the group's creatures Forge still offers stay in it.
   */
  function dropStaleAim(): void {
    if (aim === null) return;
    const offered = boardInteraction(match).selectable;
    const ids = aim.ids.filter((id) => offered.has(id));
    aim = declaringAttackers(match) && ids.length > 0 ? { ...aim, ids } : null;
  }

  /** Only a change is written: an attribute set to the value it has still invalidates the board's style. */
  function flag(name: string, value: string | null): void {
    if (canvas.getAttribute(name) === value) return;
    if (value === null) canvas.removeAttribute(name);
    else canvas.setAttribute(name, value);
  }

  /**
   * This layer has the press, so the browser's own idea of what a press means
   * must not run beside it — and the one that matters is TEXT SELECTION.
   * `./gestures.css` does write `user-select: none` on the canvas, but only
   * once `data-dragging` is set, which is after the press passes
   * `DRAG_SLOP_PX` — and the browser begins selecting on the press itself. So
   * the default is refused at the press, before there is anything to undo.
   *
   * **Only on a press this layer CLAIMED.** A press on an arrangeable card
   * returns above this without cancelling anything, because a cancelled
   * `pointerdown` is one `useArrangeDrag` leaves alone — it would take the
   * arrangement with it.
   *
   * Cancelling `pointerdown` suppresses the compatibility mouse events and
   * the selection; it does NOT suppress `click`, which is not one of them, so
   * a press that never passes the slop is still the plain click it always
   * was — the property `e2e/play.spec.ts` leans on for every card it plays by
   * clicking.
   */
  function claim(event: PointerEvent): void {
    if (event.cancelable) event.preventDefault();
  }

  /**
   * What a lifted card's RELEASE means — the one and only place a lifted
   * card's gesture reaches Forge. Called from `onPointerUp` (a held drag's
   * own release) and from `onPointerDown`'s resolving press (a click-armed
   * one) alike, always with that press's OWN point — never the point the
   * lift started from, and never a point an earlier frame remembered.
   */
  function resolveLift(state: DragState, point: Point, node: EventTarget | null): void {
    clearDropCues(canvas);
    if (state.source === null || state.lifted === null) return;
    const source = state.source;
    const zone = state.lifted;
    if (zone !== 'hand' && overHome(node, zone)) {
      // Back over the graveyard or exile it came from: nothing was sent, so nothing is.
      previewAt(null);
      floatCastLiftHome(canvas, source, state.from, () => {});
      return;
    }
    if (zone === 'hand' && overHome(node, zone)) {
      // Released back inside the hand — a reorder, never Forge. The ONE
      // line that changed here: this used to float the card back home
      // unconditionally; now a release inside the hand always means "commit
      // wherever it landed", a same-spot release included (a no-op commit,
      // `queueHandMove` skipped since nothing changed).
      previewAt(null);
      scheduleHandIndicator(null);
      const fromIndex = handPressIndex ?? handOrderIds(canvas).indexOf(source);
      handPressIndex = null;
      commitHandReorder(canvas, source, fromIndex, point);
      playRole('ui.place');
      return;
    }
    // Left its zone before release: `onPointerMove`'s own transition already cleared the
    // hand's indicator the moment the pointer crossed out of it.
    handPressIndex = null;
    const spell = needsTarget(castCardTypeLine(match, source));
    previewAt(null);
    if (!spell && !overOwnBattlefield(node)) {
      floatCastLiftHome(canvas, source, state.from, () => {});
      return;
    }
    // An earlier card still on its way is on its own from here: one park at a time.
    if (parked !== null) releaseParked(endPark('next-play')!, false);
    // The play, or the cast: it goes out now, and the card parks where it was
    // let go — a permanent over the viewer's own battlefield, a card that
    // needs a target wherever it was released outside the hand.
    const ghost = parkedGhost(canvas, source);
    // The column and the release point go WITH the act: the server tells every screen at once,
    // before any Forge frame about the card, and both screens draw the same glide into the gap.
    // `placement.at` is the lifted card's OWN box centre right now, not the raw release point:
    // the two can be a frame apart when no `pointermove` fires between the last drag update and
    // the release (the operator: "a bit of desync between where the phantom card was and
    // where the cursor actually released the card"). `cardBox` finds the exact element
    // `drawCastLift` has been positioning all along; hit-testing below still uses the real point.
    const column = spell ? null : placementAt(point);
    const liftedNow = cardBox(canvas, source);
    const liftedRect = liftedNow instanceof HTMLElement ? liftedNow.getBoundingClientRect() : null;
    const ghostAt = liftedRect !== null && liftedRect.width > 0 ? { x: liftedRect.left + liftedRect.width / 2, y: liftedRect.top + liftedRect.height / 2 } : point;
    const spot = column === null ? null : spotOf(canvas, ghostAt);
    const placement = column === null || spot === null ? undefined : { slot: column.slot, target: column.target, at: spot };
    if (!selectCard(match, source, placement)) {
      // Forge's offer moved on between the lift and the release: nothing went out.
      playRole('ui.deny');
      floatCastLiftHome(canvas, source, state.from, () => {});
      return;
    }
    playRole('ui.place');
    // §S's seam: wherever this cast ends up on Forge's stack, `live/placed.ts`
    // draws it at THIS point — the park — once a matching item appears
    // (`StackEntry.sourceCardId` keeps the same id this card had in hand).
    // Harmless for a card that never reaches the stack at all (a land): the
    // registration simply expires unmatched. A CLICK cast with no release of
    // its own (none of this module's gestures produce one, but a future
    // caller might) never calls this, which is exactly decision a's "default
    // spot" fallback in `live/placed.ts` — no special-casing needed here.
    placeSpell(source, point, 'you');
    if (!spell) {
      // The one placement call, at the release — the slot under the release point.
      notePlayedTo(source, point);
      carryCastOffStack(source);
    }
    // A played card is drawn by its stand-in from here on; a cast being aimed
    // is drawn by its own element for as long as the board has one.
    drawCastLift(canvas, source, point, !spell && ghost !== null ? 'carried' : 'parked');
    parked = { source, at: point, home: state.from, ghost, zone, leftZone: false, played: !spell, onStack: false, ghostHandedOff: false, releasedAt: Date.now(), glideStartedAt: null, stackFrameAt: null, gliding: false, drawnMidGlide: null };
    syncParkedGhost();
    // A played card's stand-in glides from the release point into the gap the row reserved for
    // it (`notePlayedTo` above) and waits THERE — the same motion the other screen draws for its
    // back — so the arrival is a swap in place, not a second move (the operator, 2026-10-08:
    // "it must look the same" from both sides). Measured a frame later: the board draws the gap first.
    if (!spell && ghost !== null) {
      const me = parked;
      landingFrame = requestAnimationFrame(() => {
        landingFrame = 0;
        if (parked !== me) return;
        const gap = expectedGapBox(canvas, 'you');
        if (gap === null) return;
        me.at = { x: gap.left + gap.width / 2, y: gap.top + gap.height / 2 };
        // A creature held on the stack first is drawn where its stand-in now waits, not back at
        // the release point (the Viridian Shaman recording, 2026-10-09). Only while the
        // registration is still the card's own: once promoted it is the stack item's.
        if (isPlaced(source)) placeSpell(source, me.at, 'you');
        ghost.style.left = `${me.at.x}px`;
        ghost.style.top = `${me.at.y}px`;
        me.glideStartedAt = Date.now();
        // Its stack card, if Forge puts it there meanwhile, waits for the glide to end (`endGlide`).
        if (!reduced() && !me.ghostHandedOff) {
          me.gliding = true;
          holdSpell(source);
          stopGlide = afterGlide(ghost, () => endGlide(me));
        }
      });
    }
    unansweredTimer = setTimeout(onParkUnanswered, PARK_UNANSWERED_MS);
    // The pointer is at the park point now; the arrow follows it from there
    // the moment Forge asks for the target, before the pointer next moves.
    hover = { at: point, node };
    paint();
  }

  function casterFacts(p: Parked, how: string, from: Point | null, to: Point | Element | null): HandoverFacts {
    return { screen: 'caster', card: p.source, how, from, to, glideStartedAt: p.glideStartedAt, releasedAt: p.releasedAt, stackFrameAt: p.stackFrameAt, motion: !reduced() };
  }

  /**
   * The parked stand-in has come to rest in its gap: its stack card is shown, and when Forge has
   * already put it there, the stand-in hands over to it in the same task — where the stand-in stands.
   */
  function endGlide(p: Parked): void {
    stopGlide = null;
    if (!p.gliding) return;
    p.gliding = false;
    releaseSpell(p.source);
    if (p.drawnMidGlide !== null && parked === p) handOverToStack(p, p.drawnMidGlide);
  }

  /**
   * `parked` is over, however it ended (`how`, reported as a `park` client event with how long it
   * waited and the question open at its end, if any): its clock stops and the stack draws
   * everything again.
   */
  function endPark(how: ParkEnd, cause: Record<string, string> = {}): Parked | null {
    const p = parked;
    parked = null;
    const me = viewerOf(match.view)?.id;
    if (p !== null && me !== undefined) endPlacement(me, p.source, how);
    if (p !== null) options.report?.('park', { how, card: p.source, ms: Date.now() - p.releasedAt, played: p.played, ask: match.asks[0]?.method ?? '-', selection: match.selectables !== null, paying: payingMana(match), ...cause });
    stopGlide?.();
    stopGlide = null;
    if (p !== null && p.gliding) {
      p.gliding = false;
      releaseSpell(p.source);
    }
    if (unansweredTimer !== null) clearTimeout(unansweredTimer);
    unansweredTimer = null;
    carryCastOffStack(null);
    return p;
  }

  /**
   * `PARK_UNANSWERED_MS` after a park: if Forge has shown no sign of it, the
   * card goes back.
   *
   * Any decision open for this seat — a question, a selection, a payment — is
   * a sign: the operator, 2026-10-15, on Cavern of Souls floating home under
   * its own creature-type question (an "As … enters" replacement, asked while
   * the land is still in the hand): *"cards should never time out and return
   * to hand while decisions like this are on the screen"*. So the clock only
   * runs out on silence. A decision that offers the card ITSELF as an answer
   * (a cleanup discard, CI run 37539089085) ends the park the moment it opens,
   * in `settleParkedIfResolved` — the card goes back to be chosen, not when
   * the clock gives up.
   */
  function onParkUnanswered(): void {
    unansweredTimer = null;
    if (!live || parked === null) return;
    // A decision open, or the card not in its own zone right now (in flight,
    // or on the table with its element not yet drawn): look again once that
    // has had its time. A card that left and came BACK (Forge took the play
    // and gave it up) is home, and is let go like any other it never took —
    // the clock keeps running until the park ends one way or another.
    if (whereIs(match, parked.source, parked.zone) !== 'home' || decisionOpen(match)) {
      unansweredTimer = setTimeout(onParkUnanswered, PARK_UNANSWERED_MS);
      return;
    }
    const p = endPark('floated-unanswered')!;
    releaseParked(p, true);
    paint();
  }

  /**
   * Whether the caster's stack still leaves a played card's own spell to the
   * parked card. It does while that spell is the only thing on the stack —
   * however long the opponent takes, and whatever Forge asks meanwhile: a
   * lone spell is drawn as the card, and this card is it. It stops, for good,
   * the moment a second item joins it (a cast trigger, a response): now there
   * is a stack to draw, and the spell belongs in its row.
   */
  function syncStackStandIn(): void {
    if (parked === null || !parked.played || parked.onStack) return;
    const stack = match.view?.stack ?? [];
    const source = parked.source;
    if (!stack.some((item) => !item.isAbility && item.sourceCardId === source)) return;
    if (stack.length > 1) showOnStack();
  }

  function showOnStack(): void {
    if (parked !== null) parked.onStack = true;
    carryCastOffStack(null);
  }

  /**
   * A cast being aimed has its stand-in on the page exactly while the board
   * has no element of its own for the card: Forge holds a card being cast in
   * none of the zones the board draws until its targets are chosen, so React
   * unmounts it, and without the stand-in the player would see the card
   * vanish the moment they let go of it. A PLAYED card has it for the whole
   * of the wait (`drawCastLift`'s `'carried'`) — UNLESS its spell is already
   * on the stack: §S's `live/placed.ts` takes over from there, drawing the
   * item at this exact point (`gestures/install.ts`'s own `resolveLift`
   * registered it, via `placeSpell`), so keeping the ghost too would draw
   * the same card twice, pixel for pixel. This is the ONE handoff rule that
   * changed for the stack redesign — everything else about the ghost
   * (the pre-stack gap, the float-back, the battlefield landing) is
   * untouched, `gestures/cast.ts`'s own.
   *
   * The handoff itself is `onGhostHandoffDrawn` below, not this function: a
   * stack item's `sourceCardId` is already true on `match` the INSTANT
   * Forge's frame arrives, synchronously, from THIS subscriber's own `match`
   * callback — before `Board`'s own `useEffect` (a different subscriber of
   * the same match) has re-rendered and called `live/placed.ts`'s `notify`
   * to actually draw it. Removing the ghost here, on the match's say alone,
   * left a GAP frame with nothing drawn at all (measured:
   * `e2e/played-card.spec.ts`'s own recording). `live/placed.ts`'s
   * `onSpellDrawn` fires synchronously from INSIDE that draw instead, so
   * removing the ghost there is an atomic swap — never a guess at how long
   * React takes, which a timer tried and sometimes guessed short, drawing
   * both at once for a frame (measured the same way).
   */
  function syncParkedGhost(): void {
    if (parked === null || parked.ghost === null || parked.ghostHandedOff) return;
    const { ghost } = parked;
    if (!parked.played && cardBox(canvas, parked.source) !== null) {
      ghost.remove();
      return;
    }
    if (ghost.isConnected) return;
    ghost.setAttribute(CAST_LIFT_ATTR, 'parked');
    ghost.style.left = `${parked.at.x}px`;
    ghost.style.top = `${parked.at.y}px`;
    // Under the board, so its card styles still dress the stand-in, but
    // outside every zone, so nothing counting a zone's cards counts it.
    (canvas.querySelector('.board') ?? canvas).appendChild(ghost);
  }

  /** Let a parked card go — its own element, or its stand-in when the board has none. */
  function releaseParked(p: Parked, floatHome: boolean): void {
    const ghost = p.ghost !== null && p.ghost.isConnected ? p.ghost : null;
    if (floatHome) {
      floatCastLiftHome(canvas, p.source, p.home, () => ghost?.remove(), ghost ?? cardBox(canvas, p.source));
    } else {
      ghost?.remove();
      clearCastLift(canvas, p.source);
    }
  }

  /**
   * Right-click or Escape, while a hand-card gesture is live. See the module
   * header's own section — this is the one function either input calls, for
   * both a parked cast and a bare lift.
   */
  function cancelLive(by: CancelInput, node: EventTarget | null = null): void {
    clearCommitted(overlayOf(canvas));
    if (parked !== null) {
      // Forge is asking about THIS cast only if a selection or a payment is
      // open now — a land, or a spell that needed neither, is already done,
      // and pressing Cancel regardless would reach whatever button 2 means
      // next.
      const asking = match.selectables !== null || payingMana(match);
      // A played card Forge is not asking about is already on its way to the
      // battlefield: there is nothing to cancel, and floating it back to a
      // hand it is about to leave would show something that is not true.
      if (parked.played && !asking) return;
      const offer = boardInteraction(match);
      const p = endPark('cancel', { by, under: describeNode(node), offered: `cards ${[...offer.selectable].join(' ')}; players ${[...offer.selectablePlayers].join(' ')}`.slice(0, 80) })!;
      if (asking) pressButton(match, 'cancel');
      releaseParked(p, true);
      paint();
      return;
    }
    if (drag !== null && drag.lifted) {
      const d = drag;
      drag = null;
      handPressIndex = null;
      scheduleHandIndicator(null);
      clearDropCues(canvas);
      previewAt(null);
      if (d.source !== null) floatCastLiftHome(canvas, d.source, d.from, () => {});
      paint();
    }
  }

  /**
   * A parked cast that Forge has finished with — no selection, no payment, no
   * open ask, and the card itself is off the stack too (it resolved, or the
   * selection closed without a question this layer answers) — needs no
   * cancel and no further input; it is simply over, so the lift comes off.
   *
   * Only once Forge's state has the card somewhere settled again: a zone the
   * board draws, or back in the hand after having left it. Between the cast
   * going out and Forge opening its target selection, nothing is open for a
   * moment — the card is still in the hand on the first frames after the
   * send, then in no zone at all — and settling in that gap would drop the
   * parked cast just before Forge asks about it, leaving a right-click or
   * Escape with nothing to cancel and the arrow with no origin.
   */
  function settleParkedIfResolved(): void {
    if (parked === null) return;
    const where = whereIs(match, parked.source, parked.zone);
    if (where !== 'home') parked.leftZone = true;
    if (parked.played && where === 'drawn') {
      // It is a permanent now (or, countered, a card in a graveyard), and the
      // play is over whatever Forge asks next — an enters trigger's target is
      // a new question about a card already on the table.
      if (!onBattlefield(match, parked.source)) {
        releaseParked(endPark('elsewhere')!, false);
        return;
      }
      // The row's own element is what it lands on, so this waits for React to
      // have drawn it; the hand's element, still lifted, is not it.
      const arrived = cardBox(canvas, parked.source);
      if (!(arrived instanceof HTMLElement) || arrived.closest('[data-zone="battlefield"]') === null) return;
      const p = endPark('landed')!;
      if (p.ghost === null || reduced()) {
        reportHandover(options.report, 'landing', canvas, casterFacts(p, p.ghost === null ? 'no-ghost' : 'motion-off', drawnCentreOf(p.ghost), drawnCentreOf(arrived)));
        releaseParked(p, false);
        return;
      }
      // Not this element, and not now: `Board` moves a placed card into the
      // column it was let go at in a layout effect AFTER this frame, and a card
      // that becomes its own pile is a NEW element — the landing drawn here hid
      // the old one and flew to its box while the new one painted at once (the
      // operator, 2026-10-08: "it immediately appears on the board"). The next
      // animation frame is after that commit: the element found then is the one
      // the card keeps, and its box is where it will stay.
      // Hidden from this very frame, or the row's card and its stand-in are both drawn until its arrival starts.
      arrived.setAttribute(CAST_LANDING_ATTR, '');
      const ghost = p.ghost;
      // From where the stack last drew it (`stackBoxOf`), when it resolved off the stack; else where it was let go.
      const drawn = stackBoxOf(p.source);
      const from = drawn === null ? p.at : { x: drawn.left + drawn.width / 2, y: drawn.top + drawn.height / 2 };
      // §S: if the stack handoff already retired this ghost (`ghostHandedOff`),
      // it is detached right now — re-attach it, WHERE THE STACK LAST DREW IT, on
      // this same synchronous frame, so hiding the real card below never opens
      // a gap with nothing drawn. The arrival itself still waits the one frame
      // `landCastGhost` always has (the comment above this block explains why).
      if (!ghost.isConnected) {
        ghost.setAttribute(CAST_LIFT_ATTR, 'parked');
        ghost.style.left = `${from.x}px`;
        ghost.style.top = `${from.y}px`;
        (canvas.querySelector('.board') ?? canvas).appendChild(ghost);
      }
      landingFrame = requestAnimationFrame(() => {
        landingFrame = 0;
        const settled = cardBox(canvas, p.source);
        if (settled !== arrived) arrived.removeAttribute(CAST_LANDING_ATTR);
        if (settled instanceof HTMLElement && settled.closest('[data-zone="battlefield"]') !== null) {
          const landing = landCastGhost(canvas, p.source, ghost, from, settled, castLandingWeight(match.view, p.source));
          reportHandover(options.report, 'landing', canvas, { ...casterFacts(p, landing.how, landing.from, landing.to), shrink: landing.shrink });
        } else {
          reportHandover(options.report, 'landing', canvas, casterFacts(p, 'gone-before-frame', drawnCentreOf(ghost), null));
          releaseParked(p, false);
        }
      });
      return;
    }
    // Forge offers the parked card ITSELF as an answer — a cleanup discard, a
    // discard cost, a choice among cards — while it is still in its own zone:
    // the play is over and the card has a new question about it, so it goes
    // home now (table-fit 2026-10-07: the discard's first offered card was the
    // land the seat had just put down, hidden at its park point).
    if (where === 'home' && offersCard(match, parked.source)) {
      releaseParked(endPark('offered')!, true);
      return;
    }
    if (decisionOpen(match)) return;
    if (match.view?.stack.some((item) => item.sourceCardId === parked!.source)) return;
    if (where === 'limbo' || (where === 'home' && !parked.leftZone)) return;
    const p = endPark('settled')!;
    releaseParked(p, false);
  }

  /**
   * The sweep is over, however it ended: every land still in it — queued, or
   * the one just sent — had its optimistic pending mark cleared.
   * A land the sweep never reaches is cleared here too.
   */
  function endTapSweep(): void {
    for (const id of tapQueue) clearTapPending(canvas, id);
    if (tapSent !== null) clearTapPending(canvas, tapSent);
    tapQueue = [];
    tapSent = null;
    if (tapTimer !== null) clearTimeout(tapTimer);
    tapTimer = null;
  }

  /** Send the next queued land when Forge is ready for it. Called at the release and on every notify. */
  function pumpTaps(): void {
    if (tapSent === null && tapQueue.length === 0) return;
    // Forge opened a selection or combat: the sweep is over, and nothing in it answers a question.
    if (match.selectables !== null || declaringCombat(match)) {
      endTapSweep();
      return;
    }
    /*
     * An ask while a tap is out is that tap's own: Forge asks which ability of
     * the land to play (`getAbilityToPlay`) for EVERY land, and `../prompts/`
     * answers a one-ability ask itself. A land with two is the player's to
     * answer, and the sweep waits for it. An ask with no tap out is not ours.
     */
    if (match.asks.length > 0) {
      if (tapSent === null) endTapSweep();
      return;
    }
    const mine = viewerOf(match.view)?.battlefield ?? [];
    if (tapSent !== null) {
      const sent = mine.find((c) => c.id === tapSent);
      // Not turned on the board yet: Forge has not answered that click.
      if (sent !== undefined && sent.tapped !== tapTo) return;
      // Forge's own `data-tapped` now carries it: the optimistic mark has done its job.
      clearTapPending(canvas, tapSent);
      tapSent = null;
    }
    while (tapQueue.length > 0) {
      const next = tapQueue[0]!;
      const land = mine.find((c) => c.id === next);
      if (land === undefined || land.tapped === tapTo) {
        clearTapPending(canvas, next);
        tapQueue.shift();
        continue;
      }
      // Not offered yet (Forge re-offers the board after each click): the next notify tries again.
      if (!landsOffered(match).some((c) => c.id === next)) return;
      tapQueue.shift();
      tapSent = next;
      if (tapTimer !== null) clearTimeout(tapTimer);
      tapTimer = setTimeout(endTapSweep, TAP_SWEEP_MS);
      if (!selectCard(match, next)) tapSent = null;
      return;
    }
    endTapSweep();
  }

  function onPointerDown(event: PointerEvent): void {
    cancelledByRightClick = false;
    // A press on the target the arrow is snapped to commits it, whichever branch below (or the card's own click) sends it.
    if (event.button === 0) commitArrowAt(overlayOf(canvas), eventTarget(event));
    /*
     * A held box group takes the next press, whatever it lands on: on a
     * defender it attacks it, anywhere else (a right-click included) it is
     * dropped. Either way the press is spent here — the click it leaves must
     * not also reach the face or card under it.
     */
    if (aim !== null) {
      claim(event);
      const group = aim;
      aim = null;
      if (event.button === 2) cancelledByRightClick = true;
      if (event.button === 0) {
        clicks.arm();
        const target = aimedTarget(match, group.ids[0]!, eventTarget(event));
        if (target !== null && target.kind !== 'stack') {
          playRole('ui.target');
          attackWith(match, group.ids, target);
        }
      }
      paint();
      return;
    }
    /*
     * A right-click cancels a live gesture outright, before any button
     * filtering below — a parked cast or a bare lift, held or click-armed
     * alike.
     */
    if (event.button === 2 && (parked !== null || (drag !== null && drag.lifted))) {
      claim(event);
      cancelledByRightClick = true;
      cancelLive('right-click', eventTarget(event));
      return;
    }
    /*
     * A click that lands on nothing, while a cast is parked, is a cancel too.
     * A press that lands on something Forge's open selection NAMES is left
     * alone — the ordinary click Board's own markup already answers with,
     * same as any other click-cast — so only a stray press inside the
     * table/board area, naming nothing, is claimed here.
     */
    if (parked !== null && event.button === 0 && match.selectables !== null && inside(eventTarget(event)) && targetAt(eventTarget(event), null) === null) {
      claim(event);
      cancelLive('stray-click', eventTarget(event));
      return;
    }
    /*
     * A click-armed gesture (`held: false`) does not resolve at its own
     * release — it keeps following the pointer with no button held until
     * THIS press resolves it, at its own point. Ahead of every other branch
     * below: the resolving press may land on anything at all, including
     * something that would otherwise start an unrelated gesture of its own.
     */
    if (drag !== null && drag.lifted && !drag.held) {
      claim(event);
      // The click that follows this press is the release's, never the card
      // under it: a release on a pile (where free placement puts the last
      // land, so the next one lands on it) must not also select that pile's
      // land — a second select while Forge is mid-getAbilityToPlay for the
      // first, and the play never happened (table-fit 2026-10-07).
      clicks.arm();
      const held = drag;
      drag = null;
      resolveLift(held, { x: event.clientX, y: event.clientY }, eventTarget(event));
      paint();
      return;
    }
    // Left button only from here: a right-click is Forge's own menu on the
    // desktop and is not this gesture's to take.
    if (event.button !== 0) return;
    // Reset at the top of every FRESH press — see the latch's own doc comment.
    clicks.reset();
    /*
     * A press on the viewer's own hand card, Forge-offered or not, is a
     * REORDER unless it leaves the hand — ahead of every other branch below.
     * `CardOnBoard` never makes a hand card arrangeable, so this is not
     * racing `Board.tsx`'s own arrange gesture for the press.
     *
     * Presses are left alone, exactly as before, when Forge is
     * asking something ELSE: an open ASK (a dialog) outranks the actionable
     * set the same way it already does for the old cast-from-hand branch
     * below — `match.asks.length === 0`; the London mulligan's bottom pick
     * (`choosingMulligan`, its own carve-out below is unreached once this
     * returns first, so it is repeated here); a selection that NAMES this
     * exact card as a choice (a discard, a reveal) — the `under.kind ===
     * 'card'` branch below still answers a click on it the way it always
     * has; and a stack-ask or the attacker box-draw, which claim a press
     * anywhere on the table.
     *
     * Lands Forge would tap for mana do NOT stand this down: they are on the
     * battlefield, and a tap box starts there, never on a hand card. With
     * that check here, a press on any card Forge was not offering — every
     * card on the other seat's turn — fell through to the tap box and
     * picked nothing up.
     */
    if (event.button === 0 && stackAsk(match) === null && !declaringAttackers(match)) {
      const press = handCardPress(eventTarget(event));
      if (
        press !== null &&
        match.asks.length === 0 &&
        !choosingMulligan(match) &&
        !(match.selectables?.cards.has(press.id) ?? false)
      ) {
        claim(event);
        // The native click this press leaves behind must not also reach the
        // card's own `onClick` — same reason the old cast-from-hand branch
        // armed this, see the latch's own doc comment.
        clicks.arm();
        const pressAt = { x: event.clientX, y: event.clientY };
        const box = cardBox(canvas, press.id);
        const from = box === null ? pressAt : centreOf(box);
        handPressIndex = handOrderIds(canvas).indexOf(press.id);
        holdLiftedSlot(press.li, press.id);
        drag = { source: press.id, press: pressAt, from, at: pressAt, target: null, moved: false, lifted: 'hand', held: true };
        // Board-sized from this call itself (`drawCastLift`'s own `'lifted'` rule) — nothing
        // of this module's reads or writes that property.
        drawCastLift(canvas, press.id, pressAt, 'lifted');
        // Deferred to the first frame, same as every later move — a layout forced here
        // would run before the browser has even painted the lift at the press point.
        scheduleHandIndicator({ cardId: press.id, point: pressAt });
        hover = null;
        paint();
        return;
      }
    }
    /*
     * Item 5: a press on the viewer's own placed spell picks it up — UNLESS
     * Forge is asking the stack-target question that element ALSO answers
     * (`stackAsk`), which keeps the press below. Checked before the
     * arrangement guard: a placed element is never arrangeable.
     */
    if (stackAsk(match) === null) {
      const under = eventTarget(event);
      const placedEl = under instanceof Element ? under.closest<HTMLElement>('[data-placed-spell][data-mine]') : null;
      if (placedEl !== null) {
        claim(event);
        const id = Number(placedEl.getAttribute('data-placed-spell'));
        placedDrag = { id, press: { x: event.clientX, y: event.clientY }, moved: false };
        hover = null;
        paint();
        return;
      }
    }
    /*
     * Lane A's arrange gesture owns a press on an arrangeable card —
     * EVEN one Forge offered. At ordinary priority Forge's actionable set names
     * most of a player's own permanents ("you could"), and claiming those presses
     * would break the arrangement gesture. A CLICK still plays the card,
     * because the slop keeps this layer out of one; what is given up is
     * drag-to-play on a card the player can also rearrange.
     *
     * The exceptions are the two inputs where a press on one's own battlefield
     * card IS the answer Forge is waiting for: combat declaration, and a mana
     * payment. Both are read off which input Forge is parked on, never off its
     * prose — see `../match.ts`'s `declaringCombat` and `payingMana`.
     *
     * Before EVERY branch, so the box-draw has it too: a marquee started on a
     * arrangeable permanent would otherwise rearrange the battlefield and declare
     * attackers in one press.
     */
    if (arrangeable(eventTarget(event)) && !declaringCombat(match) && !payingMana(match)) return;
    const at = { x: event.clientX, y: event.clientY };
    if (stackAsk(match) !== null && inside(eventTarget(event))) {
      // A question about the stack: the press may start anywhere on the table, and
      // the arrow leaves from the card being cast when it is on screen.
      const origin = clickOrigin();
      claim(event);
      drag = {
        source: null,
        press: at,
        from: origin === null ? at : origin.at,
        at,
        target: targetAt(eventTarget(event), null),
        moved: false,
        lifted: null,
        held: true,
      };
      hover = null;
      paint();
      return;
    }
    const offered = boardInteraction(match);
    const under = targetUnder(eventTarget(event), offered);
    if (under !== null && under.kind === 'card') {
      /*
       * The London mulligan's bottom pick: a hand card is offered to be SET
       * ASIDE by a click, and that click is the whole gesture. Aiming an arrow
       * from it (the pointing drag below) pointed at nothing Forge would take
       * — the operator, 2026-10-06: "it's also strange that i can drag an
       * arrow from them" (ledger Z3). Not claimed: the press stays a click.
       */
      if (choosingMulligan(match) && isHandCard(match, under.id)) return;
      const box = cardBox(canvas, under.id);
      claim(event);
      /*
       * Only a card in one of the viewer's own cast zones is ever lifted: the
       * hand, or a graveyard or exile Forge offers it from — a flashback
       * spell is picked up and carried exactly as a hand card is, with no
       * arrow, and its target is asked for only once it is cast (the
       * operator, 2026-10-11, on Cabal Therapy: "the target arrow should
       * come after the spell is played"). A battlefield land offered for its
       * mana ability is in none of them, so it drags exactly as it always has.
       *
       * **Priority's own offer ONLY — never a selection's, and never an
       * ask's.** A selection can itself name a hand or graveyard card
       * (Secluded Glen's "reveal a Faerie?", Relentless Dead's "a Zombie card
       * in your graveyard"), so the zone alone is not enough: a card Forge is
       * actively asking the seat to CHOOSE is not one it is offering to be
       * CAST, and the two can share the same id.
       * `match.asks.length > 0` already empties `offered` entirely
       * (`boardInteraction`'s own guard), so that half holds without a
       * separate check here; `match.selectables === null` is the other half;
       * `weaklySelectable.has(id)` on top of both is the precise positive
       * case — Forge's own priority-time "you could cast this", never
       * `highlighted`/`mulliganHand`/combat's unions, none of which a press
       * on a card should ever read as "lift and cast".
       */
      const castZone =
        match.selectables === null && match.asks.length === 0 && (match.weaklySelectable?.has(under.id) ?? false) ? castZoneOf(match, under.id) : null;
      if (castZone !== null) clicks.arm();
      const from = box === null ? at : centreOf(box);
      drag = {
        source: under.id,
        press: at,
        from,
        at,
        target: null,
        moved: false,
        lifted: castZone,
        held: true,
      };
      hover = null;
      if (castZone !== null) {
        const spell = needsTarget(castCardTypeLine(match, under.id));
        drawCastLift(canvas, under.id, at, 'lifted');
        updateDropCues(canvas, spell, castZone, overHome(eventTarget(event), castZone));
        // Picked up out of an opened pile: the card is in hand now, and the view gives way to it.
        if (castZone !== 'hand') closePileView();
      }
      paint();
      return;
    }
    if (!inside(eventTarget(event))) return;
    if (declaringAttackers(match) || landsOffered(match).length > 0) {
      claim(event);
      marquee = { press: at, at, moved: false };
      hover = null;
      paint();
      return;
    }
    // Inside a selection the gesture may start anywhere on the table: the
    // spell doing the targeting is not itself one of Forge's choices, so
    // there is often no offered card to drag FROM. The tail is still the
    // SOURCE's own element (`clickOrigin`, same as the click-targeting
    // arrow) — never the press point, which is wherever on the table this
    // drag happened to start and not where the spell doing the targeting is.
    if (match.selectables === null) return;
    const origin = clickOrigin();
    claim(event);
    drag = { source: null, press: at, from: origin === null ? at : origin.at, at, target: under, moved: false, lifted: null, held: true };
    hover = null;
    paint();
  }

  function onPointerMove(event: PointerEvent): void {
    const at = { x: event.clientX, y: event.clientY };
    if (drag !== null) {
      const moved = drag.moved || pastSlop(drag.press, at);
      // The card is in hand from the moment the press clears the slop, not at the press itself.
      if (drag.lifted && moved && !drag.moved) playRole('ui.lift');
      const next: DragState = { ...drag, at, moved, target: targetAt(eventTarget(event), drag.source) };
      drag = next;
      if (next.lifted !== null && next.source !== null) {
        const overZone = overHome(eventTarget(event), next.lifted);
        // Board-sized on every call, not only the first — `drawCastLift`'s own `'lifted'`
        // rule re-reads the battlefield's current `--card-w` each time; this module never
        // overrides or clears that property, inside the hand or out of it.
        drawCastLift(canvas, next.source, at, 'lifted');
        if (overZone && next.lifted === 'hand') {
          // Still inside the hand — the reorder preview, not the cast's drop cues.
          clearDropCues(canvas);
          previewAt(null);
          scheduleHandIndicator({ cardId: next.source, point: at });
        } else {
          // The press has left the hand (the mode change to the cast gesture, same press), or
          // a card from a pile is over the table — or back over its pile, the cancel cue.
          scheduleHandIndicator(null);
          const spell = needsTarget(castCardTypeLine(match, next.source));
          updateDropCues(canvas, spell, next.lifted, overZone);
          // Only a no-target card ever lands in a row.
          previewAt(!spell && overOwnBattlefield(eventTarget(event)) ? at : null);
        }
      }
    } else if (marquee !== null) {
      marquee = { press: marquee.press, at, moved: marquee.moved || pastSlop(marquee.press, at) };
    } else if (aim !== null) {
      aim = { ...aim, at, node: eventTarget(event) };
    } else if (placedDrag !== null) {
      // AD3 (item 6): this is the ONLY thing that moves a placed card — never
      // a bare hover, which is what the OLD stand-in's bug was. `moveSpell`
      // repositions the element itself (`live/placed.ts`'s own `notify`) and
      // tells lane W to relay it; `hover` stays untouched, so the free
      // click-targeting arrow (if any OTHER cast is being aimed right now)
      // keeps reading the real pointer, not this drag.
      placedDrag = { ...placedDrag, moved: placedDrag.moved || pastSlop(placedDrag.press, at) };
      if (placedDrag.moved) {
        // AE28: an own trigger/ability has no point until it is first moved; this registers it there.
        placeStackItem(placedDrag.id, at, 'you');
        moveSpell(placedDrag.id, at);
      }
    } else {
      const under = eventTarget(event);
      hover = canvas.contains(under instanceof Node ? under : null) ? { at, node: under } : null;
    }
    paint();
  }

  function onPointerUp(event: PointerEvent): void {
    // A drag let go over the target its arrow is snapped to: committed, as a press on it is.
    if (event.button === 0) commitArrowAt(overlayOf(canvas), eventTarget(event));
    if (placedDrag !== null) {
      const p = placedDrag;
      placedDrag = null;
      // A press that never moved was a click (the inspector's own hover/
      // long-press owns that gesture already) — nothing to commit.
      if (p.moved) moveSpell(p.id, { x: event.clientX, y: event.clientY });
      paint();
      return;
    }
    /*
     * A plain click (zero `moved`) does NOT resolve the gesture — it ARMS it
     * (`held: false`) and keeps tracking the pointer with no button down,
     * same as a held drag, until the next press resolves it (`onPointerDown`'s
     * own top-of-function check). Every other kind of drag, and a real drag
     * (`moved: true`), still ends here exactly as before.
     */
    if (drag !== null && drag.lifted && !drag.moved) {
      drag = { ...drag, held: false };
      paint();
      return;
    }
    const heldDrag = drag;
    const heldMarquee = marquee;
    drag = null;
    marquee = null;
    hover = null;
    paint();
    if (heldDrag !== null) {
      if (stackAsk(match) !== null) {
        // The release IS the answer, a click on the item as much as a drag onto it.
        const id = stackItemUnder(eventTarget(event), stackAsk(match)!);
        if (id !== null && commitStackTarget(match, id)) playRole('ui.target');
        return;
      }
      if (heldDrag.lifted) {
        resolveLift(heldDrag, { x: event.clientX, y: event.clientY }, eventTarget(event));
        return;
      }
      if (heldDrag.moved) commitDrag(match, heldDrag, eventTarget(event));
      return;
    }
    if (heldMarquee !== null && heldMarquee.moved) {
      const box = rectOf(heldMarquee.press, { x: event.clientX, y: event.clientY });
      if (declaringAttackers(match)) {
        const result = commitMarquee(match, box, canvas);
        if (result.kind === 'aim') {
          aim = { ids: result.ids, at: { x: event.clientX, y: event.clientY }, node: eventTarget(event) };
          paint();
        }
      } else {
        endTapSweep();
        const sweep = landsInBox(match, box, canvas);
        tapQueue = sweep.ids;
        tapTo = sweep.tap;
        // Every boxed land is drawn turned AT ONCE — Forge still gets them
        // one `selectCard` at a time, below, exactly as before.
        markTapPending(canvas, tapQueue, tapTo);
        tapTimer = setTimeout(endTapSweep, TAP_SWEEP_MS);
        pumpTaps();
      }
    }
  }

  function onPointerCancel(): void {
    if (placedDrag !== null) {
      // Wherever it last moved to (via `moveSpell`) is where it stays — no
      // cast went out, so there is nothing Forge needs telling either way.
      placedDrag = null;
      paint();
      return;
    }
    // The browser took the pointer away mid-aim: the same as letting go of
    // the cast with right-click or Escape.
    if (parked !== null && drag === null) {
      cancelLive('pointercancel');
      return;
    }
    if (drag !== null && drag.lifted) {
      handPressIndex = null;
      scheduleHandIndicator(null);
      clearDropCues(canvas);
      previewAt(null);
      const liftedSource = drag.source;
      if (liftedSource !== null) floatCastLiftHome(canvas, liftedSource, drag.from, () => {});
    }
    drag = null;
    marquee = null;
    hover = null;
    paint();
  }

  /** Escape cancels cleanly, from either phase — see `cancelLive`. */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (aim !== null) {
      aim = null;
      paint();
      return;
    }
    if (parked === null && !(drag !== null && drag.lifted)) return;
    cancelLive('escape');
  }

  /**
   * The board is a game surface: a right-click there never opens the browser's menu. One that
   * cancelled a live gesture was the gesture's, so it goes no further — the board's own card menu
   * (`card-menu/CardMenu.tsx`, listening above this) does not open on it.
   */
  function onContextMenu(event: Event): void {
    event.preventDefault();
    if (!cancelledByRightClick) return;
    cancelledByRightClick = false;
    event.stopPropagation();
  }

  const unguardText = guardTextSelection(canvas);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('click', clicks.swallow, true);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  /*
   * Forge spoke, or React redrew. Both change what this layer must show — the
   * offered set moved under an open drag, or the `<li>` carrying an intent mark
   * was remounted and lost it — and both are answered by painting again.
   * `marks.apply` writes only where the value differs, so this is cheap.
   */
  const unsubscribe = subscribe(match, () => {
    if (!live) return;
    pumpTaps();
    dropStaleAim();
    settleParkedIfResolved();
    syncStackStandIn();
    syncParkedGhost();
    paintSoon();
  });
  /**
   * The ghost's own handoff (§S) — see `syncParkedGhost`'s header for why
   * this is a separate subscription rather than a check inside it: `id` is
   * only ever reported once `live/placed.ts` has ALREADY drawn that item,
   * synchronously, in the same call — so removing the ghost here can never
   * race ahead of or behind the draw it is standing in for.
   */
  const unsubscribePlacedDrawn = onSpellDrawn((id) => {
    if (parked === null || parked.ghost === null) return;
    const item = (match.view?.stack ?? []).find((i) => i.id === id);
    // Never an ABILITY entry sharing this id — see `clickOrigin`'s own note (W17).
    if (item === undefined || item.isAbility || item.sourceCardId !== parked.source) return;
    parked.stackFrameAt = Date.now();
    if (parked.gliding) parked.drawnMidGlide = id;
    else handOverToStack(parked, id);
  });
  /** The stand-in gives way to the stack card `id`, drawn where it stands. */
  function handOverToStack(p: Parked, id: number): void {
    if (p.ghost === null || p.ghostHandedOff) return;
    p.ghostHandedOff = true;
    const from = drawnCentreOf(p.ghost);
    p.ghost.remove();
    reportHandover(options.report, 'handover', canvas, casterFacts(p, 'stack', from, canvas.querySelector(`[data-placed-spell="${id}"]`)));
  }
  const observer = new MutationObserver((records) => {
    if (!live) return;
    const setOff = records.flatMap((r) =>
      r.type === 'attributes' && r.target instanceof Element && r.target.hasAttribute(RAMMING_ATTR) ? [Number(r.target.getAttribute('data-board-card'))] : [],
    );
    if (setOff.length > 0) {
      for (const id of setOff) if (Number.isInteger(id)) rammed.add(id);
      paintSoon();
    }
    if (records.every((r) => r.type === 'attributes')) return;
    // Our own arrow and marquee live in the overlay; reacting to those would be
    // reacting to ourselves.
    const overlay = overlayOf(canvas);
    if (records.every((r) => overlay !== null && r.target instanceof Node && overlay.contains(r.target))) return;
    applyMarks();
    // A played card lands on its row's own element, which exists only now.
    settleParkedIfResolved();
    syncParkedGhost();
  });
  observer.observe(canvas, { childList: true, subtree: true, attributes: true, attributeFilter: [RAMMING_ATTR] });
  paint();

  return {
    dispose(): void {
      live = false;
      aim = null;
      unguardText();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('click', clicks.swallow, true);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      observer.disconnect();
      unsubscribe();
      unsubscribePlacedDrawn();
      const overlay = overlayOf(canvas);
      clearArrow(overlay);
      clearCommitted(overlay);
      clearAutoTargetArrows(overlay);
      clearMarquee(overlay);
      marks.clear();
      clearAllCastLifts(canvas);
      releaseLiftedSlot();
      clearDropCues(canvas);
      handPressIndex = null;
      scheduleHandIndicator(null);
      // A gesture disposed mid-flight (a remount, a resync) leaves no
      // placement preview behind either.
      if ((drag !== null && drag.lifted) || parked !== null) previewAt(null);
      if (landingFrame !== 0) cancelAnimationFrame(landingFrame);
      landingFrame = 0;
      if (paintFrame !== 0) cancelAnimationFrame(paintFrame);
      paintFrame = 0;
      endPark('disposed');
      endTapSweep();
      canvas.removeAttribute(CANVAS_ATTR);
      canvas.removeAttribute('data-dragging');
      canvas.removeAttribute('data-marquee');
      canvas.removeAttribute('data-aiming');
    },
  };
}

/** The card id an origin element carries, for the arrow's `data-source`. */
function originId(el: Element): number | null {
  const raw = el.getAttribute('data-board-card') ?? el.getAttribute('data-card-id');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

export type { Rect };
