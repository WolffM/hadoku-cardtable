/*
 * Who drew a card's art, for the places that show the art without the card's
 * own frame — and so without the illustrator line printed on it (the stack's
 * ability chip, the deck chooser's tiles). Scryfall's image guidelines ask that
 * art shown that way carries its artist in the same interface, so those places
 * show art only once they can credit it.
 *
 * The table (`art-artists.json`, built by `scripts/art/build-art-artists.ts`)
 * is a lazy chunk: only a credit needs it, and a credit can wait for it.
 */

import { useEffect, useState } from 'react';

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

function lookup(t: ArtistTable, artId: string): string | null {
  const i = t.ids[artId];
  return i === undefined ? null : (t.names[i] ?? null);
}

/** The artist of `artId`: `undefined` while the table loads, `null` if it has none. */
export function useArtist(artId: string | null): string | null | undefined {
  const [, setLoaded] = useState(table !== null);
  useEffect(() => {
    if (table !== null || artId === null) return;
    let live = true;
    void load().then((loaded) => {
      if (live && loaded !== null) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [artId]);
  if (artId === null) return null;
  return table === null ? undefined : lookup(table, artId);
}

/** The credit line under cropped art. */
export function artCredit(artist: string): string {
  return `Illus. ${artist} · ™ & © WotC`;
}
