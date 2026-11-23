/*
 * The caller's own library document (`GET /api/me/library`, `games/magic/server/src/http/me.ts`):
 * the decks they starred, when they last played each deck, and the decks they built. The server
 * keeps it on its own disk (`users/`), so nothing here reads Cloudflare.
 *
 * A deck id is the stats one: `draft:<podId>` for a drafted deck, `built:<uuid>` for a built one.
 */

import { apiBase, bodyOf, getJson, isRecord, pageFetch, sendJson, serverMessage, type Fetch } from '@hadoku/game-ui/http.ts';

import { builtDecksOf, type BuiltDeck } from './builtDecks.ts';

export interface MyLibrary {
  favourites: Set<string>;
  /** Deck id → when its owner last finished a game with it. */
  lastPlayed: Map<string, number>;
  built: BuiltDeck[];
}

export type FavouriteChange = { ok: true } | { ok: false; message: string };

export interface FavouritesClient {
  library(): Promise<MyLibrary>;
  setFavourite(deckId: string, on: boolean): Promise<FavouriteChange>;
}

const numbersOf = (raw: unknown, read: (v: unknown) => number | null): Map<string, number> =>
  new Map(
    isRecord(raw)
      ? Object.entries(raw).flatMap(([id, v]) => {
          const n = read(v);
          return n === null ? [] : [[id, n] as const];
        })
      : [],
  );
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A library answer as this page reads it: an entry that does not parse is left out. */
export function libraryOf(body: unknown): MyLibrary {
  const doc = isRecord(body) ? body : {};
  return {
    favourites: new Set(numbersOf(doc.favourites, num).keys()),
    lastPlayed: numbersOf(doc.decks, (v) => (isRecord(v) ? num(v.lastPlayedAt) : null)),
    built: builtDecksOf(doc.built),
  };
}

export function favouritesClient(fetchImpl: Fetch = pageFetch, base: string = apiBase()): FavouritesClient {
  return {
    async library() {
      let res: Response;
      try {
        res = await getJson(`${base}me/library`, fetchImpl);
      } catch {
        throw new Error('Could not reach the server.');
      }
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load your library: ${serverMessage(body, res.status)}.`);
      return libraryOf(body);
    },
    async setFavourite(deckId, on) {
      let res: Response;
      try {
        res = await sendJson(`${base}me/favourites/${encodeURIComponent(deckId)}`, 'PUT', { on }, fetchImpl);
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      return res.ok ? { ok: true } : { ok: false, message: serverMessage(await bodyOf(res), res.status) };
    },
  };
}

/** The caller's starred decks. Throws when the server cannot answer. */
export async function listFavourites(): Promise<Set<string>> {
  return (await favouritesClient().library()).favourites;
}

export function setFavourite(deckId: string, on: boolean): Promise<FavouriteChange> {
  return favouritesClient().setFavourite(deckId, on);
}
