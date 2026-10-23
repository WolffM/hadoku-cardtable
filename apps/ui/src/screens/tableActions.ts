/*
 * A table's game, resolved from its card (`TableCard.tsx`): the server's
 * `POST /api/rooms/:roomId/tables/:tableId/concede` (`apps/server/src/http/table-actions.ts`).
 */
import { apiBase, bodyOf, sendJson, serverMessage, type Fetch } from '../http.ts';

/** Concede my game at this table: null once the server has it, else its sentence. */
export async function concedeGame(roomId: string, tableId: string, fetchImpl?: Fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await sendJson(`${apiBase()}rooms/${encodeURIComponent(roomId)}/tables/${encodeURIComponent(tableId)}/concede`, 'POST', {}, fetchImpl);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return res.ok ? null : serverMessage(await bodyOf(res), res.status);
}
