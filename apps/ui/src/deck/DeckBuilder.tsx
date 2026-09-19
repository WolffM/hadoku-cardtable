/*
 * Build a deck out of a finished draft pool, and start a match with it.
 *
 * ## The model is `@hadoku/deck`'s
 *
 * `deckFromPool` opens the builder the way Forge's limited editor does — the
 * whole pool in the sideboard, nothing played — and `moveToMain` /
 * `moveToSideboard` only ever move a card between the two piles, so a card you
 * did not draft has no way in. Basic lands are `setBasicLand`: they come from
 * the table, not the pool, and they are part of the maindeck count that
 * `mainDeckSize` reports against `LIMITED_MIN_MAIN_DECK_SIZE` (40, Forge's
 * `DeckFormat.Limited` floor). This component holds a `Deck` and calls those
 * functions; it has no rules of its own.
 *
 * ## The server says whether it is legal, and it is the server that refuses
 *
 * While you build, the deck's `.dck` text goes to `POST /api/tables/check` with
 * the draft rule, and the answer — which names the card at fault — is shown
 * under the counts. When you press Start, the same text goes to the gate on
 * `POST /api/play/matches`, which checks it again and refuses a match with 422
 * rather than launching Forge. **Start is not disabled by the count**, for the
 * reason `ConstructedScreen` gives: a button a client-side opinion can grey out
 * is a control that can disagree with the server. A short deck is sent, and
 * refused by the thing that is authoritative.
 *
 * ## The other seat
 *
 * Forge reads both seats' decks when the match launches, and the gate's draft
 * arm checks only the caller's own pool — so the other seat is a library deck
 * played by Forge's AI. Playing a FRIEND happens in a room, where each of you
 * loads your own deck (Wave 13 §C): a body naming two decks against a person is
 * refused by the gate, and this screen no longer offers it.
 *
 * ## No trademarks, no images
 *
 * Rows are name, cost and type. `ManaPip` draws its own circles; there are no
 * mana symbols, frames or set symbols, and no image host is named here.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  BASIC_LAND_NAMES,
  LIMITED_MIN_MAIN_DECK_SIZE,
  basicLand,
  cardKey,
  mainDeckSize,
  moveToMain,
  moveToSideboard,
  setBasicLand,
  sideboardSize,
  type Deck,
} from '@hadoku/deck';
import type { DeckEntry } from '@hadoku/carddata/dck';

import { ManaPip } from '../components/ManaPip.tsx';
import { deckFromPool } from '../draft/deckFromPool.ts';
import type { DraftCard } from '../draft/types.ts';
import { navigate } from '../screens/route.ts';
import type { TableDeck, TableFormat, TablesClient, Verdict } from '../screens/tables.ts';
import { cardIndex, draftedSeat, librarySeat, mainSummary, sortPile } from './build.ts';

export interface DeckBuilderProps {
  draftId: string;
  /** The finished pool: every card that may ever be in this deck. */
  pool: readonly DraftCard[];
  client: TablesClient;
  /** How long the deck must sit still before the server is asked about it. */
  checkDelayMs?: number;
}

/** Which of our own pips a basic shows. Never WotC's mana symbol. */
const BASIC_PIP: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

type Library = { formats: TableFormat[]; decks: TableDeck[] };

export function DeckBuilder({ draftId, pool, client, checkDelayMs = 300 }: DeckBuilderProps) {
  const [deck, setDeck] = useState<Deck>(() => deckFromPool(draftId, pool));
  const index = useMemo(() => cardIndex(pool), [pool]);

  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [opponentDeck, setOpponentDeck] = useState('');

  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<{ error: string; seats: Verdict[] | null } | null>(null);

  // The deck as the server will see it. One object per build, so it is also
  // what the check below re-runs on.
  const seat = useMemo(() => draftedSeat(draftId, deck), [draftId, deck]);

  useEffect(() => {
    let live = true;
    Promise.all([client.formats(), client.decks()])
      .then(([formats, decks]) => {
        if (!live) return;
        setLibrary({ formats, decks });
        setOpponentDeck(decks[0]?.id ?? '');
      })
      .catch((err: unknown) => {
        if (live) setLibraryError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [client]);

  // The server's verdict on the deck as it stands, asked once it stops moving.
  useEffect(() => {
    let live = true;
    setVerdict(null);
    setCheckError(null);
    const timer = setTimeout(() => {
      client
        .check(seat)
        .then((v) => {
          if (live) setVerdict(v);
        })
        .catch((err: unknown) => {
          if (live) setCheckError(err instanceof Error ? err.message : String(err));
        });
    }, checkDelayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, seat, checkDelayMs]);

  const change = (next: Deck): void => {
    setRefusal(null);
    setDeck(next);
  };

  const opponentChoice = library?.decks.find((d) => d.id === opponentDeck);

  const start = (): void => {
    if (library === null || opponentChoice === undefined) return;
    setStarting(true);
    setRefusal(null);
    client
      .start('ai', [seat, librarySeat(opponentChoice, library.formats)])
      .then((outcome) => {
        if (outcome.ok) {
          navigate({ kind: 'match', matchId: outcome.matchId });
          return;
        }
        setRefusal({ error: outcome.error, seats: outcome.seats });
        setStarting(false);
      })
      .catch((err: unknown) => {
        setRefusal({ error: err instanceof Error ? err.message : String(err), seats: null });
        setStarting(false);
      });
  };

  const main = mainDeckSize(deck);
  const summary = mainSummary(deck, index);
  const basics = deck.basics.reduce((n, e) => n + e.count, 0);

  return (
    <div className="builder" data-testid="deck-builder">
      <section className="builder__bar lobby__card">
        <div className="builder__counts">
          <span className={main >= LIMITED_MIN_MAIN_DECK_SIZE ? 'builder__n' : 'builder__n builder__n--short'} data-testid="main-count">
            {main}
          </span>
          <span className="builder__of">
            in the maindeck, {LIMITED_MIN_MAIN_DECK_SIZE} minimum — {main - basics} drafted, {basics} basic
          </span>
          <span className="builder__n builder__n--quiet" data-testid="side-count">
            {sideboardSize(deck)}
          </span>
          <span className="builder__of">left in the sideboard</span>
        </div>
        <p className="lobby__note" data-testid="main-summary">
          {summary.creatures} creatures · {summary.spells} other spells · {summary.lands} lands. Coloured pips:{' '}
          {(['W', 'U', 'B', 'R', 'G'] as const)
            .filter((c) => summary.pips[c] > 0)
            .map((c) => `${summary.pips[c]} ${c}`)
            .join(', ') || 'none'}
          .
        </p>

        <div className="builder__basics" data-testid="basics">
          <h2 className="builder__h2">Basic lands</h2>
          {BASIC_LAND_NAMES.map((name) => {
            const request = basicLand(name);
            const key = cardKey(request);
            const count = deck.basics.find((e) => cardKey(e.card) === key)?.count ?? 0;
            return (
              <span key={name} className="builder__basic" data-testid={`basic-${name}`}>
                <ManaPip token={BASIC_PIP[name] ?? 'C'} />
                <span className="builder__basic-name">{name}</span>
                <button
                  type="button"
                  aria-label={`one fewer ${name}`}
                  data-testid={`basic-${name}-less`}
                  disabled={count === 0}
                  onClick={() => change(setBasicLand(deck, request, Math.max(0, count - 1)))}
                >
                  −
                </button>
                <span className="builder__basic-n" data-testid={`basic-${name}-count`}>
                  {count}
                </span>
                <button
                  type="button"
                  aria-label={`one more ${name}`}
                  data-testid={`basic-${name}-more`}
                  onClick={() => change(setBasicLand(deck, request, count + 1))}
                >
                  +
                </button>
              </span>
            );
          })}
        </div>

        <ServerVerdict verdict={verdict} error={checkError} />
      </section>

      <div className="builder__piles">
        <Pile
          title="Maindeck"
          hint="Click a card to send it back to the sideboard."
          testId="main-list"
          entries={sortPile(deck.main, index)}
          index={index}
          onPick={(entry) => change(moveToSideboard(deck, entry.card))}
        />
        <Pile
          title="Sideboard — your drafted pool"
          hint="Click a card to play it."
          testId="side-list"
          entries={sortPile(deck.sideboard, index)}
          index={index}
          onPick={(entry) => change(moveToMain(deck, entry.card))}
        />
      </div>

      <section className="lobby__card" data-testid="start-panel">
        <h2>Play it</h2>
        {libraryError !== null && (
          <p className="lobby__error" role="alert" data-testid="library-error">
            Could not load the deck library for the other seat: {libraryError}
          </p>
        )}
        {library === null && libraryError === null && <p className="lobby__note">Loading the deck library…</p>}
        {library !== null && (
          <>
            <div className="tables__seat">
              <label htmlFor="opponent-deck">The AI plays</label>
              <select
                id="opponent-deck"
                data-testid="opponent-deck"
                value={opponentDeck}
                onChange={(e) => {
                  setRefusal(null);
                  setOpponentDeck(e.target.value);
                }}
              >
                {library.decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {opponentChoice !== undefined && <p className="lobby__note">{opponentChoice.provenance}</p>}
            </div>
            <p className="lobby__note">
              Forge reads both decks when the match starts, and your pool is checked only for you — so the other
              seat plays a deck from the library, not somebody else&rsquo;s draft. To play a friend, make a room on
              the front page: there you each load your own deck.
            </p>
          </>
        )}
        <button
          type="button"
          className="lobby__go"
          data-testid="start-match"
          disabled={starting || library === null || opponentChoice === undefined}
          onClick={start}
        >
          {starting ? 'Starting Forge…' : 'Start the match'}
        </button>
        {refusal !== null && <Refusal error={refusal.error} seats={refusal.seats} />}
      </section>
    </div>
  );
}

function Pile(props: {
  title: string;
  hint: string;
  testId: string;
  entries: DeckEntry[];
  index: ReadonlyMap<string, DraftCard>;
  onPick: (entry: DeckEntry) => void;
}) {
  const { title, hint, testId, entries, index, onPick } = props;
  const total = entries.reduce((n, e) => n + e.count, 0);
  return (
    <section className="builder__pile">
      <h2 className="builder__h2">
        {title} <span className="builder__pile-n">{total}</span>
      </h2>
      <p className="builder__hint">{hint}</p>
      <ul className="builder__list" data-testid={testId}>
        {entries.map((entry) => {
          const card = index.get(cardKey(entry.card));
          return (
            <li key={cardKey(entry.card)}>
              <button
                type="button"
                className="builder__row"
                data-testid="deck-row"
                data-card-name={entry.card.name}
                title={card?.oracleText ?? entry.card.name}
                onClick={() => onPick(entry)}
              >
                <span className="builder__row-n">{entry.count}</span>
                <span className="builder__row-name">{entry.card.name}</span>
                <span className="builder__row-cost">
                  {(card?.manaCost ?? []).map((token, i) => (
                    <ManaPip key={i} token={token} />
                  ))}
                </span>
                <span className="builder__row-type">{card?.typeLine ?? ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ServerVerdict({ verdict, error }: { verdict: Verdict | null; error: string | null }) {
  if (error !== null) {
    return (
      <p className="lobby__error" role="alert" data-testid="deck-verdict-error">
        Could not check the deck: {error}
      </p>
    );
  }
  if (verdict === null) {
    return (
      <p className="lobby__note" data-testid="deck-verdict-pending">
        Checking with the server…
      </p>
    );
  }
  return <VerdictView verdict={verdict} testId="deck-verdict" />;
}

function VerdictView({ verdict, testId }: { verdict: Verdict; testId: string }) {
  return (
    <div className={verdict.legal ? 'tables__legal' : 'tables__illegal'} data-testid={testId}>
      <p>
        {verdict.legal
          ? `The server says: legal against ${verdict.rulesName}.`
          : `The server says: not legal against ${verdict.rulesName} — ${verdict.issues.length} ${verdict.issues.length === 1 ? 'problem' : 'problems'}:`}
      </p>
      {verdict.issues.length > 0 && (
        <ul className="tables__issues">
          {verdict.issues.map((issue, i) => (
            <li key={i}>
              {issue.cardName !== null && <strong className="tables__card">{issue.cardName}</strong>}
              {issue.cardName !== null && ' — '}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Refusal({ error, seats }: { error: string; seats: Verdict[] | null }) {
  return (
    <div className="lobby__error" role="alert" data-testid="start-refused">
      <p>{error}</p>
      {seats !== null &&
        seats.map((v, i) =>
          v.legal ? null : (
            <div key={i}>
              <p>
                Seat {i + 1}: {v.deckName}
              </p>
              <VerdictView verdict={v} testId={`refused-${i}`} />
            </div>
          ),
        )}
    </div>
  );
}
