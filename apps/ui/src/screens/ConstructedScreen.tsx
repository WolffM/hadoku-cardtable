/*
 * `#/play` — constructed: pick a format, pick the decks, start a match.
 *
 * The operator's goal, in their words: *"playing constructed with prebuilt
 * decks, to recreate standard formats from years past."* A format here is a
 * dated Standard (Wave 6's `standardPoolAt`, frozen per date under
 * `decks/pools/`), and a deck is one from the Wave 7 library. Both lists come
 * from the server, so a new frozen pool or a new collection shows up here with
 * no change to this file.
 *
 * ## The server says whether a deck is legal, twice
 *
 * Once as you choose (`POST /api/tables/check`), so the offending cards are on
 * screen before you press anything, and once when you press Start — the gate
 * on `POST /api/play/matches` — which is the check that actually refuses. The
 * Start button is NOT disabled by the first answer: the second is the one that
 * counts, and a button that only a client-side opinion can grey out is a
 * control that can disagree with the server.
 *
 * ## Why you choose your opponent's deck too
 *
 * Forge reads both seats' decks when the match launches (the bridge takes them
 * as launch arguments — `apps/server/src/play/README.md`). So the person
 * starting the match picks both, and the friend they send the link to sits
 * down at a deck that is already chosen. Said on the screen, not discovered.
 *
 * ## The lobby is the draft's lobby
 *
 * This screen is reached from the same front door as a pod, and the match it
 * starts is joined the same way: a link, `#/match/<id>`, that the same join box
 * accepts. There is no second lobby.
 */

import { useEffect, useMemo, useState } from 'react';

import { navigate } from './route.ts';
import {
  deckSize,
  tablesClient,
  type SeatChoice,
  type TableDeck,
  type TableFormat,
  type TablesClient,
  type Verdict,
} from './tables.ts';

export interface ConstructedScreenProps {
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
}

type Loaded = { formats: TableFormat[]; decks: TableDeck[] };

function seatChoice(deckId: string, formatId: string): SeatChoice {
  return { deck: { library: deckId }, rules: { kind: 'standard', format: formatId } };
}

export function ConstructedScreen({ client: given }: ConstructedScreenProps) {
  const client = useMemo(() => given ?? tablesClient(), [given]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formatId, setFormatId] = useState('');
  const [deckIds, setDeckIds] = useState<[string, string]>(['', '']);
  const [opponent, setOpponent] = useState<'human' | 'ai'>('human');
  const [verdicts, setVerdicts] = useState<[Verdict | null, Verdict | null]>([null, null]);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<{ error: string; seats: Verdict[] | null } | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([client.formats(), client.decks()])
      .then(([formats, decks]) => {
        if (!live) return;
        setLoaded({ formats, decks });
        setFormatId(formats[0]?.id ?? '');
        setDeckIds([decks[0]?.id ?? '', decks[1]?.id ?? decks[0]?.id ?? '']);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [client]);

  // The server's verdict for the current choice, re-asked whenever it changes.
  useEffect(() => {
    if (formatId === '' || deckIds[0] === '' || deckIds[1] === '') return;
    let live = true;
    setVerdicts([null, null]);
    setCheckError(null);
    Promise.all(deckIds.map((id) => client.check(seatChoice(id, formatId))))
      .then(([a, b]) => {
        if (live) setVerdicts([a ?? null, b ?? null]);
      })
      .catch((err: unknown) => {
        if (live) setCheckError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [client, formatId, deckIds]);

  const start = (): void => {
    setStarting(true);
    setRefusal(null);
    client
      .start(opponent, [seatChoice(deckIds[0], formatId), seatChoice(deckIds[1], formatId)])
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

  const format = loaded?.formats.find((f) => f.id === formatId);
  const setDeck = (seat: 0 | 1, id: string): void => {
    setRefusal(null);
    setDeckIds((prev) => (seat === 0 ? [id, prev[1]] : [prev[0], id]));
  };

  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title">Constructed</h1>
        <p className="shell__sub">A Standard format from years past, and a deck that was played in it.</p>
      </header>

      <main className="lobby">
        {loadError !== null && (
          <p className="lobby__error" role="alert" data-testid="tables-load-error">
            Could not load the formats and decks: {loadError}
          </p>
        )}
        {loaded === null && loadError === null && <p className="lobby__note">Loading formats and decks…</p>}

        {loaded !== null && (
          <>
            <section className="lobby__card">
              <h2>Format</h2>
              <label htmlFor="format">Standard, as it stood on</label>
              <select
                id="format"
                data-testid="format"
                value={formatId}
                onChange={(e) => {
                  setRefusal(null);
                  setFormatId(e.target.value);
                }}
              >
                {loaded.formats.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.id} — {f.name}
                  </option>
                ))}
              </select>
              {format !== undefined && (
                <p className="lobby__note" data-testid="format-detail">
                  {format.sets.length} sets ({format.sets.join(', ')}), {format.cardCount} cards.{' '}
                  {format.banned.length === 0 ? 'Nothing banned.' : `Banned: ${format.banned.join(', ')}.`}
                </p>
              )}
            </section>

            <section className="lobby__card">
              <h2>Decks</h2>
              <SeatPicker
                seat={0}
                label="Your deck"
                decks={loaded.decks}
                value={deckIds[0]}
                onChange={(id) => setDeck(0, id)}
                verdict={verdicts[0]}
              />
              <fieldset className="tables__opponent">
                <legend>Against</legend>
                <label>
                  <input
                    type="radio"
                    name="opponent"
                    data-testid="opponent-human"
                    checked={opponent === 'human'}
                    onChange={() => setOpponent('human')}
                  />{' '}
                  a friend — you send them the link
                </label>
                <label>
                  <input
                    type="radio"
                    name="opponent"
                    data-testid="opponent-ai"
                    checked={opponent === 'ai'}
                    onChange={() => setOpponent('ai')}
                  />{' '}
                  Forge&rsquo;s AI
                </label>
              </fieldset>
              <SeatPicker
                seat={1}
                label={opponent === 'ai' ? 'The AI plays' : 'Your friend plays'}
                decks={loaded.decks}
                value={deckIds[1]}
                onChange={(id) => setDeck(1, id)}
                verdict={verdicts[1]}
              />
              <p className="lobby__note">
                Forge reads both decks when the match starts, so you choose your
                opponent&rsquo;s too.
              </p>
              {checkError !== null && (
                <p className="lobby__error" role="alert">
                  Could not check the decks: {checkError}
                </p>
              )}
              <button
                type="button"
                className="lobby__go"
                data-testid="start-match"
                disabled={starting || formatId === '' || deckIds[0] === '' || deckIds[1] === ''}
                onClick={start}
              >
                {starting ? 'Starting Forge…' : 'Start the match'}
              </button>
              {refusal !== null && <Refusal error={refusal.error} seats={refusal.seats} />}
            </section>
          </>
        )}
      </main>

      <footer className="shell__foot">
        <p>
          <a
            className="shell__link"
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'lobby' });
            }}
          >
            Back to the lobby
          </a>
        </p>
      </footer>
    </div>
  );
}

function SeatPicker(props: {
  seat: 0 | 1;
  label: string;
  decks: TableDeck[];
  value: string;
  onChange: (id: string) => void;
  verdict: Verdict | null;
}) {
  const { seat, label, decks, value, onChange, verdict } = props;
  const deck = decks.find((d) => d.id === value);
  const size = deck === undefined ? null : deckSize(deck);
  const id = `deck-${seat}`;
  return (
    <div className="tables__seat" data-testid={`seat-${seat}`}>
      <label htmlFor={id}>{label}</label>
      <select id={id} data-testid={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {decks.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      {deck !== undefined && size !== null && (
        <p className="lobby__note">
          {deck.provenance}{' '}
          <a className="shell__link" href={deck.citation} target="_blank" rel="noreferrer">
            source
          </a>
          . {size.main} cards{size.sideboard > 0 ? `, ${size.sideboard} in the sideboard` : ''}.
        </p>
      )}
      {verdict === null ? (
        <p className="lobby__note">Checking…</p>
      ) : (
        <VerdictView verdict={verdict} testId={`verdict-${seat}`} />
      )}
    </div>
  );
}

function VerdictView({ verdict, testId }: { verdict: Verdict; testId: string }) {
  return (
    <div className={verdict.legal ? 'tables__legal' : 'tables__illegal'} data-testid={testId}>
      <p>
        {verdict.legal
          ? `Legal in ${verdict.rulesName}.`
          : `Not legal in ${verdict.rulesName} — ${verdict.issues.length} ${verdict.issues.length === 1 ? 'problem' : 'problems'}:`}
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
      {verdict.note !== null && <p className="lobby__note">{verdict.note}</p>}
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
