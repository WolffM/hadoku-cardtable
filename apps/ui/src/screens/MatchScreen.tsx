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
 * The screen is the live board (`play/live/`) and nothing else. It held a
 * "leave" line under the canvas until wave 22 §F moved Leave into the match's
 * own button bar — *"a really weird spot"* (the operator) — so there is no
 * footer here, and adding one back would put a second leave affordance and a
 * second tab stop on the page. `LiveBoard`'s `onLeave` defaults to
 * `navigate({ kind: 'lobby' })`, which is why this screen wires nothing.
 *
 * It is exactly one viewport tall: `.shell--match` is the hook
 * `chrome/chrome.css` uses to pin the page to the window, because *"this
 * module can NEVER require a scroll bar"*. `e2e/table-fit.spec.ts` measures
 * that on a live match.
 *
 * It mounts no `RoomChrome`: `App` mounts the one the page has, and its store
 * and socket are module singletons. This screen owns the match handle's
 * lifetime and nothing else: it opens the connection on mount — or adopts the
 * one a room opened before handing the page over (`play/live/matchStart.ts`),
 * so the walk from Ready to the board has no loading screen — and closes it on
 * unmount, so leaving the route does not leave a socket behind.
 *
 * ## Fast Mode's transport (wave 47)
 *
 * Production gets a REAL transport wrapped in `./pace.ts`'s pacer, built
 * around `socketIoMatchTransport()` — never `makeTransport?.()`'s own
 * result, which a test passes already built, exactly the shape it wants, and
 * which `./match.ts`'s jar-gated suites build for themselves (unpaced,
 * per the wave file's blast-radius table — this screen never runs there).
 * `initialFast` reads `PLAY_PREFS_DEFAULTS.fastMode` so the FIRST frame is
 * never paced in a mode nobody asked for (the e2e harness's own override,
 * or a returning viewer's persisted choice once `LiveBoard`'s settings
 * wiring re-applies it after this join resolves — see that file's own note).
 *
 * ## No strip over the board
 *
 * Wave 71 drew a strip of the room's live tables over the board, plus a way
 * back to the pod. The operator, 2026-10-19: *"neither of those buttons should
 * be there, useless"* — the room's own table cards are where another board is
 * opened, and the room is reached from the room list.
 */

import { useEffect, useLayoutEffect, useState } from 'react';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import { knownRoomOfMatch, takeWarmMatch, warmMatchesWith } from '../play/live/matchStart.ts';
import { pacedMatchTransport } from '../play/live/pace.ts';
import { PLAY_PREFS_DEFAULTS } from '../play/live/prefs.ts';
import { roomsClient } from '../rooms/api.ts';
import {
  closeMatch,
  socketIoMatchTransport,
  startMatch,
  type LiveMatch,
  type MatchTransport,
  type MatchTrouble,
} from '../play/live/match.ts';
import { apiUrl, sendJson } from '../http.ts';
import { useChromeShell } from '../chrome/shell.ts';

/** A board's trouble, to the server over HTTP: the socket is what is in trouble. */
function reportTrouble(matchId: string, what: MatchTrouble, detail: Record<string, unknown>): void {
  const url = apiUrl(`play/matches/${encodeURIComponent(matchId)}/report`);
  void sendJson(url, 'POST', { what, ui: __HADOKU_UI_VERSION__, detail }, undefined, { keepalive: true }).catch((err: unknown) => console.warn('[match] could not report', what, err));
}

/** The page's one way to open a match: a paced socket, its trouble reported over HTTP. */
function openMatch(matchId: string, transport?: MatchTransport): LiveMatch {
  return startMatch({
    matchId,
    transport: transport ?? pacedMatchTransport(socketIoMatchTransport(), { initialFast: PLAY_PREFS_DEFAULTS.fastMode }),
    report: (what, detail) => reportTrouble(matchId, what, detail),
  });
}

// A room opens its new match through this before it hands the page over (`matchStart.ts`).
warmMatchesWith(openMatch);

export interface MatchScreenProps {
  matchId: string;
  /** Tests pass a stub transport. Production leaves it undefined and gets a paced socket.io transport. */
  makeTransport?: () => MatchTransport;
}

export function MatchScreen({ matchId, makeTransport }: MatchScreenProps) {
  const shellRef = useChromeShell('match');
  const [match, setMatch] = useState<LiveMatch | null>(null);

  // Before paint, so a match the room already opened is drawn in the first frame, not after an empty one.
  useLayoutEffect(() => {
    const handle = (makeTransport === undefined ? takeWarmMatch(matchId) : null) ?? openMatch(matchId, makeTransport?.());
    setMatch(handle);
    return () => closeMatch(handle);
  }, [matchId, makeTransport]);

  // The room that started this match: the board's way back, and the table its
  // result screen readies at for a Rematch. The route carries only the match
  // id, so the server is asked which room started it — and it remembers that
  // after the match is over and across a restart, which the room list never did
  // (a reload on the result screen used to find no room and grey Rematch out).
  // Unknown is a legitimate answer (a match link from elsewhere, a server that
  // would not answer): the board then says "Back to the lobby", which is where
  // that viewer belongs.
  const [roomId, setRoomId] = useState<string | null>(() => knownRoomOfMatch(matchId)?.id ?? null);
  useEffect(() => {
    const known = knownRoomOfMatch(matchId);
    if (known !== undefined) {
      setRoomId(known?.id ?? null);
      return;
    }
    let live = true;
    roomsClient()
      .roomOfMatch(matchId)
      .then(
        (room) => {
          if (live) setRoomId(room?.id ?? null);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [matchId]);

  return (
    <div ref={shellRef} className="shell shell--match" data-testid="match" style={{ position: 'relative' }}>
      {match !== null && <LiveBoard match={match} roomId={roomId} />}
    </div>
  );
}
