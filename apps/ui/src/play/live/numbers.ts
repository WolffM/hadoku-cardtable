/*
 * Floating combat numbers: life changing at a seat's face. A creature gets no
 * number since 2026-10-15 — its hit is the projectile's impact (the operator:
 * "we dont have to show a number, just the impact would be fine"), and the
 * damage that stays is its P/T badge's. Approved design (its creature
 * artboards are retired):
 * https://claude.ai/artifact/BZGfndqa4MeDCDrDwDdCvn — four artboards (damage
 * to a player, life gain with stacking, damage on a creature that survives or
 * dies, and the 700ms timeline). The rules below restate it so this module
 * needs no link to read.
 *
 * ## What spawns, and from what
 *
 * Every call to `notify(view)` diffs the new view against the one before it
 * (`diffViews`, pure — no DOM, unit-tested on hand-built views): a player
 * whose `life` moved, and what a resolution did (below).
 * Nothing spawns from a click or a local guess — only from what the view
 * itself says changed, so the two seats' screens draw the same numbers from
 * the same facts, at mirrored positions, by construction.
 *
 * ## Where it lands
 *
 * A life number lands on `[data-player-face][data-player-id="<id>"]`
 * (`Board.tsx`'s own face markup; `data-viewer` on that element is also how
 * this module tells a seat's own face apart).
 *
 * ## The theme, not a colour of our own
 *
 * `--danger`/`--danger-ink` for a loss (life down, a hit),
 * `--success`/`--success-ink` for a life gain, `--bg` for every number's own
 * outline. No other colour exists here. A cleanup wipe (damage decreasing) is
 * not drawn at all.
 *
 * ## Life's counter
 *
 * `Board.tsx` renders `player.life` directly — this module does not own that
 * markup and does not change it structurally. What it does is reach into the
 * ALREADY-RENDERED `[data-testid="life"]` span: it takes the loss or gain
 * colour for `LIFE_COLOUR_MS` and is stepped through `tickSteps` at
 * `TICK_STEP_MS` apart (at once in Fast Mode) before settling back to whatever
 * the next React render put there (which is already the same number, so
 * nothing visibly snaps). Nothing is drawn beside it: the operator, 2026-10-10,
 * of a struck-through old value that sat above the counter, *"let's just remove
 * teh weird crossed out number so the UI doesn't shift"*.
 *
 * ## Reduced motion and Fast Mode
 *
 * `prefers-reduced-motion`: no rise, no pop — `data-number-reduced` switches
 * `numbers.css` to a fade-only rule, read here too (not only in CSS) so the
 * cleanup timer waits the right amount either way, the same device
 * `gestures/cast.ts`'s `floatCastLiftHome` already uses. Fast Mode only
 * changes the counter: `tickSteps` is still computed, but applied in one
 * frame instead of stepped — the floating number itself still rises exactly
 * the same.
 *
 * ## A resolution's effects, in beats
 *
 * Forge applies a resolution in ONE frame: the spell or ability leaves the
 * stack, the life total moves, the token is on the battlefield (the operator,
 * 2026-10-14: Kalitas's Zombie "was too instant"; Sorin, Grim Nemesis's +1
 * "reveals a card and then does damage. we need some kind of reveal and then
 * damage dealt animation"). In a frame where a stack item resolved
 * (`ViewDiff.resolved`), what it changed is drawn in Forge's order instead:
 *
 *  1. a reveal first — when a reveal (`Revealed`) arrived while
 *     that item was on the stack, nothing below starts until its beat
 *     (`REVEAL_BEAT_MS`) is over, and its card — where it is drawn now: the
 *     reveal notice (`../prompts/RevealNotice.tsx`), else its own zone on the
 *     board, which marks it `data-reveal-beat` for the beat — is where the
 *     hits come from;
 *  2. each hit — a player's life or a creature's damage moving — travels from
 *     that card (else the resolving item's source on the battlefield, else
 *     where the item was drawn on the stack) to its target as a
 *     `[data-hit]` mark over `HIT_MS`, staggered `BEAT_STAGGER_MS`; a card it
 *     hits flashes (`data-hit-flash`) and only then does its number rise and a
 *     life counter tick;
 *  3. each permanent that entered from nowhere the viewer could see
 *     (`ViewDiff.arrivals`: a token, or a card out of a library) travels from
 *     the card that made it (`BoardCard.createdBy`, the bridge's
 *     `tokenSources`; else the resolving item, as above) into its slot —
 *     the played card's own trip, `gestures/cast.ts`'s `landCastGhost` — its
 *     row element marked `data-arriving-from` while it does. A token made
 *     outside any resolution (a replacement during combat damage) arrives
 *     the same way, from its maker. A permanent no resolution and no maker
 *     explains (a board being set up) is not an arrival.
 *
 * Every mark is in the overlay or the stand-in layer, never a transform on a
 * card in a row (table-fit). Reduced motion: no travel — the target flashes,
 * an arrival fades in, the number appears in place.
 *
 * ## The other seat's attack is a beat
 *
 * A view in which creatures of a seat not the viewer's start attacking (`ViewDiff.attacks`) holds the
 * board for `ATTACK_BEAT_MS`: `live/pace.ts` draws nothing after it until the attack has been seen, so
 * their ram comes after the attack as a person's does, whoever declared it. The viewer's own
 * declarations are theirs to see as they click. Fast Mode: no beat.
 */

import type { ManaColor } from '@hadoku/shared';

import type { BoardView, DamageHit, FaceHit, StackEntry } from '../adapter.ts';
import {
  ATTACK_BEAT_MS,
  BEAT_STAGGER_MS,
  BOLT_STAGGER_MS,
  damagePower,
  GLIDE_MS,
  HIT_MS,
  animationsSettled,
  noteBoardDrawing,
  noteBoardSounds,
  noteCardImpact,
  noteExitBeat,
  noteLifeImpact,
  noteResolutionEffects,
  REVEAL_BEAT_MS,
} from '../motion.ts';
import { DEPARTURE_ATTR, departureCause, departuresOf, exitMotionFor, exitMs, LEAVING_GAP_ATTR, type Departure } from './departures.ts';
import { ALIGN_MS, BLAST_MS, blast, boxIn, contactMs, fanOf, ram, RAM_STAGGER_MS, ramMs, strikeOffset, type Point, type RamEnd, type RamKind } from './ram.ts';
import { crash, shake } from './crash.ts';
import { fly, impact } from './projectile.ts';
import { cardColours } from './sound-events.ts';
import { CAST_LANDING_ATTR, landCastGhost, parkedGhost } from './gestures/cast.ts';
import './numbers.css';

/* ── timing and thresholds, as Settled fixed them ────────────────────── */

export const RISE_PX = 28;
export const RISE_MS = 700;
export const FADE_MS = 280;
export const POP_MS = 90;
export const POP_THRESHOLD = 5;
export const STACK_OFFSET_PX = 12;
export const STACK_STAGGER_MS = 80;
export const TICK_STEP_MS = 150;
export const LIFE_COLOUR_MS = 1500;
/** How long what a hit reached flashes (`numbers.css`'s `effect-hit-flash`). */
export const HIT_FLASH_MS = 360;
/** An arrival with nowhere to travel from fades in over this long. */
export const ARRIVE_FADE_MS = 240;
/** On a permanent's row element while it arrives from what made it: that card's id, empty when unknown. */
export const ARRIVING_ATTR = 'data-arriving-from';
/** A reveal the server answered for this seat (`match.ts`'s `revealed`): the cards it showed, and when it arrived. */
export interface Revealed {
  readonly cardIds: readonly number[];
  readonly at: number;
}

/** A revealed card on the board, while its reveal's beat runs (`markReveal`). */
const REVEAL_BEAT_ATTR = 'data-reveal-beat';
/** A reveal drawn in the same paint as the stack item it belongs to can be noted a few ms before the item is. */
const SAME_PAINT_MS = 150;

/* ── pure: diffing two views ──────────────────────────────────────────── */

export interface LifeChange {
  readonly playerId: number;
  readonly from: number;
  readonly to: number;
}

export interface DamageChange {
  readonly cardId: number;
  readonly ownerId: number;
  readonly from: number;
  readonly to: number;
}

/** A permanent on a battlefield now that the viewer saw nowhere before: a token, or a card out of a library. */
export interface Arrival {
  readonly cardId: number;
  /** The card that made it (`BoardCard.createdBy`), when Forge keeps one. */
  readonly source: number | null;
}

export interface ViewDiff {
  readonly life: readonly LifeChange[];
  readonly damage: readonly DamageChange[];
  /** The stack items that left the stack in this view, top first: what resolved (or was countered). */
  readonly resolved: readonly StackEntry[];
  readonly arrivals: readonly Arrival[];
  /** The damage Forge dealt since the last view (`BoardView.hits` above the last `seq` seen), to a card that was or is on a battlefield. */
  readonly hits: readonly DamageHit[];
  /** The damage Forge dealt to players since the last view (`BoardView.faceHits` above the last `seq` seen). */
  readonly faceHits: readonly FaceHit[];
  /** The permanents that left every battlefield in this view (`departures.ts`). */
  readonly departures: readonly Departure[];
  /** The creatures of a seat not the viewer's that are attacking in this view and were not in the last: an attack to be seen. */
  readonly attacks: readonly number[];
}

const NO_DIFF: ViewDiff = { life: [], damage: [], resolved: [], arrivals: [], hits: [], faceHits: [], departures: [], attacks: [] };

/**
 * How a creature's ram ends, from who dies of the fight (`ram.ts`'s `RamEnd`): both, it crumples into
 * the other; only it, it is blasted away; only the other, it wins and holds the blow; neither, a bounce.
 */
export function ramEnd(kind: RamKind, dies: boolean, struckDies: boolean): RamEnd {
  if (kind === 'charge') return 'charge';
  if (dies) return struckDies ? 'crumple' : 'blasted';
  return struckDies ? 'win' : 'bounce';
}

/** One creature ramming what it hit (`ram.ts`): a card, or a player's avatar. */
export interface RamPlan {
  readonly sourceId: number;
  readonly kind: RamKind;
  readonly target: { readonly cardId: number } | { readonly playerId: number };
  readonly delayMs: number;
  /** The most damage it dealt to any one thing, and how hard that hits (`damagePower`). */
  readonly amount: number;
  readonly power: number;
}

/**
 * Who rams what, and when each blow lands (the operator, 2026-10-16: creatures "'ram' eachother and
 * the player avatar"). Every hit whose source is a creature drawn on a battlefield (`canRam`) — on a
 * card, or on a player in combat — is that creature's ram; a creature that hit several things (a
 * trampler, its blocker and the player) rams the first card it hit, else the player, and every one of
 * its hits lands as it strikes. Two creatures that hit each other first meet halfway, at one time.
 * A hit on a card that is no creature — a planeswalker, a battle — is a charge at it, as at a player:
 * nothing can fight back (the operator, 2026-10-17: "make sure that works when attacking planeswalkers also").
 * Rams go one after another, `RAM_STAGGER_MS` apart, in the order Forge dealt the damage; each as hard
 * as its heaviest hit, and two that meet as hard as the heavier of them, so they arrive together. `hitAt`: when
 * each hit (by `seq`) lands; a hit not in it has no ram and lands at once.
 */
export function planRams(
  hits: readonly DamageHit[],
  faceHits: readonly FaceHit[],
  canRam: (cardId: number) => boolean,
  isCreature: (cardId: number) => boolean = () => true,
): { rams: RamPlan[]; hitAt: Map<number, number> } {
  const groups = new Map<number, { cards: DamageHit[]; faces: FaceHit[] }>();
  const group = (sourceId: number): { cards: DamageHit[]; faces: FaceHit[] } => {
    let g = groups.get(sourceId);
    if (g === undefined) groups.set(sourceId, (g = { cards: [], faces: [] }));
    return g;
  };
  const all = [...hits.map((h) => ({ seq: h.seq, card: h })), ...faceHits.filter((h) => h.combat).map((h) => ({ seq: h.seq, face: h }))].sort((a, b) => a.seq - b.seq);
  for (const h of all) {
    const sourceId = 'card' in h ? h.card.sourceId : h.face!.sourceId;
    if (sourceId === null || !canRam(sourceId)) continue;
    if ('card' in h) group(sourceId).cards.push(h.card);
    else group(sourceId).faces.push(h.face!);
  }
  const rams: RamPlan[] = [];
  const hitAt = new Map<number, number>();
  const planned = new Set<number>();
  let slot = 0;
  const most = (sourceId: number): number => Math.max(...[...groups.get(sourceId)!.cards, ...groups.get(sourceId)!.faces].map((h) => h.amount));
  const heaviest = (sourceId: number): number => damagePower(most(sourceId));
  const strikes = (sourceId: number, kind: RamKind, delayMs: number, power = heaviest(sourceId)): void => {
    const g = groups.get(sourceId)!;
    const first = g.cards[0];
    const amount = most(sourceId);
    rams.push({ sourceId, kind, target: first !== undefined ? { cardId: first.cardId } : { playerId: g.faces[0]!.playerId }, delayMs, amount, power });
    for (const h of [...g.cards, ...g.faces]) hitAt.set(h.seq, delayMs + contactMs(kind));
    planned.add(sourceId);
  };
  for (const [sourceId, g] of groups) {
    if (planned.has(sourceId)) continue;
    const delayMs = slot++ * RAM_STAGGER_MS;
    const target = g.cards[0]?.cardId;
    const back = target === undefined ? undefined : groups.get(target)?.cards[0]?.cardId;
    if (target !== undefined && back === sourceId && !planned.has(target)) {
      // Two that meet arrive together: both at the pace of the heavier blow.
      const power = Math.max(heaviest(sourceId), heaviest(target));
      strikes(sourceId, 'meet', delayMs, power);
      strikes(target, 'meet', delayMs, power);
    } else strikes(sourceId, target === undefined || !isCreature(target) ? 'charge' : 'strike', delayMs);
  }
  return { rams, hitAt };
}

function battlefieldDamage(view: BoardView): Map<number, { damage: number; ownerId: number }> {
  const out = new Map<number, { damage: number; ownerId: number }>();
  for (const player of view.players) for (const card of player.battlefield) out.set(card.id, { damage: card.damage, ownerId: player.id });
  return out;
}

/**
 * `prev === null` (the first view this module ever sees) diffs to nothing —
 * there is no "before" to compare the opening hand's life totals against,
 * and spawning numbers for the deal-in would be a number for every player at
 * the moment the board first mounts, which nothing changed.
 */
export function diffViews(prev: BoardView | null, next: BoardView): ViewDiff {
  if (prev === null) return NO_DIFF;

  const life: LifeChange[] = [];
  for (const player of next.players) {
    const before = prev.players.find((p) => p.id === player.id);
    if (before !== undefined && before.life !== player.life) life.push({ playerId: player.id, from: before.life, to: player.life });
  }

  const prevDamage = battlefieldDamage(prev);
  const nextDamage = battlefieldDamage(next);
  const damage: DamageChange[] = [];
  for (const [cardId, cur] of nextDamage) {
    const was = prevDamage.get(cardId);
    if (was !== undefined && was.damage !== cur.damage) damage.push({ cardId, ownerId: cur.ownerId, from: was.damage, to: cur.damage });
  }


  const stillOn = new Set(next.stack.map((item) => item.id));
  const resolved = prev.stack.filter((item) => !stillOn.has(item.id));

  // Everywhere the viewer could see a card before: a battlefield, a graveyard, an exile, a hand they
  // see, a library top shown, the stack. A card on a battlefield now and in none of those came from
  // nowhere visible — a hidden hand excepted: a card played from one is the other seat's landing.
  const seen = new Set<number>(prevDamage.keys());
  for (const player of prev.players) {
    for (const card of [...player.graveyard, ...player.exile, ...(player.hand ?? [])]) seen.add(card.id);
    for (const card of player.libraryTop ?? []) seen.add(card.id);
  }
  for (const item of prev.stack) if (item.sourceCardId !== null) seen.add(item.sourceCardId);
  const arrivals: Arrival[] = [];
  // Something made it: a maker Forge names (Kalitas's Zombie in combat damage), or a resolution in
  // this same view. Never a board being set up — a match's opening state, a scenario putting its
  // permanents in place as its libraries fill — which no resolution or maker explains: drawn as
  // arrivals, every card on the table was hidden until its beat and could not be hovered or dragged.
  for (const player of next.players) {
    const before = prev.players.find((p) => p.id === player.id);
    const fromLibrary = before !== undefined && player.libraryCount < before.libraryCount;
    for (const card of player.battlefield) {
      if (seen.has(card.id)) continue;
      const made = card.createdBy !== undefined || (resolved.length > 0 && (card.token || fromLibrary));
      if (made) arrivals.push({ cardId: card.id, source: card.createdBy ?? null });
    }
  }
  const lastHit = Math.max(0, ...(prev.hits ?? []).map((h) => h.seq));
  const nowOnField = new Set(nextDamage.keys());
  const hits = (next.hits ?? []).filter((h) => h.seq > lastHit && (prevDamage.has(h.cardId) || nowOnField.has(h.cardId)));
  const lastFaceHit = Math.max(0, ...(prev.faceHits ?? []).map((h) => h.seq));
  const faceHits = (next.faceHits ?? []).filter((h) => h.seq > lastFaceHit);
  const attackingBefore = new Set(prev.players.flatMap((p) => p.battlefield.filter((c) => c.attacking).map((c) => c.id)));
  const attacks = next.players.filter((p) => !p.isViewer).flatMap((p) => p.battlefield.filter((c) => c.attacking && !attackingBefore.has(c.id)).map((c) => c.id));
  return { life, damage, resolved, arrivals, hits, faceHits, departures: departuresOf(prev, next), attacks };
}

/* ── pure: stacking (simultaneous numbers at one anchor) ─────────────── */

export interface SpawnLayout {
  readonly offsetPx: number;
  readonly delayMs: number;
}

/** `index` is how many numbers are already active at this exact anchor when this one spawns. */
export function stackLayout(index: number): SpawnLayout {
  return { offsetPx: index * STACK_OFFSET_PX, delayMs: index * STACK_STAGGER_MS };
}

/* ── pure: the life counter's steps ───────────────────────────────────── */

/** Every value the counter passes through on its way from `from` to `to`, one per `TICK_STEP_MS` — `to` last, `from` never repeated. Empty when nothing moved. */
export function tickSteps(from: number, to: number): readonly number[] {
  if (from === to) return [];
  const direction = to > from ? 1 : -1;
  const steps: number[] = [];
  for (let v = from + direction; direction > 0 ? v <= to : v >= to; v += direction) steps.push(v);
  return steps;
}

/* ── pure: a change's colour and text ─────────────────────────────────── */

export type NumberColour = 'danger' | 'success';

/** Life: up is a gain, down is a loss — the sign IS the colour. */
export function lifeColour(delta: number): NumberColour {
  return delta < 0 ? 'danger' : 'success';
}

/** `+3` for a gain, `-3` for a loss. */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/* ── the module: finding anchors and drawing into the overlay ────────── */

export interface NumbersHost {
  /** Defaults to the real `prefers-reduced-motion` media query. Injectable for tests and for a host that already tracks it. */
  readonly reducedMotion?: () => boolean;
  /** Defaults to `false` (paced). */
  readonly fastMode?: () => boolean;
  /** Told what each view's beats were (the seat's `effect` client event): one call per view that drew any. */
  readonly report?: (data: Record<string, string | number | boolean>) => void;
  /** A permanent left the battlefield: draw it leaving, from `delayMs` on (`departures.ts`'s `leave`). */
  readonly leave?: (departure: Departure, delayMs: number) => void;
}

export interface NumbersHandle {
  /** Call with every new `BoardView` the board renders — diffs it against the last one seen and spawns whatever changed. */
  /** `revealed` is the last reveal the seat was shown, if any: what gives a resolution its reveal's beat. */
  notify(view: BoardView, revealed?: Revealed): void;
  /**
   * Note where each stack item of `view` is drawn — `notify` does, and a host whose stack layer draws
   * after `notify` (`Board.tsx`: `numbers` decides the beats `placed` reads) calls this again once it has.
   */
  noteStack(view: BoardView): void;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Anything with a box: a live element, or a snapshot of one taken before it left the DOM (`lastSeenBox`, below). */
type Boxed = Element | Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

function boxOf(target: Boxed): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'> {
  return 'getBoundingClientRect' in target ? target.getBoundingClientRect() : target;
}

/** The overlay-relative centre of a box, plus a pixel offset — what every spawn and every drift target is placed in terms of. */
function centreIn(target: Boxed, box: DOMRect, dx = 0, dy = 0): { x: number; y: number } {
  const r = boxOf(target);
  return { x: r.left + r.width / 2 - box.left + dx, y: r.top + r.height / 2 - box.top + dy };
}

export function installNumbers(canvas: HTMLElement, host: NumbersHost = {}): NumbersHandle {
  let live = true;
  let prevView: BoardView | null = null;
  /** How many numbers are currently active at each anchor key — `stackLayout`'s own input, decremented on cleanup. */
  const activeAt = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** When each stack item was first drawn here — a reveal shown after it was put there is its reveal. */
  const firstSeen = new Map<number, number>();
  /** Where each stack item was drawn as of the last view (`placed.ts`'s cards): a resolved one is gone from there by the next. */
  const stackBoxes = new Map<number, DOMRect>();
  /** The marks a beat put on a row card or a face, cleared on dispose. */
  const marked = new Set<Element>();

  const reduced = (): boolean => host.reducedMotion?.() ?? prefersReducedMotion();
  const fast = (): boolean => host.fastMode?.() ?? false;
  /** Each ram drawn, to put back at once on dispose. */
  const rams = new Set<() => void>();
  /** When each creature attacking now was first drawn attacking: how long its attack was seen before it rammed. */
  const attackingSince = new Map<number, number>();
  /** Each shake of the table, likewise. */
  const shakes = new Set<() => void>();

  function overlay(): HTMLElement | null {
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }
  function faceEl(playerId: number): HTMLElement | null {
    return canvas.querySelector<HTMLElement>(`[data-player-face][data-player-id="${playerId}"]`);
  }
  function battlefieldCard(cardId: number): HTMLElement | null {
    return canvas.querySelector<HTMLElement>(`[data-zone="battlefield"] [data-board-card="${cardId}"]`);
  }

  /** The settle of each view's beats still playing: settled at once on dispose, since a board taken down draws nothing more. */
  const playing = new Set<() => void>();

  /**
   * Settles when this view's beats are over: its last beat has come (`lastMs` from now, on the same clock
   * that fires them), and every animation it started on the board has finished — a ram home, a crumble,
   * a number risen — timed by the animations themselves.
   */
  function beatsOver(lastMs: number): Promise<void> {
    return new Promise((resolve) => {
      const settle = (): void => {
        playing.delete(settle);
        resolve();
      };
      playing.add(settle);
      schedule(() => void animationsSettled(canvas).then(settle), lastMs);
    });
  }

  function schedule(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (live) fn();
    }, ms);
    timers.add(timer);
  }

  /** `fn` now when its beat is now — so a beat with nothing before it starts in the frame that caused it — else at its beat. */
  function atBeat(fn: () => void, delayMs: number): void {
    if (delayMs <= 0) fn();
    else schedule(fn, delayMs);
  }

  function bumpActive(key: string, by: 1 | -1): number {
    const next = (activeAt.get(key) ?? 0) + by;
    if (next <= 0) activeAt.delete(key);
    else activeAt.set(key, next);
    return next - by; // the count BEFORE this change — the index a spawn wants
  }

  function spawn(options: {
    anchorKey: string;
    at: Boxed;
    delta: number;
  }): void {
    const root = overlay();
    if (root === null || options.delta === 0) return;
    const box = root.getBoundingClientRect();
    const index = bumpActive(options.anchorKey, 1);
    const layout = stackLayout(index);
    const colour = lifeColour(options.delta);
    const isReduced = reduced();
    const pop = Math.abs(options.delta) >= POP_THRESHOLD;

    const el = document.createElement('div');
    el.className = 'board-number';
    el.setAttribute('aria-hidden', 'true');
    el.dataset.numberColour = colour;
    if (pop && !isReduced) el.dataset.numberPop = '';
    if (isReduced) el.dataset.numberReduced = '';
    el.textContent = formatDelta(options.delta);

    const centre = centreIn(options.at, box, layout.offsetPx);
    el.style.left = `${centre.x}px`;
    el.style.top = `${centre.y}px`;

    const place = (): void => {
      if (!live) return;
      root.append(el);
    };
    if (layout.delayMs > 0) schedule(place, layout.delayMs);
    else place();

    const riseMs = isReduced ? RISE_MS : pop ? POP_MS + RISE_MS : RISE_MS;
    schedule(() => {
      el.remove();
      bumpActive(options.anchorKey, -1);
    }, layout.delayMs + riseMs);
  }

  /** The seat bar's own life span: coloured, and stepped through on its way to what React already rendered there. */
  function animateLifeCounter(playerId: number, from: number, to: number): void {
    const face = faceEl(playerId);
    const lifeSpan = face?.querySelector<HTMLElement>('[data-testid="life"]') ?? null;
    if (lifeSpan === null) return;
    const colour = lifeColour(to - from);
    lifeSpan.dataset.numberLifeColour = colour;
    schedule(() => {
      delete lifeSpan.dataset.numberLifeColour;
    }, LIFE_COLOUR_MS);

    const steps = tickSteps(from, to);
    if (fast() || steps.length === 0) {
      lifeSpan.textContent = String(to);
      return;
    }
    steps.forEach((value, i) => {
      schedule(() => {
        lifeSpan.textContent = String(value);
      }, (i + 1) * TICK_STEP_MS);
    });
  }

  /**
   * The flash a hit leaves on the card it reached, once. Never on a player's avatar: its ring drew as a box,
   * clipped to bars by the seat, around the avatar (the operator, 2026-10-17: "an awkward red box or red
   * bars above/below the avatar when i get hit. can we just get rid of those?") — the impact, the number and
   * the ticking life total are the hit there.
   */
  function flash(target: Element | null, colour: NumberColour): void {
    if (target === null || target.hasAttribute('data-player-face')) return;
    // A card leaving is drawn as its copy (`departures.ts`): the copy's piece flashes, not the empty gap
    // — the piece, so the flash never replaces the copy's own exit animation.
    const leavingId = target.getAttribute(LEAVING_GAP_ATTR);
    const el = (leavingId === null ? null : canvas.querySelector(`[${DEPARTURE_ATTR}="${leavingId}"] .board-departure__piece`)) ?? target;
    el.removeAttribute('data-hit-flash');
    void (el as HTMLElement).offsetWidth;
    el.setAttribute('data-hit-flash', colour);
    marked.add(el);
    schedule(() => el.removeAttribute('data-hit-flash'), HIT_FLASH_MS);
  }

  /** Where a resolving item's effects come from: its source on the battlefield, else where it was drawn on the stack. */
  function sourceOf(item: StackEntry | undefined): Boxed | null {
    if (item === undefined) return null;
    const onField = item.sourceCardId === null ? null : battlefieldCard(item.sourceCardId);
    return onField ?? stackBoxes.get(item.id) ?? null;
  }

  /** Where a revealed card is drawn now: in the reveal notice when it has one, else in its own zone on the board. */
  function revealedCard(cardId: number): Element | null {
    return canvas.ownerDocument.querySelector(`[data-testid="live-reveal"] [data-card-id="${cardId}"]`) ?? canvas.querySelector(`[data-board-card="${cardId}"]`);
  }

  /** The reveal this resolution made, when it arrived while the item was on the stack: where its card is, and how long its beat still runs. */
  function revealOf(item: StackEntry | undefined, revealed: Revealed | undefined): { at: Boxed | null; waitMs: number } | null {
    if (item === undefined || revealed === undefined) return null;
    const put = firstSeen.get(item.id);
    if (put === undefined || revealed.at < put - SAME_PAINT_MS) return null;
    const first = revealed.cardIds[0];
    return { at: first === undefined ? null : revealedCard(first), waitMs: Math.max(0, revealed.at + REVEAL_BEAT_MS - Date.now()) };
  }

  /**
   * A reveal's cards on the board wear {@link REVEAL_BEAT_ATTR} while its beat runs (`board.css`): the card
   * is seen before what it causes. Again on every view inside the beat, since a card that moves (Sorin's
   * revealed top card, into its owner's hand) is a new element where it lands.
   */
  function markReveal(revealed: Revealed | undefined): void {
    if (revealed === undefined) return;
    const left = revealed.at + REVEAL_BEAT_MS - Date.now();
    if (left <= 0) return;
    for (const id of revealed.cardIds) {
      const el = canvas.querySelector(`[data-board-card="${id}"]`);
      if (el === null || el.hasAttribute(REVEAL_BEAT_ATTR)) continue;
      el.setAttribute(REVEAL_BEAT_ATTR, '');
      marked.add(el);
      schedule(() => el.removeAttribute(REVEAL_BEAT_ATTR), left);
    }
  }

  /** One hit: a mark from `from` to `to`, then `land` — at once under reduced motion, where only the flash is drawn. */
  function hit(from: Boxed, to: Element, key: string, colour: NumberColour, delayMs: number, land: () => void, hue: ManaColor | null, amount: number): void {
    const power = damagePower(amount);
    const ms = HIT_MS;
    const root = overlay();
    if (root === null || reduced()) {
      atBeat(() => {
        flash(to, colour);
        land();
      }, delayMs);
      return;
    }
    atBeat(() => {
      if (!to.isConnected) return land();
      const box = root.getBoundingClientRect();
      // A card leaving is drawn as its copy over the kept gap (`departures.ts`): aim at the card, not the gap.
      const leavingId = to.getAttribute(LEAVING_GAP_ATTR);
      const end = centreIn((leavingId === null ? null : root.querySelector(`[${DEPARTURE_ATTR}="${leavingId}"]`)) ?? to, box);
      const look = colour === 'danger' ? 'bolt' : 'heal';
      const ball = fly(root, centreIn(from, box), end, key, look, ms, hue, power);
      schedule(() => {
        ball.remove();
        impact(root, end, look, key, hue, power);
        // A bolt shakes the table as a blow of its damage does: barely until it is heavy (`crash.ts`).
        if (look === 'bolt') shakes.add(shake(canvas, amount, key));
        flash(to, colour);
        land();
      }, ms);
    }, delayMs);
  }

  /**
   * A blow with no projectile (combat damage): a crash where it lands — dust and rocks, not fire — and
   * the table shaking, both as heavy as the damage (`crash.ts`). At `at` when given (where two cards
   * meet), else on `to`.
   */
  function bang(to: Element, key: string, amount: number, at: Point | null = null): void {
    const root = overlay();
    if (root === null || reduced()) return;
    crash(root, at ?? centreIn(to, root.getBoundingClientRect()), damagePower(amount), key);
    shakes.add(shake(canvas, amount, key));
  }

  /** A permanent from nowhere visible travels from `from` into its slot, as a played card lands; in place when there is nowhere to come from. */
  function arrive(cardId: number, source: number | null, from: Boxed | null, delayMs: number): void {
    const el = battlefieldCard(cardId);
    if (el === null) return;
    el.setAttribute(ARRIVING_ATTR, source === null ? '' : String(source));
    marked.add(el);
    const settle = (): void => {
      el.removeAttribute(ARRIVING_ATTR);
      el.removeAttribute(CAST_LANDING_ATTR);
    };
    if (from === null || reduced()) {
      // Fades in where it is (`numbers.css`), from the moment its beat comes.
      el.setAttribute(CAST_LANDING_ATTR, '');
      atBeat(() => {
        el.removeAttribute(CAST_LANDING_ATTR);
        schedule(settle, ARRIVE_FADE_MS);
      }, delayMs);
      return;
    }
    el.setAttribute(CAST_LANDING_ATTR, '');
    atBeat(() => {
      // React may have drawn the row again meanwhile: the card as it is drawn now.
      const now = el.isConnected ? el : battlefieldCard(cardId);
      if (now === null) return settle();
      now.setAttribute(ARRIVING_ATTR, source === null ? '' : String(source));
      marked.add(now);
      now.removeAttribute(CAST_LANDING_ATTR);
      const ghost = parkedGhost(canvas, cardId);
      if (ghost === null) return settle();
      ghost.removeAttribute(ARRIVING_ATTR);
      const r = boxOf(from);
      landCastGhost(canvas, null, ghost, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, now);
      schedule(() => now.removeAttribute(ARRIVING_ATTR), GLIDE_MS);
    }, delayMs);
  }

  /** Where a card's hit lands: its row card, else the gap its row keeps while it leaves. */
  function hitTarget(cardId: number): HTMLElement | null {
    return battlefieldCard(cardId) ?? canvas.querySelector<HTMLElement>(`[${LEAVING_GAP_ATTR}="${cardId}"]`);
  }

  function apply(diff: ViewDiff, before: BoardView | null, revealed: Revealed | undefined): void {
    const item = diff.resolved[0];
    const reveal = revealOf(item, revealed);
    const origin = reveal?.at ?? sourceOf(item);
    const effects =
      diff.life.length + diff.hits.length + diff.departures.length + diff.arrivals.length + diff.damage.filter((c) => c.to > c.from).length > 0;
    // What it does starts at once (a reveal's beat aside); the spell waits on the stack meanwhile and goes last (`placed.ts`).
    const startMs = reveal?.waitMs ?? 0;
    /**
     * A hit is drawn in its spell's colour (the operator, 2026-10-15): the resolving card's first colour,
     * colourless for none — a land's as its sounds take it, from what it makes (2026-10-17: "the source
     * damage for valakut should be red, not colorless"; `sound-events.ts`'s `cardColours`).
     */
    const sourceOnBoard = before?.players.flatMap((pl) => pl.battlefield).find((c) => c.id === item?.sourceCardId);
    const spellHue = item?.sourceCard == null ? null : ((cardColours(item.sourceCard, sourceOnBoard?.choices)[0] as ManaColor | undefined) ?? null);
    let beat = 0;
    const nextDelay = (): number => startMs + beat++ * BEAT_STAGGER_MS;
    /** Bolts go one after another, far enough apart that each one's slam (and the death it causes) reads on its own (the operator, 2026-10-15: "all cards seem to go away at the same time"). */
    let bolt = 0;
    const nextBolt = (): number => startMs + bolt++ * BOLT_STAGGER_MS;
    /** When the last beat drawn so far is over. */
    let endMs = 0;
    const leaving = new Map(diff.departures.map((d) => [d.cardId, d]));
    /** When the hit on each card that is leaving lands: it goes then (the operator: "die when they get impacted"). */
    const fatalLand = new Map<number, number>();
    /** When the first hit on a player lands, this view: its life total's sound waits for it. */
    let firstLifeLand: number | null = null;
    /** When the first hit on a card lands, and when the first permanent starts leaving: the damage and death sounds wait for them. */
    let firstCardImpact: number | null = null;
    let firstExit: number | null = null;
    /** The sounds only this drawing knows the moment of (a charge, a blow, a crack), in ms from now. */
    const sounds: { role: string; ms: number; intensity: number; mine: boolean }[] = [];
    /** Whether `cardId` stood on the viewer's side of the table: whose sound it is. */
    const viewers = (cardId: number): boolean =>
      prevView?.players.some((p) => p.isViewer && p.battlefield.some((c) => c.id === cardId)) === true ||
      diff.departures.some((d) => d.cardId === cardId && prevView?.players.find((p) => p.id === d.playerId)?.isViewer === true);

    /*
     * Combat: each creature rams what it hit (`ram.ts`, `planRams`), and what it hit is hit — the
     * impact, a death, a player's life — as it strikes. Outside a resolution only: what resolved draws
     * its bolts instead. Fast Mode and reduced motion draw no ram, and every hit lands at once.
     */
    // A card struck is a creature if it was one before the blow or still is after (one that died of it is gone after).
    const creatures = new Set([before, prevView].flatMap((v) => v?.players.flatMap((pl) => pl.battlefield.filter((c) => c.card.typeLine.includes('Creature')).map((c) => c.id)) ?? []));
    const combat =
      origin === null && !fast() && !reduced() && overlay() !== null
        ? planRams(diff.hits, diff.faceHits, (id) => leaving.has(id) || battlefieldCard(id) !== null, (id) => creatures.has(id))
        : null;
    /** When the first ram at each player strikes, this view. */
    const charged = new Map<number, number>();
    for (const h of diff.faceHits) {
      const at = combat?.hitAt.get(h.seq);
      if (at !== undefined) charged.set(h.playerId, Math.min(charged.get(h.playerId) ?? at, at));
    }

    for (const change of diff.life) {
      const face = faceEl(change.playerId);
      if (face === null) continue;
      const land = (): void => {
        animateLifeCounter(change.playerId, change.from, change.to);
        spawn({ anchorKey: `face:${change.playerId}`, at: face, delta: change.to - change.from });
      };
      // Until the hit lands, the counter still reads what it read before the resolution (or the ram).
      const span = face.querySelector<HTMLElement>('[data-testid="life"]');
      const rammedAt = charged.get(change.playerId);
      if (rammedAt !== undefined) {
        if (span !== null) span.textContent = String(change.from);
        if (firstLifeLand === null || rammedAt < firstLifeLand) firstLifeLand = rammedAt;
        atBeat(land, rammedAt);
        continue;
      }
      if (origin === null || item === undefined) {
        land();
        continue;
      }
      if (span !== null) span.textContent = String(change.from);
      const delay = nextBolt();
      endMs = Math.max(endMs, delay + HIT_MS);
      if (firstLifeLand === null) firstLifeLand = delay + HIT_MS;
      hit(origin, face, `player:${change.playerId}`, lifeColour(change.to - change.from), delay, land, spellHue, Math.abs(change.to - change.from));
    }
    /*
     * Forge's own hits (`PlayBridge.java`'s `damage`): a creature that took lethal damage is already in
     * its graveyard in this view, so this is the only word that it was hit. From what resolved, else
     * from the source on a battlefield (an attacker, a blocker), else where it lands.
     */
    for (const h of diff.hits) {
      const target = hitTarget(h.cardId);
      if (target === null) continue;
      const departure = leaving.get(h.cardId);
      // No number: the slam is the hit (the operator, 2026-10-15) — what is left of its toughness is the badge's.
      const land = (): void => flash(target, 'danger');
      const key = `card:${h.cardId}:${h.seq}`;
      // A projectile only from what resolved: combat damage is a crash, as its rammer strikes.
      const delay = origin === null ? (combat?.hitAt.get(h.seq) ?? 0) : nextBolt();
      const landsAt = origin === null ? delay : delay + HIT_MS;
      if (departure !== undefined) fatalLand.set(h.cardId, Math.max(fatalLand.get(h.cardId) ?? 0, landsAt));
      if (firstCardImpact === null || landsAt < firstCardImpact) firstCardImpact = landsAt;
      endMs = Math.max(endMs, landsAt);
      if (origin === null) {
        atBeat(() => {
          // A rammed hit's crash is its ram's (below): one per blow, where the two cards meet.
          if (!combat?.hitAt.has(h.seq)) bang(target, key, h.amount);
          land();
        }, delay);
      } else hit(origin, target, key, 'danger', delay, land, spellHue, h.amount);
    }
    let fromMaker = 0;
    for (const arrival of diff.arrivals) {
      const maker = arrival.source === null ? null : battlefieldCard(arrival.source);
      if (maker !== null) fromMaker += 1;
      const delay = nextDelay();
      endMs = Math.max(endMs, delay + GLIDE_MS);
      arrive(arrival.cardId, arrival.source, maker ?? sourceOf(item), delay);
    }
    /*
     * What left the battlefield goes at its beat: what a hit killed the moment that hit lands, everything
     * else (destroyed, sacrificed, exiled) as the effects start.
     */
    for (const dep of diff.departures) {
      // Why it died: Forge's word, else a hit drawn here killed it, else unknown (`departures.ts`'s `exitMotionFor`).
      const said = prevView?.deathCauses?.get(dep.cardId);
      const cause = said !== undefined ? departureCause(said) : fatalLand.has(dep.cardId) ? 'damage' : undefined;
      const departure: Departure = { ...dep, ...(cause === undefined ? {} : { cause }), ...(spellHue === null ? {} : { hue: spellHue }) };
      const delay = fast() ? 0 : (fatalLand.get(departure.cardId) ?? startMs);
      if (firstExit === null || delay < firstExit) firstExit = delay;
      endMs = Math.max(endMs, delay + exitMs(departure));
      host.leave?.(departure, delay);
      if (exitMotionFor(departure) === 'shatter') {
        const killedBy = Math.max(0, ...diff.hits.filter((h) => h.cardId === departure.cardId).map((h) => h.amount));
        sounds.push({ role: 'g.crumble', ms: delay, intensity: damagePower(killedBy), mine: viewers(departure.cardId) });
      }
    }
    // After the departures: a creature that died in the fight rams as its departure's stand-in.
    const root = overlay();
    const rammers = new Set((combat?.rams ?? []).map((r) => r.sourceId));
    // The chargers form up together, at the first one's start, in a fan around the player or the card each attacks.
    const chargers = (combat?.rams ?? []).filter((r) => r.kind === 'charge');
    const chargeStart = chargers.length === 0 ? 0 : Math.min(...chargers.map((r) => r.delayMs));
    const fanned = new Map<number, Point>();
    const struckEl = (target: RamPlan['target']): HTMLElement | null =>
      'playerId' in target ? faceEl(target.playerId) : (root?.querySelector<HTMLElement>(`[${DEPARTURE_ATTR}="${target.cardId}"]`) ?? hitTarget(target.cardId));
    const packOf = (target: RamPlan['target']): string => ('playerId' in target ? `fan:${target.playerId}` : `fan:card:${target.cardId}`);
    if (root !== null) {
      const packs = new Map<string, RamPlan[]>();
      for (const r of chargers) packs.set(packOf(r.target), [...(packs.get(packOf(r.target)) ?? []), r]);
      for (const [key, members] of packs) {
        const at = struckEl(members[0]!.target);
        const boxes = members.map((r) => root.querySelector<HTMLElement>(`[${DEPARTURE_ATTR}="${r.sourceId}"]`) ?? battlefieldCard(r.sourceId));
        if (at === null || boxes.some((b) => b === null)) continue;
        const spots = fanOf(boxes.map((b) => boxIn(b!, root)), boxIn(at, root), key, boxIn(root, root));
        members.forEach((r, i) => fanned.set(r.sourceId, spots[i]!));
      }
    }
    const keep = (cancel: () => void, untilMs: number): void => {
      rams.add(cancel);
      schedule(() => rams.delete(cancel), untilMs);
      endMs = Math.max(endMs, untilMs);
    };
    /** The rams drawn, and the least time a rammer's attack had been on screen when its ram set off (-1 for none). */
    let ramsDrawn = 0;
    let attackLeadMs = -1;
    for (const plan of combat?.rams ?? []) {
      const source = root?.querySelector<HTMLElement>(`[${DEPARTURE_ATTR}="${plan.sourceId}"]`) ?? battlefieldCard(plan.sourceId);
      const struck = 'cardId' in plan.target ? plan.target.cardId : null;
      const target = struckEl(plan.target);
      if (root === null || source === null || target === null) continue;
      ramsDrawn += 1;
      const lead = Date.now() + plan.delayMs - (attackingSince.get(plan.sourceId) ?? Date.now());
      attackLeadMs = attackLeadMs === -1 ? lead : Math.min(attackLeadMs, lead);
      const end = ramEnd(plan.kind, leaving.has(plan.sourceId), struck !== null && leaving.has(struck));
      const from = boxIn(source, root);
      const to = boxIn(target, root);
      // The blow: one crash per ram (a pair that meets is one blow), where the cards meet, or on the avatar.
      const partnerFirst = plan.kind === 'meet' && (combat?.rams ?? []).indexOf(plan) > (combat?.rams ?? []).findIndex((r) => r.sourceId === struck);
      if (!partnerFirst) {
        const strike = strikeOffset(from, to, plan.kind);
        const hitPoint = plan.kind === 'charge' ? to : { x: (from.x + strike.x + to.x) / 2, y: (from.y + strike.y + to.y) / 2 };
        const at = plan.kind === 'meet' ? { x: from.x + strike.x, y: from.y + strike.y } : hitPoint;
        atBeat(() => bang(target, `crash:${plan.sourceId}`, plan.amount, at), plan.delayMs + contactMs(plan.kind));
        sounds.push({ role: 'g.crash', ms: plan.delayMs + contactMs(plan.kind), intensity: plan.power, mine: viewers(plan.sourceId) });
      }
      if (plan.kind === 'charge') sounds.push({ role: 'g.charge', ms: plan.delayMs + ALIGN_MS, intensity: plan.power, mine: viewers(plan.sourceId) });
      // Blasted as hard as what struck it hit: its partner's power when they met.
      const struckBy = (combat?.rams ?? []).find((r) => 'cardId' in r.target && r.target.cardId === plan.sourceId)?.power ?? plan.power;
      keep(
        ram(root, source, to, plan.kind, end, `ram:${plan.sourceId}`, plan.delayMs, plan.power, struckBy, { start: plan.kind === 'charge' ? chargeStart : plan.delayMs, at: fanned.get(plan.sourceId) ?? null }),
        plan.delayMs + ramMs(plan.kind, end),
      );
      // A creature killed by a blow it did not ram back into is blasted away from the one that struck it.
      if (struck !== null && !rammers.has(struck) && leaving.has(struck)) {
        const contact = plan.delayMs + contactMs(plan.kind);
        keep(blast(root, target, from, `blast:${struck}`, contact, plan.power), contact + BLAST_MS);
      }
    }
    if (prevView !== null && firstCardImpact !== null) noteCardImpact(prevView.seq, Date.now() + firstCardImpact);
    if (prevView !== null) noteBoardSounds(prevView.seq, sounds.map((s) => ({ role: s.role, at: Date.now() + s.ms, intensity: s.intensity, mine: s.mine })));
    if (prevView !== null && firstExit !== null) noteExitBeat(prevView.seq, Date.now() + firstExit);
    if (item !== undefined && effects) noteResolutionEffects(item.id, Date.now() + Math.max(endMs, startMs));
    // The other seat's attack is seen before anything after it is drawn (`live/pace.ts` waits on this beat).
    if (diff.attacks.length > 0 && !fast()) {
      endMs = Math.max(endMs, ATTACK_BEAT_MS);
      host.report?.({ what: 'attack', attackers: diff.attacks.length, beatMs: ATTACK_BEAT_MS });
    }
    if (endMs > 0) noteBoardDrawing(beatsOver(endMs));
    if (firstLifeLand !== null && prevView !== null) noteLifeImpact(prevView.seq, Date.now() + firstLifeLand);
    if (beat > 0 || bolt > 0 || reveal !== null || diff.departures.length > 0 || (combat?.rams.length ?? 0) > 0) {
      host.report?.({
        what: 'beats',
        resolved: item?.id ?? -1,
        source: item?.sourceCardId ?? -1,
        reveal: reveal !== null,
        revealWaitMs: Math.round(startMs),
        from: reveal !== null ? 'reveal' : origin === null ? 'none' : 'source',
        hits: bolt,
        forgeHits: diff.hits.length,
        rams: combat?.rams.length ?? 0,
        ramsDrawn,
        attackLeadMs: Math.round(attackLeadMs),
        arrivals: diff.arrivals.length,
        fromMaker,
        departures: diff.departures.length,
        totalMs: Math.round(endMs),
        motion: !reduced(),
      });
    }
  }

  /** What the next view's diff reads of this one's stack: when each item was first drawn, and where. */
  function noteStack(view: BoardView): void {
    const now = Date.now();
    const ids = new Set(view.stack.map((item) => item.id));
    for (const id of ids) if (!firstSeen.has(id)) firstSeen.set(id, now);
    for (const id of [...firstSeen.keys()]) if (!ids.has(id)) firstSeen.delete(id);
    stackBoxes.clear();
    for (const el of canvas.querySelectorAll<HTMLElement>('[data-placed-spell]:not([data-placed-leaving])')) {
      const id = Number(el.getAttribute('data-placed-spell'));
      if (Number.isFinite(id)) stackBoxes.set(id, el.getBoundingClientRect());
    }
  }

  return {
    notify(view: BoardView, revealed?: Revealed) {
      if (!live) return;
      const before = prevView;
      const diff = diffViews(before, view);
      prevView = view;
      apply(diff, before, revealed);
      markReveal(revealed);
      noteStack(view);
      const attacking = new Set(view.players.flatMap((p) => p.battlefield.filter((c) => c.attacking).map((c) => c.id)));
      for (const id of attackingSince.keys()) if (!attacking.has(id)) attackingSince.delete(id);
      for (const id of attacking) if (!attackingSince.has(id)) attackingSince.set(id, Date.now());
    },
    noteStack(view: BoardView) {
      if (live) noteStack(view);
    },
    dispose() {
      live = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const settle of [...playing]) settle();
      for (const cancel of rams) cancel();
      rams.clear();
      for (const cancel of shakes) cancel();
      shakes.clear();
      overlay()
        ?.querySelectorAll('.board-number')
        .forEach((el) => el.remove());
      // The colour sits on the seat bar's own life span, outside the overlay —
      // the one piece of this module that reaches into markup it does not own.
      canvas.querySelectorAll<HTMLElement>('[data-testid="life"][data-number-life-colour]').forEach((el) => {
        delete el.dataset.numberLifeColour;
      });
      overlay()
        ?.querySelectorAll('.effect-hit, .effect-hit-ember, .effect-impact')
        .forEach((el) => el.remove());
      for (const el of marked) {
        el.removeAttribute('data-hit-flash');
        el.removeAttribute(ARRIVING_ATTR);
        el.removeAttribute(REVEAL_BEAT_ATTR);
      }
      marked.clear();
    },
  };
}
