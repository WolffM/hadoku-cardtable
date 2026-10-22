/*
 * A deck's name, and — once its tournament is over — renaming and deleting it.
 * The head of the Decks page's editor (`DeckScreen`, standalone): the tiles are
 * the room's own deck chooser, and a tile is one button, so its actions live
 * where the deck is opened (the operator, 2026-10-19). The delete is also each
 * finished deck's tile's own (`DecksScreen`): one `DeleteConfirm` for both.
 */

import { useState, type ReactNode } from 'react';
import { Icon } from '@wolffm/themes';
import { DECK_NAME_MAX } from '@hadoku/shared';

import type { MyDeck, MyDecksClient } from '../deck/myDecks.ts';
import './DecksScreen.css';
import { uiLength } from '../settings/ui-scale.ts';

export function DeckManage({ deck, client, onRenamed, onDeleted }: { deck: MyDeck; client: MyDecksClient; onRenamed: (deck: MyDeck) => void; onDeleted: () => void }) {
  const [naming, setNaming] = useState<string | null>(null);
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
      {naming === null && (
        <DeleteConfirm deck={deck} client={client} onDeleted={onDeleted} testId="decks-delete" className="decks__actions">
          <button type="button" className="decks__icon" aria-label="Rename" data-testid="decks-rename" onClick={() => setNaming(deck.name)}>
            <Icon name="edit" size={uiLength('0.9rem')} />
          </button>
        </DeleteConfirm>
      )}
      {fault !== null && (
        <p className="ct-error" role="alert" data-testid="decks-fault">
          {fault}
        </p>
      )}
    </div>
  );
}

/**
 * A finished deck's delete: the bin, then Delete or Keep. Nothing while its
 * tournament runs. `children` stand beside the bin until it is pressed.
 */
export function DeleteConfirm({ deck, client, onDeleted, testId, className, children }: { deck: MyDeck; client: Pick<MyDecksClient, 'remove'>; onDeleted: () => void; testId: string; className: string; children?: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  if (!deck.concluded) return null;
  const confirm = (): void => {
    setBusy(true);
    void client.remove(deck.id).then((r) => {
      setBusy(false);
      if (r.ok) onDeleted();
      else setFault(r.message);
    });
  };
  return (
    <span className={className} data-asking={asking ? 'true' : undefined}>
      {asking ? (
        <>
          <button type="button" className="decks__confirm" data-testid={`${testId}-confirm`} disabled={busy} onClick={confirm}>
            Delete
          </button>
          <button type="button" className="decks__icon" aria-label="Keep" data-testid={`${testId}-cancel`} disabled={busy} onClick={() => setAsking(false)}>
            <Icon name="close" size={uiLength('0.9rem')} />
          </button>
        </>
      ) : (
        <>
          {children}
          <button type="button" className="decks__icon" aria-label={`Delete ${deck.name}`} data-testid={testId} onClick={() => setAsking(true)}>
            <Icon name="trash" size={uiLength('0.9rem')} />
          </button>
        </>
      )}
      {fault !== null && (
        <span className="ct-error" role="alert" data-testid={`${testId}-fault`}>
          {fault}
        </span>
      )}
    </span>
  );
}
