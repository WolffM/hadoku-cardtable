/*
 * `#/match/<matchId>` — a live match, and the link that seats your opponent.
 *
 * The same shape as a pod: the URL IS the invite. Opening it joins the match
 * over the socket, and the server's first join by a participant claims the
 * first free human seat (`apps/server/src/play/socket.ts`), so the person who
 * started it and the friend they sent it to land in seats 1 and 2 by arriving,
 * with no second lobby in between.
 *
 * Everything below the link is lane A's live board (`play/live/`), mounted as
 * its own harness mounts it. This screen owns the handle's lifetime and
 * nothing else: it opens the connection on mount and closes it on unmount, so
 * leaving the route does not leave a socket behind.
 */

import { useEffect, useState } from 'react';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import { closeMatch, startMatch, type LiveMatch, type MatchTransport } from '../play/live/match.ts';
import {navigate } from './route.ts';

export interface MatchScreenProps {
  matchId: string;
  /** Tests pass a stub transport. Production leaves it undefined and gets socket.io. */
  makeTransport?: () => MatchTransport;
}

export function MatchScreen({ matchId, makeTransport }: MatchScreenProps) {
  const [match, setMatch] = useState<LiveMatch | null>(null);

  useEffect(() => {
    const handle = startMatch({ matchId, transport: makeTransport?.() });
    setMatch(handle);
    return () => closeMatch(handle);
  }, [matchId, makeTransport]);

  return (
    <div className="shell shell--match" data-testid="match">
      {match !== null && <LiveBoard match={match} />}
      <footer className="shell__foot">
        <p>
          <a
            className="shell__link"
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'lobby' });
            }}
          >
            Leave the match
          </a>
        </p>
      </footer>
    </div>
  );
}
