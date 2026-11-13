/**
 * The one answer to "how wide is a card on this table right now".
 *
 * `board.css` sizes battlefield cards with `--card-w`, a formula of the row's
 * own measured box (`--zone-w`/`--zone-h`, `zone-box.ts`) — so the value only
 * means something INSIDE a battlefield row, and copying the expression onto
 * another element (a lifted card, a stack card, the opponent's back) silently
 * re-evaluates it against that element's own box. Every card drawn off the
 * rows reads this measured width instead (the operator, 2026-10-09: "lets make
 * sure theres a single source of truth for card sizes" — a squeezed window drew
 * a released card a size step larger: the stack layer's own hardcoded `6.5rem`).
 *
 * The measure is a card the row already draws: its used width
 * (`getComputedStyle`, which a lift's `scale` or a tap's rotation never
 * changes). Only a row with no card in it yet is measured with a probe column,
 * a `li.board-card` laid out by the row's own grid and removed in the same
 * call — never while a card is there to read: appending and removing the probe
 * costs two layouts of the whole board, and the layers that draw a dragged
 * card measure on every move (the operator, 2026-10-10: "the game has become a
 * bit more laggy … i notice it mostly when draging cards around").
 *
 * Each width is measured once and kept until the row or its first card changes
 * size (a `ResizeObserver` on both), a zone's box is written (`zone-box.ts`), the
 * row's first card is a different one, or the UI scale moves (`forgetCardWidths`).
 * Any read of a box forces the browser
 * to lay out whatever the commit before it changed, and the stack layer asks on
 * every commit: measured, this was a fifth of a combat's main-thread time.
 */
function drawnWidth(card: HTMLElement | null): number | null {
  if (card === null) return null;
  const width = Number.parseFloat(getComputedStyle(card).width);
  return width > 0 ? width : null;
}

/** A probe's width, once it is laid out. No layout (a test DOM): its own inherited `--card-w`, when that is already a px value, is the same answer. */
function probeWidth(probe: HTMLElement): number | null {
  const width = probe.getBoundingClientRect().width || Number.parseFloat(getComputedStyle(probe).getPropertyValue('--card-w')) || 0;
  return width > 0 ? width : null;
}

/** A width measured in a row, and the row's first card when it was: a different first card is a different row. */
interface Measured {
  readonly first: HTMLElement | null;
  width: number | null;
}

/**
 * One measure, split so a batch of them lays the page out once: `start` puts any probe in (a write),
 * `read` reads, `done` takes the probe out again. Every start of a batch, then every read, then every
 * done — a probe put in and taken out around each read cost a layout of the whole board per row.
 */
interface Measure {
  read: () => number | null;
  done: () => void;
}

/** By row: a drawn card's width (`cardWidthIn`), and the row's own `--card-w` (`handCardWidth`). */
const kept = { drawn: new Map<HTMLElement, Measured>(), row: new Map<HTMLElement, Measured>() };
const starts = { drawn: startDrawn, row: startRow };
const changed = new Set<() => void>();
let resizes: ResizeObserver | null = null;
const watched = new Set<Element>();

function firstCard(list: HTMLElement): HTMLElement | null {
  return list.querySelector<HTMLElement>(':scope > li.board-card');
}

function probed(list: HTMLElement, probe: HTMLElement): Measure {
  list.append(probe);
  return { read: () => probeWidth(probe), done: () => probe.remove() };
}

function cardProbe(): HTMLElement {
  const probe = document.createElement('li');
  probe.className = 'board-card';
  probe.style.visibility = 'hidden';
  return probe;
}

function startDrawn(list: HTMLElement): Measure {
  const card = firstCard(list);
  if (card === null) return probed(list, cardProbe());
  // A card drawn with no width (not laid out at all) is probed after all, on its own.
  return { read: () => drawnWidth(card) ?? measureNow(probed(list, cardProbe())), done: () => undefined };
}

function startRow(list: HTMLElement): Measure {
  const probe = document.createElement('div');
  probe.style.cssText = 'position: absolute; visibility: hidden; width: var(--card-w); height: 0';
  return probed(list, probe);
}

function measureNow(m: Measure): number | null {
  const width = m.read();
  m.done();
  return width;
}

/**
 * Every kept width measured again: after a resize of a row or its first card, and after `zone-box.ts`
 * writes a zone's box, which every row's `--card-w` resolves off. That write comes from the zones'
 * own observer, after the first layout, so a width read before it (a reload's replay draws its stack
 * at once) is read from a row nothing has sized yet; an empty row never resizes when it is. The
 * layers drawing at the widths redraw only when one moved.
 */
export function remeasureCardWidths(): void {
  const batch: { m: Measured; measure: Measure; width?: number | null }[] = [];
  for (const kind of ['drawn', 'row'] as const) {
    for (const [list, m] of kept[kind]) {
      if (!list.isConnected || firstCard(list) !== m.first) {
        kept[kind].delete(list);
        continue;
      }
      batch.push({ m, measure: starts[kind](list) });
    }
  }
  for (const b of batch) b.width = b.measure.read();
  for (const b of batch) b.measure.done();
  let moved = false;
  for (const { m, width = null } of batch) {
    if (width !== m.width) moved = true;
    m.width = width;
  }
  const wanted = new Set<Element>([...kept.drawn, ...kept.row].flatMap(([list, m]) => (m.first === null ? [list] : [list, m.first])));
  for (const el of [...watched]) {
    if (wanted.has(el)) continue;
    resizes?.unobserve(el);
    watched.delete(el);
  }
  if (moved) for (const listener of [...changed]) listener();
}

function watch(list: HTMLElement, m: Measured): void {
  for (const el of m.first === null ? [list] : [list, m.first]) {
    if (watched.has(el)) continue;
    watched.add(el);
    resizes?.observe(el);
  }
}

/** `kind`'s width in `list`, from the last measure while it still holds. Measured every call where nothing can say it went stale. */
function widthIn(kind: keyof typeof kept, list: HTMLElement): number | null {
  if (resizes === null && typeof ResizeObserver === 'function') resizes = new ResizeObserver(remeasureCardWidths);
  if (resizes === null) return measureNow(starts[kind](list));
  const first = firstCard(list);
  const known = kept[kind].get(list);
  if (known !== undefined && known.first === first) return known.width;
  const m: Measured = { first, width: measureNow(starts[kind](list)) };
  kept[kind].set(list, m);
  watch(list, m);
  return m.width;
}

export function cardWidthIn(list: HTMLElement): number | null {
  return widthIn('drawn', list);
}

/** The card width on one seat's battlefield — any card it draws, else its first row's — null before the board has drawn one. */
export function battlefieldCardWidth(root: ParentNode, owner: 'you' | 'them'): number | null {
  const zone = `[data-zone="battlefield"][data-owner="${owner}"]`;
  const drawn = root.querySelector<HTMLElement>(`${zone} .zone__cards > li.board-card`);
  const list = drawn?.parentElement ?? root.querySelector<HTMLElement>(`${zone} .zone__cards`);
  return list == null ? null : cardWidthIn(list);
}

/**
 * The card width the viewer's own hand draws at — its row's `--card-w`, the size a card has there
 * while the hand is not so full that its columns narrow — and the battlefield's where there is no
 * hand to read. A card being cast is drawn at this size from the lift to the stack, and only the
 * landing shrinks it into its battlefield slot (the operator, 2026-10-15: "casting cards are just as
 * big as hand cards and shrink down to card size once they resolve"). The row's value, not a drawn
 * card's: it holds still while the cast card leaves the hand and the others close up. A watcher's
 * bottom hand is backs, the same size. Measured with a probe that reads `--card-w` where the hand's
 * cards do (one layout), once per resize.
 */
export function handCardWidth(root: ParentNode): number | null {
  const list = root.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"] :is(.zone__cards, .card-backs)');
  const width = list === null ? null : widthIn('row', list);
  return width ?? battlefieldCardWidth(root, 'you') ?? battlefieldCardWidth(root, 'them');
}

/** Hear every change to a measured width — whatever is drawn at one draws again. */
export function onCardWidthsChanged(listener: () => void): () => void {
  changed.add(listener);
  return () => changed.delete(listener);
}

/** Every width measured again from scratch: the UI scale moved every length a card is sized from. */
export function forgetCardWidths(): void {
  kept.drawn.clear();
  kept.row.clear();
  watched.clear();
  resizes?.disconnect();
  resizes = null;
  for (const listener of [...changed]) listener();
}

/** Size an element drawn off the rows as a card `width` wide: `--card-w` in px, which `card.css` and the layers' own CSS read. */
export function sizeAsCard(el: HTMLElement, width: number | null): void {
  if (width === null) el.style.removeProperty('--card-w');
  else el.style.setProperty('--card-w', `${width}px`);
}
