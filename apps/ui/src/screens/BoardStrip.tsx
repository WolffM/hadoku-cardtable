/*
 * The board strip — wave 71 §G.
 *
 * Today the match screen shows one board with no way to see another, even
 * when a room now holds several 1v1 tables (wave 71 §D). This is the switch:
 * one pill per table that has a live match, drawn ABOVE the board, picking
 * one navigates to `#/match/<id>` and nothing else — it never concedes or
 * leaves the viewer's own game, because it is a plain link and the match it
 * points away from keeps running on the server whether anyone is watching it.
 *
 * Drawn only when there are at least two live tables (`MatchScreen.tsx`'s
 * job, not this component's — it is told the room's tables and draws nothing
 * itself when there is nothing to switch to). A player in a live game sees
 * this strip too: their own table is one of the pills, highlighted, and nobody
 * is forced off it.
 *
 * Purely presentational, on purpose — it takes already-parsed tables and does
 * no fetching of its own, which is what makes it unit-testable with a plain
 * fixture (`BoardStrip.test.ts`) instead of a mocked server.
 *
 * ## The shape
 *
 * `docs/planning/wave71-2026-10-17.md`'s wire contract names `RoomView.tables:
 * RoomTable[]`, owned by lane D in `packages/shared/src/room-tables.ts` — that
 * file landed, in this same worktree, while this lane was running (checked at
 * the start of this lane's work, when it did not exist, and again before
 * closing it), so this reads `RoomTable` from `@hadoku/shared` directly rather
 * than carrying a local stand-in.
 *
 * `apps/ui/src/screens/tables.ts` separately exports an UNRELATED type also
 * named `RoomTable` (a room's whole table state, pre-wave-71) — neither file
 * imports the other's, so the two names never collide at one import site, but
 * anyone grepping for `RoomTable` in this app will find both and should mind
 * which is which.
 */

import type { RoomTable } from '@hadoku/shared';

import { routeHash } from './route.ts';

export interface BoardStripProps {
  tables: RoomTable[];
  /** The board this screen is already showing — highlighted, not excluded. */
  currentMatchId: string;
  /**
   * The pod's own room id, wave 72 §R.3: present only when this room is a
   * draft pod past its lobby, and distinct from a constructed room, which
   * never passes this. Draws a "Back to the pod" entry alongside the
   * per-table pills, because a pod's overview (standings, the bye, who is
   * at which table) is not reachable from a live board any other way — the
   * 1v1 result screen's own "Back to room" only ever shows once a match has
   * ended (`LiveBoard.tsx`'s `live--gone` state), never while watching one.
   */
  podRoomId?: string;
}

function hasLiveMatch(t: RoomTable): t is RoomTable & { matchId: string } {
  return t.matchId !== null;
}

/** "Alice 1–0 Bob", from whichever seats are filled. Never explanatory text — just the two names and the score. */
function label(t: RoomTable & { matchId: string }): string {
  const [p0, p1] = t.players;
  return `${p0?.name ?? ''} ${t.series.wins[0]}–${t.series.wins[1]} ${p1?.name ?? ''}`.trim();
}

/**
 * Nothing at all with fewer than two live tables and no pod to go back to —
 * the common room today, and every room before wave 71. `MatchScreen.tsx`
 * passes the room's tables unfiltered; this is the one place "is there
 * anything to switch to (or back to)" is decided, so a second caller cannot
 * forget the gate. A pod draws the strip even with 0 or 1 live tables —
 * a round between games, with everyone sideboarding, still needs a way back.
 */
export function BoardStrip({ tables, currentMatchId, podRoomId }: BoardStripProps) {
  const live = tables.filter(hasLiveMatch);
  if (live.length < 2 && podRoomId === undefined) return null;

  return (
    <div className="board-strip" data-testid="board-strip">
      {/* No `--back` modifier in `BoardStrip.css` — step 0 already landed that
          file, and this lane does not reopen it for a plain pill that needs
          no visual distinction from a table pick beyond its own label. */}
      {podRoomId !== undefined && (
        <a href={routeHash({ kind: 'room', roomId: podRoomId })} className="board-strip__entry" data-testid="board-strip-back">
          Pod
        </a>
      )}
      {live.map((t) => (
        <a
          key={t.id}
          href={routeHash({ kind: 'match', matchId: t.matchId })}
          className={t.matchId === currentMatchId ? 'board-strip__entry board-strip__entry--active' : 'board-strip__entry'}
          data-testid="board-strip-entry"
          data-table-id={t.id}
        >
          {label(t)}
        </a>
      ))}
    </div>
  );
}
