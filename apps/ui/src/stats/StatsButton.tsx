/*
 * The lobby's way into the stats: the trophy beside the settings gear, and the popout it opens.
 *
 * The popout (`./StatsPopout.tsx`, with the stats screen and the deck peek under it) is a chunk of
 * its own (`../lazy.ts`): it draws only on `#/stats`, and the lobby draws without it. The trophy
 * still warms it, as it always warmed the reads: once the lobby is idle and again on hover, the
 * chunk loads and every read the popout opens with starts, so opening draws at once.
 */

import { useEffect } from 'react';
import { Icon } from '@wolffm/themes';

import { whenIdle } from '../idle.ts';
import { lazyComponent } from '../lazy.ts';
import { routeHash } from '../screens/route.ts';
import { uiLength } from '../settings/ui-scale.ts';
import type { StatsSource } from './StatsPopout.tsx';

const popout = () => import('./StatsPopout.tsx');

export const StatsPopout = lazyComponent(() => popout().then((m) => m.StatsPopout));

/** The popout's chunk, and every read it opens with, for the viewer. */
function prefetch(source: StatsSource | undefined): void {
  void StatsPopout.preload();
  popout().then(
    (m) => m.prefetchStats(source),
    (err: unknown) => console.warn('[stats] the stats did not load ahead of the popout', err),
  );
}

/** The trophy beside the settings gear: opens the viewer's stats, and warms them first. */
export function StatsButton({ source }: { source?: StatsSource }) {
  useEffect(() => whenIdle(() => prefetch(source)), [source]);
  return (
    <a
      className="ct-round-button"
      href={routeHash({ kind: 'stats' })}
      aria-label="Stats"
      data-testid="lobby-stats"
      onPointerEnter={() => prefetch(source)}
    >
      <Icon name="trophy" size={uiLength('1.1rem')} />
    </a>
  );
}
