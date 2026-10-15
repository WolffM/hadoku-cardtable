/**
 * The one answer to "how wide is a card on this table right now".
 *
 * `board.css` sizes battlefield cards with `--card-w`, a container-query
 * formula (`100cqh` of the row) — so the value only means something INSIDE a
 * battlefield row, and copying the expression onto another element (a lifted
 * card, a stack card, the opponent's back) silently re-evaluates it against
 * that element's own container. Every card drawn off the rows reads this
 * measured width instead (the operator, 2026-10-09: "lets make sure theres a
 * single source of truth for card sizes" — a squeezed window drew a released
 * card a size step larger: the stack layer's own hardcoded `6.5rem`).
 *
 * The measure is a card the row already draws: its used width
 * (`getComputedStyle`, which a lift's `scale` or a tap's rotation never
 * changes). Only a row with no card in it yet is measured with a probe column,
 * a `li.board-card` laid out by the row's own grid and removed in the same
 * call — never while a card is there to read: appending and removing the probe
 * costs two layouts of the whole board, and the layers that draw a dragged
 * card measure on every move (the operator, 2026-10-10: "the game has become a
 * bit more laggy … i notice it mostly when draging cards around").
 */
function drawnWidth(card: HTMLElement | null): number | null {
  if (card === null) return null;
  const width = Number.parseFloat(getComputedStyle(card).width);
  return width > 0 ? width : null;
}

export function cardWidthIn(list: HTMLElement): number | null {
  const drawn = drawnWidth(list.querySelector<HTMLElement>(':scope > li.board-card'));
  if (drawn !== null) return drawn;
  const probe = document.createElement('li');
  probe.className = 'board-card';
  probe.style.visibility = 'hidden';
  list.append(probe);
  let width = probe.getBoundingClientRect().width;
  // No layout (a test DOM): the probe's own inherited `--card-w`, when it is already a px value, is the same answer.
  if (!(width > 0)) width = Number.parseFloat(getComputedStyle(probe).getPropertyValue('--card-w')) || 0;
  probe.remove();
  return width > 0 ? width : null;
}

/** The card width on one seat's battlefield — any card it draws, else its first row's — null before the board has drawn one. */
export function battlefieldCardWidth(root: ParentNode, owner: 'you' | 'them'): number | null {
  const zone = `[data-zone="battlefield"][data-owner="${owner}"]`;
  const drawn = drawnWidth(root.querySelector<HTMLElement>(`${zone} .zone__cards > li.board-card`));
  if (drawn !== null) return drawn;
  const list = root.querySelector<HTMLElement>(`${zone} .zone__cards`);
  return list === null ? null : cardWidthIn(list);
}

/**
 * The card width the viewer's own hand draws at — its row's `--card-w`, the size a card has there
 * while the hand is not so full that its columns narrow — and the battlefield's where there is no
 * hand to read. A card being cast is drawn at this size from the lift to the stack, and only the
 * landing shrinks it into its battlefield slot (the operator, 2026-10-15: "casting cards are just as
 * big as hand cards and shrink down to card size once they resolve"). The row's value, not a drawn
 * card's: it holds still while the cast card leaves the hand and the others close up. A watcher's
 * bottom hand is backs, the same size. Measured with a probe that reads `--card-w` where the hand's
 * cards do (one layout); a caller on a pointer's every move measures once, not per move.
 */
export function handCardWidth(root: ParentNode): number | null {
  const list = root.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"] :is(.zone__cards, .card-backs)');
  if (list === null) return battlefieldCardWidth(root, 'you') ?? battlefieldCardWidth(root, 'them');
  const probe = document.createElement('div');
  probe.style.cssText = 'position: absolute; visibility: hidden; width: var(--card-w); height: 0';
  list.append(probe);
  let width = probe.getBoundingClientRect().width;
  // No layout (a test DOM): the probe's own inherited `--card-w`, when it is already a px value, is the same answer.
  if (!(width > 0)) width = Number.parseFloat(getComputedStyle(probe).getPropertyValue('--card-w')) || 0;
  probe.remove();
  return width > 0 ? width : (battlefieldCardWidth(root, 'you') ?? battlefieldCardWidth(root, 'them'));
}

/** Size an element drawn off the rows as a card `width` wide: `--card-w` in px, which `card.css` and the layers' own CSS read. */
export function sizeAsCard(el: HTMLElement, width: number | null): void {
  if (width === null) el.style.removeProperty('--card-w');
  else el.style.setProperty('--card-w', `${width}px`);
}
