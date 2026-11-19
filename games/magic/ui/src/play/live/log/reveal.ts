/**
 * How far a scroll box moves to show an element whose size just changed inside it (a turn of the log
 * opened or folded): down by what ends below the box, and never so far that the element's own top
 * leaves it; up to a top left above the box; nothing for one wholly in view. Both are viewport boxes.
 */
export function revealScroll(box: { top: number; bottom: number }, el: { top: number; bottom: number }): number {
  const above = el.top - box.top;
  if (above < 0) return above;
  return Math.max(0, Math.min(el.bottom - box.bottom, above));
}
