/*
 * A table's game, resolved from its card (`TableCard.tsx`): the server's
 * `POST /api/rooms/:roomId/tables/:tableId/{concede,abandon,drop}` (`apps/server/src/http/table-actions.ts`).
 */
import { apiBase, bodyOf, sendJson, serverMessage, type Fetch } from '../http.ts';

/** Resolve my game at this table — concede it, abandon its series, drop its match: null once the server has it, else its sentence. */
export async function resolveTable(action: 'concede' | 'abandon' | 'drop', roomId: string, tableId: string, fetchImpl?: Fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await sendJson(`${apiBase()}rooms/${encodeURIComponent(roomId)}/tables/${encodeURIComponent(tableId)}/${action}`, 'POST', {}, fetchImpl);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return res.ok ? null : serverMessage(await bodyOf(res), res.status);
}
