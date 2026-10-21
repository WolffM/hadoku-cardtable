/*
 * A screen's top layer: the one place everything that floats over the page is drawn.
 *
 * Each screen that shows cards mounts one empty `[data-board-zoom]` box at
 * `--z-zoom` (`play/board.css`'s `.board__zoom`, `styles.css`'s `.pod__zoom`,
 * `screens.css`'s `.peek__zoom`, `deck/deckEditor.css`'s `.deck-editor__zoom`),
 * `pointer-events: none`, as the screen's last child. The inspector, the board's
 * tooltip and the fan's related row draw into it, placed in its own coordinates
 * from the measured rect of what they belong to.
 *
 * Drawing there rather than beside the anchor is the whole point: a z-index only
 * orders an element inside its nearest stacking context, so an overlay drawn
 * inside a pack, a pile or a seat can never rise above the page regions beside
 * that ancestor however large its number. In this layer nothing is above it.
 */

/** The selector of a screen's top layer. */
export const TOP_LAYER = '[data-board-zoom]';

/** The top layer inside `root`, if it has one. */
export function topLayerIn(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(TOP_LAYER);
}

/** The top layer of the screen `el` is on: the nearest one inside any of its ancestors. */
export function topLayerOf(el: Element): HTMLElement | null {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    const layer = topLayerIn(at);
    if (layer !== null) return layer;
  }
  return null;
}

/** Where `anchor`'s top-left corner is in `layer`'s own coordinates. */
export function originIn(layer: Element, anchor: Element): { left: number; top: number } {
  const a = anchor.getBoundingClientRect();
  const l = layer.getBoundingClientRect();
  return { left: a.left - l.left, top: a.top - l.top };
}
