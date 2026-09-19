/*
 * The constructed table, inside a room: YOUR deck, their state, and the match
 * the server starts once both of you are ready.
 *
 * The operator's flow (`docs/handoff/w13.md`): a room list, a room, a game
 * type, then *"once both players have a valid deck loaded the game can be
 * started"*. What this screen used to be — one person choosing BOTH decks and
 * sending a link — is the shape they rejected in exactly those words: *"this is
 * not how any of this should work"*. So there is no picker here for anybody's
 * deck but your own, and no call this file can make that names another member.
 *
 * ## The server is the authority, and it is asked once per deck
 *
 * Loading a deck is `PUT /api/tables/rooms/:roomId/deck`, which checks it with
 * the gate and stores the verdict; that stored verdict is what the match starts
 * from. The Ready toggle is disabled while your deck is illegal, and the server
 * refuses the same thing with the same sentence — the disabled button is a
 * courtesy, the refusal is the control.
 *
 * ## Waiting for the other person is the job
 *
 * Both players' state — chosen, legal, ready — is polled from the room
 * (`pollMs`, 1.5 s). No second socket: `RoomChrome` already holds one for the
 * room's chat and roster, and a second one would share and then tear down its
 * connection. When both are ready either browser asks the server to start; the
 * server answers one match to both, and `matchId` appearing on the table is
 * what sends each player to `#/match/<id>` — including a player who never
 * pressed anything.
 *
 * ## Without a room
 *
 * `#/play` has nothing left to do: a match against a person starts in a room.
 * It points back at the room list rather than rendering a table with no room.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { navigate } from './route.ts';
import { roomsClient, type RoomsClient } from '../rooms/api.ts';
import {
  deckSize,
  tablesClient,
  type RoomPlayer,
  type RoomTable,
  type SeatChoice,
  type TableDeck,
  type TableFormat,
  type TablesClient,
  type Verdict,
} from './tables.ts';

export interface ConstructedScreenProps {
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
  /** The room whose table this is. `App` threads it from `#/room/<id>`. */
  roomId?: string;
  /** How often the room's table is re-read. Tests pass something small. */
  pollMs?: number;
  /** Tests pass a rooms client so the join-on-entry can be driven. Production passes nothing. */
  rooms?: RoomsClient;
}

type Loaded = { formats: TableFormat[]; decks: TableDeck[] };

function seatChoice(deckId: string, formatId: string): SeatChoice {
  return { deck: { library: deckId }, rules: { kind: 'standard', format: formatId } };
}

export function ConstructedScreen({ client: given, roomId, pollMs = 1500, rooms }: ConstructedScreenProps) {
  const client = useMemo(() => given ?? tablesClient(), [given]);
  return roomId === undefined ? <NoRoom /> : <RoomTableScreen client={client} roomId={roomId} pollMs={pollMs} rooms={rooms} />;
}

function RoomTableScreen({
  client,
  roomId,
  pollMs,
  rooms: givenRooms,
}: {
  client: TablesClient;
  roomId: string;
  pollMs: number;
  rooms?: RoomsClient;
}) {
  const rooms = useMemo(() => givenRooms ?? roomsClient(), [givenRooms]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formatId, setFormatId] = useState('');
  const [deckId, setDeckId] = useState('');
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startRefusal, setStartRefusal] = useState<string | null>(null);
  /** A start is in flight, or has been refused: not asked again on every poll. */
  const asked = useRef(false);
  /** The picker is set from the server's copy of your choice exactly once. */
  const restored = useRef(false);
  /**
   * The join was refused. `need` is the first refusal, sent without a
   * password; `wrong` is a refusal for one we sent. The two are different
   * sentences to a person and the same response from the server, which cannot
   * tell us which it was without telling an outsider that the room exists.
   */
  const [locked, setLocked] = useState<null | 'need' | 'wrong' | 'rate-limited'>(null);
  const [password, setPassword] = useState('');
  /** Bumped to re-run the join with whatever `passwordRef` now holds. */
  const [attempt, setAttempt] = useState(0);
  const passwordRef = useRef('');

  useEffect(() => {
    let live = true;
    Promise.all([client.formats(), client.decks()])
      .then(([formats, decks]) => {
        if (!live) return;
        setLoaded({ formats, decks });
        setFormatId((prev) => (prev === '' ? (formats[0]?.id ?? '') : prev));
        setDeckId((prev) => (prev === '' ? (decks[0]?.id ?? '') : prev));
      })
      .catch((err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [client]);

  // The room's table, polled. One read now, then one every `pollMs`.
  //
  // ## Entering a room joins it
  //
  // Reaching a room by any route other than the list's Join button — an invite
  // link, a refresh, a bookmark, a second browser — used to leave you a
  // non-member. The server answers a non-member exactly as it answers a
  // missing room (`routes.ts` `tableFor`, deliberately: a different answer
  // would tell an outsider which rooms exist), so the screen said "this room
  // is not there" about a room that was, and polled that 404 forever.
  //
  // Observed live 2026-09-19 on `r-8eb2a7cd614c`: the leader read it fine, the
  // second person got 404 on every poll, and the room file on disk held
  // exactly one member. So a read that is refused tries to JOIN once, then
  // reads again.
  //
  // Only once, and only for a refusal. A locked room refuses the join too, and
  // retrying that on a 1.5 s timer is a rate-limit trip and a password
  // guessing loop nobody asked for.
  useEffect(() => {
    let live = true;
    let joined = false;
    let stop = false;
    const read = (): void => {
      if (stop) return;
      void client.table(roomId).then(async (outcome) => {
        if (!live) return;
        if (outcome.ok) {
          setTable(outcome.table);
          setTableError(null);
          return;
        }
        if (joined) {
          // The join went through, so this refusal is something else — a room
          // that has since gone, or a read that raced the write. Keep polling:
          // stopping here would strand a member who is genuinely in the room.
          setTableError(outcome.error);
          return;
        }
        joined = true;
        const join = await rooms.join(roomId, passwordRef.current === '' ? undefined : passwordRef.current);
        if (!live) return;
        if (join.ok) {
          read();
          return;
        }
        stop = true;
        if (join.reason === 'refused') {
          // Locked, or genuinely not there — the server will not say which,
          // and should not. Ask for the password rather than sending someone
          // who followed a valid invite link back to the list, which was the
          // dead end the operator hit on 2026-09-19.
          setLocked(passwordRef.current === '' ? 'need' : 'wrong');
          return;
        }
        if (join.reason === 'rate-limited') {
          setLocked('rate-limited');
          return;
        }
        setTableError(join.message ?? outcome.error);
      });
    };
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, rooms, roomId, pollMs, attempt]);

  const players = table?.players ?? [];
  const mine = players.find((p) => p.you) ?? null;
  const matchId = table?.room.matchId ?? null;
  const full = players.length >= (table?.room.seats ?? 2);
  const spectating = table !== null && !table.you.player && full;
  const bothReady = players.length === 2 && players.every((p) => p.ready && p.legal);

  // The match the server started — for whoever pressed nothing, too.
  useEffect(() => {
    if (matchId !== null) navigate({ kind: 'match', matchId });
  }, [matchId]);

  // Both ready: either browser may ask, and the server answers one match to both.
  useEffect(() => {
    if (!bothReady || matchId !== null || mine === null || asked.current) return;
    asked.current = true;
    setStarting(true);
    client
      .startRoom(roomId)
      .then((outcome) => {
        if (outcome.ok) {
          navigate({ kind: 'match', matchId: outcome.matchId });
          return;
        }
        setStartRefusal(outcome.error);
        setStarting(false);
      })
      .catch((err: unknown) => {
        setStartRefusal(err instanceof Error ? err.message : String(err));
        setStarting(false);
      });
  }, [bothReady, matchId, mine, client, roomId]);

  // Your own choice, as the server holds it: the picker opens where you left it.
  useEffect(() => {
    if (restored.current || mine === null || mine.choice === null) return;
    const { deck, rules } = mine.choice;
    restored.current = true;
    if ('library' in deck) setDeckId(deck.library);
    if (rules.kind === 'standard') setFormatId(rules.format);
  }, [mine]);

  const apply = (outcome: Awaited<ReturnType<TablesClient['table']>>): void => {
    if (outcome.ok) {
      setTable(outcome.table);
      setActionError(null);
      return;
    }
    setActionError(outcome.error);
  };

  const loadDeck = (): void => {
    setBusy(true);
    setActionError(null);
    client
      .loadDeck(roomId, seatChoice(deckId, formatId))
      .then(apply)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const setReady = (ready: boolean): void => {
    setBusy(true);
    setActionError(null);
    client
      .ready(roomId, ready)
      .then(apply)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const format = loaded?.formats.find((f) => f.id === formatId);

  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title" data-testid="room-name">
          {table?.room.name ?? roomId}
        </h1>
        <p className="shell__sub">Constructed 1v1 — each of you loads your own deck.</p>
      </header>

      <main className="lobby">
        {locked !== null && (
          <form
            className="lobby__locked"
            data-testid="room-locked"
            onSubmit={(e) => {
              e.preventDefault();
              passwordRef.current = password;
              setLocked(null);
              setTableError(null);
              setAttempt((n) => n + 1);
            }}
          >
            <p role="alert">
              {locked === 'need'
                ? 'This room needs a password.'
                : locked === 'wrong'
                  ? 'That password did not work. It may also be that the room is no longer there.'
                  : 'Too many attempts. Wait a moment before trying again.'}
            </p>
            <label htmlFor="room-password">Password</label>
            <input
              id="room-password"
              data-testid="room-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="submit" data-testid="room-password-submit" disabled={locked === 'rate-limited'}>
              Join
            </button>
          </form>
        )}
        {locked === null && tableError !== null && table === null && (
          <p className="lobby__error" role="alert" data-testid="room-missing">
            {tableError}
          </p>
        )}
        {loadError !== null && (
          <p className="lobby__error" role="alert" data-testid="tables-load-error">
            Could not load the formats and decks: {loadError}
          </p>
        )}

        {table !== null && (
          <>
            <section className="lobby__card">
              <h2>At the table</h2>
              <ul className="tables__players" data-testid="room-players">
                {[0, 1].map((seat) => {
                  const player = players[seat];
                  return player === undefined ? (
                    <li key={seat} className="tables__seat" data-testid={`room-seat-${seat}-empty`}>
                      Waiting for someone to load a deck.
                    </li>
                  ) : (
                    <PlayerRow key={seat} seat={seat} player={player} />
                  );
                })}
              </ul>
              <p className="lobby__note" data-testid="start-state">
                {startStateText(players, bothReady, starting, matchId)}
              </p>
              {startRefusal !== null && (
                <div className="lobby__error" role="alert" data-testid="start-refused">
                  <p>{startRefusal}</p>
                  <button
                    type="button"
                    data-testid="start-retry"
                    onClick={() => {
                      asked.current = false;
                      setStartRefusal(null);
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
            </section>

            {spectating ? (
              <section className="lobby__card">
                <p className="lobby__note" data-testid="room-spectator">
                  This table already has two players. You can watch the room, but there is no third seat.
                </p>
              </section>
            ) : (
              loaded !== null && (
                <section className="lobby__card">
                  <h2>Your deck</h2>
                  <label htmlFor="format">Standard, as it stood on</label>
                  <select id="format" data-testid="format" value={formatId} onChange={(e) => setFormatId(e.target.value)}>
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

                  <label htmlFor="deck-mine">You play</label>
                  <select id="deck-mine" data-testid="deck-mine" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
                    {loaded.decks.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <DeckNote deck={loaded.decks.find((d) => d.id === deckId)} />

                  <button
                    type="button"
                    className="lobby__go"
                    data-testid="load-deck"
                    disabled={busy || formatId === '' || deckId === '' || matchId !== null}
                    onClick={loadDeck}
                  >
                    {mine === null ? 'Load this deck' : 'Load this deck instead'}
                  </button>

                  {mine?.verdict != null && <VerdictView verdict={mine.verdict} testId="verdict-mine" />}

                  <button
                    type="button"
                    className="lobby__go"
                    data-testid="ready-toggle"
                    aria-pressed={mine?.ready === true}
                    disabled={busy || mine === null || !mine.legal || matchId !== null}
                    onClick={() => setReady(!(mine?.ready === true))}
                  >
                    {mine?.ready === true ? 'I’m ready — stand down' : 'I’m ready'}
                  </button>
                  {mine !== null && !mine.legal && (
                    <p className="lobby__note" data-testid="ready-blocked">
                      Your deck is not legal in {mine.rulesName} yet, so you cannot ready up.
                    </p>
                  )}
                  {actionError !== null && (
                    <p className="lobby__error" role="alert" data-testid="table-error">
                      {actionError}
                    </p>
                  )}
                </section>
              )
            )}
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
            Back to the rooms
          </a>
        </p>
      </footer>
    </div>
  );
}

/** The sentence under the two players: who is being waited on, in one line. */
function startStateText(players: RoomPlayer[], bothReady: boolean, starting: boolean, matchId: string | null): string {
  if (matchId !== null) return 'The match is running — taking you to it.';
  if (starting) return 'Starting Forge…';
  if (players.length < 2) return 'Waiting for a second player to load a deck.';
  if (bothReady) return 'Both ready.';
  const waiting = players.filter((p) => !p.ready).map((p) => (p.you ? 'you' : p.name));
  return `Waiting for ${waiting.join(' and ')}.`;
}

function PlayerRow({ seat, player }: { seat: number; player: RoomPlayer }) {
  return (
    <li className="tables__seat" data-testid={`room-seat-${seat}`}>
      <strong>{player.you ? `${player.name} (you)` : player.name}</strong> — {player.deckName}{' '}
      <span data-testid={`room-seat-${seat}-legal`}>
        {player.legal ? `legal in ${player.rulesName}` : `not legal in ${player.rulesName} (${player.issueCount} problems)`}
      </span>
      {' · '}
      <span data-testid={`room-seat-${seat}-ready`}>{player.ready ? 'ready' : 'not ready'}</span>
    </li>
  );
}

function DeckNote({ deck }: { deck: TableDeck | undefined }) {
  if (deck === undefined) return null;
  const size = deckSize(deck);
  return (
    <p className="lobby__note">
      {deck.provenance}{' '}
      <a className="shell__link" href={deck.citation} target="_blank" rel="noreferrer">
        source
      </a>
      . {size.main} cards{size.sideboard > 0 ? `, ${size.sideboard} in the sideboard` : ''}.
    </p>
  );
}

/** `#/play` with no room: the room list is where a match starts now. */
function NoRoom() {
  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title">Constructed</h1>
        <p className="shell__sub">A Standard format from years past, and a deck that was played in it.</p>
      </header>
      <main className="lobby">
        <section className="lobby__card">
          <p data-testid="constructed-pointer">
            A constructed game is played in a room: open a room from the front page (or make one), and each of you loads
            your own deck there. Nobody picks anybody else’s deck any more.
          </p>
          <button
            type="button"
            className="lobby__go"
            data-testid="to-rooms"
            onClick={() => navigate({ kind: 'lobby' })}
          >
            See the rooms
          </button>
        </section>
      </main>
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
