/*
 * A table's one way in, for whoever is looking at it: the same answer on the table's page, the
 * room's lobby and the bracket, on every load.
 *
 * It is read off the room's own record and nothing else — the table's game, its series, and
 * whether this player has been at that game (`TableGame.entered`, the server's) — so a reload, a
 * second tab or a different road to the page cannot change it. A game is never walked into for a
 * player: Enter game is their own press (the operator, 2026-11-16 and 2026-11-19).
 */
import type { RoomTable, TableGame } from '@hadoku/shared';

import { openNewMatch } from '../play/live/matchStart.ts';
import { routeHash } from '@hadoku/game-ui/screens/route.ts';
import type { TableCardGo } from './TableCard.tsx';

export type TableDoor =
  /** A game is up and this player has not been at it. */
  | { kind: 'enter'; matchId: string }
  /** A game is up and this player left it. */
  | { kind: 'return'; matchId: string }
  /** Between two games of this player's series. */
  | { kind: 'sideboard' }
  /** Somebody else's game. */
  | { kind: 'watch'; matchId: string };

/**
 * `memberId`'s seat at `table`, or null for anyone who does not sit at it: their place among the
 * people seated, in seat order, which is the seat a game (`TableGame.entered`) and a series count
 * by. Never their place in a round's pairing: that names an AI, which holds no seat, on either
 * side, and an entrant whose seat somebody else may have taken.
 */
export function seatAt(table: Pick<RoomTable, 'players'>, memberId: string | null | undefined): number | null {
  const seat = table.players.findIndex((p) => p.memberId === memberId);
  return seat === -1 ? null : seat;
}

/** `mySeat`: this player's seat at the table (`seatAt`), or null for anyone else. */
export function tableDoor(table: Pick<RoomTable, 'matchId' | 'series'>, game: TableGame | undefined, mySeat: number | null): TableDoor | null {
  const { matchId } = table;
  if (mySeat === null) return matchId === null ? null : { kind: 'watch', matchId };
  if (matchId !== null) return { kind: game?.entered[mySeat] === true ? 'return' : 'enter', matchId };
  return table.series.phase === 'sideboarding' ? { kind: 'sideboard' } : null;
}

const LABEL = { enter: 'Enter game', return: 'Return to game', sideboard: 'Sideboard', watch: 'Watch' } as const;

/** The door as a table card's one action. */
export function doorGo(door: TableDoor | null, roomId: string, tableId: string, testId: string): TableCardGo | null {
  if (door === null) return null;
  const label = LABEL[door.kind];
  if (door.kind === 'sideboard') return { label, href: routeHash({ kind: 'room', roomId, tableId, step: 'sideboard' }), testId, door: door.kind };
  const { matchId } = door;
  const href = routeHash({ kind: 'match', matchId });
  // A game entered for the first time opens the way every new game does: its start sound, and its board ready before the page turns.
  return door.kind === 'enter' ? { label, href, testId, door: door.kind, onPress: () => openNewMatch(matchId) } : { label, href, testId, door: door.kind };
}
