/**
 * Everything one surface of the page ever showed, recorded by a `MutationObserver` from the
 * moment it is installed: whether it was drawn, its text, and the attributes asked for.
 *
 * A polling tick reads the DOM between its sleeps, so a state shorter than the tick is
 * missed and an assertion of "it showed at least once" or "these two never showed together"
 * is decided by when the tick happened to land. An observer runs after every DOM change,
 * before the browser paints it, so whatever was ever on screen is in the record.
 *
 * Rows carry the wall clock (`Date.now()`): every page of a test runs on this one machine,
 * so rows from alice's and bob's pages, and a time the test itself took, compare directly.
 * They carry the page's own `performance.now()` too, for a gap measured on one page.
 */

import type { Page } from '@playwright/test';

export interface SurfaceRow {
  /** `Date.now()` on the page when the change was observed: comparable across pages. */
  wall: number;
  /** `performance.now()` on the page then: finer, for a gap between two rows of one page. */
  t: number;
  /** Is a matching element in the layout (it has a box and is not `visibility: hidden`)? */
  shown: boolean;
  /** Its trimmed text, `''` when there is none. */
  text: string;
  /** The asked-for attributes of it, null when absent (or when it is). */
  attrs: Record<string, string | null>;
}

export interface Surface {
  /** Every change so far, the state at install first. */
  rows(): Promise<SurfaceRow[]>;
}

/** A shown stretch of a surface, in wall-clock ms; `to` is `Infinity` while it still shows. */
export interface Span {
  from: number;
  to: number;
}

let installed = 0;

/**
 * Record the first element matching `selector` on `page`, from now on.
 *
 * `shown: 'present'` reads "shown" as "in the DOM" and skips the layout read: for a surface
 * that is always drawn (the phase rail) watched by a timing spec, where forcing a layout on
 * every change would add to the very gaps it measures.
 */
export async function recordSurface(
  page: Page,
  selector: string,
  opts: { attrs?: readonly string[]; shown?: 'layout' | 'present' } = {},
): Promise<Surface> {
  const key = `s${++installed}`;
  await page.evaluate(
    ({ key, selector, attrs, layout }) => {
      const w = window as unknown as { __surfaces?: Record<string, SurfaceRow[]> };
      const rows: SurfaceRow[] = [];
      (w.__surfaces ??= {})[key] = rows;
      let last = '';
      const read = (): void => {
        const el = document.querySelector(selector);
        const shown = el !== null && (!layout || (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'));
        const row: SurfaceRow = {
          wall: Date.now(),
          t: performance.now(),
          shown,
          text: el?.textContent?.trim() ?? '',
          attrs: Object.fromEntries(attrs.map((a) => [a, el?.getAttribute(a) ?? null])),
        };
        const sig = JSON.stringify([shown, row.text, row.attrs]);
        if (sig === last) return;
        last = sig;
        rows.push(row);
      };
      new MutationObserver(read).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      read();
    },
    { key, selector, attrs: [...(opts.attrs ?? [])], layout: opts.shown !== 'present' },
  );
  return {
    rows: () => page.evaluate((k) => [...((window as unknown as { __surfaces?: Record<string, SurfaceRow[]> }).__surfaces?.[k] ?? [])], key),
  };
}

/** The stretches a surface was shown, in order. */
export function spans(rows: readonly SurfaceRow[]): Span[] {
  const out: Span[] = [];
  for (const r of rows) {
    const open = out.at(-1);
    if (r.shown && (open === undefined || open.to !== Infinity)) out.push({ from: r.wall, to: Infinity });
    else if (!r.shown && open !== undefined && open.to === Infinity) open.to = r.wall;
  }
  return out;
}

/** Every pair of stretches, one from each side, that were shown at the same time. */
export function overlaps(a: readonly Span[], b: readonly Span[]): [Span, Span][] {
  return a.flatMap((x) => b.filter((y) => x.from < y.to && y.from < x.to).map((y): [Span, Span] => [x, y]));
}
