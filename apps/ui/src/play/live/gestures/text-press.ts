/**
 * A press on the board selects text only when it lands ON text.
 *
 * The operator, 2026-10-13: *"dragging on the board shouldn't cause a text
 * highlight on the avatar name. only drag to copy avatar name if dragging in
 * that area."* A press on the board's empty space is one this layer does not
 * claim (nothing to aim, nothing to lift), so the browser's own default ran:
 * it anchors a selection at the nearest text and a drag extends it across the
 * seat names and anything else in the way. `./gestures.css`'s `user-select:
 * none` cannot help — it is written only once a gesture passes the slop — and
 * a static one on the whole frame would also take the name's own selection
 * away.
 *
 * So the selection is refused where it begins: `selectstart`, the event the
 * browser fires before it starts one, is cancelled unless the press that began
 * it landed inside a run of text (or in a text field). Every press in the
 * match frame, claimed by the gesture layer or not, is held to the same rule.
 */

/** The press point is over a text node's own glyph boxes, not merely nearest to one. */
export function pointOnText(doc: Document, x: number, y: number): boolean {
  const node = doc.caretPositionFromPoint?.(x, y)?.offsetNode ?? doc.caretRangeFromPoint?.(x, y)?.startContainer ?? null;
  if (node === null || node.nodeType !== Node.TEXT_NODE) return false;
  const range = doc.createRange();
  range.selectNodeContents(node);
  return Array.from(range.getClientRects()).some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
}

const isTextField = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null;

/** Install the rule on `canvas`; returns its teardown. */
export function guardTextSelection(canvas: HTMLElement): () => void {
  const view = canvas.ownerDocument.defaultView ?? window;
  /** Whether the press now held may start a selection; `null` while no press is held. */
  let mayselect: boolean | null = null;

  const onDown = (event: PointerEvent): void => {
    mayselect = isTextField(event.target) || pointOnText(canvas.ownerDocument, event.clientX, event.clientY);
  };
  const onUp = (): void => {
    mayselect = null;
  };
  const onSelectStart = (event: Event): void => {
    if (mayselect === false) event.preventDefault();
  };

  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('selectstart', onSelectStart);
  view.addEventListener('pointerup', onUp, true);
  view.addEventListener('pointercancel', onUp, true);
  return () => {
    canvas.removeEventListener('pointerdown', onDown, true);
    canvas.removeEventListener('selectstart', onSelectStart);
    view.removeEventListener('pointerup', onUp, true);
    view.removeEventListener('pointercancel', onUp, true);
  };
}
