/*
 * The live match's own part of the settings: the optional triggers this seat ticked "Always" on.
 *
 * They are the match's, not the player's, so they are not a preference: Forge holds them, and the
 * server reports them (`match.triggerDecisions`). The settings panel is drawn wherever its host puts
 * it — the fleet header's popout, standalone, or our own gear inside a watchparty room — so it is
 * never under the board. The board publishes them here while it is mounted, and the panel's
 * "This match" section reads them back.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { RememberedTrigger } from '@hadoku/shared';

import { setTriggerDecision, type LiveMatch } from '../play/live/match.ts';

export interface LiveMatchSettings {
  triggers: readonly RememberedTrigger[];
  /** Forget one: Forge asks again next time. */
  clear: (key: string) => void;
}

let current: LiveMatchSettings | null = null;
const listeners = new Set<() => void>();

function publish(next: LiveMatchSettings | null): void {
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

/** For the board: publish this seat's match while it is mounted. A watcher has nothing to publish. */
export function usePublishLiveMatchSettings(match: LiveMatch, seated: boolean): void {
  const triggers = match.triggerDecisions;
  useEffect(() => {
    if (!seated) return undefined;
    publish({ triggers, clear: (key) => setTriggerDecision(match, key, 'ASK') });
    return () => publish(null);
  }, [match, seated, triggers]);
}
