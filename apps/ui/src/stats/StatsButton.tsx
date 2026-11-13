/*
 * The lobby's way into the stats: the trophy beside the settings gear, and the page it opens.
 *
 * The page (`./StatsPage.tsx`, with its tabs and the deck peek under it) is a chunk of its own
 * (`../lazy.ts`): it draws only on its routes, and the lobby draws without it. The trophy still
 * warms it, as it always warmed the reads: once the lobby is idle and again on hover, the chunk
 * loads and every read the Leaderboard opens with starts, so opening draws at once.
 */

import { useEffect } from 'react';
import { Icon } from '@wolffm/themes';

import { whenIdle } from '@hadoku/game-ui/idle.ts';
import { lazyComponent } from '@hadoku/game-ui/lazy.ts';
import { routeHash } from '@hadoku/game-ui/screens/route.ts';
import { uiLength } from '@hadoku/ui-shell/settings';
import type { StatsSource } from './source.ts';

export const StatsPage = lazyComponent(() => import('./StatsPage.tsx').then((m) => m.StatsPage));

/** The page's chunk, and every read its Leaderboard opens with, for the viewer. */
function prefetch(source: StatsSource | undefined): void {
  void StatsPage.preload();
  import('./source.ts').then(
    (m) => m.prefetchLeaderboard(source),
    (err: unknown) => console.warn('[stats] the stats did not load ahead of the page', err),
  );
}

/** The trophy beside the settings gear: opens the Leaderboard, and warms it first. */
export function StatsButton({ source }: { source?: StatsSource }) {
  useEffect(() => whenIdle(() => prefetch(source)), [source]);
  return (
    <a className="ct-round-button" href={routeHash({ kind: 'stats' })} aria-label="Stats" data-testid="lobby-stats" onPointerEnter={() => prefetch(source)}>
      <Icon name="trophy" size={uiLength('1.1rem')} />
    </a>
  );
}
