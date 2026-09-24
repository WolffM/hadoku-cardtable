// @vitest-environment jsdom
/*
 * A room's constructed table, driven: load YOUR deck, watch the other person,
 * ready up, and go to the match the server started.
 *
 * The server here is a stub `fetch` that answers the way the real room routes
 * do — including the two refusals that matter: an illegal deck cannot ready up,
 * and there is no call that names another member's deck. The real routes are
 * proven separately and end to end, against the real play route and the
 * committed library, in `apps/server/src/http/tables.test.ts`; this file proves
 * the other half — that what the server says reaches the person, and that what
 * the person chose reaches the server.
 *
 * The answers are real history, the same case the server test uses: Ben
 * Stark's PT Paris deck is legal in Standard (MBS) and banned out of Standard
 * as of 2011-07-01, for four Jace, the Mind Sculptor and four Stoneforge
 * Mystic.
 *
 * `.test.ts` + `createElement`, and the jsdom pragma on line 1, for the reasons
 * `lobby.test.ts` gives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ConstructedScreen } from './ConstructedScreen.tsx';
import { LobbyScreen } from './LobbyScreen.tsx';
import { parseRoute } from './route.ts';
import { roomsClient, type ClientMode, type RoomView } from '../rooms/api.ts';
import { apiBase, tablesClient, type Fetch, type RoomPlayer, type SeatChoice, type Verdict } from './tables.ts';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

const FORMATS = [
  { id: '2011-02-13', name: 'Standard (MBS)', effective: '2011-02-04', sets: ['ZEN', 'WWK', 'ROE', 'M11', 'SOM', 'MBS'], banned: [], cardCount: 1204, source: 'x' },
  {
    id: '2011-07-01',
    name: 'Standard (2011-07-01)',
    effective: '2011-07-01',
    sets: ['ZEN', 'WWK', 'ROE', 'M11', 'SOM', 'MBS', 'NPH'],
    banned: ['Jace, the Mind Sculptor', 'Stoneforge Mystic'],
    cardCount: 1377,
    source: 'x',
  },
];

const deck = (id: string, name: string) => ({
  id,
  collection: 'pt-paris-2011-standard',
  name,
  format: 'Standard (MBS)',
  date: '2011-02-13',
  provenance: `Pro Tour Paris 2011: ${name}`,
  citation: 'https://www.mtgtop8.com/event?e=1016&f=ST',
  main: [{ count: 60, name: 'Island' }],
  sideboard: [{ count: 15, name: 'Plains' }],
});

const BEN_STARK = 'pt-paris-2011-1-ben-stark';
const PAUL_RIETZL = 'pt-paris-2011-2-paul-rietzl';
const DECKS = [deck(BEN_STARK, 'Mystic Caw Go (Ben Stark)'), deck(PAUL_RIETZL, 'Boros Landfall (Paul Rietzl)')];

const LEGAL = (deckName: string, rulesName: string): Verdict => ({ deckName, rulesName, legal: true, issues: [], note: null });

const BANNED: Verdict = {
  deckName: 'Mystic Caw Go (Ben Stark)',
  rulesName: 'Standard (2011-07-01)',
  legal: false,
  issues: [
    { kind: 'banned', message: 'plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans', cardName: 'Jace, the Mind Sculptor', count: 4, limit: 0 },
    { kind: 'banned', message: 'plays 4x Stoneforge Mystic, which Standard (2011-07-01) bans', cardName: 'Stoneforge Mystic', count: 4, limit: 0 },
  ],
  note: 'deck "Mystic Caw Go (Ben Stark)" is built for "Standard (MBS)" as of 2011-02-13, but the pool supplied is "Standard (2011-07-01)"',
};

const REFUSAL =
  'Seat 1\'s deck "Mystic Caw Go (Ben Stark)" is not legal in Standard (2011-07-01): ' +
  'plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans (and 1 more)';

const ROOM = 'r-friday';
const MATCH = 'm-0123456789ab';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** The other player, already seated: what "waiting for the other person" is about. */
function opponent(over: Partial<RoomPlayer> = {}): RoomPlayer {
  return {
    seat: 0,
    name: 'user-bob',
    you: false,
    deckName: 'Boros Landfall (Paul Rietzl)',
    rulesName: 'Standard (MBS)',
    legal: true,
    issueCount: 0,
    ready: false,
    // Never sent for someone else — a draft verdict would name their pool.
    verdict: null,
    choice: null,
    ...over,
  };
}

interface Table {
  players: RoomPlayer[];
  matchId: string | null;
  /** What `GET /api/rooms/:id` says this room is. Absent ⇒ the field is not sent at all. */
  clientMode?: ClientMode;
  /** Who the ROOM says is in it — a streamed room's seats come from here. */
  members?: { id: string; name: string }[];
  /** The room record read fails, while the table read still works. */
  roomUnreadable?: boolean;
  /** 404 for both "no such room" and "you are not in it", as the server does. */
  missing?: boolean;
  /** A start the server refuses — e.g. the other player un-readied between polls. */
  refuseStart?: { status: number; error: string };
}

/**
 * A room server that holds state: loading a deck checks it, readying is
 * refused while it is illegal, and `{ room }` starts one match.
 */
function stubServer(table: Table) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const view = () => ({
    room: { id: ROOM, name: 'Friday night', gameType: 'constructed-1v1', matchId: table.matchId, seats: 2 },
    you: { player: table.players.some((p) => p.you) },
    players: table.players.map((p, seat) => ({ ...p, seat })),
  });
  /*
   * `GET /api/rooms/:id`, as `http/rooms.ts` answers it. `clientMode` is left
   * OUT of the body when the table does not set one, which is the shape a
   * server older than the field sends — the screen must read that as builtin.
   */
  const roomRecord = (): Record<string, unknown> => ({
    id: ROOM,
    name: 'Friday night',
    creator: 'user-alice',
    leader: 'user-alice',
    gameType: 'constructed-1v1',
    ...(table.clientMode === undefined ? {} : { clientMode: table.clientMode }),
    locked: false,
    members: (table.members ?? [{ id: 'p-alice', name: 'user-alice' }]).map((m) => ({ ...m, joinedAt: '' })),
    matchId: table.matchId,
    createdAt: '2026-09-19T00:00:00.000Z',
  });
  const verdictFor = (choice: SeatChoice): Verdict => {
    const id = 'library' in choice.deck ? choice.deck.library : '?';
    const name = DECKS.find((d) => d.id === id)?.name ?? '?';
    const format = FORMATS.find((f) => f.id === (choice.rules.kind === 'standard' ? choice.rules.format : ''));
    if (format?.id === '2011-07-01' && id === BEN_STARK) return BANNED;
    return LEGAL(name, format?.name ?? '?');
  };

  const fetchImpl: Fetch = async (url, init) => {
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith(`/api/rooms/${ROOM}`)) {
      return table.roomUnreadable === true ? json(503, { error: 'rooms are restarting' }) : json(200, roomRecord());
    }
    if (url.endsWith('/tables/formats')) return json(200, { formats: FORMATS });
    if (url.endsWith('/tables/decks')) return json(200, { decks: DECKS });
    if (table.missing === true && url.includes('/tables/rooms/')) return json(404, { error: 'no such room' });
    if (url.endsWith(`/tables/rooms/${ROOM}`)) return json(200, view());
    if (url.endsWith(`/tables/rooms/${ROOM}/deck`)) {
      const verdict = verdictFor(body as SeatChoice);
      const mine: RoomPlayer = {
        seat: 0,
        name: 'user-alice',
        you: true,
        deckName: verdict.deckName,
        rulesName: verdict.rulesName,
        legal: verdict.legal,
        issueCount: verdict.issues.length,
        ready: false,
        verdict,
        choice: body as SeatChoice,
      };
      const at = table.players.findIndex((p) => p.you);
      if (at === -1) table.players.push(mine);
      else table.players[at] = mine;
      return json(200, view());
    }
    if (url.endsWith(`/tables/rooms/${ROOM}/ready`)) {
      const mine = table.players.find((p) => p.you);
      if (mine === undefined) return json(409, { error: 'load a deck before you ready up' });
      const want = (body as { ready: boolean }).ready;
      if (want && !mine.legal) return json(422, { error: REFUSAL, verdict: mine.verdict });
      mine.ready = want;
      return json(200, view());
    }
    if (url.endsWith('/play/matches')) {
      const asked = body as { room?: string };
      if (typeof asked.room !== 'string') return json(422, { error: 'a match against a person starts from a room' });
      if (table.refuseStart !== undefined) return json(table.refuseStart.status, { error: table.refuseStart.error });
      table.matchId = MATCH;
      return json(201, { matchId: MATCH });
    }
    return json(404, { error: 'not found' });
  };
  return {
    calls,
    table,
    client: tablesClient(fetchImpl, '/cardtable/api/'),
    rooms: roomsClient(fetchImpl, '/cardtable/api/'),
  };
}

async function mountRoom(table: Table) {
  const server = stubServer(table);
  render(createElement(ConstructedScreen, { client: server.client, rooms: server.rooms, roomId: ROOM, pollMs: 10 }));
  await screen.findByTestId('room-players');
  return server;
}

const lastCall = (calls: Call[], path: string): Call | undefined => calls.filter((c) => c.url.endsWith(path)).at(-1);

describe('apiBase', () => {
  it('puts the API under the prefix the app is deployed at', () => {
    expect(apiBase('/cardtable/')).toBe('/cardtable/api/');
    expect(apiBase('/cardtable')).toBe('/cardtable/api/');
    expect(apiBase('/')).toBe('/api/');
    expect(apiBase('')).toBe('/api/');
  });
});

describe('the constructed screen without a room', () => {
  it('points back at the room list instead of picking two decks', async () => {
    const server = stubServer({ players: [], matchId: null });
    render(createElement(ConstructedScreen, { client: server.client, rooms: server.rooms }));
    expect((await screen.findByTestId('constructed-pointer')).textContent).toContain('played in a room');
    // The shape the operator rejected is not on the screen at all.
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.queryByTestId('format')).toBeNull();
    fireEvent.click(screen.getByTestId('to-rooms'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });
});

describe('a room’s table', () => {
  it('shows both players, and says who is being waited on', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    expect(screen.getByTestId('room-seat-0').textContent).toContain('user-bob');
    expect(screen.getByTestId('room-seat-0-legal').textContent).toContain('legal in Standard (MBS)');
    expect(screen.getByTestId('room-seat-0-ready').textContent).toBe('not ready');
    expect(screen.getByTestId('room-seat-1-empty')).toBeTruthy();
    expect(screen.getByTestId('start-state').textContent).toContain('Waiting for a second player');
  });

  it('loads YOUR deck only, and shows the server’s verdict for it', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null });
    fireEvent.change(screen.getByTestId('deck-mine'), { target: { value: PAUL_RIETZL } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('load-deck'));
    });

    const put = lastCall(server.calls, `/tables/rooms/${ROOM}/deck`);
    expect(put).toEqual({
      url: `/cardtable/api/tables/rooms/${ROOM}/deck`,
      method: 'PUT',
      // One deck, no seat number, and no field that could name another member.
      body: { deck: { library: PAUL_RIETZL }, rules: { kind: 'standard', format: '2011-02-13' } },
    });
    expect(screen.getByTestId('verdict-mine').textContent).toContain('Legal in Standard (MBS)');
    expect(screen.getByTestId('room-seat-1').textContent).toContain('(you)');
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an illegal deck blocks YOUR ready and names the card, and nobody else’s', async () => {
    const server = await mountRoom({ players: [opponent({ ready: true })], matchId: null });
    fireEvent.change(screen.getByTestId('format'), { target: { value: '2011-07-01' } });
    fireEvent.change(screen.getByTestId('deck-mine'), { target: { value: BEN_STARK } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('load-deck'));
    });

    const verdict = screen.getByTestId('verdict-mine').textContent ?? '';
    expect(verdict).toContain('Jace, the Mind Sculptor');
    expect(verdict).toContain('Stoneforge Mystic');
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('ready-blocked').textContent).toContain('Not legal in Standard (2011-07-01)');
    // The other player is untouched by it: still ready, still legal.
    expect(screen.getByTestId('room-seat-0-ready').textContent).toBe('ready');
    // And nothing was started.
    expect(lastCall(server.calls, '/play/matches')).toBeUndefined();
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });

  it('starts the match once both are ready, without either choosing the other’s deck', async () => {
    const server = await mountRoom({ players: [opponent({ ready: true })], matchId: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId('load-deck'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ready-toggle'));
    });

    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
    expect(lastCall(server.calls, '/tables/rooms/' + ROOM + '/ready')?.body).toEqual({ ready: true });
    // The start names the ROOM. The decks are the server's to assemble.
    expect(lastCall(server.calls, '/play/matches')).toEqual({
      url: '/cardtable/api/play/matches',
      method: 'POST',
      body: { room: ROOM },
    });
  });

  it('follows the match the OTHER player started, having pressed nothing', async () => {
    const server = await mountRoom({ players: [opponent({ ready: true })], matchId: null });
    // The other browser started it; this one learns from the poll.
    server.table.matchId = MATCH;
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
    expect(lastCall(server.calls, '/play/matches')).toBeUndefined();
  });

  /*
   * Entering a room joins it — and a refusal stops, it does not spam.
   *
   * Found in production 2026-09-19 on `r-8eb2a7cd614c`. The room list's Join
   * button was the ONLY caller of `join()`, so reaching a room any other way —
   * the invite link, a refresh, a bookmark, a second browser — left you a
   * non-member. The server answers a non-member exactly as it answers a
   * missing room (deliberately: a different answer tells an outsider which
   * rooms exist), so the screen said "this room is not there" about a room
   * that was, and re-asked on a 1.5 s timer forever. The operator's console
   * was a wall of 404s and the room file on disk held exactly one member.
   */
  function stubRooms(outcome: 'ok' | 'refused' | 'rate-limited') {
    const joins: string[] = [];
    const passwords: (string | undefined)[] = [];
    let secret: string | null = null;
    let reveal: (() => void) | null = null;
    const api = {
      joins,
      passwords,
      /** From here on, this password works — and joining reveals the room. */
      accept: (p: string, onJoin?: () => void) => {
        secret = p;
        reveal = onJoin ?? null;
      },
      client: {
        list: async () => [],
        // The room record: a locked room the caller is not in answers the same
        // 404 the table read does, so the mode stays unknown and the screen
        // renders the builtin table — which is what these tests then drive.
        get: async (): Promise<RoomView | null> => null,
        create: async () => ({ ok: false as const, message: 'not used' }),
        join: async (roomId: string, password?: string) => {
          joins.push(roomId);
          passwords.push(password);
          const ok = outcome === 'ok' || (secret !== null && password === secret);
          if (ok && reveal !== null) reveal();
          return ok
            ? {
                ok: true as const,
                room: {
                  id: roomId,
                  name: roomId,
                  creator: 'user-alice',
                  leader: 'user-alice',
                  gameType: 'constructed-1v1',
                  clientMode: 'builtin' as const,
                  locked: false,
                  members: [],
                  matchId: null,
                  createdAt: '2026-09-19T00:00:00.000Z',
                },
              }
            : { ok: false as const, reason: outcome };
        },
      },
    };
    return api;
  }

  it('joins the room it was opened on, so an invite link works without the room list', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('ok');
    render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10, rooms: rooms.client }));
    await waitFor(() => expect(rooms.joins).toEqual([ROOM]));
    // The read that followed the join is the one that matters: the screen
    // recovers rather than sitting on the refusal it started with.
    server.table.missing = false;
    await screen.findByTestId('room-players');
  });

  it('asks for the password instead of sending an invite link back to the list', async () => {
    // The operator's 2026-09-19 report: following a direct link to a room they
    // had a password for dead-ended on "go back and join it from the room
    // list". The link IS the way in; the screen has to ask.
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('refused');
    render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10, rooms: rooms.client }));
    expect((await screen.findByTestId('room-locked')).textContent).toContain('needs a password');
    expect(screen.queryByTestId('room-missing')).toBeNull();
  });

  it('retries with the password typed in, and gets in', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('refused');
    render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10, rooms: rooms.client }));
    await screen.findByTestId('room-locked');

    // The room becomes readable BECAUSE the join succeeded — setting it
    // readable up front would let the first read through and prove nothing.
    rooms.accept('hunter2', () => {
      server.table.missing = false;
    });
    fireEvent.change(screen.getByTestId('room-password'), { target: { value: 'hunter2' } });
    fireEvent.submit(screen.getByTestId('room-password-submit').closest('form') as HTMLFormElement);

    await screen.findByTestId('room-players');
    expect(rooms.passwords).toEqual([undefined, 'hunter2']);
  });

  it('says the password was wrong rather than repeating "needs a password"', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('refused');
    render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10, rooms: rooms.client }));
    await screen.findByTestId('room-locked');

    fireEvent.change(screen.getByTestId('room-password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByTestId('room-password-submit').closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByTestId('room-locked').textContent).toContain('Wrong password'));
  });

  it('stops after ONE refused join instead of re-asking on the timer', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('refused');
    render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10, rooms: rooms.client }));
    await screen.findByTestId('room-locked');

    const readsWhenRefused = server.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120)); // twelve poll intervals
    });
    expect(rooms.joins).toEqual([ROOM]);
    expect(server.calls.length).toBe(readsWhenRefused);
  });

  it('says to wait rather than retrying when the join is rate-limited', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('rate-limited');
    render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10, rooms: rooms.client }));
    expect((await screen.findByTestId('room-locked')).textContent).toContain('Too many attempts');
    expect(rooms.joins).toEqual([ROOM]);
  });

  it('tells a third person there is no seat, rather than a picker that cannot work', async () => {
    await mountRoom({ players: [opponent(), opponent({ name: 'user-carol', deckName: 'Mystic Caw Go (Ben Stark)' })], matchId: null });
    expect(screen.getByTestId('room-spectator').textContent).toContain('Table full');
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.getByTestId('room-seat-1').textContent).toContain('user-carol');
  });

  it('says when the server refuses the start, and asks again only when told to', async () => {
    const server = await mountRoom({
      players: [opponent({ ready: true })],
      matchId: null,
      refuseStart: { status: 409, error: 'user-bob is not ready yet' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('load-deck'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ready-toggle'));
    });

    const refused = await screen.findByTestId('start-refused');
    expect(refused.textContent).toContain('user-bob is not ready yet');
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
    // One attempt, not one per poll.
    const attempts = () => server.calls.filter((c) => c.url.endsWith('/play/matches')).length;
    const once = attempts();
    await new Promise((r) => setTimeout(r, 60));
    expect(attempts()).toBe(once);

    // Told to, it asks again — and this time the server starts it.
    server.table.refuseStart = undefined;
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-retry'));
    });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
  });
});

describe('the lobby reaches a match', () => {
  it('joins a match from the same box that joins a pod', () => {
    render(createElement(LobbyScreen));
    fireEvent.change(screen.getByTestId('join-id'), {
      target: { value: 'https://hadoku.me/cardtable/#/match/m-0123456789ab' },
    });
    fireEvent.submit(screen.getByTestId('join-id').closest('form') as HTMLFormElement);
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: 'm-0123456789ab' });
  });
});

/* ── the two clients (D19a) ──────────────────────────────────────────── */

describe('a streamed room', () => {
  /** Mounts a room whose stream route answers however `stream` says. */
  async function mountStreamed(table: Table, stream: Fetch) {
    const server = stubServer({ clientMode: 'streamed', ...table });
    render(
      createElement(ConstructedScreen, {
        client: server.client,
        rooms: server.rooms,
        roomId: ROOM,
        pollMs: 10,
        streamFetch: stream,
      }),
    );
    await screen.findByTestId('room-streams');
    return server;
  }

  /** What the server really answers with no containers: its own SPA, HTTP 200. */
  const noContainers: Fetch = async () =>
    new Response('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { status: 200 });
  const container: Fetch = async () => new Response('<!DOCTYPE html><title>noVNC</title>', { status: 200 });

  it('gives every member their own seat, and says the stream is not there rather than spinning', async () => {
    await mountStreamed(
      {
        players: [],
        matchId: null,
        members: [
          { id: 'p-alice', name: 'user-alice' },
          { id: 'p-bob', name: 'user-bob' },
        ],
      },
      noContainers,
    );

    const seats = screen.getAllByTestId('stream-seat');
    expect(seats).toHaveLength(2);
    expect(seats.map((s) => s.getAttribute('data-seat'))).toEqual(['0', '1']);
    expect(seats.map((s) => within(s).getByTestId('stream-seat-who').textContent)).toEqual([
      'user-alice',
      'user-bob',
    ]);

    // A 200 that is our own page is NOT a stream: the seat says so in words.
    await waitFor(() => expect(screen.getAllByTestId('stream-waiting')).toHaveLength(2));
    expect(screen.getAllByTestId('stream-waiting')[0].textContent).toContain('No screen yet');
    expect(screen.queryByTestId('stream-frame')).toBeNull();

    // And none of the builtin table is on the screen: there is no deck here.
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.queryByTestId('format')).toBeNull();
    expect(screen.queryByTestId('ready-toggle')).toBeNull();
    expect(screen.queryByTestId('room-players')).toBeNull();
  });

  it('frames a seat that IS up, same-origin, at the room-keyed stream path', async () => {
    await mountStreamed(
      { players: [], matchId: null, members: [{ id: 'p-alice', name: 'user-alice' }] },
      container,
    );
    const frame = (await screen.findByTestId('stream-frame')) as HTMLIFrameElement;
    // `BASE_URL` is `/` under vitest; the deploy-prefix arithmetic is
    // `streamPath`'s own test in `rooms/rooms.test.ts`.
    // **vnc.html, not the seat's root.** websockify answers the root with a
    // directory listing, so a seat pointed there framed a file index and never
    // connected — a black screen behind a healthy container. This assertion
    // used to pin that root, which is how it shipped. See `streamPath`.
    const src = frame.getAttribute('src') ?? '';
    expect(src.startsWith(`/stream/${ROOM}/0/vnc.html?`)).toBe(true);
    // noVNC needs to be told where its websocket is, relative to the origin,
    // and to connect without a human pressing Connect first.
    expect(src).toContain(`path=${encodeURIComponent(`stream/${ROOM}/0/websockify`)}`);
    expect(src).toContain('autoconnect=true');
    // Same-origin by construction: a path, never a host.
    expect(src.startsWith('/')).toBe(true);
    expect(src).not.toContain('//');
    expect(screen.queryByTestId('stream-waiting')).toBeNull();
  });

  it('says so when the room is empty instead of drawing nothing', async () => {
    await mountStreamed({ players: [], matchId: null, members: [] }, noContainers);
    expect(screen.getByTestId('stream-nobody').textContent).toContain('Nobody has joined yet');
    expect(screen.queryByTestId('stream-seat')).toBeNull();
  });

  it('states the mode in the header, so a link does not land you somewhere unexplained', async () => {
    await mountStreamed({ players: [], matchId: null, members: [] }, noContainers);
    expect(screen.getByTestId('room-client-mode').textContent).toContain('Forge’s full client');
    expect(screen.getByTestId('room-name').textContent).toBe('Friday night');
  });
});

describe('a builtin room is what it has always been', () => {
  it('says the same sentence in its header, and draws no stream anywhere', async () => {
    await mountRoom({ players: [opponent()], matchId: null, clientMode: 'builtin' });
    expect(screen.getByTestId('room-client-mode').textContent).toBe('Constructed 1v1');
    expect(screen.queryByTestId('room-streams')).toBeNull();
    expect(screen.queryByTestId('stream-seat')).toBeNull();
    expect(screen.getByTestId('deck-mine')).toBeTruthy();
  });

  it('is what a server that never heard of the field gets: no clientMode, still our table', async () => {
    // `mountRoom`'s default table sets no `clientMode`, so the body omits the
    // field entirely — the older-server case, which must not render streamed.
    await mountRoom({ players: [opponent()], matchId: null });
    expect(screen.queryByTestId('room-streams')).toBeNull();
    expect(screen.getByTestId('deck-mine')).toBeTruthy();
  });

  it('still renders when the room record cannot be read at all', async () => {
    // The room read failing must not hide the table: it is the same server the
    // table poll is reading, and that poll reports the outage in words.
    await mountRoom({ players: [opponent()], matchId: null, roomUnreadable: true });
    expect(screen.getByTestId('deck-mine')).toBeTruthy();
    expect(screen.queryByTestId('room-streams')).toBeNull();
  });
});
