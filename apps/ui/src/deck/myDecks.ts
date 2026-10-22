/*
 * The Decks page's client: `GET /api/decks`, `PATCH`/`DELETE /api/decks/:podId`
 * (`apps/server/src/http/decks.ts`, contract in `@hadoku/shared`'s draft.ts).
 * A deck's build is still saved through `deckStore.ts` — the pod's one save
 * path — so this lists, renames and deletes, and nothing else.
 */

import { MyDeckSchema, MyDecksSchema, type MyDeck } from '@hadoku/shared';
import { apiBase, bodyOf, getJson, sendJson, serverMessage, type Fetch } from '../http.ts';

export type { MyDeck };

export type DeckChange = { ok: true } | { ok: false; message: string };

export interface MyDecksClient {
  list(): Promise<MyDeck[]>;
  rename(id: string, name: string): Promise<{ ok: true; deck: MyDeck } | { ok: false; message: string }>;
  remove(id: string): Promise<DeckChange>;
}

const errorOf = async (res: Response): Promise<string> => serverMessage(await bodyOf(res), res.status);

export function myDecksClient(fetchImpl: Fetch = (input, init) => fetch(input, init), base: string = apiBase()): MyDecksClient {
  const url = (id?: string): string => `${base}decks${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
  const send = async (request: () => Promise<Response>): Promise<Response | string> => {
    try {
      return await request();
    } catch {
      return 'Could not reach the server.';
    }
  };

  return {
    async list() {
      let res: Response;
      try {
        res = await getJson(url(), fetchImpl);
      } catch {
        throw new Error('Could not reach the server.');
      }
      if (!res.ok) throw new Error(`Could not load your decks: ${await errorOf(res)}.`);
      const parsed = MyDecksSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new Error('The server sent something this app cannot read as your decks.');
      return parsed.data.decks;
    },

    async rename(id, name) {
      const res = await send(() => sendJson(url(id), 'PATCH', { name }, fetchImpl));
      if (typeof res === 'string') return { ok: false, message: res };
      if (!res.ok) return { ok: false, message: await errorOf(res) };
      const parsed = MyDeckSchema.safeParse(((await res.json().catch(() => null)) as { deck?: unknown } | null)?.deck);
      return parsed.success ? { ok: true, deck: parsed.data } : { ok: false, message: 'The server sent something this app cannot read as a deck.' };
    },

    async remove(id) {
      const res = await send(() => fetchImpl(url(id), { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } }));
      if (typeof res === 'string') return { ok: false, message: res };
      return res.ok ? { ok: true } : { ok: false, message: await errorOf(res) };
    },
  };
}
