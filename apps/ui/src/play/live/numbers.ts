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
 *  1. a reveal first — when the reveal notice (`../prompts/RevealNotice.tsx`)
 *     was drawn while that item was on the stack, nothing below starts until
 *     its beat (`REVEAL_BEAT_MS`) is over, and its card is where the hits
 *     come from;
 *  2. each hit — a player's life or a creature's damage moving — travels from
 *     that card (else the resolving item's source on the battlefield, else
 *     where the item was drawn on the stack) to its target as a
 *     `[data-hit]` mark over `HIT_MS`, staggered `BEAT_STAGGER_MS`; the target
 *     flashes (`data-hit-flash`) and only then does its number rise and its
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
 */

import type { ManaColor } from '@hadoku/shared';

import type { BoardView, DamageHit, StackEntry } from '../adapter.ts';
import { BEAT_STAGGER_MS, BOLT_STAGGER_MS, GLIDE_MS, HIT_MS, lastRevealBeat, noteResolutionEffects, REVEAL_BEAT_MS } from '../motion.ts';
import { DEPARTURE_ATTR, departureCause, departuresOf, exitMs, LEAVING_GAP_ATTR, type Departure } from './departures.ts';
import { fly, impact } from './projectile.ts';
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
  /** The permanents that left every battlefield in this view (`departures.ts`). */
  readonly departures: readonly Departure[];
}

const NO_DIFF: ViewDiff = { life: [], damage: [], resolved: [], arrivals: [], hits: [], departures: [] };

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
    if (player.libraryTop !== undefined) seen.add(player.libraryTop.id);
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
  return { life, damage, resolved, arrivals, hits, departures: departuresOf(prev, next) };
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
  notify(view: BoardView): void;
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

  function overlay(): HTMLElement | null {
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }
  function faceEl(playerId: number): HTMLElement | null {
    return canvas.querySelector<HTMLElement>(`[data-player-face][data-player-id="${playerId}"]`);
  }
  function battlefieldCard(cardId: number): HTMLElement | null {
    return canvas.querySelector<HTMLElement>(`[data-zone="battlefield"] [data-board-card="${cardId}"]`);
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

  /** The flash a hit leaves on what it reached (a face, a card), once. */
  function flash(target: Element | null, colour: NumberColour): void {
    if (target === null) return;
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

  /** The reveal this resolution made, when its notice was drawn while the item was on the stack: the card, and how long its beat still runs. */
  function revealOf(item: StackEntry | undefined): { at: Boxed; waitMs: number } | null {
    const beat = lastRevealBeat();
    if (item === undefined || beat === null) return null;
    const put = firstSeen.get(item.id);
    if (put === undefined || beat.at < put - SAME_PAINT_MS) return null;
    const at = beat.card?.isConnected === true ? beat.card : beat.box;
    if (at === null) return null;
    return { at, waitMs: Math.max(0, beat.at + REVEAL_BEAT_MS - Date.now()) };
  }

  /** One hit: a mark from `from` to `to`, then `land` — at once under reduced motion, where only the flash is drawn. */
  function hit(from: Boxed, to: Element, key: string, colour: NumberColour, delayMs: number, land: () => void, hue: ManaColor | null = null): void {
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
      const ball = fly(root, centreIn(from, box), end, key, look, HIT_MS, hue);
      schedule(() => {
        ball.remove();
        impact(root, end, look, key, hue);
        flash(to, colour);
        land();
      }, HIT_MS);
    }, delayMs);
  }

  /** The impact alone, where `to` is — a hit with no projectile (combat damage). */
  function slam(to: Element, key: string, hue: ManaColor | null): void {
    const root = overlay();
    if (root === null || reduced()) return;
    impact(root, centreIn(to, root.getBoundingClientRect()), 'bolt', key, hue);
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

  function apply(diff: ViewDiff): void {
    const item = diff.resolved[0];
    const reveal = revealOf(item);
    const origin = reveal?.at ?? sourceOf(item);
    const effects =
      diff.life.length + diff.hits.length + diff.departures.length + diff.arrivals.length + diff.damage.filter((c) => c.to > c.from).length > 0;
    // What it does starts at once (a reveal's beat aside); the spell waits on the stack meanwhile and goes last (`placed.ts`).
    const startMs = reveal?.waitMs ?? 0;
    /** A hit is drawn in its spell's colour (the operator, 2026-10-15): the resolving card's first colour, colourless for none. */
    const spellHue = item?.sourceCard?.colors[0] ?? null;
    let beat = 0;
    const nextDelay = (): number => startMs + beat++ * BEAT_STAGGER_MS;
    /** Bolts go one after another, far enough apart that each one's slam (and the death it causes) reads on its own (the operator, 2026-10-15: "all cards seem to go away at the same time"). */
    let bolt = 0;
    const nextBolt = (): number => startMs + bolt++ * BOLT_STAGGER_MS;
    /** When the last beat drawn so far is over. */
    let endMs = 0;
    const leaving = new Map(diff.departures.map((d) => [d.cardId, d]));
    /** Each permanent's first colour — on a battlefield now, or just gone from one — for a hit with no spell behind it (combat). */
    const hueOn = new Map<number, ManaColor>();
    for (const card of [...(prevView?.players.flatMap((p) => p.battlefield) ?? []), ...diff.departures.map((d) => d.card)]) {
      const first = card.card.colors[0];
      if (first !== undefined) hueOn.set(card.id, first);
    }
    /** When the hit on each card that is leaving lands: it goes then (the operator: "die when they get impacted"). */
    const fatalLand = new Map<number, number>();

    for (const change of diff.life) {
      const face = faceEl(change.playerId);
      if (face === null) continue;
      const land = (): void => {
        animateLifeCounter(change.playerId, change.from, change.to);
        spawn({ anchorKey: `face:${change.playerId}`, at: face, delta: change.to - change.from });
      };
      if (origin === null || item === undefined) {
        land();
        continue;
      }
      // Until the hit lands, the counter still reads what it read before the resolution.
      const span = face.querySelector<HTMLElement>('[data-testid="life"]');
      if (span !== null) span.textContent = String(change.from);
      const delay = nextBolt();
      endMs = Math.max(endMs, delay + HIT_MS);
      hit(origin, face, `player:${change.playerId}`, lifeColour(change.to - change.from), delay, land, spellHue);
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
      // A projectile only from what resolved: combat damage is the impact alone, never a ball between two creatures.
      const delay = origin === null ? 0 : nextBolt();
      const landsAt = origin === null ? delay : delay + HIT_MS;
      if (departure !== undefined) fatalLand.set(h.cardId, Math.max(fatalLand.get(h.cardId) ?? 0, landsAt));
      endMs = Math.max(endMs, landsAt);
      if (origin === null) {
        slam(target, key, h.sourceId === null ? null : (hueOn.get(h.sourceId) ?? null));
        land();
      } else hit(origin, target, key, 'danger', delay, land, spellHue);
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
      const departure: Departure = cause === undefined ? dep : { ...dep, cause };
      const delay = fast() ? 0 : (fatalLand.get(departure.cardId) ?? startMs);
      endMs = Math.max(endMs, delay + exitMs(departure));
      host.leave?.(departure, delay);
    }
    if (item !== undefined && effects) noteResolutionEffects(item.id, Date.now() + Math.max(endMs, startMs));
    if (beat > 0 || bolt > 0 || reveal !== null || diff.departures.length > 0) {
      host.report?.({
        what: 'beats',
        resolved: item?.id ?? -1,
        source: item?.sourceCardId ?? -1,
        reveal: reveal !== null,
        revealWaitMs: Math.round(startMs),
        from: reveal !== null ? 'reveal' : origin === null ? 'none' : 'source',
        hits: bolt,
        forgeHits: diff.hits.length,
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
    notify(view: BoardView) {
      if (!live) return;
      const diff = diffViews(prevView, view);
      prevView = view;
      apply(diff);
      noteStack(view);
    },
    noteStack(view: BoardView) {
      if (live) noteStack(view);
    },
    dispose() {
      live = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
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
      }
      marked.clear();
    },
  };
}
