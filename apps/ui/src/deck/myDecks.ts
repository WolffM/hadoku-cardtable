/*
 * The Decks page's client: `GET /api/decks`, `PATCH`/`DELETE /api/decks/:podId`
 * (`apps/server/src/http/decks.ts`, contract in `@hadoku/shared`'s draft.ts).
 * A deck's build is still saved through `deckStore.ts` — the pod's one save
 * path — so this lists, renames and deletes, and nothing else.
 */

import { MyDeckSchema, MyDecksSchema, type MyDeck } from '@hadoku/shared';
import { apiBase } from '../screens/tables.ts';
import type { Fetch } from './deckStore.ts';

export type { MyDeck };

export type DeckChange = { ok: true } | { ok: false; message: string };

export interface MyDecksClient {
  list(): Promise<MyDeck[]>;
  rename(id: string, name: string): Promise<{ ok: true; deck: MyDeck } | { ok: false; message: string }>;
  remove(id: string): Promise<DeckChange>;
}

function defaultApiBase(): string {
  const base = import.meta.env?.BASE_URL;
  return apiBase(typeof base === 'string' ? base : '/');
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Not JSON — a proxy page. The status says what there is to say.
  }
  return `the server answered HTTP ${res.status}`;
}

export function myDecksClient(fetchImpl: Fetch = (input, init) => fetch(input, init), base: string = defaultApiBase()): MyDecksClient {
  const url = (id?: string): string => `${base}decks${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
  const send = async (id: string, init: RequestInit): Promise<Response | string> => {
    try {
      return await fetchImpl(url(id), { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...init.headers } });
    } catch {
      return 'Could not reach the server.';
    }
  };

  return {
    async list() {
      let res: Response;
      try {
        res = await fetchImpl(url(), { credentials: 'same-origin', headers: { accept: 'application/json' } });
      } catch {
        throw new Error('Could not reach the server.');
      }
      if (!res.ok) throw new Error(`Could not load your decks: ${await errorOf(res)}.`);
      const parsed = MyDecksSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new Error('The server sent something this app cannot read as your decks.');
      return parsed.data.decks;
    },

    async rename(id, name) {
      const res = await send(id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (typeof res === 'string') return { ok: false, message: res };
      if (!res.ok) return { ok: false, message: await errorOf(res) };
      const parsed = MyDeckSchema.safeParse(((await res.json().catch(() => null)) as { deck?: unknown } | null)?.deck);
      return parsed.success ? { ok: true, deck: parsed.data } : { ok: false, message: 'The server sent something this app cannot read as a deck.' };
    },

    async remove(id) {
      const res = await send(id, { method: 'DELETE' });
      if (typeof res === 'string') return { ok: false, message: res };
      return res.ok ? { ok: true } : { ok: false, message: await errorOf(res) };
    },
  };
}
