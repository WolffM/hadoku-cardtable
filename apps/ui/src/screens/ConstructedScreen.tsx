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
 * ## Choosing a deck IS loading it, and the era decides which decks there are
 *
 * The operator, of the Load button this used to have: *"just 'I'm ready' is
 * enough."* So there are two selects and one button. Picking a deck sends the
 * `PUT` itself; picking an era re-sends it under the new rules, because a deck
 * held against one format and started in another is the one way this screen
 * could lie about what it checked.
 *
 * The era also NARROWS the deck list to the decks legal in it, which is one
 * `POST /api/tables/check` per deck — see `legalDecksIn` for why there is no
 * cheaper question to ask, and why a deck the server could not be asked about
 * is offered rather than hidden. The answer is remembered per era, so flicking
 * between two eras costs nothing the second time.
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
 * ## Two clients, and the room decides which (D19a)
 *
 * A room is created `builtin` — this table — or `streamed`, which is Forge's
 * own desktop client running in a container per seat and shown through the
 * server's `/stream/**` route. The choice is the ROOM's, made once at create
 * and never again, so this screen reads it and renders one of two bodies; it
 * offers no switch, because there is nothing to switch to mid-room.
 *
 * The mode comes from `GET /api/rooms/:id`, polled beside the table, and is
 * latched the first time it is read: a later answer cannot turn a room someone
 * is sitting in into the other kind. A read that fails leaves the mode unknown
 * and this renders the builtin table — the same direction `parseRoomView`
 * defaults in, and the same outage the table poll is already reporting in
 * words a few lines below.
 *
 * ## Without a room
 *
 * `#/play` has nothing left to do: a match against a person starts in a room.
 * It points back at the room list rather than rendering a table with no room.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { navigate } from './route.ts';
import {
  roomsClient,
  streamPath,
  streamReachable,
  type ClientMode,
  type Fetch,
  type RoomMember,
  type RoomView,
  type RoomsClient,
} from '../rooms/api.ts';
import {
  RANDOM_DECK,
  legalDecksIn,
  pickRandom,
  secureRandom,
  tablesClient,
  type LegalSweep,
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
  /** Tests pass the stream probe's `fetch`. Production passes nothing. */
  streamFetch?: Fetch;
  /** Where `Random` gets its number. Tests pin it; production passes nothing. */
  rand?: () => number;
}

/** How often a seat that has no stream yet asks again. */
export const STREAM_PROBE_MS = 5000;

type Loaded = { formats: TableFormat[]; decks: TableDeck[] };

function seatChoice(deckId: string, formatId: string): SeatChoice {
  return { deck: { library: deckId }, rules: { kind: 'standard', format: formatId } };
}

export function ConstructedScreen({
  client: given,
  roomId,
  pollMs = 1500,
  rooms,
  streamFetch,
  rand = secureRandom,
}: ConstructedScreenProps) {
  const client = useMemo(() => given ?? tablesClient(), [given]);
  return roomId === undefined ? (
    <NoRoom />
  ) : (
    <RoomTableScreen
      client={client}
      roomId={roomId}
      pollMs={pollMs}
      rooms={rooms}
      streamFetch={streamFetch}
      rand={rand}
    />
  );
}

function RoomTableScreen({
  client,
  roomId,
  pollMs,
  rooms: givenRooms,
  streamFetch,
  rand,
}: {
  client: TablesClient;
  roomId: string;
  pollMs: number;
  rooms?: RoomsClient;
  streamFetch?: Fetch;
  rand: () => number;
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
  /** The era's answer to "which decks are legal here", and one per era kept. */
  const [legal, setLegal] = useState<LegalSweep | null>(null);
  const sweeps = useRef(new Map<string, LegalSweep>());
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
  /**
   * The room's own record: which client it runs, and who is in it. Streamed
   * rooms are drawn entirely from this — there is no deck to load and no
   * `players` list to read, so `table` says nothing useful about them.
   *
   * `resolved` flips on the first answer of any kind, success or failure, and
   * gates the body below so a streamed room never flashes the builtin table on
   * the way in. It is one extra concurrent request alongside the table read,
   * not a second round trip after it.
   */
  const [view, setView] = useState<RoomView | null>(null);
  const [resolved, setResolved] = useState(false);
  /** Latched on the first read. A room does not change mode under its players. */
  const modeRef = useRef<ClientMode | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([client.formats(), client.decks()])
      .then(([formats, decks]) => {
        if (!live) return;
        setLoaded({ formats, decks });
        setFormatId((prev) => (prev === '' ? (formats[0]?.id ?? '') : prev));
        // No deck is chosen for you. Choosing one is what loads it, and the
        // Ready button is dead until you have, so a default here would both
        // load a deck nobody picked and make Ready live on arrival.
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

  // The room record, polled on the same beat as the table. The mode is latched
  // on the first read; the membership keeps moving, because a streamed room's
  // seats appear as people arrive.
  useEffect(() => {
    let live = true;
    const read = (): void => {
      rooms.get(roomId).then(
        (room) => {
          if (!live) return;
          setResolved(true);
          if (room === null) return;
          modeRef.current ??= room.clientMode;
          setView(room);
        },
        () => {
          // The room could not be read. That is the same server the table poll
          // is reading, and `tableError` below already says so in words; adding
          // a second sentence about it would say it twice. What this must not
          // do is stay silent AND keep the body hidden, so the gate opens.
          if (live) setResolved(true);
        },
      );
    };
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [rooms, roomId, pollMs]);

  const players = table?.players ?? [];
  const mine = players.find((p) => p.you) ?? null;
  const matchId = table?.room.matchId ?? null;
  const full = players.length >= (table?.room.seats ?? 2);
  const spectating = table !== null && !table.you.player && full;
  const bothReady = players.length === 2 && players.every((p) => p.ready && p.legal);
  const streamed = modeRef.current === 'streamed';
  /** Whether the deck card is on the screen at all: nothing below asks for it otherwise. */
  const picking = !streamed && resolved && locked === null && table !== null && !spectating && loaded !== null;

  // Which decks this era offers. One sweep per era, remembered — see
  // `legalDecksIn`. Gated on the card being drawn, so a streamed room, a
  // locked room and a spectator ask nothing.
  useEffect(() => {
    if (!picking || loaded === null || formatId === '') return;
    const cached = sweeps.current.get(formatId);
    if (cached !== undefined) {
      setLegal(cached);
      return;
    }
    let live = true;
    void legalDecksIn(client, formatId, loaded.decks).then((sweep) => {
      // A sweep the server refused is NOT remembered: it offers every deck,
      // and caching that would leave the era un-narrowed for as long as the
      // page is open over one dropped request. Coming back to the era retries.
      if (sweep.error === null) sweeps.current.set(sweep.formatId, sweep);
      if (!live) return;
      setLegal(sweep);
      if (sweep.error !== null) setActionError(sweep.error);
    });
    return () => {
      live = false;
    };
  }, [picking, loaded, formatId, client]);

  /** The decks on offer, or null while the era's answer is still in flight. */
  const offered = useMemo(
    () =>
      legal !== null && legal.formatId === formatId && loaded !== null
        ? loaded.decks.filter((d) => legal.ids.has(d.id))
        : null,
    [legal, formatId, loaded],
  );

  // A deck the new era does not offer is no longer chosen. The `PUT` under the
  // new rules has already gone (`chooseFormat`), so its verdict is on the
  // screen saying which card is the problem; what this does is stop Ready
  // coming back to life over a deck the list no longer contains.
  useEffect(() => {
    if (offered === null || deckId === '') return;
    if (!offered.some((d) => d.id === deckId)) setDeckId('');
  }, [offered, deckId]);

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

  /** Hold a deck against a format. There is no button: choosing is loading. */
  const loadDeck = (deck: string, format: string): void => {
    setBusy(true);
    setActionError(null);
    client
      .loadDeck(roomId, seatChoice(deck, format))
      .then(apply)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /**
   * The deck dropdown moved. `Random` is one of the decks ON OFFER — the era
   * has already narrowed them, so it cannot roll an illegal deck — and it
   * resolves to that deck's id rather than staying a mystery: what you got is
   * what the dropdown then reads.
   */
  const chooseDeck = (value: string): void => {
    const chosen = value === RANDOM_DECK ? pickRandom(offered ?? [], rand)?.id : value;
    if (chosen === undefined || chosen === '') return;
    setDeckId(chosen);
    loadDeck(chosen, formatId);
  };

  /**
   * The era moved. A deck already chosen is re-sent under the new rules, so the
   * verdict the server holds is never one it formed against a different format.
   * Whether the deck survives the new era is the sweep's answer, above.
   */
  const chooseFormat = (value: string): void => {
    setFormatId(value);
    if (deckId !== '') loadDeck(deckId, value);
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

  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title" data-testid="room-name">
          {streamed ? (view?.name ?? roomId) : (table?.room.name ?? roomId)}
        </h1>
        {/* The header states which client this room is, so nobody who followed
            a link has to work it out from what is drawn below. A builtin room
            says exactly what it has always said — that sentence already names
            our table — so the only new words are the streamed room's. */}
        <p className="shell__sub" data-testid="room-client-mode">
          {streamed
            ? 'Forge’s full client'
            : 'Constructed 1v1'}
        </p>
      </header>

      <main className="lobby">
        {streamed && <StreamedSeats roomId={roomId} members={view?.members ?? []} streamFetch={streamFetch} />}
        {/* Everything below is the builtin room, unchanged. It waits for the
            room record as well as the table so a streamed room never flashes
            a deck picker on its way in; both reads are in flight together, so
            this is not a second round trip. */}
        {!streamed && resolved && (
          <>
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
                  ? 'Wrong password.'
                  : 'Too many attempts.'}
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
                    <li key={seat} className="tables__row tables__row--empty" data-testid={`room-seat-${seat}-empty`}>
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
                  Table full &mdash; watching.
                </p>
              </section>
            ) : (
              loaded !== null && (
                <section className="lobby__card">
                  <h2>Your deck</h2>
                  <label htmlFor="format">Standard, as it stood on</label>
                  <select id="format" data-testid="format" value={formatId} onChange={(e) => chooseFormat(e.target.value)}>
                    {loaded.formats.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.id} — {f.name}
                      </option>
                    ))}
                  </select>

                  {/* Only the decks that era offers, and the era's answer is
                      the gate's. Disabled until it has answered: an option
                      list assembled before the answer would offer decks the
                      era does not have. */}
                  <label htmlFor="deck-mine">You play</label>
                  <select
                    id="deck-mine"
                    data-testid="deck-mine"
                    value={deckId}
                    disabled={offered === null || matchId !== null}
                    onChange={(e) => chooseDeck(e.target.value)}
                  >
                    <option value="" disabled>
                      —
                    </option>
                    <option value={RANDOM_DECK}>Random</option>
                    {(offered ?? []).map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <DeckSource deck={(offered ?? []).find((d) => d.id === deckId)} />

                  {mine?.verdict != null && <VerdictView verdict={mine.verdict} testId="verdict-mine" />}

                  <button
                    type="button"
                    className="lobby__go"
                    data-testid="ready-toggle"
                    aria-pressed={mine?.ready === true}
                    disabled={busy || deckId === '' || mine === null || !mine.legal || matchId !== null}
                    onClick={() => setReady(!(mine?.ready === true))}
                  >
                    {mine?.ready === true ? 'Stand down' : 'Ready'}
                  </button>
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

/* ── the streamed room's face ─────────────────────────────────────────── */

/**
 * A streamed room's body: one seat per member, each seat one stream.
 *
 * One container per seat is the settled shape (operator, at w18's dispatch), so
 * this is a grid of member-sized screens rather than one shared view. The seat
 * number is the member's place in the room's own member list — the same order
 * the server hands out and the same number its stream route is keyed by.
 *
 * Nothing here draws a mana symbol, a set symbol, a tap symbol or a card frame:
 * it is text, boxes and a frame. The pixels inside the frame are Forge's own.
 */
function StreamedSeats({
  roomId,
  members,
  streamFetch,
}: {
  roomId: string;
  members: RoomMember[];
  streamFetch?: Fetch;
}) {
  return (
    <section className="lobby__card streams" data-testid="room-streams">
      <h2>One screen each</h2>
      {members.length === 0 ? (
        <p className="lobby__note" data-testid="stream-nobody">
          Nobody has joined yet.
        </p>
      ) : (
        <ul className="streams__grid" data-testid="stream-seats">
          {members.map((member, seat) => (
            <StreamSeat key={member.id} roomId={roomId} seat={seat} member={member} streamFetch={streamFetch} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One seat's screen, or the honest reason there is not one.
 *
 * The frame is mounted only once the seat's page has been fetched and proved
 * to be the stream's (`streamReachable`). Anything else — no containers, a
 * container still starting, the route not there — is the stated waiting line.
 * It is never a spinner: a spinner says "nearly", and until a container exists
 * nobody knows that. Once a seat is up it stays up and the probe stops.
 */
function StreamSeat({
  roomId,
  seat,
  member,
  streamFetch,
}: {
  roomId: string;
  seat: number;
  member: RoomMember;
  streamFetch?: Fetch;
}) {
  const url = streamPath(roomId, seat);
  const [up, setUp] = useState(false);

  useEffect(() => {
    if (up) return;
    let live = true;
    const probe = (): void => {
      void streamReachable(url, streamFetch).then((ok) => {
        if (live && ok) setUp(true);
      });
    };
    probe();
    const timer = setInterval(probe, STREAM_PROBE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [url, up, streamFetch]);

  return (
    <li className="streams__seat" data-testid="stream-seat" data-seat={seat}>
      <span className="streams__who" data-testid="stream-seat-who">
        {member.name}
      </span>
      {up ? (
        <iframe
          className="streams__frame"
          data-testid="stream-frame"
          title={`${member.name}’s screen`}
          src={url}
        />
      ) : (
        <p className="streams__waiting" data-testid="stream-waiting">
          No screen yet.
        </p>
      )}
    </li>
  );
}

/** The sentence under the two players: who is being waited on, in one line. */
function startStateText(players: RoomPlayer[], bothReady: boolean, starting: boolean, matchId: string | null): string {
  if (matchId !== null) return 'Match running — joining.';
  if (starting) return 'Starting Forge…';
  if (players.length < 2) return 'Waiting for a second player.';
  if (bothReady) return 'Both ready.';
  const waiting = players.filter((p) => !p.ready).map((p) => (p.you ? 'you' : p.name));
  return `Waiting for ${waiting.join(' and ')}.`;
}

/**
 * A status, drawn: a shape, a colour and a word.
 *
 * Colour alone is not a status — a third of the operator's friends could not
 * read it — so each state has its OWN SHAPE (`data-mark`, drawn in an inline
 * `<svg>` we own) and its own border style as well. `screens.css` colours it;
 * remove every colour from that file and this still reads.
 */
function StatusPill({
  kind,
  testId,
  state,
  mark,
  label,
  count,
}: {
  kind: 'legal' | 'ready';
  testId: string;
  state: 'yes' | 'no';
  mark: 'tick' | 'cross' | 'ring';
  label: string;
  count?: number;
}) {
  return (
    <span className={`pill pill--${kind}`} data-testid={testId} data-state={state} data-mark={mark}>
      <svg className="pill__mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {mark === 'tick' && <path d="M2.6 6.3 4.9 8.8 9.4 3.3" />}
        {mark === 'cross' && <path d="M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5" />}
        {mark === 'ring' && <circle cx="6" cy="6" r="3.4" />}
      </svg>
      {label}
      {count !== undefined && <span className="pill__count">{count}</span>}
    </span>
  );
}

/**
 * One seat at the table, as a row of cells.
 *
 * The operator, 2026-09-25, of the shape this replaces — a sentence with
 * middots for separators and `ready` as raw text: *"looks very cheap"*. So the
 * separators are gone (the cells are the separation), the two states are
 * `StatusPill`s, and the format is a cell of its own rather than a clause in
 * "legal in Standard (MBS)".
 *
 * The cells are laid out in named areas over two lines (`screens.css`): who
 * and the two states above, the deck and the format below. One line truncated
 * "Mystic Caw Go (Naoki Nakada)" to "My…" in the column this card actually
 * gets, which is the cheap look again by another route.
 *
 * The name and `(you)` stay in ONE text node, with that space: `e2e/play.spec`
 * matches `e2e-alice (you)`, and cells in a grid put no whitespace between
 * themselves.
 */
function PlayerRow({ seat, player }: { seat: number; player: RoomPlayer }) {
  return (
    <li className="tables__row" data-testid={`room-seat-${seat}`}>
      <strong className="tables__who">{player.you ? `${player.name} (you)` : player.name}</strong>
      <span className="tables__deck" data-testid={`room-seat-${seat}-deck`}>
        {player.deckName}
      </span>
      <span className="tables__rules" data-testid={`room-seat-${seat}-rules`}>
        {player.rulesName}
      </span>
      <StatusPill
        kind="legal"
        testId={`room-seat-${seat}-legal`}
        state={player.legal ? 'yes' : 'no'}
        mark={player.legal ? 'tick' : 'cross'}
        label={player.legal ? 'legal' : 'illegal'}
        {...(player.legal ? {} : { count: player.issueCount })}
      />
      <StatusPill
        kind="ready"
        testId={`room-seat-${seat}-ready`}
        state={player.ready ? 'yes' : 'no'}
        mark={player.ready ? 'tick' : 'ring'}
        label={player.ready ? 'ready' : 'not ready'}
      />
    </li>
  );
}

/**
 * Where the chosen deck came from — a link, and nothing else.
 *
 * This used to be three sentences: the provenance line (*"Transcribed from
 * mtgtop8 deck 209238."*), the citation buried mid-sentence, and the card
 * counts. The operator wanted all of it gone; the link stays because the
 * attribution is owed, and a link is not a sentence. The name is in the
 * dropdown, the counts are the server's to complain about, and the era is the
 * select above.
 */
function DeckSource({ deck }: { deck: TableDeck | undefined }) {
  if (deck === undefined) return null;
  return (
    <p className="lobby__note">
      <a className="shell__link" data-testid="deck-source" href={deck.citation} target="_blank" rel="noreferrer">
        source
      </a>
    </p>
  );
}

/** `#/play` with no room: the room list is where a match starts now. */
function NoRoom() {
  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title">Constructed</h1>
      </header>
      <main className="lobby">
        <section className="lobby__card">
          <p data-testid="constructed-pointer">Constructed is played in a room.</p>
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
