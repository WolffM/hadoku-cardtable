/*
 * `#/decks` — every draft you finished, as a deck of your own.
 *
 * The operator, 2026-10-19: *"whenever a draft is finished, we can consider
 * the pool a new deck … regardless of how the deck was updated/saved it
 * should always be reachable by the player's deck view."* A tile opens the
 * deck in the editor (`#/decks/<podId>`, `DeckScreen` with no Play); the
 * pod's builder and that editor save the same build. Renaming and deleting
 * wait for the deck's tournament to finish, so the two buttons are drawn
 * only on a deck whose pod is over.
 *
 * Nothing is drawn until both the decks and their records have answered —
 * a W–L that appears after the tile is the flash the operator asked never
 * to see.
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@wolffm/themes';
import { DECK_NAME_MAX } from '@hadoku/shared';

import { DeckColors } from '../components/DeckView.tsx';
import { myDecksClient, type MyDeck, type MyDecksClient } from '../deck/myDecks.ts';
import { DeckArt, draftedDeckOption, openDraftedDeck } from './ConstructedScreen.tsx';
import { assignDeckArt } from './deckArt.ts';
import { navigate, routeHash } from './route.ts';
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
        // A record is a garnish: without the stats service the decks still open.
        console.warn('[cardtable] deck records are unavailable', err);
        if (live) setRecords(new Map());
      });
    return () => {
      live = false;
    };
  }, [client, deckRecords]);

  const tiles = useMemo(() => {
    if (decks === null) return null;
    const options = decks.map((d) => draftedDeckOption(d.id, d.name, openDraftedDeck(d.deck, d.id, d.pool), d.pool));
    const artIds = assignDeckArt(options.map((o) => o.art ?? []));
    return decks.map((deck, i) => ({ deck, option: options[i]!, artId: artIds[i] }));
  }, [decks]);

  const replace = (next: MyDeck): void => setDecks((ds) => ds?.map((d) => (d.id === next.id ? next : d)) ?? null);
  const drop = (id: string): void => setDecks((ds) => ds?.filter((d) => d.id !== id) ?? null);
  const ready = tiles !== null && records !== null;

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
        {ready && tiles.length === 0 && (
          <p className="decks__empty" data-testid="decks-empty">
            No decks yet
          </p>
        )}
        {ready && tiles.length > 0 && (
          <ul className="decks__grid" data-testid="decks-grid">
            {tiles.map(({ deck, option, artId }) => (
              <DeckTile
                key={deck.id}
                deck={deck}
                colors={option.colors}
                artId={artId}
                record={records.get(draftedDeckStatsId(deck.id))}
                client={client}
                onRenamed={replace}
                onDeleted={drop}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function DeckTile({
  deck,
  colors,
  artId,
  record,
  client,
  onRenamed,
  onDeleted,
}: {
  deck: MyDeck;
  colors: Parameters<typeof DeckColors>[0]['colors'];
  artId: string | undefined;
  record: { wins: number; losses: number } | undefined;
  client: MyDecksClient;
  onRenamed: (deck: MyDeck) => void;
  onDeleted: (id: string) => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const rename = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === deck.name) {
      setNaming(null);
      return;
    }
    setBusy(true);
    void client.rename(deck.id, trimmed).then((r) => {
      setBusy(false);
      if (r.ok) {
        setNaming(null);
        onRenamed(r.deck);
      } else setFault(r.message);
    });
  };
  const remove = (): void => {
    setBusy(true);
    void client.remove(deck.id).then((r) => {
      setBusy(false);
      if (r.ok) onDeleted(deck.id);
      else setFault(r.message);
    });
  };

  return (
    <li className="decks__item" data-testid="decks-tile" data-deck-id={deck.id}>
      <a className="deckpick__option decks__tile" href={routeHash({ kind: 'decks', draftId: deck.id })} aria-label={deck.name}>
        <DeckArt artId={artId} />
        <span className="deckpick__name" title={deck.name} data-testid="decks-name">
          {deck.name}
        </span>
        <DeckColors colors={colors} label={`${deck.name}: ${colors.length === 0 ? 'colourless' : colors.join(' ')}`} />
        <span className="deckpick__pilot decks__meta">
          <span data-testid="decks-record">{`${record?.wins ?? 0}–${record?.losses ?? 0}`}</span>
          <span>{new Date(deck.createdAt).toLocaleDateString()}</span>
        </span>
      </a>
      {deck.concluded && (
        <div className="decks__actions">
          {naming !== null ? (
            <form
              className="decks__rename"
              onSubmit={(e) => {
                e.preventDefault();
                rename(naming);
              }}
            >
              <input
                aria-label="Deck name"
                data-testid="decks-name-input"
                value={naming}
                maxLength={DECK_NAME_MAX}
                autoFocus
                disabled={busy}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNaming(null);
                }}
              />
              <button type="submit" className="decks__icon" aria-label="Save name" data-testid="decks-name-save" disabled={busy}>
                <Icon name="tick" size="0.9rem" />
              </button>
            </form>
          ) : deleting ? (
            <>
              <button type="button" className="decks__confirm" data-testid="decks-delete-confirm" disabled={busy} onClick={remove}>
                Delete
              </button>
              <button type="button" className="decks__icon" aria-label="Keep" data-testid="decks-delete-cancel" disabled={busy} onClick={() => setDeleting(false)}>
                <Icon name="close" size="0.9rem" />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="decks__icon" aria-label="Rename" data-testid="decks-rename" onClick={() => setNaming(deck.name)}>
                <Icon name="edit" size="0.9rem" />
              </button>
              <button type="button" className="decks__icon" aria-label="Delete" data-testid="decks-delete" onClick={() => setDeleting(true)}>
                <Icon name="trash" size="0.9rem" />
              </button>
            </>
          )}
        </div>
      )}
      {fault !== null && (
        <p className="lobby__error" role="alert" data-testid="decks-fault">
          {fault}
        </p>
      )}
    </li>
  );
}
