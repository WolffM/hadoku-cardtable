/*
 * Every deck the running server's library ships, by id — the same catalog
 * `GET /api/tables/decks` answers a deck-builder screen with
 * (`apps/server/src/http/routes.ts`'s `tables.get('/decks', …)`).
 */

export interface LibraryDeckRef {
  id: string;
  name: string;
  /** The catalogued pool this deck was built for (`formatIdOf`) — the `rules.format` a start checks it against. */
  era: string;
}

export async function fetchDeckLibrary(origin: string, prefix: string, cookie: string): Promise<LibraryDeckRef[]> {
  const res = await fetch(`${origin}${prefix}/api/tables/decks`, { headers: { cookie } });
  if (!res.ok) throw new Error(`GET /api/tables/decks: HTTP ${res.status}`);
  const body = (await res.json()) as { decks: { id: string; name: string; era: string }[] };
  return body.decks.map((d) => ({ id: d.id, name: d.name, era: d.era }));
}
