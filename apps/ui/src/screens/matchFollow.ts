/*
 * A board whose game its room let go of with no result — the leader's Reset game (`Lobby.resetGame`,
 * the operator, 2026-10-30: *"the current game restarts from scratch with the same decks"*), or a game
 * whose JVM died — has nothing more coming: Forge was stopped, not ended. The match screen follows its
 * room, and once its table holds another game, or none yet with the series still `playing`, it goes
 * there: to the new match, or to the table page, which starts it (`useTableStart`).
 *
 * A game that ended (its id in the series' games) or a series that is over or set aside (Drop, Abandon,
 * a DQ) stays on the board: its result screen is the way on.
 */
import { useEffect } from 'react';

import { roomsClient, type RoomView } from '../rooms/api.ts';
import { roomFeed } from '../rooms/feed.ts';
import { navigate, type Route } from './route.ts';

/** Where a screen showing `matchId`, last seen at `tableId`, goes now; null: stay. */
export function replacedGameRoute(room: RoomView, matchId: string, tableId: string): Route | null {
  const table = room.tables.find((t) => t.id === tableId);
  if (table === undefined || table.matchId === matchId) return null;
  if (table.series.phase !== 'playing' || table.series.games.some((g) => g.matchId === matchId)) return null;
  return table.matchId === null ? { kind: 'room', roomId: room.id, tableId } : { kind: 'match', matchId: table.matchId };
}

/** Follows `roomId` while `matchId` is on screen, and goes on to its table's next game once it is replaced. */
export function useFollowReplacedGame(matchId: string, roomId: string | null): void {
  useEffect(() => {
    if (roomId === null) return;
    let tableId: string | null = null;
    let live = true;
    const read = (): void => {
      roomsClient()
        .get(roomId)
        .then(
          (room) => {
            if (!live || room === null) return;
            tableId ??= room.tables.find((t) => t.matchId === matchId)?.id ?? null;
            const next = tableId === null ? null : replacedGameRoute(room, matchId, tableId);
            if (next !== null) navigate(next, { replace: true });
          },
          // An unanswered read is asked again at the room's next change or the feed's fallback read.
          () => undefined,
        );
    };
    // `follow` reads once at once, then on every change of the room.
    const stop = roomFeed().follow({ room: roomId }, read);
    return () => {
      live = false;
      stop();
    };
  }, [matchId, roomId]);
}
