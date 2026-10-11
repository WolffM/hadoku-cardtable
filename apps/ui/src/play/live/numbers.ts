/*
 * Floating combat numbers: life changing at a seat's face, damage changing at
 * a creature's power/toughness corner. Approved design:
 * https://claude.ai/artifact/BZGfndqa4MeDCDrDwDdCvn — four artboards (damage
 * to a player, life gain with stacking, damage on a creature that survives or
 * dies, and the 700ms timeline). The rules below restate it so this module
 * needs no link to read.
 *
 * ## What spawns, and from what
 *
 * Every call to `notify(view)` diffs the new view against the one before it
 * (`diffViews`, pure — no DOM, unit-tested on hand-built views): a player
 * whose `life` moved, a battlefield creature whose `damage` moved, and a
 * creature that was on a battlefield and is now in a graveyard (it died).
 * Nothing spawns from a click or a local guess — only from what the view
 * itself says changed, so the two seats' screens draw the same numbers from
 * the same facts, at mirrored positions, by construction.
 *
 * ## Where it lands
 *
 * A life number lands on `[data-player-face][data-player-id="<id>"]`
 * (`Board.tsx`'s own face markup; `data-viewer` on that element is also how
 * this module tells a graveyard's owner apart — `you` or `them`). A damage
 * number lands on that card's `.board-card__pt` — the same badge
 * `PowerToughness` already draws, which is where damage that STAYS is drawn
 * (what is left of the toughness, in the danger ink, until cleanup); this
 * module draws only the TRANSIENT number, never the badge itself, which is
 * React's and stays exactly as it is.
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
 * ## Dying
 *
 * A creature that dies still gets its damage number — the hit that killed it
 * is a `DamageChange` like any other, read while the card was still on the
 * battlefield in `prev`. At the number's OWN halfway point
 * (`DEATH_FADE_START_MS`, half of `RISE_MS`) it stops rising in place and
 * instead drifts to its owner's graveyard pile while fading, over
 * `DEATH_FADE_MS`. One element does both halves of its life; nothing extra is
 * drawn.
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
 */

import type { BoardView } from '../adapter.ts';
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
/** Half of `RISE_MS` — the number's own halfway point, where a dying creature's number turns toward the graveyard. */
export const DEATH_FADE_START_MS = RISE_MS / 2;
export const DEATH_FADE_MS = 420;

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

/**
 * A battlefield creature that is no longer on any battlefield and is now, in
 * the SAME view, sitting in a graveyard. `damage` is what it carried the last
 * time it was seen alive — the fatal blow, when it was damage that killed it;
 * `0` for anything else (destroyed outright, sacrificed, bounced-then-not —
 * `installNumbers` draws no number for those, the same "nothing for 0" rule
 * every other change follows).
 */
export interface DeathChange {
  readonly cardId: number;
  readonly ownerId: number;
  readonly damage: number;
}

export interface ViewDiff {
  readonly life: readonly LifeChange[];
  readonly damage: readonly DamageChange[];
  readonly deaths: readonly DeathChange[];
}

function battlefieldDamage(view: BoardView): Map<number, { damage: number; ownerId: number }> {
  const out = new Map<number, { damage: number; ownerId: number }>();
  for (const player of view.players) for (const card of player.battlefield) out.set(card.id, { damage: card.damage, ownerId: player.id });
  return out;
}

function graveyardOwners(view: BoardView): Map<number, number> {
  const out = new Map<number, number>();
  for (const player of view.players) for (const card of player.graveyard) out.set(card.id, player.id);
  return out;
}

/**
 * `prev === null` (the first view this module ever sees) diffs to nothing —
 * there is no "before" to compare the opening hand's life totals against,
 * and spawning numbers for the deal-in would be a number for every player at
 * the moment the board first mounts, which nothing changed.
 */
export function diffViews(prev: BoardView | null, next: BoardView): ViewDiff {
  if (prev === null) return { life: [], damage: [], deaths: [] };

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

  const nowInGraveyard = graveyardOwners(next);
  const deaths: DeathChange[] = [];
  for (const [cardId, was] of prevDamage) {
    if (nextDamage.has(cardId)) continue; // still on a battlefield — not a death
    const ownerId = nowInGraveyard.get(cardId);
    if (ownerId !== undefined) deaths.push({ cardId, ownerId, damage: was.damage });
  }
  return { life, damage, deaths };
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

/** `+3` for a gain, `-3` for a loss — life's delta read directly; damage's delta flipped, because MORE damage marked is drawn as a loss. */
export function formatDelta(delta: number, kind: 'life' | 'damage'): string {
  const signed = kind === 'damage' ? -delta : delta;
  return signed > 0 ? `+${signed}` : `${signed}`;
}

/* ── the module: finding anchors and drawing into the overlay ────────── */

export interface NumbersHost {
  /** Defaults to the real `prefers-reduced-motion` media query. Injectable for tests and for a host that already tracks it. */
  readonly reducedMotion?: () => boolean;
  /** Defaults to `false` (paced). */
  readonly fastMode?: () => boolean;
}

export interface NumbersHandle {
  /** Call with every new `BoardView` the board renders — diffs it against the last one seen and spawns whatever changed. */
  notify(view: BoardView): void;
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
  /**
   * Every damaged creature's P/T corner, in VIEWPORT coordinates, as of the
   * last view that still had it on a battlefield. A dying creature has
   * already been removed from the DOM by the time its `DeathChange` arrives
   * — `boardCard__pt` is drawn `onBattlefield` only — so this is the one
   * thing that survives past the element itself. Written every time a
   * `DamageChange` is applied; read, once, by the death it may precede.
   */
  const lastSeenBox = new Map<number, DOMRect>();

  const reduced = (): boolean => host.reducedMotion?.() ?? prefersReducedMotion();
  const fast = (): boolean => host.fastMode?.() ?? false;

  function overlay(): HTMLElement | null {
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }
  function faceEl(playerId: number): HTMLElement | null {
    return canvas.querySelector<HTMLElement>(`[data-player-face][data-player-id="${playerId}"]`);
  }
  function ptEl(cardId: number): HTMLElement | null {
    return canvas.querySelector<HTMLElement>(`[data-card-id="${cardId}"] .board-card__pt`);
  }
  /** `you`/`them`, off the face this view already marks — never a second source for the same fact. */
  function ownerOf(playerId: number): 'you' | 'them' {
    return faceEl(playerId)?.hasAttribute('data-viewer') === true ? 'you' : 'them';
  }
  function graveyardEl(ownerId: number): HTMLElement | null {
    return canvas.querySelector<HTMLElement>(`[data-zone="graveyard"][data-owner="${ownerOf(ownerId)}"]`);
  }

  function schedule(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (live) fn();
    }, ms);
    timers.add(timer);
  }

  function bumpActive(key: string, by: 1 | -1): number {
    const next = (activeAt.get(key) ?? 0) + by;
    if (next <= 0) activeAt.delete(key);
    else activeAt.set(key, next);
    return next - by; // the count BEFORE this change — the index a spawn wants
  }

  /** Drift a dying number's own element to its owner's graveyard, fading it out — the second half of its one lifetime. */
  function turnToGraveyard(el: HTMLElement, box: DOMRect, ownerId: number): void {
    const grave = graveyardEl(ownerId);
    if (grave === null) return; // no graveyard to aim at — the number simply finishes its ordinary rise-and-fade instead
    const from = { x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) };
    const to = centreIn(grave, box);
    el.style.setProperty('--number-dx', `${to.x - from.x}px`);
    el.style.setProperty('--number-dy', `${to.y - from.y}px`);
    el.dataset.numberDying = '';
  }

  function spawn(options: {
    anchorKey: string;
    at: Boxed;
    kind: 'life' | 'damage';
    delta: number;
    dying?: { ownerId: number };
  }): void {
    const root = overlay();
    if (root === null || options.delta === 0) return;
    const box = root.getBoundingClientRect();
    const index = bumpActive(options.anchorKey, 1);
    const layout = stackLayout(index);
    // Damage only ever spawns a number for a HIT (a decrease — a cleanup wipe — never spawns one,
    // below): `lifeColour` is the only sign-dependent colour left.
    const colour = options.kind === 'life' ? lifeColour(options.delta) : 'danger';
    const isReduced = reduced();
    const pop = Math.abs(options.delta) >= POP_THRESHOLD;

    const el = document.createElement('div');
    el.className = 'board-number';
    el.setAttribute('aria-hidden', 'true');
    el.dataset.numberColour = colour;
    if (pop && !isReduced) el.dataset.numberPop = '';
    if (isReduced) el.dataset.numberReduced = '';
    el.textContent = formatDelta(options.delta, options.kind);

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
    const dying = options.dying;
    if (dying !== undefined && !isReduced) {
      // The halfway point is the RISE's own, which starts after the pop (if any) — so the pop's own
      // length counts toward it too, or a popped death would turn toward the graveyard before it had
      // even started rising.
      const halfway = (pop ? POP_MS : 0) + DEATH_FADE_START_MS;
      schedule(() => turnToGraveyard(el, box, dying.ownerId), layout.delayMs + halfway);
      schedule(() => {
        el.remove();
        bumpActive(options.anchorKey, -1);
      }, layout.delayMs + halfway + DEATH_FADE_MS);
    } else {
      schedule(() => {
        el.remove();
        bumpActive(options.anchorKey, -1);
      }, layout.delayMs + riseMs);
    }
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

  function apply(diff: ViewDiff): void {
    for (const change of diff.life) {
      animateLifeCounter(change.playerId, change.from, change.to);
      const face = faceEl(change.playerId);
      if (face !== null) spawn({ anchorKey: `face:${change.playerId}`, at: face, kind: 'life', delta: change.to - change.from });
    }
    for (const change of diff.damage) {
      const at = ptEl(change.cardId);
      if (at === null) continue;
      lastSeenBox.set(change.cardId, at.getBoundingClientRect());
      const delta = change.to - change.from;
      // A decrease is a cleanup wipe, never a hit: not an event of its own — the badge already
      // reads less (or no) damage marked now.
      if (delta <= 0) continue;
      spawn({ anchorKey: `card:${change.cardId}`, at, kind: 'damage', delta });
    }
    for (const death of diff.deaths) {
      // "Nothing for 0": destroyed outright, sacrificed, or simply left the
      // battlefield with no damage marked draws no number — there is nothing
      // to say and nowhere this module ever saw it hit from.
      if (death.damage <= 0) continue;
      const box = lastSeenBox.get(death.cardId);
      lastSeenBox.delete(death.cardId);
      if (box === undefined) continue;
      spawn({
        anchorKey: `card:${death.cardId}`,
        at: box,
        kind: 'damage',
        delta: death.damage,
        dying: { ownerId: death.ownerId },
      });
    }
  }

  return {
    notify(view: BoardView) {
      if (!live) return;
      const diff = diffViews(prevView, view);
      prevView = view;
      apply(diff);
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
    },
  };
}
