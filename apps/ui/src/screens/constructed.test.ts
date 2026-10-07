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
 * The answers are real history, the same case the server test uses: 2010's UG
 * Polymorph (Antoine Ruel) is legal in Standard (M11) and banned out of
 * Standard as of 2011-07-15, for four Jace, the Mind Sculptor.
 *
 * ## And the room's OTHER game (w23)
 *
 * The same screen renders a draft room: a lobby with a readiness gate, then the
 * pod. Those tests are `describe('a draft room')` below, and they are the proof
 * of the gate — nothing is dealt until every member is ready, and the draft is
 * asked for exactly once when they are. The constructed suites above are the
 * proof of the other half: `constructed-1v1` does not change, so not one of
 * their assertions moved to make room for the branch.
 *
 * `.test.ts` + `createElement`, and the jsdom pragma on line 1, for the reasons
 * `lobby.test.ts` gives.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DRAFT_CHANNEL, stateMessage, type DraftCard, type DraftView } from '@hadoku/shared';
import { parseDck } from '@hadoku/carddata/dck';
import { BASIC_LAND_NAMES, deckFromDeckFile, mainDeckSize } from '@hadoku/deck';
import {
  LIBRARY,
  LIBRARY_CARD_COSTS,
  deckPath,
  poolFixturePath,
  type LibraryCollection,
} from '@hadoku/deck/library';

import {
  ConstructedScreen,
  DRAFTED_BASICS,
  DRAFTED_DECK,
  draftedDeckOf,
  erasOf,
  groupSetsByBlock,
  manaValueOf,
  poolIsOnTab,
} from './ConstructedScreen.tsx';
import { deckColorsByName } from '../components/DeckView.tsx';
import { ALLOWED_ART_HOSTS } from '@hadoku/carddata/art';
import ART_IDS from '../draft/art-ids.json';
import { cardImageUrl } from '../draft/cardImage.ts';
import { parseRoute } from './route.ts';
import poolJson from '../draft/pool.json';
import { dckTextOf } from '../draft/deckFromPool.ts';
import { loadFixtures } from '../draft/fixtures.ts';
import type { DraftTransport } from '../draft/socket.ts';
import { roomsClient, type ClientMode, type RoomView } from '../rooms/api.ts';
import {
  RANDOM_DECK,
  apiBase,
  tablesClient,
  type DeckRef,
  type Fetch,
  type RoomPlayer,
  type SeatChoice,
  type TableDeck,
  type TableFormat,
  type Verdict,
} from './tables.ts';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

/**
 * The stylesheet itself, so "colour is not the only signal" can be asserted:
 * jsdom lays nothing out and computes no cascade, and the rule that carries
 * the second signal is a declaration, not a geometry.
 */
const SCREENS_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/screens', 'screens.css'), 'utf8');

/**
 * Real cross-era history, the way `apps/server/src/http/tables.test.ts` and
 * `packages/deck/src/library/library.test.ts` both use it: 2010's UG Polymorph
 * (Antoine Ruel) plays four Jace, the Mind Sculptor, legal in its own era
 * (`Standard (M11)`, 2010-07-16) and banned the moment `Standard (M12)`
 * (2011-07-15) takes effect. This file stubs the SERVER's answer rather than
 * asking the real gate for it (that proof is the other two files' job), so the
 * banned verdict below states only the ban itself and leaves out the two
 * rotation faults the real gate also reports for this exact pairing — the
 * point here is how the SCREEN shows a banned deck, not how many faults it has.
 */
// `sets` below is trimmed to the three blocks "the era's set symbols" groups,
// not the era's full real set list (2010-07-16's real pool also carries ALA,
// CFX, ARB and M10 — `decks/pools/standard-2010-07-16.generated.json`) — this
// mock is reused by that section purely for its block-grouping shape, which
// is unaffected by trimming a mock field nothing here reads for legality.
const FORMATS = [
  { id: '2010-07-16', name: 'Standard (M11)', effective: '2010-07-16', sets: ['ZEN', 'WWK', 'ROE', 'M11', 'SOM', 'MBS'], banned: [], cardCount: 1477, source: 'x', family: 'standard' as const },
  {
    id: '2011-07-15',
    name: 'Standard (M12)',
    effective: '2011-07-15',
    sets: ['ZEN', 'WWK', 'ROE', 'M11', 'SOM', 'MBS', 'NPH'],
    banned: ['Jace, the Mind Sculptor', 'Stoneforge Mystic'],
    cardCount: 1511,
    source: 'x',
    family: 'standard' as const,
  },
];

const deck = (id: string, name: string) => ({
  id,
  collection: 'power-summer-2010',
  name,
  format: 'Standard (M11)',
  date: '2010-07-16',
  provenance: `Championnat de France 2010: ${name}`,
  citation: 'https://www.mtgtop8.com/event?e=459&f=ST',
  main: [{ count: 60, name: 'Island' }],
  sideboard: [{ count: 15, name: 'Plains' }],
});

const UG_POLYMORPH = 'power-2010-3-antoine-ruel-ug-polymorph';
const SECOND_DECK = 'power-2010-1-emanuele-giusti-jund';
const DECKS = [deck(UG_POLYMORPH, 'UG Polymorph (Antoine Ruel)'), deck(SECOND_DECK, 'Jund (Emanuele Giusti)')];

const LEGAL = (deckName: string, rulesName: string): Verdict => ({ deckName, rulesName, legal: true, issues: [], note: null });

const BANNED: Verdict = {
  deckName: 'UG Polymorph (Antoine Ruel)',
  rulesName: 'Standard (M12)',
  legal: false,
  issues: [
    { kind: 'banned', message: 'plays 4x Jace, the Mind Sculptor, which Standard (M12) bans', cardName: 'Jace, the Mind Sculptor', count: 4, limit: 0 },
  ],
  note: 'deck "UG Polymorph (Antoine Ruel)" is built for "Standard (M11)" as of 2010-07-16, but the pool supplied is "Standard (M12)"',
};

const REFUSAL =
  'Seat 1\'s deck "UG Polymorph (Antoine Ruel)" is not legal in Standard (M12): ' +
  'plays 4x Jace, the Mind Sculptor, which Standard (M12) bans';

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
    deckName: 'Jund (Emanuele Giusti)',
    rulesName: 'Standard (M11)',
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
  /**
   * The pool the ROOM is on. Absent ⇒ the oldest of the two above, which keeps
   * both decks legal for the suites that are about something else.
   *
   * Deliberately NOT the newest: that a fresh room DEFAULTS to the newest pool
   * is the server's behaviour and `apps/server`'s test's to prove. What this
   * file proves is that the screen reads whatever the room says, plus its own
   * fallback when the room says nothing — see "the newest pool" below.
   */
  format?: string;
  /** Whether the CALLER is the leader. Absent ⇒ true: alice made the room. */
  leader?: boolean;
  /** `PATCH /api/rooms/:id` refuses with this, as it does for a non-leader. */
  refusePatch?: { status: number; error: string };
  /** What `GET /api/rooms/:id` says this room is. Absent ⇒ the field is not sent at all. */
  clientMode?: ClientMode;
  /** What the room PLAYS. Absent ⇒ `constructed-1v1`, which is every test above. */
  gameType?: string;
  /** Set once the server has dealt a draft room's pod. */
  draftStartedAt?: string | null;
  /** Who the ROOM says is in it — a streamed room's seats come from here. */
  members?: { id: string; name: string; ready?: boolean }[];
  /** `POST /api/rooms/:id/ready` and `…/start` refuse with this sentence. */
  refuseRoomWrite?: { status: number; error: string };
  /** The room record read fails, while the table read still works. */
  roomUnreadable?: boolean;
  /** 404 for both "no such room" and "you are not in it", as the server does. */
  missing?: boolean;
  /** The gate refuses, so the era's legality sweep cannot answer. */
  checkFails?: boolean;
  /** `PUT …/deck` refuses, so a hold made under an earlier era is left standing. */
  deckFails?: boolean;
  /** A start the server refuses — e.g. the other player un-readied between polls. */
  refuseStart?: { status: number; error: string };
  /**
   * The pods `GET /tables/formats` offers THIS caller, as pools (wave 26 §F).
   *
   * The real route builds them from the caller's own seats and sends them FIRST,
   * `source: 'draft'`, with `cardCount` being the size of their own pool — so a
   * `newestFormat` fallback still lands on the newest frozen era.
   */
  pods?: { id: string; cards: number }[];
  /**
   * What `GET /tables/decks` offers. Absent ⇒ {@link DECKS}, the two Paris rows
   * every other suite uses.
   *
   * Overridden by the colours suite, which needs the REAL decklists: a deck's
   * colours are a fold over its own card list, and `DECKS`' one-line stand-ins
   * play sixty Islands.
   */
  decks?: TableDeck[];
}

/**
 * A room server that holds state: loading a deck checks it, readying is
 * refused while it is illegal, and `{ room }` starts one match.
 */
function stubServer(table: Table) {
  const calls: Call[] = [];
  /** The last `.dck` a drafted hold was sent as, so a test can parse it back. */
  let draftedText: string | null = null;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const gameType = table.gameType ?? 'constructed-1v1';
  /** The library this table's server has. See `Table.decks`. */
  const decks = (): TableDeck[] => table.decks ?? DECKS;
  table.format ??= FORMATS[0].id;
  const iAmLeader = () => table.leader !== false;
  const view = () => ({
    room: { id: ROOM, name: 'Friday night', gameType, matchId: table.matchId, seats: 2 },
    you: { player: table.players.some((p) => p.you), leader: iAmLeader() },
    players: table.players.map((p, seat) => ({ ...p, seat })),
  });
  /*
   * `GET /api/rooms/:id`, as `http/rooms.ts` answers it. `clientMode` is left
   * OUT of the body when the table does not set one, which is the shape a
   * server older than the field sends — the screen must read that as builtin.
   */
  /** The room's members. `p-alice` is the caller, and the leader by default. */
  const membersOf = () => table.members ?? [{ id: 'p-alice', name: 'user-alice' }];
  const roomRecord = (): Record<string, unknown> => ({
    id: ROOM,
    name: 'Friday night',
    creator: 'p-alice',
    // The leader is a member ID, which is what the screen matches on — the
    // display name is not unique, and no browser can derive its own id.
    leader: 'p-alice',
    gameType,
    format: table.format,
    // Caller-scoped, as `http/rooms.ts` serialises it: whether the leader is
    // this caller, and whether this caller is ready. `p-alice` is us.
    you: { leader: iAmLeader(), ready: membersOf().some((m) => m.id === 'p-alice' && m.ready === true) },
    ...(table.clientMode === undefined ? {} : { clientMode: table.clientMode }),
    locked: false,
    members: membersOf().map((m) => ({
      ...m,
      ready: m.ready === true,
      joinedAt: '',
    })),
    matchId: table.matchId,
    draftStartedAt: table.draftStartedAt ?? null,
    createdAt: '2026-09-19T00:00:00.000Z',
  });
  /** One deck against one pool, which is the only question the gate answers. */
  const verdictOf = (deckId: string, formatId: string): Verdict => {
    const name = decks().find((d) => d.id === deckId)?.name ?? '?';
    const format = FORMATS.find((f) => f.id === formatId);
    if (format?.id === '2011-07-15' && deckId === UG_POLYMORPH) return BANNED;
    return LEGAL(name, format?.name ?? '?');
  };
  const verdictFor = (choice: SeatChoice): Verdict =>
    verdictOf(
      'library' in choice.deck ? choice.deck.library : '?',
      choice.rules.kind === 'standard' ? choice.rules.format : '',
    );

  const fetchImpl: Fetch = async (url, init) => {
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith(`/api/rooms/${ROOM}`)) {
      /*
       * The leader's setter: `PATCH /api/rooms/:id` with `{ format }`, the same
       * route and allow-list that carries `{ gameType }`. A non-leader is
       * refused in the server's own words, and — like the real one — changing
       * the pool CLEARS every stored verdict and every ready flag, because what
       * they readied with is not what the table is now.
       */
      if ((init?.method ?? 'GET') === 'PATCH') {
        if (table.refusePatch !== undefined) return json(table.refusePatch.status, { error: table.refusePatch.error });
        const asked = body as { format?: unknown };
        if (typeof asked.format !== 'string') return json(400, { error: 'format must be a string' });
        table.format = asked.format;
        table.players = table.players.map((p) =>
          p.you ? { ...p, ready: false, legal: false, verdict: null, choice: null } : { ...p, ready: false },
        );
        return json(200, roomRecord());
      }
      return table.roomUnreadable === true ? json(503, { error: 'rooms are restarting' }) : json(200, roomRecord());
    }
    /*
     * The ROOM's own writes, as `http/rooms.ts` answers them. They are NOT the
     * table's: `/api/rooms/:id/ready` is a member's readiness in the room, and
     * `/api/tables/rooms/:id/ready` below is readiness with a deck — which is
     * why a draft room must never reach the second one.
     */
    if (url.endsWith(`/api/rooms/${ROOM}/ready`)) {
      if (table.refuseRoomWrite !== undefined) {
        return json(table.refuseRoomWrite.status, { error: table.refuseRoomWrite.error });
      }
      const want = (body as { ready: boolean }).ready;
      table.members = (table.members ?? [{ id: 'p-alice', name: 'user-alice' }]).map((m) =>
        m.id === 'p-alice' ? { ...m, ready: want } : m,
      );
      return json(200, roomRecord());
    }
    /* Joining a room makes you a member — which is what makes the table read
       below start working. `missing` is exactly the refusal that triggers it. */
    if (url.endsWith(`/api/rooms/${ROOM}/join`)) {
      table.missing = false;
      return json(200, roomRecord());
    }
    if (url.endsWith(`/api/rooms/${ROOM}/start`)) {
      if (table.refuseRoomWrite !== undefined) {
        return json(table.refuseRoomWrite.status, { error: table.refuseRoomWrite.error });
      }
      table.draftStartedAt = '2026-09-26T10:00:00.000Z';
      return json(200, roomRecord());
    }
    if (url.endsWith('/tables/formats')) {
      const pods = (table.pods ?? []).map((pod) => ({
        id: `draft:${pod.id}`,
        name: `Cube draft ${pod.id}`,
        effective: '',
        sets: [],
        banned: [],
        cardCount: pod.cards,
        source: 'draft',
        // Unused: the picker's "Drafted pool" tab is `source === 'draft'`.
        family: 'standard' as const,
      }));
      return json(200, { formats: [...pods, ...FORMATS] });
    }
    if (url.endsWith('/tables/decks')) return json(200, { decks: decks() });
    // One per era, each time the room's pool moves: how the picker learns
    // which decks that pool offers. The answer is this stub's own per-deck
    // verdict, so the fake cannot disagree with `/tables/check` below.
    const legalFor = /\/tables\/legal\/([^/?]+)$/.exec(url);
    if (legalFor !== null) {
      if (table.checkFails === true) return json(503, { error: 'the gate is restarting' });
      const format = decodeURIComponent(legalFor[1]!);
      const legal = decks()
        .filter((d) => verdictFor({ deck: { library: d.id }, rules: { kind: 'standard', format } }).legal)
        .map((d) => d.id);
      return json(200, { format, legal });
    }
    // UNCHANGED by w25 — `POST /tables/check` still takes a whole seat choice,
    // because it is asked about no room.
    if (url.endsWith('/tables/check')) {
      if (table.checkFails === true) return json(503, { error: 'the gate is restarting' });
      return json(200, verdictFor(body as SeatChoice));
    }
    if (table.missing === true && url.includes('/tables/rooms/')) return json(404, { error: 'no such room' });
    if (url.endsWith(`/tables/rooms/${ROOM}`)) return json(200, view());
    if (url.endsWith(`/tables/rooms/${ROOM}/deck`)) {
      if (table.deckFails === true) return json(503, { error: 'the room is restarting' });
      /*
       * `{ deck }` and nothing else. The real route REFUSES a body carrying
       * `rules` with 400 rather than accepting and ignoring it (w25 §A.3), so
       * this stub does too: a screen that still sent a format would fail here
       * instead of passing while sending a field nobody reads.
       */
      const sent = body as { deck?: DeckRef; rules?: unknown };
      if ('rules' in (sent as object)) return json(400, { error: 'unknown field(s): rules' });
      const deckId = sent.deck !== undefined && 'library' in sent.deck ? sent.deck.library : '?';
      /*
       * The ROOM's pool is the rules, for both seats — and for a room on a pod
       * (wave 26 §F) the rule is the pod and the pool is the CALLER's own 45, so
       * the body is a `.dck` rather than a library id and the verdict says whose
       * pool it was taken in. The server's own proof of that is
       * `apps/server/src/http/tables.test.ts`; what this stub has to get right is
       * the SHAPE, so a screen sending the wrong thing fails here.
       */
      const pod = (table.format ?? '').startsWith('draft:') ? (table.format ?? '').slice('draft:'.length) : null;
      if (pod !== null) {
        const text = sent.deck !== undefined && 'dck' in sent.deck ? sent.deck.dck : null;
        if (text === null) return json(400, { error: 'body.deck is .dck text for a drafted pool' });
        draftedText = text;
      }
      const verdict =
        pod === null
          ? verdictOf(deckId, table.format ?? '')
          : LEGAL(`Cube draft ${pod}`, `your pool from ${pod}`);
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
    draftedText: () => draftedText,
    client: tablesClient(fetchImpl, '/cardtable/api/'),
    rooms: roomsClient(fetchImpl, '/cardtable/api/'),
  };
}

async function mountRoom(table: Table, rand?: () => number) {
  const server = stubServer(table);
  render(
    createElement(ConstructedScreen, {
      client: server.client,
      rooms: server.rooms,
      roomId: ROOM,
      pollMs: 10,
      ...(rand === undefined ? {} : { rand }),
    }),
  );
  await screen.findByTestId('room-players');
  return server;
}

const lastCall = (calls: Call[], path: string): Call | undefined => calls.filter((c) => c.url.endsWith(path)).at(-1);
/** The eras the picker asked the gate about, in order: one `GET /tables/legal/:format` each. */
const sweeps = (server: { calls: Call[] }): string[] =>
  server.calls.flatMap((c) => {
    const m = /\/tables\/legal\/([^/?]+)$/.exec(c.url);
    return m === null ? [] : [decodeURIComponent(m[1]!)];
  });

/**
 * The deck chooser, once the era has answered which decks it offers.
 *
 * Not a `<select>` since wave 28 §C: a `role="radiogroup"` of card-like rows, so
 * "disabled" is `aria-disabled` on the root rather than a property. The rows are
 * dead until the era answers, on purpose — a list assembled before the answer
 * would offer decks the era does not have — so every test that picks a deck waits
 * for the answer first. That wait IS the contract.
 */
async function deckPicker(): Promise<HTMLElement> {
  const group = await screen.findByTestId('deck-mine');
  await waitFor(() => expect(group.getAttribute('aria-disabled')).toBeNull());
  return group;
}

/** One row of the chooser, by the id it sends. Throws rather than returning null. */
function deckRow(value: string): HTMLButtonElement {
  const found = screen
    .getByTestId('deck-mine')
    .querySelector<HTMLButtonElement>(`[data-deck-id="${value}"]`);
  if (found === null) throw new Error(`no deck row ${value}`);
  return found;
}

/** A row's visible deck name, which is the only text the row carries of its own. */
const rowName = (row: HTMLElement): string =>
  row.querySelector('.deckpick__name')?.textContent ?? '';

/** Which deck the chooser says is chosen, or `''`. The same fact `aria-checked` carries. */
const chosen = (): string => screen.getByTestId('deck-mine').dataset['chosen'] ?? '';

/**
 * Choosing a deck. There is no Load button: this is the load.
 *
 * A click on the row, which is the same gesture the three e2e specs now make
 * (`docs/planning/wave28-evidence/C-deck-chooser-e2e-recipe.md`) — so this helper
 * and those specs drive the control the same way a person does.
 */
/**
 * Press `Random`. It is a button ABOVE the deck list now, not a row inside it
 * (operator, 2026-09-30), so `pick` — which clicks a row — cannot reach it.
 */
async function pressRandom(): Promise<void> {
  await deckPicker();
  const random = screen.getByTestId('deck-random');
  await act(async () => {
    fireEvent.click(random);
  });
}

async function pick(value: string): Promise<void> {
  await deckPicker();
  const row = deckRow(value);
  await act(async () => {
    fireEvent.click(row);
  });
}

/**
 * The LEADER moving the table's pool, which re-sends a chosen deck under the
 * new rules — on every browser in the room, not only this one.
 *
 * There is no local format state any more: this writes to the ROOM, so the wait
 * is on the room record coming back with the new pool.
 */
async function pickPool(formatId: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId('format'), { target: { value: formatId } });
  });
  await waitFor(() => expect((screen.getByTestId('format') as HTMLSelectElement).value).toBe(formatId));
}

/**
 * The chooser's deck rows, by the id they send — what the era left on offer.
 *
 * `Random` is not in this list and is not a row: it is a button beside them that
 * resolves to one of them, so a list of what the era offers is a list of decks.
 */
const offered = (): string[] =>
  [...screen.getByTestId('deck-mine').querySelectorAll<HTMLElement>('[data-testid="deck-option"]')].map(
    (row) => row.dataset['deckId'] ?? '',
  );

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
    expect(screen.getByTestId('room-seat-0-deck').textContent).toBe('Jund (Emanuele Giusti)');
    // The format is a cell, not a clause: "legal in Standard (M11)" is gone.
    expect(screen.getByTestId('room-seat-0-rules').textContent).toBe('Standard (M11)');
    expect(screen.getByTestId('room-seat-0-legal').textContent).toBe('legal');
    expect(screen.getByTestId('room-seat-0-ready').textContent).toBe('not ready');
    expect(screen.getByTestId('room-seat-1-empty')).toBeTruthy();
    expect(screen.getByTestId('start-state').textContent).toContain('Waiting for a second player');
  });

  /*
   * The operator, 2026-09-25, of the row this replaced — a sentence with
   * middots for separators and `ready` as raw text: *"looks very cheap"*.
   */
  it('draws the seats as a table: no middots, and every state a shape AND a colour', async () => {
    await mountRoom({ players: [opponent({ ready: true })], matchId: null });
    const row = screen.getByTestId('room-seat-0');
    // No separator characters anywhere in the row: the cells are the separation.
    expect(row.textContent).not.toMatch(/[·—]/);
    expect(row.className).toContain('tables__row');
    expect([...row.children].map((c) => c.className.split(' ')[0])).toEqual([
      'tables__who',
      'tables__deck',
      'tables__rules',
      'pill',
      'pill',
    ]);

    // Each state carries a drawn mark of its own, so colour is never the only
    // difference. Ready is a tick; not ready is an open ring.
    const ready = screen.getByTestId('room-seat-0-ready');
    expect(ready.dataset.state).toBe('yes');
    expect(ready.dataset.mark).toBe('tick');
    expect(ready.querySelector('svg path')).not.toBeNull();
    expect(ready.querySelector('svg circle')).toBeNull();

    const legal = screen.getByTestId('room-seat-0-legal');
    expect(legal.dataset.state).toBe('yes');
    expect(legal.dataset.mark).toBe('tick');

    // And the styles that colour them do not carry the whole signal: the
    // stylesheet distinguishes the two states by border style as well.
    expect(SCREENS_CSS).toMatch(/\.pill\[data-state='no'\] \{[^}]*border-style: dashed;/);
  });

  it('an unready, illegal seat reads as two failed states, with the count on the pill', async () => {
    await mountRoom({ players: [opponent({ legal: false, issueCount: 3, ready: false })], matchId: null });
    const legal = screen.getByTestId('room-seat-0-legal');
    expect(legal.dataset.state).toBe('no');
    expect(legal.dataset.mark).toBe('cross');
    expect(legal.textContent).toBe('illegal3');
    expect(legal.querySelector('.pill__count')!.textContent).toBe('3');
    const ready = screen.getByTestId('room-seat-0-ready');
    expect(ready.dataset.state).toBe('no');
    expect(ready.dataset.mark).toBe('ring');
    expect(ready.querySelector('svg circle')).not.toBeNull();
    expect(ready.querySelector('svg path')).toBeNull();
  });

  /*
   * The operator, of the Load button: *"just 'I'm ready' is enough."* So
   * choosing a deck IS loading it — the `PUT` goes on the change event, and
   * there is no second thing to press. Asserted by the absence of the button
   * AND by the request arriving without one, because either alone is half of
   * it: a removed button with no load is a broken screen.
   */
  it('loads YOUR deck only when it is chosen, with no button to press', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null });
    expect(screen.queryByTestId('load-deck')).toBeNull();
    await pick(SECOND_DECK);

    const put = lastCall(server.calls, `/tables/rooms/${ROOM}/deck`);
    expect(put).toEqual({
      url: `/cardtable/api/tables/rooms/${ROOM}/deck`,
      method: 'PUT',
      // One deck, no seat number, no field that could name another member —
      // and no `rules`: the ROOM's pool is what it is checked against, and a
      // body that named one would be a 400 (see the stub).
      body: { deck: { library: SECOND_DECK } },
    });
    expect(screen.getByTestId('verdict-mine').textContent).toContain('Legal in Standard (M11)');
    expect(screen.getByTestId('room-seat-1').textContent).toContain('(you)');
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false);
  });

  /*
   * The POOL moving under a chosen deck is now the only way to hold an illegal
   * one: the dropdown offers nothing else. Both halves are asserted — the
   * verdict names the banned card, and the deck drops off the list — because
   * the second is what stops Ready coming back to life over it.
   */
  it('an illegal deck blocks YOUR ready and names the card, and nobody else’s', async () => {
    const server = await mountRoom({ players: [opponent({ ready: true })], matchId: null });
    await pick(UG_POLYMORPH);
    await pickPool('2011-07-15');

    const verdict = screen.getByTestId('verdict-mine').textContent ?? '';
    expect(verdict).toContain('Jace, the Mind Sculptor');
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
    // The pool that bans it no longer offers it, and nothing is chosen.
    await waitFor(() => expect(offered()).not.toContain(UG_POLYMORPH));
    expect(chosen()).toBe('');
    // The other player was stood down BY THE POOL MOVING, which is the server's
    // rule and not this deck's fault: what they readied with is not what the
    // table is on any more. Their deck is still legal — one player's illegal
    // deck says nothing about the other's.
    await waitFor(() => expect(screen.getByTestId('room-seat-0-ready').textContent).toBe('not ready'));
    expect(screen.getByTestId('room-seat-0-legal').textContent).toBe('legal');
    // And nothing was started.
    expect(lastCall(server.calls, '/play/matches')).toBeUndefined();
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });

  it('starts the match once both are ready, without either choosing the other’s deck', async () => {
    const server = await mountRoom({ players: [opponent({ ready: true })], matchId: null });
    await pick(UG_POLYMORPH);
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

  it('alone in the room, Play vs Forge AI starts a bot match from the room', async () => {
    const server = await mountRoom({ players: [], matchId: null });
    await pick(UG_POLYMORPH);
    const bot = screen.getByTestId('play-vs-bot');
    await waitFor(() => expect((bot as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(bot);
    });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
    expect(lastCall(server.calls, '/play/matches')).toEqual({
      url: '/cardtable/api/play/matches',
      method: 'POST',
      body: { room: ROOM, bot: true },
    });
  });

  it('offers no bot when a second person is in the room', async () => {
    await mountRoom({
      players: [opponent({ ready: false })],
      matchId: null,
      members: [
        { id: 'p-alice', name: 'user-alice' },
        { id: 'p-bob', name: 'user-bob' },
      ],
    });
    await pick(UG_POLYMORPH);
    expect(screen.queryByTestId('play-vs-bot')).toBeNull();
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
        ready: async () => ({ ok: false as const, message: 'not used' }),
        start: async () => ({ ok: false as const, message: 'not used' }),
        setFormat: async () => ({ ok: false as const, message: 'not used' }),
        leave: async () => ({ ok: false as const, message: 'not used' }),
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
                  creator: 'p-alice',
                  leader: 'p-alice',
                  gameType: 'constructed-1v1',
                  format: '2010-07-16',
                  you: { leader: true, ready: false },
                  clientMode: 'builtin' as const,
                  locked: false,
                  members: [],
                  matchId: null,
                  draftStartedAt: null,
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
    await mountRoom({ players: [opponent(), opponent({ name: 'user-carol', deckName: 'UG Polymorph (Antoine Ruel)' })], matchId: null });
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
    await pick(UG_POLYMORPH);
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

/* ── the picker: two selects, one button (wave 22 §B) ────────────────── */

describe('the deck picker', () => {
  it('says Ready, not “I’m ready”, and is dead until a deck is chosen', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    const ready = screen.getByTestId('ready-toggle') as HTMLButtonElement;
    expect(ready.textContent).toBe('Ready');
    // Nothing is chosen for you, so nothing is loaded and Ready cannot be pressed.
    await deckPicker();
    expect(chosen()).toBe('');
    expect(ready.disabled).toBe(true);

    await pick(SECOND_DECK);
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false));
  });

  it('narrows the deck list to the decks the ROOM’s pool says are legal, asking the gate once per pool', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null });
    // The pool the room opens on is legal for both, so both are on offer.
    await deckPicker();
    expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]);

    await pickPool('2011-07-15');
    // The pool that bans Jace and Stoneforge offers one of the two decks.
    await waitFor(() => expect(offered()).toEqual([SECOND_DECK]));

    // It is the SERVER's answer, ONE request per pool — not one per deck, and
    // not arithmetic done here over a set list the browser was never sent.
    expect(sweeps(server)).toContain('2011-07-15');
    expect(sweeps(server).filter((f) => f === '2011-07-15')).toHaveLength(1);
    expect(server.calls.filter((c) => c.url.endsWith('/tables/check'))).toHaveLength(0);

    // And a pool already answered for is not asked again.
    await pickPool('2010-07-16');
    await waitFor(() => expect(offered()).toContain(UG_POLYMORPH));
    await pickPool('2011-07-15');
    await waitFor(() => expect(offered()).toEqual([SECOND_DECK]));
    expect(sweeps(server).filter((f) => f === '2011-07-15')).toHaveLength(1);
  });

  it('offers a deck it could not get an answer for rather than deleting it from the library', async () => {
    // Failing closed over a dropped request would silently shrink the library.
    // Failing open costs a refusal the person can read — and the failure is
    // said out loud rather than swallowed.
    await mountRoom({ players: [opponent()], matchId: null, checkFails: true });
    await deckPicker();
    expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]);
    await waitFor(() => expect(screen.getByTestId('table-error').textContent).toContain('the gate is restarting'));
  });

  /*
   * The case the `deckId === ''` half of Ready's guard exists for, and the
   * reason it is not redundant with "the server holds a legal deck for you":
   * the pool moved, the re-send under the new rules FAILED, and the server has
   * no verdict for this seat at all any more — moving the pool clears it, along
   * with everybody's readiness. Ready has to be dead; pressing it would start a
   * match from a hold nobody re-checked.
   *
   * (It used to assert that the screen still showed the OLD pool's verdict.
   * That was true when the verdict survived a format change and is not any
   * more, so the assertion went with the behaviour it described. What it was
   * there to protect — Ready stays dead — is asserted below, twice.)
   */
  it('will not ready up on a hold the pool moved out from under, when the re-send failed', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null });
    await pick(UG_POLYMORPH);
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false));

    server.table.deckFails = true;
    await pickPool('2011-07-15');

    // The re-send is refused, in the server's own words.
    await waitFor(() => expect(screen.getByTestId('table-error').textContent).toContain('the room is restarting'));
    // Nothing was checked against the new pool, so there is no verdict to show.
    await waitFor(() => expect(screen.queryByTestId('verdict-mine')).toBeNull());
    // The deck is off the list, nothing is chosen, and Ready stays dead.
    await waitFor(() => expect(offered()).not.toContain(UG_POLYMORPH));
    expect(chosen()).toBe('');
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Random chooses one of the decks on offer, and says which one it chose', async () => {
    // Pinned source: 0.99 lands on the last deck the pool offers.
    const server = await mountRoom({ players: [opponent()], matchId: null }, () => 0.99);
    await pressRandom();

    expect(chosen()).toBe(SECOND_DECK);
    expect(lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body).toEqual({ deck: { library: SECOND_DECK } });
    // `Random` is never what gets loaded: it resolves to a deck id.
    const loads = server.calls.filter((c) => c.url.endsWith('/deck'));
    expect(loads.map((c) => JSON.stringify(c.body))).not.toContain(expect.stringContaining('__random__'));
  });

  it('Random cannot roll a deck the pool bans, because the pool narrowed the list first', async () => {
    // 0 lands on the FIRST offered deck, which in this pool is not UG Polymorph's.
    const server = await mountRoom({ players: [opponent()], matchId: null }, () => 0);
    await pickPool('2011-07-15');
    await waitFor(() => expect(offered()).not.toContain(UG_POLYMORPH));
    await pressRandom();
    expect(chosen()).toBe(SECOND_DECK);
    expect(screen.getByTestId('verdict-mine').textContent).toContain('Legal in');
    expect(lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body).toEqual({ deck: { library: SECOND_DECK } });
  });

  /*
   * The operator's third session, item 3: *"Transcribed from mtgtop8 deck
   * 209238."* and its neighbours are gone. What is left of a deck's origin is
   * the link, because the attribution is owed and a link is not a sentence.
   */
  it('explains nothing: no provenance, no set list, no card counts', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    await pick(UG_POLYMORPH);
    const card = screen.getByTestId('deck-mine').closest('section') as HTMLElement;

    expect(card.textContent).not.toContain('Pro Tour Paris 2011');
    expect(card.textContent).not.toMatch(/\d+ cards/);
    expect(card.textContent).not.toContain('sideboard');
    expect(card.textContent).not.toContain('Nothing banned');
    expect(screen.queryByTestId('format-detail')).toBeNull();
    // The one surviving sentence is the server's verdict, which is a finding
    // about YOUR deck and not an explanation of the screen.
    expect(screen.getByTestId('verdict-mine').textContent).toContain('Legal in Standard (M11)');

    // No source link. Operator, 2026-09-30: *"the 'source' link is unecessary"*.
    // The attribution it carried is not lost: every `.dck` keeps its `Source URL`
    // and a "Transcribed from mtgtop8 deck …" comment, and `decks/README.md`
    // credits each deck with its mtgtop8 link.
    expect(screen.queryByTestId('deck-source')).toBeNull();
  });

  it('re-sends the deck when the pool moves, so the held verdict is never one from another pool', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null });
    await pick(SECOND_DECK);
    const loadsBefore = server.calls.filter((c) => c.url.endsWith('/deck')).length;
    await pickPool('2011-07-15');

    // A second PUT, naming the same deck and no rules at all — the room's pool
    // is what the server checks it against, and the room's pool has moved.
    await waitFor(() => expect(server.calls.filter((c) => c.url.endsWith('/deck')).length).toBe(loadsBefore + 1));
    expect(lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body).toEqual({ deck: { library: SECOND_DECK } });
    expect(screen.getByTestId('verdict-mine').textContent).toContain('Legal in Standard (M12)');
  });

  /*
   * And NOT re-sent on the way in.
   *
   * A `PUT …/deck` stands you down (`routes.ts`: a new deck un-readies you), so
   * a screen that re-sent the held deck the first time it learned the room's
   * pool would silently un-ready anybody who reloaded while ready. The first
   * sighting of a pool is not a change to it.
   */
  it('does not re-send the deck the server is already holding when it arrives', async () => {
    const held: RoomPlayer = {
      seat: 0,
      name: 'user-alice',
      you: true,
      deckName: 'Jund (Emanuele Giusti)',
      rulesName: 'Standard (M11)',
      legal: true,
      issueCount: 0,
      ready: true,
      verdict: LEGAL('Jund (Emanuele Giusti)', 'Standard (M11)'),
      choice: { deck: { library: SECOND_DECK }, rules: { kind: 'standard', format: '2010-07-16' } },
    };
    // The other player is NOT ready, so nothing starts while this is watched.
    const server = await mountRoom({ players: [opponent(), held], matchId: null });
    // The picker opens on the deck the server holds…
    await waitFor(() => expect(chosen()).toBe(SECOND_DECK));
    // …and over a dozen polls it never writes one.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(server.calls.filter((c) => c.url.endsWith('/deck'))).toHaveLength(0);
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).textContent).toBe('Stand down');
  });
});

/* ── the table's pool belongs to the leader (wave 25 §B) ─────────────── */

/*
 * Operator, 2026-09-27: *"room creator should be leader and be the one who
 * selects the room mode … people who join can only select from the deck
 * dropdown, and the room leader can change the set or other settings."*
 *
 * So the pool is the ROOM's — read from its record, written by one PATCH — and
 * the only input a non-leader has on this card is the deck below it. Both halves
 * are asserted, because either alone is half of it: a control nobody has is a
 * screen that cannot set the table, and a control everybody has is the defect.
 */
describe('the table’s pool', () => {
  const POOL_NAME = '2010-07-16 — Standard (M11)';

  it('gives the LEADER a control that moves it, and writes it to the room', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null });
    const select = screen.getByTestId('format') as HTMLSelectElement;
    expect(select.value).toBe('2010-07-16');
    expect(screen.queryByTestId('format-fixed')).toBeNull();

    await pickPool('2011-07-15');

    // One PATCH on the room itself, with `{ format }` and nothing else — the
    // same route and allow-list that carries `{ gameType }`.
    const patches = server.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toEqual([
      { url: `/cardtable/api/rooms/${ROOM}`, method: 'PATCH', body: { format: '2011-07-15' } },
    ]);
    // And the deck list follows the room, not the press: the pool the room is
    // now on is the one the gate was asked about.
    await waitFor(() => expect(offered()).toEqual([SECOND_DECK]));
  });

  /*
   * Wave 48 §U, item 1: *"i'll need a tab selector at the top for picking the
   * format as well obviously"*. Replaces the single "Matched Standard"
   * optgroup this suite used to pin (`constructed.test.ts:1760` before this
   * wave).
   */
  it('shows a tab selector above the era list, opening on the table’s own family', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    const tabs = screen.getByTestId('format-tabs');
    expect([...tabs.querySelectorAll('[role="tab"]')].map((b) => b.textContent)).toEqual(['Standard', 'Modern', 'Legacy']);
    // Every era here is Standard, and the room is on one, so that tab opens active.
    expect(screen.getByTestId('format-tab-standard').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('format-tab-modern').getAttribute('aria-selected')).toBe('false');
    // No "Drafted pool" tab at all when the room has no pod — never a disabled one.
    expect(screen.queryByTestId('format-tab-draft')).toBeNull();
    // No prose anywhere on the card explaining what a tab is or does.
    const card = screen.getByTestId('deck-mine').closest('section') as HTMLElement;
    expect(card.textContent).not.toMatch(/tab|pick the format|switch/i);
  });

  it('gives a NON-leader no pool control at all, only the value the room is on', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null, leader: false });

    // No control of any kind: not a disabled select, not a select at all.
    expect(screen.queryByTestId('format')).toBeNull();
    const fixed = screen.getByTestId('format-fixed');
    expect(fixed.tagName).toBe('SPAN');
    expect(fixed.textContent).toBe(POOL_NAME);
    expect(fixed.dataset.format).toBe('2010-07-16');
    // And there is now no `<select>` on the card AT ALL: the pool is theirs to
    // read, and the deck chooser stopped being a dropdown in wave 28 §C.
    expect(screen.getByTestId('deck-mine').closest('section')!.querySelectorAll('select')).toHaveLength(0);

    // Their one input still works, and the pool is never written by them.
    await pick(SECOND_DECK);
    expect(screen.getByTestId('verdict-mine').textContent).toContain('Legal in Standard (M11)');
    expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('follows the pool the leader moved it to, on a browser that pressed nothing', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null, leader: false });
    await pick(UG_POLYMORPH);
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false));

    // The leader's browser moved it; this one learns it from the room poll.
    server.table.format = '2011-07-15';

    // The held deck is re-sent — this seat's verdict was cleared by the change
    // too — and the pool that bans it names the cards and takes it off the list.
    await waitFor(() => expect(screen.getByTestId('verdict-mine').textContent).toContain('Jace, the Mind Sculptor'));
    expect(screen.getByTestId('format-fixed').textContent).toBe('2011-07-15 — Standard (M12)');
    await waitFor(() => expect(offered()).not.toContain(UG_POLYMORPH));
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body).toEqual({ deck: { library: UG_POLYMORPH } });
  });

  it('says who the leader is with a mark and a name, and no sentence about it', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    const mark = screen.getByTestId('room-leader');
    expect(mark.dataset.mark).toBe('crown');
    expect(mark.dataset.state).toBe('leader');
    // Our own drawing, and a shape as well as a colour — the same rule the
    // legal/ready pills follow.
    expect(mark.querySelector('svg path')).not.toBeNull();
    expect(mark.textContent).toBe('user-alice (you)');
    // No prose: nothing on the card explains what a leader is or may do.
    const card = screen.getByTestId('deck-mine').closest('section') as HTMLElement;
    expect(card.textContent).not.toMatch(/room leader|can change|only the/i);
    // And the quietest colouring in the file is its own state, so the two
    // pass/fail colourings still mean exactly what they meant.
    expect(SCREENS_CSS).toMatch(/\.pill\[data-state='leader'\] \{[^}]*border-style: dotted;/);
    // The card is a flex COLUMN, where a flex item stretches by default — an
    // inline-flex pill left to that is a 300px lozenge round two words.
    expect(SCREENS_CSS).toMatch(/\.lobby__card > \.pill \{[^}]*align-self: flex-start;/);
  });

  it('names the leader without “(you)” to everybody else', async () => {
    await mountRoom({ players: [opponent()], matchId: null, leader: false });
    expect(screen.getByTestId('room-leader').textContent).toBe('user-alice');
  });

  it('falls back to the NEWEST pool, not the oldest, when the room does not say', async () => {
    // The room record carries no pool — an older server, or a body that lost
    // the field. `formats[0]` is the oldest power-summer era (2008-07-25) and
    // is where every room used to open; the fallback is the LAST element, the
    // same default the server
    // applies at create (operator, 2026-09-27: newest).
    const server = await mountRoom({ players: [opponent()], matchId: null, format: '' });
    await waitFor(() => expect((screen.getByTestId('format') as HTMLSelectElement).value).toBe('2011-07-15'));
    await waitFor(() => expect(sweeps(server)).not.toHaveLength(0));
    expect(sweeps(server).every((f) => f === '2011-07-15')).toBe(true);
  });

  it('hands back the server’s refusal and leaves the pool where the room has it', async () => {
    const server = await mountRoom({
      players: [opponent()],
      matchId: null,
      refusePatch: { status: 409, error: 'this room is drafting; the game type cannot change now' },
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('format'), { target: { value: '2011-07-15' } });
    });
    await waitFor(() => expect(screen.getByTestId('table-error').textContent).toContain('this room is drafting'));
    // Nothing local moved: the select still reads what the ROOM is on.
    expect((screen.getByTestId('format') as HTMLSelectElement).value).toBe('2010-07-16');
    expect(server.table.format).toBe('2010-07-16');
  });
});

/* ── a draft room (w23 §B) ───────────────────────────────────────────── */

/*
 * The branch this screen never had. A room created with `gameType: 'draft'`
 * used to land its members on the constructed deck picker — the game-type
 * selector promised something the room screen did not deliver, which is the
 * defect behind the operator's *"just completely get rid of the 'start a pod'
 * button"*. Two phases now, both here: the room's lobby, then the pod.
 *
 * The pod's own drafting is `e2e/draft.spec.ts`'s to prove against a real
 * server; what these assert is the gate in front of it.
 */
describe('a draft room', () => {
  /** Three methods and no server: enough for `PodScreen` to mount and connect. */
  const stubTransport = () => ({ on: () => {}, emit: () => {}, disconnect: () => {} });

  const members = (...ready: boolean[]) =>
    ready.map((r, i) => ({ id: i === 0 ? 'p-alice' : `p-${i}`, name: i === 0 ? 'user-alice' : `user-${i}`, ready: r }));

  async function mountDraft(table: Partial<Table> = {}) {
    const server = stubServer({ players: [], matchId: null, gameType: 'draft', members: members(false), ...table });
    render(
      createElement(ConstructedScreen, {
        client: server.client,
        rooms: server.rooms,
        roomId: ROOM,
        pollMs: 10,
        makeTransport: stubTransport,
      }),
    );
    return server;
  }

  it('shows the room’s lobby and NOT a pack: nothing is dealt before everyone is ready', async () => {
    const server = await mountDraft({ members: members(false, false) });
    await screen.findByTestId('draft-lobby');

    // Who is here, and who is ready — off the ROOM's record, not the table's.
    expect(screen.getAllByTestId(/^draft-member-\d+$/)).toHaveLength(2);
    expect(screen.getByTestId('draft-member-0').textContent).toContain('user-alice');
    expect(screen.getByTestId('draft-member-0-ready').textContent).toBe('not ready');
    expect(screen.getByTestId('draft-member-0-ready').dataset.mark).toBe('ring');
    expect(screen.getByTestId('draft-state').textContent).toBe('Waiting for user-alice and user-1.');

    // No pack, no pod, no seats: the draft does not exist yet.
    expect(screen.queryByTestId('pod')).toBeNull();
    expect(screen.queryByTestId('pod-seats')).toBeNull();
    expect(screen.queryByTestId('pod-waiting')).toBeNull();

    // And none of the constructed table's furniture either.
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.queryByTestId('format')).toBeNull();
    expect(screen.queryByTestId('room-players')).toBeNull();

    // The legality sweep — one `GET /tables/legal/:format` per era — never runs. (The two catalogue GETs start at mount,
    // before the room's own type is known, and their answer is discarded rather
    // than delaying the picker for every constructed room; see the effect.)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(sweeps(server)).toHaveLength(0);
    // Nor is a single table write made: `routes.ts` answers 409 to all of them.
    expect(server.calls.filter((c) => c.url.includes('/tables/rooms/') && c.method !== 'GET')).toHaveLength(0);
    expect(server.calls.filter((c) => c.url.endsWith('/play/matches'))).toHaveLength(0);
  });

  it('states the two rules the operator would otherwise have to guess', async () => {
    await mountDraft();
    const rule = (await screen.findByTestId('draft-rule')).textContent ?? '';
    expect(rule).toContain('every member of this room is ready');
    expect(rule).toContain('eight');
    expect(rule).toMatch(/bots/i);
    // §1.6: the draft is in memory, so it cannot outlive the process, and the
    // room says that rather than coming back to an empty table.
    expect(screen.getByTestId('draft-restart-note').textContent).toContain('does not survive a restart');
  });

  it('readies YOU through the room’s route, and says so in the list', async () => {
    const server = await mountDraft({ members: members(false, false) });
    const toggle = (await screen.findByTestId('ready-toggle')) as HTMLButtonElement;
    expect(toggle.textContent).toBe('Ready');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(lastCall(server.calls, `/api/rooms/${ROOM}/ready`)).toEqual({
      url: `/cardtable/api/rooms/${ROOM}/ready`,
      method: 'POST',
      body: { ready: true },
    });
    // The room's own route, never the table's.
    expect(server.calls.filter((c) => c.url.endsWith(`/tables/rooms/${ROOM}/ready`))).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId('draft-member-0-ready').textContent).toBe('ready'));
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).textContent).toBe('Stand down');

    // Standing down again is the same route with the other boolean.
    await act(async () => {
      fireEvent.click(screen.getByTestId('ready-toggle'));
    });
    expect(lastCall(server.calls, `/api/rooms/${ROOM}/ready`)?.body).toEqual({ ready: false });
  });

  /*
   * Wave 23's stated cost, paid off (w25).
   *
   * The toggle's label used to be a latch set by our own `ready` call, because
   * nothing on the wire said which member the caller was — so a reload while
   * ready read "Ready" and pressing it re-sent readiness you already had. The
   * room record carries a caller-scoped `you.ready` now, and this browser has
   * pressed nothing at all.
   */
  it('arrives reading the readiness the ROOM holds for you, having pressed nothing', async () => {
    const server = await mountDraft({ members: members(true, false) });
    const toggle = (await screen.findByTestId('ready-toggle')) as HTMLButtonElement;
    await waitFor(() => expect(toggle.textContent).toBe('Stand down'));
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/ready`))).toHaveLength(0);
  });

  it('marks which member is the leader, with a mark and not a sentence', async () => {
    await mountDraft({ members: members(false, false) });
    await screen.findByTestId('draft-lobby');

    // `p-alice` is the room's `leader`, and a member's ID is the only thing
    // that identifies them — the display name is not unique.
    const mark = screen.getByTestId('draft-member-0-leader');
    expect(mark.dataset.mark).toBe('crown');
    expect(mark.querySelector('svg path')).not.toBeNull();
    // Exactly one member carries it, and the other says nothing.
    expect(screen.queryByTestId('draft-member-1-leader')).toBeNull();
    expect(screen.getByTestId('draft-member-1').textContent).not.toMatch(/leader/i);
  });

  it('starts the draft exactly once when every member is ready, and only then', async () => {
    // One member still not ready: nothing is asked for, however long it polls.
    const server = await mountDraft({ members: members(true, false) });
    await screen.findByTestId('draft-lobby');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80)); // eight poll intervals
    });
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`))).toHaveLength(0);
    expect(screen.queryByTestId('pod')).toBeNull();

    // The other browser readies up; this one learns it from the poll and deals.
    server.table.members = members(true, true);
    await waitFor(() => expect(screen.queryByTestId('pod')).not.toBeNull());
    const starts = server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({ url: `/cardtable/api/rooms/${ROOM}/start`, method: 'POST', body: {} });

    // And the poll does not ask again now that it has started.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`))).toHaveLength(1);
  });

  it('renders the pod, with every hook it had as its own route, once draftStartedAt is set', async () => {
    await mountDraft({ draftStartedAt: '2026-09-26T10:00:00.000Z', members: members(true) });
    await screen.findByTestId('pod');

    expect(screen.getByTestId('pod-seats')).toBeTruthy();
    expect(screen.getByTestId('pod-waiting')).toBeTruthy();
    expect(screen.getByTestId('copy-invite')).toBeTruthy();
    // The invite is the ROOM's url — there is no pod route to point at.
    const invite = screen.getByTestId('invite-url') as HTMLInputElement;
    expect(invite.value.endsWith(`#/room/${ROOM}`)).toBe(true);
    expect(invite.value).not.toContain('#/draft/');

    // The lobby phase is gone, and the constructed table never appeared.
    expect(screen.queryByTestId('draft-lobby')).toBeNull();
    expect(screen.queryByTestId('deck-mine')).toBeNull();
  });

  it('says what the server refused, and asks again only when told to', async () => {
    const server = await mountDraft({
      members: members(true, true),
      refuseRoomWrite: { status: 409, error: 'this room plays constructed-1v1, not draft' },
    });
    const refused = await screen.findByTestId('draft-error');
    expect(refused.textContent).toContain('this room plays constructed-1v1, not draft');
    expect(screen.queryByTestId('pod')).toBeNull();

    // One attempt, not one per poll.
    const attempts = () => server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`)).length;
    const once = attempts();
    expect(once).toBe(1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(attempts()).toBe(once);

    // Told to, it asks again — and this time the server deals.
    server.table.refuseRoomWrite = undefined;
    await act(async () => {
      fireEvent.click(screen.getByTestId('draft-retry'));
    });
    await waitFor(() => expect(screen.queryByTestId('pod')).not.toBeNull());
  });

  it('still joins the room it was opened on, so a draft invite link works', async () => {
    // The table poll is what joins you (`routes.ts` answers a non-member the
    // same 404 as a missing room), and a draft room needs that as much as a
    // constructed one: the invite link is the only way a friend gets in. This
    // is why the table poll is NOT switched off for a draft room.
    const server = await mountDraft({ missing: true });
    await waitFor(() =>
      expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/join`))).toHaveLength(1),
    );
    expect(lastCall(server.calls, `/api/rooms/${ROOM}/join`)?.method).toBe('POST');
    // And the read that followed it is the one that matters: the lobby appears.
    await screen.findByTestId('draft-lobby');
    expect(screen.queryByTestId('room-missing')).toBeNull();
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

  it('shows none of the draft furniture, and asks for no room write of its own', async () => {
    // The other half of the branch: `constructed-1v1` must be what it was, and
    // the draft lobby must not leak into it.
    const server = await mountRoom({ players: [opponent()], matchId: null });
    expect(screen.queryByTestId('draft-lobby')).toBeNull();
    expect(screen.queryByTestId('draft-members')).toBeNull();
    expect(screen.queryByTestId('draft-rule')).toBeNull();
    expect(screen.queryByTestId('draft-restart-note')).toBeNull();
    expect(screen.queryByTestId('pod')).toBeNull();
    // The one shared id belongs to the deck picker's own toggle here.
    expect(screen.getByTestId('ready-toggle').closest('section')).toBe(
      screen.getByTestId('deck-mine').closest('section'),
    );
    // The room's readiness and start routes are the draft's; this path uses the
    // table's, and asks neither of the new ones.
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/ready`))).toHaveLength(0);
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`))).toHaveLength(0);
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

/* ── the era's set symbols, and a room on a DRAFTED pool (wave 26 §F) ──── */

/**
 * *"constructed selections should show the set symbols that are in that era."*
 * — and then, 2026-09-28: *"this is ugly, just the symbols is okay. group them by
 * block and make them bigger."*
 *
 * The data was already on the wire (`GET /api/tables/formats` sends each era's
 * `sets`); wave 28 §C dropped the codes, enlarged the glyph and clustered the sets
 * into their blocks. Keyrune glyphs from a third-party font, never WotC's own
 * files and never `svgs.scryfall.io` (D20, `docs/LICENSING.md` §3.2).
 *
 * **Asserted on what a browser would paint**, which is the lesson the old
 * `<option>` comment left behind: the row's `textContent` is empty, so a CSS
 * `display: none` over the codes could not pass this — and every set is still
 * identifiable through `data-set`, `title` and the block's `aria-label`, which is
 * what a reader gets instead.
 */
describe('the era’s set symbols', () => {
  /** `[block code, the era's sets in it]`, in the order the row draws them. */
  const blocks = (): [string, string][] =>
    [...screen.getByTestId('pool-sets').querySelectorAll<HTMLElement>('[data-testid="pool-block"]')].map((g) => [
      g.dataset['block'] ?? '',
      g.dataset['sets'] ?? '',
    ]);

  it('groups the era’s sets by block, with no set code text anywhere', async () => {
    await mountRoom({ players: [], matchId: null, format: FORMATS[0].id });
    const row = await screen.findByTestId('pool-sets');
    expect(row.dataset.sets).toBe(FORMATS[0].sets.join(' '));

    // Three blocks out of six sets, and the core set goes last rather than
    // sitting between ROE and SOM where its release date would put it.
    expect(blocks()).toEqual([
      ['zen', 'ZEN WWK ROE'],
      ['som', 'SOM MBS'],
      ['lea', 'M11'],
    ]);
    // Every set still draws, exactly once, and the glyph is a Keyrune class.
    expect([...row.querySelectorAll('[data-set]')].map((e) => (e as HTMLElement).dataset.set)).toEqual([
      'ZEN',
      'WWK',
      'ROE',
      'SOM',
      'MBS',
      'M11',
    ]);
    expect(row.querySelector('.ss')?.className).toBe('ss ss-zen');

    // THE POINT: no text. Not hidden text — none. A test that only checked for a
    // `[data-set]` node would pass against the row this replaced.
    expect(row.textContent).toBe('');
    for (const code of FORMATS[0].sets) expect(row.textContent).not.toContain(code);
    // The code is still reachable without being painted, which is what makes
    // dropping it safe for a reader.
    expect(row.querySelector('[data-set="ZEN"]')?.getAttribute('title')).toBe('ZEN');
    expect(screen.getByLabelText('Zendikar: ZEN WWK ROE')).toBeTruthy();
    expect(screen.getByLabelText('Core Set: M11')).toBeTruthy();

    // No image, no WotC host: the symbols are a font.
    expect(row.querySelector('img')).toBeNull();
    expect(row.innerHTML).not.toContain('scryfall');
    // Bigger, and the grouping is drawn as well as grouped: the gap between
    // blocks is the second signal, and jsdom computes no cascade, so the
    // declaration is the assertion.
    expect(SCREENS_CSS).toMatch(/\.lobby__block \{[^}]*font-size: 2rem;/);
    expect(SCREENS_CSS).toMatch(/\.lobby__sets \{[^}]*gap: 6px 26px;/);
  });

  it('follows the pool the leader moves it to, and NPH joins its own block', async () => {
    await mountRoom({ players: [], matchId: null, format: FORMATS[0].id });
    await screen.findByTestId('pool-sets');

    await pickPool(FORMATS[1].id);
    await waitFor(() => expect(screen.getByTestId('pool-sets').dataset.sets).toBe(FORMATS[1].sets.join(' ')));
    // NPH is Scars of Mirrodin's third set, so the new era grows a group rather
    // than gaining a loose glyph on the end.
    expect(blocks()).toEqual([
      ['zen', 'ZEN WWK ROE'],
      ['som', 'SOM MBS NPH'],
      ['lea', 'M11'],
    ]);
    expect(screen.getByTestId('pool-sets').querySelector('[data-set="NPH"]')).not.toBeNull();
    expect(screen.getByTestId('pool-sets').textContent).toBe('');
  });

  it('puts a set it has no block for in a group of its own, at the end', async () => {
    // The map is twelve frozen codes. A thirteenth must still DRAW — a pool that
    // silently lost a set would be worse than one with an odd-looking group.
    expect(groupSetsByBlock(['ISD', 'RTR', 'M13', 'AVR'])).toEqual([
      { block: 'Innistrad', blockCode: 'isd', codes: ['ISD', 'AVR'] },
      { block: 'Core Set', blockCode: 'lea', codes: ['M13'] },
      { block: 'Other sets', blockCode: 'other', codes: ['RTR'] },
    ]);
    // And the twelve the eras are actually made of are four groups, no strays.
    expect(
      groupSetsByBlock(['ZEN', 'WWK', 'ROE', 'M11', 'SOM', 'MBS', 'NPH', 'M12', 'ISD', 'DKA', 'AVR', 'M13']).map(
        (g) => g.blockCode,
      ),
    ).toEqual(['zen', 'som', 'isd', 'lea']);
  });
});

/* ── the format tab selector (wave 48 §U) ─────────────────────────────── */

describe('erasOf: a tab shows only its own family\'s eras, newest year first', () => {
  const era = (id: string, family: TableFormat['family']): TableFormat => ({
    id,
    name: id,
    effective: id,
    sets: [],
    banned: [],
    cardCount: 0,
    source: 'x',
    family,
  });

  const mixed: TableFormat[] = [
    era('2012-07-13', 'standard'),
    era('2014-07-18', 'standard'),
    era('modern-2012-07-13', 'modern'),
    era('modern-2014-07-18', 'modern'),
    era('legacy-2016-07-22', 'legacy'),
    { ...era('draft:cube-1', 'standard'), source: 'draft' },
  ];

  it('narrows to the chosen family, drops drafted pools, newest year first', () => {
    expect(erasOf(mixed, 'standard').map((f) => f.id)).toEqual(['2014-07-18', '2012-07-13']);
    expect(erasOf(mixed, 'modern').map((f) => f.id)).toEqual(['modern-2014-07-18', 'modern-2012-07-13']);
    expect(erasOf(mixed, 'legacy').map((f) => f.id)).toEqual(['legacy-2016-07-22']);
  });

  it('a family with no eras in this room answers an empty list, not a crash', () => {
    expect(erasOf(mixed, 'legacy').length).toBeGreaterThan(0);
    expect(erasOf([era('2012-07-13', 'standard')], 'legacy')).toEqual([]);
  });
});

/*
 * Found live (w48 §U, after T.landed): a leader browsing Legacy while the
 * room sits on a Standard era saw Legacy's NEWEST era drawn as already
 * selected by the browser's own `<select>` fallback (value matches no
 * option), and clicking that exact era sent nothing — the browser already
 * considered it chosen, so no `change` fired. `poolIsOnTab` is what the
 * `<select>` asks before deciding whether to show `poolId` or nothing.
 */
describe('poolIsOnTab: the select never lets the DOM invent a selection', () => {
  const era = (id: string, family: TableFormat['family']): TableFormat => ({
    id,
    name: id,
    effective: id,
    sets: [],
    banned: [],
    cardCount: 0,
    source: 'x',
    family,
  });
  const mixed: TableFormat[] = [
    era('2014-07-18', 'standard'),
    era('modern-2014-07-18', 'modern'),
    era('legacy-2016-07-22', 'legacy'),
    era('legacy-2012-07-13', 'legacy'),
  ];

  it('is true when the room’s own era is one of the tab’s options', () => {
    expect(poolIsOnTab(mixed, 'standard', '2014-07-18', null)).toBe(true);
    expect(poolIsOnTab(mixed, 'legacy', 'legacy-2016-07-22', null)).toBe(true);
  });

  it('is false while browsing a DIFFERENT family — even the tab’s own first (newest) era', () => {
    // The room is on the Standard era; browsing Legacy must not claim its
    // newest entry (the one a naive `<select>` would default-highlight).
    expect(poolIsOnTab(mixed, 'legacy', '2014-07-18', null)).toBe(false);
    expect(poolIsOnTab(mixed, 'modern', '2014-07-18', null)).toBe(false);
  });

  it('the draft tab is true only for the caller’s OWN pod, by id', () => {
    const withPod: TableFormat[] = [...mixed, { ...era('draft:cube-1', 'standard'), source: 'draft' }];
    expect(poolIsOnTab(withPod, 'draft', 'draft:cube-1', 'cube-1')).toBe(true);
    // Browsing "Drafted pool" while the room is on a frozen era: false.
    expect(poolIsOnTab(withPod, 'draft', '2014-07-18', null)).toBe(false);
  });
});

/**
 * A drafted deck against a friend, from the room screen.
 *
 * The server half is `apps/server/src/http/tables.test.ts` — that the room's pool
 * can BE a pod, that each seat is checked against its own 45, and that nobody can
 * load a deck from somebody else's pool. What this proves is the browser half:
 * the leader can pick a pod they drafted in, the deck dropdown then offers the
 * cards YOU drafted rather than the 60-card library, and what it sends is the
 * `.dck` of your own pool.
 *
 * The pool is 45 cards off the committed cube and it arrives the way it arrives
 * in production: over the pod's own socket, which this screen opens for a room on
 * a drafted pool precisely because being connected is what keeps your seat — and
 * therefore your pool — findable by the gate.
 */
describe('a room on a drafted pool', () => {
  const POD = 'amber-lantern-k7q4';
  const POOL: DraftCard[] = (poolJson as { cards: DraftCard[] }).cards
    .slice(0, 45)
    .map((card, i) => ({ ...card, cardId: `draft:${POD}/p${i}` }));

  /** A seat view carrying a finished pool, as `deck.test.ts` builds one. */
  function seatView(pool: DraftCard[]): DraftView {
    const opening = loadFixtures()[0] as DraftView;
    const viewer = opening.viewer;
    if (viewer.kind !== 'seat') throw new Error('the opening fixture is a seat view');
    return {
      ...opening,
      draftId: POD,
      seq: opening.seq + 100,
      seats: opening.seats.map((s) => (s.id === viewer.seatId ? { ...s, pickedCount: pool.length } : s)),
      viewer: { ...viewer, pack: [], pool },
    };
  }

  function makeSocket() {
    const handlers = new Map<string, ((payload: unknown) => void)[]>();
    return {
      fire(event: string, payload?: unknown) {
        act(() => {
          for (const h of handlers.get(event) ?? []) h(payload);
        });
      },
      make: (): DraftTransport => ({
        on(event, handler) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        emit() {},
        disconnect() {},
      }),
    };
  }

  async function mountPod(over: Partial<Table> = {}) {
    const server = stubServer({
      players: [],
      matchId: null,
      format: `draft:${POD}`,
      pods: [{ id: POD, cards: 45 }],
      ...over,
    });
    const socket = makeSocket();
    render(
      createElement(ConstructedScreen, {
        client: server.client,
        rooms: server.rooms,
        roomId: ROOM,
        pollMs: 10,
        makeTransport: socket.make,
      }),
    );
    await screen.findByTestId('room-players');
    return { server, socket };
  }

  it('offers the pods the caller drafted in, on their own tab, without making one the default era', async () => {
    await mountPod();
    const tabs = await screen.findByTestId('format-tabs');
    // The table is ON the pod, so the tab bar opens there — the same property
    // the old "pods come first" ordering protected, restated for tabs: a pod
    // must never become the pool a room opens on by accident.
    expect(within(tabs).getByTestId('format-tab-draft').getAttribute('aria-selected')).toBe('true');
    const select = screen.getByTestId('format') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([`draft:${POD}`]);
    expect(select.value).toBe(`draft:${POD}`);
    // The field says what kind of pool this is, rather than calling a cube Standard.
    expect(screen.getByLabelText('Drafted pool')).toBe(select);
    // A cube is not an era, so it draws no set symbols.
    expect(screen.queryByTestId('pool-sets')).toBeNull();

    // Switching tabs browses the eras without moving the room off its pod —
    // newest year first, so the reverse of FORMATS' own (oldest-first) order.
    // The room's actual pool (the pod) is not one of THIS tab's options, so a
    // hidden empty placeholder leads the list and the select reads as nothing
    // chosen — never the first real era shown as selected by DOM fallback.
    fireEvent.click(within(tabs).getByTestId('format-tab-standard'));
    expect([...select.options].map((o) => o.value)).toEqual(['', ...[...FORMATS].reverse().map((f) => f.id)]);
    expect(select.value).toBe('');
  });

  it('offers YOUR drafted cards as the deck, and sends the .dck of your own pool', async () => {
    const { server, socket } = await mountPod();
    // Until the pod answers, there is nothing to offer and the screen says why.
    expect(screen.getByTestId('deck-mine').getAttribute('aria-disabled')).toBe('true');
    expect((await screen.findByTestId('drafted-waiting')).textContent).toContain(POD);

    socket.fire(DRAFT_CHANNEL.serverToClient, stateMessage(seatView(POOL), { name: 'Test Cube', size: 540 }));

    await deckPicker();
    // One row, and it is the cards you drafted — not the 60-card library, which
    // no cube pool holds.
    expect(offered()).toEqual([DRAFTED_DECK]);
    // The row says how big the deck it would load is; its colours are pips beside
    // that rather than letters in it. `pool.json`'s first 45 cards are the cube's
    // white section, so `W` — and the basics `draftedDeckOf` adds are Plains for
    // the same reason (wave 27 §D).
    const drafted = deckRow(DRAFTED_DECK);
    expect(rowName(drafted)).toBe(`Your drafted pool — ${45 + DRAFTED_BASICS} cards`);
    expect(drafted.dataset['colors']).toBe('W');
    expect(within(drafted).getByTestId('deck-colors').dataset['colors']).toBe('W');
    // A drafted card carries its own Scryfall id, so the art rule needs no lookup
    // table here: the most expensive card in the 45 is what the row draws.
    expect(drafted.querySelector('img')?.getAttribute('src')).toMatch(/^https:\/\//);
    // And the library sweep never ran: a drafted pool asks the gate nothing.
    expect(sweeps(server)).toEqual([]);

    await pick(DRAFTED_DECK);

    // What went to the server is a `.dck`, and it is the deck this screen built
    // out of the pool the pod answered with — byte for byte, the same writer
    // `#/deck/<podId>` uses.
    const sent = lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body as { deck: { dck: string } };
    expect(sent.deck.dck).toBe(dckTextOf(draftedDeckOf(POD, POOL)));
    expect(server.draftedText()).toBe(sent.deck.dck);
    // Parsed back by the real parser: every drafted card is in the maindeck, and
    // so are the basics (`toDeckFile` merges the pile in on export).
    const parsed = deckFromDeckFile(parseDck(sent.deck.dck));
    expect(parsed.main.reduce((n, e) => n + e.count, 0)).toBe(45 + DRAFTED_BASICS);
    expect(parsed.sideboard).toEqual([]);

    // The verdict the server took is in YOUR pool, and it says so.
    await waitFor(() => expect(screen.getByTestId('room-seat-0-rules').textContent).toBe(`your pool from ${POD}`));
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false));
  });

  /**
   * A member of the room who has no seat in the pod is told so, rather than shown
   * an empty dropdown. Two different things to a person — "you drafted elsewhere"
   * and "you are not in this pod" — and a pool is hidden information, so the
   * server tells you about your own seat and nobody else's.
   */
  it('says you have no seat in the pod rather than offering nothing', async () => {
    const { socket } = await mountPod({ pods: [] });
    socket.fire(
      DRAFT_CHANNEL.serverToClient,
      stateMessage({ ...seatView(POOL), viewer: { kind: 'spectator' } }, { name: 'Test Cube', size: 540 }),
    );
    const note = await screen.findByTestId('drafted-none');
    expect(note.textContent).toContain(POD);
    // No rows at all — and `Random` is still there, with nothing to roll.
    expect(offered()).toEqual([]);
    expect(screen.getByTestId('deck-random')).toBeTruthy();
  });
});

/**
 * The auto-build, on its own: the room screen has a dropdown, not a builder, so
 * "the cards I drafted" has to be one deck and it has to be playable.
 */
describe('draftedDeckOf', () => {
  const POD = 'amber-lantern-k7q4';
  const POOL: DraftCard[] = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45);

  it('plays every drafted card and exactly DRAFTED_BASICS basics', () => {
    const deckBuilt = draftedDeckOf(POD, POOL);
    // Everything drafted is played, and nothing else can be: `newDeck` opens with
    // the pool sideboarded and only `moveToMain` moves anything.
    expect(deckBuilt.main.reduce((n, e) => n + e.count, 0)).toBe(45);
    expect(deckBuilt.sideboard).toEqual([]);
    // The lands, split by the maindeck's own pips — largest remainder, so the
    // total is the number it says and not 16 or 18.
    expect(deckBuilt.basics.reduce((n, e) => n + e.count, 0)).toBe(DRAFTED_BASICS);
    expect(mainDeckSize(deckBuilt)).toBe(45 + DRAFTED_BASICS);
    for (const entry of deckBuilt.basics) expect(BASIC_LAND_NAMES).toContain(entry.card.name);
  });

  it('adds no basics to a pool that asks for no colour', () => {
    const colourless = POOL.map((card) => ({ ...card, manaCost: [] as string[] }));
    const deckBuilt = draftedDeckOf(POD, colourless);
    expect(deckBuilt.basics).toEqual([]);
    // Still a legal limited maindeck: 45 is over the floor on its own.
    expect(mainDeckSize(deckBuilt)).toBe(45);
  });
});

/*
 * The deck dropdown shows its colours — wave 27 §D, and the other half of the
 * operator's wave-26 ask: *"decks should have their corresponding mana
 * symbols."*
 *
 * ## Real decklists, because a deck's colours are a fold over its own card list
 *
 * Every other suite in this file offers `DECKS`, whose maindeck is one line of
 * sixty Islands — enough to prove a `PUT` went out, useless for a colour. So
 * this one hands the stub the REAL `.dck` files, read off disk exactly as the
 * server reads them, and the two decks are the two `DeckView.test.ts` chose for
 * the two facts that are hard:
 *
 *   - **Matthew Costa's UW Delver** is two colours, and its white is four
 *     Geists of Saint Traft — while it also plays two Gut Shots, which Scryfall
 *     calls red and which cost `{R/P}`. Two pips, not three.
 *   - **Nick Marriott's Mono Green Infect** is one colour, and five of its
 *     cards (Gut Shot, Mental Misstep, Apostle's Blessing, Gitaxian Probe,
 *     Mutagenic Growth) are not green. One pip, not four.
 *
 * ## What "one fold" means here, and why it is asserted rather than trusted
 *
 * The screen never folds anything itself: it calls `DeckView.tsx`'s
 * `deckColorsByName` against `@hadoku/deck/library`'s `LIBRARY_CARD_COSTS`. So
 * the risk is not a wrong fold, it is a wrong MAP — a shipped slice that has
 * drifted from `decks/pools/*.generated.json` would colour a deck differently
 * here than `DeckView` colours it, which is exactly the disagreement wave 26
 * exported one fold to prevent. Each case therefore recomputes the answer from
 * the frozen pool's own `manaCost` and asserts the dropdown matches it.
 * (`packages/deck`'s `library.test.ts` guards the map itself, byte for byte.)
 */

/* ── real library decks, shared by the two suites that need one ─────────── */

/*
 * Every other suite here offers `DECKS`, whose maindeck is one line of sixty
 * Islands — enough to prove a `PUT` went out, useless for a colour and useless
 * for a deck's art, both of which are folds over a real card list. So these read
 * the real `.dck` files off disk exactly as the server reads them.
 */
/** `apps/ui/src/screens` → the repo root, as `DeckView.test.ts` does it. */
const ROOT = resolve(import.meta.dirname ?? 'apps/ui/src/screens', '..', '..', '..', '..');
const readRepo = (repoPath: string): string => readFileSync(resolve(ROOT, repoPath), 'utf8');

const collectionOf = (id: string): LibraryCollection => {
  const found = LIBRARY.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no collection ${id}`);
  return found;
};

/** A real library deck, in the shape `GET /tables/decks` sends it. */
function realDeck(collectionId: string, file: string): TableDeck {
  const collection = collectionOf(collectionId);
  const entry = collection.decks.find((d) => d.file === file);
  if (entry === undefined) throw new Error(`no ${file} in ${collectionId}`);
  const parsed = parseDck(readRepo(deckPath(collection, entry)));
  // Every library deck names itself — `library.test.ts` refuses one that does
  // not — so a null here is a broken file, not a case to tolerate.
  if (parsed.name === null) throw new Error(`${file} has no [metadata] Name`);
  const lines = (section: string) =>
    (parsed.sections.get(section) ?? []).map((e) => ({ count: e.count, name: e.card.name }));
  return {
    id: entry.id,
    collection: collection.id,
    name: parsed.name,
    format: collection.format,
    date: collection.date,
    provenance: 'Transcribed from mtgtop8.',
    citation: collection.source,
    main: lines('main'),
    sideboard: lines('sideboard'),
  };
}

const UW_DELVER = realDeck('power-summer-2012', '1-todd-anderson-uw-delver.dck');
const MONO_GREEN = realDeck('power-summer-2012', '1-cj-steele-infect.dck');

/**
 * A name long enough to wrap past two lines — the case the clamp exists for.
 * Sixty Islands, like {@link DECKS}: this fixture is about the NAME, not the
 * colours, and a basic-land maindeck is legal everywhere this suite mounts it.
 */
const LONG_NAME_DECK = deck(
  'deck-with-an-unreasonably-long-name',
  'The Collected Works of a Pilot Who Could Not Settle on a Shorter Title for This Deck',
);

describe('the deck dropdown shows its colours', () => {

  /** The same answer, from the frozen pool rather than from the shipped slice. */
  function fromTheFixture(deck: TableDeck): string {
    const fixture = JSON.parse(readRepo(poolFixturePath(deck.date))) as {
      manaCost: Record<string, string>;
    };
    return deckColorsByName(
      deck.main.map((l) => l.name),
      fixture.manaCost,
    ).join('');
  }

  async function mountWithRealDecks(): Promise<HTMLElement> {
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, MONO_GREEN] });
    return deckPicker();
  }

  /**
   * The CHOSEN deck's pips: one `<span data-color>` per colour, in WUBRG order,
   * read off its own row. There used to be a second copy beside the control; the
   * operator called it "extra mana symbols at the bottom that are unecessary"
   * (2026-09-30), and the row already draws the same fold.
   */
  const chosenRow = (): HTMLElement => {
    const row = document.querySelector<HTMLElement>('[data-testid="deck-option"][aria-checked="true"]');
    if (row === null) throw new Error('no deck is chosen');
    return row;
  };
  const pips = (): { color: string; glyph: string }[] =>
    [...chosenRow().querySelectorAll('.deckcolors__pip')].map((el) => ({
      color: el.getAttribute('data-color') ?? '',
      glyph: el.querySelector('i')?.className ?? '',
    }));

  it('a two-colour deck carries two colours, and a mono-colour deck one', async () => {
    await mountWithRealDecks();

    const two = deckRow(UW_DELVER.id);
    expect(two.dataset['colors']).toBe('WU');
    // The row's own visible text is the deck's NAME and nothing else: the ` · WU`
    // suffix the `<option>` needed is gone, because the row draws real pips.
    expect(rowName(two)).toBe(UW_DELVER.name);
    expect(two.textContent).toBe(UW_DELVER.name);
    expect(within(two).getByTestId('deck-colors').dataset['colors']).toBe('WU');

    const one = deckRow(MONO_GREEN.id);
    expect(one.dataset['colors']).toBe('G');
    expect(rowName(one)).toBe(MONO_GREEN.name);
    expect(within(one).getByTestId('deck-colors').dataset['colors']).toBe('G');

    // Not a second fold, and not a second map: the shipped slice the screen
    // reads and the frozen pool it was cut from say the same thing, through the
    // same exported fold.
    const byMap = (d: TableDeck) =>
      deckColorsByName(
        d.main.map((l) => l.name),
        LIBRARY_CARD_COSTS,
      ).join('');
    expect(byMap(UW_DELVER)).toBe('WU');
    expect(byMap(MONO_GREEN)).toBe('G');
    expect(fromTheFixture(UW_DELVER)).toBe('WU');
    expect(fromTheFixture(MONO_GREEN)).toBe('G');
  });

  it('draws them as the D20 font pips, two for the two-colour deck and one for the mono', async () => {
    await mountWithRealDecks();
    // Nothing chosen yet, and the duplicate colour row is gone for good.
    expect(document.querySelector('[data-testid="deck-option"][aria-checked="true"]')).toBeNull();
    expect(screen.queryByTestId('deck-mine-colors')).toBeNull();

    await pick(UW_DELVER.id);
    expect(pips()).toEqual([
      { color: 'W', glyph: 'ms ms-w ms-cost' },
      { color: 'U', glyph: 'ms ms-u ms-cost' },
    ]);

    await pick(MONO_GREEN.id);
    expect(pips()).toEqual([{ color: 'G', glyph: 'ms ms-g ms-cost' }]);
  });

  it('names the colours for a reader, because colour is never the only signal', async () => {
    await mountWithRealDecks();
    await pick(UW_DELVER.id);
    // Two accessible names now, and neither is a colour: the chosen deck's line
    // beside the control, and the row's own pips. The ` · WU` letters the
    // `<option>` had to carry are gone — a `::before` glyph could not live in one,
    // and it can live in a row.
    expect(screen.queryByTestId('deck-mine-colors')).toBeNull();
    expect(
      within(deckRow(UW_DELVER.id)).getByLabelText(`${UW_DELVER.name}: W U`),
    ).toBeTruthy();
  });

  it('a deck with no coloured card in it says colourless rather than nothing', async () => {
    // `DECKS`' stand-in plays sixty Islands, which is the real shape of this
    // case: a land contributes no cost, and absence from the map is what
    // `deckColorsByName` reads as "no coloured pip".
    await mountRoom({ players: [], matchId: null });
    await deckPicker();
    expect(deckRow(UG_POLYMORPH).dataset['colors']).toBe('');
    expect(rowName(deckRow(UG_POLYMORPH))).toBe('UG Polymorph (Antoine Ruel)');
    // A colourless deck's row says the word rather than drawing nothing.
    expect(within(deckRow(UG_POLYMORPH)).getByTestId('deck-colors').textContent).toBe('colourless');
    await pick(UG_POLYMORPH);
    expect(pips()).toEqual([]);
    expect(within(chosenRow()).getByTestId('deck-colors').textContent).toBe('colourless');
  });
});

/* ── the deck section's order, and what it no longer says (2026-09-30) ──── */

describe('Ready and Random come before the deck list, and the era note is not printed', () => {
  it('puts Ready and Random ABOVE the list of decks', async () => {
    await mountRoom({ players: [], matchId: null });
    const list = await deckPicker();
    const ready = screen.getByTestId('ready-toggle');
    const random = screen.getByTestId('deck-random');
    // DOCUMENT_POSITION_FOLLOWING (4): the list comes after each button.
    expect(ready.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(random.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Random is an action, not one of the deck radios.
    expect(list.contains(random)).toBe(false);
  });

  it('does not print which era a deck was built for', async () => {
    // BANNED carries the server's era note (`libraryPoolMismatch`): "deck X is
    // built for Standard (M11) as of …, but the pool supplied is …". It is not a
    // fault in the deck, and the operator called it useless. The findings stay.
    await mountRoom({ players: [], matchId: null });
    await pick(UG_POLYMORPH);
    await pickPool('2011-07-15');
    const verdict = await screen.findByTestId('verdict-mine');
    expect(verdict.textContent).toContain('Jace, the Mind Sculptor');
    expect(verdict.textContent).not.toContain('built for');
  });
});

/* ── the deck chooser is not a dropdown (wave 28 §C, item 2) ────────────── */

/**
 * *"the deck chooser dropdown is very ugly, needs a complete redesign. it should
 * have a partial art that represents the deck and the two colored symbols. we
 * cannot use a standard dropdown for this."*
 *
 * Three things have to be true at once, and each one alone is a broken control:
 * the rows have to SHOW something (art, colours, name), the control has to say
 * which deck is chosen, and it has to be operable without a mouse. Replacing a
 * `<select>` with divs loses the last two silently, which is why they are asserted
 * here rather than looked at once.
 *
 * Asserted on what a browser would paint — the glyph classes the fonts define and
 * the URL an `<img>` would fetch — not on the presence of a node. That is the
 * lesson the old `<option>` comment leaves behind, and it outlived the dropdown.
 */
describe('the deck chooser', () => {
  async function mountChooser(): Promise<HTMLElement> {
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, MONO_GREEN] });
    return deckPicker();
  }

  const rows = (): HTMLElement[] => [
    ...screen.getByTestId('deck-mine').querySelectorAll<HTMLElement>('[data-testid="deck-option"]'),
  ];

  it('is not a select, and draws one card-like row per legal deck', async () => {
    const group = await mountChooser();

    // Not a dropdown, and not divs pretending: a radio group of real buttons, so
    // Space and Enter activate a row without a key handler of ours.
    expect(group.tagName).toBe('DIV');
    expect(group.getAttribute('role')).toBe('radiogroup');
    // No dropdown INSIDE it either — the pool's own `<select>` is still on the
    // card and is a different control.
    expect(group.querySelectorAll('select, option')).toHaveLength(0);
    expect(offered()).toEqual([UW_DELVER.id, MONO_GREEN.id]);
    for (const row of rows()) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.getAttribute('type')).toBe('button');
      expect(row.getAttribute('role')).toBe('radio');
    }

    // Each row paints the three things the operator asked for: the deck's name,
    // its colours as REAL glyphs (which an `<option>` could not hold), and a slice
    // of art. The pip classes are the font's own, asserted as classes because that
    // is what decides whether a browser draws a symbol or nothing.
    const uw = deckRow(UW_DELVER.id);
    expect(rowName(uw)).toBe(UW_DELVER.name);
    expect(
      [...uw.querySelectorAll('.deckcolors__pip i')].map((i) => i.className),
    ).toEqual(['ms ms-w ms-cost', 'ms ms-u ms-cost']);
    expect([...deckRow(MONO_GREEN.id).querySelectorAll('.deckcolors__pip i')].map((i) => i.className)).toEqual([
      'ms ms-g ms-cost',
    ]);

    // The art is a LOOKUP: the id the rule chose, resolved by the one function in
    // this app that builds an image URL. Asserting the exact URL it composes is
    // what proves no second path was invented — and the host is whichever
    // `@hadoku/carddata/art` allows, never one written down here.
    const geist = (ART_IDS as { ids: Record<string, string> }).ids['Geist of Saint Traft'];
    expect(geist).toBeDefined();
    const src = uw.querySelector('img')?.getAttribute('src');
    expect(src).toBe(cardImageUrl(geist));
    expect(ALLOWED_ART_HOSTS.some((host) => (src ?? '').startsWith(host))).toBe(true);
    // Decorative: the row's accessible name is the DECK's, not the card's.
    expect(uw.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(uw.textContent).not.toContain('Geist of Saint Traft');
  });

  it('says which deck is chosen, in the DOM and for a reader', async () => {
    const group = await mountChooser();
    // Nothing chosen: no row checked, and no row claiming to be.
    expect(group.dataset['chosen']).toBe('');
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false']);

    await pick(MONO_GREEN.id);

    expect(chosen()).toBe(MONO_GREEN.id);
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    // And a mark a person can see, because `aria-checked` paints nothing. Its own
    // colouring is not the only signal either — the chosen row is ringed.
    expect(deckRow(MONO_GREEN.id).querySelector('.deckpick__mark')?.textContent).toBe('chosen');
    expect(deckRow(UW_DELVER.id).querySelector('.deckpick__mark')).toBeNull();
    expect(SCREENS_CSS).toMatch(/\.deckpick__option\[aria-checked='true'\] \{[^}]*box-shadow: inset 0 0 0 2px/);
  });

  it('is operable by keyboard: one tab stop, arrows choose, and nothing wraps', async () => {
    const group = await mountChooser();

    // One row in the tab order, and before anything is chosen it is the first —
    // a group where every row is tabbable is a group you cannot tab out of.
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1]);

    // Down: the second deck is focused AND chosen, which is what a native
    // `<select>` did on the same key press.
    await act(async () => {
      fireEvent.keyDown(group, { key: 'ArrowDown' });
    });
    expect(document.activeElement).toBe(deckRow(MONO_GREEN.id));
    expect(chosen()).toBe(MONO_GREEN.id);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0]);

    // Up: back to the first.
    await act(async () => {
      fireEvent.keyDown(group, { key: 'ArrowUp' });
    });
    expect(document.activeElement).toBe(deckRow(UW_DELVER.id));
    expect(chosen()).toBe(UW_DELVER.id);

    // Up again at the top does NOT wrap onto the last deck. A `<select>` does not
    // wrap, and wrapping here would silently re-send a different deck.
    await act(async () => {
      fireEvent.keyDown(group, { key: 'ArrowUp' });
    });
    expect(chosen()).toBe(UW_DELVER.id);

    // End and Home reach the ends without visiting what is between them.
    await act(async () => {
      fireEvent.keyDown(group, { key: 'End' });
    });
    expect(chosen()).toBe(MONO_GREEN.id);
    await act(async () => {
      fireEvent.keyDown(group, { key: 'Home' });
    });
    expect(chosen()).toBe(UW_DELVER.id);

    // ArrowLeft/ArrowRight are the same two directions, for a grid that wraps to
    // rows on a narrow screen.
    await act(async () => {
      fireEvent.keyDown(group, { key: 'ArrowRight' });
    });
    expect(chosen()).toBe(MONO_GREEN.id);
    await act(async () => {
      fireEvent.keyDown(group, { key: 'ArrowLeft' });
    });
    expect(chosen()).toBe(UW_DELVER.id);

    // The keyboard is not a second, quieter path: choosing by key loaded the deck
    // through the same call a click makes, and the server answered a verdict.
    await waitFor(() => expect(screen.getByTestId('verdict-mine').textContent).toContain('Legal in'));
  });

  it('keeps the tab stop on the deck the server is already holding', async () => {
    // A roving tab stop that ignores the choice sends a keyboard user to one deck
    // while the screen says another is loaded. So until they move it themselves,
    // the stop IS the chosen row — including a choice that arrived from the room.
    await mountChooser();
    await pick(MONO_GREEN.id);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0]);
  });

  it('is dead until the pool answers, and says so where a test can read it', async () => {
    // `aria-disabled` rather than a `disabled` property, because the root is not a
    // form control any more — and Playwright's `toBeEnabled()` reads it, which is
    // what keeps the three e2e specs' wait meaningful after the re-aim.
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, MONO_GREEN] });
    const group = await screen.findByTestId('deck-mine');
    await deckPicker();
    expect(group.getAttribute('aria-disabled')).toBeNull();
    expect(rows()).toHaveLength(2);
    for (const row of rows()) expect((row as HTMLButtonElement).disabled).toBe(false);
  });

  it('Random is a button beside the decks, not a deck that can be chosen', async () => {
    await mountChooser();
    // It is not one of the rows, because it is not a state a deck can be in: it
    // resolves to one of them and the chooser then reads THAT deck.
    expect(offered()).not.toContain(RANDOM_DECK);
    const random = screen.getByTestId('deck-random');
    expect(random.getAttribute('role')).toBeNull();
    await act(async () => {
      fireEvent.click(random);
    });
    expect([UW_DELVER.id, MONO_GREEN.id]).toContain(chosen());
  });

  it('gives every box the same size, whatever text is in it', async () => {
    // One grid track height for every row, and the item stretched to fill it —
    // this is what makes a short name's box and a long name's box come out the
    // same height; `boxes.md` (real Playwright, a built page) has the proof that
    // a browser actually lays it out this way.
    expect(SCREENS_CSS).toMatch(/\.deckpick \{[^}]*grid-auto-rows: 190px;/);
    expect(SCREENS_CSS).toMatch(/\.deckpick \{[^}]*align-items: stretch;/);
    expect(SCREENS_CSS).toMatch(/\.deckpick__option \{[^}]*height: 100%;/);

    // The clamp: without it a long name would still wrap past the fixed track
    // and get cut off by `.deckpick__option`'s own `overflow: hidden` instead of
    // ending in an ellipsis after two lines.
    expect(SCREENS_CSS).toMatch(/\.deckpick__name \{[^}]*-webkit-line-clamp: 2;/);
    expect(SCREENS_CSS).toMatch(/\.deckpick__name \{[^}]*text-overflow: ellipsis;/);

    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, LONG_NAME_DECK] });
    await deckPicker();

    // The clamp hides the overflow visually, but the full name is still there —
    // on the element's `title`, so a reader (and a mouse hover) still gets it.
    const short = deckRow(UW_DELVER.id).querySelector('.deckpick__name');
    const long = deckRow(LONG_NAME_DECK.id).querySelector('.deckpick__name');
    expect(short?.getAttribute('title')).toBe(UW_DELVER.name);
    expect(long?.getAttribute('title')).toBe(LONG_NAME_DECK.name);
    expect(long?.textContent).toBe(LONG_NAME_DECK.name);
  });
});

/**
 * The art rule, on its own: the most expensive card the deck plays.
 *
 * A deck has no art of its own, so the rule is a decision and the decision is
 * testable without a screen. Its consequence on real lists is what matters —
 * these are the cards the decks are NAMED after, which is the whole reason the
 * rule is "most expensive" and not "first non-land".
 */
describe('which card’s art stands for a deck', () => {
  it('reads a Scryfall cost string the way Scryfall counts it', () => {
    expect(manaValueOf('{3}{G}{G}')).toBe(5);
    expect(manaValueOf('{1}')).toBe(1);
    // Twobrid pays the generic half; Phyrexian and hybrid are one mana each.
    expect(manaValueOf('{2/W}')).toBe(2);
    expect(manaValueOf('{R/P}')).toBe(1);
    expect(manaValueOf('{W/U}{W/U}')).toBe(2);
    // X is zero on the stack-independent count, which is Scryfall's `cmc`.
    expect(manaValueOf('{X}{R}')).toBe(1);
    // A land has no cost string at all, which is how a land is excluded.
    expect(manaValueOf('')).toBe(0);
  });

  it('picks the card each real deck is named after', () => {
    // `LIBRARY_CARD_COSTS` has no land in it, so the lands in these lists cannot
    // win — and every id resolves through the committed table the play board uses.
    const pickFor = (deck: TableDeck): string => {
      const best = deck.main
        .flatMap((line) => {
          const cost = LIBRARY_CARD_COSTS[line.name];
          return cost === undefined ? [] : [{ name: line.name, count: line.count, value: manaValueOf(cost) }];
        })
        .sort((a, b) => b.value - a.value || b.count - a.count || (a.name < b.name ? -1 : 1))[0];
      return best?.name ?? '';
    };
    expect(pickFor(UW_DELVER)).toBe('Geist of Saint Traft');
    expect(pickFor(MONO_GREEN)).toBe('Wild Defiance');
  });
});
