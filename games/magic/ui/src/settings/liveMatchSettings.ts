/*
 * The live match's own part of the settings: the optional triggers this seat ticked "Always" on.
 *
 * They are the match's, not the player's, so they are not a preference: Forge holds them, and the
 * server reports them (`match.triggerDecisions`). The settings panel is drawn wherever its host puts
 * it — the fleet header's popout, standalone, or our own gear inside a watchparty room — so it is
 * never under the board. The board publishes them here while it is mounted (`./liveMatch.ts`), and
 * the panel's "This match" section reads them back. This side knows nothing of the match module, so
 * the panel draws on every page without the board's code.
 */

import { useSyncExternalStore } from 'react';
import type { RememberedTrigger } from '@hadoku/shared';

export interface LiveMatchSettings {
  triggers: readonly RememberedTrigger[];
  /** Forget one: Forge asks again next time. */
  clear: (key: string) => void;
}

let current: LiveMatchSettings | null = null;
const listeners = new Set<() => void>();

export function publishLiveMatchSettings(next: LiveMatchSettings | null): void {
  current = next;
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The live match's settings, or `null` outside a match and for a watcher. */
export function useLiveMatchSettings(): LiveMatchSettings | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
