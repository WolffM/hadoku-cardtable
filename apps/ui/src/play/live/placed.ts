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
 * Four exports, typed and fixed for the whole wave — W calls them and never
 * draws:
 *
 *   - `placeSpell(id, at, side)` — a release (the park, `gestures/install.ts`)
 *     or an opponent's spell becoming known registers a point. `id` is
 *     whatever id the caller has AT THAT MOMENT: the caster's own release
 *     happens before Forge has pushed a stack item at all, so it is called
 *     with the CARD's id (`StackEntry.sourceCardId`'s own namespace — the
 *     same id a card keeps from hand to stack to battlefield). `notify`
 *     below promotes that registration onto the stack item's own `id` the
 *     moment a matching entry appears in `view.stack`, so every call after
 *     that — a drag's `moveSpell`, lane W's `commitSpell` — addresses the
 *     same record by the stack id.
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
 *   - `.placed__arrow[data-for="<item.id>"]` — one per target the item has
 *     (`aimAt`, `gestures/arrow.ts`, reused exactly as Settled requires — no
 *     second geometry), redrawn on every `notify` and on every `moveSpell`
 *     (item 8's other mutation point — see `registerRepaint`/`afterChange`
 *     below, the one place that call happens, so it is the one place a
 *     mutant can drop it).
 */
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CardTile } from '../../components/CardTile.tsx';
import { cardImageUrl } from '../../draft/cardImage.ts';
import { RulesText } from '../prompts/RulesText.tsx';
import type { BoardView, StackEntry } from '../adapter.ts';
import { aimAt, newArrow, positionArrow } from './gestures/arrow.ts';
import { cardBox, centreOf, faceBox } from './gestures/targets.ts';
import type { Point } from './gestures/types.ts';
import './placed.css';

export type { Point };

/** How long a resolve-away fade (decision c) takes. Reduced motion skips straight to it. */
export const LEAVE_FADE_MS = 250;

/** A placement nobody ever promoted (a land, a cancelled cast) is forgotten after this long. */
const PENDING_TTL_MS = 12_000;
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
  /** `Date.now()` when this was registered, so an unmatched one can expire — see `PENDING_TTL_MS`. */
  readonly registeredAt: number;
}

/** One record per spell, module-level so `gestures/install.ts` and lane W's `presence.ts` can reach it without a React tree. */
const placements = new Map<number, Placement>();
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

/**
 * Register (or move) a spell's point. See the module header for what `id`
 * means at this call. A fresh `id` starts `committed` on `side === 'you'`
 * (the owner always knows their own card) and face-down otherwise — lane W's
 * `commitSpell` turns it over once the opponent's spell is public.
 */
export function placeSpell(id: number, at: Point, side: 'you' | 'them'): void {
  const existing = placements.get(id);
  placements.set(id, { at, side, committed: existing?.committed ?? side === 'you', registeredAt: existing?.registeredAt ?? Date.now() });
  requestRepaint();
}

/** Whether `id` has a registered point (a placed spell, or an ability the viewer has moved). */
export function isPlaced(id: number): boolean {
  return placements.has(id);
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
  const p = placements.get(id);
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

/** Test-only: drop every placement, so one test's ids never leak into the next. */
export function forgetPlacements(): void {
  placements.clear();
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
 * edge. `width` is the ephemeral tile's own width, read off the source's box
 * as the best available estimate before the tile itself exists.
 */
export function besideSource(sourceBox: Rect, taken: readonly Rect[]): Point {
  const width = sourceBox.right - sourceBox.left;
  const height = sourceBox.bottom - sourceBox.top;
  let left = sourceBox.right + BESIDE_GAP;
  for (const box of taken) {
    const sameRow = Math.abs(box.top - sourceBox.top) < height;
    if (sameRow && left < box.right + BESIDE_GAP) left = box.right + BESIDE_GAP;
  }
  return { x: left + width / 2, y: sourceBox.top + height / 2 };
}

/* ── installPlaced: the DOM ───────────────────────────────────────────── */

export interface PlacedHost {
  /** Defaults to the real `prefers-reduced-motion` media query. */
  readonly reducedMotion?: () => boolean;
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

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Drawn {
  readonly el: HTMLElement;
  /** Null for a back (no `CardTile` to mount) and for the no-card-data text fallback. */
  root: Root | null;
  committed: boolean;
  isAbility: boolean;
  /** The underlying card's id, remembered from when this was drawn — `view.stack` no longer has it once the item is gone. */
  readonly sourceCardId: number | null;
  leaving: boolean;
  /** AE26: hidden until a registration arrives or the window closes — see `PLACED_PENDING_MS`. */
  pendingUntil: number | null;
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
  if (item.isAbility) return abilityChip(item);
  return item.sourceCard === null ? null : createElement(CardTile, { card: item.sourceCard });
}

/**
 * AE29 (the operator, 2026-10-09: "ability chip is the correct thing to do"): a triggered or
 * activated ability on the stack is an EFFECT of its card, never a second copy of it — half a card
 * tall, the source's art as a band with its name, the ability's own text beneath, rounded, no frame,
 * an accent glow. Mock-up: the operator's `ae29-options.html`, option 1.
 */
function abilityChip(item: StackEntry): ReactElement {
  const art = item.sourceCard === null ? null : cardImageUrl(item.sourceCard.scryfallId);
  const name = item.sourceName ?? item.sourceCard?.name ?? '';
  // Forge's description leads with the source's own name ("Eternal Witness - When …"): the band says that already.
  const text = name !== '' && item.description.startsWith(`${name} - `) ? item.description.slice(name.length + 3) : item.description;
  return createElement(
    'div',
    { className: 'placed__chip', 'data-ability-chip': '' },
    createElement(
      'div',
      { className: 'placed__chip-band' },
      art === null ? null : createElement('img', { className: 'placed__chip-art', src: art, alt: '', 'aria-hidden': 'true', draggable: false }),
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
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const reduced = (): boolean => host.reducedMotion?.() ?? prefersReducedMotion();
  const overlay = (): HTMLElement | null => canvas.querySelector<HTMLElement>('[data-board-overlay]');

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
      const pending = placements.get(item.sourceCardId);
      if (pending === undefined) continue;
      placements.delete(item.sourceCardId);
      placements.set(item.id, pending);
    }
  }

  /** Prune a never-promoted placement once it has sat unmatched past its TTL — a land, a cancelled cast. */
  function pruneStale(items: readonly StackEntry[]): void {
    const sourceIds = new Set(items.map((i) => i.sourceCardId).filter((id): id is number => id !== null));
    const itemIds = new Set(items.map((i) => i.id));
    const now = Date.now();
    for (const [id, p] of placements) {
      if (itemIds.has(id) || sourceIds.has(id)) continue;
      if (now - p.registeredAt > PENDING_TTL_MS) placements.delete(id);
    }
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
    const wantBack = record !== undefined && record.side === 'them' && !record.committed;
    if (d === undefined) {
      const el = document.createElement('div');
      el.className = 'placed';
      el.setAttribute('data-placed-spell', String(item.id));
      el.setAttribute('data-stack-id', String(item.id));
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
      d = { el, root: null, committed: !wantBack, isAbility: item.isAbility, sourceCardId: item.sourceCardId, leaving: false, pendingUntil: pending ? Date.now() + PLACED_PENDING_MS : null };
      if (pending) schedule(render, PLACED_PENDING_MS + 1);
      d.root = mount(el, item, wantBack);
      drawn.set(item.id, d);
      // Synchronous, now that the element (and, for a face, its CardTile — a
      // fresh root's first render commits without a scheduling hop) is
      // actually in the DOM. See `drawnListeners`'s own note.
      for (const listener of drawnListeners) listener(item.id);
    } else if (d.committed === wantBack) {
      // `d.committed` says "showing a face" and `wantBack` says "should show a back" — equal only on
      // a flip (lane W's `commitSpell` turned it over, or — defensively — the other direction).
      deferUnmount(d.root);
      d.root = mount(d.el, item, wantBack);
      d.committed = !wantBack;
    }
    return d;
  }

  /** The point for an item with no registered placement, plus the box it occupies — for the NEXT ability's own collision check, when it is one. */
  function positionOf(item: StackEntry, taken: readonly Rect[]): { at: Point; reserved: Rect | null } | null {
    const promoted = placements.get(item.id);
    if (promoted !== undefined) return { at: promoted.at, reserved: null };
    if (item.isAbility && item.sourceCardId !== null) {
      const source = cardBox(canvas, item.sourceCardId);
      if (source !== null) {
        const sourceBox = rectOf(source);
        const at = besideSource(sourceBox, taken);
        const width = sourceBox.right - sourceBox.left;
        const height = sourceBox.bottom - sourceBox.top;
        return { at, reserved: { left: at.x - width / 2, right: at.x + width / 2, top: at.y - height / 2, bottom: at.y + height / 2 } };
      }
    }
    const at = defaultSpot(canvas);
    return at === null ? null : { at, reserved: null };
  }

  function removeNow(id: number): void {
    const d = drawn.get(id);
    if (d === undefined) return;
    deferUnmount(d.root);
    d.el.remove();
    drawn.delete(id);
    placements.delete(id);
  }

  function leave(id: number, cardId: number | null): void {
    const d = drawn.get(id);
    if (d === undefined) return;
    if (cardId !== null && onBattlefieldNow(cardId)) {
      // AC8's own reservation is already drawing the arrival — nothing to fade.
      removeNow(id);
      return;
    }
    if (d.leaving) return;
    d.leaving = true;
    if (reduced()) {
      removeNow(id);
      return;
    }
    d.el.setAttribute('data-placed-leaving', '');
    schedule(() => removeNow(id), LEAVE_FADE_MS);
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
    const currentIds = new Set(view.stack.map((i) => i.id));

    // Resolved/left items first, so a leaving one never counts toward `taken` below.
    for (const id of [...drawn.keys()]) {
      if (currentIds.has(id)) continue;
      const was = drawn.get(id);
      leave(id, was?.isAbility === true ? null : was?.sourceCardId ?? null);
    }

    const taken: Rect[] = [];
    view.stack.forEach((item, index) => {
      const record = placements.get(item.id);
      const d = ensureElement(item, record);
      if (d.pendingUntil !== null && (record !== undefined || Date.now() >= d.pendingUntil)) {
        d.pendingUntil = null;
        d.el.removeAttribute('data-placed-pending');
      }
      if (d.leaving) return; // a resolved id Forge is reusing before the fade finished — rare, leave it be
      const resolved = positionOf(item, taken);
      if (resolved === null) return;
      const { at, reserved } = resolved;
      if (reserved !== null) taken.push(reserved);
      const p = overlayPoint(at, overlayBox);
      d.el.style.left = `${p.x}px`;
      d.el.style.top = `${p.y}px`;
      d.el.setAttribute('aria-label', itemLabel(item));
      // AE28: a trigger or ability of the viewer's own has no placement record (nothing was released
      // anywhere) — it is still theirs to move, like a spell they placed.
      const viewerName = lastView?.players.find((p) => p.isViewer)?.name ?? null;
      const ownUnplaced = record === undefined && item.isAbility && viewerName !== null && item.controllerName === viewerName;
      if ((record !== undefined && record.side === 'you') || ownUnplaced) d.el.setAttribute('data-mine', '');
      else d.el.removeAttribute('data-mine');
      const selectable = !item.isAbility && item.sourceCardId !== null && interaction?.isSelectable(item.sourceCardId) === true;
      if (selectable) d.el.setAttribute('data-selectable', '');
      else d.el.removeAttribute('data-selectable');
      if (index === 0) d.el.setAttribute('data-placed-next', '');
      else d.el.removeAttribute('data-placed-next');
    });

    drawArrows(view.stack);
    pruneStale(view.stack);
  }

  const hook = (): void => render();
  repaintHooks.add(hook);

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
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const id of [...drawn.keys()]) removeNow(id);
    },
  };
}
