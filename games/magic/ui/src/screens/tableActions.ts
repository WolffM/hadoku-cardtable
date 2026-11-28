/*
 * A table's game, resolved from its card (`TableCard.tsx`): the server's
 * `POST /api/rooms/:roomId/tables/:tableId/{concede,abandon,drop,reset,restore,replay,award}`, the
 * leader's (and an operator's) `POST /api/rooms/:roomId/tables/reset` and `POST /api/rooms/:roomId/pod/dq`,
 * and `GET /api/rooms/:roomId/admin/live` (`games/magic/server/src/http/table-actions.ts`).
 */
import { apiBase, bodyOf, getJson, isRecord, sendJson, serverMessage, type Fetch } from '@hadoku/game-ui/http.ts';

/**
 * Resolve a game at this table — concede it, abandon its series, drop its match, or (the leader or an
 * operator) reset it, restart its turn or replay the match: null once the server has it, else its sentence.
 */
export function resolveTable(action: 'concede' | 'abandon' | 'drop' | 'reset' | 'restore' | 'replay' | 'unstick', roomId: string, tableId: string, fetchImpl?: Fetch): Promise<string | null> {
  return post(`rooms/${encodeURIComponent(roomId)}/tables/${encodeURIComponent(tableId)}/${action}`, {}, fetchImpl);
}

/** The leader starts every table of the room over (`Lobby.resetRoom`): null once the server has it, else its sentence. */
export function resetRoom(roomId: string, fetchImpl?: Fetch): Promise<string | null> {
  return post(`rooms/${encodeURIComponent(roomId)}/tables/reset`, {}, fetchImpl);
}

/** The leader disqualifies a pod entrant: null once the server has it, else its sentence. */
export function dqPlayer(roomId: string, memberId: string, fetchImpl?: Fetch): Promise<string | null> {
  return post(`rooms/${encodeURIComponent(roomId)}/pod/dq`, { memberId }, fetchImpl);
}

/** A game (or with `match`, the whole match) is the table seat's: null once the server has it, else its sentence. */
export function awardTable(roomId: string, tableId: string, seat: 0 | 1, match: boolean, fetchImpl?: Fetch): Promise<string | null> {
  return post(`rooms/${encodeURIComponent(roomId)}/tables/${encodeURIComponent(tableId)}/award`, { seat, match }, fetchImpl);
}

/** One seat of a live match as the server reads it (`Match.inspect`). */
export interface LiveSeat {
  seat: number;
  ai: boolean;
  here: boolean;
  away: boolean;
  asks: { method: string; ageMs: number }[];
  waitingOn: string | null;
  /** What Forge waited on at the last re-send that this seat had not been shown. */
  unshown?: string[];
  clock: { ms: number; running: boolean } | null;
}

/** A table of the room's round as the server reads it (`GET …/admin/live`). */
export interface LiveTable {
  tableId: string;
  matchId: string | null;
  match: { status: string; turn: number | null; active: 0 | 1 | null; restoreTurn: number | null; lastActivityAt: number | null; seats: LiveSeat[] } | null;
  epochs: string[];
}

/** The room's live tables, at the server's clock (`now`), or null when the caller may not read them. */
export async function liveTables(roomId: string, fetchImpl?: Fetch): Promise<{ now: number; tables: LiveTable[] } | null> {
  const res = await getJson(`${apiBase()}rooms/${encodeURIComponent(roomId)}/admin/live`, fetchImpl);
  if (!res.ok) return null;
  const body = await bodyOf(res);
  return isRecord(body) && typeof body.now === 'number' && Array.isArray(body.tables) ? { now: body.now, tables: body.tables as LiveTable[] } : null;
}

async function post(path: string, body: unknown, fetchImpl?: Fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await sendJson(`${apiBase()}${path}`, 'POST', body, fetchImpl);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return res.ok ? null : serverMessage(await bodyOf(res), res.status);
}
