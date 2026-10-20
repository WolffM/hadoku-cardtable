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
 *   - a STACK thumbnail is a tile like any other (`live/placed.ts`'s own
 *     placed-card layer renders the item's `CardTile`, `w<id>`, inside
 *     `[data-placed-spell]` — `Board.tsx`'s old `StackThumb` is gone, wave
 *     59), so hovering it opens this same panel, anchored to its right. Wave
 *     46 had the stack opt out in favour of a big view of its own below the
 *     row; the stack redesign (2026-10-06)
 *     removed that view, because the operator wants ONE expanded view:
 *     *"you can't ever be hovering over more than one thing so just having a
 *     single distinct 'expanded view' i think would be the cleanest."*
 *   - prompt-grid tiles (lane C) carry `data-card-id` on the same terms,
 *     outside the board root entirely — which is why the listeners sit on the
 *     DOCUMENT, not on the board root `mountInspector` was handed.
 *
 * ## Touch is long-press; a pointer device hovers
 *
 * On a touch screen a tap IS the game's gesture (select, answer), so the
 * inspector opens on a LONG PRESS: hold `LONG_PRESS_MS` without moving past
 * `DRAG_SLOP_PX` — a drag or a scroll cancels it before it opens: the same
 * slop the drags use, so the two gestures decide at the same drift. The click that ends a long-press is swallowed, once, in the capture
 * phase: the player asked to read the card, not to select it. An ordinary
 * click that no long-press preceded is never touched.
 *
 * Hover: `pointerover` retargets — the same card does nothing, so there is no
 * flicker — and moving onto anything that is not a card dismisses. While a
 * button is held (lane B's drag) the inspector closes and stays closed: the
 * arrow needs the pointer, not a preview. Escape dismisses, either way,
 * WITHOUT consuming the key: a prompt that also wants Escape still gets it.
 *
 * A press on the card being read puts the preview away too — the player is
 * acting on the card now, not reading it — and so does Escape. Either way the
 * card it was on stays QUIET until the pointer (or the focus) has left it: the
 * operator, 2026-10-10, on clicking a graveyard open with its top card
 * enlarged: *"when expand graveyard/exile is clicked can we dispose the
 * currently expanded card being shown? and also make sure the cursor has to
 * exit the current expand trigger zone before it can trigger a new expand?
 * that way it won't immediately block the view again when the cursor moves
 * slightly."* One rule for every card, not a pile-view case: a press opens
 * the pile view, so the press is what puts the preview away.
 *
 * ## Where it draws, and what it may never cover
 *
 * Only into the board's `[data-board-zoom]` layer — looked up, never moved —
 * which is `position: absolute; inset: 0; pointer-events: none` over the whole
 * canvas at `--z-zoom` (`../board.css`, `.board__zoom`): the one layer above
 * everything on the table, the phase rail, the controls and a decision window
 * included (the operator, 2026-10-13: *"the hovering a card expand should render
 * on top of everything else. currently it renders below the phase tracker"*).
 * The panel is absolutely positioned in the layer's own coordinate space, so it is out of flow and
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
 * While a decision window is open (any `.live__prompt`: a choice, a
 * selection, a payment, a confirm), the panel stands beside THAT instead,
 * to its left first (`placeBesideModal`) — AND clear of the hovered card
 * itself, whichever of the two is in the way: the operator, 2026-10-06, on
 * the window: *"if theres a decision window up like selecting a card from a
 * spell from deck or something else, then the expanded view needs to stack
 * to the left of that decision window"*; the operator again, 2026-10-08, on
 * the card: *"theres an active decision on my screen, and if i hover serum
 * visions it blocks the card itself … let's try to be a bit smarter about
 * where to place the expanded img."* Neither the window nor the card being
 * read is ever the thing the panel covers. An open pile view (`../PileView.tsx`)
 * is such a window too: a card read in it, or on the board while it is open,
 * stands beside it by the same rule, never over the cards it lists — and so
 * is a deck's list in the room's picker, whose lines enlarge through here.
 *
 * ## The other faces, on the wheel
 *
 * A card with more than one face — transformed (Fable of the Mirror-Breaker and Reflection of
 * Kiki-Jiki), modal double-faced, split, an adventure — has its other faces drawn as hidden tiles by
 * the board (`../Board.tsx`'s `BoardFaces`, `data-faces-of="<id>"`). While the panel is open on such
 * a card, the mouse wheel turns it to the next face down, or back up, and round again (the operator,
 * 2026-10-17: *"mousewheel up/down lets you cycle between other relevant cards"*). The wheel scrolls
 * nothing else meanwhile; on a card with one face it is left alone. A Room is drawn as its two doors
 * (`../Board.tsx`'s `RoomDoors`): the panel opens on the door under the pointer, with its lock state,
 * and the wheel turns to the other.
 *
 * ## Staleness, on purpose
 *
 * The clone is a snapshot taken when the gesture opened. If the game moves
 * under an open preview (a counter lands, the card dies) the preview is not
 * refreshed — a hover is over in a glance, and re-cloning on every mutation
 * would flash the image. What IS watched for is the card leaving the DOM
 * entirely, which dismisses rather than leave a panel anchored to nothing.
 */

import { pastSlop } from '../live/gestures/types.ts';
import { scopeOf } from '../../dom.ts';
import { playRole } from '../../sound/index.ts';
import './inspect.css';

/** A card's height over its width — the 488 × 680 proportion `card.css` draws. */
export const CARD_TALL = 680 / 488;

/** How wide the enlarged card wants to be, in px. */
export const PREF_W = 330;

/** Breathing room between the enlarged card and everything it must not touch. */
export const GAP = 8;

/** How long a touch must hold before the press counts as a long-press. */
export const LONG_PRESS_MS = 450;


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

/**
 * An ability on the stack is drawn as a chip (`live/placed.ts`'s `abilityChip`), not a tile: hovering
 * it enlarges the chip itself — the ability's whole text, its source's art and name. The operator,
 * 2026-10-10: "lets also allow hovering them just like cards to see an expanded view."
 */
const ABILITY_CHIP = 'data-ability-chip';

/**
 * A window the panel stands beside, never on: a decision pop-up that asks something (the "waiting for
 * the other player" pop-up asks nothing), an open pile view, or a deck's list in the picker
 * (`../../screens/DeckPeek.tsx`).
 */
const OPEN_WINDOW =
  '.live__prompt:not(:has([data-testid="live-waiting-pop"])), [data-testid="pile-view"], [data-testid="deck-peek"]';

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
    // An ability's chip on the stack (`live/placed.ts`): its own text, enlarged — a chip read like a card.
    if (el.hasAttribute(ABILITY_CHIP)) return { card: el.closest('[data-placed-spell]') ?? el, tile: el };
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
 * the zoom layer's origin — the layer covers the canvas exactly, so its box is
 * the board's box). Pure, and every caller-visible "never" lives here:
 *
 *   - never over the viewer's own hand: the panel's bottom stays a `GAP`
 *     above the hand zone's top, or the board's bottom when there is no hand
 *     zone to read — except a HAND card itself, which anchors to its own top
 *     instead (below), and so never needs this clamp;
 *   - never outside the board: past the board's right edge it stands on the
 *     card's LEFT when there is room there (the stack redesign, 2026-10-06:
 *     a thumbnail in the stack's column, at 59-84% across, was being covered
 *     by its own enlargement), and otherwise clamps at that edge, shifting
 *     as little as needed; it clamps at the board's top;
 *   - never bigger than the room above the hand: it shrinks first.
 *
 * ## Horizontal and vertical anchor
 *
 * The panel opens on the hovered card's RIGHT — `left = hover.right + GAP`.
 * Only when that runs past the board's right edge does it go to the card's
 * left (`hover.left - GAP - width`), and only when it fits there; a board too
 * narrow for either side shifts it left exactly as far as it must to stay
 * inside, over the card.
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

  // Past the board's right edge: to the card's LEFT when it fits there (a
  // stack thumbnail sits in a column at 59-84% of the board, and shifting the
  // panel left as little as needed laid it over the thumbnail), else shifted
  // left as little as needed. The board's top is the other edge an anchor
  // above can cross.
  if (!isHandCard && left + width > board.right - GAP) {
    const leftOfCard = hover.left - GAP - width;
    left = leftOfCard >= board.left + GAP ? leftOfCard : board.right - GAP - width;
  } else if (left + width > board.right - GAP) {
    left = board.right - GAP - width;
  }
  if (top < ceilingTop + GAP) top = ceilingTop + GAP;

  return { left, top, width };
}

/**
 * Where the enlarged card goes when the hovered card is INSIDE a pop-up (a
 * `.live__prompt`: a choice grid, a selection, a reveal), or when a decision
 * pop-up is open elsewhere while a BOARD card is hovered. Client coordinates.
 *
 * The operator, 2026-10-06, on a three-card "put into hand" choice: the
 * enlarged view drew under the pop-up, and *"in situations like these, the
 * expanded card view needs to display to the left of the popout modal"*. The
 * operator again, 2026-10-08, on hovering Serum Visions with a decision open
 * elsewhere: *"the expanded version doesn't cover the thing that is being
 * hovered … let's try to be a bit smarter about where to place the expanded
 * img"* — the panel must clear BOTH rects, not only the pop-up's.
 *
 * Four candidates, scored in this order — the first with ZERO overlap
 * against both `modal` and `hover`, at the preferred size, wins:
 *
 *   1. the pop-up's LEFT, a `GAP` clear of it, top level with the hovered card;
 *   2. the pop-up's RIGHT, the same;
 *   3. ABOVE the hovered card, a `GAP` clear of it, left edge level with it;
 *   4. BELOW the hovered card, the same.
 *
 * If none is clean at the preferred size, each is shrunk (holding its own
 * anchor edge fixed) to the largest size at which it clears both rects —
 * every anchor point sits inside `area`, so a width of zero is always clean,
 * and the shrink always finds SOME answer — and the candidate left widest
 * wins, ties broken by the order above. No candidate is ever returned sized
 * past zero.
 */
export function placeBesideModal(hover: Rect, modal: Rect, area: Rect): { left: number; top: number; width: number } {
  const fullW = Math.max(0, Math.min(PREF_W, (area.bottom - area.top - 2 * GAP) / CARD_TALL));

  const vClamp = (top: number, height: number): number =>
    Math.min(Math.max(top, area.top + GAP), Math.max(area.top + GAP, area.bottom - GAP - height));
  const hClamp = (left: number, width: number): number =>
    Math.min(Math.max(left, area.left + GAP), Math.max(area.left + GAP, area.right - GAP - width));

  interface Spot {
    left: number;
    top: number;
    width: number;
    height: number;
  }

  /** The four anchors, each as a function of the width it is given — the edge the anchor pins never moves as the box shrinks. */
  const anchors: Array<(width: number) => Spot> = [
    // Left of the pop-up: the box's RIGHT edge is pinned at `modal.left - GAP`.
    (width) => {
      const height = width * CARD_TALL;
      return { left: modal.left - GAP - width, top: vClamp(hover.top, height), width, height };
    },
    // Right of the pop-up: the box's LEFT edge is pinned at `modal.right + GAP`.
    (width) => {
      const height = width * CARD_TALL;
      return { left: modal.right + GAP, top: vClamp(hover.top, height), width, height };
    },
    // Above the card: the box's BOTTOM edge is pinned at `hover.top - GAP`.
    (width) => {
      const height = width * CARD_TALL;
      return { left: hClamp(hover.left, width), top: hover.top - GAP - height, width, height };
    },
    // Below the card: the box's TOP edge is pinned at `hover.bottom + GAP`.
    (width) => {
      const height = width * CARD_TALL;
      return { left: hClamp(hover.left, width), top: hover.bottom + GAP, width, height };
    },
  ];

  const overlapArea = (s: Spot, r: Rect): number => {
    const w = Math.max(0, Math.min(s.left + s.width, r.right) - Math.max(s.left, r.left));
    const h = Math.max(0, Math.min(s.top + s.height, r.bottom) - Math.max(s.top, r.top));
    return w * h;
  };

  const EPS = 1e-9;
  const clean = (s: Spot): boolean =>
    s.left >= area.left + GAP - EPS &&
    s.left + s.width <= area.right - GAP + EPS &&
    s.top >= area.top + GAP - EPS &&
    s.top + s.height <= area.bottom - GAP + EPS &&
    overlapArea(s, modal) <= EPS &&
    overlapArea(s, hover) <= EPS;

  // The first candidate that is clean at the preferred width, full size.
  for (const anchor of anchors) {
    const spot = anchor(fullW);
    if (clean(spot)) return { left: spot.left, top: spot.top, width: spot.width };
  }

  // None is clean at the preferred size: binary-search each candidate's own
  // widest clean width. A width of zero always TERMINATES the search (its
  // overlap area is zero either way), even for a candidate whose anchor has
  // no room at all — such a candidate simply loses to whichever of the
  // other three does. Take the widest of the four.
  let best: Spot | null = null;
  for (const anchor of anchors) {
    let lo = 0;
    let hi = fullW;
    for (let i = 0; i < 50; i += 1) {
      const mid = (lo + hi) / 2;
      if (clean(anchor(mid))) lo = mid;
      else hi = mid;
    }
    const spot = anchor(lo);
    if (best === null || spot.width > best.width) best = spot;
  }
  const chosen = best ?? anchors[0]!(0);
  return { left: chosen.left, top: chosen.top, width: chosen.width };
}

/**
 * The enlargement: a clone of a tile the seat already drew. Stripped of the ids other code queries by
 * value (`live/LiveBoard.tsx`'s `cardBox`, the e2e suites) — it is presentation, not a card the DOM
 * can address.
 */
function enlarged(tile: Element): HTMLElement {
  const clone = tile.cloneNode(true) as HTMLElement;
  clone.removeAttribute('data-card-id');
  clone.removeAttribute('data-testid');
  const art = clone.querySelector('img');
  if (art !== null) art.setAttribute('loading', 'eager');
  return clone;
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
 * thing looked up inside it is the zoom layer (and the viewer's hand zone,
 * for placement) — every card is found through the document, because prompt
 * grids render outside the board. Returns the dispose: listeners off, panel
 * gone. Idempotent — including across a re-mount that already superseded it.
 */
export function mountInspector(root: ParentNode): () => void {
  activeMounts.get(root)?.();

  // The document, or the shadow root the board is in when embedded (D21). Hover
  // and focus inside a shadow tree never reach `document` — a pointerover whose
  // target and relatedTarget both retarget to the host is not dispatched past
  // the shadow root — so the listeners go where the cards are.
  const scope = root instanceof Node ? scopeOf(root) : document;

  let current: InspectTarget | null = null;
  let panel: HTMLElement | null = null;
  /** The faces the open panel can show — the hovered tile first — and which one it shows. */
  let faces: Element[] = [];
  let faceAt = 0;
  let watcher: MutationObserver | null = null;

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressAnchor: { x: number; y: number } | null = null;
  let pressing: InspectTarget | null = null;
  /** The card whose release-click a touch long-press just opened; swallowed once. */
  let swallowClickIn: Element | null = null;
  /** The card a press or Escape put the preview away on: it opens nothing until the pointer or focus leaves it. */
  let quiet: Element | null = null;

  const layer = (): HTMLElement | null => root.querySelector('[data-board-zoom]');

  /** The viewer's own hand — the one zone the panel may never cover. */
  const handRect = (): Rect | null => {
    const hand = root.querySelector('[data-zone="hand"][data-owner="you"]');
    return hand === null ? null : rectOf(hand.getBoundingClientRect());
  };

  function dismiss(): void {
    if (panel !== null) panel.remove();
    panel = null;
    current = null;
    faces = [];
    faceAt = 0;
    watcher?.disconnect();
    watcher = null;
  }

  /** Dismiss, and keep the card the preview was on quiet until it is left. */
  function putAway(): void {
    if (current === null) return;
    quiet = current.trigger ?? current.card;
    dismiss();
  }

  /** Whether `node` is inside the quiet card. */
  const inQuiet = (node: EventTarget | null): boolean => quiet !== null && node instanceof Node && quiet.contains(node);

  function show(target: InspectTarget): void {
    const host = layer();
    if (host === null) return;
    if (current !== null && current.card === target.card && current.trigger === target.trigger) return;
    dismiss();
    current = target;

    const clone = enlarged(target.tile);
    // A face the board draws as a card of its own (a Room's door) is not turned to twice.
    const named = (el: Element): string | null => el.querySelector('.card__name')?.textContent ?? null;
    faces = [target.tile, ...otherFacesOf(target.tile).filter((f) => named(f) !== named(target.tile))];

    const hoverR = rectOf((target.trigger ?? target.tile).getBoundingClientRect());
    // A window is open: the panel stands beside it, never on it — the hovered
    // card's own window when it is in one; otherwise the one that is open
    // (`OPEN_WINDOW`). Never for a card in the viewer's own hand: that one
    // enlarges above the hand whatever is on screen (the operator, 2026-10-07:
    // "this type of hover expand should not be affected by whats on the screen").
    const inHand = target.card.closest('[data-zone="hand"][data-owner="you"]') !== null;
    const modal = target.tile.closest(OPEN_WINDOW) ?? (inHand ? null : scope.querySelector(OPEN_WINDOW));
    const hostR = rectOf(host.getBoundingClientRect());
    const spot =
      modal !== null ? placeBesideModal(hoverR, rectOf(modal.getBoundingClientRect()), hostR) : placeInspector(hoverR, hostR, handRect());

    const el = document.createElement('div');
    el.className = 'inspect';
    el.dataset.inspect = '';
    // A visual enlargement of content already in the accessibility tree; the
    // tile underneath stays the readable one. Not a dialog, not a status.
    el.setAttribute('aria-hidden', 'true');
    el.style.left = `${spot.left - hostR.left}px`;
    el.style.top = `${spot.top - hostR.top}px`;
    el.style.width = `${spot.width}px`;
    el.appendChild(clone);
    host.appendChild(el);
    panel = el;

    // A card can leave the DOM under an open preview (it died, the zone
    // emptied). Watch for that while open — and only while open.
    watcher = new MutationObserver(() => {
      if (current !== null && (!current.card.isConnected || current.trigger?.isConnected === false)) dismiss();
    });
    watcher.observe(scope, { childList: true, subtree: true });
  }

  /** The wheel over an open panel with faces to turn: the next face down, or back up, and round. */
  function onWheel(event: WheelEvent): void {
    if (panel === null || faces.length < 2 || event.deltaY === 0) return;
    event.preventDefault();
    faceAt = (faceAt + (event.deltaY > 0 ? 1 : -1) + faces.length) % faces.length;
    panel.replaceChildren(enlarged(faces[faceAt]!));
  }

  /** A card's other faces, as the board drew them (`BoardFaces`), by the board id in its tile's own `w<id>`. */
  function otherFacesOf(tile: Element): Element[] {
    const id = tile.getAttribute('data-card-id');
    if (id === null || !TILE_ID.test(id)) return [];
    const drawn = root.querySelector(`[data-faces-of="${id.slice(1)}"]`);
    return drawn === null ? [] : [...drawn.querySelectorAll('.card')];
  }

  function onPointerOver(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    // A held button is lane B's drag (or a selection): the pointer is spoken
    // for, and the arrow does not share the canvas with a preview.
    if (event.buttons !== 0) {
      dismiss();
      return;
    }
    if (inQuiet(event.target)) return;
    quiet = null;
    const target = inspectedCardFrom(event.target, root);
    if (target === null) {
      dismiss();
      return;
    }
    show(target);
  }

  function onPointerOut(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    // Out of the quiet card — including out of the window, where no pointerover follows.
    if (inQuiet(event.target) && !inQuiet(event.relatedTarget)) quiet = null;
    if (current === null) return;
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
    // The press that put a log name's preview away also focuses it.
    if (inQuiet(event.target)) return;
    const target = inspectedCardFrom(event.target, root);
    if (target?.trigger !== undefined) show(target);
  }

  function onFocusOut(event: FocusEvent): void {
    if (event.target === quiet) quiet = null;
    if (current?.trigger !== undefined && event.target === current.trigger) dismiss();
  }

  function onPointerDown(event: PointerEvent): void {
    swallowClickIn = null;
    if (event.pointerType !== 'touch') {
      if (current !== null && event.target instanceof Node && (current.trigger ?? current.card).contains(event.target)) putAway();
      return;
    }
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
      playRole('ui.inspect');
      show(opened);
      swallowClickIn = opened.card;
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    if (pressTimer === null || pressAnchor === null) return;
    if (pastSlop(pressAnchor, { x: event.clientX, y: event.clientY })) cancelPress();
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
    if (event.key === 'Escape' && panel !== null) putAway();
  }

  function cancelPress(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressing = null;
    pressAnchor = null;
  }

  const listeners: [string, EventListener, boolean][] = [
    ['pointerover', onPointerOver as EventListener, false],
    ['pointerout', onPointerOut as EventListener, false],
    ['focusin', onFocusIn as EventListener, false],
    ['focusout', onFocusOut as EventListener, false],
    ['pointerdown', onPointerDown as EventListener, false],
    ['pointermove', onPointerMove as EventListener, false],
    ['pointerup', onPointerUpOrCancel, false],
    ['pointercancel', onPointerUpOrCancel, false],
    ['click', onClickCapture as EventListener, true],
    ['contextmenu', onContextMenu as EventListener, false],
    ['keydown', onKeyDown as EventListener, false],
  ];
  for (const [type, listener, capture] of listeners) scope.addEventListener(type, listener, capture);
  // Not passive: the wheel that turns a face must not also scroll the page under it.
  scope.addEventListener('wheel', onWheel as EventListener, { passive: false });

  const dispose = (): void => {
    cancelPress();
    dismiss();
    for (const [type, listener, capture] of listeners) scope.removeEventListener(type, listener, capture);
    scope.removeEventListener('wheel', onWheel as EventListener);
    // Only clear the registry if nothing has re-mounted this root since:
    // a superseded instance's own (stale) dispose must stay a harmless no-op.
    if (activeMounts.get(root) === dispose) activeMounts.delete(root);
  };
  activeMounts.set(root, dispose);
  return dispose;
}
