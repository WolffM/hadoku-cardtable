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

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { forgetMatchesFollowed } from '../play/live/matchStart.ts';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Tournament mode's own pod seat actions and table-starting — `pod/client.ts`'s
 * `sitPod`/`aiPod`/`closePod`/`standPod`/`startMyTable`, which hit the real
 * global `fetch` directly rather than this file's injectable `fetchImpl`
 * (`DraftLobby.test.ts`'s own header explains why; same reason, same fix).
 */
const { sitPod, aiPod, closePod, standPod, startMyTable } = vi.hoisted(() => ({
  sitPod: vi.fn(),
  aiPod: vi.fn(),
  closePod: vi.fn(),
  standPod: vi.fn(),
  startMyTable: vi.fn(),
}));
// The REST of the module (`usePodContext`, `playPod`, `startTableMatch`, …)
// is PodScreen.tsx's own real implementation — this file also renders a
// draft room's pod, which needs it; only these five are stubbed.
vi.mock('./pod/client.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sitPod,
  aiPod,
  closePod,
  standPod,
  startMyTable,
}));

import type { DraftCard, GauntletView, RoomMode } from '@hadoku/shared';
import { parseDck } from '@hadoku/carddata/dck';
import { BASIC_LAND_NAMES, deckColorsByName, mainDeckSize } from '@hadoku/deck';
import {
  LIBRARY,
  LIBRARY_ARCHETYPE_KEY,
  LIBRARY_CARD_COSTS,
  LIBRARY_DECK_STYLES,
  LIBRARY_PILOT_KEY,
  deckPath,
  formatIdOf,
  poolFixturePath,
  type LibraryCollection,
} from '@hadoku/deck/library';

import {
  ConstructedScreen,
  DRAFTED_BASICS,
  draftedDeckOf,
  openDraftedDeck,
  groupSetsByBlock,
  manaValueOf,
} from './ConstructedScreen.tsx';
import { ALLOWED_ART_HOSTS } from '@hadoku/carddata/art';
import ART_IDS from '../draft/art-ids.json';
import DECK_ART_TRAITS from '../draft/deck-art-traits.json';
import { artScore, assignDeckArt, rankDeckArt, traitsOfDraftCard } from './deckArt.ts';
import { cardImageUrl } from '../draft/cardImage.ts';
import { PEEK_DELAY_MS, PEEK_GRACE_MS } from './DeckPeek.tsx';
import type { DeckRecords } from '../stats/deckOrder.ts';
import { parseRoute } from './route.ts';
import { TITLE_MS } from './gauntlet/reveal.ts';
import poolJson from '../draft/pool.json';
import { dckTextOf, deckFromPool } from '../draft/deckFromPool.ts';
import { cardIndex, suggestBasics } from '../deck/build.ts';
import type { MyDeck, MyDecksClient } from '../deck/myDecks.ts';
import { roomsClient, type ClientMode, type RoomView } from '../rooms/api.ts';
import { takeWarmRoom, warmRoom } from '../rooms/warm.ts';
import type { RoomFeed } from '../rooms/feed.ts';
import {
  RANDOM_DECK,
  erasOf,
  poolIsOnTab,
  tablesClient,
  type DeckRef,
  type RoomPlayer,
  type SeatChoice,
  type SeatDeck,
  type TableDeck,
  type TableFormat,
  type Verdict,
} from './tables.ts';
import { apiBase, type Fetch } from '../http.ts';

beforeEach(() => {
  sitPod.mockResolvedValue({ ok: true, message: null });
  aiPod.mockResolvedValue({ ok: true, message: null });
  closePod.mockResolvedValue({ ok: true, message: null });
  standPod.mockResolvedValue({ ok: true, message: null });
  startMyTable.mockResolvedValue({ ok: true, matchId: null });
});

afterEach(() => {
  forgetMatchesFollowed();
  cleanup();
  globalThis.location.hash = '';
  vi.clearAllMocks();
});

const SCREENS_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/screens', 'screens.css'), 'utf8');

/**
 * `screens.css` on the document for this test, and a reader of what the cascade
 * gives a rendered element — so "colour is not the only signal" is asserted on
 * the pills actually drawn. jsdom resolves the cascade but lays nothing out.
 */
function styled(): (el: Element, property: string) => string {
  const sheet = document.createElement('style');
  sheet.textContent = SCREENS_CSS;
  document.head.append(sheet);
  onTestFinished(() => sheet.remove());
  return (el, property) => getComputedStyle(el).getPropertyValue(property).trim();
}


/** Every pill state on the page, by the border it is drawn with: a second signal besides its colour. */
function pillBorders(css: (el: Element, property: string) => string): Map<string, string> {
  return new Map([...document.querySelectorAll<HTMLElement>('.pill[data-state]')].map((p) => [p.dataset.state!, css(p, 'border-style')]));
}

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
/** A Modern era: forty-odd sets behind one date, the shape the set strip is NOT drawn for. */
/** Free pick's row, as the server sends it: a name, and a `family` nobody reads. */
const FREE = { id: 'free', name: 'Free pick', effective: '', sets: [], banned: [], cardCount: 0, source: 'free', family: 'standard' as const };
const MODERN = { id: 'modern-2014-07-18', name: 'Modern (M15)', effective: '2014-07-18', sets: ['ZEN', 'WWK', 'ROE', 'M11', 'SOM', 'MBS'], banned: [], cardCount: 1477, source: 'x', family: 'modern' as const };


const deck = (id: string, archetype: string, pilot: string) => ({
  id,
  collection: 'power-summer-2010',
  era: '2010-07-16',
  name: `${archetype} (${pilot})`,
  archetype,
  pilot,
  format: 'Standard (M11)',
  date: '2010-07-16',
  provenance: `Championnat de France 2010: ${pilot}, ${archetype}`,
  citation: 'https://www.mtgtop8.com/event?e=459&f=ST',
  main: [{ count: 60, name: 'Island' }],
  sideboard: [{ count: 15, name: 'Plains' }],
});

const UG_POLYMORPH = 'power-2010-3-antoine-ruel-ug-polymorph';
const SECOND_DECK = 'power-2010-1-emanuele-giusti-jund';
const DECKS = [deck(UG_POLYMORPH, 'UG Polymorph', 'Antoine Ruel'), deck(SECOND_DECK, 'Jund', 'Emanuele Giusti')];

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
    ready: false,
    ...over,
  };
}

/** My own seat, holding a deck: the one row the server tells me a deck for. */
function mySeat(deck: Partial<SeatDeck> = {}): RoomPlayer {
  return {
    seat: 0,
    name: 'user-alice',
    you: true,
    ready: false,
    deck: {
      name: 'Jund (Emanuele Giusti)',
      rulesName: 'Standard (M11)',
      legal: true,
      issueCount: 0,
      choice: { deck: { library: SECOND_DECK }, rules: { kind: 'standard', format: '2010-07-16' } },
      ...deck,
    },
  };
}

interface Table {
  players: RoomPlayer[];
  matchId: string | null;
  /** `room.locked`: both ready or a match live — the server refuses a stand-up (2026-10-12). */
  locked?: boolean;
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
  /** `RoomView.settings`. Absent ⇒ the server's default: hand smoothing on, tournament off, decks locked. */
  settings?: { handSmoothing?: boolean; tournament?: boolean; tournamentDecks?: 'locked' | 'per-round' };
  /**
   * The room's own table record (wave 71 §D's wire shape) — `@hadoku/shared`'s
   * `RoomView.tables[0]`. Absent ⇒ a fresh `seating` series, no games yet.
   */
  series?: { length: 1 | 3; wins: [number, number]; games: { matchId: string; winner: 0 | 1 | null }[]; phase: 'seating' | 'playing' | 'sideboarding' | 'between' | 'done' };
  /** `PATCH /api/rooms/:id` refuses with this, as it does for a non-leader. */
  refusePatch?: { status: number; error: string };
  /** The room's mode with its options; null until the leader picks one. Absent ⇒ Classic, which is every test above. */
  mode?: RoomMode | null;
  /** A Gauntlet room's view, as `GET …/gauntlet` answers it. Absent ⇒ undrawn, nobody ready. */
  gauntlet?: GauntletView;
  /** What `GET /api/rooms/:id` says this room is. Absent ⇒ the field is not sent at all. */
  clientMode?: ClientMode;
  /** What the room PLAYS. Absent ⇒ `constructed-1v1`, which is every test above. */
  gameType?: string;
  /** Set once the server has dealt a draft room's pod. */
  draftStartedAt?: string | null;
  /** Who the ROOM says is in it — a streamed room's seats come from here. */
  members?: { id: string; name: string; ready?: boolean; avatarId?: string }[];
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
  /** A start the server refuses — e.g. the other player un-readied between reads. */
  refuseStart?: { status: number; error: string };
  /** A start that answers only once this settles — Forge coming up. */
  holdStart?: Promise<void>;
  /**
   * What `GET /tables/decks` offers. Absent ⇒ {@link DECKS}, the two Paris rows
   * every other suite uses.
   *
   * Overridden by the colours suite, which needs the REAL decklists: a deck's
   * colours are a fold over its own card list, and `DECKS`' one-line stand-ins
   * play sixty Islands.
   */
  decks?: TableDeck[];
  /** `GET /tables/decks` answers only once a room read has, as on a reload where the room is quicker. */
  catalogueAfterRoom?: boolean;
  /** `RoomView.pod` — a draft room's pod, or (tournament mode) a constructed one. Absent ⇒ `null`. */
  pod?: unknown;
  /** What `GET /api/decks` answers — Free pick's "My decks". Absent ⇒ none; a promise ⇒ answers when it settles. */
  myDecks?: MyDeck[] | Promise<MyDeck[]>;
  /**
   * Further `RoomView.tables` entries beside the one every other field here
   * builds (`t-stub0001`) — a tournament round's OWN table, distinct from
   * the room's stale default one, so a test can tell "the screen read MY
   * table" from "the screen read `tables[0]`" (a real run, 2026-10-22:
   * exactly the production bug this proves against).
   */
  extraTables?: { id: string; players: { memberId: string; name: string }[]; matchId: string | null; series?: Table['series'] }[];
}

/**
 * A room server that holds state: loading a deck checks it, readying is
 * refused while it is illegal, and `{ room }` starts one match.
 */
/** A Gauntlet nobody has readied, as the server answers it before the draw; I sit at seat 0. */
const gauntletOf = (table: Table): GauntletView =>
  table.gauntlet ?? { phase: 'options', you: 0, players: null, ready: [false, false], era: null, revealAt: null, first: null, decks: [], step: null, games: [], choice: null, winner: null };

function stubServer(table: Table) {
  const calls: Call[] = [];
  const records = new Map<string, { games: number; wins: number; losses: number; draws: number }>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /** What the room plays now: the leader's `{ gameType }` PATCH moves it. */
  const gameType = () => table.gameType ?? 'constructed-1v1';
  /** The library this table's server has. See `Table.decks`. */
  const decks = (): TableDeck[] => table.decks ?? DECKS;
  table.format ??= FORMATS[0].id;
  const iAmLeader = () => table.leader !== false;
  const view = () => ({
    room: { id: ROOM, name: 'Friday night', gameType: gameType(), matchId: table.matchId, seats: 2, locked: table.locked === true || table.matchId !== null },
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
    gameType: gameType(),
    format: table.format,
    settings: { handSmoothing: true, tournament: false, tournamentDecks: 'locked', ...table.settings },
    ...(table.mode === undefined ? { mode: 'classic', modeOptions: {} } : table.mode === null ? { mode: null, modeOptions: null } : table.mode),
    // Caller-scoped, as `http/rooms.ts` serialises it: whether the leader is
    // this caller, and whether this caller is ready. `p-alice` is us.
    you: { id: 'p-alice', leader: iAmLeader(), ready: membersOf().some((m) => m.id === 'p-alice' && m.ready === true) },
    ...(table.clientMode === undefined ? {} : { clientMode: table.clientMode }),
    locked: false,
    members: membersOf().map((m) => ({
      ...m,
      ready: m.ready === true,
      joinedAt: '',
    })),
    matchId: table.matchId,
    draftStartedAt: table.draftStartedAt ?? null,
    ...(table.pod === undefined ? {} : { pod: table.pod }),
    createdAt: '2026-09-19T00:00:00.000Z',
    tables: [
      {
        id: 't-stub0001',
        // The seated players as members, as `http/rooms.ts` sends them: who holds a seat is what tells a spectator apart.
        players: table.players.map((p) => ({ memberId: membersOf().find((m) => m.name === p.name)?.id ?? `p-${p.name}`, name: p.name })),
        matchId: table.matchId,
        series: table.series ?? { length: 1, wins: [0, 0], games: [], phase: 'seating' },
      },
      ...(table.extraTables ?? []).map((t) => ({
        id: t.id,
        players: t.players,
        matchId: t.matchId,
        series: t.series ?? { length: 1, wins: [0, 0], games: [], phase: 'seating' },
      })),
    ],
  });
  /** One deck against one pool, which is the only question the gate answers. */
  const verdictOf = (deckId: string, formatId: string): Verdict => {
    const name = decks().find((d) => d.id === deckId)?.name ?? '?';
    const format = [...FORMATS, MODERN].find((f) => f.id === formatId);
    if (format?.id === '2011-07-15' && deckId === UG_POLYMORPH) return BANNED;
    return LEGAL(name, format?.name ?? '?');
  };
  const verdictFor = (choice: SeatChoice): Verdict =>
    verdictOf(
      'library' in choice.deck ? choice.deck.library : '?',
      choice.rules.kind === 'standard' ? choice.rules.format : '',
    );

  /** Reads parked on the wire, by what they read: each answers with its record AS IT WAS when read, once its own release is called. */
  const held = new Map<'room' | 'gauntlet', Promise<void>>();
  const holdNext = (read: 'room' | 'gauntlet'): (() => void) => {
    let release: () => void = () => undefined;
    held.set(
      read,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    return () => release();
  };
  /** The parked answer for `read`, if the next one was held; null to answer it live. */
  const answerHeld = async (read: 'room' | 'gauntlet', record: () => unknown): Promise<Response | null> => {
    const gate = held.get(read);
    if (gate === undefined) return null;
    held.delete(read);
    const stale = record();
    await gate;
    return json(200, stale);
  };
  let roomRead: () => void = () => undefined;
  const roomAnswered = new Promise<void>((r) => {
    roomRead = r;
  });
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
        const asked = body as { format?: unknown; mode?: unknown; gameType?: string; settings?: { handSmoothing?: boolean; tournament?: boolean; tournamentDecks?: 'locked' | 'per-round' } };
        // The type, as `lobby.ts` sets it: under the mode's lock, and a change leaves the mode unchosen and nobody ready.
        if (asked.gameType !== undefined) {
          if (table.players.some((p) => p.ready)) return json(409, { error: 'mode-locked' });
          if (asked.gameType !== gameType()) table.mode = null;
          table.gameType = asked.gameType;
          table.players = table.players.map((p) => ({ ...p, ready: false }));
          table.members = table.members?.map((m) => ({ ...m, ready: false }));
          return json(200, roomRecord());
        }
        // The mode, as `lobby.ts` sets it: refused once anybody is ready, and a change clears readiness.
        if (asked.mode !== undefined) {
          if (table.players.some((p) => p.ready)) return json(409, { error: 'mode-locked' });
          table.mode = body as RoomMode;
          table.players = table.players.map((p) => ({ ...p, ready: false }));
          return json(200, roomRecord());
        }
        // A setting is not a deck question: nobody's readiness or verdict moves.
        if (asked.settings !== undefined) {
          table.settings = { handSmoothing: true, tournament: false, tournamentDecks: 'locked', ...table.settings, ...asked.settings };
          return json(200, roomRecord());
        }
        if (typeof asked.format !== 'string') return json(400, { error: 'format must be a string' });
        table.format = asked.format;
        table.players = table.players.map((p) =>
          p.you ? { ...p, ready: false, deck: p.deck == null ? null : { ...p.deck, legal: false } } : { ...p, ready: false },
        );
        return json(200, roomRecord());
      }
      const parked = await answerHeld('room', roomRecord);
      if (parked !== null) return parked;
      roomRead();
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
    if (url.endsWith(`/tables/rooms/${ROOM}/gauntlet`)) return (await answerHeld('gauntlet', () => gauntletOf(table))) ?? json(200, gauntletOf(table));
    if (url.endsWith(`/tables/rooms/${ROOM}/gauntlet/ready`)) {
      const { ready } = body as { ready: boolean };
      const before = gauntletOf(table);
      table.gauntlet = { ...before, ready: before.you === 1 ? [before.ready[0], ready] : [ready, before.ready[1]] };
      return json(200, table.gauntlet);
    }
    if (url.endsWith('/tables/gauntlet/eras')) {
      return json(200, {
        eras: [
          { id: 'modern-2014-07-18', family: 'modern', title: 'Modern — 2014' },
          { id: 'modern-2012-07-13', family: 'modern', title: 'Modern — 2012' },
          { id: 'legacy-2016-07-22', family: 'legacy', title: 'Legacy — 2016' },
        ],
      });
    }
    if (url.endsWith('/tables/formats')) {
      return json(200, { formats: [FREE, ...FORMATS, MODERN] });
    }
    if (url.endsWith('/tables/decks')) {
      if (table.catalogueAfterRoom === true) {
        await roomAnswered;
        await waitFor(() => expect(document.querySelector('[data-testid="room-name"]')).not.toBeNull());
      }
      return json(200, { decks: decks() });
    }
    // One per era, each time the room's pool moves: how the picker learns
    // which decks that pool offers. The answer is this stub's own per-deck
    // verdict, so the fake cannot disagree with `/tables/check` below.
    const legalFor = /\/tables\/legal\/([^/?]+)$/.exec(url);
    if (legalFor !== null) {
      if (table.checkFails === true) return json(503, { error: 'the gate is restarting' });
      const format = decodeURIComponent(legalFor[1]!);
      if (format === FREE.id) return json(200, { format, legal: decks().map((d) => d.id) });
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
    // `?table=` names one of the room's tables; this stub room has one.
    if (url.split('?')[0]!.endsWith(`/tables/rooms/${ROOM}`)) return json(200, view());
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
      const verdict = verdictOf(deckId, table.format ?? '');
      const mine: RoomPlayer = {
        seat: 0,
        name: 'user-alice',
        you: true,
        ready: false,
        deck: { name: verdict.deckName, rulesName: verdict.rulesName, legal: verdict.legal, issueCount: verdict.issues.length, choice: body as SeatChoice },
      };
      const at = table.players.findIndex((p) => p.you);
      if (at === -1) table.players.push(mine);
      else table.players[at] = mine;
      return json(200, view());
    }
    /*
     * Sitting is its own act (2026-10-12): a seat with no deck yet, and the
     * stand-up the server refuses once the table is locked.
     */
    if (url.endsWith(`/tables/rooms/${ROOM}/sit`)) {
      if (table.players.some((p) => p.you)) return json(200, view());
      if (table.matchId !== null) return json(409, { error: 'the match has already started' });
      if (table.players.length >= 2) return json(409, { error: 'this table already has two players' });
      table.players.push({ seat: table.players.length, name: 'user-alice', you: true, ready: false, deck: null });
      return json(200, view());
    }
    if (url.endsWith(`/tables/rooms/${ROOM}/stand`)) {
      const at = table.players.findIndex((p) => p.you);
      if (at === -1) return json(200, view());
      if (table.matchId !== null) return json(409, { error: 'the match has already started' });
      if (table.locked === true) return json(409, { error: 'both players are ready — the table is locked' });
      table.players.splice(at, 1);
      return json(200, view());
    }
    if (url.endsWith(`/tables/rooms/${ROOM}/ready`)) {
      const mine = table.players.find((p) => p.you);
      if (mine?.deck == null) return json(409, { error: 'load a deck before you ready up' });
      const want = (body as { ready: boolean }).ready;
      if (want && !mine.deck.legal) return json(422, { error: REFUSAL });
      mine.ready = want;
      return json(200, view());
    }
    if (url.endsWith('/play/matches')) {
      const asked = body as { room?: string };
      if (typeof asked.room !== 'string') return json(422, { error: 'a match against a person starts from a room' });
      if (table.refuseStart !== undefined) return json(table.refuseStart.status, { error: table.refuseStart.error });
      await table.holdStart;
      table.matchId = MATCH;
      return json(201, { matchId: MATCH });
    }
    return json(404, { error: 'not found' });
  };
  return {
    calls,
    table,
    holdNextRoomRead: () => holdNext('room'),
    holdNextGauntletRead: () => holdNext('gauntlet'),
    client: tablesClient(fetchImpl, '/cardtable/api/'),
    rooms: roomsClient(fetchImpl, '/cardtable/api/'),
    /** Everyone's record per deck; empty unless a test sets one. Never the real stats service. */
    records,
    deckRecords: () => Promise.resolve(records),
    myDecks: {
      list: async () => {
        calls.push({ method: 'GET', url: '/cardtable/api/decks', body: undefined });
        return (await table.myDecks) ?? [];
      },
      rename: () => Promise.reject(new Error('not on this screen')),
      remove: () => Promise.reject(new Error('not on this screen')),
    } satisfies MyDecksClient,
  };
}

/**
 * A feed that says "changed" every `ms`: the stub server here has no socket, and
 * these tests are about what the screen does with each read, not about when the
 * server pings (`../rooms/feed.test.ts` is).
 */
function everyMs(ms: number): RoomFeed {
  return {
    follow(_target, refresh) {
      refresh();
      const timer = setInterval(refresh, ms);
      return () => clearInterval(timer);
    },
  };
}

/**
 * A feed the test steps by hand, for "however often it re-reads, nothing more
 * happens": `reread(n)` pings n times and lets each read's answer land before
 * the next, so the assertion counts reads instead of sleeping through them.
 */
function steppedFeed() {
  const refreshers = new Set<() => void>();
  const feed: RoomFeed = {
    follow(_target, refresh) {
      refresh();
      refreshers.add(refresh);
      return () => {
        refreshers.delete(refresh);
      };
    },
  };
  return {
    feed,
    /** How many reads are following the feed right now. */
    following: () => refreshers.size,
    async reread(n: number) {
      for (let i = 0; i < n; i += 1) {
        await act(async () => {
          for (const refresh of [...refreshers]) refresh();
        });
        // The stub answers in promises, never timers: a few turns of the queue land every answer and its render.
        for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
      }
    },
  };
}

/** `GET /api/rooms/:id`: one per read of the room. */
const roomReads = (server: { calls: Call[] }): number => server.calls.filter((c) => c.method === 'GET' && c.url.endsWith(`/api/rooms/${ROOM}`)).length;

async function mountRoom(table: Table, rand?: () => number, feed: RoomFeed = everyMs(10)) {
  const server = stubServer(table);
  render(
    createElement(ConstructedScreen, {
      client: server.client, deckRecords: server.deckRecords,
      rooms: server.rooms,
      myDecks: server.myDecks,
      roomId: ROOM,
      feed,
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

/** YOUR row at the table: the pool your deck was checked in, and whether it is legal there. */
const myRow = (): HTMLElement => {
  const row = screen.getByTestId('room-players').querySelector<HTMLElement>('li[data-mine]') ?? undefined;
  if (row === undefined) throw new Error('no row of yours at the table');
  return row;
};
/** Whether my Ready can be pressed: in a classic room, what the server's verdict on my deck decides. */
const myReadyOpen = (): boolean => !(within(myRow()).getByTestId('ready-toggle') as HTMLButtonElement).disabled;

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
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms }));
    expect((await screen.findByTestId('constructed-pointer')).textContent).toContain('played in a room');
    // The shape the operator rejected is not on the screen at all.
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.queryByTestId('format')).toBeNull();
    fireEvent.click(screen.getByTestId('to-rooms'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });
});

// The operator, 2026-10-16: "on first page load, i still see the room-id for a split second before
// the room actually loads … can we show a loading skeleton before the room is loaded?"
describe('a room that has not answered yet', () => {
  it('draws the room’s outline, never its id, and swaps in the room when it answers', async () => {
    const server = stubServer({ players: [opponent()], matchId: null });
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms, roomId: ROOM, feed: everyMs(10_000) }));
    // No await: this is the first paint.
    const room = screen.getByTestId('constructed');
    expect(room.textContent).not.toContain(ROOM);
    expect(screen.queryByTestId('room-name')).toBeNull();
    expect(screen.getByTestId('room-skeleton')).toBeTruthy();
    // The operator, 2026-10-20: twelve deck outlines, not eight.
    expect(screen.getByTestId('deck-skeleton').querySelectorAll('.skeleton--tile')).toHaveLength(12);
    expect(room.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(room.textContent, 'no words while it waits').not.toMatch(/Waiting|Loading|Constructed/);

    expect((await screen.findByTestId('room-name')).textContent).toBe('Friday night');
    await deckPicker();
    expect(screen.queryByTestId('room-skeleton')).toBeNull();
    expect(screen.queryByTestId('deck-skeleton')).toBeNull();
    expect(room.querySelector('main')?.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('a room the list read before navigating (rooms/warm.ts)', () => {
  it('draws the finished page on its first render: the name, the seats and a live deck picker', async () => {
    const server = stubServer({ players: [opponent()], matchId: null });
    const view = await server.rooms.get(ROOM);
    await warmRoom(view!, server.client);
    const asked = sweeps(server);
    expect(asked, 'the pool was swept while the list was still showing').toEqual([FORMATS[0].id]);

    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms, roomId: ROOM, feed: everyMs(10_000) }));
    // No await between the render and these: the first paint is the whole page.
    expect(screen.getByTestId('room-name').textContent).toBe('Friday night');
    expect(screen.getByTestId('room-seat-0').textContent).toContain('user-bob');
    expect(screen.getByTestId('deck-mine').getAttribute('aria-disabled')).toBeNull();
    expect(offered().length).toBeGreaterThan(0);
    await act(async () => {});
    expect(sweeps(server), 'a sweep the warm made is not asked again').toEqual(asked);
  });

  it('is taken once, and only by its own room', async () => {
    const server = stubServer({ players: [opponent()], matchId: null });
    const view = await server.rooms.get(ROOM);
    await warmRoom(view!, server.client);
    expect(takeWarmRoom('r-elsewhere')).toBeUndefined();
    expect(takeWarmRoom(ROOM)?.view.id).toBe(ROOM);
    expect(takeWarmRoom(ROOM)).toBeUndefined();
  });

  it('gives up after its timeout, and the room then loads as it always has', async () => {
    const server = stubServer({ players: [opponent()], matchId: null });
    const view = await server.rooms.get(ROOM);
    const never = { ...server.client, table: () => new Promise<never>(() => {}) };
    await warmRoom(view!, never, 5);
    expect(takeWarmRoom(ROOM)).toBeUndefined();
  });
});

describe('a room’s table', () => {
  // The operator, 2026-10-22: "lets get rid of the 'Waiting for Hadoku.' this is unecessary. i dont need it in either room."
  it('shows both players, and no line saying who is being waited on', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    expect(screen.getByTestId('room-seat-0').textContent).toContain('user-bob');
    expect(screen.getByTestId('room-seat-0-ready').textContent).toBe('not ready');
    expect(screen.getByTestId('room-seat-1-empty')).toBeTruthy();
    expect(screen.queryByTestId('start-state')).toBeNull();
  });

  /*
   * The operator, 2026-10-21: "don't reveal the deck that someone has picked in
   * constructed rooms … just showing whether or not they are ready is good
   * enough." The server sends another seat as its name and its ready flag, and
   * the row draws exactly that: no deck, format or legality cell to fill.
   */
  it('draws another player’s seat as their name and whether they are ready, nothing of their deck', async () => {
    await mountRoom({ players: [{ seat: 0, name: 'user-bob', you: false, ready: true } as RoomPlayer], matchId: null });
    const row = screen.getByTestId('room-seat-0');
    expect([...row.children].map((c) => c.className.split(' ')[0])).toEqual(['pod-seats__avatar-wrap', 'pod-seats__label', 'pill']);
    for (const cell of ['deck', 'rules']) expect(screen.queryByTestId(`room-seat-0-${cell}`)).toBeNull();
    expect(screen.getByTestId('room-seat-0-ready').textContent).toBe('ready');
  });

  /*
   * Sitting is its own act (the operator, 2026-10-12): an empty seat offers
   * Sit here, a seat without a deck is drawn as one, and the deck picker is
   * for the seated only.
   */
  it('an empty seat offers Sit here; sitting draws a seat with no deck yet, and the picker stays (choosing a deck still seats you)', async () => {
    const server = await mountRoom({ players: [], matchId: null });
    expect(screen.getAllByTestId('seat-sit')).toHaveLength(2);
    expect(screen.getByTestId('deck-mine'), 'a free seat: choosing a deck is still the one-click way in').toBeTruthy();
    expect(screen.queryByTestId('seat-stand')).toBeNull();
    fireEvent.click(screen.getAllByTestId('seat-sit')[0]!);
    await screen.findByTestId('seat-stand');
    expect(lastCall(server.calls, `/tables/rooms/${ROOM}/sit`)?.method).toBe('POST');
    expect(screen.getByTestId('room-seat-0').hasAttribute('data-mine')).toBe(true);
    expect(screen.getByTestId('room-seat-0').querySelector('.pod-seats__label')?.textContent, 'my name, and no (you) beside it').toBe('user-alice');
    // My own seat's ready state is the button that sets it.
    const ready = within(screen.getByTestId('room-seat-0')).getByTestId('ready-toggle');
    expect(ready.dataset.state).toBe('no');
    expect(ready.getAttribute('aria-pressed')).toBe('false');
    await screen.findByTestId('deck-mine');
    expect(screen.getAllByTestId('seat-sit'), 'the other seat stays on offer').toHaveLength(1);
    expect((screen.getByTestId('seat-sit') as HTMLButtonElement).disabled, 'but not to someone already seated').toBe(true);
    expect(
      within(screen.getByTestId('room-seat-1-empty')).queryByTestId('play-vs-bot'),
      'the only one seated may put Forge’s AI in the empty seat',
    ).not.toBeNull();
  });

  it('Stand up gives the seat back', async () => {
    const server = await mountRoom({ players: [opponent({ you: true, name: 'user-alice' })], matchId: null });
    const stand = screen.getByTestId('seat-stand') as HTMLButtonElement;
    expect(stand.disabled).toBe(false);
    fireEvent.click(stand);
    await waitFor(() => expect(screen.queryByTestId('seat-stand')).toBeNull());
    expect(lastCall(server.calls, `/tables/rooms/${ROOM}/stand`)?.method).toBe('POST');
    expect(screen.getAllByTestId('seat-sit')).toHaveLength(2);
    expect(screen.getByTestId('deck-mine'), 'stood up with a seat free: the picker stays').toBeTruthy();
  });

  it('Stand up and Sit here are dead once the table is locked (both ready, or a match live)', async () => {
    await mountRoom({ players: [opponent({ you: true, name: 'user-alice', ready: true })], matchId: null, locked: true });
    expect((screen.getByTestId('seat-stand') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('seat-sit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the bot button is gated on the seat, not the room: a second member who has not sat down leaves it', async () => {
    await mountRoom({
      players: [opponent({ you: true, name: 'user-alice' })],
      matchId: null,
      members: [
        { id: 'p-alice', name: 'user-alice' },
        { id: 'p-bob', name: 'user-bob' },
      ],
    });
    expect(screen.getByTestId('play-vs-bot')).toBeTruthy();
    expect(screen.getByTestId('constructed').getAttribute('data-members')).toBe('2');
  });

  // The operator, 2026-10-21: "spectators dont need to take seats, anyone who loads the page is a
  // spectator by default. we dont need to represent this in the UI at all."
  it('a 1v1 room draws its seats and nobody who holds none', async () => {
    await mountRoom({
      players: [opponent({ you: true, name: 'user-alice' }), opponent()],
      matchId: null,
      members: [{ id: 'p-alice', name: 'user-alice' }, { id: 'p-bob', name: 'user-bob' }, { id: 'p-w0', name: 'user-watcher' }],
    });
    await waitFor(() => expect(screen.getByTestId('constructed').getAttribute('data-members')).toBe('3'));
    expect(screen.getByTestId('constructed').textContent).not.toMatch(/user-watcher|Spectator/);
  });

  /*
   * The operator, 2026-09-25, of the row this replaced — a sentence with
   * middots for separators and `ready` as raw text: *"looks very cheap"*.
   */
  // The operator, 2026-10-22: "can we also show seats the same way we show seats then in draft?"
  // The operator, 2026-10-22: "remove the two lines below the character portrait at table … just Ready and stand are good enough".
  it('draws each seat as a draft seat: avatar, name, the ready state, Stand — no deck lines, no middots, every state a shape AND a colour', async () => {
    await mountRoom({ players: [mySeat(), opponent({ seat: 1, ready: true })], matchId: null });
    const row = screen.getByTestId('room-seat-0');
    // No separator characters anywhere in the seat: the lines are the separation.
    expect(row.textContent).not.toMatch(/[·—]/);
    expect(row.className).toContain('pod-seats__seat');
    expect([...row.children].map((c) => c.className.split(' ')[0])).toEqual([
      'pod-seats__avatar-wrap',
      'pod-seats__label',
      'pill',
      'pod-seats__actions',
    ]);
    for (const line of ['deck', 'rules']) expect(screen.queryByTestId(`room-seat-0-${line}`), `no ${line} line`).toBeNull();
    expect(screen.getByTestId('room-seat-1').querySelector('.pod-seats__avatar')?.getAttribute('data-ready'), 'a ready seat is ringed').toBe('true');

    // Each state carries a drawn mark of its own, so colour is never the only
    // difference. Ready is a tick; not ready is an open ring.
    const ready = screen.getByTestId('room-seat-1-ready');
    expect(ready.dataset.state).toBe('yes');
    expect(ready.dataset.mark).toBe('tick');
    expect(ready.querySelector('svg path')).not.toBeNull();
    expect(ready.querySelector('svg circle')).toBeNull();
  });

  /* The operator, 2026-10-21, of the legal / no deck pill: "it's ugly and unecessary". */
  it('my unready, illegal seat draws no legality of its own: only its Ready, unpressed', async () => {
    await mountRoom({ players: [mySeat({ legal: false, issueCount: 3 })], matchId: null });
    expect(screen.queryByTestId('room-seat-0-legal')).toBeNull();
    expect(screen.getByTestId('room-seat-0').textContent).not.toMatch(/illegal|legal|no deck/);
    const ready = screen.getByTestId('ready-toggle');
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
    expect(chosen()).toBe(SECOND_DECK);
    expect(myReadyOpen()).toBe(true);
    expect(screen.getByTestId('room-seat-1').hasAttribute('data-mine')).toBe(true);
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false);
  });

  /*
   * The POOL moving under a chosen deck is now the only way to hold an illegal
   * one: the dropdown offers nothing else. Both halves are asserted — your row
   * says illegal, and the deck drops off the list — because the second is what
   * stops Ready coming back to life over it.
   */
  it('an illegal deck blocks YOUR ready, and nobody else’s', async () => {
    const server = await mountRoom({ players: [opponent({ ready: true })], matchId: null });
    await pick(UG_POLYMORPH);
    await pickPool('2011-07-15');

    await waitFor(() => expect(myReadyOpen()).toBe(false));
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
    // The pool that bans it no longer offers it, and nothing is chosen.
    await waitFor(() => expect(offered()).not.toContain(UG_POLYMORPH));
    expect(chosen()).toBe('');
    // The other player was stood down BY THE POOL MOVING, which is the server's
    // rule and not this deck's fault: what they readied with is not what the
    // table is on any more.
    await waitFor(() => expect(screen.getByTestId('room-seat-0-ready').textContent).toBe('not ready'));
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
    // The other browser started it; this one learns from a re-read.
    server.table.matchId = MATCH;
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
    expect(lastCall(server.calls, '/play/matches')).toBeUndefined();
  });

  // The operator, 2026-10-19: "the initial force into the game should only happen once when the game starts".
  it('carries a player into the match once; back in the room by choice, they stay, with the way back in', async () => {
    const server = await mountRoom({ players: [opponent({ ready: true }), opponent({ you: true, name: 'user-alice', seat: 1 })], matchId: null });
    server.table.matchId = MATCH;
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
    cleanup();
    globalThis.location.hash = `#/room/${ROOM}`;
    await mountRoom({ players: [opponent({ ready: true }), opponent({ you: true, name: 'user-alice', seat: 1 })], matchId: MATCH });
    const link = await screen.findByTestId('room-match-link');
    expect(link.getAttribute('href')).toBe(`#/match/${MATCH}`);
    expect(link.textContent).toBe('Play');
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: ROOM });
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
        setSettings: async () => ({ ok: false as const, message: 'not used' }),
        setRoomMode: async () => ({ ok: false as const, message: 'not used' }),
        setGameType: async () => ({ ok: false as const, message: 'not used' }),
        setPlan: async () => ({ ok: false as const, message: 'not used', verdict: null }),
        lockPod: async () => ({ ok: false as const, message: 'not used' }),
        choosePodDeck: async () => ({ ok: false as const, message: 'not used' }),
        leave: async () => ({ ok: false as const, message: 'not used' }),
        close: async () => ({ ok: false as const, message: 'not used' }),
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
                  gameType: 'constructed-1v1' as const,
                  format: '2010-07-16',
                  settings: { handSmoothing: true, tournament: false, tournamentDecks: 'locked' as const },
                  mode: null,
                  modeOptions: null,
                  you: { id: 'p-alice', leader: true, ready: false },
                  clientMode: 'builtin' as const,
                  locked: false,
                  members: [],
                  matchId: null,
                  draftStartedAt: null,
                  createdAt: '2026-09-19T00:00:00.000Z',
                  tables: [],
                  pod: null,
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
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, roomId: ROOM, feed: everyMs(10), rooms: rooms.client }));
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
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, roomId: ROOM, feed: everyMs(10), rooms: rooms.client }));
    expect((await screen.findByTestId('room-locked')).textContent).toContain('needs a password');
    expect(screen.queryByTestId('room-missing')).toBeNull();
  });

  it('retries with the password typed in, and gets in', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('refused');
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, roomId: ROOM, feed: everyMs(10), rooms: rooms.client }));
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
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, roomId: ROOM, feed: everyMs(10), rooms: rooms.client }));
    await screen.findByTestId('room-locked');

    fireEvent.change(screen.getByTestId('room-password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByTestId('room-password-submit').closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByTestId('room-locked').textContent).toContain('Wrong password'));
  });

  it('stops after ONE refused join instead of re-asking on the timer', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('refused');
    const stepped = steppedFeed();
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, roomId: ROOM, feed: stepped.feed, rooms: rooms.client }));
    await screen.findByTestId('room-locked');

    const readsWhenRefused = server.calls.length;
    await stepped.reread(12);
    expect(rooms.joins).toEqual([ROOM]);
    expect(server.calls.length).toBe(readsWhenRefused);
  });

  it('says to wait rather than retrying when the join is rate-limited', async () => {
    const server = stubServer({ players: [], matchId: null, missing: true });
    const rooms = stubRooms('rate-limited');
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, roomId: ROOM, feed: everyMs(10), rooms: rooms.client }));
    expect((await screen.findByTestId('room-locked')).textContent).toContain('Too many attempts');
    expect(rooms.joins).toEqual([ROOM]);
  });

  it('tells a third person there is no seat, rather than a picker that cannot work', async () => {
    await mountRoom({ players: [opponent(), opponent({ seat: 1, name: 'user-carol' })], matchId: null });
    expect(screen.getByTestId('room-spectator').textContent).toContain('Table full');
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.getByTestId('room-seat-1').textContent).toContain('user-carol');
  });

  it('says when the server refuses the start, and asks again only when told to', async () => {
    const stepped = steppedFeed();
    const server = await mountRoom(
      { players: [opponent({ ready: true })], matchId: null, refuseStart: { status: 409, error: 'user-bob is not ready yet' } },
      undefined,
      stepped.feed,
    );
    await pick(UG_POLYMORPH);
    await act(async () => {
      fireEvent.click(screen.getByTestId('ready-toggle'));
    });

    const refused = await screen.findByTestId('start-refused');
    expect(refused.textContent).toContain('user-bob is not ready yet');
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
    // One attempt, not one per re-read.
    const attempts = () => server.calls.filter((c) => c.url.endsWith('/play/matches')).length;
    const once = attempts();
    const reads = roomReads(server);
    await stepped.reread(6);
    expect(roomReads(server), 'it did re-read').toBeGreaterThan(reads);
    expect(attempts()).toBe(once);

    // Told to, it asks again — and this time the server starts it.
    server.table.refuseStart = undefined;
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-retry'));
    });
    await stepped.reread(1);
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
  });
});

describe('a start in flight', () => {
  it('takes the table out of everyone’s hands until the match is up: no Stand down, no new deck', async () => {
    let up = (): void => {};
    await mountRoom({ players: [opponent({ ready: true })], matchId: null, holdStart: new Promise<void>((r) => (up = r)) });
    await pick(UG_POLYMORPH);
    await act(async () => {
      fireEvent.click(screen.getByTestId('ready-toggle'));
    });
    await waitFor(() => expect(screen.getByTestId('start-state').textContent).toBe('Starting Forge…'));
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('deck-random') as HTMLButtonElement).disabled).toBe(true);
    for (const option of screen.getByTestId('deck-mine').querySelectorAll('button')) expect(option.disabled).toBe(true);

    await act(async () => up());
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: MATCH }));
    expect(screen.queryByTestId('start-refused')).toBeNull();
  });
});

/* ── the picker: two selects, one button (wave 22 §B) ────────────────── */

describe('the deck picker', () => {
  it('says Ready, not “I’m ready”, on my seat, which I take by choosing a deck', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    // Nothing is chosen for you, so you hold no seat and there is no Ready to press.
    await deckPicker();
    expect(chosen()).toBe('');
    expect(screen.queryByTestId('ready-toggle')).toBeNull();

    await pick(SECOND_DECK);
    const ready = (await screen.findByTestId('ready-toggle')) as HTMLButtonElement;
    expect(ready.closest('[data-testid="room-seat-1"]')).not.toBeNull();
    expect(ready.textContent).toBe('Ready');
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false));
  });

  it('lists the decks by everyone’s win rate, best first', async () => {
    // The operator, 2026-10-10: "can you make sure the decks are sorted by
    // winrate?" Jund comes second in the library's own order, and has won more.
    const server = stubServer({ players: [opponent()], matchId: null });
    server.records.set(UG_POLYMORPH, { games: 4, wins: 1, losses: 3, draws: 0 });
    server.records.set(SECOND_DECK, { games: 4, wins: 3, losses: 1, draws: 0 });
    render(
      createElement(ConstructedScreen, {
        client: server.client,
        deckRecords: server.deckRecords,
        rooms: server.rooms,
        roomId: ROOM,
        feed: everyMs(10),
      }),
    );
    await screen.findByTestId('room-players');
    await deckPicker();
    await waitFor(() => expect(offered()).toEqual([SECOND_DECK, UG_POLYMORPH]));
  });

  // The operator, 2026-10-10: "i need a way to peek into the deck maybe can we show a
  // decklist when hovering for at least 1s?", and 2026-10-14: "when hovering deck show decklist".
  it('shows a deck’s list beside its tile once the pointer rests on it, and not on a pass across it', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    await deckPicker();
    const tile = screen.getByTestId('deck-mine').querySelector<HTMLElement>(`[data-deck-id="${SECOND_DECK}"]`)!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByTestId('deck-peek'), 'not on a pass across the tile').toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const peek = screen.getByTestId('deck-peek');
    expect(peek.querySelector('.peek__title')?.textContent).toBe('Jund');
    expect(peek.querySelector('.peek__pilot')?.textContent).toBe('Emanuele Giusti');
    expect(peek.textContent).toContain('Main 60');
    expect(peek.textContent).toContain('Island');
    expect(peek.textContent).toContain('Sideboard 15');
    expect(tile.getAttribute('aria-describedby')).toBe('deck-peek');
    fireEvent.pointerLeave(tile);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEEK_GRACE_MS);
    });
    expect(screen.queryByTestId('deck-peek')).toBeNull();
  });

  // The operator, 2026-10-16: "remove the gap between the deck grid button and the expanded
  // decklist so i can actually hover over things in there?"
  describe('a peeked list the pointer can reach', () => {
    async function openPeek(): Promise<{ tile: HTMLElement; other: HTMLElement }> {
      await mountRoom({ players: [opponent()], matchId: null });
      await deckPicker();
      const grid = screen.getByTestId('deck-mine');
      const tile = grid.querySelector<HTMLElement>(`[data-deck-id="${SECOND_DECK}"]`)!;
      const other = grid.querySelector<HTMLElement>(`[data-deck-id="${UG_POLYMORPH}"]`)!;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
      await advance(PEEK_DELAY_MS);
      expect(screen.getByTestId('deck-peek').querySelector('.peek__title')?.textContent).toBe('Jund');
      return { tile, other };
    }
    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    // The operator, 2026-10-21: "if i'm hovering a deck and i click it the expanded decklist should disappear".
    it('closes when its tile is pressed, and opens again on the next hover', async () => {
      const { tile } = await openPeek();
      fireEvent.pointerDown(tile, { pointerType: 'mouse' });
      fireEvent.click(tile);
      expect(screen.queryByTestId('deck-peek')).toBeNull();
      fireEvent.pointerLeave(tile);
      fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
      await advance(PEEK_DELAY_MS);
      expect(screen.getByTestId('deck-peek').querySelector('.peek__title')?.textContent).toBe('Jund');
    });

    it('closes when the room’s screen scrolls the grid, which has no scroll of its own', async () => {
      await openPeek();
      fireEvent.scroll(screen.getByTestId('constructed'));
      expect(screen.queryByTestId('deck-peek')).toBeNull();
    });

    it('stays open while a box outside the grid scrolls', async () => {
      await openPeek();
      fireEvent.scroll(screen.getByTestId('deck-peek'));
      expect(screen.getByTestId('deck-peek').querySelector('.peek__title')?.textContent).toBe('Jund');
    });

    it('stays open while the pointer moves from the tile into the list and rests there', async () => {
      const { tile } = await openPeek();
      fireEvent.pointerLeave(tile, { pointerType: 'mouse' });
      await advance(PEEK_GRACE_MS / 2);
      fireEvent.pointerEnter(screen.getByTestId('deck-peek'), { pointerType: 'mouse' });
      await advance(PEEK_GRACE_MS * 10);
      expect(screen.getByTestId('deck-peek').querySelector('.peek__title')?.textContent).toBe('Jund');
      expect(tile.getAttribute('aria-describedby')).toBe('deck-peek');
    });

    it('closes once the pointer has left both the tile and the list', async () => {
      const { tile } = await openPeek();
      fireEvent.pointerLeave(tile, { pointerType: 'mouse' });
      fireEvent.pointerEnter(screen.getByTestId('deck-peek'), { pointerType: 'mouse' });
      // Back onto its own tile and off again: still the same list.
      fireEvent.pointerLeave(screen.getByTestId('deck-peek'), { pointerType: 'mouse' });
      fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
      await advance(PEEK_GRACE_MS * 2);
      expect(screen.getByTestId('deck-peek')).toBeTruthy();
      fireEvent.pointerLeave(tile, { pointerType: 'mouse' });
      fireEvent.pointerEnter(screen.getByTestId('deck-peek'), { pointerType: 'mouse' });
      fireEvent.pointerLeave(screen.getByTestId('deck-peek'), { pointerType: 'mouse' });
      await advance(PEEK_GRACE_MS - 1);
      expect(screen.getByTestId('deck-peek')).toBeTruthy();
      await advance(1);
      expect(screen.queryByTestId('deck-peek')).toBeNull();
      expect(tile.hasAttribute('aria-describedby')).toBe(false);
    });

    it('keeps the list when a diagonal path to it crosses another tile, and opens nothing for that tile', async () => {
      const { tile, other } = await openPeek();
      fireEvent.pointerLeave(tile, { pointerType: 'mouse' });
      fireEvent.pointerEnter(other, { pointerType: 'mouse' });
      fireEvent.pointerLeave(other, { pointerType: 'mouse' });
      fireEvent.pointerEnter(screen.getByTestId('deck-peek'), { pointerType: 'mouse' });
      await advance(PEEK_DELAY_MS * 2);
      expect(screen.getByTestId('deck-peek').querySelector('.peek__title')?.textContent).toBe('Jund');
      expect(other.hasAttribute('aria-describedby')).toBe(false);
    });

    it('switches to another tile’s list when the pointer rests on that tile', async () => {
      const { tile, other } = await openPeek();
      fireEvent.pointerLeave(tile, { pointerType: 'mouse' });
      fireEvent.pointerEnter(other, { pointerType: 'mouse' });
      await advance(PEEK_GRACE_MS);
      expect(screen.queryByTestId('deck-peek')).toBeNull();
      await advance(PEEK_DELAY_MS - PEEK_GRACE_MS);
      expect(screen.getByTestId('deck-peek').querySelector('.peek__title')?.textContent).not.toBe('Jund');
      expect(other.getAttribute('aria-describedby')).toBe('deck-peek');
    });

    it('enlarges a line’s card in the inspector, beside the list', async () => {
      await openPeek();
      const list = screen.getByTestId('deck-peek');
      fireEvent.pointerEnter(list, { pointerType: 'mouse' });
      const island = [...list.querySelectorAll('.peek__line')].find((li) => li.querySelector('.peek__name')?.textContent === 'Island')!;
      fireEvent.pointerOver(island, { pointerType: 'mouse' });
      const panel = document.querySelector('[data-board-zoom] [data-inspect]');
      expect(panel?.querySelector('img')?.getAttribute('src')).toMatch(/^https:\/\//);
      fireEvent.pointerOut(island, { pointerType: 'mouse', relatedTarget: list });
      expect(document.querySelector('[data-inspect]')).toBeNull();
    });

    // Regression for a CI-only red (run 117402002655 on `a4a4a7c3`, "enlarges a
    // line's card…" above lost its peek 1/9520). The win-rate fetch resolving
    // DURING the peek's own open delay used to close it, even with no games
    // played by anyone — `byWinRate`'s own fallback leaves every deck at its
    // library index, so nothing about the list actually changed; only its
    // array's own identity did (`ConstructedScreen.tsx`'s `DeckChooser`, the
    // effect that used to key on `[options]`).
    it('a win-rate fetch that resolves mid-open does not close the peek when nothing reordered', async () => {
      const server = stubServer({ players: [opponent()], matchId: null });
      let resolveRecords: (() => void) | undefined;
      const delayed = (): Promise<DeckRecords> => new Promise((resolve) => (resolveRecords = () => resolve(new Map())));
      render(
        createElement(ConstructedScreen, {
          client: server.client,
          deckRecords: delayed,
          rooms: server.rooms,
          roomId: ROOM,
          feed: everyMs(10),
        }),
      );
      await screen.findByTestId('room-players');
      await deckPicker();
      const tile = screen.getByTestId('deck-mine').querySelector<HTMLElement>(`[data-deck-id="${SECOND_DECK}"]`)!;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        fireEvent.pointerEnter(tile, { pointerType: 'mouse' });
        // Queued, not yet run: resolving here lands the win-rate update's
        // re-render inside the SAME flush as the peek timer below, the exact
        // interleaving the CI run hit.
        resolveRecords?.();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PEEK_DELAY_MS);
        });
        expect(screen.getByTestId('deck-peek').querySelector('.peek__title')?.textContent).toBe('Jund');
      } finally {
        vi.useRealTimers();
      }
    });
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
    // Nothing was checked against the new pool, so the hold is not legal in it.
    await waitFor(() => expect(myReadyOpen()).toBe(false));
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
    expect(myReadyOpen()).toBe(true);
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
    // Not even a verdict: the operator, 2026-10-10, "i dislike that verdict it's
    // useless, just get rid of it". Your row's pill says legal or not.
    expect(screen.queryByTestId('verdict-mine')).toBeNull();
    expect(card.textContent).not.toContain('Legal in');

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
    expect(chosen(), 'the same deck, checked in the new pool').toBe(SECOND_DECK);
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
      ready: true,
      deck: { name: 'Jund (Emanuele Giusti)', rulesName: 'Standard (M11)', legal: true, issueCount: 0, choice: { deck: { library: SECOND_DECK }, rules: { kind: 'standard', format: '2010-07-16' } } },
    };
    // The other player is NOT ready, so nothing starts while this is watched.
    const stepped = steppedFeed();
    const server = await mountRoom({ players: [opponent(), held], matchId: null }, undefined, stepped.feed);
    // The picker opens on the deck the server holds…
    await waitFor(() => expect(chosen()).toBe(SECOND_DECK));
    // …and over a dozen re-reads it never writes one.
    const reads = roomReads(server);
    await stepped.reread(12);
    expect(roomReads(server), 'it did re-read').toBeGreaterThanOrEqual(reads + 12);
    expect(server.calls.filter((c) => c.url.endsWith('/deck'))).toHaveLength(0);
    const ready = screen.getByTestId('ready-toggle');
    expect(ready.getAttribute('aria-pressed'), 'the held readiness is on my seat, pressed').toBe('true');
    expect(ready.dataset.state).toBe('yes');
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
    // A drafted deck is never a room's format: no fourth tab.
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
    expect(chosen()).toBe(SECOND_DECK);
    expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  // The operator, 2026-10-09: "a lobby toggle for 'Free pick' which allows anyone to pick any
  // deck regardless of format to play against each other".
  it('Free pick: the leader’s toggle puts the room on every deck, and off again on an era', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null, format: '2011-07-15' });
    await waitFor(() => expect(offered()).toEqual([SECOND_DECK]));
    // Each state is its own element (`ActionButton`): read the toggle afresh after every press.
    const toggle = (): HTMLElement => screen.getByTestId('free-pick');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('true'));
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ format: 'free' }]);
    // Every deck, whatever its era — the deck 2011 bans included — and no era to choose.
    await waitFor(() => expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]));
    expect(screen.queryByTestId('format')).toBeNull();
    // The room's own tabs give way to the browse row: a switch, not a fourth tab.
    expect(screen.queryByTestId('format-tabs')).toBeNull();
    expect(screen.getByTestId('browse-tab-standard').getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('false'));
    // Back on the browsed tab's newest era.
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ format: 'free' }, { format: '2011-07-15' }]);
    expect((screen.getByTestId('format') as HTMLSelectElement).value).toBe('2011-07-15');
  });

  // The operator, 2026-10-10: "when free-pick is enabled, instead of showing all decks in one
  // list can we expose the Standard/Modern/Legacy to the other player?"
  it('Free pick: every player browses the library by format, and browsing moves nothing in the room', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null, leader: false, format: 'free' });
    await waitFor(() => expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]));
    expect(screen.getByTestId('browse-tab-standard').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByTestId('browse-tab-modern'));
    await waitFor(() => expect(offered()).toEqual([]));

    fireEvent.click(screen.getByTestId('browse-tab-standard'));
    fireEvent.change(screen.getByTestId('browse-era'), { target: { value: '2010-07-16' } });
    await waitFor(() => expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]));
    fireEvent.change(screen.getByTestId('browse-era'), { target: { value: '2011-07-15' } });
    await waitFor(() => expect(offered()).toEqual([]));
    expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  // The operator, 2026-10-20: "when i flip to legacy and year 2025 i see no decks". The event
  // (2025-06-30) came after the ruleset it played (Legacy (FIN), from 2025-06-13).
  it('Free pick: an era lists its decks when the event came after the ruleset began', async () => {
    const late = { ...deck('power-modern-2014-1-late', 'Late', 'Lena'), era: MODERN.id, format: MODERN.name, date: '2014-07-25' };
    await mountRoom({ players: [opponent()], matchId: null, leader: false, format: 'free', decks: [...DECKS, late] });
    fireEvent.click(screen.getByTestId('browse-tab-modern'));
    await waitFor(() => expect(offered()).toEqual([late.id]));
  });

  it('Free pick: a deck you hold stays yours while you browse another format', async () => {
    await mountRoom({ players: [opponent()], matchId: null, leader: false, format: 'free' });
    await pick(SECOND_DECK);
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('browse-tab-legacy'));
    await waitFor(() => expect(offered()).toEqual([]));
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('browse-tab-standard'));
    await waitFor(() => expect(chosen()).toBe(SECOND_DECK));
  });

  // The operator, 2026-10-19: "the only other time this deck can be selected to be played is if
  // 'Free-Pick' is enabled. under freepick we should have a filter option for 'My Decks'".
  it('Free pick: My decks offers each drafted build that is a deck, and seats its saved text', async () => {
    const pool = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45).map((card, i) => ({ ...card, cardId: `draft:pod-a/p${i}` }));
    const built = dckTextOf(draftedDeckOf('pod-a', pool));
    const mine = (id: string, deck: string | null): MyDeck => ({ id, name: `Deck ${id}`, cube: 'Cube', createdAt: 1, pool, deck, concluded: true });
    let answer!: (decks: MyDeck[]) => void;
    const server = await mountRoom({
      players: [opponent()],
      matchId: null,
      leader: false,
      format: 'free',
      myDecks: new Promise((done) => (answer = done)),
    });
    await waitFor(() => expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]));
    fireEvent.click(screen.getByTestId('browse-tab-mine'));
    // The tiles' outlines while the list is on its way, never an empty tab that then fills.
    await waitFor(() => expect(screen.getByTestId('deck-mine').querySelectorAll('.skeleton--tile')).toHaveLength(12));
    expect(screen.queryAllByTestId('deck-option')).toEqual([]);
    expect(screen.queryByTestId('browse-era')).toBeNull();
    await act(async () => answer([mine('pod-a', built), mine('pod-short', dckTextOf(deckFromPool('pod-short', pool))), mine('pod-none', null)]));
    await waitFor(() => expect(offered()).toEqual(['mine:pod-a']));
    expect(rowName(deckRow('mine:pod-a'))).toBe('Deck pod-a');

    await pick('mine:pod-a');
    const sent = lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body as { deck: { dck: string } };
    expect(sent.deck).toEqual({ dck: built });
    // A library tab never shows them.
    fireEvent.click(screen.getByTestId('browse-tab-standard'));
    await waitFor(() => expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]));
  });

  // A pick dragged to the sideboard mid-draft saves the sideboard alone — picks are the deck in
  // progress, so the save names only what is out of it. My decks reads it as the builder does.
  it('Free pick: My decks offers a build saved with only a sideboard, and seats the picks as its main deck', async () => {
    const pool = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45).map((card, i) => ({ ...card, cardId: `draft:pod-s/p${i}` }));
    const sideOnly = dckTextOf({ ...deckFromPool('pod-s', pool.slice(0, 1)), main: [] });
    const server = await mountRoom({
      players: [opponent()],
      matchId: null,
      leader: false,
      format: 'free',
      myDecks: [{ id: 'pod-s', name: 'Deck pod-s', cube: 'Cube', createdAt: 1, pool, deck: sideOnly, concluded: true }],
    });
    fireEvent.click(screen.getByTestId('browse-tab-mine'));
    await waitFor(() => expect(offered()).toEqual(['mine:pod-s']));
    await pick('mine:pod-s');
    const sent = lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body as { deck: { dck: string } };
    const seated = parseDck(sent.deck.dck);
    const count = (section: string): number => (seated.sections.get(section) ?? []).reduce((n, e) => n + e.count, 0);
    expect([count('main'), count('sideboard')]).toEqual([44, 1]);
  });

  // The operator, 2026-10-20: "'drafted pool' should be 'my decks' and should only be visible if
  // freepick is enabled." A room's format is never a pod; a drafted deck is one of My decks.
  it('off Free pick there is no Drafted pool and no My decks, and your decks are never asked for', async () => {
    const pool = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45).map((card, i) => ({ ...card, cardId: `draft:pod-a/p${i}` }));
    const built = dckTextOf(draftedDeckOf('pod-a', pool));
    const server = await mountRoom({
      players: [opponent()],
      matchId: null,
      myDecks: [{ id: 'pod-a', name: 'Deck pod-a', cube: 'Cube', createdAt: 1, pool, deck: built, concluded: true }],
    });
    await waitFor(() => expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]));
    expect(screen.queryByTestId('format-tab-draft')).toBeNull();
    expect(screen.queryByTestId('browse-tab-mine')).toBeNull();
    expect(screen.getByTestId('constructed').textContent).not.toMatch(/Drafted pool|My decks/);
    const format = screen.getByTestId('format') as HTMLSelectElement;
    expect([...format.options].map((o) => o.value).filter((v) => v.startsWith('draft:'))).toEqual([]);
    expect(server.calls.filter((c) => c.url.endsWith('/api/decks'))).toHaveLength(0);

    // On Free pick, the same build is one of My decks.
    await act(async () => {
      fireEvent.click(screen.getByTestId('free-pick'));
    });
    fireEvent.click(await screen.findByTestId('browse-tab-mine'));
    await waitFor(() => expect(offered()).toEqual(['mine:pod-a']));
  });

  it('Free pick: a drafted deck the server holds reopens as that My decks tile', async () => {
    const pool = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45).map((card, i) => ({ ...card, cardId: `draft:pod-a/p${i}` }));
    const built = dckTextOf(draftedDeckOf('pod-a', pool));
    const held: RoomPlayer = {
      seat: 1,
      name: 'user-alice',
      you: true,
      ready: false,
      deck: { name: 'Deck pod-a', rulesName: 'Free pick', legal: true, issueCount: 0, choice: { deck: { dck: built }, rules: { kind: 'free' } } },
    };
    const server = await mountRoom({
      players: [opponent(), held],
      matchId: null,
      leader: false,
      format: 'free',
      myDecks: [{ id: 'pod-a', name: 'Deck pod-a', cube: 'Cube', createdAt: 1, pool, deck: built, concluded: true }],
    });
    fireEvent.click(screen.getByTestId('browse-tab-mine'));
    await waitFor(() => expect(chosen()).toBe('mine:pod-a'));
    expect(server.calls.filter((c) => c.url.endsWith('/deck'))).toHaveLength(0);
  });

  it('Hand smoothing: on by default, and the leader’s toggle turns it off on the room', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null });
    await screen.findByTestId('hand-smoothing');
    // Each state is its own element (`ActionButton`): read the toggle afresh after every press.
    const toggle = (): HTMLElement => screen.getByTestId('hand-smoothing');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('false'));
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ settings: { handSmoothing: false } }]);
  });

  it('Hand smoothing is the leader’s: a non-leader gets no toggle', async () => {
    await mountRoom({ players: [opponent()], matchId: null, leader: false });
    await waitFor(() => expect(screen.getByTestId('format-fixed')).toBeTruthy());
    expect(screen.queryByTestId('hand-smoothing')).toBeNull();
  });

  it('has no Best-of or Sideboarding toggle: a series starts as Bo1 and a Rematch makes it Bo3', async () => {
    await mountRoom({ players: [opponent()], matchId: null });
    await screen.findByTestId('hand-smoothing');
    expect(screen.queryByTestId('match-length')).toBeNull();
    expect(screen.queryByTestId('sideboarding')).toBeNull();
  });

  // The operator, 2026-10-21: "it's weird that it shows '2–0' even after i've stood up from the table.
  // i dont need that win display at all actually, just get rid of it."
  it('the room shows no series score, not even mid-series', async () => {
    await mountRoom({
      players: [opponent({ you: true, name: 'user-alice', seat: 0, ready: false }), opponent({ seat: 1, ready: false })],
      matchId: null,
      series: { length: 3, wins: [2, 0], games: [{ matchId: 'm-0', winner: 0 }, { matchId: 'm-1', winner: 0 }], phase: 'sideboarding' },
    });
    await screen.findByTestId('room-players');
    expect(screen.queryByTestId('series-score')).toBeNull();
    expect(document.body.textContent).not.toContain('2–0');
  });

  // The rejoin audit, 2026-10-19: a player back in the room between games of a
  // series had no sideboard step there, and readying skipped sideboarding.
  it('between games of a series, the room opens my sideboard step in place of the deck card', async () => {
    const mine = { deck: { library: SECOND_DECK }, rules: { kind: 'standard', format: '2010-07-16' } } as SeatChoice;
    await mountRoom({
      players: [opponent({ you: true, name: 'user-alice', seat: 0, ready: false, deck: { name: 'Jund (Emanuele Giusti)', rulesName: 'Standard (M11)', legal: true, issueCount: 0, choice: mine } }), opponent({ seat: 1, ready: false })],
      matchId: null,
      series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-0', winner: 0 }], phase: 'sideboarding' },
    });
    expect(await screen.findByTestId('table-sideboard')).toBeTruthy();
    expect(screen.getByTestId('sideboard-step')).toBeTruthy();
    expect(screen.queryByTestId('deck-mine')).toBeNull();
  });

  it('Free pick reads as its name to a non-leader, who gets no toggle', async () => {
    await mountRoom({ players: [opponent()], matchId: null, leader: false, format: 'free' });
    expect(screen.getByTestId('format-fixed').textContent).toBe('Free pick');
    expect(screen.queryByTestId('free-pick')).toBeNull();
    await waitFor(() => expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]));
  });

  it('follows the pool the leader moved it to, on a browser that pressed nothing', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null, leader: false });
    await pick(UG_POLYMORPH);
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false));

    // The leader's browser moved it; this one learns it from a room re-read.
    server.table.format = '2011-07-15';

    // The held deck is re-sent — this seat's verdict was cleared by the change
    // too — and the pool that bans it marks it illegal and takes it off the list.
    await waitFor(() => expect(myReadyOpen()).toBe(false));
    expect(screen.getByTestId('format-fixed').textContent).toBe('2011-07-15 — Standard (M12)');
    await waitFor(() => expect(offered()).not.toContain(UG_POLYMORPH));
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(lastCall(server.calls, `/tables/rooms/${ROOM}/deck`)?.body).toEqual({ deck: { library: UG_POLYMORPH } });
  });

  // The operator, 2026-10-16: "'[Crown] Hadoku (you)' this can be shown as just a crown next to
  // the player's name in their seat. doesn't need to be on the format row".
  it('crowns the leader’s own seat, beside the name, and draws no leader chip on the format row', async () => {
    await mountRoom({ players: [opponent(), opponent({ name: 'user-alice', you: true })], matchId: null });
    await deckPicker();
    const crown = screen.getByTestId('room-leader');
    expect(crown.closest('[data-testid="room-seat-1"]'), 'on my seat, the leader’s').not.toBeNull();
    expect(crown.getAttribute('aria-label')).toBe('Room owner');
    expect(crown.querySelector('path')).not.toBeNull();
    expect(screen.getByTestId('room-seat-1').querySelector('.pod-seats__label')?.textContent).toBe('user-alice');
    // No prose: nothing on the deck card explains what a leader is or may do.
    const card = screen.getByTestId('deck-mine').closest('section') as HTMLElement;
    expect(card.querySelector('[data-testid="room-leader"]')).toBeNull();
    expect(card.textContent).not.toMatch(/room leader|can change|only the/i);
  });

  it('crowns the seat of a leader who is somebody else, and no seat while the leader is not seated', async () => {
    await mountRoom({ players: [opponent()], matchId: null, leader: false });
    await deckPicker();
    expect(screen.queryByTestId('room-leader'), 'the leader holds no seat').toBeNull();
    cleanup();
    await mountRoom({ players: [opponent({ name: 'user-alice' })], matchId: null, leader: false });
    expect((await screen.findByTestId('room-leader')).closest('[data-testid="room-seat-0"]')).not.toBeNull();
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

  /** The pod lobby with these members seated, in order, and the AI in every other seat. */
  const seatedPod = (...ids: string[]) => ({
    phase: 'lobby',
    seats: Array.from({ length: 8 }, (_, i) => (i < ids.length ? { memberId: ids[i]!, name: ids[i]! } : { memberId: 'ai', name: 'AI' })),
    round: 0,
    rounds: 0,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: [],
    built: [],
    // wave 73 §A: PodView gains these three (PodViewSchema is a strictObject,
    // so a pod literal missing them fails parsePodView and nothing renders).
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    planName: 'Test Cube',
    verdict: null,
  });

  async function mountDraft(table: Partial<Table> = {}, feed: RoomFeed = everyMs(10)) {
    const server = stubServer({ players: [], matchId: null, gameType: 'draft', members: members(false), ...table });
    render(
      createElement(ConstructedScreen, {
        client: server.client, deckRecords: server.deckRecords,
        rooms: server.rooms,
        roomId: ROOM,
        feed,
        makeTransport: stubTransport,
      }),
    );
    return server;
  }

  it('shows the room’s lobby and NOT a pack: nothing is dealt before everyone is ready', async () => {
    const stepped = steppedFeed();
    const server = await mountDraft({ members: members(false, false) }, stepped.feed);
    await screen.findByTestId('draft-lobby');

    expect(screen.queryByTestId('draft-state'), 'no line saying who is waited on').toBeNull();

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
    await stepped.reread(6);
    expect(sweeps(server)).toHaveLength(0);
    // Nor is a single table write made: `routes.ts` answers 409 to all of them.
    expect(server.calls.filter((c) => c.url.includes('/tables/rooms/') && c.method !== 'GET')).toHaveLength(0);
    expect(server.calls.filter((c) => c.url.endsWith('/play/matches'))).toHaveLength(0);
  });

  it('has no prose explaining the rule', async () => {
    await mountDraft();
    await screen.findByTestId('draft-lobby');
    expect(screen.queryByTestId('draft-rule')).toBeNull();
    expect(screen.getByTestId('draft-lobby').textContent).not.toMatch(/never before|played for|whatever is left/);
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
    await waitFor(() => expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).textContent).toBe('Stand down'));

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

  it('draws every pill state in a border style of its own, so colour is never the only signal', async () => {
    await mountDraft({ members: members(true, false), pod: seatedPod('p-alice', 'p-1') });
    await screen.findByTestId('pod-seats');
    const borders = pillBorders(styled());
    expect([...borders.keys()].sort()).toEqual(['no', 'yes']);
    expect(new Set(borders.values()).size, JSON.stringify([...borders])).toBe(borders.size);
  });

  it('marks which member is the leader, with a mark and not a sentence', async () => {
    await mountDraft({ members: members(false, false), pod: seatedPod('p-alice', 'p-1') });
    await screen.findByTestId('pod-seats');

    // `p-alice` is the room's `leader`, and a member's ID is the only thing
    // that identifies them — the display name is not unique.
    // The seat rows' own crown, beside the name.
    expect(screen.getByTestId('pod-seat-0-leader').querySelector('path')).not.toBeNull();
    // Exactly one member carries it, and the other says nothing.
    expect(screen.queryByTestId('pod-seat-1-leader')).toBeNull();
    expect(screen.getByTestId('pod-seat-1').textContent).not.toMatch(/leader|owner/i);
  });

  it('starts the draft exactly once when every seated player is ready, and only then', async () => {
    // One seated player still not ready: nothing is asked for, however often it re-reads.
    const stepped = steppedFeed();
    const server = await mountDraft({ members: members(true, false), pod: seatedPod('p-alice', 'p-1') }, stepped.feed);
    await screen.findByTestId('draft-lobby');
    await stepped.reread(8);
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`))).toHaveLength(0);
    expect(screen.queryByTestId('pod')).toBeNull();

    // The other browser readies up; this one learns it from a re-read and deals.
    server.table.members = members(true, true);
    await stepped.reread(1);
    await waitFor(() => expect(screen.queryByTestId('pod')).not.toBeNull());
    const starts = server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({ url: `/cardtable/api/rooms/${ROOM}/start`, method: 'POST', body: {} });

    // And a re-read does not ask again now that it has started.
    await stepped.reread(8);
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`))).toHaveLength(1);
  });

  // The operator, 2026-10-19: "the room should not wait on spectators to be ready", and "drafts
  // should not immediately start with open seats".
  it('does not wait on a member who never sat, and does not deal with a seat open', async () => {
    const stepped = steppedFeed();
    const open = { ...seatedPod('p-alice'), seats: [{ memberId: 'p-alice', name: 'user-alice' }, null, ...seatedPod().seats.slice(2)] };
    const server = await mountDraft({ members: members(true, false), pod: open }, stepped.feed);
    await screen.findByTestId('draft-lobby');
    await stepped.reread(4);
    expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`)), 'a seat is open').toHaveLength(0);
    // The AI takes the open seat; user-1, watching and not ready, is not waited on.
    server.table.pod = seatedPod('p-alice');
    await stepped.reread(1);
    await waitFor(() => expect(server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`))).toHaveLength(1));
  });

  it('renders the pod, with every hook it had as its own route, once draftStartedAt is set', async () => {
    await mountDraft({ draftStartedAt: '2026-09-26T10:00:00.000Z', members: members(true) });
    await screen.findByTestId('pod');

    expect(screen.getByTestId('pod-seats')).toBeTruthy();
    expect(screen.getByTestId('pod-waiting')).toBeTruthy();
    // No invite link and no copy button: the operator, 2026-10-20 — "useless".
    expect(screen.queryByTestId('copy-invite')).toBeNull();
    expect(screen.queryByTestId('invite-url')).toBeNull();

    // The lobby phase is gone, and the constructed table never appeared.
    expect(screen.queryByTestId('draft-lobby')).toBeNull();
    expect(screen.queryByTestId('deck-mine')).toBeNull();
  });

  it('says what the server refused, and asks again only when told to', async () => {
    const stepped = steppedFeed();
    const server = await mountDraft(
      { members: members(true, true), pod: seatedPod('p-alice', 'p-1'), refuseRoomWrite: { status: 409, error: 'this room plays constructed-1v1, not draft' } },
      stepped.feed,
    );
    const refused = await screen.findByTestId('draft-error');
    expect(refused.textContent).toContain('this room plays constructed-1v1, not draft');
    expect(screen.queryByTestId('pod')).toBeNull();

    // One attempt, not one per re-read.
    const attempts = () => server.calls.filter((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`)).length;
    const once = attempts();
    expect(once).toBe(1);
    await stepped.reread(6);
    expect(attempts()).toBe(once);

    // Told to, it asks again — and this time the server deals.
    server.table.refuseRoomWrite = undefined;
    await act(async () => {
      fireEvent.click(screen.getByTestId('draft-retry'));
    });
    await waitFor(() => expect(screen.queryByTestId('pod')).not.toBeNull());
  });

  it('still joins the room it was opened on, so a draft invite link works', async () => {
    // The table read is what joins you (`routes.ts` answers a non-member the
    // same 404 as a missing room), and a draft room needs that as much as a
    // constructed one: the invite link is the only way a friend gets in. This
    // is why the table read is NOT switched off for a draft room.
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

/* ── tournament mode (docs/planning/tournament-mode-plan.md) ──────────── */

describe('tournament mode', () => {
  const members = (...ready: boolean[]) =>
    ready.map((r, i) => ({ id: i === 0 ? 'p-alice' : `p-${i}`, name: i === 0 ? 'user-alice' : `user-${i}`, ready: r }));
  const emptySeats = (): ({ memberId: string; name: string } | null)[] => Array.from({ length: 8 }, () => null);

  /** A constructed tournament pod: `plan`/`planName`/`verdict` null/''/null — it never drafts (the landed contract, `@hadoku/shared`'s `pod.ts`). */
  const tournamentPod = (over: Record<string, unknown> = {}) => ({
    phase: 'lobby',
    seats: emptySeats(),
    round: 0,
    rounds: 0,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: [],
    built: [],
    plan: null,
    planName: '',
    verdict: null,
    ...over,
  });

  async function mountTournament(table: Partial<Table> = {}, feed: RoomFeed = everyMs(10)) {
    const server = stubServer({
      players: [],
      matchId: null,
      members: members(true),
      settings: { tournament: true, tournamentDecks: 'locked' },
      pod: tournamentPod(),
      ...table,
    });
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms, roomId: ROOM, feed }));
    await screen.findByTestId('constructed-mode');
    return server;
  }

  it('shows Tournament in the options row; turning it on shows Decks, defaulted to Locked', async () => {
    await mountTournament({ settings: { tournament: false, tournamentDecks: 'locked' }, pod: null });
    expect(screen.getByTestId('tournament-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('tournament-decks')).toBeNull();

    screen.getByTestId('tournament-toggle').click();
    await waitFor(() => expect(screen.getByTestId('tournament-toggle').getAttribute('aria-pressed')).toBe('true'));
    expect((screen.getByTestId('tournament-decks-locked') as HTMLInputElement).checked).toBe(true);
  });

  it('leaves Gauntlet live in the mode row while Tournament is on, and Tournament live while the mode is Gauntlet — any of the three modes may run a tournament', async () => {
    await mountTournament({ settings: { tournament: true, tournamentDecks: 'locked' }, pod: null });
    expect((screen.getByTestId('constructed-mode-gauntlet') as HTMLInputElement).disabled, 'Tournament on: Gauntlet still a live choice').toBe(false);
    expect((screen.getByTestId('constructed-mode-classic') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId('constructed-mode-random') as HTMLInputElement).disabled).toBe(false);

    screen.getByTestId('constructed-mode-gauntlet').click();
    await waitFor(() => expect((screen.getByTestId('constructed-mode-gauntlet') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByTestId('tournament-toggle') as HTMLButtonElement).disabled, 'mode is Gauntlet: Tournament stays a live toggle').toBe(false);
  });

  it('a non-leader reads Tournament and Decks disabled, never able to move them', async () => {
    await mountTournament({ leader: false, settings: { tournament: true, tournamentDecks: 'per-round' } });
    expect((screen.getByTestId('tournament-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tournament-decks-per-round') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('tournament-decks-per-round') as HTMLInputElement).checked).toBe(true);
  });

  it('replaces the 1v1 "At the table" seats with the pod seat strip while the pod is in its lobby', async () => {
    await mountTournament();
    expect(screen.queryByTestId('room-players')).toBeNull();
    expect(screen.getByTestId('tournament-lobby')).not.toBeNull();
    expect(screen.getByTestId('pod-seats')).not.toBeNull();
    // The AI button is offered on an open seat, same as a draft pod's (the operator, 2026-10-22).
    expect(screen.getAllByTestId('pod-seat-ai').length).toBeGreaterThan(0);
  });

  // All Random, not Classic, for this one: Lock's own human-ready test is
  // `member.ready` for Random (`room/lobby.ts`'s `#lockTournament`) — directly
  // observable for every human, unlike Classic's "a legal deck already held",
  // which this screen can only see for its OWN seat (`TournamentPodLobby.tsx`'s
  // own header). Classic's version of this gate is exercised live, end to end,
  // in `e2e/tournament.spec.ts` instead of guessed at here.
  const randomMode = { mode: 'random' as const, modeOptions: { pool: 'full' as const } };

  // Ruling 7 (operator, 2026-10-22): "why is there a 'lock seats' button? …
  // the seats lock when all players are ready and the games start." There is
  // nothing left to press — Ready is the only write, same `/ready` route as
  // every other room, and the server locks by itself (`room/lobby.ts`'s
  // `#maybeLockTournament`, proven in `lobby.test.ts`).
  it('draws no Lock seats button, ready or not: Ready is a plain /ready write', async () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'p-alice', name: 'user-alice' };
    seats[1] = { memberId: 'p-1', name: 'user-1' };
    const server = await mountTournament({ mode: randomMode, members: members(true, false), pod: tournamentPod({ seats }) });
    expect(screen.queryByTestId('pod-lock-seats')).toBeNull();
    screen.getByTestId('ready-toggle').click();
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith(`/api/rooms/${ROOM}/ready`))).toBe(true));
    expect(server.calls.some((c) => c.url.endsWith(`/api/rooms/${ROOM}/start`))).toBe(false);
  });

  it('shows the AI action on an open seat, and seating it sends the write', async () => {
    const server = await mountTournament();
    const seat0Ai = screen.getAllByTestId('pod-seat-ai')[0]!;
    seat0Ai.click();
    await waitFor(() => expect(aiPod).toHaveBeenCalledWith(ROOM, 0, true));
    void server;
  });

  it('once seats lock (rounds), draws the bracket and standings instead of the lobby strip', async () => {
    await mountTournament({
      pod: tournamentPod({
        phase: 'rounds',
        round: 1,
        rounds: 1,
        pairings: [{ tableId: 't-stub0001', players: ['p-alice', 'p-1'] }],
      }),
      members: members(true, true),
      players: [],
    });
    await screen.findByTestId('pod-tables');
    expect(screen.queryByTestId('tournament-lobby')).toBeNull();
    expect(screen.queryByTestId('room-players')).toBeNull();
    expect(screen.getByTestId('pod-round').textContent).toBe('Round 1 of 1');
    expect(screen.queryByTestId('pod-lock-seats')).toBeNull();
  });

  it('a real run, 2026-10-22 (room r-228e5e39987e): never follows a match on the room’s stale tables[0] — my own CURRENT round table is what surfaces', async () => {
    await mountTournament({
      // The stale table (`t-stub0001`, what every OTHER field here feeds) — as
      // if Alice had sat here before ever turning Tournament on, and a match
      // somehow still named it. The fix must never read or follow it.
      players: [{ seat: 0, name: 'user-alice', you: true, ready: false }],
      matchId: 'm-stale',
      pod: tournamentPod({
        phase: 'rounds',
        round: 1,
        rounds: 1,
        pairings: [{ tableId: 't-round1', players: ['p-alice', 'p-1'] }],
      }),
      members: members(true, true),
      extraTables: [{ id: 't-round1', players: [{ memberId: 'p-alice', name: 'user-alice' }], matchId: null }],
    });
    await screen.findByTestId('pod-tables');
    // Never navigated into the stale match.
    expect(globalThis.location.hash).toBe('');
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });

  it('once the pod is done, heads with Standings rather than a round number', async () => {
    await mountTournament({
      pod: tournamentPod({ phase: 'done', round: 1, rounds: 1 }),
      members: members(true, true),
      players: [],
    });
    await screen.findByTestId('pod-tables');
    expect(screen.queryByTestId('pod-round')).toBeNull();
    expect(screen.getByText('Standings')).not.toBeNull();
  });
});

/* ── the two clients (D19a) ──────────────────────────────────────────── */

describe('a streamed room', () => {
  /** Mounts a room whose stream route answers however `stream` says. */
  async function mountStreamed(table: Table, stream: Fetch) {
    const server = stubServer({ clientMode: 'streamed', ...table });
    render(
      createElement(ConstructedScreen, {
        client: server.client, deckRecords: server.deckRecords,
        rooms: server.rooms,
        roomId: ROOM,
        feed: everyMs(10),
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

/* ── the room's mode (constructed-modes plan, ruling 8) ───────────────── */

describe('the room’s mode', () => {
  /** Mounts a room whose seats card may be absent (no mode yet): waits for the mode row instead. */
  async function mountModeRoom(table: Table) {
    const server = stubServer(table);
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms, myDecks: server.myDecks, roomId: ROOM, feed: everyMs(10) }));
    await screen.findByTestId('constructed-mode');
    return server;
  }
  const radio = (mode: string) => screen.getByTestId(`constructed-mode-${mode}`) as HTMLInputElement;

  it('with no mode chosen, the mode row is the whole room: no seats, no deck picker, nothing chosen', async () => {
    await mountModeRoom({ players: [], matchId: null, mode: null });
    expect(['classic', 'gauntlet', 'random'].map((m) => [radio(m).checked, radio(m).disabled])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(screen.getByTestId('constructed-mode').textContent).toBe('ClassicGauntletAll Random');
    expect(screen.queryByTestId('room-players')).toBeNull();
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.queryByTestId('format-tabs')).toBeNull();
  });

  it('is the leader’s: everybody else sees the row disabled, and no words about it', async () => {
    await mountModeRoom({ players: [], matchId: null, mode: null, leader: false });
    for (const m of ['classic', 'gauntlet', 'random']) expect(radio(m).disabled).toBe(true);
    expect(screen.getByTestId('constructed').textContent).not.toMatch(/leader|wait/i);
  });

  it('the leader picks Classic: the room moves to it, and the format row and the deck picker appear', async () => {
    const server = await mountModeRoom({ players: [], matchId: null, mode: null });
    fireEvent.click(radio('classic'));
    await screen.findByTestId('deck-mine');
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ mode: 'classic', modeOptions: {} }]);
    expect(radio('classic').checked).toBe(true);
    expect(screen.getByTestId('format-tabs')).toBeTruthy();
    expect(screen.getByTestId('room-players')).toBeTruthy();
  });

  it('All Random deals the decks: no deck picker, and my seat may ready without one', async () => {
    const server = await mountModeRoom({ players: [], matchId: null, mode: null });
    fireEvent.click(radio('random'));
    await screen.findByTestId('room-players');
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)[0]).toEqual({ mode: 'random', modeOptions: { pool: 'full' } });
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    expect(screen.queryByTestId('format-tabs')).toBeNull();
    expect((screen.getByTestId('random-pool-full') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('random-pool-modern'));
    await waitFor(() => expect((screen.getByTestId('random-pool-modern') as HTMLInputElement).checked).toBe(true));
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body).at(-1)).toEqual({ mode: 'random', modeOptions: { pool: 'modern' } });
    server.table.players = [{ ...mySeat(), deck: null }];
    expect(await screen.findByTestId('ready-toggle')).toHaveProperty('disabled', false);
  });

  it('changing the mode is picking another card, until somebody is ready', async () => {
    const server = await mountModeRoom({ players: [opponent()], matchId: null });
    expect(radio('classic').checked).toBe(true);
    fireEvent.click(radio('gauntlet'));
    await waitFor(() => expect(radio('gauntlet').checked).toBe(true));
    expect(screen.queryByTestId('deck-mine')).toBeNull();
    server.table.players = [opponent({ ready: true })];
    await waitFor(() => expect(radio('classic').disabled).toBe(true));
    for (const m of ['classic', 'gauntlet', 'random']) expect(radio(m).disabled).toBe(true);
  });

  it('Gauntlet offers the server’s families and years, or Random: the leader’s picks are the room’s options', async () => {
    const server = await mountModeRoom({ players: [], matchId: null, mode: { mode: 'gauntlet', modeOptions: {} } });
    const families = await screen.findByTestId('gauntlet-family');
    // Standard has no era with ten decks here, so it is not offered.
    expect(families.textContent).toBe('ModernLegacyRandom');
    expect((screen.getByTestId('gauntlet-family-random') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('gauntlet-era')).toBeNull();
    expect(screen.queryByTestId('deck-mine')).toBeNull();

    fireEvent.click(screen.getByTestId('gauntlet-family-modern'));
    const era = (await screen.findByTestId('gauntlet-era')) as HTMLSelectElement;
    expect([...era.options].map((o) => o.textContent)).toEqual(['Random', '2014', '2012']);
    fireEvent.change(era, { target: { value: 'modern-2012-07-13' } });
    await waitFor(() => expect((screen.getByTestId('gauntlet-era') as HTMLSelectElement).value).toBe('modern-2012-07-13'));
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { mode: 'gauntlet', modeOptions: { family: 'modern' } },
      { mode: 'gauntlet', modeOptions: { family: 'modern', era: 'modern-2012-07-13' } },
    ]);
  });

  it('a Gauntlet seat readies with the Gauntlet, not the table, and once it is ready the mode is fixed', async () => {
    const server = await mountModeRoom({ players: [{ ...mySeat(), deck: null }, opponent()], matchId: null, mode: { mode: 'gauntlet', modeOptions: {} } });
    const ready = await screen.findByTestId('ready-toggle');
    await waitFor(() => expect(ready).toHaveProperty('disabled', false));
    fireEvent.click(ready);
    await waitFor(() => expect(radio('classic').disabled).toBe(true));
    expect(server.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/gauntlet/ready')).map((c) => c.body)).toEqual([{ ready: true }]);
    expect(server.calls.some((c) => c.url.endsWith(`/tables/rooms/${ROOM}/ready`))).toBe(false);
    expect(screen.getByTestId('ready-toggle').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('gauntlet-family-random') as HTMLInputElement).disabled).toBe(true);
  });

  it('a drawn Gauntlet draws its board in the room, and the mode stays fixed', async () => {
    await mountModeRoom({
      players: [{ ...mySeat(), deck: null }, opponent()],
      matchId: null,
      mode: { mode: 'gauntlet', modeOptions: { family: 'modern' } },
      gauntlet: {
        phase: 'reveal',
        you: 0,
        players: [
          { memberId: 'p-alice', name: 'user-alice' },
          { memberId: 'p-bob', name: 'user-bob' },
        ],
        ready: [true, true],
        era: { id: 'modern-2014-07-18', family: 'modern', title: 'Modern — 2014' },
        revealAt: Date.now(),
        first: 0,
        decks: [],
        step: null,
        games: [],
        choice: null,
        winner: null,
      },
    });
    expect((await screen.findByTestId('gauntlet-title')).textContent).toBe('Modern — 2014');
    for (const m of ['classic', 'gauntlet', 'random']) expect(radio(m).disabled).toBe(true);
    expect(screen.getByTestId('ready-toggle')).toHaveProperty('disabled', true);
  });

  it('a Gauntlet read the feed asked before a newer one cannot put the older board back when it lands after it', async () => {
    const server = stubServer({ players: [{ ...mySeat(), deck: null }, opponent()], matchId: null, mode: { mode: 'gauntlet', modeOptions: {} } });
    const stepped = steppedFeed();
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms, roomId: ROOM, feed: stepped.feed }));
    const ready = await screen.findByTestId('ready-toggle');
    await waitFor(() => expect(ready.getAttribute('aria-pressed')).toBe('false'));
    // A ping whose read parks on the wire holding the board as it is: nobody ready.
    const releaseOlder = server.holdNextGauntletRead();
    await stepped.reread(1);
    // The other screen readies me (my second tab), and the next ping's read lands first.
    server.table.gauntlet = { ...gauntletOf(server.table), ready: [true, false] };
    await stepped.reread(1);
    await waitFor(() => expect(screen.getByTestId('ready-toggle').getAttribute('aria-pressed')).toBe('true'));
    releaseOlder();
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    expect(screen.getByTestId('ready-toggle').getAttribute('aria-pressed'), 'the older board did not come back').toBe('true');
  });

  // The operator, 2026-10-21: "the avatar isn't rendering properly on the coinflip animation".
  it('the Gauntlet’s coin wears each player’s own avatar, as the match’s coin does', async () => {
    await mountModeRoom({
      players: [{ ...mySeat(), deck: null }, opponent()],
      matchId: null,
      mode: { mode: 'gauntlet', modeOptions: { family: 'modern' } },
      members: [
        { id: 'p-alice', name: 'user-alice', avatarId: 'fox' },
        { id: 'p-bob', name: 'user-bob', avatarId: 'owl' },
      ],
      gauntlet: {
        phase: 'reveal',
        you: 0,
        players: [
          { memberId: 'p-alice', name: 'user-alice' },
          { memberId: 'p-bob', name: 'user-bob' },
        ],
        ready: [true, true],
        era: { id: 'modern-2014-07-18', family: 'modern', title: 'Modern — 2014' },
        // Opened mid-flip: the title has landed and the coin is up.
        revealAt: Date.now() - TITLE_MS - 200,
        first: 1,
        decks: [],
        step: null,
        games: [],
        choice: null,
        winner: null,
      },
    });
    const coin = await screen.findByTestId('coin-toss');
    const face = (side: string): string | null => coin.querySelector(`.coin-toss__face--${side} img`)?.getAttribute('src') ?? null;
    expect([face('front'), face('back')], 'the winner (P1, bob) on the front, alice on the back').toEqual([
      expect.stringMatching(/square_owl\.png$/),
      expect.stringMatching(/square_fox\.png$/),
    ]);
  });

  /** A Gauntlet between two people, in `phase`, as the server's view for alice. */
  const gauntletAt = (phase: GauntletView['phase'], extra: Partial<GauntletView> = {}): GauntletView => ({
    phase,
    you: 0,
    players: [
      { memberId: 'p-alice', name: 'user-alice' },
      { memberId: 'p-bob', name: 'user-bob' },
    ],
    ready: [false, false],
    era: { id: 'modern-2014-07-18', family: 'modern', title: 'Modern — 2014' },
    revealAt: 0,
    first: 0,
    decks: [],
    step: null,
    games: [{ decks: ['d-1', null], winner: null }],
    choice: null,
    winner: null,
    ...extra,
  });

  it('from the choice straight into the game: while a Gauntlet game is dealt and starting, the room stays on the choose screen — no lobby, no versus card (ruling 13.2)', async () => {
    const server = stubServer({ players: [{ ...mySeat(), deck: null }, opponent()], matchId: null, mode: { mode: 'gauntlet', modeOptions: {} }, gauntlet: gauntletAt('playing') });
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms, myDecks: server.myDecks, roomId: ROOM, feed: everyMs(10) }));
    await screen.findByTestId('gauntlet-choose');
    expect(screen.queryByTestId('gauntlet-playing')).toBeNull();
    expect(screen.queryByTestId('gauntlet-game')).toBeNull();
    // The room around it is the one the choice was made on: its mode row and its seats stay put.
    expect(screen.getByTestId('room-players')).toBeTruthy();
    expect(radio('gauntlet').checked).toBe(true);
  });

  it('a decided Gauntlet frees the room: the mode is the leader’s again, the seat stands, and Ready begins a new one (ruling 13.4)', async () => {
    const server = await mountModeRoom({
      players: [{ ...mySeat(), deck: null }, opponent()],
      matchId: null,
      mode: { mode: 'gauntlet', modeOptions: {} },
      gauntlet: gauntletAt('done', { games: [{ decks: ['d-1', 'd-2'], winner: 1 }], winner: 1 }),
    });
    await screen.findByTestId('gauntlet-result');
    for (const m of ['classic', 'gauntlet', 'random']) expect(radio(m).disabled).toBe(false);
    expect(screen.getByTestId('seat-stand')).toHaveProperty('disabled', false);
    const ready = screen.getByTestId('ready-toggle');
    expect(ready.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(ready).toHaveProperty('disabled', false));
    fireEvent.click(ready);
    await waitFor(() => expect(server.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/gauntlet/ready')).map((c) => c.body)).toEqual([{ ready: true }]));
  });

  it('a mode change the server refuses says so in its words', async () => {
    await mountModeRoom({ players: [], matchId: null, refusePatch: { status: 409, error: 'mode-locked' } });
    fireEvent.click(radio('random'));
    expect((await screen.findByTestId('table-error')).textContent).toContain('mode-locked');
    expect(radio('classic').checked).toBe(true);
  });
});

/* ── the room's type: Constructed or Draft, in the room as in the create form ── */

describe('the room’s type', () => {
  async function mountTypeRoom(table: Table) {
    const server = stubServer(table);
    render(createElement(ConstructedScreen, { client: server.client, deckRecords: server.deckRecords, rooms: server.rooms, myDecks: server.myDecks, roomId: ROOM, feed: everyMs(10), makeTransport: () => ({ on: () => {}, emit: () => {}, disconnect: () => {} }) }));
    await screen.findByTestId('room-game-type');
    return server;
  }
  const typeRadio = (type: string) => screen.getByTestId(`room-game-type-${type}`) as HTMLInputElement;
  const both = () => ['constructed-1v1', 'draft'].map((t) => [typeRadio(t).checked, typeRadio(t).disabled]);
  const finished = { length: 1 as const, wins: [1, 0] as [number, number], games: [{ matchId: MATCH, winner: 0 as const }], phase: 'done' as const };

  it('a finished match leaves the leader the type, the create form’s two cards, Constructed chosen', async () => {
    await mountTypeRoom({ players: [opponent(), mySeat()], matchId: null, series: finished });
    expect(screen.getByTestId('room-game-type').textContent).toBe('ConstructedDraft');
    expect(both()).toEqual([
      [true, false],
      [false, false],
    ]);
  });

  it('is the leader’s: everybody else sees it disabled, and no words about it', async () => {
    await mountTypeRoom({ players: [opponent()], matchId: null, leader: false });
    expect(both()).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(screen.getByTestId('room-game-type').closest('section')?.textContent).not.toMatch(/leader|wait/i);
  });

  it('is locked when the mode is: somebody ready, or a match live', async () => {
    const server = await mountTypeRoom({ players: [opponent()], matchId: null });
    expect(typeRadio('draft').disabled).toBe(false);
    server.table.players = [opponent({ ready: true })];
    await waitFor(() => expect(typeRadio('draft').disabled).toBe(true));
    expect(typeRadio('constructed-1v1').disabled).toBe(true);
    server.table.players = [opponent()];
    await waitFor(() => expect(typeRadio('draft').disabled).toBe(false));
    server.table.matchId = MATCH;
    await waitFor(() => expect(typeRadio('draft').disabled).toBe(true));
  });

  it('is locked while a Gauntlet is under way, and the leader’s again once it is decided', async () => {
    const server = await mountTypeRoom({
      players: [],
      matchId: null,
      mode: { mode: 'gauntlet', modeOptions: {} },
      gauntlet: { ...gauntletOf({ players: [], matchId: null }), ready: [false, true] },
    });
    await waitFor(() => expect(typeRadio('draft').disabled).toBe(true));
    server.table.gauntlet = { ...gauntletOf({ players: [], matchId: null }), phase: 'done', winner: 1 };
    await waitFor(() => expect(typeRadio('draft').disabled).toBe(false));
  });

  it('switching is picking the other card: Draft draws the draft lobby, and Constructed brings the mode row back', async () => {
    const server = await mountTypeRoom({ players: [opponent()], matchId: null, series: finished });
    fireEvent.click(typeRadio('draft'));
    await screen.findByTestId('draft-lobby');
    expect(typeRadio('draft').checked).toBe(true);
    expect(screen.queryByTestId('constructed-mode')).toBeNull();

    fireEvent.click(typeRadio('constructed-1v1'));
    await screen.findByTestId('constructed-mode');
    expect(screen.queryByTestId('draft-lobby')).toBeNull();
    expect(typeRadio('constructed-1v1').checked).toBe(true);
    expect(server.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ gameType: 'draft' }, { gameType: 'constructed-1v1' }]);
  });

  it('a draft room offers it too, disabled for everybody but the leader', async () => {
    await mountTypeRoom({ players: [], matchId: null, gameType: 'draft', members: [{ id: 'p-alice', name: 'user-alice' }], leader: false });
    await screen.findByTestId('draft-lobby');
    expect(both()).toEqual([
      [false, true],
      [true, true],
    ]);
  });

  it('a type change the server refuses says so in its words, and the room stays what it was', async () => {
    await mountTypeRoom({ players: [], matchId: null, refusePatch: { status: 409, error: 'a seated player is ready; the game type cannot change now' } });
    fireEvent.click(typeRadio('draft'));
    expect((await screen.findByTestId('table-error')).textContent).toContain('the game type cannot change now');
    expect(typeRadio('constructed-1v1').checked).toBe(true);
    expect(screen.queryByTestId('draft-lobby')).toBeNull();
  });
});

describe('a builtin room is what it has always been', () => {
  it('says nothing under its name, and draws no stream anywhere', async () => {
    // The operator, 2026-10-21: "i don't need the 'Constructed 1v1' title inside the room".
    await mountRoom({ players: [opponent()], matchId: null, clientMode: 'builtin' });
    expect(screen.queryByTestId('room-client-mode')).toBeNull();
    expect(screen.queryByTestId('room-streams')).toBeNull();
    expect(screen.queryByTestId('stream-seat')).toBeNull();
    expect(screen.getByTestId('deck-mine')).toBeTruthy();
  });

  it('shows none of the draft furniture, and asks for no room write of its own', async () => {
    // The other half of the branch: `constructed-1v1` must be what it was, and
    // the draft lobby must not leak into it.
    const server = await mountRoom({ players: [opponent(), opponent({ name: 'user-alice', you: true })], matchId: null });
    expect(screen.queryByTestId('draft-lobby')).toBeNull();
    expect(screen.queryByTestId('draft-members')).toBeNull();
    expect(screen.queryByTestId('draft-rule')).toBeNull();
    expect(screen.queryByTestId('pod')).toBeNull();
    // The one shared id belongs to my seat's own toggle here.
    expect(screen.getByTestId('ready-toggle').closest('[data-testid="room-seat-1"]')).not.toBeNull();
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
    // table read is asking, and that read reports the outage in words.
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
describe('a room read that overlapped the leader’s own write', () => {
  it('cannot put the older room back: the era the leader just chose stays chosen', async () => {
    // CI 2026-10-08 (w48's spec): a read answered before a format PATCH landed after it and the
    // picker showed nothing chosen for a beat. A read issued before a write resolved is dropped and read again.
    // A slow beat, so the stale answer is not papered over by the next read before this test looks.
    const server = await mountRoom({ players: [opponent()], matchId: null }, undefined, everyMs(400));
    const select = screen.getByTestId('format') as HTMLSelectElement;
    expect(select.value).toBe(FORMATS[0].id);
    const reads = () => server.calls.filter((c) => c.method === 'GET' && c.url.endsWith(`/api/rooms/${ROOM}`)).length;
    const before = reads();
    const release = server.holdNextRoomRead();
    // The next read parks holding the OLD record.
    await waitFor(() => expect(reads()).toBeGreaterThan(before), { timeout: 2_000 });
    fireEvent.change(select, { target: { value: '2011-07-15' } });
    await waitFor(() => expect(select.value).toBe('2011-07-15'));
    release();
    // The stale answer lands now — and changes nothing.
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    expect(select.value, 'the stale read did not revert the pick').toBe('2011-07-15');
    expect(server.table.format).toBe('2011-07-15');
  });

  /**
   * Draft e2e, CI run 39039465853 (`e2e/draft.spec.ts`, "the operator's full
   * sequence…"): bob joined a fresh room the instant alice's own `PUT
   * …/deck` (choosing HER drafted pool, which also sets the room's format
   * through `choosePool`'s own write) was landing — so bob's OWN room read,
   * issued at mount before alice's write, raced a SECOND read of his own
   * (`rooms/feed.ts`'s "once when it starts following… once more when the
   * server confirms it is watching" — two of a screen's own reads, close
   * together, nothing unusual about it). The `writes.current` guard above
   * only drops a read that overlapped THIS SCREEN's own write; it does
   * nothing for two of this screen's own READS landing out of order, which
   * is exactly what let the earlier (stale, pool-less) one win and put
   * `pod`/`draftedDeck` back to null — the drafted option was never
   * rendered again, so bob's click (on a now-detached node, or nothing)
   * never reached `PUT …/deck`.
   */
  it('two of its own room reads landing out of order: the later one wins, even with no local write at all', async () => {
    const server = await mountRoom({ players: [opponent()], matchId: null }, undefined, everyMs(400));
    const select = screen.getByTestId('format') as HTMLSelectElement;
    expect(select.value).toBe(FORMATS[0].id);
    const reads = () => server.calls.filter((c) => c.method === 'GET' && c.url.endsWith(`/api/rooms/${ROOM}`)).length;
    const before = reads();
    const release = server.holdNextRoomRead();
    // The next read parks holding the OLD record — nobody local wrote anything.
    await waitFor(() => expect(reads()).toBeGreaterThan(before), { timeout: 2_000 });
    // Someone ELSE'S write lands on the stub server directly — `writes.current`
    // (this screen's own write counter) never moves.
    server.table.format = '2011-07-15';
    // The feed's own next tick (400ms) issues and resolves a SECOND, fresher
    // read before the held one is released.
    await waitFor(() => expect(select.value).toBe('2011-07-15'), { timeout: 2_000 });
    release();
    // The held, earlier-issued read's stale answer lands now.
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    expect(select.value, 'the stale, earlier-issued read did not win over the newer one').toBe('2011-07-15');
  });
});

describe('a room read a newer one overtook', () => {
  /**
   * CI `check` (39704881156, 39724078736 and four before them): the deck-peek
   * tests lost their peek mid-test. A room read slower than the feed's next
   * ping is dropped for the newer one — but it opened the screen's body first,
   * with no room record, so the picker drew the NEWEST era's decks (the
   * fallback pool) and then swapped to the room's own pool when the newer read
   * landed, closing whatever was open on it. The first answer the screen
   * keeps is the one that opens it.
   */
  it('opens nothing until the read the screen keeps has answered, so the picker never shows a pool the room is not on', async () => {
    const server = stubServer({ players: [opponent()], matchId: null });
    const stepped = steppedFeed();
    const releaseFirst = server.holdNextRoomRead();
    render(
      createElement(ConstructedScreen, {
        client: server.client,
        deckRecords: server.deckRecords,
        rooms: server.rooms,
        roomId: ROOM,
        feed: stepped.feed,
      }),
    );
    await waitFor(() => expect(roomReads(server)).toBe(1));
    // The feed pings again while the first read is still on the wire.
    const releaseSecond = server.holdNextRoomRead();
    await stepped.reread(1);
    expect(roomReads(server)).toBe(2);
    releaseFirst();
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    expect(screen.queryByTestId('deck-mine'), 'no picker from a read the screen dropped').toBeNull();
    releaseSecond();
    await deckPicker();
    expect(offered()).toEqual([UG_POLYMORPH, SECOND_DECK]);
  });
});

describe('the room answering before the catalogue', () => {
  it('still opens on the room’s own tab with its era chosen', async () => {
    // CI (w48's spec, 1 run in ~40): a reload where the room record arrived first settled the tab
    // while the era could not yet be named, and the Modern room read as the Standard tab, nothing chosen.
    await mountRoom({ players: [], matchId: null, format: MODERN.id, catalogueAfterRoom: true });
    await waitFor(() => expect(screen.getByTestId('format-tab-modern').getAttribute('aria-selected')).toBe('true'));
    expect((screen.getByTestId('format') as HTMLSelectElement).value).toBe(MODERN.id);
  });
});

describe('the era’s set symbols', () => {
  it('an eternal format draws no set strip at all — forty sets is not a row anyone reads', async () => {
    // The operator, 2026-10-07: "we shouldn't display the set symbols in modern like that".
    await mountRoom({ players: [], matchId: null, format: MODERN.id });
    await screen.findByTestId('deck-mine');
    expect(screen.getByTestId('format-tab-modern').getAttribute('aria-selected'), 'the room IS on the Modern era').toBe('true');
    expect((screen.getByTestId('format') as HTMLSelectElement).value).toBe(MODERN.id);
    expect(screen.queryByTestId('pool-sets')).toBeNull();
  });

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
  ];

  it('narrows to the chosen family, newest year first', () => {
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
    expect(poolIsOnTab(mixed, 'standard', '2014-07-18')).toBe(true);
    expect(poolIsOnTab(mixed, 'legacy', 'legacy-2016-07-22')).toBe(true);
  });

  it('is false while browsing a DIFFERENT family — even the tab’s own first (newest) era', () => {
    // The room is on the Standard era; browsing Legacy must not claim its
    // newest entry (the one a naive `<select>` would default-highlight).
    expect(poolIsOnTab(mixed, 'legacy', '2014-07-18')).toBe(false);
    expect(poolIsOnTab(mixed, 'modern', '2014-07-18')).toBe(false);
  });

});

/**
 * The auto-build, on its own: what a finished draft with no saved build is
 * shown as on the Decks page, so it has to be one deck and it has to be playable.
 */
describe('openDraftedDeck', () => {
  const POOL: DraftCard[] = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45);

  it('opens a build saved with only a sideboard with every other pick in the main deck', () => {
    const sideOnly = dckTextOf({ ...deckFromPool('pod', POOL.slice(0, 1)), main: [] });
    const deck = openDraftedDeck(sideOnly, 'pod', POOL);
    expect(mainDeckSize(deck)).toBe(44);
    expect(deck.sideboard.map((e) => [e.count, e.card.name])).toEqual([[1, POOL[0]!.name]]);
  });

  it('opens the auto-build when nothing is saved', () => {
    expect(openDraftedDeck(null, 'pod', POOL)).toEqual(draftedDeckOf('pod', POOL));
  });
});

describe('draftedDeckOf', () => {
  const POD = 'amber-lantern-k7q4';
  const POOL: DraftCard[] = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45);

  it('plays every drafted card and exactly DRAFTED_BASICS basics', () => {
    const deckBuilt = draftedDeckOf(POD, POOL);
    // Everything drafted is played, and nothing else can be: `newDeck` opens with
    // the pool sideboarded and only `moveToMain` moves anything.
    expect(deckBuilt.main.reduce((n, e) => n + e.count, 0)).toBe(45);
    expect(deckBuilt.sideboard).toEqual([]);
    // The lands, split by the maindeck's own pips.
    expect(deckBuilt.basics.reduce((n, e) => n + e.count, 0)).toBe(DRAFTED_BASICS);
    expect(mainDeckSize(deckBuilt)).toBe(45 + DRAFTED_BASICS);
    for (const entry of deckBuilt.basics) expect(BASIC_LAND_NAMES).toContain(entry.card.name);
  });

  it('splits the basics the way the editor\'s Auto does: a splashed colour gets its land', () => {
    const splash = POOL.map((card, i) => ({ ...card, manaCost: i === 0 ? ['W'] : ['R', 'R'] }));
    const deckBuilt = draftedDeckOf(POD, splash);
    const counts = Object.fromEntries(deckBuilt.basics.map((e) => [e.card.name, e.count]));
    expect(counts).toEqual({ Plains: 1, Mountain: 16 });
    const spells = { ...deckBuilt, basics: [] };
    expect(suggestBasics(spells, cardIndex(splash), 45 + DRAFTED_BASICS)).toMatchObject({ W: 1, R: 16 });
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
  const archetype = parsed.metadata.get(LIBRARY_ARCHETYPE_KEY.toLowerCase());
  const pilot = parsed.metadata.get(LIBRARY_PILOT_KEY.toLowerCase());
  if (archetype === undefined || pilot === undefined) throw new Error(`${file} has no [metadata] Archetype or Pilot`);
  const lines = (section: string) =>
    (parsed.sections.get(section) ?? []).map((e) => ({ count: e.count, name: e.card.name }));
  return {
    id: entry.id,
    collection: collection.id,
    era: formatIdOf(collection),
    name: parsed.name,
    archetype,
    pilot,
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
const NAYA_POD = realDeck('power-summer-2012', '1-caleb-durward-naya-pod.dck');
const SOLAR_FLARE = realDeck('power-summer-2012', '1-jeremy-dombek-solar-flare.dck');

/**
 * A name long enough to wrap past two lines — the case the clamp exists for.
 * Sixty Islands, like {@link DECKS}: this fixture is about the NAME, not the
 * colours, and a basic-land maindeck is legal everywhere this suite mounts it.
 */
const LONG_NAME_DECK = deck(
  'deck-with-an-unreasonably-long-name',
  'The Collected Works of a Pilot Who Could Not Settle on a Shorter Title for This Deck',
  'Somebody With a Similarly Unreasonable Name',
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
    // The row's own visible text is the deck's NAME and its player, and nothing else: the
    // ` · WU` suffix the `<option>` needed is gone, because the row draws real
    // pips, and the play style is a mark with no word.
    expect(rowName(two)).toBe(UW_DELVER.archetype);
    expect(two.textContent?.replace(/^Illus\. .*? · ™ & © WotC/, '')).toBe(`${UW_DELVER.archetype}${UW_DELVER.pilot}`);
    expect(within(two).getByTestId('deck-colors').dataset['colors']).toBe('WU');

    const one = deckRow(MONO_GREEN.id);
    expect(one.dataset['colors']).toBe('G');
    expect(rowName(one)).toBe(MONO_GREEN.archetype);
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
    expect(rowName(deckRow(UG_POLYMORPH))).toBe('UG Polymorph');
    // A colourless deck's row says the word rather than drawing nothing.
    expect(within(deckRow(UG_POLYMORPH)).getByTestId('deck-colors').textContent).toBe('colourless');
    await pick(UG_POLYMORPH);
    expect(pips()).toEqual([]);
    expect(within(chosenRow()).getByTestId('deck-colors').textContent).toBe('colourless');
  });
});

/* ── a library deck's play style (2026-10-16) ───────────────────────────── */

/**
 * *"would be cool if we had a little indicator on the decks in the deck
 * selector that told us whether it was combo, midrange, control, or aggro"* —
 * the style the deck selection gave each library deck, on its tile and in its
 * peek, as a word (so a reader hears it) beside a hue. A deck the selection
 * never saw draws no tag rather than a guess.
 */
// The operator, 2026-10-16: "the black bar at the bottom has two rows: row1: deckname, deck type
// icon, color symbols. row2: player name".
describe('a library deck’s tile names the deck, then its player', () => {
  it('draws the file’s Archetype on the first line and its Pilot on the second, the whole name in the accessible name', async () => {
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, LONG_NAME_DECK] });
    const group = await deckPicker();
    const uw = deckRow(UW_DELVER.id);
    expect(UW_DELVER.name).toBe(`${UW_DELVER.archetype} (${UW_DELVER.pilot})`);
    const name = uw.querySelector('.deckpick__name')!;
    expect(name.textContent).toBe(UW_DELVER.archetype);
    // No native tooltip: hovering opens the peek, which names the deck (operator, 2026-10-21).
    expect(name.hasAttribute('title')).toBe(false);
    expect(uw.querySelector('.deckpick__pilot')?.textContent).toBe(UW_DELVER.pilot);
    // Deck, player, style and colours, all in what a reader hears.
    const radio = within(group).getByRole('radio', { name: new RegExp(`${UW_DELVER.archetype}.*Aggro.*W U.*${UW_DELVER.pilot}`) });
    expect(radio).toBe(uw);

    const long = deckRow(LONG_NAME_DECK.id);
    expect(long.querySelector('.deckpick__name')?.textContent).toBe(LONG_NAME_DECK.archetype);
    expect(long.querySelector('.deckpick__pilot')?.textContent).toBe(LONG_NAME_DECK.pilot);
  });
});

describe('the deck chooser tags a library deck with its play style', () => {
  it('tags the library deck with its selection style, and the deck with none not at all', async () => {
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, LONG_NAME_DECK] });
    const group = await deckPicker();

    expect(LIBRARY_DECK_STYLES[UW_DELVER.id]).toBe('aggro');
    const uw = deckRow(UW_DELVER.id);
    expect(uw.dataset['style']).toBe('aggro');
    // A mark between the name and the colours, with no word drawn.
    const mark = within(uw).getByTestId('deck-style');
    expect(mark.textContent).toBe('');
    expect(mark.getAttribute('aria-label')).toBe('Aggro');
    expect(mark.previousElementSibling?.classList.contains('deckpick__name')).toBe(true);
    // In the tile's accessible name, not only painted on it.
    expect(within(group).getByRole('radio', { name: /Aggro/ })).toBe(uw);

    const unknown = deckRow(LONG_NAME_DECK.id);
    expect(unknown.hasAttribute('data-style')).toBe(false);
    expect(within(unknown).queryByTestId('deck-style')).toBeNull();
  });

  it('names the style in the deck’s peek too', async () => {
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, MONO_GREEN] });
    await deckPicker();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    fireEvent.pointerEnter(deckRow(MONO_GREEN.id), { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEEK_DELAY_MS + 50);
    });
    const peek = screen.getByTestId('deck-peek');
    expect(within(peek).getByTestId('deck-style').dataset['style']).toBe(LIBRARY_DECK_STYLES[MONO_GREEN.id]);
  });
});

/* ── the deck grid's filters (2026-10-16) ─────────────────────────────────── */

/**
 * *"next to the set symbols it would be great to have filters for decktype,
 * contained color, and even a text search. for text search if i type 'liliana'
 * it should filter out all decks that don't have a card with liliana in the
 * name."* The predicate is `deckFilter.test.ts`'s; this is the screen: the
 * filters narrow the tiles, never the choice, and Tab still lands on a tile.
 */
describe('the deck grid filters', () => {
  const FOUR = [UW_DELVER, MONO_GREEN, NAYA_POD, SOLAR_FLARE];

  async function mountFour(): Promise<HTMLElement> {
    await mountRoom({ players: [], matchId: null, decks: FOUR });
    return deckPicker();
  }

  const press = async (testId: string): Promise<void> => {
    await act(async () => {
      fireEvent.click(screen.getByTestId(testId));
    });
  };
  const search = async (text: string): Promise<void> => {
    await act(async () => {
      fireEvent.change(screen.getByTestId('deck-filter-text'), { target: { value: text } });
    });
  };

  it('narrows by style: any one of those pressed', async () => {
    await mountFour();
    expect(offered()).toHaveLength(4);
    const combo = FOUR.filter((d) => LIBRARY_DECK_STYLES[d.id] === 'combo').map((d) => d.id);
    expect(combo).toEqual([NAYA_POD.id]);
    await press('deck-filter-style-combo');
    expect(screen.getByTestId('deck-filter-style-combo').getAttribute('aria-pressed')).toBe('true');
    expect(offered()).toEqual(combo);
    await press('deck-filter-style-aggro');
    expect(new Set(offered())).toEqual(
      new Set(FOUR.filter((d) => ['combo', 'aggro'].includes(LIBRARY_DECK_STYLES[d.id] ?? '')).map((d) => d.id)),
    );
    await press('deck-filter-style-combo');
    await press('deck-filter-style-aggro');
    expect(offered()).toHaveLength(4);
  });

  it('narrows by colour: a deck must play every colour pressed', async () => {
    await mountFour();
    const colorsOf = new Map(offered().map((id) => [id, deckRow(id).dataset['colors'] ?? '']));
    await press('deck-filter-color-W');
    await press('deck-filter-color-U');
    const want = [...colorsOf].filter(([, c]) => c.includes('W') && c.includes('U')).map(([id]) => id);
    expect(want).toContain(UW_DELVER.id);
    expect(want).not.toContain(MONO_GREEN.id);
    expect(offered()).toEqual(want);
  });

  it('narrows by a card name, and says so in one line when nothing is left', async () => {
    await mountFour();
    await search('GEIST');
    const want = FOUR.filter((d) => [...d.main, ...d.sideboard].some((l) => l.name.toLowerCase().includes('geist'))).map((d) => d.id);
    expect(want).toContain(UW_DELVER.id);
    expect(want).not.toContain(MONO_GREEN.id);
    expect(offered()).toEqual(want);
    expect(screen.queryByTestId('deck-none')).toBeNull();
    await search('no card is called this');
    expect(offered()).toEqual([]);
    expect(screen.getByTestId('deck-none').textContent).toBe('No decks');
  });

  it('never changes the choice, and Tab still lands on a tile shown', async () => {
    await mountFour();
    await pick(MONO_GREEN.id);
    await press('deck-filter-color-U');
    expect(offered()).not.toContain(MONO_GREEN.id);
    expect(chosen()).toBe(MONO_GREEN.id);
    const stops = offered().filter((id) => deckRow(id).tabIndex === 0);
    expect(stops).toEqual([offered()[0]]);
    await press('deck-filter-color-U');
    expect(offered()).toContain(MONO_GREEN.id);
    expect(chosen()).toBe(MONO_GREEN.id);
    expect(deckRow(MONO_GREEN.id).getAttribute('aria-checked')).toBe('true');
    expect(offered().filter((id) => deckRow(id).tabIndex === 0)).toEqual([MONO_GREEN.id]);
  });
});

/* ── the deck section's order, and what it no longer says (2026-09-30) ──── */

describe('Ready and Random come before the deck list, and the era note is not printed', () => {
  // The operator, 2026-10-16: "Random button can be in the same row as the filter options", and
  // "Ready can be on the seat. just replace the 'not ready' pill with a button instead".
  it('puts Ready on my seat and Random among the filters, both ABOVE the list of decks', async () => {
    await mountRoom({ players: [], matchId: null });
    const list = await deckPicker();
    await pick(SECOND_DECK);
    const ready = await screen.findByTestId('ready-toggle');
    const random = screen.getByTestId('deck-random');
    expect(ready.closest('[data-testid="room-seat-0"]')).not.toBeNull();
    expect(random.parentElement).toBe(screen.getByTestId('deck-filter').parentElement);
    // DOCUMENT_POSITION_FOLLOWING (4): the list comes after each button.
    expect(ready.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(random.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Random is an action, not one of the deck radios.
    expect(list.contains(random)).toBe(false);
  });

  it('draws no verdict for an illegal deck: no card list, no era note, no pill', async () => {
    // The operator, 2026-10-10: "i dislike that verdict it's useless, just get rid of it".
    await mountRoom({ players: [], matchId: null });
    await pick(UG_POLYMORPH);
    await pickPool('2011-07-15');
    await waitFor(() => expect(myReadyOpen()).toBe(false));
    expect(screen.queryByTestId('verdict-mine')).toBeNull();
    expect(screen.queryByTestId('room-seat-0-legal')).toBeNull();
    expect(document.body.textContent).not.toContain('Jace, the Mind Sculptor');
    expect(document.body.textContent).not.toContain('built for');
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
    expect(rowName(uw)).toBe(UW_DELVER.archetype);
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
    const css = styled();
    expect(css(deckRow(MONO_GREEN.id), 'box-shadow'), 'the chosen row is ringed').not.toBe(css(deckRow(UW_DELVER.id), 'box-shadow'));
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
    // through the same call a click makes, and the server answered it legal.
    await waitFor(() => expect(myReadyOpen()).toBe(true));
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
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, LONG_NAME_DECK] });
    await deckPicker();
    // One fixed track for every row, the item stretched to fill it, and a long name ending in an ellipsis
    // rather than wrapping past the track; `boxes.md` (real Playwright, a built page) measured the boxes.
    const css = styled();
    const list = document.querySelector('.deckpick')!;
    expect(css(list, 'grid-auto-rows'), 'a fixed track, not one per content').not.toMatch(/^(auto)?$/);
    expect(css(list, 'align-items')).toBe('stretch');
    for (const name of document.querySelectorAll('.deckpick__name')) {
      expect(css(name, 'text-overflow')).toBe('ellipsis');
      expect(css(name, 'white-space'), 'one line, the player on the next').toBe('nowrap');
    }
    // The player's row is a fixed height, drawn or not, so every art band is the same size.
    expect(css(deckRow(UW_DELVER.id), 'grid-template')).toMatch(/'pilot pilot pilot' 22px/);

    // The ellipsis hides the overflow visually; the full name is in the tile's accessible name, and a
    // mouse hover opens the peek, which names it — so no native `title` doubles the peek (operator, 2026-10-21).
    const long = deckRow(LONG_NAME_DECK.id);
    expect(long.querySelector('.deckpick__name')?.textContent).toBe(LONG_NAME_DECK.archetype);
    expect(long.querySelector('.deckpick__name')?.hasAttribute('title')).toBe(false);
    expect(long.getAttribute('aria-describedby') ?? '', 'not peeked yet').toBe('');
    expect(within(document.querySelector('.deckpick')! as HTMLElement).getByRole('radio', { name: new RegExp(LONG_NAME_DECK.pilot) })).toBe(long);
  });
});

/* ── deck art is warmed ahead of the picker ──────────────────────────── */

/**
 * The operator, of the deck chooser: *"some loaded quick, but others loaded
 * extremely slowly. are these relying on external requests? this is a static
 * list we should be able to cache these images."*
 *
 * Every option's art is a known URL the moment the era's decks answer —
 * nothing about it depends on a hover or a scroll — so the screen asks the
 * browser to warm all of them the moment the list is assembled, rather than
 * leaving each `<img>` to fetch cold when it scrolls into view or paints.
 *
 * `prefetchCardImages` does this with `new Image()`, not a `<link
 * rel="prefetch">` — a prefetch link lives in a separate cache partition and
 * does not coalesce with the picker's own `<img>` for the same URL, so it
 * measurably DOUBLED the art-host traffic rather than caching anything (see
 * `art.md`'s "before" table). `new Image()` is an ordinary image load as far
 * as the browser's cache is concerned, so this suite stands in for the real
 * `Image` constructor with a plain counting fake — jsdom's own `Image` never
 * fetches regardless of which constructor is used, so the fake changes
 * nothing this environment could prove either way, and it lets the test
 * assert the one thing that matters: exactly which URLs were asked to warm,
 * and how many times. The real request count, against a built page in a
 * real browser, is `art.md`'s job.
 */
describe('deck art is warmed ahead of the picker', () => {
  /** Every `src` a warmed `Image()` was given, in construction order. */
  let warmedSrcs: string[] = [];
  /** How many `Image()` objects `prefetchCardImages` actually constructed. */
  let constructedCount = 0;
  const RealImage = globalThis.Image;

  beforeEach(() => {
    warmedSrcs = [];
    constructedCount = 0;
    class FakeImage {
      private _src = '';
      constructor() {
        constructedCount += 1;
      }
      set decoding(_v: string) {
        // Accepted and ignored — the real `Image` has the property too, and
        // `prefetchCardImages` sets it unconditionally.
      }
      set src(v: string) {
        this._src = v;
        warmedSrcs.push(v);
      }
      get src(): string {
        return this._src;
      }
    }
    // A test-only stand-in for the global `Image` constructor — not the real
    // `HTMLImageElement`, and not what `DeckArt`'s own `<img>` renders
    // through (React creates those via `document.createElement`, a separate
    // path this swap does not touch).
    globalThis.Image = FakeImage as unknown as typeof Image;
  });

  afterEach(() => {
    globalThis.Image = RealImage;
  });

  const GEIST = (ART_IDS as { ids: Record<string, string> }).ids['Geist of Saint Traft'];
  const WILD_DEFIANCE = (ART_IDS as { ids: Record<string, string> }).ids['Wild Defiance'];

  it('warms every option’s art at once, one `Image()` per distinct URL', async () => {
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, MONO_GREEN] });
    await deckPicker();

    await waitFor(() => expect(warmedSrcs).toHaveLength(2));
    expect(new Set(warmedSrcs)).toEqual(new Set([cardImageUrl(GEIST), cardImageUrl(WILD_DEFIANCE)]));
    expect(constructedCount).toBe(2);

    // The rows themselves still point at the very same URLs — warming them
    // ahead of time changes nothing about what the `<img>` tags render.
    expect(deckRow(UW_DELVER.id).querySelector('img')?.getAttribute('src')).toBe(cardImageUrl(GEIST));
    expect(deckRow(MONO_GREEN.id).querySelector('img')?.getAttribute('src')).toBe(cardImageUrl(WILD_DEFIANCE));
  });

  it('never asks twice for a URL it already warmed, including across a pool change', async () => {
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, MONO_GREEN] });
    await deckPicker();
    await waitFor(() => expect(warmedSrcs).toHaveLength(2));

    // The leader moves the room's pool. The stub's decks are the same two, so
    // the era "changes" (a new `GET /tables/legal/:format` sweep runs) while
    // every art URL on offer is one this screen has already warmed.
    await pickPool('2011-07-15');
    await waitFor(() => expect(offered()).toEqual([UW_DELVER.id, MONO_GREEN.id]));
    expect(warmedSrcs).toHaveLength(2);
    expect(constructedCount).toBe(2);

    // And moving back does not re-warm them either.
    await pickPool('2010-07-16');
    await waitFor(() => expect(offered()).toEqual([UW_DELVER.id, MONO_GREEN.id]));
    expect(warmedSrcs).toHaveLength(2);
    expect(constructedCount).toBe(2);
  });

  it('draws the placeholder for a failed art, same as before warming existed', async () => {
    // `onError` — not this effect — is what a 404 at fetch time runs into;
    // asking the browser to warm a URL ahead of time does not change what
    // happens when that warm (or the `<img>`'s own fetch) comes back 404.
    await mountRoom({ players: [], matchId: null, decks: [UW_DELVER, MONO_GREEN] });
    await deckPicker();
    const img = deckRow(UW_DELVER.id).querySelector('img') as HTMLImageElement;
    await act(async () => {
      fireEvent.error(img);
    });
    expect(deckRow(UW_DELVER.id).querySelector('.deckpick__art--none')).not.toBeNull();
    expect(deckRow(UW_DELVER.id).querySelector('img')).toBeNull();
  });

  it('never shows the same card on two tiles: the lower deck takes its next card', async () => {
    // Both decks' most iconic card is Elesh Norn.
    await mountRoom({ players: [], matchId: null, decks: [NAYA_POD, SOLAR_FLARE] });
    await deckPicker();
    const ids = (ART_IDS as { ids: Record<string, string> }).ids;
    const srcs = [NAYA_POD, SOLAR_FLARE].map((d) => deckRow(d.id).querySelector('img')?.getAttribute('src'));
    expect(srcs).toContain(cardImageUrl(ids['Elesh Norn, Grand Cenobite']!));
    expect(new Set(srcs).size).toBe(2);
  });
});

/**
 * The art rule, on its own (`deckArt.ts`): a deck's most iconic card first, and
 * no card twice on one page.
 *
 * A deck has no art of its own, so the rule is a decision and the decision is
 * testable without a screen. Its consequence on real lists is what matters —
 * these are the cards the decks are known by.
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

  /** A real deck's ranking, from the same committed tables the screen reads. */
  const rankingOf = (deck: TableDeck): string[] =>
    rankDeckArt(
      deck.main.flatMap((line) => {
        const cost = LIBRARY_CARD_COSTS[line.name];
        if (cost === undefined) return [];
        return [
          {
            name: line.name,
            count: line.count,
            manaValue: manaValueOf(cost),
            traits: (DECK_ART_TRAITS as { traits: Record<string, string> }).traits[line.name] ?? 'c',
            scryfallId: (ART_IDS as { ids: Record<string, string> }).ids[line.name],
          },
        ];
      }),
    ).map((c) => c.name);

  it('puts the card each real deck is known by first', () => {
    // `LIBRARY_CARD_COSTS` has no land in it, so the lands in these lists cannot
    // win — and every id resolves through the committed table the play board uses.
    expect(rankingOf(UW_DELVER)[0]).toBe('Geist of Saint Traft');
    expect(rankingOf(NAYA_POD)[0]).toBe('Elesh Norn, Grand Cenobite');
    expect(rankingOf(SOLAR_FLARE).slice(0, 2)).toEqual(['Elesh Norn, Grand Cenobite', 'Gideon Jura']);
  });

  it('scores a mythic legendary four-of creature over a bigger rare', () => {
    const legend = { name: 'Legend', count: 4, manaValue: 3, traits: 'mLC', scryfallId: 'a' };
    const fatty = { name: 'Fatty', count: 2, manaValue: 7, traits: 'rC', scryfallId: 'b' };
    expect(artScore(legend)).toBeGreaterThan(artScore(fatty));
    expect(rankDeckArt([fatty, legend]).map((c) => c.name)).toEqual(['Legend', 'Fatty']);
  });

  it('reads a drafted card’s rarity and front face as the same traits', () => {
    expect(traitsOfDraftCard('mythic', 'Legendary Creature — Angel')).toBe('mLC');
    expect(traitsOfDraftCard('mythic', 'Legendary Planeswalker — Jace')).toBe('mLP');
    expect(traitsOfDraftCard('common', 'Creature — Human Wizard // Creature — Human Insect')).toBe('cC');
    expect(traitsOfDraftCard('rare', 'Enchantment')).toBe('r');
  });

  it('gives a deck further down its next card when one above took its first', () => {
    const a = [{ name: 'Norn', artId: 'n' }, { name: 'Wurm', artId: 'w' }];
    const b = [{ name: 'Norn', artId: 'n' }, { name: 'Gideon', artId: 'g' }];
    const c = [{ name: 'Norn', artId: 'n' }];
    // c has nothing else, so it repeats rather than drawing a blank tile.
    expect(assignDeckArt([a, b, c, []])).toEqual(['n', 'g', 'n', undefined]);
  });
});
