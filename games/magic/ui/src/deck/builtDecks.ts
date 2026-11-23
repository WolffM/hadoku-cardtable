/*
 * Decks built from nothing, from the browser's side: a client of the caller's own document on our
 * server (`games/magic/server/src/http/me.ts`, wave 125's contract):
 *
 *   `GET    /api/me/library`          → `{ favourites, decks, built }`; `built` is every built deck,
 *                                       `{ id, name, format, dck, createdAt, updatedAt }`
 *   `PUT    /api/me/built/:builtId`   `{ name, format, dck }` → `{ built }`, the deck as stored
 *   `DELETE /api/me/built/:builtId`   → 204
 *
 * A built deck's id is `built:<uuid>`, minted here on its first save, so it never collides with a
 * pod id in the Library's one grid or in the favourites keyed by deck id. `format` is the era id the
 * deck was built for (`TableFormat.id`), or `FREE_PICK` for "Any card".
 *
 * The builder's card search is here too (`cardSearch`, `GET /api/cards/search`): the screen asks it
 * per keystroke, and once per card name when a saved deck opens (`facesForNames`).
 *
 * The answers are parsed with one Zod schema each, never trusted: a document the server wrote under
 * an older shape is a deck this screen skips, not a crash of the whole Library.
 */

import { z } from 'zod';
import { DraftCardSchema, type DraftCard } from '@hadoku/shared';

import { apiBase, bodyOf, getJson, isRecord, pageFetch, sendJson, serverMessage, type Fetch } from '@hadoku/game-ui/http.ts';

/** The prefix every built deck's id carries. */
export const BUILT_PREFIX = 'built:';

const BuiltDeckSchema = z.object({
  id: z.string().refine(isBuiltDeckId),
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

/** The `built` list of a library answer, newest change first. An entry that does not parse is left out. */
export function builtDecksOf(built: unknown): BuiltDeck[] {
  if (!Array.isArray(built)) return [];
  const out: BuiltDeck[] = [];
  for (const raw of built) {
    const deck = BuiltDeckSchema.safeParse(raw);
    if (deck.success) out.push(deck.data);
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
      const stored = BuiltDeckSchema.safeParse(isRecord(body) ? body.built : null);
      if (!stored.success) return { ok: false, message: 'The server sent something this app cannot read as your deck.' };
      return { ok: true, deck: stored.data };
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

/* ── the builder's card search: `GET /api/cards/search` (`server/src/http/cards.ts`) ── */

/** The most results one search shows. */
export const SEARCH_LIMIT = 40;

/** Cards by name, prefix matches first; `sets` narrows them to an era's sets (none: any card). */
export type CardSearch = (q: string, sets: readonly string[], limit?: number) => Promise<DraftCard[]>;

export function cardSearch(fetchImpl: Fetch = pageFetch, base: string = apiBase()): CardSearch {
  return async (q, sets, limit = SEARCH_LIMIT) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (sets.length > 0) params.set('sets', sets.join(','));
    let res: Response;
    try {
      res = await getJson(`${base}cards/search?${params.toString()}`, fetchImpl);
    } catch {
      throw new Error('Could not reach the server.');
    }
    const body = await bodyOf(res);
    if (!res.ok) throw new Error(serverMessage(body, res.status));
    const cards = z.object({ cards: z.array(DraftCardSchema) }).safeParse(body);
    if (!cards.success) throw new Error('The server sent something this app cannot read as cards.');
    return cards.data.cards;
  };
}

/**
 * The faces of a saved deck's cards, one search per name (`limit` small: the name itself is the
 * prefix), the exact name's answer kept. A name the search cannot find stays unanswered, and the
 * editor draws it by its name alone. Basics need none.
 */
export async function facesForNames(search: CardSearch, names: readonly string[], sets: readonly string[]): Promise<DraftCard[]> {
  const out: DraftCard[] = [];
  for (const name of new Set(names)) {
    const found = await search(name, sets, 10).catch(() => [] as DraftCard[]);
    const exact = found.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? (sets.length > 0 ? (await search(name, [], 10).catch(() => [] as DraftCard[])).find((c) => c.name.toLowerCase() === name.toLowerCase()) : undefined);
    if (exact !== undefined) out.push(exact);
  }
  return out;
}
