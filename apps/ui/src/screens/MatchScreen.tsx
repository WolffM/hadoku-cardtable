/*
 * `#/match/<matchId>` — a live match.
 *
 * The same shape as a pod: the URL IS the invite. Opening it joins the match
 * over the socket, and the server's first join by a participant claims the
 * first free human seat (`apps/server/src/play/socket.ts`). A match is reached
 * through its room now, so this screen draws no header and no invite box:
 * both were removed on 2026-09-19, and they must not come back — every row of
 * chrome here is height the table does not have.
 *
 * The screen is the live board (`play/live/`) and one "leave" line under it,
 * and it is exactly one viewport tall: `.shell--match` is the hook
 * `play/live/live.css` uses to pin the page to the window, because *"this
 * module can NEVER require a scroll bar"*. `e2e/table-fit.spec.ts` measures
 * that on a live match.
 *
 * It mounts no `RoomChrome`: `App` mounts the one the page has, and its store
 * and socket are module singletons. This screen owns the match handle's
 * lifetime and nothing else: it opens the connection on mount and closes it
 * on unmount, so leaving the route does not leave a socket behind.
 */

import { useEffect, useState } from 'react';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import { closeMatch, startMatch, type LiveMatch, type MatchTransport } from '../play/live/match.ts';
import { navigate } from './route.ts';

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
