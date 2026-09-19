// @vitest-environment jsdom
/*
 * `#/deck/<draftId>`, driven: a finished pool arrives over the draft socket,
 * the drafter builds 40 cards out of it with basics, and Start posts the gate's
 * draft arm — the deck's own `.dck` text, checked against the caller's pool.
 *
 * The socket is the stub `lobby.test.ts` uses and the API is a stub `fetch`
 * that answers the way the real gate does, so this proves the browser half:
 * what the drafter built is what reaches the gate, byte for byte, and what the
 * gate says reaches the drafter, card named. The gate itself — that the server
 * refuses a drafted deck no matter what a client sends — is proven against the
 * real route in `apps/server/src/http/tables.test.ts`.
 *
 * The pool is 45 cards off the committed cube (`draft/pool.json`), not an
 * invented one. `.test.ts` + `createElement` and the jsdom pragma on line 1 for
 * the reasons `screens/lobby.test.ts` gives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DRAFT_CHANNEL, stateMessage, type DraftCard, type DraftView } from '@hadoku/shared';
import { parseDck } from '@hadoku/carddata/dck';
import { basicLand, cardKey, deckFromDeckFile, moveToMain, setBasicLand } from '@hadoku/deck';

import poolData from '../draft/pool.json';
import { deckFromPool, dckTextOf } from '../draft/deckFromPool.ts';
import { loadFixtures } from '../draft/fixtures.ts';
import type { DraftTransport } from '../draft/socket.ts';
import { DeckScreen } from '../screens/DeckScreen.tsx';
import { parseRoute } from '../screens/route.ts';
import { tablesClient, type Fetch, type Verdict } from '../screens/tables.ts';
import { draftedSeat, librarySeat, mainSummary, cardIndex, poolReadiness, sortPile } from './build.ts';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

const DRAFT_ID = 'amber-lantern-k7q4';

/** 45 cube cards, as a seat's finished pool: pack 1's first 15 of three colours and so on. */
const POOL: DraftCard[] = (poolData as { cards: DraftCard[] }).cards
  .slice(0, 45)
  .map((card, i) => ({ ...card, cardId: `draft:${DRAFT_ID}/p${i}` }));

const OPENING = loadFixtures()[0] as DraftView;

function seatView(pool: DraftCard[]): DraftView {
  const viewer = OPENING.viewer;
  if (viewer.kind !== 'seat') throw new Error('the opening fixture is a seat view');
  return {
    ...OPENING,
    draftId: DRAFT_ID,
    seq: OPENING.seq + 100,
    // The schema holds a seat's pool to its public pick count.
    seats: OPENING.seats.map((s) => (s.id === viewer.seatId ? { ...s, pickedCount: pool.length } : s)),
    viewer: { ...viewer, pack: [], pool },
  };
}

/* ── the stub socket ─────────────────────────────────────────────────── */

function makeSocket() {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const sent: unknown[] = [];
  return {
    sent,
    fire(event: string, payload?: unknown) {
      act(() => {
        for (const h of handlers.get(event) ?? []) h(payload);
      });
    },
    make: (): DraftTransport => ({
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      emit(_event, message) {
        sent.push(message);
      },
      disconnect() {},
    }),
  };
}

/* ── the stub API ────────────────────────────────────────────────────── */

const FORMATS = [
  { id: '2011-02-13', name: 'Standard (MBS)', effective: '2011-02-04', sets: ['SOM', 'MBS'], banned: [], cardCount: 1204, source: 'x' },
];
const DECKS = [
  {
    id: 'pt-paris-2011-2-paul-rietzl',
    collection: 'pt-paris-2011-standard',
    name: 'Boros Landfall (Paul Rietzl)',
    format: 'Standard (MBS)',
    date: '2011-02-13',
    provenance: 'Pro Tour Paris 2011: Boros Landfall (Paul Rietzl)',
    citation: 'https://www.mtgtop8.com/event?e=1016&f=ST',
    main: [{ count: 60, name: 'Mountain' }],
    sideboard: [],
  },
];

interface Call {
  url: string;
  body: unknown;
}

function stubApi(answers: { check: (body: { deck: { dck: string } }) => Verdict; start: { status: number; body: unknown } }) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: Fetch = async (url, init) => {
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url.endsWith('/tables/formats')) return json(200, { formats: FORMATS });
    if (url.endsWith('/tables/decks')) return json(200, { decks: DECKS });
    if (url.endsWith('/tables/check')) return json(200, answers.check(body as { deck: { dck: string } }));
    if (url.endsWith('/play/matches')) return json(answers.start.status, answers.start.body);
    return json(404, { error: 'not found' });
  };
  return { calls, client: tablesClient(fetchImpl, '/cardtable/api/') };
}

const RULES = `your pool from ${DRAFT_ID}`;
const legal: Verdict = { deckName: `Cube draft ${DRAFT_ID}`, rulesName: RULES, legal: true, issues: [], note: null };
/** What the real gate says about a short deck: the size, with no card to name. */
function shortVerdict(size: number): Verdict {
  return {
    ...legal,
    legal: false,
    issues: [{ kind: 'under-minimum-size', message: `maindeck has ${size} cards, needs at least 40`, cardName: null, count: size, limit: 40 }],
  };
}

async function mount(api: ReturnType<typeof stubApi>) {
  const socket = makeSocket();
  render(createElement(DeckScreen, { draftId: DRAFT_ID, makeTransport: socket.make, client: api.client, checkDelayMs: 0 }));
  return socket;
}

async function mountReady(api: ReturnType<typeof stubApi>) {
  const socket = await mount(api);
  socket.fire(DRAFT_CHANNEL.serverToClient, stateMessage(seatView(POOL), { name: 'Test Cube', size: 540 }));
  await screen.findByTestId('deck-builder');
  await screen.findByTestId('opponent-deck');
  return socket;
}

function rowsIn(testId: string): HTMLElement[] {
  return within(screen.getByTestId(testId)).queryAllByTestId('deck-row');
}

/** Promote `n` cards, one click each, the way a person does. */
function promote(n: number): void {
  for (let i = 0; i < n; i += 1) fireEvent.click(rowsIn('side-list')[0] as HTMLElement);
}

const lastPost = (calls: Call[], path: string) => [...calls].reverse().find((c) => c.url === `/cardtable/api/${path}`);

/* ── the pure half ───────────────────────────────────────────────────── */

describe('build.ts', () => {
  it('a drafted seat is the gate’s draft arm, carrying the deck’s own .dck text', () => {
    let deck = deckFromPool(DRAFT_ID, POOL);
    deck = moveToMain(deck, deck.sideboard[0]!.card);
    deck = setBasicLand(deck, basicLand('Island'), 17);
    const seat = draftedSeat(DRAFT_ID, deck);
    expect(seat).toEqual({ deck: { dck: dckTextOf(deck) }, rules: { kind: 'draft', draftId: DRAFT_ID } });
    // The text is what the server parses: 18 cards in its main, basics included.
    const back = deckFromDeckFile(parseDck(dckTextOf(deck)));
    expect(back.main.reduce((n, e) => n + e.count, 0)).toBe(18);
    expect(back.main.find((e) => e.card.name === 'Island')?.count).toBe(17);
  });

  it('seats a library opponent in the Standard it was played in', () => {
    const d = DECKS[0]!;
    expect(librarySeat(d, FORMATS)).toEqual({ deck: { library: d.id }, rules: { kind: 'standard', format: '2011-02-13' } });
    const later = [...FORMATS, { ...FORMATS[0]!, id: '2012-10-05' }];
    expect(librarySeat({ ...d, date: '1999-01-01' }, later).rules).toEqual({ kind: 'standard', format: '2012-10-05' });
  });

  it('knows a finished pool from an unfinished one and from a spectator', () => {
    expect(poolReadiness(null)).toEqual({ kind: 'joining' });
    expect(poolReadiness({ ...seatView(POOL), viewer: { kind: 'spectator' } })).toEqual({ kind: 'spectator' });
    expect(poolReadiness(seatView(POOL.slice(0, 20)))).toEqual({ kind: 'unfinished', picked: 20, total: 45 });
    expect(poolReadiness(seatView(POOL))).toEqual({ kind: 'ready', pool: POOL });
  });

  it('orders a pile by mana value with lands last, and counts what the maindeck asks for', () => {
    const index = cardIndex(POOL);
    let deck = deckFromPool(DRAFT_ID, POOL);
    const sorted = sortPile(deck.sideboard, index);
    const cards = sorted.map((e) => index.get(cardKey(e.card)));
    expect(cards.every((c) => c !== undefined)).toBe(true);
    const isLand = (c: DraftCard | undefined) => /\bLand\b/.test(c?.typeLine ?? '');
    const firstLand = cards.findIndex(isLand);
    const spells = firstLand === -1 ? cards : cards.slice(0, firstLand);
    expect(cards.slice(spells.length).every(isLand)).toBe(true);
    const values = spells.map((c) => c?.manaValue ?? 0);
    expect(values).toEqual([...values].sort((a, b) => a - b));

    deck = moveToMain(deck, deck.sideboard[0]!.card);
    deck = setBasicLand(deck, basicLand('Plains'), 3);
    const summary = mainSummary(deck, index);
    expect(summary.lands).toBeGreaterThanOrEqual(3);
    expect(summary.creatures + summary.spells + summary.lands).toBe(4);
  });
});

/* ── the screen ──────────────────────────────────────────────────────── */

describe('DeckScreen', () => {
  it('joins the pod for the pool, and says so while the draft is unfinished', async () => {
    const api = stubApi({ check: () => legal, start: { status: 500, body: {} } });
    const socket = await mount(api);
    expect(screen.getByTestId('deck-joining')).toBeTruthy();
    expect(socket.sent).toEqual([{ type: 'join', draftId: DRAFT_ID }]);

    socket.fire(DRAFT_CHANNEL.serverToClient, stateMessage(seatView(POOL.slice(0, 30)), { name: 'Test Cube', size: 540 }));
    expect((await screen.findByTestId('deck-unfinished')).textContent).toContain('30 of 45');
    fireEvent.click(screen.getByTestId('back-to-pod'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'draft', draftId: DRAFT_ID });
  });

  it('opens with the whole pool in the sideboard and nothing played', async () => {
    const api = stubApi({ check: (b) => shortVerdict(deckFromDeckFile(parseDck(b.deck.dck)).main.length), start: { status: 500, body: {} } });
    await mountReady(api);
    expect(screen.getByTestId('main-count').textContent).toBe('0');
    expect(screen.getByTestId('side-count').textContent).toBe('45');
    expect(rowsIn('main-list')).toHaveLength(0);
    // The server was asked, and its answer is on screen.
    expect((await screen.findByTestId('deck-verdict')).textContent).toContain('maindeck has 0 cards, needs at least 40');
  });

  it('builds 23 drafted cards and 17 basics into a 40-card deck, and checks exactly that text', async () => {
    const api = stubApi({ check: () => legal, start: { status: 500, body: {} } });
    await mountReady(api);

    promote(23);
    for (let i = 0; i < 9; i += 1) fireEvent.click(screen.getByTestId('basic-Island-more'));
    for (let i = 0; i < 8; i += 1) fireEvent.click(screen.getByTestId('basic-Mountain-more'));
    fireEvent.click(screen.getByTestId('basic-Mountain-less'));
    fireEvent.click(screen.getByTestId('basic-Mountain-more'));

    expect(screen.getByTestId('main-count').textContent).toBe('40');
    expect(screen.getByTestId('side-count').textContent).toBe('22');
    expect(screen.getByTestId('basic-Island-count').textContent).toBe('9');
    expect(screen.getByTestId('basic-Mountain-count').textContent).toBe('8');

    await waitFor(() => expect(screen.getByTestId('deck-verdict').textContent).toContain('legal against'));
    const check = lastPost(api.calls, 'tables/check')?.body as { deck: { dck: string }; rules: unknown };
    expect(check.rules).toEqual({ kind: 'draft', draftId: DRAFT_ID });
    const deck = deckFromDeckFile(parseDck(check.deck.dck));
    expect(deck.main.reduce((n, e) => n + e.count, 0)).toBe(40);
    expect(deck.main.find((e) => e.card.name === 'Island')?.count).toBe(9);
    expect(deck.sideboard.reduce((n, e) => n + e.count, 0)).toBe(22);
  });

  it('starts the match through the gate with the text it checked, and goes to it', async () => {
    const api = stubApi({ check: () => legal, start: { status: 201, body: { matchId: 'm-0123456789ab', epoch: 'e', seats: [] } } });
    await mountReady(api);
    promote(40);
    await waitFor(() => expect(screen.getByTestId('deck-verdict').textContent).toContain('legal against'));
    const checked = (lastPost(api.calls, 'tables/check')?.body as { deck: { dck: string } }).deck.dck;

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-match'));
    });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: 'm-0123456789ab' }));
    expect(lastPost(api.calls, 'play/matches')?.body).toEqual({
      opponent: 'ai',
      seats: [
        { deck: { dck: checked }, rules: { kind: 'draft', draftId: DRAFT_ID } },
        { deck: { library: 'pt-paris-2011-2-paul-rietzl' }, rules: { kind: 'standard', format: '2011-02-13' } },
      ],
    });
  });

  it('does not stop a short deck itself: it sends it, and shows the server’s refusal with the card named', async () => {
    // The server's 422, in the gate's words (`gate.ts` `refusalLine`): a card
    // the pool does not hold, named, leads over the size.
    const refusal = {
      error: `Seat 1's deck "Cube draft ${DRAFT_ID}" is not legal in ${RULES}: plays 1x Black Lotus but drafted 0 (and 1 more)`,
      seats: [
        {
          ...legal,
          legal: false,
          issues: [
            { kind: 'under-minimum-size', message: 'maindeck has 11 cards, needs at least 40', cardName: null, count: 11, limit: 40 },
            { kind: 'more-copies-than-drafted', message: 'plays 1x Black Lotus but drafted 0', cardName: 'Black Lotus', count: 1, limit: 0 },
          ],
        },
        { deckName: 'Boros Landfall (Paul Rietzl)', rulesName: 'Standard (MBS)', legal: true, issues: [], note: null },
      ],
    };
    const api = stubApi({ check: () => shortVerdict(10), start: { status: 422, body: refusal } });
    await mountReady(api);
    promote(10);
    await waitFor(() => expect(screen.getByTestId('deck-verdict').textContent).toContain('maindeck has 10 cards'));

    const button = screen.getByTestId('start-match') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });

    const refused = await screen.findByTestId('start-refused');
    expect(refused.textContent).toContain(refusal.error);
    expect(screen.getByTestId('refused-0').textContent).toContain('Black Lotus');
    // The short deck went to the gate: the client did not decide for it.
    const post = lastPost(api.calls, 'play/matches')?.body as { seats: { deck: { dck: string } }[] };
    expect(deckFromDeckFile(parseDck(post.seats[0]!.deck.dck)).main.reduce((n, e) => n + e.count, 0)).toBe(10);
    // Still here, not on a match.
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });

  it('a spectator is told there is no pool to build from', async () => {
    const api = stubApi({ check: () => legal, start: { status: 500, body: {} } });
    const socket = await mount(api);
    socket.fire(DRAFT_CHANNEL.serverToClient, stateMessage({ ...seatView(POOL), viewer: { kind: 'spectator' } }, { name: 'Test Cube', size: 540 }));
    expect((await screen.findByTestId('deck-spectator')).textContent).toContain('no seat');
  });
});
