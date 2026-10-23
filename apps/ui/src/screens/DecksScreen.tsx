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
 * The page is laid out as the room's deck card (`.lobby--room`'s
 * `.lobby__decks`), so its grid is the room's at the same width — the
 * operator, 2026-10-20: *"can we make this also 6 decks in a row? also can we
 * get the filter bar from the 1v1 room in here too?"* — with the room's
 * filter row over it, less the play-style chips: a drafted deck has no style.
 *
 * Nothing but the tiles' outlines is drawn until the decks, their records,
 * every tile's art and its credit have all arrived — art landing a second
 * after its tile is the flash the operator asked never to see.
 */

import { useEffect, useMemo, useState } from 'react';

import { myDecksClient, type MyDeck, type MyDecksClient } from '../deck/myDecks.ts';
import { useArtLoaded } from '../draft/useArtLoaded.ts';
import { useArtistLookup } from '../draft/artists.ts';
import { DeckChooser, draftedDeckOption, openDraftedDeck } from './ConstructedScreen.tsx';
import { assignDeckArt } from './deckArt.ts';
import { DeckFilterBar } from './DeckFilterBar.tsx';
import { DeleteConfirm } from './DeckManage.tsx';
import { NO_DECK_FILTER, deckPasses, type DeckFilter } from './deckFilter.ts';
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
const draftedDeckStatsId = (podId: string): string => `draft:${podId}`;

/**
 * Whether every one of these pieces of art can be drawn with its credit on
 * the first frame: the art itself (`useArtLoaded`), and the artist table,
 * since `DeckArt` shows art only once it can credit it. `null` is "not known
 * yet", never ready.
 */
function useArtDrawable(artIds: readonly (string | undefined)[] | null): boolean {
  const loaded = useArtLoaded(artIds);
  const credits = useArtistLookup(artIds !== null && artIds.some((id) => id !== undefined));
  return loaded && (artIds === null || artIds.every((id) => id === undefined) || credits !== undefined);
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

  const [filter, setFilter] = useState<DeckFilter>(NO_DECK_FILTER);
  const visible = useMemo(() => (ready ? options.filter((o) => deckPasses(o, filter)) : []), [ready, options, filter]);

  return (
    <div className="shell shell--fit" data-testid="decks">
      <nav className="shell__head">
        <div className="shell__tools">
          <SettingsGear />
        </div>
      </nav>
      <main className="lobby lobby--room">
        {error !== null && (
          <p className="ct-error" role="alert" data-testid="decks-error">
            {error}
          </p>
        )}
        {error === null && (
          <section className="lobby__card lobby__decks">
            <div className="lobby__setsrow">
              <DeckFilterBar filter={filter} onChange={setFilter} styles={[]} />
            </div>
            <span className="lobby__field lobby__field--hidden" id="deck-mine-label">
              Your decks
            </span>
            <DeckChooser
              options={visible}
              value=""
              disabled={!ready}
              pending={!ready}
              empty={ready ? (options.length === 0 ? 'No decks yet' : 'No decks') : undefined}
              onChoose={(id) => navigate({ kind: 'decks', draftId: id })}
              tileAction={(option) => {
                const deck = decks?.find((d) => d.id === option.value);
                return deck === undefined ? null : (
                  <DeleteConfirm
                    deck={deck}
                    client={client}
                    onDeleted={() => setDecks((held) => held?.filter((d) => d.id !== deck.id) ?? null)}
                    testId="decks-tile-delete"
                    className="decks__tile-actions"
                  />
                );
              }}
            />
          </section>
        )}
      </main>
    </div>
  );
}
