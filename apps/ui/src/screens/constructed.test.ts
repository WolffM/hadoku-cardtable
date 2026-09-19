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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ConstructedScreen } from './ConstructedScreen.tsx';
import { LobbyScreen } from './LobbyScreen.tsx';
import { parseRoute } from './route.ts';
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
  return { calls, table, client: tablesClient(fetchImpl, '/cardtable/api/') };
}

async function mountRoom(table: Table) {
  const server = stubServer(table);
  render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10 }));
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
    render(createElement(ConstructedScreen, { client: server.client }));
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
    expect(screen.getByTestId('ready-blocked').textContent).toContain('not legal in Standard (2011-07-01)');
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

  it('says so when the room is not there, or you are not in it', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    render(createElement(ConstructedScreen, { client: server.client, roomId: ROOM, pollMs: 10 }));
    expect((await screen.findByTestId('room-missing')).textContent).toContain('no such room');
    expect(screen.queryByTestId('deck-mine')).toBeNull();
  });

  it('tells a third person there is no seat, rather than a picker that cannot work', async () => {
    await mountRoom({ players: [opponent(), opponent({ name: 'user-carol', deckName: 'Mystic Caw Go (Ben Stark)' })], matchId: null });
    expect(screen.getByTestId('room-spectator').textContent).toContain('two players');
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
