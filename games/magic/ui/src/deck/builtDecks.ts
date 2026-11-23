/*
 * Decks built from nothing, from the browser's side: a client of the caller's own document on our
 * server (`games/magic/server/src/http/me.ts`, wave 125's contract):
 *
 *   `GET    /api/me/library`          → `{ favourites, decks, built }`; `built` is `{ [id]: entry }`
 *   `PUT    /api/me/built/:builtId`   `{ name, format, dck }` → the stored entry
 *   `DELETE /api/me/built/:builtId`
 *
 * A built deck's id is `built:<uuid>`, minted here on its first save, so it never collides with a
 * pod id in the Library's one grid or in the favourites keyed by deck id. `format` is the era id the
 * deck was built for (`TableFormat.id`), or `FREE_PICK` for "Any card".
 *
 * The answers are parsed with one Zod schema each, never trusted: a document the server wrote under
 * an older shape is a deck this screen skips, not a crash of the whole Library.
 */

import { z } from 'zod';

import { apiBase, bodyOf, getJson, isRecord, pageFetch, sendJson, serverMessage, type Fetch } from '@hadoku/game-ui/http.ts';

/** The prefix every built deck's id carries. */
export const BUILT_PREFIX = 'built:';

const BuiltEntrySchema = z.object({
  name: z.string(),
  format: z.string(),
  dck: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export interface BuiltDeck {
  /** `built:<uuid>`. */
  id: string;
  name: string;
  format: string;
  dck: string;
  createdAt: number;
  updatedAt: number;
}

/** What a save sends: an id for a deck already stored, none for a new one. */
export interface BuiltDeckDraft {
  id?: string;
  name: string;
  format: string;
  dck: string;
}

export type BuiltSave = { ok: true; deck: BuiltDeck } | { ok: false; message: string };
export type BuiltDelete = { ok: true } | { ok: false; message: string };

export interface BuiltDecksClient {
  /** Newest change first. */
  list(): Promise<BuiltDeck[]>;
  save(deck: BuiltDeckDraft): Promise<BuiltSave>;
  remove(id: string): Promise<BuiltDelete>;
}

export function isBuiltDeckId(id: string): boolean {
  return id.startsWith(BUILT_PREFIX) && id.length > BUILT_PREFIX.length;
}

export function newBuiltDeckId(): string {
  return `${BUILT_PREFIX}${crypto.randomUUID()}`;
}

/** The `built` map of a library answer as decks, newest change first. An entry that does not parse is left out. */
export function builtDecksOf(built: unknown): BuiltDeck[] {
  if (!isRecord(built)) return [];
  const out: BuiltDeck[] = [];
  for (const [id, raw] of Object.entries(built)) {
    if (!isBuiltDeckId(id)) continue;
    const entry = BuiltEntrySchema.safeParse(raw);
    if (entry.success) out.push({ id, ...entry.data });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function builtDecksClient(fetchImpl: Fetch = pageFetch, base: string = apiBase()): BuiltDecksClient {
  const builtUrl = (id: string): string => `${base}me/built/${encodeURIComponent(id)}`;

  return {
    async list() {
      let res: Response;
      try {
        res = await getJson(`${base}me/library`, fetchImpl);
      } catch {
        throw new Error('Could not reach the server.');
      }
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load your decks: ${serverMessage(body, res.status)}.`);
      if (!isRecord(body)) throw new Error('The server sent something this app cannot read as your decks.');
      return builtDecksOf(body.built);
    },

    async save({ id = newBuiltDeckId(), name, format, dck }) {
      if (!isBuiltDeckId(id)) return { ok: false, message: `${JSON.stringify(id)} is not a built deck.` };
      let res: Response;
      try {
        res = await sendJson(builtUrl(id), 'PUT', { name, format, dck }, fetchImpl);
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: serverMessage(body, res.status) };
      const stored = BuiltEntrySchema.safeParse(isRecord(body) && 'deck' in body ? body.deck : body);
      if (!stored.success) return { ok: false, message: 'The server sent something this app cannot read as your deck.' };
      return { ok: true, deck: { id, ...stored.data } };
    },

    async remove(id) {
      let res: Response;
      try {
        res = await fetchImpl(builtUrl(id), { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } });
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      return res.ok ? { ok: true } : { ok: false, message: serverMessage(await bodyOf(res), res.status) };
    },
  };
}

const live = (): BuiltDecksClient => builtDecksClient();

/** The caller's built decks, newest change first. Throws when the server cannot answer. */
export function listBuiltDecks(): Promise<BuiltDeck[]> {
  return live().list();
}

/** Store a built deck; a draft with no id is a new deck and gets one. */
export function saveBuiltDeck(deck: BuiltDeckDraft): Promise<BuiltSave> {
  return live().save(deck);
}

export function deleteBuiltDeck(id: string): Promise<BuiltDelete> {
  return live().remove(id);
}
