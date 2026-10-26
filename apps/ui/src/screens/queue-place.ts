/**
 * My place in the server's queue for a Forge JVM, while a start I am waiting on waits its turn.
 *
 * The server boots a few match JVMs at a time and queues the rest (`apps/server/src/play/start-queue.ts`):
 * a burst of starts all booting together took ~50 s each. A start's `POST /api/play/matches` is only
 * answered once Forge is up, so while it is pending the page asks `GET /api/play/queue` for the
 * place of any start the caller is waiting on — their own, or a room start that seats them.
 */

import { useEffect, useState } from 'react';

/** How often a waiting page asks. */
export const QUEUE_PLACE_MS = 1000;

/** The place, read with `read` (`TablesClient.queuePlace`) while `waiting`; null otherwise, and after a read that failed. */
export function useQueuePlace(waiting: boolean, read: () => Promise<number | null>): number | null {
  const [place, setPlace] = useState<number | null>(null);
  useEffect(() => {
    if (!waiting) {
      setPlace(null);
      return;
    }
    let live = true;
    const ask = (): void => {
      read().then(
        (p) => {
          if (live) setPlace(p);
        },
        // A place we cannot read is not shown; the start itself still answers.
        () => {
          if (live) setPlace(null);
        },
      );
    };
    const timer = setInterval(ask, QUEUE_PLACE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waiting, read]);
  return place;
}

/** What a pending start says, with its place once it has one. */
export function startingText(place: number | null): string {
  return place === null ? 'Starting Forge…' : `Starting Forge… #${place} in the queue`;
}
