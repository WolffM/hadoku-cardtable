/*
 * The inspector: one card, enlarged — hover on a pointer device, long-press on
 * touch. Wave 20 §D.
 *
 * ## What it shows, and where that comes from
 *
 * A player wants to READ a card before acting on it. The enlarged card is the
 * `CardTile` the seat already drew, CLONED and sized up: art, name, cost, type
 * line, rules text, stat — exactly the face the wire carried. The adapter puts
 * `OracleText`, `Power`/`Toughness` and loyalty on every `DraftCard`
 * (`../adapter.ts`), and `CardTile` renders all of it, so the rules text is
 * not a fetch away — it is already in the tile this module enlarges. No second
 * source of card data exists here, which is also the whole hidden-information
 * story: an opponent's hand arrives as card backs with no tile to clone, so
 * there is nothing to enlarge and no face can leak. The inspector renders only
 * data the seat was sent, by construction.
 *
 * Art is never resolved here. The clone carries the tile's own `<img>` — the
 * URL `CardTile` built through `@hadoku/carddata/art` — so repointing a card's
 * art stays a one-line manifest edit and no host is named in this file.
 *
 * ## The DOM is the only contract
 *
 * Lane A's board and lane C's prompt grids are not imported; they are read, by
 * VALUE (see `../Board.tsx`'s header for the whole contract):
 *
 *   - a board card's `<li>` carries `data-card-id="<forge id>"` (digits), and
 *     the `CardTile` inside it carries its OWN `data-card-id="w<forge id>"` —
 *     the draft's namespace. Matching is on the value: digits mean "a board
 *     card, the tile is inside"; `w<digits>` means "this IS a tile". A bare
 *     `[data-card-id]` selector would confuse the two; nothing here uses one.
 *   - the STACK is not this module's any more (wave 46 X3): a thumbnail used
 *     to carry `data-source-card` so hovering it opened this same panel,
 *     anchored to its right — the settled shape for the carousel anchors its
 *     own peek BELOW the thumbnail instead, which this module has no anchor
 *     mode for, so the stack opted out rather than gaining a second one here
 *     (`Board.tsx`'s own `StackView` draws that peek directly, off the
 *     `StackEntry`s it already holds — no DOM clone, no `MutationObserver`).
 *     `data-source-card` is no longer produced anywhere, by anything.
 *   - prompt-grid tiles (lane C) carry `data-card-id` on the same terms,
 *     outside the board root entirely — which is why the listeners sit on the
 *     DOCUMENT, not on the board root `mountInspector` was handed.
 *
 * ## Touch is long-press; a pointer device hovers
 *
 * On a touch screen a tap IS the game's gesture (select, answer), so the
 * inspector opens on a LONG PRESS: hold `LONG_PRESS_MS` without moving past
 * `LONG_PRESS_SLOP_PX` — a drag or a scroll cancels it before it opens, and
 * the slop is lane B's drag slop scale, so the two gestures decide at the same
 * drift. The click that ends a long-press is swallowed, once, in the capture
 * phase: the player asked to read the card, not to select it. An ordinary
 * click that no long-press preceded is never touched.
 *
 * Hover: `pointerover` retargets — the same card does nothing, so there is no
 * flicker — and moving onto anything that is not a card dismisses. While a
 * button is held (lane B's drag) the inspector closes and stays closed: the
 * arrow needs the pointer, not a preview. Escape dismisses, either way,
 * WITHOUT consuming the key: a prompt that also wants Escape still gets it.
 *
 * ## Where it draws, and what it may never cover
 *
 * Only into lane A's `[data-board-overlay]` root — looked up, never moved —
 * which is `position: absolute; inset: 0; pointer-events: none` over the whole
 * canvas (`../board.css`, `.board__overlay`). The panel is absolutely
 * positioned in the overlay's own coordinate space, so it is out of flow and
 * cannot move a track: nothing about the canvas layout changes when it
 * appears (`e2e/table-fit.spec.ts` is that proof). This subtree re-enables no
 * pointer-events, so it can never become the element under the pointer —
 * dismiss-on-leave simply works, and no click the game needs is ever blocked.
 *
 * Placement (`placeInspector`, pure, tested on real numbers) keeps the
 * enlarged card inside the board and NEVER over the viewer's own hand: it
 * shrinks to the room above the hand zone before it will ever reach it. It
 * anchors to the hovered card's RIGHT, always: covering the battlefield is
 * the price of reading a card; covering the hand never is. A hand card is
 * the one exception, on both axes (below).
 *
 * ## Staleness, on purpose
 *
 * The clone is a snapshot taken when the gesture opened. If the game moves
 * under an open preview (a counter lands, the card dies) the preview is not
 * refreshed — a hover is over in a glance, and re-cloning on every mutation
 * would flash the image. What IS watched for is the card leaving the DOM
 * entirely, which dismisses rather than leave a panel anchored to nothing.
 */

import './inspect.css';

/** A card's height over its width — the 488 × 680 proportion `card.css` draws. */
export const CARD_TALL = 680 / 488;

/** How wide the enlarged card wants to be, in px (≈ the draft tile's 190px, larger). */
export const PREF_W = 264;

/** Breathing room between the enlarged card and everything it must not touch. */
export const GAP = 8;

/** How long a touch must hold before the press counts as a long-press. */
export const LONG_PRESS_MS = 450;

/**
 * How far the pointer may drift during that hold before the press stops being
 * a long-press. Deliberately lane B's `DRAG_SLOP_PX` scale: a drag and a
 * scroll both cancel the inspect before it opens.
 */
export const LONG_PRESS_SLOP_PX = 8;

/** A board id: digits only (`data-card-id`). */
const BOARD_ID = /^\d+$/;
/** A `CardTile`'s own id: `w` then digits — the draft's namespace. */
const TILE_ID = /^w\d+$/;

/** The thing being inspected: where the gesture is, and what to enlarge. */
interface InspectTarget {
  /** The element the gesture is on — a board card's `<li>`, a stack item, a tile. */
  card: Element;
  /** The `CardTile` to clone. */
  tile: Element;
  /**
   * The element the gesture is actually on, when it is not the card: a log line's
   * card name (`data-inspect-ids`). The pointer leaving THIS is what dismisses,
   * and the preview is placed beside it.
   */
  trigger?: Element;
}

/**
 * A name somewhere that is not a card — a log line's — points at cards with
 * `data-inspect-ids="<id>,<id>"`: the forge ids of every card of that name the
 * seat was sent. There is no second hover surface; the name resolves to a tile
 * ALREADY DRAWN on the board and that tile is what is enlarged.
 */
const INSPECT_IDS = 'data-inspect-ids';

/** The box vocabulary `placeInspector` speaks. Client coordinates. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectOf(r: DOMRect): Rect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/**
 * The board card `<li>` that owns a tile, when there is one — read by VALUE,
 * walking the parents. So that hovering the tile, its text, or the `<li>`'s
 * own edge is ONE target: crossing that edge must not dismiss-and-reopen the
 * panel over the same card.
 */
function ownerBoardCard(tile: Element): Element | null {
  for (let p = tile.parentElement; p !== null; p = p.parentElement) {
    const id = p.getAttribute('data-card-id');
    if (id !== null && BOARD_ID.test(id)) return p;
  }
  return null;
}

/**
 * The card a pointer event is on, or null. Walks up from the event's target
 * reading each element's `data-card-id` and testing the VALUE — never a bare
 * attribute match, which would confuse a `CardTile`'s own `w<id>` with the
 * board card around it. The stack is no longer a source here at all (wave 46
 * X3: `Board.tsx`'s own `StackView` draws its peek directly, never through
 * this module) — `data-source-card` is gone, and nothing replaces it.
 *
 * Null for anything that is not a card with a face to enlarge: an opponent's
 * card backs, a player's face. That null is the hidden-information control:
 * there is nothing to show because the seat was sent nothing to show.
 */
function inspectedCardFrom(node: EventTarget | null, root: ParentNode): InspectTarget | null {
  let el = node instanceof Element ? node : null;
  // The stack opted out of this module entirely (wave 46 X3): a thumbnail's
  // own `CardTile` still carries `data-card-id="w<id>"` like every other
  // tile on the board, which `TILE_ID` below would otherwise match and open
  // this panel anyway — measured directly, against real Forge
  // (`e2e/w36.spec.ts` T8). The carousel's own peek is what reads a stack
  // thumbnail's hover now; this module must never also answer it.
  if (el !== null && el.closest('.stack__item') !== null) return null;
  while (el !== null) {
    // A name, before a card: the first of its ids with a tile on the page. A
    // card with no tile drawn (it is in a zone the board shows as a count, or
    // it is hidden from this seat) enlarges nothing — the log does not get a
    // surface of its own to make up for it.
    const named = el.getAttribute(INSPECT_IDS);
    if (named !== null) {
      for (const id of named.split(',')) {
        const owner = BOARD_ID.test(id) ? root.querySelector(`[data-card-id="${id}"]`) : null;
        const tile = owner?.querySelector('.card') ?? null;
        if (owner !== null && tile !== null) return { card: owner, tile, trigger: el };
      }
      return null;
    }
    const id = el.getAttribute('data-card-id');
    if (id !== null && TILE_ID.test(id)) {
      // The tile itself — or a wrapper carrying the tile's own id.
      const tile = el.classList.contains('card') ? el : el.querySelector('.card');
      if (tile !== null) return { card: ownerBoardCard(tile) ?? el, tile };
    } else if (id !== null && BOARD_ID.test(id)) {
      // A board card, or a prompt-grid tile: the face is inside.
      const tile = el.querySelector('.card');
      if (tile !== null) return { card: el, tile };
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Where the enlarged card goes, in client coordinates (the caller subtracts
 * the overlay's origin — the overlay covers the canvas exactly, so its box is
 * the board's box). Pure, and every caller-visible "never" lives here:
 *
 *   - never over the viewer's own hand: the panel's bottom stays a `GAP`
 *     above the hand zone's top, or the board's bottom when there is no hand
 *     zone to read — except a HAND card itself, which anchors to its own top
 *     instead (below), and so never needs this clamp;
 *   - never outside the board: it clamps at the board's right edge and at
 *     its top, shifting as little as needed to stay inside — never by
 *     flipping sides;
 *   - never bigger than the room above the hand: it shrinks first.
 *
 * ## Horizontal and vertical anchor
 *
 * The panel opens on the hovered card's RIGHT, always — `left = hover.right +
 * GAP`, never computed against the left edge. The only clamp for this case is
 * the board's own right edge, and it shifts the panel left exactly as far as
 * it must to stay inside — it never jumps to the other side of the card.
 *
 * A HAND card is the one exception, on BOTH axes. Its panel's bottom-LEFT
 * corner sits exactly on the card's own top-left corner — `left = hover.left`,
 * `top = hover.top - height`, no `GAP` between them, because the hand row is
 * what the panel is standing on. It still grows up and to the right from
 * there; the right-edge and top clamps below apply to it exactly as they do
 * to every other case.
 *
 * ## Telling a hand card apart from everything else
 *
 * `floorTop` is the hand zone's own top — correct as the one thing the panel
 * must never cross for a battlefield card or a stack item, both always well
 * above it. But a HAND card's own top sits BELOW `floorTop` (the zone's box
 * includes the padding above the row), so testing `hover.top` against
 * `hand.top` — not just checking `hand !== null` — is what tells a hand card
 * apart from everything else, and it is what the anchor above keys off of.
 * Two different hand cards (even fanned to different heights) anchor to two
 * different pixels, because each uses its OWN `hover.top`, never the zone's.
 */
export function placeInspector(
  hover: Rect,
  board: Rect,
  hand: Rect | null,
): { left: number; top: number; width: number } {
  const floorTop = hand !== null ? Math.min(hand.top, board.bottom) : board.bottom;
  const ceilingTop = board.top;
  const availableHeight = Math.max(0, floorTop - GAP - (ceilingTop + GAP));
  const width = Math.max(0, Math.min(PREF_W, availableHeight / CARD_TALL, board.right - board.left - 2 * GAP));
  const height = width * CARD_TALL;

  // A hand card: see the doc comment above for why `hover.top` (not
  // `hand.top`) is the test. Its corner anchor is exact — no GAP — because it
  // stands on the card.
  const isHandCard = hand !== null && hover.top >= hand.top;

  let left = isHandCard ? hover.left : hover.right + GAP;
  let top = isHandCard
    ? hover.top - height
    : Math.min(Math.max(hover.top, ceilingTop + GAP), Math.max(ceilingTop + GAP, floorTop - GAP - height));

  // Clamp only at the board's right edge (shift left as little as needed)
  // and the board's top — the only two edges either anchor above can cross.
  if (left + width > board.right - GAP) left = board.right - GAP - width;
  if (top < ceilingTop + GAP) top = ceilingTop + GAP;

  return { left, top, width };
}

/**
 * One live instance per root: mounting the same `root` again tears the prior
 * instance down FIRST (its listeners off, its panel gone) before the new one
 * attaches. Without this, two mounts on one root stack independent
 * `document` listener sets, and disposing the newer one leaves the older
 * one's listeners — and whatever it shows — live. Keyed by identity, so
 * distinct roots (or a root's node recycled after a prior one was GC'd) never
 * collide.
 */
const activeMounts = new WeakMap<ParentNode, () => void>();

/**
 * Boot the inspector on a board. `root` is the board lane A mounted; the only
 * thing looked up inside it is the overlay root (and the viewer's hand zone,
 * for placement) — every card is found through the document, because prompt
 * grids render outside the board. Returns the dispose: listeners off, panel
 * gone. Idempotent — including across a re-mount that already superseded it.
 */
export function mountInspector(root: ParentNode): () => void {
  activeMounts.get(root)?.();

  const doc: Document = (root instanceof Element ? root.ownerDocument : null) ?? document;

  let current: InspectTarget | null = null;
  let panel: HTMLElement | null = null;
  let watcher: MutationObserver | null = null;

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressAnchor: { x: number; y: number } | null = null;
  let pressing: InspectTarget | null = null;
  /** The card whose release-click a touch long-press just opened; swallowed once. */
  let swallowClickIn: Element | null = null;

  const overlay = (): HTMLElement | null => root.querySelector('[data-board-overlay]');

  /** The viewer's own hand — the one zone the panel may never cover. */
  const handRect = (): Rect | null => {
    const hand = root.querySelector('[data-zone="hand"][data-owner="you"]');
    return hand === null ? null : rectOf(hand.getBoundingClientRect());
  };

  function dismiss(): void {
    if (panel !== null) panel.remove();
    panel = null;
    current = null;
    watcher?.disconnect();
    watcher = null;
  }

  function show(target: InspectTarget): void {
    const overlayEl = overlay();
    if (overlayEl === null) return;
    if (current !== null && current.card === target.card && current.trigger === target.trigger) return;
    dismiss();
    current = target;

    // The enlargement: a clone of the tile the seat already drew. Stripped of
    // the ids other code queries by value (`live/LiveBoard.tsx`'s `cardBox`,
    // the e2e suites) — it is presentation, not a card the DOM can address.
    const clone = target.tile.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-card-id');
    clone.removeAttribute('data-testid');
    const art = clone.querySelector('img');
    if (art !== null) art.setAttribute('loading', 'eager');

    const boardR = rectOf(overlayEl.getBoundingClientRect());
    const spot = placeInspector(rectOf((target.trigger ?? target.tile).getBoundingClientRect()), boardR, handRect());

    const el = doc.createElement('div');
    el.className = 'inspect';
    el.dataset.inspect = '';
    // A visual enlargement of content already in the accessibility tree; the
    // tile underneath stays the readable one. Not a dialog, not a status.
    el.setAttribute('aria-hidden', 'true');
    el.style.left = `${spot.left - boardR.left}px`;
    el.style.top = `${spot.top - boardR.top}px`;
    el.style.width = `${spot.width}px`;
    el.appendChild(clone);
    overlayEl.appendChild(el);
    panel = el;

    // A card can leave the DOM under an open preview (it died, the zone
    // emptied). Watch for that while open — and only while open.
    watcher = new MutationObserver(() => {
      if (current !== null && (!current.card.isConnected || current.trigger?.isConnected === false)) dismiss();
    });
    watcher.observe(doc.body, { childList: true, subtree: true });
  }

  function onPointerOver(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    // A held button is lane B's drag (or a selection): the pointer is spoken
    // for, and the arrow does not share the canvas with a preview.
    if (event.buttons !== 0) {
      dismiss();
      return;
    }
    const target = inspectedCardFrom(event.target, root);
    if (target === null) {
      dismiss();
      return;
    }
    show(target);
  }

  function onPointerOut(event: PointerEvent): void {
    if (current === null || event.pointerType === 'touch') return;
    const zone = current.trigger ?? current.card;
    if (!(event.target instanceof Node) || !zone.contains(event.target)) return;
    const to = event.relatedTarget;
    if (to instanceof Node && zone.contains(to)) return;
    // Off the card — including out of the window entirely, where there is no
    // next element to pointerover. Usually the pointerover on the next
    // element got here first; this is the case where nothing follows.
    dismiss();
  }

  // The keyboard gets what the pointer gets: a card name in the log is a tab
  // stop, and focusing it shows the card the same way hovering it does.
  function onFocusIn(event: FocusEvent): void {
    const target = inspectedCardFrom(event.target, root);
    if (target?.trigger !== undefined) show(target);
  }

  function onFocusOut(event: FocusEvent): void {
    if (current?.trigger !== undefined && event.target === current.trigger) dismiss();
  }

  function onPointerDown(event: PointerEvent): void {
    swallowClickIn = null;
    if (event.pointerType !== 'touch') return;
    cancelPress();
    const target = inspectedCardFrom(event.target, root);
    // A tap anywhere the game is not showing a card closes the preview — and
    // a second press on the card it enlarged toggles it off.
    if (target === null || (current !== null && current.card === target.card && current.trigger === target.trigger)) {
      dismiss();
      return;
    }
    pressAnchor = { x: event.clientX, y: event.clientY };
    pressing = target;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (pressing === null) return;
      const opened = pressing;
      pressing = null;
      pressAnchor = null;
      show(opened);
      swallowClickIn = opened.card;
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    if (pressTimer === null || pressAnchor === null) return;
    if (Math.hypot(event.clientX - pressAnchor.x, event.clientY - pressAnchor.y) >= LONG_PRESS_SLOP_PX) cancelPress();
  }

  /** The release that ends a long-press KEEPS the preview open; a tap elsewhere or Escape closes it. */
  function onPointerUpOrCancel(): void {
    cancelPress();
  }

  function onClickCapture(event: MouseEvent): void {
    if (swallowClickIn === null) return;
    const inCard = event.target instanceof Node && swallowClickIn.contains(event.target);
    swallowClickIn = null;
    if (!inCard) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onContextMenu(event: MouseEvent): void {
    // A mobile long-press also summons the platform's own menu; while this
    // long-press is ours, it does not get to. A desktop right-click is never
    // touched — `swallowClickIn` is only ever set by a touch long-press.
    if (swallowClickIn === null) return;
    if (event.target instanceof Node && swallowClickIn.contains(event.target)) event.preventDefault();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Dismiss and let the key go: a prompt that wants Escape still gets it.
    if (event.key === 'Escape' && panel !== null) dismiss();
  }

  function cancelPress(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressing = null;
    pressAnchor = null;
  }

  doc.addEventListener('pointerover', onPointerOver);
  doc.addEventListener('pointerout', onPointerOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerup', onPointerUpOrCancel);
  doc.addEventListener('pointercancel', onPointerUpOrCancel);
  doc.addEventListener('click', onClickCapture, true);
  doc.addEventListener('contextmenu', onContextMenu);
  doc.addEventListener('keydown', onKeyDown);

  const dispose = (): void => {
    cancelPress();
    dismiss();
    doc.removeEventListener('pointerover', onPointerOver);
    doc.removeEventListener('pointerout', onPointerOut);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('focusout', onFocusOut);
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUpOrCancel);
    doc.removeEventListener('pointercancel', onPointerUpOrCancel);
    doc.removeEventListener('click', onClickCapture, true);
    doc.removeEventListener('contextmenu', onContextMenu);
    doc.removeEventListener('keydown', onKeyDown);
    // Only clear the registry if nothing has re-mounted this root since:
    // a superseded instance's own (stale) dispose must stay a harmless no-op.
    if (activeMounts.get(root) === dispose) activeMounts.delete(root);
  };
  activeMounts.set(root, dispose);
  return dispose;
}
