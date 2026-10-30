/*
 * A table's game, resolved from its card (`TableCard.tsx`): the server's
 * `POST /api/rooms/:roomId/tables/:tableId/{concede,abandon,drop,reset}` and the leader's
 * `POST /api/rooms/:roomId/pod/dq` (`apps/server/src/http/table-actions.ts`).
 */
import { apiBase, bodyOf, sendJson, serverMessage, type Fetch } from '../http.ts';

/** Resolve a game at this table — concede it, abandon its series, drop its match, or (the leader) reset it: null once the server has it, else its sentence. */
export function resolveTable(action: 'concede' | 'abandon' | 'drop' | 'reset', roomId: string, tableId: string, fetchImpl?: Fetch): Promise<string | null> {
  return post(`rooms/${encodeURIComponent(roomId)}/tables/${encodeURIComponent(tableId)}/${action}`, {}, fetchImpl);
}

/** The leader disqualifies a pod entrant: null once the server has it, else its sentence. */
export function dqPlayer(roomId: string, memberId: string, fetchImpl?: Fetch): Promise<string | null> {
  return post(`rooms/${encodeURIComponent(roomId)}/pod/dq`, { memberId }, fetchImpl);
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
