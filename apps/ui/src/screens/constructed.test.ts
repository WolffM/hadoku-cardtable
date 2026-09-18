// @vitest-environment jsdom
/*
 * `#/play`, driven: pick a format, pick the decks, press Start — and when the
 * server refuses a deck, the screen names the card.
 *
 * The server here is a stub `fetch` that answers the way the real gate does.
 * The real gate is proven separately and end to end, against the real play
 * route and the committed library, in `apps/server/src/http/tables.test.ts`;
 * this file proves the other half — that what the gate says reaches the
 * person, and that what the person chose reaches the gate.
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
import { apiBase, tablesClient, type Fetch, type Verdict } from './tables.ts';

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

const DECKS = [
  deck('pt-paris-2011-1-ben-stark', 'Mystic Caw Go (Ben Stark)'),
  deck('pt-paris-2011-2-paul-rietzl', 'Boros Landfall (Paul Rietzl)'),
];

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

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A server that knows the two formats and answers like the real gate. */
function stubServer(start: { status: number; body: unknown }) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: Fetch = async (url, init) => {
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/tables/formats')) return json(200, { formats: FORMATS });
    if (url.endsWith('/tables/decks')) return json(200, { decks: DECKS });
    if (url.endsWith('/tables/check')) {
      const seat = body as { deck: { library: string }; rules: { format: string } };
      const name = DECKS.find((d) => d.id === seat.deck.library)?.name ?? '?';
      const format = FORMATS.find((f) => f.id === seat.rules.format);
      if (format?.id === '2011-07-01' && seat.deck.library === 'pt-paris-2011-1-ben-stark') return json(200, BANNED);
      return json(200, LEGAL(name, format?.name ?? '?'));
    }
    if (url.endsWith('/play/matches')) return json(start.status, start.body);
    return json(404, { error: 'not found' });
  };
  return { calls, client: tablesClient(fetchImpl, '/cardtable/api/') };
}

async function mount(start: { status: number; body: unknown }) {
  const server = stubServer(start);
  render(createElement(ConstructedScreen, { client: server.client }));
  await screen.findByTestId('format');
  return server;
}

describe('apiBase', () => {
  it('puts the API under the prefix the app is deployed at', () => {
    expect(apiBase('/cardtable/')).toBe('/cardtable/api/');
    expect(apiBase('/cardtable')).toBe('/cardtable/api/');
    expect(apiBase('/')).toBe('/api/');
    expect(apiBase('')).toBe('/api/');
  });
});

describe('ConstructedScreen', () => {
  it('shows the server’s verdict for the chosen format, naming each banned card', async () => {
    await mount({ status: 500, body: {} });
    await waitFor(() => expect(screen.getByTestId('verdict-0').textContent).toContain('Legal in Standard (MBS)'));

    fireEvent.change(screen.getByTestId('format'), { target: { value: '2011-07-01' } });
    await waitFor(() => expect(screen.getByTestId('verdict-0').textContent).toContain('Not legal'));
    const text = screen.getByTestId('verdict-0').textContent ?? '';
    expect(text).toContain('Jace, the Mind Sculptor');
    expect(text).toContain('Stoneforge Mystic');
    expect(screen.getByTestId('format-detail').textContent).toContain('Banned: Jace, the Mind Sculptor, Stoneforge Mystic.');
  });

  it('refuses to start with an illegal deck and names the card the server named', async () => {
    const refusal = {
      error: 'Seat 1\'s deck "Mystic Caw Go (Ben Stark)" is not legal in Standard (2011-07-01): plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans (and 1 more)',
      seats: [BANNED, LEGAL('Boros Landfall (Paul Rietzl)', 'Standard (2011-07-01)')],
    };
    const server = await mount({ status: 422, body: refusal });
    fireEvent.change(screen.getByTestId('format'), { target: { value: '2011-07-01' } });
    fireEvent.click(screen.getByTestId('opponent-ai'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-match'));
    });

    const refused = await screen.findByTestId('start-refused');
    expect(refused.textContent).toContain(refusal.error);
    expect(screen.getByTestId('refused-0').textContent).toContain('Jace, the Mind Sculptor');
    // Nowhere to go: still on this screen, not on a match.
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });

    // What was asked for is what the person chose, in the gate's shape.
    const post = server.calls.find((c) => c.url === '/cardtable/api/play/matches');
    expect(post).toEqual({
      url: '/cardtable/api/play/matches',
      method: 'POST',
      body: {
        opponent: 'ai',
        seats: [
          { deck: { library: 'pt-paris-2011-1-ben-stark' }, rules: { kind: 'standard', format: '2011-07-01' } },
          { deck: { library: 'pt-paris-2011-2-paul-rietzl' }, rules: { kind: 'standard', format: '2011-07-01' } },
        ],
      },
    });
  });

  it('goes to the match the server started', async () => {
    await mount({ status: 201, body: { matchId: 'm-0123456789ab', epoch: 'e', seats: [] } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-match'));
    });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: 'm-0123456789ab' }));
  });

  it('says so when the formats cannot be loaded, rather than rendering empty pickers', async () => {
    const fetchImpl: Fetch = async () => new Response('not found', { status: 404 });
    render(createElement(ConstructedScreen, { client: tablesClient(fetchImpl, '/cardtable/api/') }));
    const alert = await screen.findByTestId('tables-load-error');
    expect(alert.textContent).toContain('404');
  });
});

describe('the lobby reaches it', () => {
  it('has a way in from the front door', () => {
    render(createElement(LobbyScreen));
    fireEvent.click(screen.getByTestId('play-constructed'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'play' });
  });

  it('joins a match from the same box that joins a pod', () => {
    render(createElement(LobbyScreen));
    fireEvent.change(screen.getByTestId('join-id'), {
      target: { value: 'https://hadoku.me/cardtable/#/match/m-0123456789ab' },
    });
    fireEvent.submit(screen.getByTestId('join-id').closest('form') as HTMLFormElement);
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: 'm-0123456789ab' });
  });
});
