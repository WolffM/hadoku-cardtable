/**
 * Every box `board.css` sizes cards from — a battlefield, a hand, a lane, a pile — measured, and
 * written onto itself as `--zone-w`/`--zone-h` (its content box, px) and `data-zone-aspect` (its
 * width over height, as the band `board.css`'s row count steps on: 3, 4, 5, 6, 8 or 10).
 *
 * These were CSS size containers (`100cqh`, `@container row-zone (aspect-ratio >= …)`). A size
 * container made ANY layout anywhere on the board — a drop indicator, a hover lift, one changed
 * card name — lay all of the containers' contents out again: 8–25 ms a frame on a CI runner while a card
 * is dragged, against 0.4 ms measured with the same sizes written as px (the operator, 2026-10-10:
 * "this needs to be buttery smooth, i expect to get at least ~250fps at all times").
 *
 * No feedback: every measured box keeps `contain: size` (`board.css`), so nothing written here can
 * change the size of the box it was measured from — only of what is inside it. A lane's own width
 * does follow its battlefield's row count, which the battlefield's aspect sets; a lane is deeper
 * than its battlefield, so the observer measures it again in the same frame, as it is specified to.
 *
 * First paint: an observer reports every box the first time it is observed, after layout and before
 * paint, and `board.css`'s rules are laid out again before that paint — no frame is drawn unsized.
 * A window resize is measured as well, from its own event: that runs before the frame's animation
 * callbacks, which the observer runs after, so nothing that reads the board in a frame callback
 * (`e2e/table-fit.spec.ts` does, every frame) sees the old sizes for the one frame of a resize.
 */
export const ZONE_BOXES = '.seat > .zone--battlefield, .seat > .zone--hand, .zone__row, .seat .zone--graveyard, .seat .zone--exile, .seat .zone--library';

/** The bands `board.css` steps on, widest first. */
const ASPECT_BANDS = [10, 8, 6, 5, 4, 3] as const;

/** One box's measure, written; exported for the tests. */
export function writeZoneBox(el: HTMLElement, width: number, height: number): void {
  el.style.setProperty('--zone-w', `${width}px`);
  el.style.setProperty('--zone-h', `${height}px`);
  const band = height > 0 ? ASPECT_BANDS.find((b) => width / height >= b) : undefined;
  if (band === undefined) el.removeAttribute('data-zone-aspect');
  else el.setAttribute('data-zone-aspect', String(band));
}

export interface ZoneBoxes {
  /** Observe every box under `root` not yet observed, and forget the ones gone from the page. */
  sync(root: ParentNode): void;
  disconnect(): void;
}

/** Null where there is no `ResizeObserver` (a test DOM): there is no layout to measure either. */
export function observeZoneBoxes(): ZoneBoxes | null {
  if (typeof ResizeObserver === 'undefined') return null;
  const observed = new Set<Element>();
  // Read from the entries alone, then written in one pass: no layout read after a write.
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.contentBoxSize[0];
      if (box !== undefined && entry.target instanceof HTMLElement) writeZoneBox(entry.target, box.inlineSize, box.blockSize);
    }
  });
  const onResize = (): void => {
    // Every box read, then every box written: one layout for the lot.
    const measured = [...observed].filter((el): el is HTMLElement => el instanceof HTMLElement && el.isConnected).map((el) => {
      const style = getComputedStyle(el);
      const pad = (a: string, b: string): number => (Number.parseFloat(style.getPropertyValue(a)) || 0) + (Number.parseFloat(style.getPropertyValue(b)) || 0);
      return { el, width: el.clientWidth - pad('padding-left', 'padding-right'), height: el.clientHeight - pad('padding-top', 'padding-bottom') };
    });
    for (const { el, width, height } of measured) writeZoneBox(el, width, height);
  };
  window.addEventListener('resize', onResize);
  return {
    sync(root) {
      for (const el of observed) {
        if (el.isConnected) continue;
        observer.unobserve(el);
        observed.delete(el);
      }
      for (const el of root.querySelectorAll(ZONE_BOXES)) {
        if (observed.has(el)) continue;
        observed.add(el);
        observer.observe(el);
      }
    },
    disconnect() {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
      observed.clear();
    },
  };
}
