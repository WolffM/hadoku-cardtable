/*
 * The board's side of the live match's settings (`./liveMatchSettings.ts`): this seat's remembered
 * triggers, published while the board is mounted.
 */

import { useEffect } from 'react';

import { setTriggerDecision, type LiveMatch } from '../play/live/match.ts';
import { publishLiveMatchSettings } from './liveMatchSettings.ts';

/** For the board: publish this seat's match while it is mounted. A watcher has nothing to publish. */
export function usePublishLiveMatchSettings(match: LiveMatch, seated: boolean): void {
  const triggers = match.triggerDecisions;
  useEffect(() => {
    if (!seated) return undefined;
    publishLiveMatchSettings({ triggers, clear: (key) => setTriggerDecision(match, key, 'ASK') });
    return () => publishLiveMatchSettings(null);
  }, [match, seated, triggers]);
}
