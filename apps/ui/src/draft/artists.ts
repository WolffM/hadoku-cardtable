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
let loading: Promise<ArtistTable> | null = null;

function load(): Promise<ArtistTable> {
  loading ??= import('./art-artists.json').then((m) => (table = m.default as ArtistTable));
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
    void load().then(() => {
      if (live) setLoaded(true);
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
