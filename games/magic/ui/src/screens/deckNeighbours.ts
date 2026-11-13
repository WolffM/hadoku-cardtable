/*
 * Which deck lists a reader is likely to switch to next, so their art can be decoded while the grid
 * is idle and a switch crossfades at once (`deckSwap.ts` holds the old grid until the new list's
 * faces have decoded). The operator, 2026-11-01, on the crossfade's first film: *"when going to the
 * 3rd year the old images stick for a few seconds before actually swapping to the next set"* — that
 * year's art was cold, and the old grid stood while it loaded.
 *
 * The neighbours are the years beside the one shown on its own tab, then each other tab's opening
 * list: one nudge away on the year slider, or one press in the tab row.
 */

import type { Browse } from './constructed-mode/ClassicOptions.tsx';
import { FORMAT_TABS, erasOf, type TableFormat } from './tables.ts';

/** The eras beside `poolId` on its own tab, then the first era of every other tab. */
export function poolNeighbours(formats: readonly TableFormat[], poolId: string): string[] {
  const out: string[] = [];
  const own = formats.find((f) => f.id === poolId)?.family;
  if (own !== undefined) {
    const eras = erasOf(formats, own);
    const at = eras.findIndex((f) => f.id === poolId);
    for (const near of [eras[at - 1], eras[at + 1]]) if (near !== undefined) out.push(near.id);
  }
  for (const tab of FORMAT_TABS) {
    const first = tab.id === own ? undefined : erasOf(formats, tab.id)[0];
    if (first !== undefined && first.id !== poolId && !out.includes(first.id)) out.push(first.id);
  }
  return out;
}

/** Free pick's browse: the eras beside the one browsed on its tab, then every other tab as it opens. */
export function browseNeighbours(formats: readonly TableFormat[], browse: Browse): Browse[] {
  const out: Browse[] = [];
  if (browse.family !== 'mine' && browse.era !== '') {
    const eras = erasOf(formats, browse.family);
    const at = eras.findIndex((f) => f.id === browse.era);
    for (const near of [eras[at - 1], eras[at + 1]]) if (near !== undefined) out.push({ family: browse.family, era: near.id });
  }
  for (const tab of FORMAT_TABS) if (tab.id !== browse.family) out.push({ family: tab.id, era: '' });
  return out;
}
