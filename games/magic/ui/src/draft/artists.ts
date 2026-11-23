/*
 * Who drew a card's art, for the places that show the art without the card's
 * own frame — and so without the illustrator line printed on it (the stack's
 * ability chip, the deck chooser's tiles). Scryfall's image guidelines ask that
 * art shown that way carries its artist in the same interface, so those places
 * show art only once they can credit it.
 *
 * Two sources, fastest first. The table (`art-artists.json`, built by
 * `scripts/art/build-art-artists.ts`) is a lazy chunk covering the bundled cube
 * and the committed `art-ids.json` rows: no request for the cards it knows. Any
 * other id — a drafted set's card, an imported cube's, a constructed deck's —
 * is asked of the server (`GET /api/art/<id>/artist`, `card-art.ts`), which
 * answers from the same Scryfall corpus the table is built from. A table over
 * every printing would be 4.9 MB (2.5 MB gzipped) against today's 0.44 MB, so
 * the table stays small and the server covers the rest: on prod's drafted decks
 * (2026-11-23) the table alone left 106 of 174 deck tiles blank.
 */

import { useEffect, useState } from 'react';
import { BACK_FACE } from '@hadoku/carddata/art';
import { apiUrl, bodyOf, getJson, isRecord, pageFetch } from '@hadoku/game-ui/http.ts';

interface ArtistTable {
  readonly names: readonly string[];
  readonly ids: Readonly<Record<string, number>>;
}

let table: ArtistTable | null = null;
let loading: Promise<ArtistTable | null> | null = null;

/**
 * The table, or `null` if this attempt failed. Never rejects: a failure is one
 * outcome shared by every credit waiting on it, and it is not kept — the next
 * credit to ask loads again, so a chunk that failed once (a deploy swapping
 * hashes, a dropped request) does not hide every credit for the session.
 */
function load(): Promise<ArtistTable | null> {
  loading ??= import('./art-artists.json').then(
    (m) => (table = m.default as ArtistTable),
    (err: unknown) => {
      loading = null;
      console.warn('[cardtable] the artist table did not load; credited art stays hidden until it does', err);
      return null;
    },
  );
  return loading;
}

/**
 * Whether the table has loaded, for a drawer outside React that must not show art before it can
 * credit it (`play/live/placed.ts`'s chip): false starts the load, and `onLoad` runs once it lands.
 */
export function artistsReady(onLoad: () => void): boolean {
  if (table !== null) return true;
  void load().then((loaded) => {
    if (loaded !== null) onLoad();
  });
  return false;
}

function lookup(t: ArtistTable, artId: string): string | null {
  const i = t.ids[artId];
  return i === undefined ? null : (t.names[i] ?? null);
}

/**
 * Who drew each art id, once the table has loaded: `undefined` while it loads, and nothing is
 * asked for while `wanted` is false. For a component crediting several pieces of art at once.
 */
export function useArtistLookup(wanted: boolean): ((artId: string) => string | null) | undefined {
  const [, setLoaded] = useState(table !== null);
  useEffect(() => {
    if (table !== null || !wanted) return;
    let live = true;
    void load().then((loaded) => {
      if (live && loaded !== null) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [wanted]);
  const loaded = table;
  return loaded === null ? undefined : (artId) => lookup(loaded, artId);
}

/** What the server answered for each id the table misses, `null` for none: kept for the page's life. A failed read is not kept. */
const asked = new Map<string, string | null>();
const asking = new Map<string, Promise<string | null>>();

/** The server's artist for `artId` (a Scryfall id, or one carrying {@link BACK_FACE}); `null` for an id the corpus has none for. */
function askServer(artId: string): Promise<string | null> {
  const pending = asking.get(artId);
  if (pending !== undefined) return pending;
  const back = artId.endsWith(BACK_FACE);
  const url = apiUrl(`art/${back ? artId.slice(0, -BACK_FACE.length) : artId}${back ? '/back' : ''}/artist`);
  const read = getJson(url, pageFetch)
    .then(async (res) => {
      const body = res.ok ? await bodyOf(res) : null;
      const artist = isRecord(body) && typeof body.artist === 'string' ? body.artist : null;
      // A 5xx is the server's trouble, not an answer about the card: asked again next time.
      if (res.ok || res.status === 404) asked.set(artId, artist);
      return artist;
    })
    .finally(() => asking.delete(artId));
  asking.set(artId, read);
  return read;
}

/** The artist of `artId` from the table alone: `undefined` while it loads, `null` if it has none. */
export function useArtist(artId: string | null): string | null | undefined {
  const artistOf = useArtistLookup(artId !== null);
  if (artId === null) return null;
  return artistOf === undefined ? undefined : artistOf(artId);
}

/**
 * The artist of `artId` from the table, else the server: `undefined` while it is being found,
 * `null` if neither has one. Only an id the table misses is asked of the server.
 */
export function useAnyArtist(artId: string | null): string | null | undefined {
  const fromTable = useArtist(artId);
  const ask = artId !== null && fromTable === null && !asked.has(artId);
  const [, setHeard] = useState(0);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    askServer(artId).then(
      () => live && setHeard((n) => n + 1),
      (err: unknown) => {
        console.warn('[cardtable] the artist lookup failed; that art stays hidden until it answers', err);
      },
    );
    return () => {
      live = false;
    };
  }, [ask, artId]);
  if (artId === null || fromTable !== null) return fromTable;
  return asked.has(artId) ? (asked.get(artId) ?? null) : undefined;
}

/** The credit line under cropped art. */
export function artCredit(artist: string): string {
  return `Illus. ${artist} · ™ & © WotC`;
}
