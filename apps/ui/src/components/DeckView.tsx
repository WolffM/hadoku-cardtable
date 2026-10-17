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
 * ## The deck's colours
 *
 * Operator, wave 26: *"decks should have their corresponding mana symbols."* So
 * the head carries the MAINDECK's colours, folded out of the deck's own card
 * list by {@link mainDeckColors} — not stored anywhere, because a deck that
 * remembered its colours could disagree with the cards in it.
 *
 * The fold is `@hadoku/deck`'s (`colors.ts`), shared with the room screen and
 * the server's match stats; the pips are exported, and `deck/DeckEditor.tsx`
 * draws the same ones over the same model.
 *
 * ## No frames, and no images at all
 *
 * Rows are name, cost and type. The symbols are Keyrune's and Mana's as of D20
 * (2026-09-27) — `ManaPip` owns that and this file only calls it. Still
 * forbidden here as everywhere: card frames, the WotC logo, the wordmark.
 *
 * **And no art.** This file renders no `CardTile` and no `<img>`: every pile,
 * main and sideboard alike, is the text `Row` below, and its only component
 * import is `ManaPip`. Until wave 25 §F this paragraph claimed "the pool tiles
 * reuse `CardTile`", which was never true of this file — a stale comment that
 * reads as a second art path when someone goes looking for one. There is
 * exactly one `<img>` in the app (`CardTile.tsx`) and this is not it.
 *
 * A deck list as text is a choice: 40-plus cards you sort, count and move, not
 * a gallery. Making it a grid of tiles is a design change, not a bug fix. If it
 * ever becomes one, the art comes from `CardTile` → `draft/cardImage.ts` →
 * `@hadoku/carddata/art` → `art-manifest.json` like everywhere else; no image
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
  foldDeckColors,
  type Deck,
  type DeckColor,
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
 * Which pip a basic land shows.
 *
 * Also the colour a basic contributes to {@link mainDeckColors} — a deck with
 * twelve Forests in it is green even if every spell in it is Phyrexian.
 */
const BASIC_PIP: Record<string, string> = {
  Plains: 'W',
  Island: 'U',
  Swamp: 'B',
  Mountain: 'R',
  Forest: 'G',
};

/* ── a deck's colours ────────────────────────────────────────────────── */

/**
 * The MAINDECK's colours — what you are playing, not what you drafted.
 *
 * The maindeck rather than the pool because a limited pool is usually all five
 * colours and saying so tells a builder nothing. Basics count: they are the
 * mana, and a deck whose spells are all Phyrexian is still the colour of its
 * lands.
 */
export function mainDeckColors(
  deck: Deck,
  index: ReadonlyMap<string, DraftCard>,
): DeckColor[] {
  const tokens: string[] = [];
  for (const entry of deck.main) tokens.push(...(index.get(cardKey(entry.card))?.manaCost ?? []));
  for (const entry of deck.basics) {
    const pip = entry.count > 0 ? BASIC_PIP[entry.card.name] : undefined;
    if (pip !== undefined) tokens.push(pip);
  }
  return foldDeckColors(tokens);
}

/**
 * A deck's colours, as pips.
 *
 * Each pip is wrapped in a span of OUR own carrying `data-color`, so counting
 * the colours of a deck on screen does not depend on what `ManaPip` renders
 * inside — that is `ManaPip.tsx`'s business and it changed twice this month.
 */
export function DeckColors({
  colors,
  label,
}: {
  colors: readonly DeckColor[];
  label?: string;
}) {
  return (
    <span
      className="cost deckcolors"
      data-testid="deck-colors"
      data-colors={colors.join('')}
      aria-label={label ?? `deck colours: ${colors.length === 0 ? 'colourless' : colors.join(' ')}`}
    >
      {colors.map((color) => (
        <span key={color} className="deckcolors__pip" data-color={color}>
          <ManaPip token={color} />
        </span>
      ))}
      {colors.length === 0 && <span className="deckcolors__none">colourless</span>}
    </span>
  );
}

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

  const colors = mainDeckColors(deck, byKey);
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
          <DeckColors colors={colors} label={`your deck's colours: ${colors.join(' ') || 'colourless'}`} />
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
            : 'Incomplete.'}
        </span>
      </footer>
    </section>
  );
}
