/**
 * The end of a draft: a deck, and a file you can open in Forge.
 *
 * ## What this replaces
 *
 * A finished draft used to render `<ol>` of 45 card names and stop. That is the
 * moment the whole evening was for, and the app's answer to it was a list you
 * could not sort, could not build from and could not take anywhere.
 *
 * ## The model is not here, deliberately
 *
 * Every rule lives in `@hadoku/deck`, which cites Forge for each one:
 * `LIMITED_MIN_MAIN_DECK_SIZE` is `DeckFormat.Limited`'s floor of 40
 * (DeckFormat.java:47), `deckProblems` implements that and nothing else, and
 * basics are exempt from the copy limits (`DeckFormat.canHaveAnyNumberOf`,
 * DeckFormat.java:529). This component holds a `Deck` and calls those
 * functions. It has no opinion about legality, and adding one here would put a
 * second rules engine in a React component.
 *
 * "You may only play what you drafted" needs no check either: `newDeck` puts
 * the whole pool in the sideboard and `moveToMain`/`moveToSideboard` only ever
 * shuffle between the two piles, so `poolOf(deck)` is invariant. The pool count
 * is rendered for exactly that reason — it is a number that cannot change, and
 * a reader who watches it not change learns the property.
 *
 * ## No trademarks, no images
 *
 * Rows are name, cost and type, drawn by us (`ManaPip` draws its own circles
 * and renders `{T}` as the word TAP). No card frames, no set symbols, no mana
 * font. The pool tiles reuse `CardTile`, which resolves art through
 * `draft/cardImage.ts` → `@hadoku/carddata/art` → `art-manifest.json`; no image
 * host is named anywhere in this file, and none may be.
 *
 * ## The download
 *
 * `onDownload` is injected so the button is testable: jsdom has no
 * `URL.createObjectURL`, and a component that could only be exercised in a real
 * browser is a component whose export is never asserted. The default is the
 * ordinary anchor-and-blob dance, and it is the only part of this file that
 * touches the DOM directly.
 */

import { useMemo, useState } from 'react';

import {
  LIMITED_MIN_MAIN_DECK_SIZE,
  BASIC_LAND_NAMES,
  basicLand,
  cardKey,
  deckProblems,
  mainDeckSize,
  moveToMain,
  moveToSideboard,
  poolOf,
  setBasicLand,
  sideboardSize,
  totalCards,
  type Deck,
} from '@hadoku/deck';
// The `/dck` subpath, never the barrel — see `draft/deckFromPool.ts`.
import type { DeckEntry } from '@hadoku/carddata/dck';

import type { DraftCard } from '../draft/types.ts';
import {
  cardRequestOf,
  deckFromPool,
  dckFilename,
  dckTextOf,
} from '../draft/deckFromPool.ts';
import { ManaPip } from './ManaPip.tsx';
import './spectate.css';

export interface DeckViewProps {
  draftId: string;
  /** The finished pool. Every card that may ever be in the deck. */
  pool: readonly DraftCard[];
  /** Overridden in tests; the default writes a file through the browser. */
  onDownload?: (filename: string, text: string) => void;
}

/**
 * Which pip a basic land shows. Ours, drawn as a circle by `ManaPip` — never
 * WotC's mana symbol, which is a trademark this project does not render.
 */
const BASIC_PIP: Record<string, string> = {
  Plains: 'W',
  Island: 'U',
  Swamp: 'B',
  Mountain: 'R',
  Forest: 'G',
};

/** The browser half: a blob, an anchor, a click, and no leaked object URL. */
function downloadFile(filename: string, text: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Row({
  entry,
  card,
  action,
  onAction,
}: {
  entry: DeckEntry;
  card: DraftCard | undefined;
  action: string;
  onAction: () => void;
}) {
  return (
    <li className="deckrow" data-testid="deck-row" data-card-name={entry.card.name}>
      <button type="button" className="deckrow__move" onClick={onAction} title={action}>
        {action}
      </button>
      <span className="deckrow__count">{entry.count}</span>
      <span className="deckrow__name">{entry.card.name}</span>
      <span className="deckrow__cost">
        {(card?.manaCost ?? []).map((token, i) => (
          <ManaPip key={i} token={token} />
        ))}
      </span>
      <span className="deckrow__type">{card?.typeLine ?? ''}</span>
    </li>
  );
}

export function DeckView({ draftId, pool, onDownload = downloadFile }: DeckViewProps) {
  const [deck, setDeck] = useState<Deck>(() => deckFromPool(draftId, pool));

  // Rows carry a `CardRequest`, which has a name and a printing and no mana
  // cost — the cost lives on the `DraftCard` the pool was made of. One index,
  // built once, rather than a linear scan per row on every render.
  const byKey = useMemo(() => {
    const index = new Map<string, DraftCard>();
    for (const card of pool) index.set(cardKey(cardRequestOf(card)), card);
    return index;
  }, [pool]);

  const problems = deckProblems(deck, poolOf(deck));
  const main = mainDeckSize(deck);
  const side = sideboardSize(deck);
  const playable = problems.length === 0;
  const text = dckTextOf(deck);

  return (
    <section className="deck" data-testid="deck-view" data-draft-id={draftId}>
      <header className="deck__head">
        <div>
          <h1 className="deck__title">Your deck</h1>
          <p className="deck__sub">
            All {totalCards(poolOf(deck))} drafted cards start in the sideboard. Promote the
            ones you are playing; basics come from the table, not the pool.
          </p>
        </div>
        <div className="deck__counts">
          <span className="deck__count" data-testid="main-count">
            {main}
          </span>
          <span className="deck__of">
            maindeck, {LIMITED_MIN_MAIN_DECK_SIZE} minimum
          </span>
          <span className="deck__count deck__count--quiet" data-testid="side-count">
            {side}
          </span>
          <span className="deck__of">sideboard</span>
        </div>
      </header>

      <div className="deck__basics">
        <h2 className="deck__h2">Basic lands</h2>
        {BASIC_LAND_NAMES.map((name) => {
          const request = basicLand(name);
          const key = cardKey(request);
          const count = deck.basics.find((e) => cardKey(e.card) === key)?.count ?? 0;
          return (
            <span key={name} className="deck__basic" data-testid={`basic-${name}`}>
              <ManaPip token={BASIC_PIP[name] ?? 'C'} />
              <button
                type="button"
                aria-label={`one fewer ${name}`}
                disabled={count === 0}
                onClick={() => setDeck(setBasicLand(deck, request, Math.max(0, count - 1)))}
              >
                −
              </button>
              <span className="deck__basic-n" data-testid={`basic-${name}-count`}>
                {count}
              </span>
              <button
                type="button"
                aria-label={`one more ${name}`}
                onClick={() => setDeck(setBasicLand(deck, request, count + 1))}
              >
                +
              </button>
            </span>
          );
        })}
      </div>

      {problems.length > 0 && (
        <ul className="deck__problems" data-testid="deck-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="deck__piles">
        <section className="deck__pile">
          <h2 className="deck__h2">
            Maindeck <span data-testid="main-rows">{deck.main.length}</span>
          </h2>
          <ul className="deck__list" data-testid="main-list">
            {deck.main.map((entry) => (
              <Row
                key={cardKey(entry.card)}
                entry={entry}
                card={byKey.get(cardKey(entry.card))}
                action="↓"
                onAction={() => setDeck(moveToSideboard(deck, entry.card))}
              />
            ))}
          </ul>
        </section>

        <section className="deck__pile">
          <h2 className="deck__h2">
            Sideboard <span data-testid="side-rows">{deck.sideboard.length}</span>
          </h2>
          <ul className="deck__list" data-testid="side-list">
            {deck.sideboard.map((entry) => (
              <Row
                key={cardKey(entry.card)}
                entry={entry}
                card={byKey.get(cardKey(entry.card))}
                action="↑"
                onAction={() => setDeck(moveToMain(deck, entry.card))}
              />
            ))}
          </ul>
        </section>
      </div>

      <footer className="deck__foot">
        <button
          type="button"
          className="button"
          data-testid="download-dck"
          onClick={() => onDownload(dckFilename(deck), text)}
        >
          Download {dckFilename(deck)}
        </button>
        <span className="deck__note" data-testid="deck-ready">
          {playable
            ? 'Forge opens this file directly.'
            : 'You can export an unfinished deck; Forge will say the same thing about it that we do.'}
        </span>
      </footer>
    </section>
  );
}
