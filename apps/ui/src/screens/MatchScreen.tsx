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
 * lifetime and nothing else: it opens the connection on mount and closes it
 * on unmount, so leaving the route does not leave a socket behind.
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
 * ## The board strip (wave 71 §G)
 *
 * Once the room is known, this screen also asks it for its `tables` — plural
 * since wave 71, one room can hold several 1v1 tables — and draws
 * `BoardStrip` over the board. `BoardStrip` itself decides whether there is
 * anything to switch to (nothing with fewer than two live tables); this
 * screen's job is only to fetch and keep that list current.
 *
 * `rooms/api.ts`'s `RoomView` does not carry `tables` — it is wave 70's file
 * and `tables` is not on its parser's allow-list — so this reads the room's
 * own endpoint a second time, raw, through `@hadoku/shared`'s `RoomTablesSchema`
 * (lane D's `packages/shared/src/room-tables.ts`), rather than widening a
 * parser this lane does not own.
 *
 * **Stops following once THIS match has ended** (`match.over`, reactively —
 * `useSyncExternalStore` on `match.ts`'s own `subscribe`, the same store
 * `LiveBoard.tsx` reads for everything else). `GameResultScreen` (also
 * `LiveBoard.tsx`) already follows this same room for its own "which room do
 * I rematch into" read, so a second independent `roomFeed().follow()` left
 * running on the result screen doubled the room's idle read volume —
 * `e2e/aa-polling.spec.ts`'s "two result screens left open read nothing"
 * caught it (4 reads in 60 s idle against a budget of 3). The strip's own job
 * — switching to another table — has nothing left to do once this board is a
 * result screen showing Rematch, so there is nothing lost by stopping here,
 * and `tables` just keeps whatever it last knew.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { RoomTablesSchema, type RoomTable } from '@hadoku/shared';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import { pacedMatchTransport } from '../play/live/pace.ts';
import { PLAY_PREFS_DEFAULTS } from '../play/live/prefs.ts';
import { roomsClient } from '../rooms/api.ts';
import { roomFeed } from '../rooms/feed.ts';
import { apiBase } from './tables.ts';
import { BoardStrip } from './BoardStrip.tsx';
import './BoardStrip.css';
import {
  closeMatch,
  socketIoMatchTransport,
  startMatch,
  subscribe,
  type LiveMatch,
  type MatchTransport,
} from '../play/live/match.ts';

export interface MatchScreenProps {
  matchId: string;
  /** Tests pass a stub transport. Production leaves it undefined and gets a paced socket.io transport. */
  makeTransport?: () => MatchTransport;
}

function appBase(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' ? base : '/';
}

/** The room's raw body, read a second time past `rooms/api.ts`'s parser — see the header. */
async function fetchRoomTables(roomId: string): Promise<RoomTable[]> {
  try {
    const res = await fetch(`${apiBase(appBase())}rooms/${encodeURIComponent(roomId)}`, { credentials: 'same-origin' });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    const tables = (body as { tables?: unknown })?.tables;
    const parsed = RoomTablesSchema.safeParse(tables);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function MatchScreen({ matchId, makeTransport }: MatchScreenProps) {
  const [match, setMatch] = useState<LiveMatch | null>(null);

  useEffect(() => {
    const transport =
      makeTransport?.() ?? pacedMatchTransport(socketIoMatchTransport(), { initialFast: PLAY_PREFS_DEFAULTS.fastMode });
    const handle = startMatch({ matchId, transport });
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
  const [roomId, setRoomId] = useState<string | null>(null);
  useEffect(() => {
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

  // This screen's own match, ended or not — `match.ts`'s mutable store, read
  // reactively so the effect below can react to the transition rather than
  // only seeing it on the next unrelated re-render. See the header for why it
  // matters: following stops here, once there is nothing left to switch away
  // FROM.
  const over = useSyncExternalStore(
    (listener) => (match === null ? () => undefined : subscribe(match, listener)),
    () => match?.over ?? false,
  );

  // The room's tables, kept current without polling — `roomFeed` reads once
  // on follow and again whenever the server says the room changed (a second
  // table added, a match starting or ending at one), so the strip below is
  // never more than one ping behind. Nothing follows before `roomId` is known,
  // so a match with no room (an orphaned link) asks the server for nothing —
  // and nothing follows once `over`, so a result screen left open adds no
  // read of its own past the one `GameResultScreen` already makes.
  const [tables, setTables] = useState<RoomTable[]>([]);
  useEffect(() => {
    if (roomId === null || over) return;
    let live = true;
    const stopFollowing = roomFeed().follow({ room: roomId }, () => {
      fetchRoomTables(roomId).then((t) => {
        if (live) setTables(t);
      });
    });
    return () => {
      live = false;
      stopFollowing();
    };
  }, [roomId, over]);

  return (
    <div className="shell shell--match" data-testid="match" style={{ position: 'relative' }}>
      <BoardStrip tables={tables} currentMatchId={matchId} />
      {match !== null && <LiveBoard match={match} roomId={roomId} />}
    </div>
  );
}
