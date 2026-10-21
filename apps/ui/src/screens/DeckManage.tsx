/*
 * A deck's name, and — once its tournament is over — renaming and deleting it.
 * The head of the Decks page's editor (`DeckScreen`, standalone): the tiles are
 * the room's own deck chooser, and a tile is one button, so its actions live
 * where the deck is opened (the operator, 2026-10-19).
 */

import { useState } from 'react';
import { Icon } from '@wolffm/themes';
import { DECK_NAME_MAX } from '@hadoku/shared';

import type { MyDeck, MyDecksClient } from '../deck/myDecks.ts';
import './DecksScreen.css';
import { uiLength } from '../settings/ui-scale.ts';

export function DeckManage({ deck, client, onRenamed, onDeleted }: { deck: MyDeck; client: MyDecksClient; onRenamed: (deck: MyDeck) => void; onDeleted: () => void }) {
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
      if (!r.ok) {
        setFault(r.message);
        return;
      }
      setNaming(null);
      onRenamed(r.deck);
    });
  };
  const remove = (): void => {
    setBusy(true);
    void client.remove(deck.id).then((r) => {
      setBusy(false);
      if (r.ok) onDeleted();
      else setFault(r.message);
    });
  };

  return (
    <div className="decks__manage" data-testid="deck-manage">
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
            <Icon name="tick" size={uiLength('0.9rem')} />
          </button>
        </form>
      ) : (
        <strong className="decks__name" data-testid="decks-name">
          {deck.name}
        </strong>
      )}
      {deck.concluded && naming === null && (
        <span className="decks__actions">
          {deleting ? (
            <>
              <button type="button" className="decks__confirm" data-testid="decks-delete-confirm" disabled={busy} onClick={remove}>
                Delete
              </button>
              <button type="button" className="decks__icon" aria-label="Keep" data-testid="decks-delete-cancel" disabled={busy} onClick={() => setDeleting(false)}>
                <Icon name="close" size={uiLength('0.9rem')} />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="decks__icon" aria-label="Rename" data-testid="decks-rename" onClick={() => setNaming(deck.name)}>
                <Icon name="edit" size={uiLength('0.9rem')} />
              </button>
              <button type="button" className="decks__icon" aria-label="Delete" data-testid="decks-delete" onClick={() => setDeleting(true)}>
                <Icon name="trash" size={uiLength('0.9rem')} />
              </button>
            </>
          )}
        </span>
      )}
      {fault !== null && (
        <p className="lobby__error" role="alert" data-testid="decks-fault">
          {fault}
        </p>
      )}
    </div>
  );
}
