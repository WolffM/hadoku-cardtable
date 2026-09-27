/*
 * A room, and what it plays: a constructed table, or a draft.
 *
 * The room screen is the only screen a room has. `constructed-1v1` is the table
 * below — YOUR deck, their state, and the match the server starts once both of
 * you are ready — and `draft` is a lobby with a readiness gate that becomes a
 * pod. Which one is drawn comes off the ROOM's own record (`rooms.get`), never
 * off the table.
 *
 * ## The draft branch, and why it is here rather than on a route of its own (w23)
 *
 * It used to be a route of its own: `#/draft/<id>`, a client-minted id, and a
 * server that dealt the draft the moment a socket connected. The operator, of
 * the button that opened it: *"old cruft that seems to auto-start with all
 * bots"*, and of what should happen instead: *"it should go to a room first and
 * only after everyone clicks ready should it actually start the draft"*. So
 * there is one door and one id. A room created with `gameType: 'draft'` shows:
 *
 *   `draftStartedAt === null`  the room's lobby — who is here, who is ready,
 *                              and a Ready toggle. No cards exist yet.
 *   `draftStartedAt !== null`  the pod (`PodScreen`), against the room's id.
 *
 * Every member ready is the gate, and either browser may ask the server to deal
 * — the same shape constructed's start already has, guarded by the same kind of
 * ref so a poll cannot ask twice.
 *
 * **A draft room does not touch the tables API.** `http/routes.ts` answers 409
 * to `PUT …/deck`, `POST …/ready` and the room start for anything that is not
 * `constructed-1v1`, so none of them is called and the formats, decks and
 * legality sweep are not loaded either. The table POLL still runs, because its
 * join-on-refusal (below) is what turns following an invite link into
 * membership, and a draft room needs that as much as a constructed one —
 * `GET /api/tables/rooms/:roomId` is the one table route that is not gated.
 *
 * ## Whose Ready toggle it is, which the wire does not say
 *
 * `RoomView.members` carries no `you`: a member's id is a hashed participant id
 * the browser cannot derive, and the display name is not unique (an unnamed key
 * is "friend"). The constructed table gets `you` because the SERVER computes it
 * (`routes.ts` `tableView`), and there is no equivalent on the room record. So
 * the toggle's own label is a latch set by the answer to our own `ready` call,
 * and the members list beside it is the room's authority on who is ready. The
 * cost is exact and small: reload mid-lobby while already ready and the button
 * reads "Ready" until you press it, which re-sends the readiness you already
 * had. Nothing about the room is ever mis-stated, and nothing starts early.
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
import { PodScreen } from './PodScreen.tsx';
import type { DraftTransport } from '../draft/socket.ts';
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
  /**
   * The draft pod's transport, threaded to `PodScreen` once a draft room has
   * started. Tests pass a stub; production passes nothing and gets socket.io.
   */
  makeTransport?: () => DraftTransport;
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
  makeTransport,
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
      makeTransport={makeTransport}
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
  makeTransport,
}: {
  client: TablesClient;
  roomId: string;
  pollMs: number;
  rooms?: RoomsClient;
  streamFetch?: Fetch;
  rand: () => number;
  makeTransport?: () => DraftTransport;
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
  /**
   * Your own readiness in a DRAFT room, as far as this browser knows it. The
   * room record says who is ready but not which member you are (see the header),
   * so this is the answer to our own `ready` call and nothing else.
   */
  const [iAmReady, setIAmReady] = useState(false);
  /** A refusal from `ready` or `start`, in the server's own words. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const [dealing, setDealing] = useState(false);
  /** A deal is in flight or was refused: not asked again on every poll. */
  const askedDeal = useRef(false);
  /** Bumped by Try again, which is the only thing that re-asks by hand. */
  const [dealAttempt, setDealAttempt] = useState(0);

  /**
   * The room's game type, live rather than latched.
   *
   * Unlike `clientMode` — fixed at create — the leader may change the game type
   * while the room is in its lobby, and the server refuses the change once a
   * draft has started (`PATCH /api/rooms/:id` → 409) and clears every ready flag
   * when it allows it. So the screen follows it; latching would leave the room
   * drawing the game it was created as.
   *
   * A room record that could not be read leaves this false, which draws the
   * constructed table — the same direction `parseRoomView` defaults in, and the
   * behaviour every room had before there was a draft branch.
   */
  const draftRoom = view?.gameType === 'draft';
  const draftStartedAt = view?.draftStartedAt ?? null;
  const members = view?.members ?? [];
  const allReady = members.length > 0 && members.every((m) => m.ready);

  // The formats and the decks — for a constructed table only. A draft room has
  // no deck to hold, and `routes.ts` refuses every table write it could make.
  //
  // NOT gated on the room record having answered. The catalogue read starts at
  // mount, as it always has, because holding it back until `rooms.get` answers
  // would put the deck picker a round trip later for EVERY constructed room to
  // save a draft room two cached GETs. What the guard does instead is discard
  // the answer: `draftRoom` flipping true re-runs this, the previous run's
  // cleanup clears `live`, and `loaded` stays null — so no picker is assembled
  // and the per-deck legality sweep (`picking`, below) never runs at all.
  useEffect(() => {
    if (draftRoom) return;
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
  }, [client, draftRoom]);

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
  //
  // **A draft room runs this too**, and that is the whole reason the poll is not
  // switched off for one: the join-on-refusal here is what makes an invite link
  // a membership, and a draft room's invite link is the only link there is. The
  // table it reads back is empty for a draft room — nobody loads a deck — but
  // `GET /api/tables/rooms/:roomId` is not game-type gated, so the read is a
  // real answer and the join is a real join.
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
  const picking =
    !streamed && !draftRoom && resolved && locked === null && table !== null && !spectating && loaded !== null;

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
  // A draft room never reaches this — it seats nobody at the table — and says so
  // explicitly, because `startRoom` is one of the calls `routes.ts` 409s for it.
  useEffect(() => {
    if (draftRoom || !bothReady || matchId !== null || mine === null || asked.current) return;
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
  }, [draftRoom, bothReady, matchId, mine, client, roomId]);

  /*
   * Every member ready: deal the draft.
   *
   * Either browser may ask and the server deals once — `startDraft` is
   * idempotent, so a room whose draft has already started answers with its view
   * rather than an error. The ref is what stops the 1.5 s poll asking again
   * while one ask is in flight or has been refused; losing unanimity clears it,
   * so the next time everyone is ready the draft is asked for again rather than
   * the room sitting on a stale refusal for ever.
   */
  useEffect(() => {
    if (!draftRoom || draftStartedAt !== null || locked !== null) return;
    if (!allReady) {
      askedDeal.current = false;
      return;
    }
    if (askedDeal.current) return;
    askedDeal.current = true;
    setDealing(true);
    rooms
      .start(roomId)
      .then((outcome) => {
        if (outcome.ok) {
          setView(outcome.room);
          setDraftError(null);
        } else {
          setDraftError(outcome.message);
        }
        setDealing(false);
      })
      .catch((err: unknown) => {
        setDraftError(err instanceof Error ? err.message : String(err));
        setDealing(false);
      });
  }, [draftRoom, draftStartedAt, locked, allReady, dealAttempt, rooms, roomId]);

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

  /**
   * Readiness in a DRAFT room, which is the room's own and not the table's.
   *
   * `POST /api/rooms/:id/ready`, not `POST /api/tables/rooms/:id/ready` — the
   * second answers 409 for anything that is not a constructed room, and it is
   * about a deck this room has nobody holding.
   */
  const setDraftReady = (ready: boolean): void => {
    setBusy(true);
    setDraftError(null);
    rooms
      .ready(roomId, ready)
      .then((outcome) => {
        if (!outcome.ok) {
          setDraftError(outcome.message);
          return;
        }
        setView(outcome.room);
        setIAmReady(ready);
      })
      .catch((err: unknown) => setDraftError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /*
   * The pod: the draft room's second phase, and the whole screen while it lasts.
   *
   * Not nested inside the room chrome below. The pod has a status bar of its own
   * carrying the room's id, the cube, the seats and the invite link, so putting
   * it inside `.lobby` — a grid of 300px cards — would squeeze the table it
   * draws and say the room's name twice. A locked room is asked for its password
   * first: the form for that is in the body below.
   */
  if (!streamed && draftRoom && draftStartedAt !== null && locked === null) {
    return <PodScreen draftId={roomId} makeTransport={makeTransport} />;
  }

  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title" data-testid="room-name">
          {streamed ? (view?.name ?? roomId) : (table?.room.name ?? roomId)}
        </h1>
        {/* The header states what this room is, so nobody who followed a link
            has to work it out from what is drawn below. A builtin constructed
            room says exactly what it has always said — that sentence already
            names our table. */}
        <p className="shell__sub" data-testid="room-client-mode">
          {streamed
            ? 'Forge’s full client'
            : draftRoom
              ? 'Draft'
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
        {/* The draft room's first phase. Nothing below this is drawn for it:
            there is no deck to hold, no seat at a constructed table, and every
            table write it could make is a 409. */}
        {locked === null && draftRoom && (
          <DraftLobby
            members={members}
            iAmReady={iAmReady}
            allReady={allReady}
            dealing={dealing}
            busy={busy}
            error={draftError}
            onReady={setDraftReady}
            onRetry={() => {
              askedDeal.current = false;
              setDraftError(null);
              setDealAttempt((n) => n + 1);
            }}
          />
        )}

        {!draftRoom && loadError !== null && (
          <p className="lobby__error" role="alert" data-testid="tables-load-error">
            Could not load the formats and decks: {loadError}
          </p>
        )}

        {!draftRoom && table !== null && (
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

/* ── a draft room, before the cards exist ─────────────────────────────── */

/**
 * The draft room's lobby: who is here, who is ready, and the two rules a person
 * would otherwise have to guess.
 *
 * Both rules are written on the screen on purpose. *"Every member ready, then
 * bots take the rest of the eight seats"* is the operator's own design and the
 * difference between this and the pod button it replaced, which auto-started
 * against seven bots. *"A draft does not survive a restart"* is true of the
 * server as built — the deal is in memory and `draftStartedAt` is never restored
 * — and a room that silently came back to an empty table would look like a bug
 * rather than the honest answer.
 *
 * The toggle carries `ready-toggle`, the same id the constructed table's does:
 * one room plays one game, so exactly one of the two is ever on the screen.
 *
 * Nothing here draws a mana symbol, a set symbol, a tap symbol or a card frame.
 */
function DraftLobby({
  members,
  iAmReady,
  allReady,
  dealing,
  busy,
  error,
  onReady,
  onRetry,
}: {
  members: RoomMember[];
  iAmReady: boolean;
  allReady: boolean;
  dealing: boolean;
  busy: boolean;
  error: string | null;
  onReady: (ready: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <section className="lobby__card" data-testid="draft-lobby">
      <h2>In the room</h2>
      <ul className="draft__members" data-testid="draft-members">
        {members.length === 0 ? (
          <li className="draft__member draft__member--empty" data-testid="draft-nobody">
            Nobody has joined yet.
          </li>
        ) : (
          members.map((member, i) => (
            <li key={member.id} className="draft__member" data-testid={`draft-member-${i}`}>
              <strong className="tables__who">{member.name}</strong>
              <StatusPill
                kind="ready"
                testId={`draft-member-${i}-ready`}
                state={member.ready ? 'yes' : 'no'}
                mark={member.ready ? 'tick' : 'ring'}
                label={member.ready ? 'ready' : 'not ready'}
              />
            </li>
          ))
        )}
      </ul>

      <p className="lobby__note" data-testid="draft-state">
        {draftStateText(members, dealing)}
      </p>

      <button
        type="button"
        className="lobby__go"
        data-testid="ready-toggle"
        aria-pressed={iAmReady}
        disabled={busy || dealing || members.length === 0}
        onClick={() => onReady(!iAmReady)}
      >
        {iAmReady ? 'Stand down' : 'Ready'}
      </button>

      {error !== null && (
        <div className="lobby__error" role="alert" data-testid="draft-error">
          <p>{error}</p>
          {/* Only while everyone still is ready: a refusal because somebody
              stood down between polls fixes itself when they ready again, and
              the deal is asked for on its own then. */}
          {allReady && (
            <button type="button" data-testid="draft-retry" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

      <p className="lobby__note" data-testid="draft-rule">
        The draft deals when every member of this room is ready. Bots take whatever is left of the eight
        seats at that moment — never before, so nobody who has not readied is played for.
      </p>
      <p className="lobby__note" data-testid="draft-restart-note">
        A draft does not survive a restart of the server. The room comes back to this lobby, with its ready
        marks, rather than to an empty table.
      </p>
    </section>
  );
}

/** Who the draft is waiting on, in one line. Names, because none of them is "you". */
function draftStateText(members: RoomMember[], dealing: boolean): string {
  if (dealing) return 'Dealing the draft…';
  if (members.length === 0) return 'Waiting for someone to join.';
  const waiting = members.filter((m) => !m.ready).map((m) => m.name);
  if (waiting.length === 0) return 'Everyone is ready.';
  return `Waiting for ${listOf(waiting)}.`;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
