/*
 * `#/decks` — every draft you finished, as a deck of your own.
 *
 * The operator, 2026-10-19: *"whenever a draft is finished, we can consider
 * the pool a new deck … regardless of how the deck was updated/saved it
 * should always be reachable by the player's deck view."* The tiles are the
 * room's own deck chooser (`ConstructedScreen.tsx`'s `DeckChooser`) — the
 * operator, the same day: *"why aren't we using the same deck cards as we did
 * from the 1v1 constructed deck selection"* — with the W–L on the tile's
 * second line. Choosing one opens it in the editor (`#/decks/<podId>`,
 * `DeckScreen` with no Play), where it is renamed and deleted.
 *
 * Nothing but the tiles' outlines is drawn until the decks, their records,
 * every tile's art and its credit have all arrived — art landing a second
 * after its tile is the flash the operator asked never to see.
 */

import { useEffect, useMemo, useState } from 'react';

import { myDecksClient, type MyDeck, type MyDecksClient } from '../deck/myDecks.ts';
import { cardImageUrl, artReady } from '../draft/cardImage.ts';
import { useArtistLookup } from '../draft/artists.ts';
import { DeckChooser, draftedDeckOption, openDraftedDeck } from './ConstructedScreen.tsx';
import { assignDeckArt } from './deckArt.ts';
import { navigate } from './route.ts';
import { SettingsGear } from '../settings/Settings.tsx';
import type { DeckRecords } from '../stats/deckOrder.ts';
import { fetchDeckRecords } from '../stats/StatsPopout.tsx';
import './DecksScreen.css';

export interface DecksScreenProps {
  /** Tests pass stubs. Production passes nothing. */
  decks?: MyDecksClient;
  deckRecords?: () => Promise<DeckRecords>;
}

/** The stats id a drafted deck's games are reported under (`apps/server/src/http/routes.ts`'s `draftedDeckId`). */
export const draftedDeckStatsId = (podId: string): string => `draft:${podId}`;

/** How long the tiles wait on art that has not come: a stalled image must not hold the page empty for good. */
export const ART_WAIT_MS = 5000;

/**
 * Whether every one of these pieces of art can be drawn with its credit on
 * the first frame: each image fetched and decoded (`artReady` — a failed one
 * counts, its tile then draws the plain band), and the artist table loaded,
 * since `DeckArt` shows art only once it can credit it. `null` is "not known
 * yet", never ready.
 */
function useArtDrawable(artIds: readonly (string | undefined)[] | null): boolean {
  const key = artIds === null ? null : artIds.filter((id) => id !== undefined).join(',');
  const credits = useArtistLookup(key !== null && key !== '');
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const ids = key === '' ? [] : key.split(',');
    let left = 0;
    const one = (): void => {
      left -= 1;
      if (left === 0 && live) setLoaded(key);
    };
    for (const id of ids) if (!artReady(cardImageUrl(id), one)) left += 1;
    if (left === 0) setLoaded(key);
    const cap = setTimeout(() => live && setLoaded(key), ART_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(cap);
    };
  }, [key]);
  return key !== null && loaded === key && (key === '' || credits !== undefined);
}

export function DecksScreen({ decks: givenDecks, deckRecords = fetchDeckRecords }: DecksScreenProps) {
  const client = useMemo(() => givenDecks ?? myDecksClient(), [givenDecks]);
  const [decks, setDecks] = useState<MyDeck[] | null>(null);
  const [records, setRecords] = useState<DeckRecords | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client
      .list()
      .then((d) => live && setDecks(d))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    deckRecords()
      .then((r) => live && setRecords(r))
      .catch((err: unknown) => {
        // A record is a garnish: without the stats service the decks still open, at 0–0.
        console.warn('[cardtable] deck records are unavailable', err);
        if (live) setRecords(new Map());
      });
    return () => {
      live = false;
    };
  }, [client, deckRecords]);

  const options = useMemo(() => {
    if (decks === null || records === null) return null;
    const drafted = decks.map((d) => {
      const record = records.get(draftedDeckStatsId(d.id));
      return { ...draftedDeckOption(d.id, d.name, openDraftedDeck(d.deck, d.id, d.pool), d.pool), pilot: `${record?.wins ?? 0}–${record?.losses ?? 0}` };
    });
    const artIds = assignDeckArt(drafted.map((o) => o.art ?? []));
    return drafted.map((o, i) => ({ ...o, artId: artIds[i] }));
  }, [decks, records]);

  const drawable = useArtDrawable(useMemo(() => options?.map((o) => o.artId) ?? null, [options]));
  const ready = drawable && options !== null;

  return (
    <div className="shell" data-testid="decks">
      <nav className="shell__head">
        <a
          className="shell__link"
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            navigate({ kind: 'lobby' });
          }}
        >
          ← Lobby
        </a>
        <SettingsGear />
      </nav>
      <main className="decks">
        {error !== null && (
          <p className="lobby__error" role="alert" data-testid="decks-error">
            {error}
          </p>
        )}
        {error === null && (
          <DeckChooser
            options={ready ? options : []}
            value=""
            disabled={!ready}
            pending={!ready}
            empty={ready && options.length === 0 ? 'No decks yet' : undefined}
            onChoose={(id) => navigate({ kind: 'decks', draftId: id })}
          />
        )}
      </main>
    </div>
  );
}
